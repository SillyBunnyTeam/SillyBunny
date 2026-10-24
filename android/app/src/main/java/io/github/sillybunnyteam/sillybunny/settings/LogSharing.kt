package io.github.sillybunnyteam.sillybunny.settings

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import androidx.annotation.WorkerThread
import androidx.core.content.FileProvider
import io.github.sillybunnyteam.sillybunny.server.ServerHost
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.OutputStream
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.StandardOpenOption
import java.nio.file.attribute.BasicFileAttributes
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import kotlin.coroutines.cancellation.CancellationException

enum class LogShareResult { SHARED, NO_LOGS, FAILED }

/**
 * Shares the server logs through the Android share sheet (plan §4.4, §4.6). Settings, first run and
 * the server error screen all use it; [LogShareDialog] adds the required confirmation in front of it.
 *
 * A snapshot is one point-in-time file in `cacheDir/shared/logs/` named
 * `SillyBunny-logs-<yyyyMMdd'T'HHmmss'Z'>[-n].txt` (UTC): the files `ServerHost.logFiles()` returns,
 * oldest first, concatenated and capped at [MAX_SNAPSHOT_BYTES]. When the logs are larger the newest
 * bytes win, and the cut moves forward to the next line start. Only the listed regular files are read,
 * never through a symlink, and every new snapshot first deletes the earlier ones.
 */
object LogSharing {
    /** Upper bound of one snapshot: 4 MiB, small enough for mail and chat attachments. */
    const val MAX_SNAPSHOT_BYTES: Long = 4L * 1024 * 1024

    /** Snapshot directory under `cacheDir`, inside the FileProvider's `shared/` root. */
    const val SNAPSHOT_DIRECTORY = "shared/logs"
    const val MIME_TYPE = "text/plain"

    private const val PREFIX = "SillyBunny-logs-"
    private const val EXTENSION = ".txt"
    private const val PARTIAL = ".partial"
    private const val MAX_NAME_ATTEMPTS = 999
    private const val LINE_SEARCH_BYTES = 64 * 1024
    private const val COPY_BUFFER_BYTES = 64 * 1024
    private const val MAX_UTF8_CONTINUATION = 3
    private const val NEWLINE = '\n'.code.toByte()
    private val stamp = DateTimeFormatter.ofPattern("yyyyMMdd'T'HHmmss'Z'").withZone(ZoneOffset.UTC)
    private val snapshotName = Regex("""SillyBunny-logs-\d{8}T\d{6}Z(?:-[1-9]\d{0,2})?\.txt(?:\.partial)?""")

    /** The FileProvider authority the manifest declares (`${applicationId}.files`). */
    fun authority(context: Context): String = context.packageName + ".files"

    fun snapshotDirectory(context: Context): File = File(context.cacheDir, SNAPSHOT_DIRECTORY)

    fun isSnapshotName(name: String): Boolean = snapshotName.matches(name)

    /** Deletes every earlier snapshot, including interrupted ones, and returns how many it removed. */
    @WorkerThread
    fun deleteSnapshots(context: Context): Int =
        snapshotDirectory(context).listFiles().orEmpty().count { file ->
            isSnapshotName(file.name) && Files.isRegularFile(file.toPath(), LinkOption.NOFOLLOW_LINKS) && file.delete()
        }

    /**
     * Deletes earlier snapshots, then writes a new one from [logFiles] (oldest first). Returns null when
     * the logs are empty.
     */
    @WorkerThread
    @Throws(IOException::class)
    fun createSnapshot(
        context: Context,
        logFiles: List<File>,
        now: Instant = Instant.now(),
        maxBytes: Long = MAX_SNAPSHOT_BYTES,
    ): File? {
        require(maxBytes > 0) { "maxBytes" }
        deleteSnapshots(context)
        val slices = plan(logFiles, maxBytes)
        if (slices.isEmpty()) return null
        val directory = snapshotDirectory(context)
        if (!directory.isDirectory && !directory.mkdirs()) throw IOException("Cannot create $directory")
        val target = freeName(directory, now)
        val partial = File(directory, target.name + PARTIAL)
        try {
            val written = FileOutputStream(partial).use { output -> slices.sumOf { it.copyTo(output) } }
            if (written == 0L) {
                partial.delete()
                return null
            }
            if (!partial.renameTo(target)) throw IOException("Cannot publish $target")
        } catch (error: IOException) {
            partial.delete()
            throw error
        }
        return target
    }

    /** `ACTION_SEND` of [snapshot] as `text/plain` through the FileProvider with a read grant, in a chooser. */
    fun shareIntent(context: Context, snapshot: File, chooserTitle: CharSequence? = null): Intent {
        val uri = FileProvider.getUriForFile(context, authority(context), snapshot)
        val send = Intent(Intent.ACTION_SEND)
            .setType(MIME_TYPE)
            .putExtra(Intent.EXTRA_STREAM, uri)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        send.clipData = ClipData(snapshot.name, arrayOf(MIME_TYPE), ClipData.Item(uri))
        // createChooser copies the ClipData and the grant flag onto the chooser intent as well.
        return Intent.createChooser(send, chooserTitle)
    }

    /**
     * Builds a snapshot of [logFiles] on [dispatcher], then opens the share sheet from [context] on the
     * main thread. Call it only after the user confirmed the sensitive-details warning ([LogShareDialog]).
     */
    suspend fun share(
        context: Context,
        logFiles: () -> List<File>,
        dispatcher: CoroutineDispatcher = Dispatchers.IO,
        chooserTitle: CharSequence? = null,
    ): LogShareResult {
        val intent: Intent
        try {
            intent = withContext(dispatcher) {
                createSnapshot(context, logFiles())?.let { shareIntent(context, it, chooserTitle) }
            } ?: return LogShareResult.NO_LOGS
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            return LogShareResult.FAILED
        }
        if (context.findActivity() == null) intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        // Whatever thread the caller resumed on, the share sheet starts from the main thread.
        return withContext(Dispatchers.Main.immediate) {
            try {
                context.startActivity(intent)
                LogShareResult.SHARED
            } catch (_: ActivityNotFoundException) {
                LogShareResult.FAILED
            }
        }
    }

    /** [share] with the server host's rotated log files. */
    suspend fun share(
        context: Context,
        host: ServerHost,
        dispatcher: CoroutineDispatcher = Dispatchers.IO,
        chooserTitle: CharSequence? = null,
    ): LogShareResult = share(context, host::logFiles, dispatcher, chooserTitle)

    private class Slice(val path: Path, val start: Long, val end: Long) {
        /** Copies this byte range, stopping early if the file shrank or vanished meanwhile. */
        fun copyTo(output: OutputStream): Long {
            val channel = try {
                FileChannel.open(path, StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS)
            } catch (_: IOException) {
                return 0
            }
            channel.use {
                val buffer = ByteBuffer.allocate(COPY_BUFFER_BYTES)
                var position = start
                while (position < end) {
                    buffer.clear()
                    buffer.limit(minOf(buffer.capacity().toLong(), end - position).toInt())
                    val read = try {
                        channel.read(buffer, position)
                    } catch (_: IOException) {
                        -1
                    }
                    if (read <= 0) break
                    output.write(buffer.array(), 0, read)
                    position += read
                }
                return position - start
            }
        }
    }

    // Sizes are taken once up front, so a file that keeps growing cannot stretch the snapshot.
    private fun plan(logFiles: List<File>, maxBytes: Long): List<Slice> {
        val sized = logFiles.mapNotNull { file ->
            val path = file.toPath()
            val attributes = try {
                Files.readAttributes(path, BasicFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
            } catch (_: IOException) {
                null
            }
            if (attributes != null && attributes.isRegularFile && attributes.size() > 0) path to attributes.size() else null
        }
        val slices = ArrayDeque<Slice>()
        var remaining = maxBytes
        for ((path, size) in sized.asReversed()) {
            if (remaining <= 0) break
            val take = minOf(size, remaining)
            slices.addFirst(Slice(path, size - take, size))
            remaining -= take
        }
        val first = slices.firstOrNull() ?: return emptyList()
        if (first.start > 0) {
            val cut = cut(first)
            when {
                cut.line < first.end -> slices[0] = Slice(first.path, cut.line, first.end)
                // Only a partial line survived the cut: drop it, unless it is all there is to share.
                slices.size > 1 -> slices.removeFirst()
                else -> slices[0] = Slice(first.path, cut.character, first.end)
            }
        }
        return slices
    }

    /** Where a cut slice may start: [line] at a line start, [character] at a UTF-8 character start. */
    private class Cut(val line: Long, val character: Long)

    /**
     * [Cut.line] is after the first newline within [LINE_SEARCH_BYTES] of the cut (possibly the slice end), or
     * [Cut.character] when there is none there; [Cut.character] skips a partial UTF-8 sequence at the cut.
     */
    private fun cut(slice: Slice): Cut {
        val unchanged = Cut(slice.start, slice.start)
        val channel = try {
            FileChannel.open(slice.path, StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS)
        } catch (_: IOException) {
            return unchanged
        }
        channel.use {
            try {
                val previous = ByteBuffer.allocate(1)
                if (channel.read(previous, slice.start - 1) == 1 && previous.get(0) == NEWLINE) return unchanged
                val window = ByteBuffer.allocate(minOf(LINE_SEARCH_BYTES.toLong(), slice.end - slice.start).toInt())
                while (window.hasRemaining()) {
                    if (channel.read(window, slice.start + window.position()) <= 0) break
                }
                val read = window.position()
                var skip = 0
                while (skip < minOf(read, MAX_UTF8_CONTINUATION) && (window.get(skip).toInt() and 0xC0) == 0x80) skip++
                val character = slice.start + skip
                for (index in 0 until read) {
                    if (window.get(index) == NEWLINE) return Cut(slice.start + index + 1, character)
                }
                return Cut(character, character)
            } catch (_: IOException) {
                return unchanged
            }
        }
    }

    private fun freeName(directory: File, now: Instant): File {
        val base = PREFIX + stamp.format(now)
        for (attempt in 1..MAX_NAME_ATTEMPTS) {
            val name = if (attempt == 1) base + EXTENSION else "$base-$attempt$EXTENSION"
            if (!File(directory, name).exists() && !File(directory, name + PARTIAL).exists()) return File(directory, name)
        }
        throw IOException("No free snapshot name for $base")
    }

    private fun Context.findActivity(): Activity? {
        var current: Context? = this
        while (current is ContextWrapper) {
            if (current is Activity) return current
            current = current.baseContext
        }
        return null
    }
}
