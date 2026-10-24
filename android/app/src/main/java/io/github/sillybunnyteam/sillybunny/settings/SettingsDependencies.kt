package io.github.sillybunnyteam.sillybunny.settings

import androidx.activity.ComponentActivity
import io.github.sillybunnyteam.sillybunny.checkout.BrokenCheckouts
import io.github.sillybunnyteam.sillybunny.runtime.RuntimePaths
import io.github.sillybunnyteam.sillybunny.server.LaunchSession
import io.github.sillybunnyteam.sillybunny.server.ServerHost
import io.github.sillybunnyteam.sillybunny.update.AppUpdater
import io.github.sillybunnyteam.sillybunny.update.UpdateUiState
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers

/**
 * What Settings needs from the APK updater (plan §4.6, §5.5). Settings only toggles the automatic
 * check and asks for a manual one; the updater's own dialog presents and installs anything it finds.
 * Implementations must back [state] and [enabled] with Compose snapshot state so the screen observes them.
 */
interface UpdateControls {
    val state: UpdateUiState

    /** The automatic check on launch, persisted by the updater. */
    var enabled: Boolean

    fun checkNow()
}

/** [UpdateControls] over the activity-scoped [AppUpdater] that `UpdateActivityHook` also uses. */
class AppUpdaterControls(private val updater: AppUpdater) : UpdateControls {
    override val state: UpdateUiState
        get() = updater.state

    override var enabled: Boolean
        get() = updater.enabled
        set(value) {
            updater.enabled = value
        }

    override fun checkNow() = updater.checkNow()
}

/** Counts the moved-aside `SillyBunny.broken-*` folders (plan §4.7). Blocking; Settings calls it off the main thread. */
fun interface LeftoverFolderCounter {
    fun count(): Int
}

/**
 * Entry points other tracks own: Open in browser (task 5.6) and the Repair and Leftover folders screens
 * (task 5.9). Settings only calls them. A null callback hides its entry.
 */
class SettingsCallbacks(
    /** Called with the running server's session, for example `{ openInBrowser(activity, it) }`. */
    val onOpenInBrowser: ((LaunchSession) -> Unit)? = null,
    val onRepair: (() -> Unit)? = null,
    val onLeftoverFolders: (() -> Unit)? = null,
)

/** Everything the Settings screens read or call, so each can be replaced in tests. */
class SettingsDependencies(
    val serverHost: ServerHost,
    val appSettings: AppSettings,
    val updates: UpdateControls,
    val battery: BatteryOptimizations,
    val leftoverFolders: LeftoverFolderCounter,
    val notices: NoticesSource,
    val runtimeVersions: RuntimeVersionsSource,
    /** Where blocking work runs: server stop, log reads, snapshots, notices and counters. */
    val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
) {
    companion object {
        /**
         * The production wiring for [activity]. Pass `UpdateActivityHook.updater` so the dialog shares its
         * state. [leftoverFolders] defaults to counting `BrokenCheckouts.list`; task 5.9 may pass its own.
         *
         * Create it once per host, for example `remember { SettingsDependencies.forActivity(...) }`: Settings
         * keys its loads on these objects, so a new instance on every recomposition re-reads the battery state,
         * the leftover count, the runtime versions and the notices.
         */
        fun forActivity(
            activity: ComponentActivity,
            serverHost: ServerHost,
            updater: AppUpdater = AppUpdater.forActivity(activity),
            leftoverFolders: LeftoverFolderCounter? = null,
        ): SettingsDependencies {
            val context = activity.applicationContext
            return SettingsDependencies(
                serverHost = serverHost,
                appSettings = AppSettings(context),
                updates = AppUpdaterControls(updater),
                battery = SystemBatteryOptimizations(context),
                leftoverFolders = leftoverFolders
                    ?: LeftoverFolderCounter { BrokenCheckouts.list(RuntimePaths(context)).size },
                notices = AssetNoticesSource(context.assets),
                runtimeVersions = AssetRuntimeVersions(context.assets),
            )
        }
    }
}
