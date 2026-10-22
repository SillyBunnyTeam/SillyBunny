package io.github.sillybunnyteam.sillybunny.web.downloads

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Looper
import android.provider.DocumentsContract
import android.webkit.DownloadListener
import android.webkit.WebView
import androidx.activity.result.ActivityResult
import androidx.test.core.app.ApplicationProvider
import io.github.sillybunnyteam.sillybunny.R
import io.github.sillybunnyteam.sillybunny.server.LaunchSession
import io.github.sillybunnyteam.sillybunny.web.WebAddress
import io.github.sillybunnyteam.sillybunny.web.files.ContentUriPolicy
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.nio.ByteBuffer
import java.time.Duration
import java.util.Base64
import java.util.concurrent.AbstractExecutorService
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** Runs work inline, so a test controls ordering through the main looper alone. */
private class DirectExecutor : AbstractExecutorService() {
    @Volatile
    private var shut = false

    override fun execute(command: Runnable) {
        if (shut) throw RejectedExecutionException("shut down")
        command.run()
    }

    override fun shutdown() {
        shut = true
    }

    override fun shutdownNow(): MutableList<Runnable> {
        shut = true
        return mutableListOf()
    }

    override fun isShutdown(): Boolean = shut

    override fun isTerminated(): Boolean = shut

    override fun awaitTermination(timeout: Long, unit: TimeUnit): Boolean = true
}

/**
 * Keeps a transfer's work until the test runs it, so a test can act between two steps of the worker.
 * Like a real executor, work queued before [shutdown] still runs.
 */
private class ManualExecutor : AbstractExecutorService() {
    private val tasks = ArrayDeque<Runnable>()
    private var shut = false

    override fun execute(command: Runnable) {
        if (shut) throw RejectedExecutionException("shut down")
        tasks.addLast(command)
    }

    /** Runs the queued work, and work queued meanwhile, until none is left. */
    fun runAll() {
        while (tasks.isNotEmpty()) tasks.removeFirst().run()
    }

    override fun shutdown() {
        shut = true
    }

    override fun shutdownNow(): MutableList<Runnable> {
        shut = true
        return tasks.toMutableList().also { tasks.clear() }
    }

    override fun isShutdown(): Boolean = shut

    override fun isTerminated(): Boolean = shut && tasks.isEmpty()

    override fun awaitTermination(timeout: Long, unit: TimeUnit): Boolean = isTerminated()
}

private class FakePlatform : TransferPlatform {
    var bridge = true
    var binary = true
    var listener: BridgeListener? = null
    var downloads: DownloadListener? = null
    var origin: String? = null
    var removed = 0
    var evaluateResult: String? = "true"
    val evaluated = mutableListOf<String>()

    /** The main frame's document; tests set the app page, or another page. */
    @Volatile
    var page: String? = null

    /** The URLs whose WebView cookies were read, in order (worker threads). */
    val cookieUrls = CopyOnWriteArrayList<String>()

    override fun bridgeSupported(): Boolean = bridge

    override fun binarySupported(): Boolean = binary

    override fun installBridge(webView: WebView, origin: String, script: String, listener: BridgeListener): InstalledBridge {
        this.origin = origin
        this.listener = listener
        return InstalledBridge {
            removed++
            this.listener = null
        }
    }

    override fun setDownloadListener(webView: WebView, listener: DownloadListener?) {
        downloads = listener
    }

    override fun evaluate(webView: WebView, script: String, result: (String?) -> Unit) {
        evaluated += script
        result(evaluateResult)
    }

    override fun userAgent(webView: WebView): String = "WebViewUA"

    override fun pageUrl(webView: WebView): String? = page

    override fun cookies(url: String): String {
        cookieUrls += url
        return "sillybunny_launch=t0k3n"
    }
}

/**
 * Provider documents and the cache. A picked document not in [documents] is a new, empty one, as a
 * picker creates it; opening a document for writing empties it. Thread-safe for threaded workers.
 */
private class FakeStorage(private val dir: File) : TransferStorage {
    val documents = ConcurrentHashMap<Uri, ByteArray>()
    val outputs = ConcurrentHashMap<Uri, DocumentOutput>()

    /** Documents in the order they were opened for writing. */
    val opened = CopyOnWriteArrayList<Uri>()
    val discarded = CopyOnWriteArrayList<Uri>()
    val temps = CopyOnWriteArrayList<File>()

    /** Every open, close and removal of a document, in order, as "open <id>", "close <id>", "discard <id>". */
    val events = CopyOnWriteArrayList<String>()

    /** Runs on the closing thread just before a document's stream closes, so a test can hold the close. */
    @Volatile
    var beforeClose: (Uri) -> Unit = {}

    /** A document's stream; its first close is recorded in [events]. */
    inner class DocumentOutput(private val uri: Uri) : ByteArrayOutputStream() {
        @Volatile
        private var closed = false

        override fun close() {
            if (closed) return
            beforeClose(uri)
            closed = true
            events += "close ${uri.lastPathSegment}"
        }
    }

    /** The [events] of [uri] alone. */
    fun eventsOf(uri: Uri): List<String> = events.filter { it.substringAfter(' ') == uri.lastPathSegment }

    /** Documents whose provider reports no size. */
    val unknownSize: MutableSet<Uri> = ConcurrentHashMap.newKeySet()

    /** Free bytes in the cache, and on the volume of each listed document (unknown otherwise). */
    @Volatile
    var free = Long.MAX_VALUE
    val freeAt = ConcurrentHashMap<Uri, Long>()

    @Volatile
    var cleared = 0

    override fun openOutput(uri: Uri): OutputStream {
        opened += uri
        events += "open ${uri.lastPathSegment}"
        documents.remove(uri)
        return DocumentOutput(uri).also { outputs[uri] = it }
    }

    override fun sizeOf(uri: Uri): Long? = if (uri in unknownSize) null else (bytes(uri)?.size ?: 0).toLong()

    override fun discard(uri: Uri) {
        discarded += uri
        events += "discard ${uri.lastPathSegment}"
    }

    override fun newTempFile(): File = File.createTempFile("download", ".part", dir).also { temps += it }

    override fun freeBytes(): Long = free

    override fun freeBytesAt(uri: Uri): Long? = freeAt[uri]

    override fun freeBytes(output: OutputStream): Long? = outputs.entries.firstOrNull { it.value === output }?.key?.let { freeAt[it] }

    override fun clearStale() = Unit

    override fun clearOwn() {
        cleared++
    }

    /** What [uri] holds now. */
    fun bytes(uri: Uri): ByteArray? = outputs[uri]?.toByteArray() ?: documents[uri]
}

/**
 * A response body that stops before each offset in [pauses] until the test resumes it, so a test can
 * act while a fetch runs on its worker thread.
 */
private class SteppedInput(private val body: ByteArray, private val pauses: List<Int>) : InputStream() {
    private val reached = pauses.map { CountDownLatch(1) }
    private val resumed = pauses.map { CountDownLatch(1) }
    private var offset = 0

    /** Waits until the fetch stopped at pause [index]. */
    fun awaitPause(index: Int) = check(reached[index].await(10, TimeUnit.SECONDS)) { "the fetch never reached pause $index" }

    fun resume(index: Int) = resumed[index].countDown()

    override fun read(): Int {
        val one = ByteArray(1)
        return if (read(one, 0, 1) < 0) -1 else one[0].toInt() and 0xff
    }

    override fun read(b: ByteArray, off: Int, len: Int): Int {
        if (offset >= body.size) return -1
        val index = pauses.indexOf(offset)
        if (index >= 0) {
            reached[index].countDown()
            try {
                if (!resumed[index].await(10, TimeUnit.SECONDS)) throw IOException("never resumed")
            } catch (_: InterruptedException) {
                throw IOException("interrupted")
            }
        }
        val next = pauses.firstOrNull { it > offset } ?: body.size
        val count = minOf(len, next - offset)
        System.arraycopy(body, offset, b, off, count)
        offset += count
        return count
    }
}

private class ScriptedConnection(
    url: URL,
    private val status: Int,
    private val headers: Map<String, String>,
    private val body: () -> InputStream,
) : HttpURLConnection(url) {
    val sent = ConcurrentHashMap<String, String>()

    override fun connect() = Unit

    override fun disconnect() = Unit

    override fun usingProxy(): Boolean = false

    override fun getResponseCode(): Int = status

    override fun getHeaderField(name: String): String? = headers[name]

    override fun getContentType(): String? = headers["Content-Type"]

    override fun getContentLengthLong(): Long = headers["Content-Length"]?.toLong() ?: -1

    override fun getInputStream(): InputStream = body()

    override fun setRequestProperty(key: String, value: String) {
        sent[key] = value
    }
}

/** The transfer engine against a fake WebView platform, storage and network (plan §4.5). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [37])
class WebTransfersTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val address = WebAddress("sb-abcdefghijklmnopqrstuvwxyz")

    /** The web origin of the app's pages, as in the app: the per-install label, not the native address. */
    private val origin = "http://sb-abcdefghijklmnopqrstuvwxyz.localhost:41234"

    /** The server's own address, where HTTP downloads on [origin] connect. */
    private val native = "http://127.0.0.1:41234"
    private val session = LaunchSession(41234, "ab".repeat(32))
    private val platform = FakePlatform()
    private val storage = FakeStorage(context.cacheDir)
    private val held = mutableMapOf<Uri, Int>()
    private val notices = mutableListOf<Int>()
    private val launches = mutableListOf<Intent>()
    private val replies = mutableListOf<JSONObject>()
    private val routes = ConcurrentHashMap<String, Triple<Int, Map<String, String>, ByteArray>>()

    /** Responses with a 200 status whose body a test steps through. */
    private val streamed = ConcurrentHashMap<String, Pair<Map<String, String>, SteppedInput>>()
    private val requests = CopyOnWriteArrayList<ScriptedConnection>()
    private val limits = TransferLimits(chunkBytes = 4, window = 2, maxActive = 3, idleTimeoutMillis = 1_000, maxDataUrlChars = 200, maxDataUrlBytes = 100)
    private val readWrite = ContentUriPolicy.READ or ContentUriPolicy.WRITE
    private val doc = "0123456789abcdef"
    private val created = mutableListOf<WebTransfers>()
    private val threads = CopyOnWriteArrayList<ExecutorService>()

    /** The transfers' workers of an engine started with `manual`, in creation order. */
    private val manualWorkers = mutableListOf<ManualExecutor>()
    private var now = 0L
    private lateinit var transfers: WebTransfers
    private lateinit var view: WebView

    // On API 37 Robolectric answers MimeTypeMap lookups from the platform table (json, txt, ...).
    @Before
    fun setUp() = start()

    @After
    fun tearDown() {
        created.forEach(WebTransfers::release)
        threads.forEach(ExecutorService::shutdownNow)
    }

    /**
     * A fresh engine attached to a new WebView, bound, with the page's hello received when bridged.
     * With [threaded], each transfer's worker is a real thread, as in the app; with [manual], a
     * [ManualExecutor] in [manualWorkers] that runs only when the test says so; otherwise all work runs
     * inline and the main looper alone orders it.
     */
    private fun start(limits: TransferLimits = this.limits, bridge: Boolean = true, threaded: Boolean = false, manual: Boolean = false) {
        platform.bridge = bridge
        var workers = 0
        transfers = WebTransfers(
            context,
            originOf = address::origin,
            platform = platform,
            storage = storage,
            destinations = ContentUriPolicy(context, ownAuthorities = { emptySet() }) { uri, needed -> (held[uri] ?: 0) and needed == needed },
            limits = limits,
            notify = { notices += it },
            script = { "script" },
            clock = { now },
            // The first worker is the engine's own; the transfers' workers follow it.
            newWorker = {
                when {
                    workers++ == 0 -> DirectExecutor()
                    threaded -> Executors.newSingleThreadExecutor().also { threads += it }
                    manual -> ManualExecutor().also { manualWorkers += it }
                    else -> DirectExecutor()
                }
            },
            newFetch = { policy, cookies, agent -> HttpFetch(policy, cookies, agent, connect = ::connect) },
        ).also { created += it }
        view = WebView(context)
        platform.page = "$origin/"
        transfers.attach(view, session)
        transfers.bind { launches += it }
        if (bridge) hello()
    }

    /**
     * The network. Android's resolver does not resolve the label, so a request to it would fail: hops on the
     * web origin must connect to [native]. Routes are keyed by the URL the page used.
     */
    private fun connect(uri: URI): HttpURLConnection {
        if (uri.host.endsWith(".localhost")) throw AssertionError("connected to the web origin's name")
        val url = uri.toString().let { if (it.startsWith("$native/")) origin + it.removePrefix(native) else it }
        streamed[url]?.let { (headers, input) ->
            return ScriptedConnection(uri.toURL(), 200, headers) { input }.also { requests += it }
        }
        val (status, headers, body) = routes[url] ?: throw AssertionError("unexpected request to $uri")
        return ScriptedConnection(uri.toURL(), status, headers) { ByteArrayInputStream(body) }.also { requests += it }
    }

    private fun idle() = shadowOf(Looper.getMainLooper()).idle()

    /** Runs the main looper until [condition] holds, for work that threaded workers post. */
    private fun idleUntil(what: String, condition: () -> Boolean) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
        while (true) {
            idle()
            if (condition()) return
            check(System.nanoTime() < deadline) { "timed out waiting for $what" }
            Thread.sleep(5)
        }
    }

    private fun send(json: String, main: Boolean = true, from: String = origin) =
        checkNotNull(platform.listener) { "no bridge" }.onMessage(BridgeInput.Text(json), Uri.parse(from), main) { replies += JSONObject(it) }

    private fun frame(slot: Int, seq: Int, payload: ByteArray) {
        val data = ByteBuffer.allocate(8 + payload.size).putInt(slot).putInt(seq).put(payload).array()
        checkNotNull(platform.listener).onMessage(BridgeInput.Binary(data), Uri.parse(origin), true) { replies += JSONObject(it) }
    }

    private fun hello(document: String = doc) = send("""{"t":"hello","doc":"$document"}""")

    private fun begin(id: String, size: Long, name: String = "chat.json", mime: String = "application/json", key: String = "", document: String = doc) =
        send("""{"t":"begin","doc":"$document","id":"$id","name":"$name","mime":"$mime","size":$size,"key":"$key"}""")

    /** A new, empty document, as a picker creates one for a save. */
    private fun destination(name: String, grant: Int = readWrite): Uri =
        DocumentsContract.buildDocumentUri("com.android.externalstorage.documents", "primary:$name").also { held[it] = grant }

    /** An existing document holding [content] that the user picks to replace. */
    private fun existing(name: String, content: ByteArray): Uri = destination(name).also { storage.documents[it] = content }

    private fun answer(uri: Uri?, code: Int = Activity.RESULT_OK, flags: Int = readWrite) {
        transfers.onDestinationResult(ActivityResult(code, uri?.let { Intent().setData(it).addFlags(flags) }))
        idle()
    }

    private fun replies(type: String, id: String) = replies.filter { it.getString("t") == type && it.optString("id") == id }

    private fun exportId(char: Char) = char.toString().repeat(16)

    /**
     * The download listener reports [url]. With [get], an HTTP(S) URL first arrives as a main-frame
     * navigation, as a link or a location change does, which shows the download was a GET.
     */
    private fun download(url: String, disposition: String? = null, mime: String? = null, agent: String? = "ListenerUA", get: Boolean = true) {
        if (get && url.startsWith("http", ignoreCase = true)) assertFalse(transfers.handleNavigation(view, Uri.parse(url), true, true))
        checkNotNull(platform.downloads).onDownloadStart(url, agent, disposition, mime, -1)
        idle()
    }

    /** Streams [body] after `ready` and ends the export. */
    private fun stream(id: String, body: ByteArray) {
        val slot = replies("ready", id).single().getInt("slot")
        body.toList().chunked(limits.chunkBytes).forEachIndexed { seq, chunk ->
            frame(slot, seq, chunk.toByteArray())
            idle()
        }
        send("""{"t":"end","id":"$id","size":${body.size}}""")
        idle()
    }

    @Test
    fun bridgeIsInstalledForTheExactOrigin() {
        assertEquals("the web origin, never the native address", origin, platform.origin)
        assertTrue(transfers.hasBridge(view))
        start(bridge = false)
        assertFalse(transfers.hasBridge(view))
    }

    @Test
    fun pageExportStreamsOnlyAfterTheDestination() {
        val id = exportId('a')
        val body = "0123456789".toByteArray()
        begin(id, body.size.toLong())
        val launch = launches.single()
        assertEquals(Intent.ACTION_CREATE_DOCUMENT, launch.action)
        assertTrue(launch.hasCategory(Intent.CATEGORY_OPENABLE))
        assertEquals("chat.json", launch.getStringExtra(Intent.EXTRA_TITLE))
        assertEquals("application/json", launch.type)
        assertTrue("nothing is read before the user picks", replies("ready", id).isEmpty())
        val destination = destination("chat.json")
        answer(destination)
        val ready = replies("ready", id).single()
        assertEquals(4, ready.getInt("chunk"))
        assertEquals(2, ready.getInt("win"))
        assertTrue(ready.getBoolean("bin"))
        stream(id, body)
        assertEquals(listOf(0, 1, 2), replies("ack", id).map { it.getInt("seq") })
        assertEquals(1, replies("done", id).size)
        assertArrayEquals(body, storage.bytes(destination))
        assertEquals(listOf("open primary:chat.json", "close primary:chat.json"), storage.eventsOf(destination))
        assertEquals(listOf(R.string.web_transfer_saved), notices)
        assertEquals(0, transfers.activeCount)
    }

    @Test
    fun base64ChunksWithoutBinaryMessages() {
        platform.binary = false
        val id = exportId('b')
        begin(id, 6)
        val destination = destination("b64.json")
        answer(destination)
        assertFalse(replies("ready", id).single().getBoolean("bin"))
        val encoder = Base64.getEncoder()
        send("""{"t":"chunk","id":"$id","seq":0,"data":"${encoder.encodeToString("abcd".toByteArray())}"}""")
        idle()
        send("""{"t":"chunk","id":"$id","seq":1,"data":"${encoder.encodeToString("ef".toByteArray())}"}""")
        idle()
        send("""{"t":"end","id":"$id","size":6}""")
        idle()
        assertArrayEquals("abcdef".toByteArray(), storage.bytes(destination))
        assertEquals(listOf(R.string.web_transfer_saved), notices)
    }

    @Test
    fun protocolViolationsFailAndDiscardTheDestination() {
        fun failing(id: String, name: String, violate: (slot: Int) -> Unit) {
            notices.clear()
            begin(id, 10, name = name)
            val destination = destination(name)
            answer(destination)
            violate(replies("ready", id).single().getInt("slot"))
            idle()
            assertEquals(name, listOf(R.string.web_transfer_failed), notices)
            assertEquals(name, "cancelled", replies("cancel", id).single().getString("reason"))
            // Removed while the transfer still holds the stream, which is closed after that.
            assertEquals(name, listOf("open primary:$name", "discard primary:$name", "close primary:$name"), storage.eventsOf(destination))
            assertEquals(name, 0, transfers.activeCount)
        }
        failing(exportId('c'), "out-of-order.json") { slot -> frame(slot, 1, "abcd".toByteArray()) }
        failing(exportId('d'), "short-chunk.json") { slot -> frame(slot, 0, "abc".toByteArray()) }
        failing(exportId('e'), "window.json") { slot ->
            // Three chunks without an acknowledgement in between exceed the window of two.
            frame(slot, 0, "abcd".toByteArray())
            frame(slot, 1, "efgh".toByteArray())
            frame(slot, 2, "ij".toByteArray())
        }
        failing(exportId('f'), "size.json") { slot ->
            frame(slot, 0, "abcd".toByteArray())
            idle()
            send("""{"t":"end","id":"${exportId('f')}","size":4}""")
        }
        failing(exportId('0'), "abort.json") { _ -> send("""{"t":"abort","id":"${exportId('0')}"}""") }
    }

    @Test
    fun framesForOtherSlotsAreIgnored() {
        val id = exportId('a')
        begin(id, 4)
        val destination = destination("slot.json")
        answer(destination)
        val slot = replies("ready", id).single().getInt("slot")
        frame(slot + 1, 0, "zzzz".toByteArray())
        idle()
        assertTrue(notices.isEmpty())
        stream(id, "abcd".toByteArray())
        assertArrayEquals("abcd".toByteArray(), storage.bytes(destination))
    }

    @Test
    fun idleStreamsTimeOut() {
        val id = exportId('a')
        begin(id, 10)
        answer(destination("idle.json"))
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(1_001))
        assertEquals(listOf(R.string.web_transfer_failed), notices)
        assertEquals(1, replies("cancel", id).size)
    }

    @Test
    fun onlyMainFrameMessagesOfTheExactOriginCount() {
        begin(exportId('a'), 4)
        launches.clear()
        answer(null, Activity.RESULT_CANCELED)
        send("""{"t":"begin","doc":"$doc","id":"${exportId('b')}","name":"x","mime":"","size":4,"key":""}""", main = false)
        send("""{"t":"begin","doc":"$doc","id":"${exportId('c')}","name":"x","mime":"","size":4,"key":""}""", from = "http://127.0.0.1:41235")
        send("""{"t":"begin","doc":"$doc","id":"${exportId('d')}","name":"x","mime":"","size":4,"key":""}""", from = "http://localhost:41234")
        send("""{"t":"begin","doc":"$doc","id":"${exportId('e')}","name":"x","mime":"","size":4,"key":""}""", from = native)
        idle()
        assertTrue(launches.isEmpty())
        // POST notices count from any frame of the origin, so a subframe form never gets replayed either.
        send("""{"t":"post","doc":"$doc","url":"$origin/form"}""", main = false)
        download("$origin/form", get = false)
        assertEquals(listOf(R.string.web_transfer_failed), notices)
        assertTrue(requests.isEmpty())
    }

    @Test
    fun staleTooLargeAndDuplicateBeginsAreRefused() {
        begin(exportId('a'), 4, document = "f".repeat(16))
        assertEquals("refused", replies("cancel", exportId('a')).single().getString("reason"))
        begin(exportId('b'), 5L shl 30)
        assertEquals("refused", replies("cancel", exportId('b')).single().getString("reason"))
        assertEquals(listOf(R.string.web_transfer_failed), notices)
        begin(exportId('c'), 4)
        begin(exportId('c'), 4)
        assertEquals(1, replies("cancel", exportId('c')).size)
        assertEquals(1, launches.size)
    }

    @Test
    fun onePickerAtATimeAndAQueueLimit() {
        begin(exportId('a'), 4, name = "a.json")
        begin(exportId('b'), 4, name = "b.json")
        begin(exportId('c'), 4, name = "c.json")
        assertEquals(1, launches.size)
        begin(exportId('d'), 4, name = "d.json")
        assertEquals("over maxActive", "refused", replies("cancel", exportId('d')).single().getString("reason"))
        answer(null, Activity.RESULT_CANCELED)
        assertEquals(listOf("a.json", "b.json"), launches.map { it.getStringExtra(Intent.EXTRA_TITLE) })
        answer(destination("b.json"))
        assertEquals(listOf("a.json", "b.json", "c.json"), launches.map { it.getStringExtra(Intent.EXTRA_TITLE) })
        assertEquals("a cancelled picker is quiet", listOf(R.string.web_transfer_failed), notices)
        assertEquals(1, replies("cancel", exportId('a')).size)
    }

    @Test
    fun unusableDestinationsFail() {
        val bad = listOf(
            Uri.parse("file:///sdcard/Download/x.json"),
            Uri.parse("content://${context.packageName}.documents/document/x"),
            DocumentsContract.buildDocumentUri("com.android.externalstorage.documents", "primary:not-held"),
            destination("read-only.json", grant = ContentUriPolicy.READ),
        )
        for ((index, uri) in bad.withIndex()) {
            val id = exportId("abcd"[index])
            begin(id, 4)
            answer(uri)
            assertEquals(uri.toString(), index + 1, notices.count { it == R.string.web_transfer_failed })
            assertTrue(storage.outputs.isEmpty())
        }
        begin(exportId('e'), 4)
        answer(destination("no-flags.json"), flags = ContentUriPolicy.READ)
        assertEquals(5, notices.count { it == R.string.web_transfer_failed })
    }

    @Test
    fun navigationCancelsAndALateDestinationIsDiscarded() {
        begin(exportId('a'), 4)
        send("""{"t":"bye","doc":"$doc"}""")
        assertEquals(1, replies("cancel", exportId('a')).size)
        assertTrue("cancelled quietly while the picker is open", notices.isEmpty())
        val late = destination("late.json")
        answer(late)
        assertEquals("the new document the picker made is removed", listOf(late), storage.discarded)
        assertEquals("the Save is reported as failed", listOf(R.string.web_transfer_failed), notices)
        // A Cancel in the picker of a lost export says nothing.
        hello()
        begin(exportId('b'), 4)
        notices.clear()
        hello("2".repeat(16))
        assertEquals(1, replies("cancel", exportId('b')).size)
        answer(null, Activity.RESULT_CANCELED)
        assertTrue(notices.isEmpty())
    }

    /** The picker hands back an existing document when the user replaces it; it must survive a lost save. */
    @Test
    fun aLateSaveOverAnExistingDocumentKeepsIt() {
        begin(exportId('a'), 4)
        // As on renderer death or a session change while the picker is open.
        transfers.detach(view)
        val kept = existing("backup.zip", "zip bytes".toByteArray())
        answer(kept)
        assertTrue(storage.discarded.isEmpty())
        assertArrayEquals("zip bytes".toByteArray(), storage.bytes(kept))
        assertTrue(storage.opened.isEmpty())
        assertEquals(listOf(R.string.web_transfer_failed), notices)
        // An HTTP download that fails after its headers named it, then the user replaces a document.
        start()
        routes["$origin/short"] = Triple(200, mapOf("Content-Length" to "10"), "12345".toByteArray())
        download("$origin/short")
        val report = existing("short", "an earlier report".toByteArray())
        answer(report)
        assertTrue(storage.discarded.isEmpty())
        assertArrayEquals("an earlier report".toByteArray(), storage.bytes(report))
        assertEquals("the fetch and the lost Save", 3, notices.count { it == R.string.web_transfer_failed })
        assertTrue(storage.temps.none(File::exists))
    }

    @Test
    fun aNewDocumentCancelsTheOldDocumentsExports() {
        begin(exportId('a'), 4)
        begin(exportId('b'), 4)
        hello("1".repeat(16))
        assertEquals(1, replies("cancel", exportId('a')).size)
        assertEquals(1, replies("cancel", exportId('b')).size)
        assertEquals(0, transfers.activeCount)
    }

    @Test
    fun configurationChangesKeepThePickerAndLeavingCancelsIt() {
        begin(exportId('a'), 4)
        transfers.unbind(changingConfigurations = true)
        transfers.bind { launches += it }
        assertEquals("not launched again", 1, launches.size)
        val destination = destination("rotated.json")
        answer(destination)
        stream(exportId('a'), "abcd".toByteArray())
        assertArrayEquals("abcd".toByteArray(), storage.bytes(destination))
        begin(exportId('b'), 4)
        transfers.unbind(changingConfigurations = false)
        assertEquals(1, replies("cancel", exportId('b')).size)
        notices.clear()
        val gone = destination("gone.json")
        answer(gone)
        assertEquals("a Save after leaving is reported", listOf(R.string.web_transfer_failed), notices)
        assertEquals("and the new document removed", listOf(gone), storage.discarded)
        assertTrue(storage.opened.none { it == gone })
    }

    @Test
    fun exportsWaitForALauncher() {
        transfers.unbind(changingConfigurations = true)
        begin(exportId('a'), 4)
        assertTrue(launches.isEmpty())
        transfers.bind { launches += it }
        assertEquals(1, launches.size)
    }

    @Test
    fun detachAndReleaseTearDown() {
        begin(exportId('a'), 4)
        transfers.detach(view)
        assertEquals(1, platform.removed)
        assertEquals(null, platform.downloads)
        assertFalse(transfers.hasBridge(view))
        assertEquals(1, replies("cancel", exportId('a')).size)
        assertFalse(transfers.handleNavigation(view, Uri.parse("blob:$origin/x"), true, true))
        start()
        begin(exportId('b'), 4)
        transfers.release()
        assertEquals(1, replies("cancel", exportId('b')).size)
        assertEquals(0, transfers.activeCount)
        assertEquals(1, storage.cleared)
        assertEquals(2, platform.removed)
        transfers.attach(WebView(context), session)
        assertEquals("nothing is installed after release", null, platform.listener)
    }

    @Test
    fun blobNavigationsAskThePageScriptOnce() {
        val url = "blob:$origin/3f2a"
        assertTrue(transfers.handleNavigation(view, Uri.parse(url), true, false))
        assertTrue(platform.evaluated.single().contains("saveUrl(${JSONObject.quote(url)})"))
        begin(exportId('a'), 4, key = url)
        download(url)
        assertEquals("the captured export is not saved again", 1, platform.evaluated.size)
        platform.evaluateResult = "false"
        transfers.handleNavigation(view, Uri.parse("blob:$origin/gone"), true, false)
        assertEquals(listOf(R.string.web_transfer_failed), notices)
    }

    @Test
    fun withoutTheBridgeLostExportsOfferTheBrowser() {
        start(bridge = false)
        assertTrue(transfers.handleNavigation(view, Uri.parse("blob:$origin/x"), true, true))
        assertTrue(transfers.unsupportedPrompt)
        transfers.dismissUnsupported()
        assertFalse(transfers.unsupportedPrompt)
        download("$origin/file.json", get = false)
        assertTrue("no GET evidence without the page script", transfers.unsupportedPrompt)
        assertTrue(requests.isEmpty())
        transfers.unbind(changingConfigurations = false)
        assertFalse(transfers.unsupportedPrompt)
        transfers.handleNavigation(view, Uri.parse("blob:$origin/y"), true, true)
        assertEquals("no host to prompt", listOf(R.string.web_transfer_failed), notices)
    }

    @Test
    fun dataUrlsAreDecodedNatively() {
        assertTrue(transfers.handleNavigation(view, Uri.parse("data:text/plain;base64,aGk="), true, true))
        idle()
        assertEquals("download.txt", launches.single().getStringExtra(Intent.EXTRA_TITLE))
        val destination = destination("download.txt")
        answer(destination)
        assertArrayEquals("hi".toByteArray(), storage.bytes(destination))
        assertEquals(listOf(R.string.web_transfer_saved), notices)
        transfers.handleNavigation(view, Uri.parse("data:,${"x".repeat(250)}"), true, true)
        transfers.handleNavigation(view, Uri.parse("data:;base64,a"), true, true)
        idle()
        assertEquals(2, notices.count { it == R.string.web_transfer_failed })
    }

    @Test
    fun capturedDataUrlIsNotSavedAgain() {
        val url = "data:text/plain;base64,aGk="
        begin(exportId('a'), 2, key = url)
        download(url)
        assertEquals("only the page export", 1, launches.size)
    }

    @Test
    fun httpNavigationsAreNotTakenButProveAGet() {
        start(bridge = false)
        val url = "$origin/export/file.json"
        routes[url] = Triple(200, mapOf("Content-Type" to "application/json", "Content-Length" to "2"), "{}".toByteArray())
        assertFalse(transfers.handleNavigation(view, Uri.parse("$url#top"), true, true))
        download(url)
        assertFalse(transfers.unsupportedPrompt)
        assertEquals("file.json", launches.single().getStringExtra(Intent.EXTRA_TITLE))
        val destination = destination("file.json")
        answer(destination)
        assertArrayEquals("{}".toByteArray(), storage.bytes(destination))
        assertEquals("sillybunny_launch=t0k3n", requests.single().sent["Cookie"])
        assertEquals("ListenerUA", requests.single().sent["User-Agent"])
        assertTrue("temp file removed", storage.temps.none(File::exists))
    }

    @Test
    fun serverNamesAndHintsNameHttpDownloads() {
        val url = "$origin/bytes?n=2"
        routes[url] = Triple(200, mapOf("Content-Disposition" to "attachment; filename=\"../server.json\"", "Content-Length" to "2"), "ok".toByteArray())
        download(url, disposition = "attachment; filename=listener.json")
        assertEquals("server.json", launches.last().getStringExtra(Intent.EXTRA_TITLE))
        val hinted = "$origin/datamaid"
        routes[hinted] = Triple(200, mapOf("Content-Type" to "application/json"), "{}".toByteArray())
        send("""{"t":"get","doc":"$doc","url":"$hinted","name":"datamaid.json"}""")
        idle()
        answer(null, Activity.RESULT_CANCELED)
        assertEquals("datamaid.json", launches.last().getStringExtra(Intent.EXTRA_TITLE))
        download(hinted)
        assertEquals("the captured link is not fetched twice", 2, requests.size)
        assertEquals("WebViewUA", requests.last().sent["User-Agent"])
    }

    @Test
    fun refusedHttpDownloads() {
        routes["$origin/posted"] = Triple(200, emptyMap(), ByteArray(0))
        send("""{"t":"post","doc":"$doc","url":"$origin/posted"}""")
        download("$origin/posted", get = false)
        download("http://127.0.0.1:41235/other-port")
        download("$native/native-address")
        download("http://example.com/cleartext")
        send("""{"t":"get","doc":"$doc","url":"https://example.com/outside","name":"x"}""")
        send("""{"t":"get","doc":"${"f".repeat(16)}","url":"$origin/stale","name":"x"}""")
        idle()
        assertEquals(5, notices.count { it == R.string.web_transfer_failed })
        assertTrue(requests.isEmpty())
        assertTrue(launches.isEmpty())
    }

    @Test
    fun httpFailuresFail() {
        fun failed() = notices.count { it == R.string.web_transfer_failed }
        routes["$origin/500"] = Triple(500, emptyMap(), ByteArray(0))
        routes["$origin/short"] = Triple(200, mapOf("Content-Length" to "10"), "12345".toByteArray())
        routes["$origin/redirect"] = Triple(302, mapOf("Location" to "http://127.0.0.1:41235/x"), ByteArray(0))
        download("$origin/500")
        assertEquals(1, failed())
        assertTrue(launches.isEmpty())
        download("$origin/short")
        assertEquals(2, failed())
        assertEquals("the headers arrived before the body fell short", 1, launches.size)
        val late = destination("short")
        answer(late)
        assertEquals("the new document the picker made is removed", listOf(late), storage.discarded)
        assertEquals("the Save is reported as failed", 3, failed())
        download("$origin/redirect")
        assertEquals(4, failed())
        assertEquals(1, launches.size)
        assertTrue("partial files removed", storage.temps.none(File::exists))
        start(limits = TransferLimits(chunkBytes = 4, maxTransferBytes = 8))
        routes["$origin/big"] = Triple(200, mapOf("Content-Length" to "9"), ByteArray(9))
        download("$origin/big")
        assertEquals(5, failed())
        assertTrue(storage.outputs.isEmpty())
    }

    @Test
    fun aRepeatedDownloadReportIsOneDownload() {
        val url = "$origin/twice.txt"
        routes[url] = Triple(200, mapOf("Content-Type" to "text/plain", "Content-Length" to "2"), "hi".toByteArray())
        // As WebView 74 does for a text/plain attachment: the same URL twice, the second time as octet-stream.
        download(url, mime = "text/plain")
        download(url, mime = "application/octet-stream")
        assertEquals(1, requests.size)
        assertEquals(1, launches.size)
        download("blob:$origin/b1")
        download("blob:$origin/b1")
        assertEquals(1, platform.evaluated.size)
        answer(null, Activity.RESULT_CANCELED)
        now += WebTransfers.DUPLICATE_REPORT_MILLIS + 1
        download(url)
        assertEquals("a later report is a new download", 2, requests.size)
        assertEquals(2, launches.size)
        assertTrue(notices.isEmpty())
    }

    @Test
    fun cancellingAFetchedDownloadRemovesItsTempFile() {
        routes["$origin/f.json"] = Triple(200, mapOf("Content-Length" to "2"), "{}".toByteArray())
        download("$origin/f.json")
        assertEquals(1, storage.temps.size)
        assertTrue(storage.temps.single().exists())
        answer(null, Activity.RESULT_CANCELED)
        assertFalse(storage.temps.single().exists())
        assertTrue(notices.isEmpty())
    }

    /** The page sends keyOf(url) from transfers.js: a data: URL over 64 characters arrives shortened. */
    @Test
    fun longCapturedDataUrlIsNotSavedAgain() {
        val url = "data:text/plain;base64," + "QUFB".repeat(20)
        assertEquals(103, url.length)
        val pageKey = "${url.take(64)}#${url.length}"
        begin(exportId('a'), 60, key = pageKey)
        download(url)
        assertEquals("the listener's report is the captured export", 1, transfers.activeCount)
        begin(exportId('b'), 60, key = pageKey)
        assertTrue(transfers.handleNavigation(view, Uri.parse(url), true, true))
        idle()
        assertEquals("so is the navigation", 2, transfers.activeCount)
        assertTrue(transfers.handleNavigation(view, Uri.parse(url), true, true))
        idle()
        assertEquals("a navigation nothing captured is saved", 3, transfers.activeCount)
        assertEquals(1, launches.size)
    }

    /**
     * The page script never runs outside the app origin, so it cannot report a form POST there (a
     * cross-origin frame's form, say): only a main-frame navigation shows such a download was a GET.
     */
    @Test
    fun downloadsOutsideTheAppOriginNeedGetEvidence() {
        val url = "https://files.example.com/export.json"
        routes[url] = Triple(200, mapOf("Content-Length" to "2", "Content-Type" to "application/json"), "{}".toByteArray())
        download(url, get = false)
        assertTrue("offers the browser instead", transfers.unsupportedPrompt)
        assertTrue("never fetched", requests.isEmpty())
        transfers.dismissUnsupported()
        now += WebTransfers.DUPLICATE_REPORT_MILLIS + 1
        download(url)
        assertFalse(transfers.unsupportedPrompt)
        assertEquals(1, requests.size)
        assertEquals("no cookies outside the app origin", null, requests.single().sent["Cookie"])
        assertEquals("export.json", launches.single().getStringExtra(Intent.EXTRA_TITLE))
    }

    /**
     * Also inside the app origin, with the page script: a frame of the app's host on another port is
     * same-site, so its form POST into the app origin carries the launch cookie, and no script there reports it.
     * Without a GET navigation for the URL the download is never fetched, so never replayed as a GET.
     */
    @Test
    fun appOriginDownloadsNeedGetEvidenceToo() {
        assertTrue(transfers.hasBridge(view))
        val url = "$origin/attachment?name=posted.json&n=700"
        routes[url] = Triple(200, mapOf("Content-Length" to "2", "Content-Disposition" to "attachment; filename=\"posted.json\""), "{}".toByteArray())
        download(url, disposition = "attachment; filename=\"posted.json\"", get = false)
        assertTrue("offers the browser instead", transfers.unsupportedPrompt)
        assertTrue("never fetched", requests.isEmpty())
        assertTrue(launches.isEmpty())
        transfers.dismissUnsupported()
        // The same URL after a main-frame navigation to it is a GET, fetched with the cookie.
        now += WebTransfers.DUPLICATE_REPORT_MILLIS + 1
        download(url)
        assertFalse(transfers.unsupportedPrompt)
        assertEquals("sillybunny_launch=t0k3n", requests.single().sent["Cookie"])
        assertEquals("posted.json", launches.single().getStringExtra(Intent.EXTRA_TITLE))
        assertTrue(notices.isEmpty())
    }

    @Test
    fun webOriginDownloadsConnectToTheNativeAddressWithTheWebOriginsCookies() {
        val url = "$origin/backups/x.zip?n=1"
        routes[url] = Triple(200, mapOf("Content-Length" to "2"), "ok".toByteArray())
        download(url)
        val destination = destination("x.zip")
        answer(destination)
        assertArrayEquals("ok".toByteArray(), storage.bytes(destination))
        assertEquals("$native/backups/x.zip?n=1", requests.single().url.toString())
        assertEquals("the cookies WebView holds for the web origin", listOf(url), platform.cookieUrls)
        assertEquals("sillybunny_launch=t0k3n", requests.single().sent["Cookie"])
    }

    @Test
    fun redirectsOnTheWebOriginStayOnTheNativeAddress() {
        routes["$origin/r"] = Triple(302, mapOf("Location" to "/b?x=1"), ByteArray(0))
        routes["$origin/b?x=1"] = Triple(200, mapOf("Content-Length" to "2"), "ok".toByteArray())
        download("$origin/r")
        assertEquals(listOf("$native/r", "$native/b?x=1"), requests.map { it.url.toString() })
        assertEquals(listOf("$origin/r", "$origin/b?x=1"), platform.cookieUrls)
        assertEquals(1, launches.size)
        // An absolute redirect to the native address is another origin, so it is refused.
        now += WebTransfers.DUPLICATE_REPORT_MILLIS + 1
        routes["$origin/to-native"] = Triple(302, mapOf("Location" to "$native/b?x=1"), ByteArray(0))
        download("$origin/to-native")
        assertEquals(3, requests.size)
        assertEquals(listOf(R.string.web_transfer_failed), notices)
    }

    @Test
    fun nothingCountsWhileAnotherPageIsShown() {
        routes["$origin/file.json"] = Triple(200, mapOf("Content-Length" to "2"), "{}".toByteArray())
        for (other in listOf("https://openrouter.ai/auth?callback_url=x", "$native/", "http://127.0.0.1:41235/", "about:blank", null)) {
            platform.page = other
            assertFalse("$other", transfers.handleNavigation(view, Uri.parse("blob:$origin/x"), true, true))
            assertFalse("$other", transfers.handleNavigation(view, Uri.parse("data:text/plain;base64,aGk="), true, true))
            assertFalse("$other", transfers.handleNavigation(view, Uri.parse("$origin/file.json"), true, true))
            checkNotNull(platform.downloads).onDownloadStart("$origin/file.json", "UA", null, null, -1)
            checkNotNull(platform.downloads).onDownloadStart("https://openrouter.ai/x.json", "UA", null, null, -1)
            idle()
        }
        assertTrue(platform.evaluated.isEmpty())
        assertTrue(requests.isEmpty())
        assertTrue(launches.isEmpty())
        assertTrue(notices.isEmpty())
        assertFalse(transfers.unsupportedPrompt)
        // Back on the app page, the same report counts: no GET was seen meanwhile, so the browser is offered.
        platform.page = "$origin/chats"
        checkNotNull(platform.downloads).onDownloadStart("$origin/file.json", "UA", null, null, -1)
        idle()
        assertTrue(transfers.unsupportedPrompt)
        assertTrue(transfers.handleNavigation(view, Uri.parse("data:text/plain;base64,aGk="), true, true))
    }

    @Test
    fun pageExportReplacesADocumentOnlyWhenComplete() {
        val old = "0123456789abcdef".toByteArray()
        val kept = existing("chat.json", old)
        begin(exportId('a'), 10)
        answer(kept)
        val slot = replies("ready", exportId('a')).single().getInt("slot")
        frame(slot, 0, "abcd".toByteArray())
        idle()
        // The page navigates while the export streams: the export ends and the document keeps its content.
        send("""{"t":"bye","doc":"$doc"}""")
        idle()
        assertArrayEquals(old, storage.bytes(kept))
        assertTrue("never opened", storage.opened.isEmpty())
        assertTrue(storage.discarded.isEmpty())
        assertTrue("the cache copy is gone", storage.temps.none(File::exists))
        assertEquals(listOf(R.string.web_transfer_failed), notices)
        // A complete export replaces it, also when it is shorter than before.
        val next = "1".repeat(16)
        hello(next)
        begin(exportId('b'), 6, document = next)
        answer(kept)
        assertTrue("not opened while the export streams", storage.opened.isEmpty())
        stream(exportId('b'), "abcdef".toByteArray())
        assertArrayEquals("abcdef".toByteArray(), storage.bytes(kept))
        assertEquals(listOf(kept), storage.opened.toList())
        assertEquals(listOf(R.string.web_transfer_failed, R.string.web_transfer_saved), notices)
        assertTrue(storage.temps.none(File::exists))
    }

    @Test
    fun aDocumentOfUnknownSizeIsNeverRemoved() {
        val cloud = destination("cloud.json").also { storage.unknownSize += it }
        begin(exportId('a'), 4)
        answer(cloud)
        assertTrue("treated as replaced: collected in the cache first", storage.opened.isEmpty())
        send("""{"t":"abort","id":"${exportId('a')}"}""")
        idle()
        assertTrue(storage.discarded.isEmpty())
        assertEquals(listOf(R.string.web_transfer_failed), notices)
    }

    @Test
    fun httpDownloadReplacesADocumentWhenComplete() {
        val url = "$origin/report.json"
        routes[url] = Triple(200, mapOf("Content-Length" to "2", "Content-Type" to "application/json"), "{}".toByteArray())
        download(url)
        assertEquals("report.json", launches.single().getStringExtra(Intent.EXTRA_TITLE))
        val kept = existing("report.json", "a longer earlier report".toByteArray())
        // Room only because the old content goes.
        storage.freeAt[kept] = limits.reserveBytes
        answer(kept)
        assertArrayEquals("{}".toByteArray(), storage.bytes(kept))
        assertEquals(listOf(kept), storage.opened.toList())
        assertEquals(listOf(R.string.web_transfer_saved), notices)
        assertTrue(storage.temps.none(File::exists))
    }

    @Test
    fun noRoomFailsBeforeADocumentIsEmptied() {
        fun failed() = notices.count { it == R.string.web_transfer_failed }
        // A page export to a new document whose volume lacks room for the declared size.
        val fresh = destination("fresh.json")
        storage.freeAt[fresh] = limits.reserveBytes + 3
        begin(exportId('a'), 4)
        answer(fresh)
        assertTrue(replies("ready", exportId('a')).isEmpty())
        assertEquals(listOf(fresh), storage.discarded.toList())
        assertEquals(listOf("open primary:fresh.json", "discard primary:fresh.json", "close primary:fresh.json"), storage.eventsOf(fresh))
        assertEquals(1, failed())
        // A page export to a replaced document, without room in the cache to collect it first.
        storage.free = limits.reserveBytes + 3
        val kept = existing("kept.json", "old".toByteArray())
        begin(exportId('b'), 4)
        answer(kept)
        assertTrue(replies("ready", exportId('b')).isEmpty())
        assertArrayEquals("old".toByteArray(), storage.bytes(kept))
        assertEquals(2, failed())
        storage.free = Long.MAX_VALUE
        // An HTTP body, complete in the cache, for a replaced document whose volume is too full even
        // once its 4 bytes go.
        val url = "$origin/eight"
        routes[url] = Triple(200, mapOf("Content-Length" to "8"), "12345678".toByteArray())
        download(url)
        val replaced = existing("eight", "1234".toByteArray())
        storage.freeAt[replaced] = limits.reserveBytes + 3
        answer(replaced)
        assertArrayEquals("1234".toByteArray(), storage.bytes(replaced))
        assertEquals(3, failed())
        // The same body for a new document on a volume that is too full.
        now += WebTransfers.DUPLICATE_REPORT_MILLIS + 1
        download(url)
        val full = destination("eight-new")
        storage.freeAt[full] = limits.reserveBytes + 7
        answer(full)
        assertEquals(4, failed())
        assertEquals(listOf("open primary:eight-new", "discard primary:eight-new", "close primary:eight-new"), storage.eventsOf(full))
        // A decoded data: URL for a replaced document: 2 bytes in place of 1 leave less than the reserve.
        transfers.handleNavigation(view, Uri.parse("data:text/plain;base64,aGk="), true, true)
        idle()
        val note = existing("note.txt", "x".toByteArray())
        storage.freeAt[note] = limits.reserveBytes
        answer(note)
        assertArrayEquals("x".toByteArray(), storage.bytes(note))
        assertEquals(5, failed())
        val untouched = listOf(kept, replaced, note)
        assertTrue("a replaced document is never opened without room", storage.opened.none { it in untouched })
        assertTrue(storage.discarded.none { it in untouched })
        assertTrue(storage.temps.none(File::exists))
        assertEquals(0, transfers.activeCount)
    }

    @Test
    fun httpStreamsIntoANewDocumentOncePicked() {
        start(threaded = true)
        val url = "$origin/slow.bin"
        val body = ByteArray(12) { (it * 7).toByte() }
        val input = SteppedInput(body, listOf(4, 8))
        streamed[url] = mapOf("Content-Length" to "12", "Content-Disposition" to "attachment; filename=slow.bin") to input
        assertFalse(transfers.handleNavigation(view, Uri.parse(url), true, true))
        checkNotNull(platform.downloads).onDownloadStart(url, "UA", null, null, -1)
        input.awaitPause(0)
        idleUntil("the picker") { launches.size == 1 }
        val destination = destination("slow.bin")
        answer(destination)
        input.resume(0)
        input.awaitPause(1)
        // The fetch still runs: what was buffered is in the new document already, and the cache file is gone.
        assertArrayEquals(body.copyOf(8), storage.bytes(destination))
        assertTrue(storage.temps.none(File::exists))
        input.resume(1)
        idleUntil("the save") { R.string.web_transfer_saved in notices }
        assertArrayEquals(body, storage.bytes(destination))
        assertEquals(listOf("open primary:slow.bin", "close primary:slow.bin"), storage.eventsOf(destination))
        assertEquals(0, transfers.activeCount)
    }

    @Test
    fun httpForAReplacedDocumentWaitsForTheWholeBody() {
        start(threaded = true)
        val url = "$origin/backup.zip"
        val input = SteppedInput(ByteArray(12) { 1 }, listOf(4))
        streamed[url] = mapOf("Content-Length" to "12", "Content-Disposition" to "attachment; filename=backup.zip") to input
        assertFalse(transfers.handleNavigation(view, Uri.parse(url), true, true))
        checkNotNull(platform.downloads).onDownloadStart(url, "UA", null, null, -1)
        input.awaitPause(0)
        idleUntil("the picker") { launches.size == 1 }
        val kept = existing("backup.zip", "the previous backup".toByteArray())
        answer(kept)
        // The WebView goes away (renderer death, a session change) while the body still arrives.
        transfers.detach(view)
        input.resume(0)
        idleUntil("the cancelled fetch to clean up") { storage.temps.isNotEmpty() && storage.temps.none(File::exists) }
        assertArrayEquals("the previous backup".toByteArray(), storage.bytes(kept))
        assertTrue(storage.opened.isEmpty())
        assertTrue(storage.discarded.isEmpty())
        assertTrue("cancelled quietly", notices.isEmpty())
        assertEquals(0, transfers.activeCount)
    }

    /** Streams one chunk of an export whose worker the test runs, and waits for its acknowledgement. */
    private fun streamOn(worker: ManualExecutor, id: String, seq: Int, chunk: ByteArray) {
        frame(replies("ready", id).single().getInt("slot"), seq, chunk)
        worker.runAll()
        idle()
    }

    /**
     * A document the picker created is removed while the transfer still holds its stream, which is
     * closed after that: the downloads provider updates a document from a close listener, and a removal
     * racing that listener crashes the provider. A document whose whole export was written and closed
     * stays, also when the cancel comes in the same moment.
     */
    @Test
    fun aCreatedDocumentIsRemovedBeforeItsStreamCloses() {
        start(manual = true)
        // The page leaves while the export streams.
        val leaving = destination("leaving.json")
        begin(exportId('a'), 8, name = "leaving.json")
        answer(leaving)
        val first = manualWorkers.last()
        first.runAll()
        idle()
        streamOn(first, exportId('a'), 0, "abcd".toByteArray())
        send("""{"t":"bye","doc":"$doc"}""")
        first.runAll()
        idle()
        assertEquals(listOf("open primary:leaving.json", "discard primary:leaving.json", "close primary:leaving.json"), storage.eventsOf(leaving))
        // The whole export arrived, but the page leaves before the worker closes the document.
        val second = "1".repeat(16)
        hello(second)
        val late = destination("late.json")
        begin(exportId('b'), 4, name = "late.json", document = second)
        answer(late)
        val lateWorker = manualWorkers.last()
        lateWorker.runAll()
        idle()
        streamOn(lateWorker, exportId('b'), 0, "abcd".toByteArray())
        send("""{"t":"end","id":"${exportId('b')}","size":4}""")
        send("""{"t":"bye","doc":"$second"}""")
        lateWorker.runAll()
        idle()
        assertEquals(listOf("open primary:late.json", "discard primary:late.json", "close primary:late.json"), storage.eventsOf(late))
        // The whole export is written and closed, and the page leaves before the main thread hears of it.
        val third = "2".repeat(16)
        hello(third)
        val kept = destination("kept.json")
        begin(exportId('c'), 4, name = "kept.json", document = third)
        answer(kept)
        val keptWorker = manualWorkers.last()
        keptWorker.runAll()
        idle()
        streamOn(keptWorker, exportId('c'), 0, "abcd".toByteArray())
        send("""{"t":"end","id":"${exportId('c')}","size":4}""")
        keptWorker.runAll()
        send("""{"t":"bye","doc":"$third"}""")
        keptWorker.runAll()
        idle()
        assertEquals(listOf("open primary:kept.json", "close primary:kept.json"), storage.eventsOf(kept))
        assertArrayEquals("abcd".toByteArray(), storage.bytes(kept))
        assertEquals(listOf(leaving, late), storage.discarded.toList())
        assertEquals("the save is reported as failed all the same", 3, notices.count { it == R.string.web_transfer_failed })
        assertTrue(notices.none { it == R.string.web_transfer_saved })
        assertEquals(0, transfers.activeCount)
    }

    /** A document the user chose to replace is not opened, so not emptied, once its export was cancelled. */
    @Test
    fun aReplacedDocumentIsNotOpenedOnceItsExportWasCancelled() {
        start(manual = true)
        val old = "the previous chat".toByteArray()
        val kept = existing("chat.json", old)
        begin(exportId('a'), 4)
        answer(kept)
        val worker = manualWorkers.last()
        worker.runAll()
        idle()
        streamOn(worker, exportId('a'), 0, "abcd".toByteArray())
        // The export is complete in the cache, and the page leaves before the final copy runs.
        send("""{"t":"end","id":"${exportId('a')}","size":4}""")
        send("""{"t":"bye","doc":"$doc"}""")
        worker.runAll()
        idle()
        assertArrayEquals(old, storage.bytes(kept))
        assertTrue("never opened", storage.opened.isEmpty())
        assertTrue(storage.discarded.isEmpty())
        assertTrue(storage.temps.none(File::exists))
        assertEquals(listOf(R.string.web_transfer_failed), notices)
    }

    /** The same order for a download that streams into a new document when the WebView goes away. */
    @Test
    fun aDownloadCancelledWhileItStreamsRemovesTheDocumentBeforeClosingIt() {
        start(threaded = true)
        val url = "$origin/slow.bin"
        val body = ByteArray(12) { (it * 5).toByte() }
        val input = SteppedInput(body, listOf(4, 8))
        streamed[url] = mapOf("Content-Length" to "12", "Content-Disposition" to "attachment; filename=slow.bin") to input
        assertFalse(transfers.handleNavigation(view, Uri.parse(url), true, true))
        checkNotNull(platform.downloads).onDownloadStart(url, "UA", null, null, -1)
        input.awaitPause(0)
        idleUntil("the picker") { launches.size == 1 }
        val destination = destination("slow.bin")
        answer(destination)
        input.resume(0)
        input.awaitPause(1)
        assertEquals("streams into the new document", listOf("open primary:slow.bin"), storage.eventsOf(destination))
        transfers.detach(view)
        input.resume(1)
        assertTrue(threads.single().awaitTermination(10, TimeUnit.SECONDS))
        idle()
        assertEquals(listOf("open primary:slow.bin", "discard primary:slow.bin", "close primary:slow.bin"), storage.eventsOf(destination))
        assertTrue(storage.temps.none(File::exists))
        assertTrue("cancelled quietly", notices.isEmpty())
        assertEquals(0, transfers.activeCount)
    }

    /** No room for the buffered part once a download switches to its new document: removed, then closed. */
    @Test
    fun noRoomWhenADownloadSwitchesToItsNewDocumentRemovesItFirst() {
        start(threaded = true)
        val url = "$origin/tight.bin"
        val input = SteppedInput(ByteArray(12) { 2 }, listOf(4))
        streamed[url] = mapOf("Content-Length" to "12", "Content-Disposition" to "attachment; filename=tight.bin") to input
        assertFalse(transfers.handleNavigation(view, Uri.parse(url), true, true))
        checkNotNull(platform.downloads).onDownloadStart(url, "UA", null, null, -1)
        input.awaitPause(0)
        idleUntil("the picker") { launches.size == 1 }
        val destination = destination("tight.bin")
        // Short of the 4 buffered bytes above the reserve.
        storage.freeAt[destination] = limits.reserveBytes + 3
        answer(destination)
        input.resume(0)
        idleUntil("the failure") { R.string.web_transfer_failed in notices }
        assertTrue(threads.single().awaitTermination(10, TimeUnit.SECONDS))
        idle()
        assertEquals(listOf("open primary:tight.bin", "discard primary:tight.bin", "close primary:tight.bin"), storage.eventsOf(destination))
        assertTrue(storage.temps.none(File::exists))
        assertEquals(listOf(R.string.web_transfer_failed), notices)
        assertEquals(0, transfers.activeCount)
    }

    /** A download whose whole body is in its new document as the cancel comes keeps the document. */
    @Test
    fun aDownloadCompleteAsItIsCancelledKeepsTheDocument() {
        start(threaded = true)
        val url = "$origin/done.bin"
        val body = ByteArray(8) { (it * 3).toByte() }
        val input = SteppedInput(body, listOf(4))
        streamed[url] = mapOf("Content-Length" to "8", "Content-Disposition" to "attachment; filename=done.bin") to input
        assertFalse(transfers.handleNavigation(view, Uri.parse(url), true, true))
        checkNotNull(platform.downloads).onDownloadStart(url, "UA", null, null, -1)
        input.awaitPause(0)
        idleUntil("the picker") { launches.size == 1 }
        val destination = destination("done.bin")
        val closing = CountDownLatch(1)
        val closeMayEnd = CountDownLatch(1)
        storage.beforeClose = { uri ->
            if (uri == destination) {
                closing.countDown()
                closeMayEnd.await(10, TimeUnit.SECONDS)
            }
        }
        answer(destination)
        input.resume(0)
        assertTrue("the whole body is in the document, which is being closed", closing.await(10, TimeUnit.SECONDS))
        transfers.detach(view)
        closeMayEnd.countDown()
        assertTrue(threads.single().awaitTermination(10, TimeUnit.SECONDS))
        idle()
        assertEquals(listOf("open primary:done.bin", "close primary:done.bin"), storage.eventsOf(destination))
        assertArrayEquals(body, storage.bytes(destination))
        assertTrue(storage.discarded.isEmpty())
        assertEquals(0, transfers.activeCount)
    }
}
