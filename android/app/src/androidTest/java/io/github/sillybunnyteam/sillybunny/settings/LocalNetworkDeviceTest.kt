package io.github.sillybunnyteam.sillybunny.settings

import android.app.Application
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import io.github.sillybunnyteam.sillybunny.firstrun.FirstRunDeviceFixture
import io.github.sillybunnyteam.sillybunny.firstrun.FirstRunScreenHost
import io.github.sillybunnyteam.sillybunny.firstrun.FirstRunStage
import io.github.sillybunnyteam.sillybunny.firstrun.FirstRunUi
import io.github.sillybunnyteam.sillybunny.settings.LocalNetworkStatus.BLOCKED
import io.github.sillybunnyteam.sillybunny.settings.LocalNetworkStatus.DENIED
import io.github.sillybunnyteam.sillybunny.settings.LocalNetworkStatus.GRANTED
import io.github.sillybunnyteam.sillybunny.settings.LocalNetworkStatus.NOT_ASKED
import io.github.sillybunnyteam.sillybunny.settings.LocalNetworkStatus.NOT_REQUIRED
import io.github.sillybunnyteam.sillybunny.settings.SettingsUi.eventually
import io.github.sillybunnyteam.sillybunny.settings.SettingsUi.shell
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeFalse
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TestName
import org.junit.runner.RunWith
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import java.util.regex.Pattern
import kotlin.concurrent.thread

/**
 * Android 17's local-network permission on a device: whether the image enforces it for the app's UID, the request,
 * denial and settings-page flows of the Welcome item and the Settings row, and their absence below API 37.
 *
 * Each API 37 test needs a fresh permission and no stored answer, so run them one at a time and reset from the
 * host first: `pm clear <package>`, `pm revoke <package> android.permission.ACCESS_LOCAL_NETWORK` and
 * `pm clear-permission-flags <package> android.permission.ACCESS_LOCAL_NETWORK user-set user-fixed`. Without the
 * reset they are skipped by their assumption. The reachability test also needs `-e fixturePort <port>`: an HTTP
 * server on the host's 127.0.0.1, which the emulator reaches as 10.0.2.2.
 */
@RunWith(AndroidJUnit4::class)
class LocalNetworkDeviceTest {
    @get:Rule
    val name = TestName()

    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val app = ApplicationProvider.getApplicationContext<Application>()
    private val device = UiDevice.getInstance(instrumentation)
    private var fixture: FirstRunDeviceFixture? = null
    private var firstRun: FirstRunScreenHost? = null
    private var settings: SettingsScreenHost? = null

    @After
    fun tearDown() {
        try {
            firstRun?.close()
            settings?.close()
        } finally {
            fixture?.close()
        }
    }

    private fun granted(): Boolean = app.checkSelfPermission(PERMISSION) == PackageManager.PERMISSION_GRANTED

    private fun stored(): LocalNetworkStatus = AndroidLocalNetworkAccess(app).status()

    private fun assumeFreshPermission() {
        assumeTrue("ACCESS_LOCAL_NETWORK exists from API 37", Build.VERSION.SDK_INT >= 37)
        assumeFalse("Reset ACCESS_LOCAL_NETWORK from the host before this test", granted())
        assumeTrue("Clear the app's data from the host before this test", stored() == NOT_ASKED)
    }

    private fun dialogShown(timeoutMillis: Long): Boolean = device.wait(Until.hasObject(By.res(DIALOG_BUTTON)), timeoutMillis) == true

    /** A repeated request can show the deny button as `permission_deny_and_dont_ask_again_button`. */
    private fun answerPermissionDialog(allow: Boolean) {
        val id = if (allow) "permission_allow_button" else "permission_deny(_and_dont_ask_again)?_button"
        val selector = By.res(Pattern.compile(".*:id/$id"))
        val button = device.wait(Until.findObject(selector), 15_000)
        assertNotNull("Permission dialog button $id", button)
        button.click()
        assertTrue(device.wait(Until.gone(selector), 10_000))
    }

    private fun assertSettingsPageOpens() {
        assertNotNull("The app's page in system settings", device.wait(Until.findObject(By.pkg(SETTINGS)), 15_000))
        assertFalse("The request dialog stays closed", dialogShown(1_000))
        Log.i(TAG, shell("dumpsys activity activities").lines().filter { "ResumedActivity" in it }.joinToString(" | ") { it.trim() })
        device.pressBack()
        assertTrue(device.wait(Until.gone(By.pkg(SETTINGS)), 10_000))
    }

    private fun launchFirstRun(): FirstRunScreenHost {
        val fixture = FirstRunDeviceFixture(app, name.methodName).also { this.fixture = it }
        fixture.mode("success")
        fixture.release()
        val screen = FirstRunScreenHost(fixture.dependencies()).launch().also { firstRun = it }
        eventually(message = "Welcome") { screen.controller.state.value.stage == FirstRunStage.Welcome }
        return screen
    }

    private fun launchSettings(): SettingsScreenHost = SettingsScreenHost({ activity ->
        SettingsDependencies(
            serverHost = DeviceFakeServerHost(),
            appSettings = AppSettings(activity),
            updates = DeviceUpdateControls(),
            battery = SystemBatteryOptimizations(activity),
            leftoverFolders = LeftoverFolderCounter { 0 },
            notices = NoticesSource { null },
            runtimeVersions = RuntimeVersionsSource { emptyList() },
            localNetwork = AndroidLocalNetworkAccess(activity),
        )
    }).launch().also { settings = it }

    @Test
    fun theWelcomeItemAsksUntilTheSystemStopsAndTheInstallStillRuns() {
        assumeFreshPermission()
        val screen = launchFirstRun()
        val state = { screen.controller.state.value }
        assertEquals(NOT_ASKED, state().localNetwork)
        assertTrue(FirstRunUi.shown("firstrun_local_network"))
        assertFalse("Nothing asks on its own", dialogShown(3_000))

        FirstRunUi.click("firstrun_local_network_allow")
        answerPermissionDialog(allow = false)
        eventually(message = "DENIED") { state().localNetwork == DENIED }
        assertTrue(FirstRunUi.shown("firstrun_local_network_denied"))

        FirstRunUi.click("firstrun_local_network_allow")
        answerPermissionDialog(allow = false)
        eventually(message = "BLOCKED") { state().localNetwork == BLOCKED }
        assertTrue(FirstRunUi.shown("firstrun_local_network_blocked"))
        assertFalse(FirstRunUi.present("firstrun_local_network_allow"))
        assertFalse(granted())

        FirstRunUi.click("firstrun_continue")
        eventually(20_000, "Installed") { state().stage == FirstRunStage.Installed }
        assertEquals(1, fixture!!.host.jobs.size)
        assertEquals(BLOCKED, state().localNetwork)
    }

    @Test
    fun theSettingsRowAsksUntilTheSystemStopsThenOpensTheSettingsPage() {
        assumeFreshPermission()
        launchSettings()
        assertTrue(SettingsUi.shown(SettingsTags.LOCAL_NETWORK))
        assertFalse("Nothing asks on its own", dialogShown(3_000))

        SettingsUi.click(SettingsTags.LOCAL_NETWORK)
        answerPermissionDialog(allow = false)
        eventually(message = "DENIED") { stored() == DENIED }

        SettingsUi.click(SettingsTags.LOCAL_NETWORK)
        answerPermissionDialog(allow = false)
        eventually(message = "BLOCKED") { stored() == BLOCKED }

        // The dialog no longer shows, so the row opens the app's page in system settings instead.
        SettingsUi.click(SettingsTags.LOCAL_NETWORK)
        assertSettingsPageOpens()
        assertTrue(SettingsUi.find(SettingsTags.LOCAL_NETWORK).isEnabled)
        assertEquals(BLOCKED, stored())
        assertFalse(granted())
    }

    @Test
    fun theSettingsRowGrantsAndThenOpensTheSettingsPage() {
        assumeFreshPermission()
        launchSettings()
        SettingsUi.click(SettingsTags.LOCAL_NETWORK)
        answerPermissionDialog(allow = true)
        eventually(message = "granted") { granted() }
        assertEquals(GRANTED, stored())

        SettingsUi.click(SettingsTags.LOCAL_NETWORK)
        assertSettingsPageOpens()
        assertTrue(granted())
    }

    @Test
    fun aHostOnAPrivateAddressBeforeAndAfterTheGrant() {
        assumeTrue("ACCESS_LOCAL_NETWORK exists from API 37", Build.VERSION.SDK_INT >= 37)
        val port = InstrumentationRegistry.getArguments().getString("fixturePort")?.toIntOrNull()
        assumeTrue("Pass -e fixturePort <port> of an HTTP server on the host", port != null)
        assumeFalse("Reset ACCESS_LOCAL_NETWORK from the host before this test", granted())
        LoopbackServer().use { loopback ->
            val before = probes(port!!, loopback.port)
            Log.i(TAG, "before the grant: $before")

            instrumentation.uiAutomation.grantRuntimePermission(app.packageName, PERMISSION)
            eventually(message = "granted") { granted() }
            // The grant reaches the socket rules asynchronously, so give it a few attempts.
            var after = probes(port, loopback.port)
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20)
            while (!(after.app.reached && after.child.reached) && System.nanoTime() < deadline) {
                Thread.sleep(1_000)
                after = probes(port, loopback.port)
            }
            Log.i(TAG, "after the grant: $after")

            assertTrue("Loopback is not local network: $before", before.appLoopback.reached && before.childLoopback.reached)
            assertEquals("A child process follows the app's grant: $before", before.app.reached, before.child.reached)
            assertTrue("The host fixture after the grant: $after", after.app.reached && after.child.reached)
        }
    }

    @Test
    fun neitherTheItemNorTheRowAppearsBelowApi37() {
        assumeTrue("Below API 37 there is no local-network permission", Build.VERSION.SDK_INT < 37)
        val screen = launchFirstRun()
        assertEquals(NOT_REQUIRED, screen.controller.state.value.localNetwork)
        assertTrue(FirstRunUi.shown("firstrun_battery"))
        assertTrue(FirstRunUi.shown("firstrun_continue"))
        assertNull(FirstRunUi.findOrNull("firstrun_local_network", 5_000))
        screen.close()
        firstRun = null

        launchSettings()
        assertTrue(SettingsUi.shown(SettingsTags.BATTERY))
        assertNull(SettingsUi.findOrNull(SettingsTags.LOCAL_NETWORK, 5_000))
        assertFalse(dialogShown(1_000))
    }

    /** One HTTP request's outcome: [reached] when an HTTP status line came back. */
    private data class Outcome(val reached: Boolean, val detail: String)

    private data class Probes(val app: Outcome, val child: Outcome, val appLoopback: Outcome, val childLoopback: Outcome)

    private fun probes(port: Int, loopbackPort: Int) = Probes(
        app = fromApp(HOST_ALIAS, port),
        child = fromChild(HOST_ALIAS, port),
        appLoopback = fromApp(LOOPBACK, loopbackPort),
        childLoopback = fromChild(LOOPBACK, loopbackPort),
    )

    private fun fromApp(host: String, port: Int): Outcome = try {
        Socket().use { socket ->
            socket.connect(InetSocketAddress(host, port), TIMEOUT_MILLIS)
            socket.soTimeout = TIMEOUT_MILLIS
            socket.getOutputStream().write(REQUEST.toByteArray())
            val status = socket.getInputStream().bufferedReader().readLine().orEmpty()
            Outcome(status.startsWith("HTTP/"), status)
        }
    } catch (failure: IOException) {
        Outcome(false, failure.toString())
    }

    /** The same request from a process the app starts, which runs under the app's UID like the Node server. */
    private fun fromChild(host: String, port: Int): Outcome {
        val process = ProcessBuilder("/system/bin/toybox", "nc", "-w", "${TIMEOUT_MILLIS / 1_000}", host, "$port")
            .redirectErrorStream(true)
            .start()
        val output = AtomicReference("")
        val reader = thread(name = "local-network-child", isDaemon = true) {
            output.set(process.inputStream.bufferedReader().readText())
        }
        process.outputStream.use { it.write(REQUEST.toByteArray()) }
        val finished = process.waitFor(TIMEOUT_MILLIS * 3L, TimeUnit.MILLISECONDS)
        if (!finished) process.destroyForcibly()
        reader.join(TIMEOUT_MILLIS.toLong())
        val status = output.get().lineSequence().firstOrNull().orEmpty()
        return Outcome(status.startsWith("HTTP/"), "exit=${if (finished) process.exitValue() else "killed"} $status".trim())
    }

    /** A one-line HTTP server on 127.0.0.1 inside the app process, for the loopback control. */
    private class LoopbackServer : AutoCloseable {
        private val socket = ServerSocket(0, 8, InetAddress.getByName(LOOPBACK))
        val port: Int = socket.localPort
        private val worker = thread(name = "local-network-loopback", isDaemon = true) {
            while (!socket.isClosed) {
                try {
                    socket.accept().use { client ->
                        client.soTimeout = TIMEOUT_MILLIS
                        client.getInputStream().bufferedReader().readLine()
                        client.getOutputStream().write("HTTP/1.0 204 No Content\r\n\r\n".toByteArray())
                    }
                } catch (_: IOException) {
                    // A closed server socket ends the loop; a failed client only ends its own request.
                }
            }
        }

        override fun close() {
            socket.close()
            worker.join(5_000)
        }
    }

    private companion object {
        const val TAG = "LocalNetworkDevice"
        const val PERMISSION = "android.permission.ACCESS_LOCAL_NETWORK"

        /** The emulator's alias for the host's 127.0.0.1, a private address on the emulated Wi-Fi network. */
        const val HOST_ALIAS = "10.0.2.2"
        const val LOOPBACK = "127.0.0.1"
        const val TIMEOUT_MILLIS = 5_000
        const val REQUEST = "GET / HTTP/1.0\r\nHost: probe\r\n\r\n"
        val DIALOG_BUTTON: Pattern = Pattern.compile(".*:id/permission_(allow|deny)_button")

        /** The app's page in system settings belongs to the Settings app. */
        val SETTINGS: Pattern = Pattern.compile("com\\.(google\\.)?android\\.settings")
    }
}
