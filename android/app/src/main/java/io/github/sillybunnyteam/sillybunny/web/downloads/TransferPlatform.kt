package io.github.sillybunnyteam.sillybunny.web.downloads

import android.annotation.SuppressLint
import android.content.ContentResolver
import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import android.webkit.CookieManager
import android.webkit.DownloadListener
import android.webkit.WebView
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.io.File
import java.io.FileDescriptor
import java.io.FileNotFoundException
import java.io.FileOutputStream
import java.io.IOException
import java.io.OutputStream
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/** A message the page script posted through the bridge. */
internal sealed class BridgeInput {
    class Text(val text: String) : BridgeInput()

    class Binary(val bytes: ByteArray) : BridgeInput()
}

/** Receives bridge messages on the main thread; [reply] posts a string back to the sending frame. */
internal fun interface BridgeListener {
    fun onMessage(input: BridgeInput, sourceOrigin: Uri, isMainFrame: Boolean, reply: (String) -> Unit)
}

/** Undoes [TransferPlatform.installBridge]. */
internal fun interface InstalledBridge {
    fun remove()
}

/** The WebView calls [WebTransfers] makes, so tests can drive it without a WebView provider. */
internal interface TransferPlatform {
    /** Both the document-start script and the message listener are available. */
    fun bridgeSupported(): Boolean

    /** The page may post ArrayBuffer chunks instead of base64 strings. */
    fun binarySupported(): Boolean

    /**
     * Adds the message listener and the document-start [script] for frames of exactly [origin]; null
     * when the provider refuses either.
     */
    fun installBridge(webView: WebView, origin: String, script: String, listener: BridgeListener): InstalledBridge?

    fun setDownloadListener(webView: WebView, listener: DownloadListener?)

    fun evaluate(webView: WebView, script: String, result: (String?) -> Unit)

    fun userAgent(webView: WebView): String?

    /** The WebView cookie header for [url]; only ever called for the exact app origin. */
    fun cookies(url: String): String?
}

internal object AndroidTransferPlatform : TransferPlatform {
    const val BRIDGE_NAME = "sillybunnyTransfers"

    override fun bridgeSupported(): Boolean =
        WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) &&
            WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)

    override fun binarySupported(): Boolean = WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_ARRAY_BUFFER)

    override fun installBridge(
        webView: WebView,
        origin: String,
        script: String,
        listener: BridgeListener,
    ): InstalledBridge? {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return null
        val rules = setOf(origin)
        try {
            WebViewCompat.addWebMessageListener(webView, BRIDGE_NAME, rules) { _, message, sourceOrigin, isMainFrame, reply ->
                val input = read(message) ?: return@addWebMessageListener
                listener.onMessage(input, sourceOrigin, isMainFrame) { text -> reply.postMessage(text) }
            }
        } catch (_: IllegalArgumentException) {
            return null
        } catch (_: UnsupportedOperationException) {
            return null
        }
        val handler = addScript(webView, script, rules)
        if (handler == null) {
            WebViewCompat.removeWebMessageListener(webView, BRIDGE_NAME)
            return null
        }
        return InstalledBridge {
            handler.remove()
            WebViewCompat.removeWebMessageListener(webView, BRIDGE_NAME)
        }
    }

    private fun addScript(webView: WebView, script: String, rules: Set<String>) =
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            try {
                WebViewCompat.addDocumentStartJavaScript(webView, script, rules)
            } catch (_: IllegalArgumentException) {
                null
            } catch (_: UnsupportedOperationException) {
                null
            }
        } else {
            null
        }

    private fun read(message: WebMessageCompat): BridgeInput? = when (message.type) {
        WebMessageCompat.TYPE_STRING -> message.data?.let(BridgeInput::Text)
        WebMessageCompat.TYPE_ARRAY_BUFFER ->
            if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_ARRAY_BUFFER)) {
                BridgeInput.Binary(message.arrayBuffer)
            } else {
                null
            }
        else -> null
    }

    override fun setDownloadListener(webView: WebView, listener: DownloadListener?) {
        webView.setDownloadListener(listener)
    }

    override fun evaluate(webView: WebView, script: String, result: (String?) -> Unit) {
        webView.evaluateJavascript(script) { result(it) }
    }

    override fun userAgent(webView: WebView): String? = webView.settings.userAgentString

    override fun cookies(url: String): String? = CookieManager.getInstance().getCookie(url)
}

/** Storage calls for exports: destinations chosen in SAF and the cache that buffers downloads. */
internal interface TransferStorage {
    /** Opens [uri] for writing from its start; what it held before is replaced. */
    fun openOutput(uri: Uri): OutputStream

    /**
     * The size of the document at [uri], or null when neither its provider nor its file says. A picker
     * creates a new document empty, so a size of 0 is how a document created for a save is told apart
     * from an existing one the user chose to replace.
     */
    fun sizeOf(uri: Uri): Long?

    /**
     * Best-effort removal of a destination the picker created for a save; never a replaced document.
     * A caller that opened [uri] for writing removes it before closing that stream, never right after:
     * the downloads provider updates a document from a listener that runs once a writer closed it, and
     * a removal racing that listener crashes the provider's process.
     */
    fun discard(uri: Uri)

    fun newTempFile(): File

    /** Bytes still free where temporary files live. */
    fun freeBytes(): Long

    /** Bytes free on the volume that holds [uri], measured without writing to it; null when unknown. */
    fun freeBytesAt(uri: Uri): Long?

    /** Bytes free on the volume [output] writes to; null when unknown, for example for a pipe. */
    fun freeBytes(output: OutputStream): Long?

    /** Removes temporary files of other instances, for example ones left by a killed process. */
    fun clearStale()

    /** Removes this instance's temporary files. */
    fun clearOwn()
}

internal class ContentTransferStorage(private val context: Context) : TransferStorage {
    private val resolver: ContentResolver get() = context.contentResolver
    private val root: File get() = File(context.cacheDir, TEMP_DIR)

    // Each instance buffers in its own folder, and folders of instances alive in this process are never
    // cleared as stale, so clearing never races a live download.
    private val ownName = UUID.randomUUID().toString().also { liveFolders += it }
    private val own: File get() = File(root, ownName)

    override fun openOutput(uri: Uri): OutputStream {
        // "wt" truncates a replaced document; some providers only know "w".
        val stream = try {
            resolver.openOutputStream(uri, "wt")
        } catch (_: FileNotFoundException) {
            openTruncated(uri)
        } catch (_: IllegalArgumentException) {
            openTruncated(uri)
        }
        return stream ?: throw FileNotFoundException("destination")
    }

    // Mode "w" need not truncate (plan §4.8), which would leave the end of a longer replaced document
    // behind, so a local file is truncated here. Through a pipe the provider decides what "w" replaces.
    private fun openTruncated(uri: Uri): OutputStream? = resolver.openOutputStream(uri, "w")?.also { stream ->
        try {
            (stream as? FileOutputStream)?.channel?.truncate(0)
        } catch (_: IOException) {
            // Not a regular file.
        }
    }

    override fun sizeOf(uri: Uri): Long? {
        val reported = reportedSize(uri)
        if (reported != null && reported > 0) return reported
        // MediaStore fills in a size only after it has scanned the file, and the downloads provider
        // updates it after a writer closed; a local file's own size settles a reported 0 or nothing.
        return localSize(uri) ?: reported
    }

    private fun reportedSize(uri: Uri): Long? = try {
        resolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { cursor ->
            val column = cursor.getColumnIndex(OpenableColumns.SIZE)
            if (column >= 0 && cursor.moveToFirst() && !cursor.isNull(column)) cursor.getLong(column).takeIf { it >= 0 } else null
        }
    } catch (_: Exception) {
        null
    }

    // Opened read-only: probing never changes the document.
    private fun localSize(uri: Uri): Long? = try {
        resolver.openFileDescriptor(uri, "r")?.use { descriptor ->
            Os.fstat(descriptor.fileDescriptor).takeIf { OsConstants.S_ISREG(it.st_mode) }?.st_size
        }
    } catch (_: Exception) {
        null
    }

    override fun freeBytesAt(uri: Uri): Long? = try {
        resolver.openFileDescriptor(uri, "r")?.use { freeBytes(it.fileDescriptor) }
    } catch (_: Exception) {
        null
    }

    override fun freeBytes(output: OutputStream): Long? = try {
        (output as? FileOutputStream)?.fd?.let(::freeBytes)
    } catch (_: IOException) {
        null
    }

    private fun freeBytes(descriptor: FileDescriptor): Long? = try {
        if (OsConstants.S_ISREG(Os.fstat(descriptor).st_mode)) Os.fstatvfs(descriptor).let { it.f_bavail * it.f_frsize } else null
    } catch (_: ErrnoException) {
        null
    }

    override fun discard(uri: Uri) {
        try {
            if (DocumentsContract.isDocumentUri(context, uri)) {
                DocumentsContract.deleteDocument(resolver, uri)
            } else {
                resolver.delete(uri, null, null)
            }
        } catch (_: Exception) {
            // The document stays; nothing more can be done for it.
        }
    }

    override fun newTempFile(): File {
        own.mkdirs()
        return File.createTempFile("download", ".part", own)
    }

    // The reserve protects space other apps and the system need right now. Allocatable bytes would also
    // count other apps' caches, which are only freed by allocateBytes, so they are not used here.
    @SuppressLint("UsableSpace")
    override fun freeBytes(): Long = context.cacheDir.usableSpace

    override fun clearStale() {
        root.listFiles()?.filter { it.name !in liveFolders }?.forEach { it.deleteRecursively() }
    }

    override fun clearOwn() {
        own.deleteRecursively()
        liveFolders -= ownName
    }

    private companion object {
        const val TEMP_DIR = "web-transfers"
        val liveFolders: MutableSet<String> = ConcurrentHashMap.newKeySet()
    }
}

/** The document-start script from `assets/web/transfers.js`. */
internal object TransferScript {
    const val ASSET = "web/transfers.js"

    @Volatile
    private var cached: String? = null

    fun load(context: Context): String =
        cached ?: context.assets.open(ASSET).bufferedReader().use { it.readText() }.also { cached = it }
}
