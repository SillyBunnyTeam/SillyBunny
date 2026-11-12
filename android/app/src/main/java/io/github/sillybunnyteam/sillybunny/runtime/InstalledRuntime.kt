package io.github.sillybunnyteam.sillybunny.runtime

import io.github.sillybunnyteam.sillybunny.runtime.StrictJson.count
import io.github.sillybunnyteam.sillybunny.runtime.StrictJson.sha256
import io.github.sillybunnyteam.sillybunny.runtime.StrictJson.text
import org.json.JSONException
import org.json.JSONObject

/** The installed APK a runtime layout must match (plan §2.4 step 1). */
data class ApkFingerprint(
    val versionCode: Long,
    val lastUpdateTime: Long,
    val nativeLibraryDir: String,
    val manifestSha256: String,
)

/** Why [RuntimeLayout.ensure] rebuilt the layout. */
enum class RefreshReason {
    /** No finished layout exists: first launch, an interrupted earlier run, or an unreadable record. */
    MISSING,
    VERSION_CODE,
    LAST_UPDATE_TIME,

    /** Changes on every install, including `adb install -r` of the same APK. */
    NATIVE_LIBRARY_DIR,

    /** `runtime-manifest.json` differs: the bundled payload changed. */
    MANIFEST,
}

/**
 * `runtime/installed-runtime.json`, written last into a finished layout: which APK the layout was built
 * for and what it holds (schema 1).
 */
data class InstalledRuntime(
    val fingerprint: ApkFingerprint,
    val abi: String,
    val versions: Map<String, String>,
    val gitCoreLinks: Int,
    val npmFiles: Int,
    val npmContentBytes: Long,
    val npmDigest: String,
    val npmSyncMode: NpmSyncMode,
) {
    /** Every way [current] differs from the APK this layout was built for; empty when it still matches. */
    fun refreshReasons(current: ApkFingerprint): Set<RefreshReason> = buildSet {
        if (fingerprint.versionCode != current.versionCode) add(RefreshReason.VERSION_CODE)
        if (fingerprint.lastUpdateTime != current.lastUpdateTime) add(RefreshReason.LAST_UPDATE_TIME)
        if (fingerprint.nativeLibraryDir != current.nativeLibraryDir) add(RefreshReason.NATIVE_LIBRARY_DIR)
        if (fingerprint.manifestSha256 != current.manifestSha256) add(RefreshReason.MANIFEST)
    }

    fun toJson(): String {
        val versionObject = JSONObject()
        versions.toSortedMap().forEach { (name, version) -> versionObject.put(name, version) }
        return JSONObject()
            .put("schema", SCHEMA)
            .put("versionCode", fingerprint.versionCode)
            .put("lastUpdateTime", fingerprint.lastUpdateTime)
            .put("nativeLibraryDir", fingerprint.nativeLibraryDir)
            .put("manifestSha256", fingerprint.manifestSha256)
            .put("abi", abi)
            .put("versions", versionObject)
            .put("gitCoreLinks", gitCoreLinks)
            .put(
                "npm",
                JSONObject()
                    .put("files", npmFiles)
                    .put("contentBytes", npmContentBytes)
                    .put("digest", npmDigest)
                    .put("syncMode", npmSyncMode.name),
            )
            .toString(2) + "\n"
    }

    companion object {
        const val SCHEMA = 1
        const val MAX_BYTES = 64 * 1024

        /** Parses [bytes], or returns null unless they are a complete schema-1 record. */
        fun parse(bytes: ByteArray): InstalledRuntime? = try {
            val root = StrictJson.parse(bytes, MAX_BYTES)
            require(root.count("schema") == SCHEMA.toLong())
            val versionObject = root.getJSONObject("versions")
            val npm = root.getJSONObject("npm")
            InstalledRuntime(
                fingerprint = ApkFingerprint(
                    versionCode = root.count("versionCode"),
                    lastUpdateTime = root.count("lastUpdateTime"),
                    nativeLibraryDir = root.text("nativeLibraryDir"),
                    manifestSha256 = root.sha256("manifestSha256"),
                ),
                abi = root.text("abi"),
                versions = versionObject.keys().asSequence().associateWith { versionObject.text(it) }.toSortedMap(),
                gitCoreLinks = root.count("gitCoreLinks").also { require(it <= GitCoreLinks.MAX_LINKS) }.toInt(),
                npmFiles = npm.count("files").also { require(it <= NpmArchive.MAX_FILES) }.toInt(),
                npmContentBytes = npm.count("contentBytes"),
                npmDigest = npm.sha256("digest"),
                npmSyncMode = NpmSyncMode.valueOf(npm.text("syncMode")),
            )
        } catch (_: JSONException) {
            null
        } catch (_: IllegalArgumentException) {
            null
        }
    }
}
