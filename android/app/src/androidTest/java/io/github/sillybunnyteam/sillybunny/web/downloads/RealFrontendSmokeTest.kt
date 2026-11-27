package io.github.sillybunnyteam.sillybunny.web.downloads

import android.webkit.WebView
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Until
import io.github.sillybunnyteam.sillybunny.R
import io.github.sillybunnyteam.sillybunny.web.WebScreenTags
import io.github.sillybunnyteam.sillybunny.web.WebViewVersion
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Smoke test against the real SillyBunny server and frontend, which the test run starts on the host with a
 * random port and `SILLYBUNNY_LAUNCH_TOKEN`, and forwards with `adb reverse`. Run with `-e smoke 1
 * -e fixturePort <port> -e fixtureOther <port> -e fixtureToken <token>`; skipped otherwise. Inside the app's
 * real shell on the per-install web origin, with the real chooser and downloads and the system's DocumentsUI:
 * a character export, a chat export, a backup download and a file-input character import of the exported card.
 * The three exports are Blob page exports, which the downloads bridge captures. Below the supported WebView
 * version (API 29's WebView 74) the frontend does not start; see [olderWebView].
 * Each step is driven through the frontend's own handlers; only the import starts from a real tap on a button
 * this test adds, because a file chooser needs a user gesture. Last, the OpenRouter Authorize button: the real
 * provider page loads in the app (it needs the emulator's network), and its return to the app's callback reaches
 * the frontend.
 */
@RunWith(AndroidJUnit4::class)
class RealFrontendSmokeTest {
    private val args = InstrumentationRegistry.getArguments()
    private var host: TransferHost? = null

    @Before
    fun onlyAgainstTheRealServer() {
        assumeTrue("run with -e smoke 1 against the real server", args.getString("smoke") == "1")
    }

    @After
    fun tearDown() {
        try {
            host?.outputs?.toSet()?.forEach { Documents.remove(it) }
        } finally {
            host?.close()
        }
    }

    /**
     * The frontend finished starting: its context API answers and the characters are loaded. On a fresh data root
     * the start waits for the onboarding popup (the user's name); it is accepted with the suggested name, as a user
     * would. Plain ES5, so that it also parses on an old WebView.
     */
    private fun frontendReady(view: WebView): Boolean = runCatching {
        val state = HostWeb.text(
            view,
            "(function () { var popup = document.querySelector('dialog.popup[open] .onboarding');" +
                " var ok = popup && popup.closest('dialog.popup') && popup.closest('dialog.popup').querySelector('.popup-button-ok');" +
                " if (ok) { ok.click(); return 'onboarding'; } var st = window.SillyTavern;" +
                " return String(document.readyState === 'complete' && !!st && typeof st.getContext === 'function'" +
                " && st.getContext().characters.length > 0); })()",
        )
        if (state == "onboarding") HostWeb.note("smoke: accepted the onboarding popup")
        state == "true"
    }.getOrDefault(false)

    @Test
    fun realFrontendExportsBackupAndImport() {
        val major = HostWeb.webViewMajor()
        if (major > 0 && WebViewVersion.isBelowMinimum(major)) return olderWebView(major)
        val launched = TransferHost(TransferFixture(), realPicker = true).also { host = it }
        launched.launch(firstPageMillis = FRONTEND_MILLIS, ready = ::frontendReady)
        val view = launched.webView()
        val webView = InstrumentationRegistry.getInstrumentation().targetContext.packageManager
            .getPackageInfo(checkNotNull(WebView.getCurrentWebViewPackage()).packageName, 0).versionName
        val bridged = launched.bridged()
        HostWeb.note("smoke: webview=$webView bridged=$bridged secure=${HostWeb.text(view, "String(window.isSecureContext)")}")
        // The page exports are Blobs: only the bridge captures them (every supported WebView has its features).
        check(bridged) { "no downloads bridge on WebView $webView" }
        val outcomes = linkedMapOf<String, String>()
        fun step(name: String, block: () -> String) {
            val outcome = runCatching(block).getOrElse { "failed: ${it.message}" }
            outcomes[name] = outcome
            HostWeb.note("smoke $name: $outcome")
            // Whatever the step left open, the app must be in front for the next one.
            runCatching { RealPicker.gone(5_000) }.onFailure { HostWeb.device.pressBack() }
        }
        fun saveInPicker(name: String, count: Int): String {
            RealPicker.save()
            launched.waitNotice(R.string.web_transfer_saved, count, PICKER_MILLIS)
            val saved = launched.outputs.last()
            return "saved ${Documents.name(saved)} (${Media.read(saved)?.size} bytes) as $name"
        }

        // A character with a chat: the default Seraphina.
        HostWeb.eval(
            view,
            "window.__smoke = {}; (async () => { const c = SillyTavern.getContext();" +
                " const i = c.characters.findIndex((x) => x.avatar === 'default_Seraphina.png');" +
                " __smoke.selected = String(await c.selectCharacterById(i)); })()" +
                ".catch((e) => { __smoke.selected = 'err:' + e; }); 1",
        )
        HostWeb.waitFor("the character selected", 30_000) { HostWeb.text(view, "String(window.__smoke.selected)") != "undefined" }
        HostWeb.note("smoke select: ${HostWeb.text(view, "String(window.__smoke.selected)")}")

        step("character export") {
            HostWeb.eval(view, "\$('.export_format[data-format=\"png\"]').first().trigger('click'); 1")
            saveInPicker("a character card", 1)
        }
        step("chat export") {
            HostWeb.eval(view, "\$('#option_select_chat').trigger('click'); 1")
            HostWeb.waitFor("the chat list", 20_000) { HostWeb.text(view, "String(\$('#select_chat_div .exportRawChatButton').length)") != "0" }
            HostWeb.eval(view, "\$('#select_chat_div .exportRawChatButton').first().trigger('click'); 1")
            saveInPicker("a chat", 2)
        }
        step("backup download") {
            HostWeb.eval(view, "\$('#select_chat_cross').trigger('click'); \$('#account_button').trigger('click'); 1")
            HostWeb.waitFor("the account panel", 20_000) { HostWeb.text(view, "String(\$('.userBackupButton').length)") != "0" }
            HostWeb.eval(view, "\$('.userBackupButton').first().trigger('click'); 1")
            saveInPicker("a backup", 3)
        }
        step("file-input import") {
            val card = launched.outputs.firstOrNull() ?: error("no exported card to import")
            val name = checkNotNull(Documents.name(card)) { "no name for the exported card" }
            val before = checkNotNull(HostWeb.text(view, "String(SillyTavern.getContext().characters.length)")).toInt()
            HostWeb.eval(
                view,
                "document.querySelectorAll('.popup-button-close, .popup-button-cancel').forEach((b) => b.click());" +
                    " const b = document.createElement('button'); b.id = 'p56int-import'; b.textContent = 'import';" +
                    " b.style.cssText = 'position:fixed;left:10%;top:40%;width:80%;height:120px;z-index:2147483647';" +
                    " b.onclick = () => \$('#character_import_button').trigger('click'); document.body.appendChild(b); 1",
            )
            HostWeb.tap(view, "p56int-import")
            val listed = checkNotNull(HostWeb.device.wait(Until.findObject(By.text(name)), PICKER_MILLIS)) {
                "$name not listed: ${RealPicker.screen()}"
            }
            listed.click()
            RealPicker.gone()
            HostWeb.waitFor("the imported character", PICKER_MILLIS) {
                (HostWeb.text(view, "String(SillyTavern.getContext().characters.length)")?.toIntOrNull() ?: 0) > before
            }
            "imported $name: characters $before -> ${HostWeb.text(view, "String(SillyTavern.getContext().characters.length)")}"
        }
        // Last, because it leaves the app's page: the frontend's own Authorize button. The real sign-in needs an
        // account, so the provider's redirect back to the app's callback is started from its page by script.
        step("openrouter return") {
            val url = { onMain { view.url }.orEmpty() }
            HostWeb.eval(view, "\$('.openrouter_authorize').first().trigger('click'); 1")
            HostWeb.waitFor("the provider's page in the app", PICKER_MILLIS) { url().startsWith(OPENROUTER) }
            HostWeb.waitFor("the provider's page loaded", PICKER_MILLIS) {
                HostWeb.text(view, "location.origin + ' ' + document.readyState") == "$OPENROUTER complete"
            }
            val page = HostWeb.text(view, "location.pathname").orEmpty()
            val bridge = HostWeb.text(view, "typeof sillybunnyTransfers + '/' + typeof globalThis[Symbol.for('sillybunny.transfers')]")
            check(bridge == "undefined/undefined") { "the provider's page has the bridge or the page script: $bridge" }
            val callback = "${launched.fixture.webOrigin}/callback/openrouter?code=p56int-smoke"
            HostWeb.eval(view, "location.href = ${JSONObject.quote(callback)}; 1")
            HostWeb.waitFor("the app again", FRONTEND_MILLIS) { url().startsWith(launched.fixture.webOrigin) && frontendReady(view) }
            // The frontend's checkOpenRouterAuth saw source=openrouter and cleared the query; it logs its own outcome.
            HostWeb.waitFor("the frontend read the return", PICKER_MILLIS) { HostWeb.text(view, "location.search") == "" }
            "the provider's $page loaded in the app without the bridge ($bridge); its return reached the app's frontend"
        }
        HostWeb.note("smoke outcomes: ${JSONObject(outcomes as Map<*, *>)}")
        assertEquals(outcomes.toString(), emptyList<String>(), outcomes.filterValues { it.startsWith("failed") }.keys.toList())
    }

    /**
     * Below [WebViewVersion.MINIMUM_MAJOR] (API 29's WebView 74) the frontend's modules do not parse, so none of its
     * steps can run. Checked instead: the real server's page loads on the web origin with the launch cookie, the
     * frontend does not start, and the shell shows its version warning. The test then ends as skipped.
     */
    private fun olderWebView(major: Int) {
        val launched = TransferHost(TransferFixture(), realPicker = true).also { host = it }
        launched.launch(firstPageMillis = FRONTEND_MILLIS, keepVersionWarning = true) { view ->
            // An element of the real index.html: the gate's 403 page has none.
            HostWeb.text(view, "String(document.readyState === 'complete' && !!document.getElementById('character_import_file'))") == "true"
        }
        val view = launched.webView()
        check(HostWeb.text(view, "location.origin") == launched.fixture.webOrigin) { "the page is not on the web origin" }
        val frontend = HostWeb.text(view, "typeof window.SillyTavern")
        check(frontend == "undefined") { "the frontend started on WebView $major" }
        check(HostWeb.shown(WebScreenTags.VERSION_WARNING)) { "no version warning on WebView $major" }
        HostWeb.note(
            "smoke: WebView $major is below ${WebViewVersion.MINIMUM_MAJOR}: the server's page loaded on the web origin " +
                "with the launch cookie, the frontend did not start (SillyTavern $frontend), the version warning is shown",
        )
        assumeTrue("the frontend needs WebView ${WebViewVersion.MINIMUM_MAJOR} or later, this one is $major", false)
    }

    private companion object {
        /** The real frontend loads hundreds of modules on a cold emulator. */
        const val FRONTEND_MILLIS = 240_000L
        const val PICKER_MILLIS = 60_000L
        const val OPENROUTER = "https://openrouter.ai"
    }
}
