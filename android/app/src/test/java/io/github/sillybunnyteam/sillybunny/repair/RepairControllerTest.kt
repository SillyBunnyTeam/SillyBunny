package io.github.sillybunnyteam.sillybunny.repair

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import io.github.sillybunnyteam.sillybunny.checkout.BrokenCheckouts
import io.github.sillybunnyteam.sillybunny.runtime.RuntimePaths
import io.github.sillybunnyteam.sillybunny.server.ServerHost
import io.github.sillybunnyteam.sillybunny.server.SetupJob
import io.github.sillybunnyteam.sillybunny.server.SetupState
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.time.Instant
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
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

/**
 * Every Repair step and its failure paths (plan §4.7) on real directories, against a fake server host and a
 * fake provider. The controller runs unconfined, so each call returns once Repair waits for the reinstall,
 * and finishing the fake job completes the rest on the test thread.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [37])
class RepairControllerTest {
    @get:Rule
    val temporary = TemporaryFolder()

    private val context: Context = ApplicationProvider.getApplicationContext()
    private val events = mutableListOf<String>()
    private lateinit var paths: RuntimePaths
    private lateinit var host: FakeRepairServerHost
    private lateinit var maintenance: FakeMaintenance
    private lateinit var store: RepairStore
    private lateinit var script: File
    private var visible = true
    private var deferredStarts = 0
    private var now = Instant.parse("2026-10-21T07:00:00Z")
    private var moveFailure: IOException? = null
    private var afterMove: (File) -> Unit = {}

    @Before
    fun setUp() {
        val root = temporary.root
        paths = RuntimePaths(
            File(root, "files").apply { mkdirs() },
            File(root, "cache").apply { mkdirs() },
            File(root, "lib"),
        )
        host = FakeRepairServerHost(events)
        maintenance = FakeMaintenance(events)
        store = RepairStore(File(root, "no_backup/repair-record.json"))
        script = File(root, "install.sh").apply { writeText("#!/system/bin/sh\n") }
    }

    private fun controller(
        serverHost: ServerHost = host,
        dispatcher: CoroutineDispatcher = Dispatchers.Unconfined,
        recordStore: RepairStore = store,
    ) = RepairController(
        context = context,
        paths = paths,
        serverHost = serverHost,
        maintenance = maintenance,
        installScript = script,
        isVisible = { visible },
        onServerStartDeferred = { deferredStarts++ },
        store = recordStore,
        defaultRef = "staging",
        clock = { now.also { now = now.plusSeconds(1) } },
        dispatcher = dispatcher,
        stopTimeoutMillis = 1_234,
        moveAside = { target, at ->
            events += "move"
            moveFailure?.let { throw it }
            BrokenCheckouts.moveAside(target, at).also(afterMove)
        },
    )

    private fun checkout(config: String? = "dataRoot: ./data\n", tracking: String? = "release"): File =
        TestCheckouts.create(paths.checkoutDir, config = config, tracking = tracking)

    private fun broken(): List<File> = BrokenCheckouts.list(paths)

    private fun argsFor(source: File, ref: String) = listOf(
        "--no-start", "--dir", paths.checkoutDir.path, "--ref", ref, "--use-node",
        "--migrate-from", source.path, "--allow-git-source",
    )

    /** What a successful install.sh leaves: a new checkout with the migrated data. */
    private fun installSucceeds(exitLines: Array<String> = arrayOf("Done.")) {
        val job = host.jobs.last()
        val source = File(job.args[job.args.indexOf("--migrate-from") + 1])
        TestCheckouts.installed(paths.checkoutDir)
        File(source, "data").copyRecursively(File(paths.checkoutDir, "data"))
        host.finish(0, *exitLines)
    }

    /** The provider is open again, and the last end came after the last begin. */
    private fun assertMaintenanceEnded() {
        assertFalse("provider left in maintenance", maintenance.inMaintenance)
        assertTrue(events.lastIndexOf("end") > events.lastIndexOf("begin"))
    }

    private fun assertUntouched(checkout: File, data: String = "user data") {
        assertEquals(data, File(checkout, "data/default-user/chats/chat.jsonl").readText())
        assertTrue(CheckoutChecks.isSillyBunny(checkout))
    }

    /** From now on the record stays readable but can be neither saved nor cleared: its temporary file is a non-empty directory. */
    private fun blockRecordWrites(): File = File(temporary.root, "no_backup/repair-record.json.tmp").apply {
        mkdirs()
        File(this, "keep").writeText("x")
    }

    @Test
    fun aRepairMovesTheCheckoutAsideReinstallsWithMigrationAndStartsTheServer() {
        checkout(tracking = "release")
        val repair = controller()
        assertTrue(repair.start())

        val source = broken().single()
        val running = repair.state.value as RepairState.Running
        assertEquals(RepairStep.REINSTALLING, running.step)
        assertEquals(source, running.source)
        assertEquals("release", running.ref)
        assertTrue(running.canCancel)
        val job = host.jobs.single()
        assertSame(script, job.script)
        assertEquals(argsFor(source, "release"), job.args)
        assertEquals(paths.filesDir, job.workingDir)
        assertEquals(listOf(1_234L), host.stopTimeouts)
        // The provider stays closed while install.sh copies the moved folder.
        assertTrue(maintenance.inMaintenance)
        assertFalse(paths.checkoutDir.exists())
        assertUntouched(source)
        val record = store.load()!!
        assertEquals(RepairPhase.REINSTALLING, record.phase)
        assertEquals(source.name, record.source)
        assertEquals("release", record.ref)

        host.emit("Cloning into 'SillyBunny'...")
        assertEquals(listOf("Cloning into 'SillyBunny'..."), (repair.state.value as RepairState.Running).lines)
        installSucceeds()

        val done = repair.state.value as RepairState.Succeeded
        assertEquals(source, done.source)
        assertTrue(done.serverStarted)
        assertEquals(listOf("Cloning into 'SillyBunny'...", "Done."), done.lines)
        assertEquals(listOf("end", "stop", "begin", "move", "runSetup", "end", "notify", "start"), events)
        assertEquals(1, host.startCount)
        assertEquals(0, deferredStarts)
        assertNull(store.load())
        // The moved folder is kept; nothing was deleted.
        assertEquals(listOf(source), broken())
        assertUntouched(source)
        assertUntouched(paths.checkoutDir)
        assertMaintenanceEnded()
        assertFalse(repair.startServer())
    }

    @Test
    fun theRefIsTheTrackedBranchOrTheDefault() {
        val cases = listOf("feature/two" to "feature/two", null to "staging", "-weird" to "staging", "release" to "release")
        for ((tracking, expected) in cases) {
            host.jobs.clear()
            checkout(tracking = tracking)
            val repair = controller()
            assertTrue(repair.start())
            val source = broken().last()
            assertEquals("tracking $tracking", argsFor(source, expected), host.jobs.single().args)
            assertEquals(expected, store.load()?.ref)
            installSucceeds()
            assertTrue(repair.state.value is RepairState.Succeeded)
            paths.checkoutDir.deleteRecursively()
        }
    }

    @Test
    fun aServerThatDoesNotStopAbortsBeforeAnythingMoves() {
        checkout()
        host.stopResult = false
        val repair = controller()
        assertTrue(repair.start())
        val failed = repair.state.value as RepairState.Failed
        assertEquals(RepairFailure.STOP_TIMEOUT, failed.reason)
        assertNull(failed.source)
        assertTrue(failed.canRetry)
        // Nothing moved, so no branch is chosen yet and none is offered.
        assertNull(failed.ref)
        assertNull(failed.fallbackRef)
        assertFalse(repair.retryWithDefaultRef())
        assertEquals(listOf("end", "stop"), events)
        assertEquals(0, maintenance.begins)
        assertTrue(broken().isEmpty())
        assertUntouched(paths.checkoutDir)
        assertNull(store.load())

        host.stopResult = true
        host.stopFailure = IllegalStateException("binder died")
        events.clear()
        assertTrue(repair.retry())
        assertEquals(RepairFailure.STOP_TIMEOUT, (repair.state.value as RepairState.Failed).reason)
        assertTrue(broken().isEmpty())
        assertEquals(0, maintenance.begins)
    }

    @Test
    fun aFailedRenameEndsMaintenanceAndKeepsTheCheckout() {
        checkout()
        moveFailure = IOException("EXDEV")
        val repair = controller()
        assertTrue(repair.start())
        val failed = repair.state.value as RepairState.Failed
        assertEquals(RepairFailure.MOVE_FAILED, failed.reason)
        assertNull(failed.source)
        assertEquals(listOf("end", "stop", "begin", "move", "end", "notify"), events)
        assertMaintenanceEnded()
        assertTrue(host.jobs.isEmpty())
        assertTrue(broken().isEmpty())
        assertUntouched(paths.checkoutDir)
        assertNull(store.load())
    }

    @Test
    fun aFailedMaintenanceBeginStillEndsItAndMovesNothing() {
        checkout()
        maintenance.beginFailure = IllegalStateException("provider busy")
        val repair = controller()
        assertTrue(repair.start())
        val failed = repair.state.value as RepairState.Failed
        assertEquals(RepairFailure.MAINTENANCE_FAILED, failed.reason)
        assertNull(failed.source)
        assertEquals(listOf("end", "stop", "begin", "end", "notify"), events)
        assertMaintenanceEnded()
        assertTrue(broken().isEmpty())
        assertUntouched(paths.checkoutDir)
        assertNull(store.load())
    }

    @Test
    fun aRefusedReinstallKeepsTheMovedFolderAsTheSource() {
        checkout()
        host.accept = false
        val repair = controller()
        assertTrue(repair.start())
        val source = broken().single()
        val failed = repair.state.value as RepairState.Failed
        assertEquals(RepairFailure.SETUP_REFUSED, failed.reason)
        assertEquals(source, failed.source)
        assertTrue(failed.canRetry)
        assertMaintenanceEnded()
        assertUntouched(source)
        val record = store.load()!!
        assertEquals(RepairPhase.FAILED, record.phase)
        assertEquals(RepairFailure.SETUP_REFUSED, record.failure)
        assertEquals(source.name, record.source)
        assertEquals("release", record.ref)

        // A host that throws is refused the same way, and the retry migrates from the same folder.
        host.accept = true
        host.runSetupFailure = IllegalStateException("not visible")
        assertTrue(repair.retry())
        assertEquals(RepairFailure.SETUP_REFUSED, (repair.state.value as RepairState.Failed).reason)
        assertEquals(listOf(source), broken())
        assertMaintenanceEnded()
    }

    @Test
    fun aFailedReinstallKeepsEverythingAndShowsItsLastLines() {
        checkout()
        host.onRunSetup = {
            File(paths.checkoutDir, ".git").mkdirs()
            host.emit("Cloning into 'SillyBunny'...")
        }
        val repair = controller()
        assertTrue(repair.start())
        val source = broken().single()
        host.finish(128, "fatal: unable to access the repository")

        val failed = repair.state.value as RepairState.Failed
        assertEquals(RepairFailure.INSTALL_FAILED, failed.reason)
        assertEquals(source, failed.source)
        assertEquals(128, failed.exitCode)
        assertEquals(listOf("Cloning into 'SillyBunny'...", "fatal: unable to access the repository"), failed.lines)
        assertTrue(failed.canRetry)
        assertEquals(0, host.startCount)
        assertMaintenanceEnded()
        assertUntouched(source)
        assertTrue(paths.checkoutDir.isDirectory)
        assertEquals(RepairPhase.FAILED, store.load()?.phase)
        // The failure stays until it is retried: closing the screen keeps it, and the next launch shows it.
        repair.dismiss()
        assertSame(failed, repair.state.value)
        assertTrue(controller().resumeOnLaunch())
    }

    @Test
    fun exitZeroWithoutACheckoutIsAFailure() {
        checkout()
        val repair = controller()
        assertTrue(repair.start())
        host.finish(0)
        val failed = repair.state.value as RepairState.Failed
        assertEquals(RepairFailure.NOT_A_CHECKOUT, failed.reason)
        assertEquals(broken().single(), failed.source)
        assertEquals(0, host.startCount)
    }

    @Test
    fun cancelStopsTheReinstallAndLeavesTheRecordReadyForARetry() {
        checkout()
        val repair = controller()
        assertFalse(repair.cancel())
        assertTrue(repair.start())
        val source = broken().single()
        assertTrue(repair.cancel())
        assertEquals(1, host.cancelCount)
        assertTrue((repair.state.value as RepairState.Running).cancelling)
        assertFalse((repair.state.value as RepairState.Running).canCancel)
        assertFalse(repair.cancel())
        // Output still streams while the job stops.
        host.emit("Terminated")
        assertTrue((repair.state.value as RepairState.Running).cancelling)
        host.finish(143)

        val failed = repair.state.value as RepairState.Failed
        assertEquals(RepairFailure.CANCELLED, failed.reason)
        assertEquals(source, failed.source)
        assertTrue(failed.canRetry)
        assertMaintenanceEnded()
        val record = store.load()!!
        assertEquals(RepairPhase.FAILED, record.phase)
        assertEquals(RepairFailure.CANCELLED, record.failure)
        assertEquals(source.name, record.source)

        assertTrue(repair.retry())
        assertEquals(argsFor(source, "release"), host.jobs.last().args)
        installSucceeds()
        assertTrue(repair.state.value is RepairState.Succeeded)
    }

    @Test
    fun aRetryMovesThePartialCheckoutAsideAndMigratesFromTheOriginal() {
        checkout(tracking = "release")
        val repair = controller()
        assertTrue(repair.start())
        val source = broken().single()
        // install.sh cloned part of a checkout, then failed.
        TestCheckouts.track(paths.checkoutDir, local = "main", upstream = "other-branch")
        File(paths.checkoutDir, "half.js").writeText("half")
        host.finish(1, "fatal: early EOF")
        assertEquals(RepairFailure.INSTALL_FAILED, (repair.state.value as RepairState.Failed).reason)

        events.clear()
        assertTrue(repair.retry())
        val partial = broken().single { it != source }
        assertEquals("half", File(partial, "half.js").readText())
        assertFalse(paths.checkoutDir.exists())
        // Reading the unfinished record reopens and announces the provider before the attempt fences it again.
        assertEquals(listOf("end", "notify", "stop", "begin", "move", "runSetup"), events)
        // The original folder stays the source and keeps its ref; the partial is recorded, never migrated.
        assertEquals(argsFor(source, "release"), host.jobs.last().args)
        val record = store.load()!!
        assertEquals(source.name, record.source)
        assertEquals(listOf(partial.name), record.partials)
        assertEquals(source, (repair.state.value as RepairState.Running).source)

        installSucceeds()
        assertEquals(source, (repair.state.value as RepairState.Succeeded).source)
        assertEquals(setOf(source, partial), broken().toSet())
        assertUntouched(source)
        assertUntouched(paths.checkoutDir)
        assertMaintenanceEnded()
    }

    @Test
    fun aRetryRefusesAPartialThatIsNotADirectoryAndASourceThatVanished() {
        checkout()
        val repair = controller()
        assertTrue(repair.start())
        val source = broken().single()
        host.finish(1)
        paths.checkoutDir.deleteRecursively()
        paths.checkoutDir.writeText("not a folder")

        assertTrue(repair.retry())
        val failed = repair.state.value as RepairState.Failed
        assertEquals(RepairFailure.PARTIAL_NOT_DIRECTORY, failed.reason)
        assertEquals(source, failed.source)
        assertEquals("not a folder", paths.checkoutDir.readText())
        assertMaintenanceEnded()

        paths.checkoutDir.delete()
        moveFailure = null
        Files.move(source.toPath(), File(temporary.root, "moved-by-someone").toPath())
        assertTrue(repair.retry())
        val gone = repair.state.value as RepairState.Failed
        assertEquals(RepairFailure.SOURCE_MISSING, gone.reason)
        assertFalse(gone.canRetry)
        // Nothing to migrate from: closing forgets the record.
        repair.dismiss()
        assertEquals(RepairState.Idle, repair.state.value)
        assertNull(store.load())
    }

    @Test
    fun aRetryWhosePartialCannotMoveKeepsTheOriginalSource() {
        checkout()
        val repair = controller()
        assertTrue(repair.start())
        val source = broken().single()
        File(paths.checkoutDir, ".git").mkdirs()
        host.finish(1)
        moveFailure = IOException("EBUSY")
        assertTrue(repair.retry())
        val failed = repair.state.value as RepairState.Failed
        assertEquals(RepairFailure.PARTIAL_MOVE_FAILED, failed.reason)
        assertEquals(source, failed.source)
        assertEquals(source.name, store.load()?.source)
        assertTrue(store.load()!!.partials.isEmpty())
        assertTrue(File(paths.checkoutDir, ".git").isDirectory)
        assertMaintenanceEnded()
    }

    @Test
    fun processDeathBeforeTheMoveLeavesNothingToResume() {
        checkout()
        val at = Instant.parse("2026-10-21T06:00:00Z")
        val records = listOf(
            RepairRecord(RepairPhase.STOPPING, at),
            RepairRecord(RepairPhase.QUIESCING, at),
            RepairRecord(RepairPhase.MOVING_ASIDE, at, movingAt = at),
        )
        for (record in records) {
            store.save(record)
            maintenance.inMaintenance = true
            events.clear()
            val repair = controller(serverHost = FakeRepairServerHost(events))
            assertFalse(record.phase.name, repair.resumeOnLaunch())
            assertEquals(RepairState.Idle, repair.state.value)
            assertNull(store.load())
            assertEquals(listOf("end", "notify"), events)
            assertMaintenanceEnded()
            assertTrue(broken().isEmpty())
            assertUntouched(paths.checkoutDir)
        }
        // Without any record, a launch still reopens a provider that a failed end left closed.
        maintenance.inMaintenance = true
        events.clear()
        assertFalse(controller().resumeOnLaunch())
        assertEquals(listOf("end"), events)
        assertFalse(maintenance.inMaintenance)
    }

    @Test
    fun processDeathRightAfterTheMoveResumesFromTheStampedFolder() {
        checkout()
        // An older folder moved aside in the same second must never be mistaken for this one.
        val first = controller()
        now = Instant.parse("2026-10-21T07:00:00Z")
        val older = BrokenCheckouts.moveAside(paths, Instant.parse("2026-10-21T07:00:01Z"))
        checkout()
        afterMove = { throw ProcessDeath() }
        assertTrue(first.start())
        val source = broken().single { it != older }
        assertEquals("SillyBunny.broken-20261021T070001Z-2", source.name)
        val disk = store.load()!!
        assertEquals(RepairPhase.MOVING_ASIDE, disk.phase)
        assertNull(disk.source)
        assertEquals(listOf(older.name), disk.preexisting)

        // A new process: the host is idle and the provider is still fenced.
        afterMove = {}
        maintenance.inMaintenance = true
        val repair = controller(serverHost = FakeRepairServerHost(events))
        assertTrue(repair.resumeOnLaunch())
        val failed = repair.state.value as RepairState.Failed
        assertEquals(RepairFailure.INTERRUPTED, failed.reason)
        assertEquals(source, failed.source)
        assertTrue(failed.canRetry)
        // The branch is read from the moved folder, so the screen can show it and offer the default instead.
        assertEquals("release", failed.ref)
        assertEquals("staging", failed.fallbackRef)
        assertMaintenanceEnded()
        val record = store.load()!!
        assertEquals(RepairPhase.FAILED, record.phase)
        assertEquals(source.name, record.source)
        assertNull(record.movingAt)
        assertTrue(record.preexisting.isEmpty())
        assertEquals("release", record.ref)

        val retryHost = FakeRepairServerHost(events)
        val retrying = controller(serverHost = retryHost)
        assertTrue(retrying.resumeOnLaunch())
        assertTrue(retrying.retry())
        assertEquals(argsFor(source, "release"), retryHost.jobs.single().args)
        assertEquals("release", store.load()?.ref)
    }

    @Test
    fun processDeathDuringTheReinstallResumesAsInterruptedAndRetriesFromTheOriginal() {
        checkout(tracking = "release")
        assertTrue(controller().start())
        val source = broken().single()
        // install.sh was killed with the app: a partial clone is left behind.
        TestCheckouts.track(paths.checkoutDir, local = "release", upstream = "release")
        maintenance.inMaintenance = true

        val newHost = FakeRepairServerHost(events)
        val repair = controller(serverHost = newHost)
        assertTrue(repair.resumeOnLaunch())
        val failed = repair.state.value as RepairState.Failed
        assertEquals(RepairFailure.INTERRUPTED, failed.reason)
        assertEquals(source, failed.source)
        assertMaintenanceEnded()
        assertEquals(RepairFailure.INTERRUPTED, store.load()?.failure)
        // Another launch shows the same unfinished Repair.
        assertTrue(repair.resumeOnLaunch())

        assertTrue(repair.retry())
        val partial = broken().single { it != source }
        assertTrue(File(partial, ".git/HEAD").isFile)
        assertEquals(argsFor(source, "release"), newHost.jobs.single().args)
        newHost.onRunSetup = {}
        TestCheckouts.installed(paths.checkoutDir)
        newHost.finish(0)
        assertEquals(source, (repair.state.value as RepairState.Succeeded).source)
        assertNull(store.load())
    }

    @Test
    fun aReinstallStillRunningInThisProcessIsFollowedAfterResume() {
        checkout()
        // The first controller stops observing (its dispatcher never runs again), as if it were gone.
        val frozen = StandardTestDispatcher()
        val gone = controller(dispatcher = frozen)
        assertTrue(gone.start())
        frozen.scheduler.runCurrent()
        val source = broken().single()
        assertTrue(host.setup.value is SetupState.Running)
        host.emit("Receiving objects: 10%")

        val atEnd = mutableListOf<RepairRecord?>()
        maintenance.onEnd = { atEnd += store.load() }
        val repair = controller()
        assertTrue(repair.resumeOnLaunch())
        val running = repair.state.value as RepairState.Running
        assertEquals(RepairStep.REINSTALLING, running.step)
        assertEquals(source, running.source)
        assertEquals("release", running.ref)
        assertEquals(listOf("Receiving objects: 10%"), running.lines)
        assertTrue(maintenance.inMaintenance)
        assertTrue(repair.cancel())
        assertEquals(1, host.cancelCount)
        TestCheckouts.installed(paths.checkoutDir)
        host.finish(0)
        // The job completed before the cancel landed: a finished checkout is a success.
        assertEquals(source, (repair.state.value as RepairState.Succeeded).source)
        assertMaintenanceEnded()
        assertNull(store.load())
        // A followed reinstall also forgets its record before the provider reopens.
        assertEquals(listOf<RepairRecord?>(null), atEnd)
    }

    @Test
    fun processDeathWhileMovingAPartialAsideRecordsThePartial() {
        checkout()
        val repair = controller()
        assertTrue(repair.start())
        val source = broken().single()
        File(paths.checkoutDir, ".git").mkdirs()
        host.finish(1)

        afterMove = { throw ProcessDeath() }
        assertTrue(repair.retry())
        val partial = broken().single { it != source }
        assertEquals(RepairPhase.MOVING_PARTIAL_ASIDE, store.load()?.phase)

        afterMove = {}
        maintenance.inMaintenance = true
        val resumed = controller(serverHost = FakeRepairServerHost(events))
        assertTrue(resumed.resumeOnLaunch())
        val failed = resumed.state.value as RepairState.Failed
        assertEquals(source, failed.source)
        assertEquals(RepairFailure.INTERRUPTED, failed.reason)
        val record = store.load()!!
        assertEquals(source.name, record.source)
        assertEquals(listOf(partial.name), record.partials)
        assertMaintenanceEnded()
    }

    @Test
    fun anAbsoluteDataRootInsideTheCheckoutIsRefusedBeforeAnythingStops() {
        val checkoutPath = paths.checkoutDir.path
        val filesPath = paths.filesDir.path
        val linkToInside = File(paths.filesDir, "outside-link")
        val inside = listOf(
            "dataRoot: $checkoutPath/userdata\n",
            "dataRoot: \"$checkoutPath/data\" # moved\n",
            "dataRoot: '$filesPath/./SillyBunny/data'\n",
            "dataRoot: $filesPath/SillyBunny\n",
            "dataRoot: ${linkToInside.path}/chats\n",
        )
        for (config in inside) {
            paths.checkoutDir.deleteRecursively()
            checkout(config = config)
            Files.deleteIfExists(linkToInside.toPath())
            Files.createSymbolicLink(linkToInside.toPath(), File(paths.checkoutDir, "data").toPath())
            events.clear()
            val repair = controller()
            assertTrue(repair.start())
            assertEquals(config, RepairState.Refused(RepairRefusal.DATA_ROOT_INSIDE_CHECKOUT), repair.state.value)
            // Refused before step 2: nothing stopped, fenced, moved or recorded; the config is untouched.
            assertEquals(listOf("end"), events)
            assertTrue(broken().isEmpty())
            assertNull(store.load())
            assertEquals(config, File(paths.checkoutDir, "config.yaml").readText())
            assertUntouched(paths.checkoutDir)
        }
    }

    @Test
    fun anAbsoluteDataRootOutsideTheCheckoutIsReusedNotRefused() {
        val outside = File(paths.filesDir, "SillyBunny-data").apply { mkdirs() }
        for (root in listOf(outside.path, "${paths.filesDir.path}/SillyBunny2/data", "/storage/emulated/0/SillyBunny")) {
            paths.checkoutDir.deleteRecursively()
            host.jobs.clear()
            checkout(config = "dataRoot: $root\n")
            val repair = controller()
            assertTrue(repair.start())
            assertEquals(root, RepairStep.REINSTALLING, (repair.state.value as RepairState.Running).step)
            installSucceeds()
            assertTrue(repair.state.value is RepairState.Succeeded)
        }
    }

    @Test
    fun preconditionsRefuseWithoutTouchingAnything() {
        fun expectRefusal(reason: RepairRefusal) {
            events.clear()
            val repair = controller()
            assertTrue(repair.start())
            assertEquals(RepairState.Refused(reason), repair.state.value)
            assertEquals(listOf("end"), events)
            assertTrue(broken().isEmpty())
            assertNull(store.load())
            repair.dismiss()
            assertEquals(RepairState.Idle, repair.state.value)
        }

        expectRefusal(RepairRefusal.CHECKOUT_MISSING)
        val real = temporary.newFolder("real")
        TestCheckouts.create(real)
        Files.createSymbolicLink(paths.checkoutDir.toPath(), real.toPath())
        expectRefusal(RepairRefusal.CHECKOUT_NOT_DIRECTORY)
        Files.delete(paths.checkoutDir.toPath())
        paths.checkoutDir.writeText("a file")
        expectRefusal(RepairRefusal.CHECKOUT_NOT_DIRECTORY)
        paths.checkoutDir.delete()

        checkout(config = null)
        File(paths.checkoutDir, "package.json").writeText("{\"name\": \"something-else\"}")
        expectRefusal(RepairRefusal.NOT_SILLYBUNNY)
        paths.checkoutDir.deleteRecursively()

        checkout(config = "dataRoot: ./data\n")
        File(paths.checkoutDir, "config.yaml").writeBytes(byteArrayOf(0xFF.toByte(), 0xFE.toByte()))
        expectRefusal(RepairRefusal.CONFIG_UNREADABLE)
        File(paths.checkoutDir, "config.yaml").writeText("dataRoot: ./data/../../elsewhere\n")
        expectRefusal(RepairRefusal.DATA_ROOT_OUTSIDE_CHECKOUT)
        File(paths.checkoutDir, "config.yaml").writeText("dataRoot: /bad\u0000path\n")
        expectRefusal(RepairRefusal.CONFIG_UNREADABLE)

        File(paths.checkoutDir, "config.yaml").writeText("dataRoot: ./data\n")
        host.setup.value = SetupState.Running(SetupJob(script, listOf("--no-start"), paths.filesDir), emptyList())
        expectRefusal(RepairRefusal.SETUP_BUSY)
        assertUntouched(paths.checkoutDir)
    }

    @Test
    fun aRepairThatCannotBeShownAbortsBeforeTheMove() {
        checkout()
        visible = false
        val repair = controller()
        assertTrue(repair.start())
        val failed = repair.state.value as RepairState.Failed
        assertEquals(RepairFailure.NOT_VISIBLE, failed.reason)
        assertNull(failed.source)
        assertEquals(listOf("end", "stop", "begin", "end", "notify"), events)
        assertTrue(broken().isEmpty())
        assertUntouched(paths.checkoutDir)
        assertMaintenanceEnded()
    }

    @Test
    fun aSuccessWhileNotVisibleDefersTheServerStart() {
        checkout()
        val repair = controller()
        assertTrue(repair.start())
        // The user left the app while install.sh ran in the foreground service.
        visible = false
        installSucceeds()
        val done = repair.state.value as RepairState.Succeeded
        assertFalse(done.serverStarted)
        assertEquals(1, deferredStarts)
        assertEquals(0, host.startCount)
        assertNull(store.load())
        assertFalse(controller().resumeOnLaunch())

        visible = true
        assertTrue(repair.startServer())
        assertEquals(1, host.startCount)
        assertTrue((repair.state.value as RepairState.Succeeded).serverStarted)
        assertFalse(repair.startServer())
        repair.dismiss()
        assertEquals(RepairState.Idle, repair.state.value)
    }

    @Test
    fun aServerThatFailsToStartAfterSuccessIsDeferredToo() {
        checkout()
        host.startFailure = IllegalStateException("background start")
        val repair = controller()
        assertTrue(repair.start())
        installSucceeds()
        assertFalse((repair.state.value as RepairState.Succeeded).serverStarted)
        assertEquals(1, deferredStarts)
        assertFalse(repair.startServer())
        host.startFailure = null
        assertTrue(repair.startServer())
    }

    @Test
    fun anUnwritableRecordStopsBeforeTheServerIsStopped() {
        checkout()
        temporary.newFile("blocker")
        val repair = controller(recordStore = RepairStore(File(temporary.root, "blocker/repair-record.json")))
        assertTrue(repair.start())
        val failed = repair.state.value as RepairState.Failed
        assertEquals(RepairFailure.RECORD_UNWRITABLE, failed.reason)
        assertNull(failed.source)
        assertEquals(listOf("end"), events)
        assertUntouched(paths.checkoutDir)
    }

    @Test
    fun anUnreadableRecordRefusesRepairAndLaunchRecovery() {
        checkout()
        File(temporary.root, "no_backup").mkdirs()
        File(temporary.root, "no_backup/repair-record.json").writeText("{ not json")
        maintenance.inMaintenance = true
        val repair = controller()
        assertFalse(repair.resumeOnLaunch())
        assertEquals(RepairState.Refused(RepairRefusal.RECORD_UNREADABLE), repair.state.value)
        assertTrue(repair.start())
        assertEquals(RepairState.Refused(RepairRefusal.RECORD_UNREADABLE), repair.state.value)
        assertTrue(events.isEmpty())
        // Where the data is cannot be known, so the provider stays fenced and nothing moves.
        assertTrue(maintenance.inMaintenance)
        assertTrue(broken().isEmpty())
        assertUntouched(paths.checkoutDir)

        // Once the record can be read again, the refusal clears.
        store.clear()
        assertFalse(repair.resumeOnLaunch())
        assertEquals(RepairState.Idle, repair.state.value)
        assertFalse(maintenance.inMaintenance)
    }

    @Test
    fun startAndResumeAreRefusedWhileBusy() {
        checkout()
        val repair = controller()
        assertTrue(repair.start())
        assertFalse(repair.start())
        assertFalse(repair.retry())
        // A launch while the reinstall runs shows the Repair screen without touching anything.
        assertTrue(repair.resumeOnLaunch())
        assertEquals(1, host.jobs.size)
        installSucceeds()
        assertTrue(repair.state.value is RepairState.Succeeded)
        assertFalse(repair.resumeOnLaunch())
    }

    @Test
    fun anUnexpectedErrorAfterTheMoveKeepsTheSourceAndEndsMaintenance() {
        checkout()
        afterMove = { throw IllegalStateException("bug") }
        val repair = controller()
        assertTrue(repair.start())
        val source = broken().single()
        val failed = repair.state.value as RepairState.Failed
        assertEquals(RepairFailure.UNEXPECTED_ERROR, failed.reason)
        assertEquals(source, failed.source)
        assertEquals(source.name, store.load()?.source)
        assertMaintenanceEnded()
        assertNotNull(store.load())
    }

    @Test
    fun aTrackedBranchThatIsGoneUpstreamCanBeRetriedOnTheDefaultBranch() {
        checkout(tracking = "feature-x")
        val repair = controller()
        assertFalse(repair.retryWithDefaultRef())
        assertTrue(repair.start())
        val source = broken().single()
        assertEquals("feature-x", (repair.state.value as RepairState.Running).ref)
        // install.sh cannot clone a branch deleted upstream, and leaves no partial checkout.
        host.finish(128, "fatal: Remote branch feature-x not found in upstream origin")
        val failed = repair.state.value as RepairState.Failed
        assertEquals(RepairFailure.INSTALL_FAILED, failed.reason)
        assertEquals(source, failed.source)
        assertEquals("feature-x", failed.ref)
        assertEquals("staging", failed.fallbackRef)

        // Retry keeps the branch, so a failure that is worth retrying (a lost network) never switches it.
        assertTrue(repair.retry())
        assertEquals(argsFor(source, "feature-x"), host.jobs.last().args)
        host.finish(128, "fatal: Remote branch feature-x not found in upstream origin")
        assertEquals("staging", (repair.state.value as RepairState.Failed).fallbackRef)

        // The way out survives a relaunch: the record still names the folder and the branch.
        val relaunched = controller()
        assertTrue(relaunched.resumeOnLaunch())
        val shown = relaunched.state.value as RepairState.Failed
        assertEquals(source, shown.source)
        assertEquals("feature-x", shown.ref)
        assertEquals("staging", shown.fallbackRef)

        assertTrue(relaunched.retryWithDefaultRef())
        assertEquals(argsFor(source, "staging"), host.jobs.last().args)
        assertEquals("staging", (relaunched.state.value as RepairState.Running).ref)
        assertEquals("staging", store.load()?.ref)
        // The choice is kept: a later failure retries the default and offers nothing else.
        host.finish(1, "fatal: unable to access the repository")
        val again = relaunched.state.value as RepairState.Failed
        assertEquals("staging", again.ref)
        assertNull(again.fallbackRef)
        assertFalse(relaunched.retryWithDefaultRef())
        assertTrue(relaunched.retry())
        assertEquals(argsFor(source, "staging"), host.jobs.last().args)
        installSucceeds()

        assertEquals(source, (relaunched.state.value as RepairState.Succeeded).source)
        assertEquals(listOf("feature-x", "feature-x", "staging", "staging"), host.jobs.map { it.args[it.args.indexOf("--ref") + 1] })
        assertEquals(listOf(source), broken())
        assertUntouched(source)
        assertUntouched(paths.checkoutDir)
        assertNull(store.load())
        assertMaintenanceEnded()
    }

    @Test
    fun aSuccessForgetsTheRecordBeforeTheProviderReopens() {
        checkout()
        val atEnd = mutableListOf<RepairRecord?>()
        maintenance.onEnd = { atEnd += store.load() }
        val repair = controller()
        assertTrue(repair.start())
        atEnd.clear()
        installSucceeds()
        assertTrue(repair.state.value is RepairState.Succeeded)
        // Nothing could write to the new checkout through the provider while a retry could still move it aside.
        assertEquals(listOf<RepairRecord?>(null), atEnd)
        assertEquals(1, host.startCount)
        assertMaintenanceEnded()
    }

    @Test
    fun aRecordThatCannotBeForgottenAfterSuccessKeepsTheServerStoppedUntilARetryFinishes() {
        checkout()
        val repair = controller()
        assertTrue(repair.start())
        val source = broken().single()
        val blocker = blockRecordWrites()
        installSucceeds()

        val failed = repair.state.value as RepairState.Failed
        assertEquals(RepairFailure.RECORD_UNWRITABLE, failed.reason)
        assertEquals(source, failed.source)
        assertTrue(failed.canRetry)
        assertEquals(0, host.startCount)
        assertEquals(0, deferredStarts)
        assertMaintenanceEnded()
        // The record still points a retry at the moved folder.
        val disk = store.load()!!
        assertEquals(RepairPhase.REINSTALLING, disk.phase)
        assertEquals(source.name, disk.source)

        // Once the record can be written, a retry in the same process finishes the job it already ran.
        blocker.deleteRecursively()
        assertTrue(repair.retry())
        assertEquals(source, (repair.state.value as RepairState.Succeeded).source)
        assertEquals(1, host.jobs.size)
        assertEquals(1, host.startCount)
        assertNull(store.load())
        assertEquals(listOf(source), broken())
        assertUntouched(paths.checkoutDir)
        assertMaintenanceEnded()
    }

    @Test
    fun processDeathAfterAnUnforgottenSuccessMigratesAgainAndKeepsTheNewCheckoutAside() {
        checkout()
        assertTrue(controller().start())
        val source = broken().single()
        val blocker = blockRecordWrites()
        installSucceeds()
        // The provider reopened on the failure; a file manager writes into the new checkout, then the process dies.
        val late = "data/default-user/chats/late.jsonl"
        File(paths.checkoutDir, late).writeText("written after the reinstall")
        blocker.deleteRecursively()

        val newHost = FakeRepairServerHost(events)
        val repair = controller(serverHost = newHost)
        assertTrue(repair.resumeOnLaunch())
        assertEquals(RepairFailure.INTERRUPTED, (repair.state.value as RepairState.Failed).reason)
        assertTrue(repair.retry())
        // The retry migrates from the original folder again; the late write stays in the checkout it moved aside.
        val partial = broken().single { it != source }
        assertEquals(argsFor(source, "release"), newHost.jobs.single().args)
        assertEquals("written after the reinstall", File(partial, late).readText())
        TestCheckouts.installed(paths.checkoutDir)
        File(source, "data").copyRecursively(File(paths.checkoutDir, "data"))
        newHost.finish(0)

        assertEquals(source, (repair.state.value as RepairState.Succeeded).source)
        assertFalse(File(paths.checkoutDir, late).exists())
        assertEquals(setOf(source, partial), broken().toSet())
        assertUntouched(source)
        assertUntouched(paths.checkoutDir)
    }

    @Test
    fun earlyFailuresOfARetryKeepTheMovedFolderAsTheSource() {
        checkout()
        val repair = controller()
        assertTrue(repair.start())
        val source = broken().single()
        host.finish(1, "fatal: early EOF")

        fun assertKept(reason: RepairFailure, recorded: RepairFailure = reason) {
            val failed = repair.state.value as RepairState.Failed
            assertEquals(reason, failed.reason)
            assertEquals(source, failed.source)
            assertTrue(failed.canRetry)
            assertEquals("release", failed.ref)
            val record = store.load()!!
            assertEquals(RepairPhase.FAILED, record.phase)
            assertEquals(recorded, record.failure)
            assertEquals(source.name, record.source)
            assertMaintenanceEnded()
            assertUntouched(source)
            assertEquals(listOf(source), broken())
            assertEquals(0, host.startCount)
        }

        host.stopResult = false
        assertTrue(repair.retry())
        assertKept(RepairFailure.STOP_TIMEOUT)
        host.stopResult = true

        maintenance.beginFailure = IllegalStateException("provider busy")
        assertTrue(repair.retry())
        assertKept(RepairFailure.MAINTENANCE_FAILED)
        maintenance.beginFailure = null

        visible = false
        assertTrue(repair.retry())
        assertKept(RepairFailure.NOT_VISIBLE)
        visible = true

        // A record that cannot be saved stops the retry before the server is touched; the disk keeps the last failure.
        val blocker = blockRecordWrites()
        events.clear()
        assertTrue(repair.retry())
        assertKept(RepairFailure.RECORD_UNWRITABLE, recorded = RepairFailure.NOT_VISIBLE)
        assertEquals(listOf("end", "notify"), events)
        blocker.deleteRecursively()

        assertTrue(repair.retry())
        assertEquals(argsFor(source, "release"), host.jobs.last().args)
        installSucceeds()
        assertEquals(source, (repair.state.value as RepairState.Succeeded).source)
        assertEquals(2, host.jobs.size)
    }

    /** Stands in for the process dying: an Error that no Repair step catches. */
    private class ProcessDeath : Error("process death")
}
