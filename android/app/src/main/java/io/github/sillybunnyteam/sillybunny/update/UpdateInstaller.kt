package io.github.sillybunnyteam.sillybunny.update

import android.app.Activity
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import androidx.annotation.VisibleForTesting
import androidx.core.net.toUri
import java.io.File
import java.util.UUID
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit

class UnknownSourcesRequiredException : IllegalStateException()

enum class UpdateInstallFailure {
    MAIN_THREAD,
    ALREADY_INSTALLING,
    INVALID_ARCHIVE,
    SESSION_FAILED,
}

class UpdateInstallException(val failure: UpdateInstallFailure) : Exception()

class UpdateInstaller(
    context: Context,
    private val serverController: ServerController = NoOpServerController,
) {
    private val context = context.applicationContext
    private val store = UpdateStore(this.context)

    fun canInstall(): Boolean = try {
        context.packageManager.canRequestPackageInstalls()
    } catch (_: SecurityException) {
        false
    }

    fun unknownSourcesIntent(): Intent =
        Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, "package:${context.packageName}".toUri())

    fun reconcileAfterLaunch() {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            throw UpdateInstallException(UpdateInstallFailure.MAIN_THREAD)
        }
        synchronized(installLock) {
            val result = store.lastInstallResult
            val callback = store.activeCallback()
            if (callback == null) {
                if (store.activeSessionId != null || result.outcome == InstallOutcome.VERIFYING ||
                    result.outcome == InstallOutcome.AWAITING_USER_ACTION
                ) failUnauthenticatedInstall()
            } else {
                reconcileSession(callback, result, preserveAvailableAction = true)
            }
            abandonUntrackedSessions()
        }
    }

    fun resumePendingUserAction(activity: Activity): Boolean {
        if (Looper.myLooper() != Looper.getMainLooper() || UpdateForeground.currentActivity() !== activity) {
            return false
        }
        val result = store.lastInstallResult
        if (result.outcome != InstallOutcome.AWAITING_USER_ACTION) return false
        val callback = store.activeCallback()
        if (callback == null) {
            inBackground {
                if (store.activeCallback() == null && store.lastInstallResult == result) failUnauthenticatedInstall()
            }
            return false
        }
        if (result.sessionId != callback.sessionId) {
            inBackground { reconcileSession(callback, result) }
            return false
        }

        val pending = store.pendingUserAction(callback)
        // The callback and preference observer can both run during one onResume. Do not reopen
        // or abort confirmation until the activity actually leaves and resumes again.
        if (pending?.presentedSequence == UpdateForeground.sequence) return false
        val userAction = pending?.intent
        val notificationConsumed = pending?.notificationIntent?.let {
            !UpdateNotifications.pendingUserActionAvailable(context, it)
        } ?: false
        if (notificationConsumed) store.setUserActionPresented(callback, true)
        if (userAction != null && !notificationConsumed) {
            try {
                if (!store.setUserActionPresented(callback, true)) return false
                activity.startActivity(Intent(userAction))
                store.markUserActionPresented(callback, UpdateForeground.sequence)
                UpdateNotifications.cancelInstall(context)
                return true
            } catch (_: RuntimeException) {
                store.setUserActionPresented(callback, false)
                inBackground { reconcileSession(callback, result, nonresumableOutcome = InstallOutcome.FAILED) }
                return false
            }
        }
        inBackground { reconcileSession(callback, result) }
        return false
    }

    // Session queries and abandons wait on the platform's per-session lock, which installation holds
    // while it extracts native libraries, so they never run on the main thread.
    private fun inBackground(work: () -> Unit) {
        background.execute { synchronized(installLock) { work() } }
    }

    /** getMySessions lists only sessions this app created, so an untracked one for this package was leaked. */
    private fun abandonUntrackedSessions() {
        try {
            val installer = context.packageManager.packageInstaller
            val tracked = store.activeSessionId
            installer.mySessions.filter {
                it.sessionId != tracked && it.appPackageName == context.packageName
            }.forEach { session ->
                try {
                    installer.abandonSession(session.sessionId)
                } catch (_: Exception) {
                    // A session that finished or was released meanwhile needs nothing more.
                }
            }
        } catch (_: Exception) {
            // Best effort: the platform expires sessions that stay untouched for three days.
        }
    }

    private fun failUnauthenticatedInstall() {
        val sessionId = store.activeSessionId
        try {
            val installer = context.packageManager.packageInstaller
            val ownsSession = installer.mySessions.any {
                it.sessionId == sessionId && it.appPackageName == context.packageName
            }
            if (sessionId != null && ownsSession) installer.abandonSession(sessionId)
        } catch (_: Exception) {
            // Lost local authentication cannot authorize launching or retaining a confirmation.
        }
        store.failInstall(sessionId)
        UpdateNotifications.cancelInstall(context)
    }

    private fun reconcileSession(
        callback: UpdateStore.InstallCallback,
        expectedResult: InstallResult,
        preserveAvailableAction: Boolean = false,
        nonresumableOutcome: InstallOutcome = InstallOutcome.ABORTED,
    ) {
        if (store.activeCallback() != callback) return
        try {
            val expectedVersion = store.activeVersionCode(callback)
            val installedVersion = ApkVerifier.installedVersionCode(context)
            if (expectedVersion != null && installedVersion != null && installedVersion >= expectedVersion) {
                finishInstall(callback, InstallOutcome.SUCCESS, expectedResult)
                return
            }
            val installer = context.packageManager.packageInstaller
            val ownedSession = installer.mySessions.firstOrNull { it.sessionId == callback.sessionId }
            if (store.activeCallback() != callback || store.lastInstallResult != expectedResult) return
            if (ownedSession != null && ownedSession.appPackageName != context.packageName) {
                finishInstall(callback, InstallOutcome.FAILED, expectedResult)
                return
            }
            val waitingForAction = expectedResult.outcome == InstallOutcome.AWAITING_USER_ACTION
            val pending = if (waitingForAction) store.pendingUserAction(callback) else null
            val notificationConsumed = pending?.notificationIntent?.let {
                !UpdateNotifications.pendingUserActionAvailable(context, it)
            } ?: false
            if (notificationConsumed) store.setUserActionPresented(callback, true)
            val availableConfirmation = !store.userActionPresented(callback) &&
                pending?.intent != null && !notificationConsumed
            if (preserveAvailableAction && ownedSession?.isSealed == true && waitingForAction &&
                pending != null && (availableConfirmation ||
                    (store.userActionPresented(callback) && !ownedSession.isActive))
            ) return

            // Active does not imply consent: developer verification can ask for another action
            // without deactivating the session. Only the current prompt's durable presentation counts.
            val canContinue = expectedResult.outcome == InstallOutcome.VERIFYING ||
                (waitingForAction && store.userActionPresented(callback))
            if ((ownedSession == null || ownedSession.isSealed) && canContinue &&
                keepForConsent(callback, expectedResult, ownedSession, waitingForAction)
            ) return
            if (ownedSession != null) installer.abandonSession(callback.sessionId)
            val outcome = when (expectedResult.outcome) {
                InstallOutcome.SUCCESS, InstallOutcome.FAILED, InstallOutcome.ABORTED -> expectedResult.outcome
                else -> nonresumableOutcome
            }
            finishInstall(callback, outcome, expectedResult)
        } catch (_: Exception) {
            finishInstall(callback, InstallOutcome.FAILED, expectedResult)
        }
    }

    /**
     * Decides whether a sealed session that may hold the user's consent stays. Android 14 and later
     * re-activate the session after consent; Android 10-13 leave it inactive. On every version the
     * session's progress moves from 0.8 to 0.9 only when installation starts after consent. A prompt
     * that returns before either sign waits up to [consentGraceMillis], because the installer UI can
     * also close without answering, and is released after that. A missing [session] waits the same
     * way: the platform drops a finished session before its final status reaches the receiver.
     */
    private fun keepForConsent(
        callback: UpdateStore.InstallCallback,
        expectedResult: InstallResult,
        session: PackageInstaller.SessionInfo?,
        promptReturned: Boolean,
    ): Boolean {
        if (session != null && (session.isActive || session.progress > CONSENTED_PROGRESS)) {
            if (store.recordInstallResult(
                    callback,
                    InstallResult(InstallOutcome.VERIFYING),
                    terminal = false,
                    expectedResult = expectedResult,
                )
            ) UpdateNotifications.cancelInstall(context)
            return true
        }
        val now = clock()
        if (promptReturned) {
            if (store.beginConsentWait(callback, expectedResult, now)) {
                UpdateNotifications.cancelInstall(context)
                scheduleConsentRecheck(consentGraceMillis)
            }
            return true
        }
        val startedAt = store.consentWaitStartedAt(callback) ?: return false
        val elapsed = now - startedAt
        // elapsedRealtime restarts at boot, so a negative wait has expired as well.
        if (elapsed < 0 || elapsed >= consentGraceMillis) return false
        scheduleConsentRecheck(consentGraceMillis - elapsed)
        return true
    }

    private fun scheduleConsentRecheck(delayMillis: Long) {
        consentRecheck?.cancel(false)
        consentRecheck = background.schedule(
            Runnable { recheckConsent() },
            delayMillis.coerceAtLeast(0),
            TimeUnit.MILLISECONDS,
        )
    }

    private fun recheckConsent() = synchronized(installLock) {
        val callback = store.activeCallback() ?: return@synchronized
        val result = store.lastInstallResult
        if (result.outcome == InstallOutcome.VERIFYING && result.sessionId == callback.sessionId) {
            reconcileSession(callback, result)
        }
    }

    private fun finishInstall(
        callback: UpdateStore.InstallCallback,
        outcome: InstallOutcome,
        expectedResult: InstallResult,
    ) {
        val status = when (outcome) {
            InstallOutcome.SUCCESS -> PackageInstaller.STATUS_SUCCESS
            InstallOutcome.ABORTED -> PackageInstaller.STATUS_FAILURE_ABORTED
            else -> PackageInstaller.STATUS_FAILURE
        }
        if (store.recordInstallResult(
                callback,
                InstallResult(outcome, status),
                terminal = true,
                expectedResult = expectedResult,
            )
        ) {
            UpdateNotifications.cancelInstall(context)
        }
    }

    fun install(apk: File, versionCode: Long): Int {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            throw UpdateInstallException(UpdateInstallFailure.MAIN_THREAD)
        }
        return synchronized(installLock) {
            if (!canInstall()) throw UnknownSourcesRequiredException()
            if (store.activeSessionId != null) {
                throw UpdateInstallException(UpdateInstallFailure.ALREADY_INSTALLING)
            }
            val download = store.ownedDownload(apk.absolutePath)
                ?: throw UpdateInstallException(UpdateInstallFailure.INVALID_ARCHIVE)
            val signer = ApkVerifier.installedSigner(context)
            val installedVersion = ApkVerifier.installedVersionCode(context)
            if (signer == null || installedVersion == null || versionCode <= installedVersion ||
                !ApkVerifier.verifyArchive(context, download, versionCode, signer)
            ) {
                store.downloadedApk = download.path
                store.failInstall(null)
                throw UpdateInstallException(UpdateInstallFailure.INVALID_ARCHIVE)
            }
            if (!canInstall()) throw UnknownSourcesRequiredException()

            val length = download.length()
            if (length <= 0) {
                store.downloadedApk = download.path
                store.failInstall(null)
                throw UpdateInstallException(UpdateInstallFailure.INVALID_ARCHIVE)
            }
            var installer: PackageInstaller? = null
            var sessionId: Int? = null
            var session: PackageInstaller.Session? = null
            var callback: PendingIntent? = null
            store.downloadedApk = download.path
            try {
                val params = sessionParams(length)
                val packageInstaller = context.packageManager.packageInstaller
                installer = packageInstaller
                serverController.stopForUpdate()
                val createdSession = packageInstaller.createSession(params)
                sessionId = createdSession
                val openedSession = packageInstaller.openSession(createdSession)
                session = openedSession
                openedSession.openWrite("base.apk", 0, length).use { output ->
                    val copied = download.inputStream().use { it.copyTo(output, 64 * 1024) }
                    if (copied != length || download.length() != length) {
                        throw UpdateInstallException(UpdateInstallFailure.INVALID_ARCHIVE)
                    }
                    openedSession.fsync(output)
                }
                val action = newCallbackAction(createdSession)
                callback = callbackPendingIntent(createdSession, action)
                if (!store.beginInstall(createdSession, action, download, versionCode)) {
                    throw UpdateInstallException(UpdateInstallFailure.SESSION_FAILED)
                }
                // Commit only queues installation; callback state must already survive process death.
                openedSession.commit(callback.intentSender)
                createdSession
            } catch (exception: Exception) {
                callback?.cancel()
                if (sessionId != null) {
                    try {
                        installer?.abandonSession(sessionId)
                    } catch (_: Exception) {
                        // A rejected or already-finished session may no longer be owned by us.
                    }
                }
                store.failInstall(sessionId)
                if (exception is UpdateInstallException) throw exception
                throw UpdateInstallException(UpdateInstallFailure.SESSION_FAILED)
            } finally {
                try {
                    session?.close()
                } catch (_: Exception) {
                    // Closing the local handle must not turn an accepted commit into a failure.
                }
            }
        }
    }

    fun callbackPendingIntent(sessionId: Int, action: String): PendingIntent = PendingIntent.getBroadcast(
        context,
        sessionId,
        Intent(context, InstallStatusReceiver::class.java).setAction(action).setPackage(context.packageName),
        callbackPendingIntentFlags(),
    )

    internal fun newCallbackAction(sessionId: Int): String =
        "${context.packageName}.update.INSTALL_STATUS.$sessionId.${UUID.randomUUID()}"

    internal fun sessionParams(length: Long): PackageInstaller.SessionParams =
        PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(context.packageName)
            setSize(length)
            if (Build.VERSION.SDK_INT >= 31) {
                setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_REQUIRED)
            }
        }

    companion object {
        private val installLock = Any()
        private const val CONSENTED_PROGRESS = 0.85f
        private val background = ScheduledThreadPoolExecutor(1) { work ->
            Thread(work, "apk-update-installer").apply { isDaemon = true }
        }
        private var consentRecheck: ScheduledFuture<*>? = null

        @Volatile
        @VisibleForTesting
        internal var clock: () -> Long = SystemClock::elapsedRealtime

        @Volatile
        @VisibleForTesting
        internal var consentGraceMillis = 60_000L

        /** Waits for session work already handed to the background thread; scheduled rechecks keep waiting. */
        @VisibleForTesting
        internal fun awaitBackgroundWork() {
            background.submit(Runnable {}).get(10, TimeUnit.SECONDS)
        }

        @VisibleForTesting
        internal fun resetForTest() {
            synchronized(installLock) {
                consentRecheck?.cancel(false)
                consentRecheck = null
            }
            clock = SystemClock::elapsedRealtime
            consentGraceMillis = 60_000L
        }

        fun callbackPendingIntentFlags(): Int = PendingIntent.FLAG_UPDATE_CURRENT or
            if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0
    }
}
