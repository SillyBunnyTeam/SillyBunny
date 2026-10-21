package io.github.sillybunnyteam.sillybunny.firstrun

import android.os.Bundle
import io.github.sillybunnyteam.sillybunny.server.LaunchSession
import io.github.sillybunnyteam.sillybunny.server.ServerState
import io.github.sillybunnyteam.sillybunny.server.SetupJob
import io.github.sillybunnyteam.sillybunny.server.SetupState
import java.io.File
import java.nio.file.Files
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [37])
class FirstRunControllerTest {
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
        assertTrue(controller.state.value.stage is FirstRunStage.Installing)
        return controller to fixture.host.jobs.last()
    }

    private fun TestScope.finish(job: SetupJob, exitCode: Int, lines: List<String> = listOf("last")) {
        fixture.host.setup.value = SetupState.Finished(job, exitCode, lines)
        runCurrent()
    }

    @Test
    fun freshStartShowsWelcomeWithTheCurrentAnswers() = runTest {
        val state = controller().state.value
        assertEquals(FirstRunStage.Welcome, state.stage)
        assertEquals(NotificationStatus.NOT_ASKED, state.notifications)
        assertEquals(BatteryStatus.NOT_EXEMPT, state.battery)
        assertTrue(state.visible)
        assertTrue(fixture.host.jobs.isEmpty())
    }

    @Test
    fun notificationsNeedNoRequestBelowApi33() = runTest {
        fixture.notifications.required = false
        val controller = controller()
        assertEquals(NotificationStatus.NOT_REQUIRED, controller.state.value.notifications)
        controller.onNotificationPermissionResult(granted = false, canAskAgain = false)
        assertEquals(NotificationStatus.NOT_REQUIRED, controller.state.value.notifications)
    }

    @Test
    fun grantedPermissionIsShownAndKept() = runTest {
        val controller = controller()
        fixture.notifications.granted = true
        controller.onNotificationPermissionResult(granted = true, canAskAgain = false)
        assertEquals(NotificationStatus.GRANTED, controller.state.value.notifications)

        val preGranted = controller()
        assertEquals(NotificationStatus.GRANTED, preGranted.state.value.notifications)
    }

    @Test
    fun aDenialCanBeAskedAgainUntilItIsPermanent() = runTest {
        val controller = controller()
        controller.onNotificationPermissionResult(granted = false, canAskAgain = true)
        assertEquals(NotificationStatus.DENIED, controller.state.value.notifications)
        controller.onNotificationPermissionResult(granted = false, canAskAgain = false)
        assertEquals(NotificationStatus.PERMANENTLY_DENIED, controller.state.value.notifications)
        controller.onNotificationPermissionResult(granted = false, canAskAgain = false)
        assertEquals(NotificationStatus.PERMANENTLY_DENIED, controller.state.value.notifications)
    }

    @Test
    fun aDismissedFirstRequestIsNotPermanent() = runTest {
        val controller = controller()
        controller.onNotificationPermissionResult(granted = false, canAskAgain = false)
        assertEquals(NotificationStatus.DENIED, controller.state.value.notifications)
    }

    @Test
    fun aPermanentDenialNeverBlocksTheInstall() = runTest {
        val controller = controller()
        controller.onNotificationPermissionResult(granted = false, canAskAgain = true)
        controller.onNotificationPermissionResult(granted = false, canAskAgain = false)
        controller.continueFromWelcome()
        runCurrent()
        assertTrue(controller.state.value.stage is FirstRunStage.Installing)
        assertEquals(1, fixture.host.jobs.size)
    }

    @Test
    fun anAcceptedExemptionIsShown() = runTest {
        val controller = controller()
        fixture.exempt = true
        controller.onBatteryExemptionResult()
        assertEquals(BatteryStatus.EXEMPT, controller.state.value.battery)
        controller.skipBatteryExemption()
        assertEquals(BatteryStatus.EXEMPT, controller.state.value.battery)
    }

    @Test
    fun aDeclinedOrUnavailableExemptionCountsAsSkipped() = runTest {
        val controller = controller()
        controller.onBatteryExemptionResult()
        assertEquals(BatteryStatus.SKIPPED, controller.state.value.battery)

        val unavailable = controller()
        unavailable.onBatteryExemptionUnavailable()
        assertEquals(BatteryStatus.SKIPPED, unavailable.state.value.battery)
    }

    @Test
    fun aSkippedExemptionNeverBlocksTheInstall() = runTest {
        val controller = controller()
        controller.skipBatteryExemption()
        assertEquals(BatteryStatus.SKIPPED, controller.state.value.battery)
        controller.continueFromWelcome()
        runCurrent()
        assertTrue(controller.state.value.stage is FirstRunStage.Installing)
    }

    @Test
    fun anExistingExemptionIsReadAtStart() = runTest {
        fixture.exempt = true
        assertEquals(BatteryStatus.EXEMPT, controller().state.value.battery)
    }

    @Test
    fun storageBelowTheThresholdStopsBeforeAnythingRuns() = runTest {
        fixture.availableBytes = FirstRunStorage.REQUIRED_FREE_BYTES - 1
        val controller = controller()
        controller.continueFromWelcome()
        runCurrent()
        val stage = controller.state.value.stage as FirstRunStage.Failed
        assertEquals(
            FirstRunFailure.LowStorage(FirstRunStorage.REQUIRED_FREE_BYTES - 1, FirstRunStorage.REQUIRED_FREE_BYTES),
            stage.failure,
        )
        assertEquals(0, fixture.networkCalls)
        assertEquals(0, fixture.layoutCalls)
        assertTrue(fixture.host.jobs.isEmpty())

        fixture.availableBytes = FirstRunStorage.REQUIRED_FREE_BYTES
        controller.retry()
        runCurrent()
        assertTrue(controller.state.value.stage is FirstRunStage.Installing)
    }

    @Test
    fun offlineShowsAnErrorAndRetryChecksAgain() = runTest {
        fixture.network = NetworkKind.NONE
        val controller = controller()
        controller.continueFromWelcome()
        runCurrent()
        assertEquals(FirstRunFailure.Offline, (controller.state.value.stage as FirstRunStage.Failed).failure)
        assertEquals(0, fixture.layoutCalls)
        assertTrue(fixture.host.jobs.isEmpty())

        fixture.network = NetworkKind.UNMETERED
        controller.retry()
        runCurrent()
        assertTrue(controller.state.value.stage is FirstRunStage.Installing)
    }

    @Test
    fun aMeteredNetworkWarnsAndContinuesOnlyWhenConfirmed() = runTest {
        fixture.network = NetworkKind.METERED
        val controller = controller()
        controller.continueFromWelcome()
        runCurrent()
        assertEquals(FirstRunStage.MeteredWarning(cellular = false), controller.state.value.stage)
        assertEquals(0, fixture.layoutCalls)
        assertTrue(fixture.host.jobs.isEmpty())

        controller.continueOnMeteredNetwork()
        runCurrent()
        assertTrue(controller.state.value.stage is FirstRunStage.Installing)
        assertEquals(1, fixture.layoutCalls)
    }

    @Test
    fun aCellularNetworkWarns() = runTest {
        fixture.network = NetworkKind.CELLULAR
        val controller = controller()
        controller.continueFromWelcome()
        runCurrent()
        assertEquals(FirstRunStage.MeteredWarning(cellular = true), controller.state.value.stage)
    }

    @Test
    fun checkingAgainOnAnUnmeteredNetworkSkipsTheWarning() = runTest {
        fixture.network = NetworkKind.CELLULAR
        val controller = controller()
        controller.continueFromWelcome()
        runCurrent()
        fixture.network = NetworkKind.UNMETERED
        controller.retry()
        runCurrent()
        assertTrue(controller.state.value.stage is FirstRunStage.Installing)
    }

    @Test
    fun anUnmeteredNetworkInstallsWithoutAWarning() = runTest {
        val (controller, job) = installing()
        assertEquals(1, fixture.storageCalls)
        assertEquals(1, fixture.networkCalls)
        assertEquals(1, fixture.layoutCalls)
        assertEquals(FirstRunStage.Installing(emptyList(), cancelling = false), controller.state.value.stage)
        assertSame(fixture.script, job.script)
    }

    @Test
    fun theInstallJobHasTheExactArguments() = runTest {
        val (_, job) = installing()
        assertEquals(
            listOf("--no-start", "--dir", fixture.paths.checkoutDir.path, "--ref", FirstRunFixture.REF, "--use-node"),
            job.args,
        )
        assertEquals(fixture.filesDir, job.workingDir)
    }

    @Test
    fun aLayoutFailureShowsItsReason() = runTest {
        fixture.layout = { RuntimeLayoutOutcome.Failed("links missing") }
        val controller = controller()
        controller.continueFromWelcome()
        runCurrent()
        assertEquals(FirstRunFailure.Layout("links missing"), (controller.state.value.stage as FirstRunStage.Failed).failure)
        assertTrue(fixture.host.jobs.isEmpty())
    }

    @Test
    fun aThrowingLayoutCountsAsAFailure() = runTest {
        fixture.layout = { throw IllegalStateException("asset unreadable") }
        val controller = controller()
        controller.continueFromWelcome()
        runCurrent()
        assertEquals(FirstRunFailure.Layout("asset unreadable"), (controller.state.value.stage as FirstRunStage.Failed).failure)
        assertTrue(fixture.host.jobs.isEmpty())
    }

    @Test
    fun aRefusedSetupShowsBusyWithoutASecondJob() = runTest {
        fixture.host.accept = false
        val controller = controller()
        controller.continueFromWelcome()
        runCurrent()
        assertEquals(FirstRunStage.Busy, controller.state.value.stage)
        assertTrue(fixture.host.jobs.isEmpty())

        fixture.host.accept = true
        controller.retry()
        runCurrent()
        assertTrue(controller.state.value.stage is FirstRunStage.Installing)
        assertEquals(1, fixture.host.jobs.size)
    }

    @Test
    fun aThrowingServerHostIsAnUnexpectedFailure() = runTest {
        fixture.host.failure = IllegalStateException("service start not allowed")
        val controller = controller()
        controller.continueFromWelcome()
        runCurrent()
        assertEquals(
            FirstRunFailure.Unexpected("service start not allowed"),
            (controller.state.value.stage as FirstRunStage.Failed).failure,
        )
    }

    @Test
    fun progressIsStreamedAndSuccessNeedsACheckout() = runTest {
        val (controller, job) = installing()
        fixture.host.setup.value = SetupState.Running(job, listOf("Cloning"))
        runCurrent()
        assertEquals(listOf("Cloning"), (controller.state.value.stage as FirstRunStage.Installing).lines)
        fixture.host.setup.value = SetupState.Running(job, listOf("Cloning", "Receiving objects"))
        runCurrent()
        assertEquals(2, (controller.state.value.stage as FirstRunStage.Installing).lines.size)

        fixture.writeInstalledCheckout()
        finish(job, 0)
        assertEquals(FirstRunStage.Installed, controller.state.value.stage)
    }

    @Test
    fun aNonZeroExitShowsTheErrorWithItsLinesAndRepairForAPartialCheckout() = runTest {
        val (controller, job) = installing()
        fixture.writePartialCheckout()
        finish(job, 128, listOf("fatal: early EOF"))
        assertEquals(
            FirstRunStage.Failed(FirstRunFailure.Install(128), listOf("fatal: early EOF"), partialCheckout = true),
            controller.state.value.stage,
        )
    }

    @Test
    fun aFailureWithNothingLeftHidesRepair() = runTest {
        val (controller, job) = installing()
        finish(job, 1)
        assertFalse((controller.state.value.stage as FirstRunStage.Failed).partialCheckout)
    }

    @Test
    fun exitZeroWithoutACheckoutIsAFailure() = runTest {
        val (controller, job) = installing()
        finish(job, 0)
        assertEquals(FirstRunFailure.NoCheckout, (controller.state.value.stage as FirstRunStage.Failed).failure)
    }

    @Test
    fun cancelNeedsAConfirmationAndEndsOnTheErrorScreen() = runTest {
        val (controller, job) = installing()
        controller.requestCancel()
        assertTrue(controller.state.value.confirmingCancel)
        controller.dismissCancel()
        runCurrent()
        assertFalse(controller.state.value.confirmingCancel)
        assertEquals(0, fixture.host.cancelCount)

        controller.requestCancel()
        controller.confirmCancel()
        runCurrent()
        assertEquals(1, fixture.host.cancelCount)
        assertEquals(FirstRunStage.Installing(emptyList(), cancelling = true), controller.state.value.stage)
        controller.requestCancel()
        assertFalse(controller.state.value.confirmingCancel)

        finish(job, 143)
        assertEquals(FirstRunFailure.Cancelled, (controller.state.value.stage as FirstRunStage.Failed).failure)
    }

    @Test
    fun aJobThatEndsWellDespiteACancelStillSucceeds() = runTest {
        val (controller, job) = installing()
        controller.requestCancel()
        controller.confirmCancel()
        fixture.writeInstalledCheckout()
        finish(job, 0)
        assertEquals(FirstRunStage.Installed, controller.state.value.stage)
    }

    @Test
    fun backClosesTheSubViewsAndNeverCancelsTheInstall() = runTest {
        val (controller, job) = installing()
        controller.requestCancel()
        assertTrue(controller.handleBack())
        assertFalse(controller.state.value.confirmingCancel)
        assertFalse(controller.handleBack())
        runCurrent()
        assertEquals(0, fixture.host.cancelCount)
        assertTrue(controller.state.value.stage is FirstRunStage.Installing)

        finish(job, 1)
        controller.openLogs()
        assertTrue(controller.handleBack())
        assertNull(controller.state.value.logs)
        assertFalse(controller.handleBack())
    }

    @Test
    fun theLogViewShowsTheLastLinesThenTheSetupLog() = runTest {
        val (controller, job) = installing()
        finish(job, 1, listOf("one", "two"))
        controller.openLogs()
        assertEquals(FirstRunLogView(listOf("one", "two"), setupLog = null), controller.state.value.logs)
        runCurrent()
        assertEquals(FirstRunLogView(listOf("one", "two"), fixture.setupLog), controller.state.value.logs)
        controller.closeLogs()
        assertNull(controller.state.value.logs)
    }

    @Test
    fun retryMovesAPartialCheckoutAsideWithoutDeletingAnything() = runTest {
        val (controller, job) = installing()
        val partial = fixture.writePartialCheckout()
        finish(job, 1)
        assertTrue((controller.state.value.stage as FirstRunStage.Failed).partialCheckout)

        var checkoutAtSecondStart: Boolean? = null
        fixture.host.onRunSetup = { checkoutAtSecondStart = fixture.paths.checkoutDir.exists() }
        controller.retry()
        runCurrent()

        assertTrue(controller.state.value.stage is FirstRunStage.Installing)
        assertEquals(false, checkoutAtSecondStart)
        assertEquals(2, fixture.host.jobs.size)
        assertEquals(job.args, fixture.host.jobs.last().args)
        val broken = fixture.brokenCheckouts().single()
        assertEquals(File(fixture.filesDir, "SillyBunny.broken-20261021T120000Z"), broken)
        assertEquals(partial, FirstRunFixture.tree(broken))
    }

    @Test
    fun aSecondRetryUsesTheNextFreeName() = runTest {
        val (controller, job) = installing()
        fixture.writePartialCheckout()
        finish(job, 1)
        controller.retry()
        runCurrent()
        fixture.writePartialCheckout()
        finish(fixture.host.jobs.last(), 1)
        controller.retry()
        runCurrent()
        assertEquals(
            listOf("SillyBunny.broken-20261021T120000Z", "SillyBunny.broken-20261021T120000Z-2"),
            fixture.brokenCheckouts().map { it.name },
        )
    }

    @Test
    fun aFailedMoveAsideStopsAndLeavesEverythingInPlace() = runTest {
        val target = File(temporary.root, "elsewhere").apply { mkdirs() }
        File(target, "keep.txt").writeText("keep")
        Files.createSymbolicLink(fixture.paths.checkoutDir.toPath(), target.toPath())

        val controller = controller()
        assertEquals(
            FirstRunStage.Failed(FirstRunFailure.Interrupted, emptyList(), partialCheckout = true),
            controller.state.value.stage,
        )
        controller.retry()
        runCurrent()

        val stage = controller.state.value.stage as FirstRunStage.Failed
        assertTrue(stage.failure is FirstRunFailure.MoveAside)
        assertTrue(stage.partialCheckout)
        assertTrue(fixture.host.jobs.isEmpty())
        assertTrue(Files.isSymbolicLink(fixture.paths.checkoutDir.toPath()))
        assertEquals("keep", File(target, "keep.txt").readText())
        assertTrue(fixture.brokenCheckouts().isEmpty())
    }

    @Test
    fun aFileInTheWayIsNeverDeleted() = runTest {
        fixture.paths.checkoutDir.writeText("not a directory")
        val controller = controller()
        controller.retry()
        runCurrent()
        assertTrue((controller.state.value.stage as FirstRunStage.Failed).failure is FirstRunFailure.MoveAside)
        assertEquals("not a directory", fixture.paths.checkoutDir.readText())
        assertTrue(fixture.host.jobs.isEmpty())
    }

    @Test
    fun anEmptyCheckoutFolderIsLeftForTheInstaller() = runTest {
        fixture.paths.checkoutDir.mkdirs()
        val controller = controller()
        assertEquals(FirstRunStage.Welcome, controller.state.value.stage)
        controller.continueFromWelcome()
        runCurrent()
        assertTrue(controller.state.value.stage is FirstRunStage.Installing)
        assertTrue(fixture.paths.checkoutDir.isDirectory)
        assertTrue(fixture.brokenCheckouts().isEmpty())
    }

    @Test
    fun anInvisibleActivityWaitsForTheNextStartBeforeInstalling() = runTest {
        val controller = controller()
        controller.setVisible(false)
        controller.continueFromWelcome()
        runCurrent()
        assertEquals(FirstRunStage.WaitingForForeground, controller.state.value.stage)
        assertEquals(1, fixture.layoutCalls)
        assertTrue(fixture.host.jobs.isEmpty())

        controller.setVisible(true)
        runCurrent()
        assertTrue(controller.state.value.stage is FirstRunStage.Installing)
        assertEquals(1, fixture.host.jobs.size)
        assertEquals(1, fixture.layoutCalls)
    }

    @Test
    fun backgroundingDuringAsynchronousWorkDefersTheStart() = runTest {
        lateinit var subject: FirstRunController
        fixture.layout = {
            subject.setVisible(false)
            RuntimeLayoutOutcome.Ready
        }
        subject = controller()
        subject.continueFromWelcome()
        runCurrent()
        assertEquals(FirstRunStage.WaitingForForeground, subject.state.value.stage)
        assertTrue(fixture.host.jobs.isEmpty())

        subject.setVisible(true)
        runCurrent()
        assertEquals(1, fixture.host.jobs.size)
    }

    @Test
    fun aRetryInTheBackgroundKeepsThePartialCheckoutUntilTheNextStart() = runTest {
        val (controller, job) = installing()
        val partial = fixture.writePartialCheckout()
        finish(job, 1)
        fixture.network = NetworkKind.METERED
        controller.retry()
        runCurrent()
        controller.continueOnMeteredNetwork()
        controller.setVisible(false)
        runCurrent()
        assertEquals(FirstRunStage.WaitingForForeground, controller.state.value.stage)
        assertEquals(1, fixture.host.jobs.size)
        assertEquals(partial, FirstRunFixture.tree(fixture.paths.checkoutDir))
        assertTrue(fixture.brokenCheckouts().isEmpty())

        controller.setVisible(true)
        runCurrent()
        assertEquals(2, fixture.host.jobs.size)
        assertEquals(partial, FirstRunFixture.tree(fixture.brokenCheckouts().single()))
    }

    @Test
    fun anOldResultIsIgnoredUntilTheNewJobRuns() = runTest {
        val (controller, first) = installing()
        finish(first, 1)
        fixture.host.publishRunning = false
        controller.retry()
        runCurrent()
        assertTrue(controller.state.value.stage is FirstRunStage.Installing)

        val second = fixture.host.jobs.last()
        fixture.host.setup.value = SetupState.Running(second, listOf("again"))
        runCurrent()
        assertEquals(listOf("again"), (controller.state.value.stage as FirstRunStage.Installing).lines)
        fixture.writeInstalledCheckout()
        finish(second, 0)
        assertEquals(FirstRunStage.Installed, controller.state.value.stage)
    }

    @Test
    fun aJobThatVanishesIsReportedAsInterrupted() = runTest {
        val (controller, job) = installing()
        fixture.host.setup.value = SetupState.Running(job, listOf("one"))
        runCurrent()
        fixture.host.setup.value = SetupState.Idle
        runCurrent()
        assertEquals(FirstRunFailure.Interrupted, (controller.state.value.stage as FirstRunStage.Failed).failure)
    }

    @Test
    fun anotherJobReplacingOursIsReportedAsInterrupted() = runTest {
        val (controller, _) = installing()
        val repair = SetupJob(fixture.script, listOf("--migrate-from", "x"), fixture.filesDir)
        fixture.host.setup.value = SetupState.Running(repair, emptyList())
        runCurrent()
        assertEquals(FirstRunFailure.Interrupted, (controller.state.value.stage as FirstRunStage.Failed).failure)
    }

    @Test
    fun repeatedTapsStartOnePipeline() = runTest {
        val controller = controller()
        controller.continueFromWelcome()
        controller.continueFromWelcome()
        runCurrent()
        assertEquals(1, fixture.layoutCalls)
        assertEquals(1, fixture.host.jobs.size)
    }

    @Test
    fun retryFromBusyWhileRepairRunsTouchesNothing() = runTest {
        val repair = fixture.repairJob()
        fixture.host.setup.value = SetupState.Running(repair, listOf("Cloning"))
        fixture.host.accept = false
        var asked = 0
        fixture.host.onRunSetup = { asked++ }
        val inProgress = fixture.writeRepairInProgress()
        val controller = controller()
        assertEquals(FirstRunStage.Busy, controller.state.value.stage)

        controller.retry()
        runCurrent()
        assertEquals(FirstRunStage.Busy, controller.state.value.stage)
        assertEquals(inProgress, FirstRunFixture.tree(fixture.paths.checkoutDir))
        assertTrue(fixture.brokenCheckouts().isEmpty())
        assertSame(repair, (fixture.host.setup.value as SetupState.Running).job)
        assertEquals(0, asked)
        assertEquals(0, fixture.storageCalls)
        assertEquals(0, fixture.layoutCalls)
    }

    @Test
    fun retryFromTheErrorScreenWhileRepairRunsTouchesNothing() = runTest {
        val (controller, job) = installing()
        finish(job, 1, listOf("fatal"))
        assertEquals(FirstRunFailure.Install(1), (controller.state.value.stage as FirstRunStage.Failed).failure)

        // The error screen's Repair callback starts p59's job, which clones and migrates into checkoutDir.
        val repair = fixture.repairJob()
        fixture.host.setup.value = SetupState.Running(repair, listOf("Cloning"))
        fixture.host.accept = false
        val inProgress = fixture.writeRepairInProgress()
        runCurrent()

        controller.retry()
        runCurrent()
        assertEquals(FirstRunStage.Busy, controller.state.value.stage)
        assertEquals(inProgress, FirstRunFixture.tree(fixture.paths.checkoutDir))
        assertTrue(fixture.brokenCheckouts().isEmpty())
        assertSame(repair, (fixture.host.setup.value as SetupState.Running).job)
        assertEquals(1, fixture.host.jobs.size)
    }

    @Test
    fun retryWhileTheServerIsUpTouchesNothing() = runTest {
        val partial = fixture.writePartialCheckout()
        val controller = controller()
        assertEquals(FirstRunFailure.Interrupted, (controller.state.value.stage as FirstRunStage.Failed).failure)
        val session = LaunchSession(40_000, "0".repeat(64))
        for (server in listOf(ServerState.Starting(1), ServerState.Running(session, false), ServerState.Stopping)) {
            fixture.host.state.value = server
            controller.retry()
            runCurrent()
            assertEquals(FirstRunStage.Busy, controller.state.value.stage)
            assertEquals(partial, FirstRunFixture.tree(fixture.paths.checkoutDir))
            assertTrue(fixture.brokenCheckouts().isEmpty())
            assertTrue(fixture.host.jobs.isEmpty())
        }

        // A server that gave up has no process left: Retry moves the partial checkout aside and installs.
        fixture.host.state.value = ServerState.Failed(listOf("exit 1"), canRestart = true)
        controller.retry()
        runCurrent()
        assertTrue(controller.state.value.stage is FirstRunStage.Installing)
        assertEquals(partial, FirstRunFixture.tree(fixture.brokenCheckouts().single()))
        assertEquals(1, fixture.host.jobs.size)
    }

    @Test
    fun aJobStartingWhileTheCheckoutIsReadStopsTheRename() = runTest {
        val partial = fixture.writePartialCheckout()
        val controller = controller()
        val repair = fixture.repairJob()
        // Repair starts after the install step's busy check, while that step reads checkoutDir.
        fixture.onInspect = {
            if (controller.state.value.stage == FirstRunStage.Preparing) {
                fixture.host.setup.value = SetupState.Running(repair, emptyList())
            }
        }
        controller.retry()
        runCurrent()
        assertEquals(FirstRunStage.Busy, controller.state.value.stage)
        assertEquals(partial, FirstRunFixture.tree(fixture.paths.checkoutDir))
        assertTrue(fixture.brokenCheckouts().isEmpty())
        assertTrue(fixture.host.jobs.isEmpty())
        assertEquals(1, fixture.layoutCalls)
    }

    @Test
    fun retryAfterRepairFinishedKeepsItsCheckout() = runTest {
        val (controller, job) = installing()
        finish(job, 1, listOf("fatal"))
        val repair = fixture.repairJob()
        fixture.host.setup.value = SetupState.Running(repair, listOf("Cloning"))
        runCurrent()
        controller.retry()
        runCurrent()
        assertEquals(FirstRunStage.Busy, controller.state.value.stage)

        // Repair finishes: a complete checkout that holds the user's data.
        fixture.writeRepairInProgress()
        val repaired = fixture.writeInstalledCheckout()
        fixture.host.setup.value = SetupState.Finished(repair, 0, listOf("Done"))
        runCurrent()
        val checks = fixture.storageCalls
        controller.retry()
        runCurrent()
        assertEquals(FirstRunStage.Installed, controller.state.value.stage)
        assertEquals(repaired, FirstRunFixture.tree(fixture.paths.checkoutDir))
        assertTrue(fixture.brokenCheckouts().isEmpty())
        assertEquals(1, fixture.host.jobs.size)
        assertEquals(checks, fixture.storageCalls)
    }

    @Test
    fun aCheckoutFinishedElsewhereBeforeTheInstallIsNeverMoved() = runTest {
        fixture.network = NetworkKind.METERED
        val controller = controller()
        controller.continueFromWelcome()
        runCurrent()
        assertEquals(FirstRunStage.MeteredWarning(cellular = false), controller.state.value.stage)

        // Meanwhile another job, such as a first run in a second window, finished a checkout.
        val finished = fixture.writeInstalledCheckout()
        controller.continueOnMeteredNetwork()
        runCurrent()
        assertEquals(FirstRunStage.Installed, controller.state.value.stage)
        assertEquals(finished, FirstRunFixture.tree(fixture.paths.checkoutDir))
        assertTrue(fixture.brokenCheckouts().isEmpty())
        assertTrue(fixture.host.jobs.isEmpty())
    }
}
