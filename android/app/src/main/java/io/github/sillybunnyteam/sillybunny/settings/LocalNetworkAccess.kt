package io.github.sillybunnyteam.sillybunny.settings

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.ContextCompat
import androidx.core.content.edit

/** The local-network permission as the first-run Welcome item and the Settings row show it. */
enum class LocalNetworkStatus {
    /** Below API 37 the permission does not exist, so neither the item nor the row shows. */
    NOT_REQUIRED,
    NOT_ASKED,

    /** Denied, and the system dialog can still show. */
    DENIED,

    /** Denied, and the system dialog no longer shows: only the app's page in system settings can grant it. */
    BLOCKED,
    GRANTED,
}

/**
 * Android 17's `ACCESS_LOCAL_NETWORK` permission. Only a backend on another device on the same network needs
 * it; loopback and internet traffic do not, so the app never asks on its own: only a tap on the Welcome item or
 * the Settings row does, and a denial changes nothing else. The request itself runs in the UI, which reports
 * the answer to [onRequestResult].
 */
interface LocalNetworkAccess {
    /** The permission to request, or null below API 37. */
    val permission: String?

    /** The current status. Blocking: it reads the stored answers. */
    fun status(): LocalNetworkStatus

    /**
     * Records the answer to a request and returns the new status. [canAskAgain] is
     * `shouldShowRequestPermissionRationale`, read right after the answer.
     */
    fun onRequestResult(granted: Boolean, canAskAgain: Boolean): LocalNetworkStatus

    companion object {
        /** The app's page in system settings, where a permission the dialog no longer offers can be granted. */
        fun settingsIntent(packageName: String): Intent =
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null))

        /** The status after an answer to a request, given the status before it. */
        fun afterAnswer(current: LocalNetworkStatus, granted: Boolean, canAskAgain: Boolean): LocalNetworkStatus =
            when {
                current == LocalNetworkStatus.NOT_REQUIRED -> current
                granted || current == LocalNetworkStatus.GRANTED -> LocalNetworkStatus.GRANTED
                canAskAgain -> LocalNetworkStatus.DENIED
                // A first answer without a rationale can be a dismissed dialog. Only a repeated one means the
                // system stopped asking.
                current == LocalNetworkStatus.DENIED || current == LocalNetworkStatus.BLOCKED -> LocalNetworkStatus.BLOCKED
                else -> LocalNetworkStatus.DENIED
            }
    }
}

/**
 * [LocalNetworkAccess] through `checkSelfPermission`. Android stops showing the dialog after a second denial
 * without saying so, so the last denial is stored: the item and the row then open the settings page instead of a
 * request that would return at once, also after process death or a restart.
 */
class AndroidLocalNetworkAccess(context: Context) : LocalNetworkAccess {
    private val context = context.applicationContext
    private val answers by lazy { this.context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE) }

    override val permission: String?
        get() = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.CINNAMON_BUN) {
            Manifest.permission.ACCESS_LOCAL_NETWORK
        } else {
            null
        }

    override fun status(): LocalNetworkStatus {
        val permission = permission ?: return LocalNetworkStatus.NOT_REQUIRED
        if (ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED) {
            return LocalNetworkStatus.GRANTED
        }
        return when (answers.getString(KEY_DENIAL, null)) {
            LocalNetworkStatus.BLOCKED.name -> LocalNetworkStatus.BLOCKED
            LocalNetworkStatus.DENIED.name -> LocalNetworkStatus.DENIED
            else -> LocalNetworkStatus.NOT_ASKED
        }
    }

    override fun onRequestResult(granted: Boolean, canAskAgain: Boolean): LocalNetworkStatus {
        val next = LocalNetworkAccess.afterAnswer(status(), granted, canAskAgain)
        if (next == LocalNetworkStatus.DENIED || next == LocalNetworkStatus.BLOCKED) {
            // Written at once: the process can die right after the answer, and a lost BLOCKED costs a dead tap.
            answers.edit(commit = true) { putString(KEY_DENIAL, next.name) }
        }
        return next
    }

    private companion object {
        const val PREFERENCES = "local_network"
        const val KEY_DENIAL = "denial"
    }
}
