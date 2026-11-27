package io.github.sillybunnyteam.sillybunny.update

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.DialogProperties
import io.github.sillybunnyteam.sillybunny.R

@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun UpdateDialog(
    state: UpdateUiState,
    onUpdate: () -> Unit,
    onCheckNow: () -> Unit,
    onLater: () -> Unit,
) {
    if (!state.visible || state.phase == UpdatePhase.IDLE) return
    AlertDialog(
        modifier = Modifier.semantics { testTagsAsResourceId = true },
        onDismissRequest = onLater,
        properties = DialogProperties(dismissOnClickOutside = false),
        title = {
            Text(
                text = stringResource(
                    if (state.blocked != null) R.string.update_required_title else R.string.update_title,
                ),
                modifier = Modifier.testTag(if (state.blocked != null) "update_required" else "update_title"),
            )
        },
        text = {
            Column(
                modifier = Modifier.heightIn(max = 360.dp).verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                val message = when (state.phase) {
                    UpdatePhase.CHECKING -> R.string.update_checking
                    UpdatePhase.DOWNLOADING -> R.string.update_downloading
                    UpdatePhase.AWAITING_SOURCE_PERMISSION -> R.string.update_unknown_sources
                    UpdatePhase.INSTALLING -> R.string.update_installing
                    UpdatePhase.ERROR -> R.string.update_error
                    UpdatePhase.UP_TO_DATE -> R.string.update_up_to_date
                    UpdatePhase.UPDATED -> R.string.update_updated
                    else -> if (state.blocked != null) R.string.update_required_body else R.string.update_available_body
                }
                Text(
                    text = stringResource(message),
                    modifier = Modifier.testTag(if (state.phase == UpdatePhase.ERROR) "update_error" else "update_message")
                        .semantics { liveRegion = LiveRegionMode.Polite },
                    color = if (state.phase == UpdatePhase.ERROR) MaterialTheme.colorScheme.error else {
                        MaterialTheme.colorScheme.onSurface
                    },
                )
                when (state.phase) {
                    UpdatePhase.DOWNLOADING -> LinearProgressIndicator(
                        progress = {
                            if (state.totalBytes > 0) {
                                (state.downloadedBytes.toFloat() / state.totalBytes).coerceIn(0f, 1f)
                            } else 0f
                        },
                        modifier = Modifier.fillMaxWidth().testTag("update_progress"),
                    )
                    UpdatePhase.CHECKING, UpdatePhase.INSTALLING -> CircularProgressIndicator(
                        modifier = Modifier.testTag("update_progress"),
                    )
                    else -> Unit
                }
            }
        },
        confirmButton = {
            when (state.phase) {
                UpdatePhase.AVAILABLE -> Button(
                    onClick = onUpdate,
                    modifier = Modifier.heightIn(min = 48.dp).testTag("update_confirm"),
                ) { Text(stringResource(R.string.update_confirm)) }
                UpdatePhase.ERROR, UpdatePhase.REQUIRED, UpdatePhase.UP_TO_DATE -> Button(
                    onClick = if (state.candidate != null) onUpdate else onCheckNow,
                    modifier = Modifier.heightIn(min = 48.dp).testTag("update_retry"),
                ) { Text(stringResource(R.string.update_retry)) }
                else -> Unit
            }
        },
        dismissButton = {
            TextButton(
                onClick = onLater,
                modifier = Modifier.heightIn(min = 48.dp).testTag("update_later"),
            ) { Text(stringResource(R.string.update_later)) }
        },
    )
}
