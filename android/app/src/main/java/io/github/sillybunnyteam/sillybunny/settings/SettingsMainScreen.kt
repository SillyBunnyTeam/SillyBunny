package io.github.sillybunnyteam.sillybunny.settings

import android.content.ActivityNotFoundException
import androidx.activity.compose.LocalActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.core.app.ActivityCompat
import androidx.lifecycle.compose.LifecycleResumeEffect
import io.github.sillybunnyteam.sillybunny.R
import io.github.sillybunnyteam.sillybunny.server.ServerState
import io.github.sillybunnyteam.sillybunny.server.SetupState
import io.github.sillybunnyteam.sillybunny.update.UpdateCheckFailure
import io.github.sillybunnyteam.sillybunny.update.UpdateCheckResult
import io.github.sillybunnyteam.sillybunny.update.UpdatePhase
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Phases in which the updater is already working, so Check now would only repeat itself. */
private val updaterBusyPhases = setOf(
    UpdatePhase.CHECKING,
    UpdatePhase.DOWNLOADING,
    UpdatePhase.AWAITING_SOURCE_PERMISSION,
    UpdatePhase.INSTALLING,
)

@Composable
internal fun SettingsMainScreen(
    dependencies: SettingsDependencies,
    callbacks: SettingsCallbacks,
    stopInFlight: Boolean,
    onStop: () -> Unit,
    onNavigateUp: () -> Unit,
    onOpenLogs: () -> Unit,
    onShareLogs: () -> Unit,
    onOpenLicenses: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val host = dependencies.serverHost
    val io = dependencies.ioDispatcher
    val serverState by host.state.collectAsState()
    val setupState by host.setup.collectAsState()

    // Battery state and the leftover count can change in other screens, so they are read on every resume.
    var resumes by remember { mutableIntStateOf(0) }
    LifecycleResumeEffect(Unit) {
        resumes++
        onPauseOrDispose { }
    }
    var batteryExempt by remember { mutableStateOf<Boolean?>(null) }
    // Set once none of the battery screens could start, so the entry stops offering a dead shortcut.
    var batteryUnavailable by remember { mutableStateOf(false) }
    LaunchedEffect(resumes, dependencies.battery) {
        if (resumes == 0) return@LaunchedEffect
        val battery = dependencies.battery
        batteryExempt = withContext(io) { runCatching { battery.isExempt() }.getOrNull() }
    }
    val batteryScreen = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        resumes++
    }
    var leftoverCount by remember { mutableStateOf<Int?>(null) }
    LaunchedEffect(resumes, dependencies.leftoverFolders, callbacks.onLeftoverFolders != null) {
        if (resumes == 0 || callbacks.onLeftoverFolders == null) return@LaunchedEffect
        val counter = dependencies.leftoverFolders
        leftoverCount = withContext(io) { runCatching { counter.count() }.getOrNull() }
    }
    // config.yaml can change while the app runs, through the Files app or the server's own settings.
    var dataElsewhere by remember { mutableStateOf(false) }
    LaunchedEffect(resumes, dependencies.dataRoot) {
        val check = dependencies.dataRoot
        if (resumes == 0) return@LaunchedEffect
        dataElsewhere = check != null && withContext(io) { runCatching { check.dataElsewhere() }.getOrNull() } == true
    }
    val runtimeVersions by produceState(emptyList<RuntimeVersion>(), dependencies.runtimeVersions) {
        val source = dependencies.runtimeVersions
        value = withContext(io) { runCatching { source.read() }.getOrDefault(emptyList()) }
    }

    Scaffold(
        modifier = modifier.testTag(SettingsTags.MAIN),
        topBar = { SettingsTopBar(stringResource(R.string.settings_title), onNavigateUp) },
        contentWindowInsets = WindowInsets.safeDrawing,
    ) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .belowTopBar(padding)
                .verticalScroll(rememberScrollState())
                .padding(padding.insideScroll()),
        ) {
            SettingsSectionHeader(stringResource(R.string.settings_section_server))
            ServerEntry(
                state = serverState,
                setupRunning = setupState is SetupState.Running,
                stopInFlight = stopInFlight,
                onStop = onStop,
                onStart = {
                    val current = serverState
                    if (current is ServerState.Failed) host.restart(context) else host.start(context)
                },
            )
            callbacks.onOpenInBrowser?.let { openInBrowser ->
                val running = serverState as? ServerState.Running
                SettingsEntry(
                    headline = stringResource(R.string.settings_open_in_browser),
                    tag = SettingsTags.OPEN_IN_BROWSER,
                    enabled = running != null,
                    onClick = { running?.let { openInBrowser(it.session) } },
                )
            }

            SettingsSectionHeader(stringResource(R.string.settings_section_updates))
            GitAutoUpdateEntries(
                settings = dependencies.appSettings,
                serverRunning = serverState is ServerState.Running,
                onRestart = { host.restart(context) },
            )
            AppUpdateEntries(dependencies.updates)

            SettingsSectionHeader(stringResource(R.string.settings_section_runtime))
            SettingsEntry(
                headline = stringResource(R.string.settings_runtime_node),
                tag = SettingsTags.RUNTIME,
                supporting = runtimeVersions.takeIf { it.isNotEmpty() }
                    ?.joinToString("\n") { "${it.component} ${it.version}" },
                modifier = Modifier.semantics {
                    this[SettingsSemantics.RuntimeVersions] = runtimeVersions.map { "${it.component}=${it.version}" }
                },
            )

            SettingsSectionHeader(stringResource(R.string.settings_section_device))
            SettingsEntry(
                headline = stringResource(R.string.settings_battery),
                tag = SettingsTags.BATTERY,
                supporting = when (batteryExempt) {
                    true -> stringResource(R.string.settings_battery_exempt)
                    false -> stringResource(R.string.settings_battery_not_exempt)
                    null -> null
                },
                enabled = !batteryUnavailable,
                onClick = {
                    val screens = runCatching { dependencies.battery.shortcutIntents(batteryExempt == true) }
                        .getOrDefault(emptyList())
                    // The request screen first; when it does not resolve (or is not ours to start), the system list.
                    val opened = screens.any { intent ->
                        try {
                            batteryScreen.launch(intent)
                            true
                        } catch (_: ActivityNotFoundException) {
                            false
                        } catch (_: SecurityException) {
                            false
                        }
                    }
                    if (!opened) batteryUnavailable = true
                },
                modifier = Modifier.semantics { batteryExempt?.let { this[SettingsSemantics.BatteryExempt] = it } },
            )
            dependencies.localNetwork?.takeIf { it.permission != null }?.let { access ->
                LocalNetworkEntry(access, resumes, io)
            }

            SettingsSectionHeader(stringResource(R.string.settings_section_logs))
            SettingsEntry(
                headline = stringResource(R.string.settings_view_logs),
                tag = SettingsTags.VIEW_LOGS,
                onClick = onOpenLogs,
            )
            SettingsEntry(
                headline = stringResource(R.string.settings_share_logs),
                tag = SettingsTags.SHARE_LOGS,
                onClick = onShareLogs,
            )

            if (callbacks.onRepair != null || callbacks.onLeftoverFolders != null || dataElsewhere) {
                SettingsSectionHeader(stringResource(R.string.settings_section_maintenance))
            }
            if (dataElsewhere) {
                SettingsEntry(
                    headline = stringResource(R.string.settings_data_root_elsewhere),
                    tag = SettingsTags.DATA_ELSEWHERE,
                )
            }
            callbacks.onRepair?.let { repair ->
                SettingsEntry(
                    headline = stringResource(R.string.settings_repair),
                    tag = SettingsTags.REPAIR,
                    onClick = repair,
                )
            }
            callbacks.onLeftoverFolders?.let { leftovers ->
                val count = leftoverCount
                SettingsEntry(
                    headline = stringResource(R.string.settings_leftover_folders),
                    tag = SettingsTags.LEFTOVER_FOLDERS,
                    supporting = count?.let { stringResource(R.string.settings_leftover_count, it) },
                    enabled = count != 0,
                    onClick = leftovers,
                    modifier = Modifier.semantics { count?.let { this[SettingsSemantics.LeftoverCount] = it } },
                )
            }

            SettingsSectionHeader(stringResource(R.string.settings_section_about))
            SettingsEntry(
                headline = stringResource(R.string.settings_licenses),
                tag = SettingsTags.OPEN_LICENSES,
                onClick = onOpenLicenses,
            )
        }
    }
}

@Composable
private fun ServerEntry(
    state: ServerState,
    setupRunning: Boolean,
    stopInFlight: Boolean,
    onStop: () -> Unit,
    onStart: () -> Unit,
) {
    val status = when (state) {
        is ServerState.Stopped -> R.string.settings_server_stopped
        is ServerState.Starting -> R.string.settings_server_starting
        is ServerState.Running -> R.string.settings_server_running
        ServerState.Stopping -> R.string.settings_server_stopping
        is ServerState.Failed -> R.string.settings_server_failed
    }
    val progress = stringResource(R.string.settings_server_progress)
    SettingsEntry(
        headline = stringResource(status),
        tag = SettingsTags.SERVER_STATUS,
        modifier = Modifier.semantics { this[SettingsSemantics.ServerStatus] = state.statusName() },
        trailing = {
            when {
                stopInFlight || state == ServerState.Stopping -> CircularProgressIndicator(
                    modifier = Modifier
                        .size(32.dp)
                        .testTag(SettingsTags.SERVER_PROGRESS)
                        .semantics { contentDescription = progress },
                )
                state is ServerState.Starting || state is ServerState.Running -> Button(
                    onClick = onStop,
                    modifier = Modifier.heightIn(min = 48.dp).testTag(SettingsTags.SERVER_STOP),
                ) { Text(stringResource(R.string.settings_server_stop)) }
                else -> Button(
                    onClick = onStart,
                    // A setup job (first run, Repair) owns the checkout until it finishes.
                    enabled = !setupRunning && (state !is ServerState.Failed || state.canRestart),
                    modifier = Modifier.heightIn(min = 48.dp).testTag(SettingsTags.SERVER_START),
                ) { Text(stringResource(R.string.settings_server_start)) }
            }
        },
    )
}

/**
 * Android 17's optional local-network permission. A tap asks for it while the system dialog can still show; once
 * the dialog no longer shows, and once access is granted, a tap opens the app's page in system settings instead.
 */
@Composable
private fun LocalNetworkEntry(access: LocalNetworkAccess, resumes: Int, io: CoroutineDispatcher) {
    val activity = LocalActivity.current
    val packageName = LocalContext.current.packageName
    var status by remember(access) { mutableStateOf<LocalNetworkStatus?>(null) }
    // Bumped by every answer and every return from system settings. A new key also cancels a read still running.
    var changes by remember { mutableIntStateOf(0) }
    var settingsUnavailable by remember { mutableStateOf(false) }
    LaunchedEffect(resumes, changes, access) {
        if (resumes == 0) return@LaunchedEffect
        status = withContext(io) { runCatching { access.status() }.getOrNull() }
    }
    val scope = rememberCoroutineScope()
    val request = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        val permission = access.permission
        val canAskAgain = activity != null && permission != null &&
            ActivityCompat.shouldShowRequestPermissionRationale(activity, permission)
        scope.launch {
            withContext(io) { access.onRequestResult(granted, canAskAgain) }
            changes++
        }
    }
    val settingsPage = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        changes++
    }
    val current = status
    SettingsEntry(
        headline = stringResource(R.string.settings_local_network),
        tag = SettingsTags.LOCAL_NETWORK,
        supporting = when (current) {
            LocalNetworkStatus.GRANTED -> stringResource(R.string.settings_local_network_granted)
            LocalNetworkStatus.NOT_ASKED, LocalNetworkStatus.DENIED ->
                stringResource(R.string.settings_local_network_not_granted)
            LocalNetworkStatus.BLOCKED -> stringResource(R.string.settings_local_network_blocked)
            LocalNetworkStatus.NOT_REQUIRED, null -> null
        },
        enabled = when (current) {
            LocalNetworkStatus.NOT_ASKED, LocalNetworkStatus.DENIED -> true
            LocalNetworkStatus.BLOCKED, LocalNetworkStatus.GRANTED -> !settingsUnavailable
            LocalNetworkStatus.NOT_REQUIRED, null -> false
        },
        onClick = {
            when (current) {
                LocalNetworkStatus.NOT_ASKED, LocalNetworkStatus.DENIED -> access.permission?.let { request.launch(it) }
                LocalNetworkStatus.BLOCKED, LocalNetworkStatus.GRANTED -> try {
                    settingsPage.launch(LocalNetworkAccess.settingsIntent(packageName))
                } catch (_: ActivityNotFoundException) {
                    settingsUnavailable = true
                }
                LocalNetworkStatus.NOT_REQUIRED, null -> Unit
            }
        },
        modifier = Modifier.semantics { current?.let { this[SettingsSemantics.LocalNetwork] = it } },
    )
}

@Composable
private fun GitAutoUpdateEntries(settings: AppSettings, serverRunning: Boolean, onRestart: () -> Unit) {
    var autoUpdate by remember(settings) { mutableStateOf(settings.autoUpdateGit) }
    SettingsEntry(
        headline = stringResource(R.string.settings_auto_update_git),
        tag = SettingsTags.AUTO_UPDATE_GIT,
        // SILLYBUNNY_AUTO_UPDATE is read when the server starts, so a change waits for the next start.
        supporting = stringResource(R.string.settings_auto_update_git_summary),
        modifier = Modifier.toggleable(value = autoUpdate, role = Role.Switch) { enabled ->
            autoUpdate = enabled
            settings.autoUpdateGit = enabled
        },
        trailing = { Switch(checked = autoUpdate, onCheckedChange = null) },
    )
    if (serverRunning) {
        SettingsEntry(
            headline = stringResource(R.string.settings_restart_server),
            tag = SettingsTags.RESTART_SERVER,
            onClick = onRestart,
        )
    }
}

@Composable
private fun AppUpdateEntries(updates: UpdateControls) {
    val state = updates.state
    val enabled = updates.enabled
    SettingsEntry(
        headline = stringResource(R.string.settings_app_updates),
        tag = SettingsTags.APP_UPDATES,
        modifier = Modifier.toggleable(value = enabled, role = Role.Switch) { updates.enabled = it },
        trailing = { Switch(checked = enabled, onCheckedChange = null) },
    )
    val phase = stringResource(state.phase.label())
    val result = when (val last = state.lastResult) {
        null -> null
        is UpdateCheckResult.Available ->
            stringResource(R.string.settings_update_result_available, last.candidate.manifest.versionName)
        UpdateCheckResult.UpToDate -> stringResource(R.string.settings_update_result_up_to_date)
        is UpdateCheckResult.Failed -> stringResource(last.reason.label())
    }
    SettingsEntry(
        headline = stringResource(R.string.settings_check_now),
        tag = SettingsTags.CHECK_NOW,
        // Settings only asks; the updater's own dialog shows what it found and installs nothing silently.
        supporting = listOfNotNull(phase, result).joinToString("\n"),
        enabled = state.phase !in updaterBusyPhases,
        onClick = updates::checkNow,
        modifier = Modifier.semantics {
            this[SettingsSemantics.UpdatePhaseShown] = state.phase
            this[SettingsSemantics.UpdateResultShown] = state.lastResult.resultName()
        },
    )
}

private fun ServerState.statusName(): String = when (this) {
    is ServerState.Stopped -> "STOPPED"
    is ServerState.Starting -> "STARTING"
    is ServerState.Running -> "RUNNING"
    ServerState.Stopping -> "STOPPING"
    is ServerState.Failed -> "FAILED"
}

private fun UpdatePhase.label(): Int = when (this) {
    UpdatePhase.IDLE -> R.string.settings_update_phase_idle
    UpdatePhase.CHECKING -> R.string.settings_update_phase_checking
    UpdatePhase.AVAILABLE -> R.string.settings_update_phase_available
    UpdatePhase.REQUIRED -> R.string.settings_update_phase_required
    UpdatePhase.DOWNLOADING -> R.string.settings_update_phase_downloading
    UpdatePhase.AWAITING_SOURCE_PERMISSION -> R.string.settings_update_phase_awaiting_source_permission
    UpdatePhase.INSTALLING -> R.string.settings_update_phase_installing
    UpdatePhase.ERROR -> R.string.settings_update_phase_error
    UpdatePhase.UP_TO_DATE -> R.string.settings_update_phase_up_to_date
    UpdatePhase.UPDATED -> R.string.settings_update_phase_updated
}

private fun UpdateCheckFailure.label(): Int = when (this) {
    UpdateCheckFailure.NETWORK -> R.string.settings_update_result_network
    UpdateCheckFailure.INVALID_MANIFEST -> R.string.settings_update_result_invalid_manifest
    UpdateCheckFailure.SIGNER_MISMATCH -> R.string.settings_update_result_signer_mismatch
    UpdateCheckFailure.INVALID_PACKAGE -> R.string.settings_update_result_invalid_package
}

private fun UpdateCheckResult?.resultName(): String = when (this) {
    null -> "NONE"
    is UpdateCheckResult.Available -> "AVAILABLE"
    UpdateCheckResult.UpToDate -> "UP_TO_DATE"
    is UpdateCheckResult.Failed -> "FAILED_" + reason.name
}
