package io.github.sillybunnyteam.sillybunny.server

import android.content.Context
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.StandardOpenOption
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

/**
 * Crash records of unexpected server exits (plan Appendix A, Round 5, Q17), one text file per exit.
 *
 * Both directories sit in `filesDir/crash`, outside the checkout: the DocumentsProvider only reaches the
 * checkout's `data/` and `config.yaml`, and the FileProvider only `cacheDir/shared/`. Node writes its fatal-error
 * reports into [reportsDir], and a record embeds the newest one. Within one run the raw reports have no cap: every
 * Node process that inherits `NODE_OPTIONS`, the server's own children included, can add one per fatal error, and
 * they stay until the next launch ([prepareReports]), record ([write]) or clean exit deletes them all.
 * [recordsDir] keeps the `keep` most recently written records. Every part of a record is bounded and has the run's
 * launch token replaced.
 */
internal class CrashRecords(
    directory: File,
    private val keep: Int = KEEP,
    private val maxLogLines: Int = MAX_LOG_LINES,
    private val maxLogBytes: Int = MAX_LOG_BYTES,
    private val maxReportBytes: Int = MAX_REPORT_BYTES,
) {
    val reportsDir = File(directory, REPORTS)
    val recordsDir = File(directory, RECORDS)

    init {
        require(keep >= 1 && maxLogLines >= 1 && maxLogBytes >= 2 * MAX_LINE_BYTES && maxReportBytes >= 1)
    }

    /** One unexpected exit. Not a data class: its [token] must never reach a `toString`. */
    class Crash(
        val epochMillis: Long,
        val exitCode: Int?,
        val uptimeMillis: Long,
        val launchedEpochMillis: Long,
        val token: String?,
        val serverLog: List<String>,
        val nativeLog: List<String>,
    )

    /** Creates [reportsDir] without reports of earlier runs; null when it cannot be created. */
    fun prepareReports(): File? {
        if (!reportsDir.isDirectory && !reportsDir.mkdirs()) return null
        clearReports()
        return reportsDir
    }

    fun clearReports() {
        reportsDir.listFiles()?.forEach { file ->
            if (!Files.isDirectory(file.toPath(), LinkOption.NOFOLLOW_LINKS)) file.delete()
        }
    }

    /** Writes [crash]'s record, then prunes old records and deletes the raw reports. Never throws. */
    fun write(crash: Crash): File? {
        val record = try {
            writeRecord(crash)
        } catch (_: IOException) {
            null
        } catch (_: RuntimeException) {
            null
        }
        clearReports()
        prune()
        return record
    }

    /** The records, the most recently written first. */
    fun records(): List<File> = recordsDir.listFiles().orEmpty()
        .filter { RECORD_NAME.matches(it.name) && Files.isRegularFile(it.toPath(), LinkOption.NOFOLLOW_LINKS) }
        .sortedWith(NEWEST_FIRST)

    private fun writeRecord(crash: Crash): File? {
        if (!recordsDir.isDirectory && !recordsDir.mkdirs()) return null
        val bytes = render(crash).toByteArray(Charsets.UTF_8)
        val target = nextName(crash.epochMillis)
        val partial = File(recordsDir, target.name + PARTIAL)
        try {
            partial.writeBytes(bytes)
            if (!partial.renameTo(target)) throw IOException("record")
        } catch (error: IOException) {
            partial.delete()
            throw error
        }
        return target
    }

    private fun render(crash: Crash): String {
        val text = StringBuilder()
        text.append("$HEADER time=${STAMP.format(Instant.ofEpochMilli(crash.epochMillis))} ")
            .append(describeExit(crash.exitCode))
            .append(" uptimeMs=${crash.uptimeMillis}\n")
        val serverLog = bounded(redactLines(crash.serverLog, crash.token))
        text.append("$HEADER server-log lines=${serverLog.size}\n")
        serverLog.forEach { text.append(it).append('\n') }
        val nativeLog = bounded(redactLines(crash.nativeLog, crash.token))
        text.append("$HEADER native-log tag=${LogcatNativeLog.TAG} lines=${nativeLog.size}\n")
        nativeLog.forEach { text.append(it).append('\n') }
        val report = newestReport(crash.launchedEpochMillis)
        val head = report?.let { readHead(it) }
        if (report == null || head == null) {
            text.append("$HEADER node-report none\n")
        } else {
            val (bytes, size) = head
            text.append("$HEADER node-report file=${report.name} bytes=$size")
            if (size > bytes.size) text.append(" truncatedAt=${bytes.size}")
            text.append('\n')
            redact(bytes, crash.token, maxReportBytes).forEach { text.append(it).append('\n') }
        }
        text.append("$HEADER end\n")
        return text.toString()
    }

    /** The newest lines that fit in [maxLogLines] and [maxLogBytes]. */
    private fun bounded(lines: List<String>): List<String> {
        val kept = ArrayDeque<String>()
        var bytes = 0
        for (line in lines.asReversed()) {
            if (kept.size == maxLogLines) break
            val size = line.toByteArray(Charsets.UTF_8).size + 1
            if (bytes + size > maxLogBytes) break
            kept.addFirst(line)
            bytes += size
        }
        return kept
    }

    private fun newestReport(sinceEpochMillis: Long): File? = reportsDir.listFiles().orEmpty()
        .filter { file ->
            REPORT_NAME.matches(file.name) &&
                Files.isRegularFile(file.toPath(), LinkOption.NOFOLLOW_LINKS) &&
                file.lastModified() >= sinceEpochMillis - CLOCK_SLACK_MILLIS
        }
        .maxWithOrNull(compareBy<File> { it.lastModified() }.thenBy { it.name })

    /** The first [maxReportBytes] bytes of [file] and its size; a link is never followed. */
    private fun readHead(file: File): Pair<ByteArray, Long>? = try {
        FileChannel.open(file.toPath(), StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS).use { channel ->
            val size = channel.size()
            val buffer = ByteBuffer.allocate(minOf(size, maxReportBytes.toLong()).toInt())
            while (buffer.hasRemaining()) {
                if (channel.read(buffer) <= 0) break
            }
            buffer.array().copyOf(buffer.position()) to size
        }
    } catch (_: IOException) {
        null
    }

    /**
     * Records sort by a sequence number one above every record's and interrupted write's, not by their time: once the
     * clock moved back, a new record carries an earlier time than the old ones, and pruning by time would delete it.
     */
    private fun nextName(epochMillis: Long): File {
        val highest = recordsDir.list().orEmpty().maxOfOrNull { sequence(it.removeSuffix(PARTIAL)) ?: 0L } ?: 0L
        val number = (highest + 1).toString().padStart(SEQUENCE_DIGITS, '0')
        return File(recordsDir, "$PREFIX$number-${NAME_STAMP.format(Instant.ofEpochMilli(epochMillis))}$EXTENSION")
    }

    private fun prune() {
        val files = recordsDir.listFiles() ?: return
        files.filter { it.name.endsWith(PARTIAL) }.forEach { it.delete() }
        files.filter { RECORD_NAME.matches(it.name) }.sortedWith(NEWEST_FIRST).drop(keep).forEach { it.delete() }
    }

    companion object {
        const val DIRECTORY = "crash"
        const val KEEP = 5
        const val MAX_LOG_LINES = 200
        const val MAX_LOG_BYTES = 64 * 1024
        const val MAX_REPORT_BYTES = 1024 * 1024
        const val HEADER = "${ServerManager.MARKER} crash-record"

        private const val REPORTS = "reports"
        private const val RECORDS = "records"
        private const val PREFIX = "crash-"
        private const val EXTENSION = ".txt"
        private const val PARTIAL = ".partial"
        private const val SEQUENCE_DIGITS = 6
        private const val MAX_LINE_BYTES = 8192

        // A file time can be coarser than the launch time's milliseconds, so a report written right after the spawn
        // can carry a time a little before the launch.
        private const val CLOCK_SLACK_MILLIS = 2_000L

        private val STAMP = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC)
        private val NAME_STAMP = DateTimeFormatter.ofPattern("yyyyMMdd'T'HHmmss.SSS'Z'").withZone(ZoneOffset.UTC)
        private val RECORD_NAME = Regex("""crash-(\d{6,18})-\d{8}T\d{6}\.\d{3}Z\.txt""")
        private val REPORT_NAME = Regex("""report\.[0-9.]+\.json""")

        private val NEWEST_FIRST = compareByDescending<File> { sequence(it.name) ?: 0L }.thenByDescending { it.name }

        private val SIGNAL_NAMES = listOf(
            "SIGHUP", "SIGINT", "SIGQUIT", "SIGILL", "SIGTRAP", "SIGABRT", "SIGBUS", "SIGFPE", "SIGKILL", "SIGUSR1",
            "SIGSEGV", "SIGUSR2", "SIGPIPE", "SIGALRM", "SIGTERM", "SIGSTKFLT", "SIGCHLD", "SIGCONT", "SIGSTOP",
            "SIGTSTP", "SIGTTIN", "SIGTTOU", "SIGURG", "SIGXCPU", "SIGXFSZ", "SIGVTALRM", "SIGPROF", "SIGWINCH",
            "SIGIO", "SIGPWR", "SIGSYS",
        )

        fun directory(context: Context): File = File(context.filesDir, DIRECTORY)

        /**
         * The exit status as the session shell reports it. A shell reports a command killed by signal N as 128 + N,
         * so such a status also names the signal; a program can exit with such a status itself, so both are kept.
         */
        fun describeExit(exitCode: Int?): String {
            if (exitCode == null) return "exit=unknown"
            val signal = exitCode - 128
            if (signal !in 1..64) return "exit=$exitCode"
            val name = SIGNAL_NAMES.getOrNull(signal - 1) ?: "SIGRTMIN+${signal - 32}"
            return "exit=$exitCode signal=$signal $name"
        }

        /** The last lines of [files] (oldest first, as a rotating log lists them), from their last [maxBytes]. */
        fun lastLines(files: List<File>, maxLines: Int, maxBytes: Int): List<String> {
            val chunks = ArrayDeque<ByteArray>()
            var remaining = maxBytes.toLong()
            var cut = false
            for (file in files.asReversed()) {
                if (remaining <= 0) break
                val (bytes, partial) = readTail(file, remaining) ?: continue
                chunks.addFirst(bytes)
                remaining -= bytes.size
                if (partial) {
                    cut = true
                    break
                }
            }
            val all = ByteArrayOutputStream()
            chunks.forEach { all.write(it) }
            val lines = String(all.toByteArray(), Charsets.UTF_8).split('\n').dropLastWhile { it.isEmpty() }
            // The first line may be cut mid-way when the read started inside it.
            return (if (cut) lines.drop(1) else lines).takeLast(maxLines)
        }

        private fun readTail(file: File, maxBytes: Long): Pair<ByteArray, Boolean>? = try {
            FileChannel.open(file.toPath(), StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS).use { channel ->
                val size = channel.size()
                val start = maxOf(0L, size - maxBytes)
                val buffer = ByteBuffer.allocate((size - start).toInt())
                var position = start
                while (buffer.hasRemaining()) {
                    val read = channel.read(buffer, position)
                    if (read <= 0) break
                    position += read
                }
                buffer.array().copyOf(buffer.position()) to (start > 0)
            }
        } catch (_: IOException) {
            null
        }

        // Every line keeps its line end, because an unended last line that ends like the start of the token would be
        // taken for a cut token and replaced.
        private fun redactLines(lines: List<String>, token: String?): List<String> =
            if (lines.isEmpty()) {
                emptyList()
            } else {
                redact(lines.joinToString("\n", postfix = "\n").toByteArray(Charsets.UTF_8), token, MAX_LINE_BYTES)
            }

        private fun redact(bytes: ByteArray, token: String?, maxLineBytes: Int): List<String> {
            if (bytes.isEmpty()) return emptyList()
            val lines = ArrayList<String>()
            val splitter = RedactingLineSplitter(token, maxLineBytes) { lines += it }
            splitter.feed(bytes, bytes.size)
            splitter.finish()
            return lines
        }

        private fun sequence(name: String): Long? = RECORD_NAME.matchEntire(name)?.groupValues?.get(1)?.toLong()
    }
}
