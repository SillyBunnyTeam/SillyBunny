package io.github.sillybunnyteam.sillybunny.update

import android.app.Activity
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import android.os.Looper
import android.provider.Settings
import androidx.core.net.toUri
import java.io.File
import java.util.UUID

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
                return
            }
            reconcileSession(callback, result, preserveAvailableAction = true)
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
            failUnauthenticatedInstall()
            return false
        }
        if (result.sessionId != callback.sessionId) {
            reconcileSession(callback, result)
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
                reconcileSession(callback, result, nonresumableOutcome = InstallOutcome.FAILED)
                return false
            }
        }
        reconcileSession(callback, result)
        return false
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
            if (ownedSession != null && ownedSession.isSealed && ownedSession.isActive && canContinue) {
                if (store.recordInstallResult(
                        callback,
                        InstallResult(InstallOutcome.VERIFYING),
                        terminal = false,
                        expectedResult = expectedResult,
                    )
                ) UpdateNotifications.cancelInstall(context)
                return
            }
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

        fun callbackPendingIntentFlags(): Int = PendingIntent.FLAG_UPDATE_CURRENT or
            if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0
    }
}
