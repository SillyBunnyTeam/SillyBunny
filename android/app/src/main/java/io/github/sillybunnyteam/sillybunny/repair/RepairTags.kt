package io.github.sillybunnyteam.sillybunny.repair

import java.util.Locale

/** Test tags (also exposed as resource IDs for UiAutomator) on the Repair and leftover-folder screens. */
object RepairTags {
    const val CONFIRM = "repair_confirm"
    const val CONFIRM_ACTION = "repair_confirm_action"
    const val CONFIRM_FILE_ACCESS = "repair_confirm_file_access"
    const val CLOSE = "repair_close"
    const val PROGRESS = "repair_progress"
    const val PROGRESS_INDICATOR = "repair_progress_indicator"
    const val LINES = "repair_lines"
    const val CANCEL = "repair_cancel"
    const val CANCELLING = "repair_cancelling"
    const val CANCEL_DIALOG = "repair_cancel_dialog"
    const val CANCEL_CONFIRM = "repair_cancel_confirm"
    const val CANCEL_DISMISS = "repair_cancel_dismiss"
    const val REFUSED = "repair_refused"
    const val FAILED = "repair_failed"
    const val DATA_LOCATION = "repair_data_location"
    const val NOTHING_MOVED = "repair_nothing_moved"
    const val EXIT_CODE = "repair_exit_code"
    const val REF = "repair_ref"
    const val DEFAULT_REF = "repair_default_ref"
    const val RETRY = "repair_retry"
    const val RETRY_DEFAULT = "repair_retry_default"
    const val VIEW_LOGS = "repair_view_logs"
    const val SHARE_LOGS = "repair_share_logs"
    const val SUCCEEDED = "repair_succeeded"
    const val KEPT_FOLDER = "repair_kept_folder"
    const val SUCCEEDED_FILE_ACCESS = "repair_succeeded_file_access"
    const val SERVER_NOT_STARTED = "repair_server_not_started"
    const val START_SERVER = "repair_start_server"
    const val DONE = "repair_done"

    const val LEFTOVER_LIST = "leftover_list"
    const val LEFTOVER_LOADING = "leftover_loading"
    const val LEFTOVER_EMPTY = "leftover_empty"
    const val LEFTOVER_CLOSE = "leftover_close"
    const val LEFTOVER_DELETE_SCREEN = "leftover_delete_screen"
    const val LEFTOVER_DELETE_NAME = "leftover_delete_name"
    const val LEFTOVER_DELETE = "leftover_delete"
    const val LEFTOVER_DELETE_DIALOG = "leftover_delete_dialog"
    const val LEFTOVER_DELETE_DIALOG_NAME = "leftover_delete_dialog_name"
    const val LEFTOVER_DELETE_CONFIRM = "leftover_delete_confirm"
    const val LEFTOVER_DELETE_DISMISS = "leftover_delete_dismiss"
    const val LEFTOVER_DELETING = "leftover_deleting"
    const val LEFTOVER_DELETED = "leftover_deleted"
    const val LEFTOVER_PARTIAL = "leftover_partial"
    const val LEFTOVER_REMOVED = "leftover_removed"
    const val LEFTOVER_REMAINING = "leftover_remaining"
    const val LEFTOVER_EXAMPLES = "leftover_examples"
    const val LEFTOVER_BACK = "leftover_back"

    fun step(step: RepairStep) = "repair_step_${step.name.lowercase(Locale.ROOT)}"

    fun refusal(reason: RepairRefusal) = "repair_refusal_${reason.name.lowercase(Locale.ROOT)}"

    fun failure(reason: RepairFailure) = "repair_failure_${reason.name.lowercase(Locale.ROOT)}"

    fun leftoverItem(name: String) = "leftover_item_$name"

    fun leftoverMovedAt(name: String) = "leftover_moved_at_$name"

    fun leftoverMeasuring(name: String) = "leftover_measuring_$name"

    fun leftoverSize(name: String) = "leftover_size_$name"

    fun leftoverApproximate(name: String) = "leftover_approximate_$name"

    fun leftoverProtection(name: String) = "leftover_protection_$name"

    fun deleteRefusal(reason: DeleteRefusal) = "leftover_refusal_${reason.name.lowercase(Locale.ROOT)}"
}
