package io.github.sillybunnyteam.sillybunny.settings

import android.os.Looper
import androidx.activity.ComponentActivity
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.SemanticsPropertyKey
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import io.github.sillybunnyteam.sillybunny.BuildConfig
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeFalse
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.concurrent.CopyOnWriteArrayList

// API 37 is not here: the Espresso 3.5.0 that Compose UI tests bring fails on it (InputManager.getInstance).
// The device suite covers API 37 with UiAutomator instead.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29, 36])
class SettingsSubScreensTest {
    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>()

    private fun exists(tag: String) = compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty()

    private fun <T> value(tag: String, key: SemanticsPropertyKey<T>): T? =
        compose.onAllNodesWithTag(tag).fetchSemanticsNodes().firstOrNull()?.config?.getOrNull(key)

    @Test
    fun theLogViewShowsRecentLinesNewestLastAndRefreshesWhileOpen() {
        val host = FakeServerHost(lines = listOf("first", "second"))
        var shares = 0
        compose.setContent {
            MaterialTheme { SettingsLogsScreen(host, onShare = { shares++ }, onNavigateUp = {}) }
        }
        compose.waitUntil(5_000) { value(SettingsTags.LOGS_TEXT, SettingsSemantics.LogLines) == listOf("first", "second") }

        host.lines = listOf("first", "second", "third")
        val reads = host.lineReads.get()
        compose.mainClock.advanceTimeBy(LOG_REFRESH_MILLIS + 100)
        compose.waitUntil(5_000) { host.lineReads.get() > reads }
        compose.waitUntil(5_000) {
            value(SettingsTags.LOGS_TEXT, SettingsSemantics.LogLines) == listOf("first", "second", "third")
        }
        compose.onNodeWithTag(SettingsTags.LOGS_EMPTY).assertDoesNotExist()

        compose.onNodeWithTag(SettingsTags.LOGS_SHARE).performClick()
        assertEquals(1, shares)
    }

    @Test
    fun theLogViewKeepsOnlyTheNewestLines() {
        val lines = List(MAX_LOG_VIEW_LINES + 5) { "line $it" }
        compose.setContent {
            MaterialTheme { SettingsLogsScreen(FakeServerHost(lines = lines), onShare = {}, onNavigateUp = {}) }
        }
        compose.waitUntil(5_000) { value(SettingsTags.LOGS_TEXT, SettingsSemantics.LogLines) != null }
        val shown = value(SettingsTags.LOGS_TEXT, SettingsSemantics.LogLines)!!
        assertEquals(MAX_LOG_VIEW_LINES, shown.size)
        assertEquals("line ${lines.size - 1}", shown.last())
    }

    @Test
    fun anEmptyLogShowsTheEmptyStateAndAFailingHostDoesNotCrash() {
        var host by mutableStateOf(FakeServerHost(lines = emptyList()))
        compose.setContent {
            MaterialTheme { key(host) { SettingsLogsScreen(host, onShare = {}, onNavigateUp = {}) } }
        }
        compose.waitUntil(5_000) { exists(SettingsTags.LOGS_EMPTY) }
        compose.onNodeWithTag(SettingsTags.LOGS_TEXT).assertDoesNotExist()

        host = object : FakeServerHost() {
            override fun recentLogLines(): List<String> = error("host failed")
        }
        compose.mainClock.advanceTimeBy(LOG_REFRESH_MILLIS + 100)
        compose.waitForIdle()
        compose.onNodeWithTag(SettingsTags.LOGS).assertExists()
    }

    @Test
    fun theLogViewNavigatesUp() {
        var ups = 0
        compose.setContent {
            MaterialTheme { SettingsLogsScreen(FakeServerHost(), onShare = {}, onNavigateUp = { ups++ }) }
        }
        compose.onNodeWithTag(SettingsTags.NAVIGATE_UP).performClick()
        assertEquals(1, ups)
    }

    @Test
    fun licensesListEveryComponentAndExpandToTheirNotices() {
        val notices = (ThirdPartyNotices.load(NoticesFixture.source()) as NoticesLoad.Loaded).notices
        compose.setContent {
            MaterialTheme { SettingsLicensesScreen(NoticesFixture.source(), onNavigateUp = {}) }
        }
        compose.waitUntil(5_000) { exists(SettingsTags.LICENSES_LIST) }
        val list = compose.onNodeWithTag(SettingsTags.LICENSES_LIST)
        for (id in NoticesFixture.componentIds) {
            list.performScrollToNode(hasTestTag(SettingsTags.LICENSE_COMPONENT_PREFIX + id))
            compose.onNodeWithTag(SettingsTags.LICENSE_COMPONENT_PREFIX + id).assertExists()
        }

        // Expanding a component shows its own notice text, decoded with each license's encoding.
        val latin1 = notices.components.single { it.id == "termux/libfixture" }
        val row = SettingsTags.LICENSE_COMPONENT_PREFIX + latin1.id
        val tag = SettingsTags.LICENSE_NOTICE_PREFIX + latin1.id
        compose.onNodeWithTag(tag).assertDoesNotExist()
        list.performScrollToNode(hasTestTag(row))
        compose.onNodeWithTag(row).performClick()
        // The text is decoded off the main thread, so its block appears once that finishes.
        compose.waitUntil(5_000) { runCatching { list.performScrollToNode(hasTestTag(tag)) }.isSuccess }
        compose.onNodeWithTag(tag).assertTextEquals(ThirdPartyNotices.chunks(notices.noticeText(latin1)).first())
        list.performScrollToNode(hasTestTag(row))
        compose.onNodeWithTag(row).performClick()
        compose.onNodeWithTag(tag).assertDoesNotExist()

        // The full THIRD_PARTY_NOTICES text is one more expandable entry, decoded off the main thread.
        list.performScrollToNode(hasTestTag(SettingsTags.LICENSES_FULL_TEXT_TOGGLE))
        compose.onNodeWithTag(SettingsTags.LICENSES_FULL_TEXT_TOGGLE).performClick()
        compose.waitUntil(5_000) { exists(SettingsTags.LICENSES_FULL_TEXT) }
        compose.onNodeWithTag(SettingsTags.LICENSES_FULL_TEXT)
            .assertTextEquals(ThirdPartyNotices.chunks(notices.fullText()).first())
    }

    @Test
    fun noticesAreReadOffTheMainThread() {
        val readers = CopyOnWriteArrayList<Boolean>()
        val fixture = NoticesFixture.source()
        val source = NoticesSource { name ->
            readers += Looper.getMainLooper().isCurrentThread
            fixture.open(name)
        }
        compose.setContent { MaterialTheme { SettingsLicensesScreen(source, onNavigateUp = {}) } }
        compose.waitUntil(5_000) { exists(SettingsTags.LICENSES_LIST) }
        assertEquals(listOf(false, false), readers.toList())
    }

    @Test
    fun missingMalformedAndUnknownNoticesShowTheEmptyState() {
        val unknownSchema = JSONObject(NoticesFixture.indexJson).put("schema", 2).toString().toByteArray()
        val cases = listOf(
            NoticesSource { null } to "MISSING",
            NoticesFixture.source(text = null) to "MISSING",
            NoticesFixture.source(index = "{".toByteArray()) to "MALFORMED",
            NoticesFixture.source(index = unknownSchema) to "UNKNOWN_SCHEMA",
        )
        var source by mutableStateOf(cases.first().first)
        compose.setContent {
            MaterialTheme { key(source) { SettingsLicensesScreen(source, onNavigateUp = {}) } }
        }
        for ((next, reason) in cases) {
            source = next
            compose.waitUntil(5_000) { value(SettingsTags.LICENSES_EMPTY, SettingsSemantics.NoticesUnavailable) == reason }
            compose.onNodeWithTag(SettingsTags.LICENSES_LIST).assertDoesNotExist()
        }
    }

    @Test
    fun aDebugBuildWithoutNoticesAssetsShowsTheEmptyState() {
        // Notices are packaged only with the runtime.
        assumeFalse("This build packages the runtime and its notices", BuildConfig.HAS_RUNTIME)
        val source = AssetNoticesSource(compose.activity.assets)
        compose.setContent { MaterialTheme { SettingsLicensesScreen(source, onNavigateUp = {}) } }
        compose.waitUntil(5_000) { exists(SettingsTags.LICENSES_EMPTY) }
        assertTrue(value(SettingsTags.LICENSES_EMPTY, SettingsSemantics.NoticesUnavailable) == "MISSING")
    }
}
