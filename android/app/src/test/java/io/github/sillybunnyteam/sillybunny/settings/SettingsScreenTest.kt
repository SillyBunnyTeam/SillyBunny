package io.github.sillybunnyteam.sillybunny.settings

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import androidx.activity.BackEventCompat
import androidx.activity.ComponentActivity
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsPropertyKey
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertHasNoClickAction
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.lifecycle.Lifecycle
import io.github.sillybunnyteam.sillybunny.server.LaunchSession
import io.github.sillybunnyteam.sillybunny.server.ServerState
import io.github.sillybunnyteam.sillybunny.server.SetupJob
import io.github.sillybunnyteam.sillybunny.server.SetupState
import io.github.sillybunnyteam.sillybunny.update.UpdateCheckFailure
import io.github.sillybunnyteam.sillybunny.update.UpdateCheckResult
import io.github.sillybunnyteam.sillybunny.update.UpdatePhase
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicInteger
import kotlin.coroutines.CoroutineContext

// API 37 is not here: the Espresso 3.5.0 that Compose UI tests bring fails on it (InputManager.getInstance).
// The device suite covers API 37 with UiAutomator instead.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29, 36])
class SettingsScreenTest {
    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>()

    private val context: Context get() = compose.activity

    @Before
    fun reset() {
        context.getSharedPreferences("app_settings", Context.MODE_PRIVATE).edit().clear().commit()
        LogSharing.snapshotDirectory(context).deleteRecursively()
        resetFileProviderRoots()
    }

    private fun show(
        dependencies: SettingsDependencies,
        callbacks: SettingsCallbacks = SettingsCallbacks(),
        onNavigateUp: () -> Unit = {},
    ) = compose.setContent {
        MaterialTheme { SettingsScreen(dependencies, callbacks, onNavigateUp) }
    }

    private fun node(tag: String): SemanticsNodeInteraction = compose.onNodeWithTag(tag)

    /** Scrolls the main screen to [tag] first, so clicks land on it on any screen size. */
    private fun entry(tag: String): SemanticsNodeInteraction = node(tag).performScrollTo()

    private fun exists(tag: String) = compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty()

    private fun <T> value(tag: String, key: SemanticsPropertyKey<T>): T? =
        compose.onAllNodesWithTag(tag).fetchSemanticsNodes().firstOrNull()?.config?.getOrNull(key)

    private fun <T> SemanticsNodeInteraction.has(key: SemanticsPropertyKey<T>, expected: T) =
        assert(SemanticsMatcher.expectValue(key, expected))

    private fun status(expected: String) = node(SettingsTags.SERVER_STATUS).has(SettingsSemantics.ServerStatus, expected)

    private fun resumeAgain() {
        compose.activityRule.scenario.moveToState(Lifecycle.State.STARTED)
        compose.activityRule.scenario.moveToState(Lifecycle.State.RESUMED)
    }

    private fun back() = compose.runOnUiThread { compose.activity.onBackPressedDispatcher.onBackPressed() }

    @Test
    fun serverEntriesFollowTheServerState() {
        val host = FakeServerHost()
        val opened = mutableListOf<LaunchSession>()
        show(fakeDependencies(context, host = host), SettingsCallbacks(onOpenInBrowser = { opened += it }))

        status("STOPPED")
        node(SettingsTags.SERVER_START).assertIsEnabled()
        node(SettingsTags.SERVER_STOP).assertDoesNotExist()
        node(SettingsTags.SERVER_PROGRESS).assertDoesNotExist()
        entry(SettingsTags.OPEN_IN_BROWSER).assertIsNotEnabled()
        node(SettingsTags.RESTART_SERVER).assertDoesNotExist()

        host.emit(ServerState.Starting(attempt = 1))
        status("STARTING")
        node(SettingsTags.SERVER_STOP).assertIsEnabled()
        node(SettingsTags.SERVER_START).assertDoesNotExist()
        entry(SettingsTags.OPEN_IN_BROWSER).assertIsNotEnabled()
        node(SettingsTags.RESTART_SERVER).assertDoesNotExist()

        host.emit(runningState)
        status("RUNNING")
        node(SettingsTags.SERVER_STOP).assertIsEnabled()
        node(SettingsTags.SERVER_START).assertDoesNotExist()
        entry(SettingsTags.RESTART_SERVER).assertIsEnabled()
        entry(SettingsTags.OPEN_IN_BROWSER).assertIsEnabled().performClick()
        assertEquals(listOf(runningState.session), opened)

        host.emit(ServerState.Stopping)
        status("STOPPING")
        node(SettingsTags.SERVER_PROGRESS).assertExists()
        node(SettingsTags.SERVER_STOP).assertDoesNotExist()
        node(SettingsTags.SERVER_START).assertDoesNotExist()
        entry(SettingsTags.OPEN_IN_BROWSER).assertIsNotEnabled()

        host.emit(ServerState.Failed(listOf("last line"), canRestart = true))
        status("FAILED")
        // Start from a failed server is the host's explicit restart.
        entry(SettingsTags.SERVER_START).assertIsEnabled().performClick()
        assertEquals(1, host.restarts.get())
        assertEquals(0, host.starts.get())
        status("STARTING")

        host.emit(ServerState.Failed(emptyList(), canRestart = false))
        entry(SettingsTags.SERVER_START).assertIsNotEnabled()

        // A first-run or Repair job owns the checkout until it finishes.
        host.emit(ServerState.Stopped(userStopped = true))
        host.emitSetup(SetupState.Running(SetupJob(File("install.sh"), emptyList(), context.filesDir), emptyList()))
        entry(SettingsTags.SERVER_START).assertIsNotEnabled()
        host.emitSetup(SetupState.Idle)
        entry(SettingsTags.SERVER_START).assertIsEnabled()
        assertEquals(listOf(runningState.session), opened)
    }

    @Test
    fun stopRunsOffTheMainThreadAndStartAppearsAfterIt() {
        val gate = CountDownLatch(1)
        val host = FakeServerHost(initial = runningState).apply { stopGate = gate }
        show(fakeDependencies(context, host = host))

        entry(SettingsTags.SERVER_STOP).performClick()
        compose.waitUntil(5_000) { host.stops.get() == 1 }
        // The blocking stop is still running: progress replaces both actions.
        compose.waitUntil(5_000) { exists(SettingsTags.SERVER_PROGRESS) }
        node(SettingsTags.SERVER_STOP).assertDoesNotExist()
        node(SettingsTags.SERVER_START).assertDoesNotExist()
        assertEquals(false, host.stopOnMainThread)
        assertNotNull(host.stopThread)

        gate.countDown()
        compose.waitUntil(5_000) { exists(SettingsTags.SERVER_START) }
        status("STOPPED")
        node(SettingsTags.SERVER_PROGRESS).assertDoesNotExist()
        assertEquals(1, host.stops.get())

        entry(SettingsTags.SERVER_START).performClick()
        assertEquals(1, host.starts.get())
        assertNotNull(host.startContext)
        status("STARTING")
        node(SettingsTags.SERVER_STOP).assertExists()
    }

    @Test
    fun theGitAutoUpdateSwitchPersistsAndOffersARestartWhileRunning() {
        val host = FakeServerHost(initial = runningState)
        var generation by mutableIntStateOf(0)
        val dependencies = fakeDependencies(context, host = host)
        compose.setContent {
            MaterialTheme { key(generation) { SettingsScreen(dependencies, SettingsCallbacks(), onNavigateUp = {}) } }
        }

        entry(SettingsTags.AUTO_UPDATE_GIT).assertIsOn().performClick().assertIsOff()
        assertFalse(AppSettings(context).autoUpdateGit)
        // A fresh screen reads the stored value back.
        generation++
        entry(SettingsTags.AUTO_UPDATE_GIT).assertIsOff().performClick().assertIsOn()
        assertTrue(AppSettings(context).autoUpdateGit)

        // The change applies at the next server start; the restart action gives one now.
        entry(SettingsTags.RESTART_SERVER).performClick()
        assertEquals(1, host.restarts.get())
        host.emit(ServerState.Stopped(userStopped = true))
        node(SettingsTags.RESTART_SERVER).assertDoesNotExist()
        entry(SettingsTags.AUTO_UPDATE_GIT).assertIsOn()
    }

    @Test
    fun appUpdatesSwitchAndCheckNowGoThroughTheUpdater() {
        val updates = FakeUpdateControls()
        show(fakeDependencies(context, updates = updates))

        entry(SettingsTags.APP_UPDATES).assertIsOn().performClick().assertIsOff()
        assertFalse(updates.enabled)
        entry(SettingsTags.APP_UPDATES).performClick().assertIsOn()
        assertTrue(updates.enabled)

        entry(SettingsTags.CHECK_NOW).assertIsEnabled()
            .has(SettingsSemantics.UpdatePhaseShown, UpdatePhase.IDLE)
            .has(SettingsSemantics.UpdateResultShown, "NONE")
            .performClick()
        assertEquals(1, updates.checks)

        // While the updater works, Check now would only repeat itself.
        for (phase in listOf(
            UpdatePhase.CHECKING,
            UpdatePhase.DOWNLOADING,
            UpdatePhase.AWAITING_SOURCE_PERMISSION,
            UpdatePhase.INSTALLING,
        )) {
            updates.state = updates.state.copy(phase = phase)
            entry(SettingsTags.CHECK_NOW).assertIsNotEnabled().has(SettingsSemantics.UpdatePhaseShown, phase)
        }

        updates.state = updates.state.copy(
            phase = UpdatePhase.ERROR,
            lastResult = UpdateCheckResult.Failed(UpdateCheckFailure.SIGNER_MISMATCH),
        )
        entry(SettingsTags.CHECK_NOW).assertIsEnabled()
            .has(SettingsSemantics.UpdatePhaseShown, UpdatePhase.ERROR)
            .has(SettingsSemantics.UpdateResultShown, "FAILED_SIGNER_MISMATCH")
        updates.state = updates.state.copy(phase = UpdatePhase.UP_TO_DATE, lastResult = UpdateCheckResult.UpToDate)
        entry(SettingsTags.CHECK_NOW).assertIsEnabled().has(SettingsSemantics.UpdateResultShown, "UP_TO_DATE")
        entry(SettingsTags.CHECK_NOW).performClick()
        assertEquals(2, updates.checks)
    }

    @Test
    fun batteryStateIsReadAgainOnResumeAndTheShortcutOpens() {
        val battery = FakeBattery(exempt = false)
        show(fakeDependencies(context, battery = battery))

        compose.waitUntil(5_000) { value(SettingsTags.BATTERY, SettingsSemantics.BatteryExempt) == false }
        entry(SettingsTags.BATTERY).assertIsEnabled()

        battery.exempt = true
        val reads = battery.reads.get()
        resumeAgain()
        compose.waitUntil(5_000) { battery.reads.get() > reads }
        compose.waitUntil(5_000) { value(SettingsTags.BATTERY, SettingsSemantics.BatteryExempt) == true }

        entry(SettingsTags.BATTERY).performClick()
        val started = shadowOf(compose.activity).nextStartedActivityForResult
        assertNotNull(started)
        assertEquals(FakeBattery.ACTION, started.intent.action)
    }

    @Test
    fun theBatteryShortcutFallsBackWhenTheRequestDoesNotResolve() {
        // With activity checks on, starting an intent nothing resolves throws, as on a device.
        shadowOf(compose.activity.application).checkActivities(true)
        val list = ComponentName(context.packageName, "io.github.sillybunnyteam.sillybunny.test.BatteryList")
        shadowOf(context.packageManager).apply {
            addActivityIfNotPresent(list)
            addIntentFilterForActivity(list, IntentFilter(FakeBattery.FALLBACK_ACTION).apply { addCategory(Intent.CATEGORY_DEFAULT) })
        }
        val battery = FakeBattery(intents = listOf(Intent(FakeBattery.ACTION), Intent(FakeBattery.FALLBACK_ACTION)))
        show(fakeDependencies(context, battery = battery))

        entry(SettingsTags.BATTERY).assertIsEnabled().performClick()
        assertEquals(FakeBattery.FALLBACK_ACTION, shadowOf(compose.activity).nextStartedActivityForResult.intent.action)

        // Nothing resolves at all: the entry stays, disabled.
        battery.intents = listOf(Intent(FakeBattery.ACTION))
        entry(SettingsTags.BATTERY).performClick()
        assertNull(shadowOf(compose.activity).nextStartedActivityForResult)
        entry(SettingsTags.BATTERY).assertIsNotEnabled()
    }

    @Test
    fun leftoverFoldersShowTheirCountAndOpenTheirScreen() {
        val leftovers = FakeLeftovers(count = 3)
        var opened = 0
        show(fakeDependencies(context, leftovers = leftovers), SettingsCallbacks(onLeftoverFolders = { opened++ }))

        compose.waitUntil(5_000) { value(SettingsTags.LEFTOVER_FOLDERS, SettingsSemantics.LeftoverCount) == 3 }
        entry(SettingsTags.LEFTOVER_FOLDERS).assertIsEnabled().performClick()
        assertEquals(1, opened)

        // Coming back from that screen counts again; with nothing left the entry is disabled.
        leftovers.count = 0
        resumeAgain()
        compose.waitUntil(5_000) { value(SettingsTags.LEFTOVER_FOLDERS, SettingsSemantics.LeftoverCount) == 0 }
        entry(SettingsTags.LEFTOVER_FOLDERS).assertIsNotEnabled()
    }

    @Test
    fun repairAndOpenInBrowserCallTheirCallbacks() {
        var repairs = 0
        val opened = mutableListOf<LaunchSession>()
        show(
            fakeDependencies(context, host = FakeServerHost(initial = runningState)),
            SettingsCallbacks(onOpenInBrowser = { opened += it }, onRepair = { repairs++ }),
        )
        entry(SettingsTags.REPAIR).assertIsEnabled().performClick()
        assertEquals(1, repairs)
        entry(SettingsTags.OPEN_IN_BROWSER).performClick()
        assertEquals(listOf(runningState.session), opened)
    }

    @Test
    fun entriesOwnedByOtherScreensAreHiddenWithoutTheirCallbacks() {
        show(fakeDependencies(context, host = FakeServerHost(initial = runningState)))
        node(SettingsTags.OPEN_IN_BROWSER).assertDoesNotExist()
        node(SettingsTags.REPAIR).assertDoesNotExist()
        node(SettingsTags.LEFTOVER_FOLDERS).assertDoesNotExist()
        for (tag in listOf(
            SettingsTags.SERVER_STATUS,
            SettingsTags.AUTO_UPDATE_GIT,
            SettingsTags.APP_UPDATES,
            SettingsTags.CHECK_NOW,
            SettingsTags.RUNTIME,
            SettingsTags.BATTERY,
            SettingsTags.VIEW_LOGS,
            SettingsTags.SHARE_LOGS,
            SettingsTags.OPEN_LICENSES,
        )) {
            node(tag).assertExists()
        }
    }

    @Test
    fun runtimeIsNodeOnlyAndReadOnlyWithKnownVersions() {
        val versions = listOf(RuntimeVersion("node", "24.22.0"), RuntimeVersion("npm", "11.6.2"))
        show(fakeDependencies(context, versions = { versions }))
        compose.waitUntil(5_000) {
            value(SettingsTags.RUNTIME, SettingsSemantics.RuntimeVersions) == listOf("node=24.22.0", "npm=11.6.2")
        }
        entry(SettingsTags.RUNTIME).assertHasNoClickAction()
    }

    @Test
    fun aMissingRuntimeManifestShowsNoVersions() {
        show(fakeDependencies(context, versions = { error("unreadable") }))
        compose.waitForIdle()
        entry(SettingsTags.RUNTIME).has(SettingsSemantics.RuntimeVersions, emptyList()).assertHasNoClickAction()
    }

    @Test
    fun subScreensSurviveRecreationAndBackLeavesThemFirst() {
        val restoration = StateRestorationTester(compose)
        var ups = 0
        val dependencies = fakeDependencies(context)
        restoration.setContent {
            MaterialTheme { SettingsScreen(dependencies, SettingsCallbacks(), onNavigateUp = { ups++ }) }
        }

        entry(SettingsTags.VIEW_LOGS).performClick()
        node(SettingsTags.LOGS).assertExists()
        restoration.emulateSavedInstanceStateRestore()
        node(SettingsTags.LOGS).assertExists()
        node(SettingsTags.MAIN).assertDoesNotExist()
        back()
        node(SettingsTags.MAIN).assertExists()
        node(SettingsTags.LOGS).assertDoesNotExist()
        assertEquals(0, ups)

        entry(SettingsTags.OPEN_LICENSES).performClick()
        node(SettingsTags.LICENSES).assertExists()
        restoration.emulateSavedInstanceStateRestore()
        node(SettingsTags.LICENSES).assertExists()
        // The top bar's up arrow on a sub-screen returns to Settings, not out of it.
        node(SettingsTags.NAVIGATE_UP).performClick()
        node(SettingsTags.MAIN).assertExists()
        assertEquals(0, ups)

        // On the main screen, back and the up arrow both leave Settings.
        back()
        assertEquals(1, ups)
        node(SettingsTags.NAVIGATE_UP).performClick()
        assertEquals(2, ups)
    }

    @Test
    fun aCancelledPredictiveBackGestureStaysOnTheSubScreen() {
        var ups = 0
        show(fakeDependencies(context), onNavigateUp = { ups++ })
        entry(SettingsTags.VIEW_LOGS).performClick()
        node(SettingsTags.LOGS).assertExists()

        val dispatcher = compose.activity.onBackPressedDispatcher
        compose.runOnUiThread {
            dispatcher.dispatchOnBackStarted(BackEventCompat(0f, 0f, 0f, BackEventCompat.EDGE_LEFT))
            dispatcher.dispatchOnBackProgressed(BackEventCompat(40f, 0f, 0.5f, BackEventCompat.EDGE_LEFT))
            dispatcher.dispatchOnBackCancelled()
        }
        compose.waitForIdle()
        node(SettingsTags.LOGS).assertExists()

        compose.runOnUiThread {
            dispatcher.dispatchOnBackStarted(BackEventCompat(0f, 0f, 0f, BackEventCompat.EDGE_LEFT))
            dispatcher.dispatchOnBackProgressed(BackEventCompat(80f, 0f, 0.8f, BackEventCompat.EDGE_LEFT))
            dispatcher.onBackPressed()
        }
        compose.waitUntil(5_000) { exists(SettingsTags.MAIN) }
        node(SettingsTags.LOGS).assertDoesNotExist()
        assertEquals(0, ups)
    }

    @Test
    fun shareWarnsFirstThenOpensTheShareSheetWithASnapshot() {
        val logs = File(context.filesDir, "p57-share-logs").apply {
            deleteRecursively()
            mkdirs()
        }
        val log = File(logs, "server.log").apply { writeText("line\n") }
        show(fakeDependencies(context, host = FakeServerHost(logs = listOf(log))))

        entry(SettingsTags.SHARE_LOGS).performClick()
        node(SettingsTags.SHARE_DIALOG).assertExists()
        node(SettingsTags.SHARE_WARNING).assertExists()
        node(SettingsTags.SHARE_CANCEL).performClick()
        node(SettingsTags.SHARE_DIALOG).assertDoesNotExist()
        assertNull("nothing is shared without confirmation", shadowOf(compose.activity).nextStartedActivity)

        entry(SettingsTags.SHARE_LOGS).performClick()
        node(SettingsTags.SHARE_CONFIRM).performClick()
        compose.waitUntil(5_000) { !exists(SettingsTags.SHARE_DIALOG) }
        val chooser = shadowOf(compose.activity).nextStartedActivity
        assertNotNull(chooser)
        assertEquals(Intent.ACTION_CHOOSER, chooser.action)
        assertEquals(0, chooser.flags and Intent.FLAG_ACTIVITY_NEW_TASK)
        val snapshots = LogSharing.snapshotDirectory(context).listFiles().orEmpty().filter { LogSharing.isSnapshotName(it.name) }
        assertEquals(1, snapshots.size)
        assertEquals("line\n", snapshots.single().readText())
    }

    @Test
    fun aSecondConfirmBeforeTheNextFrameStartsNoSecondShare() {
        val logs = File(context.filesDir, "p57-share-twice").apply {
            deleteRecursively()
            mkdirs()
        }
        val log = File(logs, "server.log").apply { writeText("line\n") }
        // Every share builds its snapshot through one dispatch to the IO dispatcher.
        val ioJobs = AtomicInteger()
        val io = object : CoroutineDispatcher() {
            override fun dispatch(context: CoroutineContext, block: Runnable) {
                ioJobs.incrementAndGet()
                Dispatchers.IO.dispatch(context, block)
            }
        }
        show(fakeDependencies(context, host = FakeServerHost(logs = listOf(log)), ioDispatcher = io))

        entry(SettingsTags.SHARE_LOGS).performClick()
        compose.waitForIdle()
        val before = ioJobs.get()
        val confirm = node(SettingsTags.SHARE_CONFIRM).fetchSemanticsNode().config[SemanticsActions.OnClick].action!!
        compose.runOnUiThread {
            confirm()
            confirm()
        }
        compose.waitUntil(5_000) { !exists(SettingsTags.SHARE_DIALOG) }
        assertEquals("one snapshot for two clicks", 1, ioJobs.get() - before)
        assertEquals(Intent.ACTION_CHOOSER, shadowOf(compose.activity).nextStartedActivity?.action)
        assertNull("one share sheet only", shadowOf(compose.activity).nextStartedActivity)
    }

    @Test
    fun shareWithoutLogsSaysSoAndSharesNothing() {
        show(fakeDependencies(context, host = FakeServerHost(logs = emptyList())))
        entry(SettingsTags.SHARE_LOGS).performClick()
        node(SettingsTags.SHARE_CONFIRM).performClick()
        compose.waitUntil(5_000) { exists(SettingsTags.SHARE_NO_LOGS) }
        node(SettingsTags.SHARE_DIALOG).assertExists()
        assertNull(shadowOf(compose.activity).nextStartedActivity)
        node(SettingsTags.SHARE_CANCEL).performClick()
        node(SettingsTags.SHARE_DIALOG).assertDoesNotExist()
    }

    @Test
    fun theShareWarningSurvivesRecreation() {
        val restoration = StateRestorationTester(compose)
        val dependencies = fakeDependencies(context)
        restoration.setContent { MaterialTheme { SettingsScreen(dependencies, SettingsCallbacks(), onNavigateUp = {}) } }
        entry(SettingsTags.SHARE_LOGS).performClick()
        node(SettingsTags.SHARE_WARNING).assertExists()
        restoration.emulateSavedInstanceStateRestore()
        node(SettingsTags.SHARE_WARNING).assertExists()
        node(SettingsTags.SHARE_CONFIRM).assertIsEnabled()
    }

    @Test
    fun openingSettingsDeletesEarlierLogSnapshotsOnly() {
        val directory = LogSharing.snapshotDirectory(context).apply { mkdirs() }
        val stale = File(directory, "SillyBunny-logs-20260101T000000Z.txt").apply { writeText("old") }
        val unrelated = File(directory, "keep.txt").apply { writeText("not a snapshot") }
        show(fakeDependencies(context))
        compose.waitUntil(5_000) { !stale.exists() }
        assertTrue(unrelated.exists())
    }
}
