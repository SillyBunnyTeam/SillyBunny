package io.github.sillybunnyteam.sillybunny.repair

import android.content.Context
import androidx.activity.ComponentActivity
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.core.app.ApplicationProvider
import io.github.sillybunnyteam.sillybunny.checkout.BrokenCheckouts
import io.github.sillybunnyteam.sillybunny.runtime.RuntimePaths
import kotlinx.coroutines.Dispatchers
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

/**
 * The Repair screen (plan §4.7): confirmation, progress, result, and the rule that system back never cancels a
 * running Repair. Nodes are found by test tag only, never by text.
 */
// API 37 is not here: the Espresso 3.5.0 that Compose UI tests bring fails on it (InputManager.getInstance).
// The device suite covers API 37 with UiAutomator instead.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29, 36])
class RepairScreenTest {
    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>()

    @get:Rule
    val temporary = TemporaryFolder()

    private var state by mutableStateOf<RepairState>(RepairState.Idle)
    private val calls = mutableListOf<String>()
    private val source = File("/data/user/0/app/files/SillyBunny.broken-20261021T070001Z")

    private fun show() {
        compose.setContent {
            RepairTheme {
                RepairContent(
                    state = state,
                    onConfirm = { calls += "confirm" },
                    onCancel = { calls += "cancel" },
                    onRetry = { calls += "retry" },
                    onRetryWithDefaultRef = { calls += "retryDefault" },
                    onStartServer = { calls += "startServer" },
                    onClose = { calls += "close" },
                    onViewLogs = { calls += "viewLogs" },
                    onShareLogs = { calls += "shareLogs" },
                )
            }
        }
        compose.waitForIdle()
    }

    private fun exists(tag: String): Boolean {
        compose.waitForIdle()
        // Clickable rows merge their children, so tagged details live in the unmerged tree.
        return compose.onAllNodesWithTag(tag, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
    }

    private fun click(tag: String) {
        compose.onNodeWithTag(tag).performScrollTo().performClick()
        compose.waitForIdle()
    }

    /** Dialog buttons live in their own window, outside the screen's scroll container. */
    private fun clickInDialog(tag: String) {
        compose.onNodeWithTag(tag).performClick()
        compose.waitForIdle()
    }

    private fun back() {
        // The handler must see the latest state, so let it compose first.
        compose.waitForIdle()
        compose.runOnUiThread { compose.activity.onBackPressedDispatcher.onBackPressed() }
        compose.waitForIdle()
    }

    @Test
    fun theConfirmationSaysNothingIsDeletedAndStartsOnlyWhenConfirmed() {
        show()
        assertTrue(exists(RepairTags.CONFIRM))
        assertTrue(exists(RepairTags.CONFIRM_FILE_ACCESS))
        assertTrue(exists(RepairTags.CONFIRM_ACTION))
        assertFalse(exists(RepairTags.PROGRESS))
        assertTrue(calls.isEmpty())

        click(RepairTags.CONFIRM_ACTION)
        assertEquals(listOf("confirm"), calls)
        click(RepairTags.CLOSE)
        back()
        assertEquals(listOf("confirm", "close", "close"), calls)
    }

    @Test
    fun everyStepShowsItsProgressAndOnlyTheReinstallCanBeCancelled() {
        show()
        for (step in RepairStep.entries) {
            state = RepairState.Running(step, if (step == RepairStep.CHECKING) null else source, emptyList())
            assertTrue(step.name, exists(RepairTags.PROGRESS))
            assertTrue(step.name, exists(RepairTags.step(step)))
            assertTrue(step.name, exists(RepairTags.PROGRESS_INDICATOR))
            assertEquals(step.name, step == RepairStep.REINSTALLING, exists(RepairTags.CANCEL))
            assertFalse(step.name, exists(RepairTags.LINES))
            assertFalse(step.name, exists(RepairTags.REF))
        }
        state = RepairState.Running(RepairStep.REINSTALLING, source, listOf("Cloning into 'SillyBunny'...", "Receiving objects: 10%"))
        assertTrue(exists(RepairTags.LINES))
        assertFalse(exists(RepairTags.CANCELLING))
        // The branch being installed is shown next to its label.
        state = RepairState.Running(RepairStep.REINSTALLING, source, emptyList(), ref = "feature-x")
        compose.waitForIdle()
        compose.onNodeWithTag(RepairTags.REF).assert(hasAnyDescendant(hasText("feature-x")))
        assertTrue(calls.isEmpty())
    }

    @Test
    fun systemBackNeverCancelsARunningRepair() {
        show()
        for (step in RepairStep.entries) {
            state = RepairState.Running(step, source, listOf("line"))
            back()
            assertTrue(step.name, exists(RepairTags.step(step)))
        }
        assertFalse(exists(RepairTags.CANCEL_DIALOG))
        assertTrue(calls.isEmpty())
    }

    @Test
    fun cancelSitsBehindAConfirmation() {
        state = RepairState.Running(RepairStep.REINSTALLING, source, listOf("Cloning into 'SillyBunny'..."))
        show()
        click(RepairTags.CANCEL)
        assertTrue(exists(RepairTags.CANCEL_DIALOG))
        assertTrue(calls.isEmpty())
        clickInDialog(RepairTags.CANCEL_DISMISS)
        assertFalse(exists(RepairTags.CANCEL_DIALOG))
        assertTrue(calls.isEmpty())

        click(RepairTags.CANCEL)
        clickInDialog(RepairTags.CANCEL_CONFIRM)
        assertEquals(listOf("cancel"), calls)
        assertFalse(exists(RepairTags.CANCEL_DIALOG))

        state = RepairState.Running(RepairStep.REINSTALLING, source, listOf("Terminated"), cancelling = true)
        assertTrue(exists(RepairTags.CANCELLING))
        assertFalse(exists(RepairTags.CANCEL))
        back()
        assertEquals(listOf("cancel"), calls)
    }

    @Test
    fun anOpenCancelDialogClosesWhenTheReinstallEnds() {
        state = RepairState.Running(RepairStep.REINSTALLING, source, emptyList())
        show()
        click(RepairTags.CANCEL)
        assertTrue(exists(RepairTags.CANCEL_DIALOG))
        state = RepairState.Failed(RepairFailure.INSTALL_FAILED, source, listOf("fatal"), 128, canRetry = true)
        assertFalse(exists(RepairTags.CANCEL_DIALOG))
        assertTrue(exists(RepairTags.FAILED))
        assertTrue(calls.isEmpty())
    }

    @Test
    fun aRefusalExplainsWhyAndLeaves() {
        show()
        for (reason in RepairRefusal.entries) {
            state = RepairState.Refused(reason)
            assertTrue(reason.name, exists(RepairTags.REFUSED))
            assertTrue(reason.name, exists(RepairTags.refusal(reason)))
            assertFalse(reason.name, exists(RepairTags.RETRY))
        }
        click(RepairTags.CLOSE)
        back()
        assertEquals(listOf("close", "close"), calls)
    }

    @Test
    fun aFailureShowsWhereTheDataIsWithRetryAndLogs() {
        state = RepairState.Failed(RepairFailure.INSTALL_FAILED, source, listOf("fatal: early EOF"), 128, canRetry = true)
        show()
        for (tag in listOf(
            RepairTags.FAILED,
            RepairTags.failure(RepairFailure.INSTALL_FAILED),
            RepairTags.EXIT_CODE,
            RepairTags.DATA_LOCATION,
            RepairTags.LINES,
            RepairTags.RETRY,
            RepairTags.VIEW_LOGS,
            RepairTags.SHARE_LOGS,
        )) {
            assertTrue(tag, exists(tag))
        }
        assertFalse(exists(RepairTags.NOTHING_MOVED))
        // No branch known and none offered: no branch rows, no second retry.
        assertFalse(exists(RepairTags.REF))
        assertFalse(exists(RepairTags.DEFAULT_REF))
        assertFalse(exists(RepairTags.RETRY_DEFAULT))
        click(RepairTags.RETRY)
        click(RepairTags.VIEW_LOGS)
        click(RepairTags.SHARE_LOGS)
        click(RepairTags.CLOSE)
        assertEquals(listOf("retry", "viewLogs", "shareLogs", "close"), calls)

        // Nothing moved: no data location, no exit code, no output.
        state = RepairState.Failed(RepairFailure.STOP_TIMEOUT, null, emptyList(), null, canRetry = true)
        assertTrue(exists(RepairTags.NOTHING_MOVED))
        assertFalse(exists(RepairTags.DATA_LOCATION))
        assertFalse(exists(RepairTags.EXIT_CODE))
        assertFalse(exists(RepairTags.LINES))
        assertTrue(exists(RepairTags.RETRY))

        // A folder that is gone cannot be retried; logs stay available.
        state = RepairState.Failed(RepairFailure.SOURCE_MISSING, source, emptyList(), null, canRetry = false)
        assertFalse(exists(RepairTags.RETRY))
        assertTrue(exists(RepairTags.VIEW_LOGS))
        back()
        assertEquals("close", calls.last())

        for (reason in RepairFailure.entries) {
            state = RepairState.Failed(reason, source, emptyList(), 0, canRetry = true)
            assertTrue(reason.name, exists(RepairTags.failure(reason)))
            // Exit code 0 (a finished job without a checkout) is not shown as an error code.
            assertFalse(reason.name, exists(RepairTags.EXIT_CODE))
        }
    }

    @Test
    fun aFailureOnAnotherBranchShowsItAndOffersTheDefaultBranch() {
        state = RepairState.Failed(
            RepairFailure.INSTALL_FAILED,
            source,
            listOf("fatal: Remote branch feature-x not found in upstream origin"),
            128,
            canRetry = true,
            ref = "feature-x",
            fallbackRef = "staging",
        )
        show()
        compose.onNodeWithTag(RepairTags.REF).assert(hasAnyDescendant(hasText("feature-x")))
        compose.onNodeWithTag(RepairTags.DEFAULT_REF).assert(hasAnyDescendant(hasText("staging")))
        assertTrue(exists(RepairTags.RETRY))
        assertTrue(exists(RepairTags.RETRY_DEFAULT))
        click(RepairTags.RETRY_DEFAULT)
        click(RepairTags.RETRY)
        assertEquals(listOf("retryDefault", "retry"), calls)

        // Already on the default branch: it is shown, and no other branch is offered.
        state = RepairState.Failed(RepairFailure.INSTALL_FAILED, source, emptyList(), 1, canRetry = true, ref = "staging")
        compose.waitForIdle()
        compose.onNodeWithTag(RepairTags.REF).assert(hasAnyDescendant(hasText("staging")))
        assertFalse(exists(RepairTags.DEFAULT_REF))
        assertFalse(exists(RepairTags.RETRY_DEFAULT))
        assertEquals(listOf("retryDefault", "retry"), calls)
    }

    @Test
    fun aSuccessKeepsTheFolderAndOffersADeferredServerStart() {
        state = RepairState.Succeeded(source, serverStarted = false, lines = listOf("Done."))
        show()
        assertTrue(exists(RepairTags.SUCCEEDED))
        assertTrue(exists(RepairTags.KEPT_FOLDER))
        assertTrue(exists(RepairTags.SUCCEEDED_FILE_ACCESS))
        assertTrue(exists(RepairTags.SERVER_NOT_STARTED))
        click(RepairTags.START_SERVER)
        assertEquals(listOf("startServer"), calls)

        state = RepairState.Succeeded(source, serverStarted = true, lines = emptyList())
        assertFalse(exists(RepairTags.START_SERVER))
        assertFalse(exists(RepairTags.SERVER_NOT_STARTED))
        click(RepairTags.DONE)
        assertEquals(listOf("startServer", "close"), calls)
    }

    @Test
    fun theScreenDrivesARealControllerFromConfirmationToSuccess() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val paths = RuntimePaths(
            File(temporary.root, "files").apply { mkdirs() },
            File(temporary.root, "cache").apply { mkdirs() },
            File(temporary.root, "lib"),
        )
        TestCheckouts.create(paths.checkoutDir, config = "dataRoot: ./data\n", tracking = "release")
        val host = FakeRepairServerHost()
        val maintenance = FakeMaintenance()
        val controller = RepairController(
            context = context,
            paths = paths,
            serverHost = host,
            maintenance = maintenance,
            installScript = File(temporary.root, "install.sh"),
            isVisible = { true },
            store = RepairStore(File(temporary.root, "no_backup/repair-record.json")),
            defaultRef = "staging",
            dispatcher = Dispatchers.Unconfined,
        )
        var closes = 0
        compose.setContent {
            RepairScreen(controller, onClose = { closes++ }, onViewLogs = {}, onShareLogs = {})
        }
        click(RepairTags.CONFIRM_ACTION)
        assertTrue(exists(RepairTags.step(RepairStep.REINSTALLING)))
        assertTrue(exists(RepairTags.CANCEL))
        val moved = BrokenCheckouts.list(paths).single()

        compose.runOnUiThread {
            TestCheckouts.installed(paths.checkoutDir)
            host.finish(0, "Done.")
        }
        assertTrue(exists(RepairTags.SUCCEEDED))
        assertTrue(exists(RepairTags.KEPT_FOLDER))
        assertEquals(RepairState.Succeeded(moved, serverStarted = true, lines = listOf("Done.")), controller.state.value)
        assertEquals(1, host.startCount)
        assertFalse(maintenance.inMaintenance)

        click(RepairTags.DONE)
        assertEquals(1, closes)
        assertEquals(RepairState.Idle, controller.state.value)
        assertTrue(exists(RepairTags.CONFIRM))
    }
}
