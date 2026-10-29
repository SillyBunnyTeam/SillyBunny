package io.github.sillybunnyteam.sillybunny.app

import androidx.activity.ComponentActivity
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.createSavedStateHandle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import io.github.sillybunnyteam.sillybunny.firstrun.CheckoutStatus
import io.github.sillybunnyteam.sillybunny.firstrun.FirstRunInstall
import io.github.sillybunnyteam.sillybunny.runtime.RuntimeLayoutResult
import io.github.sillybunnyteam.sillybunny.server.LaunchSession
import io.github.sillybunnyteam.sillybunny.server.ServerState
import io.github.sillybunnyteam.sillybunny.server.SetupJob
import io.github.sillybunnyteam.sillybunny.server.SetupState
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** The screens that open over the route, the last one on top. */
internal enum class Overlay { SETTINGS, REPAIR, LEFTOVERS, LOGS }

/**
 * Plan §2.4 on every launch, kept across configuration changes: lays out the runtime off the main thread, resumes an
 * unfinished Repair, reads the checkout, then routes with [LaunchDecision]. Call it on the main thread only.
 *
 * It starts nothing itself. A server start becomes [startRequest], which the started activity takes with
 * [takeStartRequest], so no start is attempted from the background. The launch asks for one start when its first
 * decided route is a stopped server, a user stop and the stop before an APK install included (plan §5.6). A server
 * that gave up keeps its error screen instead, because only an explicit Restart runs it again. A first run asks for
 * its start once the install is handed over ([onFirstRunInstalled]); an unfinished Repair found on launch starts
 * the server itself when it succeeds.
 */
internal class LaunchCoordinator(
    private val components: AppComponents,
    private val handle: SavedStateHandle,
) : ViewModel() {
    private val host = components.server

    private val mutableRoute = MutableStateFlow<AppRoute>(AppRoute.Loading)
    val route: StateFlow<AppRoute> = mutableRoute.asStateFlow()

    private val mutableOverlays = MutableStateFlow(restoreOverlays())
    val overlays: StateFlow<List<Overlay>> = mutableOverlays.asStateFlow()

    private val mutableStartRequest = MutableStateFlow(false)

    /** True while a server start waits for a started activity. */
    val startRequest: StateFlow<Boolean> = mutableStartRequest.asStateFlow()

    private val mutableFirstRunGeneration = MutableStateFlow(handle[KEY_FIRST_RUN_GENERATION] ?: 0)

    /** Changes whenever a first run ends, so that the next first run gets a new controller. */
    val firstRunGeneration: StateFlow<Int> = mutableFirstRunGeneration.asStateFlow()

    private val mutableOriginWarning = MutableStateFlow<LaunchSession?>(null)

    /** The running session whose port changed, so its client-side storage starts empty; null once dismissed. */
    val originWarning: StateFlow<LaunchSession?> = mutableOriginWarning.asStateFlow()

    private var layout = LayoutStatus.CHECKING
    private var checkout: CheckoutStatus? = null
    private var firstRunActive = false
    private var startPending = false
    private var startDecided = false
    private var originWarningDismissed: LaunchSession? = null
    private var inspectedFor: InspectionKey? = null
    private var launch: Job? = null
    private var inspection: Job? = null
    private var settle: Job? = null

    init {
        viewModelScope.launch { host.state.collect { update() } }
        viewModelScope.launch { host.setup.collect { update() } }
        runLaunch()
    }

    /** Runs the launch again from the runtime error screen. */
    fun retryLayout() {
        if (layout == LayoutStatus.FAILED) runLaunch()
    }

    /** A user action or the launch asks for a server start; the progress screen shows until the host reports it. */
    fun requestStart() {
        startPending = true
        mutableStartRequest.value = true
        update()
    }

    /** True once per request: the caller, a started activity, starts the server now. */
    fun takeStartRequest(): Boolean {
        if (!mutableStartRequest.value) return false
        mutableStartRequest.value = false
        settle?.cancel()
        settle = viewModelScope.launch {
            // The host leaves the idle states within one step of its worker; a request it ignored, for example
            // while a setup job runs, must not leave the progress screen up.
            delay(START_SETTLE_MILLIS)
            if (startPending) {
                startPending = false
                update()
            }
        }
        return true
    }

    /**
     * The first-run screen reports a finished install while the activity is started; it may report it again after
     * a recreation, so only the first report counts.
     */
    fun onFirstRunInstalled() {
        if (!firstRunActive) return
        checkout = CheckoutStatus.INSTALLED
        endFirstRun()
        components.notifyRootsChanged()
        requestStart()
    }

    fun open(overlay: Overlay) {
        val current = mutableOverlays.value
        if (current.lastOrNull() != overlay) setOverlays(current - overlay + overlay)
    }

    fun close(overlay: Overlay) {
        val current = mutableOverlays.value
        if (overlay in current) setOverlays(current - overlay)
    }

    fun dismissOriginWarning() {
        originWarningDismissed = mutableOriginWarning.value ?: return
        update()
    }

    private fun runLaunch() {
        launch?.cancel()
        layout = LayoutStatus.CHECKING
        checkout = null
        update()
        launch = viewModelScope.launch {
            // Catch inside the IO block: an exception that crosses withContext can arrive as a stack-trace
            // recovery copy that wraps the original, which logs the same cause twice.
            val failure = withContext(components.io) {
                try {
                    describeFailure(components.layout())
                } catch (cancel: CancellationException) {
                    throw cancel
                } catch (error: Exception) {
                    "failed${AppComponents.causes(error)}"
                }
            }
            if (failure != null) {
                withContext(components.io) { components.recordLayoutFailure(failure) }
                layout = LayoutStatus.FAILED
                update()
                return@launch
            }
            withContext(components.io) { components.clearLayoutFailure() }
            val unfinishedRepair = try {
                components.repair.resume()
            } catch (cancel: CancellationException) {
                throw cancel
            } catch (_: Exception) {
                false
            }
            if (unfinishedRepair) setOverlays(mutableOverlays.value - Overlay.REPAIR + Overlay.REPAIR, refresh = false)
            inspectedFor = inspectionKey(host.state.value, host.setup.value)
            checkout = inspect()
            layout = LayoutStatus.READY
            update()
        }
    }

    private fun update() {
        val server = host.state.value
        val setup = host.setup.value
        if (!LaunchDecision.isIdle(server)) startPending = false
        var next = decide(server, setup)
        if (next == AppRoute.FirstRun) {
            firstRunActive = true
        } else if (firstRunActive && next != AppRoute.Loading) {
            endFirstRun()
        }
        if (!startDecided && next != AppRoute.Loading && next != AppRoute.RuntimeError) {
            startDecided = true
            if (next is AppRoute.ServerStopped) {
                startPending = true
                mutableStartRequest.value = true
                next = decide(server, setup)
            }
        }
        mutableRoute.value = next
        mutableOriginWarning.value = (next as? AppRoute.Web)
            ?.takeIf { it.originChanged && it.session != originWarningDismissed }
            ?.session
        inspectWhenIdle(server, setup)
    }

    private fun decide(server: ServerState, setup: SetupState): AppRoute = LaunchDecision.route(
        LaunchInputs(
            layout = layout,
            repairOpen = Overlay.REPAIR in mutableOverlays.value,
            checkout = checkout,
            server = server,
            setup = setupKind(setup),
            firstRunActive = firstRunActive,
            startPending = startPending,
        ),
    )

    private fun setupKind(setup: SetupState): SetupKind {
        val running = setup as? SetupState.Running ?: return SetupKind.NONE
        val firstRun = FirstRunInstall.isFirstRunJob(running.job, components.paths, components.defaultRef)
        return if (firstRun) SetupKind.FIRST_RUN else SetupKind.OTHER
    }

    /**
     * Reads the checkout again whenever the server or a setup job reaches another idle state: a failed start or a
     * failed Repair can leave no checkout behind, and only an idle server lets the first run take over.
     */
    private fun inspectWhenIdle(server: ServerState, setup: SetupState) {
        if (layout != LayoutStatus.READY || checkout == null || !LaunchDecision.isIdle(server)) return
        val key = inspectionKey(server, setup)
        if (key == inspectedFor) return
        inspectedFor = key
        inspection?.cancel()
        inspection = viewModelScope.launch {
            val status = inspect()
            if (status != checkout) {
                checkout = status
                update()
            }
        }
    }

    private suspend fun inspect(): CheckoutStatus = try {
        withContext(components.io) { components.checkout.status() }
    } catch (cancel: CancellationException) {
        throw cancel
    } catch (_: Exception) {
        // Unreadable counts as something in the way, as in the first-run flow.
        CheckoutStatus.PARTIAL
    }

    private fun endFirstRun() {
        firstRunActive = false
        val next = mutableFirstRunGeneration.value + 1
        handle[KEY_FIRST_RUN_GENERATION] = next
        mutableFirstRunGeneration.value = next
    }

    private fun setOverlays(next: List<Overlay>, refresh: Boolean = true) {
        handle[KEY_OVERLAYS] = ArrayList(next.map { it.name })
        mutableOverlays.value = next
        if (refresh) update()
    }

    private fun restoreOverlays(): List<Overlay> = handle.get<ArrayList<String>>(KEY_OVERLAYS).orEmpty()
        .mapNotNull { name -> Overlay.entries.firstOrNull { it.name == name } }

    /** What a checkout read depends on; a setup job's streamed lines are left out, because they change constantly. */
    private data class InspectionKey(val server: ServerState, val setup: SetupPhase)

    private sealed interface SetupPhase {
        data object Idle : SetupPhase

        class Running(val job: SetupJob) : SetupPhase {
            override fun equals(other: Any?) = other is Running && other.job === job

            override fun hashCode() = System.identityHashCode(job)
        }

        class Finished(val job: SetupJob, val exitCode: Int) : SetupPhase {
            override fun equals(other: Any?) = other is Finished && other.job === job && other.exitCode == exitCode

            override fun hashCode() = 31 * System.identityHashCode(job) + exitCode
        }
    }

    companion object {
        /** How long a start request keeps the progress screen while the host still reports the server idle. */
        const val START_SETTLE_MILLIS = 5_000L

        private const val KEY_OVERLAYS = "io.github.sillybunnyteam.sillybunny.app.overlays"
        private const val KEY_FIRST_RUN_GENERATION = "io.github.sillybunnyteam.sillybunny.app.firstRunGeneration"

        fun forActivity(activity: ComponentActivity, components: AppComponents): LaunchCoordinator =
            ViewModelProvider(activity, factory(components))[LaunchCoordinator::class.java]

        fun factory(components: AppComponents): ViewModelProvider.Factory = viewModelFactory {
            initializer { LaunchCoordinator(components, createSavedStateHandle()) }
        }

        private fun inspectionKey(server: ServerState, setup: SetupState) = InspectionKey(
            server,
            when (setup) {
                SetupState.Idle -> SetupPhase.Idle
                is SetupState.Running -> SetupPhase.Running(setup.job)
                is SetupState.Finished -> SetupPhase.Finished(setup.job, setup.exitCode)
            },
        )

        /** The layout log line for a result that is not ready, or null for a ready one. */
        private fun describeFailure(result: RuntimeLayoutResult): String? = when (result) {
            is RuntimeLayoutResult.Ready -> null
            RuntimeLayoutResult.Unavailable -> "unavailable"
            is RuntimeLayoutResult.Failed ->
                "failed reason=${result.error.reason.name}${AppComponents.causes(result.error.cause)}"
        }
    }
}
