package io.github.sillybunnyteam.sillybunny.web.downloads

import android.app.Activity
import android.app.Application
import android.content.ClipData
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.SystemClock
import android.provider.MediaStore
import android.util.Log
import android.webkit.DownloadListener
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.activity.compose.LocalActivityResultRegistryOwner
import androidx.activity.compose.setContent
import androidx.activity.result.ActivityResultRegistry
import androidx.activity.result.ActivityResultRegistryOwner
import androidx.activity.result.contract.ActivityResultContract
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.remember
import androidx.core.app.ActivityOptionsCompat
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import io.github.sillybunnyteam.sillybunny.R
import io.github.sillybunnyteam.sillybunny.server.LaunchSession
import io.github.sillybunnyteam.sillybunny.web.WebAddress
import io.github.sillybunnyteam.sillybunny.web.WebDownloads
import io.github.sillybunnyteam.sillybunny.web.WebFileChooser
import io.github.sillybunnyteam.sillybunny.web.WebScreen
import io.github.sillybunnyteam.sillybunny.web.WebShell
import io.github.sillybunnyteam.sillybunny.web.files.ContentUriPolicy
import io.github.sillybunnyteam.sillybunny.web.files.SafFileChooser
import io.github.sillybunnyteam.sillybunny.web.files.rememberSafFileChooser
import io.github.sillybunnyteam.sillybunny.web.retainedWebShell
import java.io.ByteArrayOutputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.regex.Pattern
import kotlin.math.roundToInt
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener

/**
 * The host fixture server (`fixtures/transfer-server.mjs`): the real launch-token middleware in front
 * of the transfer fixture pages, reached through `adb reverse`. Ports and token come from the
 * instrumentation arguments `fixturePort`, `fixtureOther` and `fixtureToken`. The pages load from the
 * app's per-install web origin [webOrigin]; the fixture's own control requests use its native address
 * [origin]. The fixture logs URLs with the label replaced by `<label>`.
 */
internal class TransferFixture {
    private val args = InstrumentationRegistry.getArguments()
    val port: Int = requireNotNull(args.getString("fixturePort")) { "run with -e fixturePort <port>" }.toInt()
    val otherPort: Int = requireNotNull(args.getString("fixtureOther")) { "run with -e fixtureOther <port>" }.toInt()
    val token: String = requireNotNull(args.getString("fixtureToken")) { "run with -e fixtureToken <hex>" }
    val session = LaunchSession(port, token)

    /** The server's native address, `http://127.0.0.1:<port>`. */
    val origin = session.origin

    /** The web origin of the app's pages, `http://<label>.localhost:<port>`; keep it out of test output. */
    val webOrigin: String = WebAddress.forInstall(InstrumentationRegistry.getInstrumentation().targetContext).origin(session)

    class Request(
        val listener: String,
        val method: String,
        val url: String,
        val status: Int,
        val launchCookie: Boolean,
        val anyCookie: Boolean,
        /** The kind of host name the request used: `ip`, `localhost`, `label`, ... */
        val host: String,
    ) {
        override fun toString() = "$listener $method $host $url $status cookie=$launchCookie/$anyCookie"
    }

    fun requests(): List<Request> {
        val array = JSONArray(get("/__fixture/log"))
        return (0 until array.length()).map {
            val entry = array.getJSONObject(it)
            Request(
                entry.getString("listener"),
                entry.getString("method"),
                entry.getString("url"),
                entry.getInt("status"),
                entry.getBoolean("launchCookie"),
                entry.getBoolean("anyCookie"),
                entry.optString("host"),
            )
        }
    }

    /** App-port requests whose path starts with [prefix]. */
    fun app(prefix: String): List<Request> = requests().filter { it.listener == "app" && it.url.startsWith(prefix) }

    /** Requests that reached the other loopback port. */
    fun escaped(): List<Request> = requests().filter { it.listener == "other" }

    fun reset() {
        get("/__fixture/reset")
    }

    private fun get(path: String): String {
        val connection = URL("$origin$path").openConnection() as HttpURLConnection
        return try {
            connection.connectTimeout = 5_000
            connection.readTimeout = 5_000
            connection.inputStream.bufferedReader().readText()
        } finally {
            connection.disconnect()
        }
    }
}

/**
 * Stands in for the activity's result registry: records every launch the host's launchers make and
 * answers it when the test says so, so a picker can stay "open" across steps such as recreation.
 */
internal class HostRegistry : ActivityResultRegistry() {
    class Launch(val requestCode: Int, val intent: Intent) {
        val action: String? get() = intent.action
        val title: String? get() = intent.getStringExtra(Intent.EXTRA_TITLE)
        val type: String? get() = intent.type

        override fun toString() = "$action type=$type title=$title"
    }

    private val launches = LinkedBlockingQueue<Launch>()

    override fun <I, O> onLaunch(requestCode: Int, contract: ActivityResultContract<I, O>, input: I, options: ActivityOptionsCompat?) {
        val launch = Launch(requestCode, input as Intent)
        HostWeb.note("launch $launch")
        launches += launch
    }

    fun next(timeoutMillis: Long = 15_000): Launch = checkNotNull(poll(timeoutMillis)) { "no picker was launched" }

    /** The next launch within [timeoutMillis], or null. */
    fun poll(timeoutMillis: Long): Launch? = launches.poll(timeoutMillis, TimeUnit.MILLISECONDS)

    /** Passes when nothing is launched within [millis]. */
    fun none(millis: Long = 2_000) {
        val launch = launches.poll(millis, TimeUnit.MILLISECONDS) ?: return
        throw AssertionError("unexpected launch: $launch")
    }

    fun answer(launch: Launch, resultCode: Int, data: Intent?): Boolean = onMain { dispatchResult(launch.requestCode, resultCode, data) }

    fun cancel(launch: Launch): Boolean = answer(launch, Activity.RESULT_CANCELED, null)
}

/**
 * The URI grants the stand-in picker gave this app. Results delivered through [HostRegistry] skip the
 * system, which would record the grants of a real picker's result; MediaStore items the test created
 * are readable anyway, so the system never records a grant for them. The policy under test asks this
 * table instead of `checkUriPermission`, except in [TransferHost.realPicker] runs.
 */
internal object Grants {
    private val granted = ConcurrentHashMap<Uri, Int>()

    fun give(uri: Uri, flags: Int) {
        granted.merge(uri, flags and (ContentUriPolicy.READ or ContentUriPolicy.WRITE)) { old, new -> old or new }
    }

    fun holds(uri: Uri, needed: Int): Boolean = (granted[uri] ?: 0) and needed == needed

    fun clear() = granted.clear()
}

/** The real platform without the bridge, as on a WebView that lacks the needed features. */
internal object NoBridgePlatform : TransferPlatform by AndroidTransferPlatform {
    override fun bridgeSupported(): Boolean = false
}

/** [delegate] with every download listener report recorded in [reports] before it is handled. */
private class ReportingPlatform(private val delegate: TransferPlatform, private val reports: MutableList<String>) :
    TransferPlatform by delegate {
    override fun setDownloadListener(webView: WebView, listener: DownloadListener?) {
        val reporting = listener?.let { inner ->
            DownloadListener { url, userAgent, disposition, mime, length ->
                HostWeb.note("download reported $url mime=$mime length=$length")
                reports += url
                inner.onDownloadStart(url, userAgent, disposition, mime, length)
            }
        }
        delegate.setDownloadListener(webView, reporting)
    }
}

/**
 * Hosts the app's own [WebScreen] for the transfer tests in the debug `ComponentActivity` from
 * `ui-test-manifest`, so they run inside the real shell: its WebView settings, its per-install web
 * origin, its navigation and request containment, and its WebView kept across activity recreation. The
 * chooser and the downloads come from the real factories, wrapped only to record what the shell hands
 * them. Unless [realPicker] is set, the activity result registry is replaced by [registry] and URI grants
 * are checked against [Grants].
 */
internal class TransferHost(
    val fixture: TransferFixture,
    val realPicker: Boolean = false,
    private val platform: TransferPlatform = AndroidTransferPlatform,
) : Application.ActivityLifecycleCallbacks, AutoCloseable {
    val registry = HostRegistry()
    val openInBrowserCalls = AtomicInteger()

    /** String resources of every toast the chooser and the downloads asked for, in order. */
    val notices = CopyOnWriteArrayList<Int>()

    /** `mode accept permission hint` of every request the shell handed to the chooser. */
    val chooserCalls = CopyOnWriteArrayList<String>()

    /** Every main-frame navigation the shell offered to the downloads, and whether it was taken. */
    val offers = CopyOnWriteArrayList<String>()

    /** URLs the WebView reported to the download listener. */
    val downloadReports = CopyOnWriteArrayList<String>()

    /** Destinations the downloads wrote to or discarded. */
    val outputs = CopyOnWriteArrayList<Uri>()
    val discarded = CopyOnWriteArrayList<Uri>()

    private val app = ApplicationProvider.getApplicationContext<Application>()
    private val registryOwner = object : ActivityResultRegistryOwner {
        override val activityResultRegistry: ActivityResultRegistry get() = registry
    }
    lateinit var scenario: ActivityScenario<ComponentActivity>
        private set

    // Main thread only.
    private var currentChooser: SafFileChooser? = null
    private var currentTransfers: WebTransfers? = null

    /**
     * Shows the shell, waits for its first page (`/`, which is `transfers.html`; [ready] says when it is) and then
     * opens [page] unless that is `transfers.html`.
     */
    fun launch(
        page: String = "transfers.html",
        firstPageMillis: Long = 30_000,
        keepVersionWarning: Boolean = false,
        ready: (WebView) -> Boolean = { HostWeb.ready(it, "") },
    ): TransferHost {
        Grants.clear()
        app.registerActivityLifecycleCallbacks(this)
        scenario = ActivityScenario.launch(ComponentActivity::class.java)
        HostWeb.waitFor("first page", firstPageMillis) { webViewOrNull()?.let(ready) == true }
        // API 29's WebView 74 is below the supported version: the shell's banner would cover the page's foot.
        val shell = shell()
        if (!keepVersionWarning) onMain { shell.dismissVersionWarning() }
        if (page != "transfers.html") open(page)
        return this
    }

    override fun onActivityPostCreated(activity: Activity, savedInstanceState: Bundle?) {
        if (activity.javaClass == ComponentActivity::class.java) {
            (activity as ComponentActivity).setContent { Content() }
        }
    }

    @Composable
    private fun Content() {
        if (realPicker) {
            Hosted()
        } else {
            CompositionLocalProvider(LocalActivityResultRegistryOwner provides registryOwner) { Hosted() }
        }
    }

    @Composable
    private fun Hosted() {
        val chooser = rememberSafFileChooser { SafFileChooser(it, policy = policy(it), notify = ::notice) }
        val transfers = rememberWebTransfers(onOpenInBrowser = { openInBrowserCalls.incrementAndGet() }) {
            WebTransfers(
                it,
                platform = ReportingPlatform(platform, downloadReports),
                storage = recording(ContentTransferStorage(it)),
                destinations = policy(it),
                notify = ::notice,
            )
        }
        SideEffect {
            currentChooser = chooser
            currentTransfers = transfers
        }
        val recordedChooser = remember(chooser) { RecordingChooser(chooser) }
        val recordedDownloads = remember(transfers) { RecordingDownloads(transfers) }
        WebScreen(fixture.session, fileChooser = recordedChooser, downloads = recordedDownloads)
    }

    /** The real chooser; records each request the shell hands it. */
    private inner class RecordingChooser(private val chooser: SafFileChooser) : WebFileChooser {
        override fun show(webView: WebView, callback: ValueCallback<Array<Uri>>, params: WebChromeClient.FileChooserParams): Boolean {
            val permission = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.CINNAMON_BUN) params.permissionMode else -1
            val call = "${params.mode} ${params.acceptTypes.joinToString(",")} $permission ${params.filenameHint}"
            HostWeb.note("chooser $call")
            chooserCalls += call
            return chooser.show(webView, callback, params)
        }

        override fun cancelPending() = chooser.cancelPending()
    }

    /** The real downloads; records each navigation the shell offers them. */
    private inner class RecordingDownloads(private val transfers: WebTransfers) : WebDownloads {
        override fun attach(webView: WebView, session: LaunchSession) = transfers.attach(webView, session)

        override fun handleNavigation(webView: WebView, url: Uri, isMainFrame: Boolean, hasGesture: Boolean): Boolean {
            val taken = transfers.handleNavigation(webView, url, isMainFrame, hasGesture)
            offers += "${WebAddress.redact(url.toString()).take(80)} taken=$taken"
            return taken
        }

        override fun detach(webView: WebView) = transfers.detach(webView)
    }

    private fun policy(context: Context): ContentUriPolicy =
        if (realPicker) ContentUriPolicy(context) else ContentUriPolicy(context, holdsGrant = Grants::holds)

    private fun recording(storage: TransferStorage): TransferStorage = object : TransferStorage by storage {
        override fun openOutput(uri: Uri): OutputStream {
            outputs += uri
            return storage.openOutput(uri)
        }

        override fun discard(uri: Uri) {
            discarded += uri
            storage.discard(uri)
        }
    }

    private fun notice(id: Int) {
        notices += id
        HostWeb.note("notice ${noticeName(id)}")
    }

    /** The shell the activity keeps; call from the test thread. */
    fun shell(): WebShell {
        var shell: WebShell? = null
        scenario.onActivity { shell = retainedWebShell(it, it) }
        return checkNotNull(shell)
    }

    private fun webViewOrNull(): WebView? {
        val shell = shell()
        return onMain { shell.webView }
    }

    fun webView(): WebView = checkNotNull(webViewOrNull()) { "no WebView" }

    fun transfers(): WebTransfers = checkNotNull(onMain { currentTransfers }) { "no downloads" }

    fun chooser(): SafFileChooser = checkNotNull(onMain { currentChooser }) { "no chooser" }

    fun bridged(): Boolean {
        val view = webViewOrNull() ?: return false
        return onMain { currentTransfers?.hasBridge(view) == true }
    }

    fun activeTransfers(): Int = onMain { checkNotNull(currentTransfers).activeCount }

    fun count(notice: Int): Int = notices.count { it == notice }

    /** Waits until no export is alive, then lets queued main-thread work run. */
    fun waitIdle(timeoutMillis: Long = 30_000) {
        HostWeb.waitFor("transfers to end", timeoutMillis) { activeTransfers() == 0 }
        onMain { }
    }

    fun waitNotice(notice: Int, count: Int = 1, timeoutMillis: Long = 30_000) {
        HostWeb.waitFor("${noticeName(notice)} x$count", timeoutMillis) { count(notice) >= count }
    }

    /** Loads [page] of the fixture in the same WebView and waits until its script ran. */
    fun open(page: String) {
        val view = webView()
        val url = "${fixture.webOrigin}/$page"
        onMain { view.loadUrl(url) }
        HostWeb.waitFor("page $page", 20_000) { HostWeb.ready(view, page) }
    }

    /** Finishing the activity releases the shell, its WebView, the chooser and the downloads. */
    override fun close() {
        try {
            scenario.close()
        } finally {
            app.unregisterActivityLifecycleCallbacks(this)
            Grants.clear()
        }
    }

    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit

    override fun onActivityStarted(activity: Activity) = Unit

    override fun onActivityResumed(activity: Activity) = Unit

    override fun onActivityPaused(activity: Activity) = Unit

    override fun onActivityStopped(activity: Activity) = Unit

    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit

    override fun onActivityDestroyed(activity: Activity) = Unit

    companion object {
        const val TAG = "p56b"

        fun noticeName(id: Int): String = when (id) {
            R.string.web_transfer_saved -> "saved"
            R.string.web_transfer_failed -> "failed"
            R.string.web_files_rejected -> "rejected"
            else -> "string#$id"
        }
    }
}

internal fun <T> onMain(block: () -> T): T {
    var result: Result<T>? = null
    InstrumentationRegistry.getInstrumentation().runOnMainSync { result = runCatching(block) }
    return result!!.getOrThrow()
}

/** Page-level helpers over a live WebView. */
internal object HostWeb {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    val device: UiDevice get() = UiDevice.getInstance(instrumentation)

    /** Runs [script] and returns its JSON-encoded result. */
    fun eval(view: WebView, script: String, timeoutMillis: Long = 30_000): String {
        val latch = CountDownLatch(1)
        var value: String? = null
        onMain { view.evaluateJavascript(script) { value = it; latch.countDown() } }
        check(latch.await(timeoutMillis, TimeUnit.MILLISECONDS)) { "evaluateJavascript timed out: ${WebAddress.redact(script.take(200))}" }
        return value ?: "null"
    }

    /** Runs [script] and decodes a string, number or boolean result as text; null for JS null/undefined. */
    fun text(view: WebView, script: String, timeoutMillis: Long = 30_000): String? =
        when (val decoded = JSONTokener(eval(view, script, timeoutMillis)).nextValue()) {
            JSONObject.NULL -> null
            else -> decoded.toString()
        }

    /** True once fixture [page] is the current document and its script ran. */
    fun ready(view: WebView, page: String): Boolean = runCatching {
        text(view, "location.pathname === ${JSONObject.quote("/$page")} && document.readyState === 'complete' && !!window.results") == "true"
    }.getOrDefault(false)

    fun title(view: WebView): String? = runCatching { text(view, "document.title") }.getOrNull()

    fun result(view: WebView, key: String): String? {
        val quoted = JSONObject.quote(key)
        return text(view, "window.results && window.results[$quoted] !== undefined && window.results[$quoted] !== null ? String(window.results[$quoted]) : null")
    }

    fun waitResult(view: WebView, key: String, timeoutMillis: Long = 15_000): String {
        waitFor("results.$key", timeoutMillis) { result(view, key) != null }
        return checkNotNull(result(view, key))
    }

    /** Calls `fx.<call>` on the transfers page. */
    fun fx(view: WebView, call: String): String? = text(view, "window.fx.$call")

    /** A real tap on the centre of element [id], so the page sees a user gesture. */
    fun tap(view: WebView, id: String) {
        val js = "(function(){var e=document.getElementById('$id');e.scrollIntoView({block:'center'});" +
            "var r=e.getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2,window.devicePixelRatio].join(',');})()"
        val (x, y, ratio) = checkNotNull(text(view, js)).split(',').map(String::toDouble)
        val location = IntArray(2)
        onMain { view.getLocationOnScreen(location) }
        check(device.click((location[0] + x * ratio).roundToInt(), (location[1] + y * ratio).roundToInt())) { "tap $id" }
    }

    fun clickTag(tag: String, timeoutMillis: Long = 10_000) {
        val found = checkNotNull(device.wait(Until.findObject(By.res(tag)), timeoutMillis)) { "$tag is not on screen" }
        found.click()
    }

    fun shown(tag: String, timeoutMillis: Long = 10_000): Boolean = device.wait(Until.hasObject(By.res(tag)), timeoutMillis) == true

    fun gone(tag: String, timeoutMillis: Long = 10_000): Boolean = device.wait(Until.gone(By.res(tag)), timeoutMillis) == true

    fun waitFor(what: String, timeoutMillis: Long = 15_000, condition: () -> Boolean) {
        val deadline = SystemClock.uptimeMillis() + timeoutMillis
        while (SystemClock.uptimeMillis() < deadline) {
            if (runCatching(condition).getOrDefault(false)) return
            Thread.sleep(100)
        }
        check(condition()) { "timed out waiting for $what" }
    }

    /** The installed WebView's major version, 0 when unknown. */
    fun webViewMajor(): Int = WebView.getCurrentWebViewPackage()?.versionName?.substringBefore('.')?.toIntOrNull() ?: 0

    /** Logs [message] with every label redacted. */
    fun note(message: String) {
        val redacted = WebAddress.redact(message)
        Log.i(TransferHost.TAG, redacted)
        println("p56b: $redacted")
    }
}

/** The system's DocumentsUI save picker, driven as a user does (API 29 and API 37 wording). */
internal object RealPicker {
    private val device: UiDevice get() = HostWeb.device
    private val saveText = Pattern.compile("(?i)save")
    private val confirmText = Pattern.compile("(?i)ok|overwrite|replace")

    /** The picker's Save button once the picker is in front, or null. */
    fun saveButton(timeoutMillis: Long = 20_000): UiObject2? =
        device.wait(Until.findObject(By.text(saveText).clickable(true)), timeoutMillis)
            ?: device.wait(Until.findObject(By.res("android:id/button1")), 2_000)

    /** Saves under the suggested name. */
    fun save() {
        val save = checkNotNull(saveButton()) { "no save button: ${screen()}" }
        HostWeb.note("picker package ${device.currentPackageName}")
        save.click()
    }

    /** Taps the listed document [name], saves over it and confirms that it is replaced. */
    fun replace(name: String) {
        checkNotNull(saveButton()) { "picker not shown: ${screen()}" }
        val item = device.wait(Until.findObject(By.clazz("android.widget.TextView").text(name)), 20_000)
        checkNotNull(item) { "$name not listed: ${screen()}" }
        item.click()
        val confirm = By.res("android:id/button1").text(confirmText)
        var saved = false
        val deadline = SystemClock.uptimeMillis() + 20_000
        while (SystemClock.uptimeMillis() < deadline) {
            val ok = device.wait(Until.findObject(confirm), 2_000)
            if (ok != null) {
                HostWeb.note("confirming: ${screen()}")
                ok.click()
                return
            }
            if (!saved) {
                device.findObject(By.text(saveText).clickable(true))?.let {
                    it.click()
                    saved = true
                }
            }
        }
        throw AssertionError("no replace confirmation: ${screen()}")
    }

    /** Waits until this app is in front again. */
    fun gone(timeoutMillis: Long = 20_000) {
        val app = ApplicationProvider.getApplicationContext<Context>().packageName
        HostWeb.waitFor("the picker to close", timeoutMillis) { device.currentPackageName == app }
    }

    /** The texts on screen, for failure messages. */
    fun screen(): String = runCatching {
        device.findObjects(By.text(Pattern.compile(".+"))).joinToString(" | ") { "${it.className?.substringAfterLast('.')}:${it.text}" }
    }.getOrDefault("?").take(1_500)
}

/**
 * MediaStore Downloads items stand in for SAF documents: this app may create, write, read and delete
 * its own items without permissions on API 29+, and their `content://media` URIs belong to another
 * app's provider, as picker results do.
 */
internal object Media {
    private val context: Context get() = ApplicationProvider.getApplicationContext()
    private val created = CopyOnWriteArrayList<Uri>()
    private val serial = AtomicInteger()

    fun create(name: String, mime: String, bytes: ByteArray? = null, folder: String = Environment.DIRECTORY_DOWNLOADS + "/p56b"): Uri {
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, name)
            put(MediaStore.MediaColumns.MIME_TYPE, mime)
            put(MediaStore.MediaColumns.RELATIVE_PATH, folder)
        }
        val uri = checkNotNull(context.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)) { "insert $name" }
        created += uri
        if (bytes != null) checkNotNull(context.contentResolver.openOutputStream(uri, "w")).use { it.write(bytes) }
        return uri
    }

    /** A fresh empty document to answer a `CREATE_DOCUMENT` launch with, as a picker creates one. */
    fun destination(tag: String): Uri =
        create("p56b-$tag-${serial.incrementAndGet()}-${SystemClock.uptimeMillis()}.bin", "application/octet-stream", ByteArray(0))

    fun read(uri: Uri): ByteArray? = try {
        context.contentResolver.openInputStream(uri)?.use { input ->
            ByteArrayOutputStream().also { input.copyTo(it) }.toByteArray()
        }
    } catch (_: Exception) {
        null
    }

    fun sha256(uri: Uri): String? = try {
        context.contentResolver.openInputStream(uri)?.use { input ->
            val digest = MessageDigest.getInstance("SHA-256")
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
            }
            digest.digest().joinToString("") { "%02x".format(it) }
        }
    } catch (_: Exception) {
        null
    }

    fun exists(uri: Uri): Boolean = try {
        context.contentResolver.query(uri, arrayOf(MediaStore.MediaColumns._ID), null, null, null)?.use { it.count > 0 } == true
    } catch (_: Exception) {
        false
    }

    fun displayName(uri: Uri): String? =
        context.contentResolver.query(uri, arrayOf(MediaStore.MediaColumns.DISPLAY_NAME), null, null, null)?.use {
            if (it.moveToFirst()) it.getString(0) else null
        }

    fun cleanup() {
        for (uri in created) runCatching { context.contentResolver.delete(uri, null, null) }
        created.clear()
    }

    /**
     * A picker result for [uris]: `data` is the first, `ClipData` carries all of them, with [flags].
     * With [grant] the stand-in picker also records the grants, as the system does for a real result.
     */
    fun result(uris: List<Uri>, flags: Int = READ_WRITE, grant: Boolean = true): Intent {
        val intent = Intent().setData(uris.first()).addFlags(flags)
        if (uris.size > 1) {
            val clip = ClipData.newRawUri("", uris.first())
            uris.drop(1).forEach { clip.addItem(ClipData.Item(it)) }
            intent.clipData = clip
        }
        if (grant) uris.forEach { Grants.give(it, flags) }
        return intent
    }

    const val READ_WRITE = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
}

/** Test bytes: byte i of a body with seed s is (i * 31 + s) & 0xff, as in the fixture server and pages. */
internal fun patternBytes(length: Int, seed: Int): ByteArray = ByteArray(length) { ((it * 31 + seed) and 0xff).toByte() }

internal fun patternSha256(length: Long, seed: Int): String {
    val digest = MessageDigest.getInstance("SHA-256")
    val buffer = ByteArray(64 * 1024)
    var offset = 0L
    while (offset < length) {
        val count = minOf(buffer.size.toLong(), length - offset).toInt()
        for (index in 0 until count) buffer[index] = (((offset + index) * 31 + seed) and 0xff).toByte()
        digest.update(buffer, 0, count)
        offset += count
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
}
