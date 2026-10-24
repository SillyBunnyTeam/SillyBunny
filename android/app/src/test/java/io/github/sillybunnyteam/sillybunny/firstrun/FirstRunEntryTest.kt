package io.github.sillybunnyteam.sillybunny.firstrun

import android.Manifest
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.os.Looper
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.LocalActivityResultRegistryOwner
import androidx.activity.result.ActivityResult
import androidx.activity.result.ActivityResultRegistry
import androidx.activity.result.ActivityResultRegistryOwner
import androidx.activity.result.contract.ActivityResultContract
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.core.app.ActivityOptionsCompat
import androidx.lifecycle.Lifecycle
import io.github.sillybunnyteam.sillybunny.server.SetupState
import kotlinx.coroutines.Dispatchers
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** [FirstRunScreen] with a real controller: lifecycle, system back, the system requests and the callbacks. */
// Espresso 3.5.0, which Compose UI tests pull in, reflects InputManager.getInstance(); Robolectric's
// API 37 image no longer has it, so the Compose tests run on API 36. The controller tests use API 37.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class FirstRunEntryTest {
    @get:Rule(order = 0)
    val temporary = TemporaryFolder()

    @get:Rule(order = 1)
    val compose = createAndroidComposeRule<ComponentActivity>()

    private lateinit var fixture: FirstRunFixture
    private val registry = FakeResultRegistry()
    private var installedCalls = 0
    private var repairCalls = 0
    private var shareCalls = 0

    @Before
    fun setUp() {
        fixture = FirstRunFixture(temporary.root)
    }

    private fun start(): FirstRunController {
        val dependencies = fixture.dependencies(Dispatchers.Main)
        lateinit var controller: FirstRunController
        compose.runOnUiThread { controller = FirstRun.controller(compose.activity, dependencies) }
        val owner = object : ActivityResultRegistryOwner {
            override val activityResultRegistry: ActivityResultRegistry = registry
        }
        compose.setContent {
            CompositionLocalProvider(LocalActivityResultRegistryOwner provides owner) {
                FirstRunScreen(
                    controller = controller,
                    onInstalled = { installedCalls++ },
                    onRepair = { repairCalls++ },
                    onShareLogs = { shareCalls++ },
                )
            }
        }
        compose.waitForIdle()
        return controller
    }

    private fun tap(tag: String) {
        compose.onNodeWithTag(tag).performScrollTo().performClick()
        compose.waitForIdle()
    }

    private fun answer(result: Any?) {
        compose.runOnUiThread { registry.answer(result) }
        compose.waitForIdle()
    }

    private fun moveTo(state: Lifecycle.State) {
        compose.activityRule.scenario.moveToState(state)
        shadowOf(Looper.getMainLooper()).idle()
    }

    @Test
    fun visibilityFollowsTheActivityLifecycle() {
        val controller = start()
        assertTrue(controller.state.value.visible)
        moveTo(Lifecycle.State.CREATED)
        assertFalse(controller.state.value.visible)
        moveTo(Lifecycle.State.RESUMED)
        assertTrue(controller.state.value.visible)
    }

    @Test
    fun anInstallReadyWhileStoppedStartsOnTheNextStart() {
        fixture.notifications.required = false
        fixture.network = NetworkKind.METERED
        val controller = start()
        tap("firstrun_continue")
        compose.onNodeWithTag("firstrun_metered").assertExists()

        moveTo(Lifecycle.State.CREATED)
        compose.runOnUiThread { controller.continueOnMeteredNetwork() }
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(FirstRunStage.WaitingForForeground, controller.state.value.stage)
        assertTrue(fixture.host.jobs.isEmpty())

        moveTo(Lifecycle.State.RESUMED)
        compose.waitForIdle()
        assertTrue(controller.state.value.stage is FirstRunStage.Installing)
        assertEquals(1, fixture.host.jobs.size)
        compose.onNodeWithTag("firstrun_installing").assertExists()
    }

    @Test
    fun backDuringAnInstallLeavesTheAppWithoutCancelling() {
        fixture.notifications.required = false
        start()
        tap("firstrun_continue")
        compose.onNodeWithTag("firstrun_installing").assertExists()
        assertFalse(compose.activity.onBackPressedDispatcher.hasEnabledCallbacks())
        compose.runOnUiThread { compose.activity.onBackPressedDispatcher.onBackPressed() }
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(0, fixture.host.cancelCount)
        assertTrue(fixture.host.setup.value is SetupState.Running)
    }

    @Test
    fun backClosesTheLogViewFirst() {
        fixture.notifications.required = false
        fixture.network = NetworkKind.NONE
        val controller = start()
        tap("firstrun_continue")
        tap("firstrun_view_logs")
        compose.onNodeWithTag("firstrun_logs").assertExists()
        assertTrue(compose.activity.onBackPressedDispatcher.hasEnabledCallbacks())

        compose.runOnUiThread { compose.activity.onBackPressedDispatcher.onBackPressed() }
        compose.waitForIdle()
        compose.onNodeWithTag("firstrun_logs").assertDoesNotExist()
        compose.onNodeWithTag("firstrun_error_offline").assertExists()
        assertTrue(controller.state.value.stage is FirstRunStage.Failed)
        assertFalse(compose.activity.onBackPressedDispatcher.hasEnabledCallbacks())
    }

    @Test
    fun successIsReportedOnceTheActivityIsStarted() {
        fixture.notifications.required = false
        val controller = start()
        tap("firstrun_continue")
        val job = fixture.host.jobs.single()

        moveTo(Lifecycle.State.CREATED)
        fixture.writeInstalledCheckout()
        compose.runOnUiThread { fixture.host.setup.value = SetupState.Finished(job, 0, listOf("done")) }
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(FirstRunStage.Installed, controller.state.value.stage)
        assertEquals(0, installedCalls)

        moveTo(Lifecycle.State.RESUMED)
        compose.waitForIdle()
        assertEquals(1, installedCalls)
    }

    @Test
    fun continueAsksForNotificationsOnceAndNeverWaitsOnTheAnswer() {
        val controller = start()
        tap("firstrun_continue")
        assertEquals(listOf<Any?>(Manifest.permission.POST_NOTIFICATIONS), registry.inputs)
        assertEquals(FirstRunStage.Welcome, controller.state.value.stage)

        answer(false)
        assertEquals(NotificationStatus.DENIED, controller.state.value.notifications)
        assertTrue(controller.state.value.stage is FirstRunStage.Installing)
        assertEquals(1, registry.inputs.size)
    }

    @Test
    fun theAllowButtonShowsTheAnswerAndContinueDoesNotAskAgain() {
        val controller = start()
        tap("firstrun_notifications_allow")
        assertEquals(listOf<Any?>(Manifest.permission.POST_NOTIFICATIONS), registry.inputs)
        fixture.notifications.granted = true
        answer(true)
        compose.onNodeWithTag("firstrun_notifications_granted").assertExists()
        assertEquals(FirstRunStage.Welcome, controller.state.value.stage)

        tap("firstrun_continue")
        assertEquals(1, registry.inputs.size)
        assertTrue(controller.state.value.stage is FirstRunStage.Installing)
    }

    @Test
    fun theExemptionDialogIsTriedFirst() {
        start()
        tap("firstrun_battery_allow")
        val intent = registry.inputs.single() as Intent
        assertEquals(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, intent.action)
        assertEquals("package:${compose.activity.packageName}", intent.dataString)
        fixture.exempt = true
        answer(ActivityResult(Activity.RESULT_OK, null))
        compose.onNodeWithTag("firstrun_battery_exempt").assertExists()
    }

    @Test
    fun theSettingsListIsTheFallbackAndADeclineCountsAsASkip() {
        registry.unavailable = { (it as? Intent)?.action == Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS }
        start()
        tap("firstrun_battery_allow")
        assertEquals(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS, (registry.inputs.single() as Intent).action)
        answer(ActivityResult(Activity.RESULT_CANCELED, null))
        compose.onNodeWithTag("firstrun_battery_skipped").assertExists()
    }

    @Test
    fun noExemptionScreenCountsAsASkip() {
        registry.unavailable = { it is Intent }
        start()
        tap("firstrun_battery_allow")
        assertTrue(registry.inputs.isEmpty())
        compose.onNodeWithTag("firstrun_battery_skipped").assertExists()
        compose.onNodeWithTag("firstrun_continue").assertExists()
    }

    @Test
    fun repairAndShareReachTheCaller() {
        fixture.writePartialCheckout()
        start()
        compose.onNodeWithTag("firstrun_error_interrupted").assertExists()
        tap("firstrun_repair")
        tap("firstrun_share_logs")
        assertEquals(1, repairCalls)
        assertEquals(1, shareCalls)
        assertEquals(0, installedCalls)
    }

    /** Records launches instead of starting anything; [answer] delivers the oldest pending result. */
    private class FakeResultRegistry : ActivityResultRegistry() {
        val inputs = mutableListOf<Any?>()
        private val pending = mutableListOf<Int>()
        var unavailable: (Any?) -> Boolean = { false }

        override fun <I, O> onLaunch(
            requestCode: Int,
            contract: ActivityResultContract<I, O>,
            input: I,
            options: ActivityOptionsCompat?,
        ) {
            if (unavailable(input)) throw ActivityNotFoundException()
            inputs += input
            pending += requestCode
        }

        fun answer(result: Any?) {
            dispatchResult(pending.removeAt(0), result)
        }
    }
}
