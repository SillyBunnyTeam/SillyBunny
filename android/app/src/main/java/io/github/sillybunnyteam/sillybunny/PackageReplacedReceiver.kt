package io.github.sillybunnyteam.sillybunny

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

// Inert until task 5.8: never starts the server or changes data after an update.
class PackageReplacedReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
    }
}
