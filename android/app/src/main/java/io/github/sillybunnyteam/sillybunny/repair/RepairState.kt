package io.github.sillybunnyteam.sillybunny.repair

import java.io.File

/** The visible steps of a Repair attempt (plan §4.7). */
enum class RepairStep {
    CHECKING,
    STOPPING_SERVER,
    PAUSING_FILE_ACCESS,
    MOVING_ASIDE,
    MOVING_PARTIAL_ASIDE,
    REINSTALLING,
    STARTING_SERVER,
}

/** Why Repair refused to begin. Nothing was stopped, moved or changed. */
enum class RepairRefusal {
    CHECKOUT_MISSING,

    /** The checkout is a file or a symbolic link, not a real directory. */
    CHECKOUT_NOT_DIRECTORY,

    /** install.sh would refuse the source: no `package.json` naming `sillybunny`. */
    NOT_SILLYBUNNY,

    /** `config.yaml` exists but cannot be read as install.sh would, so the data root is unknown. */
    CONFIG_UNREADABLE,

    /** An absolute `dataRoot` inside the checkout: the rename would leave the new config pointing at empty data. */
    DATA_ROOT_INSIDE_CHECKOUT,

    /** A relative `dataRoot` climbing out of the checkout, which install.sh refuses to migrate. */
    DATA_ROOT_OUTSIDE_CHECKOUT,

    /** Another setup job (for example the first-run install) is running. */
    SETUP_BUSY,

    /** A Repair record exists but cannot be read, so where the data is cannot be known. */
    RECORD_UNREADABLE,
}

/** Why a Repair attempt stopped. [RepairState.Failed.source] says where the user's data is. */
enum class RepairFailure {
    RECORD_UNWRITABLE,
    STOP_TIMEOUT,
    MAINTENANCE_FAILED,
    NOT_VISIBLE,
    MOVE_FAILED,
    SOURCE_MISSING,
    SOURCE_INVALID,
    SETUP_BUSY,
    PARTIAL_NOT_DIRECTORY,
    PARTIAL_MOVE_FAILED,
    SETUP_REFUSED,
    INSTALL_FAILED,
    NOT_A_CHECKOUT,
    CANCELLED,
    INTERRUPTED,
    UNEXPECTED_ERROR,
}

sealed interface RepairState {
    /** No Repair is running and none is unfinished: the Repair screen shows its confirmation. */
    data object Idle : RepairState

    /**
     * [source] is the moved-aside folder holding the data once it has moved. [lines] tail the reinstall
     * output. [cancelling] is true once the user confirmed Cancel and the reinstall is stopping. [ref] is the
     * branch the reinstall installs, set while it runs.
     */
    data class Running(
        val step: RepairStep,
        val source: File?,
        val lines: List<String>,
        val cancelling: Boolean = false,
        val ref: String? = null,
    ) : RepairState {
        val canCancel: Boolean get() = step == RepairStep.REINSTALLING && !cancelling
    }

    data class Refused(val reason: RepairRefusal) : RepairState

    /**
     * [source] null means nothing moved and the checkout is where it was; otherwise the data is in
     * [source], which every retry migrates from. A failed attempt keeps every folder.
     *
     * [ref] is the branch the next retry installs (null when nothing moved). [fallbackRef] is the default
     * branch that [RepairController.retryWithDefaultRef] installs instead, offered while a retry can run and
     * [ref] is another branch: a tracked branch that is gone upstream fails every retry of it. Retry itself
     * never switches branches, because most failures (a lost network, say) are worth retrying as they are.
     */
    data class Failed(
        val reason: RepairFailure,
        val source: File?,
        val lines: List<String>,
        val exitCode: Int?,
        val canRetry: Boolean,
        val ref: String? = null,
        val fallbackRef: String? = null,
    ) : RepairState

    /** The reinstall migrated from [source], which is kept until the user deletes it. */
    data class Succeeded(val source: File, val serverStarted: Boolean, val lines: List<String>) : RepairState
}
