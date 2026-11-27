package io.github.sillybunnyteam.sillybunny.runtime

import io.github.sillybunnyteam.sillybunny.runtime.RuntimeManifest.Companion.toHex
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.StandardOpenOption
import java.security.MessageDigest

/** File helpers for the layout: create-only writes, fsync, and deletes that never follow symlinks. */
internal object LayoutFiles {
    private const val BUFFER = 64 * 1024

    /** Writes [data] to a new file; an existing file or link at [path] fails instead of being replaced. */
    fun writeNew(path: Path, data: ByteArray) {
        FileChannel.open(path, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE).use { channel ->
            val buffer = ByteBuffer.wrap(data)
            while (buffer.hasRemaining()) channel.write(buffer)
            channel.force(true)
        }
    }

    /**
     * Copies [input] into a new file at [path] while hashing it, and fsyncs it. Fails with
     * [RuntimeLayoutException.Reason.ASSET] unless the bytes match [expected].
     */
    fun copyVerified(input: InputStream, path: Path, expected: RuntimeFileRecord) {
        val digest = MessageDigest.getInstance("SHA-256")
        var size = 0L
        input.use { stream ->
            FileChannel.open(path, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE).use { channel ->
                val bytes = ByteArray(BUFFER)
                while (true) {
                    val read = stream.read(bytes)
                    if (read < 0) break
                    size += read
                    if (size > expected.size) throw RuntimeLayoutException(RuntimeLayoutException.Reason.ASSET)
                    digest.update(bytes, 0, read)
                    val buffer = ByteBuffer.wrap(bytes, 0, read)
                    while (buffer.hasRemaining()) channel.write(buffer)
                }
                if (size != expected.size || digest.digest().toHex() != expected.sha256) {
                    throw RuntimeLayoutException(RuntimeLayoutException.Reason.ASSET)
                }
                channel.force(true)
            }
        }
    }

    /** Reads at most [limit] bytes; longer input fails with [reason]. */
    fun readBounded(input: InputStream, limit: Int, reason: RuntimeLayoutException.Reason): ByteArray = input.use { stream ->
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(BUFFER)
        while (true) {
            val read = stream.read(buffer)
            if (read < 0) break
            if (out.size() + read > limit) throw RuntimeLayoutException(reason)
            out.write(buffer, 0, read)
        }
        out.toByteArray()
    }

    fun syncFile(path: Path) {
        FileChannel.open(path, StandardOpenOption.READ).use { it.force(true) }
    }

    /** Best effort: not every filesystem lets a directory be opened for fsync. */
    fun syncDirectory(path: Path) {
        try {
            FileChannel.open(path, StandardOpenOption.READ).use { it.force(true) }
        } catch (_: IOException) {
            // The rename that publishes a layout is synced by the next successful directory sync.
        }
    }

    /** Deletes [path] and, for a real directory, everything below it. Symlinks are removed, never followed. */
    fun deleteTree(path: Path) {
        if (Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS)) {
            Files.newDirectoryStream(path).use { entries -> entries.forEach(::deleteTree) }
        }
        Files.deleteIfExists(path)
    }
}
