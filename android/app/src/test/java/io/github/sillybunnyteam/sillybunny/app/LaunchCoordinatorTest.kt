package io.github.sillybunnyteam.sillybunny.app

import android.os.Looper
import androidx.lifecycle.SavedStateHandle
import io.github.sillybunnyteam.sillybunny.app.AppFixture.Companion.OTHER_SESSION
import io.github.sillybunnyteam.sillybunny.app.AppFixture.Companion.REF
import io.github.sillybunnyteam.sillybunny.app.AppFixture.Companion.SESSION
import io.github.sillybunnyteam.sillybunny.firstrun.FirstRunInstall
import io.github.sillybunnyteam.sillybunny.repair.RepairFailure
import io.github.sillybunnyteam.sillybunny.repair.RepairPhase
import io.github.sillybunnyteam.sillybunny.repair.RepairRecord
import io.github.sillybunnyteam.sillybunny.repair.TestCheckouts
import io.github.sillybunnyteam.sillybunny.runtime.RuntimeLayoutException
import io.github.sillybunnyteam.sillybunny.runtime.RuntimeLayoutResult
import io.github.sillybunnyteam.sillybunny.server.ServerState
import io.github.sillybunnyteam.sillybunny.server.SetupJob
import io.github.sillybunnyteam.sillybunny.server.SetupState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import java.io.File
import java.io.IOException
import java.time.Duration
import java.time.Instant

/** The launch coordinator's decisions over a fake host, layout and checkout; the launch runs inside the constructor. */
@RunWith(RobolectricTestRunner::class)
class LaunchCoordinatorTest {
    @get:Rule
    val temporary = TemporaryFolder()

    private lateinit var fixture: AppFixture

    @Before
    fun setUp() {
        fixture = AppFixture(temporary.newFolder("app"))
    }

    private fun launch(handle: SavedStateHandle = SavedStateHandle()) = LaunchCoordinator(fixture.components, handle)

    private fun publish(state: ServerState) {
        fixture.host.state.value = state
        shadowOf(Looper.getMainLooper()).idle()
    }

    private fun layoutLog(): File = File(fixture.paths.logsDir, AppComponents.LAYOUT_LOG)

    @Test
    fun aStoppedServerIsStartedOnceThenTheRouteFollowsTheHost() {
        fixture.writeInstalledCheckout()
        val coordinator = launch()
        assertEquals(AppRoute.Progress(stopping = false), coordinator.route.value)
        assertTrue(coordinator.startRequest.value)
        assertTrue(coordinator.takeStartRequest())
        assertFalse(coordinator.takeStartRequest())

        publish(ServerState.Starting(attempt = 1))
        assertEquals(AppRoute.Progress(stopping = false), coordinator.route.value)
        publish(ServerState.Running(SESSION, originChanged = false))
        assertEquals(AppRoute.Web(SESSION, originChanged = false), coordinator.route.value)
        publish(ServerState.Stopping)
        assertEquals(AppRoute.Progress(stopping = true), coordinator.route.value)
        publish(ServerState.Stopped(userStopped = true))
        assertEquals(AppRoute.ServerStopped(userStopped = true), coordinator.route.value)
        // Only the launch asks for a start on its own.
        assertFalse(coordinator.startRequest.value)
        assertEquals(1, fixture.layoutCalls)
    }

    @Test
    fun aUserStopOrAnUpdateStopIsStartedByTheNextLaunch() {
        fixture.writeInstalledCheckout()
        fixture.host.state.value = ServerState.Stopped(userStopped = true)
        val coordinator = launch()
        assertEquals(AppRoute.Progress(stopping = false), coordinator.route.value)
        assertTrue(coordinator.startRequest.value)
    }

    @Test
    fun aServerThatGaveUpKeepsItsErrorScreenUntilRestart() {
        fixture.writeInstalledCheckout()
        fixture.host.state.value = ServerState.Failed(listOf("boom"), canRestart = true)
        val coordinator = launch()
        assertEquals(AppRoute.ServerFailed(listOf("boom"), canRestart = true), coordinator.route.value)
        assertFalse(coordinator.startRequest.value)

        coordinator.requestStart()
        assertEquals(AppRoute.Progress(stopping = false), coordinator.route.value)
        assertTrue(coordinator.takeStartRequest())
        // The host never reports the start, as when a setup job refuses it: the error screen comes back.
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(LaunchCoordinator.START_SETTLE_MILLIS))
        assertEquals(AppRoute.ServerFailed(listOf("boom"), canRestart = true), coordinator.route.value)
    }

    @Test
    fun aFailureThatCannotRestartRoutesToRepairOrToTheFirstRun() {
        fixture.writeInstalledCheckout()
        val coordinator = launch()
        assertTrue(coordinator.takeStartRequest())
        publish(ServerState.Starting(attempt = 1))
        publish(ServerState.Failed(listOf("start.sh is missing"), canRestart = false))
        // A finished checkout keeps the error screen, which offers Repair but no Restart.
        assertEquals(AppRoute.ServerFailed(listOf("start.sh is missing"), canRestart = false), coordinator.route.value)

        // Without a checkout, the checkout is read again once the server is idle, and the first run takes over.
        fixture.paths.checkoutDir.deleteRecursively()
        publish(ServerState.Starting(attempt = 1))
        publish(ServerState.Failed(emptyList(), canRestart = false))
        assertEquals(AppRoute.FirstRun, coordinator.route.value)
        assertFalse(coordinator.startRequest.value)
    }

    @Test
    fun aFailedLayoutShowsTheRuntimeErrorAndStartsNothing() {
        fixture.layout = {
            RuntimeLayoutResult.Failed(RuntimeLayoutException(RuntimeLayoutException.Reason.STORAGE, IOException("disk full")))
        }
        fixture.writeInstalledCheckout()
        val coordinator = launch()
        assertEquals(AppRoute.RuntimeError, coordinator.route.value)
        assertFalse(coordinator.startRequest.value)
        assertEquals(0, fixture.checkoutReads)
        assertTrue(fixture.host.events.isEmpty())
        val line = layoutLog().readText()
        assertTrue(line, line.endsWith(" runtime-layout failed reason=STORAGE cause=java.io.IOException: disk full\n"))
        assertEquals(listOf(layoutLog()), fixture.components.logFiles())

        // Retry runs the whole launch again; a ready layout makes the old failure line stale.
        fixture.layout = { fixture.ready() }
        coordinator.retryLayout()
        assertEquals(2, fixture.layoutCalls)
        assertEquals(AppRoute.Progress(stopping = false), coordinator.route.value)
        assertTrue(coordinator.startRequest.value)
        assertFalse(layoutLog().exists())
    }

    @Test
    fun aRuntimeThisApkLacksIsAnError() {
        fixture.layout = { RuntimeLayoutResult.Unavailable }
        val coordinator = launch()
        assertEquals(AppRoute.RuntimeError, coordinator.route.value)
        assertTrue(layoutLog().readText().endsWith(" runtime-layout unavailable\n"))
        coordinator.retryLayout()
        assertEquals(2, fixture.layoutCalls)
        assertEquals(AppRoute.RuntimeError, coordinator.route.value)
    }

    @Test
    fun aLayoutThatThrowsIsAFailedLayout() {
        fixture.layout = { throw IllegalStateException("called on the main thread") }
        val coordinator = launch()
        assertEquals(AppRoute.RuntimeError, coordinator.route.value)
        val line = layoutLog().readText()
        assertTrue(line, line.endsWith(" runtime-layout failed cause=java.lang.IllegalStateException: called on the main thread\n"))
    }

    @Test
    fun withoutACheckoutTheFirstRunShowsAndAsksForTheStartWhenItHandsOver() {
        val coordinator = launch()
        assertEquals(AppRoute.FirstRun, coordinator.route.value)
        assertFalse(coordinator.startRequest.value)
        assertEquals(0, coordinator.firstRunGeneration.value)

        coordinator.onFirstRunInstalled()
        assertEquals(AppRoute.Progress(stopping = false), coordinator.route.value)
        assertTrue(coordinator.startRequest.value)
        assertEquals(1, coordinator.firstRunGeneration.value)
        assertEquals(1, fixture.rootsChanged)

        // A recreated first-run screen reports the same install again.
        assertTrue(coordinator.takeStartRequest())
        coordinator.onFirstRunInstalled()
        assertFalse(coordinator.startRequest.value)
        assertEquals(1, coordinator.firstRunGeneration.value)
        assertEquals(1, fixture.rootsChanged)
    }

    @Test
    fun aFirstRunInstallKeepsTheFirstRunUntilItHandsOver() {
        val job = FirstRunInstall.job(fixture.paths.installScript, fixture.paths, REF)
        fixture.host.setup.value = SetupState.Running(job, emptyList())
        val coordinator = launch()
        assertEquals(AppRoute.FirstRun, coordinator.route.value)

        fixture.writeInstalledCheckout()
        fixture.host.setup.value = SetupState.Finished(job, 0, listOf("Done."))
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(AppRoute.FirstRun, coordinator.route.value)
        assertFalse(coordinator.startRequest.value)
    }

    @Test
    fun anotherSetupJobShowsRepair() {
        fixture.writeInstalledCheckout()
        val job = SetupJob(fixture.paths.installScript, listOf("--migrate-from", "elsewhere"), fixture.filesDir)
        fixture.host.setup.value = SetupState.Running(job, emptyList())
        val coordinator = launch()
        assertEquals(AppRoute.Repair, coordinator.route.value)
        assertFalse(coordinator.startRequest.value)
    }

    @Test
    fun anUnfinishedRepairOpensRepairInsteadOfStartingTheServer() {
        fixture.writeInstalledCheckout()
        val source = TestCheckouts.create(File(fixture.filesDir, "SillyBunny.broken-20261022T120000Z"))
        fixture.repairStore.save(
            RepairRecord(
                phase = RepairPhase.FAILED,
                startedAt = Instant.parse("2026-10-22T12:00:00Z"),
                source = source.name,
                ref = REF,
                failure = RepairFailure.INSTALL_FAILED,
            ),
        )
        val coordinator = launch()
        assertEquals(AppRoute.Repair, coordinator.route.value)
        assertEquals(listOf(Overlay.REPAIR), coordinator.overlays.value)
        assertFalse(coordinator.startRequest.value)
        assertTrue(fixture.host.events.isEmpty())

        // Closing it decides nothing new: this launch already chose Repair over a start.
        coordinator.close(Overlay.REPAIR)
        assertEquals(AppRoute.ServerStopped(userStopped = false), coordinator.route.value)
        assertFalse(coordinator.startRequest.value)
    }

    @Test
    fun aRunningServerShowsTheWebAndWarnsOncePerChangedOrigin() {
        fixture.writeInstalledCheckout()
        fixture.host.state.value = ServerState.Running(SESSION, originChanged = true)
        val coordinator = launch()
        assertEquals(AppRoute.Web(SESSION, originChanged = true), coordinator.route.value)
        assertFalse(coordinator.startRequest.value)
        assertEquals(SESSION, coordinator.originWarning.value)

        coordinator.dismissOriginWarning()
        assertNull(coordinator.originWarning.value)
        publish(ServerState.Running(SESSION, originChanged = true))
        assertNull(coordinator.originWarning.value)

        publish(ServerState.Running(OTHER_SESSION, originChanged = false))
        assertNull(coordinator.originWarning.value)
        publish(ServerState.Running(SESSION, originChanged = true))
        assertNull(coordinator.originWarning.value)
    }

    @Test
    fun aNewSessionOnAnotherPortWarnsAgain() {
        fixture.writeInstalledCheckout()
        fixture.host.state.value = ServerState.Running(SESSION, originChanged = true)
        val coordinator = launch()
        coordinator.dismissOriginWarning()
        publish(ServerState.Running(OTHER_SESSION, originChanged = true))
        assertEquals(OTHER_SESSION, coordinator.originWarning.value)
    }

    @Test
    fun overlaysStackAndSurviveProcessDeath() {
        fixture.writeInstalledCheckout()
        fixture.host.state.value = ServerState.Running(SESSION, originChanged = false)
        val handle = SavedStateHandle()
        val coordinator = launch(handle)
        coordinator.open(Overlay.SETTINGS)
        coordinator.open(Overlay.LEFTOVERS)
        coordinator.open(Overlay.SETTINGS)
        assertEquals(listOf(Overlay.LEFTOVERS, Overlay.SETTINGS), coordinator.overlays.value)

        val restored = launch(handle)
        assertEquals(listOf(Overlay.LEFTOVERS, Overlay.SETTINGS), restored.overlays.value)
        restored.close(Overlay.SETTINGS)
        assertEquals(listOf(Overlay.LEFTOVERS), restored.overlays.value)
        assertEquals(AppRoute.Web(SESSION, originChanged = false), restored.route.value)
    }

    @Test
    fun theCheckoutIsReadAgainOnlyWhileTheServerIsIdle() {
        fixture.writeInstalledCheckout()
        fixture.host.state.value = ServerState.Running(SESSION, originChanged = false)
        launch()
        val reads = fixture.checkoutReads
        publish(ServerState.Running(OTHER_SESSION, originChanged = false))
        publish(ServerState.Stopping)
        assertEquals(reads, fixture.checkoutReads)
        publish(ServerState.Stopped(userStopped = true))
        assertEquals(reads + 1, fixture.checkoutReads)
    }

    @Test
    fun anUnreadableCheckoutCountsAsPartial() {
        fixture.checkout = { throw IOException("permission denied") }
        val coordinator = launch()
        assertEquals(AppRoute.FirstRun, coordinator.route.value)
        assertFalse(coordinator.startRequest.value)
    }
}
