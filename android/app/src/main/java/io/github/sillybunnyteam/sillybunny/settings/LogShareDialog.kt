package io.github.sillybunnyteam.sillybunny.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.heightIn
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.Saver
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
import androidx.compose.ui.unit.dp
import io.github.sillybunnyteam.sillybunny.BuildConfig
import io.github.sillybunnyteam.sillybunny.R
import io.github.sillybunnyteam.sillybunny.server.ServerHost
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.io.File

enum class LogSharePhase { CONFIRM, PREPARING, NO_LOGS, FAILED }

/** Whether the share confirmation is showing; it survives configuration changes. */
@Stable
class LogShareState internal constructor(visible: Boolean) {
    var visible by mutableStateOf(visible)
        private set

    var phase by mutableStateOf(LogSharePhase.CONFIRM)
        internal set

    /** Shows the warning; nothing is shared until the user confirms it. */
    fun request() {
        if (phase == LogSharePhase.PREPARING) return
        phase = LogSharePhase.CONFIRM
        visible = true
    }

    fun dismiss() {
        if (phase != LogSharePhase.PREPARING) visible = false
    }

    internal fun finish() {
        phase = LogSharePhase.CONFIRM
        visible = false
    }

    internal companion object {
        val Saver: Saver<LogShareState, Boolean> = Saver(save = { it.visible }, restore = { LogShareState(it) })
    }
}

@Composable
fun rememberLogShareState(): LogShareState = rememberSaveable(saver = LogShareState.Saver) { LogShareState(false) }

/**
 * The confirmation in front of [LogSharing.share]: a warning that logs may contain sensitive details,
 * then the share sheet. Place it once per screen and call [LogShareState.request] from a Share action.
 */
@Composable
fun LogShareDialog(state: LogShareState, host: ServerHost, ioDispatcher: CoroutineDispatcher = Dispatchers.IO) =
    LogShareDialog(state, host::logFiles, ioDispatcher)

@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun LogShareDialog(
    state: LogShareState,
    logFiles: () -> List<File>,
    ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
) {
    if (!state.visible) return
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val currentLogFiles by rememberUpdatedState(logFiles)
    val chooserTitle = stringResource(R.string.settings_share_chooser_title)
    val preparing = stringResource(R.string.settings_share_preparing)
    AlertDialog(
        onDismissRequest = state::dismiss,
        // The dialog is its own window, so it repeats the screen's debug-only resource-id exposure.
        modifier = Modifier.semantics { testTagsAsResourceId = BuildConfig.DEBUG }.testTag(SettingsTags.SHARE_DIALOG),
        title = { Text(stringResource(R.string.settings_share_title)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
                Text(
                    text = stringResource(R.string.settings_share_warning),
                    modifier = Modifier.testTag(SettingsTags.SHARE_WARNING),
                )
                when (state.phase) {
                    LogSharePhase.PREPARING -> CircularProgressIndicator(
                        modifier = Modifier.testTag(SettingsTags.SHARE_PROGRESS).semantics { contentDescription = preparing },
                    )
                    LogSharePhase.NO_LOGS -> Text(
                        text = stringResource(R.string.settings_share_no_logs),
                        modifier = Modifier.testTag(SettingsTags.SHARE_NO_LOGS).semantics { liveRegion = LiveRegionMode.Polite },
                    )
                    LogSharePhase.FAILED -> Text(
                        text = stringResource(R.string.settings_share_failed),
                        color = MaterialTheme.colorScheme.error,
                        modifier = Modifier.testTag(SettingsTags.SHARE_FAILED).semantics { liveRegion = LiveRegionMode.Polite },
                    )
                    LogSharePhase.CONFIRM -> Unit
                }
            }
        },
        confirmButton = {
            if (state.phase == LogSharePhase.CONFIRM || state.phase == LogSharePhase.FAILED) {
                Button(
                    onClick = {
                        // A second click before the next frame must not start a second share, whose snapshot
                        // would replace the one the first share is handing to the share sheet.
                        if (state.phase == LogSharePhase.PREPARING) return@Button
                        state.phase = LogSharePhase.PREPARING
                        scope.launch {
                            try {
                                when (LogSharing.share(context, currentLogFiles, ioDispatcher, chooserTitle)) {
                                    LogShareResult.SHARED -> state.finish()
                                    LogShareResult.NO_LOGS -> state.phase = LogSharePhase.NO_LOGS
                                    LogShareResult.FAILED -> state.phase = LogSharePhase.FAILED
                                }
                            } finally {
                                // A cancelled share (the dialog left composition) must not lock the state.
                                if (state.phase == LogSharePhase.PREPARING) state.phase = LogSharePhase.CONFIRM
                            }
                        }
                    },
                    modifier = Modifier.heightIn(min = 48.dp).testTag(SettingsTags.SHARE_CONFIRM),
                ) { Text(stringResource(R.string.settings_share_confirm)) }
            }
        },
        dismissButton = {
            TextButton(
                onClick = state::dismiss,
                enabled = state.phase != LogSharePhase.PREPARING,
                modifier = Modifier.heightIn(min = 48.dp).testTag(SettingsTags.SHARE_CANCEL),
            ) { Text(stringResource(R.string.settings_share_cancel)) }
        },
    )
}
