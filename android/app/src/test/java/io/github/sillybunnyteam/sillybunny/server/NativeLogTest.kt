package io.github.sillybunnyteam.sillybunny.server

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.util.concurrent.TimeUnit

class NativeLogTest {
    @get:Rule
    val temporary = TemporaryFolder()

    /** A stand-in for `/system/bin/logcat`: a POSIX shell script with [body]. */
    private fun fakeLogcat(body: String): String {
        assumeTrue(File("/bin/sh").canExecute())
        val script = temporary.newFile("logcat")
        script.writeText("#!/bin/sh\n$body\n")
        assertTrue(script.setExecutable(true))
        return script.path
    }

    @Test
    fun itDumpsOnlyTheNodejsTagSinceTheRunStartedWithoutBufferHeaders() {
        val logcat = fakeLogcat(
            """
            printf '%s\n' "args: $*" '--------- beginning of main' 'E/nodejs ( 4207): Uncaught TypeError: boom'
            printf '\n'
            printf '%s\n' 'E/nodejs ( 4207):     at server.js:1:1'
            """.trimIndent(),
        )

        val lines = LogcatNativeLog(logcat = logcat, inherited = { emptyMap() }).linesSince(1_792_537_484_033)

        assertEquals(
            listOf(
                "args: -d -v brief -T 1792537484.033 nodejs:V *:S",
                "E/nodejs ( 4207): Uncaught TypeError: boom",
                "E/nodejs ( 4207):     at server.js:1:1",
            ),
            lines,
        )
    }

    @Test
    fun itKeepsOnlyTheNewestLines() {
        val logcat = fakeLogcat("i=1; while [ \"\$i\" -le 500 ]; do echo \"E/nodejs ( 1): line \$i\"; i=\$((i+1)); done")

        val lines = LogcatNativeLog(maxLines = 200, logcat = logcat, inherited = { emptyMap() }).linesSince(0)

        assertEquals((301..500).map { "E/nodejs ( 1): line $it" }, lines)
    }

    @Test
    fun aHungLogcatIsStoppedAtTheTimeout() {
        // The reader runs logcat with PATH=/system/bin, so the stand-in names its sleep by path.
        val sleep = listOf("/bin/sleep", "/usr/bin/sleep", "/system/bin/sleep").firstOrNull { File(it).canExecute() }
        assumeTrue(sleep != null)
        val logcat = fakeLogcat("exec $sleep 30")
        val started = System.nanoTime()

        val lines = LogcatNativeLog(timeoutMillis = 300, logcat = logcat, inherited = { emptyMap() }).linesSince(0)

        assertTrue(lines.isEmpty())
        assertTrue(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started) < 5_000)
    }

    @Test
    fun aMissingLogcatGivesNoLinesAndNeverThrows() {
        val lines = LogcatNativeLog(logcat = File(temporary.root, "missing/logcat").path).linesSince(0)

        assertTrue(lines.isEmpty())
    }
}
