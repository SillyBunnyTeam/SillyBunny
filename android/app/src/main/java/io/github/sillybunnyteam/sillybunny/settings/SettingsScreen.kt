package io.github.sillybunnyteam.sillybunny.settings

import androidx.activity.compose.BackHandler
import androidx.activity.compose.PredictiveBackHandler
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import io.github.sillybunnyteam.sillybunny.BuildConfig
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.coroutines.cancellation.CancellationException

/** The screens [SettingsScreen] navigates between; saved across configuration changes. */
enum class SettingsDestination { MAIN, LOGS, LICENSES }

/** How far a predictive-back gesture shrinks a sub-screen before it is released. */
private const val BACK_GESTURE_SCALE = 0.1f

/**
 * Native Settings (plan §4.6) with its logs and licenses sub-screens. System back, including a
 * predictive-back gesture, returns from a sub-screen first; on the main screen it calls [onNavigateUp],
 * like the top bar's up arrow. Host it inside the app's MaterialTheme, edge to edge.
 */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun SettingsScreen(
    dependencies: SettingsDependencies,
    callbacks: SettingsCallbacks,
    onNavigateUp: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var destination by rememberSaveable { mutableStateOf(SettingsDestination.MAIN) }
    var snapshotsCleaned by rememberSaveable { mutableStateOf(false) }
    var stopInFlight by remember { mutableStateOf(false) }
    var backProgress by remember { mutableFloatStateOf(0f) }
    val share = rememberLogShareState()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val host = dependencies.serverHost
    val io = dependencies.ioDispatcher

    // Opening Settings removes log snapshots an earlier share left behind.
    LaunchedEffect(Unit) {
        if (!snapshotsCleaned) {
            withContext(io) { runCatching { LogSharing.deleteSnapshots(context) } }
            snapshotsCleaned = true
        }
    }
    PredictiveBackHandler(enabled = destination != SettingsDestination.MAIN) { events ->
        try {
            events.collect { backProgress = it.progress }
            destination = SettingsDestination.MAIN
        } finally {
            backProgress = 0f
        }
    }
    BackHandler(enabled = destination == SettingsDestination.MAIN, onBack = onNavigateUp)

    val stop: () -> Unit = {
        if (!stopInFlight) {
            stopInFlight = true
            // ServerHost.stop blocks until the process group is gone, so it never runs on the main thread.
            scope.launch {
                try {
                    withContext(io) { host.stop() }
                } catch (error: CancellationException) {
                    throw error
                } catch (_: Exception) {
                    // The host's state flow still reports where the server ended up.
                } finally {
                    stopInFlight = false
                }
            }
        }
    }
    val toMain = { destination = SettingsDestination.MAIN }
    val subScreen = Modifier.graphicsLayer {
        val scale = 1f - BACK_GESTURE_SCALE * backProgress
        scaleX = scale
        scaleY = scale
    }
    // Debug builds expose the test tags as resource ids, so UiAutomator device tests can find them.
    Box(modifier.fillMaxSize().semantics { testTagsAsResourceId = BuildConfig.DEBUG }) {
        when (destination) {
            SettingsDestination.MAIN -> SettingsMainScreen(
                dependencies = dependencies,
                callbacks = callbacks,
                stopInFlight = stopInFlight,
                onStop = stop,
                onNavigateUp = onNavigateUp,
                onOpenLogs = { destination = SettingsDestination.LOGS },
                onShareLogs = share::request,
                onOpenLicenses = { destination = SettingsDestination.LICENSES },
            )
            SettingsDestination.LOGS -> SettingsLogsScreen(
                host = host,
                onShare = share::request,
                onNavigateUp = toMain,
                modifier = subScreen,
                ioDispatcher = io,
            )
            SettingsDestination.LICENSES -> SettingsLicensesScreen(
                source = dependencies.notices,
                onNavigateUp = toMain,
                modifier = subScreen,
                ioDispatcher = io,
            )
        }
        LogShareDialog(share, host::logFiles, io)
    }
}
