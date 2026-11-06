package io.github.sillybunnyteam.sillybunny.app

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathBuilder
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.colorResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.findViewTreeViewModelStoreOwner
import androidx.lifecycle.viewmodel.compose.LocalViewModelStoreOwner
import io.github.sillybunnyteam.sillybunny.BuildConfig
import io.github.sillybunnyteam.sillybunny.R
import io.github.sillybunnyteam.sillybunny.firstrun.FirstRunScreen
import io.github.sillybunnyteam.sillybunny.repair.LeftoverFoldersScreen
import io.github.sillybunnyteam.sillybunny.repair.RepairScreen
import io.github.sillybunnyteam.sillybunny.server.LaunchSession
import io.github.sillybunnyteam.sillybunny.settings.LogShareDialog
import io.github.sillybunnyteam.sillybunny.settings.LogShareState
import io.github.sillybunnyteam.sillybunny.settings.SettingsCallbacks
import io.github.sillybunnyteam.sillybunny.settings.SettingsDependencies
import io.github.sillybunnyteam.sillybunny.settings.SettingsLogsScreen
import io.github.sillybunnyteam.sillybunny.settings.SettingsScreen
import io.github.sillybunnyteam.sillybunny.settings.rememberLogShareState
import io.github.sillybunnyteam.sillybunny.web.retainedWebShell
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

/** Test tags of the app's own screens; debug builds expose them as resource IDs for UiAutomator. */
internal object AppTags {
    const val LOADING = "app_loading"
    const val RUNTIME_ERROR = "app_runtime_error"
    const val RUNTIME_RETRY = "app_runtime_retry"
    const val RUNTIME_SHARE_LOGS = "app_runtime_share_logs"
    const val PROGRESS = "app_progress"
    const val FAILED = "app_failed"
    const val FAILED_LINES = "app_failed_lines"
    const val FAILED_RESTART = "app_failed_restart"
    const val FAILED_SHARE_LOGS = "app_failed_share_logs"
    const val FAILED_REPAIR = "app_failed_repair"
    const val STOPPED = "app_stopped"
    const val STOPPED_START = "app_stopped_start"
    const val BAR = "app_bar"
    const val OPEN_SETTINGS = "app_open_settings"
    const val OPEN_IN_BROWSER = "app_open_in_browser"
    const val WEB = "app_web"
    const val ORIGIN_CHANGED = "app_origin_changed"
    const val ORIGIN_CHANGED_OK = "app_origin_changed_ok"
}

/** The app's colours, which the Repair screen's own theme repeats. */
@Composable
internal fun AppTheme(content: @Composable () -> Unit) {
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
 * Everything [AppContent] needs from the activity.
 *
 * @param settings new Settings dependencies; Settings reloads its counts and versions for every new instance.
 * @param onFirstRunShown the first run appeared; its Welcome asks for notifications itself.
 * @param onFirstRunInstalled the first run handed its finished install over; runs again after a recreation.
 * @param onRepairShown the Repair screen appeared, which can start a setup job.
 */
internal class AppActions(
    val settings: () -> SettingsDependencies,
    val openInBrowser: (LaunchSession) -> Unit,
    val onFirstRunShown: () -> Unit,
    val onFirstRunInstalled: () -> Unit,
    val onRepairShown: () -> Unit,
)

/**
 * The route of [coordinator], or the newest overlay instead of it. Only one of them is composed at a time, so
 * system back always reaches the screen on top. One share confirmation serves every screen here.
 */
@Composable
internal fun AppContent(
    coordinator: LaunchCoordinator,
    components: AppComponents,
    actions: AppActions,
    modifier: Modifier = Modifier,
) {
    val route by coordinator.route.collectAsStateWithLifecycle()
    val overlays by coordinator.overlays.collectAsStateWithLifecycle()
    val originWarning by coordinator.originWarning.collectAsStateWithLifecycle()
    val share = rememberLogShareState()
    // Overlays need the laid-out runtime, so they wait behind the loading and runtime error screens.
    val ready = route != AppRoute.Loading && route != AppRoute.RuntimeError
    // Debug builds expose the test tags as resource IDs, so UiAutomator device tests can find them.
    Surface(modifier.fillMaxSize().semantics { testTagsAsResourceId = BuildConfig.DEBUG }) {
        when (val overlay = overlays.lastOrNull()?.takeIf { ready }) {
            null -> RouteContent(route, coordinator, components, actions, share)
            else -> OverlayContent(overlay, coordinator, components, actions, share)
        }
    }
    if (overlays.isEmpty() && route is AppRoute.Web && originWarning != null) {
        OriginChangedDialog(onDismiss = coordinator::dismissOriginWarning)
    }
    LogShareDialog(share, components::logFiles, components.io)
}

@Composable
private fun RouteContent(
    route: AppRoute,
    coordinator: LaunchCoordinator,
    components: AppComponents,
    actions: AppActions,
    share: LogShareState,
) {
    val openSettings = { coordinator.open(Overlay.SETTINGS) }
    when (route) {
        AppRoute.Loading -> LoadingScreen()
        AppRoute.RuntimeError -> RuntimeErrorScreen(onRetry = coordinator::retryLayout, onShareLogs = share::request)
        AppRoute.FirstRun -> FirstRunHost(coordinator, components, actions, share)
        AppRoute.Repair -> RepairHost(coordinator, components, actions, share)
        is AppRoute.Progress -> ProgressScreen(route.stopping, openSettings)
        is AppRoute.Web -> WebHost(route.session, components, openSettings, actions.openInBrowser)
        is AppRoute.ServerFailed -> ServerFailedScreen(
            route = route,
            onRestart = coordinator::requestStart,
            onShareLogs = share::request,
            onRepair = { coordinator.open(Overlay.REPAIR) },
            onOpenSettings = openSettings,
        )
        is AppRoute.ServerStopped -> ServerStoppedScreen(route.userStopped, coordinator::requestStart, openSettings)
    }
}

@Composable
private fun OverlayContent(
    overlay: Overlay,
    coordinator: LaunchCoordinator,
    components: AppComponents,
    actions: AppActions,
    share: LogShareState,
) {
    when (overlay) {
        Overlay.SETTINGS -> {
            val dependencies = remember { actions.settings() }
            val callbacks = remember(coordinator, actions) {
                SettingsCallbacks(
                    onOpenInBrowser = actions.openInBrowser,
                    onRepair = { coordinator.open(Overlay.REPAIR) },
                    onLeftoverFolders = { coordinator.open(Overlay.LEFTOVERS) },
                )
            }
            SettingsScreen(dependencies, callbacks, onNavigateUp = { coordinator.close(Overlay.SETTINGS) })
        }
        Overlay.REPAIR -> RepairHost(coordinator, components, actions, share)
        Overlay.LEFTOVERS -> LeftoverFoldersScreen(
            folders = components.leftovers,
            onClose = { coordinator.close(Overlay.LEFTOVERS) },
        )
        Overlay.LOGS -> {
            val close = { coordinator.close(Overlay.LOGS) }
            BackHandler(onBack = close)
            SettingsLogsScreen(
                host = components.server,
                onShare = share::request,
                onNavigateUp = close,
                ioDispatcher = components.io,
            )
        }
    }
}

@Composable
private fun FirstRunHost(
    coordinator: LaunchCoordinator,
    components: AppComponents,
    actions: AppActions,
    share: LogShareState,
) {
    val owner = checkNotNull(LocalViewModelStoreOwner.current) { "the first run needs a ViewModelStoreOwner" }
    val generation by coordinator.firstRunGeneration.collectAsStateWithLifecycle()
    val controller = remember(owner, generation) { components.firstRunController(owner, generation) }
    LaunchedEffect(Unit) { actions.onFirstRunShown() }
    FirstRunScreen(
        controller = controller,
        onInstalled = actions.onFirstRunInstalled,
        onRepair = { coordinator.open(Overlay.REPAIR) },
        onShareLogs = share::request,
    )
}

@Composable
private fun RepairHost(
    coordinator: LaunchCoordinator,
    components: AppComponents,
    actions: AppActions,
    share: LogShareState,
) {
    LaunchedEffect(Unit) { actions.onRepairShown() }
    RepairScreen(
        controller = components.repair,
        onClose = { coordinator.close(Overlay.REPAIR) },
        onViewLogs = { coordinator.open(Overlay.LOGS) },
        onShareLogs = share::request,
    )
}

@Composable
private fun LoadingScreen() {
    Box(Modifier.fillMaxSize().safeDrawingPadding().testTag(AppTags.LOADING), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(16.dp)) {
            CircularProgressIndicator()
            Text(stringResource(R.string.app_loading), style = MaterialTheme.typography.bodyLarge)
        }
    }
}

/** Nothing here starts setup or the server: the runtime they need is not laid out. */
@Composable
private fun RuntimeErrorScreen(onRetry: () -> Unit, onShareLogs: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .safeDrawingPadding()
            .verticalScroll(rememberScrollState())
            .padding(24.dp)
            .testTag(AppTags.RUNTIME_ERROR),
        verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
    ) {
        Text(stringResource(R.string.app_runtime_error), style = MaterialTheme.typography.titleMedium)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = onRetry, modifier = Modifier.testTag(AppTags.RUNTIME_RETRY)) {
                Text(stringResource(R.string.app_runtime_retry))
            }
            OutlinedButton(onClick = onShareLogs, modifier = Modifier.testTag(AppTags.RUNTIME_SHARE_LOGS)) {
                Text(stringResource(R.string.app_share_logs))
            }
        }
    }
}

@Composable
private fun ProgressScreen(stopping: Boolean, onOpenSettings: () -> Unit) {
    ServerFrame(AppTags.PROGRESS, onOpenSettings, centered = true) {
        CircularProgressIndicator(Modifier.align(Alignment.CenterHorizontally))
        Text(
            text = stringResource(if (stopping) R.string.app_server_stopping else R.string.app_server_starting),
            style = MaterialTheme.typography.bodyLarge,
            modifier = Modifier.align(Alignment.CenterHorizontally),
        )
    }
}

/** Restart only where a start can help ([AppRoute.ServerFailed.canRestart]); Repair always. */
@Composable
private fun ServerFailedScreen(
    route: AppRoute.ServerFailed,
    onRestart: () -> Unit,
    onShareLogs: () -> Unit,
    onRepair: () -> Unit,
    onOpenSettings: () -> Unit,
) {
    ServerFrame(AppTags.FAILED, onOpenSettings, centered = false) {
        Text(stringResource(R.string.app_server_failed), style = MaterialTheme.typography.titleMedium)
        if (route.lines.isNotEmpty()) {
            Text(
                text = route.lines.joinToString("\n"),
                style = MaterialTheme.typography.bodySmall,
                fontFamily = FontFamily.Monospace,
                softWrap = false,
                modifier = Modifier
                    .weight(1f, fill = false)
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .horizontalScroll(rememberScrollState())
                    .testTag(AppTags.FAILED_LINES),
            )
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (route.canRestart) {
                Button(onClick = onRestart, modifier = Modifier.testTag(AppTags.FAILED_RESTART)) {
                    Text(stringResource(R.string.app_server_restart))
                }
            }
            OutlinedButton(onClick = onShareLogs, modifier = Modifier.testTag(AppTags.FAILED_SHARE_LOGS)) {
                Text(stringResource(R.string.app_share_logs))
            }
            OutlinedButton(onClick = onRepair, modifier = Modifier.testTag(AppTags.FAILED_REPAIR)) {
                Text(stringResource(R.string.app_server_repair))
            }
        }
    }
}

@Composable
private fun ServerStoppedScreen(userStopped: Boolean, onStart: () -> Unit, onOpenSettings: () -> Unit) {
    ServerFrame(AppTags.STOPPED, onOpenSettings, centered = true) {
        val message = if (userStopped) R.string.app_server_stopped_by_user else R.string.app_server_stopped
        Text(stringResource(message), style = MaterialTheme.typography.bodyLarge)
        Button(onClick = onStart, modifier = Modifier.testTag(AppTags.STOPPED_START)) {
            Text(stringResource(R.string.app_server_start))
        }
    }
}

/** A server screen: the bar on top, then [content] inside the remaining safe area. */
@Composable
private fun ServerFrame(
    tag: String,
    onOpenSettings: () -> Unit,
    centered: Boolean,
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(Modifier.fillMaxSize().testTag(tag)) {
        AppBar(onOpenSettings = onOpenSettings, onOpenInBrowser = null)
        Column(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .consumeWindowInsets(BAR_INSETS)
                .windowInsetsPadding(WindowInsets.safeDrawing)
                .padding(24.dp),
            verticalArrangement = if (centered) {
                Arrangement.spacedBy(16.dp, Alignment.CenterVertically)
            } else {
                Arrangement.spacedBy(16.dp)
            },
            content = content,
        )
    }
}

/**
 * The native control (plan §4.5): a bar above the web content, so it never covers the web UI. It takes the top
 * and side insets; the content below it takes the rest, the keyboard included.
 */
@Composable
private fun AppBar(onOpenSettings: () -> Unit, onOpenInBrowser: (() -> Unit)?) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .testTag(AppTags.BAR)
            .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal))
            .height(BAR_HEIGHT)
            .padding(start = 16.dp, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = stringResource(R.string.app_name),
            style = MaterialTheme.typography.titleMedium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        if (onOpenInBrowser != null) {
            IconButton(onClick = onOpenInBrowser, modifier = Modifier.testTag(AppTags.OPEN_IN_BROWSER)) {
                Icon(AppIcons.openInBrowser, contentDescription = stringResource(R.string.app_open_in_browser))
            }
        }
        IconButton(onClick = onOpenSettings, modifier = Modifier.testTag(AppTags.OPEN_SETTINGS)) {
            Icon(AppIcons.settings, contentDescription = stringResource(R.string.app_open_settings))
        }
    }
}

/** The web route; web fullscreen (video, for example) hides the bar, so the page gets the whole window. */
@Composable
private fun WebHost(
    session: LaunchSession,
    components: AppComponents,
    onOpenSettings: () -> Unit,
    onOpenInBrowser: (LaunchSession) -> Unit,
) {
    val view = LocalView.current
    val shell = remember(view) {
        val owner = checkNotNull(view.findViewTreeViewModelStoreOwner()) { "WebHost needs a ViewModelStoreOwner" }
        retainedWebShell(owner, view.context)
    }
    val fullscreen = shell.fullscreen != null
    Column(Modifier.fillMaxSize().testTag(AppTags.WEB)) {
        if (!fullscreen) AppBar(onOpenSettings = onOpenSettings, onOpenInBrowser = { onOpenInBrowser(session) })
        val content = Modifier.weight(1f).fillMaxWidth()
        components.webContent(session, if (fullscreen) content else content.consumeWindowInsets(BAR_INSETS))
    }
}

/** The port changed since the previous run, so the page's client-side storage starts empty (plan §4.5). */
@Composable
private fun OriginChangedDialog(onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        modifier = Modifier.semantics { testTagsAsResourceId = BuildConfig.DEBUG }.testTag(AppTags.ORIGIN_CHANGED),
        title = { Text(stringResource(R.string.app_origin_changed_title)) },
        text = { Text(stringResource(R.string.app_origin_changed_body)) },
        confirmButton = {
            TextButton(onClick = onDismiss, modifier = Modifier.testTag(AppTags.ORIGIN_CHANGED_OK)) {
                Text(stringResource(R.string.app_origin_changed_ok))
            }
        },
    )
}

private val BAR_HEIGHT = 48.dp

/** What [AppBar] takes from the safe area, so the content below it does not pad for the status bar again. */
private val BAR_INSETS: WindowInsets
    @Composable get() = WindowInsets.safeDrawing.only(WindowInsetsSides.Top)

/** Drawn in code, because the app has no icon library dependency. */
private object AppIcons {
    private const val CENTER = 12f
    private const val TEETH = 8
    private const val TIP_RADIUS = 10f
    private const val ROOT_RADIUS = 7.6f
    private const val HOLE_RADIUS = 3.2f

    val settings: ImageVector by lazy {
        ImageVector.Builder("settings", 24.dp, 24.dp, 24f, 24f).apply {
            path(fill = SolidColor(Color.Black), pathFillType = PathFillType.EvenOdd) {
                val step = 2 * PI / TEETH
                for (tooth in 0 until TEETH) {
                    val middle = tooth * step
                    polar(ROOT_RADIUS, middle - 0.3 * step, move = tooth == 0)
                    polar(TIP_RADIUS, middle - 0.17 * step)
                    polar(TIP_RADIUS, middle + 0.17 * step)
                    polar(ROOT_RADIUS, middle + 0.3 * step)
                }
                close()
                // Even-odd filling leaves this circle empty.
                moveTo(CENTER + HOLE_RADIUS, CENTER)
                arcTo(HOLE_RADIUS, HOLE_RADIUS, 0f, false, true, CENTER - HOLE_RADIUS, CENTER)
                arcTo(HOLE_RADIUS, HOLE_RADIUS, 0f, false, true, CENTER + HOLE_RADIUS, CENTER)
                close()
            }
        }.build()
    }

    val openInBrowser: ImageVector by lazy {
        ImageVector.Builder("open_in_browser", 24.dp, 24.dp, 24f, 24f).apply {
            path(
                stroke = SolidColor(Color.Black),
                strokeLineWidth = 2f,
                strokeLineCap = StrokeCap.Round,
                strokeLineJoin = StrokeJoin.Round,
            ) {
                moveTo(11f, 5f)
                lineTo(5f, 5f)
                lineTo(5f, 19f)
                lineTo(19f, 19f)
                lineTo(19f, 13f)
                moveTo(10f, 14f)
                lineTo(19f, 5f)
                moveTo(14f, 5f)
                lineTo(19f, 5f)
                lineTo(19f, 10f)
            }
        }.build()
    }

    private fun PathBuilder.polar(radius: Float, angle: Double, move: Boolean = false) {
        val x = CENTER + radius * cos(angle).toFloat()
        val y = CENTER + radius * sin(angle).toFloat()
        if (move) moveTo(x, y) else lineTo(x, y)
    }
}
