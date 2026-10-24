package io.github.sillybunnyteam.sillybunny.runtime

import org.json.JSONObject

/**
 * Strict readers for the runtime's JSON files. org.json alone coerces types (`getString` accepts numbers,
 * `getLong` accepts `"12"`), so every accessor checks the JSON type itself. Any deviation throws
 * [IllegalArgumentException] or [org.json.JSONException]; callers map both to their own failure.
 */
internal object StrictJson {
    private val SHA256 = Regex("[0-9a-f]{64}")

    fun parse(bytes: ByteArray, maxBytes: Int): JSONObject {
        require(bytes.size <= maxBytes)
        return JSONObject(String(bytes, Charsets.UTF_8))
    }

    /** A non-blank JSON string. */
    fun JSONObject.text(key: String): String {
        val value = get(key)
        require(value is String && value.isNotBlank())
        return value
    }

    /** An integral, non-negative JSON number; fractions, strings and booleans are rejected. */
    fun JSONObject.count(key: String): Long {
        val value = get(key)
        require(value is Int || value is Long)
        return (value as Number).toLong().also { require(it >= 0) }
    }

    /** Lowercase SHA-256 hex. */
    fun JSONObject.sha256(key: String = "sha256"): String = text(key).also { require(SHA256.matches(it)) }
}
