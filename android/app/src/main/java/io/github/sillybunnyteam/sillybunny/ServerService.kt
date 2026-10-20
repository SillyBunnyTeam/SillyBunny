package io.github.sillybunnyteam.sillybunny

import android.app.Service
import android.content.Intent
import android.os.IBinder

// Inert until task 5.4: never starts a process or restarts itself.
class ServerService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        stopSelf(startId)
        return START_NOT_STICKY
    }
}
