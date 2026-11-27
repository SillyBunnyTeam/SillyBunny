package io.github.sillybunnyteam.sillybunny.update

import android.app.NotificationManager
import android.content.Context
import android.content.SharedPreferences
import android.content.pm.PackageInstaller
import android.os.Build
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.util.Log
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import io.github.sillybunnyteam.sillybunny.MainActivity
import java.io.File
import java.util.Collections
import java.util.regex.Pattern
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Real PackageInstaller sessions on the device. The consent test needs two steps on the host first:
 * push a copy of the debug APK that is signed with another key to [FIXTURE], and run
 * `appops set <package> REQUEST_INSTALL_PACKAGES allow`. The platform rejects that approved update with
 * a signature conflict, so the app under test is never replaced. Without those steps the test is skipped.
 */
@RunWith(AndroidJUnit4::class)
class UpdateSessionInstrumentedTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val device = UiDevice.getInstance(instrumentation)
    private val store = UpdateStore(context)
    private val updates = File(context.cacheDir, "updates")

    @Before
    fun prepare() {
        context.getSharedPreferences("app_updates", Context.MODE_PRIVATE).edit().clear().commit()
        store.enabled = false
        abandonOwnSessions()
    }

    @After
    fun clean() {
        abandonOwnSessions()
        context.getSharedPreferences("app_updates", Context.MODE_PRIVATE).edit().clear().commit()
        updates.listFiles()?.filter { it.name.startsWith("update-fixture") }?.forEach(File::delete)
        context.getSystemService(NotificationManager::class.java).cancelAll()
    }

    @Test
    fun archiveVerificationReadsTheCertificatesOfThisDevicesApk() {
        val copy = File(updates.apply { mkdirs() }, "update-fixture-self.apk")
        File(context.applicationInfo.sourceDir).copyTo(copy, overwrite = true)
        val signer = ApkVerifier.installedSigner(context)
        val version = ApkVerifier.installedVersionCode(context)
        assertNotNull(signer)
        assertNotNull(version)
        assertTrue(ApkVerifier.verifyArchive(context, copy, version!!, signer!!))
    }

    @Test
    fun launchReleasesAnInstallerSessionThatNoInstallTracks() {
        val installer = context.packageManager.packageInstaller
        val orphan = installer.createSession(UpdateInstaller(context).sessionParams(1))
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            awaitInitialized(scenario)
            assertFalse(installer.mySessions.any { it.sessionId == orphan })
        }
    }

    @Test
    fun approvedConfirmationEndsWithThePlatformResultInsteadOfAnAbandon() {
        assumeTrue(
            "allow REQUEST_INSTALL_PACKAGES for ${context.packageName} first",
            UpdateInstaller(context).canInstall(),
        )
        val outcomes = Collections.synchronizedList(mutableListOf<InstallResult>())
        // Records every outcome before the activity's updater shows it and resets it to IDLE.
        val listener = SharedPreferences.OnSharedPreferenceChangeListener { _, key ->
            if (key == "install_outcome") outcomes += store.lastInstallResult
        }
        val preferences = context.getSharedPreferences("app_updates", Context.MODE_PRIVATE)
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            awaitInitialized(scenario)
            // Copied only now: the launch work deletes downloads that no install claims.
            val fixture = copyFixture()
            instrumentation.runOnMainSync { preferences.registerOnSharedPreferenceChangeListener(listener) }
            try {
                commitFixture(fixture)
                val confirm = awaitConfirmation()
                assertNotNull("No system confirmation appeared; outcomes ${snapshot(outcomes)}", confirm)
                confirm!!.click()
                val deadline = SystemClock.uptimeMillis() + 120_000
                while (snapshot(outcomes).none { it.outcome in terminalOutcomes } &&
                    SystemClock.uptimeMillis() < deadline
                ) {
                    Thread.sleep(100)
                }
                val seen = snapshot(outcomes)
                Log.i(TAG, "API ${Build.VERSION.SDK_INT} outcomes $seen")
                val terminal = seen.firstOrNull { it.outcome in terminalOutcomes }
                assertNotNull("No terminal outcome; outcomes $seen", terminal)
                // An abandon by the app records ABORTED and drops the platform's later result.
                assertEquals("outcomes $seen", InstallOutcome.FAILED, terminal!!.outcome)
                assertNotEquals("outcomes $seen", PackageInstaller.STATUS_FAILURE_ABORTED, terminal.status)
                assertFalse("outcomes $seen", seen.any { it.outcome == InstallOutcome.ABORTED })
            } finally {
                instrumentation.runOnMainSync { preferences.unregisterOnSharedPreferenceChangeListener(listener) }
            }
        }
    }

    private fun snapshot(outcomes: MutableList<InstallResult>) = synchronized(outcomes) { outcomes.toList() }

    private fun copyFixture(): File {
        val target = File(updates.apply { mkdirs() }, "update-fixture.apk")
        ParcelFileDescriptor.AutoCloseInputStream(
            instrumentation.uiAutomation.executeShellCommand("cat $FIXTURE"),
        ).use { input -> target.outputStream().use { input.copyTo(it) } }
        assumeTrue("push the signature-conflict APK to $FIXTURE first", target.length() > 0)
        return target
    }

    private fun commitFixture(fixture: File) {
        val updater = UpdateInstaller(context)
        val installer = context.packageManager.packageInstaller
        val length = fixture.length()
        val sessionId = installer.createSession(updater.sessionParams(length))
        installer.openSession(sessionId).use { session ->
            session.openWrite("base.apk", 0, length).use { output ->
                fixture.inputStream().use { it.copyTo(output) }
                session.fsync(output)
            }
            val action = updater.newCallbackAction(sessionId)
            // Above the installed version, so recovery never mistakes the unchanged app for a finished update.
            val expectedVersion = ApkVerifier.installedVersionCode(context)!! + 1
            assertTrue(store.beginInstall(sessionId, action, fixture, expectedVersion))
            session.commit(updater.callbackPendingIntent(sessionId, action).intentSender)
        }
    }

    private fun awaitConfirmation(): UiObject2? {
        val installerPackage = Pattern.compile(".*packageinstaller.*")
        val selectors = listOf(
            By.pkg(installerPackage).res("android:id/button1").enabled(true),
            By.pkg(installerPackage).text(Pattern.compile("(?i)install|update")).enabled(true).clickable(true),
        )
        val deadline = SystemClock.uptimeMillis() + 30_000
        while (SystemClock.uptimeMillis() < deadline) {
            selectors.firstNotNullOfOrNull { device.findObject(it) }?.let { return it }
            Thread.sleep(250)
        }
        return null
    }

    private fun awaitInitialized(scenario: ActivityScenario<MainActivity>) {
        val deadline = SystemClock.uptimeMillis() + 10_000
        var initialized = false
        while (!initialized && SystemClock.uptimeMillis() < deadline) {
            scenario.onActivity { initialized = AppUpdater.forActivity(it).state.initialized }
            if (!initialized) Thread.sleep(20)
        }
        assertTrue("The updater's launch work did not finish", initialized)
    }

    private fun abandonOwnSessions() {
        val installer = context.packageManager.packageInstaller
        installer.mySessions.filter { it.appPackageName == context.packageName }.forEach {
            try {
                installer.abandonSession(it.sessionId)
            } catch (_: Exception) {
                // Already finished.
            }
        }
    }

    private companion object {
        const val TAG = "UpdateSessionTest"
        const val FIXTURE = "/data/local/tmp/sillybunny-update-conflict.apk"
        val terminalOutcomes = setOf(InstallOutcome.SUCCESS, InstallOutcome.FAILED, InstallOutcome.ABORTED)
    }
}
