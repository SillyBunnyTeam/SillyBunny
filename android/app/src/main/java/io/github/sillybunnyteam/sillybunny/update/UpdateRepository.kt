package io.github.sillybunnyteam.sillybunny.update

import android.content.Context
import android.os.Build
import io.github.sillybunnyteam.sillybunny.BuildConfig
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.net.URI
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
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
    private val supportedAbis: List<String> = Build.SUPPORTED_ABIS.toList(),
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
        var firstRedirect: String? = null
        val json = try {
            http.fetchJson(manifestUrl, onRedirect = { target -> if (firstRedirect == null) firstRedirect = target })
        } catch (_: Exception) {
            return failed(UpdateCheckFailure.NETWORK)
        }
        val manifest = UpdateManifestParser.parse(json, supportedAbis, sdk)
            ?: return failed(UpdateCheckFailure.INVALID_MANIFEST)
        if (manifest.prerelease) return failed(UpdateCheckFailure.INVALID_MANIFEST)
        if (manifest.versionCode <= version) return UpdateCheckResult.UpToDate
        if (!signerMatches(manifest, signer)) return failed(UpdateCheckFailure.SIGNER_MISMATCH)
        val downloadUrl = stableDownloadUrl(manifest, firstRedirect)
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
        // The API lists newest releases first, so a manifest that failed before any current one may be newer.
        var networkFailureAboveCurrent = false
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
                if (!sawCurrent) networkFailureAboveCurrent = true
                continue
            }
            val manifest = UpdateManifestParser.parse(body, supportedAbis, sdk)
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
            sawCurrent && !networkFailureAboveCurrent -> UpdateCheckResult.UpToDate
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

    /**
     * [hostingUrl] is the first redirect target of the manifest request. For the official latest URL GitHub
     * redirects to the release that holds the manifest, which plan §6.1 can make newer than [UpdateManifest.releaseTag].
     */
    internal fun stableDownloadUrl(manifest: UpdateManifest, hostingUrl: String? = null): String? {
        if (!http.isAllowedUrl(manifestUrl) || !UpdateManifestParser.isSafeAssetName(manifest.asset.name)) return null
        val original = URI(manifestUrl)
        if (!isOfficialOrigin(original) || original.rawPath != OFFICIAL_LATEST_PATH) {
            return siblingUrl(manifestUrl, manifest.asset.name)
        }

        // latest can advance while the prompt is open; bind the APK to the release that served the checked manifest.
        val tag = hostingUrl?.let(::hostingReleaseTag) ?: encodeReleaseTag(manifest.releaseTag) ?: return null
        return "$OFFICIAL_RELEASE_DOWNLOAD/$tag/${manifest.asset.name}".takeIf(http::isAllowedUrl)
    }

    private fun isOfficialOrigin(uri: URI): Boolean =
        uri.scheme == "https" && uri.host.equals("github.com", ignoreCase = true) && uri.port in listOf(-1, 443) &&
            uri.rawUserInfo == null

    /** The encoded tag of an official `releases/download/<tag>/android-update.json` URL, or null. */
    private fun hostingReleaseTag(url: String): String? = try {
        val uri = URI(url)
        val path = uri.rawPath.orEmpty()
        val prefix = "$OFFICIAL_RELEASE_PATH/"
        val suffix = "/$MANIFEST_NAME"
        if (!isOfficialOrigin(uri) || uri.rawQuery != null || uri.rawFragment != null ||
            !path.startsWith(prefix) || !path.endsWith(suffix) || path.length <= prefix.length + suffix.length
        ) {
            null
        } else {
            decodePathSegment(path.substring(prefix.length, path.length - suffix.length))?.let(::encodeReleaseTag)
        }
    } catch (_: Exception) {
        null
    }

    private fun decodePathSegment(raw: String): String? {
        val bytes = ByteArrayOutputStream()
        var index = 0
        while (index < raw.length) {
            val char = raw[index]
            if (char == '%') {
                if (index + 2 >= raw.length) return null
                val high = Character.digit(raw[index + 1], 16)
                val low = Character.digit(raw[index + 2], 16)
                if (high < 0 || low < 0) return null
                bytes.write(high * 16 + low)
                index += 3
            } else {
                if (char == '/' || char.code !in 0x21..0x7e) return null
                bytes.write(char.code)
                index++
            }
        }
        return try {
            Charsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(bytes.toByteArray())).toString()
        } catch (_: CharacterCodingException) {
            null
        }
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
        const val OFFICIAL_RELEASE_PATH = "/SillyBunnyTeam/SillyBunny/releases/download"
        const val OFFICIAL_RELEASE_DOWNLOAD = "https://github.com$OFFICIAL_RELEASE_PATH"
        const val HEX = "0123456789ABCDEF"
    }
}
