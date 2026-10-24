package io.github.sillybunnyteam.sillybunny.web

import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.net.Uri
import android.util.AndroidRuntimeException
import android.webkit.JsResult
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import io.github.sillybunnyteam.sillybunny.server.LaunchSession
import java.lang.reflect.Proxy

/** One ordered log shared by every fake, so tests can check the order of hook calls. */
internal class EventLog {
    val events = mutableListOf<String>()

    operator fun plusAssign(event: String) {
        events += event
    }

    fun since(mark: Int): List<String> = events.drop(mark)

    val size: Int get() = events.size
}

internal class CookieCall(val url: String, val value: String, val done: (Boolean) -> Unit)

internal class FakeWebShellPlatform(private val log: EventLog) : WebShellPlatform {
    val views = mutableListOf<RecordingWebView>()
    val cookies = mutableListOf<CookieCall>()
    val opened = mutableListOf<Uri>()
    var configureCalls = 0
    var blockRequest: ((Uri) -> Boolean)? = null
    var packageInfo: PackageInfo? = null
    var failNewWebView = false

    override fun newWebView(context: Context): WebView {
        if (failNewWebView) throw AndroidRuntimeException("no WebView provider")
        return RecordingWebView(context, "w${views.size + 1}", log).also { views += it }
    }

    override fun setCookie(url: String, value: String, done: (Boolean) -> Unit) {
        log += "cookie $url"
        cookies += CookieCall(url, value, done)
    }

    override fun configureProcess(blockRequest: (Uri) -> Boolean) {
        configureCalls++
        this.blockRequest = blockRequest
    }

    override fun currentWebViewPackage(context: Context): PackageInfo? = packageInfo

    override fun openExternal(context: Context, uri: Uri): Boolean {
        log += "open $uri"
        opened += uri
        return true
    }
}

internal class RecordingWebView(context: Context, private val name: String, private val log: EventLog) : WebView(context) {
    override fun loadUrl(url: String) {
        log += "load $name $url"
        super.loadUrl(url)
    }

    override fun destroy() {
        log += "destroy $name"
        super.destroy()
    }

    override fun toString(): String = name
}

internal class RecordingChooser(private val log: EventLog, private val name: String = "chooser") : WebFileChooser {
    val callbacks = mutableListOf<ValueCallback<Array<Uri>>>()

    override fun show(webView: WebView, callback: ValueCallback<Array<Uri>>, params: WebChromeClient.FileChooserParams): Boolean {
        log += "show $name $webView"
        callbacks += callback
        return true
    }

    override fun cancelPending() {
        log += "cancel $name"
    }
}

internal class RecordingDownloads(private val log: EventLog, private val name: String = "downloads") : WebDownloads {
    var takes: (Uri) -> Boolean = { false }

    override fun attach(webView: WebView, session: LaunchSession) {
        log += "attach $name $webView ${session.port}"
    }

    override fun handleNavigation(webView: WebView, url: Uri, isMainFrame: Boolean, hasGesture: Boolean): Boolean {
        log += "offer $name $webView $url main=$isMainFrame gesture=$hasGesture"
        return takes(url)
    }

    override fun detach(webView: WebView) {
        log += "detach $name $webView"
    }
}

internal class FakeRequest(
    url: String,
    private val mainFrame: Boolean = true,
    private val gesture: Boolean = true,
    private val method: String = "GET",
) : WebResourceRequest {
    private val uri = Uri.parse(url)

    override fun getUrl(): Uri = uri

    override fun isForMainFrame(): Boolean = mainFrame

    override fun isRedirect(): Boolean = false

    override fun hasGesture(): Boolean = gesture

    override fun getMethod(): String = method

    override fun getRequestHeaders(): Map<String, String> = emptyMap()
}

internal class FakeChooserParams : WebChromeClient.FileChooserParams() {
    override fun getMode(): Int = MODE_OPEN

    override fun getAcceptTypes(): Array<String> = arrayOf("")

    override fun isCaptureEnabled(): Boolean = false

    override fun getTitle(): CharSequence? = null

    override fun getFilenameHint(): String? = null

    override fun createIntent(): Intent = Intent(Intent.ACTION_GET_CONTENT)
}

internal class FakePermissionRequest(private val origin: Uri, private val resources: Array<String>) : PermissionRequest() {
    var granted: List<String>? = null
    var denied = false

    override fun getOrigin(): Uri = origin

    override fun getResources(): Array<String> = resources

    override fun grant(resources: Array<String>) {
        granted = resources.toList()
    }

    override fun deny() {
        denied = true
    }
}

// The platform deprecates constructing this class in apps; a test needs a detail to hand to the client.
@Suppress("DEPRECATION")
internal class FakeRenderProcessGoneDetail(private val crashed: Boolean = true) : RenderProcessGoneDetail() {
    override fun didCrash(): Boolean = crashed

    override fun rendererPriorityAtExit(): Int = WebView.RENDERER_PRIORITY_BOUND
}

internal class RecordingValueCallback<T> : ValueCallback<T> {
    val values = mutableListOf<T?>()

    override fun onReceiveValue(value: T?) {
        values += value
    }
}

/**
 * Wires a framework [JsResult] to a receiver, so `confirm()` completes as it would in a WebView. The
 * receiver interface and field are hidden framework API, reached by reflection in tests only.
 */
internal class JsResultProbe {
    var completed = 0
        private set

    fun <T : JsResult> wire(result: T): T {
        val receiverType = Class.forName("android.webkit.JsResult\$ResultReceiver")
        val receiver = Proxy.newProxyInstance(receiverType.classLoader, arrayOf(receiverType)) { _, method, _ ->
            if (method.name == "onJsResultComplete") completed++
            null
        }
        JsResult::class.java.getDeclaredField("mReceiver").apply { isAccessible = true }.set(result, receiver)
        return result
    }

    fun confirmed(result: JsResult): Boolean =
        JsResult::class.java.getDeclaredField("mResult").apply { isAccessible = true }.getBoolean(result)

    fun promptText(result: JsResult): String? =
        result.javaClass.getDeclaredField("mStringResult").apply { isAccessible = true }.get(result) as String?
}
