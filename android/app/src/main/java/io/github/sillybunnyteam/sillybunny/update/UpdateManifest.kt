package io.github.sillybunnyteam.sillybunny.update

import android.util.JsonReader
import android.util.JsonToken
import java.io.StringReader
import java.util.Locale

data class ApkAsset(val name: String, val sha256: String, val size: Long)

data class UpdateManifest(
    val versionCode: Long,
    val versionName: String,
    val prerelease: Boolean,
    val releaseTag: String,
    val defaultRef: String,
    val minSdk: Int,
    val signingCertSha256: String,
    val inputsHash: String,
    val asset: ApkAsset,
)

object UpdateManifestParser {
    const val MAX_APK_BYTES: Long = 300L * 1024 * 1024

    private val hex = Regex("[0-9a-fA-F]{64}")
    private val abiName = Regex("[a-z0-9][a-z0-9_-]{0,31}")
    private val assetName = Regex("[A-Za-z0-9][A-Za-z0-9._-]{0,191}\\.apk")

    fun parse(json: String, abi: String, sdk: Int): UpdateManifest? {
        return try {
            parseManifest(UpdateJson.parse(json) as? Map<*, *> ?: return null, abi, sdk)
        } catch (_: Exception) {
            null
        }
    }

    internal fun isSafeAssetName(name: String): Boolean =
        assetName.matches(name) && ".." !in name

    internal fun isSha256(value: String): Boolean = hex.matches(value)

    private fun parseManifest(root: Map<*, *>, abi: String, sdk: Int): UpdateManifest? {
        if (sdk <= 0 || !abiName.matches(abi) || root.positiveLong("schema") != 1L) return null
        val versionCode = root.positiveLong("versionCode") ?: return null
        val versionName = root.text("versionName", 128) ?: return null
        val prerelease = root["prerelease"] as? Boolean ?: return null
        val releaseTag = root.text("releaseTag", 256) ?: return null
        val defaultRef = root["defaultRef"] as? String ?: return null
        if (defaultRef != "release" && defaultRef != "staging") return null
        val minSdk = root.positiveLong("minSdk")
            ?.takeIf { it <= sdk.toLong() && it <= Int.MAX_VALUE }?.toInt() ?: return null
        val signingCert = root["signingCertSha256"] as? String ?: return null
        val fingerprint = ApkVerifier.normalizeFingerprint(signingCert) ?: return null
        val inputsHash = (root["inputsHash"] as? String)?.takeIf(::isSha256) ?: return null

        val assets = root["assets"] as? Map<*, *> ?: return null
        if (assets.isEmpty() || assets.size > 16) return null
        var selected: ApkAsset? = null
        val names = mutableSetOf<String>()
        for ((key, value) in assets) {
            if (key !is String || !abiName.matches(key)) return null
            val entry = value as? Map<*, *> ?: return null
            val name = (entry["name"] as? String)?.takeIf(::isSafeAssetName) ?: return null
            if (!names.add(name)) return null
            val sha256 = (entry["sha256"] as? String)?.takeIf(::isSha256) ?: return null
            val size = entry.positiveLong("size")?.takeIf { it <= MAX_APK_BYTES } ?: return null
            if (key == abi) selected = ApkAsset(name, sha256.lowercase(Locale.ROOT), size)
        }

        val runtime = root["runtime"] as? Map<*, *> ?: return null
        for (name in listOf("node", "git", "bash", "npm")) {
            if (runtime.text(name, 128) == null) return null
        }
        if (!runtime.containsKey("bun")) return null
        if (runtime["bun"] != null && runtime.text("bun", 128) == null) return null

        return UpdateManifest(
            versionCode = versionCode,
            versionName = versionName,
            prerelease = prerelease,
            releaseTag = releaseTag,
            defaultRef = defaultRef,
            minSdk = minSdk,
            signingCertSha256 = fingerprint.joinToString("") { "%02x".format(it.toInt() and 0xff) },
            inputsHash = inputsHash.lowercase(Locale.ROOT),
            asset = selected ?: return null,
        )
    }

    private fun Map<*, *>.positiveLong(key: String): Long? =
        (this[key] as? UpdateJson.Number)?.positiveLong()

    private fun Map<*, *>.text(key: String, maxLength: Int): String? =
        (this[key] as? String)?.takeIf {
            it.length in 1..maxLength && it.isNotBlank() && it.none { char -> char.code < 0x20 || char.code == 0x7f }
        }
}

// JsonReader preserves token types; JSONObject's coercion and permissive syntax are unsuitable here.
internal object UpdateJson {
    const val MAX_BYTES = 2 * 1024 * 1024
    private const val MAX_DEPTH = 32
    private const val MAX_NODES = 30_000
    private const val MAX_ENTRIES = 4_096
    private val positiveInteger = Regex("[1-9][0-9]*")
    private val jsonNumber = Regex("-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?")

    data class Number(val literal: String) {
        fun positiveLong(): Long? = literal.takeIf(positiveInteger::matches)?.toLongOrNull()
    }

    fun parse(json: String): Any? {
        if (json.length > MAX_BYTES || json.toByteArray(Charsets.UTF_8).size > MAX_BYTES || !strictTokens(json)) {
            return null
        }
        return try {
            JsonReader(StringReader(json)).use { reader ->
                reader.isLenient = false
                val remaining = intArrayOf(MAX_NODES)
                val result = readValue(reader, 0, remaining)
                check(reader.peek() == JsonToken.END_DOCUMENT)
                result
            }
        } catch (_: Exception) {
            null
        }
    }

    private fun readValue(reader: JsonReader, depth: Int, remaining: IntArray): Any? {
        check(depth <= MAX_DEPTH && remaining[0]-- > 0)
        return when (reader.peek()) {
            JsonToken.BEGIN_OBJECT -> {
                reader.beginObject()
                val values = linkedMapOf<String, Any?>()
                while (reader.hasNext()) {
                    check(values.size < MAX_ENTRIES)
                    val name = reader.nextName()
                    check(name.length <= 256 && validUnicode(name) && !values.containsKey(name))
                    values[name] = readValue(reader, depth + 1, remaining)
                }
                reader.endObject()
                values
            }
            JsonToken.BEGIN_ARRAY -> {
                reader.beginArray()
                val values = mutableListOf<Any?>()
                while (reader.hasNext()) {
                    check(values.size < MAX_ENTRIES)
                    values.add(readValue(reader, depth + 1, remaining))
                }
                reader.endArray()
                values
            }
            JsonToken.STRING -> reader.nextString().also { check(validUnicode(it)) }
            JsonToken.NUMBER -> Number(reader.nextString())
            JsonToken.BOOLEAN -> reader.nextBoolean()
            JsonToken.NULL -> {
                reader.nextNull()
                null
            }
            else -> error("")
        }
    }

    private fun validUnicode(value: String): Boolean {
        var index = 0
        while (index < value.length) {
            val char = value[index++]
            if (char.isHighSurrogate()) {
                if (index >= value.length || !value[index++].isLowSurrogate()) return false
            } else if (char.isLowSurrogate()) {
                return false
            }
        }
        return true
    }

    // Android's strict reader still accepts some non-JSON escapes and case-insensitive literals.
    private fun strictTokens(json: String): Boolean {
        var index = 0
        while (index < json.length) {
            when (val char = json[index++]) {
                ' ', '\t', '\r', '\n', '{', '}', '[', ']', ':', ',' -> Unit
                '"' -> {
                    var closed = false
                    while (index < json.length) {
                        val next = json[index++]
                        if (next.code < 0x20) return false
                        if (next == '"') {
                            closed = true
                            break
                        }
                        if (next == '\\') {
                            if (index >= json.length) return false
                            when (json[index++]) {
                                '"', '\\', '/', 'b', 'f', 'n', 'r', 't' -> Unit
                                'u' -> {
                                    if (index + 4 > json.length) return false
                                    repeat(4) {
                                        if (json[index++] !in "0123456789abcdefABCDEF") return false
                                    }
                                }
                                else -> return false
                            }
                        }
                    }
                    if (!closed) return false
                }
                else -> {
                    if (char !in "-0123456789tfn") return false
                    val start = index - 1
                    while (index < json.length && json[index] !in " \t\r\n{}[]:,") index++
                    val literal = json.substring(start, index)
                    if (literal != "true" && literal != "false" && literal != "null" && !jsonNumber.matches(literal)) {
                        return false
                    }
                }
            }
        }
        return true
    }
}
