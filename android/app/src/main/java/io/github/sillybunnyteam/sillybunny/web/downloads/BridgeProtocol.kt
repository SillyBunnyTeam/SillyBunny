package io.github.sillybunnyteam.sillybunny.web.downloads

import org.json.JSONException
import org.json.JSONObject
import java.util.Base64

/** Bounds for exports (plan §4.5). Sizes are bytes unless named otherwise. */
internal class TransferLimits(
    /** Largest single export through the bridge or HTTP. */
    val maxTransferBytes: Long = 4L shl 30,
    /** Payload bytes per bridge chunk; every chunk but the last is exactly this long. */
    val chunkBytes: Int = 256 * 1024,
    /** Chunks the page may send before it waits for an acknowledgement. */
    val window: Int = 4,
    /** Exports alive at once (being prepared, waiting for a destination or being written). */
    val maxActive: Int = 16,
    /** A streaming bridge export with no message for this long is cancelled. */
    val idleTimeoutMillis: Long = 60_000,
    val maxDataUrlChars: Int = 4 shl 20,
    val maxDataUrlBytes: Int = 3 shl 20,
    /** Free cache space kept in reserve while HTTP downloads are buffered. */
    val reserveBytes: Long = 64L shl 20,
    /** How long a captured or navigated URL is remembered for duplicate and POST checks. */
    val recentMillis: Long = 30_000,
) {
    init {
        require(chunkBytes in 1..(8 shl 20)) { "chunkBytes" }
        require(window in 1..64) { "window" }
        require(maxActive >= 1) { "maxActive" }
    }

    /** Longest JSON message accepted: a base64 chunk plus its envelope. */
    val maxMessageChars: Int get() = (chunkBytes + 2) / 3 * 4 + 512
}

/** A message from the page script, see `assets/web/transfers.js`. */
internal sealed class BridgeMessage {
    /** A new document started; transfers of earlier documents in this WebView are cancelled. */
    class Hello(val doc: String) : BridgeMessage()

    /** The document is going away; its unfinished transfers are cancelled. */
    class Bye(val doc: String) : BridgeMessage()

    /** A Blob export of [size] bytes; [key] identifies the captured `blob:`/`data:` URL, if any. */
    class Begin(
        val doc: String,
        val id: String,
        val name: String?,
        val mime: String?,
        val size: Long,
        val key: String?,
    ) : BridgeMessage()

    /** One base64 chunk, used when binary messages are unavailable. */
    class Chunk(val id: String, val seq: Int, val bytes: ByteArray) : BridgeMessage()

    class End(val id: String, val size: Long) : BridgeMessage()

    /** The page could not read an export it had begun. */
    class Abort(val id: String) : BridgeMessage()

    /** The page could not read an export before it began, for example an already revoked Blob URL. */
    class Fail(val doc: String) : BridgeMessage()

    /** A same-origin `<a download>` click on an HTTP(S) URL, fetched natively. */
    class Get(val doc: String, val url: String, val name: String?) : BridgeMessage()

    /** A form POST navigation is starting; a download from it must not be replayed as a GET. */
    class Post(val doc: String, val url: String) : BridgeMessage()
}

/** A binary chunk: `[u32 slot][u32 seq][payload]`, big-endian, payload from [OFFSET]. */
internal class ChunkFrame(val slot: Int, val seq: Int, val data: ByteArray) {
    val length: Int get() = data.size - OFFSET

    companion object {
        const val OFFSET = 8
    }
}

/** Parses page messages strictly and builds native replies. Anything malformed is null. */
internal object BridgeMessages {
    private val idPattern = Regex("[0-9a-f]{16,64}")
    const val MAX_NAME_CHARS = 1_024
    private const val MAX_MIME_CHARS = 256
    private const val MAX_KEY_CHARS = 2_048

    fun parse(text: String, limits: TransferLimits): BridgeMessage? {
        if (text.isEmpty() || text.length > limits.maxMessageChars) return null
        val json = try {
            JSONObject(text)
        } catch (_: JSONException) {
            return null
        }
        val type = json.opt("t") as? String ?: return null
        return try {
            when (type) {
                "hello" -> BridgeMessage.Hello(id(json, "doc") ?: return null)
                "bye" -> BridgeMessage.Bye(id(json, "doc") ?: return null)
                "begin" -> BridgeMessage.Begin(
                    doc = id(json, "doc") ?: return null,
                    id = id(json, "id") ?: return null,
                    name = text(json, "name", MAX_NAME_CHARS),
                    mime = text(json, "mime", MAX_MIME_CHARS),
                    size = count(json, "size") ?: return null,
                    key = text(json, "key", MAX_KEY_CHARS)?.takeIf { it.startsWith("blob:") || it.startsWith("data:") },
                )
                "chunk" -> BridgeMessage.Chunk(
                    id = id(json, "id") ?: return null,
                    seq = sequence(json) ?: return null,
                    bytes = base64(json.opt("data")) ?: return null,
                )
                "end" -> BridgeMessage.End(id(json, "id") ?: return null, count(json, "size") ?: return null)
                "abort" -> BridgeMessage.Abort(id(json, "id") ?: return null)
                "fail" -> BridgeMessage.Fail(id(json, "doc") ?: return null)
                "get" -> BridgeMessage.Get(
                    doc = id(json, "doc") ?: return null,
                    url = text(json, "url", DownloadPolicy.MAX_URL_CHARS) ?: return null,
                    name = text(json, "name", MAX_NAME_CHARS),
                )
                "post" -> BridgeMessage.Post(
                    doc = id(json, "doc") ?: return null,
                    url = text(json, "url", DownloadPolicy.MAX_URL_CHARS) ?: return null,
                )
                else -> null
            }
        } catch (_: JSONException) {
            null
        }
    }

    fun parseFrame(data: ByteArray, limits: TransferLimits): ChunkFrame? {
        if (data.size <= ChunkFrame.OFFSET || data.size > ChunkFrame.OFFSET + limits.chunkBytes) return null
        val slot = readInt(data, 0)
        val seq = readInt(data, 4)
        if (slot < 0 || seq < 0) return null
        return ChunkFrame(slot, seq, data)
    }

    fun ready(id: String, slot: Int, limits: TransferLimits, binary: Boolean): String =
        JSONObject()
            .put("t", "ready")
            .put("id", id)
            .put("slot", slot)
            .put("chunk", limits.chunkBytes)
            .put("win", limits.window)
            .put("bin", binary)
            .toString()

    fun ack(id: String, seq: Int): String = JSONObject().put("t", "ack").put("id", id).put("seq", seq).toString()

    fun done(id: String): String = JSONObject().put("t", "done").put("id", id).toString()

    fun cancel(id: String, reason: String): String =
        JSONObject().put("t", "cancel").put("id", id).put("reason", reason).toString()

    /** Asks the page script to export a `blob:` URL it can still resolve; [url] becomes a JS string literal. */
    fun saveUrlScript(url: String): String =
        "(function(){var t=window[Symbol.for('sillybunny.transfers')];" +
            "return !!(t&&t.saveUrl(${JSONObject.quote(url)}));})()"

    private fun id(json: JSONObject, name: String): String? =
        (json.opt(name) as? String)?.takeIf(idPattern::matches)

    private fun text(json: JSONObject, name: String, maxChars: Int): String? =
        (json.opt(name) as? String)?.takeIf { it.length <= maxChars }

    private fun count(json: JSONObject, name: String): Long? {
        val value = json.opt(name) as? Number ?: return null
        val long = value.toLong()
        return long.takeIf { it >= 0 && it.toDouble() == value.toDouble() }
    }

    private fun sequence(json: JSONObject): Int? = count(json, "seq")?.takeIf { it <= Int.MAX_VALUE }?.toInt()

    private fun base64(value: Any?): ByteArray? {
        val text = value as? String ?: return null
        return try {
            Base64.getDecoder().decode(text)
        } catch (_: IllegalArgumentException) {
            null
        }
    }

    private fun readInt(data: ByteArray, offset: Int): Int =
        (data[offset].toInt() and 0xff shl 24) or (data[offset + 1].toInt() and 0xff shl 16) or
            (data[offset + 2].toInt() and 0xff shl 8) or (data[offset + 3].toInt() and 0xff)
}

/**
 * Ordering and size checks for one bridge export: chunks arrive in sequence, every chunk but the
 * last is exactly [chunkBytes] long, and the total equals the size declared at `begin`.
 */
internal class TransferProgress(val declaredSize: Long, private val chunkBytes: Int) {
    var received: Long = 0
        private set
    private var nextSeq = 0

    /** True when chunk [seq] of [length] bytes is the expected next one; records it. */
    fun accept(seq: Int, length: Int): Boolean {
        val expected = minOf(chunkBytes.toLong(), declaredSize - received)
        if (seq != nextSeq || expected <= 0 || length.toLong() != expected) return false
        received += length
        nextSeq++
        return true
    }

    /** True when every declared byte has arrived and [size] matches. */
    fun complete(size: Long): Boolean = size == declaredSize && received == declaredSize
}
