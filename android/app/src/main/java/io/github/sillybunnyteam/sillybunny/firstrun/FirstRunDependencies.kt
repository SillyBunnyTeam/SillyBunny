package io.github.sillybunnyteam.sillybunny.firstrun

import android.content.Context
import io.github.sillybunnyteam.sillybunny.BuildConfig
import io.github.sillybunnyteam.sillybunny.runtime.RuntimePaths
import io.github.sillybunnyteam.sillybunny.server.ServerHost
import io.github.sillybunnyteam.sillybunny.settings.AndroidLocalNetworkAccess
import io.github.sillybunnyteam.sillybunny.settings.LocalNetworkAccess
import java.io.File
import java.time.Clock
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers

/** The result of laying out the runtime (plan §2.2, §2.4 step 1). */
sealed interface RuntimeLayoutOutcome {
    data object Ready : RuntimeLayoutOutcome

    data class Failed(val reason: String) : RuntimeLayoutOutcome
}

/**
 * Makes the runtime layout match the installed APK. Blocking and idempotent; the controller calls it on
 * its IO dispatcher, never on the main thread. A thrown exception counts as a failure with its message.
 */
fun interface RuntimeLayoutStep {
    fun ensure(): RuntimeLayoutOutcome
}

/** The `POST_NOTIFICATIONS` state. The request itself runs in the UI, which reports the result back. */
interface NotificationPermission {
    /** True on API 33+, where the permission is a runtime permission. */
    val required: Boolean

    fun isGranted(): Boolean
}

fun interface BatteryExemption {
    /** True when the app is already exempt from battery optimisation. */
    fun isExempt(): Boolean
}

fun interface StorageProbe {
    /** Bytes available to the app where `filesDir` lives. Blocking. */
    fun availableBytes(): Long
}

fun interface NetworkProbe {
    /** The current default network. Blocking. */
    fun current(): NetworkKind
}

fun interface CheckoutInspector {
    /** What is at `checkoutDir` now. Blocking. */
    fun status(): CheckoutStatus
}

fun interface SetupLogReader {
    /** A bounded tail of the setup log, or an empty list when there is none. Blocking. */
    fun read(): List<String>
}

/**
 * Every dependency of [FirstRunController]. Only [context], [paths], [serverHost], [installScript] and
 * [layout] have no default; the defaults are the Android adapters in this package.
 *
 * The first-run ViewModel keeps these for its whole life, across configuration changes, so nothing here may
 * hold an Activity. Lambdas such as [layout] must not capture one either: read `applicationContext` into a
 * local `val` first and capture that.
 *
 * @param context any context; only its application context is kept, for `ServerHost.runSetup`.
 * @param installScript the laid-out `install.sh` (task 5.5 adds the asset and its path).
 * @param layout the runtime layout step, adapted from `RuntimeLayout.ensure(context)` by task 5.5.
 * @param defaultRef the `--ref` value, `BuildConfig.DEFAULT_REF` in production.
 */
class FirstRunDependencies(
    context: Context,
    val paths: RuntimePaths,
    val serverHost: ServerHost,
    val installScript: File,
    val layout: RuntimeLayoutStep,
    val defaultRef: String = BuildConfig.DEFAULT_REF,
    val notifications: NotificationPermission = AndroidNotificationPermission(context),
    val battery: BatteryExemption = AndroidBatteryExemption(context),
    val localNetwork: LocalNetworkAccess = AndroidLocalNetworkAccess(context),
    val storage: StorageProbe = StatFsStorageProbe(paths.filesDir),
    val network: NetworkProbe = ConnectivityNetworkProbe(context),
    val checkout: CheckoutInspector = FileCheckoutInspector(paths.checkoutDir),
    val setupLog: SetupLogReader = SetupLogFileReader(File(paths.logsDir, SETUP_LOG_FILE_NAME)),
    val clock: Clock = Clock.systemUTC(),
    val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
) {
    val context: Context = context.applicationContext

    companion object {
        /** p54's `ServerHost` writes each setup job's full output to `logsDir/setup.log`. */
        const val SETUP_LOG_FILE_NAME = "setup.log"
    }
}
