package io.github.sillybunnyteam.sillybunny.settings

import android.content.Context
import androidx.core.content.edit

/**
 * Native settings shared by the server and the Settings screen (plan §4.6). The APK update-check
 * toggle lives in `update.UpdateStore`.
 */
class AppSettings(context: Context) {
    private val preferences = context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    /** Auto-update SillyBunny (git) on launch; maps to `SILLYBUNNY_AUTO_UPDATE`. Default on. */
    var autoUpdateGit: Boolean
        get() = preferences.getBoolean(AUTO_UPDATE_GIT, true)
        set(value) = preferences.edit { putBoolean(AUTO_UPDATE_GIT, value) }

    private companion object {
        const val FILE = "app_settings"
        const val AUTO_UPDATE_GIT = "auto_update_git"
    }
}
