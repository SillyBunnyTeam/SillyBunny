package io.github.sillybunnyteam.sillybunny.checkout

import io.github.sillybunnyteam.sillybunny.runtime.RuntimePaths
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.time.Instant

class BrokenCheckoutsTest {
    @get:Rule
    val temporary = TemporaryFolder()

    private val now: Instant = Instant.parse("2026-10-21T07:08:09Z")

    private fun paths(): RuntimePaths {
        val root = temporary.root
        return RuntimePaths(File(root, "files"), File(root, "cache"), File(root, "lib")).also {
            it.filesDir.mkdirs()
        }
    }

    @Test
    fun movesTheCheckoutAsideWithItsContents() {
        val paths = paths()
        File(paths.checkoutDir, "data").mkdirs()
        File(paths.checkoutDir, "data/chat.jsonl").writeText("kept")

        val moved = BrokenCheckouts.moveAside(paths, now)

        assertEquals("SillyBunny.broken-20261021T070809Z", moved.name)
        assertFalse(paths.checkoutDir.exists())
        assertEquals("kept", File(moved, "data/chat.jsonl").readText())
    }

    @Test
    fun neverReusesAnExistingName() {
        val paths = paths()
        val existing = paths.brokenCheckout("20261021T070809Z").also { it.mkdirs() }
        File(existing, "old.txt").writeText("old")
        paths.checkoutDir.mkdirs()

        val moved = BrokenCheckouts.moveAside(paths, now)

        assertEquals("SillyBunny.broken-20261021T070809Z-2", moved.name)
        assertEquals("old", File(existing, "old.txt").readText())
    }

    @Test
    fun refusesAMissingOrSymlinkedCheckout() {
        val paths = paths()
        assertMoveFails(paths)

        val elsewhere = temporary.newFolder("elsewhere")
        Files.createSymbolicLink(paths.checkoutDir.toPath(), elsewhere.toPath())
        assertMoveFails(paths)
        assertTrue(Files.isSymbolicLink(paths.checkoutDir.toPath()))
        assertTrue(BrokenCheckouts.list(paths).isEmpty())
    }

    @Test
    fun listsOnlyMovedAsideDirectoriesInOrder() {
        val paths = paths()
        for (suffix in listOf("20261021T070809Z-10", "20261021T070809Z-2", "20261021T070809Z", "20251231T235959Z")) {
            paths.brokenCheckout(suffix).mkdirs()
        }
        File(paths.filesDir, "SillyBunny.broken-20261021T000000Z.txt").writeText("not a folder")
        File(paths.filesDir, "SillyBunny.broken-notes").mkdirs()
        paths.brokenCheckout("20261021T000001Z").writeText("a file with a matching name")
        Files.createSymbolicLink(
            paths.brokenCheckout("20261021T000002Z").toPath(),
            temporary.newFolder("target").toPath(),
        )

        val names = BrokenCheckouts.list(paths).map { it.name }

        assertEquals(
            listOf(
                "SillyBunny.broken-20251231T235959Z",
                "SillyBunny.broken-20261021T070809Z",
                "SillyBunny.broken-20261021T070809Z-2",
                "SillyBunny.broken-20261021T070809Z-10",
            ),
            names,
        )
        assertTrue(BrokenCheckouts.isBrokenCheckoutName("SillyBunny.broken-20261021T070809Z-2"))
        assertFalse(BrokenCheckouts.isBrokenCheckoutName("SillyBunny.broken-20261021T070809Z-0"))
        assertFalse(BrokenCheckouts.isBrokenCheckoutName("SillyBunny"))
    }

    private fun assertMoveFails(paths: RuntimePaths) {
        try {
            BrokenCheckouts.moveAside(paths, now)
            fail("moveAside should refuse")
        } catch (_: IOException) {
        }
    }
}
