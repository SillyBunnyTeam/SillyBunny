package io.github.sillybunnyteam.sillybunny.runtime

import io.github.sillybunnyteam.sillybunny.runtime.StrictJson.count
import io.github.sillybunnyteam.sillybunny.runtime.StrictJson.sha256
import io.github.sillybunnyteam.sillybunny.runtime.StrictJson.text
import org.json.JSONException
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest

/** SHA-256 (lowercase hex) and byte size of one bundled file. */
data class RuntimeFileRecord(val sha256: String, val size: Long)

/** The npm archive as `assets/runtime/npm.json` and the manifest's `npm` object describe it. */
data class NpmArchiveRecord(
    val version: String,
    val sha256: String,
    val size: Long,
    val files: Int,
    val contentBytes: Long,
)

/**
 * The build-generated `assets/runtime-manifest.json` (plan §2.1): versions, plus SHA-256 and size of every
 * bundled native per ABI and of every runtime asset. Its own SHA-256 identifies the payload a layout was
 * built from.
 */
class RuntimeManifest private constructor(
    val sha256: String,
    val versions: Map<String, String>,
    val natives: Map<String, Map<String, RuntimeFileRecord>>,
    val assets: Map<String, RuntimeFileRecord>,
    val npm: NpmArchiveRecord,
    val gitCoreLinkCount: Int,
) {
    /**
     * The packaged ABI whose natives all exist in [nativeLibraryDir] with their recorded sizes, or null when
     * the installed APK carries no runtime for this device.
     */
    fun matchAbi(nativeLibraryDir: File): String? = natives.entries.firstOrNull { (_, records) ->
        records.all { (name, record) -> File(nativeLibraryDir, name).let { it.isFile && it.length() == record.size } }
    }?.key

    companion object {
        const val ASSET = "runtime-manifest.json"
        const val NPM_ARCHIVE = "runtime/npm.zip"
        const val NPM_JSON = "runtime/npm.json"
        const val GIT_CORE_LINKS = "runtime/git-core-links.txt"
        const val CA_BUNDLE = "runtime/certs/cert.pem"
        const val GIT_TEMPLATES = "runtime/git-templates/"
        const val MAX_BYTES = 4 * 1024 * 1024

        /** Packaged natives are always `lib*.so`: the only names the package manager extracts. */
        internal val NATIVE_NAME = Regex("lib[A-Za-z0-9_.+-]+\\.so")

        private val ABIS = setOf("arm64-v8a", "armeabi-v7a", "x86_64")
        private val VERSIONS = listOf("node", "npm", "git", "bash")
        private val REQUIRED_NATIVES = setOf(
            "libbash.so",
            "libgit.so",
            "libgit-remote-http.so",
            "libnode.so",
            "libnpm.so",
            "libnpx.so",
        )
        private val REQUIRED_ASSETS = setOf(NPM_ARCHIVE, NPM_JSON, GIT_CORE_LINKS, CA_BUNDLE)
        private val ASSET_SEGMENT = Regex("[A-Za-z0-9_.+-]+")

        /** Parses [bytes] strictly; any deviation from schema 1 is [RuntimeLayoutException.Reason.MANIFEST]. */
        fun parse(bytes: ByteArray): RuntimeManifest = strictly(RuntimeLayoutException.Reason.MANIFEST) {
            val root = StrictJson.parse(bytes, MAX_BYTES)
            require(root.count("schema") == 1L)
            val versionObject = root.getJSONObject("versions")
            val versions = VERSIONS.associateWith { versionObject.text(it) }
            val abiObject = root.getJSONObject("abis")
            val natives = sortedMapOf<String, Map<String, RuntimeFileRecord>>()
            abiObject.keys().forEach { abi ->
                require(abi in ABIS)
                val records = abiObject.getJSONObject(abi).getJSONObject("natives").records { NATIVE_NAME.matches(it) }
                require(records.keys.containsAll(REQUIRED_NATIVES))
                natives[abi] = records
            }
            require(natives.isNotEmpty())
            val assets = root.getJSONObject("assets").records(::isSafeAssetPath)
            require(assets.keys.containsAll(REQUIRED_ASSETS))
            val npm = root.getJSONObject("npm").npmRecord()
            require(assets.getValue(NPM_ARCHIVE) == RuntimeFileRecord(npm.sha256, npm.size))
            val linkCount = root.count("gitCoreLinkCount").also { require(it in 1..GitCoreLinks.MAX_LINKS) }.toInt()
            RuntimeManifest(sha256(bytes), versions, natives, assets, npm, linkCount)
        }

        /** Parses `assets/runtime/npm.json` strictly; deviations are [RuntimeLayoutException.Reason.NPM_ARCHIVE]. */
        fun parseNpmRecord(bytes: ByteArray): NpmArchiveRecord = strictly(RuntimeLayoutException.Reason.NPM_ARCHIVE) {
            val root = StrictJson.parse(bytes, MAX_BYTES)
            require(root.count("schema") == 1L)
            root.npmRecord()
        }

        /** A relative asset path made only of plain segments, never `.`, `..`, empty or absolute. */
        internal fun isSafeAssetPath(path: String): Boolean = path.length <= 1024 &&
            path.split('/').all { it != "." && it != ".." && ASSET_SEGMENT.matches(it) }

        internal fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).toHex()

        internal fun ByteArray.toHex(): String {
            val hex = "0123456789abcdef"
            return buildString(size * 2) {
                this@toHex.forEach { byte ->
                    append(hex[(byte.toInt() shr 4) and 0xF])
                    append(hex[byte.toInt() and 0xF])
                }
            }
        }

        private inline fun <T> strictly(reason: RuntimeLayoutException.Reason, block: () -> T): T = try {
            block()
        } catch (error: JSONException) {
            throw RuntimeLayoutException(reason, error)
        } catch (error: IllegalArgumentException) {
            throw RuntimeLayoutException(reason, error)
        }

        private fun JSONObject.npmRecord() = NpmArchiveRecord(
            version = text("version"),
            sha256 = sha256(),
            size = count("size"),
            files = count("files").also { require(it in 1..NpmArchive.MAX_FILES) }.toInt(),
            contentBytes = count("contentBytes").also { require(it <= NpmArchive.MAX_CONTENT_BYTES) },
        )

        private fun JSONObject.records(validName: (String) -> Boolean): Map<String, RuntimeFileRecord> {
            val records = sortedMapOf<String, RuntimeFileRecord>()
            keys().forEach { name ->
                require(validName(name))
                val record = getJSONObject(name)
                records[name] = RuntimeFileRecord(record.sha256(), record.count("size"))
            }
            return records
        }
    }
}
