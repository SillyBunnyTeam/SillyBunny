package io.github.sillybunnyteam.sillybunny.app

import android.app.Instrumentation
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Direction
import androidx.test.uiautomator.StaleObjectException
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import io.github.sillybunnyteam.sillybunny.R
import io.github.sillybunnyteam.sillybunny.runtime.RuntimePaths
import io.github.sillybunnyteam.sillybunny.server.LaunchSession
import io.github.sillybunnyteam.sillybunny.server.ServerManager
import io.github.sillybunnyteam.sillybunny.server.ServerNotifications
import io.github.sillybunnyteam.sillybunny.server.ServerState
import io.github.sillybunnyteam.sillybunny.web.WebAddress
import io.github.sillybunnyteam.sillybunny.web.WebScreenTags
import io.github.sillybunnyteam.sillybunny.web.WebViewVersion
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.regex.Pattern

/**
 * The installed app, driven through UiAutomator as a user drives it. Its state is read in-process: the
 * instrumentation runs in the app's process, so [ServerManager.get] returns the instance the app uses. Debug builds
 * expose Compose test tags as resource ids. Failure messages name ports, never launch tokens.
 */
internal class AppDeviceUi(private val instrumentation: Instrumentation) {
    val context: Context = instrumentation.targetContext
    val device: UiDevice = UiDevice.getInstance(instrumentation)
    val paths = RuntimePaths(context)
    private val server by lazy { ServerManager.get(context) }
    private val address by lazy { WebAddress.forInstall(context) }

    val state: ServerState get() = server.state.value

    fun now(): Long = SystemClock.uptimeMillis()

    fun launch() {
        val intent = checkNotNull(context.packageManager.getLaunchIntentForPackage(context.packageName)) {
            "no launcher intent"
        }
        context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    /** The app's tagged elements on screen, from one accessibility query. */
    fun tags(): Set<String> = try {
        device.findObjects(By.res(APP_TAG)).mapNotNull { it.resourceName }.toSet()
    } catch (_: StaleObjectException) {
        emptySet()
    }

    /** Waits for [tag], scrolling the app's scrollable container both ways meanwhile. */
    fun find(tag: String, timeoutMillis: Long = UI_MILLIS): UiObject2? {
        val deadline = now() + timeoutMillis
        var direction = Direction.DOWN
        while (true) {
            device.wait(Until.findObject(By.res(tag)), POLL_MILLIS)?.let { return it }
            if (now() >= deadline) return null
            val container = device.findObject(By.pkg(context.packageName).scrollable(true)) ?: continue
            val more = try {
                container.scroll(direction, SCROLL_PERCENT)
            } catch (_: StaleObjectException) {
                true
            }
            if (!more) direction = if (direction == Direction.DOWN) Direction.UP else Direction.DOWN
        }
    }

    fun click(tag: String, timeoutMillis: Long = UI_MILLIS) {
        val target = checkNotNull(find(tag, timeoutMillis)) { "$tag is not on screen; tags ${tags()}" }
        check(tap(target)) { "$tag went away before the click" }
    }

    /** Clicks [tag] if it shows within [timeoutMillis]; false when it did not, or vanished meanwhile. */
    fun clickIfShown(tag: String, timeoutMillis: Long): Boolean = tap(find(tag, timeoutMillis))

    private fun tap(target: UiObject2?): Boolean {
        if (target == null) return false
        return try {
            target.click()
            true
        } catch (_: StaleObjectException) {
            false
        }
    }

    /**
     * Allows a runtime-permission dialog that is on screen or shows within [timeoutMillis]. On API 33+ a tap while the
     * dialog opens can go to a window that takes no input yet, so the allow button gets another tap until the dialog
     * closes. The dialog counts as closed once its allow button stays away for [SETTLE_MILLIS].
     * False when the dialog is still open after [DIALOG_MILLIS] of taps; true when it closed or when none showed.
     */
    fun allowPermission(timeoutMillis: Long): Boolean {
        val selector = By.res(PERMISSION_ALLOW)
        var button: UiObject2 = device.wait(Until.findObject(selector), timeoutMillis) ?: return true
        val deadline = now() + DIALOG_MILLIS
        while (now() < deadline) {
            tap(button)
            device.wait(Until.gone(selector), RETAP_MILLIS)
            button = device.wait(Until.findObject(selector), SETTLE_MILLIS) ?: return true
        }
        return false
    }

    /** Fails on a screen that ends the run: an error screen or an update prompt nobody expects here. */
    fun failOnErrorScreens(tags: Set<String>) {
        val errors = tags.filter { it in ERROR_TAGS || it.startsWith("update_") }
        check(errors.isEmpty()) { "error screen $errors; server ${describe(state)}; tags $tags" }
    }

    /** Waits for [predicate] on the server state; a server that gave up fails the wait with its last lines. */
    fun awaitState(timeoutMillis: Long, what: String, predicate: (ServerState) -> Boolean): ServerState {
        val deadline = now() + timeoutMillis
        while (true) {
            val current = state
            if (predicate(current)) return current
            check(current !is ServerState.Failed) { "the server failed while waiting for $what: ${describe(current)}" }
            check(now() < deadline) { "no $what within $timeoutMillis ms; server ${describe(current)}; tags ${tags()}" }
            SystemClock.sleep(POLL_MILLIS)
        }
    }

    /**
     * Waits until a server run other than [previous] is Running and the web route shows its UI. Times are relative to
     * [since]. An origin-change warning on the way is acknowledged, as a user would.
     */
    fun awaitUi(timeoutMillis: Long, since: Long, previous: LaunchSession? = null): Arrival {
        val deadline = now() + timeoutMillis
        var runningAt = -1L
        var pageAt = -1L
        while (true) {
            val tags = tags()
            failOnErrorScreens(tags)
            if (AppTags.ORIGIN_CHANGED_OK in tags) clickIfShown(AppTags.ORIGIN_CHANGED_OK, 0)
            val session = (state as? ServerState.Running)?.session?.takeIf { it != previous }
            if (session != null) {
                if (runningAt < 0) runningAt = now() - since
                val page = page(session)
                if (page != Page.NONE && pageAt < 0) pageAt = now() - since
                if (isUi(page)) return Arrival(session, runningAt, pageAt, now() - since)
            }
            check(now() < deadline) { "no UI within $timeoutMillis ms; server ${describe(state)}; tags $tags" }
            SystemClock.sleep(POLL_MILLIS)
        }
    }

    /** Dismisses the app's warning about an old system WebView, which shows only where the frontend cannot boot. */
    fun dismissVersionWarning() {
        if (frontendSupported) return
        // Not find(): its scrolling would swipe the page, because the WebView is the screen's scrollable view.
        val warning = By.res(WebScreenTags.VERSION_DISMISS)
        check(tap(device.wait(Until.findObject(warning), UI_MILLIS))) { "no WebView version warning; tags ${tags()}" }
        check(device.wait(Until.gone(warning), UI_MILLIS)) { "the WebView version warning stayed" }
    }

    /**
     * False on a system WebView older than the frontend needs, the same check as the app's version warning. Such a
     * WebView loads the page but cannot parse the frontend's scripts, so the frontend never boots there.
     */
    val frontendSupported: Boolean by lazy {
        !WebViewVersion.isBelowMinimum(WebViewVersion.parseMajor(WebViewVersion.currentPackage(context)?.versionName))
    }

    /** How far the SillyBunny page has come in the WebView. */
    enum class Page {
        NONE,

        /** The page from the session's origin is loaded; the server only serves it with that run's cookie. */
        LOADED,

        /** The frontend has also finished its boot, which removes the page's `#preloader`. */
        BOOTED,
    }

    fun page(session: LaunchSession): Page {
        val view = webView() ?: return Page.NONE
        val origin = address.origin(session)
        val (url, progress) = onMain { view.url to view.progress }
        if (url?.startsWith("$origin/") != true || progress < 100) return Page.NONE
        return when (evaluate(view, PAGE_STATE)?.trim('"')) {
            "booted" -> Page.BOOTED
            "loaded" -> Page.LOADED
            else -> Page.NONE
        }
    }

    /** The UI is the booted frontend; where it cannot boot ([frontendSupported] false), the loaded page. */
    fun isUi(page: Page): Boolean = page == Page.BOOTED || (!frontendSupported && page == Page.LOADED)

    /** The WebView's cookie jar holds [session]'s token for its origin. */
    fun hasCookieFor(session: LaunchSession): Boolean = onMain {
        CookieManager.getInstance().getCookie(address.origin(session)).orEmpty()
            .split(';')
            .any { it.trim() == "${LaunchSession.COOKIE_NAME}=${session.token}" }
    }

    fun serverNotificationShown(): Boolean = context.getSystemService(NotificationManager::class.java)
        .activeNotifications.any { it.id == ServerNotifications.NOTIFICATION_ID }

    /**
     * Taps Stop on the server notification in the shade. A collapsed notification hides its actions, so it is
     * expanded first through its own expand button. The shade is closed again afterwards.
     */
    fun stopFromNotification() {
        check(device.openNotification()) { "the notification shade did not open" }
        val label = Pattern.quote(context.getString(R.string.server_notification_stop))
        val stop = By.clazz(BUTTON).text(Pattern.compile("(?i)$label"))
        var button = device.wait(Until.findObject(stop), SHADE_MILLIS)
        if (button == null) {
            val appName = context.applicationInfo.loadLabel(context.packageManager).toString()
            val header = checkNotNull(device.wait(Until.findObject(By.res(APP_NAME).text(appName)), SHADE_MILLIS)) {
                "no notification of $appName in the shade"
            }
            val expand = generateSequence(header) { it.parent }.firstNotNullOfOrNull { it.findObject(By.res(EXPAND)) }
            check(tap(expand)) { "the server notification has no expand button" }
            button = device.wait(Until.findObject(stop), SHADE_MILLIS)
        }
        check(tap(button)) { "no Stop action on the server notification" }
        closeShade()
    }

    private fun closeShade() {
        val deadline = now() + SHADE_MILLIS
        while (device.currentPackageName == SYSTEM_UI && now() < deadline) {
            device.pressBack()
            device.wait(Until.hasObject(By.pkg(context.packageName).depth(0)), POLL_MILLIS)
            SystemClock.sleep(POLL_MILLIS)
        }
        check(device.currentPackageName == context.packageName) { "the shade stayed open" }
    }

    /** This app's node server processes; start.sh runs the server as `node --no-warnings server.js`. */
    fun nodePids(): List<Int> = File("/proc").listFiles().orEmpty().mapNotNull { dir ->
        val pid = dir.name.toIntOrNull() ?: return@mapNotNull null
        val args = try {
            File(dir, "cmdline").readText().split('\u0000')
        } catch (_: IOException) {
            return@mapNotNull null
        }
        pid.takeIf { "server.js" in args }
    }

    /** Folders that Repair moved aside, by name. */
    fun brokenFolders(): Set<String> = paths.filesDir.listFiles().orEmpty()
        .map { it.name }
        .filter { it.startsWith("${paths.checkoutDir.name}.broken-") }
        .toSet()

    /** One timing for the host script, which collects every `app_e2e` status line of the `am instrument` output. */
    fun record(name: String, millis: Long) {
        Log.i(LOG_TAG, "$name=$millis")
        instrumentation.sendStatus(STATUS_TIMING, Bundle().apply { putString(STATUS_KEY, "$name=$millis") })
    }

    /** Where the WebView sits on screen, and where the keyboard's top edge is, in screen pixels. */
    class WebLayout(val left: Int, val top: Int, val bottom: Int, val keyboardShown: Boolean, val keyboardTop: Int)

    fun webLayout(): WebLayout? = onMain {
        val view = resumedWebView() ?: return@onMain null
        val location = IntArray(2).also(view::getLocationOnScreen)
        val root = view.rootView
        val rootLocation = IntArray(2).also(root::getLocationOnScreen)
        val insets = ViewCompat.getRootWindowInsets(view)
        val keyboard = insets?.getInsets(WindowInsetsCompat.Type.ime())?.bottom ?: 0
        WebLayout(
            left = location[0],
            top = location[1],
            bottom = location[1] + view.height,
            keyboardShown = insets?.isVisible(WindowInsetsCompat.Type.ime()) == true,
            keyboardTop = rootLocation[1] + root.height - keyboard,
        )
    }

    fun awaitWebLayout(what: String, predicate: (WebLayout) -> Boolean): WebLayout {
        val deadline = now() + UI_MILLIS
        while (true) {
            val layout = webLayout()
            if (layout != null && predicate(layout)) return layout
            check(now() < deadline) { "no $what within $UI_MILLIS ms; tags ${tags()}" }
            SystemClock.sleep(POLL_MILLIS)
        }
    }

    /**
     * Taps a text field that is on top of the page, as a user would: SillyBunny's message box, or else the first
     * other one, such as the name field of the frontend's own first-run prompt, which covers the message box until
     * someone answers it. A booted frontend opens its prompts one after another, and a prompt without a text field,
     * such as an extension's question about data it found in the browser, can stay on top until the next one opens,
     * so a booted frontend gets [FIELD_MILLIS] to bring a field on top. Where no field is on top, for example under
     * the loading overlay of a frontend that cannot boot, it taps a probe field that it adds above the page or inside
     * the top modal dialog, so the keyboard check still measures the app's layout.
     * Page coordinates are CSS pixels, so devicePixelRatio maps them to the screen.
     */
    fun tapTextField() {
        val view = checkNotNull(webView()) { "no WebView" }
        val fieldDeadline = now() + if (frontendSupported) FIELD_MILLIS else 0L
        var answer = settledAnswer(view, TOP_FIELD)
        while (answer == "none" && now() < fieldDeadline) answer = settledAnswer(view, TOP_FIELD)
        if (answer == "none") answer = checkNotNull(evaluate(view, PROBE_FIELD)) { "the page did not answer" }.trim('"')
        check(answer != "none") { "no text field on top of the page" }
        val (x, y, ratio) = answer.split(',').map { it.toFloat() }
        val layout = checkNotNull(webLayout()) { "no WebView" }
        check(device.click((layout.left + x * ratio).toInt(), (layout.top + y * ratio).toInt())) { "the tap failed" }
    }

    /**
     * [script]'s answer once [SETTLED_POLLS] polls in a row return it. The frontend hides its loading overlay right
     * before it opens its first-run prompt, so an earlier answer can name a field that the opening prompt then covers.
     */
    private fun settledAnswer(view: WebView, script: String): String {
        val deadline = now() + UI_MILLIS
        var last: String? = null
        var same = 0
        while (true) {
            val answer = evaluate(view, script)?.trim('"')
            same = if (answer != null && answer == last) same + 1 else 1
            last = answer
            if (answer != null && same >= SETTLED_POLLS) return answer
            check(now() < deadline) { "the page did not settle within $UI_MILLIS ms; last answer $answer" }
            SystemClock.sleep(POLL_MILLIS)
        }
    }

    private fun webView(): WebView? = onMain { resumedWebView() }

    /** Main thread only. */
    private fun resumedWebView(): WebView? {
        val activity = ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED).firstOrNull()
        return activity?.window?.decorView?.let(::findWebView)
    }

    private fun findWebView(view: View): WebView? = when (view) {
        is WebView -> view.takeIf { it.isAttachedToWindow }
        is ViewGroup -> (0 until view.childCount).firstNotNullOfOrNull { findWebView(view.getChildAt(it)) }
        else -> null
    }

    private fun evaluate(view: WebView, script: String): String? {
        val latch = CountDownLatch(1)
        var value: String? = null
        instrumentation.runOnMainSync {
            view.evaluateJavascript(script) {
                value = it
                latch.countDown()
            }
        }
        return if (latch.await(SCRIPT_SECONDS, TimeUnit.SECONDS)) value else null
    }

    private fun <T> onMain(block: () -> T): T {
        var result: Result<T>? = null
        instrumentation.runOnMainSync { result = runCatching(block) }
        return checkNotNull(result).getOrThrow()
    }

    /** A state for a failure message: the last server lines of a failure, and never a session's token. */
    fun describe(state: ServerState): String = when (state) {
        is ServerState.Failed ->
            "Failed(canRestart=${state.canRestart}, last=${state.lastLines.takeLast(FAILED_LINES)})"
        is ServerState.Running -> "Running(port=${state.session.port}, originChanged=${state.originChanged})"
        else -> state.toString()
    }

    /** When a server run reached Running, its page loaded and its UI showed, in ms after the wait's start. */
    class Arrival(val session: LaunchSession, val runningMillis: Long, val pageMillis: Long, val uiMillis: Long)

    companion object {
        const val UI_MILLIS = 60_000L
        const val POLL_MILLIS = 500L
        private const val SHADE_MILLIS = 10_000L
        private const val DIALOG_MILLIS = 10_000L
        private const val RETAP_MILLIS = 2_000L
        private const val SETTLE_MILLIS = 1_000L
        private const val SCRIPT_SECONDS = 10L
        private const val SCROLL_PERCENT = 0.8f
        private const val FAILED_LINES = 20
        private const val STATUS_TIMING = 2
        private const val STATUS_KEY = "app_e2e"
        private const val LOG_TAG = "AppDeviceTest"
        private const val BUTTON = "android.widget.Button"
        private const val APP_NAME = "android:id/app_name_text"
        private const val EXPAND = "android:id/expand_button"
        private const val SYSTEM_UI = "com.android.systemui"
        // The page scripts are ES5 only, because the old system WebViews that cannot run the frontend run them too.
        private const val PAGE_STATE = "(function () { " +
            "if (document.title !== 'SillyBunny') return 'none'; " +
            "if (document.getElementById('send_textarea') === null) return 'none'; " +
            "return document.getElementById('preloader') === null ? 'booted' : 'loaded'; })()"
        // A field is on top when a tap on its center hits it. A modal dialog is drawn above every z-index and makes
        // the rest of the page inert, so a probe that the top dialog covers moves into that dialog.
        private const val CENTER = "function center(field) { var box = field.getBoundingClientRect(); " +
            "var x = box.left + box.width / 2, y = box.top + box.height / 2; " +
            "if (box.width === 0 || x < 0 || y < 0) return null; " +
            "if (x >= window.innerWidth || y >= window.innerHeight) return null; " +
            "var hit = document.elementFromPoint(x, y); " +
            "return hit !== null && field.contains(hit) ? [x, y, window.devicePixelRatio].join(',') : null; } "
        private const val TOP_FIELD = "(function () { $CENTER" +
            "var fields = [document.getElementById('send_textarea')].concat(" +
            "Array.prototype.slice.call(document.querySelectorAll('textarea, input[type=\"text\"]'))); " +
            "for (var i = 0; i < fields.length; i++) { var found = fields[i] && center(fields[i]); " +
            "if (found) return found; } return 'none'; })()"
        private const val PROBE_FIELD = "(function () { $CENTER" +
            "var probe = document.createElement('textarea'); " +
            "probe.style.cssText = 'position:fixed;left:0;bottom:0;width:100%;height:48px;z-index:2147483647'; " +
            "document.body.appendChild(probe); var found = center(probe); if (found) return found; " +
            "var box = probe.getBoundingClientRect(); " +
            "var hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2); " +
            "var dialog = hit !== null ? hit.closest('dialog') : null; if (dialog === null) return 'none'; " +
            "dialog.appendChild(probe); return center(probe) || 'none'; })()"
        private const val SETTLED_POLLS = 4
        private const val FIELD_MILLIS = 20_000L

        /** Compose test tags of this app's screens; system views have `package:id/name` ids instead. */
        private val APP_TAG: Pattern = Pattern.compile("[a-z]+_[^:/]+")
        private val PERMISSION_ALLOW: Pattern = Pattern.compile(".*:id/permission_allow_button")
        private val ERROR_TAGS = listOf(
            AppTags.FAILED,
            AppTags.RUNTIME_ERROR,
            "firstrun_error",
            "repair_failed",
            "repair_refused",
        )

        fun sha256(file: File): String = MessageDigest.getInstance("SHA-256").digest(file.readBytes())
            .joinToString("") { "%02x".format(it) }
    }
}

/**
 * The lines a growing log file gained since the last call. A shorter file means the log rotated, so reading starts
 * over at the new file's beginning.
 */
internal class LogWatch(private val file: File) {
    private var offset = 0L
    private val pending = StringBuilder()

    fun newLines(): List<String> {
        val length = file.length()
        if (length < offset) offset = 0
        if (length == offset) return emptyList()
        val bytes = try {
            RandomAccessFile(file, "r").use { input ->
                input.seek(offset)
                ByteArray((length - offset).toInt()).also { input.readFully(it) }
            }
        } catch (_: IOException) {
            return emptyList()
        }
        offset = length
        pending.append(String(bytes, Charsets.UTF_8))
        val end = pending.lastIndexOf("\n")
        if (end < 0) return emptyList()
        val lines = pending.substring(0, end).split('\n')
        pending.delete(0, end + 1)
        return lines
    }
}
