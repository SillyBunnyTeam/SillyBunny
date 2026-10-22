package io.github.sillybunnyteam.sillybunny.web

import android.app.Activity
import android.app.Application
import android.app.Instrumentation
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.util.Log
import android.view.KeyEvent
import android.webkit.CookieManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.annotation.RequiresApi
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import io.github.sillybunnyteam.sillybunny.server.LaunchSession
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.regex.Pattern
import kotlin.math.roundToInt
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener

/**
 * The host fixture server (`fixtures/fixture-server.mjs` next to this file): the real launch-token
 * middleware in front of the fixture pages, reached through `adb reverse`. Its ports and token come from
 * the instrumentation arguments `fixturePort`, `fixtureOther` and `fixtureToken`.
 */
internal class FixtureServer {
    private val args = InstrumentationRegistry.getArguments()
    val port: Int = requireNotNull(args.getString("fixturePort")) { "run with -e fixturePort <port>" }.toInt()
    val otherPort: Int = requireNotNull(args.getString("fixtureOther")) { "run with -e fixtureOther <port>" }.toInt()
    val token: String = requireNotNull(args.getString("fixtureToken")) { "run with -e fixtureToken <hex>" }
    val session = LaunchSession(port, token)
    val origin = session.origin

    class Request(
        val listener: String,
        val method: String,
        val url: String,
        val status: Int,
        val launchCookie: Boolean,
        val anyCookie: Boolean,
        /** A WebView sent it (its user agent has `; wv)`), not the device's browser. */
        val webView: Boolean,
    ) {
        override fun toString() = "$listener $method $url $status cookie=$launchCookie/$anyCookie"
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
                entry.optBoolean("webView"),
            )
        }
    }

    /**
     * Requests that reached the other loopback port (listeners `other` and `other-ws`): each one escaped the
     * shell's containment. Requests to the fixture's redirector (listener `hop`) are not escapes.
     */
    fun escaped(): List<Request> = requests().filter { it.listener.startsWith("other") }

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

/** Records the shell's download hooks; the shell calls them on the main thread. */
internal class DeviceDownloads : WebDownloads {
    val events = CopyOnWriteArrayList<String>()

    @Volatile
    var takes: (Uri) -> Boolean = { false }

    override fun attach(webView: WebView, session: LaunchSession) {
        events += "attach ${webView.identity()}"
    }

    override fun handleNavigation(webView: WebView, url: Uri, isMainFrame: Boolean, hasGesture: Boolean): Boolean {
        events += "offer $url main=$isMainFrame gesture=$hasGesture"
        return takes(url)
    }

    override fun detach(webView: WebView) {
        events += "detach ${webView.identity()}"
    }
}

/** Answers every chooser request with a cancellation and records the calls. */
internal class DeviceChooser : WebFileChooser {
    val events = CopyOnWriteArrayList<String>()

    override fun show(webView: WebView, callback: ValueCallback<Array<Uri>>, params: WebChromeClient.FileChooserParams): Boolean {
        events += "show ${webView.identity()}"
        callback.onReceiveValue(null)
        return true
    }

    override fun cancelPending() {
        events += "cancel"
    }
}

internal fun WebView.identity(): String = Integer.toHexString(System.identityHashCode(this))

/** Blocks and records every `ACTION_VIEW` the app starts, so nothing leaves the test. */
internal class ViewIntents : Instrumentation.ActivityMonitor() {
    val intents = CopyOnWriteArrayList<Intent>()

    override fun onStartActivity(intent: Intent): Instrumentation.ActivityResult? {
        if (intent.action != Intent.ACTION_VIEW) return null
        intents += Intent(intent)
        return Instrumentation.ActivityResult(Activity.RESULT_CANCELED, null)
    }

    fun data(): List<String> = intents.map { it.dataString.orEmpty() }
}

/**
 * Hosts [WebScreen] in the debug `ComponentActivity` from `ui-test-manifest`. The content is set on every
 * new instance of the activity, so recreation behaves as it does for an app activity calling setContent in
 * onCreate.
 */
internal class WebScreenHost(private val session: LaunchSession) : Application.ActivityLifecycleCallbacks, AutoCloseable {
    val chooser = DeviceChooser()
    val downloads = DeviceDownloads()
    private val app = ApplicationProvider.getApplicationContext<Application>()
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    lateinit var scenario: ActivityScenario<ComponentActivity>
        private set

    fun launch(): WebScreenHost {
        app.registerActivityLifecycleCallbacks(this)
        scenario = ActivityScenario.launch(ComponentActivity::class.java)
        return this
    }

    override fun onActivityPostCreated(activity: Activity, savedInstanceState: Bundle?) {
        // Only the test host activity, never an app activity that happens to start meanwhile.
        if (activity.javaClass == ComponentActivity::class.java) {
            (activity as ComponentActivity).setContent { WebScreen(session, fileChooser = chooser, downloads = downloads) }
        }
    }

    fun shell(): WebShell {
        var shell: WebShell? = null
        scenario.onActivity { shell = retainedWebShell(it, it) }
        return checkNotNull(shell)
    }

    fun activity(): ComponentActivity {
        var activity: ComponentActivity? = null
        scenario.onActivity { activity = it }
        return checkNotNull(activity)
    }

    fun webViewOrNull(): WebView? {
        val shell = shell()
        return onMain { shell.webView }
    }

    fun webView(): WebView = checkNotNull(webViewOrNull()) { "no WebView" }

    override fun close() {
        try {
            scenario.close()
        } finally {
            app.unregisterActivityLifecycleCallbacks(this)
        }
    }

    private fun <T> onMain(block: () -> T): T {
        var result: Result<T>? = null
        instrumentation.runOnMainSync { result = runCatching(block) }
        return result!!.getOrThrow()
    }

    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit

    override fun onActivityStarted(activity: Activity) = Unit

    override fun onActivityResumed(activity: Activity) = Unit

    override fun onActivityPaused(activity: Activity) = Unit

    override fun onActivityStopped(activity: Activity) = Unit

    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit

    override fun onActivityDestroyed(activity: Activity) = Unit
}

/** Page-level helpers over a live WebView. */
internal object Web {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val device get() = UiDevice.getInstance(instrumentation)

    fun <T> onMain(block: () -> T): T {
        var result: Result<T>? = null
        instrumentation.runOnMainSync { result = runCatching(block) }
        return result!!.getOrThrow()
    }

    /** Runs [script] and returns its JSON-encoded result. */
    fun eval(view: WebView, script: String, timeoutMillis: Long = 10_000): String {
        val latch = CountDownLatch(1)
        var value: String? = null
        onMain { view.evaluateJavascript(script) { value = it; latch.countDown() } }
        check(latch.await(timeoutMillis, TimeUnit.MILLISECONDS)) { "evaluateJavascript timed out: $script" }
        return value ?: "null"
    }

    /** Runs [script] and decodes a string, number or boolean result as text; null for JS null/undefined. */
    fun text(view: WebView, script: String): String? =
        when (val decoded = JSONTokener(eval(view, script)).nextValue()) {
            JSONObject.NULL -> null
            else -> decoded.toString()
        }

    fun title(view: WebView): String? = runCatching { text(view, "document.title") }.getOrNull()

    fun result(view: WebView, key: String): String? = text(view, "window.results && window.results['$key'] !== undefined ? String(window.results['$key']) : null")

    fun navigate(view: WebView, path: String, title: String) {
        eval(view, "location.href = '$path'; 1")
        waitFor("title $title") { title(view) == title }
    }

    /**
     * A real tap on the centre of element [id], so the page sees a user gesture, and a confirmed one: the element must
     * see the click, or its document must give way to the navigation that the click started. On a busy device an
     * injected tap can arrive as a long press instead (a text selection, and no click); then the selection is cleared
     * and the tap is sent once more. Fails when no tap reached the page as a click. The element's click handler must not
     * open a JavaScript dialog synchronously, because the confirmation reads the page.
     */
    fun tap(view: WebView, id: String) {
        var seen = "none"
        for (attempt in 1..TAP_ATTEMPTS) {
            // Unique per attempt, so a click left over from an earlier tap of the same element does not count.
            val mark = "${SystemClock.uptimeMillis()}-$attempt"
            val armed = checkNotNull(text(view, armTap(id, mark))) { "tap $id: no answer from the page" }
            check(armed != "missing") { "tap $id: no such element" }
            val (x, y, ratio) = armed.split(',').map(String::toDouble)
            val location = IntArray(2)
            onMain { view.getLocationOnScreen(location) }
            device.waitForIdle(TAP_IDLE_MILLIS)
            check(device.click((location[0] + x * ratio).roundToInt(), (location[1] + y * ratio).roundToInt())) { "tap $id" }
            seen = awaitTap(view, id, mark)
            if (seen == "click" || seen == "replaced") return
            note("tap $id attempt $attempt: the page saw no click ($seen); clearing any selection")
            runCatching { eval(view, "window.getSelection && window.getSelection().removeAllRanges(); 1") }
            settle(TAP_RETRY_PAUSE_MILLIS)
        }
        error("tap $id: no tap reached the page as a click (last: $seen)")
    }

    /**
     * Records clicks and long presses (`contextmenu`) of element [id] under [mark], scrolls it to the centre and returns
     * `x,y,devicePixelRatio` of its centre, or `missing`.
     */
    private fun armTap(id: String, mark: String): String =
        "(function (id, mark) {" +
            " var e = document.getElementById(id); if (!e) return 'missing';" +
            " var taps = window.__fixtureTaps || (window.__fixtureTaps = {});" +
            " taps[id] = { mark: mark, click: 0, press: 0 };" +
            " if (!e.__fixtureTapHooks) {" +
            "  e.__fixtureTapHooks = true;" +
            "  e.addEventListener('click', function () { taps[id].click++; }, true);" +
            "  e.addEventListener('contextmenu', function () { taps[id].press++; }, true);" +
            " }" +
            " e.scrollIntoView({ block: 'center' });" +
            " var r = e.getBoundingClientRect();" +
            " return [r.left + r.width / 2, r.top + r.height / 2, window.devicePixelRatio].join(',');" +
            "})(${JSONObject.quote(id)}, ${JSONObject.quote(mark)})"

    /**
     * Waits for the outcome of the tap armed under [mark]: `click`, `replaced` (the document was replaced, so the click
     * started a navigation), `long-press`, or after [TAP_CONFIRM_MILLIS] `selection` or `none`.
     */
    private fun awaitTap(view: WebView, id: String, mark: String): String {
        val script = "(function (id, mark) {" +
            " var t = window.__fixtureTaps && window.__fixtureTaps[id];" +
            " if (!t || t.mark !== mark) return 'replaced';" +
            " if (t.click > 0) return 'click';" +
            " if (t.press > 0) return 'long-press';" +
            " return window.getSelection && String(window.getSelection()) ? 'selection' : 'none';" +
            "})(${JSONObject.quote(id)}, ${JSONObject.quote(mark)})"
        val deadline = SystemClock.uptimeMillis() + TAP_CONFIRM_MILLIS
        var seen: String
        do {
            seen = runCatching { text(view, script) }.getOrNull() ?: "unreadable"
            if (seen == "click" || seen == "replaced" || seen == "long-press") return seen
            Thread.sleep(100)
        } while (SystemClock.uptimeMillis() < deadline)
        return seen
    }

    class HttpResult(
        val status: Int,
        val location: String?,
        val setCookie: String?,
        val cacheControl: String?,
        val contentType: String?,
        val body: String,
    )

    /** A plain GET from the app process: no cookies, no redirects followed. */
    fun get(url: String): HttpResult {
        val connection = URL(url).openConnection() as HttpURLConnection
        return try {
            connection.instanceFollowRedirects = false
            connection.connectTimeout = 5_000
            connection.readTimeout = 5_000
            val status = connection.responseCode
            val stream = if (status < 400) connection.inputStream else connection.errorStream
            HttpResult(
                status,
                connection.getHeaderField("Location"),
                connection.getHeaderField("Set-Cookie"),
                connection.getHeaderField("Cache-Control"),
                connection.contentType,
                stream?.bufferedReader()?.use { it.readText() }.orEmpty(),
            )
        } finally {
            connection.disconnect()
        }
    }

    fun clearCookies() {
        val latch = CountDownLatch(1)
        onMain { CookieManager.getInstance().removeAllCookies { latch.countDown() } }
        check(latch.await(10, TimeUnit.SECONDS))
    }

    fun waitFor(what: String, timeoutMillis: Long = 15_000, condition: () -> Boolean) {
        val deadline = SystemClock.uptimeMillis() + timeoutMillis
        while (SystemClock.uptimeMillis() < deadline) {
            if (runCatching(condition).getOrDefault(false)) return
            Thread.sleep(100)
        }
        check(condition()) { "timed out waiting for $what" }
    }

    /** Lets in-flight work settle where the expected outcome is that nothing happens. */
    fun settle(millis: Long = 1_500) = Thread.sleep(millis)

    /** Runs [command] as the shell user and returns its output once the command has finished. */
    fun shell(command: String): String =
        ParcelFileDescriptor.AutoCloseInputStream(instrumentation.uiAutomation.executeShellCommand(command)).use {
            it.readBytes().toString(Charsets.UTF_8)
        }

    /** Like [shell], with [input] on the command's standard input, for example a script for `sh`. */
    @RequiresApi(31)
    fun shellWithInput(command: String, input: String): String {
        val (output, stdin) = instrumentation.uiAutomation.executeShellCommandRw(command)
        ParcelFileDescriptor.AutoCloseOutputStream(stdin).use { it.write(input.toByteArray(Charsets.UTF_8)) }
        return ParcelFileDescriptor.AutoCloseInputStream(output).use { it.readBytes().toString(Charsets.UTF_8) }
    }

    /** The window manager's current focus line, for example `mCurrentFocus=Window{... <package>/<activity>}`. */
    fun focusedWindow(): String = shell("dumpsys window").lineSequence().firstOrNull { "mCurrentFocus" in it }?.trim().orEmpty()

    fun note(message: String) {
        Log.i("p56a", message)
        println("p56a: $message")
    }

    /** One tap and one retry. */
    private const val TAP_ATTEMPTS = 2

    /** At most this long waiting for the UI to settle before a tap. */
    private const val TAP_IDLE_MILLIS = 2_000L

    /** How long a tap may take to reach the page as a click; a click normally arrives within a few hundred ms. */
    private const val TAP_CONFIRM_MILLIS = 5_000L

    /** Lets the selection handles and toolbar of a long press go away before the next tap. */
    private const val TAP_RETRY_PAUSE_MILLIS = 500L
}

/**
 * The screen's own Compose controls, found by test tag: debug builds expose the tags as resource IDs. The
 * Compose test rule is not used because its Espresso 3.5.0 idling fails on API 37 (InputManager.getInstance).
 */
internal object ScreenUi {
    private val device get() = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())

    fun find(tag: String, timeoutMillis: Long = 10_000): UiObject2 =
        checkNotNull(device.wait(Until.findObject(By.res(tag)), timeoutMillis)) { "$tag is not on screen" }

    fun click(tag: String) = find(tag).click()

    fun shown(tag: String, timeoutMillis: Long = 10_000): Boolean = device.wait(Until.hasObject(By.res(tag)), timeoutMillis) == true

    fun gone(tag: String, timeoutMillis: Long = 10_000): Boolean = device.wait(Until.gone(By.res(tag)), timeoutMillis) == true

    /** True when the focused window holds the element tagged [tag], so that a key such as Back goes to that window. */
    fun focusedWindowHas(tag: String): Boolean {
        val window = InstrumentationRegistry.getInstrumentation().uiAutomation.windows.firstOrNull { it.isFocused } ?: return false
        val pending = ArrayDeque(listOfNotNull(window.root))
        while (pending.isNotEmpty()) {
            val node = pending.removeFirst()
            if (node.viewIdResourceName == tag) return true
            for (index in 0 until node.childCount) node.getChild(index)?.let(pending::addLast)
        }
        return false
    }
}

/**
 * The device's own browser, [packageName] from the instrumentation argument `fixtureBrowser`, for the opt-in Open in
 * browser measurement. It clears the browser's data, so use it only on a test device or emulator.
 *
 * For Chrome, [prepare] turns the first-run screens off through Chrome's debug command line
 * (`/data/local/tmp/chrome-command-line`, read while Chrome is the debug app), and [clear] grants the notification
 * permission, so that Chrome's notification promotion does not take focus. [restore] stops the browser, clears its
 * data (the launch cookie and that permission with it) and undoes [prepare].
 */
@RequiresApi(31)
internal class DeviceBrowser(val packageName: String) {
    private val device get() = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())

    /** The installed version; null when [packageName] is not installed. */
    val versionName: String? = Web.shell("dumpsys package $packageName").lineSequence()
        .map(String::trim)
        .firstOrNull { it.startsWith("versionName=") }
        ?.removePrefix("versionName=")

    /** The activity a browsable http link opens, as `package/class`; the system's chooser when there is no default. */
    fun linkHandler(): String =
        Web.shell("cmd package resolve-activity --brief -a android.intent.action.VIEW -c android.intent.category.BROWSABLE -d http://127.0.0.1/")
            .trim().lines().last().trim()

    fun prepare() {
        if (packageName != CHROME) return
        Web.shell("am set-debug-app --persistent $packageName")
        Web.shellWithInput("sh", "echo '_ $CHROME_FLAGS' > $CHROME_COMMAND_LINE && chmod 644 $CHROME_COMMAND_LINE\n")
    }

    /** Stops the browser and clears its data, cookies included, so the next start begins without the launch cookie. */
    fun clear() {
        wipe()
        if (Build.VERSION.SDK_INT >= 33) Web.shell("pm grant $packageName android.permission.POST_NOTIFICATIONS")
    }

    private fun wipe() {
        stop()
        Web.shell("pm clear $packageName")
    }

    /** Stops the browser's process. */
    fun stop() {
        Web.shell("am force-stop $packageName")
    }

    /** Opens [url] in the browser the way any installed app can: an `ACTION_VIEW` from another app (the shell user). */
    fun viewFromAnotherApp(url: String) {
        Web.shell("am start -a android.intent.action.VIEW -c android.intent.category.BROWSABLE -p $packageName -d $url")
    }

    /** Closes a promotion of the browser that holds focus, if one is showing. */
    fun dismissPrompts() {
        device.findObject(By.pkg(packageName).text(PROMPT_DISMISS))?.click()
    }

    /** Reloads the current tab as a keyboard user does (F5). */
    fun reload() {
        device.pressKeyCode(KeyEvent.KEYCODE_F5)
    }

    fun restore() {
        wipe()
        if (packageName == CHROME) {
            Web.shell("am clear-debug-app")
            Web.shell("rm -f $CHROME_COMMAND_LINE")
        }
    }

    companion object {
        const val CHROME = "com.android.chrome"
        private const val CHROME_COMMAND_LINE = "/data/local/tmp/chrome-command-line"
        private const val CHROME_FLAGS = "--disable-fre --no-default-browser-check --no-first-run"
        private val PROMPT_DISMISS = Pattern.compile("No thanks|No, thanks|Not now")
    }
}
