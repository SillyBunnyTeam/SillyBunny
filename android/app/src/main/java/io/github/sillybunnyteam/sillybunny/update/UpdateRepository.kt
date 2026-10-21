package io.github.sillybunnyteam.sillybunny.update

import android.content.Context
import android.os.Build
import io.github.sillybunnyteam.sillybunny.BuildConfig
import java.io.File
import java.io.IOException
import java.net.URI
import java.nio.file.Files
import java.nio.file.LinkOption
import java.security.MessageDigest

data class UpdateCandidate(val manifest: UpdateManifest, val downloadUrl: String)

enum class UpdateCheckFailure { NETWORK, INVALID_MANIFEST, SIGNER_MISMATCH, INVALID_PACKAGE }

sealed interface UpdateCheckResult {
    data class Available(val candidate: UpdateCandidate) : UpdateCheckResult
    data object UpToDate : UpdateCheckResult
    data class Failed(val reason: UpdateCheckFailure) : UpdateCheckResult
}

class UpdateRepository(
    context: Context,
    private val manifestUrl: String = BuildConfig.UPDATE_MANIFEST_URL,
    private val releasesApiUrl: String = BuildConfig.RELEASES_API_URL,
    private val http: UpdateHttpClient = UpdateHttpClient(),
    private val primaryAbi: String = Build.SUPPORTED_ABIS.firstOrNull().orEmpty(),
    private val sdk: Int = Build.VERSION.SDK_INT,
    private val defaultRef: String = BuildConfig.DEFAULT_REF,
    private val installedVersionCode: () -> Long? = { ApkVerifier.installedVersionCode(context) },
    private val installedSigner: () -> ByteArray? = { ApkVerifier.installedSigner(context) },
    private val archiveVerifier: (File, Long, ByteArray) -> Boolean = { apk, version, signer ->
        ApkVerifier.verifyArchive(context, apk, version, signer)
    },
) {
    private val context = context.applicationContext

    fun check(): UpdateCheckResult {
        val version: Long
        val signer: ByteArray
        try {
            version = installedVersionCode()?.takeIf { it >= 0 }
                ?: return failed(UpdateCheckFailure.INVALID_PACKAGE)
            signer = installedSigner()?.takeIf { it.size == 32 }
                ?: return failed(UpdateCheckFailure.INVALID_PACKAGE)
        } catch (_: Exception) {
            return failed(UpdateCheckFailure.INVALID_PACKAGE)
        }
        return try {
            val branch = UpdateChannel.trackedBranch(File(context.filesDir, "SillyBunny"), defaultRef)
            if (branch == "release") checkStable(version, signer) else checkReleases(version, signer)
        } catch (_: Exception) {
            failed(UpdateCheckFailure.NETWORK)
        }
    }

    fun download(candidate: UpdateCandidate, onProgress: (Long, Long) -> Unit = { _, _ -> }): File {
        val manifest = candidate.manifest
        val signer = installedSigner()?.takeIf { it.size == 32 } ?: throw IOException()
        val declaredSigner = ApkVerifier.normalizeFingerprint(manifest.signingCertSha256) ?: throw IOException()
        val currentVersion = installedVersionCode()?.takeIf { it >= 0 } ?: throw IOException()
        if (manifest.versionCode <= currentVersion || manifest.minSdk !in 1..sdk ||
            !MessageDigest.isEqual(signer, declaredSigner) ||
            !UpdateManifestParser.isSafeAssetName(manifest.asset.name) ||
            !UpdateManifestParser.isSha256(manifest.asset.sha256) ||
            manifest.asset.size !in 1..UpdateManifestParser.MAX_APK_BYTES ||
            !http.isAllowedUrl(candidate.downloadUrl)
        ) throw IOException()

        val directory = File(context.cacheDir, "updates")
        if (!directory.mkdirs() && !Files.isDirectory(directory.toPath(), LinkOption.NOFOLLOW_LINKS)) {
            throw IOException()
        }
        val partial = Files.createTempFile(directory.toPath(), "update-", ".part").toFile()
        val complete = File(directory, partial.name.removeSuffix(".part") + ".apk")
        var retained = false
        try {
            http.download(candidate.downloadUrl, partial, manifest.asset.size, manifest.asset.sha256, onProgress)
            if (!archiveVerifier(partial, manifest.versionCode, signer)) throw IOException()
            if (complete.exists() || !partial.renameTo(complete)) throw IOException()
            retained = true
            return complete
        } finally {
            if (!retained) {
                partial.delete()
            }
        }
    }

    private fun checkStable(version: Long, signer: ByteArray): UpdateCheckResult {
        val json = try {
            http.fetchJson(manifestUrl)
        } catch (_: Exception) {
            return failed(UpdateCheckFailure.NETWORK)
        }
        val manifest = UpdateManifestParser.parse(json, primaryAbi, sdk)
            ?: return failed(UpdateCheckFailure.INVALID_MANIFEST)
        if (manifest.prerelease) return failed(UpdateCheckFailure.INVALID_MANIFEST)
        if (manifest.versionCode <= version) return UpdateCheckResult.UpToDate
        if (!signerMatches(manifest, signer)) return failed(UpdateCheckFailure.SIGNER_MISMATCH)
        val downloadUrl = stableDownloadUrl(manifest)
            ?: return failed(UpdateCheckFailure.INVALID_MANIFEST)
        return UpdateCheckResult.Available(UpdateCandidate(manifest, downloadUrl))
    }

    private fun checkReleases(version: Long, signer: ByteArray): UpdateCheckResult {
        val json = try {
            http.fetchJson(releasesApiUrl)
        } catch (_: Exception) {
            return failed(UpdateCheckFailure.NETWORK)
        }
        val releases = UpdateJson.parse(json) as? List<*>
            ?: return failed(UpdateCheckFailure.INVALID_MANIFEST)
        var best: UpdateCandidate? = null
        var fetched = 0
        var sawCurrent = false
        var networkFailure = false
        var invalidManifest = false
        var signerMismatch = false

        for (releaseValue in releases) {
            if (fetched >= MAX_MANIFESTS) break
            val release = releaseValue as? Map<*, *> ?: continue
            if (release["draft"] != false) continue
            val assets = release["assets"] as? List<*> ?: continue
            val manifests = namedAssets(assets, MANIFEST_NAME)
            if (manifests.isEmpty()) continue
            val releaseManifestUrl = manifests.singleOrNull()?.get("browser_download_url") as? String
            if (releaseManifestUrl == null || !http.isAllowedUrl(releaseManifestUrl)) {
                invalidManifest = true
                continue
            }
            fetched++
            val body = try {
                http.fetchJson(releaseManifestUrl)
            } catch (_: Exception) {
                networkFailure = true
                continue
            }
            val manifest = UpdateManifestParser.parse(body, primaryAbi, sdk)
            if (manifest == null) {
                invalidManifest = true
                continue
            }
            if (manifest.versionCode <= version) {
                sawCurrent = true
                continue
            }
            if (!signerMatches(manifest, signer)) {
                signerMismatch = true
                continue
            }
            val apkAssets = namedAssets(assets, manifest.asset.name)
            val downloadUrl = if (apkAssets.isEmpty()) {
                siblingUrl(releaseManifestUrl, manifest.asset.name)
            } else {
                (apkAssets.singleOrNull()?.get("browser_download_url") as? String)?.takeIf(http::isAllowedUrl)
            }
            if (downloadUrl == null) {
                invalidManifest = true
                continue
            }
            val previous = best
            if (previous == null || manifest.versionCode > previous.manifest.versionCode) {
                best = UpdateCandidate(manifest, downloadUrl)
            }
        }
        return best?.let { UpdateCheckResult.Available(it) } ?: when {
            signerMismatch -> failed(UpdateCheckFailure.SIGNER_MISMATCH)
            sawCurrent -> UpdateCheckResult.UpToDate
            networkFailure -> failed(UpdateCheckFailure.NETWORK)
            invalidManifest -> failed(UpdateCheckFailure.INVALID_MANIFEST)
            else -> UpdateCheckResult.UpToDate
        }
    }

    private fun namedAssets(assets: List<*>, name: String): List<Map<*, *>> =
        assets.mapNotNull { it as? Map<*, *> }.filter { it["name"] == name }

    private fun signerMatches(manifest: UpdateManifest, signer: ByteArray): Boolean =
        ApkVerifier.normalizeFingerprint(manifest.signingCertSha256)?.let {
            MessageDigest.isEqual(signer, it)
        } ?: false

    internal fun stableDownloadUrl(manifest: UpdateManifest): String? {
        if (!http.isAllowedUrl(manifestUrl) || !UpdateManifestParser.isSafeAssetName(manifest.asset.name)) return null
        val original = URI(manifestUrl)
        if (original.scheme != "https" || !original.host.equals("github.com", ignoreCase = true) ||
            original.port !in listOf(-1, 443) || original.rawPath != OFFICIAL_LATEST_PATH
        ) return siblingUrl(manifestUrl, manifest.asset.name)

        // latest can advance while the prompt is open; bind the APK to the checked manifest's release.
        val tag = encodeReleaseTag(manifest.releaseTag) ?: return null
        return "$OFFICIAL_RELEASE_DOWNLOAD/$tag/${manifest.asset.name}".takeIf(http::isAllowedUrl)
    }

    private fun encodeReleaseTag(tag: String): String? {
        if (tag.length !in 1..256 || tag.startsWith('.') || tag.endsWith('.') || tag.endsWith(".lock") ||
            ".." in tag || "@{" in tag || tag.any {
                it.isWhitespace() || Character.isISOControl(it) || it in "/\\%?#~^:*["
            }
        ) return null
        var index = 0
        while (index < tag.length) {
            val char = tag[index++]
            if (char.isHighSurrogate()) {
                if (index >= tag.length || !tag[index++].isLowSurrogate()) return null
            } else if (char.isLowSurrogate()) {
                return null
            }
        }
        return buildString {
            for (byte in tag.toByteArray(Charsets.UTF_8)) {
                val value = byte.toInt() and 0xff
                val char = value.toChar()
                if (char in 'a'..'z' || char in 'A'..'Z' || char in '0'..'9' || char in "-._~") {
                    append(char)
                } else {
                    append('%')
                    append(HEX[value ushr 4])
                    append(HEX[value and 0xf])
                }
            }
        }
    }

    private fun siblingUrl(originalUrl: String, name: String): String? = try {
        if (!UpdateManifestParser.isSafeAssetName(name) || !http.isAllowedUrl(originalUrl)) {
            null
        } else {
            URI(originalUrl).resolve(name).toString().takeIf(http::isAllowedUrl)
        }
    } catch (_: Exception) {
        null
    }

    private fun failed(reason: UpdateCheckFailure) = UpdateCheckResult.Failed(reason)

    private companion object {
        const val MAX_MANIFESTS = 20
        const val MANIFEST_NAME = "android-update.json"
        const val OFFICIAL_LATEST_PATH = "/SillyBunnyTeam/SillyBunny/releases/latest/download/android-update.json"
        const val OFFICIAL_RELEASE_DOWNLOAD = "https://github.com/SillyBunnyTeam/SillyBunny/releases/download"
        const val HEX = "0123456789ABCDEF"
    }
}
