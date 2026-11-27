package io.github.sillybunnyteam.sillybunny.settings

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings

/** The battery-optimisation exemption shortcut (plan §4.3, §4.6; R2 §2). */
interface BatteryOptimizations {
    /** Whether this app is exempt. Settings reads it again on every resume, off the main thread. */
    fun isExempt(): Boolean

    /**
     * The system screens the shortcut may open for the current [exempt] state, in the order Settings tries them:
     * the first one that starts wins, so a screen that does not resolve falls back to the next one.
     */
    fun shortcutIntents(exempt: Boolean): List<Intent>
}

class SystemBatteryOptimizations(context: Context) : BatteryOptimizations {
    private val context = context.applicationContext

    override fun isExempt(): Boolean =
        context.getSystemService(PowerManager::class.java)?.isIgnoringBatteryOptimizations(context.packageName) == true

    /**
     * Not exempt yet: the per-app request, else the system list. Already exempt: the system list only, because
     * the request screen closes at once for an exempt app. Settings starts them instead of resolving them first:
     * starting an activity is not subject to package visibility, so no `<queries>` entry is needed.
     */
    override fun shortcutIntents(exempt: Boolean): List<Intent> =
        if (exempt) listOf(listIntent()) else listOf(requestIntent(context.packageName), listIntent())

    companion object {
        // The manifest declares REQUEST_IGNORE_BATTERY_OPTIMIZATIONS on purpose: the APK is distributed
        // outside Google Play, so Play's acceptable-use policy for this request does not apply (plan §4.2).
        @SuppressLint("BatteryLife")
        fun requestIntent(packageName: String): Intent =
            Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.fromParts("package", packageName, null))

        fun listIntent(): Intent = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
    }
}
