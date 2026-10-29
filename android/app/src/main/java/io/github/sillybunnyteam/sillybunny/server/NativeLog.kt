package io.github.sillybunnyteam.sillybunny.server

import java.io.IOException
import java.util.Locale
import java.util.concurrent.TimeUnit

/**
 * Node's C++-side error output, including uncaught-exception reports and fatal errors, goes to the
 * logcat tag `nodejs`, not to the captured stderr (plan §4.4, S2.1). The manager reads these entries
 * after an unexpected exit, so the log and the error screen show why the server died.
 */
internal fun interface NativeLog {
    /** This app's own `nodejs` logcat lines written since [sinceEpochMillis], oldest first; empty when unavailable. */
    fun linesSince(sinceEpochMillis: Long): List<String>
}

/**
 * Dumps the app's own log entries with `/system/bin/logcat -d`. An app without `READ_LOGS` sees only its
 * own UID's entries, which include every process the server group runs. Bounded in time and lines;
 * never throws.
 */
internal class LogcatNativeLog(
    private val timeoutMillis: Long = 5_000,
    private val maxLines: Int = 200,
    private val inherited: () -> Map<String, String> = { System.getenv() },
    private val logcat: String = LOGCAT,
) : NativeLog {
    override fun linesSince(sinceEpochMillis: Long): List<String> {
        val since = String.format(Locale.ROOT, "%d.%03d", sinceEpochMillis / 1_000, sinceEpochMillis % 1_000)
        val builder = ProcessBuilder(logcat, "-d", "-v", "brief", "-T", since, "$TAG:V", "*:S").redirectErrorStream(true)
        builder.environment().clear()
        val environment = inherited()
        for (key in ProcessEnvironment.FRAMEWORK_ROOTS) environment[key]?.let { builder.environment()[key] = it }
        builder.environment()["PATH"] = "/system/bin"
        val process = try {
            builder.start()
        } catch (_: IOException) {
            return emptyList()
        }
        val lines = ArrayDeque<String>()
        val reader = Thread({
            try {
                process.inputStream.bufferedReader(Charsets.UTF_8).forEachLine { line ->
                    // logcat prints a buffer header before the first entry of each buffer.
                    if (line.isBlank() || line.startsWith("--------- ")) return@forEachLine
                    synchronized(lines) {
                        if (lines.size == maxLines) lines.removeFirst()
                        lines.addLast(line)
                    }
                }
            } catch (_: IOException) {
                // Destroyed after the timeout.
            }
        }, "native-log").apply {
            isDaemon = true
            start()
        }
        try {
            if (!process.waitFor(timeoutMillis, TimeUnit.MILLISECONDS)) process.destroyForcibly()
            reader.join(1_000)
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
            process.destroyForcibly()
        }
        return synchronized(lines) { lines.toList() }
    }

    companion object {
        const val TAG = "nodejs"
        private const val LOGCAT = "/system/bin/logcat"
    }
}
