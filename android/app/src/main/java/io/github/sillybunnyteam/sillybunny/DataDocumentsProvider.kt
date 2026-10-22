package io.github.sillybunnyteam.sillybunny

import android.content.Context
import android.database.Cursor
import android.database.MatrixCursor
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import android.provider.DocumentsContract.Root
import android.provider.DocumentsProvider
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import android.webkit.MimeTypeMap
import io.github.sillybunnyteam.sillybunny.documents.DocumentFiles
import io.github.sillybunnyteam.sillybunny.documents.DocumentMode
import io.github.sillybunnyteam.sillybunny.documents.DocumentNames
import io.github.sillybunnyteam.sillybunny.documents.DocumentObservers
import io.github.sillybunnyteam.sillybunny.documents.DocumentProxy
import io.github.sillybunnyteam.sillybunny.documents.DocumentsWorkspace
import java.io.FileNotFoundException
import java.io.IOException
import java.nio.file.Files
import java.nio.file.LinkOption

// SillyBunny exposes only data and config through a synthetic root, never the checkout itself.
class DataDocumentsProvider : DocumentsProvider() {
    override fun onCreate(): Boolean = true

    override fun shutdown() {
        context?.let { DocumentsWorkspace.get(it).post { releaseProvider() } }
        super.shutdown()
    }

    override fun queryRoots(projection: Array<out String>?): Cursor = access {
        val columns = projection ?: ROOT_PROJECTION
        MatrixCursor(columns).apply {
            val root = try {
                files.root()
            } catch (_: ErrnoException) {
                null
            } catch (_: FileNotFoundException) {
                null
            }
            if (root != null) {
                addRow(columns.map { column ->
                    when (column) {
                        Root.COLUMN_ROOT_ID -> "sillybunny"
                        Root.COLUMN_DOCUMENT_ID -> rootId
                        Root.COLUMN_TITLE -> context.getString(R.string.app_name)
                        // The provider supports creation below the root's data anchor; direct root siblings remain refused.
                        Root.COLUMN_FLAGS -> Root.FLAG_LOCAL_ONLY or Root.FLAG_SUPPORTS_IS_CHILD or Root.FLAG_SUPPORTS_CREATE
                        Root.COLUMN_ICON -> R.mipmap.ic_launcher
                        Root.COLUMN_MIME_TYPES -> "*/*"
                        else -> null
                    }
                })
            }
            setNotificationUri(context.contentResolver, DocumentsContract.buildRootsUri(authority(context)))
        }
    }

    override fun queryDocument(documentId: String, projection: Array<out String>?): Cursor = access {
        val entry = ids.resolve(documentId)
        documentCursor(projection).apply {
            addDocument(entry, documentId, context)
            setNotificationUri(context.contentResolver, DocumentsContract.buildDocumentUri(authority(context), documentId))
        }
    }

    override fun queryChildDocuments(
        parentDocumentId: String,
        projection: Array<out String>?,
        sortOrder: String?,
    ): Cursor = access {
        val parent = ids.resolve(parentDocumentId)
        if (!parent.directory) throw FileNotFoundException("lorum ipsum")
        val children = if (parent.relative == null) {
            listOf("data", "config.yaml")
        } else {
            parent.file.list()?.toList() ?: throw FileNotFoundException("lorum ipsum")
        }
        val listed = linkedMapOf<String, DocumentObservers.Child>()
        documentCursor(projection).apply {
            // One ledger transaction per listing: new IDs cost one commit, not one per child.
            ids.batch {
                children.sorted().forEach { name ->
                    // A child that vanishes, or whose identity cannot be read or written, is omitted instead of
                    // failing the whole listing. Fail-closed: an ID issued for it earlier cannot resolve either.
                    val child = try {
                        files.child(parent, name).let { it to ids.id(it) }
                    } catch (_: ErrnoException) {
                        null
                    } catch (_: FileNotFoundException) {
                        null
                    }
                    if (child != null) {
                        val (entry, id) = child
                        listed[name] = DocumentObservers.Child.of(entry, id)
                        addDocument(entry, id, context)
                    }
                }
            }
            setNotificationUri(
                context.contentResolver,
                DocumentsContract.buildChildDocumentsUri(authority(context), parentDocumentId),
            )
            observers.listed(parent, parentDocumentId, listed)
        }
    }

    override fun isChildDocument(parentDocumentId: String, documentId: String): Boolean = access {
        val parent = ids.resolve(parentDocumentId)
        val child = ids.resolve(documentId)
        parent.directory && parent.file.toPath() != child.file.toPath() &&
            child.file.toPath().startsWith(parent.file.toPath())
    }

    override fun createDocument(parentDocumentId: String, mimeType: String, displayName: String): String = access {
        val parent = ids.resolve(parentDocumentId)
        if (!parent.directory || parent.relative?.let { it == "data" || it.startsWith("data/") } != true) {
            throw FileNotFoundException("lorum ipsum")
        }
        val name = DocumentNames.validate(displayName)
        val path = parent.file.toPath().resolve(name)
        if (mimeType == Document.MIME_TYPE_DIR) {
            Files.createDirectory(path)
        } else {
            val fd = Os.open(
                path.toString(),
                OsConstants.O_WRONLY or OsConstants.O_CREAT or OsConstants.O_EXCL or
                    OsConstants.O_NOFOLLOW or OsConstants.O_CLOEXEC,
                0x180,
            )
            Os.close(fd)
        }
        val entry = files.child(parent, name)
        ids.id(entry).also { id ->
            observers.created(entry, id)
            notifyDocument(parentDocumentId)
            notifyChildren(parentDocumentId)
            // The parent's modified time changed too, and the grandparent's listing shows it.
            notifyListingOf(requireNotNull(parent.relative))
        }
    }

    override fun renameDocument(documentId: String, displayName: String): String? = access {
        val entry = ids.resolve(documentId)
        requireMutable(entry)
        val name = DocumentNames.validate(displayName)
        if (entry.file.name == name) return@access null
        val relative = requireNotNull(entry.relative)
        val target = entry.file.toPath().resolveSibling(name)
        if (Files.exists(target, LinkOption.NOFOLLOW_LINKS)) throw FileNotFoundException("lorum ipsum")
        // Only issued IDs can carry grants or cursors, and the ledger records every one of them, so the
        // subtree is never walked, marked or recorded. Old descendant IDs stop resolving with the old path.
        val oldIds = ids.issuedUnder(relative)
        Files.move(entry.file.toPath(), target)
        val renamed = files.resolve("${relative.substringBeforeLast('/')}/$name")
        observers.removed(entry)
        // DocumentsProvider moves the caller's narrow grant to the new ID after this returns, then revokes
        // documentId itself, so only the other IDs are revoked here.
        oldIds.filter { it != documentId }.forEach(::revoke)
        ids.forget(documentId)
        val renamedId = ids.id(renamed)
        observers.created(renamed, renamedId)
        (oldIds + documentId).distinct().forEach(::notifyDocument)
        notifyNameChange(relative)
        renamedId
    }

    override fun deleteDocument(documentId: String) = access {
        val entry = ids.resolve(documentId)
        requireMutable(entry)
        val relative = requireNotNull(entry.relative)
        try {
            // lstat-only removal: nothing below the entry is identified, marked or recorded first.
            files.deleteTree(entry)
        } catch (failure: Exception) {
            // A partial delete keeps the entry and what remains below it reachable, and revokes only what is
            // gone. Any listing at or below the entry may have lost rows, so every remaining issued ID is notified.
            revokeStale(relative).forEach(::notifyDocument)
            ids.issuedUnder(relative).forEach { id ->
                notifyDocument(id)
                notifyChildren(id)
            }
            notifyParentOf(relative)
            throw failure
        }
        observers.removed(entry)
        (revokeUnder(relative) + documentId).distinct().forEach(::notifyDocument)
        notifyNameChange(relative)
    }

    override fun openDocument(
        documentId: String,
        mode: String,
        signal: CancellationSignal?,
    ): ParcelFileDescriptor {
        signal?.throwIfCanceled()
        val workspace = DocumentsWorkspace.get(requireNotNull(context))
        val proxy = access {
            signal?.throwIfCanceled()
            val entry = ids.resolve(documentId)
            if (entry.directory) throw FileNotFoundException("lorum ipsum")
            val requestedMode = DocumentMode.parse(mode)
            val descriptor = files.open(entry, requestedMode.openFlags)
            try {
                ids.verifyOpened(documentId, descriptor)
                // wt/rwt truncate only at the commit below, after the no-follow open and identity checks.
                DocumentProxy(this, descriptor, documentId, requireNotNull(entry.relative), requestedMode).also {
                    sessions += it
                }
            } catch (failure: Throwable) {
                Os.close(descriptor)
                throw failure
            }
        }
        try {
            signal?.setOnCancelListener { workspace.post { proxy.cancel() } }
            // Never open the FUSE descriptor on the serialized I/O worker: initial size callbacks can block on it.
            workspace.keepProxyBridgeAlive()
            val descriptor = workspace.storageManager.openProxyFileDescriptor(proxy.mode.proxyFlags, proxy, workspace.proxyHandler)
            try {
                // The commit point: ordered against cancellation and maintenance on the worker. A cancel or
                // beginMaintenance() before it fails the open with the content intact; after it, a late cancel
                // is ignored and the client gets a working descriptor.
                workspace.call { proxy.commit(signal) }
                signal?.setOnCancelListener(null)
                return descriptor
            } catch (failure: Throwable) {
                descriptor.close()
                throw failure
            }
        } catch (failure: Throwable) {
            workspace.call { proxy.close() }
            if (failure is android.os.OperationCanceledException) throw failure
            throw FileNotFoundException("lorum ipsum")
        }
    }

    private fun <T> access(block: DocumentsWorkspace.() -> T): T {
        val workspace = DocumentsWorkspace.get(requireNotNull(context))
        return workspace.call {
            requireAvailable()
            revoker = ::revokeDocumentPermission
            try {
                block()
            } catch (_: ErrnoException) {
                throw FileNotFoundException("lorum ipsum")
            } catch (_: IOException) {
                throw FileNotFoundException("lorum ipsum")
            }
        }
    }

    private fun documentCursor(projection: Array<out String>?) = MatrixCursor(projection ?: DOCUMENT_PROJECTION)

    private fun requireMutable(entry: DocumentFiles.Entry) {
        if (entry.relative?.startsWith("data/") != true) throw FileNotFoundException("lorum ipsum")
    }

    private fun MatrixCursor.addDocument(entry: DocumentFiles.Entry, id: String, context: Context) {
        addRow(columnNames.map { column ->
            when (column) {
                Document.COLUMN_DOCUMENT_ID -> id
                Document.COLUMN_DISPLAY_NAME -> if (entry.relative == null) context.getString(R.string.app_name) else entry.file.name
                Document.COLUMN_MIME_TYPE -> if (entry.directory) Document.MIME_TYPE_DIR else {
                    MimeTypeMap.getSingleton().getMimeTypeFromExtension(entry.file.extension.lowercase())
                        ?: "application/octet-stream"
                }
                Document.COLUMN_FLAGS -> if (entry.relative == null) 0 else {
                    var flags = if (entry.directory) Document.FLAG_DIR_SUPPORTS_CREATE else 0
                    if (!entry.directory) flags = flags or Document.FLAG_SUPPORTS_WRITE
                    if (entry.relative.startsWith("data/")) {
                        flags = flags or Document.FLAG_SUPPORTS_DELETE or Document.FLAG_SUPPORTS_RENAME
                    }
                    flags
                }
                Document.COLUMN_SIZE -> if (entry.directory) null else entry.stat.st_size
                Document.COLUMN_LAST_MODIFIED -> entry.stat.st_mtime * 1000
                Document.COLUMN_ICON -> if (entry.relative == null) R.mipmap.ic_launcher else null
                else -> null
            }
        })
    }

    companion object {
        @JvmStatic
        fun beginMaintenance(context: Context) {
            DocumentsWorkspace.get(context).call { beginMaintenance() }
        }

        @JvmStatic
        fun endMaintenance(context: Context) {
            DocumentsWorkspace.get(context).call { endMaintenance() }
        }

        @JvmStatic
        fun notifyRootsChanged(context: Context) {
            DocumentsWorkspace.get(context).post {
                notify(DocumentsContract.buildRootsUri(authority(context)))
            }
        }

        @JvmStatic
        fun usesCustomDataRoot(context: Context): Boolean? = DocumentsWorkspace.get(context).call { usesCustomDataRoot() }

        private val ROOT_PROJECTION = arrayOf(
            Root.COLUMN_ROOT_ID,
            Root.COLUMN_DOCUMENT_ID,
            Root.COLUMN_TITLE,
            Root.COLUMN_FLAGS,
            Root.COLUMN_ICON,
            Root.COLUMN_MIME_TYPES,
        )
        private val DOCUMENT_PROJECTION = arrayOf(
            Document.COLUMN_DOCUMENT_ID,
            Document.COLUMN_DISPLAY_NAME,
            Document.COLUMN_MIME_TYPE,
            Document.COLUMN_FLAGS,
            Document.COLUMN_SIZE,
            Document.COLUMN_LAST_MODIFIED,
        )

        private fun authority(context: Context): String = "${context.packageName}.documents"
    }
}
