package io.github.sillybunnyteam.sillybunny.app

import android.os.Bundle
import android.os.Process
import android.os.SystemClock
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.github.sillybunnyteam.sillybunny.firstrun.CheckoutStatus
import io.github.sillybunnyteam.sillybunny.firstrun.FileCheckoutInspector
import io.github.sillybunnyteam.sillybunny.repair.RepairState
import io.github.sillybunnyteam.sillybunny.repair.RepairTags
import io.github.sillybunnyteam.sillybunny.server.ServerManager
import io.github.sillybunnyteam.sillybunny.server.ServerState
import io.github.sillybunnyteam.sillybunny.settings.SettingsTags
import io.github.sillybunnyteam.sillybunny.web.WebScreenTags
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The real-runtime run of plan §7.1's user steps: the first run against a git fixture remote, a relaunch, Stop and
 * Start, a killed server and Repair, plus the native bar and keyboard layout on the window size the host sets.
 * A host script runs one method per `am instrument` call with `-e appE2E true`, in this order, and checks a seeded
 * `data/` fixture between the calls; `am instrument` force-stops the app before each call, so every method starts
 * from a launcher tap. Without that argument every method skips, so a plain androidTest run installs, starts and
 * changes nothing.
 */
@RunWith(AndroidJUnit4::class)
class AppDeviceTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val arguments: Bundle = InstrumentationRegistry.getArguments()
    private lateinit var ui: AppDeviceUi

    @Before
    fun onlyInEndToEndRuns() {
        assumeTrue("run by the end-to-end host script", arguments.getString("appE2E") == "true")
        ui = AppDeviceUi(instrumentation)
    }

    private fun checkout(): CheckoutStatus = FileCheckoutInspector(ui.paths.checkoutDir).status()

    /** Step 1: a fresh install goes through Welcome, the clone and the first start (`npm ci`) to the UI. */
    @Test
    fun firstRunReachesTheUi() {
        assertEquals(CheckoutStatus.ABSENT, checkout())
        val start = ui.now()
        val seen = linkedMapOf<String, Long>()
        val mark = { name: String -> seen.putIfAbsent(name, ui.now() - start) }
        val log = LogWatch(File(ui.paths.logsDir, ServerManager.SERVER_LOG))
        ui.launch()
        checkNotNull(ui.find(WELCOME, LAYOUT_MILLIS)) { "no Welcome; tags ${ui.tags()}" }
        mark("welcome")
        if (ui.clickIfShown(NOTIFICATIONS_ALLOW, CHOICE_MILLIS)) ui.allowPermission(PERMISSION_MILLIS)
        ui.clickIfShown(BATTERY_SKIP, CHOICE_MILLIS)
        ui.click(CONTINUE)
        mark("continue")
        val deadline = start + FIRST_RUN_MILLIS
        while (true) {
            // Continue asks for the notification permission itself when Welcome did not.
            ui.allowPermission(0)
            val tags = ui.tags()
            ui.failOnErrorScreens(tags)
            tags.filter { it in FIRST_RUN_MARKS }.forEach { mark(it) }
            if (METERED.any { it in tags }) ui.clickIfShown(METERED_CONTINUE, 0)
            for (line in log.newLines()) LOG_MARKS.forEach { (text, name) -> if (text in line) mark(name) }
            val running = ui.state as? ServerState.Running
            if (running != null) {
                mark("running")
                val page = ui.page(running.session)
                if (page != AppDeviceUi.Page.NONE) mark("page")
                if (ui.isUi(page)) {
                    mark("ui")
                    seen.forEach { (name, millis) -> ui.record("firstRun.$name", millis) }
                    assertTrue("no launch cookie for the session", ui.hasCookieFor(running.session))
                    assertEquals(CheckoutStatus.INSTALLED, checkout())
                    if (!ui.frontendSupported) {
                        checkNotNull(ui.find(WebScreenTags.VERSION_WARNING)) { "no WebView version warning" }
                    }
                    return
                }
            }
            check(ui.now() < deadline) { "the first run did not reach the UI; seen $seen; tags $tags" }
            SystemClock.sleep(AppDeviceUi.POLL_MILLIS)
        }
    }

    /** Step 2: a relaunch with a finished checkout reaches the UI without the first run. */
    @Test
    fun aRelaunchReachesTheUiWithoutTheFirstRun() {
        assertEquals(CheckoutStatus.INSTALLED, checkout())
        val start = ui.now()
        ui.launch()
        val deadline = start + START_MILLIS
        while (ui.state !is ServerState.Running) {
            val tags = ui.tags()
            check(tags.none { it.startsWith("firstrun_") }) { "the first run showed: $tags" }
            ui.failOnErrorScreens(tags)
            check(ui.now() < deadline) { "no server start; server ${ui.describe(ui.state)}; tags $tags" }
            SystemClock.sleep(AppDeviceUi.POLL_MILLIS)
        }
        val arrival = ui.awaitUi(START_MILLIS, start)
        ui.record("relaunch.running", arrival.runningMillis)
        ui.record("relaunch.page", arrival.pageMillis)
        ui.record("relaunch.ui", arrival.uiMillis)
        assertTrue("no launch cookie for the session", ui.hasCookieFor(arrival.session))
    }

    /** Step 3: Stop from the notification, Start from the stopped screen, then Stop and Start in Settings. */
    @Test
    fun stopFromTheNotificationAndFromSettingsThenStart() {
        ui.launch()
        val first = ui.awaitUi(START_MILLIS, ui.now()).session
        assertTrue("no server notification while the server runs", ui.serverNotificationShown())

        var start = ui.now()
        ui.stopFromNotification()
        ui.awaitState(STOP_MILLIS, "a stop from the notification") { it == ServerState.Stopped(userStopped = true) }
        ui.record("stop.notification", ui.now() - start)
        checkNotNull(ui.find(AppTags.STOPPED_START)) { "no Start on the stopped screen; tags ${ui.tags()}" }
        assertTrue("the server notification stayed", awaitNotification(shown = false))

        start = ui.now()
        ui.click(AppTags.STOPPED_START)
        val second = ui.awaitUi(START_MILLIS, start, previous = first)
        ui.record("start.stoppedScreen.running", second.runningMillis)
        ui.record("start.stoppedScreen.page", second.pageMillis)
        ui.record("start.stoppedScreen.ui", second.uiMillis)
        assertTrue("no launch cookie for the new session", ui.hasCookieFor(second.session))

        ui.click(AppTags.OPEN_SETTINGS)
        start = ui.now()
        ui.click(SettingsTags.SERVER_STOP)
        ui.awaitState(STOP_MILLIS, "a stop from Settings") { it == ServerState.Stopped(userStopped = true) }
        ui.record("stop.settings", ui.now() - start)
        start = ui.now()
        ui.click(SettingsTags.SERVER_START)
        val running = ui.awaitState(START_MILLIS, "a start from Settings") {
            it is ServerState.Running && it.session != second.session
        } as ServerState.Running
        ui.record("start.settings.running", ui.now() - start)
        ui.click(SettingsTags.NAVIGATE_UP)
        val third = ui.awaitUi(START_MILLIS, start, previous = second.session)
        ui.record("start.settings.page", third.pageMillis)
        ui.record("start.settings.ui", third.uiMillis)
        assertTrue("the UI shows another run than the one Settings started", third.session == running.session)
        assertTrue("no launch cookie for the new session", ui.hasCookieFor(third.session))
    }

    /** Step 4: a killed node process restarts on its own, and the WebView reconnects with the new run's cookie. */
    @Test
    fun aKilledServerRestartsAndTheWebViewReconnects() {
        ui.launch()
        val before = ui.awaitUi(START_MILLIS, ui.now()).session
        val pids = ui.nodePids()
        assertEquals("node processes $pids", 1, pids.size)
        val start = ui.now()
        Process.killProcess(pids.single())
        val after = ui.awaitUi(RESTART_MILLIS, start, previous = before)
        ui.record("restart.running", after.runningMillis)
        ui.record("restart.page", after.pageMillis)
        ui.record("restart.ui", after.uiMillis)
        assertTrue("the restart reused the launch token", after.session.token != before.token)
        assertTrue("no launch cookie for the new session", ui.hasCookieFor(after.session))
        assertFalse("the old launch cookie stayed", ui.hasCookieFor(before))
        assertFalse("the killed process is still there", pids.single() in ui.nodePids())
    }

    /**
     * Step 5: Repair from Settings replaces a checkout with a broken `.git`, keeps `config.yaml`, and keeps the old
     * folder, which Leftovers lists. The host compares the seeded `data/` files afterwards.
     */
    @Test
    fun repairFromSettingsReplacesABrokenCheckout() {
        ui.launch()
        ui.awaitUi(START_MILLIS, ui.now())
        val checkout = ui.paths.checkoutDir
        val config = File(checkout, "config.yaml")
        assertTrue("no config.yaml in the checkout", config.isFile)
        val configDigest = AppDeviceUi.sha256(config)
        val foldersBefore = ui.brokenFolders()
        File(checkout, ".git/HEAD").writeText(BROKEN_HEAD)

        ui.click(AppTags.OPEN_SETTINGS)
        ui.click(SettingsTags.REPAIR)
        val start = ui.now()
        ui.click(RepairTags.CONFIRM_ACTION)
        val repair = AppComponents.get(ui.context).repair
        val deadline = start + REPAIR_MILLIS
        while (true) {
            val state = repair.state.value
            if (state is RepairState.Succeeded) break
            check(state !is RepairState.Failed && state !is RepairState.Refused) { "Repair ended: $state" }
            check(ui.now() < deadline) { "Repair did not finish; state $state; tags ${ui.tags()}" }
            SystemClock.sleep(AppDeviceUi.POLL_MILLIS)
        }
        ui.record("repair.succeeded", ui.now() - start)
        checkNotNull(ui.find(RepairTags.SUCCEEDED)) { "no success screen; tags ${ui.tags()}" }
        val kept = (ui.brokenFolders() - foldersBefore).singleOrNull()
        checkNotNull(kept) { "no new moved-aside folder: before $foldersBefore, after ${ui.brokenFolders()}" }
        assertEquals(BROKEN_HEAD, File(ui.paths.filesDir, "$kept/.git/HEAD").readText())
        assertTrue("the new checkout has no branch HEAD", File(checkout, ".git/HEAD").readText().startsWith("ref: "))
        assertEquals("config.yaml changed", configDigest, AppDeviceUi.sha256(config))
        checkNotNull(ui.find(RepairTags.KEPT_FOLDER)) { "the success screen does not name the kept folder" }

        // Repair starts the server itself while the app is visible; Start shows only when it could not.
        ui.clickIfShown(RepairTags.START_SERVER, 0)
        ui.click(RepairTags.DONE)
        ui.click(SettingsTags.LEFTOVER_FOLDERS)
        checkNotNull(ui.find(RepairTags.leftoverItem(kept))) { "Leftovers does not list $kept; tags ${ui.tags()}" }
        ui.click(RepairTags.LEFTOVER_CLOSE)
        ui.click(SettingsTags.NAVIGATE_UP)
        val arrival = ui.awaitUi(REPAIR_START_MILLIS, start)
        ui.record("repair.running", arrival.runningMillis)
        ui.record("repair.page", arrival.pageMillis)
        ui.record("repair.ui", arrival.uiMillis)
        assertEquals(CheckoutStatus.INSTALLED, checkout())
    }

    /**
     * The native bar and the keyboard, on the window size the host sets with `wm size`: the bar sits above the web
     * content, and the keyboard moves the web content's bottom edge up instead of covering it (adjustResize).
     */
    @Test
    fun theBarAndTheKeyboardLeaveTheWebContentVisible() {
        ui.launch()
        ui.awaitUi(START_MILLIS, ui.now())
        // An old system WebView gets a warning over the bottom of the web content; a user dismisses it first.
        ui.dismissVersionWarning()
        val configuration = ui.context.resources.configuration
        ui.record("layout.widthDp", configuration.screenWidthDp.toLong())
        ui.record("layout.heightDp", configuration.screenHeightDp.toLong())
        val bar = checkNotNull(ui.find(AppTags.BAR)) { "no bar; tags ${ui.tags()}" }.visibleBounds
        checkNotNull(ui.find(AppTags.OPEN_SETTINGS)) { "no Settings control" }
        checkNotNull(ui.find(AppTags.OPEN_IN_BROWSER)) { "no Open in browser control" }
        val before = ui.awaitWebLayout("the web content") { !it.keyboardShown }
        assertTrue("the bar $bar overlaps the web content at ${before.top}", bar.bottom <= before.top)

        ui.tapTextField()
        val typing = ui.awaitWebLayout("the keyboard") { it.keyboardShown }
        assertTrue(
            "the keyboard top ${typing.keyboardTop} covers the web content bottom ${typing.bottom}",
            typing.bottom <= typing.keyboardTop + 1,
        )
        assertTrue("the web content kept its height under the keyboard", typing.bottom < before.bottom)
        ui.record("layout.webHeightPx", (before.bottom - before.top).toLong())
        ui.record("layout.webHeightWithKeyboardPx", (typing.bottom - typing.top).toLong())

        ui.device.pressBack()
        ui.awaitWebLayout("the keyboard to close") { !it.keyboardShown && it.bottom == before.bottom }
    }

    private fun awaitNotification(shown: Boolean): Boolean {
        val deadline = ui.now() + AppDeviceUi.UI_MILLIS
        while (ui.serverNotificationShown() != shown) {
            if (ui.now() >= deadline) return false
            SystemClock.sleep(AppDeviceUi.POLL_MILLIS)
        }
        return true
    }

    private companion object {
        const val WELCOME = "firstrun_welcome"
        const val NOTIFICATIONS_ALLOW = "firstrun_notifications_allow"
        const val BATTERY_SKIP = "firstrun_battery_skip"
        const val CONTINUE = "firstrun_continue"
        const val METERED_CONTINUE = "firstrun_metered_continue"
        val METERED = listOf("firstrun_metered", "firstrun_cellular")

        /** First-run screens and app routes whose first appearance marks a phase of the first run. */
        val FIRST_RUN_MARKS = setOf(
            "firstrun_checking",
            "firstrun_metered",
            "firstrun_cellular",
            "firstrun_preparing",
            "firstrun_waiting",
            "firstrun_installing",
            "firstrun_installed",
            AppTags.PROGRESS,
            AppTags.WEB,
        )

        /** start.sh's own lines around the dependency install of the first start. */
        val LOG_MARKS = listOf(
            "Installing packages via npm" to "npmInstall",
            "Dependencies are up to date." to "npmUpToDate",
            "Entering SillyBunny..." to "serverLaunch",
        )

        const val BROKEN_HEAD = "not a git ref\n"

        // Sized past a slow emulator's first launch, clone, npm ci and Repair on a shared host.
        const val LAYOUT_MILLIS = 5 * 60_000L
        const val CHOICE_MILLIS = 3_000L
        const val PERMISSION_MILLIS = 15_000L
        const val FIRST_RUN_MILLIS = 40 * 60_000L
        const val START_MILLIS = 5 * 60_000L
        const val STOP_MILLIS = 60_000L
        const val RESTART_MILLIS = 5 * 60_000L
        const val REPAIR_MILLIS = 20 * 60_000L
        const val REPAIR_START_MILLIS = 40 * 60_000L
    }
}
