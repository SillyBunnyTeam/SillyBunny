package io.github.sillybunnyteam.sillybunny.web.downloads

import android.webkit.MimeTypeMap
import androidx.core.net.toUri
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.Charset
import java.nio.charset.CodingErrorAction
import java.text.Normalizer

/**
 * File names and MIME types for saved downloads (plan §4.5). Requested names come from pages,
 * servers and URLs, so they are untrusted: [sanitize] keeps one safe display name and
 * [saveMime] picks the `ACTION_CREATE_DOCUMENT` type that keeps that name's extension.
 */
internal object FileNames {
    const val FALLBACK = "download"
    const val DEFAULT_MIME = "application/octet-stream"
    private const val MAX_NAME_BYTES = 255
    private const val MAX_EXTENSION_CHARS = 16
    private const val MAX_HEADER_CHARS = 8_192

    private val mimeName = Regex("[a-z0-9][a-z0-9!#$&^_.+-]{0,126}")
    private val reservedDeviceNames = Regex("(?i)(con|prn|aux|nul|com[1-9]|lpt[1-9])(\\..*)?")
    private val percentEscape = Regex("%[0-9A-Fa-f]{2}")

    /** The `filename*` (RFC 8187) or `filename` parameter of a Content-Disposition header. */
    fun fromContentDisposition(header: String?): String? {
        if (header.isNullOrBlank() || header.length > MAX_HEADER_CHARS) return null
        val parameters = dispositionParameters(header)
        parameters["filename*"]?.let(::decodeExtendedValue)?.takeIf { it.isNotBlank() }?.let { return it }
        return parameters["filename"]?.let(::decodeLegacyValue)?.takeIf { it.isNotBlank() }
    }

    /** The last path segment of an HTTP(S) URL, percent-decoded. */
    fun fromUrl(url: String?): String? {
        if (url.isNullOrEmpty() || !(url.startsWith("http:", true) || url.startsWith("https:", true))) return null
        return try {
            url.toUri().lastPathSegment?.takeIf { it.isNotBlank() }
        } catch (_: RuntimeException) {
            null
        }
    }

    /**
     * One safe display name: the last path component only, without control, bidi, separator or
     * reserved characters, leading or trailing dots and spaces, or a reserved device name, at most
     * 255 UTF-8 bytes with the extension kept. A name that is only an extension, such as `.json`,
     * becomes `download.json`. Falls back to [fallback] when nothing usable remains.
     */
    fun sanitize(name: String?, fallback: String = FALLBACK): String {
        val normalized = Normalizer.normalize(name.orEmpty(), Normalizer.Form.NFC)
        val base = normalized.replace('\\', '/').substringAfterLast('/')
        val replaced = buildString(base.length) {
            var index = 0
            while (index < base.length) {
                val codePoint = base.codePointAt(index)
                if (isUnsafe(codePoint)) append('_') else appendCodePoint(codePoint)
                index += Character.charCount(codePoint)
            }
        }
        val cleaned = replaced.trim { it.isWhitespace() || it == '.' }
        if (cleaned.isEmpty() || cleaned.all { it == '_' || it == '.' || it.isWhitespace() }) {
            return if (fallback == FALLBACK) FALLBACK else sanitize(fallback)
        }
        val extensionOnly = replaced.trimStart { it.isWhitespace() }.startsWith('.') && '.' !in cleaned &&
            cleaned.length <= MAX_EXTENSION_CHARS && cleaned.all(Char::isLetterOrDigit)
        if (extensionOnly) return "$FALLBACK.${cleaned.lowercase()}"
        val safe = if (reservedDeviceNames.matches(cleaned)) "_$cleaned" else cleaned
        return truncate(safe)
    }

    /** Adds the extension that [mime] maps to when [name] has none. */
    fun withExtensionFor(
        name: String,
        mime: String?,
        extensionForMime: (String) -> String? = ::platformExtension,
    ): String {
        if (extension(name) != null) return name
        val type = normalizeMime(mime)?.takeUnless { it == DEFAULT_MIME } ?: return name
        val extension = extensionForMime(type)?.lowercase()
            ?.takeIf { it.length in 1..MAX_EXTENSION_CHARS && it.all(Char::isLetterOrDigit) }
            ?: return name
        return truncate("$name.$extension")
    }

    /**
     * The MIME type to create a document named [name] with. Document providers append the MIME
     * type's own extension when it disagrees with the name, so the type comes from the name's
     * extension, and an unknown extension uses octet-stream, which providers leave unchanged.
     */
    fun saveMime(name: String, mimeForExtension: (String) -> String? = ::platformMime): String =
        extension(name)?.let(mimeForExtension)?.let(::normalizeMime) ?: DEFAULT_MIME

    /** The lowercase extension of [name], or null when it has none or it is not plain letters and digits. */
    fun extension(name: String): String? {
        val dot = name.lastIndexOf('.')
        if (dot <= 0 || dot == name.length - 1) return null
        val extension = name.substring(dot + 1)
        if (extension.length > MAX_EXTENSION_CHARS || !extension.all(Char::isLetterOrDigit)) return null
        return extension.lowercase()
    }

    /** A lowercase `type/subtype` without parameters, or null when [value] is not one. */
    fun normalizeMime(value: String?): String? {
        val mime = value?.substringBefore(';')?.trim()?.lowercase() ?: return null
        val slash = mime.indexOf('/')
        if (slash <= 0 || slash != mime.lastIndexOf('/')) return null
        if (!mimeName.matches(mime.substring(0, slash)) || !mimeName.matches(mime.substring(slash + 1))) return null
        return mime
    }

    private fun platformExtension(mime: String): String? = MimeTypeMap.getSingleton().getExtensionFromMimeType(mime)

    private fun platformMime(extension: String): String? = MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension)

    private fun isUnsafe(codePoint: Int): Boolean =
        codePoint < 0x20 || codePoint in 0x7f..0x9f ||
            codePoint == '/'.code || codePoint == '\\'.code || codePoint in reservedChars ||
            codePoint in 0x200b..0x200f || codePoint in 0x202a..0x202e || codePoint in 0x2066..0x2069 ||
            codePoint == 0x2028 || codePoint == 0x2029 || codePoint == 0xfeff ||
            codePoint in Character.MIN_SURROGATE.code..Character.MAX_SURROGATE.code ||
            codePoint == 0xfffe || codePoint == 0xffff

    private val reservedChars = setOf('<', '>', ':', '"', '|', '?', '*').map { it.code }.toSet()

    private fun truncate(name: String): String {
        if (name.toByteArray(Charsets.UTF_8).size <= MAX_NAME_BYTES) return name
        val extension = extension(name)?.let { name.substring(name.length - it.length - 1) }.orEmpty()
        val limit = MAX_NAME_BYTES - extension.toByteArray(Charsets.UTF_8).size
        val base = StringBuilder(name.substring(0, name.length - extension.length))
        while (base.isNotEmpty() && base.toString().toByteArray(Charsets.UTF_8).size > limit) {
            val last = base.codePointBefore(base.length)
            base.setLength(base.length - Character.charCount(last))
        }
        val trimmed = base.toString().trimEnd { it.isWhitespace() || it == '.' }
        return (trimmed.ifEmpty { FALLBACK }) + extension
    }

    private fun dispositionParameters(header: String): Map<String, String> {
        val parameters = LinkedHashMap<String, String>()
        var index = header.indexOf(';')
        if (index < 0) return parameters
        while (index < header.length) {
            while (index < header.length && (header[index] == ';' || header[index].isWhitespace())) index++
            val nameStart = index
            while (index < header.length && header[index] != '=' && header[index] != ';') index++
            val name = header.substring(nameStart, index).trim().lowercase()
            if (index >= header.length || header[index] != '=') continue
            index++
            while (index < header.length && header[index].isWhitespace()) index++
            val value = StringBuilder()
            if (index < header.length && header[index] == '"') {
                index++
                while (index < header.length && header[index] != '"') {
                    if (header[index] == '\\' && index + 1 < header.length) index++
                    value.append(header[index])
                    index++
                }
                index++
            } else {
                while (index < header.length && header[index] != ';') value.append(header[index++])
            }
            if (name.isNotEmpty() && name !in parameters) parameters[name] = value.toString().trim()
        }
        return parameters
    }

    private fun decodeExtendedValue(value: String): String? {
        val first = value.indexOf('\'')
        val second = if (first < 0) -1 else value.indexOf('\'', first + 1)
        if (second < 0) return null
        val charset = when (value.substring(0, first).trim().lowercase()) {
            "utf-8" -> Charsets.UTF_8
            "iso-8859-1" -> Charsets.ISO_8859_1
            else -> return null
        }
        val bytes = percentDecode(value.substring(second + 1)) ?: return null
        return decodeStrict(bytes, charset)
    }

    // Like browsers, accept percent-encoded UTF-8 in a plain filename parameter when it decodes cleanly.
    private fun decodeLegacyValue(value: String): String {
        if (!percentEscape.containsMatchIn(value)) return value
        val bytes = percentDecode(value) ?: return value
        return decodeStrict(bytes, Charsets.UTF_8) ?: value
    }

    private fun percentDecode(value: String): ByteArray? {
        val output = ByteArrayOutputStream(value.length)
        var index = 0
        while (index < value.length) {
            val char = value[index]
            if (char == '%') {
                if (index + 2 >= value.length) return null
                val digits = value.substring(index + 1, index + 3)
                if (!digits.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }) return null
                output.write(digits.toInt(16))
                index += 3
            } else {
                output.write(char.toString().toByteArray(Charsets.UTF_8))
                index++
            }
        }
        return output.toByteArray()
    }

    private fun decodeStrict(bytes: ByteArray, charset: Charset): String? = try {
        charset.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(bytes))
            .toString()
    } catch (_: CharacterCodingException) {
        null
    }
}
