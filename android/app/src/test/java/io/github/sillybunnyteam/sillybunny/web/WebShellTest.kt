package io.github.sillybunnyteam.sillybunny.web

import android.content.Context
import android.content.pm.PackageInfo
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.Message
import android.view.View
import android.webkit.ConsoleMessage
import android.webkit.GeolocationPermissions
import android.webkit.JsPromptResult
import android.webkit.JsResult
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebView
import androidx.test.core.app.ApplicationProvider
import io.github.sillybunnyteam.sillybunny.server.LaunchSession
import java.time.Duration
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadow.api.Shadow
import org.robolectric.shadows.ShadowJsPromptResult
import org.robolectric.shadows.ShadowJsResult

/** The shell's hook order and policy wiring, against fakes for the provider, chooser and downloads. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29, 37])
class WebShellTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val log = EventLog()
    private val platform = FakeWebShellPlatform(log)
    private val chooser = RecordingChooser(log)
    private val downloads = RecordingDownloads(log)
    private val token = "ab".repeat(32)
    private val session = LaunchSession(41_234, token)
    private val address = WebAddress(LABEL)
    private val host = "$LABEL.localhost"

    /** The web origin: the per-install label, never the server's native `http://127.0.0.1:41234`. */
    private val origin = "http://$host:41234"
    private var now = 1_000_000L
    private val shells = mutableListOf<WebShell>()

    private fun shell(
        policy: WebPermissionPolicy = WebPermissionPolicy.DEFAULT,
        openRouter: Uri = Uri.parse(WebNavigationPolicy.OPENROUTER_ORIGIN),
    ): WebShell = WebShell(context, platform, policy, { now }, openRouter).also { shells += it }

    private fun idle() = shadowOf(Looper.getMainLooper()).idle()

    /** A shell showing [session] with its page loaded. */
    private fun loaded(
        policy: WebPermissionPolicy = WebPermissionPolicy.DEFAULT,
        openRouter: Uri = Uri.parse(WebNavigationPolicy.OPENROUTER_ORIGIN),
    ): WebShell {
        val shell = shell(policy, openRouter)
        shell.bind(session, address, chooser, downloads)
        platform.cookies.last().done(true)
        return shell
    }

    private val WebView.client get() = shadowOf(this).webViewClient
    private val WebView.chrome get() = shadowOf(this).webChromeClient

    @After
    fun release() {
        shells.forEach(WebShell::release)
        idle()
    }

    @Test
    fun attachesDownloadsThenLoadsOnlyAfterTheCookieWasAccepted() {
        val shell = shell()
        shell.bind(session, address, chooser, downloads)
        assertEquals(listOf("attach downloads w1 41234", "cookie $origin"), log.events)
        assertEquals("sillybunny_launch=$token; HttpOnly; SameSite=Strict; Path=/", platform.cookies.single().value)
        assertNull(shadowOf(platform.views[0]).lastLoadedUrl)
        platform.cookies.single().done(true)
        assertEquals("load w1 $origin/", log.events.last())
        assertFalse(shell.loadFailed)
        assertSame(platform.views[0], shell.webView)
        assertEquals(1, platform.configureCalls)
    }

    @Test
    fun aRejectedCookieNeverLoadsAndRetryStartsOver() {
        val shell = shell()
        shell.bind(session, address, chooser, downloads)
        platform.cookies.single().done(false)
        assertTrue(shell.loadFailed)
        assertTrue(log.events.none { it.startsWith("load") })
        val mark = log.size
        shell.retry()
        assertEquals(
            listOf("cancel chooser", "detach downloads w1", "destroy w1", "attach downloads w2 41234", "cookie $origin"),
            log.since(mark),
        )
        assertFalse(shell.loadFailed)
        platform.cookies.last().done(true)
        assertEquals("load w2 $origin/", log.events.last())
    }

    @Test
    fun aCookieTimeoutFailsAndALateAnswerIsIgnored() {
        val shell = shell()
        shell.bind(session, address, chooser, downloads)
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(WebShell.COOKIE_TIMEOUT_MILLIS))
        assertTrue(shell.loadFailed)
        platform.cookies.single().done(true)
        assertTrue(log.events.none { it.startsWith("load") })
    }

    @Test
    fun settingsFollowThePlan() {
        loaded()
        val view = platform.views.single()
        val settings = view.settings
        assertTrue(settings.javaScriptEnabled)
        assertTrue(settings.domStorageEnabled)
        assertFalse(settings.allowFileAccess)
        assertFalse(settings.allowContentAccess)
        @Suppress("DEPRECATION")
        assertFalse(settings.allowFileAccessFromFileURLs)
        @Suppress("DEPRECATION")
        assertFalse(settings.allowUniversalAccessFromFileURLs)
        // No deprecated WebSQL toggle; IndexedDB needs none.
        @Suppress("DEPRECATION")
        assertFalse(settings.databaseEnabled)
        assertTrue(settings.supportMultipleWindows())
        assertFalse(settings.javaScriptCanOpenWindowsAutomatically)
        assertNotNull(view.client)
        assertNotNull(view.chrome)
        // The shell never takes the download hooks; WebDownloads owns them.
        assertNull(shadowOf(view).downloadListener)
    }

    @Test
    fun theSameSessionKeepsItsWebViewAndTheLatestChooserServesRequests() {
        val shell = loaded()
        val second = RecordingChooser(log, "chooser2")
        shell.bind(session, address, second, RecordingDownloads(log, "downloads2"))
        assertEquals(1, platform.views.size)
        val view = platform.views.single()
        val callback = RecordingValueCallback<Array<Uri>>()
        assertTrue(view.chrome.onShowFileChooser(view, callback, FakeChooserParams()))
        assertEquals("show chooser2 w1", log.events.last())
        assertTrue(callback.values.isEmpty())
    }

    @Test
    fun aChooserRequestFromAnotherPageIsCancelled() {
        loaded()
        val view = platform.views.single()
        view.loadUrl("https://example.com/")
        val callback = RecordingValueCallback<Array<Uri>>()
        assertTrue(view.chrome.onShowFileChooser(view, callback, FakeChooserParams()))
        assertEquals(listOf<Array<Uri>?>(null), callback.values)
        assertTrue(log.events.none { it.startsWith("show") })
    }

    @Test
    fun aNewSessionReplacesTheWebViewInTheDocumentedOrder() {
        val shell = loaded()
        val mark = log.size
        val next = LaunchSession(41_300, "cd".repeat(32))
        shell.bind(next, address, chooser, RecordingDownloads(log, "downloads2"))
        assertEquals(
            listOf(
                "cancel chooser",
                "detach downloads w1",
                "destroy w1",
                "attach downloads2 w2 41300",
                "cookie http://$host:41300",
            ),
            log.since(mark),
        )
        platform.cookies.last().done(true)
        assertEquals("load w2 http://$host:41300/", log.events.last())
    }

    @Test
    fun aNewAddressReplacesTheWebViewToo() {
        val shell = loaded()
        val other = WebAddress("sb-zyxwvutsrqponmlkjihgfedcba")
        val mark = log.size
        shell.bind(session, other, chooser, downloads)
        assertEquals(
            listOf("cancel chooser", "detach downloads w1", "destroy w1", "attach downloads w2 41234", "cookie http://${other.host}:41234"),
            log.since(mark),
        )
        assertEquals(other.appOrigin(41_234), shell.appOrigin)
    }

    @Test
    fun rendererDeathRecreatesTheWebViewAndReattachesDownloads() {
        val shell = loaded()
        val dead = platform.views.single()
        val mark = log.size
        assertTrue(dead.client.onRenderProcessGone(dead, FakeRenderProcessGoneDetail()))
        assertEquals(listOf("cancel chooser", "detach downloads w1", "destroy w1"), log.since(mark))
        assertNull(shell.webView)
        idle()
        assertEquals("attach downloads w2 41234", log.events[log.size - 2])
        platform.cookies.last().done(true)
        assertEquals("load w2 $origin/", log.events.last())
        assertSame(platform.views[1], shell.webView)
        assertFalse(shell.loadFailed)
    }

    @Test
    fun repeatedRendererDeathStopsUntilRetry() {
        val shell = loaded()
        repeat(WebShell.RENDERER_DEATH_LIMIT) {
            val view = checkNotNull(shell.webView)
            view.client.onRenderProcessGone(view, FakeRenderProcessGoneDetail(crashed = false))
            idle()
            platform.cookies.last().done(true)
            now += 1_000
        }
        assertTrue(shell.loadFailed)
        assertNull(shell.webView)
        assertEquals(WebShell.RENDERER_DEATH_LIMIT, platform.views.size)
        shell.retry()
        assertNotNull(shell.webView)
        assertFalse(shell.loadFailed)
    }

    @Test
    fun rendererDeathsFarApartKeepRecovering() {
        val shell = loaded()
        repeat(WebShell.RENDERER_DEATH_LIMIT + 2) {
            val view = checkNotNull(shell.webView)
            view.client.onRenderProcessGone(view, FakeRenderProcessGoneDetail())
            idle()
            platform.cookies.last().done(true)
            now += WebShell.RENDERER_DEATH_WINDOW_MILLIS + 1
        }
        assertFalse(shell.loadFailed)
        assertNotNull(shell.webView)
    }

    @Test
    fun releaseCancelsTheChooserAndDetachesDownloadsBeforeDestroying() {
        val shell = loaded()
        val mark = log.size
        shell.release()
        assertEquals(listOf("cancel chooser", "detach downloads w1", "destroy w1"), log.since(mark))
        assertTrue(shell.isReleased)
    }

    @Test
    fun aMissingProviderShowsTheFailureInsteadOfCrashing() {
        platform.failNewWebView = true
        val shell = shell()
        shell.bind(session, address, chooser, downloads)
        assertTrue(shell.loadFailed)
        assertTrue(log.events.isEmpty())
        platform.failNewWebView = false
        shell.retry()
        assertEquals(listOf("attach downloads w1 41234", "cookie $origin"), log.events)
    }

    @Test
    fun mainFrameNavigationsAreOfferedToDownloadsBeforeRouting() {
        loaded()
        val view = platform.views.single()
        downloads.takes = { it.scheme == "blob" }
        val blob = "blob:$origin/9b1c"
        val mark = log.size
        assertTrue(view.client.shouldOverrideUrlLoading(view, FakeRequest(blob)))
        assertEquals(listOf("offer downloads w1 $blob main=true gesture=true"), log.since(mark))

        val data = "data:text/plain,x"
        assertTrue(view.client.shouldOverrideUrlLoading(view, FakeRequest(data, gesture = false)))
        assertEquals("offer downloads w1 $data main=true gesture=false", log.events.last())

        assertTrue(view.client.shouldOverrideUrlLoading(view, FakeRequest("https://example.com/a")))
        assertEquals(
            listOf("offer downloads w1 https://example.com/a main=true gesture=true", "open https://example.com/a"),
            log.events.takeLast(2),
        )
        assertFalse(view.client.shouldOverrideUrlLoading(view, FakeRequest("$origin/next")))
        assertEquals("offer downloads w1 $origin/next main=true gesture=true", log.events.last())

        val blocked = listOf(
            "http://127.0.0.1:41235/",
            // The server's native address and other local names are not the web origin.
            "http://127.0.0.1:41234/",
            "http://localhost:41234/",
            "http://$host:41235/",
            "intent://scan/#Intent;scheme=zxing;end",
            "file:///sdcard/a",
        )
        blocked.forEach { assertTrue(it, view.client.shouldOverrideUrlLoading(view, FakeRequest(it))) }
        assertTrue(log.events.none { it.startsWith("open") && !it.endsWith("example.com/a") })

        // Subframes are routed without an offer: generated content stays inside its frame.
        val before = log.size
        assertFalse(view.client.shouldOverrideUrlLoading(view, FakeRequest(blob, mainFrame = false)))
        assertEquals(before, log.size)
    }

    @Test
    fun requestsToOtherLocalNamesAreAnsweredLocally() {
        loaded()
        val view = platform.views.single()
        val blocked = view.client.shouldInterceptRequest(view, FakeRequest("http://127.0.0.1:9/x", mainFrame = false))
        assertEquals(403, blocked!!.statusCode)
        assertEquals(0, blocked.data.available())
        listOf("http://127.0.0.1:41234/x", "http://localhost:41234/x", "http://$host:9/x", "http://other.localhost:41234/x", "http://[::1]:41234/x")
            .forEach { assertEquals(it, 403, view.client.shouldInterceptRequest(view, FakeRequest(it, mainFrame = false))?.statusCode) }
        assertNull(view.client.shouldInterceptRequest(view, FakeRequest("$origin/x", mainFrame = false)))
        assertNull(view.client.shouldInterceptRequest(view, FakeRequest("https://example.com/x", mainFrame = false)))
        // Service worker fetches get the same check through the process-wide client.
        val serviceWorker = checkNotNull(platform.blockRequest)
        assertTrue(serviceWorker(Uri.parse("http://127.0.0.1:9/x")))
        assertTrue(serviceWorker(Uri.parse("http://127.0.0.1:41234/sw.js")))
        assertTrue(serviceWorker(Uri.parse("http://$host:9/x")))
        assertFalse(serviceWorker(Uri.parse("$origin/sw.js")))
        assertFalse(serviceWorker(Uri.parse("https://example.com/x")))
    }

    @Test
    fun popupsAreCaughtAndRoutedLikeMainFrameNavigations() {
        loaded()
        val opener = platform.views.single()
        downloads.takes = { it.scheme == "blob" }

        fun open(url: String, gesture: Boolean = true): RecordingWebView {
            val transport = opener.WebViewTransport()
            val message = Message.obtain(Handler(Looper.getMainLooper()), 0, transport)
            assertTrue(opener.chrome.onCreateWindow(opener, false, gesture, message))
            val catcher = transport.webView as RecordingWebView
            assertFalse(catcher.settings.javaScriptEnabled)
            assertTrue(catcher.client.shouldOverrideUrlLoading(catcher, FakeRequest(url, gesture = gesture)))
            idle()
            return catcher
        }

        open("https://example.com/popup")
        assertEquals("open https://example.com/popup", log.events.last { !it.startsWith("destroy") })
        assertTrue(log.events.contains("offer downloads w1 https://example.com/popup main=true gesture=true"))
        assertEquals("destroy w2", log.events.last())

        open("$origin/page")
        assertTrue(log.events.contains("load w1 $origin/page"))

        val blob = "blob:$origin/77"
        open(blob)
        assertTrue(log.events.contains("offer downloads w1 $blob main=true gesture=true"))

        val mark = log.size
        open("http://127.0.0.1:9/")
        assertTrue(log.since(mark).none { it.startsWith("open") || it.startsWith("load") })
    }

    @Test
    fun popupCatchersAnswerEveryRequestLocallyAndTimeOut() {
        loaded()
        val opener = platform.views.single()
        val transport = opener.WebViewTransport()
        assertTrue(opener.chrome.onCreateWindow(opener, false, true, Message.obtain(Handler(Looper.getMainLooper()), 0, transport)))
        val catcher = checkNotNull(transport.webView)
        val response = catcher.client.shouldInterceptRequest(catcher, FakeRequest("https://example.com/x", mainFrame = false))
        assertEquals(403, response!!.statusCode)
        // Its console messages are taken, so Chromium does not log them with the opener's URL.
        val message = ConsoleMessage("blocked", "http://sb-aaaaaaaaaaaaaaaaaaaaaaaaaa.localhost:1/", 1, ConsoleMessage.MessageLevel.LOG)
        assertTrue(checkNotNull(catcher.chrome).onConsoleMessage(message))
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(WebShell.POPUP_TIMEOUT_MILLIS))
        assertTrue(shadowOf(catcher).wasDestroyCalled())
        assertTrue(log.events.none { it.startsWith("open") })
    }

    @Test
    fun aPopupWaitsPastAboutBlankForItsRealTarget() {
        loaded()
        val opener = platform.views.single()
        val transport = opener.WebViewTransport()
        assertTrue(opener.chrome.onCreateWindow(opener, false, true, Message.obtain(Handler(Looper.getMainLooper()), 0, transport)))
        val catcher = checkNotNull(transport.webView)
        assertTrue(catcher.client.shouldOverrideUrlLoading(catcher, FakeRequest("about:blank")))
        idle()
        assertFalse(shadowOf(catcher).wasDestroyCalled())
        assertTrue(log.events.none { it.startsWith("open") })
        assertTrue(catcher.client.shouldOverrideUrlLoading(catcher, FakeRequest("https://example.com/later")))
        idle()
        assertEquals("open https://example.com/later", log.events.last { it.startsWith("open") })
        assertTrue(shadowOf(catcher).wasDestroyCalled())
    }

    @Test
    fun aStaleWebViewCannotOpenWindows() {
        val shell = loaded()
        val old = platform.views.single()
        shell.bind(LaunchSession(41_300, "cd".repeat(32)), address, chooser, downloads)
        val transport = old.WebViewTransport()
        assertFalse(old.chrome.onCreateWindow(old, false, true, Message.obtain(Handler(Looper.getMainLooper()), 0, transport)))
    }

    @Test
    fun jsDialogsHandTheAnswerBackToThePage() {
        val shell = loaded()
        val view = platform.views.single()
        val probe = JsResultProbe()

        val alert = probe.wire(Shadow.newInstanceOf(JsResult::class.java))
        assertTrue(view.chrome.onJsAlert(view, origin, "hello", alert))
        val shownAlert = shell.dialog as WebShell.JsDialog.Alert
        assertEquals("hello", shownAlert.message)
        shell.answerDialog(shownAlert, accept = false)
        assertTrue(probe.confirmed(alert))
        assertNull(shell.dialog)

        val confirm = Shadow.newInstanceOf(JsResult::class.java)
        assertTrue(view.chrome.onJsConfirm(view, origin, "sure?", confirm))
        shell.answerDialog(shell.dialog!!, accept = false)
        assertTrue(Shadow.extract<ShadowJsResult>(confirm).wasCancelled())

        val prompt = probe.wire(ShadowJsPromptResult.newInstance())
        assertTrue(view.chrome.onJsPrompt(view, origin, "name?", "bunny", prompt))
        val shownPrompt = shell.dialog as WebShell.JsDialog.Prompt
        assertEquals("bunny", shownPrompt.text)
        shownPrompt.text = "rabbit"
        shell.answerDialog(shownPrompt, accept = true)
        assertEquals("rabbit", probe.promptText(prompt))

        val leave = Shadow.newInstanceOf(JsResult::class.java)
        assertTrue(view.chrome.onJsBeforeUnload(view, origin, "", leave))
        assertTrue(shell.dialog is WebShell.JsDialog.BeforeUnload)
        shell.answerDialog(shell.dialog!!, accept = false)
        assertTrue(Shadow.extract<ShadowJsResult>(leave).wasCancelled())
    }

    @Test
    fun aSecondDialogWhileOneIsOpenIsDeclined() {
        val shell = loaded()
        val view = platform.views.single()
        val first = Shadow.newInstanceOf(JsResult::class.java)
        val second = Shadow.newInstanceOf(JsResult::class.java)
        view.chrome.onJsConfirm(view, origin, "1", first)
        view.chrome.onJsConfirm(view, origin, "2", second)
        assertTrue(Shadow.extract<ShadowJsResult>(second).wasCancelled())
        assertEquals("1", shell.dialog!!.message)
    }

    @Test
    fun teardownDeclinesAnOpenDialog() {
        val shell = loaded()
        val view = platform.views.single()
        val confirm = Shadow.newInstanceOf(JsResult::class.java)
        view.chrome.onJsConfirm(view, origin, "1", confirm)
        shell.release()
        assertTrue(Shadow.extract<ShadowJsResult>(confirm).wasCancelled())
    }

    @Test
    fun permissionRequestsGrantOnlyAllowedResourcesAfterTheAndroidPermission() {
        val app = Uri.parse("$origin/")
        val defaultShell = loaded()
        val view = platform.views.single()
        val camera = FakePermissionRequest(app, arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
        view.chrome.onPermissionRequest(camera)
        assertTrue(camera.denied)
        assertNull(defaultShell.permissionRequest)
        defaultShell.release()

        val policy = WebPermissionPolicy(setOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE, PermissionRequest.RESOURCE_PROTECTED_MEDIA_ID))
        val shell = loaded(policy)
        val current = checkNotNull(shell.webView)
        val media = FakePermissionRequest(app, arrayOf(PermissionRequest.RESOURCE_PROTECTED_MEDIA_ID, PermissionRequest.RESOURCE_VIDEO_CAPTURE))
        current.chrome.onPermissionRequest(media)
        assertEquals(listOf(PermissionRequest.RESOURCE_PROTECTED_MEDIA_ID), media.granted)

        val foreign = FakePermissionRequest(Uri.parse("https://example.com/"), arrayOf(PermissionRequest.RESOURCE_PROTECTED_MEDIA_ID))
        current.chrome.onPermissionRequest(foreign)
        assertTrue(foreign.denied)

        val microphone = FakePermissionRequest(app, arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
        current.chrome.onPermissionRequest(microphone)
        val pending = checkNotNull(shell.permissionRequest)
        assertEquals(listOf(android.Manifest.permission.RECORD_AUDIO), pending.missing)
        assertNull(microphone.granted)
        shell.onAndroidPermissionsResult(mapOf(android.Manifest.permission.RECORD_AUDIO to false))
        assertTrue(microphone.denied)

        val again = FakePermissionRequest(app, arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
        current.chrome.onPermissionRequest(again)
        shell.onAndroidPermissionsResult(mapOf(android.Manifest.permission.RECORD_AUDIO to true))
        assertEquals(listOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE), again.granted)
    }

    @Test
    fun geolocationIsAlwaysDenied() {
        loaded()
        val view = platform.views.single()
        var answer: Triple<String?, Boolean, Boolean>? = null
        view.chrome.onGeolocationPermissionsShowPrompt(
            origin,
            GeolocationPermissions.Callback { requester, allow, retain -> answer = Triple(requester, allow, retain) },
        )
        assertEquals(Triple<String?, Boolean, Boolean>(origin, false, false), answer)
        assertFalse(view.settings.getGeolocationEnabledCompat())
    }

    @Suppress("DEPRECATION")
    private fun android.webkit.WebSettings.getGeolocationEnabledCompat(): Boolean =
        (this as org.robolectric.fakes.RoboWebSettings).geolocationEnabled

    @Test
    fun backLeavesFullscreenBeforeHistoryAndStopsWithoutHistory() {
        val shell = loaded()
        val view = platform.views.single()
        var hidden = 0
        view.chrome.onShowCustomView(View(context), WebChromeClient.CustomViewCallback { hidden++ })
        assertNotNull(shell.fullscreen)
        // Two history entries: one step back is possible.
        shadowOf(view).pushEntryToHistory("$origin/")
        shadowOf(view).pushEntryToHistory("$origin/page2.html")
        assertTrue(shell.onBack())
        assertEquals(1, hidden)
        assertNull(shell.fullscreen)
        assertEquals(0, shadowOf(view).goBackInvocations)
        assertTrue(shell.onBack())
        assertEquals(1, shadowOf(view).goBackInvocations)
        // History is used up, so Back goes to the system.
        assertFalse(shell.onBack())
        assertFalse(shell.canGoBack)
    }

    @Test
    fun aSecondFullscreenViewIsRefused() {
        val shell = loaded()
        val view = platform.views.single()
        view.chrome.onShowCustomView(View(context), WebChromeClient.CustomViewCallback { })
        var refused = 0
        view.chrome.onShowCustomView(View(context), WebChromeClient.CustomViewCallback { refused++ })
        assertEquals(1, refused)
        view.chrome.onHideCustomView()
        assertNull(shell.fullscreen)
    }

    @Test
    fun onlyAKnownOldProviderShowsTheVersionWarning() {
        fun warningFor(versionName: String?): WebShell.VersionWarning? {
            platform.packageInfo = PackageInfo().apply {
                packageName = "com.google.android.webview"
                this.versionName = versionName
            }
            return shell().versionWarning
        }
        assertEquals(110, warningFor("110.0.5481.153")?.major)
        assertNull(warningFor("111.0.5563.116"))
        assertNull(warningFor(null))
        assertNull(warningFor("developer build"))
        platform.packageInfo = null
        assertNull(shell().versionWarning)
    }

    @Test
    fun theVersionWarningLinksToTheProviderAndTheBrowser() {
        platform.packageInfo = PackageInfo().apply {
            packageName = "com.google.android.webview"
            versionName = "100.0.4896.127"
        }
        val shell = shell()
        assertFalse(shell.openInBrowser(context))
        assertTrue(shell.openWebViewUpdate(context))
        assertEquals(Uri.parse("market://details?id=com.google.android.webview"), platform.opened.single())
        shell.bind(session, address, chooser, downloads)
        assertTrue(shell.openInBrowser(context))
        val handoff = platform.opened.last()
        assertEquals("$origin/__sillybunny/handoff", "${handoff.scheme}://${handoff.authority}${handoff.path}")
        assertFalse(handoff.toString().contains(token))
        shell.dismissVersionWarning()
        assertNull(shell.versionWarning)
    }

    @Test
    fun consoleMessagesAreConsumed() {
        loaded()
        val view = platform.views.single()
        assertTrue(view.chrome.onConsoleMessage(android.webkit.ConsoleMessage("m", "s", 1, android.webkit.ConsoleMessage.MessageLevel.LOG)))
    }

    @Test
    fun navigationsFromAnotherPageAreNotOfferedToDownloads() {
        loaded()
        val view = platform.views.single()
        downloads.takes = { true }
        view.loadUrl("https://openrouter.ai/auth")
        val mark = log.size
        assertTrue(view.client.shouldOverrideUrlLoading(view, FakeRequest("blob:https://openrouter.ai/x")))
        assertTrue(view.client.shouldOverrideUrlLoading(view, FakeRequest("data:text/plain,x")))
        assertTrue(log.since(mark).none { it.startsWith("offer") })
    }

    @Test
    fun theOpenRouterSignInLoadsInAppAndItsReturnIsReloadedWithTheCookie() {
        loaded()
        val view = platform.views.single()
        val start = "https://openrouter.ai/auth?callback_url=${Uri.encode("$origin/callback/openrouter")}&code_challenge=c&code_challenge_method=S256"
        val mark = log.size
        // authorizeOpenRouter() sets location.href after awaited work, so without a gesture.
        assertFalse(view.client.shouldOverrideUrlLoading(view, FakeRequest(start, gesture = false)))
        view.loadUrl(start)
        // The provider's own pages stay in-app; other sites still leave.
        assertFalse(view.client.shouldOverrideUrlLoading(view, FakeRequest("https://openrouter.ai/sign-in?redirect=1")))
        assertTrue(view.client.shouldOverrideUrlLoading(view, FakeRequest("https://accounts.example.com/login")))
        assertEquals("open https://accounts.example.com/login", log.events.last())
        // Requests to the provider are not local, so the containment lets them through.
        assertNull(view.client.shouldInterceptRequest(view, FakeRequest("https://openrouter.ai/api/x", mainFrame = false)))
        // The redirect back is cancelled and replaced by the URL the server's callback route leads to.
        assertTrue(view.client.shouldOverrideUrlLoading(view, FakeRequest("$origin/callback/openrouter?code=abc-1")))
        idle()
        assertEquals("load w1 $origin/?source=openrouter&query=code%3Dabc-1", log.events.last())
        assertTrue(log.since(mark).none { it.startsWith("offer") })
        assertEquals(1, log.since(mark).count { it.startsWith("open") })
    }

    @Test
    fun aRedirectStraightBackIsReplacedToo() {
        loaded()
        val view = platform.views.single()
        val start = "https://openrouter.ai/auth?callback_url=${Uri.encode("$origin/callback/openrouter")}"
        assertFalse(view.client.shouldOverrideUrlLoading(view, FakeRequest(start)))
        // No provider page committed: its answer redirected to the callback at once.
        assertTrue(view.client.shouldOverrideUrlLoading(view, FakeRequest("$origin/callback/openrouter?code=2")))
        idle()
        assertEquals("load w1 $origin/?source=openrouter&query=code%3D2", log.events.last())
    }

    @Test
    fun onlyTheAppsOwnOpenRouterStartLoadsInApp() {
        loaded()
        val view = platform.views.single()
        listOf(
            "https://openrouter.ai/auth?callback_url=${Uri.encode("http://127.0.0.1:41234/callback/openrouter")}",
            "https://openrouter.ai/auth?callback_url=${Uri.encode("https://evil.example/callback/openrouter")}",
            "https://openrouter.ai/keys",
            "https://openrouter.ai.evil.example/auth?callback_url=${Uri.encode("$origin/callback/openrouter")}",
        ).forEach {
            assertTrue(it, view.client.shouldOverrideUrlLoading(view, FakeRequest(it)))
            assertEquals("open $it", log.events.last())
        }
        // Not in a sign-in: a callback navigation is an ordinary app navigation.
        val mark = log.size
        assertFalse(view.client.shouldOverrideUrlLoading(view, FakeRequest("$origin/callback/openrouter?code=1")))
        idle()
        assertTrue(log.since(mark).none { it.startsWith("load") })
        // A start from a subframe is not a sign-in either.
        val start = "https://openrouter.ai/auth?callback_url=${Uri.encode("$origin/callback/openrouter")}"
        assertFalse(view.client.shouldOverrideUrlLoading(view, FakeRequest(start, mainFrame = false)))
        assertFalse(view.client.shouldOverrideUrlLoading(view, FakeRequest("$origin/callback/openrouter?code=3")))
        idle()
        assertTrue(log.since(mark).none { it.startsWith("load") })
    }

    @Test
    fun theAppOriginLoadingAgainEndsTheSignIn() {
        loaded()
        val view = platform.views.single()
        val start = "https://openrouter.ai/auth?callback_url=${Uri.encode("$origin/callback/openrouter")}"
        assertFalse(view.client.shouldOverrideUrlLoading(view, FakeRequest(start)))
        view.client.onPageStarted(view, "$origin/", null)
        val mark = log.size
        assertFalse(view.client.shouldOverrideUrlLoading(view, FakeRequest("$origin/callback/openrouter?code=1")))
        idle()
        assertTrue(log.since(mark).none { it.startsWith("load") })
        assertTrue(view.client.shouldOverrideUrlLoading(view, FakeRequest("https://openrouter.ai/sign-in")))
        assertEquals("open https://openrouter.ai/sign-in", log.events.last())
    }

    @Test
    fun aSignInStartedInANewWindowOpensInPlace() {
        loaded()
        val opener = platform.views.single()
        val start = "https://openrouter.ai/auth?callback_url=${Uri.encode("$origin/callback/openrouter")}"
        val transport = opener.WebViewTransport()
        assertTrue(opener.chrome.onCreateWindow(opener, false, true, Message.obtain(Handler(Looper.getMainLooper()), 0, transport)))
        val catcher = transport.webView as RecordingWebView
        assertTrue(catcher.client.shouldOverrideUrlLoading(catcher, FakeRequest(start)))
        idle()
        assertTrue(log.events.contains("load w1 $start"))
        assertTrue(log.events.none { it.startsWith("open") })
    }

    @Test
    fun aFixtureProviderOnALocalNameIsLetThroughTheContainment() {
        val provider = Uri.parse("http://provider.localhost:45678")
        loaded(openRouter = provider)
        val view = platform.views.single()
        assertNull(view.client.shouldInterceptRequest(view, FakeRequest("http://provider.localhost:45678/auth", mainFrame = false)))
        assertEquals(403, view.client.shouldInterceptRequest(view, FakeRequest("http://provider.localhost:45679/", mainFrame = false))?.statusCode)
        val start = "http://provider.localhost:45678/auth?callback_url=${Uri.encode("$origin/callback/openrouter")}"
        assertFalse(view.client.shouldOverrideUrlLoading(view, FakeRequest(start)))
        view.loadUrl(start)
        assertTrue(view.client.shouldOverrideUrlLoading(view, FakeRequest("$origin/callback/openrouter?code=f")))
        idle()
        assertEquals("load w1 $origin/?source=openrouter&query=code%3Df", log.events.last())
    }

    private companion object {
        const val LABEL = "sb-abcdefghijklmnopqrstuvwxyz"
    }
}
