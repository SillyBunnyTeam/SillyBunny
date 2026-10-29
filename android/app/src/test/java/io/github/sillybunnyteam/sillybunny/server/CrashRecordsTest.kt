package io.github.sillybunnyteam.sillybunny.server

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.nio.file.Files
import java.time.Instant

class CrashRecordsTest {
    @get:Rule
    val temporary = TemporaryFolder()

    private val launched = Instant.parse("2026-10-24T12:00:00Z").toEpochMilli()
    private val token = LaunchTokens.generate()
    private lateinit var records: CrashRecords

    @Before
    fun prepare() {
        records = CrashRecords(File(temporary.root, "crash"))
        assertNotNull(records.prepareReports())
    }

    private fun crash(
        exitCode: Int? = 1,
        at: Long = launched + 61_000,
        serverLog: List<String> = listOf("server line"),
        nativeLog: List<String> = emptyList(),
    ) = CrashRecords.Crash(at, exitCode, uptimeMillis = 61_000, launched, token, serverLog, nativeLog)

    private fun report(name: String, text: String, modified: Long = launched + 30_000): File =
        File(records.reportsDir, name).apply {
            writeText(text)
            setLastModified(modified)
        }

    private fun everything(): String = temporary.root.walkTopDown().filter { it.isFile }.joinToString("\n") { it.readText() }

    @Test
    fun aRecordHoldsTheExitTheUptimeTheLogsAndTheNewestReportOfThisLaunch() {
        report("report.20261024.115900.4207.0.001.json", """{"old":true}""", modified = launched - 60_000)
        report("report.20261024.120030.4207.0.001.json", """{"first":true}""", modified = launched + 30_000)
        report("report.20261024.120040.4300.0.002.json", """{"header":{"event":"Allocation failed"}}""", launched + 40_000)

        val record = records.write(
            crash(serverLog = listOf("Entering SillyBunny...", "[sillybunny-android] exit code=1"), nativeLog = listOf("E/nodejs: FATAL ERROR")),
        )!!

        assertEquals("crash-000001-20261024T120101.000Z.txt", record.name)
        assertEquals(
            listOf(
                "${CrashRecords.HEADER} time=2026-10-24T12:01:01.000Z exit=1 uptimeMs=61000",
                "${CrashRecords.HEADER} server-log lines=2",
                "Entering SillyBunny...",
                "[sillybunny-android] exit code=1",
                "${CrashRecords.HEADER} native-log tag=nodejs lines=1",
                "E/nodejs: FATAL ERROR",
                "${CrashRecords.HEADER} node-report file=report.20261024.120040.4300.0.002.json bytes=40",
                """{"header":{"event":"Allocation failed"}}""",
                "${CrashRecords.HEADER} end",
            ),
            record.readLines(),
        )
        // The raw reports go once a record holds the one it needs.
        assertEquals(emptyList<String>(), records.reportsDir.list()!!.toList())
    }

    @Test
    fun aRecordWithoutAReportSaysSo() {
        val record = records.write(crash(exitCode = null, serverLog = emptyList()))!!

        val lines = record.readLines()
        assertTrue(lines.first().contains(" exit=unknown "))
        assertTrue(lines.contains("${CrashRecords.HEADER} server-log lines=0"))
        assertTrue(lines.contains("${CrashRecords.HEADER} node-report none"))
    }

    @Test
    fun anExitStatusFromASignalNamesTheSignal() {
        assertEquals("exit=139 signal=11 SIGSEGV", CrashRecords.describeExit(139))
        assertEquals("exit=134 signal=6 SIGABRT", CrashRecords.describeExit(134))
        assertEquals("exit=137 signal=9 SIGKILL", CrashRecords.describeExit(137))
        assertEquals("exit=143 signal=15 SIGTERM", CrashRecords.describeExit(143))
        assertEquals("exit=159 signal=31 SIGSYS", CrashRecords.describeExit(159))
        assertEquals("exit=162 signal=34 SIGRTMIN+2", CrashRecords.describeExit(162))
        assertEquals("exit=1", CrashRecords.describeExit(1))
        assertEquals("exit=128", CrashRecords.describeExit(128))
        assertEquals("exit=193", CrashRecords.describeExit(193))
        assertEquals("exit=-1", CrashRecords.describeExit(-1))
        assertEquals("exit=unknown", CrashRecords.describeExit(null))
    }

    @Test
    fun theTokenIsReplacedInEveryPart() {
        val half = token.length / 2
        report(
            "report.20261024.120040.4300.0.001.json",
            """{"javascriptStack":{"message":"Error: $token"},"x":"${token.take(half)}${token.drop(half)}"}""",
        )

        val record = records.write(
            crash(serverLog = listOf("cookie=$token", "plain"), nativeLog = listOf("E/nodejs: token $token at start")),
        )!!

        val text = record.readText()
        assertFalse(text.contains(token))
        assertFalse(text.contains(token.take(32)))
        assertTrue(text.contains("cookie=${RedactingLineSplitter.REDACTED}"))
        assertTrue(text.contains("E/nodejs: token ${RedactingLineSplitter.REDACTED} at start"))
        assertTrue(text.contains("""{"javascriptStack":{"message":"Error: [REDACTED]"},"x":"[REDACTED]"}"""))
        assertFalse(everything().contains(token))
    }

    @Test
    fun aTokenCutByTheReportBoundIsReplacedToo() {
        val small = CrashRecords(File(temporary.root, "small"), maxReportBytes = 100)
        small.prepareReports()
        File(small.reportsDir, "report.20261024.120040.4300.0.001.json").apply {
            writeText("x".repeat(90) + token + "\"}")
            setLastModified(launched + 30_000)
        }

        val text = small.write(crash())!!.readText()

        assertTrue(text.contains("\n" + "x".repeat(90) + RedactingLineSplitter.REDACTED + "\n"))
        assertFalse(text.contains(token.take(10)))
    }

    @Test
    fun aLineThatEndsLikeTheTokenStartsStaysWhole() {
        val record = records.write(
            crash(serverLog = listOf("id ${token.take(8)}"), nativeLog = listOf("E/nodejs: ${token.take(1)}")),
        )!!

        val lines = record.readLines()
        assertTrue(lines.contains("id ${token.take(8)}"))
        assertTrue(lines.contains("E/nodejs: ${token.take(1)}"))
    }

    @Test
    fun everyPartIsBounded() {
        val long = "x".repeat(20_000)
        val serverLog = (1..1_000).map { "line $it ${"y".repeat(400)}" } + long
        val nativeLog = (1..300).map { "E/nodejs: native $it" }
        val bigReport = "{" + "\"k\":\"" + "z".repeat(3 * 1024 * 1024) + "\"}"
        report("report.20261024.120040.4300.0.001.json", bigReport)

        val text = records.write(crash(serverLog = serverLog, nativeLog = nativeLog))!!.readText()

        val sections = text.split('\n')
        val serverStart = sections.indexOfFirst { it.startsWith("${CrashRecords.HEADER} server-log") }
        val nativeStart = sections.indexOfFirst { it.startsWith("${CrashRecords.HEADER} native-log") }
        val reportStart = sections.indexOfFirst { it.startsWith("${CrashRecords.HEADER} node-report") }
        val serverLines = sections.subList(serverStart + 1, nativeStart)
        val nativeLines = sections.subList(nativeStart + 1, reportStart)
        assertTrue(serverLines.size <= CrashRecords.MAX_LOG_LINES)
        assertTrue(serverLines.sumOf { it.length + 1 } <= CrashRecords.MAX_LOG_BYTES)
        // The newest lines win, and a line longer than the log's line limit is cut.
        assertEquals("x".repeat(8192), serverLines.last())
        assertEquals("line 1000 ${"y".repeat(400)}", serverLines[serverLines.size - 2])
        assertEquals(CrashRecords.MAX_LOG_LINES, nativeLines.size)
        assertEquals("E/nodejs: native 300", nativeLines.last())
        assertEquals(
            "${CrashRecords.HEADER} node-report file=report.20261024.120040.4300.0.001.json " +
                "bytes=${bigReport.length} truncatedAt=${CrashRecords.MAX_REPORT_BYTES}",
            sections[reportStart],
        )
        assertEquals(CrashRecords.MAX_REPORT_BYTES, sections[reportStart + 1].length)
        assertTrue(text.length < CrashRecords.MAX_REPORT_BYTES + 2 * CrashRecords.MAX_LOG_BYTES + 1024)
    }

    @Test
    fun atMostFiveRecordsStayNewestFirst() {
        val names = (0 until 7).map { index -> records.write(crash(at = launched + index * 60_000L))!!.name }
        // Two exits in the same millisecond get distinct names, and the later one sorts first.
        val same = records.write(crash(at = launched + 6 * 60_000L))!!.name

        assertEquals("crash-000008-20261024T120600.000Z.txt", same)
        assertEquals(listOf(same) + names.reversed().take(4), records.records().map { it.name })
        assertEquals(CrashRecords.KEEP, records.recordsDir.list()!!.size)
    }

    @Test
    fun aRecordWrittenAfterTheClockMovedBackIsTheNewestAndStays() {
        val later = (1..CrashRecords.KEEP).map { hours -> records.write(crash(at = launched + hours * 3_600_000L))!! }

        val record = records.write(crash(at = launched))!!

        assertTrue(record.isFile)
        assertEquals("crash-000006-20261024T120000.000Z.txt", record.name)
        val kept = listOf(record) + later.reversed().take(CrashRecords.KEEP - 1)
        assertEquals(kept.map { it.name }, records.records().map { it.name })
        assertFalse(later.first().exists())
        assertEquals(CrashRecords.KEEP, records.recordsDir.list()!!.size)
    }

    @Test
    fun anInterruptedWriteLeavesNoPartialFileBehind() {
        File(records.recordsDir.apply { mkdirs() }, "crash-000003-20261024T115959.000Z.txt.partial").writeText("half")

        records.write(crash())

        assertEquals(listOf("crash-000004-20261024T120101.000Z.txt"), records.recordsDir.list()!!.toList())
    }

    @Test
    fun aLinkInTheReportDirectoryIsNeverFollowed() {
        val secret = File(temporary.root, "secrets.json").apply { writeText("""{"api_key":"sk-not-for-sharing"}""") }
        val link = File(records.reportsDir, "report.20261024.120040.4300.0.001.json")
        Files.createSymbolicLink(link.toPath(), secret.toPath())

        val record = records.write(crash())!!

        assertFalse(record.readText().contains("sk-not-for-sharing"))
        assertTrue(record.readLines().contains("${CrashRecords.HEADER} node-report none"))
        // The link goes with the reports; its target stays.
        assertFalse(Files.exists(link.toPath(), java.nio.file.LinkOption.NOFOLLOW_LINKS))
        assertTrue(secret.isFile)
    }

    @Test
    fun preparingTheReportDirectoryClearsReportsOfEarlierRuns() {
        report("report.20261024.115900.4207.0.001.json", "{}")

        assertEquals(records.reportsDir, records.prepareReports())

        assertEquals(emptyList<String>(), records.reportsDir.list()!!.toList())
    }

    @Test
    fun aReportDirectoryThatCannotBeCreatedIsNull() {
        val blocked = File(temporary.root, "blocked").apply { writeText("a file, not a directory") }

        assertNull(CrashRecords(blocked).prepareReports())
        assertNull(CrashRecords(blocked).write(crash()))
    }

    @Test
    fun lastLinesReadAcrossRotatedFilesAndDropALineCutAtTheStart() {
        val old = File(temporary.root, "server.log.1").apply { writeText("a1\na2\na3\n") }
        val new = File(temporary.root, "server.log").apply { writeText("b1\nb2\n") }

        assertEquals(listOf("a1", "a2", "a3", "b1", "b2"), CrashRecords.lastLines(listOf(old, new), 10, 1024))
        assertEquals(listOf("a3", "b1", "b2"), CrashRecords.lastLines(listOf(old, new), 3, 1024))
        // The last 11 bytes reach 5 bytes into the older file, "2\na3\n": its cut first line is dropped.
        assertEquals(listOf("a3", "b1", "b2"), CrashRecords.lastLines(listOf(old, new), 10, 11))
        assertEquals(emptyList<String>(), CrashRecords.lastLines(emptyList(), 10, 1024))
    }
}
