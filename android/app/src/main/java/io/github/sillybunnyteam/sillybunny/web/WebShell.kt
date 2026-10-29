package io.github.sillybunnyteam.sillybunny.web

import android.annotation.SuppressLint
import android.content.Context
import android.content.MutableContextWrapper
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.net.http.SslError
import android.os.Handler
import android.os.Looper
import android.os.Message
import android.os.SystemClock
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.GeolocationPermissions
import android.webkit.JsPromptResult
import android.webkit.JsResult
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.SslErrorHandler
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat
import androidx.core.net.toUri
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import io.github.sillybunnyteam.sillybunny.BuildConfig
import io.github.sillybunnyteam.sillybunny.R
import io.github.sillybunnyteam.sillybunny.server.LaunchSession

/**
 * Owns the app WebView for [WebScreen] (plan §4.5). All members are main-thread only unless noted.
 *
 * Lifetime: the shell is retained by an activity-scoped `ViewModel` ([WebShellHolder]), so activity
 * recreation for a configuration change keeps the same WebView, page, history, open dialog, fullscreen
 * view and pending callbacks; nothing reloads. The WebView is built on a [MutableContextWrapper] whose
 * base is the application context, so the provider never binds an Activity that later goes stale; the
 * base becomes the current Activity only while the view is mounted in that Activity's window. The
 * WebView is destroyed when the shell is released, when [bind] receives a different [LaunchSession] or
 * [WebAddress], and after renderer death (a fresh WebView replaces it).
 *
 * Origin: pages load from the per-install web origin `http://<label>.localhost:<port>` ([WebAddress]),
 * never from the server's native address [LaunchSession.origin]. The launch cookie is set for that origin
 * only, so it is host-only on the label.
 *
 * Hook order, as `WebIntegrations.kt` documents: [WebDownloads.attach] before the first load, then the
 * launch cookie, then `origin/` once the cookie callback reports success; navigations are offered to
 * [WebDownloads.handleNavigation] before routing, but only while the main frame shows the app origin;
 * teardown calls [WebFileChooser.cancelPending] and [WebDownloads.detach] before the WebView is destroyed.
 * The [WebDownloads] attached to a WebView serves it for its whole life; the latest [WebFileChooser]
 * passed to [bind] serves new chooser requests.
 *
 * OpenRouter sign-in (integration item 7): the frontend's navigation to [openRouter]`/auth` with the app's
 * own `callback_url` loads in this WebView, and so do the provider's own navigations while its page is
 * shown; everything else external still goes to `ACTION_VIEW`. The provider's redirect back to
 * `/callback/openrouter` is a cross-site navigation, which does not carry the `SameSite=Strict` launch
 * cookie, so the shell cancels it and loads the URL that the server's callback route leads to itself. The
 * provider page gets no bridge, downloads, file chooser or permissions: those serve the app origin only.
 */
internal class WebShell(
    private val appContext: Context,
    private val platform: WebShellPlatform = AndroidWebShellPlatform,
    private val permissionPolicy: WebPermissionPolicy = WebPermissionPolicy.DEFAULT,
    private val clock: () -> Long = SystemClock::elapsedRealtime,
    /** The OpenRouter origin whose sign-in may load in-app; device tests pass a fixture origin. */
    private val openRouter: Uri = WebNavigationPolicy.OPENROUTER_ORIGIN.toUri(),
) {
    /** Increments whenever the shell switches to a different WebView instance. */
    var generation by mutableIntStateOf(0)
        private set

    /** True when the cookie could not be set or the renderer keeps dying; [retry] starts over. */
    var loadFailed by mutableStateOf(false)
        private set

    var canGoBack by mutableStateOf(false)
        private set

    var fullscreen by mutableStateOf<FullscreenView?>(null)
        private set

    var dialog by mutableStateOf<JsDialog?>(null)
        private set

    var permissionRequest by mutableStateOf<PendingPermission?>(null)
        private set

    var versionWarning by mutableStateOf<VersionWarning?>(null)
        private set

    var webView: WebView? = null
        private set

    var session: LaunchSession? = null
        private set

    var address: WebAddress? = null
        private set

    /** The exact origin of the current session's pages; null before the first [bind]. */
    var appOrigin: AppOrigin? = null
        private set

    var isReleased = false
        private set

    private val handler = Handler(Looper.getMainLooper())
    private var contextWrapper: MutableContextWrapper? = null
    private var container: ViewGroup? = null
    private var fileChooser: WebFileChooser = NoWebFileChooser
    private var requestedDownloads: WebDownloads = NoWebDownloads
    private var attachedDownloads: WebDownloads = NoWebDownloads
    private val popups = mutableSetOf<WebView>()
    private val rendererDeaths = ArrayDeque<Long>()

    /** Set when the frontend started the OpenRouter sign-in in-app; cleared once the app origin loads again. */
    private var openRouterArmed = false

    init {
        val provider = platform.currentWebViewPackage(appContext)
        val major = WebViewVersion.parseMajor(provider?.versionName)
        if (WebViewVersion.isBelowMinimum(major)) {
            versionWarning = VersionWarning(major!!, provider?.packageName)
        }
    }

    /** Shows [session] on [address]'s web origin; called on every composition, so it only acts on changes. */
    fun bind(session: LaunchSession, address: WebAddress, fileChooser: WebFileChooser, downloads: WebDownloads) {
        check(!isReleased) { "released" }
        this.fileChooser = fileChooser
        requestedDownloads = downloads
        if (session == this.session && address == this.address) return
        teardownWebView()
        this.session = session
        this.address = address
        val app = address.appOrigin(session.port)
        appOrigin = app
        LaunchCookieContainment.app = app
        rendererDeaths.clear()
        startWebView()
    }

    /** Puts the current WebView into [container], an Activity-window view. */
    fun mount(container: ViewGroup) {
        this.container = container
        val view = webView ?: return
        val parent = view.parent as? ViewGroup
        // Switch the base before the view reaches the new window, and only while it is detached.
        if (parent !== container) parent?.removeView(view)
        contextWrapper?.baseContext = container.context
        if (view.parent == null) {
            container.addView(view, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        }
    }

    /** Takes the WebView out of [container] when its Activity window goes away. */
    fun unmount(container: ViewGroup) {
        if (this.container !== container) return
        this.container = null
        webView?.let { if (it.parent === container) container.removeView(it) }
        contextWrapper?.baseContext = appContext
    }

    /** Back: leaves fullscreen first, then WebView history. False when there was nothing to undo. */
    fun onBack(): Boolean {
        if (fullscreen != null) {
            exitFullscreen()
            return true
        }
        val view = webView ?: return false
        if (!view.canGoBack()) {
            // Stale state: stop intercepting so the next Back reaches the system.
            canGoBack = false
            return false
        }
        view.goBack()
        return true
    }

    fun exitFullscreen() {
        val current = fullscreen ?: return
        fullscreen = null
        current.callback.onCustomViewHidden()
    }

    fun answerDialog(answered: JsDialog, accept: Boolean) {
        if (dialog !== answered) return
        dialog = null
        answered.complete(accept)
    }

    fun onAndroidPermissionsResult(results: Map<String, Boolean>) {
        val pending = permissionRequest ?: return
        permissionRequest = null
        val granted = permissionPolicy.grantable(pending.candidates) { results[it] == true || isGranted(it) }
        if (granted.isEmpty()) pending.request.deny() else pending.request.grant(granted.toTypedArray())
    }

    fun dismissVersionWarning() {
        versionWarning = null
    }

    /**
     * Opens the current session in the browser (plan §3.3); false without a session or a browser. The browser then
     * holds the launch token as a cookie; see [io.github.sillybunnyteam.sillybunny.web.openInBrowser].
     */
    fun openInBrowser(context: Context): Boolean {
        val current = session ?: return false
        val web = address ?: return false
        return platform.openExternal(context, BrowserHandoff.uri(current, web))
    }

    /** Opens the store page of the current WebView provider; false when none could be opened. */
    fun openWebViewUpdate(context: Context): Boolean =
        WebViewVersion.updateUris(versionWarning?.providerPackage).any { platform.openExternal(context, it) }

    fun retry() {
        if (!loadFailed || isReleased || session == null) return
        rendererDeaths.clear()
        teardownWebView()
        startWebView()
    }

    fun release() {
        if (isReleased) return
        isReleased = true
        teardownWebView()
        popups.toList().forEach(::destroyPopup)
        handler.removeCallbacksAndMessages(null)
        session = null
    }

    private fun startWebView() {
        val current = checkNotNull(session)
        val app = checkNotNull(appOrigin)
        loadFailed = false
        val wrapper = MutableContextWrapper(appContext)
        val view = try {
            platform.configureProcess(LaunchCookieContainment::blocks)
            platform.newWebView(wrapper)
        } catch (e: RuntimeException) {
            // No usable WebView provider, for example while it is being updated: offer Retry and the browser.
            if (BuildConfig.DEBUG) Log.w(TAG, "WebView unavailable", e)
            loadFailed = true
            return
        }
        configure(view, app)
        contextWrapper = wrapper
        webView = view
        canGoBack = false
        attachedDownloads = requestedDownloads
        attachedDownloads.attach(view, current)
        generation++
        container?.let(::mount)
        // The cookie callback is the barrier: the first request for origin/ must carry the launch cookie.
        var settled = false
        val timeout = Runnable {
            if (!settled && webView === view) {
                settled = true
                loadFailed = true
            }
        }
        handler.postDelayed(timeout, COOKIE_TIMEOUT_MILLIS)
        // Set for the web origin only and without a Domain attribute, so the cookie is host-only on the label.
        platform.setCookie(app.url, launchCookie(current)) { accepted ->
            handler.removeCallbacks(timeout)
            // A late answer after the timeout is ignored; Retry starts over with a fresh WebView.
            if (settled || webView !== view || isReleased) return@setCookie
            settled = true
            if (accepted) view.loadUrl(app.url + "/") else loadFailed = true
        }
    }

    @SuppressLint("SetJavaScriptEnabled") // The frontend is a JavaScript app; only its exact origin loads.
    private fun configure(view: WebView, app: AppOrigin) {
        view.setBackgroundColor(ContextCompat.getColor(appContext, R.color.charcoal_canvas))
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            @Suppress("DEPRECATION") // Deprecated defaults; set explicitly so no provider can differ.
            allowFileAccessFromFileURLs = false
            @Suppress("DEPRECATION")
            allowUniversalAccessFromFileURLs = false
            setGeolocationEnabled(false)
            setSupportMultipleWindows(true)
            javaScriptCanOpenWindowsAutomatically = false
            // TTS, previews and notification sounds start after async work, without a fresh gesture.
            mediaPlaybackRequiresUserGesture = false
        }
        view.webViewClient = ShellWebViewClient(app)
        view.webChromeClient = ShellChromeClient(app)
    }

    private fun teardownWebView() {
        val view = webView ?: return
        webView = null
        canGoBack = false
        openRouterArmed = false
        dialog?.let {
            dialog = null
            it.complete(false)
        }
        fullscreen?.let {
            fullscreen = null
            it.callback.onCustomViewHidden()
        }
        permissionRequest?.let {
            permissionRequest = null
            runCatching { it.request.deny() }
        }
        fileChooser.cancelPending()
        attachedDownloads.detach(view)
        attachedDownloads = NoWebDownloads
        (view.parent as? ViewGroup)?.removeView(view)
        contextWrapper?.baseContext = appContext
        contextWrapper = null
        view.stopLoading()
        view.destroy()
    }

    /** Routes a navigation; true when the WebView must not load it itself. */
    private fun onNavigation(view: WebView, url: Uri, isMainFrame: Boolean, hasGesture: Boolean, newWindow: Boolean): Boolean {
        val app = appOrigin
        if (view !== webView || app == null) return true
        val topLevel = isMainFrame || newWindow
        if (topLevel) {
            // The page that started it: the main frame's current document (the opener's, for a new window).
            val page = view.url?.toUri()
            routeOpenRouter(view, url, page, app, newWindow)?.let { return it }
            // Downloads serve the app origin only, never the OpenRouter page.
            if (WebNavigationPolicy.isAppUrl(page, app) && attachedDownloads.handleNavigation(view, url, true, hasGesture)) {
                return true
            }
        }
        return when (WebNavigationPolicy.route(url, app, topLevel, hasGesture)) {
            WebRoute.InApp -> {
                // A new window for the app origin opens in place; there is one app window.
                if (newWindow) view.loadUrl(url.toString())
                newWindow
            }
            WebRoute.External -> {
                platform.openExternal(container?.context ?: appContext, url)
                true
            }
            WebRoute.Block -> true
        }
    }

    /**
     * The OpenRouter exception (integration item 7) for a top-level navigation that [page] started; null
     * when it does not apply. Only the exact [openRouter] origin loads in-app, and only once the app origin
     * started the sign-in or while the provider's page is shown. The redirect back to the app's callback is
     * replaced by an app-initiated load, which carries the launch cookie.
     */
    private fun routeOpenRouter(view: WebView, url: Uri, page: Uri?, app: AppOrigin, newWindow: Boolean): Boolean? {
        val inFlow = openRouterArmed || WebNavigationPolicy.isSameOrigin(page, openRouter)
        if (WebNavigationPolicy.isSameOrigin(url, openRouter)) {
            val starts = WebNavigationPolicy.isAppUrl(page, app) && WebNavigationPolicy.isOpenRouterStart(url, openRouter, app)
            if (!inFlow && !starts) return null
            openRouterArmed = true
            // A new window for it opens in place, like one for the app origin.
            if (newWindow) view.loadUrl(url.toString())
            return newWindow
        }
        if (!inFlow) return null
        val target = WebNavigationPolicy.openRouterReturn(url, app) ?: return null
        openRouterArmed = false
        // Not from inside shouldOverrideUrlLoading: the cancelled navigation ends first.
        handler.post { if (webView === view && !isReleased) view.loadUrl(target) }
        return true
    }

    private fun onRendererGone(view: WebView) {
        if (view in popups) {
            destroyPopup(view)
            return
        }
        if (view !== webView) return
        // The renderer is gone, so this WebView is unusable: tear it down now and start a fresh one.
        teardownWebView()
        val now = clock()
        rendererDeaths.addLast(now)
        while (rendererDeaths.first() < now - RENDERER_DEATH_WINDOW_MILLIS) rendererDeaths.removeFirst()
        if (rendererDeaths.size >= RENDERER_DEATH_LIMIT) {
            loadFailed = true
            return
        }
        handler.post { if (!isReleased && webView == null && session != null) startWebView() }
    }

    /**
     * `window.open` and `target=_blank` (plan §4.5): a hidden, script-less WebView receives the new
     * window only to learn its URL, which is then routed like a main-frame navigation of the opener. Every
     * request it would make is answered locally, so nothing, and no cookie, leaves through it.
     */
    private fun catchPopup(opener: WebView, isUserGesture: Boolean, resultMsg: Message): Boolean {
        val transport = resultMsg.obj as? WebView.WebViewTransport ?: return false
        val catcher = platform.newWebView(MutableContextWrapper(appContext))
        var settled = false
        fun settle(url: Uri?) {
            // Every new window starts at about:blank; wait for the real target or the timeout.
            if (settled || url?.toString() == BLANK) return
            settled = true
            handler.post { destroyPopup(catcher) }
            if (url != null && !isReleased) {
                onNavigation(opener, url, isMainFrame = true, hasGesture = isUserGesture, newWindow = true)
            }
        }
        catcher.settings.apply {
            javaScriptEnabled = false
            allowFileAccess = false
            allowContentAccess = false
            setGeolocationEnabled(false)
        }
        catcher.webViewClient = PopupCatcherClient(::settle)
        // Chromium logs the console messages that no client takes, with the opener's URL (and so the label) as
        // their source; a blocked data: popup adds one.
        catcher.webChromeClient = SilentChromeClient
        popups += catcher
        transport.webView = catcher
        resultMsg.sendToTarget()
        handler.postDelayed({ settle(null) }, POPUP_TIMEOUT_MILLIS)
        return true
    }

    private fun destroyPopup(popup: WebView) {
        if (!popups.remove(popup)) return
        popup.stopLoading()
        popup.destroy()
    }

    private fun isGranted(permission: String): Boolean =
        ContextCompat.checkSelfPermission(appContext, permission) == PackageManager.PERMISSION_GRANTED

    /** Takes a popup catcher's console messages, so that Chromium does not log them; see [catchPopup]. */
    private object SilentChromeClient : WebChromeClient() {
        override fun onConsoleMessage(consoleMessage: ConsoleMessage): Boolean = true
    }

    /** Learns a caught popup's target without loading anything; see [catchPopup]. */
    // MissingOnRenderProcessGone also flags the supertype constructor call of a Kotlin WebViewClient
    // subclass. This client implements onRenderProcessGone and returns true.
    @SuppressLint("MissingOnRenderProcessGone")
    private inner class PopupCatcherClient(private val settle: (Uri?) -> Unit) : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            settle(request.url)
            return true
        }

        override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
            if (url == null || url == BLANK) return
            view.stopLoading()
            settle(url.toUri())
        }

        // Runs off the main thread: answers every request locally and reports the main frame's URL.
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
            if (request.isForMainFrame) {
                val url = request.url
                handler.post { settle(url) }
            }
            return blockedResponse()
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            settle(null)
            return true
        }
    }

    // MissingOnRenderProcessGone also flags the supertype constructor call of a Kotlin WebViewClient
    // subclass. This client implements onRenderProcessGone and returns true.
    @SuppressLint("MissingOnRenderProcessGone")
    private inner class ShellWebViewClient(private val app: AppOrigin) : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
            onNavigation(view, request.url, request.isForMainFrame, request.hasGesture(), newWindow = false)

        // Runs off the main thread; reads only [app] and [openRouter]. The real OpenRouter origin is never a
        // local name; device tests serve a fixture provider on one.
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            val url = request.url
            val refused = WebNavigationPolicy.refusesRequest(url, app) && !WebNavigationPolicy.isSameOrigin(url, openRouter)
            return if (refused) blockedResponse() else null
        }

        override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
            // Back on the app origin: the OpenRouter sign-in is over, or was left.
            if (view === webView && WebNavigationPolicy.isAppUrl(url?.toUri(), app)) openRouterArmed = false
        }

        override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
            if (view === webView) canGoBack = view.canGoBack()
        }

        override fun onPageFinished(view: WebView, url: String?) {
            if (view === webView) canGoBack = view.canGoBack()
        }

        @SuppressLint("WebViewClientOnReceivedSslError") // Always cancels; never proceeds.
        override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
            handler.cancel()
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            onRendererGone(view)
            return true
        }
    }

    private inner class ShellChromeClient(private val app: AppOrigin) : WebChromeClient() {
        override fun onJsAlert(view: WebView, url: String?, message: String?, result: JsResult): Boolean =
            show(view, JsDialog.Alert(message.orEmpty(), result))

        override fun onJsConfirm(view: WebView, url: String?, message: String?, result: JsResult): Boolean =
            show(view, JsDialog.Confirm(message.orEmpty(), result))

        override fun onJsPrompt(
            view: WebView,
            url: String?,
            message: String?,
            defaultValue: String?,
            result: JsPromptResult,
        ): Boolean = show(view, JsDialog.Prompt(message.orEmpty(), defaultValue.orEmpty(), result))

        override fun onJsBeforeUnload(view: WebView, url: String?, message: String?, result: JsResult): Boolean =
            show(view, JsDialog.BeforeUnload(message.orEmpty(), result))

        private fun show(view: WebView, request: JsDialog): Boolean {
            if (view !== webView || dialog != null) {
                request.complete(false)
            } else {
                dialog = request
            }
            return true
        }

        override fun onShowCustomView(view: View, callback: CustomViewCallback) {
            if (webView == null || fullscreen != null) {
                callback.onCustomViewHidden()
                return
            }
            fullscreen = FullscreenView(view, callback)
        }

        override fun onHideCustomView() {
            fullscreen = null
        }

        override fun onPermissionRequest(request: PermissionRequest) {
            val candidates = permissionPolicy.candidates(request.origin, app, request.resources)
            if (candidates.isEmpty()) {
                request.deny()
                return
            }
            val missing = permissionPolicy.missingAndroidPermissions(candidates, ::isGranted)
            when {
                missing.isEmpty() -> request.grant(candidates.toTypedArray())
                permissionRequest != null -> request.deny()
                else -> permissionRequest = PendingPermission(request, candidates, missing)
            }
        }

        override fun onPermissionRequestCanceled(request: PermissionRequest) {
            if (permissionRequest?.request === request) permissionRequest = null
        }

        override fun onGeolocationPermissionsShowPrompt(origin: String?, callback: GeolocationPermissions.Callback) {
            callback.invoke(origin, false, false)
        }

        override fun onConsoleMessage(consoleMessage: ConsoleMessage): Boolean {
            if (BuildConfig.DEBUG) {
                // Chromium's messages can name the page's origin, and so the label.
                Log.d(TAG, "${consoleMessage.messageLevel()} ${consoleMessage.lineNumber()}: ${WebAddress.redact(consoleMessage.message())}")
            }
            return true
        }

        override fun onShowFileChooser(
            webView: WebView,
            filePathCallback: ValueCallback<Array<Uri>>,
            fileChooserParams: FileChooserParams,
        ): Boolean {
            if (webView !== this@WebShell.webView || !WebNavigationPolicy.isAppUrl(webView.url?.toUri(), app)) {
                filePathCallback.onReceiveValue(null)
                return true
            }
            return fileChooser.show(webView, filePathCallback, fileChooserParams)
        }

        override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean =
            view === webView && catchPopup(view, isUserGesture, resultMsg)

        override fun onCloseWindow(window: WebView) {
            // The app window ignores window.close(); a popup catcher closes for good.
            if (window in popups) destroyPopup(window)
        }
    }

    /** A JavaScript dialog waiting for the user; [complete] hands the answer back to the page. */
    sealed class JsDialog(val message: String) {
        abstract fun complete(accept: Boolean)

        class Alert(message: String, private val result: JsResult) : JsDialog(message) {
            override fun complete(accept: Boolean) = result.confirm()
        }

        class Confirm(message: String, private val result: JsResult) : JsDialog(message) {
            override fun complete(accept: Boolean) = if (accept) result.confirm() else result.cancel()
        }

        class Prompt(message: String, defaultValue: String, private val result: JsPromptResult) : JsDialog(message) {
            /** The text field's current value; kept here so it survives activity recreation. */
            var text by mutableStateOf(defaultValue)

            override fun complete(accept: Boolean) = if (accept) result.confirm(text) else result.cancel()
        }

        /** `beforeunload`: accept leaves the page, decline stays. */
        class BeforeUnload(message: String, private val result: JsResult) : JsDialog(message) {
            override fun complete(accept: Boolean) = if (accept) result.confirm() else result.cancel()
        }
    }

    class FullscreenView(val view: View, val callback: WebChromeClient.CustomViewCallback)

    /** A web permission request waiting for Android permissions [missing]. */
    class PendingPermission(val request: PermissionRequest, val candidates: List<String>, val missing: List<String>) {
        /** Set once the Android request is shown, so a recreated screen does not ask twice. */
        var launched = false
    }

    class VersionWarning(val major: Int, val providerPackage: String?)

    companion object {
        private const val TAG = "SillyBunnyWeb"
        private const val BLANK = "about:blank"
        const val COOKIE_TIMEOUT_MILLIS = 10_000L
        const val POPUP_TIMEOUT_MILLIS = 10_000L
        const val RENDERER_DEATH_LIMIT = 3
        const val RENDERER_DEATH_WINDOW_MILLIS = 60_000L

        fun launchCookie(session: LaunchSession): String =
            "${LaunchSession.COOKIE_NAME}=${session.token}; HttpOnly; SameSite=Strict; Path=/"
    }
}

/**
 * Process-wide request containment for requests that bypass [WebViewClient]: service worker fetches.
 * The app origin is the current session's; without one, every request to a local name is refused.
 */
internal object LaunchCookieContainment {
    @Volatile
    var app: AppOrigin? = null

    fun blocks(url: Uri): Boolean = WebNavigationPolicy.refusesRequest(url, app)
}

/** Keeps one [WebShell] per Activity across configuration changes. */
internal class WebShellHolder(private val create: () -> WebShell) : ViewModel() {
    private var shell: WebShell? = null

    fun shell(): WebShell = shell?.takeUnless { it.isReleased } ?: create().also { shell = it }

    override fun onCleared() {
        shell?.release()
        shell = null
    }

    companion object {
        const val KEY = "io.github.sillybunnyteam.sillybunny.web.WebShell"

        fun factory(create: () -> WebShell): ViewModelProvider.Factory = object : ViewModelProvider.Factory {
            override fun <T : ViewModel> create(modelClass: Class<T>): T {
                require(modelClass == WebShellHolder::class.java) { "modelClass" }
                @Suppress("UNCHECKED_CAST")
                return WebShellHolder(create) as T
            }
        }
    }
}
