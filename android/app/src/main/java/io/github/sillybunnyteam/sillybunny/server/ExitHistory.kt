package io.github.sillybunnyteam.sillybunny.server

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.Context
import android.os.Build

/** Exit-history checks for sticky recreation; `ApplicationExitInfo` exists from API 30 only (R2 §2). */
internal object ExitHistory {
    /**
     * True when this package's most recent process exit was `REASON_USER_REQUESTED`: force stop, Task
     * Manager Stop, a Recents removal that killed it and, before API 34, some package updates. That is
     * ambiguous, so it only stops a sticky recreation from resurrecting the server, never an explicit start.
     */
    fun lastExitUserRequested(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return false
        return try {
            val manager = context.getSystemService(ActivityManager::class.java) ?: return false
            manager.getHistoricalProcessExitReasons(context.packageName, 0, 1).firstOrNull()?.reason ==
                ApplicationExitInfo.REASON_USER_REQUESTED
        } catch (_: RuntimeException) {
            false
        }
    }
}
