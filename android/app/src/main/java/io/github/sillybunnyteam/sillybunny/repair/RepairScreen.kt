package io.github.sillybunnyteam.sillybunny.repair

import androidx.activity.compose.BackHandler
import androidx.annotation.StringRes
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.colorResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import io.github.sillybunnyteam.sillybunny.BuildConfig
import io.github.sillybunnyteam.sillybunny.R

/** The same colours as `MainActivity`'s theme. */
@Composable
fun RepairTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = darkColorScheme(
            primary = colorResource(R.color.warm_signal),
            onPrimary = colorResource(R.color.shadow_ink),
            background = colorResource(R.color.charcoal_canvas),
            onBackground = colorResource(R.color.linen_text),
            surface = colorResource(R.color.charcoal_canvas),
            onSurface = colorResource(R.color.linen_text),
        ),
        content = content,
    )
}

/**
 * The Repair entry screen (plan §4.7): confirmation, progress, then the result. Settings, the first-run
 * error screen and the server error screen open it. [onViewLogs] and [onShareLogs] open the shared log
 * view and share sheet; [onClose] leaves the screen. System back never cancels a running Repair.
 */
@Composable
fun RepairScreen(
    controller: RepairController,
    onClose: () -> Unit,
    onViewLogs: () -> Unit,
    onShareLogs: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val state by controller.state.collectAsState()
    RepairTheme {
        RepairContent(
            state = state,
            onConfirm = { controller.start() },
            onCancel = { controller.cancel() },
            onRetry = { controller.retry() },
            onRetryWithDefaultRef = { controller.retryWithDefaultRef() },
            onStartServer = { controller.startServer() },
            onClose = {
                controller.dismiss()
                onClose()
            },
            onViewLogs = onViewLogs,
            onShareLogs = onShareLogs,
            modifier = modifier,
        )
    }
}

/** Stateless Repair screen for [state]. System back leaves it, except while Repair runs, when it does nothing. */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun RepairContent(
    state: RepairState,
    onConfirm: () -> Unit,
    onCancel: () -> Unit,
    onRetry: () -> Unit,
    onRetryWithDefaultRef: () -> Unit,
    onStartServer: () -> Unit,
    onClose: () -> Unit,
    onViewLogs: () -> Unit,
    onShareLogs: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var confirmingCancel by rememberSaveable { mutableStateOf(false) }
    val cancellable = (state as? RepairState.Running)?.canCancel == true
    LaunchedEffect(cancellable) {
        if (!cancellable) confirmingCancel = false
    }
    // System back never cancels a running Repair: cancelling takes the confirmed Cancel action.
    BackHandler {
        if (state !is RepairState.Running) onClose()
    }
    Surface(modifier = modifier.fillMaxSize()) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .semantics { testTagsAsResourceId = BuildConfig.DEBUG }
                .safeDrawingPadding()
                .verticalScroll(rememberScrollState())
                .padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            when (state) {
                RepairState.Idle -> Confirmation(onConfirm, onClose)
                is RepairState.Running -> Progress(state) { confirmingCancel = true }
                is RepairState.Refused -> Refusal(state, onClose)
                is RepairState.Failed -> Failure(state, onRetry, onRetryWithDefaultRef, onViewLogs, onShareLogs, onClose)
                is RepairState.Succeeded -> Success(state, onStartServer, onClose)
            }
        }
    }
    if (confirmingCancel && cancellable) {
        AlertDialog(
            modifier = Modifier.semantics { testTagsAsResourceId = BuildConfig.DEBUG }.testTag(RepairTags.CANCEL_DIALOG),
            onDismissRequest = { confirmingCancel = false },
            title = { Text(stringResource(R.string.repair_cancel_dialog_title)) },
            text = { Text(stringResource(R.string.repair_cancel_dialog_body)) },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirmingCancel = false
                        onCancel()
                    },
                    modifier = Modifier.heightIn(min = 48.dp).testTag(RepairTags.CANCEL_CONFIRM),
                ) { Text(stringResource(R.string.repair_cancel_dialog_confirm)) }
            },
            dismissButton = {
                TextButton(
                    onClick = { confirmingCancel = false },
                    modifier = Modifier.heightIn(min = 48.dp).testTag(RepairTags.CANCEL_DISMISS),
                ) { Text(stringResource(R.string.repair_cancel_dialog_dismiss)) }
            },
        )
    }
}

@Composable
private fun Confirmation(onConfirm: () -> Unit, onClose: () -> Unit) {
    Title(R.string.repair_confirm_title, RepairTags.CONFIRM)
    Text(stringResource(R.string.repair_confirm_body))
    Text(stringResource(R.string.repair_confirm_nothing_deleted), style = MaterialTheme.typography.bodyLarge)
    // Maintenance revokes every document ID and grant, so file managers must be granted access again (§4.8).
    Text(
        text = stringResource(R.string.repair_confirm_file_access),
        modifier = Modifier.testTag(RepairTags.CONFIRM_FILE_ACCESS),
    )
    Button(
        onClick = onConfirm,
        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag(RepairTags.CONFIRM_ACTION),
    ) { Text(stringResource(R.string.repair_confirm_action)) }
    CloseButton(R.string.repair_close_action, RepairTags.CLOSE, onClose)
}

@Composable
private fun Progress(state: RepairState.Running, onCancelRequest: () -> Unit) {
    Title(R.string.repair_progress_title, RepairTags.PROGRESS)
    Text(
        text = stringResource(stepText(state.step)),
        modifier = Modifier.testTag(RepairTags.step(state.step)).semantics { liveRegion = LiveRegionMode.Polite },
    )
    // The branch being installed: a branch that is gone upstream explains a failed reinstall.
    state.ref?.let { LabeledValue(R.string.repair_ref_label, it, RepairTags.REF, monospace = true) }
    val description = stringResource(R.string.repair_progress_description)
    LinearProgressIndicator(
        modifier = Modifier
            .fillMaxWidth()
            .testTag(RepairTags.PROGRESS_INDICATOR)
            .semantics { contentDescription = description },
    )
    if (state.lines.isNotEmpty()) OutputLines(state.lines)
    if (state.cancelling) {
        Text(
            text = stringResource(R.string.repair_cancelling),
            modifier = Modifier.testTag(RepairTags.CANCELLING).semantics { liveRegion = LiveRegionMode.Polite },
        )
    }
    if (state.canCancel) {
        OutlinedButton(
            onClick = onCancelRequest,
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag(RepairTags.CANCEL),
        ) { Text(stringResource(R.string.repair_cancel_action)) }
    }
}

@Composable
private fun Refusal(state: RepairState.Refused, onClose: () -> Unit) {
    Title(R.string.repair_refused_title, RepairTags.REFUSED)
    Text(
        text = stringResource(refusalText(state.reason)),
        color = MaterialTheme.colorScheme.error,
        modifier = Modifier.testTag(RepairTags.refusal(state.reason)),
    )
    CloseButton(R.string.repair_close_action, RepairTags.CLOSE, onClose)
}

@Composable
private fun Failure(
    state: RepairState.Failed,
    onRetry: () -> Unit,
    onRetryWithDefaultRef: () -> Unit,
    onViewLogs: () -> Unit,
    onShareLogs: () -> Unit,
    onClose: () -> Unit,
) {
    Title(R.string.repair_failed_title, RepairTags.FAILED)
    Text(
        text = stringResource(failureText(state.reason)),
        color = MaterialTheme.colorScheme.error,
        modifier = Modifier.testTag(RepairTags.failure(state.reason)),
    )
    val exitCode = state.exitCode
    if (exitCode != null && exitCode != 0) {
        LabeledValue(R.string.repair_exit_code_label, exitCode.toString(), RepairTags.EXIT_CODE)
    }
    val source = state.source
    if (source != null) {
        LabeledValue(R.string.repair_data_location_label, source.name, RepairTags.DATA_LOCATION, monospace = true)
        state.ref?.let { LabeledValue(R.string.repair_ref_label, it, RepairTags.REF, monospace = true) }
    } else {
        Text(
            text = stringResource(R.string.repair_nothing_moved),
            modifier = Modifier.testTag(RepairTags.NOTHING_MOVED),
        )
    }
    if (state.lines.isNotEmpty()) OutputLines(state.lines)
    if (state.canRetry) {
        Button(
            onClick = onRetry,
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag(RepairTags.RETRY),
        ) { Text(stringResource(R.string.repair_retry_action)) }
    }
    // Retry keeps the branch; a tracked branch deleted upstream needs this way out to the default branch.
    val fallbackRef = state.fallbackRef
    if (fallbackRef != null) {
        LabeledValue(R.string.repair_default_ref_label, fallbackRef, RepairTags.DEFAULT_REF, monospace = true)
        OutlinedButton(
            onClick = onRetryWithDefaultRef,
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag(RepairTags.RETRY_DEFAULT),
        ) { Text(stringResource(R.string.repair_retry_default_action)) }
    }
    OutlinedButton(
        onClick = onViewLogs,
        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag(RepairTags.VIEW_LOGS),
    ) { Text(stringResource(R.string.repair_view_logs_action)) }
    OutlinedButton(
        onClick = onShareLogs,
        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag(RepairTags.SHARE_LOGS),
    ) { Text(stringResource(R.string.repair_share_logs_action)) }
    CloseButton(R.string.repair_close_action, RepairTags.CLOSE, onClose)
}

@Composable
private fun Success(state: RepairState.Succeeded, onStartServer: () -> Unit, onClose: () -> Unit) {
    Title(R.string.repair_succeeded_title, RepairTags.SUCCEEDED)
    Text(stringResource(R.string.repair_succeeded_body))
    LabeledValue(R.string.repair_kept_folder_label, state.source.name, RepairTags.KEPT_FOLDER, monospace = true)
    Text(
        text = stringResource(R.string.repair_succeeded_file_access),
        modifier = Modifier.testTag(RepairTags.SUCCEEDED_FILE_ACCESS),
    )
    if (!state.serverStarted) {
        Text(
            text = stringResource(R.string.repair_server_not_started),
            modifier = Modifier.testTag(RepairTags.SERVER_NOT_STARTED),
        )
        Button(
            onClick = onStartServer,
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag(RepairTags.START_SERVER),
        ) { Text(stringResource(R.string.repair_start_server_action)) }
    }
    CloseButton(R.string.repair_done_action, RepairTags.DONE, onClose)
}

@Composable
private fun Title(@StringRes text: Int, tag: String) {
    Text(
        text = stringResource(text),
        style = MaterialTheme.typography.headlineSmall,
        modifier = Modifier.testTag(tag),
    )
}

@Composable
private fun CloseButton(@StringRes text: Int, tag: String, onClick: () -> Unit) {
    TextButton(
        onClick = onClick,
        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag(tag),
    ) { Text(stringResource(text)) }
}

/** A placeholder label with its value (a name, date, size or count) as separate text, never formatted into it. */
@Composable
internal fun LabeledValue(@StringRes label: Int, value: String, tag: String, monospace: Boolean = false) {
    Column(
        modifier = Modifier.fillMaxWidth().testTag(tag),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Text(text = stringResource(label), style = MaterialTheme.typography.labelLarge)
        Text(
            text = value,
            fontFamily = if (monospace) FontFamily.Monospace else null,
            style = MaterialTheme.typography.bodyLarge,
        )
    }
}

/** The tail of the reinstall output, newest at the bottom, selectable. */
@Composable
private fun OutputLines(lines: List<String>) {
    val scroll = rememberScrollState()
    LaunchedEffect(lines) { scroll.scrollTo(scroll.maxValue) }
    val description = stringResource(R.string.repair_lines_description)
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(max = 240.dp)
            .border(1.dp, MaterialTheme.colorScheme.outline, MaterialTheme.shapes.small)
            .verticalScroll(scroll)
            .padding(8.dp)
            .testTag(RepairTags.LINES)
            .semantics { contentDescription = description },
    ) {
        SelectionContainer {
            Text(
                text = lines.joinToString("\n"),
                fontFamily = FontFamily.Monospace,
                style = MaterialTheme.typography.bodySmall,
            )
        }
    }
}

@StringRes
private fun stepText(step: RepairStep): Int = when (step) {
    RepairStep.CHECKING -> R.string.repair_step_checking
    RepairStep.STOPPING_SERVER -> R.string.repair_step_stopping_server
    RepairStep.PAUSING_FILE_ACCESS -> R.string.repair_step_pausing_file_access
    RepairStep.MOVING_ASIDE -> R.string.repair_step_moving_aside
    RepairStep.MOVING_PARTIAL_ASIDE -> R.string.repair_step_moving_partial_aside
    RepairStep.REINSTALLING -> R.string.repair_step_reinstalling
    RepairStep.STARTING_SERVER -> R.string.repair_step_starting_server
}

@StringRes
private fun refusalText(reason: RepairRefusal): Int = when (reason) {
    RepairRefusal.CHECKOUT_MISSING -> R.string.repair_refused_checkout_missing
    RepairRefusal.CHECKOUT_NOT_DIRECTORY -> R.string.repair_refused_checkout_not_directory
    RepairRefusal.NOT_SILLYBUNNY -> R.string.repair_refused_not_sillybunny
    RepairRefusal.CONFIG_UNREADABLE -> R.string.repair_refused_config_unreadable
    RepairRefusal.DATA_ROOT_INSIDE_CHECKOUT -> R.string.repair_refused_data_root_inside_checkout
    RepairRefusal.DATA_ROOT_OUTSIDE_CHECKOUT -> R.string.repair_refused_data_root_outside_checkout
    RepairRefusal.SETUP_BUSY -> R.string.repair_refused_setup_busy
    RepairRefusal.RECORD_UNREADABLE -> R.string.repair_refused_record_unreadable
}

@StringRes
private fun failureText(reason: RepairFailure): Int = when (reason) {
    RepairFailure.RECORD_UNWRITABLE -> R.string.repair_failed_record_unwritable
    RepairFailure.STOP_TIMEOUT -> R.string.repair_failed_stop_timeout
    RepairFailure.MAINTENANCE_FAILED -> R.string.repair_failed_maintenance_failed
    RepairFailure.NOT_VISIBLE -> R.string.repair_failed_not_visible
    RepairFailure.MOVE_FAILED -> R.string.repair_failed_move_failed
    RepairFailure.SOURCE_MISSING -> R.string.repair_failed_source_missing
    RepairFailure.SOURCE_INVALID -> R.string.repair_failed_source_invalid
    RepairFailure.SETUP_BUSY -> R.string.repair_failed_setup_busy
    RepairFailure.PARTIAL_NOT_DIRECTORY -> R.string.repair_failed_partial_not_directory
    RepairFailure.PARTIAL_MOVE_FAILED -> R.string.repair_failed_partial_move_failed
    RepairFailure.SETUP_REFUSED -> R.string.repair_failed_setup_refused
    RepairFailure.INSTALL_FAILED -> R.string.repair_failed_install_failed
    RepairFailure.NOT_A_CHECKOUT -> R.string.repair_failed_not_a_checkout
    RepairFailure.CANCELLED -> R.string.repair_failed_cancelled
    RepairFailure.INTERRUPTED -> R.string.repair_failed_interrupted
    RepairFailure.UNEXPECTED_ERROR -> R.string.repair_failed_unexpected_error
}
