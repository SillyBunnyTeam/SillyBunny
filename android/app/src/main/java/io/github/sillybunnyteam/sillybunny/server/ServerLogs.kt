package io.github.sillybunnyteam.sillybunny.server

import java.io.BufferedOutputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.OutputStream

/**
 * A size-capped log: [baseName] is the newest file, then `.1` up to `.(keep - 1)`, the oldest. Writing
 * never throws; a full disk only loses log lines.
 */
internal class RotatingLogFile(
    private val directory: File,
    private val baseName: String,
    private val maxBytes: Long,
    private val keep: Int,
) {
    private var output: OutputStream? = null
    private var size = 0L

    init {
        require(keep >= 1 && maxBytes > 0)
    }

    @Synchronized
    fun append(line: String) {
        val bytes = (line + "\n").toByteArray(Charsets.UTF_8)
        try {
            if (output == null) open()
            if (size > 0 && size + bytes.size > maxBytes) {
                rotate()
                open()
            }
            output?.write(bytes)
            size += bytes.size
        } catch (_: IOException) {
            closeQuietly()
        }
    }

    @Synchronized
    fun flush() {
        try {
            output?.flush()
        } catch (_: IOException) {
            closeQuietly()
        }
    }

    /** Starts a new newest file, keeping the previous one as `.1`. */
    @Synchronized
    fun rotateNow() {
        try {
            rotate()
        } catch (_: IOException) {
            closeQuietly()
        }
    }

    @Synchronized
    fun close() {
        flush()
        closeQuietly()
    }

    /** Existing files, oldest first. */
    fun files(): List<File> = (keep - 1 downTo 0).map(::file).filter { it.isFile }

    private fun file(index: Int): File = if (index == 0) File(directory, baseName) else File(directory, "$baseName.$index")

    private fun open() {
        if (!directory.isDirectory && !directory.mkdirs()) throw IOException("logs")
        val newest = file(0)
        size = if (newest.isFile) newest.length() else 0
        output = BufferedOutputStream(FileOutputStream(newest, true), 16 * 1024)
    }

    private fun rotate() {
        closeQuietly()
        file(keep - 1).delete()
        for (index in keep - 2 downTo 0) {
            val source = file(index)
            if (source.isFile) source.renameTo(file(index + 1))
        }
        size = 0
    }

    private fun closeQuietly() {
        try {
            output?.close()
        } catch (_: IOException) {
            // Nothing else to do for a log.
        }
        output = null
    }
}

/** The last [capacity] lines, for the log view and error screens. */
internal class LineTail(private val capacity: Int) {
    private val lines = ArrayDeque<String>(capacity)

    @Synchronized
    fun add(line: String) {
        if (lines.size == capacity) lines.removeFirst()
        lines.addLast(line)
    }

    @Synchronized
    fun addAll(values: List<String>) = values.forEach(::add)

    @Synchronized
    fun snapshot(): List<String> = lines.toList()

    @Synchronized
    fun last(count: Int): List<String> = lines.toList().takeLast(count)

    @Synchronized
    fun clear() = lines.clear()
}

/**
 * Splits a process's merged output into lines. Every occurrence of [secret] is replaced before lines are
 * split, also across read boundaries (adapted from S2.5's `StreamCapture`), so no line holds the launch
 * token, not even one cut by a read boundary or by the end of the output. Only a trailing partial match
 * of [secret] waits for the next read, so a complete line is never held back. `\n`, `\r\n` and a lone
 * `\r` end a line; longer lines are cut at [maxLineBytes].
 */
internal class RedactingLineSplitter(
    secret: String?,
    private val maxLineBytes: Int = 8192,
    private val onLine: (String) -> Unit,
) {
    private val secret = secret?.toByteArray(Charsets.UTF_8) ?: ByteArray(0)
    private var pending = ByteArray(0)
    private val line = ByteArrayOutputStream()
    private var afterCarriageReturn = false
    private var hasContent = false

    fun feed(buffer: ByteArray, count: Int) {
        val bytes = pending + buffer.copyOfRange(0, count)
        var offset = 0
        while (offset < bytes.size) {
            if (matches(bytes, offset)) {
                emit(REPLACEMENT)
                offset += secret.size
                continue
            }
            // The rest may be the start of the secret, completed by the next read.
            if (secret.isNotEmpty() && bytes.size - offset < secret.size && isPrefixOfSecret(bytes, offset)) break
            emit(bytes[offset])
            offset++
        }
        pending = bytes.copyOfRange(offset, bytes.size)
    }

    /** Flushes the rest; a trailing partial match of the secret is replaced too. */
    fun finish() {
        val bytes = pending
        pending = ByteArray(0)
        var partialAt = bytes.size
        for (start in bytes.indices) {
            if (secret.isNotEmpty() && isPrefixOfSecret(bytes, start)) {
                partialAt = start
                break
            }
        }
        for (index in 0 until partialAt) emit(bytes[index])
        if (partialAt < bytes.size) emit(REPLACEMENT)
        if (hasContent) flushLine()
    }

    private fun matches(bytes: ByteArray, offset: Int): Boolean {
        if (secret.isEmpty() || offset + secret.size > bytes.size) return false
        for (index in secret.indices) if (bytes[offset + index] != secret[index]) return false
        return true
    }

    private fun isPrefixOfSecret(bytes: ByteArray, start: Int): Boolean {
        for (index in start until bytes.size) if (bytes[index] != secret[index - start]) return false
        return true
    }

    private fun emit(bytes: ByteArray) = bytes.forEach(::emit)

    private fun emit(byte: Byte) {
        when (byte) {
            NEWLINE -> {
                if (afterCarriageReturn) afterCarriageReturn = false else flushLine()
            }
            CARRIAGE_RETURN -> {
                flushLine()
                afterCarriageReturn = true
            }
            else -> {
                afterCarriageReturn = false
                hasContent = true
                if (line.size() < maxLineBytes) line.write(byte.toInt())
            }
        }
    }

    private fun flushLine() {
        onLine(String(line.toByteArray(), Charsets.UTF_8))
        line.reset()
        hasContent = false
    }

    companion object {
        const val REDACTED = "[REDACTED]"
        private val REPLACEMENT = REDACTED.toByteArray(Charsets.UTF_8)
        private const val NEWLINE = '\n'.code.toByte()
        private const val CARRIAGE_RETURN = '\r'.code.toByte()
    }
}
