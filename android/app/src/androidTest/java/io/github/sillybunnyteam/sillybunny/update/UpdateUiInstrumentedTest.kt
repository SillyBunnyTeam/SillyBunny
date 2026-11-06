package io.github.sillybunnyteam.sillybunny.update

import android.app.ActivityManager
import android.app.NotificationManager
import android.content.Intent
import android.content.pm.PackageInstaller
import android.provider.Settings
import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import io.github.sillybunnyteam.sillybunny.MainActivity
import io.github.sillybunnyteam.sillybunny.PackageReplacedReceiver
import java.io.File
import java.util.concurrent.atomic.AtomicInteger
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class UpdateUiInstrumentedTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val device = UiDevice.getInstance(instrumentation)
    private val store = UpdateStore(context)
    private val blocked = File(context.filesDir, "status/update-blocked.json")

    @Before
    fun prepare() {
        context.getSharedPreferences("app_updates", 0).edit().clear().commit()
        store.enabled = false
        blocked.parentFile!!.mkdirs()
        blocked.delete()
    }

    @After
    fun clean() {
        blocked.delete()
        context.getSharedPreferences("app_updates", 0).edit().clear().commit()
        context.getSystemService(NotificationManager::class.java).cancelAll()
    }

    @Test
    fun malformedBlockedStatusShowsARequiredPromptThatCanBeDeferred() {
        blocked.writeText("{")
        ActivityScenario.launch(MainActivity::class.java).use {
            assertTrue(device.wait(Until.hasObject(By.res("update_required")), 10_000))
            val later = device.findObject(By.res("update_later"))
            assertNotNull(later)
            later.click()
            assertTrue(device.wait(Until.gone(By.res("update_required")), 5_000))
        }
    }

    @Test
    fun requiredPromptAndDisabledPreferenceSurviveRecreation() {
        blocked.writeText("""{"required":2,"installed":1,"reason":"newer"}""")
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            assertTrue(device.wait(Until.hasObject(By.res("update_required")), 10_000))
            scenario.recreate()
            assertTrue(device.wait(Until.hasObject(By.res("update_required")), 10_000))
            scenario.onActivity {
                val updater = AppUpdater.forActivity(it)
                assertFalse(updater.enabled)
                assertEquals(2L, updater.state.blocked!!.requiredVersionCode)
            }
        }
    }

    @Test
    fun aBlockWrittenAfterLaunchIsObservedWithoutRelaunching() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            val deadline = System.nanoTime() + 5_000_000_000L
            var initialized = false
            while (!initialized && System.nanoTime() < deadline) {
                scenario.onActivity { initialized = AppUpdater.forActivity(it).state.initialized }
                if (!initialized) Thread.sleep(20)
            }
            assertTrue(initialized)
            blocked.writeText("""{"required":3,"installed":1,"reason":"newer"}""")
            assertTrue(device.wait(Until.hasObject(By.res("update_required")), 10_000))
            blocked.delete()
            assertTrue(device.wait(Until.gone(By.res("update_required")), 10_000))
        }
    }

    @Test
    fun sourceApprovalIsScopedToThisPackage() {
        val intent = UpdateInstaller(context).unknownSourcesIntent()
        assertEquals(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, intent.action)
        assertEquals("package:${context.packageName}", intent.data.toString())
    }

    @Test
    fun downloadProgressDoesNotOfferADuplicateInstallAction() {
        val deferred = AtomicInteger()
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                activity.setContent {
                    MaterialTheme {
                        UpdateDialog(
                            state = UpdateUiState(
                                visible = true,
                                phase = UpdatePhase.DOWNLOADING,
                                downloadedBytes = 25,
                                totalBytes = 100,
                            ),
                            onUpdate = { throw AssertionError("Duplicate install action") },
                            onCheckNow = { throw AssertionError("Duplicate check action") },
                            onLater = { deferred.incrementAndGet() },
                        )
                    }
                }
            }
            assertTrue(device.wait(Until.hasObject(By.res("update_progress")), 5_000))
            assertFalse(device.hasObject(By.res("update_confirm")))
            assertFalse(device.hasObject(By.res("update_retry")))
            device.findObject(By.res("update_later")).click()
            instrumentation.waitForIdleSync()
            assertEquals(1, deferred.get())
        }
    }

    @Test
    fun errorsExposeAnExplicitRetry() {
        val retried = AtomicInteger()
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                activity.setContent {
                    MaterialTheme {
                        UpdateDialog(
                            state = UpdateUiState(visible = true, phase = UpdatePhase.ERROR),
                            onUpdate = { throw AssertionError("No unverified candidate may be installed") },
                            onCheckNow = { retried.incrementAndGet() },
                            onLater = {},
                        )
                    }
                }
            }
            assertTrue(device.wait(Until.hasObject(By.res("update_error")), 5_000))
            device.findObject(By.res("update_retry")).click()
            instrumentation.waitForIdleSync()
            assertEquals(1, retried.get())
        }
    }

    @Test
    fun replacementStateIsHandledOnlyOnTheNextExplicitLaunch() {
        PackageReplacedReceiver().onReceive(context, Intent(Intent.ACTION_MY_PACKAGE_REPLACED))
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            assertTrue(device.wait(Until.hasObject(By.res("update_title")), 10_000))
            scenario.onActivity {
                assertEquals(1L, AppUpdater.forActivity(it).state.updatedVersionCode)
                assertEquals(UpdatePhase.UPDATED, AppUpdater.forActivity(it).state.phase)
            }
            assertNull(store.consumeReplacement())
        }
    }

    @Test
    fun replacementBroadcastNeverStartsTheServer() {
        PackageReplacedReceiver().onReceive(context, Intent(Intent.ACTION_MY_PACKAGE_REPLACED))
        @Suppress("DEPRECATION")
        val running = context.getSystemService(ActivityManager::class.java).getRunningServices(20)
        assertFalse(running.any { it.service.className.endsWith(".ServerService") })
        assertEquals(1L, store.consumeReplacement())
    }

    @Test
    fun coldLaunchRecoversAnUncommittedOwnedSession() {
        val apk = File(context.cacheDir, "updates/interrupted.apk")
        apk.parentFile!!.mkdirs()
        apk.writeText("interrupted fixture")
        val installer = context.packageManager.packageInstaller
        val sessionId = installer.createSession(
            PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
                setAppPackageName(context.packageName)
            },
        )
        try {
            assertTrue(store.beginInstall(sessionId, "interrupted-fixture", apk, 3))
            ActivityScenario.launch(MainActivity::class.java).use {
                assertTrue(device.wait(Until.hasObject(By.res("update_error")), 10_000))
                assertTrue(device.hasObject(By.res("update_retry")))
                assertNull(store.activeSessionId)
                assertFalse(apk.exists())
                assertFalse(installer.mySessions.any { session -> session.sessionId == sessionId })
            }
        } finally {
            if (installer.mySessions.any { it.sessionId == sessionId }) installer.abandonSession(sessionId)
            apk.delete()
        }
    }
}
