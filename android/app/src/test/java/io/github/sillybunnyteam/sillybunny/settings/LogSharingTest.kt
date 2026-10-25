package io.github.sillybunnyteam.sillybunny.settings

import android.app.Application
import android.content.Intent
import android.net.Uri
import androidx.core.content.IntentCompat
import androidx.test.core.app.ApplicationProvider
import io.github.sillybunnyteam.sillybunny.server.CrashRecords
import io.github.sillybunnyteam.sillybunny.server.LaunchTokens
import io.github.sillybunnyteam.sillybunny.server.RedactingLineSplitter
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import java.io.File
import java.nio.file.Files
import java.time.Instant

@RunWith(RobolectricTestRunner::class)
class LogSharingTest {
    private val context = ApplicationProvider.getApplicationContext<Application>()
    private val now = Instant.parse("2026-10-21T06:30:15Z")
    private val token = LaunchTokens.generate()
    private lateinit var logs: File

    @Before
    fun prepare() {
        logs = File(context.filesDir, "logs").apply {
            deleteRecursively()
            mkdirs()
        }
        LogSharing.snapshotDirectory(context).deleteRecursively()
        CrashRecords.directory(context).deleteRecursively()
        resetFileProviderRoots()
    }

    private fun log(name: String, text: String) = File(logs, name).apply { writeText(text) }

    private fun snapshots() = LogSharing.snapshotDirectory(context).listFiles().orEmpty().map { it.name }.sorted()

    private fun crashRecord(at: Instant, line: String): File = CrashRecords(CrashRecords.directory(context)).write(
        CrashRecords.Crash(
            epochMillis = at.toEpochMilli(),
            exitCode = 139,
            uptimeMillis = 5_000,
            launchedEpochMillis = at.toEpochMilli() - 5_000,
            token = token,
            serverLog = listOf(line),
            nativeLog = listOf("F/nodejs: fatal $token"),
        ),
    )!!

    @Test
    fun theSnapshotStartsWithTheCrashRecordsNewestFirst() {
        val older = crashRecord(now.minusSeconds(120), "older crash cookie=$token")
        val newer = crashRecord(now.minusSeconds(60), "newer crash")

        val snapshot = LogSharing.createSnapshot(context, listOf(log("server.log", "one\n")), now)!!

        val text = snapshot.readText()
        assertEquals(newer.readText() + older.readText() + "one\n", text)
        assertTrue(text.contains("older crash cookie=${RedactingLineSplitter.REDACTED}"))
        assertTrue(text.contains("exit=139 signal=11 SIGSEGV"))
        assertFalse(text.contains(token))
    }

    @Test
    fun crashRecordsAloneAreShared() = runBlocking {
        val record = crashRecord(now.minusSeconds(60), "crashed")

        assertEquals(record.readText(), LogSharing.createSnapshot(context, emptyList(), now)!!.readText())
        assertEquals(LogShareResult.SHARED, LogSharing.share(context, { emptyList() }, Dispatchers.IO))
        assertEquals(1, snapshots().size)
    }

    @Test
    fun recordsGoInWholeWithinHalfTheCapAndTheLogsGetTheRest() {
        val directory = File(context.filesDir, "record-input").apply { mkdirs() }
        val newest = File(directory, "crash-000002-20261021T063000.000Z.txt").apply { writeText("r".repeat(29) + "\n") }
        val older = File(directory, "crash-000001-20261021T062000.000Z.txt").apply { writeText("s".repeat(29) + "\n") }
        val server = log("server.log", "aaaa\n".repeat(20))

        val snapshot = LogSharing.createSnapshot(
            context,
            listOf(server),
            now,
            maxBytes = 100,
            records = listOf(newest, older),
        )!!

        // The newest record's 30 bytes fit in half the cap; the older one's do not, so the logs get the other 70.
        assertEquals(newest.readText() + "aaaa\n".repeat(14), snapshot.readText())
        // A link is skipped; a record too big for half the cap ends the records, so none older jumps the queue.
        val link = File(directory, "crash-000004-20261021T063200.000Z.txt").toPath()
        Files.createSymbolicLink(link, newest.toPath())
        val big = File(directory, "crash-000003-20261021T063100.000Z.txt").apply { writeText("b".repeat(60) + "\n") }
        val logsOnly = LogSharing.createSnapshot(
            context,
            listOf(server),
            now,
            maxBytes = 100,
            records = listOf(link.toFile(), big, newest),
        )!!
        assertEquals("aaaa\n".repeat(20), logsOnly.readText())
    }

    @Test
    fun snapshotConcatenatesTheListedFilesOldestFirst() {
        val files = listOf(log("server.log.2", "one\n"), log("server.log.1", "two\n"), log("server.log", "three\n"))
        val snapshot = LogSharing.createSnapshot(context, files, now)!!
        assertEquals("one\ntwo\nthree\n", snapshot.readText())
        assertEquals("SillyBunny-logs-20261021T063015Z.txt", snapshot.name)
        assertEquals(LogSharing.snapshotDirectory(context), snapshot.parentFile)
        assertTrue(LogSharing.isSnapshotName(snapshot.name))
    }

    @Test
    fun theCapKeepsTheNewestBytesAndStartsAtALine() {
        val old = log("server.log.1", "aaaa\nbbbb\n")
        val new = log("server.log", "cccc\ndddd\n")
        // 13 bytes reach back into the older file mid-line ("bb\n"); the cut moves to the next line start.
        val snapshot = LogSharing.createSnapshot(context, listOf(old, new), now, maxBytes = 13)!!
        assertEquals("cccc\ndddd\n", snapshot.readText())
        // A cut that lands exactly on a line start keeps that line.
        val exact = LogSharing.createSnapshot(context, listOf(old, new), now, maxBytes = 15)!!
        assertEquals("bbbb\ncccc\ndddd\n", exact.readText())
        // The newest file alone is cut too when it exceeds the cap.
        val newest = LogSharing.createSnapshot(context, listOf(old, new), now, maxBytes = 7)!!
        assertEquals("dddd\n", newest.readText())
    }

    @Test
    fun aPartialLineThatIsAllThereIsStartsAtACharacter() {
        // "é" is two bytes; a 10-byte cap cuts after its first byte, and the only newline ends the file.
        val only = log("server.log", "aé" + "x".repeat(8) + "\n")
        val snapshot = LogSharing.createSnapshot(context, listOf(only), now, maxBytes = 10)!!
        assertEquals("x".repeat(8) + "\n", snapshot.readText())
    }

    @Test
    fun theDefaultCapIsFourMebibytesOfTheNewestContent() {
        assertEquals(4L * 1024 * 1024, LogSharing.MAX_SNAPSHOT_BYTES)
        val line = "x".repeat(1023) + "\n"
        val old = File(logs, "server.log.1").apply { writeText(line.repeat(3 * 1024)) }
        val new = File(logs, "server.log").apply { writeText(line.repeat(2 * 1024 - 1) + "newest\n") }
        val snapshot = LogSharing.createSnapshot(context, listOf(old, new), now)!!
        assertTrue(snapshot.length() <= LogSharing.MAX_SNAPSHOT_BYTES)
        assertTrue(snapshot.length() > LogSharing.MAX_SNAPSHOT_BYTES - line.length)
        val text = snapshot.readText()
        assertTrue(text.endsWith("newest\n"))
        assertTrue(text.startsWith("x"))
    }

    @Test
    fun onlyTheListedRegularFilesAreRead() {
        val listed = log("server.log", "listed\n")
        log("secret.log", "unlisted\n")
        val outside = File(context.filesDir, "outside.txt").apply { writeText("outside\n") }
        val link = File(logs, "link.log").toPath()
        Files.createSymbolicLink(link, outside.toPath())
        val directory = File(logs, "folder.log").apply { mkdirs() }
        val missing = File(logs, "missing.log")
        val snapshot = LogSharing.createSnapshot(context, listOf(link.toFile(), directory, missing, listed), now)!!
        assertEquals("listed\n", snapshot.readText())
    }

    @Test
    fun emptyLogsGiveNoSnapshot() {
        assertNull(LogSharing.createSnapshot(context, emptyList(), now))
        assertNull(LogSharing.createSnapshot(context, listOf(log("server.log", "")), now))
        assertEquals(emptyList<String>(), snapshots())
    }

    @Test
    fun eachSnapshotDeletesEarlierOnesButNothingElse() {
        val directory = LogSharing.snapshotDirectory(context).apply { mkdirs() }
        File(directory, "SillyBunny-logs-20260101T000000Z.txt").writeText("old")
        File(directory, "SillyBunny-logs-20260101T000000Z-2.txt.partial").writeText("interrupted")
        File(directory, "keep.txt").writeText("not a snapshot")
        val shared = File(context.cacheDir, "shared/other.txt").apply { writeText("another owner") }
        val snapshot = LogSharing.createSnapshot(context, listOf(log("server.log", "line\n")), now)!!
        assertEquals(listOf("SillyBunny-logs-20261021T063015Z.txt", "keep.txt"), snapshots())
        assertTrue(shared.exists())
        assertEquals("line\n", snapshot.readText())
        assertEquals(1, LogSharing.deleteSnapshots(context))
        assertEquals(listOf("keep.txt"), snapshots())
    }

    @Test
    fun theShareIntentGrantsReadAccessThroughTheFileProvider() {
        val snapshot = LogSharing.createSnapshot(context, listOf(log("server.log", "shared line\n")), now)!!
        val chooser = LogSharing.shareIntent(context, snapshot, "title")
        assertEquals(Intent.ACTION_CHOOSER, chooser.action)
        val send = IntentCompat.getParcelableExtra(chooser, Intent.EXTRA_INTENT, Intent::class.java)!!
        assertEquals(Intent.ACTION_SEND, send.action)
        assertEquals("text/plain", send.type)
        assertTrue(send.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION != 0)
        assertEquals(0, send.flags and Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        val uri = IntentCompat.getParcelableExtra(send, Intent.EXTRA_STREAM, Uri::class.java)!!
        assertEquals("content", uri.scheme)
        assertEquals("${context.packageName}.files", uri.authority)
        assertEquals("/shared/logs/${snapshot.name}", uri.path)
        assertEquals(1, send.clipData!!.itemCount)
        assertEquals(uri, send.clipData!!.getItemAt(0).uri)
        assertEquals("text/plain", send.clipData!!.description.getMimeType(0))
        // The chooser carries the same grant, so the share sheet itself can read the preview.
        assertTrue(chooser.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION != 0)
        assertEquals(uri, chooser.clipData!!.getItemAt(0).uri)
        // The URI resolves to the snapshot's bytes through the declared provider.
        val bytes = context.contentResolver.openInputStream(uri)!!.use { it.readBytes() }
        assertArrayEquals(snapshot.readBytes(), bytes)
    }

    @Test
    fun shareOpensTheChooserFromAnyContext() = runBlocking {
        val host = FakeServerHost(logs = listOf(log("server.log", "line\n")))
        assertEquals(LogShareResult.SHARED, LogSharing.share(context, host, Dispatchers.IO))
        val started = shadowOf(context).nextStartedActivity
        assertNotNull(started)
        assertEquals(Intent.ACTION_CHOOSER, started.action)
        assertTrue("a non-activity context needs a new task", started.flags and Intent.FLAG_ACTIVITY_NEW_TASK != 0)
        assertEquals(1, snapshots().size)
    }

    @Test
    fun shareReportsMissingLogsAndFailures() = runBlocking {
        assertEquals(LogShareResult.NO_LOGS, LogSharing.share(context, { emptyList() }, Dispatchers.IO))
        assertEquals(LogShareResult.FAILED, LogSharing.share(context, { error("host failed") }, Dispatchers.IO))
        assertNull(shadowOf(context).nextStartedActivity)
        assertFalse(snapshots().any { it.endsWith(".txt") })
    }
}
