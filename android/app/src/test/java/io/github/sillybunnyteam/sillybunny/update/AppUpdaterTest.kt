package io.github.sillybunnyteam.sillybunny.update

import android.app.Application
import android.os.Looper
import androidx.activity.ComponentActivity
import androidx.test.core.app.ApplicationProvider
import java.io.File
import java.util.concurrent.TimeUnit
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29, 37])
class AppUpdaterTest {
    private val context = ApplicationProvider.getApplicationContext<Application>()
    private val controller = Robolectric.buildActivity(ComponentActivity::class.java)
    private lateinit var updater: AppUpdater

    @Before
    fun resetState() {
        context.getSharedPreferences("app_updates", 0).edit().clear().commit()
        File(context.filesDir, "status/update-blocked.json").delete()
        controller.setup()
        updater = AppUpdater.forActivity(controller.get())
        assertSame("ViewModel must use the current Application", context, updater.getApplication<Application>())
    }

    @After
    fun close() {
        UpdateForeground.detach(controller.get())
        controller.get().viewModelStore.clear()
        controller.pause().stop().destroy()
        File(context.filesDir, "status/update-blocked.json").delete()
    }

    @Test
    fun settingsCanDisableAutomaticChecksAndShareTheActivityInstance() {
        assertTrue(updater.enabled)
        assertSame(updater, AppUpdater.forActivity(controller.get()))
        updater.enabled = false
        assertFalse(UpdateStore(context).enabled)
        updater.onLaunch()
        waitForWorker()
        assertNull(updater.lastResult)
        assertFalse(updater.state.visible)
    }

    @Test
    fun showsAnExistingMalformedBlockEvenWhenAutomaticChecksAreOff() {
        val file = File(context.filesDir, "status/update-blocked.json")
        file.parentFile!!.mkdirs()
        file.writeText("{")
        updater.enabled = false
        updater.onLaunch()
        await { updater.state.blocked != null }
        assertTrue(updater.state.visible)
        assertEquals(UpdatePhase.REQUIRED, updater.state.phase)
        updater.later()
        assertFalse(updater.state.visible)
    }

    @Test
    fun observesABlockWrittenAfterLaunch() {
        updater.enabled = false
        updater.onLaunch()
        waitForWorker()
        val file = File(context.filesDir, "status/update-blocked.json")
        file.writeText("""{"required":2,"installed":1,"reason":"newer"}""")
        updater.onForeground()
        await { updater.state.blocked != null }
        assertEquals(2L, updater.state.blocked!!.requiredVersionCode)
        assertTrue(updater.state.visible)
    }

    @Test
    fun removesTheRequiredVariantWhenTheGateClears() {
        val file = File(context.filesDir, "status/update-blocked.json")
        file.parentFile!!.mkdirs()
        file.writeText("{}")
        updater.enabled = false
        updater.onLaunch()
        await { updater.state.blocked != null }
        file.delete()
        updater.onForeground()
        await { updater.state.blocked == null }
        assertEquals(UpdatePhase.IDLE, updater.state.phase)
    }

    @Test
    fun consumesTheReplacementOnAnExplicitLaunch() {
        UpdateStore(context).recordReplacement(2)
        updater.enabled = false
        updater.onLaunch()
        await { updater.state.updatedVersionCode == 2L }
        assertEquals(UpdatePhase.UPDATED, updater.state.phase)
        assertTrue(updater.state.visible)
        assertNull(UpdateStore(context).consumeReplacement())
        assertNotNull(updater.state.updatedVersionCode)
    }

    @Test
    fun checkNowRunsEvenWhenAutomaticChecksAreDisabledAndRetainsItsResult() {
        updater.enabled = false
        updater.checkNow()
        assertEquals(UpdatePhase.CHECKING, updater.state.phase)
        await { updater.lastResult != null }
        assertTrue(updater.state.visible)
        assertNotNull(updater.state.lastResult)
        assertFalse(updater.enabled)
    }

    @Test
    fun installFailureIsSurfacedOnceRatherThanOnEveryForegroundReturn() {
        updater.enabled = false
        updater.onLaunch()
        UpdateStore(context).lastInstallResult = InstallResult(outcome = InstallOutcome.FAILED)
        updater.onForeground()
        assertEquals(UpdatePhase.ERROR, updater.state.phase)
        updater.later()
        updater.onForeground()
        assertFalse(updater.state.visible)
    }

    @Test
    fun laterKeepsADismissedCheckHiddenWhileRetainingItsResult() {
        updater.enabled = false
        updater.checkNow()
        updater.later()
        await { updater.lastResult != null }
        assertFalse(updater.state.visible)
    }

    @Test
    fun finalTeardownRemovesAnUncommittedVerifiedDownload() {
        val download = File(context.cacheDir, "updates/candidate.apk")
        download.parentFile!!.mkdirs()
        download.writeText("verified fixture")
        UpdateStore(context).downloadedApk = download.absolutePath
        controller.get().viewModelStore.clear()
        assertFalse(download.exists())
        assertNull(UpdateStore(context).downloadedApk)
    }

    @Test
    fun finalTeardownRetainsTheDownloadOwnedByAnActiveInstallerSession() {
        val download = File(context.cacheDir, "updates/candidate.apk")
        download.parentFile!!.mkdirs()
        download.writeText("verified fixture")
        val store = UpdateStore(context)
        assertTrue(store.beginInstall(12, "active-callback", download, 2))
        controller.get().viewModelStore.clear()
        assertTrue(download.exists())
        assertEquals(12, store.activeSessionId)
        store.failInstall(12)
    }

    @Test
    fun launchRemovesAnInterruptedDownloadButPreservesUnrelatedCacheFiles() {
        val directory = File(context.cacheDir, "updates").apply { mkdirs() }
        val partial = File(directory, "update-interrupted.part").apply { writeText("partial") }
        val unrelated = File(directory, "keep.json").apply { writeText("keep") }
        updater.enabled = false
        updater.onLaunch()
        await { !partial.exists() }
        assertTrue(unrelated.exists())
        unrelated.delete()
    }

    @Test
    fun notificationDeniedPendingConfirmationCannotLeaveTheForegroundUiStuck() {
        val store = UpdateStore(context)
        val apk = File(context.cacheDir, "updates/pending.apk")
        apk.parentFile!!.mkdirs()
        apk.writeText("verified fixture")
        assertTrue(store.beginInstall(32, "pending-callback", apk, 2))
        store.recordInstallResult(
            store.activeCallback()!!,
            InstallResult(InstallOutcome.AWAITING_USER_ACTION),
            terminal = false,
        )
        UpdateForeground.attach(controller.get())
        try {
            updater.onForeground()
            assertEquals(UpdatePhase.ERROR, updater.state.phase)
            assertNull(store.activeSessionId)
            assertFalse(apk.exists())
        } finally {
            UpdateForeground.detach(controller.get())
        }
    }

    @Test
    fun coldLaunchReleasesAnInterruptedPrecommitInsteadOfStayingInstalling() {
        val store = UpdateStore(context)
        val apk = File(context.cacheDir, "updates/interrupted.apk")
        apk.parentFile!!.mkdirs()
        apk.writeText("verified fixture")
        assertTrue(store.beginInstall(42, "interrupted-callback", apk, 2))
        updater.enabled = false
        updater.onLaunch()
        await { updater.state.initialized }
        assertEquals(UpdatePhase.ERROR, updater.state.phase)
        assertNull(store.activeSessionId)
        assertFalse(apk.exists())
    }

    private fun waitForWorker() {
        await { updater.state.initialized }
        shadowOf(Looper.getMainLooper()).idle()
    }

    private fun await(condition: () -> Boolean) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        while (!condition() && System.nanoTime() < deadline) {
            shadowOf(Looper.getMainLooper()).idle()
            Thread.sleep(10)
        }
        shadowOf(Looper.getMainLooper()).idle()
        assertTrue("Timed out waiting for updater state", condition())
    }
}
