package io.github.sillybunnyteam.sillybunny.app

import io.github.sillybunnyteam.sillybunny.firstrun.CheckoutStatus
import io.github.sillybunnyteam.sillybunny.server.LaunchSession
import io.github.sillybunnyteam.sillybunny.server.ServerState

/** The screen under any overlay (plan §2.4). */
internal sealed interface AppRoute {
    /** Laying out the runtime, looking for an unfinished Repair or reading the checkout. */
    data object Loading : AppRoute

    /** The runtime layout failed, or this APK has no runtime. Nothing is started from here. */
    data object RuntimeError : AppRoute

    data object FirstRun : AppRoute

    data object Repair : AppRoute

    /** The server starts, restarts or stops, or a start request has not reached it yet. */
    data class Progress(val stopping: Boolean) : AppRoute

    data class Web(val session: LaunchSession, val originChanged: Boolean) : AppRoute

    data class ServerFailed(val lines: List<String>, val canRestart: Boolean) : AppRoute

    data class ServerStopped(val userStopped: Boolean) : AppRoute
}

internal enum class LayoutStatus { CHECKING, READY, FAILED }

/** Which setup job `ServerHost.setup` reports as running. */
internal enum class SetupKind {
    NONE,

    /** The first-run install (`FirstRunInstall.isFirstRunJob`). */
    FIRST_RUN,

    /** Any other job, which only Repair starts. */
    OTHER,
}

/**
 * @param repairOpen the Repair screen is open: an unfinished Repair found on launch, or a user action.
 * @param checkout null until the launch read it.
 * @param firstRunActive the first-run flow is showing and its install has not been handed to the server yet.
 * @param startPending a start was requested and the host still reports the server idle.
 */
internal data class LaunchInputs(
    val layout: LayoutStatus,
    val repairOpen: Boolean,
    val checkout: CheckoutStatus?,
    val server: ServerState,
    val setup: SetupKind,
    val firstRunActive: Boolean,
    val startPending: Boolean,
)

internal object LaunchDecision {
    /**
     * Plan §2.4 as one function: nothing runs before the layout is ready, an open or running Repair comes
     * first, then the first-run flow while no finished checkout exists and the server is idle, else the server.
     */
    fun route(inputs: LaunchInputs): AppRoute = with(inputs) {
        when {
            layout == LayoutStatus.CHECKING -> AppRoute.Loading
            layout == LayoutStatus.FAILED -> AppRoute.RuntimeError
            repairOpen -> AppRoute.Repair
            setup == SetupKind.FIRST_RUN -> AppRoute.FirstRun
            setup == SetupKind.OTHER -> AppRoute.Repair
            checkout == null -> AppRoute.Loading
            isIdle(server) && (firstRunActive || checkout != CheckoutStatus.INSTALLED) -> AppRoute.FirstRun
            else -> serverRoute(server, startPending)
        }
    }

    /** Stopped and Failed have no process left, so only they allow a setup job or a new start. */
    fun isIdle(server: ServerState): Boolean = server is ServerState.Stopped || server is ServerState.Failed

    private fun serverRoute(server: ServerState, startPending: Boolean): AppRoute = when (server) {
        is ServerState.Starting -> AppRoute.Progress(stopping = false)
        ServerState.Stopping -> AppRoute.Progress(stopping = true)
        is ServerState.Running -> AppRoute.Web(server.session, server.originChanged)
        is ServerState.Failed -> if (startPending) {
            AppRoute.Progress(stopping = false)
        } else {
            AppRoute.ServerFailed(server.lastLines, server.canRestart)
        }
        is ServerState.Stopped ->
            if (startPending) AppRoute.Progress(stopping = false) else AppRoute.ServerStopped(server.userStopped)
    }
}
