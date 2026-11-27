package io.github.sillybunnyteam.sillybunny.settings

import android.content.res.AssetManager
import org.json.JSONException
import org.json.JSONObject
import java.io.IOException

/** One bundled runtime component and its version, for the read-only Runtime entry. */
data class RuntimeVersion(val component: String, val version: String)

/** Bundled runtime versions, or an empty list when they are unknown. Blocking; called off the main thread. */
fun interface RuntimeVersionsSource {
    fun read(): List<RuntimeVersion>
}

/**
 * Reads `versions` from the build-generated `assets/runtime-manifest.json` (plan §2.1). The APK runs Node
 * only (plan §9.10); a missing or unexpected manifest just shows no versions.
 */
class AssetRuntimeVersions(private val assets: AssetManager) : RuntimeVersionsSource {
    override fun read(): List<RuntimeVersion> = try {
        assets.open(ASSET).use { parse(readCapped(it, MAX_BYTES)) }
    } catch (_: IOException) {
        emptyList()
    }

    companion object {
        const val ASSET = "runtime-manifest.json"
        const val MAX_BYTES = 4 * 1024 * 1024
        private const val MAX_TEXT = 64
        private val order = listOf("node", "npm", "git", "bash")

        fun parse(bytes: ByteArray): List<RuntimeVersion> {
            val root = try {
                JSONObject(String(bytes, Charsets.UTF_8))
            } catch (_: JSONException) {
                return emptyList()
            }
            val schema = root.opt("schema")
            if ((schema !is Int && schema !is Long) || (schema as Number).toLong() != 1L) return emptyList()
            val versions = root.optJSONObject("versions") ?: return emptyList()
            val keys = versions.keys().asSequence().toList()
            return (order.filter { it in keys } + keys.filter { it !in order }.sorted()).mapNotNull { key ->
                val version = versions.opt(key) as? String
                if (version.isNullOrBlank() || version.length > MAX_TEXT || key.isBlank() || key.length > MAX_TEXT) {
                    null
                } else {
                    RuntimeVersion(key, version)
                }
            }
        }
    }
}
