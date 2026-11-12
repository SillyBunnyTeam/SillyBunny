package io.github.sillybunnyteam.sillybunny.server

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.os.Bundle
import android.os.SystemClock
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import android.provider.DocumentsContract.Root
import android.system.Os
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Direction
import androidx.test.uiautomator.StaleObjectException
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import io.github.sillybunnyteam.sillybunny.R
import io.github.sillybunnyteam.sillybunny.app.AppDeviceUi
import io.github.sillybunnyteam.sillybunny.app.AppTags
import io.github.sillybunnyteam.sillybunny.firstrun.CheckoutStatus
import io.github.sillybunnyteam.sillybunny.firstrun.FileCheckoutInspector
import io.github.sillybunnyteam.sillybunny.settings.LogSharing
import io.github.sillybunnyteam.sillybunny.settings.SettingsTags
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.regex.Pattern

/**
 * Real-runtime checks of the crash records (plan Appendix A, Round 5, Q17) and of the setup notification's Cancel
 * (Q21). A host script runs one method per `am instrument` call with `-e crashE2E true`; without that argument every
 * method skips, so a plain androidTest run changes nothing.
 *
 * [aKilledServerLeavesARecordThatShareLogsIncludes] needs a finished first run. It writes the PID to crash to
 * `files/crash-e2e/target`, and the host kills it with `adb shell run-as <package> kill -<signal> <pid>`. The cancel
 * methods need a fresh install whose notifications may show. Status lines (`crash_e2e`) never carry a token.
 */
@RunWith(AndroidJUnit4::class)
class CrashDeviceTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val arguments: Bundle = InstrumentationRegistry.getArguments()
    private lateinit var ui: AppDeviceUi

    @Before
    fun onlyInEndToEndRuns() {
        assumeTrue("run by the crash host script", arguments.getString("crashE2E") == "true")
        ui = AppDeviceUi(instrumentation)
    }

    /**
     * `-e crashTarget supervisor` (the default) crashes `node server.js`, whose status names the signal
     * (`-e crashSignal <number>`); `child` crashes the server child, which the supervisor reports as status 1.
     */
    @Test
    fun aKilledServerLeavesARecordThatShareLogsIncludes() {
        val target = arguments.getString("crashTarget") ?: TARGET_SUPERVISOR
        val signal = arguments.getString("crashSignal")?.toInt() ?: Signals.SIGKILL
        val records = CrashRecords(CrashRecords.directory(ui.context))
        val known = records.records().map { it.name }.toSet()
        File(ui.context.filesDir, HANDOVER).deleteRecursively()
        ui.launch()
        val before = ui.awaitUi(START_MILLIS, ui.now()).session
        val supervisor = ui.nodePids().single()
        val pid = if (target == TARGET_SUPERVISOR) supervisor else childOf(supervisor)

        handOver(pid)
        val start = ui.now()
        val record = waitFor("a new crash record", CRASH_MILLIS) { records.records().firstOrNull { it.name !in known } }
        report("recordMillis", ui.now() - start)
        val after = ui.awaitUi(RESTART_MILLIS, start, previous = before).session
        report("restartUiMillis", ui.now() - start)
        File(ui.context.filesDir, HANDOVER).deleteRecursively()

        val text = record.readText()
        val lines = text.lines().dropLastWhile { it.isEmpty() }
        val status = if (target == TARGET_SUPERVISOR) CrashRecords.describeExit(128 + signal) else "exit=1"
        assertTrue(lines.first(), lines.first().contains(" $status uptimeMs="))
        for (section in listOf("server-log lines=", "native-log tag=nodejs lines=", "node-report ")) {
            assertTrue("no $section section", lines.any { it.startsWith("${CrashRecords.HEADER} $section") })
        }
        assertEquals("${CrashRecords.HEADER} end", lines.last())
        assertFalse("the record holds the crashed run's token", text.contains(before.token))
        assertFalse("the record holds the new run's token", text.contains(after.token))
        report("record", record.name)
        report("recordBytes", record.length())
        report("header", lines.first())

        val earlier = snapshots().map { it.name }.toSet()
        val shared = ui.now()
        ui.click(AppTags.OPEN_SETTINGS)
        checkNotNull(ui.device.wait(Until.findObject(By.res(SettingsTags.MAIN)), AppDeviceUi.UI_MILLIS)) {
            "no Settings; tags ${ui.tags()}"
        }
        scrollDownTo(SettingsTags.SHARE_LOGS).click()
        // A tap before the dialog takes input is lost, so the button gets another tap until the snapshot shows.
        val snapshot = waitFor("a Share logs snapshot", AppDeviceUi.UI_MILLIS) {
            ui.clickIfShown(SettingsTags.SHARE_CONFIRM, 0)
            snapshots().firstOrNull { it.name !in earlier }
        }
        report("snapshotMillis", ui.now() - shared)
        val content = snapshot.readText()
        assertTrue("the snapshot does not start with the new record", content.startsWith(text))
        assertFalse("the snapshot holds the crashed run's token", content.contains(before.token))
        assertFalse("the snapshot holds the new run's token", content.contains(after.token))
        report("snapshot", snapshot.name)
        report("snapshotBytes", snapshot.length())
        report("recordsKept", records.records().size)
        ui.device.pressBack()
    }

    /** After a crash step: the app's DocumentsProvider, walked through the ContentResolver, never lists a record. */
    @Test
    fun theDocumentsProviderDoesNotReachTheRecords() {
        val records = CrashRecords(CrashRecords.directory(ui.context)).records()
        assertTrue("no crash record to look for", records.isNotEmpty())
        val authority = "${ui.context.packageName}.documents"
        val resolver = ui.context.contentResolver
        val roots = resolver.query(DocumentsContract.buildRootsUri(authority), ROOT_COLUMNS, null, null, null)
        val root = checkNotNull(roots) { "no documents roots" }.use { cursor ->
            check(cursor.moveToFirst()) { "no documents root" }
            cursor.getString(0)
        }
        val names = ArrayList<String>()
        val top = ArrayList<String>()
        val pending = ArrayDeque(listOf(root))
        while (pending.isNotEmpty() && names.size < MAX_DOCUMENTS) {
            val parent = pending.removeFirst()
            val children = DocumentsContract.buildChildDocumentsUri(authority, parent)
            resolver.query(children, CHILD_COLUMNS, null, null, null)?.use { cursor ->
                while (cursor.moveToNext()) {
                    names += cursor.getString(1)
                    if (parent == root) top += cursor.getString(1)
                    if (cursor.getString(2) == Document.MIME_TYPE_DIR) pending += cursor.getString(0)
                }
            }
        }

        assertTrue("the root lists $top", setOf("data", "config.yaml").containsAll(top))
        for (record in records) assertFalse("the provider lists ${record.name}", record.name in names)
        assertFalse(names.any { it.startsWith("crash-") && it.endsWith(".txt") })
        val hostile = records.flatMap { record ->
            listOf(record.absolutePath, "../crash/records/${record.name}", "crash/records/${record.name}")
        }
        for (id in hostile) {
            val cursor = try {
                resolver.query(DocumentsContract.buildDocumentUri(authority, id), null, null, null, null)
            } catch (_: IllegalArgumentException) {
                null
            }
            cursor.use { assertTrue("the provider answers a record path", it == null || it.count == 0) }
        }
        report("documentsWalked", names.size)
        report("documentsRoot", top.sorted().joinToString(","))
        report("hostileIdsRefused", hostile.size)
    }

    @Test
    fun theNotificationsCancelStopsTheFirstRunSetup() = cancelTheFirstRunSetup("notification") { cancel ->
        tapSetupCancelInTheShade()
        // A second tap, as from a stale shade: the job is already being cancelled.
        cancel.send()
    }

    @Test
    fun theInAppCancelStopsTheFirstRunSetup() = cancelTheFirstRunSetup("app") {
        // Right after Continue the Installing screen can still be laying out, and a tap then misses Cancel.
        waitFor("the cancel confirmation", AppDeviceUi.UI_MILLIS) {
            ui.clickIfShown(FIRST_RUN_CANCEL, 0)
            ui.find(FIRST_RUN_CANCEL_CONFIRM, CHOICE_MILLIS)
        }
        ui.click(FIRST_RUN_CANCEL_CONFIRM)
    }

    /** Starts the first run, cancels its setup job with [cancel] (given the notification's Cancel), checks the stop. */
    private fun cancelTheFirstRunSetup(how: String, cancel: (PendingIntent) -> Unit) {
        assertEquals(CheckoutStatus.ABSENT, FileCheckoutInspector(ui.paths.checkoutDir).status())
        val host = ServerManager.get(ui.context)
        ui.launch()
        checkNotNull(ui.find(WELCOME, LAYOUT_MILLIS)) { "no Welcome; tags ${ui.tags()}" }
        if (ui.clickIfShown(NOTIFICATIONS_ALLOW, CHOICE_MILLIS)) awaitNotificationAnswer()
        ui.clickIfShown(BATTERY_SKIP, CHOICE_MILLIS)
        ui.click(CONTINUE)
        waitFor("the first-run setup job", SETUP_MILLIS) {
            allowNotifications()
            if (METERED.any { it in ui.tags() }) ui.clickIfShown(METERED_CONTINUE, 0)
            host.setup.value as? SetupState.Running
        }
        val notification = waitFor("the setup notification", AppDeviceUi.UI_MILLIS) { serverNotification() }
        val action = notification.actions.single()
        assertEquals(ServerNotifications.cancelSetupIntent(ui.context), action.actionIntent)
        // Running is published before the job's session exists.
        val processes = waitFor("a setup process", AppDeviceUi.UI_MILLIS) { jobProcesses().size.takeIf { it > 0 } }

        val start = ui.now()
        cancel(action.actionIntent)
        val finished = waitFor("the end of the setup job", STOP_MILLIS) { host.setup.value as? SetupState.Finished }
        report("$how.finishedMillis", ui.now() - start)
        waitFor("the setup processes to end", STOP_MILLIS) { if (jobProcesses().isEmpty()) Unit else null }
        waitFor("the notification to go", AppDeviceUi.UI_MILLIS) { if (serverNotification() == null) Unit else null }
        val screen = waitFor("the first-run error screen", AppDeviceUi.UI_MILLIS) {
            ui.tags().firstOrNull { it.startsWith(FIRST_RUN_ERROR_PREFIX) && it != FIRST_RUN_ERROR_LINES }
        }
        assertTrue("a user cancel is not marked cancelled", finished.cancelled)
        assertNotEquals(0, finished.exitCode)
        assertEquals(FIRST_RUN_ERROR_CANCELLED, screen)

        // Late cancels after the job: nothing changes, and nothing starts.
        action.actionIntent.send()
        action.actionIntent.send()
        SystemClock.sleep(SETTLE_MILLIS)
        assertSame(finished, host.setup.value)
        assertTrue(host.state.value.let { it !is ServerState.Running && it !is ServerState.Starting })
        assertTrue(jobProcesses().isEmpty())
        assertEquals(null, serverNotification())
        report("$how.exitCode", finished.exitCode)
        report("$how.cancelled", finished.cancelled)
        report("$how.processes", processes)
        report("$how.screen", screen)
        report("$how.serverState", host.state.value::class.java.simpleName)
    }

    /**
     * Allows the dialog that Welcome's notification button opens, and waits until Welcome shows the answer. Until the
     * dialog draws, its window takes every touch on Welcome, so an earlier tap on Battery or Continue is lost (the
     * same wait as `AppDeviceTest`'s).
     */
    private fun awaitNotificationAnswer() {
        waitFor("Welcome's answer to the notification request", PERMISSION_MILLIS) {
            allowNotifications()
            if (NOTIFICATION_ANSWERS.any { it in ui.tags() }) Unit else null
        }
    }

    private fun allowNotifications() {
        check(ui.allowPermission(0)) { "the notification permission dialog stayed open; tags ${ui.tags()}" }
    }

    /**
     * Taps Cancel on the setup notification in the shade, expanding the notification first when its actions are
     * hidden, then closes the shade.
     */
    private fun tapSetupCancelInTheShade() {
        val device = ui.device
        check(device.openNotification()) { "the notification shade did not open" }
        val label = Pattern.quote(ui.context.getString(R.string.server_notification_cancel_setup))
        val selector = By.clazz(BUTTON).text(Pattern.compile("(?i)$label"))
        var button: UiObject2? = device.wait(Until.findObject(selector), SHADE_MILLIS)
        if (button == null) {
            val appName = ui.context.applicationInfo.loadLabel(ui.context.packageManager).toString()
            val header = checkNotNull(device.wait(Until.findObject(By.res(APP_NAME).text(appName)), SHADE_MILLIS)) {
                "no notification of $appName in the shade"
            }
            val expand = generateSequence(header) { it.parent }.firstNotNullOfOrNull { it.findObject(By.res(EXPAND)) }
            checkNotNull(expand) { "the setup notification has no expand button" }.click()
            button = device.wait(Until.findObject(selector), SHADE_MILLIS)
        }
        checkNotNull(button) { "no Cancel action on the setup notification" }.click()
        val deadline = ui.now() + SHADE_MILLIS
        while (device.currentPackageName == SYSTEM_UI && ui.now() < deadline) {
            device.pressBack()
            SystemClock.sleep(AppDeviceUi.POLL_MILLIS)
        }
    }

    /**
     * Scrolls the screen's list down until [tag] shows. `AppDeviceUi.find` does not get past the first screen of a
     * Compose list: Compose sends no accessibility events while UiAutomation is the only listener, so
     * `UiObject2.scroll` reports the end after every swipe and `find` turns back.
     */
    private fun scrollDownTo(tag: String): UiObject2 {
        repeat(MAX_SCROLLS) {
            ui.device.wait(Until.findObject(By.res(tag)), AppDeviceUi.POLL_MILLIS)?.let { return it }
            val list = ui.device.findObject(By.pkg(ui.context.packageName).scrollable(true))
            try {
                list?.scroll(Direction.DOWN, SCROLL_PERCENT)
            } catch (_: StaleObjectException) {
                // The list was laid out again before the swipe; the next round looks it up again.
            }
        }
        return checkNotNull(ui.device.wait(Until.findObject(By.res(tag)), AppDeviceUi.POLL_MILLIS)) {
            "$tag is not on screen after $MAX_SCROLLS scrolls; tags ${ui.tags()}"
        }
    }

    private fun serverNotification(): Notification? =
        ui.context.getSystemService(NotificationManager::class.java).activeNotifications
            .firstOrNull { it.id == ServerNotifications.NOTIFICATION_ID }?.notification

    /** Live processes of this app in another session: the setup job's, or the server's. */
    private fun jobProcesses(): List<ProcStat> {
        val own = Procfs.read(Os.getpid())?.session ?: return emptyList()
        return Procfs.snapshot(Os.getuid()).processes.values.filter { it.live && it.session != own }
    }

    /** The node process that [supervisor] started: the server child, which runs `server.js` by its full path. */
    private fun childOf(supervisor: Int): Int = waitFor("the server child", AppDeviceUi.UI_MILLIS) {
        Procfs.snapshot(Os.getuid()).processes.values.firstOrNull { stat ->
            stat.live && stat.ppid == supervisor && Procfs.argv(stat.pid).orEmpty().any { it.endsWith("/server.js") }
        }?.pid
    }

    /** Publishes [pid] for the host in one rename, so the host never reads half a line. */
    private fun handOver(pid: Int) {
        val directory = File(ui.context.filesDir, HANDOVER).apply { mkdirs() }
        val partial = File(directory, "target.partial").apply { writeText("$pid\n") }
        check(partial.renameTo(File(directory, "target"))) { "cannot publish the target" }
        report("targetPid", pid)
    }

    private fun snapshots(): List<File> = LogSharing.snapshotDirectory(ui.context).listFiles().orEmpty()
        .filter { LogSharing.isSnapshotName(it.name) && it.name.endsWith(".txt") }

    private fun report(name: String, value: Any) {
        Log.i(TAG, "$name=$value")
        instrumentation.sendStatus(STATUS_CODE, Bundle().apply { putString(STATUS_KEY, "$name=$value") })
    }

    private fun <T : Any> waitFor(what: String, timeoutMillis: Long, probe: () -> T?): T {
        val deadline = ui.now() + timeoutMillis
        while (true) {
            probe()?.let { return it }
            check(ui.now() < deadline) { "no $what within $timeoutMillis ms; server ${ui.describe(ui.state)}" }
            SystemClock.sleep(POLL_MILLIS)
        }
    }

    private companion object {
        const val TAG = "CrashDeviceTest"
        const val STATUS_CODE = 2
        const val STATUS_KEY = "crash_e2e"
        const val HANDOVER = "crash-e2e"
        const val TARGET_SUPERVISOR = "supervisor"

        const val WELCOME = "firstrun_welcome"
        const val NOTIFICATIONS_ALLOW = "firstrun_notifications_allow"
        val NOTIFICATION_ANSWERS = listOf(
            "firstrun_notifications_granted",
            "firstrun_notifications_denied",
            "firstrun_notifications_blocked",
        )
        const val BATTERY_SKIP = "firstrun_battery_skip"
        const val CONTINUE = "firstrun_continue"
        const val METERED_CONTINUE = "firstrun_metered_continue"
        val METERED = listOf("firstrun_metered", "firstrun_cellular")
        const val FIRST_RUN_CANCEL = "firstrun_cancel"
        const val FIRST_RUN_CANCEL_CONFIRM = "firstrun_cancel_confirm"
        const val FIRST_RUN_ERROR_PREFIX = "firstrun_error_"
        const val FIRST_RUN_ERROR_LINES = "firstrun_error_lines"
        const val FIRST_RUN_ERROR_CANCELLED = "firstrun_error_cancelled"

        const val BUTTON = "android.widget.Button"
        const val APP_NAME = "android:id/app_name_text"
        const val EXPAND = "android:id/expand_button"
        const val SYSTEM_UI = "com.android.systemui"

        val ROOT_COLUMNS = arrayOf(Root.COLUMN_DOCUMENT_ID)
        val CHILD_COLUMNS =
            arrayOf(Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE)
        const val MAX_DOCUMENTS = 20_000

        const val MAX_SCROLLS = 10
        const val SCROLL_PERCENT = 0.8f

        const val POLL_MILLIS = 100L
        const val SETTLE_MILLIS = 3_000L
        const val SHADE_MILLIS = 10_000L
        const val CHOICE_MILLIS = 3_000L
        const val PERMISSION_MILLIS = 60_000L
        const val LAYOUT_MILLIS = 5 * 60_000L
        const val SETUP_MILLIS = 5 * 60_000L
        const val STOP_MILLIS = 60_000L
        const val CRASH_MILLIS = 5 * 60_000L
        const val START_MILLIS = 5 * 60_000L
        const val RESTART_MILLIS = 5 * 60_000L
    }
}
