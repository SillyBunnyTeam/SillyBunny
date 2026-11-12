package io.github.sillybunnyteam.sillybunny.update

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import java.lang.ref.WeakReference

object UpdateForeground {
    @Volatile
    private var activity = WeakReference<Activity>(null)
    @Volatile
    internal var sequence: Long = 0
        private set

    fun attach(activity: Activity) {
        if (this.activity.get() !== activity) sequence++
        this.activity = WeakReference(activity)
    }

    fun detach(activity: Activity) {
        val reference = this.activity
        if (reference.get() === activity) reference.clear()
    }

    fun currentActivity(): Activity? = activity.get()?.takeUnless { it.isFinishing || it.isDestroyed }
}

class InstallStatusReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val store = UpdateStore(context)
        val callback = store.activeCallback() ?: return
        if (intent.component != ComponentName(context, InstallStatusReceiver::class.java) ||
            intent.action != callback.action ||
            intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1) != callback.sessionId ||
            !intent.hasExtra(PackageInstaller.EXTRA_STATUS)
        ) return

        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        val reason = developerVerificationReason(intent)
        val result = InstallResult(
            outcome = when (status) {
                PackageInstaller.STATUS_PENDING_USER_ACTION -> InstallOutcome.AWAITING_USER_ACTION
                PackageInstaller.STATUS_SUCCESS -> InstallOutcome.SUCCESS
                PackageInstaller.STATUS_FAILURE_ABORTED -> InstallOutcome.ABORTED
                // No public streaming/verification-pending constant exists in the API 37 SDK.
                // Preserve unfamiliar negative progress statuses without finishing their session.
                else -> if (status < 0) InstallOutcome.VERIFYING else InstallOutcome.FAILED
            },
            status = status,
            legacyStatus = if (intent.hasExtra(LEGACY_STATUS_EXTRA)) {
                intent.getIntExtra(LEGACY_STATUS_EXTRA, 0)
            } else null,
            developerVerificationReason = reason,
        )
        val terminal = status >= 0
        val accepted = if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            store.recordPendingUserAction(callback, result, userActionIntent(intent))
        } else {
            store.recordInstallResult(callback, result, terminal)
        }
        if (!accepted) return

        if (terminal || result.outcome != InstallOutcome.AWAITING_USER_ACTION) {
            UpdateNotifications.cancelInstall(context)
        }
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            val pending = store.pendingUserAction(callback)
            val userAction = pending?.intent
            if (userAction == null) {
                UpdateForeground.currentActivity()?.let { UpdateInstaller(context).resumePendingUserAction(it) }
                return
            }
            val activity = UpdateForeground.currentActivity()
            if (activity != null) {
                try {
                    if (!store.setUserActionPresented(callback, true)) return
                    activity.startActivity(Intent(userAction))
                    store.markUserActionPresented(callback, UpdateForeground.sequence)
                    UpdateNotifications.cancelInstall(context)
                    return
                } catch (_: RuntimeException) {
                    store.setUserActionPresented(callback, false)
                    // Retain the authenticated intent for a notification tap or foreground retry.
                }
            }
            pending.notification?.let { UpdateNotifications.postUserAction(context, it) }
        } else if (status == PackageInstaller.STATUS_FAILURE_ABORTED && reason != null) {
            val userAction = userActionIntent(intent) ?: return
            presentUserAction(context, userAction)
        }
    }

    private fun presentUserAction(context: Context, intent: Intent) {
        val activity = UpdateForeground.currentActivity()
        if (activity != null) {
            try {
                activity.startActivity(intent)
                UpdateNotifications.cancelInstall(context)
                return
            } catch (_: RuntimeException) {
                // A paused/destroyed activity or unavailable installer can still use a tap intent.
            }
        }
        UpdateNotifications.postUserAction(context, intent)
    }

    @Suppress("DEPRECATION")
    private fun userActionIntent(intent: Intent): Intent? = try {
        if (Build.VERSION.SDK_INT >= 33) {
            intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
        } else {
            intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
        }
    } catch (_: RuntimeException) {
        null
    }

    private fun developerVerificationReason(intent: Intent): Int? =
        if (Build.VERSION.SDK_INT >= 36 &&
            Build.VERSION.SDK_INT_FULL >= Build.VERSION_CODES_FULL.BAKLAVA_1 &&
            intent.hasExtra(PackageInstaller.EXTRA_DEVELOPER_VERIFICATION_FAILURE_REASON)
        ) {
            intent.getIntExtra(
                PackageInstaller.EXTRA_DEVELOPER_VERIFICATION_FAILURE_REASON,
                PackageInstaller.DEVELOPER_VERIFICATION_FAILED_REASON_UNKNOWN,
            )
        } else null

    private companion object {
        // This diagnostic extra is present in system callbacks but is not a public SDK constant.
        const val LEGACY_STATUS_EXTRA = "android.content.pm.extra.LEGACY_STATUS"
    }
}
