package io.github.sillybunnyteam.sillybunny.firstrun

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.os.Build
import android.os.StatFs
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import io.github.sillybunnyteam.sillybunny.firstrun.FirstRunDeviceFixture.Companion.eventually
import java.util.regex.Pattern
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeFalse
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TestName
import org.junit.runner.RunWith

/**
 * The real platform pieces: the `POST_NOTIFICATIONS` dialog on API 33+, the battery-exemption screens, and the
 * storage and network probes.
 *
 * Each notification test needs a fresh permission, so run them one at a time and reset from the host first:
 * `pm revoke <package> android.permission.POST_NOTIFICATIONS` and
 * `pm clear-permission-flags <package> android.permission.POST_NOTIFICATIONS user-set user-fixed`.
 * Without the reset they are skipped by their assumption.
 */
@RunWith(AndroidJUnit4::class)
class FirstRunSystemDialogsTest {
    @get:Rule
    val name = TestName()

    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val device = UiDevice.getInstance(instrumentation)
    private lateinit var fixture: FirstRunDeviceFixture
    private var screen: FirstRunScreenHost? = null

    @Before
    fun setUp() {
        fixture = FirstRunDeviceFixture(context, name.methodName)
        fixture.mode("success")
        fixture.release()
    }

    @After
    fun tearDown() {
        try {
            screen?.close()
        } finally {
            fixture.close()
        }
    }

    /** The real notification and battery adapters; fakes for the probes, the layout and the server host. */
    private fun launch(): FirstRunScreenHost =
        FirstRunScreenHost(fixture.dependencies(realPermissions = true)).launch().also { screen = it }

    private fun FirstRunScreenHost.state() = controller.state.value

    private fun notificationsGranted(): Boolean =
        context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    private fun assumeFreshNotificationPermission() {
        assumeTrue("POST_NOTIFICATIONS is a runtime permission from API 33", Build.VERSION.SDK_INT >= 33)
        assumeFalse("Reset POST_NOTIFICATIONS from the host before this test", notificationsGranted())
    }

    /**
     * Taps a button of the permission controller's dialog by its resource ID. A repeated request can show the
     * deny button as `permission_deny_and_dont_ask_again_button`.
     */
    private fun answerPermissionDialog(allow: Boolean) {
        val id = if (allow) "permission_allow_button" else "permission_deny(_and_dont_ask_again)?_button"
        val selector = By.res(Pattern.compile(".*:id/$id"))
        val button = device.wait(Until.findObject(selector), 15_000)
        assertNotNull("Permission dialog button $id", button)
        button.click()
        assertTrue(device.wait(Until.gone(selector), 10_000))
    }

    @Test
    fun theNotificationDialogGrants() {
        assumeFreshNotificationPermission()
        val screen = launch()
        eventually { screen.state().stage == FirstRunStage.Welcome }
        assertEquals(NotificationStatus.NOT_ASKED, screen.state().notifications)
        FirstRunUi.click("firstrun_notifications_allow")
        answerPermissionDialog(allow = true)
        eventually { screen.state().notifications == NotificationStatus.GRANTED }
        assertTrue(notificationsGranted())
        assertTrue(FirstRunUi.shown("firstrun_notifications_granted"))
        assertEquals(FirstRunStage.Welcome, screen.state().stage)
        assertTrue(fixture.host.jobs.isEmpty())
    }

    @Test
    fun continueAsksFirstAndADenialNeverBlocksTheInstall() {
        assumeFreshNotificationPermission()
        val screen = launch()
        FirstRunUi.click("firstrun_continue")
        answerPermissionDialog(allow = false)
        eventually(20_000) { screen.state().stage == FirstRunStage.Installed }
        assertEquals(NotificationStatus.DENIED, screen.state().notifications)
        assertFalse(notificationsGranted())
        assertEquals(1, fixture.host.jobs.size)
        eventually { screen.installed.get() == 1 }
    }

    @Test
    fun aSecondDenialIsPermanent() {
        assumeFreshNotificationPermission()
        val screen = launch()
        FirstRunUi.click("firstrun_notifications_allow")
        answerPermissionDialog(allow = false)
        eventually { screen.state().notifications == NotificationStatus.DENIED }
        assertTrue(FirstRunUi.shown("firstrun_notifications_denied"))
        FirstRunUi.click("firstrun_notifications_allow")
        answerPermissionDialog(allow = false)
        eventually { screen.state().notifications == NotificationStatus.PERMANENTLY_DENIED }
        assertTrue(FirstRunUi.shown("firstrun_notifications_blocked"))
        assertFalse(FirstRunUi.present("firstrun_notifications_allow"))

        // Continue no longer asks, and the install still runs.
        FirstRunUi.click("firstrun_continue")
        eventually(20_000) { screen.state().stage == FirstRunStage.Installed }
        assertFalse(notificationsGranted())
        assertEquals(NotificationStatus.PERMANENTLY_DENIED, screen.state().notifications)
    }

    @Test
    fun belowApi33NothingIsAskedAndContinueInstalls() {
        assumeTrue("POST_NOTIFICATIONS needs no request below API 33", Build.VERSION.SDK_INT < 33)
        val screen = launch()
        eventually { screen.state().stage == FirstRunStage.Welcome }
        assertEquals(NotificationStatus.NOT_REQUIRED, screen.state().notifications)
        assertTrue(FirstRunUi.shown("firstrun_battery"))
        assertFalse(FirstRunUi.present("firstrun_notifications"))
        FirstRunUi.click("firstrun_continue")
        eventually(20_000) { screen.installed.get() == 1 }
        assertFalse(device.hasObject(By.res(Pattern.compile(".*:id/permission_allow_button"))))
    }

    @Test
    fun theBatteryExemptionDialogOpensAndBackCountsAsASkip() {
        val screen = launch()
        eventually { screen.state().stage == FirstRunStage.Welcome }
        assertNotEquals(BatteryStatus.EXEMPT, screen.state().battery)
        FirstRunUi.click("firstrun_battery_allow")
        val settings = device.wait(Until.findObject(By.pkg(SETTINGS)), 15_000)
        assertNotNull("The battery-exemption dialog", settings)
        device.pressBack()
        eventually(15_000) { screen.state().battery == BatteryStatus.SKIPPED }
        assertFalse(AndroidBatteryExemption(context).isExempt())
        assertTrue(FirstRunUi.shown("firstrun_battery_skipped"))
        assertTrue(FirstRunUi.shown("firstrun_continue"))
    }

    @Test
    fun bothBatteryExemptionScreensResolve() {
        // Started from a visible activity, as the Welcome screen does.
        val screen = launch()
        eventually { screen.state().stage == FirstRunStage.Welcome }
        val candidates = BatteryExemptionIntents.candidates(context.packageName)
        val opened = candidates.map { intent ->
            context.startActivity(Intent(intent).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            val shown = device.wait(Until.hasObject(By.pkg(SETTINGS)), 15_000) == true
            device.pressBack()
            device.wait(Until.gone(By.pkg(SETTINGS)), 10_000)
            Log.i(TAG, "${intent.action} opened=$shown")
            intent.action to shown
        }
        assertEquals(candidates.map { it.action to true }, opened)
    }

    @Test
    fun theRealStorageAndNetworkProbesAnswer() {
        val available = StatFsStorageProbe(context.filesDir).availableBytes()
        val total = StatFs(context.filesDir.path).totalBytes
        assertTrue("available $available of $total", available in 1..total)

        val manager = context.getSystemService(ConnectivityManager::class.java)
        val capabilities = manager.activeNetwork?.let { manager.getNetworkCapabilities(it) }
        val expected = capabilities?.let { ConnectivityNetworkProbe.classify(it) } ?: NetworkKind.NONE
        val kind = ConnectivityNetworkProbe(context).current()
        Log.i(TAG, "storage available=$available total=$total network=$kind capabilities=$capabilities")
        assertEquals(expected, kind)
    }

    private companion object {
        const val TAG = "FirstRunDevice"

        /** The battery-exemption dialog and list belong to the Settings app. */
        val SETTINGS: Pattern = Pattern.compile("com\\.(google\\.)?android\\.settings")
    }
}
