package io.github.sillybunnyteam.sillybunny.web.downloads

import java.io.ByteArrayOutputStream
import java.util.Base64

/**
 * Bounded `data:` URL decoding for downloads (plan §4.5), following the WHATWG data: URL processor:
 * the body is percent-decoded and, with `;base64`, then forgiving-base64 decoded. A URL longer than
 * [decode]'s character limit or a body larger than its byte limit is refused.
 */
internal object DataUrls {
    class Decoded(val mime: String, val bytes: ByteArray)

    fun decode(url: String, maxChars: Int, maxBytes: Int): Decoded? {
        if (url.length > maxChars || !url.startsWith("data:", ignoreCase = true)) return null
        val input = url.substringBefore('#')
        val comma = input.indexOf(',', 5)
        if (comma < 0) return null
        var type = input.substring(5, comma).trim(::isAsciiWhitespace)
        val semicolon = type.lastIndexOf(';')
        val base64 = semicolon >= 0 && type.substring(semicolon + 1).trimStart(' ').equals("base64", ignoreCase = true)
        if (base64) type = type.substring(0, semicolon).trimEnd(' ')
        if (type.startsWith(";")) type = "text/plain$type"
        val mime = FileNames.normalizeMime(type) ?: "text/plain"
        val raw = percentDecode(input.substring(comma + 1), if (base64) maxBytes.toLong() * 2 + 4 else maxBytes.toLong())
            ?: return null
        val bytes = if (base64) forgivingBase64(raw) ?: return null else raw
        if (bytes.size > maxBytes) return null
        return Decoded(mime, bytes)
    }

    /** A short key that identifies [url] for duplicate checks without keeping a large URL around. */
    fun key(url: String): String = if (url.length <= KEY_CHARS) url else "${url.take(KEY_CHARS)}#${url.length}"

    private const val KEY_CHARS = 64

    // WHATWG percent-decode: a '%' not followed by two hex digits stays a literal '%'.
    private fun percentDecode(body: String, limit: Long): ByteArray? {
        val output = ByteArrayOutputStream(minOf(body.length.toLong(), limit, 1L shl 20).toInt())
        var index = 0
        while (index < body.length) {
            val char = body[index]
            when {
                char == '%' && isHex(body.getOrNull(index + 1)) && isHex(body.getOrNull(index + 2)) -> {
                    output.write(body.substring(index + 1, index + 3).toInt(16))
                    index += 3
                }
                char.code < 0x80 -> {
                    output.write(char.code)
                    index++
                }
                else -> {
                    val end = if (Character.isHighSurrogate(char) && index + 1 < body.length) index + 2 else index + 1
                    output.write(body.substring(index, end).toByteArray(Charsets.UTF_8))
                    index = end
                }
            }
            if (output.size() > limit) return null
        }
        return output.toByteArray()
    }

    private fun isHex(char: Char?): Boolean = char != null && (char in '0'..'9' || char in 'a'..'f' || char in 'A'..'F')

    // WHATWG forgiving-base64 decode over the isomorphic decoding of the percent-decoded body.
    private fun forgivingBase64(input: ByteArray): ByteArray? {
        val text = StringBuilder(input.size)
        for (byte in input) {
            val char = (byte.toInt() and 0xff).toChar()
            if (!isAsciiWhitespace(char)) text.append(char)
        }
        var length = text.length
        if (length % 4 == 0 && length >= 2 && text[length - 1] == '=') {
            length--
            if (text[length - 1] == '=') length--
        }
        if (length % 4 == 1) return null
        for (index in 0 until length) {
            val char = text[index]
            if (!(char in 'A'..'Z' || char in 'a'..'z' || char in '0'..'9' || char == '+' || char == '/')) return null
        }
        val padded = StringBuilder(length + 3).append(text, 0, length)
        while (padded.length % 4 != 0) padded.append('=')
        return try {
            Base64.getDecoder().decode(padded.toString())
        } catch (_: IllegalArgumentException) {
            null
        }
    }

    private fun isAsciiWhitespace(char: Char): Boolean =
        char == ' ' || char == '\t' || char == '\n' || char == '\u000c' || char == '\r'
}
