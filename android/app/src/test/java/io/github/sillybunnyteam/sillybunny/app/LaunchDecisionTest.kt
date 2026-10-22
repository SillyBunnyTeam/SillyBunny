package io.github.sillybunnyteam.sillybunny.app

import io.github.sillybunnyteam.sillybunny.firstrun.CheckoutStatus
import io.github.sillybunnyteam.sillybunny.server.LaunchSession
import io.github.sillybunnyteam.sillybunny.server.ServerState
import org.junit.Assert.assertEquals
import org.junit.Test

/** Plan §2.4 as a table: layout result × checkout state × server state (and the setup job) → screen. */
class LaunchDecisionTest {
    private val session = LaunchSession(41_234, "ab".repeat(32))
    private val failed = ServerState.Failed(listOf("last line"), canRestart = true)
    private val failedForGood = ServerState.Failed(emptyList(), canRestart = false)
    private val idle = listOf(ServerState.Stopped(userStopped = false), ServerState.Stopped(userStopped = true), failed, failedForGood)
    private val busy = listOf(ServerState.Starting(attempt = 1), ServerState.Running(session, originChanged = true), ServerState.Stopping)
    private val servers = idle + busy
    private val checkouts = listOf(null) + CheckoutStatus.entries

    private fun route(
        layout: LayoutStatus = LayoutStatus.READY,
        checkout: CheckoutStatus? = CheckoutStatus.INSTALLED,
        server: ServerState = ServerState.Stopped(userStopped = false),
        setup: SetupKind = SetupKind.NONE,
        repairOpen: Boolean = false,
        firstRunActive: Boolean = false,
        startPending: Boolean = false,
    ): AppRoute = LaunchDecision.route(LaunchInputs(layout, repairOpen, checkout, server, setup, firstRunActive, startPending))

    @Test
    fun nothingRunsBeforeTheLayoutIsReady() {
        for (checkout in checkouts) {
            for (server in servers) {
                for (setup in SetupKind.entries) {
                    for (repairOpen in listOf(false, true)) {
                        assertEquals(AppRoute.Loading, route(LayoutStatus.CHECKING, checkout, server, setup, repairOpen))
                        assertEquals(AppRoute.RuntimeError, route(LayoutStatus.FAILED, checkout, server, setup, repairOpen))
                    }
                }
            }
        }
    }

    @Test
    fun anOpenRepairComesFirst() {
        for (checkout in checkouts) {
            for (server in servers) {
                for (setup in SetupKind.entries) {
                    assertEquals(AppRoute.Repair, route(checkout = checkout, server = server, setup = setup, repairOpen = true))
                }
            }
        }
    }

    @Test
    fun aRunningSetupJobKeepsItsOwnScreen() {
        for (checkout in checkouts) {
            for (server in servers) {
                assertEquals(AppRoute.FirstRun, route(checkout = checkout, server = server, setup = SetupKind.FIRST_RUN))
                assertEquals(AppRoute.Repair, route(checkout = checkout, server = server, setup = SetupKind.OTHER))
            }
        }
    }

    @Test
    fun theCheckoutIsReadBeforeAnythingElse() {
        for (server in servers) {
            assertEquals(AppRoute.Loading, route(checkout = null, server = server))
        }
    }

    @Test
    fun anIdleServerWithoutAFinishedCheckoutShowsTheFirstRun() {
        for (checkout in listOf(CheckoutStatus.ABSENT, CheckoutStatus.EMPTY, CheckoutStatus.PARTIAL)) {
            for (server in idle) {
                assertEquals("$checkout $server", AppRoute.FirstRun, route(checkout = checkout, server = server))
                assertEquals(AppRoute.FirstRun, route(checkout = checkout, server = server, startPending = true))
            }
        }
    }

    @Test
    fun aServerWithAProcessKeepsItsScreenWhateverTheCheckout() {
        for (checkout in CheckoutStatus.entries) {
            assertEquals(AppRoute.Progress(stopping = false), route(checkout = checkout, server = ServerState.Starting(2)))
            assertEquals(AppRoute.Progress(stopping = true), route(checkout = checkout, server = ServerState.Stopping))
            assertEquals(
                AppRoute.Web(session, originChanged = false),
                route(checkout = checkout, server = ServerState.Running(session, originChanged = false)),
            )
        }
    }

    @Test
    fun anInstalledCheckoutShowsTheServerState() {
        assertEquals(AppRoute.ServerStopped(userStopped = false), route(server = ServerState.Stopped(userStopped = false)))
        assertEquals(AppRoute.ServerStopped(userStopped = true), route(server = ServerState.Stopped(userStopped = true)))
        assertEquals(AppRoute.ServerFailed(listOf("last line"), canRestart = true), route(server = failed))
        assertEquals(AppRoute.ServerFailed(emptyList(), canRestart = false), route(server = failedForGood))
        assertEquals(AppRoute.Web(session, originChanged = true), route(server = ServerState.Running(session, originChanged = true)))
    }

    @Test
    fun aRequestedStartShowsProgressUntilTheHostReportsIt() {
        for (server in idle) {
            assertEquals(AppRoute.Progress(stopping = false), route(server = server, startPending = true))
        }
        assertEquals(
            AppRoute.Web(session, originChanged = false),
            route(server = ServerState.Running(session, originChanged = false), startPending = true),
        )
    }

    @Test
    fun anActiveFirstRunKeepsItsScreenUntilItHandsOver() {
        for (server in idle) {
            assertEquals(AppRoute.FirstRun, route(server = server, firstRunActive = true))
        }
        assertEquals(AppRoute.Progress(stopping = false), route(server = ServerState.Starting(1), firstRunActive = true))
    }
}
