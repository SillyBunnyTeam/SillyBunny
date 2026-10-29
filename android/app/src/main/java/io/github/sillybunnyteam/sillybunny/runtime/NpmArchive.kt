package io.github.sillybunnyteam.sillybunny.runtime

import io.github.sillybunnyteam.sillybunny.runtime.RuntimeManifest.Companion.toHex
import java.io.File
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardOpenOption
import java.security.MessageDigest
import java.util.concurrent.Callable
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.zip.CRC32
import java.util.zip.DataFormatException
import java.util.zip.Inflater

/** How [NpmArchive.extractTo] makes the extracted files safe to publish before the layout swap. */
enum class NpmSyncMode {
    /** fsync every file as soon as it is written, then every new directory (the S2.5 baseline). */
    EACH_FILE,

    /** Write every file first, then fsync all new files and directories from a small thread pool. */
    BATCHED,

    /**
     * No fsync; read every file back and check the completion digest. This survives the process being
     * killed, but not a power loss shortly after the swap, so it is measured and never the default.
     */
    VERIFIED,
}

/**
 * The bundled npm ZIP (plan §2.2 `lib/node_modules/npm/`), parsed from its central directory with the
 * rules the build applies: plain relative paths only, no duplicates, no links or special files, stored or
 * deflated entries only, no ZIP64 and bounded totals. Extraction checks every entry's size and CRC-32.
 */
class NpmArchive private constructor(
    private val bytes: ByteArray,
    private val directories: List<String>,
    val entries: List<Entry>,
) {
    /** One file in the archive. */
    class Entry internal constructor(
        val path: String,
        internal val method: Int,
        val crc32: Long,
        internal val compressedSize: Int,
        val size: Long,
        internal val dataOffset: Int,
    )

    val files: Int get() = entries.size

    val contentBytes: Long get() = entries.sumOf { it.size }

    /** SHA-256 over every file's path, size and CRC-32 in path order: what a complete extraction holds. */
    val digest: String by lazy { digestOf(entries.map { Triple(it.path, it.size, it.crc32) }) }

    /**
     * Extracts every entry below [target], which must not exist yet, and makes the result safe to publish
     * as [mode] describes. Any mismatch fails with [RuntimeLayoutException.Reason.NPM_ARCHIVE]. Missing
     * parents of [target] are created but not synced: the caller owns them.
     */
    @Throws(IOException::class)
    fun extractTo(target: File, mode: NpmSyncMode) {
        val root = target.toPath()
        root.parent?.let { Files.createDirectories(it) }
        Files.createDirectory(root)
        val created = HashSet<Path>().apply { add(root) }

        fun directory(path: Path) {
            if (path in created) return
            path.parent?.let(::directory)
            // A fresh tree has nothing here yet, so an existing file, directory or link fails.
            Files.createDirectory(path)
            created.add(path)
        }

        val inflater = Inflater(true)
        val buffer = ByteArray(BUFFER)
        val written = ArrayList<Path>(entries.size)
        try {
            directories.forEach { directory(root.resolve(it)) }
            for (entry in entries) {
                val path = root.resolve(entry.path)
                path.parent?.let(::directory)
                FileChannel.open(path, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE).use { channel ->
                    write(entry, channel, inflater, buffer)
                    if (mode == NpmSyncMode.EACH_FILE) channel.force(true)
                }
                written.add(path)
            }
        } finally {
            inflater.end()
        }
        when (mode) {
            // New directory entries are made durable too, so every synced file stays reachable by its path.
            NpmSyncMode.EACH_FILE -> created.forEach(LayoutFiles::syncDirectory)
            NpmSyncMode.BATCHED -> syncAll(written, created)
            NpmSyncMode.VERIFIED -> verify(root, buffer)
        }
    }

    private fun write(entry: Entry, channel: FileChannel, inflater: Inflater, buffer: ByteArray) {
        val crc = CRC32()
        var size = 0L

        fun emit(source: ByteArray, offset: Int, length: Int) {
            size += length
            if (size > entry.size) fail()
            crc.update(source, offset, length)
            val wrapped = ByteBuffer.wrap(source, offset, length)
            while (wrapped.hasRemaining()) channel.write(wrapped)
        }

        if (entry.method == STORED) {
            emit(bytes, entry.dataOffset, entry.compressedSize)
        } else {
            inflater.reset()
            inflater.setInput(bytes, entry.dataOffset, entry.compressedSize)
            var padded = false
            while (!inflater.finished()) {
                val consumed = inflater.bytesRead
                val count = try {
                    inflater.inflate(buffer)
                } catch (error: DataFormatException) {
                    fail(error)
                }
                when {
                    count > 0 -> emit(buffer, 0, count)
                    inflater.finished() -> Unit
                    inflater.needsDictionary() -> fail()
                    // zlib may ask for one byte past a raw deflate stream; anything more is a truncated entry.
                    inflater.needsInput() -> {
                        if (padded) fail()
                        inflater.setInput(PADDING)
                        padded = true
                    }
                    inflater.bytesRead == consumed -> fail()
                }
            }
            val read = inflater.bytesRead - entry.compressedSize
            if (read != 0L && !(padded && read == 1L)) fail()
        }
        if (size != entry.size || crc.value != entry.crc32) fail()
    }

    private fun syncAll(files: List<Path>, directories: Collection<Path>) {
        val pool = Executors.newFixedThreadPool(SYNC_THREADS)
        try {
            val syncs = files.map { path -> pool.submit(Callable { LayoutFiles.syncFile(path) }) } +
                directories.map { path -> pool.submit(Callable { LayoutFiles.syncDirectory(path) }) }
            syncs.forEach { pending ->
                try {
                    pending.get()
                } catch (error: ExecutionException) {
                    throw error.cause as? IOException ?: IOException(error.cause)
                }
            }
        } finally {
            pool.shutdownNow()
        }
    }

    private fun verify(root: Path, buffer: ByteArray) {
        val found = entries.map { entry ->
            val crc = CRC32()
            var size = 0L
            FileChannel.open(root.resolve(entry.path), StandardOpenOption.READ).use { channel ->
                while (true) {
                    val read = channel.read(ByteBuffer.wrap(buffer))
                    if (read < 0) break
                    crc.update(buffer, 0, read)
                    size += read
                }
            }
            Triple(entry.path, size, crc.value)
        }
        if (digestOf(found) != digest) fail()
    }

    companion object {
        // runtime-packaging.gradle.kts (checkNpmArchive) applies these limits and parse's rules at build time.
        const val MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
        const val MAX_FILES = 20_000
        const val MAX_CONTENT_BYTES = 512L * 1024 * 1024
        private const val MAX_PATH = 1024
        private const val MAX_DEPTH = 64
        private const val BUFFER = 64 * 1024
        private const val STORED = 0
        private const val DEFLATED = 8
        private const val SYNC_THREADS = 4

        // Encrypted, strongly encrypted and masked-header entries cannot be read without secrets.
        private const val UNSUPPORTED_FLAGS = 0x0001 or 0x0040 or 0x2000
        private val PADDING = ByteArray(1)

        // The same segment rule the build applies before packaging npm.zip.
        private val SEGMENT = Regex("[A-Za-z0-9_.@+~-]+")

        /**
         * Checks [bytes] against [expected] (size and SHA-256, before anything else is read), then parses
         * the archive and checks its file count and content size against [expected] too.
         */
        fun open(bytes: ByteArray, expected: NpmArchiveRecord): NpmArchive {
            if (bytes.size.toLong() != expected.size || bytes.size > MAX_ARCHIVE_BYTES) fail()
            if (RuntimeManifest.sha256(bytes) != expected.sha256) fail()
            val archive = parse(bytes)
            if (archive.files != expected.files || archive.contentBytes != expected.contentBytes) fail()
            return archive
        }

        /** A relative path of plain segments: never absolute, empty, `.`, `..` or with a backslash. */
        fun isSafePath(path: String): Boolean {
            if (path.isEmpty() || path.length > MAX_PATH) return false
            val segments = path.split('/')
            return segments.size <= MAX_DEPTH && segments.all { it != "." && it != ".." && SEGMENT.matches(it) }
        }

        internal fun parse(bytes: ByteArray): NpmArchive {
            val end = endRecord(bytes)
            val count = u16(bytes, end + 10)
            if (u16(bytes, end + 4) != 0 || u16(bytes, end + 6) != 0 || u16(bytes, end + 8) != count) fail()
            val directoryStart = u32(bytes, end + 16)
            // The central directory must end right at the end record: no ZIP64 records, no other data.
            if (count == 0xFFFF || directoryStart + u32(bytes, end + 12) != end.toLong()) fail()
            var position = directoryStart.toInt()
            val paths = HashSet<String>()
            val directories = ArrayList<String>()
            val files = ArrayList<Entry>()
            var total = 0L
            repeat(count) {
                if (position + 46 > end || u32(bytes, position) != 0x02014b50L) fail()
                val flags = u16(bytes, position + 8)
                val method = u16(bytes, position + 10)
                val compressed = u32(bytes, position + 20)
                val size = u32(bytes, position + 24)
                val nameLength = u16(bytes, position + 28)
                val next = position + 46 + nameLength + u16(bytes, position + 30) + u16(bytes, position + 32)
                val localHeader = u32(bytes, position + 42)
                if (next > end || u16(bytes, position + 34) != 0) fail()
                // ISO-8859-1 keeps every byte; the segment rule then rejects anything outside plain ASCII.
                val name = String(bytes, position + 46, nameLength, Charsets.ISO_8859_1)
                val directory = name.endsWith('/')
                val path = name.removeSuffix("/")
                if (!isSafePath(path) || !paths.add(path)) fail()
                if ((flags and UNSUPPORTED_FLAGS) != 0 || (method != STORED && method != DEFLATED)) fail()
                if (compressed == 0xFFFFFFFFL || size == 0xFFFFFFFFL || localHeader == 0xFFFFFFFFL) fail()
                // The upper half of the external attributes holds a Unix mode: only plain files and directories.
                val type = (u32(bytes, position + 38) ushr 16) and 0xF000
                if (type != 0L && type != (if (directory) 0x4000L else 0x8000L)) fail()
                if (directory) {
                    if (size != 0L) fail()
                    directories += path
                } else {
                    if (method == STORED && compressed != size) fail()
                    total += size
                    if (files.size >= MAX_FILES || total > MAX_CONTENT_BYTES) fail()
                    val data = dataOffset(bytes, localHeader, name, method, compressed, directoryStart)
                    files += Entry(path, method, u32(bytes, position + 16), compressed.toInt(), size, data)
                }
                position = next
            }
            if (position.toLong() != end.toLong()) fail()
            // A file may not also be the parent directory of another entry.
            val parents = HashSet<String>()
            (files.map { it.path } + directories).forEach { path ->
                var slash = path.lastIndexOf('/')
                while (slash > 0) {
                    parents += path.substring(0, slash)
                    slash = path.lastIndexOf('/', slash - 1)
                }
            }
            if (files.any { it.path in parents }) fail()
            return NpmArchive(bytes, directories, files)
        }

        private fun endRecord(bytes: ByteArray): Int {
            val last = bytes.size - 22
            for (at in last downTo maxOf(0, last - 0xFFFF)) {
                if (u32(bytes, at) == 0x06054b50L && at + 22 + u16(bytes, at + 20) == bytes.size) return at
            }
            fail()
        }

        private fun dataOffset(bytes: ByteArray, header: Long, name: String, method: Int, compressed: Long, limit: Long): Int {
            if (header + 30 > limit || u32(bytes, header.toInt()) != 0x04034b50L) fail()
            val at = header.toInt()
            if (u16(bytes, at + 8) != method || (u16(bytes, at + 6) and UNSUPPORTED_FLAGS) != 0) fail()
            val nameLength = u16(bytes, at + 26)
            val start = header + 30 + nameLength + u16(bytes, at + 28)
            if (start + compressed > limit || String(bytes, at + 30, nameLength, Charsets.ISO_8859_1) != name) fail()
            return start.toInt()
        }

        private fun digestOf(files: List<Triple<String, Long, Long>>): String {
            val digest = MessageDigest.getInstance("SHA-256")
            files.sortedBy { it.first }.forEach { (path, size, crc) ->
                digest.update("$path\u0000$size\u0000$crc\n".toByteArray(Charsets.UTF_8))
            }
            return digest.digest().toHex()
        }

        private fun u16(bytes: ByteArray, at: Int): Int =
            (bytes[at].toInt() and 0xFF) or ((bytes[at + 1].toInt() and 0xFF) shl 8)

        private fun u32(bytes: ByteArray, at: Int): Long =
            u16(bytes, at).toLong() or (u16(bytes, at + 2).toLong() shl 16)

        private fun fail(cause: Throwable? = null): Nothing =
            throw RuntimeLayoutException(RuntimeLayoutException.Reason.NPM_ARCHIVE, cause)
    }
}
