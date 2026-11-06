package io.github.sillybunnyteam.sillybunny.repair

import android.content.ContentResolver
import android.content.Context
import android.database.Cursor
import android.net.Uri
import android.os.Build
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import android.provider.DocumentsContract.Root
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import io.github.sillybunnyteam.sillybunny.BuildConfig
import io.github.sillybunnyteam.sillybunny.DataDocumentsProvider
import io.github.sillybunnyteam.sillybunny.checkout.BrokenCheckouts
import io.github.sillybunnyteam.sillybunny.runtime.RuntimePaths
import io.github.sillybunnyteam.sillybunny.server.SetupJob
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.FileNotFoundException
import java.nio.file.Files
import java.nio.file.LinkOption
import java.util.concurrent.atomic.AtomicInteger

/**
 * Repair on a device (plan §4.7), driven through its screen: the real app paths, the real DocumentsProvider
 * through [DocumentsProviderMaintenance], and a server host whose reinstall is a real `/system/bin/sh` script
 * standing in for `install.sh`. Run it on a dedicated installation: it asserts that no checkout and no
 * moved-aside folder exist, creates its own and removes them afterwards.
 */
@RunWith(AndroidJUnit4::class)
class RepairDeviceTest {
    private val context: Context = InstrumentationRegistry.getInstrumentation().targetContext
    private val resolver: ContentResolver = context.contentResolver
    private val authority = "${context.packageName}.documents"
    private val paths = RuntimePaths(context)
    private val fence = File(context.noBackupFilesDir, "documents-maintenance")
    private val device get() = RepairUi.device

    private lateinit var work: File
    private lateinit var argsFile: File
    private lateinit var gateFile: File
    private lateinit var exitFile: File
    private lateinit var missingRefFile: File
    private lateinit var script: File
    private lateinit var store: RepairStore
    private lateinit var host: ShellScriptServerHost
    private lateinit var controller: RepairController
    private var owned = false

    @Volatile
    private var screen: ScreenHost? = null
    private val closes = AtomicInteger()
    private val deferred = AtomicInteger()
    private val views = AtomicInteger()
    private val shares = AtomicInteger()

    @Before
    fun setUp() {
        assertNotEquals(Looper.getMainLooper(), Looper.myLooper())
        assertFalse("Run this suite on a dedicated installation without a checkout", exists(paths.checkoutDir))
        assertTrue("Run this suite on a dedicated installation without leftover folders", BrokenCheckouts.list(paths).isEmpty())
        assertFalse("Provider maintenance is active before the test", fence.exists())
        owned = true
        work = File(context.cacheDir, "p59-repair-device")
        deleteTree(work.toPath())
        assertTrue(work.mkdirs())
        argsFile = File(work, "args.txt")
        gateFile = File(work, "gate")
        exitFile = File(work, "exit").apply { writeText("0") }
        missingRefFile = File(work, "missing-ref")
        script = File(work, "install.sh").apply { writeText(FAKE_INSTALL_SCRIPT) }
        store = RepairStore(File(context.noBackupFilesDir, "p59-device-record.json")).also { it.clear() }
        host = ShellScriptServerHost(
            mapOf(
                "P59_ARGS_FILE" to argsFile.path,
                "P59_GATE_FILE" to gateFile.path,
                "P59_EXIT_FILE" to exitFile.path,
                "P59_MISSING_REF_FILE" to missingRefFile.path,
                "P59_RUNS_FILE" to File(work, "runs").path,
            ),
        )
        controller = RepairController(
            context = context,
            paths = paths,
            serverHost = host,
            maintenance = DocumentsProviderMaintenance,
            installScript = script,
            isVisible = { screen?.visible == true },
            onServerStartDeferred = { deferred.incrementAndGet() },
            store = store,
            defaultRef = "staging",
        )
        DeviceCheckouts.create(paths.checkoutDir, tracking = "release")
        DataDocumentsProvider.notifyRootsChanged(context)
    }

    @After
    fun tearDown() {
        if (!owned) return
        try {
            // Let a script that still waits finish, and the controller settle, before anything is removed.
            gateFile.writeText("open")
            host.awaitIdle()
            val deadline = SystemClock.uptimeMillis() + SLOW_STEP_MILLIS
            while (controller.state.value is RepairState.Running && SystemClock.uptimeMillis() < deadline) {
                SystemClock.sleep(50)
            }
            screen?.close()
        } finally {
            try {
                DataDocumentsProvider.endMaintenance(context)
            } finally {
                deleteTree(paths.checkoutDir.toPath())
                BrokenCheckouts.list(paths).forEach { deleteTree(it.toPath()) }
                store.clear()
                deleteTree(work.toPath())
                DataDocumentsProvider.notifyRootsChanged(context)
                owned = false
            }
        }
    }

    @Test
    fun aConfirmedRepairMovesTheCheckoutAsideAndReinstallsWithTheExactArguments() {
        launch()
        assertTrue(RepairUi.shown(RepairTags.CONFIRM))
        assertTrue(RepairUi.shown(RepairTags.CONFIRM_FILE_ACCESS))
        // Showing the screen changes nothing.
        SystemClock.sleep(SETTLE_MILLIS)
        assertTrue(File(paths.checkoutDir, CHAT).isFile)
        assertEquals(0, host.stops.get())
        assertNull(store.load())

        RepairUi.click(RepairTags.CONFIRM_ACTION)
        awaitScriptWaiting()
        assertTrue(RepairUi.shown(RepairTags.step(RepairStep.REINSTALLING)))
        assertTrue(RepairUi.shown(RepairTags.CANCEL))
        val source = BrokenCheckouts.list(paths).single()
        assertEquals("user data", File(source, CHAT).readText())
        assertTrue("Provider maintenance is not active during the reinstall", fence.exists())
        val record = checkNotNull(store.load())
        assertEquals(RepairPhase.REINSTALLING, record.phase)
        assertEquals(source.name, record.source)
        assertEquals("release", record.ref)
        // install.sh got exactly these arguments, from the files directory.
        assertEquals(expectedArgs(source), argsFile.readLines())
        assertJobs(source, count = 1)
        assertEquals(1, host.stops.get())
        assertEquals(0, host.starts.get())

        openGate()
        assertTrue(RepairUi.shown(RepairTags.SUCCEEDED, SLOW_STEP_MILLIS))
        val succeeded = controller.state.value as RepairState.Succeeded
        assertEquals(source, succeeded.source)
        assertTrue(succeeded.serverStarted)
        assertEquals(1, host.starts.get())
        assertEquals(0, deferred.get())
        assertNull(store.load())
        assertFalse(fence.exists())
        assertTrue(File(paths.checkoutDir, ".git/HEAD").isFile)
        assertEquals("user data", File(paths.checkoutDir, CHAT).readText())
        assertEquals("dataRoot: ./data\n", File(paths.checkoutDir, "config.yaml").readText())
        // The moved folder is kept and named; file managers are told to grant access again.
        assertEquals("user data", File(source, CHAT).readText())
        assertTrue(RepairUi.find(RepairTags.KEPT_FOLDER).hasObject(By.text(source.name)))
        assertTrue(RepairUi.shown(RepairTags.SUCCEEDED_FILE_ACCESS))
        assertFalse(RepairUi.present(RepairTags.START_SERVER))
        RepairUi.click(RepairTags.DONE)
        RepairUi.eventually(message = "the screen to close") { closes.get() == 1 }
        assertEquals(RepairState.Idle, controller.state.value)
        assertEquals(listOf(source), BrokenCheckouts.list(paths))
    }

    @Test
    fun aFailedReinstallKeepsTheDataInTheMovedFolderAndARetryMigratesFromIt() {
        exitFile.writeText("1")
        openGate()
        launch()
        RepairUi.click(RepairTags.CONFIRM_ACTION)
        assertTrue(RepairUi.shown(RepairTags.FAILED, SLOW_STEP_MILLIS))
        val source = BrokenCheckouts.list(paths).single()
        val failed = controller.state.value as RepairState.Failed
        assertEquals(RepairFailure.INSTALL_FAILED, failed.reason)
        assertEquals(1, failed.exitCode)
        assertEquals(source, failed.source)
        assertTrue(failed.canRetry)
        assertTrue(RepairUi.shown(RepairTags.failure(RepairFailure.INSTALL_FAILED)))
        assertTrue(RepairUi.find(RepairTags.DATA_LOCATION).hasObject(By.text(source.name)))
        assertTrue(RepairUi.find(RepairTags.EXIT_CODE).hasObject(By.text("1")))
        assertTrue(RepairUi.shown(RepairTags.LINES))
        val record = checkNotNull(store.load())
        assertEquals(RepairPhase.FAILED, record.phase)
        assertEquals(source.name, record.source)
        assertEquals(RepairFailure.INSTALL_FAILED, record.failure)
        assertFalse(fence.exists())
        assertEquals(0, host.starts.get())
        // The failed run left a partial checkout; the data stays in the moved folder.
        assertTrue(File(paths.checkoutDir, ".git/HEAD").isFile)
        assertEquals("user data", File(source, CHAT).readText())

        RepairUi.click(RepairTags.VIEW_LOGS)
        RepairUi.click(RepairTags.SHARE_LOGS)
        RepairUi.eventually(message = "the log actions") { views.get() == 1 && shares.get() == 1 }

        exitFile.writeText("0")
        RepairUi.click(RepairTags.RETRY)
        assertTrue(RepairUi.shown(RepairTags.SUCCEEDED, SLOW_STEP_MILLIS))
        // The partial checkout was moved aside too, never used as the source and never deleted.
        val folders = BrokenCheckouts.list(paths)
        assertEquals(2, folders.size)
        val partial = folders.single { it != source }
        assertTrue(File(partial, ".git/HEAD").isFile)
        assertEquals(expectedArgs(source), argsFile.readLines())
        assertJobs(source, count = 2)
        assertEquals("user data", File(paths.checkoutDir, CHAT).readText())
        assertEquals("user data", File(source, CHAT).readText())
        assertNull(store.load())
        assertFalse(fence.exists())
        assertEquals(2, host.stops.get())
        assertEquals(1, host.starts.get())
    }

    @Test
    fun backgroundingMidReinstallNeverCancelsItAndDefersTheServerStart() {
        val shown = launch()
        RepairUi.click(RepairTags.CONFIRM_ACTION)
        awaitScriptWaiting()

        // System back does nothing while Repair runs.
        device.pressBack()
        SystemClock.sleep(SETTLE_MILLIS)
        assertTrue(shown.visible)
        assertTrue(controller.state.value is RepairState.Running)
        assertTrue(RepairUi.shown(RepairTags.step(RepairStep.REINSTALLING)))
        assertEquals(0, closes.get())

        // Home stops the activity; the reinstall goes on and finishes in the background.
        device.pressHome()
        RepairUi.eventually(message = "the activity to stop") { !shown.visible }
        openGate()
        RepairUi.eventually(SLOW_STEP_MILLIS, "the reinstall to finish") { controller.state.value is RepairState.Succeeded }
        val succeeded = controller.state.value as RepairState.Succeeded
        assertFalse(succeeded.serverStarted)
        assertEquals(1, deferred.get())
        assertEquals(0, host.starts.get())
        assertEquals(0, host.cancels.get())
        assertEquals(1, host.jobs.size)
        assertNull(store.load())
        assertFalse(fence.exists())

        // Back in front, the screen offers the deferred start.
        shown.bringToFront()
        assertTrue(RepairUi.shown(RepairTags.SUCCEEDED))
        assertTrue(RepairUi.shown(RepairTags.SERVER_NOT_STARTED))
        RepairUi.click(RepairTags.START_SERVER)
        RepairUi.eventually(message = "the server start") { host.starts.get() == 1 }
        assertTrue((controller.state.value as RepairState.Succeeded).serverStarted)
        assertTrue(RepairUi.gone(RepairTags.START_SERVER))
        assertEquals(1, deferred.get())
    }

    @Test
    fun cancellingTakesAConfirmationAndARetryMovesThePartialCheckoutAside() {
        launch()
        RepairUi.click(RepairTags.CONFIRM_ACTION)
        awaitScriptWaiting()
        val source = BrokenCheckouts.list(paths).single()

        // Dismissing the confirmation keeps the reinstall running.
        RepairUi.click(RepairTags.CANCEL)
        assertTrue(RepairUi.shown(RepairTags.CANCEL_DIALOG))
        RepairUi.click(RepairTags.CANCEL_DISMISS)
        assertTrue(RepairUi.gone(RepairTags.CANCEL_DIALOG))
        SystemClock.sleep(SETTLE_MILLIS)
        assertEquals(0, host.cancels.get())
        assertTrue(controller.state.value is RepairState.Running)

        RepairUi.click(RepairTags.CANCEL)
        RepairUi.click(RepairTags.CANCEL_CONFIRM)
        assertTrue(RepairUi.shown(RepairTags.failure(RepairFailure.CANCELLED), SLOW_STEP_MILLIS))
        assertEquals(1, host.cancels.get())
        val failed = controller.state.value as RepairState.Failed
        assertEquals(source, failed.source)
        assertTrue(failed.canRetry)
        assertFalse(fence.exists())
        assertEquals(0, host.starts.get())
        // The stopped script left a partial checkout without data.
        assertTrue(File(paths.checkoutDir, ".git/HEAD").isFile)
        assertFalse(File(paths.checkoutDir, "data").exists())

        openGate()
        RepairUi.click(RepairTags.RETRY)
        assertTrue(RepairUi.shown(RepairTags.SUCCEEDED, SLOW_STEP_MILLIS))
        val partial = BrokenCheckouts.list(paths).single { it != source }
        assertTrue(File(partial, ".git/HEAD").isFile)
        assertFalse(File(partial, "data").exists())
        assertJobs(source, count = 2)
        assertEquals("user data", File(paths.checkoutDir, CHAT).readText())
        assertEquals("user data", File(source, CHAT).readText())
        assertEquals(1, host.starts.get())
    }

    @Test
    fun aTrackedBranchThatIsGoneUpstreamCanBeRetriedOnTheDefaultBranch() {
        // The checkout tracks release, which upstream deleted: every clone of it fails with exit 128.
        missingRefFile.writeText("release")
        openGate()
        launch()
        RepairUi.click(RepairTags.CONFIRM_ACTION)
        assertTrue(RepairUi.shown(RepairTags.failure(RepairFailure.INSTALL_FAILED), SLOW_STEP_MILLIS))
        val source = BrokenCheckouts.list(paths).single()
        assertEquals(expectedArgs(source, ref = "release"), argsFile.readLines())
        assertTrue(RepairUi.find(RepairTags.EXIT_CODE).hasObject(By.text("128")))
        assertTrue(RepairUi.find(RepairTags.DATA_LOCATION).hasObject(By.text(source.name)))
        assertTrue(RepairUi.find(RepairTags.REF).hasObject(By.text("release")))
        assertTrue(RepairUi.find(RepairTags.DEFAULT_REF).hasObject(By.text("staging")))
        assertFalse(exists(paths.checkoutDir))
        assertFalse(fence.exists())

        // Retry keeps the branch and fails the same way. The second run's output on screen shows that the screen
        // left the first failure, whose layout is otherwise the same.
        RepairUi.click(RepairTags.RETRY)
        RepairUi.eventually(SLOW_STEP_MILLIS, "the retry to fail") {
            host.jobs.size == 2 && controller.state.value is RepairState.Failed
        }
        RepairUi.eventually(SLOW_STEP_MILLIS, "the retry's output on screen") {
            RepairUi.showsText(RepairTags.LINES, "install.sh run 2")
        }
        assertEquals(expectedArgs(source, ref = "release"), argsFile.readLines())
        device.waitForIdle()

        // The default branch migrates from the same folder and finishes.
        RepairUi.click(RepairTags.RETRY_DEFAULT)
        assertTrue(RepairUi.shown(RepairTags.SUCCEEDED, SLOW_STEP_MILLIS))
        assertEquals(expectedArgs(source, ref = "staging"), argsFile.readLines())
        assertEquals(3, host.jobs.size)
        assertEquals(listOf(source), BrokenCheckouts.list(paths))
        assertEquals("user data", File(paths.checkoutDir, CHAT).readText())
        assertEquals("user data", File(source, CHAT).readText())
        assertNull(store.load())
        assertFalse(fence.exists())
        assertEquals(3, host.stops.get())
        assertEquals(1, host.starts.get())
    }

    /**
     * Plan §4.7 "External writers" with the real provider: a descriptor delivered before Repair never writes
     * again, neither into the moved-aside folder nor into the new checkout, and no document ID from before
     * Repair resolves afterwards. Writes go through AppFuse to the provider's proxy callback, as a file
     * manager's would.
     */
    @Test
    fun aWriterOpenedBeforeRepairNeverWritesAgainThroughTheRealProvider() {
        val root = rootDocument()
        val data = child(root, "data")
        val config = child(root, "config.yaml")
        val chat = child(child(child(data, "default-user"), "chats"), "chat.jsonl")
        val writer = open(chat, "rw")
        try {
            val early = "safe".toByteArray(Charsets.UTF_8)
            assertEquals(early.size, Os.pwrite(writer.fileDescriptor, early, 0, early.size, 0L))

            launch()
            RepairUi.click(RepairTags.CONFIRM_ACTION)
            awaitScriptWaiting()
            val source = BrokenCheckouts.list(paths).single()
            // While install.sh copies the moved folder, the provider is closed and the delivered writer is fenced.
            assertTrue(fence.exists())
            assertWriteRefused(writer, "during Repair")
            assertUnavailable(chat)
            expectRefusal("roots during Repair") {
                resolver.query(DocumentsContract.buildRootsUri(authority), null, null, null, null).use { it == null || it.count == 0 }
            }

            openGate()
            assertTrue(RepairUi.shown(RepairTags.SUCCEEDED, SLOW_STEP_MILLIS))
            assertFalse(fence.exists())

            // The writer stays fenced after Repair; neither folder took a late write.
            assertWriteRefused(writer, "after Repair")
            assertEquals("safe data", File(source, CHAT).readText())
            assertEquals("safe data", File(paths.checkoutDir, CHAT).readText())
            for (old in listOf(root, data, config, chat)) assertUnavailable(old)

            // The new checkout has new IDs; writes through them land in it, never in the moved folder.
            val freshRoot = rootDocument()
            assertNotEquals(DocumentsContract.getDocumentId(root), DocumentsContract.getDocumentId(freshRoot))
            val freshChat = child(child(child(child(freshRoot, "data"), "default-user"), "chats"), "chat.jsonl")
            assertNotEquals(DocumentsContract.getDocumentId(chat), DocumentsContract.getDocumentId(freshChat))
            assertEquals("safe data", read(freshChat))
            open(freshChat, "wt").use { fresh ->
                val late = "new data".toByteArray(Charsets.UTF_8)
                assertEquals(late.size, Os.write(fresh.fileDescriptor, late, 0, late.size))
            }
            assertEquals("new data", File(paths.checkoutDir, CHAT).readText())
            assertEquals("safe data", File(source, CHAT).readText())
        } finally {
            writer.close()
        }
    }

    private fun launch(): ScreenHost = ScreenHost {
        RepairScreen(
            controller = controller,
            onClose = { closes.incrementAndGet() },
            onViewLogs = { views.incrementAndGet() },
            onShareLogs = { shares.incrementAndGet() },
        )
    }.launch().also { screen = it }

    /**
     * The script runs and waits for the gate: the checkout moved aside and the script laid out a new one. Its output
     * up to the wait is on screen too, so the progress layout no longer shifts under a click (the output box grows
     * with each line and pushes Cancel down; a loaded emulator can draw a line after a click read Cancel's bounds).
     */
    private fun awaitScriptWaiting() {
        RepairUi.eventually(SLOW_STEP_MILLIS, "the reinstall to start") {
            (controller.state.value as? RepairState.Running)?.step == RepairStep.REINSTALLING &&
                File(paths.checkoutDir, "package.json").isFile
        }
        RepairUi.eventually(SLOW_STEP_MILLIS, "the reinstall output on screen") {
            RepairUi.showsText(RepairTags.LINES, "Cloning into")
        }
        device.waitForIdle()
    }

    private fun openGate() {
        gateFile.writeText("open")
    }

    private fun expectedArgs(source: File, ref: String = "release") = listOf(
        "--no-start", "--dir", paths.checkoutDir.path, "--ref", ref, "--use-node", "--repo", BuildConfig.REPO_URL,
        "--migrate-from", source.path, "--allow-git-source",
    )

    private fun assertJobs(source: File, count: Int) {
        assertEquals(count, host.jobs.size)
        for (job: SetupJob in host.jobs) {
            assertEquals(script, job.script)
            assertEquals(expectedArgs(source), job.args)
            assertEquals(paths.filesDir, job.workingDir)
        }
    }

    private fun assertWriteRefused(writer: ParcelFileDescriptor, label: String) {
        val late = "late".toByteArray(Charsets.UTF_8)
        try {
            Os.pwrite(writer.fileDescriptor, late, 0, late.size, 0L)
            fail("A writer from before Repair wrote $label")
        } catch (refused: ErrnoException) {
            Log.i(TAG, "sdk=${Build.VERSION.SDK_INT} write $label refused: ${OsConstants.errnoName(refused.errno)}")
        }
    }

    private fun assertUnavailable(uri: Uri) {
        expectRefusal("query $uri") { resolver.query(uri, null, null, null, null).use { it == null || it.count == 0 } }
        expectRefusal("open $uri") { resolver.openFileDescriptor(uri, "r").use { it == null } }
    }

    private fun expectRefusal(label: String, operation: () -> Boolean) {
        val refused = try {
            operation()
        } catch (error: Exception) {
            when (error) {
                is FileNotFoundException, is IllegalArgumentException, is SecurityException -> true
                else -> throw error
            }
        }
        assertTrue("$label unexpectedly succeeded", refused)
    }

    private fun query(uri: Uri, projection: Array<String>): Cursor =
        checkNotNull(resolver.query(uri, projection, null, null, null)) { "No cursor for $uri" }

    private fun rootDocument(): Uri = query(DocumentsContract.buildRootsUri(authority), arrayOf(Root.COLUMN_DOCUMENT_ID)).use {
        assertEquals(1, it.count)
        assertTrue(it.moveToFirst())
        DocumentsContract.buildDocumentUri(authority, it.getString(0))
    }

    private fun child(parent: Uri, name: String): Uri {
        val children = DocumentsContract.buildChildDocumentsUri(authority, DocumentsContract.getDocumentId(parent))
        val id = query(children, arrayOf(Document.COLUMN_DISPLAY_NAME, Document.COLUMN_DOCUMENT_ID)).use { cursor ->
            var found: String? = null
            while (cursor.moveToNext()) if (cursor.getString(0) == name) found = cursor.getString(1)
            checkNotNull(found) { "No child $name" }
        }
        return DocumentsContract.buildDocumentUri(authority, id)
    }

    private fun open(uri: Uri, mode: String): ParcelFileDescriptor = checkNotNull(resolver.openFileDescriptor(uri, mode))

    private fun read(uri: Uri): String =
        ParcelFileDescriptor.AutoCloseInputStream(open(uri, "r")).bufferedReader(Charsets.UTF_8).use { it.readText() }

    private fun exists(file: File) = Files.exists(file.toPath(), LinkOption.NOFOLLOW_LINKS)

    private companion object {
        const val TAG = "RepairDeviceTest"
        const val CHAT = DeviceCheckouts.CHAT
        const val SETTLE_MILLIS = 1_000L
    }
}
