package io.github.sillybunnyteam.sillybunny.documents

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.ParcelFileDescriptor
import android.os.ProxyFileDescriptorCallback
import android.os.storage.StorageManager
import android.provider.DocumentsContract
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import android.util.AtomicFile
import android.util.Log
import java.io.File
import java.io.FileNotFoundException
import java.util.UUID
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit

internal class DocumentsWorkspace private constructor(val context: Context) {
    val files by lazy { DocumentFiles(context.filesDir) }
    val ids by lazy { DocumentIds(files, context.noBackupFilesDir) { rootId } }
    val observers = DocumentObservers(this)
    var revoker: ((String) -> Unit)? = null
    val sessions = mutableSetOf<DocumentProxy>()
    private val authority = "${context.packageName}.documents"
    private val proxyThread by lazy { HandlerThread("documents-proxy").apply { start() } }
    val proxyHandler by lazy { Handler(proxyThread.looper) }
    val storageManager by lazy { context.getSystemService(StorageManager::class.java) }
    private val proxyBridgeLock = Any()
    private var proxySentinel: ParcelFileDescriptor? = null
    private val worker = ScheduledThreadPoolExecutor(1) { runnable ->
        Thread(runnable, "documents-io").apply { isDaemon = true }
    }
    private val notifications = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "documents-notifications").apply { isDaemon = true }
    }
    private val generationFile by lazy { AtomicFile(File(context.noBackupFilesDir, "documents-generation")) }
    private val maintenanceFile by lazy { File(context.noBackupFilesDir, "documents-maintenance") }
    private var generation: String? = null
    private var maintenance: Boolean? = null
    val isAvailable: Boolean get() = !(maintenance ?: maintenanceFile.exists().also { maintenance = it })
    val rootId: String get() = "root:${generation()}${files.identity(files.root())}"

    fun <T> call(block: DocumentsWorkspace.() -> T): T {
        try {
            return worker.submit<T> { block() }.get()
        } catch (failure: ExecutionException) {
            throw failure.cause ?: failure
        } catch (failure: InterruptedException) {
            Thread.currentThread().interrupt()
            throw FileNotFoundException("TODO(copy)")
        }
    }

    fun post(block: DocumentsWorkspace.() -> Unit) {
        worker.execute { guarded(block) }
    }

    fun schedule(delayMillis: Long, block: DocumentsWorkspace.() -> Unit) {
        worker.schedule({ guarded(block) }, delayMillis, TimeUnit.MILLISECONDS)
    }

    private fun guarded(block: DocumentsWorkspace.() -> Unit) {
        try {
            block()
        } catch (failure: Throwable) {
            // Posted work has no caller to report to. Escaping would end the process, and the server it hosts.
            Log.w(TAG, "Background document work failed", failure)
        }
    }

    fun requireAvailable() {
        if (!isAvailable) throw FileNotFoundException("TODO(copy)")
    }

    fun releaseProvider() {
        observers.clear()
        sessions.toList().forEach { it.close() }
        revoker = null
        synchronized(proxyBridgeLock) {
            proxySentinel?.close()
            proxySentinel = null
        }
    }

    fun keepProxyBridgeAlive() {
        if (Build.VERSION.SDK_INT != 29) return
        synchronized(proxyBridgeLock) {
            if (proxySentinel != null) return
            // Android 10's last-close/remount path has a Java/native AppFuse lock inversion (fixed in 11).
            // Keep this process's bridge alive with an empty private descriptor, never a user-data lease.
            // Its callbacks must not acquire the I/O gate or proxyBridgeLock during synchronous open.
            proxySentinel = storageManager.openProxyFileDescriptor(
                ParcelFileDescriptor.MODE_READ_ONLY,
                object : ProxyFileDescriptorCallback() {
                    override fun onGetSize(): Long = 0
                    override fun onRead(offset: Long, size: Int, data: ByteArray): Int = 0
                    override fun onRelease() = Unit
                },
                proxyHandler,
            )
        }
    }

    fun beginMaintenance() {
        if (!isAvailable) return
        // Repair can run without a checkout (failed first install, interrupted Repair); the gate must still close.
        val previousRoot = currentRootId()
        // Persist the closed gate before revocation: a host crash must not reopen access mid-Repair.
        java.io.FileOutputStream(maintenanceFile).use { output ->
            output.write(1)
            output.fd.sync()
        }
        maintenance = true
        observers.clear()
        sessions.toList().forEach { it.close() }
        ids.issuedUnder(null).forEach(::revokeGrants)
        ids.clear()
        previousRoot?.let(::revokeGrants)
        newGeneration()
        rootsChanged(previousRoot)
    }

    fun endMaintenance() {
        if (isAvailable) return
        // Every recovery completion, including one after host death, invalidates pre-Repair IDs.
        // A failed reinstall can leave no checkout; the new generation alone then retires old root IDs.
        ids.issuedUnder(null).forEach(::revokeGrants)
        ids.clear()
        currentRootId()?.let(::revokeGrants)
        newGeneration()
        if (maintenanceFile.exists() && !maintenanceFile.delete()) throw FileNotFoundException("TODO(copy)")
        maintenance = false
        rootsChanged(currentRootId())
    }

    fun currentRootId(): String? = try {
        rootId
    } catch (_: ErrnoException) {
        null
    } catch (_: FileNotFoundException) {
        null
    }

    private fun rootsChanged(rootDocumentId: String?) {
        rootDocumentId?.let {
            notifyDocument(it)
            notifyChildren(it)
        }
        notifyRoots()
    }

    /** The roots cursor shows a summary read from `config.yaml`, so a change there notifies it. */
    fun notifyRoots() {
        notify(DocumentsContract.buildRootsUri(authority))
    }

    /**
     * Whether `config.yaml`'s `dataRoot` sends the server's data outside the `data` folder this provider shows.
     * Null when that is unknown: no checkout, maintenance, an unreadable file or a value this reader cannot parse.
     * The server reads the key with a YAML parser and joins a relative value to the checkout, which is its working
     * directory, so the value is resolved the same way, then its symlinks. A folder inside `data` still counts as
     * shown. Nothing here changes what the provider exposes.
     */
    fun dataRootElsewhere(): Boolean? {
        if (!isAvailable) return null
        return try {
            val value = configuredDataRoot() ?: return null
            val checkout = files.checkout.toPath()
            val target = checkout.resolve(value).normalize().toFile().canonicalFile.toPath()
            !target.startsWith(checkout.resolve("data"))
        } catch (_: Exception) {
            null
        }
    }

    /** The `dataRoot` value: the server's default when the key is absent, null when it cannot be read with certainty. */
    private fun configuredDataRoot(): String? {
        val entry = files.resolve("config.yaml")
        if (entry.stat.st_size > MAX_CONFIG_BYTES) return null
        val descriptor = files.open(entry, OsConstants.O_RDONLY)
        val bytes = ByteArray(MAX_CONFIG_BYTES + 1)
        val size = try {
            var total = 0
            while (total < bytes.size) {
                val count = Os.read(descriptor, bytes, total, bytes.size - total)
                if (count <= 0) break
                total += count
            }
            total
        } finally {
            Os.close(descriptor)
        }
        if (size > MAX_CONFIG_BYTES) return null
        val lines = String(bytes, 0, size, Charsets.UTF_8).removePrefix("\uFEFF").lines()
        val keys = lines.indices.filter { DATA_ROOT_KEY.matches(lines[it]) }
        if (keys.isEmpty()) return DEFAULT_DATA_ROOT
        val line = keys.singleOrNull() ?: return null
        // An indented line after the key continues its value, or holds it when the key line has none.
        val next = lines.getOrNull(line + 1)
        if (next != null && (next.startsWith(' ') || next.startsWith('\t')) && next.isNotBlank() &&
            !next.trimStart().startsWith('#')
        ) {
            return null
        }
        return yamlScalar(DATA_ROOT_KEY.matchEntire(lines[line])!!.groupValues[1].trim())
    }

    /**
     * One flow scalar on one line, as a YAML parser reads it: double-quoted without escapes, single-quoted, or
     * plain up to a comment. Null for YAML null, block scalars, flow collections, anchors, tags, aliases, escapes
     * and anything malformed.
     */
    private fun yamlScalar(text: String): String? {
        fun commentOnly(rest: String) = rest.isEmpty() || rest[0].isWhitespace() && (rest.isBlank() || rest.trimStart()[0] == '#')
        return when {
            text.isEmpty() || text.startsWith('#') -> null
            text.startsWith('"') -> {
                val end = text.indexOf('"', 1)
                text.substring(1, maxOf(end, 1)).takeIf { end > 0 && '\\' !in it && commentOnly(text.substring(end + 1)) }
            }
            text.startsWith('\'') -> {
                val value = StringBuilder()
                var index = 1
                while (index < text.length) {
                    if (text[index] != '\'') {
                        value.append(text[index++])
                    } else if (text.getOrNull(index + 1) == '\'') {
                        value.append('\'')
                        index += 2
                    } else {
                        return value.toString().takeIf { commentOnly(text.substring(index + 1)) }
                    }
                }
                null
            }
            text[0] in "[]{}|>&*!%@`,?" -> null
            else -> {
                val plain = text.split(Regex("[ \t]#"), limit = 2)[0].trimEnd()
                plain.takeIf { ": " !in it && !it.endsWith(':') && it !in YAML_NULLS }
            }
        }
    }

    /**
     * Notifies the parent of [relative]: its document and children URIs. Only issued IDs can carry cursors,
     * so the parent's IDs come from the ledger and nothing is walked, marked or recorded.
     */
    fun notifyParentOf(relative: String) {
        issuedAtParentOf(relative).forEach { id ->
            notifyDocument(id)
            notifyChildren(id)
        }
    }

    /**
     * [relative] was created, deleted or renamed, so its parent's rows and the parent's modified time changed.
     * Notifies the parent ([notifyParentOf]) and the grandparent's listing, the one other cursor that shows that
     * time. Nothing in higher listings or in the roots cursor changes.
     */
    fun notifyNameChange(relative: String) {
        notifyParentOf(relative)
        notifyListingOf(relative.substringBeforeLast('/', ""))
    }

    /** Notifies the listing that shows [relative] as a row: its parent's children URI. The checkout ("") has none. */
    fun notifyListingOf(relative: String) {
        if (relative.isEmpty()) return
        issuedAtParentOf(relative).forEach(::notifyChildren)
    }

    private fun issuedAtParentOf(relative: String): List<String> {
        val parent = relative.substringBeforeLast('/', "")
        return if (parent.isEmpty()) listOfNotNull(currentRootId()) else ids.issuedAt(parent)
    }

    fun notifyDocument(id: String) {
        notify(DocumentsContract.buildDocumentUri(authority, id))
    }

    fun notifyChildren(id: String) {
        notify(DocumentsContract.buildChildDocumentsUri(authority, id))
    }

    fun notify(uri: Uri) {
        // Content observers can synchronously re-enter the provider; never hold its I/O gate here.
        notifications.execute {
            try {
                context.contentResolver.notifyChange(uri, null, 0)
            } catch (failure: Exception) {
                Log.w(TAG, "Change notification failed", failure)
            }
        }
    }

    /** Revokes every grant on [id] and forgets it. */
    fun revoke(id: String) {
        revokeGrants(id)
        ids.forget(id)
    }

    /** Revokes and forgets every ID issued at or below [relative], and returns them. */
    fun revokeUnder(relative: String): List<String> = ids.issuedUnder(relative).also { issued ->
        issued.forEach(::revokeGrants)
        ids.forgetUnder(relative)
    }

    private fun revokeGrants(id: String) {
        val callback = revoker
        if (callback != null) {
            callback(id)
        } else {
            val flags = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            context.revokeUriPermission(DocumentsContract.buildDocumentUri(authority, id), flags)
            context.revokeUriPermission(DocumentsContract.buildTreeDocumentUri(authority, id), flags)
        }
    }

    /** Revokes the IDs issued at or below [relative] that no longer resolve, and returns them. */
    fun revokeStale(relative: String?): List<String> = ids.issuedUnder(relative).filter { id ->
        val stale = try {
            ids.resolve(id)
            false
        } catch (_: Exception) {
            true
        }
        if (stale) revoke(id)
        stale
    }

    private fun generation(): String {
        generation?.let { return it }
        val stored = if (generationFile.baseFile.exists()) {
            generationFile.openRead().bufferedReader().use { it.readText() }
        } else {
            newGeneration()
        }
        if (!stored.matches(DocumentFiles.UUID_PATTERN)) throw FileNotFoundException("TODO(copy)")
        generation = stored
        return stored
    }

    private fun newGeneration(): String {
        val value = UUID.randomUUID().toString()
        val output = generationFile.startWrite()
        try {
            output.write(value.toByteArray(Charsets.US_ASCII))
            generationFile.finishWrite(output)
        } catch (failure: Throwable) {
            generationFile.failWrite(output)
            throw failure
        }
        generation = value
        return value
    }

    companion object {
        private const val TAG = "SillyBunnyDocuments"
        private val workspaces = mutableMapOf<String, DocumentsWorkspace>()
        private const val MAX_CONFIG_BYTES = 65_536

        /** The server's default when `config.yaml` has no `dataRoot` (src/command-line.js). */
        private const val DEFAULT_DATA_ROOT = "./data"

        /** A top-level `dataRoot` key, plain or quoted, and the rest of its line. */
        private val DATA_ROOT_KEY = Regex("""(?:dataRoot|"dataRoot"|'dataRoot')[ \t]*:(?:[ \t](.*))?""")
        private val YAML_NULLS = setOf("~", "null", "Null", "NULL")

        fun get(context: Context): DocumentsWorkspace = synchronized(workspaces) {
            val application = context.applicationContext
            workspaces.getOrPut(application.applicationInfo.dataDir) { DocumentsWorkspace(application) }
        }
    }
}
