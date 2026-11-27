package io.github.sillybunnyteam.sillybunny.repair

import io.github.sillybunnyteam.sillybunny.runtime.RuntimePaths
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.time.Instant
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Listing, measuring and deleting moved-aside folders (plan §4.6) on real directories with real symlinks.
 * Tests run as root, so unreadable and undeletable entries are injected through [NoFollowTree]'s fault hook.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [37])
class LeftoverFoldersTest {
    @get:Rule
    val temporary = TemporaryFolder()

    private lateinit var paths: RuntimePaths
    private lateinit var store: RepairStore
    private lateinit var outside: File
    private val faults = mutableListOf<String>()

    @Before
    fun setUp() {
        paths = RuntimePaths(
            File(temporary.root, "files").apply { mkdirs() },
            File(temporary.root, "cache").apply { mkdirs() },
            File(temporary.root, "lib"),
        )
        store = RepairStore(File(temporary.root, "no_backup/repair-record.json"))
        outside = File(temporary.root, "outside").apply { mkdirs() }
        TestCheckouts.create(paths.checkoutDir, config = "dataRoot: ./data\n")
    }

    private fun leftovers(
        limits: SizeLimits = SizeLimits(),
        dispatcher: CoroutineDispatcher = Dispatchers.Unconfined,
        nanoTime: () -> Long = System::nanoTime,
        fault: (NoFollowTree.Operation, Path) -> Unit = { _, _ -> },
    ) = LeftoverFolders(paths, store, dispatcher, limits, NoFollowTree(nanoTime, fault))

    private fun folder(name: String): File = File(paths.filesDir, name).apply { mkdirs() }

    private fun file(parent: File, name: String, bytes: Int): File =
        File(parent, name).apply {
            parentFile!!.mkdirs()
            writeBytes(ByteArray(bytes) { 7 })
        }

    private fun link(at: File, target: File): Path = Files.createSymbolicLink(at.toPath(), target.toPath())

    private fun exists(file: File) = Files.exists(file.toPath(), LinkOption.NOFOLLOW_LINKS)

    @Test
    fun theListShowsOnlyMovedAsideFoldersOldestFirstWithTheirDates() {
        val newer = folder("SillyBunny.broken-20261021T000000Z-2")
        val older = folder("SillyBunny.broken-20261020T101010Z")
        val sameSecond = folder("SillyBunny.broken-20261021T000000Z")
        file(paths.filesDir, "SillyBunny.broken-20261019T000000Z", 3)
        link(File(paths.filesDir, "SillyBunny.broken-20261018T000000Z"), outside)
        folder("SillyBunny.broken-bogus")
        folder("SillyBunny.broken-20261017T000000Z-0")
        folder("runtime")

        val folders = leftovers()
        val listed = folders.list()
        assertEquals(listOf(older, sameSecond, newer), listed.map { it.file })
        assertEquals(listOf(older.name, sameSecond.name, newer.name), listed.map { it.name })
        assertEquals(Instant.parse("2026-10-20T10:10:10Z"), listed[0].movedAt)
        assertEquals(Instant.parse("2026-10-21T00:00:00Z"), listed[2].movedAt)
        assertTrue(listed.all { it.protection == null })
        assertEquals(3, folders.count())
    }

    @Test
    fun sizesCountRegularFilesAndNeverFollowLinks() {
        val target = folder("SillyBunny.broken-20261020T000000Z")
        file(target, "a.txt", 10)
        file(target, "sub/b.bin", 1_000)
        val bigOutside = file(outside, "big.bin", 5_000)
        file(outside, "dir/inner.bin", 7_000)
        link(File(target, "link-to-file"), bigOutside)
        link(File(target, "link-to-dir"), File(outside, "dir"))
        link(File(target, "sub/nested-link-dir"), File(outside, "dir"))
        link(File(target, "sub/loop"), target)

        val size = leftovers().measure(target.name)
        assertEquals(1_010L, size.bytes)
        assertEquals(7, size.entries)
        assertFalse(size.approximate)
        assertEquals(NOT_A_SIZE, leftovers().measure("SillyBunny.broken-20261020T000000Z/../outside"))
    }

    @Test
    fun theSizeWalkIsBoundedByEntriesTimeAndDepth() {
        val wide = folder("SillyBunny.broken-20261020T000000Z")
        repeat(10) { file(wide, "f$it", 1) }
        val byEntries = leftovers(limits = SizeLimits(maxEntries = 4)).measure(wide.name)
        assertEquals(FolderSize(4, 4, approximate = true), byEntries)

        var ticks = 0L
        val byTime = leftovers(
            limits = SizeLimits(maxMillis = 2_500),
            nanoTime = { (ticks++) * 1_000_000_000L },
        ).measure(wide.name)
        assertEquals(FolderSize(2, 2, approximate = true), byTime)

        val deep = folder("SillyBunny.broken-20261021T000000Z")
        file(deep, "a/top.txt", 3)
        file(deep, "a/b/c/d/deep.txt", 100)
        assertEquals(FolderSize(3, 3, approximate = true), leftovers(limits = SizeLimits(maxDepth = 2)).measure(deep.name))
        assertEquals(FolderSize(103, 6, approximate = false), leftovers().measure(deep.name))
    }

    @Test
    fun anUnreadableEntryIsSkippedAndTheWalkGoesOn() {
        val target = folder("SillyBunny.broken-20261020T000000Z")
        file(target, "a-locked/hidden.bin", 500)
        file(target, "b.txt", 20)
        file(target, "c/inner.txt", 30)
        file(target, "d-unstatable.txt", 40)
        val size = leftovers(fault = { operation, path ->
            if (operation == NoFollowTree.Operation.OPEN_DIRECTORY && path.toString() == "a-locked") throw IOException("EACCES")
            if (operation == NoFollowTree.Operation.READ_ATTRIBUTES && path.toString() == "d-unstatable.txt") throw IOException("EACCES")
        }).measure(target.name)
        assertEquals(50L, size.bytes)
        assertEquals(5, size.entries)
        assertTrue(size.approximate)
    }

    @Test
    fun deletingRemovesLinksNeverTheirTargets() {
        val target = folder("SillyBunny.broken-20261020T000000Z")
        file(target, "data/default-user/chats/chat.jsonl", 100)
        file(target, ".git/objects/pack/pack.idx", 50)
        File(target, ".git/objects/pack/pack.idx").setReadOnly()
        val keepFile = file(outside, "keep.txt", 5)
        val keepDir = File(outside, "keep-dir").apply { mkdirs() }
        val keepInner = file(keepDir, "inner.txt", 6)
        link(File(target, "link-to-file"), keepFile)
        link(File(target, "link-to-dir"), keepDir)
        link(File(target, "data/nested-link-dir"), keepDir)
        link(File(target, "data/default-user/up"), paths.filesDir)
        link(File(target, "dangling"), File(outside, "missing"))

        val folders = leftovers()
        val result = folders.deleteNow(target.name)
        // 13 entries plus the folder itself.
        assertEquals(DeleteResult.Deleted(14), result)
        assertFalse(exists(target))
        assertEquals(5L, keepFile.length())
        assertEquals(6L, keepInner.length())
        assertTrue(keepDir.isDirectory)
        assertEquals("user data", File(paths.checkoutDir, "data/default-user/chats/chat.jsonl").readText())
        assertTrue(paths.filesDir.isDirectory)
        assertEquals(0, folders.count())
    }

    @Test
    fun aDirectorySwappedForALinkMidDeleteIsNotFollowed() {
        val target = folder("SillyBunny.broken-20261020T000000Z")
        file(target, "sub/inside.txt", 4)
        file(target, "other.txt", 4)
        val victim = File(outside, "victim").apply { mkdirs() }
        val victimFile = file(victim, "precious.txt", 9)
        val result = leftovers(fault = { operation, path ->
            if (operation == NoFollowTree.Operation.OPEN_DIRECTORY && path.toString() == "sub") {
                // Another writer replaces the directory with a link to somewhere outside, right before it opens.
                Files.move(File(target, "sub").toPath(), File(outside, "moved-sub").toPath())
                link(File(target, "sub"), victim)
            }
        }).deleteNow(target.name)

        val partial = result as DeleteResult.Partial
        assertEquals(listOf("sub", "."), partial.examples)
        assertEquals(2, partial.remainingEntries)
        assertEquals(9L, victimFile.length())
        assertTrue(File(outside, "moved-sub/inside.txt").isFile)
        assertTrue(Files.isSymbolicLink(File(target, "sub").toPath()))
        assertFalse(File(target, "other.txt").exists())
    }

    @Test
    fun unreadableAndUndeletableEntriesAreReportedNotRetried() {
        val target = folder("SillyBunny.broken-20261020T000000Z")
        file(target, "locked/secret.txt", 3)
        file(target, "nested/stuck.txt", 3)
        file(target, "nested/gone.txt", 3)
        file(target, "plain.txt", 3)
        val result = leftovers(fault = { operation, path ->
            faults += "$operation $path"
            if (operation == NoFollowTree.Operation.OPEN_DIRECTORY && path.toString() == "locked") throw IOException("EACCES")
            if (operation == NoFollowTree.Operation.DELETE && path.toString() == "nested/stuck.txt") throw IOException("EPERM")
        }).deleteNow(target.name)

        val partial = result as DeleteResult.Partial
        // Removed: gone.txt and plain.txt. Left: locked/ (never opened), nested/stuck.txt, nested/ and the folder.
        assertEquals(2, partial.removedEntries)
        assertEquals(4, partial.remainingEntries)
        assertEquals(setOf("locked", "nested/stuck.txt", "nested", "."), partial.examples.toSet())
        assertEquals(".", partial.examples.last())
        assertTrue(partial.examples.indexOf("nested/stuck.txt") < partial.examples.indexOf("nested"))
        assertTrue(File(target, "locked/secret.txt").isFile)
        assertTrue(File(target, "nested/stuck.txt").isFile)
        assertFalse(File(target, "nested/gone.txt").exists())
        assertFalse(File(target, "plain.txt").exists())
        // Each failing operation was tried once; nothing was retried.
        assertEquals(1, faults.count { it == "OPEN_DIRECTORY locked" })
        assertEquals(1, faults.count { it == "DELETE nested/stuck.txt" })
        assertEquals(1, faults.count { it == "DELETE nested" })
        assertEquals(1, faults.count { it == "DELETE " })
    }

    @Test
    fun theFolderAnUnfinishedRepairMigratesFromCannotBeDeleted() {
        val source = folder("SillyBunny.broken-20261020T000000Z")
        val other = folder("SillyBunny.broken-20261021T000000Z")
        file(source, "data/default-user/chats/chat.jsonl", 10)
        store.save(
            RepairRecord(
                RepairPhase.FAILED,
                Instant.parse("2026-10-20T00:00:00Z"),
                source = source.name,
                ref = "release",
                failure = RepairFailure.INSTALL_FAILED,
            ),
        )
        val folders = leftovers()
        assertEquals(DeleteRefusal.REPAIR_SOURCE, folders.list().single { it.file == source }.protection)
        assertNull(folders.list().single { it.file == other }.protection)
        assertEquals(DeleteResult.Refused(DeleteRefusal.REPAIR_SOURCE), folders.deleteNow(source.name))
        assertTrue(File(source, "data/default-user/chats/chat.jsonl").isFile)

        // A rename in flight has no source name yet: every folder it could have made is protected.
        store.save(
            RepairRecord(
                RepairPhase.MOVING_ASIDE,
                Instant.parse("2026-10-21T00:00:00Z"),
                preexisting = listOf(source.name),
                movingAt = Instant.parse("2026-10-20T00:00:00.500Z"),
            ),
        )
        val made = folder("SillyBunny.broken-20261020T000000Z-2")
        assertEquals(DeleteRefusal.REPAIR_SOURCE, folders.refusal(made.name))
        assertNull(folders.refusal(source.name))
        assertNull(folders.refusal(other.name))

        // An unreadable record could name any folder.
        File(temporary.root, "no_backup/repair-record.json").writeText("{")
        assertTrue(folders.list().all { it.protection == DeleteRefusal.REPAIR_SOURCE })
        assertEquals(DeleteResult.Refused(DeleteRefusal.REPAIR_SOURCE), folders.deleteNow(other.name))
        assertTrue(other.isDirectory)
    }

    @Test
    fun aFolderHoldingTheCurrentDataRootOrConfigCannotBeDeleted() {
        val holder = folder("SillyBunny.broken-20261020T000000Z")
        val free = folder("SillyBunny.broken-20261021T000000Z")
        file(holder, "data/default-user/chats/chat.jsonl", 10)
        val holderConfig = file(holder, "config.yaml", 4)
        val checkout = paths.checkoutDir
        val config = File(checkout, "config.yaml")
        val cases = listOf<Pair<String, () -> Unit>>(
            "absolute root" to { config.writeText("dataRoot: ${holder.path}/data\n") },
            "absolute root with a dot" to { config.writeText("dataRoot: \"${paths.filesDir.path}/./${holder.name}\"\n") },
            "relative root climbing into it" to { config.writeText("dataRoot: ../${holder.name}/data\n") },
            "config linked into it" to {
                Files.delete(config.toPath())
                link(config, holderConfig)
            },
            "data linked into it" to {
                deleteNoFollow(File(checkout, "data").toPath())
                link(File(checkout, "data"), File(holder, "data"))
            },
            "checkout linked into it" to {
                Files.move(checkout.toPath(), File(holder, "nested-checkout").toPath())
                link(checkout, File(holder, "nested-checkout"))
            },
        )
        val folders = leftovers()
        for ((label, arrange) in cases) {
            deleteNoFollow(checkout.toPath())
            TestCheckouts.create(checkout, config = "dataRoot: ./data\n")
            assertNull(label, folders.refusal(holder.name))
            arrange()
            assertEquals(label, DeleteRefusal.HOLDS_DATA_ROOT, folders.refusal(holder.name))
            assertEquals(label, DeleteResult.Refused(DeleteRefusal.HOLDS_DATA_ROOT), folders.deleteNow(holder.name))
            assertNull(label, folders.refusal(free.name))
            assertTrue(label, File(holder, "data/default-user/chats/chat.jsonl").isFile)
        }
    }

    /** Deletes a tree without following links; a test helper, never used on data a test must keep. */
    private fun deleteNoFollow(path: Path) {
        if (Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS)) {
            Files.list(path).use { it.toList() }.forEach(::deleteNoFollow)
        }
        Files.deleteIfExists(path)
    }

    @Test
    fun anUnknownDataRootProtectsEveryFolder() {
        val target = folder("SillyBunny.broken-20261020T000000Z")
        File(paths.checkoutDir, "config.yaml").writeBytes(byteArrayOf(0xC3.toByte(), 0x28))
        val folders = leftovers()
        assertEquals(DeleteRefusal.DATA_ROOT_UNKNOWN, folders.list().single().protection)
        assertEquals(DeleteResult.Refused(DeleteRefusal.DATA_ROOT_UNKNOWN), folders.deleteNow(target.name))
        assertTrue(target.isDirectory)
        // Without a checkout the default root cannot be inside a leftover.
        paths.checkoutDir.deleteRecursively()
        assertNull(folders.refusal(target.name))
    }

    @Test
    fun onlyAMovedAsideFolderDirectlyInFilesCanBeDeleted() {
        val real = folder("SillyBunny.broken-20261020T000000Z")
        file(real, "x.txt", 1)
        link(File(paths.filesDir, "SillyBunny.broken-20261021T000000Z"), outside)
        file(outside, "keep.txt", 2)
        val folders = leftovers()
        for (name in listOf(
            "SillyBunny",
            "SillyBunny.broken-20261021T000000Z",
            "SillyBunny.broken-20261022T000000Z",
            "../outside",
            "SillyBunny.broken-20261020T000000Z/../SillyBunny",
            "runtime",
            "",
            ".",
        )) {
            assertEquals(name, DeleteResult.Refused(DeleteRefusal.NOT_A_LEFTOVER), folders.deleteNow(name))
        }
        assertTrue(File(outside, "keep.txt").isFile)
        assertTrue(File(paths.checkoutDir, "package.json").isFile)
        assertTrue(File(real, "x.txt").isFile)
    }

    @Test
    fun nothingIsDeletedWithoutAnExplicitDelete() {
        val a = folder("SillyBunny.broken-20261020T000000Z")
        val b = folder("SillyBunny.broken-20261021T000000Z")
        file(a, "data/a.txt", 3)
        file(b, "data/b.txt", 4)
        val folders = leftovers()
        folders.refresh()
        folders.list()
        folders.count()
        folders.measure(a.name)
        folders.refusal(b.name)
        val state = folders.state.value
        assertFalse(state.loading)
        assertEquals(listOf(a.name, b.name), state.folders.map { it.name })
        assertEquals(FolderSize(3, 2, false), state.sizes[a.name])
        assertEquals(FolderSize(4, 2, false), state.sizes[b.name])
        assertTrue(File(a, "data/a.txt").isFile)
        assertTrue(File(b, "data/b.txt").isFile)
    }

    @Test
    fun deleteRunsOffTheCallerOneAtATimeAndReportsItsOutcome() {
        val a = folder("SillyBunny.broken-20261020T000000Z")
        val b = folder("SillyBunny.broken-20261021T000000Z")
        file(a, "a.txt", 3)
        val dispatcher = StandardTestDispatcher()
        val folders = leftovers(dispatcher = dispatcher)
        folders.refresh()
        dispatcher.scheduler.runCurrent()
        assertEquals(2, folders.state.value.folders.size)

        assertTrue(folders.delete(a.name))
        assertFalse(folders.delete(b.name))
        assertEquals(a.name, folders.state.value.deleting)
        // Nothing has run on the caller's thread yet.
        assertTrue(File(a, "a.txt").isFile)
        dispatcher.scheduler.runCurrent()
        val state = folders.state.value
        assertNull(state.deleting)
        assertEquals(DeleteOutcome(a.name, DeleteResult.Deleted(2)), state.lastOutcome)
        assertEquals(listOf(b.name), state.folders.map { it.name })
        assertFalse(a.exists())
        assertTrue(b.isDirectory)
        folders.clearOutcome()
        assertNull(folders.state.value.lastOutcome)
    }

    private companion object {
        val NOT_A_SIZE = FolderSize(0, 0, approximate = true)
    }
}
