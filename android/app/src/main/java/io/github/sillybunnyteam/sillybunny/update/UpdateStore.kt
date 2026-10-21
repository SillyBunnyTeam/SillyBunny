package io.github.sillybunnyteam.sillybunny.update

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import androidx.core.content.edit
import java.io.File
import java.nio.file.Files
import java.util.UUID

enum class InstallOutcome {
    IDLE,
    AWAITING_USER_ACTION,
    VERIFYING,
    SUCCESS,
    FAILED,
    ABORTED,
}

data class InstallResult(
    val outcome: InstallOutcome = InstallOutcome.IDLE,
    val status: Int? = null,
    val legacyStatus: Int? = null,
    val developerVerificationReason: Int? = null,
    val sessionId: Int? = null,
)

class UpdateStore(context: Context) {
    private val context = context.applicationContext
    private val preferences = this.context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

    var enabled: Boolean
        get() = preferences.getBoolean(ENABLED, true)
        set(value) = preferences.edit { putBoolean(ENABLED, value) }

    var lastInstallResult: InstallResult
        get() = synchronized(lock) {
            InstallResult(
                outcome = InstallOutcome.entries.firstOrNull {
                    it.name == preferences.getString(OUTCOME, null)
                } ?: InstallOutcome.IDLE,
                status = preferences.optionalInt(STATUS),
                legacyStatus = preferences.optionalInt(LEGACY_STATUS),
                developerVerificationReason = preferences.optionalInt(VERIFICATION_REASON),
                sessionId = preferences.optionalInt(RESULT_SESSION),
            )
        }
        set(value) = synchronized(lock) {
            preferences.edit { putResult(value) }
        }

    var activeSessionId: Int?
        get() = preferences.optionalInt(ACTIVE_SESSION)
        set(value) = synchronized(lock) {
            val resetCallback = value == null || value != activeSessionId
            if (resetCallback) clearPendingUserAction()
            preferences.edit {
                putOptionalInt(ACTIVE_SESSION, value)
                if (resetCallback) remove(CALLBACK_ACTION).remove(ACTIVE_VERSION).remove(USER_ACTION_PRESENTED)
            }
        }

    var downloadedApk: String?
        get() = preferences.getString(DOWNLOADED_APK, null)
        set(value) = synchronized(lock) {
            preferences.edit { putString(DOWNLOADED_APK, ownedDownload(value)?.path) }
        }

    fun recordReplacement(versionCode: Long) = synchronized(lock) {
        if (versionCode <= 0) return@synchronized
        clearPendingUserAction()
        UpdateNotifications.cancelInstall(context)
        val sessionId = activeSessionId
        val replacesActiveSession = sessionId != null &&
            preferences.getLong(ACTIVE_VERSION, -1) == versionCode
        val download = if (replacesActiveSession) ownedDownload(downloadedApk) else null
        // Replacement can kill the old process before its final install callback is delivered.
        preferences.edit(commit = true) {
            putLong(REPLACEMENT, versionCode)
            remove(USER_ACTION_PRESENTED)
            if (replacesActiveSession) {
                putResult(InstallResult(InstallOutcome.SUCCESS, sessionId = sessionId))
                    .removeSession().remove(DOWNLOADED_APK)
            }
        }
        download?.delete()
        Unit
    }

    fun consumeReplacement(): Long? = synchronized(lock) {
        if (!preferences.contains(REPLACEMENT)) return@synchronized null
        val versionCode = preferences.getLong(REPLACEMENT, -1)
        preferences.edit { remove(REPLACEMENT) }
        versionCode.takeIf { it > 0 }
    }

    fun clearDownload() = synchronized(lock) {
        val download = ownedDownload(downloadedApk)
        preferences.edit { remove(DOWNLOADED_APK) }
        download?.delete()
        Unit
    }

    internal fun ownedDownload(path: String?): File? {
        if (path == null) return null
        return try {
            val root = File(context.cacheDir.canonicalFile, "updates")
            val candidate = File(path)
            if (!candidate.isAbsolute || !downloadName.matches(candidate.name) ||
                ".." in candidate.name || Files.isSymbolicLink(root.toPath()) ||
                Files.isSymbolicLink(candidate.toPath()) || root.canonicalFile != root
            ) return null
            candidate.canonicalFile.takeIf {
                it.parentFile == root && (!it.exists() || it.isFile)
            }
        } catch (_: Exception) {
            null
        }
    }

    internal fun activeCallback(): InstallCallback? = synchronized(lock) {
        val sessionId = activeSessionId ?: return@synchronized null
        val action = preferences.getString(CALLBACK_ACTION, null) ?: return@synchronized null
        InstallCallback(sessionId, action)
    }

    @SuppressLint("UseKtx")
    internal fun beginInstall(
        sessionId: Int,
        callbackAction: String,
        apk: File,
        versionCode: Long,
    ): Boolean = synchronized(lock) {
        if (sessionId < 0 || versionCode <= 0 || callbackAction.isEmpty() || activeSessionId != null) {
            return@synchronized false
        }
        val download = ownedDownload(apk.path) ?: return@synchronized false
        clearPendingUserAction()
        // Unlike KTX edit, commit's Boolean lets us reject a session if callback identity was not persisted.
        preferences.edit()
            .putInt(ACTIVE_SESSION, sessionId)
            .putString(CALLBACK_ACTION, callbackAction)
            .putLong(ACTIVE_VERSION, versionCode)
            .putBoolean(USER_ACTION_PRESENTED, false)
            .putString(DOWNLOADED_APK, download.path)
            .putResult(InstallResult(InstallOutcome.VERIFYING, sessionId = sessionId))
            .commit()
    }

    internal fun recordInstallResult(
        callback: InstallCallback,
        result: InstallResult,
        terminal: Boolean,
        expectedResult: InstallResult? = null,
    ): Boolean = synchronized(lock) {
        if (activeCallback() != callback || (expectedResult != null && lastInstallResult != expectedResult)) {
            return@synchronized false
        }
        val download = if (terminal) ownedDownload(downloadedApk) else null
        clearPendingUserAction()
        // Receiver work is limited to a small preferences write and at most one cache-file unlink.
        preferences.edit(commit = true) {
            putResult(result.copy(sessionId = callback.sessionId))
            if (terminal) removeSession().remove(DOWNLOADED_APK)
            else if (result.outcome == InstallOutcome.AWAITING_USER_ACTION) putBoolean(USER_ACTION_PRESENTED, false)
        }
        download?.delete()
        true
    }

    internal fun failInstall(sessionId: Int?) = synchronized(lock) {
        if (activeSessionId != null && activeSessionId != sessionId) return@synchronized
        clearPendingUserAction()
        val download = ownedDownload(downloadedApk)
        preferences.edit {
            putResult(InstallResult(InstallOutcome.FAILED, sessionId = sessionId))
                .removeSession().remove(DOWNLOADED_APK)
        }
        download?.delete()
        Unit
    }

    internal fun rememberPendingUserAction(callback: InstallCallback, intent: Intent?): PendingUserAction? =
        synchronized(lock) {
            if (activeCallback() != callback) return@synchronized null
            clearPendingUserAction()
            if (intent == null) return@synchronized null
            // The one-shot notification token lets recovery detect a tap without a receiver trampoline.
            val notificationIntent = Intent(intent).setIdentifier("${callback.action}.${UUID.randomUUID()}")
            val notification = UpdateNotifications.userActionPendingIntent(context, notificationIntent)
            PendingUserAction(
                callback,
                Intent(intent),
                notificationIntent.takeIf { notification != null },
                notification,
            ).also {
                pendingAction = it
            }
        }

    internal fun recordPendingUserAction(callback: InstallCallback, result: InstallResult, intent: Intent?): Boolean =
        synchronized(lock) {
            if (!recordInstallResult(callback, result, terminal = false)) return@synchronized false
            // Launch recovery must not see AWAITING between resetting the bit and retaining its intent.
            rememberPendingUserAction(callback, intent)
            true
        }

    internal fun pendingUserAction(callback: InstallCallback): PendingUserAction? = synchronized(lock) {
        pendingAction?.takeIf { it.callback == callback && activeCallback() == callback }
    }

    internal fun userActionPresented(callback: InstallCallback): Boolean = synchronized(lock) {
        activeCallback() == callback && preferences.getBoolean(USER_ACTION_PRESENTED, false)
    }

    @SuppressLint("UseKtx", "ApplySharedPref")
    internal fun setUserActionPresented(callback: InstallCallback, presented: Boolean): Boolean = synchronized(lock) {
        if (activeCallback() != callback || lastInstallResult.outcome != InstallOutcome.AWAITING_USER_ACTION) {
            return@synchronized false
        }
        // Persist before leaving this process; KTX edit cannot return commit's durability Boolean.
        preferences.edit().putBoolean(USER_ACTION_PRESENTED, presented).commit()
    }

    internal fun markUserActionPresented(callback: InstallCallback, foregroundSequence: Long) = synchronized(lock) {
        val pending = pendingUserAction(callback) ?: return@synchronized
        pending.notification?.cancel()
        pending.intent = null
        pending.notificationIntent = null
        pending.notification = null
        pending.presentedSequence = foregroundSequence
    }

    internal fun clearPendingUserAction() = synchronized(lock) {
        pendingAction?.notification?.cancel()
        pendingAction = null
    }

    internal fun activeVersionCode(callback: InstallCallback): Long? = synchronized(lock) {
        if (activeCallback() != callback) return@synchronized null
        preferences.getLong(ACTIVE_VERSION, -1).takeIf { it > 0 }
    }

    private fun SharedPreferences.optionalInt(key: String): Int? =
        if (contains(key)) getInt(key, 0) else null

    private fun SharedPreferences.Editor.putOptionalInt(
        key: String,
        value: Int?,
    ): SharedPreferences.Editor = if (value == null) remove(key) else putInt(key, value)

    private fun SharedPreferences.Editor.putResult(result: InstallResult): SharedPreferences.Editor =
        putString(OUTCOME, result.outcome.name)
            .putOptionalInt(STATUS, result.status)
            .putOptionalInt(LEGACY_STATUS, result.legacyStatus)
            .putOptionalInt(VERIFICATION_REASON, result.developerVerificationReason)
            .putOptionalInt(RESULT_SESSION, result.sessionId)

    private fun SharedPreferences.Editor.removeSession(): SharedPreferences.Editor =
        remove(ACTIVE_SESSION).remove(CALLBACK_ACTION).remove(ACTIVE_VERSION).remove(USER_ACTION_PRESENTED)

    internal data class InstallCallback(val sessionId: Int, val action: String)

    internal class PendingUserAction(
        val callback: InstallCallback,
        var intent: Intent?,
        var notificationIntent: Intent?,
        var notification: PendingIntent?,
        var presentedSequence: Long? = null,
    )

    private companion object {
        const val PREFERENCES = "app_updates"
        const val ENABLED = "enabled"
        const val OUTCOME = "install_outcome"
        const val STATUS = "install_status"
        const val LEGACY_STATUS = "install_legacy_status"
        const val VERIFICATION_REASON = "install_verification_reason"
        const val RESULT_SESSION = "install_result_session"
        const val ACTIVE_SESSION = "active_session"
        const val ACTIVE_VERSION = "active_version"
        const val CALLBACK_ACTION = "callback_action"
        const val USER_ACTION_PRESENTED = "user_action_presented"
        const val DOWNLOADED_APK = "downloaded_apk"
        const val REPLACEMENT = "replacement_version"
        val lock = Any()
        var pendingAction: PendingUserAction? = null
        val downloadName = Regex("[A-Za-z0-9][A-Za-z0-9._-]{0,191}\\.(?:apk|part)")
    }
}
