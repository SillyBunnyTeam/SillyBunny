package io.github.sillybunnyteam.sillybunny.smoke

import android.os.Bundle
import android.os.SystemClock
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import io.github.sillybunnyteam.sillybunny.repair.RepairTags
import io.github.sillybunnyteam.sillybunny.server.ServerManager
import io.github.sillybunnyteam.sillybunny.server.ServerState
import io.github.sillybunnyteam.sillybunny.settings.SettingsTags
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The native screens and system dialogs of the Android smoke (plan §7.1). `tests/android-smoke/run-smoke.js`
 * runs one method at a time with `am instrument -e class <this>#<method> -e smokeRun true` and its `-e`
 * arguments; the host checks the results (files, server state, versionCode) itself.
 *
 * Every method skips itself without `smokeRun`, so a plain androidTest run never installs, repairs or
 * updates anything.
 */
@RunWith(AndroidJUnit4::class)
class SmokeUiTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val arguments: Bundle = InstrumentationRegistry.getArguments()
    private val device = UiDevice.getInstance(instrumentation)
    private val ui = SmokeUi(device, instrumentation.targetContext)

    @Before
    fun onlyInSmokeRuns() {
        assumeTrue("run by tests/android-smoke/run-smoke.js", arguments.getString("smokeRun") == "true")
    }

    /**
     * Step 1: Welcome (notifications allowed, battery exemption skipped), the metered-network warning when
     * [expectMetered][flag], the clone, and the first start, whose `start.sh` runs `npm ci` and `init` before the
     * server: the step ends when that server is Running. Ending earlier would let `am instrument` stop the app in
     * the middle of the dependency install.
     */
    @Test
    fun firstRun() {
        val expectMetered = flag("expectMetered")
        val deadline = deadline(seconds("timeoutSeconds", 40 * 60L))
        val server = ServerManager.get(instrumentation.targetContext)
        ui.launchApp()
        assertNotNull("no first-run screen", ui.waitForAny(FIRST_RUN_SCREENS, SCREEN_MILLIS))
        if (ui.present("firstrun_welcome")) {
            if (ui.clickIfShown("firstrun_notifications_allow")) ui.allowPermission(PERMISSION_MILLIS)
            ui.clickIfShown("firstrun_battery_skip")
            ui.click("firstrun_continue")
        }
        var continued = SystemClock.uptimeMillis()
        var sawMetered = false
        while (SystemClock.uptimeMillis() < deadline) {
            // On API 33+ Continue asks for notifications when Welcome did not, and so can the app before its first start.
            ui.allowPermission()
            val state = server.state.value
            when {
                state is ServerState.Running -> return assertMetered(expectMetered, sawMetered)
                state is ServerState.Failed -> fail("the first start failed: ${state.lastLines.takeLast(FAILED_LINES)}")
                ui.present("firstrun_error") -> fail("first run failed: ${ui.tagsMatching("firstrun_error_.*")}")
                ui.present("firstrun_metered") || ui.present("firstrun_cellular") -> {
                    sawMetered = true
                    ui.clickIfShown("firstrun_metered_continue")
                }
                ui.present("firstrun_busy") -> {
                    ui.clickIfShown("firstrun_retry")
                    SystemClock.sleep(RETRY_MILLIS)
                }
                ui.present("firstrun_welcome") -> if (SystemClock.uptimeMillis() - continued >= RETRY_MILLIS) {
                    ui.clickIfShown("firstrun_continue")
                    continued = SystemClock.uptimeMillis()
                }
            }
            SystemClock.sleep(POLL_MILLIS)
        }
        val last = server.state.value::class.simpleName
        fail("the first start did not reach Running within the timeout: $last; tags ${ui.tagsMatching("[a-z]+_.*")}")
    }

    /** Step 5: the min-app-version gate's prompt for an APK update, dismissed with Later. */
    @Test
    fun expectUpdatePrompt() {
        ui.launchApp()
        assertNotNull("update_required", ui.find("update_required", seconds("timeoutSeconds", 120L) * 1_000))
        ui.click("update_later")
        assertTrue("update_required stays", ui.gone("update_required", DIALOG_MILLIS))
    }

    /**
     * Step 6: accepts the offered APK update, from the launch check or Settings' Check now, then the
     * system installer. Installing replaces this process, so a passing run ends with the instrumentation's
     * process crash, which the host expects; returning means the update never happened.
     */
    @Test
    fun acceptAppUpdate() {
        val deadline = deadline(seconds("timeoutSeconds", 600L))
        ui.launchApp()
        if (ui.find("update_confirm", OFFER_MILLIS) == null) {
            ui.click(argument("openSettingsTag"), SCREEN_MILLIS)
            ui.click(SettingsTags.CHECK_NOW, SCREEN_MILLIS)
            assertNotNull("no update offered", ui.find("update_confirm", OFFER_MILLIS))
        }
        ui.click("update_confirm")
        while (SystemClock.uptimeMillis() < deadline) {
            if (ui.present("update_error")) fail("the update failed")
            // run-smoke.js grants the install-source access first; this covers a device where it could not.
            if (ui.tap(ui.unknownSourcesSwitch())) ui.pressBack()
            ui.tap(ui.installerButton())
            SystemClock.sleep(POLL_MILLIS)
        }
        fail("the update was not installed within the timeout")
    }

    /** Step 10: the error screen after the restart policy gave up, with Restart and Share logs. */
    @Test
    fun errorScreen() {
        val restart = argument("restartTag")
        ui.launchApp()
        assertNotNull(restart, ui.find(restart, SCREEN_MILLIS))
        assertNotNull(argument("shareTag"), ui.find(argument("shareTag")))
        if (flag("pressRestart")) {
            ui.click(restart)
            assertTrue("$restart stays", ui.gone(restart, SCREEN_MILLIS))
        }
    }

    /**
     * Step 12: Repair from the first-run screen (a broken checkout offers it there) or from Settings,
     * confirmed, until it succeeds; then starts the server.
     */
    @Test
    fun repair() {
        val openSettings = argument("openSettingsTag")
        val deadline = deadline(seconds("timeoutSeconds", 40 * 60L))
        ui.launchApp()
        val entry = listOf("firstrun_error", "firstrun_repair", RepairTags.CONFIRM, openSettings)
        when (ui.waitForAny(entry, SCREEN_MILLIS)) {
            "firstrun_error", "firstrun_repair" -> ui.click("firstrun_repair", SCREEN_MILLIS)
            RepairTags.CONFIRM -> Unit
            openSettings -> {
                ui.click(openSettings)
                ui.click(SettingsTags.REPAIR, SCREEN_MILLIS)
            }
            else -> fail("no way to Repair on screen")
        }
        ui.click(RepairTags.CONFIRM_ACTION, SCREEN_MILLIS)
        while (SystemClock.uptimeMillis() < deadline) {
            when {
                ui.present(RepairTags.SUCCEEDED) -> {
                    if (!ui.clickIfShown(RepairTags.START_SERVER)) ui.click(RepairTags.DONE)
                    return
                }
                ui.present(RepairTags.FAILED) -> fail("Repair failed")
                ui.present(RepairTags.REFUSED) -> fail("Repair refused")
            }
            SystemClock.sleep(POLL_MILLIS)
        }
        fail("Repair did not finish within the timeout")
    }

    /**
     * The harness's CDP check (`run-smoke.js probe`): a debuggable WebView in the app process, held until
     * the host has attached over `webview_devtools_remote_<pid>` and set the page title to `title`.
     */
    @Test
    fun webViewHost() {
        val title = argument("title")
        val deadline = deadline(seconds("timeoutSeconds", 120L))
        ActivityScenario.launch(ComponentActivity::class.java).use { scenario ->
            lateinit var webView: WebView
            scenario.onActivity { activity ->
                WebView.setWebContentsDebuggingEnabled(true)
                webView = WebView(activity)
                activity.setContentView(webView)
                webView.loadUrl("about:blank")
            }
            var current: String? = null
            while (SystemClock.uptimeMillis() < deadline) {
                scenario.onActivity { current = webView.title }
                if (current == title) return
                SystemClock.sleep(POLL_MILLIS)
            }
            fail("the host never set the WebView title (last: $current)")
        }
    }

    private fun argument(name: String): String =
        checkNotNull(arguments.getString(name)?.takeIf { it.isNotEmpty() }) { "missing -e $name" }

    private fun flag(name: String): Boolean = arguments.getString(name) == "true"

    private fun seconds(name: String, fallback: Long): Long =
        arguments.getString(name)?.toLongOrNull()?.takeIf { it > 0 } ?: fallback

    private fun deadline(seconds: Long): Long = SystemClock.uptimeMillis() + seconds * 1_000

    private fun assertMetered(expected: Boolean, seen: Boolean) {
        if (expected) assertTrue("the metered-network warning never showed", seen)
    }

    private companion object {
        val FIRST_RUN_SCREENS = listOf(
            "firstrun_loading",
            "firstrun_welcome",
            "firstrun_checking",
            "firstrun_metered",
            "firstrun_cellular",
            "firstrun_preparing",
            "firstrun_waiting",
            "firstrun_installing",
            "firstrun_busy",
            "firstrun_error",
            "firstrun_installed",
        )
        const val SCREEN_MILLIS = 120_000L
        const val OFFER_MILLIS = 60_000L
        const val PERMISSION_MILLIS = 15_000L
        const val DIALOG_MILLIS = 10_000L
        const val RETRY_MILLIS = 15_000L
        const val POLL_MILLIS = 1_000L
        const val FAILED_LINES = 20
    }
}
