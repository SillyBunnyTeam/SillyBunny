package io.github.sillybunnyteam.sillybunny.firstrun

import android.os.Bundle
import io.github.sillybunnyteam.sillybunny.server.SetupJob
import io.github.sillybunnyteam.sillybunny.server.SetupState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Recreation from every stage, both while the process lives and after process death. */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [37])
class FirstRunRecreationTest {
    @get:Rule
    val temporary = TemporaryFolder()

    private lateinit var fixture: FirstRunFixture

    @Before
    fun setUp() {
        fixture = FirstRunFixture(temporary.root)
    }

    private fun TestScope.controller(restored: Bundle? = null, visible: Boolean = true): FirstRunController {
        val controller = FirstRunController(
            fixture.dependencies(StandardTestDispatcher(testScheduler)),
            backgroundScope,
            restored,
        )
        if (visible) controller.setVisible(true)
        runCurrent()
        return controller
    }

    private fun TestScope.installing(): Pair<FirstRunController, SetupJob> {
        val controller = controller()
        controller.continueFromWelcome()
        runCurrent()
        return controller to fixture.host.jobs.last()
    }

    private fun processDeath() {
        fixture.host.setup.value = SetupState.Idle
    }

    /**
     * Drives a controller in its own scope, takes its record, then stops it and resets the fake host, so the
     * live controller cannot race the restored one.
     */
    private fun TestScope.capture(visible: Boolean = true, drive: TestScope.(FirstRunController) -> Unit): Bundle {
        val scope = CoroutineScope(backgroundScope.coroutineContext + Job(backgroundScope.coroutineContext[Job]))
        val live = FirstRunController(fixture.dependencies(StandardTestDispatcher(testScheduler)), scope)
        if (visible) live.setVisible(true)
        runCurrent()
        drive(live)
        val record = live.saveState()
        scope.cancel()
        runCurrent()
        processDeath()
        fixture.host.jobs.clear()
        return record
    }

    private fun snapshot(stage: FirstRunSnapshot.Stage, failure: FirstRunFailure? = null): Bundle =
        FirstRunSnapshot(stage, failure = failure).toBundle()

    @Test
    fun welcomeKeepsItsAnswers() = runTest {
        val live = controller()
        live.onNotificationPermissionResult(granted = false, canAskAgain = true)
        live.skipBatteryExemption()
        val restored = controller(live.saveState())
        assertEquals(FirstRunStage.Welcome, restored.state.value.stage)
        assertEquals(NotificationStatus.DENIED, restored.state.value.notifications)
        assertEquals(BatteryStatus.SKIPPED, restored.state.value.battery)

        live.onNotificationPermissionResult(granted = false, canAskAgain = false)
        assertEquals(NotificationStatus.PERMANENTLY_DENIED, controller(live.saveState()).state.value.notifications)
    }

    @Test
    fun answersChangedInSettingsWinOverTheRecord() = runTest {
        val live = controller()
        fixture.notifications.granted = true
        live.onNotificationPermissionResult(granted = true, canAskAgain = false)
        val record = live.saveState()
        fixture.notifications.granted = false
        fixture.exempt = true
        val restored = controller(record)
        assertEquals(NotificationStatus.NOT_ASKED, restored.state.value.notifications)
        assertEquals(BatteryStatus.EXEMPT, restored.state.value.battery)
    }

    @Test
    fun checkingPreparingAndWaitingRunThePreflightAgain() = runTest {
        val checking = capture { it.continueFromWelcome() }
        fixture.network = NetworkKind.METERED
        val preparing = capture {
            it.continueFromWelcome()
            runCurrent()
            it.continueOnMeteredNetwork()
        }
        fixture.network = NetworkKind.UNMETERED
        val waiting = capture(visible = false) {
            it.continueFromWelcome()
            runCurrent()
        }
        assertEquals(FirstRunSnapshot.Stage.CHECKING, FirstRunSnapshot.fromBundle(checking)!!.stage)
        assertEquals(FirstRunSnapshot.Stage.PREPARING, FirstRunSnapshot.fromBundle(preparing)!!.stage)
        assertEquals(FirstRunSnapshot.Stage.WAITING, FirstRunSnapshot.fromBundle(waiting)!!.stage)

        for (record in listOf(checking, preparing, waiting)) {
            processDeath()
            fixture.host.jobs.clear()
            val restored = controller(record)
            assertTrue(restored.state.value.stage is FirstRunStage.Installing)
            assertEquals(1, fixture.host.jobs.size)
        }

        processDeath()
        fixture.host.jobs.clear()
        val hidden = controller(waiting, visible = false)
        assertEquals(FirstRunStage.WaitingForForeground, hidden.state.value.stage)
        assertTrue(fixture.host.jobs.isEmpty())
    }

    @Test
    fun theMeteredWarningKeepsItsKindAndStartsNothing() = runTest {
        fixture.network = NetworkKind.CELLULAR
        val live = controller()
        live.continueFromWelcome()
        runCurrent()
        val restored = controller(live.saveState())
        assertEquals(FirstRunStage.MeteredWarning(cellular = true), restored.state.value.stage)
        assertTrue(fixture.host.jobs.isEmpty())
    }

    @Test
    fun installingFollowsTheJobWhileTheProcessLives() = runTest {
        val (live, job) = installing()
        fixture.host.setup.value = SetupState.Running(job, listOf("Cloning"))
        runCurrent()
        val restored = controller(live.saveState())
        assertEquals(FirstRunStage.Installing(listOf("Cloning"), cancelling = false), restored.state.value.stage)

        fixture.writeInstalledCheckout()
        fixture.host.setup.value = SetupState.Finished(job, 0, listOf("Done"))
        runCurrent()
        assertEquals(FirstRunStage.Installed, restored.state.value.stage)
        assertEquals(1, fixture.host.jobs.size)
    }

    @Test
    fun aJobFromAnotherControllerIsRecognisedByItsArguments() = runTest {
        val (live, _) = installing()
        val sameArguments = fixture.installJob()
        fixture.host.setup.value = SetupState.Running(sameArguments, listOf("x"))
        val restored = controller(live.saveState())
        assertEquals(FirstRunStage.Installing(listOf("x"), cancelling = false), restored.state.value.stage)
    }

    @Test
    fun installingAfterProcessDeathIsInterruptedAndOffersRepair() = runTest {
        val (live, _) = installing()
        fixture.writePartialCheckout()
        val record = live.saveState()
        processDeath()
        val restored = controller(record)
        assertEquals(
            FirstRunStage.Failed(FirstRunFailure.Interrupted, emptyList(), partialCheckout = true),
            restored.state.value.stage,
        )
        assertEquals(1, fixture.host.jobs.size)
    }

    @Test
    fun installingAfterProcessDeathWithAKilledCloneIsInterrupted() = runTest {
        val record = capture {
            it.continueFromWelcome()
            runCurrent()
        }
        assertEquals(FirstRunSnapshot.Stage.INSTALLING, FirstRunSnapshot.fromBundle(record)!!.stage)
        // The process died during the clone's checkout: package.json is there, start.sh and .git/index are not.
        val killed = fixture.writeKilledClone()
        val restored = controller(record)
        assertEquals(
            FirstRunStage.Failed(FirstRunFailure.Interrupted, emptyList(), partialCheckout = true),
            restored.state.value.stage,
        )
        assertEquals(killed, FirstRunFixture.tree(fixture.paths.checkoutDir))

        // Retry moves it aside, never deletes it, and installs again.
        restored.retry()
        runCurrent()
        assertTrue(restored.state.value.stage is FirstRunStage.Installing)
        assertEquals(killed, FirstRunFixture.tree(fixture.brokenCheckouts().single()))
        assertEquals(1, fixture.host.jobs.size)
    }

    @Test
    fun aFreshStartWithAKilledCloneIsInterrupted() = runTest {
        val killed = fixture.writeKilledClone()
        assertEquals(
            FirstRunStage.Failed(FirstRunFailure.Interrupted, emptyList(), partialCheckout = true),
            controller().state.value.stage,
        )
        assertEquals(killed, FirstRunFixture.tree(fixture.paths.checkoutDir))
        assertTrue(fixture.host.jobs.isEmpty())
    }

    @Test
    fun installingAfterProcessDeathWithACompleteCheckoutIsInstalled() = runTest {
        val (live, _) = installing()
        fixture.writeInstalledCheckout()
        val record = live.saveState()
        processDeath()
        assertEquals(FirstRunStage.Installed, controller(record).state.value.stage)
    }

    @Test
    fun installingWhoseJobFinishedMeanwhileShowsItsResult() = runTest {
        val (live, job) = installing()
        val record = live.saveState()
        fixture.host.setup.value = SetupState.Finished(job, 2, listOf("error: x"))
        val restored = controller(record)
        assertEquals(
            FirstRunStage.Failed(FirstRunFailure.Install(2), listOf("error: x"), partialCheckout = false),
            restored.state.value.stage,
        )
    }

    @Test
    fun aCancelInFlightSurvivesRecreation() = runTest {
        val (live, job) = installing()
        live.requestCancel()
        live.confirmCancel()
        runCurrent()
        val record = live.saveState()

        val stillRunning = controller(record)
        assertEquals(FirstRunStage.Installing(emptyList(), cancelling = true), stillRunning.state.value.stage)

        fixture.host.setup.value = SetupState.Finished(job, 143, emptyList())
        runCurrent()
        assertEquals(FirstRunFailure.Cancelled, (stillRunning.state.value.stage as FirstRunStage.Failed).failure)
        assertEquals(FirstRunFailure.Cancelled, (controller(record).state.value.stage as FirstRunStage.Failed).failure)
    }

    @Test
    fun busyIsRestored() = runTest {
        fixture.host.accept = false
        val live = controller()
        live.continueFromWelcome()
        runCurrent()
        assertEquals(FirstRunStage.Busy, live.state.value.stage)
        assertEquals(FirstRunStage.Busy, controller(live.saveState()).state.value.stage)
    }

    @Test
    fun anotherRunningJobShowsBusyWhateverTheRecordSays() = runTest {
        val repair = SetupJob(fixture.script, listOf("--no-start", "--migrate-from", "x"), fixture.filesDir)
        fixture.host.setup.value = SetupState.Running(repair, emptyList())
        assertEquals(FirstRunStage.Busy, controller().state.value.stage)
        assertEquals(FirstRunStage.Busy, controller(snapshot(FirstRunSnapshot.Stage.WELCOME)).state.value.stage)
    }

    @Test
    fun everyFailureIsRestoredAndRepairFollowsTheFilesystem() = runTest {
        val failures = listOf(
            FirstRunFailure.LowStorage(10, FirstRunStorage.REQUIRED_FREE_BYTES),
            FirstRunFailure.Offline,
            FirstRunFailure.Layout("reason"),
            FirstRunFailure.Install(7),
            FirstRunFailure.Cancelled,
            FirstRunFailure.Interrupted,
            FirstRunFailure.NoCheckout,
            FirstRunFailure.MoveAside("reason"),
            FirstRunFailure.Unexpected("reason"),
        )
        for (failure in failures) {
            val restored = controller(snapshot(FirstRunSnapshot.Stage.FAILED, failure))
            assertEquals(FirstRunStage.Failed(failure, emptyList(), partialCheckout = false), restored.state.value.stage)
        }
        fixture.writePartialCheckout()
        for (failure in failures) {
            val restored = controller(snapshot(FirstRunSnapshot.Stage.FAILED, failure))
            assertEquals(FirstRunStage.Failed(failure, emptyList(), partialCheckout = true), restored.state.value.stage)
        }
        assertTrue(fixture.host.jobs.isEmpty())
    }

    @Test
    fun aLiveFailureKeepsItsLinesWhileTheResultIsStillThere() = runTest {
        val (live, job) = installing()
        fixture.host.setup.value = SetupState.Finished(job, 1, listOf("a", "b"))
        runCurrent()
        val restored = controller(live.saveState())
        assertEquals(
            FirstRunStage.Failed(FirstRunFailure.Install(1), listOf("a", "b"), partialCheckout = false),
            restored.state.value.stage,
        )
    }

    @Test
    fun theLogViewIsReopened() = runTest {
        val (live, job) = installing()
        fixture.host.setup.value = SetupState.Finished(job, 1, listOf("a"))
        runCurrent()
        live.openLogs()
        runCurrent()
        val restored = controller(live.saveState())
        assertEquals(FirstRunLogView(listOf("a"), fixture.setupLog), restored.state.value.logs)
    }

    @Test
    fun installedIsRestoredOnlyWithACheckout() = runTest {
        val (live, job) = installing()
        fixture.writeInstalledCheckout()
        fixture.host.setup.value = SetupState.Finished(job, 0, emptyList())
        runCurrent()
        val record = live.saveState()
        processDeath()
        assertEquals(FirstRunStage.Installed, controller(record).state.value.stage)

        fixture.paths.checkoutDir.deleteRecursively()
        assertEquals(FirstRunStage.Welcome, controller(record).state.value.stage)
    }

    @Test
    fun aFreshStartDerivesFromTheServerHostAndTheFilesystem() = runTest {
        val job = fixture.installJob()
        fixture.host.setup.value = SetupState.Running(job, listOf("x"))
        assertEquals(FirstRunStage.Installing(listOf("x"), cancelling = false), controller().state.value.stage)

        fixture.host.setup.value = SetupState.Finished(job, 3, listOf("y"))
        assertEquals(
            FirstRunStage.Failed(FirstRunFailure.Install(3), listOf("y"), partialCheckout = false),
            controller().state.value.stage,
        )

        fixture.writeInstalledCheckout()
        fixture.host.setup.value = SetupState.Finished(job, 0, emptyList())
        assertEquals(FirstRunStage.Installed, controller().state.value.stage)

        processDeath()
        assertEquals(FirstRunStage.Installed, controller().state.value.stage)

        fixture.paths.checkoutDir.deleteRecursively()
        fixture.writePartialCheckout()
        assertEquals(
            FirstRunStage.Failed(FirstRunFailure.Interrupted, emptyList(), partialCheckout = true),
            controller().state.value.stage,
        )

        fixture.paths.checkoutDir.deleteRecursively()
        fixture.paths.checkoutDir.mkdirs()
        assertEquals(FirstRunStage.Welcome, controller().state.value.stage)
        assertTrue(fixture.host.jobs.isEmpty())
    }

    @Test
    fun foreignOrBrokenRecordsStartFresh() = runTest {
        assertEquals(FirstRunStage.Welcome, controller(Bundle()).state.value.stage)
        val wrongVersion = snapshot(FirstRunSnapshot.Stage.BUSY).apply { putInt("version", 2) }
        assertEquals(FirstRunStage.Welcome, controller(wrongVersion).state.value.stage)
        val failedWithoutReason = snapshot(FirstRunSnapshot.Stage.FAILED)
        assertEquals(FirstRunStage.Welcome, controller(failedWithoutReason).state.value.stage)
        val unknownStage = snapshot(FirstRunSnapshot.Stage.BUSY).apply { putString("stage", "NOPE") }
        assertEquals(FirstRunStage.Welcome, controller(unknownStage).state.value.stage)
    }

    @Test
    fun aRecordSavedBeforeDerivingIsKept() = runTest {
        val record = FirstRunSnapshot(FirstRunSnapshot.Stage.BUSY, notifications = NotificationStatus.DENIED)
        val restoring = FirstRunController(
            fixture.dependencies(StandardTestDispatcher(testScheduler)),
            backgroundScope,
            record.toBundle(),
        )
        assertEquals(FirstRunStage.Loading, restoring.state.value.stage)
        assertEquals(record, FirstRunSnapshot.fromBundle(restoring.saveState()))
        assertEquals(null, FirstRunSnapshot.fromBundle(controllerWithoutRecord().saveState()))
    }

    private fun TestScope.controllerWithoutRecord(): FirstRunController =
        FirstRunController(fixture.dependencies(StandardTestDispatcher(testScheduler)), backgroundScope)

    @Test
    fun recordsRoundTrip() {
        val records = FirstRunSnapshot.Stage.entries.map { FirstRunSnapshot(it, failure = FirstRunFailure.Offline) } +
            listOf(
                FirstRunSnapshot(FirstRunSnapshot.Stage.METERED, cellular = true),
                FirstRunSnapshot(
                    FirstRunSnapshot.Stage.FAILED,
                    failure = FirstRunFailure.LowStorage(1, 2),
                    notifications = NotificationStatus.PERMANENTLY_DENIED,
                    battery = BatteryStatus.SKIPPED,
                    cancelRequested = true,
                    logsOpen = true,
                ),
                FirstRunSnapshot(FirstRunSnapshot.Stage.FAILED, failure = FirstRunFailure.Layout("l")),
                FirstRunSnapshot(FirstRunSnapshot.Stage.FAILED, failure = FirstRunFailure.Install(-1)),
                FirstRunSnapshot(FirstRunSnapshot.Stage.FAILED, failure = FirstRunFailure.Cancelled),
                FirstRunSnapshot(FirstRunSnapshot.Stage.FAILED, failure = FirstRunFailure.Interrupted),
                FirstRunSnapshot(FirstRunSnapshot.Stage.FAILED, failure = FirstRunFailure.NoCheckout),
                FirstRunSnapshot(FirstRunSnapshot.Stage.FAILED, failure = FirstRunFailure.MoveAside("m")),
                FirstRunSnapshot(FirstRunSnapshot.Stage.FAILED, failure = FirstRunFailure.Unexpected("u")),
                FirstRunSnapshot(FirstRunSnapshot.Stage.INSTALLED, battery = BatteryStatus.EXEMPT),
            )
        for (record in records) {
            assertEquals(record, FirstRunSnapshot.fromBundle(record.toBundle()))
        }
        assertNotNull(FirstRunSnapshot.fromBundle(FirstRunSnapshot(FirstRunSnapshot.Stage.WELCOME).toBundle()))
    }
}
