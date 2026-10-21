package io.github.sillybunnyteam.sillybunny.update

import android.content.Context
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.content.pm.Signature
import android.os.Build
import java.io.File
import java.security.MessageDigest

object ApkVerifier {
    private val plainFingerprint = Regex("[0-9a-fA-F]{64}")
    private val colonFingerprint = Regex("(?:[0-9a-fA-F]{2}:){31}[0-9a-fA-F]{2}")

    fun installedSigner(context: Context): ByteArray? {
        return try {
            singleSigner(installedPackage(context))
        } catch (_: Exception) {
            null
        }
    }

    fun matchesSigner(signatures: Array<Signature>?, expected: ByteArray): Boolean {
        if (expected.size != 32 || signatures?.size != 1) return false
        return try {
            MessageDigest.isEqual(expected, sha256(signatures.single()))
        } catch (_: Exception) {
            false
        }
    }

    fun normalizeFingerprint(value: String): ByteArray? {
        if (!plainFingerprint.matches(value) && !colonFingerprint.matches(value)) return null
        val hex = value.replace(":", "")
        return ByteArray(32) { index -> hex.substring(index * 2, index * 2 + 2).toInt(16).toByte() }
    }

    fun verifyArchive(
        context: Context,
        apk: File,
        expectedVersionCode: Long,
        expectedSigner: ByteArray,
    ): Boolean {
        if (!apk.isFile || expectedVersionCode <= 0 || expectedSigner.size != 32) return false
        return try {
            val info = archivePackage(context.packageManager, apk) ?: return false
            val signingInfo = info.signingInfo ?: return false
            info.packageName == context.packageName &&
                info.longVersionCode == expectedVersionCode &&
                !signingInfo.hasMultipleSigners() &&
                matchesSigner(signingInfo.apkContentsSigners, expectedSigner)
        } catch (_: Exception) {
            false
        }
    }

    internal fun installedVersionCode(context: Context): Long? {
        return try {
            installedPackage(context).longVersionCode.takeIf { it >= 0 }
        } catch (_: Exception) {
            null
        }
    }

    private fun singleSigner(info: PackageInfo): ByteArray? {
        val signingInfo = info.signingInfo ?: return null
        if (signingInfo.hasMultipleSigners()) return null
        val signers = signingInfo.apkContentsSigners ?: return null
        return if (signers.size == 1) sha256(signers.single()) else null
    }

    private fun sha256(signature: Signature): ByteArray =
        MessageDigest.getInstance("SHA-256").digest(signature.toByteArray())

    @Suppress("DEPRECATION")
    private fun installedPackage(context: Context): PackageInfo {
        val manager = context.packageManager
        return if (Build.VERSION.SDK_INT >= 33) {
            manager.getPackageInfo(
                context.packageName,
                PackageManager.PackageInfoFlags.of(PackageManager.GET_SIGNING_CERTIFICATES.toLong()),
            )
        } else {
            manager.getPackageInfo(context.packageName, PackageManager.GET_SIGNING_CERTIFICATES)
        }
    }

    @Suppress("DEPRECATION")
    private fun archivePackage(manager: PackageManager, apk: File): PackageInfo? =
        if (Build.VERSION.SDK_INT >= 33) {
            manager.getPackageArchiveInfo(
                apk.absolutePath,
                PackageManager.PackageInfoFlags.of(PackageManager.GET_SIGNING_CERTIFICATES.toLong()),
            )
        } else {
            // API 29 only collects archive certificates when GET_SIGNATURES is also set.
            // The returned legacy signatures are never used for verification.
            val flags = PackageManager.GET_SIGNING_CERTIFICATES or
                (if (Build.VERSION.SDK_INT == 29) PackageManager.GET_SIGNATURES else 0)
            manager.getPackageArchiveInfo(apk.absolutePath, flags)
        }
}
