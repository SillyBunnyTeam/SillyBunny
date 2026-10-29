package io.github.sillybunnyteam.sillybunny.server

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.drawable.Icon
import android.os.Build
import io.github.sillybunnyteam.sillybunny.MainActivity
import io.github.sillybunnyteam.sillybunny.R
import io.github.sillybunnyteam.sillybunny.ServerService

/** What the foreground service is doing, which picks its notification text. */
internal enum class ServiceMode { SERVER, SETUP }

/**
 * The foreground service's own channel and ongoing notification (plan §4.4). Every PendingIntent is
 * immutable and carries no extras, so nothing about the session reaches SystemUI.
 */
internal object ServerNotifications {
    const val CHANNEL_ID = "server"
    const val NOTIFICATION_ID = 5401
    private const val REQUEST_STOP = 5402
    private const val REQUEST_OPEN = 5403
    private const val REQUEST_CANCEL_SETUP = 5404

    fun ensureChannel(context: Context) {
        try {
            context.getSystemService(NotificationManager::class.java)?.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ID,
                    context.getString(R.string.server_notification_channel),
                    NotificationManager.IMPORTANCE_LOW,
                ).apply { setShowBadge(false) },
            )
        } catch (_: RuntimeException) {
            // A missing channel only hides the notification; the foreground service still runs.
        }
    }

    fun build(context: Context, mode: ServiceMode): Notification {
        ensureChannel(context)
        val text = if (mode == ServiceMode.SETUP) R.string.server_notification_setup else R.string.server_notification_running
        val builder = Notification.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_server_notification)
            .setContentTitle(context.getString(R.string.server_notification_title))
            .setContentText(context.getString(text))
            .setCategory(Notification.CATEGORY_SERVICE)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setContentIntent(openIntent(context))
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
        }
        val (label, action) = when (mode) {
            ServiceMode.SERVER -> R.string.server_notification_stop to stopIntent(context)
            ServiceMode.SETUP -> R.string.server_notification_cancel_setup to cancelSetupIntent(context)
        }
        builder.addAction(
            Notification.Action.Builder(
                Icon.createWithResource(context, R.drawable.ic_server_notification),
                context.getString(label),
                action,
            ).build(),
        )
        return builder.build()
    }

    fun stopIntent(context: Context): PendingIntent = PendingIntent.getService(
        context,
        REQUEST_STOP,
        ServerService.intent(context, ServerService.ACTION_STOP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    /** Only ever cancels a running setup job ([ServerManager.onStartCommand]); it starts nothing. */
    fun cancelSetupIntent(context: Context): PendingIntent = PendingIntent.getService(
        context,
        REQUEST_CANCEL_SETUP,
        ServerService.intent(context, ServerService.ACTION_CANCEL_SETUP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    /** Brings the existing task forward, as the launcher icon does. */
    private fun openIntent(context: Context): PendingIntent = PendingIntent.getActivity(
        context,
        REQUEST_OPEN,
        Intent(context, MainActivity::class.java)
            .setAction(Intent.ACTION_MAIN)
            .addCategory(Intent.CATEGORY_LAUNCHER)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
}
