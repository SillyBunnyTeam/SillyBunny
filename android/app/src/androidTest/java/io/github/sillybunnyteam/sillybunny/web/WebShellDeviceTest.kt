package io.github.sillybunnyteam.sillybunny.web

import android.content.ClipboardManager
import android.content.Intent
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.annotation.RequiresApi
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import io.github.sillybunnyteam.sillybunny.server.LaunchSession
import io.github.sillybunnyteam.sillybunny.web.downloads.DISMISS_TAG
import java.net.InetAddress
import java.util.regex.Pattern
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The WebView shell on a device, against the host fixture server (`fixtures/fixture-server.mjs`): the
 * repository's launch-token middleware in front of `fixtures/pages`, a second loopback listener that must
 * never receive anything the shell can see, and a stand-in for the OpenRouter sign-in. The shell loads the
 * pages from the app's per-install web origin `http://<label>.localhost:<port>`; the label never appears in
 * test output (see [FixtureServer.redacted]). Run with `-e fixturePort <p> -e fixtureOther <q>
 * -e fixtureProvider <r> -e fixtureToken <hex>` after `adb reverse tcp:<p> tcp:<p>` and the same for `<q>`
 * and `<r>`. Optional: `-e fixtureExternalRedirector <url prefix>`, an https redirector whose URL takes the
 * encoded target last (for example `https://httpbin.org/redirect-to?status_code=302&url=`), adds an external
 * hop to the measured redirect cases (never for the label); `-e fixtureBrowser <package>` runs
 * [openInBrowserWithTheDevicesBrowser] with that browser, which is skipped without it.
 */
@RunWith(AndroidJUnit4::class)
class WebShellDeviceTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val device = UiDevice.getInstance(instrumentation)
    private val fixture = FixtureServer()
    private val intents = ViewIntents()
    private var host: WebScreenHost? = null
    private var immersiveConfirmations: String? = null

    @Before
    fun setUp() {
        // About a second after a page enters fullscreen, the system shows its one-time immersive-mode
        // confirmation, which takes focus and swallows Back until the user dismisses it. Fresh devices, CI
        // images included, have not confirmed it, so each test runs with it confirmed; tearDown restores the
        // device's own value.
        immersiveConfirmations = Web.shell("settings get secure $IMMERSIVE_CONFIRMATIONS").trim()
        Web.shell("settings put secure $IMMERSIVE_CONFIRMATIONS confirmed")
        instrumentation.addMonitor(intents)
        fixture.reset()
    }

    @After
    fun tearDown() {
        try {
            host?.close()
        } finally {
            instrumentation.removeMonitor(intents)
            runCatching { device.unfreezeRotation() }
            runCatching { restoreImmersiveConfirmations() }
        }
    }

    private fun restoreImmersiveConfirmations() {
        val saved = immersiveConfirmations ?: return
        if (saved.isEmpty() || saved == "null") {
            Web.shell("settings delete secure $IMMERSIVE_CONFIRMATIONS")
        } else {
            Web.shell("settings put secure $IMMERSIVE_CONFIRMATIONS $saved")
        }
    }

    /**
     * Shows the shell for the fixture session and waits until the home page is loaded. [defaults] and
     * [openRouter] as in [WebScreenHost].
     */
    private fun launch(dismissVersionWarning: Boolean = true, defaults: Boolean = false, openRouter: String? = null): WebScreenHost {
        val launched = WebScreenHost(fixture.session, defaults, openRouter).launch()
        host = launched
        Web.waitFor("home page", 30_000) { launched.webViewOrNull()?.let(Web::title) == "fixture-home" }
        if (dismissVersionWarning) {
            val shell = launched.shell()
            Web.onMain { shell.dismissVersionWarning() }
        }
        return launched
    }

    /** Waits until the page's `results[key]` has settled, and returns it. */
    private fun settled(view: WebView, key: String, timeoutMillis: Long = 15_000): String {
        var value: String? = null
        Web.waitFor("results.$key", timeoutMillis) {
            value = Web.result(view, key)
            value != null && value != "pending" && value != "waiting"
        }
        return checkNotNull(value)
    }

    /**
     * What the pages asked the fixture for: its log without favicon requests, which WebView sends by itself some time
     * after a load. A reload shows up here as a new request for the document.
     */
    private fun pageRequests(): List<FixtureServer.Request> = fixture.requests().filter { it.url != "/favicon.ico" }

    /** True once every `results[key]` of [keys] has settled (set, and no longer `pending`). */
    private fun allSettled(view: WebView, keys: List<String>): Boolean {
        val list = keys.joinToString(",") { JSONObject.quote(it) }
        return Web.text(view, "String([$list].every((k) => window.results && results[k] !== undefined && results[k] !== 'pending'))") == "true"
    }

    private fun awaitDialog(shell: WebShell, type: Class<out WebShell.JsDialog>) {
        Web.waitFor("dialog ${type.simpleName}") { Web.onMain { type.isInstance(shell.dialog) } }
    }

    @Test
    fun theLaunchCookieIsSetBeforeTheFirstLoad() {
        Web.clearCookies()
        // Without the cookie the gate refuses the origin, for a plain client and for a bare WebView.
        assertEquals(403, Web.get("${fixture.origin}/").status)
        val bare = Web.onMain { WebView(instrumentation.targetContext) }
        try {
            Web.onMain { bare.loadUrl("${fixture.origin}/?bare") }
            Web.waitFor("bare WebView refused") { fixture.requests().any { it.url == "/?bare" && it.status == 403 && !it.anyCookie } }
            Web.onMain { bare.loadUrl("${fixture.webOrigin}/?bare-label") }
            Web.waitFor("bare WebView refused on the web origin") {
                fixture.requests().any { it.url == "/?bare-label" && it.host == "label" && it.status == 403 && !it.anyCookie }
            }
        } finally {
            Web.onMain { bare.destroy() }
        }
        fixture.reset()

        val launched = launch()
        // The bare WebView's requests are marked, in case one of them is logged late.
        val requests = fixture.requests().filter { !it.url.startsWith("/?bare") }
        assertTrue(requests.toString(), requests.isNotEmpty())
        val first = requests.first()
        assertEquals(
            requests.toString(),
            "app GET / 200 true label",
            "${first.listener} ${first.method} ${first.url} ${first.status} ${first.launchCookie} ${first.host}",
        )
        // Every later request passed the gate too (the fixture has no favicon, so that one is a 404 behind it), on the
        // web origin, over plain HTTP: no TLS handshake (an HTTPS upgrade) reached the port.
        assertTrue(requests.toString(), requests.all { it.listener == "app" && it.launchCookie && it.status != 403 && it.host == "label" })
        assertTrue(requests.toString(), requests.none { it.method == "TLS" })
        // WebDownloads was attached once, before that load.
        assertEquals(launched.downloads.events.toString(), 1, launched.downloads.events.count { it.startsWith("attach ") })

        val view = launched.webView()
        val settings = Web.onMain { view.settings }
        Web.onMain {
            assertTrue(settings.javaScriptEnabled)
            assertTrue(settings.domStorageEnabled)
            assertFalse(settings.allowFileAccess)
            assertFalse(settings.allowContentAccess)
        }
        // The page runs on the web origin, which Chromium counts as a secure context.
        val origin = Web.text(view, "location.origin")
        assertTrue(fixture.redacted(origin), origin == fixture.webOrigin)
        assertEquals("true", Web.text(view, "String(window.isSecureContext)"))
        // Origin-keyed storage works and survives a reload of the same origin.
        Web.eval(view, "probeStorage('kept-1'); 1")
        assertEquals("kept-1", settled(view, "ls"))
        assertEquals("kept-1", settled(view, "idb"))
        assertEquals("held", settled(view, "locks"))
        assertEquals("true", settled(view, "quota"))
    }

    /**
     * The web origin needs no network: Chromium resolves `*.localhost` names itself, so the app loads with the device
     * off every network, where no DNS server could answer; over plain HTTP, with no HTTPS upgrade attempt reaching the
     * server; and the page is a secure context.
     */
    @Test
    fun theWebOriginLoadsWithoutANetwork() {
        val network = DeviceNetwork()
        network.off()
        try {
            // A public name no longer resolves (measured): nothing could have answered a DNS query for the label either.
            val dns = runCatching { InetAddress.getByName("example.com") }.isSuccess
            val launched = launch()
            val view = launched.webView()
            val origin = Web.text(view, "location.origin")
            assertTrue(fixture.redacted(origin), origin == fixture.webOrigin)
            assertEquals("true", Web.text(view, "String(window.isSecureContext)"))
            val requests = fixture.requests()
            Web.note(
                "offline api=${Build.VERSION.SDK_INT} webview=${WebViewVersion.currentPackage(instrumentation.targetContext)?.versionName} " +
                    "publicNameResolved=$dns requests=$requests",
            )
            assertTrue(requests.toString(), requests.isNotEmpty())
            assertTrue(requests.toString(), requests.all { it.listener == "app" && it.host == "label" && it.launchCookie && it.method != "TLS" })
        } finally {
            network.restore()
        }
    }

    @Test
    fun linksStayInAppOnlyForTheExactOrigin() {
        val launched = launch()
        val view = launched.webView()
        Web.navigate(view, "/links.html", "fixture-links")
        fixture.reset()

        Web.tap(view, "same")
        Web.waitFor("page2") { Web.title(view) == "fixture-page2" }
        Web.onMain { view.goBack() }
        Web.waitFor("links again") { Web.title(view) == "fixture-links" }

        Web.tap(view, "external")
        Web.waitFor("external page handed off") { "https://example.com/ext" in intents.data() }
        assertTrue(intents.intents.last().hasCategory(Intent.CATEGORY_BROWSABLE))
        Web.tap(view, "mailto")
        Web.waitFor("mailto handed off") { "mailto:someone@example.com" in intents.data() }

        val handedOff = intents.intents.size
        // Web.tap confirms that each link saw the click. That is the delivery check for data:, which Chromium refuses
        // before any WebView callback; the other three are also offered to WebDownloads (asserted below).
        for (id in listOf("other-port", "other-port-label", "intent", "blob", "data")) {
            Web.tap(view, id)
            Web.settle(800)
        }
        Web.settle()
        assertEquals(fixture.redacted(intents.data()), handedOff, intents.intents.size)
        assertEquals("fixture-links", Web.title(view))
        assertTrue(fixture.escaped().toString(), fixture.escaped().isEmpty())

        // Main-frame navigations are offered to WebDownloads before routing.
        val offers = launched.downloads.events.filter { it.startsWith("offer ") }
        Web.note("link offers api=${Build.VERSION.SDK_INT}: $offers")
        val shown = fixture.redacted(offers)
        assertTrue(shown, "offer https://example.com/ext main=true gesture=true" in offers)
        assertTrue(shown, offers.any { it.startsWith("offer http://127.0.0.1:${fixture.otherPort}/link main=true") })
        assertTrue(shown, offers.any { it.startsWith("offer http://${fixture.address.host}:${fixture.otherPort}/link-label main=true") })
        assertTrue(shown, offers.any { it.startsWith("offer intent://scan/") })
        assertTrue(shown, offers.any { it.startsWith("offer blob:${fixture.webOrigin}/") })

        // A navigation that WebDownloads takes goes no further.
        launched.downloads.takes = { it.host == "example.com" }
        Web.tap(view, "external")
        Web.settle()
        assertEquals(handedOff, intents.intents.size)
    }

    @Test
    fun popupsAreRoutedLikeMainFrameNavigations() {
        val launched = launch()
        val view = launched.webView()
        Web.navigate(view, "/popups.html", "fixture-popups")
        fixture.reset()

        Web.tap(view, "open-external")
        Web.waitFor("window.open handed off") { "https://example.com/popup" in intents.data() }
        Web.tap(view, "blank-external")
        Web.waitFor("target=_blank handed off") { "https://example.com/blank" in intents.data() }
        Web.tap(view, "open-noopener")
        Web.waitFor("noopener handed off") { "https://example.com/noopener" in intents.data() }
        // Opened a second after the tap, as the frontend does after awaited work.
        Web.tap(view, "open-later")
        Web.waitFor("delayed window.open handed off") { "https://example.com/later" in intents.data() }
        // Without a gesture the popup blocker refuses it.
        Web.eval(view, "openAuto(); 1")
        Web.settle()
        assertFalse(intents.data().toString(), "https://example.com/auto" in intents.data())

        val handedOff = intents.intents.size
        Web.tap(view, "open-blob")
        Web.waitFor("blob popup offered") {
            launched.downloads.events.any { it.startsWith("offer blob:${fixture.webOrigin}/") && it.contains("main=true") }
        }
        // A new window for another loopback port is offered like a main-frame navigation, then blocked.
        Web.tap(view, "open-other")
        Web.waitFor("other-port popup offered") {
            launched.downloads.events.any { it.startsWith("offer http://127.0.0.1:${fixture.otherPort}/popup main=true") }
        }
        Web.tap(view, "open-other-label")
        Web.waitFor("other-port popup on the app host offered") {
            launched.downloads.events.any { it.startsWith("offer http://${fixture.address.host}:${fixture.otherPort}/popup-label main=true") }
        }
        // Chromium refuses a new window for a data: URL before any WebView callback; measured, not asserted. Web.tap
        // confirms that the button saw the click.
        Web.tap(view, "open-data")
        Web.settle()
        Web.note("data popup api=${Build.VERSION.SDK_INT} offered=${launched.downloads.events.any { it.startsWith("offer data:") }}")
        assertEquals(fixture.redacted(intents.data()), handedOff, intents.intents.size)
        assertTrue(fixture.escaped().toString(), fixture.escaped().isEmpty())
        assertEquals("fixture-popups", Web.title(view))

        // A new window for the app origin opens in place, in the one app WebView.
        Web.tap(view, "open-same")
        Web.waitFor("app popup opened in place") { Web.title(view) == "fixture-page2" }
        assertSame(view, launched.webView())
        Web.note("popup offers api=${Build.VERSION.SDK_INT}: ${launched.downloads.events.filter { it.startsWith("offer") }}")
    }

    @Test
    fun javaScriptDialogsReturnTheUsersAnswer() {
        val launched = launch()
        val view = launched.webView()
        val shell = launched.shell()
        Web.navigate(view, "/dialogs.html", "fixture-dialogs")

        Web.eval(view, "doAlert(); 1")
        awaitDialog(shell, WebShell.JsDialog.Alert::class.java)
        ScreenUi.click(WebScreenTags.DIALOG_ACCEPT)
        assertEquals("done", settled(view, "alert"))

        Web.eval(view, "doConfirm('c1'); 1")
        awaitDialog(shell, WebShell.JsDialog.Confirm::class.java)
        ScreenUi.click(WebScreenTags.DIALOG_ACCEPT)
        assertEquals("true", settled(view, "c1"))

        Web.eval(view, "doConfirm('c2'); 1")
        awaitDialog(shell, WebShell.JsDialog.Confirm::class.java)
        ScreenUi.click(WebScreenTags.DIALOG_DISMISS)
        assertEquals("false", settled(view, "c2"))

        Web.eval(view, "doConfirm('c3'); 1")
        awaitDialog(shell, WebShell.JsDialog.Confirm::class.java)
        // The dialog's window comes a frame or more after the shell's dialog state. A Back sent before that window has
        // focus reaches the activity instead (seen once: the activity finished), so wait for the window first.
        Web.waitFor("the dialog's window has focus") { ScreenUi.focusedWindowHas(WebScreenTags.DIALOG) }
        device.pressBack()
        assertEquals("false", settled(view, "c3"))

        Web.eval(view, "doPrompt('p1'); 1")
        awaitDialog(shell, WebShell.JsDialog.Prompt::class.java)
        assertEquals("fixture-default", Web.onMain { (shell.dialog as WebShell.JsDialog.Prompt).text })
        ScreenUi.find(WebScreenTags.DIALOG_TEXT).text = "fixture-typed"
        ScreenUi.click(WebScreenTags.DIALOG_ACCEPT)
        assertEquals("fixture-typed", settled(view, "p1"))

        Web.eval(view, "doPrompt('p2'); 1")
        awaitDialog(shell, WebShell.JsDialog.Prompt::class.java)
        ScreenUi.click(WebScreenTags.DIALOG_DISMISS)
        assertEquals("null", settled(view, "p2"))

        // An open dialog survives activity recreation and still answers the page.
        Web.eval(view, "doConfirm('c4'); 1")
        awaitDialog(shell, WebShell.JsDialog.Confirm::class.java)
        launched.scenario.recreate()
        assertTrue(ScreenUi.shown(WebScreenTags.DIALOG))
        assertSame(view, launched.webView())
        ScreenUi.click(WebScreenTags.DIALOG_ACCEPT)
        assertEquals("true", settled(view, "c4"))

        // beforeunload: Stay keeps the page, Leave navigates. Chromium asks only after a user gesture.
        Web.tap(view, "touch")
        Web.eval(view, "guard(); 1")
        Web.eval(view, "setTimeout(function () { location.href = '/page2.html'; }, 0); 1")
        awaitDialog(shell, WebShell.JsDialog.BeforeUnload::class.java)
        ScreenUi.click(WebScreenTags.DIALOG_DISMISS)
        Web.settle()
        assertEquals("fixture-dialogs", Web.title(view))
        Web.eval(view, "setTimeout(function () { location.href = '/page2.html'; }, 0); 1")
        awaitDialog(shell, WebShell.JsDialog.BeforeUnload::class.java)
        ScreenUi.click(WebScreenTags.DIALOG_ACCEPT)
        Web.waitFor("left the page") { Web.title(view) == "fixture-page2" }
    }

    @Test
    fun fullscreenEntersAndBackLeavesItFirst() {
        val launched = launch()
        val view = launched.webView()
        val shell = launched.shell()
        // A tap, not a script navigation: Chromium skips history entries left without a user gesture.
        Web.tap(view, "to-fullscreen")
        Web.waitFor("fullscreen page") { Web.title(view) == "fixture-fullscreen" }
        Web.waitFor("history") { Web.onMain { shell.canGoBack } }

        Web.tap(view, "go")
        Web.waitFor("custom view shown") { Web.onMain { shell.fullscreen != null } }
        assertEquals("ok", settled(view, "fs"))
        val custom = Web.onMain { checkNotNull(shell.fullscreen).view }
        Web.waitFor("custom view on screen") { Web.onMain { custom.isAttachedToWindow && custom.isShown && custom.width > 0 } }
        val decor = launched.activity().window.decorView
        if (Build.VERSION.SDK_INT >= 30) {
            Web.waitFor("system bars hidden") {
                Web.onMain { ViewCompat.getRootWindowInsets(decor)?.isVisible(WindowInsetsCompat.Type.statusBars()) } == false
            }
        }
        // Wait past the moment the system's immersive-mode confirmation would appear (setUp marks it confirmed):
        // the app window must still have focus, so that Back reaches it and not that confirmation.
        Web.settle(CONFIRMATION_DELAY_MILLIS)
        val focus = Web.focusedWindow()
        assertTrue(focus, focus.contains(instrumentation.targetContext.packageName))

        // Back leaves fullscreen and nothing else: the page and its history stay.
        device.pressBack()
        Web.waitFor("custom view hidden") { Web.onMain { shell.fullscreen == null } }
        Web.waitFor("page left fullscreen") { Web.text(view, "String(document.fullscreenElement === null)") == "true" }
        assertEquals("fixture-fullscreen", Web.title(view))
        assertTrue(Web.onMain { shell.canGoBack })
        Web.waitFor("custom view removed") { Web.onMain { !custom.isAttachedToWindow } }
        if (Build.VERSION.SDK_INT >= 30) {
            Web.waitFor("system bars back") {
                Web.onMain { ViewCompat.getRootWindowInsets(decor)?.isVisible(WindowInsetsCompat.Type.statusBars()) } == true
            }
        }

        // The page can leave fullscreen by itself too. The shell's custom view comes before the page's fullscreen
        // element, and exitFullscreen() rejects ("Document not active") until that element is set, so wait for the
        // second requestFullscreen() to settle and for the element first.
        Web.eval(view, "delete results.fs; delete results.exit; 1")
        Web.tap(view, "go")
        Web.waitFor("custom view shown again") { Web.onMain { shell.fullscreen != null } }
        assertEquals("ok", settled(view, "fs"))
        Web.waitFor("page in fullscreen again") { Web.text(view, "String(document.fullscreenElement !== null)") == "true" }
        val again = Web.onMain { checkNotNull(shell.fullscreen).view }
        Web.eval(view, "document.exitFullscreen().then(() => { results.exit = 'ok'; }, (e) => { results.exit = 'err:' + e.name; }); 1")
        assertEquals("ok", settled(view, "exit"))
        Web.waitFor("custom view hidden by the page") { Web.onMain { shell.fullscreen == null } }
        Web.waitFor("custom view removed again") { Web.onMain { !again.isAttachedToWindow } }
    }

    @Test
    fun backWalksWebHistoryThenLeavesNormally() {
        val launched = launch()
        val view = launched.webView()
        val shell = launched.shell()
        assertFalse(Web.onMain { shell.canGoBack })
        Web.tap(view, "to-page2")
        Web.waitFor("page2") { Web.title(view) == "fixture-page2" }
        Web.waitFor("history") { Web.onMain { shell.canGoBack } }

        device.pressBack()
        Web.waitFor("home again") { Web.title(view) == "fixture-home" }
        Web.waitFor("no history") { !Web.onMain { shell.canGoBack } }
        assertEquals(Lifecycle.State.RESUMED, launched.scenario.state)

        // Without history Back is not intercepted: the activity finishes as usual.
        device.pressBack()
        Web.waitFor("activity finished") { launched.scenario.state == Lifecycle.State.DESTROYED }
        Web.waitFor("shell released") { Web.onMain { shell.isReleased } }
        assertEquals("cancel", launched.chooser.events.last())
        assertTrue(launched.downloads.events.toString(), launched.downloads.events.last() == "detach ${view.identity()}")
    }

    @Test
    fun configurationChangesKeepThePageWithoutReloading() {
        val launched = launch()
        val view = launched.webView()
        val shell = launched.shell()
        Web.tap(view, "to-page2")
        Web.waitFor("page2") { Web.title(view) == "fixture-page2" }
        Web.waitFor("history") { Web.onMain { shell.canGoBack } }
        Web.eval(view, "window.marker = 'kept'; 1")
        val requests = pageRequests().size
        val first = launched.activity()

        launched.scenario.recreate()
        val second = launched.activity()
        assertNotSame(first, second)
        assertSame(shell, launched.shell())
        assertSame(view, launched.webView())
        assertEquals("kept", Web.text(view, "window.marker"))
        assertTrue(Web.onMain { shell.canGoBack })
        assertSame(second, Web.onMain { view.context.findActivity() })
        assertTrue(Web.onMain { view.isAttachedToWindow })

        // A real rotation, delivered by the system.
        device.setOrientationLandscape()
        Web.waitFor("recreated by rotation") { launched.activity() !== second }
        val third = launched.activity()
        assertSame(view, launched.webView())
        assertEquals("kept", Web.text(view, "window.marker"))
        assertSame(third, Web.onMain { view.context.findActivity() })
        device.setOrientationPortrait()
        Web.waitFor("rotated back") { launched.activity() !== third }
        assertEquals("kept", Web.text(view, "window.marker"))
        Web.waitFor("WebView shown again") { Web.onMain { view.isAttachedToWindow && view.width > 0 } }

        // Nothing was requested again, and the downloads hooks stayed on the one WebView.
        assertEquals(fixture.requests().toString(), requests, pageRequests().size)
        assertEquals(listOf("attach ${view.identity()}"), launched.downloads.events.filter { !it.startsWith("offer") })
        assertTrue(launched.chooser.events.isEmpty())
    }

    @Test
    fun rendererDeathRecreatesTheWebViewWithoutCrashingTheApp() {
        val launched = launch()
        val shell = launched.shell()
        Web.eval(launched.webView(), "probeStorage('kept-2'); 1")
        assertEquals("kept-2", settled(launched.webView(), "idb"))

        fun killAndRecover(label: String, kill: (WebView) -> Unit) {
            val dead = launched.webView()
            val deadId = dead.identity()
            Web.onMain { kill(dead) }
            Web.waitFor("$label: replacement WebView", 30_000) { launched.webViewOrNull().let { it != null && it !== dead } }
            val fresh = launched.webView()
            Web.waitFor("$label: page reloaded", 30_000) { Web.title(fresh) == "fixture-home" }
            val events = launched.downloads.events.toList()
            val detached = events.lastIndexOf("detach $deadId")
            val attached = events.lastIndexOf("attach ${fresh.identity()}")
            assertTrue("$label: $events", detached >= 0 && attached > detached)
            assertFalse(Web.onMain { shell.loadFailed })
            // Same origin and profile: storage written before the crash is still there.
            Web.eval(fresh, "probeStorage(); 1")
            assertEquals("kept-2", settled(fresh, "ls"))
            assertEquals("kept-2", settled(fresh, "idb"))
        }

        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_VIEW_RENDERER_TERMINATE)) {
            killAndRecover("terminate") { checkNotNull(WebViewCompat.getWebViewRenderProcess(it)).terminate() }
        }
        killAndRecover("chrome://crash") { it.loadUrl("chrome://crash") }
        assertTrue(launched.chooser.events.toString(), launched.chooser.events.count { it == "cancel" } >= 1)
        // The app process survived both.
        assertEquals(Lifecycle.State.RESUMED, launched.scenario.state)
        assertTrue(fixture.requests().toString(), fixture.requests().all { it.listener == "app" && it.launchCookie })
    }

    @Test
    fun clipboardTextAndImageCases() {
        val launched = launch()
        val view = launched.webView()
        Web.navigate(view, "/clipboard.html", "fixture-clipboard")
        val clipboard = instrumentation.targetContext.getSystemService(ClipboardManager::class.java)
        fun clipText(): String? = Web.onMain { clipboard.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.text?.toString() }

        // Text written from a tap: on a supported WebView the async API works and reaches the Android clipboard.
        // An older provider (API 29's stock WebView 74) rejects it even inside a gesture; that case is measured.
        val major = WebViewVersion.parseMajor(WebViewVersion.currentPackage(instrumentation.targetContext)?.versionName)
        Web.tap(view, "write-text")
        val writeText = settled(view, "writeText")
        if (!WebViewVersion.isBelowMinimum(major)) assertEquals("ok", writeText)
        if (writeText == "ok") {
            val written = checkNotNull(Web.result(view, "written"))
            Web.waitFor("clipboard has the written text") { clipText() == written }
        }
        // execCommand copy from a tap reaches the Android clipboard on every provider.
        Web.tap(view, "exec-copy")
        Web.waitFor("execCommand copy") { Web.result(view, "execCopy") != null }
        assertEquals("true", Web.result(view, "execCopy"))
        Web.waitFor("clipboard has the copied text") { clipText() == "fixture-exec-copy" }

        // The other cases are measured: each settles with a result or a rejection, never a hang or a crash.
        Web.tap(view, "read-text")
        val read = settled(view, "readText")
        Web.tap(view, "write-png")
        val png = settled(view, "writePng")
        // What the PNG write left on the Android clipboard: an image type, the earlier text, or nothing.
        var mimes: List<String>? = null
        runCatching {
            Web.waitFor("an image on the clipboard", 3_000) {
                mimes = Web.onMain {
                    clipboard.primaryClipDescription?.let { description -> (0 until description.mimeTypeCount).map(description::getMimeType) }
                }
                mimes?.any { it.startsWith("image/") } == true
            }
        }
        val textAfterPng = clipText()
        Web.tap(view, "write-late")
        val late = settled(view, "writeLate", 20_000)
        Web.eval(view, "writeWithoutGesture(); 1")
        val noGesture = settled(view, "writeNoGesture")
        Web.note(
            "clipboard api=${Build.VERSION.SDK_INT} webview=${WebViewVersion.currentPackage(instrumentation.targetContext)?.versionName}" +
                " writeText=$writeText readText=$read writePng=$png clipMimes=$mimes textAfterPng=$textAfterPng writeLate=$late writeNoGesture=$noGesture",
        )
        for (outcome in listOf(writeText, read, png, late, noGesture)) {
            assertTrue(outcome, outcome.startsWith("ok") || outcome.startsWith("err:") || outcome.startsWith("throw:"))
        }
        assertEquals(Lifecycle.State.RESUMED, launched.scenario.state)
    }

    @Test
    fun serviceWorkerRegistersKeepsTheCookieAndStaysContained() {
        val launched = launch()
        val view = launched.webView()
        Web.navigate(view, "/sw.html", "fixture-sw")
        // Start without a worker: one left by an earlier run would skip the script fetch checked below.
        Web.eval(view, "unregisterAll(); 1")
        Web.waitFor("earlier workers unregistered") { Web.result(view, "unregistered") != null }
        if (Web.result(view, "unregistered") != "0") {
            Web.eval(view, "window.marker = 'controlled'; location.reload(); 1")
            Web.waitFor("reloaded without a worker") {
                Web.text(view, "String(window.marker)") == "undefined" && Web.title(view) == "fixture-sw" &&
                    Web.text(view, "String(navigator.serviceWorker.controller === null)") == "true"
            }
        }
        fixture.reset()
        try {
            Web.eval(view, "registerWorker(); 1")
            Web.waitFor("worker settled", 30_000) {
                Web.result(view, "registered")?.startsWith("err") == true || Web.result(view, "leakLabel") != null
            }
            assertEquals("ok", Web.result(view, "registered"))
            assertEquals("sw:probe ?via=sw", Web.result(view, "probe"))
            val app = fixture.requests().filter { it.listener == "app" }
            assertTrue(app.toString(), app.any { it.url.startsWith("/sw.js") && it.status == 200 && it.launchCookie })
            assertTrue(app.toString(), app.any { it.url == "/sw-probe?via=sw" && it.status == 200 && it.launchCookie })
            // The worker's own fetches to another loopback port, as 127.0.0.1 and as the app's host, were answered locally.
            assertTrue(fixture.escaped().toString(), fixture.escaped().isEmpty())
            Web.note("service worker api=${Build.VERSION.SDK_INT} leak=${Web.result(view, "leak")} leakLabel=${Web.result(view, "leakLabel")}")

            // A reload under the worker keeps the launch cookie. The marker tells the new document from the old one.
            fixture.reset()
            Web.eval(view, "window.marker = 'before-reload'; location.reload(); 1")
            Web.waitFor("reloaded under the worker") {
                Web.text(view, "String(window.marker)") == "undefined" && Web.title(view) == "fixture-sw" &&
                    Web.text(view, "String(navigator.serviceWorker.controller !== null)") == "true"
            }
            val reload = fixture.requests()
            Web.note("service worker reload api=${Build.VERSION.SDK_INT}: $reload")
            assertTrue(reload.toString(), reload.any { it.url == "/sw.html" })
            assertTrue(reload.toString(), reload.all { it.listener == "app" && it.launchCookie && it.status != 403 })
        } finally {
            // Best effort, so that a failure above stays the reported one.
            val cleanup = runCatching {
                Web.eval(view, "unregisterAll(); 1")
                Web.waitFor("worker unregistered") { Web.result(view, "unregistered") != null }
            }
            Web.note("service worker cleanup api=${Build.VERSION.SDK_INT}: ${cleanup.exceptionOrNull()?.message ?: "unregistered"}")
        }
    }

    /**
     * Containment per request kind and host name (plan §4.5). The other loopback listener is reached as `127.0.0.1`,
     * `localhost`, `other.localhost` and as the app's own label host on that other port:
     * - requests the shell sees (`d-`), main-frame redirects (`m-`) and first hops to another local origin (`x-`)
     *   never arrive;
     * - WebSocket handshakes (`ws-`) and the redirect hops of subresource requests (`r-`, and `e-` through an
     *   external redirector) reach no WebView hook, so they are measured: what arrived, with which `Referer` and
     *   `Origin`, and whether it carried the launch cookie. The cookie is host-only on the label, so nothing that
     *   arrives under the other three names may carry it; only a page that knows the label can aim a request at the
     *   label host on another port.
     */
    @Test
    fun otherLoopbackPortsNeverReceiveRequestsTheShellCanSee() {
        val launched = launch()
        val view = launched.webView()
        Web.navigate(view, "/containment.html", "fixture-containment")
        fixture.reset()
        // Image, stylesheet, script, frame, form POST, fetch, XHR and beacon straight to the other port: none arrived.
        Web.eval(view, "direct(); 1")
        val direct = HOSTS.flatMap { host -> REDIRECT_KINDS.map { "d-$host-$it" } }
        Web.waitFor("direct requests settled", 30_000) { allSettled(view, direct) }
        Web.settle(2_000)
        assertTrue(fixture.escaped().toString(), fixture.escaped().isEmpty())
        for (host in HOSTS) {
            Web.note("direct api=${Build.VERSION.SDK_INT} " + REDIRECT_KINDS.joinToString(" ") { "d-$host-$it=${Web.result(view, "d-$host-$it")}" })
        }

        // A main-frame redirect from the app to another port is offered and routed like a navigation, so it is
        // dropped before the browser follows it: after a script navigation, a window.open and a form POST.
        fun mainFrameRedirect(label: String, path: String, offered: String, start: () -> Unit) {
            fixture.reset()
            start()
            Web.waitFor("$label: redirect answered") { fixture.requests().any { it.url == path && it.status == 302 } }
            Web.waitFor("$label: redirect target offered") { launched.downloads.events.any { it.startsWith("offer $offered main=true") } }
            Web.settle()
            assertTrue("$label: ${fixture.escaped()}", fixture.escaped().isEmpty())
            assertEquals(label, "fixture-containment", Web.title(view))
        }
        val bases = mapOf(
            "ip" to "http://127.0.0.1:${fixture.otherPort}",
            "localhost" to "http://localhost:${fixture.otherPort}",
            "named" to "http://other.localhost:${fixture.otherPort}",
            "label" to "http://${fixture.address.host}:${fixture.otherPort}",
        )
        for ((host, base) in bases) {
            val path = "/redirect-other?host=$host&to=/m-location-$host"
            mainFrameRedirect("location, $host", path, "$base/m-location-$host") { Web.eval(view, "location.href = ${JSONObject.quote(path)}; 1") }
        }
        mainFrameRedirect("window.open", "/redirect-other?to=/m-open", "${bases["ip"]}/m-open") { Web.tap(view, "open-redirect") }
        mainFrameRedirect("window.open, app host", "/redirect-other?host=label&to=/m-open-label", "${bases["label"]}/m-open-label") {
            Web.tap(view, "open-redirect-label")
        }
        mainFrameRedirect("form POST", "/redirect-other?to=/m-post", "${bases["ip"]}/m-post") { Web.eval(view, "postSelf(false); 1") }
        mainFrameRedirect("form POST, app host", "/redirect-other?host=label&to=/m-post-label", "${bases["label"]}/m-post-label") {
            Web.eval(view, "postSelf(true); 1")
        }
        assertTrue(fixture.redacted(intents.data()), intents.intents.isEmpty())

        // Residual exposure, measured. A WebSocket handshake and the redirect hops of subresource requests never reach
        // a WebView hook, so what they carry to another port is outside the shell's control.
        fixture.reset()
        val external = InstrumentationRegistry.getArguments().getString("fixtureExternalRedirector").orEmpty()
        Web.eval(view, "residual(${JSONObject.quote(external)}); 1")
        val local = HOSTS.flatMap { host -> listOf("ws-$host") + REDIRECT_KINDS.map { "r-$host-$it" } } +
            listOf("ip", "localhost").flatMap { name -> HOP_KINDS.map { "x-$name-$it" } }
        Web.waitFor("residual cases settled", 60_000) { allSettled(view, local) }
        // Never with the label, which must not reach a third party.
        val remote = if (external.isEmpty()) emptyList() else HOSTS.filter { it != "label" }.flatMap { host -> HOP_KINDS.map { "e-$host-$it" } }
        if (remote.isNotEmpty()) {
            // Best effort: the external host may be slow or unreachable; unsettled cases are reported as pending.
            runCatching { Web.waitFor("external hops settled", 90_000) { allSettled(view, remote) } }
        }
        Web.settle(2_000)
        val log = fixture.requests()
        // Every same-origin probe reached the app first, so each one measured a real redirect.
        for (host in HOSTS) {
            for (kind in REDIRECT_KINDS) {
                val path = "/redirect-other?host=$host&to=/r-$host-$kind"
                assertTrue("r-$host-$kind: $log", log.any { it.listener == "app" && it.url == path && it.status == 302 })
            }
        }
        // The shell refused every first hop to another local origin, so the fixture's redirector saw none.
        assertTrue(log.toString(), log.none { it.listener == "hop" })
        val escaped = log.filter { it.listener.startsWith("other") }
        fun arrivals(key: String) = escaped.filter { it.url == "/$key" }
        fun outcome(key: String): String {
            val reached = arrivals(key)
            val arrived = if (reached.isEmpty()) {
                "none"
            } else {
                reached.joinToString("+") { "${it.method}:cookie=${it.launchCookie}/${it.anyCookie}:ref=${it.referer}:origin=${it.origin}" }
            }
            return "$key=${Web.result(view, key)} arrived=$arrived"
        }
        for (host in HOSTS) {
            val keys = listOf("ws-$host") + REDIRECT_KINDS.map { "r-$host-$it" }
            Web.note("residual api=${Build.VERSION.SDK_INT} ${keys.joinToString(" ") { outcome(it) }}")
        }
        Web.note("residual api=${Build.VERSION.SDK_INT} ${local.filter { it.startsWith("x-") }.joinToString(" ") { outcome(it) }}")
        if (remote.isNotEmpty()) Web.note("residual api=${Build.VERSION.SDK_INT} ${remote.joinToString(" ") { outcome(it) }}")
        val withToken = (local + remote).filter { key -> arrivals(key).any { it.launchCookie } }
        Web.note("residual api=${Build.VERSION.SDK_INT} launch cookie reached another port: $withToken; external=${external.isNotEmpty()}")
        // Host-only on the label: no request under another name carried the cookie, and no Referer named the app.
        assertTrue(withToken.toString(), withToken.all { it.endsWith("-label") || it.contains("-label-") })
        assertTrue(escaped.toString(), escaped.none { it.referer == "label" })
    }

    @Test
    fun openInBrowserHandsOffWithASingleUseCode() {
        val launched = launch()
        val shell = launched.shell()
        val activity = launched.activity()
        assertTrue(Web.onMain { shell.openInBrowser(activity) })
        val intent = intents.intents.single()
        assertTrue(intent.hasCategory(Intent.CATEGORY_BROWSABLE))
        val uri = checkNotNull(intent.data)
        // The handoff goes to the web origin, so the browser keeps the cookie for the label host too.
        assertTrue(fixture.redacted(uri), "${uri.scheme}://${uri.authority}${uri.path}" == "${fixture.webOrigin}${BrowserHandoff.PATH}")
        val code = checkNotNull(uri.getQueryParameter("c"))
        assertEquals(BrowserHandoff.CODE_LENGTH, code.length)
        assertFalse(uri.toString().contains(fixture.token))

        // Redeemed here at the server's native address with the same path and query: Android's resolver does not
        // resolve the label. The repository's middleware accepts the Kotlin code once, then refuses its replay. It
        // answers with a page that moves the browser to / by meta refresh (plan §3.3), not with a redirect.
        val redeem = "${fixture.origin}${BrowserHandoff.PATH}?c=$code"
        val redeemed = Web.get(redeem)
        assertEquals(200, redeemed.status)
        assertEquals(null, redeemed.location)
        assertEquals("no-store", redeemed.cacheControl)
        assertTrue(redeemed.contentType, redeemed.contentType.orEmpty().startsWith("text/html"))
        // Checked before the body is printed in any message: the token stays out of test output.
        assertFalse("the handoff page carries the token", redeemed.body.contains(fixture.token))
        assertTrue(redeemed.body, redeemed.body.contains("<meta http-equiv=\"refresh\" content=\"0;url=/\">"))
        assertTrue(
            "unexpected Set-Cookie",
            redeemed.setCookie == "${LaunchSession.COOKIE_NAME}=${fixture.token}; Path=/; HttpOnly; SameSite=Strict",
        )
        assertEquals(403, Web.get(redeem).status)

        // The public entry point for Settings and the downloads fallback does the same with a fresh code.
        assertTrue(openInBrowser(activity, fixture.session))
        val second = checkNotNull(intents.intents.last().data)
        assertTrue(fixture.redacted(second), second.toString().startsWith("${fixture.webOrigin}${BrowserHandoff.PATH}?c="))
        val secondCode = checkNotNull(second.getQueryParameter("c"))
        assertNotEquals(code, secondCode)
        assertEquals(200, Web.get("${fixture.origin}${BrowserHandoff.PATH}?c=$secondCode").status)
    }

    /**
     * Measured and opt-in: Open in browser with the device's own browser, which the other tests replace with an intent
     * catcher. Run with `-e fixtureBrowser <package>`, for example `com.android.chrome`, on API 31 or later and on an
     * image that has a browser (the API 37 image has Chrome; the API 29 image has no browser). The test clears that
     * browser's data, so run it only on a test device or emulator. The app's own [openInBrowser] starts the browser
     * from an app activity, as Settings and the WebView screen do. The fixture logs whether each request carried the
     * launch cookie:
     * 1. Open in browser from a cleared browser: the browser asks the web origin `http://<label>.localhost:<port>`,
     *    and the middleware answers the handoff with a page that moves to `/`;
     * 2. a reload (F5) of the tab that step 1 left;
     * 3. another app's `ACTION_VIEW` for a page on another loopback port, with the cookie from step 1 in the browser,
     *    as `127.0.0.1`, `localhost` and `other.localhost`, and (measured only) as the label host, which another app
     *    would have to know;
     * 4. the same once the browser's process was stopped;
     * 5. the OpenRouter return in the browser: the provider's page sends the browser back to the app's callback.
     *
     * Asserted: the browser redeemed the code without any cookie on the label host and landed on the app (`/`
     * answered 200 and carried the launch cookie); in steps 3 and 4 nothing under the three other names carried the
     * cookie (the page, its image, its WebSocket and the favicon); no request URL carried the token. The rest is
     * browser behaviour, so it is measured, not asserted. Steps 3 to 5 put the label into the `ACTION_VIEW` that the
     * test sends, which the system logs as it logs the handoff itself.
     */
    @Test
    fun openInBrowserWithTheDevicesBrowser() {
        val browserPackage = InstrumentationRegistry.getArguments().getString("fixtureBrowser").orEmpty()
        assumeTrue("run with -e fixtureBrowser <package>", browserPackage.isNotEmpty())
        assumeTrue("the browser preparation needs API 31 or later", Build.VERSION.SDK_INT >= 31)
        if (Build.VERSION.SDK_INT >= 31) measureOpenInBrowser(DeviceBrowser(browserPackage))
    }

    @RequiresApi(31)
    private fun measureOpenInBrowser(browser: DeviceBrowser) {
        val name = "${browser.packageName} ${browser.versionName}"
        assertNotNull("${browser.packageName} is not installed", browser.versionName)
        val handler = browser.linkHandler()
        assertTrue("http links open $handler: make ${browser.packageName} the default browser", handler.startsWith("${browser.packageName}/"))
        // The other tests catch ACTION_VIEW; here the browser gets it.
        instrumentation.removeMonitor(intents)
        val handoff = "${BrowserHandoff.PATH}?c="
        val seen = mutableListOf<FixtureServer.Request>()
        // No WebView runs in this test, so everything the fixture logs comes from the browser.
        fun requests() = fixture.requests().filter { !it.webView }
        fun measured(label: String): List<FixtureServer.Request> {
            val requests = requests()
            seen += requests
            val summary = requests.joinToString(" | ") {
                "${it.listener} ${it.method} ${it.host} ${it.url.substringBefore('?')} ${it.status} cookie=${it.launchCookie}"
            }
            Web.note("browser api=${Build.VERSION.SDK_INT} $name $label: ${summary.ifEmpty { "nothing" }}")
            return requests
        }

        // Another app asks the browser for a page on another loopback port; the page's own image and WebSocket show
        // what the browser sends there by itself.
        fun anotherApp(label: String, host: String, path: String): List<FixtureServer.Request> {
            fixture.reset()
            browser.viewFromAnotherApp("http://$host:${fixture.otherPort}$path")
            Web.waitFor("$label: the page", BROWSER_TIMEOUT_MILLIS) { requests().any { it.listener == "other" && it.url == path } }
            runCatching {
                Web.waitFor("$label: its image and WebSocket") {
                    requests().let { all -> all.any { it.url.startsWith("/b-sub") } && all.any { it.listener == "other-ws" } }
                }
            }
            Web.settle(BROWSER_SETTLE_MILLIS)
            return measured(label)
        }

        // The three names another app can use; then the label host, which it would have to know.
        fun otherNames(round: String) {
            for ((kind, host) in listOf("ip" to "127.0.0.1", "localhost" to "localhost", "named" to "other.localhost")) {
                val requests = anotherApp("another app, other port, $kind$round", host, "/b-$kind")
                assertTrue("$kind$round: $requests", requests.none { it.launchCookie })
            }
            anotherApp("another app, other port, label host$round", fixture.address.host, "/b-label")
        }

        browser.prepare()
        try {
            // Open in browser from an app activity, with a cleared browser: no launch cookie before the handoff.
            browser.clear()
            fixture.reset()
            ActivityScenario.launch(ComponentActivity::class.java).use { scenario ->
                scenario.onActivity { assertTrue("no browser started", openInBrowser(it, fixture.session)) }
                Web.waitFor("the browser redeemed the code", BROWSER_TIMEOUT_MILLIS) { requests().any { it.url.startsWith(handoff) } }
                Web.waitFor("the browser asked for /", BROWSER_TIMEOUT_MILLIS) { requests().any { it.url == "/" } }
                Web.settle(BROWSER_SETTLE_MILLIS)
                browser.dismissPrompts()
            }
            val opened = measured("open in browser")
            val redeemed = opened.first { it.url.startsWith(handoff) }
            assertEquals(opened.toString(), 200, redeemed.status)
            assertEquals(opened.toString(), "label", redeemed.host)
            // The cleared browser came without the cookie, so the cookie it sends next came from this handoff.
            assertFalse(opened.toString(), redeemed.anyCookie)
            // The page's own move to / carries the cookie; with a 302 there, Chrome landed on the gate's 403.
            val landed = opened.first { it.url == "/" }
            assertTrue(opened.toString(), landed.status == 200 && landed.launchCookie && landed.host == "label")
            // Plain HTTP on the label host: no TLS handshake (an HTTPS upgrade) reached the port.
            assertTrue(opened.toString(), opened.none { it.method == "TLS" })
            // The landing page is a secure context in the browser too (the fixture's home page reports it there).
            Web.waitFor("the browser reported its context", BROWSER_TIMEOUT_MILLIS) { requests().any { it.url.startsWith(SECURE_REPORT) } }
            val context = requests().first { it.url.startsWith(SECURE_REPORT) }
            Web.note("browser api=${Build.VERSION.SDK_INT} $name secure context: ${context.url.substringAfter('=')} host=${context.host}")
            assertEquals("${SECURE_REPORT}true", context.url)

            // Chromium resolves the label itself: the handoff also lands with no network at all.
            val network = DeviceNetwork()
            network.off()
            try {
                fixture.reset()
                ActivityScenario.launch(ComponentActivity::class.java).use { scenario ->
                    scenario.onActivity { assertTrue("no browser started", openInBrowser(it, fixture.session)) }
                    Web.waitFor("offline: the browser asked for /", BROWSER_TIMEOUT_MILLIS) { requests().any { it.url == "/" } }
                    Web.settle(BROWSER_SETTLE_MILLIS)
                    browser.dismissPrompts()
                }
            } finally {
                network.restore()
            }
            val offline = measured("open in browser, no network")
            assertTrue(offline.toString(), offline.any { it.url.startsWith(handoff) && it.status == 200 && it.host == "label" })
            val landedOffline = offline.first { it.url == "/" }
            assertTrue(offline.toString(), landedOffline.status == 200 && landedOffline.launchCookie && landedOffline.host == "label")
            assertTrue(offline.toString(), offline.none { it.method == "TLS" })

            fixture.reset()
            browser.reload()
            val reloaded = runCatching { Web.waitFor("reload: / again", 10_000) { requests().any { it.url == "/" } } }.isSuccess
            Web.settle(1_000)
            measured(if (reloaded) "reload" else "reload (no request)")

            otherNames("")
            browser.stop()
            otherNames(", browser restarted")

            // The OpenRouter return: a cross-site navigation from the provider's page to the app's callback.
            fixture.reset()
            val callback = Uri.encode("${fixture.webOrigin}${WebNavigationPolicy.OPENROUTER_CALLBACK_PATH}")
            browser.viewFromAnotherApp("${fixture.providerOrigin}/auth?auto=1&callback_url=$callback")
            runCatching {
                Web.waitFor("openrouter: the callback", BROWSER_TIMEOUT_MILLIS) { requests().any { it.url.startsWith("/callback/") } }
            }
            Web.settle(BROWSER_SETTLE_MILLIS)
            measured("openrouter return")
            // The code keeps the token out of every URL the browser asked for.
            assertTrue("a request URL carried the token", seen.none { fixture.token in it.url })
        } finally {
            browser.restore()
        }
    }

    @Test
    fun fileInputsGoToTheInjectedChooser() {
        val launched = launch()
        val view = launched.webView()
        Web.navigate(view, "/file.html", "fixture-file")
        Web.tap(view, "pick")
        Web.waitFor("chooser asked") { launched.chooser.events.any { it.startsWith("show ") } }
        assertEquals("show ${view.identity()}", launched.chooser.events.first { it.startsWith("show ") })
        Web.settle()
        assertEquals("0", Web.result(view, "changes"))
    }

    @Test
    fun anOldWebViewShowsANonBlockingWarning() {
        val provider = WebViewVersion.currentPackage(instrumentation.targetContext)
        val major = WebViewVersion.parseMajor(provider?.versionName)
        Web.note("WebView provider api=${Build.VERSION.SDK_INT}: ${provider?.packageName} ${provider?.versionName} major=$major")
        val launched = launch(dismissVersionWarning = false)
        if (!WebViewVersion.isBelowMinimum(major)) {
            assertFalse(ScreenUi.shown(WebScreenTags.VERSION_WARNING, 2_000))
            return
        }
        assertTrue(ScreenUi.shown(WebScreenTags.VERSION_WARNING))
        ScreenUi.click(WebScreenTags.VERSION_UPDATE)
        Web.waitFor("store link") { "market://details?id=${checkNotNull(provider).packageName}" in intents.data() }
        ScreenUi.click(WebScreenTags.OPEN_IN_BROWSER)
        Web.waitFor("browser handoff") { intents.data().any { it.startsWith("${fixture.webOrigin}/__sillybunny/handoff?c=") } }
        ScreenUi.click(WebScreenTags.VERSION_DISMISS)
        assertTrue(ScreenUi.gone(WebScreenTags.VERSION_WARNING))
        // Not a block: the page loaded and kept working underneath.
        assertEquals("fixture-home", Web.title(launched.webView()))
    }

    /**
     * The screen as the app's activity calls it, with no chooser or downloads passed: the real SAF chooser and the
     * real downloads serve the page. A file input opens the system's picker; a page export is captured by the page
     * script and asks for a destination where the WebView supports it, and offers the browser where it does not.
     */
    @Test
    fun theDefaultScreenUsesTheRealChooserAndDownloads() {
        val launched = launch(defaults = true)
        val view = launched.webView()
        val app = instrumentation.targetContext.packageName
        // DocumentsUI, or the photo picker of the media provider.
        val picker = By.pkg(Pattern.compile(".*(documentsui|media).*"))
        fun closePicker(what: String) {
            assertTrue("$what: the system picker", device.wait(Until.hasObject(picker), PICKER_TIMEOUT_MILLIS))
            device.pressBack()
            Web.waitFor("$what: back in the app", PICKER_TIMEOUT_MILLIS) { device.currentPackageName == app }
        }

        val bridged = WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT) &&
            WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
        val api = Web.text(view, "typeof globalThis[Symbol.for('sillybunny.transfers')]")
        Web.note("defaults api=${Build.VERSION.SDK_INT} bridgeFeatures=$bridged pageScript=$api")
        assertEquals(if (bridged) "object" else "undefined", api)
        Web.eval(
            view,
            "(function () { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['x'], { type: 'text/plain' }));" +
                " a.download = 'defaults.txt'; document.body.appendChild(a); a.click(); a.remove(); })(); 1",
        )
        if (bridged) {
            closePicker("export")
        } else {
            assertTrue("the browser is offered", ScreenUi.shown(DISMISS_TAG))
            ScreenUi.click(DISMISS_TAG)
            assertTrue(ScreenUi.gone(DISMISS_TAG))
        }

        Web.navigate(view, "/file.html", "fixture-file")
        Web.tap(view, "pick")
        closePicker("file input")
        Web.settle()
        assertEquals("0", Web.result(view, "changes"))
        assertTrue(fixture.redacted(intents.data()), intents.intents.isEmpty())
    }

    /**
     * The OpenRouter sign-in (integration item 7) against the fixture's stand-in provider, which the shell treats as
     * the OpenRouter origin. The frontend's start loads the provider in the app WebView; the provider's own pages stay
     * there and its other links go to the browser; its return to the app's callback is a cross-site navigation, which
     * would not carry the `SameSite=Strict` launch cookie, so the shell cancels it and loads where the server's
     * callback route leads, with the cookie. A sign-in with another callback is not the app's: it goes to the browser.
     */
    @Test
    fun theOpenRouterSignInReturnsWithTheLaunchCookie() {
        val launched = launch(openRouter = fixture.providerOrigin)
        val view = launched.webView()
        val returned = "/?source=openrouter&query=code%3Dfixture-code"
        fun returnedWithTheCookie(label: String) {
            Web.waitFor("$label: back on the app") { Web.title(view) == "fixture-home" && Web.text(view, "location.search") != "" }
            assertEquals(label, returned.removePrefix("/"), Web.text(view, "location.search"))
            val log = fixture.requests()
            assertTrue("$label: $log", log.any { it.listener == "app" && it.url == returned && it.status == 200 && it.launchCookie })
            // The cancelled callback never reached the server, and nothing was refused.
            assertTrue("$label: $log", log.none { it.url.startsWith("/callback") })
            assertTrue("$label: $log", log.none { it.status == 403 })
            assertTrue("$label: $log", log.none { it.listener == "provider" && it.anyCookie })
        }

        Web.navigate(view, "/openrouter.html", "fixture-openrouter")
        fixture.reset()
        Web.eval(view, "signIn(); 1")
        Web.waitFor("the provider's page in the app") { Web.title(view) == "fixture-provider" }
        // The provider's page gets no bridge or page script.
        assertEquals("undefined", Web.result(view, "bridge"))
        assertEquals("undefined", Web.result(view, "api"))
        Web.tap(view, "sign-in")
        Web.waitFor("the provider's next page in the app") { Web.title(view) == "fixture-provider-sign-in" }
        Web.tap(view, "elsewhere")
        Web.waitFor("the provider's other link handed off") { "https://example.com/provider-elsewhere" in intents.data() }
        assertEquals("fixture-provider-sign-in", Web.title(view))
        Web.eval(view, "fx.back(); 1")
        returnedWithTheCookie("page return")
        val handedOff = intents.intents.size

        // The provider answers the start with a redirect straight back.
        Web.navigate(view, "/openrouter.html", "fixture-openrouter")
        fixture.reset()
        Web.eval(view, "signIn('302'); 1")
        returnedWithTheCookie("redirect return")

        // A sign-in with another callback is not the app's own: it is routed like any other page, so it does not load
        // in the app. The real provider would go to the browser; this one, on a local name, is blocked.
        Web.navigate(view, "/openrouter.html", "fixture-openrouter")
        fixture.reset()
        Web.eval(view, "signInElsewhere(); 1")
        Web.waitFor("a foreign sign-in routed") {
            launched.downloads.events.any { it.startsWith("offer ${fixture.providerOrigin}/auth?") && it.contains("127.0.0.1") }
        }
        Web.settle()
        assertEquals("fixture-openrouter", Web.title(view))
        assertEquals(fixture.redacted(intents.data()), handedOff, intents.intents.size)
        assertTrue(fixture.requests().toString(), fixture.requests().none { it.listener == "provider" })
        assertTrue(fixture.escaped().toString(), fixture.escaped().isEmpty())
    }

    @Test
    fun mediaPlaysAfterAsyncWorkWithoutAFreshGesture() {
        val launched = launch()
        val view = launched.webView()
        Web.navigate(view, "/media.html", "fixture-media")

        // The frontend starts TTS, previews and notification sounds after awaited work, without a fresh gesture, so
        // the shell turns WebView's gesture requirement off: play() from script alone must not be refused.
        Web.eval(view, "playLater(); 1")
        val autoplay = settled(view, "autoplay")
        assertFalse(autoplay, autoplay.startsWith("err:NotAllowedError"))
        // A dedicated worker compiles and runs WebAssembly.
        Web.eval(view, "workerWasm(); 1")
        assertEquals("ok:42", settled(view, "wasm"))

        // Measured only: Web Audio with an AudioWorklet, and speechSynthesis, which needs a platform TTS engine.
        Web.eval(view, "webAudio(); speech(); 1")
        val worklet = settled(view, "worklet")
        val speak = settled(view, "speak", 15_000)

        // Measured only: background audio after a qualifying start. A looping silent track starts from a tap, then the
        // activity is stopped (another activity covers it, as Home would) while the page keeps being read.
        Web.tap(view, "loop")
        val loop = settled(view, "loop")
        Web.settle(1_000)
        val audio = instrumentation.targetContext.getSystemService(AudioManager::class.java)
        val musicActive = Web.onMain { audio.isMusicActive }
        val focus = audioFocusHeld()
        val foreground = Web.text(view, "loopState()")
        launched.scenario.moveToState(Lifecycle.State.CREATED)
        Web.settle(5_000)
        val stopped = Web.text(view, "loopState()")
        val musicWhileStopped = Web.onMain { audio.isMusicActive }
        launched.scenario.moveToState(Lifecycle.State.RESUMED)
        Web.settle(1_000)
        val resumed = Web.text(view, "loopState()")
        Web.eval(view, "stopLoop(); 1")
        Web.note(
            "media api=${Build.VERSION.SDK_INT} autoplay=$autoplay wasm=ok:42 context=${Web.result(view, "context")} worklet=$worklet " +
                "voices=${Web.result(view, "voices")} speak=$speak loop=$loop musicActive=$musicActive audioFocus=$focus",
        )
        Web.note(
            "media background api=${Build.VERSION.SDK_INT} foreground=[$foreground] stopped5s=[$stopped] " +
                "musicActiveWhileStopped=$musicWhileStopped resumed=[$resumed]",
        )
        assertEquals(Lifecycle.State.RESUMED, launched.scenario.state)
    }

    /** Whether the app is in the audio service's focus stack. */
    private fun audioFocusHeld(): Boolean {
        val lines = Web.shell("dumpsys audio").lines()
        val start = lines.indexOfFirst { "Audio Focus stack entries" in it }
        if (start < 0) return false
        return lines.drop(start + 1)
            .takeWhile { it.startsWith(" ") || it.startsWith("\t") }
            .any { instrumentation.targetContext.packageName in it }
    }

    @Test
    fun theKeyboardResizesThePageAfterRotation() {
        val launched = launch()
        val view = launched.webView()
        Web.navigate(view, "/input.html", "fixture-input")
        // A rotation and back: the retained WebView now sits in the window of a third activity instance.
        val first = launched.activity()
        device.setOrientationLandscape()
        Web.waitFor("recreated by rotation") { launched.activity() !== first }
        val second = launched.activity()
        device.setOrientationPortrait()
        Web.waitFor("rotated back") { launched.activity() !== second }
        Web.waitFor("WebView shown again") { Web.onMain { view.isAttachedToWindow && view.width > 0 } }
        Web.settle(1_000)

        // Edge to edge: the WebView stays clear of the system bars.
        val decor = launched.activity().window.decorView
        val (top, bottom) = Web.onMain {
            val location = IntArray(2)
            view.getLocationOnScreen(location)
            location[1] to location[1] + view.height
        }
        val bars = Web.onMain { checkNotNull(ViewCompat.getRootWindowInsets(decor)).getInsets(WindowInsetsCompat.Type.systemBars()) }
        val screenHeight = Web.onMain { decor.height }
        assertTrue("top=$top bars=$bars", top >= bars.top)
        assertTrue("bottom=$bottom screen=$screenHeight bars=$bars", bottom <= screenHeight - bars.bottom)

        // The keyboard shrinks the WebView, keeps the focused field in view and types into the page.
        val fullHeight = Web.onMain { view.height }
        Web.tap(view, "field")
        Web.waitFor("WebView resized above the keyboard") { Web.onMain { view.height } < fullHeight }
        val ime = Web.onMain { ViewCompat.getRootWindowInsets(decor)?.isVisible(WindowInsetsCompat.Type.ime()) }
        Web.waitFor("field in view") { Web.text(view, "fieldVisible()") == "true" }
        Web.shell("input text fixture")
        Web.waitFor("typed into the page") { Web.text(view, "document.getElementById('field').value") == "fixture" }
        Web.note("keyboard api=${Build.VERSION.SDK_INT} imeVisible=$ime webViewHeight=$fullHeight->${Web.onMain { view.height }}")
        Web.eval(view, "document.activeElement.blur(); 1")
    }

    @Test
    fun aLargeScreenResizeKeepsThePageWithoutReloading() {
        val launched = launch()
        val view = launched.webView()
        Web.eval(view, "window.marker = 'kept'; 1")
        val requests = pageRequests().size
        val first = launched.activity()
        val smallest = Web.onMain { first.resources.configuration.smallestScreenWidthDp }
        val width = Web.onMain { view.width }
        try {
            // A tablet-sized display at the same density: the smallest width becomes 600 dp or more.
            Web.shell("wm size ${LARGE_WIDTH}x$LARGE_HEIGHT")
            Web.waitFor("recreated for the larger display") { launched.activity() !== first }
            val large = launched.activity()
            val largeSmallest = Web.onMain { large.resources.configuration.smallestScreenWidthDp }
            assertSame(view, launched.webView())
            assertEquals("kept", Web.text(view, "window.marker"))
            Web.waitFor("WebView fills the larger window") { Web.onMain { view.isAttachedToWindow && view.width > width } }
            Web.note(
                "large screen api=${Build.VERSION.SDK_INT} smallestWidthDp=$smallest->$largeSmallest " +
                    "webView=${width}px->${Web.onMain { view.width }}px",
            )
            assertTrue("smallestScreenWidthDp=$largeSmallest", largeSmallest >= 600)
        } finally {
            Web.shell("wm size reset")
        }
        Web.waitFor("recreated for the original display") {
            val current = launched.activity()
            Web.onMain { current.resources.configuration.smallestScreenWidthDp } == smallest
        }
        Web.waitFor("WebView shown again") { Web.onMain { view.isAttachedToWindow && view.width == width } }
        assertSame(view, launched.webView())
        assertEquals("kept", Web.text(view, "window.marker"))
        // Nothing was requested again.
        assertEquals(fixture.requests().toString(), requests, pageRequests().size)
    }

    private companion object {
        const val IMMERSIVE_CONFIRMATIONS = "immersive_mode_confirmations"

        /** Longer than the system waits before it shows the immersive-mode confirmation (about a second). */
        const val CONFIRMATION_DELAY_MILLIS = 2_500L

        /** The request kinds of the probes in `containment.html`, and the host names they use for the other port. */
        val REDIRECT_KINDS = listOf("img", "css", "script", "frame", "form", "nocors", "cors", "xhr", "beacon")
        val HOP_KINDS = listOf("img", "css", "script", "frame", "form", "nocors", "beacon")
        val HOSTS = listOf("ip", "localhost", "named", "label")

        /** The system picker can take a while to start cold. */
        const val PICKER_TIMEOUT_MILLIS = 20_000L

        /** The request with which the fixture's home page reports `isSecureContext` in the browser. */
        const val SECURE_REPORT = "/png?secure="

        /** At the AVDs' 440 dpi this gives a smallest width of about 650 dp. */
        const val LARGE_WIDTH = 1800
        const val LARGE_HEIGHT = 2700

        /** A cleared browser starts cold, so its first request can take a while. */
        const val BROWSER_TIMEOUT_MILLIS = 60_000L

        /** Lets the browser's follow-up requests (favicon, subresources) arrive before a step is measured. */
        const val BROWSER_SETTLE_MILLIS = 3_000L
    }
}
