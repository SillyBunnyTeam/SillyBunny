package io.github.sillybunnyteam.sillybunny.firstrun

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Every screen of the flow, rendered from a state and checked by test tags only. */
// Espresso 3.5.0, which Compose UI tests pull in, reflects InputManager.getInstance(); Robolectric's
// API 37 image no longer has it, so the Compose tests run on API 36. The controller tests use API 37.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class FirstRunScreensTest {
    @get:Rule
    val compose = createComposeRule()

    private val actions = RecordingActions()
    private var state by mutableStateOf(FirstRunUiState())

    private fun show(initial: FirstRunUiState) {
        state = initial
        compose.setContent { FirstRunTheme { FirstRunContent(state, actions) } }
    }

    private fun update(next: FirstRunUiState) {
        state = next
        compose.waitForIdle()
    }

    private fun exists(tag: String) {
        compose.onNodeWithTag(tag).assertExists()
    }

    private fun absent(tag: String) {
        compose.onNodeWithTag(tag).assertDoesNotExist()
    }

    /** Taps a node inside a scrolling screen. */
    private fun tap(tag: String) {
        compose.onNodeWithTag(tag).performScrollTo().performClick()
    }

    private fun failed(failure: FirstRunFailure, partial: Boolean = false, lines: List<String> = emptyList()) =
        FirstRunUiState(stage = FirstRunStage.Failed(failure, lines, partialCheckout = partial))

    @Test
    fun waitingStagesShowAProgressScreen() {
        show(FirstRunUiState())
        val stages = listOf(
            FirstRunStage.Loading to "firstrun_loading",
            FirstRunStage.Checking to "firstrun_checking",
            FirstRunStage.Preparing to "firstrun_preparing",
            FirstRunStage.WaitingForForeground to "firstrun_waiting",
            FirstRunStage.Installed to "firstrun_installed",
        )
        for ((stage, tag) in stages) {
            update(FirstRunUiState(stage = stage))
            compose.onNodeWithTag(tag).assertIsDisplayed()
            exists("firstrun_progress")
            absent("firstrun_continue")
        }
    }

    @Test
    fun welcomeOffersBothRequestsAndContinues() {
        show(FirstRunUiState(stage = FirstRunStage.Welcome))
        exists("firstrun_welcome")
        exists("firstrun_notifications")
        absent("firstrun_notifications_denied")
        tap("firstrun_notifications_allow")
        tap("firstrun_battery_allow")
        tap("firstrun_battery_skip")
        tap("firstrun_continue")
        assertEquals(
            listOf("requestNotifications", "requestBatteryExemption", "skipBatteryExemption", "continueFromWelcome"),
            actions.calls,
        )
    }

    @Test
    fun welcomeShowsEveryNotificationAnswer() {
        val welcome = FirstRunUiState(stage = FirstRunStage.Welcome)
        show(welcome.copy(notifications = NotificationStatus.DENIED))
        exists("firstrun_notifications_denied")
        exists("firstrun_notifications_allow")

        update(welcome.copy(notifications = NotificationStatus.PERMANENTLY_DENIED))
        exists("firstrun_notifications_blocked")
        absent("firstrun_notifications_allow")

        update(welcome.copy(notifications = NotificationStatus.GRANTED))
        exists("firstrun_notifications_granted")
        absent("firstrun_notifications_allow")

        update(welcome.copy(notifications = NotificationStatus.NOT_REQUIRED))
        absent("firstrun_notifications")
        exists("firstrun_battery")
        tap("firstrun_continue")
        assertEquals(listOf("continueFromWelcome"), actions.calls)
    }

    @Test
    fun welcomeShowsEveryBatteryAnswer() {
        val welcome = FirstRunUiState(stage = FirstRunStage.Welcome)
        show(welcome.copy(battery = BatteryStatus.EXEMPT))
        exists("firstrun_battery_exempt")
        absent("firstrun_battery_allow")
        absent("firstrun_battery_skip")

        update(welcome.copy(battery = BatteryStatus.SKIPPED))
        exists("firstrun_battery_skipped")
        absent("firstrun_battery_allow")
        absent("firstrun_battery_skip")
        exists("firstrun_continue")
    }

    @Test
    fun meteredAndCellularWarningsShowTheEstimateAndLetTheUserContinue() {
        show(FirstRunUiState(stage = FirstRunStage.MeteredWarning(cellular = false)))
        exists("firstrun_metered")
        absent("firstrun_cellular")
        exists("firstrun_download_estimate")
        exists("firstrun_download_breakdown")
        tap("firstrun_metered_continue")
        tap("firstrun_metered_recheck")
        assertEquals(listOf("continueOnMeteredNetwork", "retry"), actions.calls)

        update(FirstRunUiState(stage = FirstRunStage.MeteredWarning(cellular = true)))
        exists("firstrun_cellular")
        absent("firstrun_metered")
        exists("firstrun_download_estimate")
    }

    @Test
    fun installingShowsTheLatestLineAndACollapsibleRawLog() {
        show(FirstRunUiState(stage = FirstRunStage.Installing(listOf("Cloning", "Receiving objects"), cancelling = false)))
        exists("firstrun_installing")
        exists("firstrun_install_progress")
        exists("firstrun_install_latest")
        absent("firstrun_raw_log")
        tap("firstrun_log_toggle")
        exists("firstrun_raw_log")
        tap("firstrun_log_toggle")
        absent("firstrun_raw_log")

        tap("firstrun_cancel")
        assertEquals(listOf("requestCancel"), actions.calls)

        update(FirstRunUiState(stage = FirstRunStage.Installing(emptyList(), cancelling = true)))
        absent("firstrun_install_latest")
        absent("firstrun_cancel")
        exists("firstrun_cancelling")
    }

    @Test
    fun cancelAsksForAConfirmation() {
        val installing = FirstRunUiState(stage = FirstRunStage.Installing(emptyList(), cancelling = false))
        show(installing.copy(confirmingCancel = true))
        exists("firstrun_cancel_dialog")
        compose.onNodeWithTag("firstrun_cancel_dismiss").performClick()
        compose.onNodeWithTag("firstrun_cancel_confirm").performClick()
        assertEquals(listOf("dismissCancel", "confirmCancel"), actions.calls)

        update(installing)
        absent("firstrun_cancel_dialog")
    }

    @Test
    fun busyOffersARetry() {
        show(FirstRunUiState(stage = FirstRunStage.Busy))
        exists("firstrun_busy")
        tap("firstrun_retry")
        assertEquals(listOf("retry"), actions.calls)
    }

    @Test
    fun everyFailureHasItsMessageAndTheSameActions() {
        val failures = listOf(
            FirstRunFailure.LowStorage(1_000, FirstRunStorage.REQUIRED_FREE_BYTES) to "firstrun_error_storage",
            FirstRunFailure.Offline to "firstrun_error_offline",
            FirstRunFailure.Layout("reason") to "firstrun_error_layout",
            FirstRunFailure.Install(1) to "firstrun_error_install",
            FirstRunFailure.Cancelled to "firstrun_error_cancelled",
            FirstRunFailure.Interrupted to "firstrun_error_interrupted",
            FirstRunFailure.NoCheckout to "firstrun_error_no_checkout",
            FirstRunFailure.MoveAside("reason") to "firstrun_error_move_aside",
            FirstRunFailure.Unexpected("reason") to "firstrun_error_unexpected",
        )
        show(FirstRunUiState())
        for ((failure, tag) in failures) {
            update(failed(failure))
            exists("firstrun_error")
            exists(tag)
            for ((_, other) in failures) {
                if (other != tag) absent(other)
            }
            exists("firstrun_retry")
            exists("firstrun_view_logs")
            exists("firstrun_share_logs")
            exists("firstrun_logs_warning")
            absent("firstrun_repair")
            absent("firstrun_error_lines")
        }
    }

    @Test
    fun theErrorScreenActionsAndRepairOnlyForAPartialCheckout() {
        show(failed(FirstRunFailure.Install(128), partial = true, lines = listOf("fatal: early EOF")))
        exists("firstrun_error_lines")
        tap("firstrun_retry")
        tap("firstrun_view_logs")
        tap("firstrun_share_logs")
        tap("firstrun_repair")
        assertEquals(listOf("retry", "openLogs", "shareLogs", "repair"), actions.calls)

        update(failed(FirstRunFailure.Install(128), partial = false))
        absent("firstrun_repair")
    }

    @Test
    fun theLogViewShowsTheLastLinesThenTheSetupLog() {
        val error = failed(FirstRunFailure.Install(1), lines = listOf("one"))
        show(error.copy(logs = FirstRunLogView(listOf("one"), setupLog = null)))
        exists("firstrun_logs")
        absent("firstrun_error")
        exists("firstrun_logs_sensitive")
        exists("firstrun_logs_last_lines")
        absent("firstrun_logs_last_lines_empty")
        exists("firstrun_logs_setup_log")
        exists("firstrun_logs_loading")

        update(error.copy(logs = FirstRunLogView(emptyList(), setupLog = emptyList())))
        exists("firstrun_logs_last_lines_empty")
        exists("firstrun_logs_setup_log_empty")
        absent("firstrun_logs_loading")

        update(error.copy(logs = FirstRunLogView(listOf("one"), setupLog = listOf("setup"))))
        absent("firstrun_logs_setup_log_empty")
        absent("firstrun_logs_loading")

        compose.onNodeWithTag("firstrun_logs_close").performClick()
        assertEquals(listOf("closeLogs"), actions.calls)
    }

    /** Records each action by name. */
    private class RecordingActions : FirstRunActions {
        val calls = mutableListOf<String>()

        override fun requestNotifications() {
            calls += "requestNotifications"
        }

        override fun requestBatteryExemption() {
            calls += "requestBatteryExemption"
        }

        override fun skipBatteryExemption() {
            calls += "skipBatteryExemption"
        }

        override fun continueFromWelcome() {
            calls += "continueFromWelcome"
        }

        override fun continueOnMeteredNetwork() {
            calls += "continueOnMeteredNetwork"
        }

        override fun retry() {
            calls += "retry"
        }

        override fun requestCancel() {
            calls += "requestCancel"
        }

        override fun confirmCancel() {
            calls += "confirmCancel"
        }

        override fun dismissCancel() {
            calls += "dismissCancel"
        }

        override fun openLogs() {
            calls += "openLogs"
        }

        override fun closeLogs() {
            calls += "closeLogs"
        }

        override fun shareLogs() {
            calls += "shareLogs"
        }

        override fun repair() {
            calls += "repair"
        }
    }
}
