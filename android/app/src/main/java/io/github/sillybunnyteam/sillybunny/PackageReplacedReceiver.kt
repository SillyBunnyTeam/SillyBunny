package io.github.sillybunnyteam.sillybunny

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import io.github.sillybunnyteam.sillybunny.update.UpdateNotifications
import io.github.sillybunnyteam.sillybunny.update.UpdateStore

// SillyBunny intentionally waits for an explicit launch instead of restarting its server after replacement.
class PackageReplacedReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        val versionCode = try {
            val installed = if (Build.VERSION.SDK_INT >= 33) {
                context.packageManager.getPackageInfo(context.packageName, PackageManager.PackageInfoFlags.of(0))
            } else {
                @Suppress("DEPRECATION")
                context.packageManager.getPackageInfo(context.packageName, 0)
            }
            installed.longVersionCode
        } catch (_: PackageManager.NameNotFoundException) {
            return
        }
        UpdateStore(context).recordReplacement(versionCode)
        UpdateNotifications.postReplaced(context)
    }
}
