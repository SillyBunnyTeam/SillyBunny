package io.github.sillybunnyteam.sillybunny.web.downloads

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Until
import io.github.sillybunnyteam.sillybunny.R
import java.io.File
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TestRule
import org.junit.runner.RunWith

/**
 * Page exports and HTTP downloads end to end (plan §4.5, S2.7b patterns) in the app's real WebView shell
 * ([TransferHost] hosts [io.github.sillybunnyteam.sillybunny.web.WebScreen]) against the host fixture
 * server, on the app's per-install web origin. Destinations are MediaStore items handed back through
 * [HostRegistry]. Tests that need the page script skip on a WebView without the bridge; the rest also
 * cover that WebView.
 */
@RunWith(AndroidJUnit4::class)
class WebTransfersDeviceTest {
    @get:Rule
    val mediaProcesses: TestRule = MediaProcessRule()

    private val fixture = TransferFixture()
    private var host: TransferHost? = null

    @Before
    fun setUp() {
        fixture.reset()
    }

    @After
    fun tearDown() {
        try {
            host?.close()
        } finally {
            Media.cleanup()
        }
    }

    private fun launch(platform: TransferPlatform = AndroidTransferPlatform, realPicker: Boolean = false): TransferHost {
        val launched = TransferHost(fixture, realPicker = realPicker, platform = platform)
        host = launched
        return launched.launch()
    }

    /** A host whose WebView has the bridge; skips the test on a WebView without it. */
    private fun bridgedHost(): TransferHost {
        val launched = launch()
        assumeTrue("no bridge on WebView ${HostWeb.webViewMajor()}", launched.bridged())
        return launched
    }

    /** Answers [launch] with a new destination and waits for the [saved]th saved notice. */
    private fun save(host: TransferHost, launch: HostRegistry.Launch, tag: String, saved: Int = 1, timeoutMillis: Long = 60_000): Uri {
        val destination = Media.destination(tag)
        assertTrue("result delivered", host.registry.answer(launch, Activity.RESULT_OK, Media.result(listOf(destination))))
        host.waitNotice(R.string.web_transfer_saved, saved, timeoutMillis)
        return destination
    }

    private fun js(value: String): String = JSONObject.quote(value)

    @Test
    fun bridgeIsOnlyForTheAppOrigin() {
        val host = launch()
        val view = host.webView()
        // A sandboxed frame of the app's own page has an opaque origin, so it is another origin.
        val frame = JSONObject(HostWeb.waitResult(view, "frame", 20_000))
        assertEquals("opaque-origin frame sees no bridge", "undefined", frame.getString("bridge"))
        assertEquals("opaque-origin frame sees no page script", "undefined", frame.getString("api"))
        val state = JSONObject(checkNotNull(HostWeb.fx(view, "state()")))
        HostWeb.note("bridged=${host.bridged()} webview=${HostWeb.webViewMajor()} main frame state=$state")
        assertEquals(if (host.bridged()) "object" else "undefined", state.getString("api"))
        // The page script keeps the message channel to itself: the app's own frame cannot reach it either.
        assertEquals("main frame sees no bridge global", "undefined", state.getString("bridge"))
    }

    @Test
    fun immediatelyRevokedExportIsSavedAfterThePickerAnswers() {
        val host = bridgedHost()
        val view = host.webView()
        assertEquals("ok", HostWeb.fx(view, "helper(5000, 3, 'chat.jsonl', 'application/jsonl')"))
        val launch = host.registry.next()
        assertEquals(Intent.ACTION_CREATE_DOCUMENT, launch.action)
        assertTrue(launch.intent.hasCategory(Intent.CATEGORY_OPENABLE))
        assertEquals("chat.jsonl", launch.title)
        assertEquals(FileNames.saveMime("chat.jsonl"), launch.type)
        Thread.sleep(500)
        val destination = save(host, launch, "immediate")
        assertArrayEquals(patternBytes(5000, 3), Media.read(destination))
        host.waitIdle()
        assertEquals(0, host.count(R.string.web_transfer_failed))
    }

    @Test
    fun revocationTimersDoNotLoseExports() {
        val host = bridgedHost()
        val view = host.webView()
        // Archive (0 ms) and QIG (1 s) timers; the destination is chosen after the URL is gone.
        // 600000 bytes is three chunks, the last one short.
        for ((index, delay) in listOf(0, 1_000).withIndex()) {
            val seed = 11 + index
            HostWeb.fx(view, "revokeLater(600000, $seed, 'timer-$delay.bin', $delay)")
            val launch = host.registry.next()
            assertEquals("timer-$delay.bin", launch.title)
            Thread.sleep(delay + 1_500L)
            val destination = save(host, launch, "timer$delay", saved = index + 1)
            assertArrayEquals(patternBytes(600000, seed), Media.read(destination))
        }
    }

    @Test
    fun exportRevokedAfterSixtySecondsIsSavedAfterwards() {
        val host = bridgedHost()
        val view = host.webView()
        HostWeb.fx(view, "revokeLater(300000, 13, 'debug-log.txt', 60000)")
        val launch = host.registry.next()
        assertEquals("debug-log.txt", launch.title)
        Thread.sleep(61_000)
        val destination = save(host, launch, "sixty")
        assertArrayEquals(patternBytes(300000, 13), Media.read(destination))
    }

    @Test
    fun appendedAnchorExport() {
        val host = bridgedHost()
        val view = host.webView()
        HostWeb.fx(view, "appended(4096, 14, 'Seraphina.png')")
        val launch = host.registry.next()
        assertEquals("Seraphina.png", launch.title)
        assertEquals("image/png", launch.type)
        val destination = save(host, launch, "appended")
        assertArrayEquals(patternBytes(4096, 14), Media.read(destination))
    }

    @Test
    fun realTapOnAnExportLink() {
        val host = bridgedHost()
        val view = host.webView()
        HostWeb.tap(view, "tapExport")
        val launch = host.registry.next()
        assertEquals("tapped.json", launch.title)
        assertEquals("application/json", launch.type)
        val destination = save(host, launch, "tap")
        assertArrayEquals(patternBytes(3000, 21), Media.read(destination))
    }

    @Test
    fun nonCancelableClickFallsBackToTheDownloadListener() {
        val host = bridgedHost()
        val view = host.webView()
        HostWeb.fx(view, "nonCancelable(2048, 15, 'plain.txt')")
        val launch = host.registry.next()
        assertEquals("name kept from the click", "plain.txt", launch.title)
        val destination = save(host, launch, "noncancelable")
        assertArrayEquals(patternBytes(2048, 15), Media.read(destination))
        host.registry.none()
    }

    @Test
    fun largeExportStreamsInChunks() {
        val host = bridgedHost()
        val view = host.webView()
        val size = 64 shl 20
        HostWeb.text(view, "window.fx.helper($size, 16, 'big.bin', 'application/octet-stream')", 120_000)
        val launch = host.registry.next(60_000)
        assertEquals("big.bin", launch.title)
        val started = System.nanoTime()
        val destination = save(host, launch, "large", timeoutMillis = 300_000)
        HostWeb.note("64 MiB export written in ${(System.nanoTime() - started) / 1_000_000} ms")
        assertEquals(patternSha256(size.toLong(), 16), Media.sha256(destination))
        host.waitIdle()
    }

    @Test
    fun saveAllQueuesOnePickerAtATime() {
        val host = bridgedHost()
        val view = host.webView()
        HostWeb.fx(view, "saveAll(3, 2000, 300)")
        for (index in 1..3) {
            val launch = host.registry.next()
            assertEquals("generated-1700000000000-$index.png", launch.title)
            if (index < 3) host.registry.none(1_500)
            val destination = save(host, launch, "all$index", saved = index)
            assertArrayEquals(patternBytes(2000, index), Media.read(destination))
        }
        host.waitIdle()
    }

    @Test
    fun pickerCancelEndsTheExportQuietly() {
        val host = bridgedHost()
        val view = host.webView()
        HostWeb.fx(view, "helper(1000, 17, 'cancel.json', 'application/json')")
        val launch = host.registry.next()
        assertTrue(host.registry.cancel(launch))
        host.waitIdle()
        assertEquals(0, host.count(R.string.web_transfer_saved))
        assertEquals(0, host.count(R.string.web_transfer_failed))
    }

    @Test
    fun navigationCancelsTheExportAndDiscardsALateDestination() {
        val host = bridgedHost()
        val view = host.webView()
        HostWeb.fx(view, "helper(1000, 18, 'leaving.json', 'application/json')")
        val launch = host.registry.next()
        HostWeb.fx(view, "navigate('/page2.html')")
        HostWeb.waitFor("page2") { HostWeb.title(view) == "fixture-page2" }
        host.waitIdle()
        assertEquals("cancelled quietly while the picker was open", 0, host.count(R.string.web_transfer_failed))
        val destination = Media.destination("late")
        host.registry.answer(launch, Activity.RESULT_OK, Media.result(listOf(destination)))
        // The user pressed Save for an export that is gone: they are told it failed.
        host.waitNotice(R.string.web_transfer_failed)
        HostWeb.waitFor("late destination discarded") { !Media.exists(destination) }
        assertEquals(listOf(destination), host.discarded.toList())
        assertEquals(0, host.count(R.string.web_transfer_saved))
        assertEquals(1, host.count(R.string.web_transfer_failed))
    }

    @Test
    fun detachCancelsExports() {
        val host = bridgedHost()
        val view = host.webView()
        HostWeb.fx(view, "helper(1000, 19, 'detached.json', 'application/json')")
        val launch = host.registry.next()
        val transfers = host.transfers()
        onMain { transfers.detach(view) }
        host.waitIdle()
        assertFalse(host.bridged())
        val destination = Media.destination("detach")
        host.registry.answer(launch, Activity.RESULT_OK, Media.result(listOf(destination)))
        host.waitNotice(R.string.web_transfer_failed)
        HostWeb.waitFor("destination discarded") { !Media.exists(destination) }
        assertEquals(0, host.count(R.string.web_transfer_saved))
    }

    @Test
    fun capturedDataUrlExports() {
        val host = bridgedHost()
        val view = host.webView()
        HostWeb.fx(view, "dataBase64('hello base64', 'note.txt')")
        var launch = host.registry.next()
        assertEquals("note.txt", launch.title)
        assertArrayEquals("hello base64".toByteArray(), Media.read(save(host, launch, "data64")))
        val text = "héllo wörld ✓ 100%"
        HostWeb.fx(view, "dataPercent(${js(text)}, 'note2.txt')")
        launch = host.registry.next()
        assertEquals("note2.txt", launch.title)
        assertArrayEquals(text.toByteArray(Charsets.UTF_8), Media.read(save(host, launch, "datapct", saved = 2)))
        host.registry.none()
    }

    @Test
    fun nonCancelableDataUrlIsDecodedNatively() {
        val host = bridgedHost()
        val view = host.webView()
        HostWeb.fx(view, "dataNonCancelable('native data', 'ignored.txt')")
        val launch = host.registry.next()
        assertEquals("download.txt", launch.title)
        assertArrayEquals("native data".toByteArray(), Media.read(save(host, launch, "datanative")))
        host.registry.none()
    }

    @Test
    fun dataUrlsWorkWithoutTheBridge() {
        val host = launch(platform = NoBridgePlatform)
        val view = host.webView()
        assertFalse(host.bridged())
        HostWeb.fx(view, "dataBase64('no bridge data', 'nb.txt')")
        val launch = host.registry.next()
        assertEquals("download.txt", launch.title)
        assertArrayEquals("no bridge data".toByteArray(), Media.read(save(host, launch, "nobridge")))
    }

    @Test
    fun fetchedAttachmentIsSavedOnce() {
        val host = bridgedHost()
        val view = host.webView()
        HostWeb.fx(view, "fetchAttachment('backup.zip', 4000, 6)")
        val launch = host.registry.next()
        assertEquals("backup.zip", launch.title)
        host.registry.none()
        assertArrayEquals(patternBytes(4000, 6), Media.read(save(host, launch, "fetched")))
        assertTrue(HostWeb.waitResult(view, "fetched").startsWith("attachment"))
        assertEquals(listOf("POST"), fixture.app("/attachment").map { it.method })
    }

    @Test
    fun formPostDownloadIsNeverReplayed() {
        val host = launch()
        val view = host.webView()
        HostWeb.fx(view, "postForm()")
        if (host.bridged()) {
            host.waitNotice(R.string.web_transfer_failed)
        } else {
            // Without the page script the POST is invisible, so a reported download cannot be trusted as
            // a GET and the browser is offered. Older WebViews (74) never report a POST's download at all.
            val prompted = HostWeb.shown(OPEN_IN_BROWSER_TAG)
            val reported = host.downloadReports.any { "posted.json" in it }
            HostWeb.note("form POST download reported=$reported prompted=$prompted")
            assertEquals("prompt exactly when the WebView reports the download", reported, prompted)
            if (prompted) {
                HostWeb.clickTag(DISMISS_TAG)
                assertTrue(HostWeb.gone(DISMISS_TAG))
            }
        }
        host.registry.none(3_000)
        val hits = fixture.app("/attachment?name=posted.json")
        HostWeb.note("form POST requests: $hits")
        assertTrue(hits.isNotEmpty())
        assertTrue("never refetched with GET: $hits", hits.all { it.method == "POST" })
        assertEquals(0, host.openInBrowserCalls.get())
    }

    /**
     * A frame of the app's host on another loopback port would be same-site with the app origin, so a
     * form POST from it into the app origin would carry the launch cookie, with no page script there to
     * report it. The shell refuses that frame's request: nothing reaches the other port, and no POST, no
     * download and no prompt follow.
     */
    @Test
    fun aFormPostFromAnotherPortIsNeverReplayed() {
        val host = launch()
        val view = host.webView()
        val name = "otherport-post.json"
        HostWeb.fx(view, "postFromOtherPort(${js(name)})")
        host.registry.none(3_000)
        assertFalse("no prompt", HostWeb.shown(OPEN_IN_BROWSER_TAG, 2_000))
        HostWeb.note("other-port frame: bridged=${host.bridged()} webview=${HostWeb.webViewMajor()} log=${fixture.requests()}")
        assertEquals("the frame was refused", emptyList<String>(), fixture.escaped().map { it.toString() })
        assertEquals("no POST reached the app", emptyList<String>(), fixture.app("/attachment").map { it.toString() })
        assertTrue(host.downloadReports.toString(), host.downloadReports.isEmpty())
        assertEquals(0, host.openInBrowserCalls.get())
        assertEquals(0, host.count(R.string.web_transfer_saved))
    }

    @Test
    fun getNavigationAttachmentIsFetchedWithTheCookie() {
        val host = launch()
        val view = host.webView()
        HostWeb.fx(view, "navigate('/attachment?name=nav.json&n=2500&seed=7')")
        val launch = host.registry.next(20_000)
        assertEquals("nav.json", launch.title)
        assertArrayEquals(patternBytes(2500, 7), Media.read(save(host, launch, "navigation")))
        val gets = fixture.app("/attachment?name=nav.json")
        HostWeb.note("navigation attachment requests: $gets")
        assertTrue("the WebView's request and the app's fetch: $gets", gets.size >= 2)
        assertTrue(gets.all { it.method == "GET" && it.launchCookie })
    }

    @Test
    fun serverFileNameStarIsUsed() {
        val host = launch()
        val view = host.webView()
        val disposition = "attachment; filename=\"..\\\\..\\\\evil.txt\"; filename*=UTF-8''r%C3%A9sum%C3%A9.txt"
        HostWeb.fx(view, "navigate('/bytes?n=900&seed=23&disposition=' + encodeURIComponent(${js(disposition)}))")
        val launch = host.registry.next(20_000)
        assertEquals("résumé.txt", launch.title)
        assertArrayEquals(patternBytes(900, 23), Media.read(save(host, launch, "filenamestar")))
    }

    /** Server-named downloads take the same name rules on every WebView, bridged or not. */
    @Test
    fun hostileServerNamesBecomeSafeTitles() {
        val host = launch()
        val view = host.webView()
        val cases = listOf(
            Triple("attachment; filename=\"../../etc/passwd\"", "text/plain", "passwd.txt"),
            Triple("attachment; filename*=UTF-8''evil%E2%80%AEgnp.exe", "application/octet-stream", "evil_gnp.exe"),
            Triple("attachment; filename=\"con.txt\"", "text/plain", "_con.txt"),
            Triple("attachment; filename=\".json\"", "application/json", "download.json"),
            Triple("attachment; filename*=UTF-8''%E3%82%AD%E3%83%A3%E3%83%A9.png", "image/png", "キャラ.png"),
            Triple("attachment; filename=\"page\"", "application/json", "page.json"),
            Triple("attachment; filename=\"noext\"", "application/octet-stream", "noext"),
            Triple("attachment", "text/plain", "bytes.txt"),
        )
        for ((disposition, mime, title) in cases) {
            HostWeb.fx(view, "navigate('/bytes?n=10&type=' + encodeURIComponent(${js(mime)}) + '&disposition=' + encodeURIComponent(${js(disposition)}))")
            val launch = host.registry.next(20_000)
            assertEquals("title for $disposition", title, launch.title)
            assertEquals("type for $title", FileNames.saveMime(title), launch.type)
            host.registry.cancel(launch)
            host.waitIdle()
        }
    }

    /** A large HTTP download streams to its destination, and a second one waits for the first picker. */
    @Test
    fun largeAndQueuedHttpDownloads() {
        val host = launch()
        val view = host.webView()
        val size = 64 shl 20
        HostWeb.fx(view, "navigate('/bytes?n=$size&seed=5&disposition=' + encodeURIComponent('attachment; filename=\"big.bin\"'))")
        val first = host.registry.next(60_000)
        assertEquals("big.bin", first.title)
        HostWeb.fx(view, "navigate('/attachment?name=queued.json&n=700&seed=6')")
        host.registry.none(3_000)
        val started = System.nanoTime()
        val big = save(host, first, "http-large", timeoutMillis = 300_000)
        HostWeb.note("64 MiB HTTP download saved in ${(System.nanoTime() - started) / 1_000_000} ms")
        assertEquals(patternSha256(size.toLong(), 5), Media.sha256(big))
        val second = host.registry.next()
        assertEquals("queued.json", second.title)
        assertArrayEquals(patternBytes(700, 6), Media.read(save(host, second, "http-queued", saved = 2)))
        host.waitIdle()
    }

    /** Once a new document is picked, a download that still arrives streams into it instead of the cache. */
    @Test
    fun slowHttpDownloadStreamsIntoTheNewDocument() {
        val host = launch()
        val view = host.webView()
        val before = cacheParts()
        val size = 2_000_000
        HostWeb.fx(view, "navigate('/bytes?n=$size&seed=24&delay=150&disposition=' + encodeURIComponent('attachment; filename=\"slow.bin\"'))")
        val launch = host.registry.next(20_000)
        assertEquals("slow.bin", launch.title)
        val destination = Media.destination("slow")
        assertTrue(host.registry.answer(launch, Activity.RESULT_OK, Media.result(listOf(destination))))
        Thread.sleep(1_500)
        assertEquals("the body still arrives", 1, host.activeTransfers())
        assertEquals("what was buffered moved to the document", emptyList<String>(), cacheParts() - before)
        host.waitNotice(R.string.web_transfer_saved, timeoutMillis = 60_000)
        assertEquals(patternSha256(size.toLong(), 24), Media.sha256(destination))
        host.waitIdle()
        assertEquals(emptyList<String>(), cacheParts() - before)
    }

    /** Download buffers in the cache folder of [ContentTransferStorage]. */
    private fun cacheParts(): List<String> =
        File(ApplicationProvider.getApplicationContext<Context>().cacheDir, "web-transfers").walkTopDown()
            .filter { it.isFile && it.name.endsWith(".part") }
            .map { it.path }
            .toList()

    @Test
    fun sameOriginDownloadLinkUsesTheNameHintAndTheCookie() {
        val host = bridgedHost()
        val view = host.webView()
        HostWeb.fx(view, "httpAnchor('/bytes?n=1800&seed=8&type=application%2Fjson', 'datamaid.json')")
        val launch = host.registry.next()
        assertEquals("datamaid.json", launch.title)
        assertArrayEquals(patternBytes(1800, 8), Media.read(save(host, launch, "datamaid")))
        val hits = fixture.app("/bytes?n=1800")
        assertEquals("fetched once, by the app: $hits", 1, hits.size)
        assertTrue(hits.single().method == "GET" && hits.single().launchCookie)
    }

    @Test
    fun redirectsAreCheckedPerHop() {
        val host = bridgedHost()
        val view = host.webView()
        // Another port on 127.0.0.1, the app's own host on another port, and the server's native address,
        // which is another origin than the web origin. The page builds the label host itself.
        val targets = listOf(
            "'http://127.0.0.1:${fixture.otherPort}/bytes?n=10'",
            "'http://' + location.hostname + ':${fixture.otherPort}/bytes?n=11'",
            "'http://127.0.0.1:${fixture.port}/bytes?n=12'",
        )
        for ((index, target) in targets.withIndex()) {
            HostWeb.fx(view, "httpAnchor('/redirect?to=' + encodeURIComponent($target), 'leak$index.bin')")
            host.waitNotice(R.string.web_transfer_failed, index + 1)
        }
        host.registry.none()
        assertEquals("nothing reached the other port", emptyList<String>(), fixture.escaped().map { it.toString() })
        assertEquals("nothing followed to the native address", emptyList<String>(), fixture.app("/bytes?n=12").map { it.toString() })
        HostWeb.fx(view, "httpAnchor('/redirect?to=' + encodeURIComponent('/bytes?n=1200&seed=9'), 'redir.bin')")
        val launch = host.registry.next()
        assertEquals("redir.bin", launch.title)
        assertArrayEquals(patternBytes(1200, 9), Media.read(save(host, launch, "redirect")))
        val hops = fixture.app("/redirect") + fixture.app("/bytes?n=1200")
        assertTrue("cookie on every same-origin hop: $hops", hops.isNotEmpty() && hops.all { it.launchCookie })
        assertEquals(emptyList<String>(), fixture.escaped().map { it.toString() })
    }

    @Test
    fun hostileNamesAndTypesBecomeSafeTitles() {
        val host = bridgedHost()
        val view = host.webView()
        val cases = listOf(
            Triple("../../etc/passwd", "text/plain", "passwd.txt"),
            Triple("evil‮gnp.exe", "application/octet-stream", "evil_gnp.exe"),
            Triple("con.txt", "text/plain", "_con.txt"),
            Triple(".json", "application/json", "download.json"),
            Triple("a\u0000b:c?.txt", "text/plain", "a_b_c_.txt"),
            Triple("キャラクター.png", "image/png", "キャラクター.png"),
            Triple("", "text/plain", "download.txt"),
            Triple("noext", "", "noext"),
            Triple("noext", "application/octet-stream", "noext"),
            Triple("page", "application/json", "page.json"),
            Triple("x".repeat(300) + ".json", "application/json", "x".repeat(250) + ".json"),
        )
        for ((name, mime, title) in cases) {
            HostWeb.fx(view, "helper(10, 1, ${js(name)}, ${js(mime)})")
            val launch = host.registry.next()
            assertEquals("title for ${js(name)} $mime", title, launch.title)
            assertEquals("type for $title", FileNames.saveMime(title), launch.type)
            host.registry.cancel(launch)
            host.waitIdle()
        }
        assertEquals("application/json", FileNames.saveMime("page.json"))
        assertEquals("application/octet-stream", FileNames.saveMime("noext"))
    }

    @Test
    fun missingFeaturesOfferOpenInBrowser() {
        val host = launch(platform = NoBridgePlatform)
        val view = host.webView()
        assertFalse(host.bridged())
        assertEquals("undefined", JSONObject(checkNotNull(HostWeb.fx(view, "state()"))).getString("api"))
        HostWeb.fx(view, "revokeLater(1000, 20, 'lost.json', 5000)")
        assertTrue("prompt shown", HostWeb.shown(OPEN_IN_BROWSER_TAG))
        HostWeb.clickTag(OPEN_IN_BROWSER_TAG)
        HostWeb.waitFor("open in browser") { host.openInBrowserCalls.get() == 1 }
        assertTrue(HostWeb.gone(OPEN_IN_BROWSER_TAG))
        HostWeb.fx(view, "helper(1000, 20, 'lost2.json', 'application/json')")
        assertTrue(HostWeb.shown(DISMISS_TAG))
        HostWeb.clickTag(DISMISS_TAG)
        assertTrue(HostWeb.gone(DISMISS_TAG))
        assertEquals(1, host.openInBrowserCalls.get())
        host.registry.none()
    }

    @Test
    fun exportSurvivesActivityRecreation() {
        val host = bridgedHost()
        val view = host.webView()
        HostWeb.fx(view, "helper(300000, 22, 'recreated.json', 'application/json')")
        val launch = host.registry.next()
        host.scenario.recreate()
        assertSame(view, host.webView())
        val destination = save(host, launch, "recreate")
        assertArrayEquals(patternBytes(300000, 22), Media.read(destination))
    }

    /**
     * The system picker for real: DocumentsUI saves an export into Downloads and the system records
     * the result's URI grants, which the strict grant check must accept; then the file chooser opens
     * the same document from DocumentsUI and the page reads it back.
     */
    @Test
    fun realDocumentsUiRoundTrip() {
        val host = launch(realPicker = true)
        val view = host.webView()
        val name = "p56b-real-${System.currentTimeMillis()}.txt"
        val body = "real picker ${System.nanoTime()}"
        val device = HostWeb.device
        // With the bridge the page script streams this data: URL export; without it the app decodes it.
        HostWeb.fx(view, "dataBase64(${js(body)}, ${js(name)})")
        RealPicker.save()
        host.waitNotice(R.string.web_transfer_saved, timeoutMillis = 30_000)
        val saved = host.outputs.last()
        try {
            val savedName = checkNotNull(savedName(saved)) { "no name for $saved" }
            HostWeb.note("real destination $saved name=$savedName")
            assertEquals(body, Media.read(saved)?.toString(Charsets.UTF_8))
            host.open("chooser.html")
            HostWeb.tap(view, "single")
            val listed = checkNotNull(device.wait(Until.findObject(By.text(savedName)), 20_000)) { "$savedName not listed" }
            listed.click()
            val files = JSONArray(HostWeb.waitResult(view, "single", 20_000))
            assertEquals(1, files.length())
            assertEquals(savedName, files.getJSONObject(0).getString("name"))
            assertEquals(body, HostWeb.waitResult(view, "singleText"))
            assertEquals(0, host.count(R.string.web_files_rejected))
        } finally {
            // Only once the downloads provider has handled the app's close of the document.
            Documents.remove(saved)
        }
    }

    private fun savedName(uri: Uri): String? = runCatching {
        ApplicationProvider.getApplicationContext<Context>().contentResolver
            .query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
            ?.use { if (it.moveToFirst()) it.getString(0) else null }
    }.getOrNull()
}
