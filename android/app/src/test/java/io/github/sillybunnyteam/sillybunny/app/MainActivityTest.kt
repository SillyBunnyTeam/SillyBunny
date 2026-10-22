package io.github.sillybunnyteam.sillybunny.app

import android.Manifest
import android.content.Context
import android.os.Looper
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.findViewTreeViewModelStoreOwner
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import io.github.sillybunnyteam.sillybunny.MainActivity
import io.github.sillybunnyteam.sillybunny.app.AppFixture.Companion.OTHER_SESSION
import io.github.sillybunnyteam.sillybunny.app.AppFixture.Companion.REF
import io.github.sillybunnyteam.sillybunny.app.AppFixture.Companion.SESSION
import io.github.sillybunnyteam.sillybunny.firstrun.FirstRunInstall
import io.github.sillybunnyteam.sillybunny.repair.RepairState
import io.github.sillybunnyteam.sillybunny.repair.RepairTags
import io.github.sillybunnyteam.sillybunny.repair.TestCheckouts
import io.github.sillybunnyteam.sillybunny.runtime.RuntimeLayoutResult
import io.github.sillybunnyteam.sillybunny.server.ServerState
import io.github.sillybunnyteam.sillybunny.server.SetupState
import io.github.sillybunnyteam.sillybunny.settings.SettingsTags
import io.github.sillybunnyteam.sillybunny.update.AppUpdater
import io.github.sillybunnyteam.sillybunny.update.UpdateStore
import io.github.sillybunnyteam.sillybunny.web.EventLog
import io.github.sillybunnyteam.sillybunny.web.FakeWebShellPlatform
import io.github.sillybunnyteam.sillybunny.web.RecordingChooser
import io.github.sillybunnyteam.sillybunny.web.RecordingDownloads
import io.github.sillybunnyteam.sillybunny.web.WebAddress
import io.github.sillybunnyteam.sillybunny.web.WebScreenContent
import io.github.sillybunnyteam.sillybunny.web.WebScreenTags
import io.github.sillybunnyteam.sillybunny.web.WebShell
import io.github.sillybunnyteam.sillybunny.web.WebShellHolder
import io.github.sillybunnyteam.sillybunny.web.retainedWebShell
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.io.File

/**
 * MainActivity over fake components: the launch decisions reach the right screens, server starts happen only
 * while the activity is started, and the WebView screen keeps one WebView per server session across recreation.
 * The WebView runs on a recording platform, so the cookie and every load are visible.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class MainActivityTest {
    @get:Rule
    val temporary = TemporaryFolder()

    @get:Rule
    val compose = createEmptyComposeRule()

    private val context: Context = ApplicationProvider.getApplicationContext()
    private val log = EventLog()
    private val platform = FakeWebShellPlatform(log)
    private val chooser = RecordingChooser(log)
    private val downloads = RecordingDownloads(log)
    private val address = WebAddress(LABEL)
    private lateinit var fixture: AppFixture
    private var scenario: ActivityScenario<MainActivity>? = null

    @Before
    fun setUp() {
        // The launch check would reach the network.
        UpdateStore(context).enabled = false
        fixture = AppFixture(temporary.newFolder("app"))
        fixture.webContent = { session, modifier ->
            val view = LocalView.current
            val shell = remember(view) {
                retainedWebShell(checkNotNull(view.findViewTreeViewModelStoreOwner()), view.context)
            }
            WebScreenContent(shell, session, address, chooser, downloads, modifier)
        }
        AppComponents.replaceForTest(fixture.components)
    }

    @After
    fun tearDown() {
        scenario?.close()
        AppComponents.replaceForTest(null)
    }

    private fun launch(): ActivityScenario<MainActivity> = ActivityScenario.launch(MainActivity::class.java).also {
        scenario = it
        compose.waitForIdle()
    }

    private fun activity(): MainActivity {
        var activity: MainActivity? = null
        checkNotNull(scenario).onActivity { activity = it }
        return checkNotNull(activity)
    }

    private fun publish(state: ServerState) {
        fixture.host.state.value = state
        shadowOf(Looper.getMainLooper()).idle()
        compose.waitForIdle()
    }

    /** Gives the activity's retained WebView shell the recording platform before any web screen asks for it. */
    private fun recordWebViews() {
        checkNotNull(scenario).onActivity { activity ->
            val factory = WebShellHolder.factory { WebShell(activity.applicationContext, platform) }
            ViewModelProvider(activity, factory)[WebShellHolder.KEY, WebShellHolder::class.java].shell()
        }
    }

    /** A finished checkout and a server already starting, so the launch asks for nothing; then [SESSION] runs. */
    private fun showWeb() {
        fixture.writeInstalledCheckout()
        fixture.host.state.value = ServerState.Starting(attempt = 1)
        launch()
        recordWebViews()
        publish(ServerState.Running(SESSION, originChanged = false))
        platform.cookies.last().done(true)
        compose.waitForIdle()
    }

    private fun loads() = log.events.filter { it.startsWith("load ") }

    @Test
    fun everyServerSessionGetsItsOwnCookieAndWebView() {
        showWeb()
        val first = platform.cookies.single()
        assertEquals(address.origin(SESSION), first.url)
        assertEquals("sillybunny_launch=${SESSION.token}; HttpOnly; SameSite=Strict; Path=/", first.value)
        assertEquals(listOf("load w1 ${address.origin(SESSION)}/"), loads())

        // An automatic restart publishes a new session with a new token.
        publish(ServerState.Starting(attempt = 2))
        publish(ServerState.Running(OTHER_SESSION, originChanged = false))
        val second = platform.cookies.last()
        assertEquals(2, platform.cookies.size)
        assertEquals(address.origin(OTHER_SESSION), second.url)
        assertEquals("sillybunny_launch=${OTHER_SESSION.token}; HttpOnly; SameSite=Strict; Path=/", second.value)
        second.done(true)
        compose.waitForIdle()
        assertEquals(listOf("w1", "w2"), platform.views.map { it.toString() })
        assertEquals("load w2 ${address.origin(OTHER_SESSION)}/", loads().last())
    }

    @Test
    fun recreationRestartsNeitherTheServerNorTheWebView() {
        showWeb()
        assertEquals(1, fixture.activityStarts)
        checkNotNull(scenario).recreate()
        compose.waitForIdle()
        compose.onNodeWithTag(WebScreenTags.CONTENT).assertExists()
        assertEquals(0, fixture.host.starts)
        assertEquals(0, fixture.host.restarts)
        assertEquals(1, platform.views.size)
        assertEquals(1, platform.cookies.size)
        assertEquals(1, loads().size)
        assertEquals(2, fixture.activityStarts)
        assertEquals(1, fixture.activityStops)
    }

    @Test
    @Config(qualifiers = "w360dp-h640dp")
    fun onAPhoneTheBarSitsAboveTheWebContent() = assertBarAboveWebContent()

    @Test
    @Config(qualifiers = "w1280dp-h800dp")
    fun onALargeScreenTheBarSitsAboveTheWebContent() = assertBarAboveWebContent()

    private fun assertBarAboveWebContent() {
        showWeb()
        val web = compose.onNodeWithTag(AppTags.WEB).fetchSemanticsNode().boundsInRoot
        val bar = compose.onNodeWithTag(AppTags.BAR).fetchSemanticsNode().boundsInRoot
        val content = compose.onNodeWithTag(WebScreenTags.CONTENT).fetchSemanticsNode().boundsInRoot
        assertTrue("bar $bar overlaps content $content", bar.bottom <= content.top)
        assertEquals(web.width, bar.width, 1f)
        assertEquals(web.width, content.width, 1f)
        assertEquals(web.bottom, content.bottom, 1f)
        assertTrue("content $content in $web", content.height > web.height / 2)
        compose.onNodeWithTag(AppTags.OPEN_IN_BROWSER).assertIsDisplayed()
        compose.onNodeWithTag(AppTags.OPEN_SETTINGS).assertIsDisplayed()
    }

    @Test
    fun settingsOpensOverTheWebAndBackKeepsTheSameWebView() {
        showWeb()
        compose.onNodeWithTag(AppTags.OPEN_SETTINGS).performClick()
        compose.onNodeWithTag(SettingsTags.MAIN).assertExists()
        compose.onNodeWithTag(WebScreenTags.CONTENT).assertDoesNotExist()
        checkNotNull(scenario).onActivity { it.onBackPressedDispatcher.onBackPressed() }
        compose.waitForIdle()
        compose.onNodeWithTag(WebScreenTags.CONTENT).assertExists()
        assertEquals(1, platform.views.size)
        assertEquals(1, loads().size)
    }

    @Test
    fun theLaunchStartsAStoppedServerAndAsksForNotificationsOnceWithoutWaiting() {
        fixture.writeInstalledCheckout()
        launch()
        assertEquals(1, fixture.host.starts)
        val request = checkNotNull(shadowOf(activity()).lastRequestedPermission)
        assertArrayEquals(arrayOf(Manifest.permission.POST_NOTIFICATIONS), request.requestedPermissions)

        publish(ServerState.Starting(attempt = 1))
        publish(ServerState.Stopped(userStopped = true))
        compose.onNodeWithTag(AppTags.STOPPED_START).performClick()
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(2, fixture.host.starts)
        assertSame(request, shadowOf(activity()).lastRequestedPermission)
    }

    @Test
    @Config(sdk = [29])
    fun belowApi33NothingIsAsked() {
        fixture.writeInstalledCheckout()
        launch()
        assertEquals(1, fixture.host.starts)
        assertNull(shadowOf(activity()).lastRequestedPermission)
    }

    @Test
    fun theUpdaterReachesTheServerThroughTheSharedController() {
        fixture.writeInstalledCheckout()
        launch()
        assertSame(fixture.controller, AppUpdater.forActivity(activity()).serverController)
    }

    @Test
    fun aServerThatGaveUpOffersRestartShareAndRepairButIsNotRestartedByTheLaunch() {
        fixture.writeInstalledCheckout()
        fixture.host.state.value = ServerState.Failed(listOf("line one", "line two"), canRestart = true)
        launch()
        compose.onNodeWithTag(AppTags.FAILED_LINES).assertIsDisplayed()
        compose.onNodeWithTag(AppTags.FAILED_SHARE_LOGS).assertIsDisplayed()
        assertEquals(0, fixture.host.starts)
        compose.onNodeWithTag(AppTags.FAILED_RESTART).performClick()
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(1, fixture.host.starts)

        publish(ServerState.Starting(attempt = 1))
        publish(ServerState.Failed(emptyList(), canRestart = false))
        compose.onNodeWithTag(AppTags.FAILED_RESTART).assertDoesNotExist()
        compose.onNodeWithTag(AppTags.FAILED_REPAIR).performClick()
        compose.onNodeWithTag(RepairTags.CONFIRM).assertExists()
    }

    @Test
    fun aRuntimeErrorStartsNothingUntilRetrySucceeds() {
        fixture.layout = { RuntimeLayoutResult.Unavailable }
        fixture.writeInstalledCheckout()
        launch()
        compose.onNodeWithTag(AppTags.RUNTIME_ERROR).assertIsDisplayed()
        compose.onNodeWithTag(AppTags.RUNTIME_SHARE_LOGS).assertIsDisplayed()
        assertTrue(fixture.host.events.isEmpty())

        fixture.layout = { fixture.ready() }
        compose.onNodeWithTag(AppTags.RUNTIME_RETRY).performClick()
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(1, fixture.host.starts)
    }

    @Test
    fun theFirstRunInstallsThroughTheHostAndThenStartsTheServer() {
        launch()
        compose.onNodeWithTag("firstrun_welcome").assertExists()
        compose.onNodeWithTag("firstrun_continue").performClick()
        compose.waitForIdle()
        val job = fixture.host.jobs.single()
        assertEquals(FirstRunInstall.args(fixture.paths, REF), job.args)
        assertEquals(fixture.paths.installScript, job.script)
        assertEquals(0, fixture.host.starts)

        fixture.writeInstalledCheckout()
        fixture.host.setup.value = SetupState.Finished(job, 0, listOf("Done."))
        shadowOf(Looper.getMainLooper()).idle()
        compose.waitForIdle()
        assertEquals(1, fixture.host.starts)
        assertEquals(1, fixture.rootsChanged)
        // The first run's Welcome owned the notification question.
        assertNull(shadowOf(activity()).lastRequestedPermission)
    }

    @Test
    fun aRepairOpenedFromTheFirstRunDoesNotAskForNotificationsAgain() {
        launch()
        compose.onNodeWithTag("firstrun_welcome").assertExists()
        // The first run's error screen offers Repair, after its Welcome asked.
        checkNotNull(scenario).onActivity { LaunchCoordinator.forActivity(it, fixture.components).open(Overlay.REPAIR) }
        compose.waitForIdle()
        compose.onNodeWithTag(RepairTags.CONFIRM).assertExists()
        assertNull(shadowOf(activity()).lastRequestedPermission)
    }

    @Test
    fun aRepairThatSucceededInTheBackgroundStartsTheServerAtTheNextStart() {
        TestCheckouts.create(fixture.paths.checkoutDir, config = "dataRoot: ./data\n", tracking = REF)
        assertTrue(fixture.repair.start())
        val job = fixture.host.jobs.single()
        val source = File(job.args[job.args.indexOf("--migrate-from") + 1])
        // The user left the app while install.sh ran.
        fixture.visible = false
        TestCheckouts.installed(fixture.paths.checkoutDir)
        File(source, "data").copyRecursively(File(fixture.paths.checkoutDir, "data"))
        fixture.host.setup.value = SetupState.Finished(job, 0, listOf("Done."))
        assertTrue(fixture.repairStartDeferred.get())

        fixture.visible = true
        launch()
        assertFalse(fixture.repairStartDeferred.get())
        assertTrue((fixture.repair.state.value as RepairState.Succeeded).serverStarted)
        assertTrue(fixture.host.starts >= 1)
    }

    private companion object {
        const val LABEL = "sb-abcdefghijklmnopqrstuvwxyz"
    }
}
