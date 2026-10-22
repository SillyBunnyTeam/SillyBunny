package io.github.sillybunnyteam.sillybunny.web

import android.content.ClipboardManager
import android.content.Intent
import android.media.AudioManager
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
import androidx.test.uiautomator.UiDevice
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import io.github.sillybunnyteam.sillybunny.server.LaunchSession
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
 * repository's launch-token middleware in front of `fixtures/pages`, plus a second loopback listener that
 * must never receive anything the shell can see. Run with `-e fixturePort <p> -e fixtureOther <q>
 * -e fixtureToken <hex>` after `adb reverse tcp:<p> tcp:<p>` and `adb reverse tcp:<q> tcp:<q>`. Optional:
 * `-e fixtureExternalRedirector <url prefix>`, an https redirector whose URL takes the encoded target last
 * (for example `https://httpbin.org/redirect-to?status_code=302&url=`), adds an external hop to the
 * measured redirect cases; `-e fixtureBrowser <package>` runs [openInBrowserWithTheDevicesBrowser] with that
 * browser, which is skipped without it.
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

    /** Shows the shell for the fixture session and waits until the home page is loaded. */
    private fun launch(dismissVersionWarning: Boolean = true): WebScreenHost {
        val launched = WebScreenHost(fixture.session).launch()
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
        } finally {
            Web.onMain { bare.destroy() }
        }
        fixture.reset()

        val launched = launch()
        // The bare WebView's requests are marked, in case one of them is logged late.
        val requests = fixture.requests().filter { it.url != "/?bare" }
        assertTrue(requests.toString(), requests.isNotEmpty())
        val first = requests.first()
        assertEquals(requests.toString(), "app GET / 200 true", "${first.listener} ${first.method} ${first.url} ${first.status} ${first.launchCookie}")
        // Every later request passed the gate too (the fixture has no favicon, so that one is a 404 behind it).
        assertTrue(requests.toString(), requests.all { it.listener == "app" && it.launchCookie && it.status != 403 })
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
        // Origin-keyed storage works and survives a reload of the same origin.
        Web.eval(view, "probeStorage('kept-1'); 1")
        assertEquals("kept-1", settled(view, "ls"))
        assertEquals("kept-1", settled(view, "idb"))
        assertEquals("held", settled(view, "locks"))
        assertEquals("true", settled(view, "quota"))
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
        for (id in listOf("other-port", "intent", "blob", "data")) {
            Web.tap(view, id)
            Web.settle(800)
        }
        Web.settle()
        assertEquals(intents.data().toString(), handedOff, intents.intents.size)
        assertEquals("fixture-links", Web.title(view))
        assertTrue(fixture.escaped().toString(), fixture.escaped().isEmpty())

        // Main-frame navigations are offered to WebDownloads before routing.
        val offers = launched.downloads.events.filter { it.startsWith("offer ") }
        Web.note("link offers api=${Build.VERSION.SDK_INT}: $offers")
        assertTrue(offers.toString(), "offer https://example.com/ext main=true gesture=true" in offers)
        assertTrue(offers.toString(), offers.any { it.startsWith("offer http://127.0.0.1:${fixture.otherPort}/link main=true") })
        assertTrue(offers.toString(), offers.any { it.startsWith("offer intent://scan/") })
        assertTrue(offers.toString(), offers.any { it.startsWith("offer blob:http://127.0.0.1:${fixture.port}/") })

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
            launched.downloads.events.any { it.startsWith("offer blob:http://127.0.0.1:${fixture.port}/") && it.contains("main=true") }
        }
        // A new window for another loopback port is offered like a main-frame navigation, then blocked.
        Web.tap(view, "open-other")
        Web.waitFor("other-port popup offered") {
            launched.downloads.events.any { it.startsWith("offer http://127.0.0.1:${fixture.otherPort}/popup main=true") }
        }
        // Chromium refuses a new window for a data: URL before any WebView callback; measured, not asserted. Web.tap
        // confirms that the button saw the click.
        Web.tap(view, "open-data")
        Web.settle()
        Web.note("data popup api=${Build.VERSION.SDK_INT} offered=${launched.downloads.events.any { it.startsWith("offer data:") }}")
        assertEquals(intents.data().toString(), handedOff, intents.intents.size)
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
                Web.result(view, "registered")?.startsWith("err") == true || Web.result(view, "leak") != null
            }
            assertEquals("ok", Web.result(view, "registered"))
            assertEquals("sw:probe ?via=sw", Web.result(view, "probe"))
            val app = fixture.requests().filter { it.listener == "app" }
            assertTrue(app.toString(), app.any { it.url.startsWith("/sw.js") && it.status == 200 && it.launchCookie })
            assertTrue(app.toString(), app.any { it.url == "/sw-probe?via=sw" && it.status == 200 && it.launchCookie })
            // The worker's own fetch to another loopback port was answered locally.
            assertTrue(fixture.escaped().toString(), fixture.escaped().isEmpty())
            Web.note("service worker api=${Build.VERSION.SDK_INT} leak=${Web.result(view, "leak")}")

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

    @Test
    fun otherLoopbackPortsNeverReceiveRequestsTheShellCanSee() {
        val launched = launch()
        val view = launched.webView()
        Web.navigate(view, "/containment.html", "fixture-containment")
        Web.waitFor("page requests settled") {
            Web.result(view, "form") == "submitted" && Web.result(view, "xhr") != null && Web.result(view, "fetch") != null
        }
        Web.settle(2_000)
        // Image, frame, form POST, fetch, XHR and beacon straight to another port: none arrived there.
        assertTrue(fixture.escaped().toString(), fixture.escaped().isEmpty())
        Web.note(
            "containment api=${Build.VERSION.SDK_INT} fetch=${Web.result(view, "fetch")} xhr=${Web.result(view, "xhr")} " +
                "beacon=${Web.result(view, "beacon")}",
        )

        // A main-frame redirect from the app to another port is offered and routed like a navigation, so it is
        // dropped before the browser follows it: after a script navigation, a window.open and a form POST.
        fun mainFrameRedirect(label: String, target: String, start: () -> Unit) {
            fixture.reset()
            start()
            Web.waitFor("$label: redirect answered") {
                fixture.requests().any { it.url == "/redirect-other?to=$target" && it.status == 302 }
            }
            Web.waitFor("$label: redirect target offered") {
                launched.downloads.events.any { it.startsWith("offer http://127.0.0.1:${fixture.otherPort}$target main=true") }
            }
            Web.settle()
            assertTrue("$label: ${fixture.escaped()}", fixture.escaped().isEmpty())
            assertEquals(label, "fixture-containment", Web.title(view))
        }
        mainFrameRedirect("location", "/m-location") { Web.eval(view, "location.href = '/redirect-other?to=/m-location'; 1") }
        mainFrameRedirect("window.open", "/m-open") { Web.tap(view, "open-redirect") }
        mainFrameRedirect("form POST", "/m-post") { Web.eval(view, "postSelf(); 1") }
        assertTrue(intents.data().toString(), intents.intents.isEmpty())

        // Residual exposure, measured only. A WebSocket handshake and the redirect hops of subresource requests
        // never reach a WebView hook, so what they carry to another port is outside the shell's control.
        fixture.reset()
        val external = InstrumentationRegistry.getArguments().getString("fixtureExternalRedirector").orEmpty()
        Web.eval(view, "residual(${JSONObject.quote(external)}); 1")
        val local = listOf("ws") + REDIRECT_KINDS.map { "r-$it" } + HOP_KINDS.map { "x-$it" }
        Web.waitFor("residual cases settled", 30_000) { allSettled(view, local) }
        val remote = if (external.isEmpty()) emptyList() else HOP_KINDS.map { "e-$it" }
        if (remote.isNotEmpty()) {
            // Best effort: the external host may be slow or unreachable; unsettled cases are reported as pending.
            runCatching { Web.waitFor("external hops settled", 60_000) { allSettled(view, remote) } }
        }
        Web.settle(2_000)
        val log = fixture.requests()
        // Every same-origin probe reached the app first, so each one measured a real redirect.
        for (kind in REDIRECT_KINDS) {
            assertTrue("r-$kind: $log", log.any { it.listener == "app" && it.url == "/redirect-other?to=/r-$kind" && it.status == 302 })
        }
        val escaped = log.filter { it.listener.startsWith("other") }
        fun outcome(key: String): String {
            val reached = escaped.filter { if (key == "ws") it.listener == "other-ws" else it.url == "/$key" }
            val hop = if (key.startsWith("x-")) " hop=${log.any { it.listener == "hop" && it.url.endsWith("to=/$key") }}" else ""
            val arrived = if (reached.isEmpty()) "none" else reached.joinToString("+") { "${it.method}:cookie=${it.launchCookie}/${it.anyCookie}" }
            return "$key=${Web.result(view, key)}$hop arrived=$arrived"
        }
        for (group in listOf(listOf("ws"), REDIRECT_KINDS.map { "r-$it" }, HOP_KINDS.map { "x-$it" }, remote)) {
            if (group.isNotEmpty()) Web.note("residual api=${Build.VERSION.SDK_INT} ${group.joinToString(" ") { outcome(it) }}")
        }
        val withToken = (local + remote).filter { key ->
            escaped.any { it.launchCookie && (if (key == "ws") it.listener == "other-ws" else it.url == "/$key") }
        }
        Web.note("residual api=${Build.VERSION.SDK_INT} launch cookie reached another port: $withToken; external=${external.isNotEmpty()}")
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
        assertEquals("${fixture.origin}/__sillybunny/handoff", "${uri.scheme}://${uri.authority}${uri.path}")
        assertEquals(BrowserHandoff.CODE_LENGTH, checkNotNull(uri.getQueryParameter("c")).length)
        assertFalse(uri.toString().contains(fixture.token))

        // The repository's middleware accepts the Kotlin code once, then refuses its replay. It answers with a page
        // that moves the browser to / by meta refresh (plan §3.3), not with a redirect.
        val redeemed = Web.get(uri.toString())
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
        assertEquals(403, Web.get(uri.toString()).status)

        // The public entry point for Settings and the downloads fallback does the same with a fresh code.
        assertTrue(openInBrowser(activity, fixture.session))
        val second = checkNotNull(intents.intents.last().dataString)
        assertNotEquals(uri.toString(), second)
        assertEquals(200, Web.get(second).status)
    }

    /**
     * Measured and opt-in: Open in browser with the device's own browser, which the other tests replace with an intent
     * catcher. Run with `-e fixtureBrowser <package>`, for example `com.android.chrome`, on API 31 or later and on an
     * image that has a browser (the API 37 image has Chrome; the API 29 image has no browser). The test clears that
     * browser's data, so run it only on a test device or emulator. The app's own [openInBrowser] starts the browser
     * from an app activity, as Settings and the WebView screen do. The fixture logs whether each request carried the
     * launch cookie:
     * 1. Open in browser from a cleared browser: the middleware answers the handoff with a page that moves to `/`;
     * 2. a reload (F5) of the tab that step 1 left;
     * 3. another app's `ACTION_VIEW` for a page on another loopback port, with the cookie from step 1 in the browser;
     * 4. the same once the browser's process was stopped.
     *
     * Asserted: the browser redeemed the code without any cookie and landed on the app (`/` answered 200 and carried
     * the launch cookie), and no request URL carried the token. Steps 2 to 4 are browser behaviour, so they are
     * measured, not asserted. Steps 3 and 4 are the cross-port baseline on 127.0.0.1.
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
            val summary = requests.joinToString(" | ") { "${it.listener} ${it.method} ${it.url.substringBefore('?')} ${it.status} cookie=${it.launchCookie}" }
            Web.note("browser api=${Build.VERSION.SDK_INT} $name $label: ${summary.ifEmpty { "nothing" }}")
            return requests
        }

        // Another app asks the browser for a page on another loopback port; the page's own image and WebSocket show
        // what the browser sends there by itself.
        fun anotherApp(label: String, path: String) {
            fixture.reset()
            browser.viewFromAnotherApp("http://127.0.0.1:${fixture.otherPort}$path")
            Web.waitFor("$label: the page", BROWSER_TIMEOUT_MILLIS) { requests().any { it.listener == "other" && it.url == path } }
            runCatching {
                Web.waitFor("$label: its image and WebSocket") {
                    requests().let { all -> all.any { it.url.startsWith("/b-sub") } && all.any { it.listener == "other-ws" } }
                }
            }
            Web.settle(BROWSER_SETTLE_MILLIS)
            measured(label)
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
            // The cleared browser came without the cookie, so the cookie it sends next came from this handoff.
            assertFalse(opened.toString(), redeemed.anyCookie)
            // The page's own move to / carries the cookie; with a 302 there, Chrome landed on the gate's 403.
            val landed = opened.first { it.url == "/" }
            assertTrue(opened.toString(), landed.status == 200 && landed.launchCookie)

            fixture.reset()
            browser.reload()
            val reloaded = runCatching { Web.waitFor("reload: / again", 10_000) { requests().any { it.url == "/" } } }.isSuccess
            Web.settle(1_000)
            measured(if (reloaded) "reload" else "reload (no request)")

            anotherApp("another app, other port", "/b-intent")
            browser.stop()
            anotherApp("another app, other port, browser restarted", "/b-restart")
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
        Web.waitFor("browser handoff") { intents.data().any { it.startsWith("${fixture.origin}/__sillybunny/handoff?c=") } }
        ScreenUi.click(WebScreenTags.VERSION_DISMISS)
        assertTrue(ScreenUi.gone(WebScreenTags.VERSION_WARNING))
        // Not a block: the page loaded and kept working underneath.
        assertEquals("fixture-home", Web.title(launched.webView()))
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

        /** The subresource kinds of the redirect probes in `containment.html`. */
        val REDIRECT_KINDS = listOf("img", "css", "script", "frame", "form", "nocors", "cors", "xhr", "beacon")
        val HOP_KINDS = listOf("img", "css", "script", "frame", "form", "nocors", "beacon")

        /** At the AVDs' 440 dpi this gives a smallest width of about 650 dp. */
        const val LARGE_WIDTH = 1800
        const val LARGE_HEIGHT = 2700

        /** A cleared browser starts cold, so its first request can take a while. */
        const val BROWSER_TIMEOUT_MILLIS = 60_000L

        /** Lets the browser's follow-up requests (favicon, subresources) arrive before a step is measured. */
        const val BROWSER_SETTLE_MILLIS = 3_000L
    }
}
