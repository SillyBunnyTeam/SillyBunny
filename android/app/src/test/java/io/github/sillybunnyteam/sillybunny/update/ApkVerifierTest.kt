package io.github.sillybunnyteam.sillybunny.update

import android.content.Context
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.content.pm.Signature
import android.os.Build
import androidx.test.core.app.ApplicationProvider
import java.io.File
import java.util.Locale
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.ClassName
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.shadows.ShadowApplicationPackageManager
import org.robolectric.shadows.ShadowPackageManager
import org.robolectric.util.ReflectionHelpers

@RunWith(RobolectricTestRunner::class)
@Config(
    sdk = [29],
    shadows = [ApkVerifierTest.ArchivePackageManager::class, ApkVerifierTest.ArchiveFlagsPackageManager::class],
)
class ApkVerifierTest {
    @get:Rule
    val temporary = TemporaryFolder()

    @Test
    fun normalizesOnlyCompletePlainOrColonDelimitedFingerprints() {
        val hex = CoreTestFixtures.hex(CoreTestFixtures.signer)
        assertArrayEquals(CoreTestFixtures.signer, ApkVerifier.normalizeFingerprint(hex))
        assertArrayEquals(CoreTestFixtures.signer, ApkVerifier.normalizeFingerprint(hex.uppercase(Locale.ROOT)))
        assertArrayEquals(CoreTestFixtures.signer, ApkVerifier.normalizeFingerprint(hex.chunked(2).joinToString(":")))
        for (value in listOf(
            "", " ", hex.dropLast(1), hex + "00", " $hex", "$hex\n", "zz".repeat(32),
            hex.chunked(2).joinToString(":") + ":", hex.chunked(2).joinToString("-"),
            hex.substring(0, 2) + ":" + hex.substring(2), "１２".repeat(32),
        )) assertNull(value, ApkVerifier.normalizeFingerprint(value))
    }

    @Test
    fun hashesEncodedCertificateAndRequiresExactlyOneSigner() {
        val current = CoreTestFixtures.certificate
        val other = Signature(byteArrayOf(2, 4, 6, 8))
        val expected = CoreTestFixtures.signer
        assertTrue(ApkVerifier.matchesSigner(arrayOf(current), expected))
        assertFalse(ApkVerifier.matchesSigner(arrayOf(other), expected))
        assertFalse(ApkVerifier.matchesSigner(null, expected))
        assertFalse(ApkVerifier.matchesSigner(emptyArray(), expected))
        assertFalse(ApkVerifier.matchesSigner(arrayOf(current, other), expected))
        assertFalse(ApkVerifier.matchesSigner(arrayOf(current, current), expected))
        assertFalse(ApkVerifier.matchesSigner(arrayOf(current), ByteArray(31)))
        assertFalse(ApkVerifier.matchesSigner(arrayOf(current), current.toByteArray()))
    }

    @Test
    @Config(sdk = [29, 31, 34, 35, 37])
    fun installedSignerUsesCurrentSignerAndNeverHistory() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val old = Signature(byteArrayOf(9, 7, 5, 3, 1))
        val info = CoreTestFixtures.packageInfo(context, 4)
        info.signingInfo = CoreTestFixtures.signingInfo(arrayOf(CoreTestFixtures.certificate), arrayOf(old, CoreTestFixtures.certificate))
        shadowOf(context.packageManager).installPackage(info)
        assertArrayEquals(CoreTestFixtures.signer, ApkVerifier.installedSigner(context))

        info.signingInfo = CoreTestFixtures.signingInfo(emptyArray(), arrayOf(CoreTestFixtures.certificate))
        shadowOf(context.packageManager).installPackage(info)
        assertNull(ApkVerifier.installedSigner(context))

        info.signingInfo = CoreTestFixtures.signingInfo(arrayOf(CoreTestFixtures.certificate, old))
        shadowOf(context.packageManager).installPackage(info)
        assertNull(ApkVerifier.installedSigner(context))
    }

    @Test
    @Config(sdk = [29, 31, 34, 35, 37])
    @Suppress("DEPRECATION")
    fun missingSigningInfoDoesNotFallBackToLegacySignatures() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val info = CoreTestFixtures.packageInfo(context, 4)
        info.signingInfo = null
        info.signatures = arrayOf(CoreTestFixtures.certificate)
        shadowOf(context.packageManager).installPackage(info)
        assertNull(ApkVerifier.installedSigner(context))
    }

    @Test
    @Config(sdk = [29, 31, 34, 35, 37])
    fun archiveRequiresSamePackageExactLongVersionAndCurrentSingleSigner() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val apk = temporary.newFile("candidate.part")
        val expected = CoreTestFixtures.signer
        val version = Int.MAX_VALUE.toLong() + 9
        val info = CoreTestFixtures.packageInfo(context, version)
        val manager = shadowOf(context.packageManager)
        manager.setPackageArchiveInfo(apk.absolutePath, info)
        val verified = ApkVerifier.verifyArchive(context, apk, version, expected)
        val archiveManager = manager as ArchivePackageManager
        assertEquals("archive overload", Build.VERSION.SDK_INT >= 33, archiveManager.usedFlagsOverload)
        @Suppress("DEPRECATION")
        val expectedFlags = PackageManager.GET_SIGNING_CERTIFICATES.toLong() or
            (if (Build.VERSION.SDK_INT == 29) PackageManager.GET_SIGNATURES.toLong() else 0L)
        assertEquals(expectedFlags, archiveManager.archiveFlags)
        assertTrue(verified)
        assertFalse(ApkVerifier.verifyArchive(context, apk, version - 1, expected))
        assertFalse(ApkVerifier.verifyArchive(context, apk, 0, expected))

        info.packageName = "other.package"
        manager.setPackageArchiveInfo(apk.absolutePath, info)
        assertFalse(ApkVerifier.verifyArchive(context, apk, version, expected))
        info.packageName = context.packageName
        val other = Signature(byteArrayOf(9, 8, 7))
        info.signingInfo = CoreTestFixtures.signingInfo(arrayOf(other), arrayOf(CoreTestFixtures.certificate, other))
        manager.setPackageArchiveInfo(apk.absolutePath, info)
        assertFalse(ApkVerifier.verifyArchive(context, apk, version, expected))

        info.signingInfo = CoreTestFixtures.signingInfo(arrayOf(CoreTestFixtures.certificate, other))
        manager.setPackageArchiveInfo(apk.absolutePath, info)
        assertFalse(ApkVerifier.verifyArchive(context, apk, version, expected))
        info.signingInfo = CoreTestFixtures.signingInfo(emptyArray(), arrayOf(CoreTestFixtures.certificate))
        manager.setPackageArchiveInfo(apk.absolutePath, info)
        assertFalse(ApkVerifier.verifyArchive(context, apk, version, expected))
        info.signingInfo = null
        manager.setPackageArchiveInfo(apk.absolutePath, info)
        assertFalse(ApkVerifier.verifyArchive(context, apk, version, expected))
    }

    @Test
    fun rejectsMissingUnreadableOrInvalidArchiveAndWrongFingerprintLength() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val missing = File(temporary.root, "missing.apk")
        val invalid = temporary.newFile("invalid.apk").apply { writeText("not an APK") }
        assertFalse(ApkVerifier.verifyArchive(context, missing, 2, CoreTestFixtures.signer))
        assertFalse(ApkVerifier.verifyArchive(context, temporary.root, 2, CoreTestFixtures.signer))
        assertFalse(ApkVerifier.verifyArchive(context, invalid, 2, CoreTestFixtures.signer))
        assertFalse(ApkVerifier.verifyArchive(context, invalid, 2, ByteArray(31)))
    }

    // Robolectric 4.17's archive fixture map only intercepts the deprecated int overload.
    @Implements(className = "android.app.ApplicationPackageManager", isInAndroidSdk = false)
    class ArchivePackageManager : ShadowApplicationPackageManager() {
        var usedFlagsOverload = false
        var archiveFlags = 0L

        @Implementation
        override fun getPackageArchiveInfo(path: String, flags: Int): PackageInfo? {
            return archiveInfo(path, flags.toLong(), false)
        }

        fun archiveInfo(path: String, flags: Long, flagsOverload: Boolean): PackageInfo? {
            usedFlagsOverload = flagsOverload
            archiveFlags = flags
            return getShadowPackageArchiveInfo(path, flags.toInt())
        }
    }

    // This overload is declared on PackageManager, not ApplicationPackageManager.
    @Implements(PackageManager::class)
    class ArchiveFlagsPackageManager : ShadowPackageManager() {
        companion object {
            @JvmStatic
            @Implementation(minSdk = 33)
            fun getPackageArchiveInfo(
                path: String,
                @ClassName("android.content.pm.PackageManager\$PackageInfoFlags") flags: Any,
            ): PackageInfo? {
                val context = ApplicationProvider.getApplicationContext<Context>()
                val manager = shadowOf(context.packageManager) as ArchivePackageManager
                val value: Long = ReflectionHelpers.callInstanceMethod(flags, "getValue")
                return manager.archiveInfo(path, value, true)
            }
        }
    }
}
