package io.github.sillybunnyteam.sillybunny.settings

import android.content.res.AssetManager
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.FileNotFoundException
import java.io.IOException
import java.io.InputStream
import java.nio.charset.Charset
import java.security.MessageDigest
import java.util.Locale

/** Opens a packaged notices file by name, or returns null when it is absent. Blocking. */
fun interface NoticesSource {
    @Throws(IOException::class)
    fun open(name: String): InputStream?
}

/** The notices track p523 packages into the APK's assets (plan §5.3); debug builds may have none. */
class AssetNoticesSource(private val assets: AssetManager) : NoticesSource {
    override fun open(name: String): InputStream? = try {
        assets.open(name)
    } catch (_: FileNotFoundException) {
        null
    }
}

/** One license text inside `THIRD_PARTY_NOTICES`: a byte range and its declared encoding. */
class NoticeLicense internal constructor(
    val path: String,
    val offset: Int,
    val length: Int,
    internal val charset: Charset,
)

/** One entry of `THIRD_PARTY_NOTICES.json`; [offset] and [length] are bytes of the notices text. */
class NoticeComponent internal constructor(
    val id: String,
    val section: String,
    val name: String,
    val version: String,
    /** The SPDX expression, or null when the generator recorded none. */
    val spdx: String?,
    val offset: Int,
    val length: Int,
    val licenses: List<NoticeLicense>,
)

sealed interface NoticesLoad {
    class Loaded(val notices: ThirdPartyNotices) : NoticesLoad

    data class Unavailable(val reason: Reason) : NoticesLoad

    enum class Reason { MISSING, UNKNOWN_SCHEMA, MALFORMED }
}

/**
 * `THIRD_PARTY_NOTICES` and the index `android/runtime/notices.py` writes beside it (schema 1). Fields
 * read: `schema`; `notices.file`, `notices.byteLength` and `notices.sha256`; and per component `id`,
 * `section`, `name`, `version`, `spdx`, `offset`, `length` and `licenses[]` (`path`, `encoding`,
 * `offset`, `length`). Anything else is ignored; anything inconsistent makes the whole pair unavailable.
 */
class ThirdPartyNotices private constructor(
    val components: List<NoticeComponent>,
    private val text: ByteArray,
) {
    private val licenses = components.flatMap { it.licenses }

    /** The component's header and license texts, each license decoded with its declared encoding. */
    fun noticeText(component: NoticeComponent): String =
        decode(component.offset, component.offset + component.length, component.licenses)

    /** The whole `THIRD_PARTY_NOTICES` file. */
    fun fullText(): String = decode(0, text.size, licenses)

    // License ranges are validated as ordered, disjoint and inside their component, so everything
    // between them is the generator's UTF-8 framing.
    private fun decode(start: Int, end: Int, ranges: List<NoticeLicense>): String {
        val builder = StringBuilder(end - start)
        var position = start
        for (license in ranges) {
            if (license.offset > position) builder.append(String(text, position, license.offset - position, Charsets.UTF_8))
            builder.append(String(text, license.offset, license.length, license.charset))
            position = license.offset + license.length
        }
        if (position < end) builder.append(String(text, position, end - position, Charsets.UTF_8))
        return builder.toString()
    }

    companion object {
        const val NOTICES_ASSET = "THIRD_PARTY_NOTICES"
        const val INDEX_ASSET = "THIRD_PARTY_NOTICES.json"
        const val SCHEMA = 1L
        const val MAX_INDEX_BYTES = 8 * 1024 * 1024
        const val MAX_NOTICES_BYTES = 64 * 1024 * 1024

        /** Lines per displayed text block, so long notices render lazily. */
        const val CHUNK_LINES = 100

        private const val MAX_FIELD_LENGTH = 1024
        private val sha256 = Regex("[0-9a-fA-F]{64}")
        private val charsets: Map<String, Charset> = mapOf("utf-8" to Charsets.UTF_8, "iso-8859-1" to Charsets.ISO_8859_1)

        /** Never throws: a missing, malformed or unknown-schema pair is [NoticesLoad.Unavailable]. Blocking. */
        fun load(source: NoticesSource): NoticesLoad = try {
            parse(source)
        } catch (_: Malformed) {
            NoticesLoad.Unavailable(NoticesLoad.Reason.MALFORMED)
        } catch (_: IOException) {
            NoticesLoad.Unavailable(NoticesLoad.Reason.MALFORMED)
        } catch (_: JSONException) {
            NoticesLoad.Unavailable(NoticesLoad.Reason.MALFORMED)
        } catch (_: RuntimeException) {
            NoticesLoad.Unavailable(NoticesLoad.Reason.MALFORMED)
        }

        /** Splits [text] into blocks of at most [lines] lines. */
        fun chunks(text: String, lines: Int = CHUNK_LINES): List<String> {
            require(lines > 0)
            val result = ArrayList<String>()
            var start = 0
            var count = 0
            for (index in text.indices) {
                if (text[index] == '\n' && ++count == lines) {
                    result += text.substring(start, index)
                    start = index + 1
                    count = 0
                }
            }
            if (start < text.length) result += text.substring(start)
            return result
        }

        private fun parse(source: NoticesSource): NoticesLoad {
            val indexBytes = source.open(INDEX_ASSET)?.use { readCapped(it, MAX_INDEX_BYTES) }
                ?: return NoticesLoad.Unavailable(NoticesLoad.Reason.MISSING)
            val root = JSONObject(String(indexBytes, Charsets.UTF_8))
            val schema = root.opt("schema")
            if (schema !is Int && schema !is Long) throw Malformed()
            if ((schema as Number).toLong() != SCHEMA) return NoticesLoad.Unavailable(NoticesLoad.Reason.UNKNOWN_SCHEMA)

            val file = root.optJSONObject("notices") ?: throw Malformed()
            if (file.opt("file") != NOTICES_ASSET) throw Malformed()
            val byteLength = file.count("byteLength")
            val digest = file.opt("sha256") as? String ?: throw Malformed()
            if (!sha256.matches(digest) || byteLength > MAX_NOTICES_BYTES) throw Malformed()
            val text = source.open(NOTICES_ASSET)?.use { readCapped(it, MAX_NOTICES_BYTES) }
                ?: return NoticesLoad.Unavailable(NoticesLoad.Reason.MISSING)
            if (text.size != byteLength || sha256Hex(text) != digest.lowercase(Locale.ROOT)) throw Malformed()

            val components = components(root.optJSONArray("components") ?: throw Malformed(), text.size)
            return NoticesLoad.Loaded(ThirdPartyNotices(components, text))
        }

        private fun components(array: JSONArray, size: Int): List<NoticeComponent> {
            val ids = HashSet<String>()
            var previousEnd = 0
            return List(array.length()) { index ->
                val item = array.optJSONObject(index) ?: throw Malformed()
                val id = item.text("id")
                if (!ids.add(id)) throw Malformed()
                val offset = item.count("offset")
                val length = item.count("length")
                if (offset < previousEnd || length <= 0 || offset.toLong() + length > size) throw Malformed()
                previousEnd = offset + length
                NoticeComponent(
                    id = id,
                    section = item.text("section"),
                    name = item.text("name"),
                    version = item.text("version"),
                    spdx = item.optionalText("spdx"),
                    offset = offset,
                    length = length,
                    licenses = licenses(item.optJSONArray("licenses") ?: throw Malformed(), offset, offset + length),
                )
            }
        }

        private fun licenses(array: JSONArray, start: Int, end: Int): List<NoticeLicense> {
            if (array.length() == 0) throw Malformed()
            var previousEnd = start
            return List(array.length()) { index ->
                val item = array.optJSONObject(index) ?: throw Malformed()
                val offset = item.count("offset")
                val length = item.count("length")
                if (offset < previousEnd || length <= 0 || offset.toLong() + length > end) throw Malformed()
                previousEnd = offset + length
                val charset = (item.opt("encoding") as? String)?.let(charsets::get) ?: throw Malformed()
                NoticeLicense(item.text("path"), offset, length, charset)
            }
        }

        private fun JSONObject.text(name: String): String {
            val value = opt(name) as? String ?: throw Malformed()
            if (value.isBlank() || value.length > MAX_FIELD_LENGTH) throw Malformed()
            return value
        }

        /** A JSON null or an absent field is null; anything but a usable string is malformed. */
        private fun JSONObject.optionalText(name: String): String? {
            val value = opt(name)
            if (value == null || value == JSONObject.NULL) return null
            if (value !is String || value.isBlank() || value.length > MAX_FIELD_LENGTH) throw Malformed()
            return value
        }

        private fun JSONObject.count(name: String): Int {
            val value = opt(name)
            val number = if (value is Int) value.toLong() else if (value is Long) value else throw Malformed()
            if (number !in 0..Int.MAX_VALUE) throw Malformed()
            return number.toInt()
        }

        private fun sha256Hex(bytes: ByteArray): String =
            MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(Locale.ROOT, it) }
    }

    private class Malformed : Exception()
}

/** Reads all of [input], or throws [IOException] once it exceeds [maxBytes]. */
internal fun readCapped(input: InputStream, maxBytes: Int): ByteArray {
    val output = ByteArrayOutputStream()
    val buffer = ByteArray(64 * 1024)
    var total = 0L
    while (true) {
        val read = input.read(buffer)
        if (read < 0) break
        total += read
        if (total > maxBytes) throw IOException("More than $maxBytes bytes")
        output.write(buffer, 0, read)
    }
    return output.toByteArray()
}
