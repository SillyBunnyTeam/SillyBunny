package io.github.sillybunnyteam.sillybunny.update

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import io.github.sillybunnyteam.sillybunny.MainActivity
import io.github.sillybunnyteam.sillybunny.R

object UpdateNotifications {
    internal const val CHANNEL_ID = "app_updates"
    internal const val REPLACED_ID = 5801
    internal const val INSTALL_ID = 5802

    fun ensureChannel(context: Context) {
        try {
            context.getSystemService(NotificationManager::class.java)?.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ID,
                    context.getString(R.string.update_notification_channel),
                    NotificationManager.IMPORTANCE_DEFAULT,
                ),
            )
        } catch (_: SecurityException) {
            // Disabled notifications must not prevent recording an update or starting explicitly.
        }
    }

    fun postReplaced(context: Context) {
        val intent = Intent(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        post(context, REPLACED_ID, intent, R.string.update_replaced_title, R.string.update_replaced_body)
    }

    fun postUserAction(context: Context, intent: Intent) {
        userActionPendingIntent(context, intent)?.let { postUserAction(context, it) }
    }

    internal fun postUserAction(context: Context, pendingIntent: PendingIntent) {
        post(context, INSTALL_ID, pendingIntent, R.string.update_install_title, R.string.update_install_body)
    }

    internal fun userActionPendingIntent(
        context: Context,
        intent: Intent,
        existingOnly: Boolean = false,
    ): PendingIntent? = try {
        PendingIntent.getActivity(
            context,
            INSTALL_ID,
            Intent(intent).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_ONE_SHOT or
                if (existingOnly) PendingIntent.FLAG_NO_CREATE else PendingIntent.FLAG_UPDATE_CURRENT,
        )
    } catch (_: SecurityException) {
        null
    }

    internal fun pendingUserActionAvailable(context: Context, intent: Intent): Boolean =
        userActionPendingIntent(context, intent, existingOnly = true) != null

    fun cancelInstall(context: Context) {
        try {
            context.getSystemService(NotificationManager::class.java)?.cancel(INSTALL_ID)
        } catch (_: SecurityException) {
            // The user can revoke notification access between the callback and cancellation.
        }
    }

    private fun post(context: Context, id: Int, intent: Intent, title: Int, body: Int) {
        try {
            post(
                context,
                id,
                PendingIntent.getActivity(
                    context,
                    id,
                    intent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                ),
                title,
                body,
            )
        } catch (_: SecurityException) {
            // Creating a tap token must be as harmless as posting a denied notification.
        }
    }

    private fun post(context: Context, id: Int, contentIntent: PendingIntent, title: Int, body: Int) {
        ensureChannel(context)
        try {
            val manager = context.getSystemService(NotificationManager::class.java) ?: return
            if (!manager.areNotificationsEnabled() ||
                (Build.VERSION.SDK_INT >= 33 &&
                    context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) !=
                    PackageManager.PERMISSION_GRANTED)
            ) return

            // SystemUI sends this only on a notification tap and supplies its own BAL privilege.
            // There is no app-side send or creator-wide background-launch delegation here.
            manager.notify(
                id,
                Notification.Builder(context, CHANNEL_ID)
                    .setSmallIcon(R.drawable.ic_update_notification)
                    .setContentTitle(context.getString(title))
                    .setContentText(context.getString(body))
                    .setContentIntent(contentIntent)
                    .setAutoCancel(true)
                    .setOnlyAlertOnce(true)
                    .build(),
            )
        } catch (_: SecurityException) {
            // Permission may change after the preflight check; persisted state remains usable.
        }
    }
}
