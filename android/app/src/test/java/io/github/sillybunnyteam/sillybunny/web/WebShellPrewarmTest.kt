package io.github.sillybunnyteam.sillybunny.web

import android.app.Activity
import android.content.ComponentCallbacks2
import android.content.Context
import android.content.MutableContextWrapper
import android.content.pm.PackageInfo
import android.net.Uri
import android.os.Looper
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner
import androidx.test.core.app.ApplicationProvider
import io.github.sillybunnyteam.sillybunny.server.LaunchSession
import java.nio.file.Files
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class WebShellPrewarmTest {
    @get:Rule
    val temp = TemporaryFolder()

    private val appContext: Context = ApplicationProvider.getApplicationContext()
    private val log = EventLog()
    private val platform = PrewarmFakePlatform(log)
    private val chooser = RecordingChooser(log)
    private val downloads = RecordingDownloads(log)
    private val session = LaunchSession(41_234, "ab".repeat(32))
    private val address = WebAddress(LABEL)
    private val origin = address.origin(session)
    private val shells = mutableListOf<WebShell>()
    private val stores = mutableListOf<ViewModelStore>()

    @After
    fun tearDown() {
        shells.forEach(WebShell::release)
        stores.forEach(ViewModelStore::clear)
        WebShell.discardPrewarmed()
        shadowOf(Looper.getMainLooper()).idle()
    }

    @Test
    fun prewarmUsesApplicationContextNeverLoadsAppUrlAndHandsOffCleanlyOnBind() {
        val activityController = Robolectric.buildActivity(Activity::class.java).setup()
        val activity = activityController.get()

        // Passing an Activity still wraps only applicationContext so no Activity leaks while prewarmed.
        WebShell.prewarm(activity, platform)
        assertTrue(WebShell.hasPrewarmed(platform))
        assertEquals(1, platform.views.size)
        assertEquals(1, platform.configureCalls)
        assertEquals(1, platform.warmCookies)
        assertEquals(1, platform.warmRenderers)
        val warmView = platform.views.single()
        val wrapper = warmView.context as MutableContextWrapper
        assertSame(appContext, wrapper.baseContext)
        assertTrue(log.events.none { it.startsWith("load ") })

        // Calling prewarm again for the same platform is a no-op.
        WebShell.prewarm(appContext, platform)
        assertEquals(1, platform.views.size)

        // While prewarmed, non-blank requests are blocked locally.
        val prewarmClient = shadowOf(warmView).webViewClient
        assertEquals(403, prewarmClient.shouldInterceptRequest(warmView, FakeRequest("https://example.com/x"))?.statusCode)
        assertNull(prewarmClient.shouldInterceptRequest(warmView, FakeRequest("about:blank")))

        // bind() reuses the warm WebView, attaches downloads before loading, and mounts onto the Activity.
        val shell = WebShell(appContext, platform).also { shells += it }
        val container = FrameLayout(activity)
        shell.mount(container)
        shell.bind(session, address, chooser, downloads)
        assertFalse(WebShell.hasPrewarmed(platform))
        assertSame(warmView, shell.webView)
        assertSame(activity, wrapper.baseContext)
        assertSame(container, warmView.parent)
        assertEquals(listOf("attach downloads w1 41234", "cookie $origin"), log.events)

        platform.cookies.single().done(true)
        assertEquals("load w1 $origin/", log.events.last())

        // Prewarm about:blank history is pruned on first app commit so canGoBack starts false.
        shadowOf(warmView).pushEntryToHistory("about:blank")
        shadowOf(warmView).pushEntryToHistory("$origin/")
        shadowOf(warmView).webViewClient.onPageFinished(warmView, "$origin/")
        assertFalse(shell.canGoBack)

        // Unmounting resets MutableContextWrapper back to applicationContext.
        shell.unmount(container)
        assertSame(appContext, wrapper.baseContext)
        activityController.destroy()
    }

    @Test
    fun prewarmForDefaultPlatformDoesNotInterfereWithAnotherPlatform() {
        val otherPlatform = PrewarmFakePlatform(EventLog())
        WebShell.prewarm(appContext, otherPlatform)
        assertTrue(WebShell.hasPrewarmed(otherPlatform))

        val shell = WebShell(appContext, platform).also { shells += it }
        shell.bind(session, address, chooser, downloads)
        assertEquals(1, platform.views.size)
        assertNotSame(otherPlatform.views.single(), shell.webView)
        assertTrue(WebShell.hasPrewarmed(otherPlatform))
    }

    @Test
    fun rendererDeathDuringPrewarmEvictsStaleViewAndBindCreatesFreshOne() {
        WebShell.prewarm(appContext, platform)
        val deadWarm = platform.views.single()
        assertTrue(shadowOf(deadWarm).webViewClient.onRenderProcessGone(deadWarm, FakeRenderProcessGoneDetail()))
        assertFalse(WebShell.hasPrewarmed(platform))
        assertTrue(shadowOf(deadWarm).wasDestroyCalled())

        val shell = WebShell(appContext, platform).also { shells += it }
        shell.bind(session, address, chooser, downloads)
        assertEquals(2, platform.views.size)
        assertSame(platform.views[1], shell.webView)
    }

    @Test
    fun existingLookupDoesNotInstantiateHolderAndLifecycleHooksPreserveTimers() {
        val store = ViewModelStore().also { stores += it }
        val owner = object : ViewModelStoreOwner {
            override val viewModelStore: ViewModelStore = store
        }
        assertNull(WebShell.existing(owner))

        // Trim memory evicts an unclaimed prewarmed WebView without instantiating a shell for owner.
        WebShell.prewarm(appContext, platform)
        assertTrue(WebShell.hasPrewarmed(platform))
        WebShell.onTrimMemory(owner, ComponentCallbacks2.TRIM_MEMORY_UI_HIDDEN)
        assertFalse(WebShell.hasPrewarmed(platform))
        assertNull(WebShell.existing(owner))

        val holder = WebShellHolder.get(owner, WebShellHolder.factory { WebShell(appContext, platform) })
        assertNull(WebShell.existing(owner))
        val shell = holder.shell().also { shells += it }
        assertSame(shell, WebShell.existing(owner))

        shell.bind(session, address, chooser, downloads)
        val view = shell.webView as LifecycleRecordingWebView

        shell.onPause()
        assertEquals(1, view.pauses)
        assertEquals(0, view.pauseTimersCalls)

        shell.onResume()
        assertEquals(1, view.resumes)
        assertEquals(0, view.pauseTimersCalls)

        WebShell.onTrimMemory(owner, ComponentCallbacks2.TRIM_MEMORY_UI_HIDDEN)
        assertEquals(listOf(false), view.clearCacheIncludeDisk)
    }

    @Test
    fun webShellAndServiceWorkerClientsServeStaticAssetsWhileKeepingContainment() {
        val checkout = temp.newFolder("checkout").toPath()
        val scriptFile = checkout.resolve("public/scripts/app.js")
        Files.createDirectories(scriptFile.parent)
        Files.writeString(scriptFile, "export const fast = true;\n")
        val interceptor = StaticAssetInterceptor(checkout)

        val shell = WebShell(
            appContext = appContext,
            platform = platform,
            staticAssets = interceptor,
        ).also { shells += it }
        shell.bind(session, address, chooser, downloads)
        platform.cookies.single().done(true)
        val view = checkNotNull(shell.webView)
        val client = shadowOf(view).webViewClient

        // App-origin static JS is served directly from disk with text/javascript.
        val hit = checkNotNull(client.shouldInterceptRequest(view, FakeRequest("$origin/scripts/app.js", mainFrame = false)))
        assertEquals(200, hit.statusCode)
        assertEquals("text/javascript", hit.mimeType)
        assertEquals("export const fast = true;\n", hit.data.use { it.bufferedReader().readText() })

        // Dynamic app routes still return null so Express handles them.
        assertNull(client.shouldInterceptRequest(view, FakeRequest("$origin/api/status", mainFrame = false)))
        assertNull(client.shouldInterceptRequest(view, FakeRequest("$origin/lib.js", mainFrame = false)))

        // Other loopback ports remain blocked with 403 Forbidden.
        assertEquals(403, client.shouldInterceptRequest(view, FakeRequest("http://127.0.0.1:41234/scripts/app.js", mainFrame = false))?.statusCode)

        // ServiceWorker hook gets both containment and static asset serving.
        val swIntercept = checkNotNull(platform.interceptRequest)
        val swHit = checkNotNull(swIntercept(FakeRequest("$origin/scripts/app.js", mainFrame = false)))
        assertEquals("text/javascript", swHit.mimeType)
        assertTrue(checkNotNull(platform.blockRequest)(Uri.parse("http://127.0.0.1:41234/scripts/app.js")))
    }

    private class LifecycleRecordingWebView(
        context: Context,
        private val name: String,
        private val log: EventLog,
    ) : WebView(context) {
        var pauses = 0
        var resumes = 0
        var pauseTimersCalls = 0
        val clearCacheIncludeDisk = mutableListOf<Boolean>()

        override fun loadUrl(url: String) {
            log += "load $name $url"
            super.loadUrl(url)
        }

        override fun destroy() {
            log += "destroy $name"
            super.destroy()
        }

        override fun onPause() {
            pauses++
            super.onPause()
        }

        override fun onResume() {
            resumes++
            super.onResume()
        }

        override fun pauseTimers() {
            pauseTimersCalls++
            super.pauseTimers()
        }

        override fun clearCache(includeDiskFiles: Boolean) {
            clearCacheIncludeDisk += includeDiskFiles
            super.clearCache(includeDiskFiles)
        }

        override fun toString(): String = name
    }

    private class PrewarmFakePlatform(private val log: EventLog) : WebShellPlatform {
        val views = mutableListOf<LifecycleRecordingWebView>()
        val cookies = mutableListOf<CookieCall>()
        var configureCalls = 0
        var warmCookies = 0
        var warmRenderers = 0
        var blockRequest: ((Uri) -> Boolean)? = null
        var interceptRequest: ((WebResourceRequest) -> WebResourceResponse?)? = null

        override fun newWebView(context: Context): WebView =
            LifecycleRecordingWebView(context, "w${views.size + 1}", log).also { views += it }

        override fun setCookie(url: String, value: String, done: (Boolean) -> Unit) {
            log += "cookie $url"
            cookies += CookieCall(url, value, done)
        }

        override fun configureProcess(blockRequest: (Uri) -> Boolean) {
            configureProcess(blockRequest) { null }
        }

        override fun configureProcess(
            blockRequest: (Uri) -> Boolean,
            interceptRequest: (WebResourceRequest) -> WebResourceResponse?,
        ) {
            configureCalls++
            this.blockRequest = blockRequest
            this.interceptRequest = interceptRequest
        }

        override fun warmCookieManager() {
            warmCookies++
        }

        override fun warmRenderer(webView: WebView) {
            warmRenderers++
        }

        override fun currentWebViewPackage(context: Context): PackageInfo? = null

        override fun openExternal(context: Context, uri: Uri): Boolean = true
    }

    private companion object {
        const val LABEL = "sb-abcdefghijklmnopqrstuvwxyz"
    }
}
