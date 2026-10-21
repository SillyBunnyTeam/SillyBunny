package io.github.sillybunnyteam.sillybunny.firstrun

import android.os.Bundle
import io.github.sillybunnyteam.sillybunny.checkout.BrokenCheckouts
import io.github.sillybunnyteam.sillybunny.server.ServerState
import io.github.sillybunnyteam.sillybunny.server.SetupJob
import io.github.sillybunnyteam.sillybunny.server.SetupState
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.firstOrNull
import kotlinx.coroutines.flow.transformWhile
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * The first-run flow of plan §4.3 as one state machine: Welcome, preflight, runtime layout, install, then
 * success or the error screen. Every Android dependency comes from [dependencies]; blocking work runs on
 * its IO dispatcher. Call every method on [scope]'s thread (the main thread in production).
 *
 * Lifecycle rules (plan §4.3, R2 §2): `ServerHost.runSetup` is called only while the activity is started,
 * rechecked after every asynchronous step, and otherwise waits for the next start. The install itself runs
 * in the server host's foreground service, so it survives backgrounding; this controller only observes it.
 *
 * Recreation: [saveState] returns the minimal record; a controller built with it derives the rest from
 * `ServerHost.setup` and the filesystem. A partial checkout is never deleted: it is moved aside with
 * [BrokenCheckouts.moveAside] right before `install.sh` runs again.
 *
 * `checkoutDir` is left alone while the server or any setup job runs (Repair clones and migrates into it):
 * the flow shows Busy instead. A finished checkout found there counts as installed and is never moved.
 */
class FirstRunController(
    private val dependencies: FirstRunDependencies,
    private val scope: CoroutineScope,
    restoredState: Bundle? = null,
) {
    private val paths = dependencies.paths
    private val host = dependencies.serverHost
    private val io = dependencies.ioDispatcher
    private val restored = FirstRunSnapshot.fromBundle(restoredState)

    private val mutableState = MutableStateFlow(FirstRunUiState())

    /** The current screen state. */
    val state: StateFlow<FirstRunUiState> = mutableState.asStateFlow()

    private var pipeline: Job? = null
    private var observer: Job? = null
    private var startedJob: SetupJob? = null
    private var cancelRequested = restored?.cancelRequested ?: false
    private var sawRunning = false

    init {
        pipeline = scope.launch { restore() }
    }

    /** Report whether the activity is at least started. Also re-reads the permission and battery state. */
    fun setVisible(started: Boolean) {
        if (state.value.visible == started) return
        mutableState.update { it.copy(visible = started) }
        if (!started) return
        refreshPermissions()
        if (state.value.stage == FirstRunStage.WaitingForForeground) {
            launchPipeline { installWhenVisible() }
        }
    }

    /** Re-reads the notification permission and battery exemption, which the user may change in Settings. */
    fun refreshPermissions() {
        mutableState.update {
            it.copy(notifications = currentNotifications(it.notifications), battery = currentBattery(it.battery))
        }
    }

    /**
     * The result of the `POST_NOTIFICATIONS` request. [canAskAgain] is
     * `shouldShowRequestPermissionRationale` read right after the result.
     */
    fun onNotificationPermissionResult(granted: Boolean, canAskAgain: Boolean) {
        val permission = dependencies.notifications
        mutableState.update {
            val next = when {
                !permission.required -> NotificationStatus.NOT_REQUIRED
                granted || permission.isGranted() -> NotificationStatus.GRANTED
                // A first result without a rationale can be a dismissed dialog. Only a repeated denial is
                // permanent; the system then stops showing the dialog.
                !canAskAgain && (
                    it.notifications == NotificationStatus.DENIED ||
                        it.notifications == NotificationStatus.PERMANENTLY_DENIED
                    ) -> NotificationStatus.PERMANENTLY_DENIED
                else -> NotificationStatus.DENIED
            }
            it.copy(notifications = next)
        }
    }

    /** The user came back from the battery-exemption dialog or settings list. */
    fun onBatteryExemptionResult() {
        val exempt = dependencies.battery.isExempt()
        mutableState.update { it.copy(battery = if (exempt) BatteryStatus.EXEMPT else BatteryStatus.SKIPPED) }
    }

    /** Skip the exemption; it stays available in Settings. */
    fun skipBatteryExemption() {
        mutableState.update { if (it.battery == BatteryStatus.EXEMPT) it else it.copy(battery = BatteryStatus.SKIPPED) }
    }

    /** Neither the exemption dialog nor the settings list could be opened. */
    fun onBatteryExemptionUnavailable() = skipBatteryExemption()

    /** Continue from Welcome, whatever the permission and exemption answers were. */
    fun continueFromWelcome() {
        if (state.value.stage != FirstRunStage.Welcome) return
        enter(FirstRunStage.Checking)
        launchPipeline { runPreflight() }
    }

    /** Continue after the metered or cellular warning. */
    fun continueOnMeteredNetwork() {
        if (state.value.stage !is FirstRunStage.MeteredWarning) return
        enter(FirstRunStage.Preparing)
        launchPipeline { prepareAndInstall() }
    }

    /** Retry from the error or busy screen, or check the network again from the metered warning. */
    fun retry() {
        when (state.value.stage) {
            is FirstRunStage.Failed, FirstRunStage.Busy, is FirstRunStage.MeteredWarning -> {
                enter(FirstRunStage.Checking)
                launchPipeline { retryPipeline() }
            }
            else -> Unit
        }
    }

    /** Ask to cancel the running install; [confirmCancel] does it. */
    fun requestCancel() {
        val stage = state.value.stage
        if (stage is FirstRunStage.Installing && !stage.cancelling) {
            mutableState.update { it.copy(confirmingCancel = true) }
        }
    }

    fun dismissCancel() {
        mutableState.update { it.copy(confirmingCancel = false) }
    }

    /** Cancels the install job's process group; the error screen follows once the job reports finished. */
    fun confirmCancel() {
        mutableState.update { it.copy(confirmingCancel = false) }
        val stage = state.value.stage as? FirstRunStage.Installing ?: return
        if (stage.cancelling) return
        cancelRequested = true
        enter(stage.copy(cancelling = true))
        // Not tied to the scope: a confirmed cancel still happens if the screen goes away right after it.
        scope.launch(io + NonCancellable) {
            try {
                host.cancelSetup()
            } catch (_: RuntimeException) {
                // The job then simply runs to its end; the observer still reports it.
            }
        }
    }

    /** Opens the log sub-view from the error screen. */
    fun openLogs() {
        val stage = state.value.stage as? FirstRunStage.Failed ?: return
        mutableState.update { it.copy(logs = FirstRunLogView(stage.lines, setupLog = null)) }
        scope.launch {
            val log = try {
                withContext(io) { dependencies.setupLog.read() }
            } catch (cancel: CancellationException) {
                throw cancel
            } catch (_: Exception) {
                emptyList()
            }
            mutableState.update { current ->
                val view = current.logs ?: return@update current
                current.copy(logs = view.copy(setupLog = log))
            }
        }
    }

    fun closeLogs() {
        mutableState.update { it.copy(logs = null) }
    }

    /**
     * System back: closes the cancel confirmation or the log view and returns true. Otherwise returns false so
     * back leaves the app; it never cancels a running install.
     */
    fun handleBack(): Boolean {
        val current = state.value
        return when {
            current.confirmingCancel -> {
                dismissCancel()
                true
            }
            current.logs != null -> {
                closeLogs()
                true
            }
            else -> false
        }
    }

    /** The minimal record for `onSaveInstanceState`; pass it back as `restoredState`. */
    fun saveState(): Bundle {
        val current = state.value
        val stage = when (current.stage) {
            FirstRunStage.Loading -> return restored?.toBundle() ?: Bundle()
            FirstRunStage.Welcome -> FirstRunSnapshot.Stage.WELCOME
            FirstRunStage.Checking -> FirstRunSnapshot.Stage.CHECKING
            is FirstRunStage.MeteredWarning -> FirstRunSnapshot.Stage.METERED
            FirstRunStage.Preparing -> FirstRunSnapshot.Stage.PREPARING
            FirstRunStage.WaitingForForeground -> FirstRunSnapshot.Stage.WAITING
            is FirstRunStage.Installing -> FirstRunSnapshot.Stage.INSTALLING
            FirstRunStage.Busy -> FirstRunSnapshot.Stage.BUSY
            is FirstRunStage.Failed -> FirstRunSnapshot.Stage.FAILED
            FirstRunStage.Installed -> FirstRunSnapshot.Stage.INSTALLED
        }
        return FirstRunSnapshot(
            stage = stage,
            cellular = (current.stage as? FirstRunStage.MeteredWarning)?.cellular ?: false,
            failure = (current.stage as? FirstRunStage.Failed)?.failure,
            notifications = current.notifications,
            battery = current.battery,
            cancelRequested = cancelRequested,
            logsOpen = current.logs != null,
        ).toBundle()
    }

    private suspend fun restore() {
        val saved = restored
        mutableState.update {
            it.copy(
                notifications = currentNotifications(saved?.notifications ?: NotificationStatus.NOT_ASKED),
                battery = currentBattery(saved?.battery ?: BatteryStatus.NOT_EXEMPT),
            )
        }
        val setup = host.setup.value
        val running = setup as? SetupState.Running
        when {
            running != null && isOurs(running.job) -> {
                sawRunning = true
                enter(FirstRunStage.Installing(running.lines, cancelling = cancelRequested))
                observeSetup()
            }
            running != null -> enter(FirstRunStage.Busy)
            saved == null -> deriveFresh(setup)
            else -> deriveSaved(saved, setup)
        }
        if (saved?.logsOpen == true) openLogs()
    }

    private suspend fun deriveFresh(setup: SetupState) {
        val finished = setup as? SetupState.Finished
        if (finished != null && isOurs(finished.job)) {
            complete(finished)
            return
        }
        when (inspect()) {
            CheckoutStatus.INSTALLED -> enter(FirstRunStage.Installed)
            CheckoutStatus.PARTIAL -> fail(FirstRunFailure.Interrupted, known = CheckoutStatus.PARTIAL)
            CheckoutStatus.ABSENT, CheckoutStatus.EMPTY -> enter(FirstRunStage.Welcome)
        }
    }

    private suspend fun deriveSaved(saved: FirstRunSnapshot, setup: SetupState) {
        val finished = (setup as? SetupState.Finished)?.takeIf { isOurs(it.job) }
        when (saved.stage) {
            FirstRunSnapshot.Stage.WELCOME -> enter(FirstRunStage.Welcome)
            FirstRunSnapshot.Stage.METERED -> enter(FirstRunStage.MeteredWarning(saved.cellular))
            // The user had already continued; preflight and layout are repeatable, and the install still
            // waits for a started activity.
            FirstRunSnapshot.Stage.CHECKING,
            FirstRunSnapshot.Stage.PREPARING,
            FirstRunSnapshot.Stage.WAITING,
            -> runPreflight()
            FirstRunSnapshot.Stage.INSTALLING -> when {
                finished != null -> complete(finished)
                else -> {
                    // The job is gone without a result, so the process died while it ran. Only a clone that
                    // committed its index (see FileCheckoutInspector) counts as installed.
                    val checkout = inspect()
                    if (checkout == CheckoutStatus.INSTALLED) {
                        enter(FirstRunStage.Installed)
                    } else {
                        fail(FirstRunFailure.Interrupted, known = checkout)
                    }
                }
            }
            FirstRunSnapshot.Stage.BUSY -> enter(FirstRunStage.Busy)
            FirstRunSnapshot.Stage.FAILED -> fail(saved.failure ?: FirstRunFailure.Interrupted, finished?.lines.orEmpty())
            FirstRunSnapshot.Stage.INSTALLED -> deriveFresh(SetupState.Idle)
        }
    }

    /**
     * Retry first looks at what changed while the flow stood still: the server or another job (Repair) may be
     * using `checkoutDir`, or may have finished a checkout there. Neither is touched.
     */
    private suspend fun retryPipeline() {
        if (hostBusy()) {
            enter(FirstRunStage.Busy)
            return
        }
        if (inspect() == CheckoutStatus.INSTALLED) {
            enter(FirstRunStage.Installed)
            return
        }
        runPreflight()
    }

    private suspend fun runPreflight() {
        enter(FirstRunStage.Checking)
        val result = try {
            withContext(io) { preflight() }
        } catch (cancel: CancellationException) {
            throw cancel
        } catch (error: Exception) {
            fail(FirstRunFailure.Unexpected(describe(error)))
            return
        }
        when (result) {
            is Preflight.LowStorage -> fail(
                FirstRunFailure.LowStorage(result.availableBytes, FirstRunStorage.REQUIRED_FREE_BYTES),
            )
            Preflight.Offline -> fail(FirstRunFailure.Offline)
            is Preflight.Ready -> when (result.network) {
                NetworkKind.METERED -> enter(FirstRunStage.MeteredWarning(cellular = false))
                NetworkKind.CELLULAR -> enter(FirstRunStage.MeteredWarning(cellular = true))
                NetworkKind.UNMETERED, NetworkKind.NONE -> prepareAndInstall()
            }
        }
    }

    /** Blocking; runs on the IO dispatcher. Storage first: below the threshold nothing else runs. */
    private fun preflight(): Preflight {
        val available = dependencies.storage.availableBytes()
        if (available < FirstRunStorage.REQUIRED_FREE_BYTES) return Preflight.LowStorage(available)
        val network = dependencies.network.current()
        if (network == NetworkKind.NONE) return Preflight.Offline
        return Preflight.Ready(network)
    }

    private suspend fun prepareAndInstall() {
        enter(FirstRunStage.Preparing)
        val outcome = try {
            withContext(io) { dependencies.layout.ensure() }
        } catch (cancel: CancellationException) {
            throw cancel
        } catch (error: Exception) {
            RuntimeLayoutOutcome.Failed(describe(error))
        }
        if (outcome is RuntimeLayoutOutcome.Failed) {
            fail(FirstRunFailure.Layout(outcome.reason))
            return
        }
        installWhenVisible()
    }

    private suspend fun installWhenVisible() {
        if (!state.value.visible) {
            enter(FirstRunStage.WaitingForForeground)
            return
        }
        // The server or another setup job may be using checkoutDir right now, so nothing there is touched.
        if (hostBusy()) {
            enter(FirstRunStage.Busy)
            return
        }
        // install.sh refuses a non-empty --dir and updates, instead of reinstalling, one that already has
        // .git (scripts/bootstrap/install.sh main()). A finished clone is the whole install, so it counts as
        // installed; anything else left there is renamed aside, never deleted.
        when (inspect()) {
            CheckoutStatus.INSTALLED -> {
                enter(FirstRunStage.Installed)
                return
            }
            CheckoutStatus.PARTIAL -> {
                val moved = try {
                    withContext(io) {
                        // Checked again right before the rename: a job may have started while checkoutDir was read.
                        if (hostBusy()) null else BrokenCheckouts.moveAside(paths, dependencies.clock.instant())
                    }
                } catch (cancel: CancellationException) {
                    throw cancel
                } catch (error: Exception) {
                    fail(FirstRunFailure.MoveAside(describe(error)))
                    return
                }
                if (moved == null) {
                    enter(FirstRunStage.Busy)
                    return
                }
            }
            CheckoutStatus.ABSENT, CheckoutStatus.EMPTY -> Unit
        }
        // Asynchronous work just ran: recheck right before the foreground-service start.
        if (!state.value.visible) {
            enter(FirstRunStage.WaitingForForeground)
            return
        }
        startInstall()
    }

    private suspend fun startInstall() {
        val job = FirstRunInstall.job(dependencies.installScript, paths, dependencies.defaultRef)
        cancelRequested = false
        sawRunning = false
        val started = try {
            host.runSetup(dependencies.context, job)
        } catch (error: RuntimeException) {
            fail(FirstRunFailure.Unexpected(describe(error)))
            return
        }
        if (!started) {
            enter(FirstRunStage.Busy)
            return
        }
        startedJob = job
        val running = (host.setup.value as? SetupState.Running)?.takeIf { it.job === job }
        enter(FirstRunStage.Installing(running?.lines.orEmpty(), cancelling = false))
        observeSetup()
    }

    private fun observeSetup() {
        observer?.cancel()
        observer = scope.launch {
            val end = host.setup.transformWhile { setup ->
                when (setup) {
                    is SetupState.Running -> if (isOurs(setup.job)) {
                        sawRunning = true
                        enter(FirstRunStage.Installing(setup.lines, cancelling = cancelRequested))
                        true
                    } else {
                        // Another job runs, so ours ended without this controller seeing its result.
                        emit(null)
                        false
                    }
                    is SetupState.Finished -> when {
                        isOurs(setup.job) -> {
                            emit(setup)
                            false
                        }
                        // A result from before this job started.
                        !sawRunning -> true
                        else -> {
                            emit(null)
                            false
                        }
                    }
                    SetupState.Idle -> if (sawRunning) {
                        emit(null)
                        false
                    } else {
                        true
                    }
                }
            }.firstOrNull()
            if (state.value.stage !is FirstRunStage.Installing) return@launch
            if (end != null) complete(end) else fail(FirstRunFailure.Interrupted)
        }
    }

    private suspend fun complete(finished: SetupState.Finished) {
        val checkout = inspect()
        when {
            finished.exitCode == 0 && checkout == CheckoutStatus.INSTALLED -> enter(FirstRunStage.Installed)
            cancelRequested -> fail(FirstRunFailure.Cancelled, finished.lines, checkout)
            finished.exitCode != 0 -> fail(FirstRunFailure.Install(finished.exitCode), finished.lines, checkout)
            else -> fail(FirstRunFailure.NoCheckout, finished.lines, checkout)
        }
        cancelRequested = false
    }

    private suspend fun fail(
        failure: FirstRunFailure,
        lines: List<String> = emptyList(),
        known: CheckoutStatus? = null,
    ) {
        val checkout = known ?: inspect()
        val partial = checkout == CheckoutStatus.PARTIAL || checkout == CheckoutStatus.INSTALLED
        enter(FirstRunStage.Failed(failure, lines, partialCheckout = partial))
    }

    private suspend fun inspect(): CheckoutStatus = try {
        withContext(io) { dependencies.checkout.status() }
    } catch (cancel: CancellationException) {
        throw cancel
    } catch (_: Exception) {
        // Unreadable: treat it as something in the way rather than as nothing there.
        CheckoutStatus.PARTIAL
    }

    private fun enter(stage: FirstRunStage) {
        mutableState.update {
            it.copy(
                stage = stage,
                logs = it.logs.takeIf { stage is FirstRunStage.Failed },
                confirmingCancel = it.confirmingCancel && stage is FirstRunStage.Installing && !stage.cancelling,
            )
        }
    }

    private fun launchPipeline(block: suspend () -> Unit) {
        pipeline?.cancel()
        pipeline = scope.launch { block() }
    }

    private fun isOurs(job: SetupJob): Boolean =
        startedJob?.let { job === it } ?: FirstRunInstall.isFirstRunJob(job, paths, dependencies.defaultRef)

    /**
     * True while any setup job runs or the server is starting, running or stopping: the cases in which
     * `ServerHost.runSetup` refuses. `Stopped` and `Failed` have no process left. Safe on any thread.
     */
    private fun hostBusy(): Boolean = host.setup.value is SetupState.Running ||
        when (host.state.value) {
            is ServerState.Starting, is ServerState.Running, ServerState.Stopping -> true
            is ServerState.Stopped, is ServerState.Failed -> false
        }

    private fun currentNotifications(known: NotificationStatus): NotificationStatus {
        val permission = dependencies.notifications
        return when {
            !permission.required -> NotificationStatus.NOT_REQUIRED
            permission.isGranted() -> NotificationStatus.GRANTED
            known == NotificationStatus.DENIED || known == NotificationStatus.PERMANENTLY_DENIED -> known
            else -> NotificationStatus.NOT_ASKED
        }
    }

    private fun currentBattery(known: BatteryStatus): BatteryStatus = when {
        dependencies.battery.isExempt() -> BatteryStatus.EXEMPT
        known == BatteryStatus.SKIPPED -> BatteryStatus.SKIPPED
        else -> BatteryStatus.NOT_EXEMPT
    }

    private sealed interface Preflight {
        data class LowStorage(val availableBytes: Long) : Preflight

        data object Offline : Preflight

        data class Ready(val network: NetworkKind) : Preflight
    }

    private companion object {
        fun describe(error: Throwable): String = error.message?.takeIf { it.isNotBlank() } ?: error.javaClass.simpleName
    }
}
