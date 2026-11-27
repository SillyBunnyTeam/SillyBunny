package io.github.sillybunnyteam.sillybunny

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.ServiceCompat
import io.github.sillybunnyteam.sillybunny.server.ServerManager
import io.github.sillybunnyteam.sillybunny.server.ServerNotifications
import io.github.sillybunnyteam.sillybunny.server.ServiceMode

/**
 * The foreground service that keeps the server's process group, or one setup job, alive (task 5.4).
 *
 * All state lives in [ServerManager]; this class only promotes, leaves the foreground and forwards start
 * commands. It is not exported: only this app's explicit intents, including its own notification's
 * Stop and Cancel actions, reach it. Start it through [ServerManager.start], [ServerManager.restart] or
 * [ServerManager.runSetup], never directly.
 */
class ServerService : Service() {
    private var lastStartId = 0

    override fun onCreate() {
        super.onCreate()
        ServerNotifications.ensureChannel(this)
        ServerManager.get(this).attachService(this)
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        lastStartId = startId
        // The process-wide manager is looked up on every command, never cached across commands.
        val manager = ServerManager.get(this)
        manager.attachService(this)
        // A null intent is a START_STICKY recreation; the persisted run intent decides what happens.
        return manager.onStartCommand(this, intent?.action)
    }

    override fun onDestroy() {
        ServerManager.existing()?.detachService(this)
        super.onDestroy()
    }

    /**
     * Enters or updates the foreground with [mode]'s notification. A denied notification permission only
     * hides the notification; false means the platform refused the foreground service itself.
     */
    internal fun promote(mode: ServiceMode): Boolean = try {
        // The specialUse type exists from API 34; earlier releases take no type here.
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
        } else {
            0
        }
        ServiceCompat.startForeground(this, ServerNotifications.NOTIFICATION_ID, ServerNotifications.build(this, mode), type)
        true
    } catch (_: RuntimeException) {
        false
    }

    /** Leaves the foreground and stops, unless a newer start command is already on its way. */
    internal fun release() {
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelfResult(lastStartId)
    }

    companion object {
        internal const val ACTION_START = "io.github.sillybunnyteam.sillybunny.action.SERVER_START"
        internal const val ACTION_RESTART = "io.github.sillybunnyteam.sillybunny.action.SERVER_RESTART"
        internal const val ACTION_SETUP = "io.github.sillybunnyteam.sillybunny.action.SERVER_SETUP"
        internal const val ACTION_STOP = "io.github.sillybunnyteam.sillybunny.action.SERVER_STOP"
        internal const val ACTION_CANCEL_SETUP = "io.github.sillybunnyteam.sillybunny.action.SETUP_CANCEL"

        /** An explicit intent carrying only [action]: no extras, so nothing about a session leaves the app. */
        internal fun intent(context: Context, action: String): Intent =
            Intent(context, ServerService::class.java).setAction(action)
    }
}
