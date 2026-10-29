package io.github.sillybunnyteam.sillybunny.web.downloads

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.webkit.WebView
import android.widget.Toast
import androidx.activity.result.ActivityResult
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import io.github.sillybunnyteam.sillybunny.R
import io.github.sillybunnyteam.sillybunny.server.LaunchSession
import io.github.sillybunnyteam.sillybunny.web.WebAddress
import io.github.sillybunnyteam.sillybunny.web.WebDownloads
import io.github.sillybunnyteam.sillybunny.web.files.ContentUriPolicy
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.io.OutputStream
import java.net.HttpURLConnection
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The app's [WebDownloads] (plan §4.5): page exports and HTTP downloads are written to a document the
 * user creates with `ACTION_CREATE_DOCUMENT`; nothing is saved anywhere else.
 *
 * - **Page exports.** When the WebView provider supports both `DOCUMENT_START_SCRIPT` and
 *   `WEB_MESSAGE_LISTENER`, [attach] installs `assets/web/transfers.js` and the `sillybunnyTransfers`
 *   bridge for the exact app origin only: the per-install web origin that [originOf] gives for the
 *   session (`http://<label>.localhost:<port>`), not the server's native address. The script keeps each
 *   Blob from the moment its `blob:` URL is created and captures `<a download>` clicks (attached,
 *   detached and programmatic) before the page can revoke the URL. Bytes stream only after the user
 *   picks a destination, in ordered chunks
 *   of [TransferLimits.chunkBytes] with at most [TransferLimits.window] unacknowledged, a size
 *   declared up front, an idle timeout and cancellation when the document goes away. Writes run off
 *   the main thread. Messages count only from the main frame of the exact origin; form POST notices,
 *   which can only make downloads stricter, are taken from any frame of that origin.
 * - **HTTP downloads.** Same-origin `<a download>` clicks and `setDownloadListener` reports are fetched
 *   by [HttpFetch] straight away and buffered in the cache while the picker is open, so a short-lived
 *   URL is used before the picker delays it. Once the user picks a new document, the buffered part is
 *   copied there and the rest streams straight to it. WebView cookies go only to the exact app origin
 *   and redirects are checked per hop ([DownloadPolicy]). The fetch connects to the session's native
 *   address, because Android's resolver does not resolve the web origin's `*.localhost` name. A URL the
 *   page POSTed to is never fetched again. A download listener report is fetched only with proof that it
 *   was a GET: the page script's own capture of the link, or a main-frame navigation seen by
 *   [handleNavigation]. The listener does not say which method or frame a download came from, and the
 *   page script sees forms only in frames of the app origin, while a frame of the app's host on another
 *   port is same-site, so its form POST into the app origin would carry the launch cookie (the shell
 *   refuses such frames). Without that proof Open in browser is offered. A URL
 *   reported again within [DUPLICATE_REPORT_MILLIS] is the same download: some WebViews report one
 *   download twice.
 * - **Replaced documents.** The picker may hand back an existing document the user chose to replace.
 *   Only a document reported empty counts as created for the save ([TransferStorage.sizeOf]); any other
 *   one is opened, which empties it, only once the whole export has arrived (in the cache, or in memory
 *   for `data:`) and there is room for it. It is never removed, also not when the save fails or its
 *   result comes too late. A created document that cannot be filled is removed.
 * - **Removing a created document.** A transfer keeps the writable descriptor it opened on its
 *   destination until it ends. A save that fails or is cancelled removes a created document first and
 *   closes the descriptor afterwards; one whose whole export was written and closed is kept. The
 *   downloads provider (DocumentsUI's Downloads root) updates a document from a listener that runs
 *   when a writer closes it, and a removal racing that listener crashes the provider's process
 *   (`android.process.media`), and this app with it. Removed first, the document and its download
 *   row are gone before the listener runs, so it finds nothing to update.
 * - **Navigations.** [handleNavigation] takes `blob:` URLs (exported by the page script) and `data:`
 *   URLs (decoded with [DataUrls] within [TransferLimits.maxDataUrlBytes]). A URL the script already
 *   exported is not saved again; attachment responses that the page fetches itself never reach this
 *   class, so they cause no save. HTTP(S) navigations are never taken: they only show that a later
 *   download report for the same URL came from a GET.
 * - **Missing features.** Without the bridge, page exports cannot be captured: [unsupportedPrompt]
 *   asks the host to offer Open in browser. No `addJavascriptInterface` fallback exists.
 * - **Other pages.** Download reports and navigations count only while the WebView's main frame shows
 *   the app origin, so an external page that the shell lets in (the OpenRouter sign-in) gets no downloads,
 *   as it gets no bridge.
 * - One destination picker is open at a time; exports wait in a queue, at most
 *   [TransferLimits.maxActive] alive.
 *
 * Lifetime: one instance serves every WebView attached to it until [release]. It holds no Activity:
 * the host binds the current activity's launcher with [bind] and unbinds it with [unbind], so an
 * instance kept in an activity ViewModel (see `rememberWebDownloads`) keeps working across activity
 * recreation together with a WebView the host keeps across it, and an open picker delivers its
 * result to [onDestinationResult] after recreation. [detach] cancels that WebView's transfers. Main
 * thread only.
 */
internal class WebTransfers(
    private val context: Context,
    /** The web origin of a session's pages; the bridge allowlist and the cookie origin of downloads. */
    private val originOf: (LaunchSession) -> String = WebAddress.forInstall(context)::origin,
    private val platform: TransferPlatform = AndroidTransferPlatform,
    private val storage: TransferStorage = ContentTransferStorage(context),
    private val destinations: ContentUriPolicy = ContentUriPolicy(context),
    private val limits: TransferLimits = TransferLimits(),
    private val notify: (Int) -> Unit = { Toast.makeText(context, it, Toast.LENGTH_SHORT).show() },
    private val script: () -> String = { TransferScript.load(context) },
    private val clock: () -> Long = SystemClock::elapsedRealtime,
    private val newWorker: () -> ExecutorService = ::defaultWorker,
    private val newFetch: (DownloadPolicy, (String) -> String?, String?) -> HttpFetch = { policy, cookies, agent ->
        HttpFetch(policy, cookies, agent)
    },
) : WebDownloads {
    private val handler = Handler(Looper.getMainLooper())
    private val misc: ExecutorService = newWorker()
    private val attachments = LinkedHashMap<WebView, Attachment>()
    private val alive = LinkedHashSet<Transfer>()
    private val pageIds = HashMap<String, Transfer>()
    private val slots = HashMap<Int, Transfer>()
    private val queue = ArrayDeque<Transfer>()
    private var nextSlot = 1
    private var launch: ((Intent) -> Unit)? = null
    private var pickerOpen = false
    private var picking: Transfer? = null
    private var released = false

    init {
        misc.execute { storage.clearStale() }
    }

    /** True while the host should offer Open in browser because a page export could not be captured. */
    var unsupportedPrompt by mutableStateOf(false)
        private set

    /** Transfers alive now, for tests and diagnostics. */
    internal val activeCount: Int get() = alive.size

    internal fun hasBridge(webView: WebView): Boolean = attachments[webView]?.bridge != null

    // region WebDownloads

    override fun attach(webView: WebView, session: LaunchSession) {
        if (released) return
        attachments.remove(webView)?.let(::teardown)
        val attachment = Attachment(webView, session)
        attachment.userAgent = platform.userAgent(webView)
        platform.setDownloadListener(webView) { url, userAgent, disposition, mime, _ ->
            onDownloadStart(attachment, url, userAgent, disposition, mime)
        }
        if (platform.bridgeSupported()) {
            attachment.bridge = platform.installBridge(webView, attachment.webOrigin, script()) { input, origin, main, reply ->
                onBridge(attachment, input, origin, main, reply)
            }
        }
        attachments[webView] = attachment
    }

    override fun handleNavigation(webView: WebView, url: Uri, isMainFrame: Boolean, hasGesture: Boolean): Boolean {
        val attachment = attachments[webView]?.takeIf(::onAppPage) ?: return false
        val text = url.toString()
        val key = TransferKeys.of(text)
        return when (url.scheme?.lowercase()) {
            "blob" -> {
                if (!attachment.captured.consume(key)) saveBlobUrl(attachment, text)
                true
            }
            "data" -> {
                if (!attachment.captured.consume(key)) saveDataUrl(attachment, text)
                true
            }
            // Only GET navigations reach here, which is what a later download report needs to know. The
            // shell routes the navigation itself; a download it turns into is deduplicated in onDownloadStart.
            "http", "https" -> {
                attachment.gets.add(key)
                false
            }
            else -> false
        }
    }

    override fun detach(webView: WebView) {
        attachments.remove(webView)?.let(::teardown)
    }

    // endregion

    // region Host binding

    /** Connects the current activity's destination picker launcher. */
    fun bind(launch: (Intent) -> Unit) {
        if (released) return
        this.launch = launch
        pump()
    }

    /**
     * Disconnects the launcher. Unless the activity is only changing configurations, an open picker's
     * result can no longer arrive, so its export is cancelled; queued exports wait for the next [bind].
     */
    fun unbind(changingConfigurations: Boolean) {
        launch = null
        if (changingConfigurations) return
        unsupportedPrompt = false
        if (pickerOpen) {
            pickerOpen = false
            picking?.let { cancel(it) }
            picking = null
        }
    }

    /** The destination picker's result for the export it was opened for. */
    fun onDestinationResult(result: ActivityResult) {
        val transfer = if (pickerOpen) picking else null
        pickerOpen = false
        picking = null
        val data = result.data
        val uri = data?.data
        val saved = result.resultCode == Activity.RESULT_OK && uri != null
        val usable = uri != null && result.resultCode == Activity.RESULT_OK && destinations.isForeignContent(uri) &&
            destinations.hasGrant(uri, data.flags, ContentUriPolicy.WRITE)
        when {
            // The export is gone (cancelled while the picker was open, or the picker outlived this
            // engine's binding), so a Save cannot be honoured: say so, and keep a replaced document.
            transfer == null || transfer.stage != Stage.PICKING -> {
                if (saved) notify(R.string.web_transfer_failed)
                if (usable) discardIfCreated(uri)
            }
            result.resultCode != Activity.RESULT_OK -> cancel(transfer)
            !usable -> fail(transfer)
            else -> startWriting(transfer, uri)
        }
        pump()
    }

    fun dismissUnsupported() {
        unsupportedPrompt = false
    }

    /** Cancels everything and stops the worker threads; the owner is gone for good. */
    fun release() {
        if (released) return
        released = true
        launch = null
        pickerOpen = false
        picking = null
        attachments.values.toList().forEach(::teardown)
        attachments.clear()
        alive.toList().forEach { cancel(it) }
        misc.execute { storage.clearOwn() }
        misc.shutdown()
    }

    // endregion

    // region Download listener and navigations

    private fun onDownloadStart(attachment: Attachment, url: String, userAgent: String?, disposition: String?, mime: String?) {
        // Another page in the main frame (the OpenRouter sign-in) gets no downloads.
        if (attachment.detached || !onAppPage(attachment)) return
        val key = TransferKeys.of(url)
        // WebView 74 reported a text/plain attachment twice within milliseconds; it is one download.
        if (attachment.reports.contains(key)) return
        attachment.reports.add(key)
        if (attachment.captured.consume(key)) return
        when {
            url.startsWith("blob:", ignoreCase = true) -> saveBlobUrl(attachment, url)
            url.startsWith("data:", ignoreCase = true) -> saveDataUrl(attachment, url)
            else -> {
                val hop = attachment.policy.start(url)
                when {
                    hop == null || attachment.posts.contains(key) -> notify(R.string.web_transfer_failed)
                    // Links the page script took were captured above. Otherwise only a main-frame navigation
                    // offered to handleNavigation shows that the download was a GET: the script cannot see
                    // a form in a frame of another origin, and one of the app's host on another port is
                    // same-site, so its POST into the app origin would carry the launch cookie.
                    !attachment.gets.contains(key) -> promptUnsupported()
                    else -> startHttp(attachment, hop, nameHint = null, disposition = disposition, mime = mime, userAgent = userAgent)
                }
            }
        }
    }

    private fun saveBlobUrl(attachment: Attachment, url: String) {
        if (attachment.bridge == null) {
            promptUnsupported()
            return
        }
        attachment.captured.add(TransferKeys.of(url))
        platform.evaluate(attachment.webView, BridgeMessages.saveUrlScript(url)) { result ->
            if (result != "true") notify(R.string.web_transfer_failed)
        }
    }

    private fun saveDataUrl(attachment: Attachment, url: String) {
        attachment.captured.add(TransferKeys.of(url))
        if (url.length > limits.maxDataUrlChars) {
            notify(R.string.web_transfer_failed)
            return
        }
        // Decoding a few MiB is too slow for the main thread.
        misc.execute {
            val decoded = DataUrls.decode(url, limits.maxDataUrlChars, limits.maxDataUrlBytes)
            handler.post {
                when {
                    released || attachment.detached -> Unit
                    decoded == null -> notify(R.string.web_transfer_failed)
                    else -> {
                        val transfer = Transfer(attachment, BytesSource(decoded.bytes))
                        if (register(transfer)) enqueue(transfer, FileNames.withExtensionFor(FileNames.FALLBACK, decoded.mime))
                    }
                }
            }
        }
    }

    /** True while [attachment]'s main frame shows a page of the app origin. */
    private fun onAppPage(attachment: Attachment): Boolean {
        val page = platform.pageUrl(attachment.webView)?.let(Uri::parse) ?: return false
        if (page.scheme == null || page.encodedAuthority == null) return false
        return WebOrigin.parse("${page.scheme}://${page.encodedAuthority}/") == attachment.origin
    }

    private fun promptUnsupported() {
        if (launch != null) unsupportedPrompt = true else notify(R.string.web_transfer_failed)
    }

    // endregion

    // region Bridge

    private fun onBridge(attachment: Attachment, input: BridgeInput, sourceOrigin: Uri, isMainFrame: Boolean, reply: (String) -> Unit) {
        if (attachment.detached || WebOrigin.parse(sourceOrigin.toString()) != attachment.origin) return
        when (input) {
            is BridgeInput.Binary -> {
                if (!isMainFrame) return
                val frame = BridgeMessages.parseFrame(input.bytes, limits) ?: return
                val transfer = slots[frame.slot]?.takeIf { it.attachment === attachment } ?: return
                onChunk(transfer, frame.seq, frame.data, ChunkFrame.OFFSET, frame.length)
            }
            is BridgeInput.Text -> {
                val message = BridgeMessages.parse(input.text, limits) ?: return
                if (message is BridgeMessage.Post) {
                    attachment.posts.add(TransferKeys.of(message.url))
                    return
                }
                if (!isMainFrame) return
                onPageMessage(attachment, message, reply)
            }
        }
    }

    private fun onPageMessage(attachment: Attachment, message: BridgeMessage, reply: (String) -> Unit) {
        when (message) {
            is BridgeMessage.Hello -> onHello(attachment, message.doc, reply)
            is BridgeMessage.Bye -> onBye(attachment, message.doc)
            is BridgeMessage.Begin -> onBegin(attachment, message, reply)
            is BridgeMessage.Chunk -> pageTransfer(attachment, message.id)?.let {
                onChunk(it, message.seq, message.bytes, 0, message.bytes.size)
            }
            is BridgeMessage.End -> pageTransfer(attachment, message.id)?.let { onEnd(it, message.size) }
            is BridgeMessage.Abort -> pageTransfer(attachment, message.id)?.let(::fail)
            is BridgeMessage.Fail -> if (message.doc == attachment.doc) notify(R.string.web_transfer_failed)
            is BridgeMessage.Get -> onGet(attachment, message)
            is BridgeMessage.Post -> Unit
        }
    }

    private fun pageTransfer(attachment: Attachment, id: String): Transfer? =
        pageIds[id]?.takeIf { it.attachment === attachment }

    private fun onHello(attachment: Attachment, doc: String, reply: (String) -> Unit) {
        val previous = attachment.doc
        attachment.doc = doc
        attachment.reply = reply
        if (previous != null && previous != doc) cancelDocument(attachment) { it != doc }
    }

    private fun onBye(attachment: Attachment, doc: String) {
        if (attachment.doc == doc) {
            attachment.doc = null
            attachment.reply = null
        }
        cancelDocument(attachment) { it == doc }
    }

    /** Navigation cancellation: page exports of the matching documents can no longer be read. */
    private fun cancelDocument(attachment: Attachment, matches: (String) -> Boolean) {
        alive.filter { it.attachment === attachment && (it.source as? PageSource)?.doc?.let(matches) == true }
            .forEach { if (it.stage == Stage.WRITING || it.stage == Stage.FINISHING) fail(it) else cancel(it) }
    }

    private fun onBegin(attachment: Attachment, message: BridgeMessage.Begin, reply: (String) -> Unit) {
        val stale = message.doc != attachment.doc || message.id in pageIds
        val tooLarge = message.size > limits.maxTransferBytes
        val source = PageSource(message.doc, message.id, message.size, reply, limits.chunkBytes)
        val transfer = Transfer(attachment, source)
        if (stale || tooLarge || !register(transfer)) {
            reply(BridgeMessages.cancel(message.id, "refused"))
            if (tooLarge) notify(R.string.web_transfer_failed)
            return
        }
        pageIds[message.id] = transfer
        // The page sends TransferKeys.of(url) already (keyOf in transfers.js); shortening a long data:
        // key again would never match the URL the WebView reports.
        message.key?.let { attachment.captured.add(it) }
        enqueue(transfer, FileNames.withExtensionFor(FileNames.sanitize(message.name), message.mime))
    }

    private fun onGet(attachment: Attachment, message: BridgeMessage.Get) {
        if (message.doc != attachment.doc) return
        val hop = attachment.policy.start(message.url)?.takeIf { it.sendCookies }
        if (hop == null) {
            notify(R.string.web_transfer_failed)
            return
        }
        attachment.captured.add(TransferKeys.of(message.url))
        startHttp(attachment, hop, nameHint = message.name, disposition = null, mime = null, userAgent = null)
    }

    private fun onChunk(transfer: Transfer, seq: Int, data: ByteArray, offset: Int, length: Int) {
        val page = transfer.source as? PageSource ?: return
        val acceptable = transfer.stage == Stage.WRITING && page.streaming && page.endSize < 0 &&
            page.inFlight < limits.window && page.progress.accept(seq, length)
        if (!acceptable) {
            fail(transfer)
            return
        }
        page.inFlight++
        touch(transfer)
        val worker = transfer.worker ?: return fail(transfer)
        worker.execute {
            val written = try {
                checkNotNull(transfer.output).write(data, offset, length)
                true
            } catch (_: Exception) {
                false
            }
            handler.post { onChunkWritten(transfer, seq, written) }
        }
    }

    private fun onChunkWritten(transfer: Transfer, seq: Int, written: Boolean) {
        if (transfer.stage != Stage.WRITING) return
        if (!written) {
            fail(transfer)
            return
        }
        val page = transfer.source as PageSource
        page.inFlight--
        page.reply(BridgeMessages.ack(page.id, seq))
        finishPageIfDone(transfer)
    }

    private fun onEnd(transfer: Transfer, size: Long) {
        val page = transfer.source as? PageSource ?: return
        if (transfer.stage != Stage.WRITING || !page.streaming || page.endSize >= 0) {
            fail(transfer)
            return
        }
        page.endSize = size
        touch(transfer)
        finishPageIfDone(transfer)
    }

    private fun finishPageIfDone(transfer: Transfer) {
        val page = transfer.source as PageSource
        if (page.endSize < 0 || page.inFlight > 0) return
        if (!page.progress.complete(page.endSize)) {
            fail(transfer)
            return
        }
        transfer.stage = Stage.FINISHING
        handler.removeCallbacks(transfer.idle)
        val worker = transfer.worker ?: return fail(transfer)
        worker.execute {
            val finished = try {
                val buffer = transfer.buffer
                if (buffer == null) {
                    finishOutput(transfer)
                } else {
                    // An export for a replaced document went to the cache; only now is the document opened.
                    transfer.output?.use { it.flush() }
                    transfer.output = null
                    copyBuffered(transfer, buffer)
                    transfer.buffer = null
                }
                true
            } catch (_: Exception) {
                false
            }
            handler.post { if (finished) complete(transfer) else fail(transfer) }
        }
    }

    private fun touch(transfer: Transfer) {
        handler.removeCallbacks(transfer.idle)
        handler.postDelayed(transfer.idle, limits.idleTimeoutMillis)
    }

    private fun allocateSlot(transfer: Transfer): Int {
        while (slots.containsKey(nextSlot)) nextSlot = if (nextSlot == Int.MAX_VALUE) 1 else nextSlot + 1
        val slot = nextSlot
        nextSlot = if (nextSlot == Int.MAX_VALUE) 1 else nextSlot + 1
        slots[slot] = transfer
        return slot
    }

    // endregion

    // region HTTP

    private fun startHttp(
        attachment: Attachment,
        hop: DownloadHop,
        nameHint: String?,
        disposition: String?,
        mime: String?,
        userAgent: String?,
    ) {
        val source = HttpSource(hop, nameHint, disposition, mime)
        val transfer = Transfer(attachment, source)
        if (!register(transfer)) return
        val worker = newWorker().also { transfer.worker = it }
        val fetch = newFetch(attachment.policy, platform::cookies, userAgent ?: attachment.userAgent)
        worker.execute { fetchBody(transfer, source, fetch) }
    }

    /** Worker thread: fetches the body and reports headers and completion to the main thread. */
    private fun fetchBody(transfer: Transfer, source: HttpSource, fetch: HttpFetch) {
        val response = try {
            fetch.open(source.hop) { source.connection = it }
        } catch (_: Exception) {
            null
        }
        if (response == null) {
            handler.post { fail(transfer) }
            return
        }
        try {
            if (source.cancelled.get()) return
            if (response.length > limits.maxTransferBytes) {
                handler.post { fail(transfer) }
                return
            }
            handler.post { onHttpHeaders(transfer, response) }
            val sink = HttpSink(transfer, source)
            val size = sink.use { output ->
                response.connection.inputStream.use { input ->
                    HttpFetch.copyBounded(input, output, limits.maxTransferBytes, { !source.cancelled.get() }, output::hasRoom)
                }
            }
            if (response.length >= 0 && size != response.length) throw IOException("truncated")
            val direct = sink.direct
            if (direct) finishOutput(transfer)
            handler.post { onHttpFetched(transfer, source, direct) }
        } catch (_: Exception) {
            // Any failure, also an unexpected one, ends the transfer instead of this worker thread.
            handler.post { fail(transfer) }
        } finally {
            response.connection.disconnect()
        }
    }

    /**
     * Worker thread: where an HTTP body goes. It is buffered in the cache while the picker is open.
     * Once the user has picked a document the picker created, the buffered part is copied there and
     * the rest streams straight to it, so a large download does not need its size twice. A replaced
     * document is left alone until the whole body is in the cache ([copyHttp]).
     */
    private inner class HttpSink(private val transfer: Transfer, private val source: HttpSource) : OutputStream() {
        private var cache: OutputStream? = FileOutputStream(storage.newTempFile().also { source.temp = it })
        private var checked = 0L
        private var decided = false

        /** True once the body goes straight to the destination, whose stream is then [Transfer.output]. */
        var direct = false
            private set

        private val output: OutputStream get() = (if (direct) transfer.output else cache) ?: throw IOException("closed")

        override fun write(b: Int) = write(byteArrayOf(b.toByte()), 0, 1)

        override fun write(b: ByteArray, off: Int, len: Int) {
            if (!decided && transfer.destination != null) switchToDestination()
            output.write(b, off, len)
        }

        override fun flush() = output.flush()

        /** Closes the cache file only: the destination stays with the transfer, whose ending closes it. */
        override fun close() {
            cache?.close()
            cache = null
        }

        /** Keeps [TransferLimits.reserveBytes] free where the body goes, checked every few MiB of [total]. */
        fun hasRoom(total: Long): Boolean {
            // Checking free space for every buffer would cost a statfs call each time.
            if (total - checked < SPACE_CHECK_BYTES) return true
            checked = total
            val free = if (direct) transfer.output?.let { storage.freeBytes(it) } else storage.freeBytes()
            return free == null || free > limits.reserveBytes
        }

        private fun switchToDestination() {
            decided = true
            try {
                if (transfer.aborted || classify(transfer) != Target.CREATED) return
                val file = checkNotNull(source.temp)
                close()
                // From here on the transfer holds the destination's stream, see finishOutput and endOutput.
                val target = storage.openOutput(checkNotNull(transfer.destination)).also { transfer.output = it }
                if (!hasRoomFor(storage.freeBytes(target), file.length())) throw IOException("no space")
                FileInputStream(file).use { it.copyTo(target, COPY_BUFFER_BYTES) }
                file.delete()
                source.temp = null
                direct = true
            } catch (error: IOException) {
                throw error
            } catch (error: Exception) {
                throw IOException(error)
            }
        }
    }

    private fun onHttpHeaders(transfer: Transfer, response: HttpFetch.Response) {
        if (transfer.stage != Stage.PREPARING) return
        val source = transfer.source as HttpSource
        val requested = FileNames.fromContentDisposition(response.disposition ?: source.disposition)
            ?: source.nameHint?.takeIf { it.isNotBlank() }
            ?: FileNames.fromUrl(response.url.toString())
        val mime = FileNames.normalizeMime(response.mime ?: source.mime)
        enqueue(transfer, FileNames.withExtensionFor(FileNames.sanitize(requested), mime))
    }

    private fun onHttpFetched(transfer: Transfer, source: HttpSource, direct: Boolean) {
        if (transfer.stage == Stage.CLOSED) return
        source.fetched = true
        when {
            direct -> complete(transfer)
            transfer.stage == Stage.WRITING -> copyHttp(transfer, source)
        }
    }

    /** Copies a body that is completely in the cache to the destination picked for it. */
    private fun copyHttp(transfer: Transfer, source: HttpSource) {
        transfer.stage = Stage.FINISHING
        val worker = transfer.worker ?: return fail(transfer)
        worker.execute {
            val copied = try {
                copyBuffered(transfer, checkNotNull(source.temp))
                source.temp = null
                true
            } catch (_: Exception) {
                false
            }
            handler.post { if (copied) complete(transfer) else fail(transfer) }
        }
    }

    /** Worker thread: copies a complete export from cache [file] to the destination, then removes the file. */
    private fun copyBuffered(transfer: Transfer, file: File) {
        writeComplete(transfer, file.length()) { output -> FileInputStream(file).use { it.copyTo(output, COPY_BUFFER_BYTES) } }
        file.delete()
    }

    /**
     * Worker thread: writes a complete export of [length] bytes to the destination. Opening a replaced
     * document empties it, so that happens only when the free space on its volume, plus what the
     * document holds now, leaves the reserve after the write, and not once the transfer was cancelled.
     */
    private fun writeComplete(transfer: Transfer, length: Long, write: (OutputStream) -> Unit) {
        if (transfer.aborted) throw IOException("cancelled")
        val destination = checkNotNull(transfer.destination)
        val created = classify(transfer) == Target.CREATED
        if (!created && !hasRoomFor(storage.freeBytesAt(destination), length, freed = transfer.existingSize)) {
            throw IOException("no space")
        }
        // The transfer holds the stream until it ends: a failure leaves it to endOutput.
        val output = storage.openOutput(destination).also { transfer.output = it }
        if (created && !hasRoomFor(storage.freeBytes(output), length)) throw IOException("no space")
        write(output)
        finishOutput(transfer)
    }

    /**
     * Worker thread: closes the destination once the whole export is in it. From then on the document
     * is kept, also when the transfer is cancelled in the same moment, because removing it right after
     * the close could race its provider's close listener (see the class notes). When the transfer was
     * cancelled before this point, nothing is closed here: [endOutput] removes a created document first.
     */
    private fun finishOutput(transfer: Transfer) {
        if (transfer.aborted) return
        val output = transfer.output ?: return
        transfer.output = null
        transfer.finished = true
        output.use { it.flush() }
    }

    /**
     * True when writing [needed] bytes, after [freed] bytes are released, still leaves the reserve of
     * [free]; an unknown amount of free space passes.
     */
    private fun hasRoomFor(free: Long?, needed: Long, freed: Long = 0L): Boolean =
        free == null || free >= needed - freed + limits.reserveBytes

    /**
     * Worker thread, before the destination is first opened: whether the picker created it for this
     * save or handed back an existing document the user chose to replace. Only a document reported
     * empty counts as created; an unknown size counts as replaced, so nothing is ever removed on a guess.
     */
    private fun classify(transfer: Transfer): Target {
        transfer.target?.let { return it }
        val size = storage.sizeOf(checkNotNull(transfer.destination))
        val target = if (size == 0L) Target.CREATED else Target.REPLACED
        transfer.existingSize = size ?: 0L
        transfer.target = target
        return target
    }

    // endregion

    // region Queue, destinations and endings

    private fun register(transfer: Transfer): Boolean {
        if (released || alive.size >= limits.maxActive) {
            notify(R.string.web_transfer_failed)
            return false
        }
        alive += transfer
        return true
    }

    private fun enqueue(transfer: Transfer, name: String) {
        transfer.name = name
        transfer.stage = Stage.QUEUED
        queue.addLast(transfer)
        pump()
    }

    private fun pump() {
        if (pickerOpen || released) return
        val launcher = launch ?: return
        while (queue.isNotEmpty()) {
            val next = queue.removeFirst()
            if (next.stage != Stage.QUEUED) continue
            val page = next.source as? PageSource
            if (page != null && next.attachment.doc != page.doc) {
                cancel(next)
                continue
            }
            next.stage = Stage.PICKING
            picking = next
            pickerOpen = true
            try {
                launcher(createDocumentIntent(next.name))
                return
            } catch (_: ActivityNotFoundException) {
                pickerOpen = false
                picking = null
                fail(next)
            } catch (_: IllegalStateException) {
                // The launcher was unregistered underneath us; the export cannot be offered.
                pickerOpen = false
                picking = null
                fail(next)
            }
        }
    }

    private fun startWriting(transfer: Transfer, destination: Uri) {
        transfer.destination = destination
        transfer.stage = Stage.WRITING
        val worker = transfer.worker ?: newWorker().also { transfer.worker = it }
        when (val source = transfer.source) {
            is PageSource -> worker.execute {
                val opened = try {
                    openPageOutput(transfer, source, destination)
                    true
                } catch (_: Exception) {
                    false
                }
                handler.post { if (opened) onPageOutputOpen(transfer) else fail(transfer) }
            }
            // A fetch still running sees the destination and may switch to it (HttpSink).
            is HttpSource -> if (source.fetched) copyHttp(transfer, source)
            is BytesSource -> {
                transfer.stage = Stage.FINISHING
                worker.execute {
                    val written = try {
                        writeComplete(transfer, source.bytes.size.toLong()) { it.write(source.bytes) }
                        true
                    } catch (_: Exception) {
                        false
                    }
                    handler.post { if (written) complete(transfer) else fail(transfer) }
                }
            }
        }
    }

    /**
     * Worker thread: where a page export's chunks go once the page is told it may stream. A document
     * the picker created takes them directly; one the user chose to replace keeps its content until
     * the whole export has arrived in the cache ([copyBuffered]). Either way there must be room for
     * the declared size first.
     */
    private fun openPageOutput(transfer: Transfer, page: PageSource, destination: Uri) {
        if (transfer.aborted) throw IOException("cancelled")
        val size = page.progress.declaredSize
        if (classify(transfer) == Target.CREATED) {
            // The transfer holds the stream until it ends: a failure leaves it to endOutput.
            val output = storage.openOutput(destination).also { transfer.output = it }
            if (!hasRoomFor(storage.freeBytes(output), size)) throw IOException("no space")
        } else {
            if (!hasRoomFor(storage.freeBytes(), size)) throw IOException("no space")
            val buffer = storage.newTempFile()
            transfer.buffer = buffer
            transfer.output = FileOutputStream(buffer)
        }
    }

    private fun onPageOutputOpen(transfer: Transfer) {
        if (transfer.stage != Stage.WRITING) return
        val page = transfer.source as PageSource
        if (transfer.attachment.doc != page.doc) {
            fail(transfer)
            return
        }
        page.slot = allocateSlot(transfer)
        page.streaming = true
        page.reply(BridgeMessages.ready(page.id, page.slot, limits, platform.binarySupported()))
        touch(transfer)
    }

    private fun complete(transfer: Transfer) {
        if (transfer.stage == Stage.CLOSED) return
        close(transfer)
        (transfer.source as? PageSource)?.let { it.reply(BridgeMessages.done(it.id)) }
        transfer.worker?.shutdown()
        notify(R.string.web_transfer_saved)
    }

    /** Ends [transfer] with a failure notice. */
    private fun fail(transfer: Transfer) = abort(transfer, notice = true)

    /** Ends [transfer] quietly, for example when the user dismissed the picker. */
    private fun cancel(transfer: Transfer) = abort(transfer, notice = false)

    private fun abort(transfer: Transfer, notice: Boolean) {
        if (transfer.stage == Stage.CLOSED) return
        transfer.aborted = true
        val destination = transfer.destination
        close(transfer)
        val source = transfer.source
        if (source is PageSource) source.reply(BridgeMessages.cancel(source.id, "cancelled"))
        if (source is HttpSource) {
            source.cancelled.set(true)
            source.connection?.let { connection -> misc.execute { connection.disconnect() } }
        }
        val worker = transfer.worker
        if (worker != null) {
            // Runs after any write or fetch already queued on this transfer's worker, so the
            // destination has been classified if anything was written to it.
            worker.execute { endOutput(transfer, destination) }
            worker.shutdown()
        } else if (destination != null) {
            discardIfCreated(destination)
        }
        if (notice) notify(R.string.web_transfer_failed)
    }

    /**
     * Worker thread, once a transfer ended without completing. A document the picker created is removed
     * while the transfer still holds its writable stream, and the stream is closed after that, so the
     * provider's close listener runs only once the document is gone (see the class notes). A document
     * whose whole export was written and closed stays, and so does one the user chose to replace.
     */
    private fun endOutput(transfer: Transfer, destination: Uri?) {
        val output = transfer.output
        transfer.output = null
        if (destination != null && !transfer.finished && classify(transfer) == Target.CREATED) storage.discard(destination)
        try {
            output?.close()
        } catch (_: IOException) {
            // Closing only releases the stream.
        }
        (transfer.source as? HttpSource)?.temp?.delete()
        transfer.buffer?.delete()
    }

    private fun close(transfer: Transfer) {
        transfer.stage = Stage.CLOSED
        alive -= transfer
        queue.remove(transfer)
        handler.removeCallbacks(transfer.idle)
        (transfer.source as? PageSource)?.let { page ->
            pageIds.remove(page.id)
            if (slots[page.slot] === transfer) slots.remove(page.slot)
        }
    }

    /**
     * Removes [uri] if the picker created it empty for a save that is gone; a replaced document stays.
     * Nothing was ever opened for writing on it, so no close listener can race the removal.
     */
    private fun discardIfCreated(uri: Uri) {
        if (!released) misc.execute { if (storage.sizeOf(uri) == 0L) storage.discard(uri) }
    }

    private fun teardown(attachment: Attachment) {
        attachment.detached = true
        attachment.bridge?.remove()
        attachment.bridge = null
        platform.setDownloadListener(attachment.webView, null)
        alive.filter { it.attachment === attachment }.forEach { cancel(it) }
    }

    // endregion

    private enum class Stage { PREPARING, QUEUED, PICKING, WRITING, FINISHING, CLOSED }

    /** What the picker handed back: a document created for the save, or an existing one to replace. */
    private enum class Target { CREATED, REPLACED }

    private inner class Attachment(val webView: WebView, session: LaunchSession) {
        /** The origin of the app's pages; HTTP downloads on it connect to the session's native address. */
        val webOrigin: String = originOf(session)
        val origin: WebOrigin = checkNotNull(WebOrigin.parse(webOrigin))
        val policy = DownloadPolicy(origin, native = checkNotNull(WebOrigin.parse(session.origin)))
        var bridge: InstalledBridge? = null
        var doc: String? = null
        var reply: ((String) -> Unit)? = null
        var userAgent: String? = null
        var detached = false

        /** URLs the page script already exported, so other paths do not save them again. */
        val captured = RecentKeys(limits.recentMillis, RECENT_KEYS, clock)

        /** Main-frame navigations seen by [handleNavigation]: proof that a download was a GET. */
        val gets = RecentKeys(limits.recentMillis, RECENT_KEYS, clock)

        /** Form POST targets reported by the page script; never fetched again. */
        val posts = RecentKeys(limits.recentMillis, RECENT_KEYS, clock)

        /** URLs the download listener reported moments ago, so a repeated report is not a second save. */
        val reports = RecentKeys(DUPLICATE_REPORT_MILLIS, RECENT_KEYS, clock)
    }

    private inner class Transfer(val attachment: Attachment, val source: Source) {
        var stage = Stage.PREPARING
        var name = FileNames.FALLBACK

        /** Set on the main thread once picked; read on [worker], for example by a running fetch. */
        @Volatile
        var destination: Uri? = null
        var worker: ExecutorService? = null

        /**
         * The destination's stream, or the cache file's for a replaced document, from its opening until
         * the transfer ends ([finishOutput], [endOutput]). Touched only on [worker].
         */
        @Volatile
        var output: OutputStream? = null

        /** Set on the main thread when the transfer ends without completing; read on [worker]. */
        @Volatile
        var aborted = false

        /** Set on [worker] once the whole export is in the destination and its stream was closed. */
        @Volatile
        var finished = false

        /** Set on [worker] before the destination is first opened, see [classify]. */
        @Volatile
        var target: Target? = null

        /** What a replaced document held when it was picked; touched only on [worker]. */
        @Volatile
        var existingSize = 0L

        /** The cache file a page export for a replaced document goes to; touched only on [worker]. */
        @Volatile
        var buffer: File? = null

        val idle = Runnable { fail(this) }
    }

    private sealed class Source

    private class PageSource(
        val doc: String,
        val id: String,
        size: Long,
        val reply: (String) -> Unit,
        chunkBytes: Int,
    ) : Source() {
        val progress = TransferProgress(size, chunkBytes)
        var slot = 0
        var streaming = false
        var inFlight = 0
        var endSize = -1L
    }

    private class HttpSource(
        val hop: DownloadHop,
        val nameHint: String?,
        val disposition: String?,
        val mime: String?,
    ) : Source() {
        val cancelled = AtomicBoolean(false)

        @Volatile
        var connection: HttpURLConnection? = null

        @Volatile
        var temp: File? = null
        var fetched = false
    }

    private class BytesSource(val bytes: ByteArray) : Source()

    companion object {
        /** How long a download listener report counts as a repeat of the same download. */
        const val DUPLICATE_REPORT_MILLIS = 2_000L
        private const val RECENT_KEYS = 64
        private const val SPACE_CHECK_BYTES = 4L shl 20
        private const val COPY_BUFFER_BYTES = 64 * 1024

        fun createDocumentIntent(name: String): Intent = Intent(Intent.ACTION_CREATE_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType(FileNames.saveMime(name))
            .putExtra(Intent.EXTRA_TITLE, name)

        private fun defaultWorker(): ExecutorService = Executors.newSingleThreadExecutor { runnable ->
            Thread(runnable, "sillybunny-web-transfer").apply { isDaemon = true }
        }
    }
}

/** Keys seen within [ttlMillis], at most [max] of them; oldest first. */
internal class RecentKeys(private val ttlMillis: Long, private val max: Int, private val clock: () -> Long) {
    private val entries = LinkedHashMap<String, Long>()

    fun add(key: String) {
        prune()
        entries.remove(key)
        entries[key] = clock()
        while (entries.size > max) entries.remove(entries.keys.first())
    }

    fun contains(key: String): Boolean {
        prune()
        return key in entries
    }

    /** True when [key] was present; it is removed, so one export answers one duplicate. */
    fun consume(key: String): Boolean {
        prune()
        return entries.remove(key) != null
    }

    private fun prune() {
        val oldest = clock() - ttlMillis
        val iterator = entries.values.iterator()
        while (iterator.hasNext()) {
            if (iterator.next() >= oldest) break
            iterator.remove()
        }
    }
}
