package io.github.sillybunnyteam.sillybunny.runtime

import io.github.sillybunnyteam.sillybunny.runtime.TestZip.Item
import io.github.sillybunnyteam.sillybunny.runtime.TestZip.file
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.nio.file.Files

class NpmArchiveTest {
    @get:Rule
    val temporary = TemporaryFolder()

    private val good = listOf(
        file(".npmrc", "registry=lorum\n"),
        file("package.json", "{\"name\":\"npm\"}", TestZip.STORED),
        Item("bin/"),
        file("bin/npm-cli.js", "require('../lib/cli.js')\n"),
        file("lib/cli.js", "module.exports = 1\n".repeat(50)),
        file("node_modules/@npmcli/arborist/index.js", "x"),
        file("empty.txt", ""),
    )

    @Test
    fun extractsEveryEntryWithEachSyncMode() {
        val bytes = TestZip.build(good)
        val archive = open(bytes, good)
        assertEquals(6, archive.files)
        NpmSyncMode.entries.forEach { mode ->
            val target = File(temporary.root, "npm-$mode")
            archive.extractTo(target, mode)
            assertEquals("registry=lorum\n", File(target, ".npmrc").readText())
            assertEquals("module.exports = 1\n".repeat(50), File(target, "lib/cli.js").readText())
            assertEquals(0L, File(target, "empty.txt").length())
            assertTrue(File(target, "node_modules/@npmcli/arborist/index.js").isFile)
            assertEquals(6, target.walkTopDown().count { it.isFile })
        }
    }

    @Test
    fun digestDescribesTheContent() {
        val first = open(TestZip.build(good), good)
        val changed = good.map { if (it.name == "lib/cli.js") file("lib/cli.js", "changed") else it }
        assertNotEquals(first.digest, open(TestZip.build(changed), changed).digest)
        // Entry order does not matter, only paths, sizes and CRCs.
        assertEquals(first.digest, open(TestZip.build(good.reversed()), good).digest)
    }

    @Test
    fun hashAndSizeAreCheckedBeforeParsing() {
        val bytes = TestZip.build(good)
        val record = record(bytes, good)
        assertRejected { NpmArchive.open(bytes, record.copy(sha256 = "0".repeat(64))) }
        assertRejected { NpmArchive.open(bytes, record.copy(size = record.size + 1)) }
        assertRejected { NpmArchive.open(bytes, record.copy(files = record.files + 1)) }
        assertRejected { NpmArchive.open(bytes, record.copy(contentBytes = record.contentBytes - 1)) }
        // Garbage that matches its own record still has to be a ZIP.
        val garbage = ByteArray(100) { it.toByte() }
        assertRejected { NpmArchive.open(garbage, TestZip.record(garbage, 1, 1)) }
    }

    @Test
    fun unsafePathsAreRejected() {
        listOf(
            "/etc/passwd", "../outside", "lib/../../outside", "./x", "a//b", "a\\b", "lib/", "sp ace", "tab\tname",
            "nul\u0000", "café", "a/./b", "trailing/..",
        ).forEach { name ->
            val items = listOf(file("ok.js", "1"), file(name, "x"))
            assertRejected(name) { NpmArchive.parse(TestZip.build(items)) }
        }
        assertRejected { NpmArchive.parse(TestZip.build(file("x".repeat(1025), "x"))) }
        assertRejected { NpmArchive.parse(TestZip.build(file(List(65) { "d" }.joinToString("/"), "x"))) }
    }

    @Test
    fun duplicatesAndFileDirectoryConflictsAreRejected() {
        assertRejected { NpmArchive.parse(TestZip.build(file("a.js", "1"), file("a.js", "2"))) }
        assertRejected { NpmArchive.parse(TestZip.build(Item("lib/"), Item("lib/"))) }
        assertRejected { NpmArchive.parse(TestZip.build(file("lib", "1"), Item("lib/"))) }
        assertRejected { NpmArchive.parse(TestZip.build(file("lib", "1"), file("lib/cli.js", "2"))) }
    }

    @Test
    fun linksAndSpecialFilesAreRejected() {
        assertRejected { NpmArchive.parse(TestZip.build(Item("link", "target".toByteArray(), mode = TestZip.LINK_MODE))) }
        assertRejected { NpmArchive.parse(TestZip.build(Item("fifo", mode = TestZip.FIFO_MODE))) }
        assertRejected { NpmArchive.parse(TestZip.build(Item("dir-as-file", mode = TestZip.DIRECTORY_MODE))) }
        assertRejected { NpmArchive.parse(TestZip.build(Item("file-as-dir/", mode = TestZip.FILE_MODE))) }
        // A mode-less entry (as Windows tools write) is a plain file.
        assertEquals(1, NpmArchive.parse(TestZip.build(Item("plain", "x".toByteArray(), mode = 0))).files)
    }

    @Test
    fun unsupportedEntriesAreRejected() {
        assertRejected { NpmArchive.parse(TestZip.build(Item("enc.js", "x".toByteArray(), flags = 0x0001))) }
        assertRejected { NpmArchive.parse(TestZip.build(Item("strong.js", "x".toByteArray(), flags = 0x0040))) }
        assertRejected { NpmArchive.parse(TestZip.build(Item("bzip2.js", "x".toByteArray(), method = 12))) }
        assertRejected { NpmArchive.parse(TestZip.build(Item("zip64.js", "x".toByteArray(), size = 0xFFFFFFFFL))) }
        assertRejected { NpmArchive.parse(TestZip.build(Item("stored.js", "abc".toByteArray(), method = TestZip.STORED, size = 4))) }
        assertRejected { NpmArchive.parse(TestZip.build(Item("local.js", "x".toByteArray(), localName = "other.js"))) }
        assertRejected { NpmArchive.parse(TestZip.build(Item("dir/", "x".toByteArray(), method = TestZip.STORED))) }
    }

    @Test
    fun oversizedTotalsAreRejected() {
        // Declared sizes count, so a small archive cannot claim to unpack into more than the limit.
        val bomb = Item("bomb.bin", ByteArray(16), size = NpmArchive.MAX_CONTENT_BYTES + 1)
        assertRejected { NpmArchive.parse(TestZip.build(bomb)) }
        val halves = listOf(
            Item("a.bin", ByteArray(16), size = NpmArchive.MAX_CONTENT_BYTES / 2 + 1),
            Item("b.bin", ByteArray(16), size = NpmArchive.MAX_CONTENT_BYTES / 2 + 1),
        )
        assertRejected { NpmArchive.parse(TestZip.build(halves)) }
        val many = (0..NpmArchive.MAX_FILES).map { Item("f$it", method = TestZip.STORED) }
        assertRejected { NpmArchive.parse(TestZip.build(many)) }
    }

    @Test
    fun malformedContainersAreRejected() {
        val bytes = TestZip.build(good)
        assertRejected { NpmArchive.parse(bytes + byteArrayOf(0)) }
        assertRejected { NpmArchive.parse(TestZip.build(good, entryCount = good.size - 1)) }
        assertRejected { NpmArchive.parse(bytes.copyOf(bytes.size - 1)) }
        assertRejected { NpmArchive.parse(ByteArray(0)) }
        val shifted = bytes.copyOf().also { it[it.size - 6] = (it[it.size - 6] + 1).toByte() }
        assertRejected { NpmArchive.parse(shifted) }
    }

    @Test
    fun corruptContentFailsExtraction() {
        val wrongCrc = listOf(Item("crc.js", "content".toByteArray(), crc = 1))
        assertRejected { extract(wrongCrc) }
        val longer = listOf(Item("long.js", "content".toByteArray(), size = 6))
        assertRejected { extract(longer) }
        val shorter = listOf(Item("short.js", "content".toByteArray(), size = 8))
        assertRejected { extract(shorter) }
        val deflated = TestZip.deflate("some longer content to deflate".toByteArray())
        val truncated = listOf(
            Item("cut.js", "some longer content to deflate".toByteArray(), payload = deflated.copyOf(deflated.size - 3)),
        )
        assertRejected { extract(truncated) }
        val padded = listOf(
            Item("tail.js", "some longer content to deflate".toByteArray(), payload = deflated + byteArrayOf(1, 2, 3)),
        )
        assertRejected { extract(padded) }
    }

    @Test
    fun extractionNeedsAFreshTarget() {
        val archive = open(TestZip.build(good), good)
        val target = temporary.newFolder("existing")
        assertThrows(java.nio.file.FileAlreadyExistsException::class.java) { archive.extractTo(target, NpmSyncMode.VERIFIED) }
        val planted = File(temporary.root, "planted")
        Files.createDirectories(File(planted, "bin").toPath())
        Files.createSymbolicLink(File(planted, "bin/npm-cli.js").toPath(), File(temporary.root, "victim").toPath())
        assertThrows(java.nio.file.FileAlreadyExistsException::class.java) { archive.extractTo(planted, NpmSyncMode.VERIFIED) }
        assertFalse(File(temporary.root, "victim").exists())
    }

    private fun extract(items: List<Item>) {
        val archive = NpmArchive.parse(TestZip.build(items))
        archive.extractTo(File(temporary.root, "x-" + System.nanoTime()), NpmSyncMode.EACH_FILE)
    }

    private fun record(bytes: ByteArray, items: List<Item>): NpmArchiveRecord {
        val files = items.filterNot { it.name.endsWith('/') }
        return TestZip.record(bytes, files.size, files.sumOf { it.data.size.toLong() })
    }

    private fun open(bytes: ByteArray, items: List<Item>) = NpmArchive.open(bytes, record(bytes, items))

    private fun assertRejected(label: String = "", block: () -> Unit) {
        val error = assertThrows(label, RuntimeLayoutException::class.java) { block() }
        assertEquals(label, RuntimeLayoutException.Reason.NPM_ARCHIVE, error.reason)
        assertEquals("TODO(copy)", error.message)
    }
}
