package io.github.sillybunnyteam.sillybunny.settings

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.LocalActivityResultRegistryOwner
import androidx.activity.result.ActivityResult
import androidx.activity.result.ActivityResultRegistry
import androidx.activity.result.ActivityResultRegistryOwner
import androidx.activity.result.contract.ActivityResultContract
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.core.app.ActivityOptionsCompat
import androidx.lifecycle.Lifecycle
import io.github.sillybunnyteam.sillybunny.settings.LocalNetworkStatus.BLOCKED
import io.github.sillybunnyteam.sillybunny.settings.LocalNetworkStatus.DENIED
import io.github.sillybunnyteam.sillybunny.settings.LocalNetworkStatus.GRANTED
import io.github.sillybunnyteam.sillybunny.settings.LocalNetworkStatus.NOT_ASKED
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/** The Local network row and the notice that the server's data lives outside the shared `data` folder. */
// API 37 is not here: the Espresso 3.5.0 that Compose UI tests bring fails on it (InputManager.getInstance).
// LocalNetworkAccessTest covers the API 37 adapter and the device suite covers the API 37 screen.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29, 36])
class SettingsLocalNetworkTest {
    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>()

    private val context: Context get() = compose.activity
    private val registry = FakeResultRegistry()

    private fun dependencies(localNetwork: LocalNetworkAccess? = null, dataRoot: DataRootCheck? = null): SettingsDependencies {
        val base = fakeDependencies(context)
        return SettingsDependencies(
            serverHost = base.serverHost,
            appSettings = base.appSettings,
            updates = base.updates,
            battery = base.battery,
            leftoverFolders = base.leftoverFolders,
            notices = base.notices,
            runtimeVersions = base.runtimeVersions,
            localNetwork = localNetwork,
            dataRoot = dataRoot,
            ioDispatcher = base.ioDispatcher,
        )
    }

    private var shown by mutableStateOf<SettingsDependencies?>(null)

    private fun show(dependencies: SettingsDependencies) {
        shown = dependencies
        val owner = object : ActivityResultRegistryOwner {
            override val activityResultRegistry: ActivityResultRegistry = registry
        }
        compose.setContent {
            CompositionLocalProvider(LocalActivityResultRegistryOwner provides owner) {
                MaterialTheme { shown?.let { SettingsScreen(it, SettingsCallbacks(), onNavigateUp = {}) } }
            }
        }
    }

    private fun node(tag: String): SemanticsNodeInteraction = compose.onNodeWithTag(tag)

    private fun entry(tag: String): SemanticsNodeInteraction = node(tag).performScrollTo()

    private fun exists(tag: String) = compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty()

    private fun shownStatus(): LocalNetworkStatus? = compose.onAllNodesWithTag(SettingsTags.LOCAL_NETWORK)
        .fetchSemanticsNodes().firstOrNull()?.config?.getOrNull(SettingsSemantics.LocalNetwork)

    private fun awaitStatus(expected: LocalNetworkStatus) = compose.waitUntil(5_000) { shownStatus() == expected }

    private fun tap() {
        entry(SettingsTags.LOCAL_NETWORK).performClick()
        compose.waitForIdle()
    }

    private fun answer(result: Any?) {
        compose.runOnUiThread { registry.answer(result) }
        compose.waitForIdle()
    }

    private fun canAskAgain(value: Boolean) =
        shadowOf(context.packageManager).setShouldShowRequestPermissionRationale(LOCAL_NETWORK_PERMISSION, value)

    private fun resumeAgain() {
        compose.activityRule.scenario.moveToState(Lifecycle.State.STARTED)
        compose.activityRule.scenario.moveToState(Lifecycle.State.RESUMED)
    }

    private fun settingsPage(input: Any?) {
        val intent = input as Intent
        assertEquals(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, intent.action)
        assertEquals("package:${context.packageName}", intent.dataString)
    }

    @Test
    fun theRowShowsOnlyWhereThePermissionExists() {
        show(dependencies())
        node(SettingsTags.BATTERY).assertExists()
        node(SettingsTags.LOCAL_NETWORK).assertDoesNotExist()

        shown = dependencies(FakeLocalNetwork(permission = null))
        compose.waitForIdle()
        node(SettingsTags.LOCAL_NETWORK).assertDoesNotExist()

        // These SDK levels are below 37, so the real adapter has no permission to offer.
        shown = dependencies(AndroidLocalNetworkAccess(context))
        compose.waitForIdle()
        node(SettingsTags.LOCAL_NETWORK).assertDoesNotExist()

        shown = dependencies(FakeLocalNetwork())
        compose.waitUntil(5_000) { exists(SettingsTags.LOCAL_NETWORK) }
        awaitStatus(NOT_ASKED)
        assertTrue(registry.inputs.isEmpty())
    }

    @Test
    fun aTapAsksUntilTheSystemStopsThenOpensTheSettingsPage() {
        val access = FakeLocalNetwork()
        show(dependencies(access))
        awaitStatus(NOT_ASKED)
        entry(SettingsTags.LOCAL_NETWORK).assertIsEnabled()
        assertTrue("nothing is requested before a tap", registry.inputs.isEmpty())

        tap()
        assertEquals(listOf<Any?>(LOCAL_NETWORK_PERMISSION), registry.inputs)
        canAskAgain(true)
        answer(false)
        awaitStatus(DENIED)
        entry(SettingsTags.LOCAL_NETWORK).assertIsEnabled()

        tap()
        assertEquals(listOf<Any?>(LOCAL_NETWORK_PERMISSION, LOCAL_NETWORK_PERMISSION), registry.inputs)
        canAskAgain(false)
        answer(false)
        awaitStatus(BLOCKED)
        assertEquals(listOf(false to true, false to false), access.answers)

        // The dialog no longer shows, so the row opens the app's page in system settings.
        tap()
        assertEquals(3, registry.inputs.size)
        settingsPage(registry.inputs.last())

        // Granted there: the row reads the status again when the page returns.
        access.current = GRANTED
        answer(ActivityResult(Activity.RESULT_CANCELED, null))
        awaitStatus(GRANTED)

        // Granted, the row still leads to the page where access can be turned off.
        tap()
        assertEquals(4, registry.inputs.size)
        settingsPage(registry.inputs.last())
        assertEquals(2, access.answers.size)
    }

    @Test
    fun aDismissedDialogIsAskedAgainAndAGrantShows() {
        val access = FakeLocalNetwork()
        show(dependencies(access))
        awaitStatus(NOT_ASKED)

        // Dismissing the dialog also returns a denial without a rationale; only a repeat means it stopped showing.
        tap()
        canAskAgain(false)
        answer(false)
        awaitStatus(DENIED)

        tap()
        assertEquals(listOf<Any?>(LOCAL_NETWORK_PERMISSION, LOCAL_NETWORK_PERMISSION), registry.inputs)
        answer(true)
        awaitStatus(GRANTED)
    }

    @Test
    fun theStatusIsReadAgainOnResume() {
        val access = FakeLocalNetwork(current = BLOCKED)
        show(dependencies(access))
        awaitStatus(BLOCKED)

        access.current = GRANTED
        val reads = access.reads.get()
        resumeAgain()
        compose.waitUntil(5_000) { access.reads.get() > reads }
        awaitStatus(GRANTED)
    }

    @Test
    fun withoutASettingsPageTheBlockedRowIsDisabled() {
        registry.unavailable = { it is Intent }
        show(dependencies(FakeLocalNetwork(current = BLOCKED)))
        awaitStatus(BLOCKED)
        entry(SettingsTags.LOCAL_NETWORK).assertIsEnabled()
        tap()
        assertTrue(registry.inputs.isEmpty())
        entry(SettingsTags.LOCAL_NETWORK).assertIsNotEnabled()
    }

    @Test
    fun theDataNoticeShowsOnlyWhenTheCheckSaysElsewhere() {
        val reads = AtomicInteger()
        val answer = AtomicReference<Boolean?>(false)
        val failure = AtomicReference<RuntimeException?>(null)
        show(
            dependencies(
                dataRoot = DataRootCheck {
                    reads.incrementAndGet()
                    failure.get()?.let { throw it }
                    answer.get()
                },
            ),
        )
        compose.waitUntil(5_000) { reads.get() > 0 }
        compose.waitForIdle()
        node(SettingsTags.DATA_ELSEWHERE).assertDoesNotExist()

        answer.set(true)
        resumeAgain()
        compose.waitUntil(5_000) { exists(SettingsTags.DATA_ELSEWHERE) }
        entry(SettingsTags.DATA_ELSEWHERE).assertExists()

        // An unknown answer hides the notice rather than guessing.
        answer.set(null)
        resumeAgain()
        compose.waitUntil(5_000) { !exists(SettingsTags.DATA_ELSEWHERE) }

        answer.set(true)
        resumeAgain()
        compose.waitUntil(5_000) { exists(SettingsTags.DATA_ELSEWHERE) }
        failure.set(IllegalStateException("unreadable"))
        resumeAgain()
        compose.waitUntil(5_000) { !exists(SettingsTags.DATA_ELSEWHERE) }

        failure.set(null)
        resumeAgain()
        compose.waitUntil(5_000) { exists(SettingsTags.DATA_ELSEWHERE) }
        shown = dependencies()
        compose.waitUntil(5_000) { !exists(SettingsTags.DATA_ELSEWHERE) }
    }

    /** Records launches instead of starting anything; [answer] delivers the oldest pending result. */
    private class FakeResultRegistry : ActivityResultRegistry() {
        val inputs = mutableListOf<Any?>()
        private val pending = mutableListOf<Int>()
        var unavailable: (Any?) -> Boolean = { false }

        override fun <I, O> onLaunch(
            requestCode: Int,
            contract: ActivityResultContract<I, O>,
            input: I,
            options: ActivityOptionsCompat?,
        ) {
            if (unavailable(input)) throw ActivityNotFoundException()
            inputs += input
            pending += requestCode
        }

        fun answer(result: Any?) {
            dispatchResult(pending.removeAt(0), result)
        }
    }
}
