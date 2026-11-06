package io.github.sillybunnyteam.sillybunny.settings

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import io.github.sillybunnyteam.sillybunny.R
import io.github.sillybunnyteam.sillybunny.server.ServerHost
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext

/** How often the open log view reads `ServerHost.recentLogLines()` again. */
const val LOG_REFRESH_MILLIS = 1_000L

/** The log view shows at most this many of the most recent lines. */
const val MAX_LOG_VIEW_LINES = 2_000

/**
 * The in-app log view (plan §4.4, §4.6): `recentLogLines()` oldest first, so the newest line is at the
 * bottom, in selectable monospace text. It refreshes while the screen is started and follows new lines
 * until the user scrolls away from the bottom.
 */
@Composable
fun SettingsLogsScreen(
    host: ServerHost,
    onShare: () -> Unit,
    onNavigateUp: () -> Unit,
    modifier: Modifier = Modifier,
    ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
) {
    val lifecycleOwner = LocalLifecycleOwner.current
    var lines by remember { mutableStateOf<List<String>?>(null) }
    LaunchedEffect(host, lifecycleOwner, ioDispatcher) {
        lifecycleOwner.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (true) {
                val next = withContext(ioDispatcher) {
                    runCatching { host.recentLogLines().takeLast(MAX_LOG_VIEW_LINES) }.getOrNull()
                }
                if (next != null && next != lines) lines = next
                delay(LOG_REFRESH_MILLIS)
            }
        }
    }
    Scaffold(
        modifier = modifier.testTag(SettingsTags.LOGS),
        topBar = {
            SettingsTopBar(
                title = stringResource(R.string.settings_logs_title),
                onNavigateUp = onNavigateUp,
                actions = {
                    TextButton(onClick = onShare, modifier = Modifier.testTag(SettingsTags.LOGS_SHARE)) {
                        Text(stringResource(R.string.settings_logs_share))
                    }
                },
            )
        },
        contentWindowInsets = WindowInsets.safeDrawing,
    ) { padding ->
        val current = lines
        when {
            current == null -> Unit
            current.isEmpty() -> Box(
                modifier = Modifier.fillMaxSize().padding(padding).padding(24.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = stringResource(R.string.settings_logs_empty),
                    modifier = Modifier.testTag(SettingsTags.LOGS_EMPTY),
                )
            }
            else -> LogText(current, padding)
        }
    }
}

@Composable
private fun LogText(lines: List<String>, padding: PaddingValues) {
    val scroll = rememberScrollState()
    val slack = with(LocalDensity.current) { 24.dp.roundToPx() }
    var follow by remember { mutableStateOf(true) }
    LaunchedEffect(scroll, slack) {
        // Only user gestures change whether the view follows: scrolling up stops it, back down resumes.
        snapshotFlow { scroll.isScrollInProgress to (scroll.value >= scroll.maxValue - slack) }
            .collect { (scrolling, atBottom) -> if (scrolling) follow = atBottom }
    }
    LaunchedEffect(scroll) {
        snapshotFlow { scroll.maxValue }.collect { max ->
            if (follow && max != Int.MAX_VALUE && scroll.value != max) scroll.scrollTo(max)
        }
    }
    val text = remember(lines) { lines.joinToString("\n") }
    SelectionContainer(modifier = Modifier.fillMaxSize().belowTopBar(padding)) {
        Text(
            text = text,
            modifier = Modifier
                .fillMaxWidth()
                .verticalScroll(scroll)
                .padding(padding.insideScroll())
                .padding(horizontal = 16.dp, vertical = 8.dp)
                .testTag(SettingsTags.LOGS_TEXT)
                .semantics { this[SettingsSemantics.LogLines] = lines },
            fontFamily = FontFamily.Monospace,
            style = MaterialTheme.typography.bodySmall,
        )
    }
}
