package io.github.sillybunnyteam.sillybunny.server

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class ServerLogsTest {
    @get:Rule
    val temporary = TemporaryFolder()

    private fun lines(file: File) = file.readText().lines().dropLastWhile { it.isEmpty() }

    @Test
    fun theLogRotatesAtItsSizeCapAndKeepsThreeFiles() {
        val directory = File(temporary.root, "logs")
        val log = RotatingLogFile(directory, "server.log", maxBytes = 100, keep = 3)

        // Each line is 10 bytes with its newline, so every file holds exactly 10 lines.
        for (index in 0 until 45) log.append("line %04d".format(index))
        log.close()

        val files = log.files()
        assertEquals(listOf("server.log.2", "server.log.1", "server.log"), files.map { it.name })
        assertEquals((20 until 30).map { "line %04d".format(it) }, lines(files[0]))
        assertEquals((30 until 40).map { "line %04d".format(it) }, lines(files[1]))
        assertEquals((40 until 45).map { "line %04d".format(it) }, lines(files[2]))
        files.forEach { assertTrue(it.length() <= 100) }
        assertEquals(3, directory.listFiles()!!.size)
    }

    @Test
    fun aNewLogContinuesTheNewestFileAndCountsItsSize() {
        val directory = File(temporary.root, "logs")
        RotatingLogFile(directory, "server.log", 100, 3).apply {
            repeat(9) { append("line 000$it") }
            close()
        }

        val reopened = RotatingLogFile(directory, "server.log", 100, 3)
        reopened.append("line 0009")
        reopened.append("line 0010")
        reopened.close()

        assertEquals(listOf("server.log.1", "server.log"), reopened.files().map { it.name })
        assertEquals(listOf("line 0010"), lines(File(directory, "server.log")))
    }

    @Test
    fun rotateNowStartsAFreshNewestFile() {
        val directory = File(temporary.root, "logs")
        val log = RotatingLogFile(directory, "setup.log", 1_000, 2)
        log.append("first job")
        log.rotateNow()
        log.append("second job")
        log.rotateNow()
        log.append("third job")
        log.close()

        assertEquals(listOf("setup.log.1", "setup.log"), log.files().map { it.name })
        assertEquals(listOf("second job"), lines(File(directory, "setup.log.1")))
        assertEquals(listOf("third job"), lines(File(directory, "setup.log")))
    }

    @Test
    fun anUnwritableDirectoryNeverThrows() {
        val blocker = temporary.newFile("not-a-directory")
        val log = RotatingLogFile(File(blocker, "logs"), "server.log", 100, 3)

        log.append("lost")
        log.flush()
        log.close()

        assertTrue(log.files().isEmpty())
    }

    @Test
    fun theTailKeepsTheLastLines() {
        val tail = LineTail(500)
        for (index in 0 until 1_234) tail.add("line $index")

        val snapshot = tail.snapshot()
        assertEquals(500, snapshot.size)
        assertEquals("line 734", snapshot.first())
        assertEquals("line 1233", snapshot.last())
        assertEquals((1_184 until 1_234).map { "line $it" }, tail.last(50))
        tail.clear()
        assertTrue(tail.snapshot().isEmpty())
    }

    @Test
    fun theSplitterHandlesEveryLineEndingAndCutsLongLines() {
        val lines = mutableListOf<String>()
        val splitter = RedactingLineSplitter(null, maxLineBytes = 8) { lines += it }
        val output = "a\nb\r\nc\rd\n\ne\r\r\n0123456789ABC\npartial".toByteArray()

        splitter.feed(output, output.size)
        splitter.finish()

        assertEquals(listOf("a", "b", "c", "d", "", "e", "", "01234567", "partial"), lines)
    }

    @Test
    fun aCompleteLineIsNeverHeldBackWaitingForMoreOutput() {
        val token = LaunchTokens.generate()
        val lines = mutableListOf<String>()
        val splitter = RedactingLineSplitter(token) { lines += it }

        val first = "listening on 127.0.0.1\nagain $token\n".toByteArray()
        splitter.feed(first, first.size)
        assertEquals(listOf("listening on 127.0.0.1", "again [REDACTED]"), lines)

        // Only a possible start of the token waits for the next read.
        val partial = "next ${token.take(10)}".toByteArray()
        splitter.feed(partial, partial.size)
        assertEquals(2, lines.size)
        val rest = "${token.drop(10)} done\n".toByteArray()
        splitter.feed(rest, rest.size)
        assertEquals("next [REDACTED] done", lines.last())
        assertEquals(3, lines.size)
    }

    @Test
    fun pumpLinesKeepsDrainingAfterTheConsumerFails() {
        val input = java.io.ByteArrayInputStream("one\ntwo\nthree\n".repeat(5_000).toByteArray())
        var calls = 0

        pumpLines(input, RedactingLineSplitter(null) { calls++; throw IllegalStateException("consumer") })

        assertEquals(1, calls)
        assertEquals(0, input.available())
    }

    @Test
    fun pumpLinesDrainsAStreamThatFailsMidway() {
        val lines = mutableListOf<String>()
        val failing = object : java.io.InputStream() {
            private val data = "one\ntwo".toByteArray()
            private var position = 0

            override fun read(): Int = throw UnsupportedOperationException()

            override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
                if (position >= data.size) throw java.io.IOException("closed")
                val count = minOf(length, data.size - position)
                System.arraycopy(data, position, buffer, offset, count)
                position += count
                return count
            }
        }

        pumpLines(failing, RedactingLineSplitter(null) { lines += it })

        assertEquals(listOf("one", "two"), lines)
    }
}
