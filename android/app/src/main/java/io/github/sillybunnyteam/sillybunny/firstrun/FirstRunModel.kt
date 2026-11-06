package io.github.sillybunnyteam.sillybunny.firstrun

import io.github.sillybunnyteam.sillybunny.settings.LocalNetworkStatus

/** The notification-permission row on the Welcome screen (plan §4.3 step 1). A denial never blocks anything. */
enum class NotificationStatus {
    /** Below API 33 notifications need no runtime permission. */
    NOT_REQUIRED,
    NOT_ASKED,

    /** Denied, and the system dialog can still be shown again. */
    DENIED,

    /** Denied in a way the system dialog will not ask again; only system settings can change it. */
    PERMANENTLY_DENIED,
    GRANTED,
}

/** The optional battery-optimisation exemption row. A skip leaves it for Settings. */
enum class BatteryStatus {
    NOT_EXEMPT,
    EXEMPT,
    SKIPPED,
}

/** What the network preflight saw. */
enum class NetworkKind {
    /** No active network, or one that is not validated for internet access. */
    NONE,
    UNMETERED,

    /** A validated, metered, non-cellular network, such as a metered Wi-Fi hotspot. */
    METERED,
    CELLULAR,
}

/** What is at `RuntimePaths.checkoutDir`, read without following symlinks. */
enum class CheckoutStatus {
    ABSENT,

    /** A real, empty directory. `install.sh` clones into it, so it is not in the way. */
    EMPTY,

    /** Anything else that is not a finished checkout: a partial or killed clone, a file or a symlink. */
    PARTIAL,

    /**
     * A finished clone: a real directory holding `.git/HEAD`, `.git/index` and `package.json`. Git commits the
     * index only after the whole tree is written, and the clone is all `install.sh --no-start` does.
     */
    INSTALLED,
}

/** Why the flow stopped on the error screen. */
sealed interface FirstRunFailure {
    data class LowStorage(val availableBytes: Long, val requiredBytes: Long) : FirstRunFailure

    data object Offline : FirstRunFailure

    data class Layout(val reason: String) : FirstRunFailure

    data class Install(val exitCode: Int) : FirstRunFailure

    data object Cancelled : FirstRunFailure

    /** The install was running when the process died, or a partial checkout was found on launch. */
    data object Interrupted : FirstRunFailure

    /** `install.sh` exited 0, yet `checkoutDir` holds no git checkout. */
    data object NoCheckout : FirstRunFailure

    /** Moving a partial checkout aside failed, so nothing was started. */
    data class MoveAside(val reason: String) : FirstRunFailure

    /** A probe or the server host threw. */
    data class Unexpected(val reason: String) : FirstRunFailure
}

/** One screen of the first-run flow. */
sealed interface FirstRunStage {
    /** Deriving the state from the saved record, `ServerHost.setup` and the filesystem. */
    data object Loading : FirstRunStage

    data object Welcome : FirstRunStage

    /** Storage and network preflight. */
    data object Checking : FirstRunStage

    /** A metered or cellular network: the user may continue after seeing the download estimate. */
    data class MeteredWarning(val cellular: Boolean) : FirstRunStage

    /** Laying out the runtime (plan §2.4 step 1). */
    data object Preparing : FirstRunStage

    /** Ready to install, waiting for the activity to be started again before any foreground-service start. */
    data object WaitingForForeground : FirstRunStage

    /** The install job runs in the foreground service; [lines] is its streamed tail. */
    data class Installing(val lines: List<String>, val cancelling: Boolean) : FirstRunStage

    /**
     * The server or another setup job (such as Repair) is running, so nothing at `checkoutDir` was touched and
     * nothing was started; also shown when `ServerHost.runSetup` refuses.
     */
    data object Busy : FirstRunStage

    /** [partialCheckout] is true while something is left at `checkoutDir`; it shows Repair. */
    data class Failed(
        val failure: FirstRunFailure,
        val lines: List<String>,
        val partialCheckout: Boolean,
    ) : FirstRunStage

    data object Installed : FirstRunStage
}

/** The log sub-view. [setupLog] is null while it is being read. */
data class FirstRunLogView(val lastLines: List<String>, val setupLog: List<String>?)

/** Everything the screens render. [visible] mirrors the activity being at least started. */
data class FirstRunUiState(
    val stage: FirstRunStage = FirstRunStage.Loading,
    val notifications: NotificationStatus = NotificationStatus.NOT_ASKED,
    val battery: BatteryStatus = BatteryStatus.NOT_EXEMPT,
    /** The optional Welcome item; it never blocks or delays Continue. */
    val localNetwork: LocalNetworkStatus = LocalNetworkStatus.NOT_REQUIRED,
    val visible: Boolean = false,
    val logs: FirstRunLogView? = null,
    val confirmingCancel: Boolean = false,
)
