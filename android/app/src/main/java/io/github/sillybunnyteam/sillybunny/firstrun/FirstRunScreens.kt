package io.github.sillybunnyteam.sillybunny.firstrun

import android.text.format.Formatter
import androidx.activity.compose.BackHandler
import androidx.activity.compose.LocalActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.StringRes
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.colorResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.app.ActivityCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.sillybunnyteam.sillybunny.BuildConfig
import io.github.sillybunnyteam.sillybunny.R

/**
 * The first-run flow's entry point (plan §4.3). It reports the activity's started state to [controller], runs
 * the notification and battery requests, and handles system back: back closes the log view, and otherwise
 * leaves the app without cancelling a running install. On API 33+, Continue first requests `POST_NOTIFICATIONS`
 * when it was never asked, then continues whatever the answer.
 *
 * [onInstalled] runs once the install succeeded while the activity is started, and again after a recreation in
 * that state, so it must be idempotent. [onRepair] and [onShareLogs] come from the error screen.
 */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun FirstRunScreen(
    controller: FirstRunController,
    onInstalled: () -> Unit,
    onRepair: () -> Unit,
    onShareLogs: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val state by controller.state.collectAsStateWithLifecycle()
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner, controller) {
        val lifecycle = lifecycleOwner.lifecycle
        val observer = LifecycleEventObserver { _, _ ->
            controller.setVisible(lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED))
        }
        lifecycle.addObserver(observer)
        onDispose {
            lifecycle.removeObserver(observer)
            controller.setVisible(false)
        }
    }

    val activity = LocalActivity.current
    // Continue asks for notifications once when they were never asked, then continues whatever the answer.
    var continueAfterAnswer by rememberSaveable { mutableStateOf(false) }
    val notificationLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        val permission = AndroidNotificationPermission.requestPermission()
        val canAskAgain = activity != null && permission != null &&
            ActivityCompat.shouldShowRequestPermissionRationale(activity, permission)
        controller.onNotificationPermissionResult(it, canAskAgain)
        if (continueAfterAnswer) {
            continueAfterAnswer = false
            controller.continueFromWelcome()
        }
    }
    val batteryLauncher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        controller.onBatteryExemptionResult()
    }
    val packageName = LocalContext.current.packageName
    val latestOnRepair by rememberUpdatedState(onRepair)
    val latestOnShareLogs by rememberUpdatedState(onShareLogs)
    val actions = remember(controller, notificationLauncher, batteryLauncher, packageName) {
        object : FirstRunActions {
            override fun requestNotifications() {
                AndroidNotificationPermission.requestPermission()?.let { notificationLauncher.launch(it) }
            }

            override fun requestBatteryExemption() {
                if (BatteryExemptionIntents.launchFirst(packageName) { batteryLauncher.launch(it) } == null) {
                    controller.onBatteryExemptionUnavailable()
                }
            }

            override fun skipBatteryExemption() = controller.skipBatteryExemption()

            override fun continueFromWelcome() {
                val permission = AndroidNotificationPermission.requestPermission()
                if (permission != null && controller.state.value.notifications == NotificationStatus.NOT_ASKED) {
                    continueAfterAnswer = true
                    notificationLauncher.launch(permission)
                } else {
                    controller.continueFromWelcome()
                }
            }

            override fun continueOnMeteredNetwork() = controller.continueOnMeteredNetwork()

            override fun retry() = controller.retry()

            override fun requestCancel() = controller.requestCancel()

            override fun confirmCancel() = controller.confirmCancel()

            override fun dismissCancel() = controller.dismissCancel()

            override fun openLogs() = controller.openLogs()

            override fun closeLogs() = controller.closeLogs()

            override fun shareLogs() = latestOnShareLogs()

            override fun repair() = latestOnRepair()
        }
    }

    BackHandler(enabled = state.logs != null) { controller.closeLogs() }

    val latestOnInstalled by rememberUpdatedState(onInstalled)
    if (state.stage == FirstRunStage.Installed && state.visible) {
        LaunchedEffect(Unit) { latestOnInstalled() }
    }

    FirstRunTheme {
        // Debug builds expose the test tags as resource IDs, so device tests can find controls with UiAutomator.
        Surface(modifier = modifier.fillMaxSize().semantics { testTagsAsResourceId = BuildConfig.DEBUG }) {
            FirstRunContent(state, actions)
        }
    }
}

/** Every user action the screens can trigger. [FirstRunScreen] maps them to the controller and callbacks. */
interface FirstRunActions {
    fun requestNotifications()

    fun requestBatteryExemption()

    fun skipBatteryExemption()

    fun continueFromWelcome()

    fun continueOnMeteredNetwork()

    fun retry()

    fun requestCancel()

    fun confirmCancel()

    fun dismissCancel()

    fun openLogs()

    fun closeLogs()

    fun shareLogs()

    fun repair()
}

/** The same colours as `MainActivity`'s theme. */
@Composable
internal fun FirstRunTheme(content: @Composable () -> Unit) {
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

/** Stateless rendering of [state]: one screen, plus the log view or the cancel confirmation on top. */
@Composable
internal fun FirstRunContent(state: FirstRunUiState, actions: FirstRunActions) {
    val logs = state.logs
    if (logs != null) {
        LogScreen(logs, actions)
    } else {
        when (val stage = state.stage) {
            FirstRunStage.Loading -> ProgressScreen("firstrun_loading", R.string.firstrun_loading)
            FirstRunStage.Welcome -> WelcomeScreen(state.notifications, state.battery, actions)
            FirstRunStage.Checking -> ProgressScreen("firstrun_checking", R.string.firstrun_checking)
            is FirstRunStage.MeteredWarning -> MeteredScreen(stage.cellular, actions)
            FirstRunStage.Preparing -> ProgressScreen("firstrun_preparing", R.string.firstrun_preparing)
            FirstRunStage.WaitingForForeground -> ProgressScreen("firstrun_waiting", R.string.firstrun_waiting)
            is FirstRunStage.Installing -> InstallingScreen(stage, actions)
            FirstRunStage.Busy -> BusyScreen(actions)
            is FirstRunStage.Failed -> FailedScreen(stage, actions)
            FirstRunStage.Installed -> ProgressScreen("firstrun_installed", R.string.firstrun_installed)
        }
    }
    if (state.confirmingCancel) {
        CancelDialog(actions)
    }
}

@Composable
private fun ScreenColumn(tag: String, content: @Composable ColumnScope.() -> Unit) {
    Box(modifier = Modifier.fillMaxSize().safeDrawingPadding(), contentAlignment = Alignment.TopCenter) {
        Column(
            modifier = Modifier
                .widthIn(max = 640.dp)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(24.dp)
                .testTag(tag),
            verticalArrangement = Arrangement.spacedBy(16.dp),
            content = content,
        )
    }
}

@Composable
private fun Title(@StringRes text: Int) {
    Text(
        text = stringResource(text),
        style = MaterialTheme.typography.headlineSmall,
        modifier = Modifier.semantics { heading() },
    )
}

@Composable
private fun Body(@StringRes text: Int, tag: String? = null) {
    Text(
        text = stringResource(text),
        style = MaterialTheme.typography.bodyLarge,
        modifier = if (tag == null) Modifier else Modifier.testTag(tag),
    )
}

@Composable
private fun Status(@StringRes text: Int, tag: String) {
    Text(
        text = stringResource(text),
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.primary,
        modifier = Modifier.testTag(tag).semantics { liveRegion = LiveRegionMode.Polite },
    )
}

@Composable
private fun ActionButton(@StringRes text: Int, tag: String, onClick: () -> Unit) {
    Button(onClick = onClick, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag(tag)) {
        Text(stringResource(text))
    }
}

@Composable
private fun SecondaryButton(@StringRes text: Int, tag: String, onClick: () -> Unit) {
    OutlinedButton(onClick = onClick, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag(tag)) {
        Text(stringResource(text))
    }
}

@Composable
private fun ProgressScreen(tag: String, @StringRes message: Int) {
    Box(
        modifier = Modifier.fillMaxSize().safeDrawingPadding().padding(24.dp).testTag(tag),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            CircularProgressIndicator(modifier = Modifier.testTag("firstrun_progress"))
            Text(
                text = stringResource(message),
                textAlign = TextAlign.Center,
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
            )
        }
    }
}

@Composable
private fun WelcomeScreen(notifications: NotificationStatus, battery: BatteryStatus, actions: FirstRunActions) {
    ScreenColumn("firstrun_welcome") {
        Title(R.string.firstrun_welcome_title)
        Body(R.string.firstrun_welcome_body)
        if (notifications != NotificationStatus.NOT_REQUIRED) {
            OutlinedCard(modifier = Modifier.fillMaxWidth().testTag("firstrun_notifications")) {
                Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(stringResource(R.string.firstrun_notifications_title), style = MaterialTheme.typography.titleMedium)
                    Text(stringResource(R.string.firstrun_notifications_body), style = MaterialTheme.typography.bodyMedium)
                    when (notifications) {
                        NotificationStatus.NOT_ASKED, NotificationStatus.DENIED -> {
                            if (notifications == NotificationStatus.DENIED) {
                                Status(R.string.firstrun_notifications_denied, "firstrun_notifications_denied")
                            }
                            FilledTonalButton(
                                onClick = actions::requestNotifications,
                                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)
                                    .testTag("firstrun_notifications_allow"),
                            ) { Text(stringResource(R.string.firstrun_notifications_allow)) }
                        }
                        NotificationStatus.PERMANENTLY_DENIED ->
                            Status(R.string.firstrun_notifications_blocked, "firstrun_notifications_blocked")
                        NotificationStatus.GRANTED ->
                            Status(R.string.firstrun_notifications_granted, "firstrun_notifications_granted")
                        NotificationStatus.NOT_REQUIRED -> Unit
                    }
                }
            }
        }
        OutlinedCard(modifier = Modifier.fillMaxWidth().testTag("firstrun_battery")) {
            Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(stringResource(R.string.firstrun_battery_title), style = MaterialTheme.typography.titleMedium)
                Text(stringResource(R.string.firstrun_battery_body), style = MaterialTheme.typography.bodyMedium)
                when (battery) {
                    BatteryStatus.NOT_EXEMPT -> {
                        FilledTonalButton(
                            onClick = actions::requestBatteryExemption,
                            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("firstrun_battery_allow"),
                        ) { Text(stringResource(R.string.firstrun_battery_allow)) }
                        TextButton(
                            onClick = actions::skipBatteryExemption,
                            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("firstrun_battery_skip"),
                        ) { Text(stringResource(R.string.firstrun_battery_skip)) }
                    }
                    BatteryStatus.EXEMPT -> Status(R.string.firstrun_battery_exempt, "firstrun_battery_exempt")
                    BatteryStatus.SKIPPED -> Status(R.string.firstrun_battery_skipped, "firstrun_battery_skipped")
                }
            }
        }
        ActionButton(R.string.firstrun_continue, "firstrun_continue", actions::continueFromWelcome)
    }
}

@Composable
private fun MeteredScreen(cellular: Boolean, actions: FirstRunActions) {
    val context = LocalContext.current
    ScreenColumn(if (cellular) "firstrun_cellular" else "firstrun_metered") {
        Title(R.string.firstrun_metered_title)
        Body(if (cellular) R.string.firstrun_cellular_body else R.string.firstrun_metered_body)
        Text(
            text = stringResource(
                R.string.firstrun_download_estimate,
                Formatter.formatShortFileSize(context, InstallDownloadEstimate.TOTAL_MIN_BYTES),
                Formatter.formatShortFileSize(context, InstallDownloadEstimate.TOTAL_MAX_BYTES),
            ),
            style = MaterialTheme.typography.titleMedium,
            modifier = Modifier.testTag("firstrun_download_estimate"),
        )
        Text(
            text = stringResource(
                R.string.firstrun_download_breakdown,
                Formatter.formatShortFileSize(context, InstallDownloadEstimate.CLONE_BYTES),
                Formatter.formatShortFileSize(context, InstallDownloadEstimate.NPM_CI_MIN_BYTES),
                Formatter.formatShortFileSize(context, InstallDownloadEstimate.NPM_CI_MAX_BYTES),
            ),
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.testTag("firstrun_download_breakdown"),
        )
        ActionButton(R.string.firstrun_metered_continue, "firstrun_metered_continue", actions::continueOnMeteredNetwork)
        SecondaryButton(R.string.firstrun_metered_recheck, "firstrun_metered_recheck", actions::retry)
    }
}

@Composable
private fun InstallingScreen(stage: FirstRunStage.Installing, actions: FirstRunActions) {
    var showLog by rememberSaveable { mutableStateOf(false) }
    ScreenColumn("firstrun_installing") {
        Title(R.string.firstrun_installing_title)
        Body(R.string.firstrun_installing_body)
        LinearProgressIndicator(modifier = Modifier.fillMaxWidth().testTag("firstrun_install_progress"))
        stage.lines.lastOrNull()?.let { latest ->
            Text(
                text = latest,
                style = MaterialTheme.typography.bodySmall,
                fontFamily = FontFamily.Monospace,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.testTag("firstrun_install_latest"),
            )
        }
        TextButton(
            onClick = { showLog = !showLog },
            modifier = Modifier.heightIn(min = 48.dp).testTag("firstrun_log_toggle"),
        ) { Text(stringResource(if (showLog) R.string.firstrun_log_hide else R.string.firstrun_log_show)) }
        if (showLog) {
            LogBox(stage.lines, "firstrun_raw_log")
        }
        if (stage.cancelling) {
            Status(R.string.firstrun_cancelling, "firstrun_cancelling")
        } else {
            SecondaryButton(R.string.firstrun_cancel, "firstrun_cancel", actions::requestCancel)
        }
    }
}

/** A bounded, scrollable block of log lines that follows the newest line while scrolled to the end. */
@Composable
private fun LogBox(lines: List<String>, tag: String) {
    val scroll = rememberScrollState()
    LaunchedEffect(scroll) {
        var previousMax = scroll.maxValue
        snapshotFlow { scroll.maxValue }.collect { max ->
            if (scroll.value >= previousMax) scroll.scrollTo(max)
            previousMax = max
        }
    }
    OutlinedCard(modifier = Modifier.fillMaxWidth().testTag(tag)) {
        Text(
            text = lines.joinToString("\n"),
            style = MaterialTheme.typography.bodySmall,
            fontFamily = FontFamily.Monospace,
            modifier = Modifier.fillMaxWidth().heightIn(max = 320.dp).verticalScroll(scroll).padding(12.dp),
        )
    }
}

@Composable
private fun BusyScreen(actions: FirstRunActions) {
    ScreenColumn("firstrun_busy") {
        Title(R.string.firstrun_busy_title)
        Body(R.string.firstrun_busy_body)
        ActionButton(R.string.firstrun_retry, "firstrun_retry", actions::retry)
    }
}

@Composable
private fun FailedScreen(stage: FirstRunStage.Failed, actions: FirstRunActions) {
    ScreenColumn("firstrun_error") {
        Title(R.string.firstrun_error_title)
        FailureMessage(stage.failure)
        if (stage.lines.isNotEmpty()) {
            LogBox(stage.lines.takeLast(ERROR_SCREEN_LINES), "firstrun_error_lines")
        }
        ActionButton(R.string.firstrun_retry, "firstrun_retry", actions::retry)
        SecondaryButton(R.string.firstrun_view_logs, "firstrun_view_logs", actions::openLogs)
        SecondaryButton(R.string.firstrun_share_logs, "firstrun_share_logs", actions::shareLogs)
        Text(
            text = stringResource(R.string.firstrun_logs_sensitive),
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.testTag("firstrun_logs_warning"),
        )
        if (stage.partialCheckout) {
            SecondaryButton(R.string.firstrun_repair, "firstrun_repair", actions::repair)
        }
    }
}

@Composable
private fun FailureMessage(failure: FirstRunFailure) {
    val context = LocalContext.current
    val (tag, text) = when (failure) {
        is FirstRunFailure.LowStorage -> "firstrun_error_storage" to stringResource(
            R.string.firstrun_error_storage,
            Formatter.formatShortFileSize(context, failure.availableBytes),
            Formatter.formatShortFileSize(context, failure.requiredBytes),
        )
        FirstRunFailure.Offline -> "firstrun_error_offline" to stringResource(R.string.firstrun_error_offline)
        is FirstRunFailure.Layout -> "firstrun_error_layout" to
            stringResource(R.string.firstrun_error_layout, failure.reason)
        is FirstRunFailure.Install -> "firstrun_error_install" to
            stringResource(R.string.firstrun_error_install, failure.exitCode)
        FirstRunFailure.Cancelled -> "firstrun_error_cancelled" to stringResource(R.string.firstrun_error_cancelled)
        FirstRunFailure.Interrupted -> "firstrun_error_interrupted" to
            stringResource(R.string.firstrun_error_interrupted)
        FirstRunFailure.NoCheckout -> "firstrun_error_no_checkout" to
            stringResource(R.string.firstrun_error_no_checkout)
        is FirstRunFailure.MoveAside -> "firstrun_error_move_aside" to
            stringResource(R.string.firstrun_error_move_aside, failure.reason)
        is FirstRunFailure.Unexpected -> "firstrun_error_unexpected" to
            stringResource(R.string.firstrun_error_unexpected, failure.reason)
    }
    Text(
        text = text,
        style = MaterialTheme.typography.bodyLarge,
        color = MaterialTheme.colorScheme.error,
        modifier = Modifier.testTag(tag).semantics { liveRegion = LiveRegionMode.Polite },
    )
}

@Composable
private fun LogScreen(view: FirstRunLogView, actions: FirstRunActions) {
    Column(modifier = Modifier.fillMaxSize().safeDrawingPadding().testTag("firstrun_logs")) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(start = 24.dp, end = 8.dp, top = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = stringResource(R.string.firstrun_logs_title),
                style = MaterialTheme.typography.titleLarge,
                modifier = Modifier.weight(1f).semantics { heading() },
            )
            TextButton(
                onClick = actions::closeLogs,
                modifier = Modifier.heightIn(min = 48.dp).testTag("firstrun_logs_close"),
            ) { Text(stringResource(R.string.firstrun_logs_close)) }
        }
        Text(
            text = stringResource(R.string.firstrun_logs_sensitive),
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.padding(horizontal = 24.dp).testTag("firstrun_logs_sensitive"),
        )
        LazyColumn(
            modifier = Modifier.weight(1f).fillMaxWidth().testTag("firstrun_logs_list"),
            contentPadding = PaddingValues(horizontal = 24.dp, vertical = 16.dp),
        ) {
            item { LogHeading(R.string.firstrun_logs_last_lines, "firstrun_logs_last_lines") }
            if (view.lastLines.isEmpty()) {
                item { LogEmpty("firstrun_logs_last_lines_empty") }
            } else {
                items(view.lastLines) { LogLine(it) }
            }
            item { LogHeading(R.string.firstrun_logs_setup_log, "firstrun_logs_setup_log") }
            val setupLog = view.setupLog
            when {
                setupLog == null -> item {
                    CircularProgressIndicator(modifier = Modifier.padding(8.dp).testTag("firstrun_logs_loading"))
                }
                setupLog.isEmpty() -> item { LogEmpty("firstrun_logs_setup_log_empty") }
                else -> items(setupLog) { LogLine(it) }
            }
        }
    }
}

@Composable
private fun LogHeading(@StringRes text: Int, tag: String) {
    Text(
        text = stringResource(text),
        style = MaterialTheme.typography.titleSmall,
        modifier = Modifier.padding(top = 16.dp, bottom = 8.dp).testTag(tag).semantics { heading() },
    )
}

@Composable
private fun LogEmpty(tag: String) {
    Text(
        text = stringResource(R.string.firstrun_logs_empty),
        style = MaterialTheme.typography.bodySmall,
        modifier = Modifier.testTag(tag),
    )
}

@Composable
private fun LogLine(line: String) {
    Text(text = line, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace)
}

@OptIn(ExperimentalComposeUiApi::class)
@Composable
private fun CancelDialog(actions: FirstRunActions) {
    AlertDialog(
        // A dialog is its own window, so it needs its own resource-ID flag.
        modifier = Modifier.semantics { testTagsAsResourceId = BuildConfig.DEBUG }.testTag("firstrun_cancel_dialog"),
        onDismissRequest = actions::dismissCancel,
        title = { Text(stringResource(R.string.firstrun_cancel_title)) },
        text = { Text(stringResource(R.string.firstrun_cancel_body)) },
        confirmButton = {
            TextButton(
                onClick = actions::confirmCancel,
                modifier = Modifier.heightIn(min = 48.dp).testTag("firstrun_cancel_confirm"),
            ) { Text(stringResource(R.string.firstrun_cancel_confirm)) }
        },
        dismissButton = {
            TextButton(
                onClick = actions::dismissCancel,
                modifier = Modifier.heightIn(min = 48.dp).testTag("firstrun_cancel_dismiss"),
            ) { Text(stringResource(R.string.firstrun_cancel_dismiss)) }
        },
    )
}

/** The error screen shows this many of the job's last lines; View logs shows them all. */
private const val ERROR_SCREEN_LINES = 8
