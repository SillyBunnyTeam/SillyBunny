package io.github.sillybunnyteam.sillybunny.repair

import android.text.format.DateUtils
import android.text.format.Formatter
import androidx.activity.compose.BackHandler
import androidx.annotation.StringRes
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
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

/**
 * The moved-aside folders (plan §4.6): each with its name, date and size. Deleting happens only on the
 * separate screen for one folder, after a confirmation naming it; nothing is ever deleted automatically.
 */
@Composable
fun LeftoverFoldersScreen(
    folders: LeftoverFolders,
    onClose: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val state by folders.state.collectAsState()
    LaunchedEffect(folders) { folders.refresh() }
    RepairTheme {
        LeftoverFoldersContent(
            state = state,
            onDelete = { name -> folders.delete(name) },
            onClearOutcome = { folders.clearOutcome() },
            onClose = onClose,
            modifier = modifier,
        )
    }
}

/** Stateless leftover-folder screens for [state]. System back returns from the delete screen to the list. */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun LeftoverFoldersContent(
    state: LeftoverState,
    onDelete: (String) -> Unit,
    onClearOutcome: () -> Unit,
    onClose: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var selected by rememberSaveable { mutableStateOf<String?>(null) }
    val leaveDeleteScreen = {
        selected = null
        onClearOutcome()
    }
    BackHandler {
        when {
            state.deleting != null -> Unit
            selected != null -> leaveDeleteScreen()
            else -> onClose()
        }
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
            val name = selected
            if (name == null) {
                FolderList(state, onOpen = { selected = it }, onClose = onClose)
            } else {
                DeleteScreen(state, name, onDelete, onBack = leaveDeleteScreen)
            }
        }
    }
}

@Composable
private fun FolderList(state: LeftoverState, onOpen: (String) -> Unit, onClose: () -> Unit) {
    Text(
        text = stringResource(R.string.leftover_title),
        style = MaterialTheme.typography.headlineSmall,
        modifier = Modifier.testTag(RepairTags.LEFTOVER_LIST),
    )
    when {
        state.folders.isEmpty() && state.loading -> Loading()
        state.folders.isEmpty() -> Text(
            text = stringResource(R.string.leftover_empty),
            modifier = Modifier.testTag(RepairTags.LEFTOVER_EMPTY),
        )
        else -> state.folders.forEachIndexed { index, folder ->
            if (index > 0) HorizontalDivider()
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 48.dp)
                    .clickable { onOpen(folder.name) }
                    .testTag(RepairTags.leftoverItem(folder.name))
                    .padding(vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                FolderDetails(folder, state.sizes[folder.name])
            }
        }
    }
    TextButton(
        onClick = onClose,
        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag(RepairTags.LEFTOVER_CLOSE),
    ) { Text(stringResource(R.string.leftover_close_action)) }
}

@Composable
private fun DeleteScreen(state: LeftoverState, name: String, onDelete: (String) -> Unit, onBack: () -> Unit) {
    var confirming by rememberSaveable { mutableStateOf(false) }
    val folder = state.folders.firstOrNull { it.name == name }
    val outcome = state.lastOutcome?.takeIf { it.name == name }
    val deletingThis = state.deleting == name
    val canDelete = folder != null && folder.protection == null && state.deleting == null && outcome == null
    LaunchedEffect(canDelete) {
        if (!canDelete) confirming = false
    }

    Text(
        text = stringResource(R.string.leftover_delete_title),
        style = MaterialTheme.typography.headlineSmall,
        modifier = Modifier.testTag(RepairTags.LEFTOVER_DELETE_SCREEN),
    )
    Text(
        text = name,
        fontFamily = FontFamily.Monospace,
        style = MaterialTheme.typography.titleMedium,
        modifier = Modifier.testTag(RepairTags.LEFTOVER_DELETE_NAME),
    )
    when {
        folder != null && outcome == null -> FolderDetails(folder, state.sizes[name], showName = false)
        folder == null && outcome == null && state.loading -> Loading()
        folder == null && outcome == null -> Refusal(DeleteRefusal.NOT_A_LEFTOVER)
    }
    if (outcome == null) Text(stringResource(R.string.leftover_delete_warning))
    if (deletingThis) {
        Text(
            text = stringResource(R.string.leftover_deleting),
            modifier = Modifier.testTag(RepairTags.LEFTOVER_DELETING).semantics { liveRegion = LiveRegionMode.Polite },
        )
        LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
    }
    when (val result = outcome?.result) {
        null -> Unit
        is DeleteResult.Deleted -> Text(
            text = stringResource(R.string.leftover_deleted),
            modifier = Modifier.testTag(RepairTags.LEFTOVER_DELETED).semantics { liveRegion = LiveRegionMode.Polite },
        )
        is DeleteResult.Partial -> {
            Text(
                text = stringResource(R.string.leftover_partial),
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier.testTag(RepairTags.LEFTOVER_PARTIAL).semantics { liveRegion = LiveRegionMode.Polite },
            )
            LabeledValue(R.string.leftover_removed_label, result.removedEntries.toString(), RepairTags.LEFTOVER_REMOVED)
            LabeledValue(R.string.leftover_remaining_label, result.remainingEntries.toString(), RepairTags.LEFTOVER_REMAINING)
            if (result.examples.isNotEmpty()) {
                Text(
                    text = result.examples.joinToString("\n"),
                    fontFamily = FontFamily.Monospace,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.testTag(RepairTags.LEFTOVER_EXAMPLES),
                )
            }
        }
        is DeleteResult.Refused -> Refusal(result.reason)
    }
    if (canDelete) {
        Button(
            onClick = { confirming = true },
            colors = ButtonDefaults.buttonColors(
                containerColor = MaterialTheme.colorScheme.error,
                contentColor = MaterialTheme.colorScheme.onError,
            ),
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag(RepairTags.LEFTOVER_DELETE),
        ) { Text(stringResource(R.string.leftover_delete_action)) }
    }
    TextButton(
        onClick = onBack,
        enabled = state.deleting == null,
        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag(RepairTags.LEFTOVER_BACK),
    ) { Text(stringResource(R.string.leftover_back_action)) }

    if (confirming && canDelete) DeleteDialog(name, onDelete) { confirming = false }
}

/** The explicit confirmation step: it names the one folder that will be deleted. */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
private fun DeleteDialog(name: String, onDelete: (String) -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        modifier = Modifier.semantics { testTagsAsResourceId = BuildConfig.DEBUG }.testTag(RepairTags.LEFTOVER_DELETE_DIALOG),
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.leftover_delete_dialog_title)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(stringResource(R.string.leftover_delete_dialog_body))
                Text(
                    text = name,
                    fontFamily = FontFamily.Monospace,
                    modifier = Modifier.testTag(RepairTags.LEFTOVER_DELETE_DIALOG_NAME),
                )
            }
        },
        confirmButton = {
            TextButton(
                onClick = {
                    onDismiss()
                    onDelete(name)
                },
                colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error),
                modifier = Modifier.heightIn(min = 48.dp).testTag(RepairTags.LEFTOVER_DELETE_CONFIRM),
            ) { Text(stringResource(R.string.leftover_delete_dialog_confirm)) }
        },
        dismissButton = {
            TextButton(
                onClick = onDismiss,
                modifier = Modifier.heightIn(min = 48.dp).testTag(RepairTags.LEFTOVER_DELETE_DISMISS),
            ) { Text(stringResource(R.string.leftover_delete_dialog_dismiss)) }
        },
    )
}

@Composable
private fun FolderDetails(folder: LeftoverFolder, size: FolderSize?, showName: Boolean = true) {
    val context = LocalContext.current
    if (showName) {
        Text(text = folder.name, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodyLarge)
    }
    val movedAt = folder.movedAt
    if (movedAt != null) {
        val date = DateUtils.formatDateTime(
            context,
            movedAt.toEpochMilli(),
            DateUtils.FORMAT_SHOW_DATE or DateUtils.FORMAT_SHOW_TIME or DateUtils.FORMAT_SHOW_YEAR,
        )
        LabeledValue(R.string.leftover_moved_at_label, date, RepairTags.leftoverMovedAt(folder.name))
    }
    when {
        size == null -> Text(
            text = stringResource(R.string.leftover_measuring),
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.testTag(RepairTags.leftoverMeasuring(folder.name)),
        )
        size.approximate -> LabeledValue(
            R.string.leftover_size_approximate_label,
            Formatter.formatShortFileSize(context, size.bytes),
            RepairTags.leftoverApproximate(folder.name),
        )
        else -> LabeledValue(
            R.string.leftover_size_label,
            Formatter.formatShortFileSize(context, size.bytes),
            RepairTags.leftoverSize(folder.name),
        )
    }
    folder.protection?.let { reason ->
        Text(
            text = stringResource(refusalText(reason)),
            color = MaterialTheme.colorScheme.error,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.testTag(RepairTags.leftoverProtection(folder.name)),
        )
    }
}

@Composable
private fun Refusal(reason: DeleteRefusal) {
    Text(
        text = stringResource(refusalText(reason)),
        color = MaterialTheme.colorScheme.error,
        modifier = Modifier.testTag(RepairTags.deleteRefusal(reason)),
    )
}

@Composable
private fun Loading() {
    val description = stringResource(R.string.leftover_loading_description)
    LinearProgressIndicator(
        modifier = Modifier
            .fillMaxWidth()
            .testTag(RepairTags.LEFTOVER_LOADING)
            .semantics { contentDescription = description },
    )
}

@StringRes
private fun refusalText(reason: DeleteRefusal): Int = when (reason) {
    DeleteRefusal.NOT_A_LEFTOVER -> R.string.leftover_refusal_not_a_leftover
    DeleteRefusal.REPAIR_SOURCE -> R.string.leftover_refusal_repair_source
    DeleteRefusal.HOLDS_DATA_ROOT -> R.string.leftover_refusal_holds_data_root
    DeleteRefusal.DATA_ROOT_UNKNOWN -> R.string.leftover_refusal_data_root_unknown
    DeleteRefusal.UNSUPPORTED -> R.string.leftover_refusal_unsupported
}
