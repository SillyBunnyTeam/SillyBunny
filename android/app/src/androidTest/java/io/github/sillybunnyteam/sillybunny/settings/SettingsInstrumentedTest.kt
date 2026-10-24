package io.github.sillybunnyteam.sillybunny.settings

import android.app.Activity
import android.app.Application
import android.content.Intent
import android.os.Build
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.core.content.FileProvider
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Until
import io.github.sillybunnyteam.sillybunny.server.ServerHost
import io.github.sillybunnyteam.sillybunny.server.ServerState
import io.github.sillybunnyteam.sillybunny.settings.SettingsUi.device
import io.github.sillybunnyteam.sillybunny.settings.SettingsUi.eventually
import io.github.sillybunnyteam.sillybunny.settings.SettingsUi.shell
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicInteger
import java.util.regex.Pattern

@RunWith(AndroidJUnit4::class)
class SettingsInstrumentedTest {
    private val app = ApplicationProvider.getApplicationContext<Application>()
    private val logs = File(app.filesDir, "p57-device-logs")
    private var host: SettingsScreenHost? = null

    @Before
    fun prepare() {
        logs.deleteRecursively()
        LogSharing.snapshotDirectory(app).deleteRecursively()
    }

    @After
    fun clean() {
        host?.close()
        logs.deleteRecursively()
        LogSharing.snapshotDirectory(app).deleteRecursively()
    }

    private fun dependencies(
        activity: ComponentActivity,
        server: ServerHost,
        battery: BatteryOptimizations = SystemBatteryOptimizations(activity),
        notices: NoticesSource = AssetNoticesSource(activity.assets),
    ) = SettingsDependencies(
        serverHost = server,
        appSettings = AppSettings(activity),
        updates = DeviceUpdateControls(),
        battery = battery,
        leftoverFolders = LeftoverFolderCounter { 0 },
        notices = notices,
        runtimeVersions = AssetRuntimeVersions(activity.assets),
    )

    private fun launch(dependencies: (ComponentActivity) -> SettingsDependencies): SettingsScreenHost =
        SettingsScreenHost(dependencies).launch().also { host = it }

    private fun snapshots(): List<File> = LogSharing.snapshotDirectory(app).listFiles().orEmpty()
        .filter { LogSharing.isSnapshotName(it.name) && it.name.endsWith(".txt") }

    @Test
    fun stopRunsOffTheMainThreadThenStartAppears() {
        val gate = CountDownLatch(1)
        val server = DeviceFakeServerHost(initial = deviceRunningState, stopGate = gate)
        launch { dependencies(it, server) }

        assertTrue(SettingsUi.shown(SettingsTags.SERVER_STATUS))
        SettingsUi.click(SettingsTags.SERVER_STOP)
        eventually(message = "stop") { server.stops.get() == 1 }
        // The blocking stop is still running: progress replaces both actions.
        assertTrue(SettingsUi.shown(SettingsTags.SERVER_PROGRESS))
        assertFalse(SettingsUi.present(SettingsTags.SERVER_STOP))
        assertFalse(SettingsUi.present(SettingsTags.SERVER_START))
        assertEquals(ServerState.Stopping, server.state.value)
        assertEquals(false, server.stopOnMainThread)

        gate.countDown()
        assertTrue(SettingsUi.shown(SettingsTags.SERVER_START))
        assertTrue(server.state.value is ServerState.Stopped)
        assertTrue(SettingsUi.gone(SettingsTags.SERVER_PROGRESS))
        SettingsUi.click(SettingsTags.SERVER_START)
        assertTrue(SettingsUi.shown(SettingsTags.SERVER_STOP))
        assertEquals(1, server.starts.get())
        assertTrue("Start comes from the visible screen", server.startContext is Activity)
        assertTrue(server.state.value is ServerState.Starting)
    }

    @Test
    fun theLicensesScreenRendersTheFixtureNotices() {
        val notices = (ThirdPartyNotices.load(NoticesFixture.source()) as NoticesLoad.Loaded).notices
        launch { dependencies(it, DeviceFakeServerHost(), notices = NoticesFixture.source()) }
        SettingsUi.click(SettingsTags.OPEN_LICENSES)
        assertTrue(SettingsUi.shown(SettingsTags.LICENSES_LIST))
        for (id in NoticesFixture.componentIds) {
            assertTrue(id, SettingsUi.shown(SettingsTags.LICENSE_COMPONENT_PREFIX + id))
        }

        val component = notices.components.single { it.id == "npm/fixture-pkg" }
        SettingsUi.click(SettingsTags.LICENSE_COMPONENT_PREFIX + component.id)
        val block = SettingsUi.find(SettingsTags.LICENSE_NOTICE_PREFIX + component.id)
        assertEquals(ThirdPartyNotices.chunks(notices.noticeText(component)).first(), block.text)

        SettingsUi.click(SettingsTags.LICENSES_FULL_TEXT_TOGGLE)
        val full = SettingsUi.find(SettingsTags.LICENSES_FULL_TEXT)
        assertEquals(ThirdPartyNotices.chunks(notices.fullText()).first(), full.text)
    }

    @Test
    fun theBuildsOwnNoticesAssetsShowTheLicensesOrTheEmptyState() {
        // Debug builds without runtime inputs package no notices; builds with them list the components.
        val packaged = app.assets.list("").orEmpty().contains(ThirdPartyNotices.INDEX_ASSET)
        launch { dependencies(it, DeviceFakeServerHost()) }
        SettingsUi.click(SettingsTags.OPEN_LICENSES)
        val expected = if (packaged) SettingsTags.LICENSES_LIST else SettingsTags.LICENSES_EMPTY
        assertTrue(expected, SettingsUi.shown(expected))
    }

    /** The system battery screens, with the exemption reads counted and an optional [first] screen ahead of them. */
    private class CountingBattery(private val first: Intent? = null) : BatteryOptimizations {
        val system = SystemBatteryOptimizations(ApplicationProvider.getApplicationContext())
        val reads = AtomicInteger()

        override fun isExempt(): Boolean = system.isExempt().also { reads.incrementAndGet() }

        override fun shortcutIntents(exempt: Boolean): List<Intent> = listOfNotNull(first) + system.shortcutIntents(exempt)
    }

    /** The package of the screen the system shortcut opens first in the current exemption state. */
    private fun firstSystemScreen(battery: CountingBattery): String {
        val exempt = battery.system.isExempt()
        val screen = battery.system.shortcutIntents(exempt).first()
        val expected = if (exempt) {
            Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS
        } else {
            Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS
        }
        assertEquals(expected, screen.action)
        val target = screen.resolveActivity(app.packageManager)
        assertNotNull("the battery shortcut resolves", target)
        return target!!.packageName
    }

    /** Opens the battery entry, waits for [target] to come to the front, goes back and expects a fresh read. */
    private fun openTheBatteryScreenAndReturn(battery: CountingBattery, target: String) {
        launch { dependencies(it, DeviceFakeServerHost(), battery = battery) }
        SettingsUi.find(SettingsTags.BATTERY)
        eventually(message = "first battery read") { battery.reads.get() > 0 }
        val before = battery.reads.get()
        SettingsUi.click(SettingsTags.BATTERY)
        assertTrue("the system screen opens", device.wait(Until.hasObject(By.pkg(target)), 15_000))
        device.pressBack()
        assertTrue("the system screen closes", device.wait(Until.gone(By.pkg(target)), 15_000))
        // Back in Settings the exemption is read again.
        eventually(15_000, "battery read after return") { battery.reads.get() > before }
        assertTrue(SettingsUi.shown(SettingsTags.MAIN))
    }

    @Test
    fun theBatteryShortcutResolvesAndReturns() {
        val battery = CountingBattery()
        openTheBatteryScreenAndReturn(battery, firstSystemScreen(battery))
    }

    @Test
    fun aBatteryScreenThatDoesNotResolveFallsBackToTheNextOne() {
        // Starting an intent nothing handles throws on a device; the shortcut then opens the system screen.
        val battery = CountingBattery(first = Intent("io.github.sillybunnyteam.sillybunny.test.NO_SUCH_SCREEN"))
        openTheBatteryScreenAndReturn(battery, firstSystemScreen(battery))
    }

    @Test
    fun theShareSheetOpensWithASnapshotThatTheReadGrantMakesReadable() {
        val nonce = UUID.randomUUID().toString()
        logs.mkdirs()
        val log = File(logs, "server.log").apply { writeText("first\n$nonce\n") }
        launch { dependencies(it, DeviceFakeServerHost(logs = listOf(log))) }

        SettingsUi.click(SettingsTags.SHARE_LOGS)
        assertTrue(SettingsUi.shown(SettingsTags.SHARE_WARNING))
        assertTrue("nothing is written before the warning is confirmed", snapshots().isEmpty())
        SettingsUi.click(SettingsTags.SHARE_CONFIRM)
        assertTrue("the share sheet opens", device.wait(Until.hasObject(By.pkg(CHOOSER)), 15_000))

        val snapshot = snapshots().single()
        assertEquals("first\n$nonce\n", snapshot.readText())
        val uri = FileProvider.getUriForFile(app, LogSharing.authority(app), snapshot)
        assertEquals("content", uri.scheme)
        if (Build.VERSION.SDK_INT >= CHOOSER_APP_SDK) {
            // The share sheet is its own app here, and the share intent's grant covers exactly this URI.
            assertTrue("the share sheet holds a read grant", shell("dumpsys activity permissions").contains(uri.toString()))
        }
        // The provider is not exported: another uid reads the snapshot only through a read grant.
        assertFalse(shell("content read --uri $uri").contains(nonce))
        app.grantUriPermission(SHELL_PACKAGE, uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        try {
            assertTrue(shell("content read --uri $uri").contains(nonce))
        } finally {
            app.revokeUriPermission(SHELL_PACKAGE, uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }

        device.pressBack()
        assertTrue("the share sheet closes", device.wait(Until.gone(By.pkg(CHOOSER)), 15_000))
        assertTrue(SettingsUi.shown(SettingsTags.MAIN))
        assertTrue(SettingsUi.gone(SettingsTags.SHARE_DIALOG))
    }

    @Test
    fun systemBackLeavesASubScreenBeforeSettings() {
        val screen = launch { dependencies(it, DeviceFakeServerHost()) }
        SettingsUi.click(SettingsTags.VIEW_LOGS)
        assertTrue(SettingsUi.shown(SettingsTags.LOGS_TEXT))
        device.pressBack()
        assertTrue(SettingsUi.shown(SettingsTags.MAIN))
        assertTrue(SettingsUi.gone(SettingsTags.LOGS))
        assertEquals(0, screen.ups.get())
        device.pressBack()
        eventually(message = "navigate up") { screen.ups.get() == 1 }
        assertTrue(SettingsUi.present(SettingsTags.MAIN))
    }

    private companion object {
        const val SHELL_PACKAGE = "com.android.shell"

        /** From API 34 the share sheet is the IntentResolver app; before, it runs in the system process. */
        const val CHOOSER_APP_SDK = 34

        val CHOOSER: Pattern = Pattern.compile("android|com\\.android\\.intentresolver|com\\.google\\.android\\.intentresolver")
    }
}
