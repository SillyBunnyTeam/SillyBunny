package io.github.sillybunnyteam.sillybunny.update

import android.app.Application
import android.os.Looper
import androidx.activity.ComponentActivity
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.test.core.app.ApplicationProvider
import io.github.sillybunnyteam.sillybunny.ClosingFileObserver
import java.io.File
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29, 37], shadows = [ClosingFileObserver::class])
class AppUpdaterTest {
    private val context = ApplicationProvider.getApplicationContext<Application>()
    private val controller = Robolectric.buildActivity(ComponentActivity::class.java)
    private val stoppedActivities = mutableListOf<ActivityController<ComponentActivity>>()
    private lateinit var updater: AppUpdater

    @Before
    fun resetState() {
        UpdateInstaller.resetForTest()
        context.getSharedPreferences("app_updates", 0).edit().clear().commit()
        File(context.filesDir, "status/update-blocked.json").delete()
        controller.setup()
        updater = AppUpdater.forActivity(controller.get())
        assertSame("ViewModel must use the current Application", context, updater.getApplication<Application>())
    }

    @After
    fun close() {
        UpdateInstaller.awaitBackgroundWork()
        UpdateForeground.detach(controller.get())
        controller.get().viewModelStore.clear()
        controller.pause().stop().destroy()
        // Release the status observers of the updaters that simulated process death.
        stoppedActivities.forEach {
            it.get().viewModelStore.clear()
            it.destroy()
        }
        File(context.filesDir, "status/update-blocked.json").delete()
        UpdateInstaller.resetForTest()
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
        // As in UpdateActivityHook, launch first: recovery now reports back through the store's listener.
        updater.enabled = false
        updater.onLaunch()
        waitForWorker()
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
            UpdateInstaller.awaitBackgroundWork()
            await { updater.state.phase == UpdatePhase.ERROR }
            assertNull(store.activeSessionId)
            assertFalse(apk.exists())
        } finally {
            UpdateForeground.detach(controller.get())
        }
    }

    @Test
    fun aSatisfiedRequirementKeepsThePostUpdateNoticeInsteadOfDemandingAnUpdate() {
        installedVersion(2)
        blockedStatus("""{"required":2,"installed":1,"reason":"newer"}""")
        UpdateStore(context).recordReplacement(2)
        updater.enabled = false
        updater.onLaunch()
        await { updater.state.initialized }
        assertNull(updater.state.blocked)
        assertEquals(UpdatePhase.UPDATED, updater.state.phase)
        assertTrue(updater.state.visible)
        updater.onForeground()
        waitForWorker()
        assertNull(updater.state.blocked)
        assertEquals(UpdatePhase.UPDATED, updater.state.phase)
    }

    @Test
    fun aSatisfiedRequirementIsNotShownOnAPlainLaunch() {
        installedVersion(3)
        blockedStatus("""{"required":2,"installed":1,"reason":"newer"}""")
        updater.enabled = false
        updater.onLaunch()
        waitForWorker()
        assertNull(updater.state.blocked)
        assertFalse(updater.state.visible)
        assertEquals(UpdatePhase.IDLE, updater.state.phase)
    }

    @Test
    fun anUnmetRequirementStillShowsTheRequiredPromptAfterAnUpdate() {
        installedVersion(2)
        blockedStatus("""{"required":3,"installed":2,"reason":"newer"}""")
        UpdateStore(context).recordReplacement(2)
        updater.enabled = false
        updater.onLaunch()
        await { updater.state.initialized }
        assertEquals(3L, updater.state.blocked!!.requiredVersionCode)
        assertEquals(UpdatePhase.REQUIRED, updater.state.phase)
    }

    @Test
    fun requirementsThatTheInstalledVersionCannotSatisfyStayBlocking() {
        installedVersion(5)
        blockedStatus("""{"required":null,"installed":5,"reason":"missing"}""")
        updater.enabled = false
        updater.onLaunch()
        await { updater.state.blocked != null }
        assertEquals(UpdatePhase.REQUIRED, updater.state.phase)
        assertEquals("missing", updater.state.blocked!!.reason)
    }

    @Test
    fun aCancelledOrFailedInstallRestoresTheServerThatTheUpdateStopped() {
        val resumes = AtomicInteger()
        updater.serverController = object : ServerController {
            override fun stopForUpdate() = Unit

            override fun resumeAfterAbandonedUpdate() {
                assertNotSame(Looper.getMainLooper(), Looper.myLooper())
                resumes.incrementAndGet()
            }
        }
        updater.enabled = false
        updater.onLaunch()
        waitForWorker()
        listOf(InstallOutcome.ABORTED, InstallOutcome.FAILED).forEachIndexed { index, outcome ->
            UpdateStore(context).lastInstallResult = InstallResult(outcome = outcome)
            updater.onForeground()
            await { resumes.get() == index + 1 }
            assertEquals(UpdatePhase.ERROR, updater.state.phase)
        }
        UpdateStore(context).lastInstallResult = InstallResult(outcome = InstallOutcome.SUCCESS)
        updater.onForeground()
        assertEquals(UpdatePhase.UPDATED, updater.state.phase)
        updater.awaitWorkerForTest()
        assertEquals(2, resumes.get())
    }

    @Test
    @Config(shadows = [ApkVerifierTest.ArchivePackageManager::class, ApkVerifierTest.ArchiveFlagsPackageManager::class])
    fun sourceApprovalSurvivesTheProcessDeathThatAndroid11CausesWhenTheGrantChanges() {
        UpdateTestServer().use { server ->
            server.json("/latest/android-update.json", CoreTestFixtures.manifest(version = 2).toString())
            server.bytes("/latest/${CoreTestFixtures.APK_NAME}", CoreTestFixtures.payload)
            val manager = shadowOf(context.packageManager)
            manager.installPackage(CoreTestFixtures.packageInfo(context, 1))
            manager.setCanRequestPackageInstalls(false)
            val store = UpdateStore(context)
            val apk = withActivity { activity ->
                val first = updaterFor(activity, repository(server))
                first.enabled = false
                first.onLaunch()
                await { first.state.initialized }
                first.checkNow()
                await { first.state.phase == UpdatePhase.AVAILABLE }
                first.requestUpdate()
                await { first.state.phase == UpdatePhase.AWAITING_SOURCE_PERMISSION }
                File(store.downloadedApk!!)
            }
            assertTrue(apk.isFile)
            manager.setPackageArchiveInfo(apk.absolutePath, CoreTestFixtures.packageInfo(context, 2))

            // Android 11 kills the app when the user allows installs from it, so nothing in memory survives;
            // the activity is recreated in a new process and the Settings result is delivered before onResume.
            manager.setCanRequestPackageInstalls(true)
            withActivity { activity ->
                val stops = AtomicInteger()
                val second = updaterFor(activity, repository(server))
                second.serverController = ServerController { stops.incrementAndGet() }
                second.enabled = false
                second.onLaunch()
                second.resumeAfterSourceApproval()
                await { store.activeSessionId != null }
                assertEquals(1, stops.get())
                assertEquals(2L, store.activeVersionCode(store.activeCallback()!!))
                assertEquals(UpdatePhase.INSTALLING, second.state.phase)
                assertTrue(second.state.visible)
                assertTrue(apk.isFile)
                store.failInstall(store.activeSessionId)
            }
        }
    }

    @Test
    fun aStaleSourceApprovalIsDroppedOnALaunchWithoutTheSettingsResult() {
        UpdateTestServer().use { server ->
            server.json("/latest/android-update.json", CoreTestFixtures.manifest(version = 2).toString())
            server.bytes("/latest/${CoreTestFixtures.APK_NAME}", CoreTestFixtures.payload)
            shadowOf(context.packageManager).setCanRequestPackageInstalls(false)
            val apk = withActivity { activity ->
                val first = updaterFor(activity, repository(server))
                first.enabled = false
                first.onLaunch()
                await { first.state.initialized }
                first.checkNow()
                await { first.state.phase == UpdatePhase.AVAILABLE }
                first.requestUpdate()
                await { first.state.phase == UpdatePhase.AWAITING_SOURCE_PERMISSION }
                File(UpdateStore(context).downloadedApk!!)
            }
            withActivity { activity ->
                val second = updaterFor(activity, repository(server))
                second.enabled = false
                second.onLaunch()
                await { second.state.initialized && !apk.exists() }
                assertNull(UpdateStore(context).downloadedApk)
                assertFalse(second.state.visible)
                second.resumeAfterSourceApproval()
                assertNotEquals(UpdatePhase.INSTALLING, second.state.phase)
            }
        }
    }

    private fun <T> withActivity(block: (ComponentActivity) -> T): T {
        val activity = Robolectric.buildActivity(ComponentActivity::class.java).setup()
        stoppedActivities += activity
        try {
            return block(activity.get())
        } finally {
            // Process death never calls onCleared, so keep the ViewModel and only drop the activity.
            activity.pause().stop()
        }
    }

    private fun updaterFor(activity: ComponentActivity, repository: UpdateRepository): AppUpdater =
        ViewModelProvider(
            activity,
            object : ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T : ViewModel> create(modelClass: Class<T>): T = AppUpdater(context, repository) as T
            },
        )[AppUpdater::class.java]

    private fun repository(server: UpdateTestServer) = UpdateRepository(
        context,
        manifestUrl = server.url("/latest/android-update.json"),
        releasesApiUrl = server.url("/releases"),
        http = UpdateHttpClient(allowDebugLoopback = true),
        supportedAbis = listOf(CoreTestFixtures.ABI),
        defaultRef = "release",
        installedVersionCode = { 1 },
        installedSigner = { CoreTestFixtures.signer },
        archiveVerifier = { _, _, _ -> true },
    )

    private fun installedVersion(version: Long) {
        shadowOf(context.packageManager).getInternalMutablePackageInfo(context.packageName).longVersionCode = version
    }

    private fun blockedStatus(json: String) {
        File(context.filesDir, "status/update-blocked.json").apply {
            parentFile!!.mkdirs()
            writeText(json)
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
