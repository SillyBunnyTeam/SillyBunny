package io.github.sillybunnyteam.sillybunny.web

import android.content.Context
import android.content.pm.PackageInfo
import android.net.Uri
import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import androidx.webkit.ServiceWorkerClientCompat
import androidx.webkit.ServiceWorkerControllerCompat
import androidx.webkit.WebViewFeature
import io.github.sillybunnyteam.sillybunny.BuildConfig

/** The provider calls the WebView shell makes, behind one seam so the shell's order is testable. */
internal interface WebShellPlatform {
    fun newWebView(context: Context): WebView

    /** Sets [value] for [url]; [done] runs on the calling (UI) thread with the provider's result. */
    fun setCookie(url: String, value: String, done: (Boolean) -> Unit)

    /** Applies process-wide WebView policy once: debugging and service worker containment. */
    fun configureProcess(blockRequest: (Uri) -> Boolean)

    /** Applies process-wide WebView policy once, including service worker static asset serving. */
    fun configureProcess(
        blockRequest: (Uri) -> Boolean,
        interceptRequest: (WebResourceRequest) -> WebResourceResponse?,
    ) = configureProcess(blockRequest)

    /** Initializes the cookie store during prewarm before a session port or token exists. */
    fun warmCookieManager() {}

    /** Spins up the renderer process on a prewarmed [webView] without loading an app URL. */
    fun warmRenderer(webView: WebView) {}

    fun currentWebViewPackage(context: Context): PackageInfo?

    /** Opens [uri] in another app; false when nothing handled it. */
    fun openExternal(context: Context, uri: Uri): Boolean
}

internal object AndroidWebShellPlatform : WebShellPlatform {
    private var processConfigured = false

    override fun newWebView(context: Context): WebView = WebView(context)

    override fun setCookie(url: String, value: String, done: (Boolean) -> Unit) {
        val cookies = CookieManager.getInstance()
        cookies.setAcceptCookie(true)
        // The callback is the completion barrier; flush() only persists cookies.
        cookies.setCookie(url, value) { accepted -> done(accepted == true) }
    }

    override fun warmCookieManager() {
        CookieManager.getInstance().setAcceptCookie(true)
    }

    override fun warmRenderer(webView: WebView) {
        webView.loadUrl("about:blank")
    }

    override fun configureProcess(blockRequest: (Uri) -> Boolean) =
        configureProcess(blockRequest) { null }

    override fun configureProcess(
        blockRequest: (Uri) -> Boolean,
        interceptRequest: (WebResourceRequest) -> WebResourceResponse?,
    ) {
        if (processConfigured) return
        // Recent providers turn debugging on for debuggable apps by themselves, so set it either way.
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        // Set only once the provider answered, so a provider that is missing now is configured later.
        processConfigured = true
        try {
            if (!WebViewFeature.isFeatureSupported(WebViewFeature.SERVICE_WORKER_BASIC_USAGE)) return
            val controller = ServiceWorkerControllerCompat.getInstance()
            val settings = controller.serviceWorkerWebSettings
            if (WebViewFeature.isFeatureSupported(WebViewFeature.SERVICE_WORKER_CONTENT_ACCESS)) {
                settings.allowContentAccess = false
            }
            if (WebViewFeature.isFeatureSupported(WebViewFeature.SERVICE_WORKER_FILE_ACCESS)) {
                settings.allowFileAccess = false
            }
            if (WebViewFeature.isFeatureSupported(WebViewFeature.SERVICE_WORKER_SHOULD_INTERCEPT_REQUEST)) {
                // Service worker fetches bypass WebViewClient, so they get the same containment and static serving here.
                controller.setServiceWorkerClient(
                    object : ServiceWorkerClientCompat() {
                        override fun shouldInterceptRequest(
                            request: WebResourceRequest,
                        ): WebResourceResponse? =
                            if (blockRequest(request.url)) blockedResponse() else interceptRequest(request)
                    },
                )
            }
        } catch (_: UnsupportedOperationException) {
            // Provider without WebView support-library glue, such as Robolectric's shadow provider.
        } catch (_: LinkageError) {
            // WebViewGlueCommunicator.<clinit> wraps missing provider glue in ExceptionInInitializerError.
        }
    }

    override fun currentWebViewPackage(context: Context): PackageInfo? = WebViewVersion.currentPackage(context)

    override fun openExternal(context: Context, uri: Uri): Boolean = startViewIntent(context, uri)
}

/** An empty 403 that stands in for a request the shell must not send. */
internal fun blockedResponse(): WebResourceResponse =
    WebResourceResponse(
        "text/plain",
        "utf-8",
        403,
        "Forbidden",
        mapOf("Cache-Control" to "no-store"),
        java.io.ByteArrayInputStream(ByteArray(0)),
    )
