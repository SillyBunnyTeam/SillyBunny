package io.github.sillybunnyteam.sillybunny.firstrun

import android.os.SystemClock
import androidx.lifecycle.Lifecycle
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import io.github.sillybunnyteam.sillybunny.BuildConfig
import io.github.sillybunnyteam.sillybunny.checkout.BrokenCheckouts
import io.github.sillybunnyteam.sillybunny.firstrun.FirstRunDeviceFixture.Companion.eventually
import io.github.sillybunnyteam.sillybunny.firstrun.FirstRunDeviceFixture.Companion.tree
import io.github.sillybunnyteam.sillybunny.server.SetupState
import java.io.File
import java.nio.file.Files
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TestName
import org.junit.runner.RunWith

/** The whole flow on a device, against a server host that runs a real `/system/bin/sh` script. */
@RunWith(AndroidJUnit4::class)
class FirstRunDeviceTest {
    @get:Rule
    val name = TestName()

    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val device = UiDevice.getInstance(instrumentation)
    private lateinit var fixture: FirstRunDeviceFixture
    private val screens = mutableListOf<FirstRunScreenHost>()

    @Before
    fun setUp() {
        fixture = FirstRunDeviceFixture(context, name.methodName)
    }

    @After
    fun tearDown() {
        try {
            screens.forEach { it.close() }
        } finally {
            fixture.close()
        }
    }

    private fun launch(): FirstRunScreenHost = FirstRunScreenHost(fixture.dependencies()).launch().also { screens += it }

    private fun stage(screen: FirstRunScreenHost): FirstRunStage = screen.controller.state.value.stage

    private fun installingLines(screen: FirstRunScreenHost): Int = (stage(screen) as? FirstRunStage.Installing)?.lines?.size ?: -1

    @Test
    fun anInstallKeepsRunningWhileStoppedAndItsSuccessWaitsForTheNextStart() {
        fixture.mode("success")
        val screen = launch()
        FirstRunUi.click("firstrun_continue")
        assertTrue(FirstRunUi.shown("firstrun_install_latest"))
        val job = fixture.host.jobs.single()
        assertEquals(
            listOf("--no-start", "--dir", fixture.paths.checkoutDir.path, "--ref", BuildConfig.DEFAULT_REF, "--use-node"),
            job.args,
        )
        assertEquals(fixture.script, job.script)
        assertEquals(fixture.paths.filesDir, job.workingDir)

        // Stopped: the job keeps streaming, and the screen shows its current lines once it is started again.
        screen.scenario.moveToState(Lifecycle.State.CREATED)
        assertFalse(screen.controller.state.value.visible)
        val before = fixture.host.runningLines()
        eventually { fixture.host.runningLines() >= before + 3 }
        screen.scenario.moveToState(Lifecycle.State.RESUMED)
        eventually { screen.controller.state.value.visible && installingLines(screen) >= before + 3 }
        assertTrue(FirstRunUi.shown("firstrun_install_latest"))

        // It finishes while stopped: success is reported only once the activity is started again.
        screen.scenario.moveToState(Lifecycle.State.CREATED)
        fixture.release()
        eventually(20_000) { stage(screen) == FirstRunStage.Installed }
        SystemClock.sleep(SETTLE_MILLIS)
        assertEquals(0, screen.installed.get())
        screen.scenario.moveToState(Lifecycle.State.RESUMED)
        eventually { screen.installed.get() == 1 }

        assertTrue(File(fixture.paths.checkoutDir, ".git/HEAD").isFile)
        assertTrue(File(fixture.paths.checkoutDir, ".git/index").isFile)
        assertTrue(File(fixture.paths.checkoutDir, "package.json").isFile)
        assertTrue(BrokenCheckouts.list(fixture.paths).isEmpty())
        assertEquals(listOf("absent"), fixture.starts())
        assertEquals(1, fixture.host.jobs.size)
        assertEquals(0, fixture.host.cancels.get())
    }

    @Test
    fun aKilledCloneIsInterruptedAndRetryWaitsWhileAnotherJobRuns() {
        // A clone killed during its checkout: package.json is written, the index is still .git/index.lock.
        val checkout = fixture.paths.checkoutDir
        File(checkout, ".git").mkdirs()
        File(checkout, ".git/HEAD").writeText("ref: refs/heads/staging\n")
        File(checkout, ".git/index.lock").writeText("")
        File(checkout, "package.json").writeText("{\"name\":\"sillybunny\"}\n")
        val killed = tree(checkout)
        fixture.mode("success")
        val screen = launch()
        assertTrue(FirstRunUi.shown("firstrun_error_interrupted"))
        assertTrue(FirstRunUi.shown("firstrun_repair"))
        assertEquals(FirstRunFailure.Interrupted, (stage(screen) as FirstRunStage.Failed).failure)
        assertEquals(0, screen.installed.get())

        // Another setup job (Repair, say) runs: Retry, from the error screen and then from Busy, touches nothing.
        val other = fixture.otherJob()
        assertTrue(fixture.host.runSetup(context, other))
        FirstRunUi.click("firstrun_retry")
        assertTrue(FirstRunUi.shown("firstrun_busy"))
        eventually { stage(screen) == FirstRunStage.Busy }
        FirstRunUi.click("firstrun_retry")
        SystemClock.sleep(SETTLE_MILLIS)
        assertEquals(FirstRunStage.Busy, stage(screen))
        assertTrue(FirstRunUi.shown("firstrun_busy"))
        assertEquals(killed, tree(checkout))
        assertTrue(BrokenCheckouts.list(fixture.paths).isEmpty())
        assertEquals(listOf(other), fixture.host.jobs.toList())
        assertTrue(fixture.starts().isEmpty())

        // Once that job has finished, Retry moves the killed clone aside, never deleting it, and installs.
        fixture.releaseOther()
        eventually { (fixture.host.setup.value as? SetupState.Finished)?.job === other }
        fixture.release()
        FirstRunUi.click("firstrun_retry")
        eventually(20_000) { screen.installed.get() == 1 }
        assertEquals(killed, tree(BrokenCheckouts.list(fixture.paths).single()))
        assertEquals(listOf("absent"), fixture.starts())
        assertTrue(File(checkout, ".git/index").isFile)
        assertEquals(2, fixture.host.jobs.size)
    }

    @Test
    fun homeAndBackLeaveTheInstallRunningAndANewActivityShowsIt() {
        fixture.mode("success")
        val first = launch()
        FirstRunUi.click("firstrun_continue")
        assertTrue(FirstRunUi.shown("firstrun_install_latest"))

        // A real Home press stops the activity; the job keeps going.
        device.pressHome()
        eventually { !first.controller.state.value.visible }
        val before = fixture.host.streamed.get()
        eventually { fixture.host.streamed.get() >= before + 3 }
        first.bringToFront()
        eventually { installingLines(first) >= before + 3 }
        assertTrue(FirstRunUi.shown("firstrun_install_latest"))

        // The real system back leaves the app and never cancels the install.
        device.pressBack()
        eventually { !first.controller.state.value.visible }
        SystemClock.sleep(SETTLE_MILLIS)
        assertTrue(fixture.host.setup.value is SetupState.Running)
        assertEquals(0, fixture.host.cancels.get())

        // A new activity, with a new controller, derives the running job from the server host.
        first.close()
        val second = launch()
        eventually { stage(second) is FirstRunStage.Installing }
        assertNotSame(first.controller, second.controller)
        assertTrue(FirstRunUi.shown("firstrun_install_latest"))
        fixture.release()
        eventually(20_000) { second.installed.get() == 1 }
        assertEquals(0, first.installed.get())
        assertEquals(1, fixture.host.jobs.size)
        assertEquals(0, fixture.host.cancels.get())
    }

    @Test
    fun aConfigurationChangeKeepsTheControllerAndTheRunningInstall() {
        fixture.mode("success")
        val screen = launch()
        FirstRunUi.click("firstrun_continue")
        assertTrue(FirstRunUi.shown("firstrun_install_latest"))
        val controller = screen.controller

        screen.scenario.recreate()
        assertSame(controller, screen.controller)
        assertTrue(FirstRunUi.shown("firstrun_install_latest"))
        assertTrue(stage(screen) is FirstRunStage.Installing)

        fixture.release()
        eventually(20_000) { screen.installed.get() == 1 }
        assertEquals(1, fixture.host.jobs.size)
    }

    @Test
    fun theErrorScreenActionsAndTheMoveAsideBeforeARetry() {
        fixture.mode("partial")
        fixture.release()
        val screen = launch()
        FirstRunUi.click("firstrun_continue")
        assertTrue(FirstRunUi.shown("firstrun_error_install", 15_000))
        assertTrue(FirstRunUi.shown("firstrun_error_lines"))
        assertTrue(FirstRunUi.shown("firstrun_logs_warning"))
        assertTrue(FirstRunUi.shown("firstrun_repair"))
        val partial = tree(fixture.paths.checkoutDir)
        assertEquals(setOf(".git/HEAD", "half.js"), partial.keys)

        // View logs: the last lines and the setup log file; the real system back closes it.
        FirstRunUi.click("firstrun_view_logs")
        assertTrue(FirstRunUi.shown("firstrun_logs"))
        assertTrue(FirstRunUi.shown("firstrun_logs_sensitive"))
        assertTrue(FirstRunUi.gone("firstrun_logs_loading"))
        val logs = checkNotNull(screen.controller.state.value.logs)
        assertEquals(fixture.setupLogFile.readLines(), logs.setupLog)
        assertTrue(logs.setupLog!!.isNotEmpty())
        assertEquals((stage(screen) as FirstRunStage.Failed).lines, logs.lastLines)
        device.pressBack()
        assertTrue(FirstRunUi.gone("firstrun_logs"))
        assertTrue(FirstRunUi.shown("firstrun_error"))
        assertTrue(stage(screen) is FirstRunStage.Failed)

        FirstRunUi.click("firstrun_share_logs")
        FirstRunUi.click("firstrun_repair")
        eventually { screen.shares.get() == 1 && screen.repairs.get() == 1 }

        // Retry renames the partial checkout aside before install.sh runs again; nothing is deleted.
        fixture.mode("success")
        FirstRunUi.click("firstrun_retry")
        eventually(20_000) { screen.installed.get() == 1 }
        val broken = BrokenCheckouts.list(fixture.paths).single()
        assertTrue(BrokenCheckouts.isBrokenCheckoutName(broken.name))
        assertEquals(partial, tree(broken))
        assertEquals(listOf("absent", "absent"), fixture.starts())
        assertFalse(File(fixture.paths.checkoutDir, "half.js").exists())
        assertTrue(File(fixture.paths.checkoutDir, "package.json").isFile)
        assertEquals(2, fixture.host.jobs.size)
    }

    @Test
    fun aFailedMoveAsideStopsWithItsErrorAndKeepsEverything() {
        val elsewhere = File(fixture.root, "elsewhere").apply { mkdirs() }
        File(elsewhere, "keep.txt").writeText("keep")
        // A symlink in place of the checkout: moveAside refuses it instead of renaming what it points to.
        Files.createSymbolicLink(fixture.paths.checkoutDir.toPath(), elsewhere.toPath())
        fixture.mode("success")
        fixture.release()
        val screen = launch()
        assertTrue(FirstRunUi.shown("firstrun_error_interrupted"))
        assertTrue(FirstRunUi.shown("firstrun_repair"))

        FirstRunUi.click("firstrun_retry")
        assertTrue(FirstRunUi.shown("firstrun_error_move_aside", 15_000))
        assertTrue((stage(screen) as FirstRunStage.Failed).failure is FirstRunFailure.MoveAside)
        assertTrue(FirstRunUi.shown("firstrun_repair"))
        assertTrue(Files.isSymbolicLink(fixture.paths.checkoutDir.toPath()))
        assertEquals("keep", File(elsewhere, "keep.txt").readText())
        assertTrue(BrokenCheckouts.list(fixture.paths).isEmpty())
        assertTrue(fixture.host.jobs.isEmpty())
        assertTrue(fixture.starts().isEmpty())
    }

    @Test
    fun aRenameFailureStopsWithItsErrorAndDeletesNothing() {
        fixture.mode("success")
        fixture.release()
        val checkout = fixture.paths.checkoutDir
        File(checkout, ".git").mkdirs()
        File(checkout, ".git/HEAD").writeText("ref: refs/heads/staging\n")
        File(checkout, "half.js").writeText("half")
        val partial = tree(checkout)
        val screen = launch()
        assertTrue(FirstRunUi.shown("firstrun_error_interrupted"))

        // The app's user cannot rename inside a read-only folder, so rename(2) itself fails with EACCES.
        assertTrue(fixture.paths.filesDir.setWritable(false, false))
        try {
            FirstRunUi.click("firstrun_retry")
            assertTrue(FirstRunUi.shown("firstrun_error_move_aside", 15_000))
            val failed = stage(screen) as FirstRunStage.Failed
            assertTrue(failed.failure is FirstRunFailure.MoveAside)
            assertTrue(failed.partialCheckout)
        } finally {
            assertTrue(fixture.paths.filesDir.setWritable(true, true))
        }
        assertEquals(partial, tree(checkout))
        assertTrue(BrokenCheckouts.list(fixture.paths).isEmpty())
        assertTrue(fixture.host.jobs.isEmpty())
        assertTrue(fixture.starts().isEmpty())
    }

    @Test
    fun cancelStopsTheJobOnlyAfterAConfirmation() {
        fixture.mode("success")
        val screen = launch()
        FirstRunUi.click("firstrun_continue")
        assertTrue(FirstRunUi.shown("firstrun_install_latest"))

        FirstRunUi.click("firstrun_cancel")
        assertTrue(FirstRunUi.shown("firstrun_cancel_dialog"))
        FirstRunUi.click("firstrun_cancel_dismiss")
        assertTrue(FirstRunUi.gone("firstrun_cancel_dialog"))
        SystemClock.sleep(SETTLE_MILLIS)
        assertTrue(fixture.host.setup.value is SetupState.Running)
        assertEquals(0, fixture.host.cancels.get())

        FirstRunUi.click("firstrun_cancel")
        assertTrue(FirstRunUi.shown("firstrun_cancel_dialog"))
        FirstRunUi.click("firstrun_cancel_confirm")
        assertTrue(FirstRunUi.shown("firstrun_error_cancelled", 15_000))
        assertEquals(1, fixture.host.cancels.get())
        val finished = fixture.host.setup.value as SetupState.Finished
        assertTrue(finished.exitCode != 0)
        val failed = stage(screen) as FirstRunStage.Failed
        assertEquals(FirstRunFailure.Cancelled, failed.failure)
        assertFalse(fixture.paths.checkoutDir.exists())
        assertFalse(failed.partialCheckout)
        assertTrue(FirstRunUi.shown("firstrun_retry"))
        assertFalse(FirstRunUi.present("firstrun_repair"))
    }

    @Test
    fun aFailureWithNothingLeftOffersNoRepair() {
        fixture.mode("fail")
        fixture.release()
        val screen = launch()
        FirstRunUi.click("firstrun_continue")
        assertTrue(FirstRunUi.shown("firstrun_error_install", 15_000))
        val failed = stage(screen) as FirstRunStage.Failed
        assertEquals(FirstRunFailure.Install(1), failed.failure)
        assertFalse(failed.partialCheckout)
        assertFalse(fixture.paths.checkoutDir.exists())
        assertTrue(FirstRunUi.shown("firstrun_retry"))
        assertTrue(FirstRunUi.shown("firstrun_view_logs"))
        assertTrue(FirstRunUi.shown("firstrun_share_logs"))
        assertTrue(FirstRunUi.shown("firstrun_logs_warning"))
        assertFalse(FirstRunUi.present("firstrun_repair"))
    }

    private companion object {
        /** Lets in-flight work settle where the expected outcome is that nothing happens. */
        const val SETTLE_MILLIS = 1_000L
    }
}
