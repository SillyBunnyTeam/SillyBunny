package io.github.sillybunnyteam.sillybunny.documents

import android.content.Context
import android.database.ContentObserver
import android.net.Uri
import android.provider.DocumentsContract
import android.os.CancellationSignal
import android.os.FileObserver
import android.os.OperationCanceledException
import android.os.ParcelFileDescriptor
import android.os.Handler
import android.os.HandlerThread
import android.provider.DocumentsContract.Document
import android.provider.DocumentsContract.Root
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import android.util.Log
import androidx.test.core.app.ApplicationProvider
import io.github.sillybunnyteam.sillybunny.ClosingFileObserver
import io.github.sillybunnyteam.sillybunny.DataDocumentsProvider
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.assertThrows
import org.junit.Assert.assertFalse
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.LooperMode
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowLog
import java.io.File
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.StandardCopyOption
import java.nio.file.attribute.UserDefinedFileAttributeView
import java.nio.charset.StandardCharsets
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit

@RunWith(RobolectricTestRunner::class)
@Config(
    sdk = [29],
    shadows = [
        PosixTestOs::class,
        ProxyTestStorageManager::class,
        PosixTestParcelFileDescriptor::class,
        ClosingFileObserver::class,
    ],
)
@LooperMode(LooperMode.Mode.PAUSED)
class DataDocumentsProviderTest {
    private lateinit var checkout: File
    private lateinit var provider: DataDocumentsProvider

    @Before
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        checkout = File(context.filesDir, "SillyBunny")
        checkout.deleteRecursively()
        provider = Robolectric.buildContentProvider(DataDocumentsProvider::class.java).create().get()
    }

    @After
    fun tearDown() {
        provider.shutdown()
        val context = ApplicationProvider.getApplicationContext<Context>()
        DocumentsWorkspace.get(context).call { }
        checkout.deleteRecursively()
    }

    @Test
    fun rootAppearsOnlyAfterCheckoutExistsAndHonorsProjection() {
        val projection = arrayOf(Root.COLUMN_TITLE, Root.COLUMN_DOCUMENT_ID)
        provider.queryRoots(projection).use { cursor ->
            assertEquals(0, cursor.count)
            assertEquals(projection.toList(), cursor.columnNames.toList())
        }
        check(checkout.mkdir())
        provider.queryRoots(projection).use { cursor ->
            assertEquals(1, cursor.count)
            check(cursor.moveToFirst())
            assertEquals("SillyBunny", cursor.getString(0))
        }
    }

    @Test
    fun syntheticRootListsOnlyExistingDataAndConfig() {
        check(File(checkout, "data").mkdirs())
        File(checkout, "config.yaml").writeText("port: 4444")
        File(checkout, "server.js").writeText("hidden")
        File(checkout, ".git").mkdir()
        val root = rootId()
        provider.queryChildDocuments(root, null, sortOrder = null).use { cursor ->
            val names = mutableSetOf<String>()
            val nameColumn = cursor.getColumnIndexOrThrow(Document.COLUMN_DISPLAY_NAME)
            while (cursor.moveToNext()) names += cursor.getString(nameColumn)
            assertEquals(setOf("data", "config.yaml"), names)
        }
        File(checkout, "config.yaml").delete()
        provider.queryChildDocuments(root, arrayOf(Document.COLUMN_DISPLAY_NAME), sortOrder = null).use { cursor ->
            assertEquals(1, cursor.count)
            check(cursor.moveToFirst())
            assertEquals("data", cursor.getString(0))
        }
    }

    @Test
    fun rootAndChildQueriesRejectUnknownAndHostileIds() {
        check(File(checkout, "data").mkdirs())
        rootId()
        listOf("", "missing", "/data", "../data", "root/../config.yaml", "data2", "data\u0000").forEach { id ->
            assertThrows(java.io.FileNotFoundException::class.java) { provider.queryDocument(id, null) }
            assertThrows(java.io.FileNotFoundException::class.java) {
                provider.queryChildDocuments(id, null, sortOrder = null)
            }
        }
        provider.queryDocument(rootId(), arrayOf(Document.COLUMN_MIME_TYPE)).use { cursor ->
            assertTrue(cursor.moveToFirst())
            assertEquals(Document.MIME_TYPE_DIR, cursor.getString(0))
        }
    }

    @Test
    fun createRenameDeleteAndAllDepthChildChecks() {
        check(File(checkout, "data").mkdirs())
        val root = rootId()
        val data = childId(root, "data")
        val directory = provider.createDocument(data, Document.MIME_TYPE_DIR, "nested")
        val child = provider.createDocument(directory, "text/plain", "entry.txt")
        assertTrue(provider.isChildDocument(root, child))
        assertTrue(provider.isChildDocument(data, child))
        assertTrue(provider.isChildDocument(directory, child))
        assertFalse(provider.isChildDocument(child, directory))
        assertFalse(provider.isChildDocument(child, child))
        val renamed = requireNotNull(provider.renameDocument(child, "renamed.txt"))
        assertEquals(renamed, childId(directory, "renamed.txt"))
        assertThrows(java.io.FileNotFoundException::class.java) { provider.queryDocument(child, null) }
        provider.deleteDocument(directory)
        assertThrows(java.io.FileNotFoundException::class.java) { provider.queryDocument(renamed, null) }
        assertThrows(java.io.FileNotFoundException::class.java) { provider.queryDocument(directory, null) }
    }

    @Test
    fun anchorsRejectMutationsRegardlessOfFlags() {
        check(File(checkout, "data").mkdirs())
        File(checkout, "config.yaml").writeText("port: 4444")
        val root = rootId()
        val data = childId(root, "data")
        val config = childId(root, "config.yaml")
        listOf(root, data, config).forEach { id ->
            assertThrows(java.io.FileNotFoundException::class.java) { provider.renameDocument(id, "renamed") }
            assertThrows(java.io.FileNotFoundException::class.java) { provider.deleteDocument(id) }
        }
        listOf(root, config).forEach { id ->
            assertThrows(java.io.FileNotFoundException::class.java) {
                provider.createDocument(id, "text/plain", "sibling")
            }
        }
        assertTrue(File(checkout, "data").isDirectory)
        assertEquals("port: 4444", File(checkout, "config.yaml").readText())
    }

    @Test
    fun unchangedRenameKeepsTheSameGrantAndDocument() {
        check(File(checkout, "data").mkdirs())
        val id = provider.createDocument(childId(rootId(), "data"), "text/plain", "same.txt")
        write(id, "wt", "preserved")
        assertEquals(null, provider.renameDocument(id, "same.txt"))
        assertEquals("preserved", read(id))
    }

    @Test
    fun deletingUppercaseDirectoryDoesNotRevokeLowercaseSibling() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val revoked = CopyOnWriteArrayList<Uri>()
        provider.shutdown()
        provider = DataDocumentsProvider().apply {
            attachInfo(object : android.content.ContextWrapper(context) {
                override fun revokeUriPermission(uri: Uri, modeFlags: Int) {
                    revoked += uri
                    super.revokeUriPermission(uri, modeFlags)
                }
            }, requireNotNull(context.packageManager.resolveContentProvider("${context.packageName}.documents", 0)))
        }
        check(File(checkout, "data").mkdirs())
        val data = childId(rootId(), "data")
        val upper = provider.createDocument(data, Document.MIME_TYPE_DIR, "A")
        val lower = provider.createDocument(data, Document.MIME_TYPE_DIR, "a")
        val upperFile = provider.createDocument(upper, "text/plain", "entry.txt")
        val lowerFile = provider.createDocument(lower, "text/plain", "entry.txt")
        provider.deleteDocument(upper)
        val authority = "${context.packageName}.documents"
        assertTrue(revoked.contains(DocumentsContract.buildDocumentUri(authority, upperFile)))
        assertFalse(revoked.contains(DocumentsContract.buildDocumentUri(authority, lowerFile)))
        assertFalse(revoked.contains(DocumentsContract.buildTreeDocumentUri(authority, lowerFile)))
        write(lowerFile, "wt", "still granted")
        assertEquals("still granted", read(lowerFile))
    }

    @Test
    fun relistingReplacedDirectoryRevokesTheOldDirectoryAndDescendants() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val revoked = CopyOnWriteArrayList<Uri>()
        provider.shutdown()
        provider = DataDocumentsProvider().apply {
            attachInfo(object : android.content.ContextWrapper(context) {
                override fun revokeUriPermission(uri: Uri, modeFlags: Int) {
                    revoked += uri
                    super.revokeUriPermission(uri, modeFlags)
                }
            }, requireNotNull(context.packageManager.resolveContentProvider("${context.packageName}.documents", 0)))
        }
        check(File(checkout, "data").mkdirs())
        val data = childId(rootId(), "data")
        val oldDirectory = provider.createDocument(data, Document.MIME_TYPE_DIR, "replace")
        val oldFile = provider.createDocument(oldDirectory, "text/plain", "entry.txt")
        provider.queryChildDocuments(oldDirectory, null, sortOrder = null).close()
        check(File(checkout, "data/replace").renameTo(File(checkout, "retired")))
        check(File(checkout, "data/replace").mkdir())
        File(checkout, "data/replace/entry.txt").writeText("new")
        val replacement = childId(data, "replace")
        val replacementFile = childId(replacement, "entry.txt")
        val authority = "${context.packageName}.documents"
        assertTrue(revoked.contains(DocumentsContract.buildDocumentUri(authority, oldDirectory)))
        assertTrue(revoked.contains(DocumentsContract.buildDocumentUri(authority, oldFile)))
        assertFalse(revoked.contains(DocumentsContract.buildDocumentUri(authority, replacement)))
        assertEquals("new", read(replacementFile))
    }

    @Test
    fun creationAndRenameRejectEveryUnsafeName() {
        check(File(checkout, "data").mkdirs())
        val data = childId(rootId(), "data")
        val file = provider.createDocument(data, "text/plain", "safe.txt")
        val names = listOf("", ".", "..", "/absolute", "a/b", "a\\b", "null\u0000", "\n", "a\u007f", "é".repeat(128))
        names.forEach { name ->
            assertThrows(java.io.FileNotFoundException::class.java) { provider.createDocument(data, "text/plain", name) }
            assertThrows(java.io.FileNotFoundException::class.java) { provider.renameDocument(file, name) }
        }
        assertEquals(file, childId(data, "safe.txt"))
    }

    @Test
    fun leafAndIntermediateSymlinksStayHiddenAndCannotUseAnOldId() {
        val dataDirectory = File(checkout, "data").apply { mkdirs() }
        val outside = File(checkout, "private").apply { mkdir() }
        val root = rootId()
        File(outside, "secret.txt").writeText("hidden")
        val data = childId(root, "data")
        val leaf = File(dataDirectory, "leaf.txt").apply { writeText("safe") }
        val nested = File(dataDirectory, "nested").apply { mkdir() }
        File(nested, "secret.txt").writeText("safe")
        val leafId = childId(data, "leaf.txt")
        val nestedId = childId(data, "nested")
        val nestedFileId = childId(nestedId, "secret.txt")
        check(leaf.delete())
        Files.createSymbolicLink(leaf.toPath(), File(outside, "secret.txt").toPath())
        check(nested.deleteRecursively())
        Files.createSymbolicLink(nested.toPath(), outside.toPath())
        provider.queryChildDocuments(data, null, sortOrder = null).use { assertEquals(0, it.count) }
        listOf(leafId, nestedId, nestedFileId).forEach { id ->
            assertThrows(java.io.FileNotFoundException::class.java) { provider.queryDocument(id, null) }
            assertThrows(java.io.FileNotFoundException::class.java) { provider.deleteDocument(id) }
            assertThrows(java.io.FileNotFoundException::class.java) { provider.renameDocument(id, "escape") }
            assertThrows(java.io.FileNotFoundException::class.java) { provider.isChildDocument(root, id) }
        }
        assertEquals("hidden", File(outside, "secret.txt").readText())
        assertTrue(Files.isSymbolicLink(leaf.toPath()))
        assertTrue(Files.exists(outside.toPath(), LinkOption.NOFOLLOW_LINKS))
    }

    @Test
    fun specialFilesAreNeitherListedNorOpened() {
        val dataDirectory = File(checkout, "data").apply { mkdirs() }
        val fifo = File(dataDirectory, "pipe")
        fifo.writeText("regular before replacement")
        val data = childId(rootId(), "data")
        val oldId = childId(data, "pipe")
        check(fifo.delete())
        val process = ProcessBuilder("mkfifo", fifo.absolutePath).start()
        assertEquals(0, process.waitFor())
        val socket = File(dataDirectory, "socket")
        val socketProcess = ProcessBuilder(
            "python3", "-c", "import socket,sys;s=socket.socket(socket.AF_UNIX);s.bind(sys.argv[1])", socket.name,
        ).directory(dataDirectory).redirectErrorStream(true).start()
        val socketOutput = socketProcess.inputStream.bufferedReader().use { it.readText() }
        assertEquals(socketOutput, 0, socketProcess.waitFor())
        provider.queryChildDocuments(data, null, sortOrder = null).use { assertEquals(0, it.count) }
        assertThrows(java.io.FileNotFoundException::class.java) { provider.openDocument(oldId, "rw", null) }
        assertThrows(java.io.FileNotFoundException::class.java) { provider.deleteDocument(oldId) }
        assertThrows(java.io.FileNotFoundException::class.java) {
            provider.createDocument(data, "text/plain", "pipe")
        }
    }

    @Test
    fun fileIdentityRoundTripsWithoutRecyclingAfterExternalReplacement() {
        check(File(checkout, "data").mkdirs())
        val file = File(checkout, "data/document.txt").apply { writeText("first") }
        val data = childId(rootId(), "data")
        val first = childId(data, "document.txt")
        provider.queryDocument(first, arrayOf(Document.COLUMN_DOCUMENT_ID)).use { cursor ->
            check(cursor.moveToFirst())
            assertEquals(first, cursor.getString(0))
        }
        repeat(50) { count ->
            check(file.delete())
            file.writeText("replacement $count")
        }
        val replacement = childId(data, "document.txt")
        assertFalse(first == replacement)
        assertThrows(java.io.FileNotFoundException::class.java) { provider.queryDocument(first, null) }
        val anotherProvider = Robolectric.buildContentProvider(DataDocumentsProvider::class.java).create().get()
        anotherProvider.queryDocument(replacement, arrayOf(Document.COLUMN_DOCUMENT_ID)).use { cursor ->
            check(cursor.moveToFirst())
            assertEquals(replacement, cursor.getString(0))
        }
        anotherProvider.shutdown()
        DocumentsWorkspace.get(ApplicationProvider.getApplicationContext()).call { }
    }

    @Test
    fun markerChangedBetweenResolveAndOpenIsRejectedBeforeTruncating() {
        check(File(checkout, "data").mkdirs())
        val file = File(checkout, "data/raced.txt").apply { writeText("preserved") }
        val id = childId(childId(rootId(), "data"), "raced.txt")
        PosixTestOs.beforeOpen = { path, flags ->
            if (path == file.path && flags and android.system.OsConstants.O_NOFOLLOW != 0) {
                java.nio.file.Files.getFileAttributeView(
                    file.toPath(), java.nio.file.attribute.UserDefinedFileAttributeView::class.java,
                ).write("sillybunny.document-id", java.nio.ByteBuffer.wrap(java.util.UUID.randomUUID().toString().toByteArray()))
            }
        }
        try {
            assertThrows(java.io.FileNotFoundException::class.java) { provider.openDocument(id, "wt", null) }
        } finally {
            PosixTestOs.beforeOpen = null
        }
        assertEquals("preserved", file.readText())
    }

    @Test
    fun syntheticRootIdentityDoesNotSurviveCheckoutReplacement() {
        check(File(checkout, "data").mkdirs())
        val oldRoot = rootId()
        check(checkout.renameTo(File(checkout.parentFile, "SillyBunny.retired")))
        check(checkout.mkdir())
        check(File(checkout, "data").mkdir())
        assertThrows(java.io.FileNotFoundException::class.java) { provider.queryDocument(oldRoot, null) }
        assertFalse(oldRoot == rootId())
        File(checkout.parentFile, "SillyBunny.retired").deleteRecursively()
    }

    @Test
    fun writeModesHaveDeliberateTruncationAppendAndSeekSemantics() {
        check(File(checkout, "data").mkdirs())
        val data = childId(rootId(), "data")
        val id = provider.createDocument(data, "text/plain", "modes.txt")
        write(id, "wt", "abcdef")
        write(id, "w", "xy")
        assertEquals("xycdef", read(id))
        write(id, "wt", "q")
        assertEquals("q", read(id))
        write(id, "wa", "rs")
        assertEquals("qrs", read(id))
        provider.openDocument(id, "rw", null).use { descriptor ->
            val callback = ProxyTestStorageManager.callbackFor(descriptor)
            assertEquals(1, callback.onWrite(1, 1, byteArrayOf('Z'.code.toByte())))
            callback.onRelease()
        }
        assertEquals("qZs", read(id))
        write(id, "rwt", "t")
        assertEquals("t", read(id))
    }

    @Test
    fun cancelledAndInvalidOpensDoNotModifyFiles() {
        check(File(checkout, "data").mkdirs())
        val data = childId(rootId(), "data")
        val id = provider.createDocument(data, "text/plain", "cancel.txt")
        write(id, "wt", "preserved")
        val signal = CancellationSignal().apply { cancel() }
        assertThrows(OperationCanceledException::class.java) { provider.openDocument(id, "wt", signal) }
        listOf("", "rt", "bad", "a", "wr", "rwa").forEach { mode ->
            assertThrows(java.io.FileNotFoundException::class.java) { provider.openDocument(id, mode, null) }
        }
        assertThrows(java.io.FileNotFoundException::class.java) { provider.openDocument(data, "r", null) }
        assertEquals("preserved", read(id))
    }

    @Test
    fun deleteRevokesIssuedDescendantUrisAndNotifiesParents() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val revoked = CopyOnWriteArrayList<Uri>()
        val grantContext = object : android.content.ContextWrapper(context) {
            override fun revokeUriPermission(uri: Uri, modeFlags: Int) {
                revoked += uri
                super.revokeUriPermission(uri, modeFlags)
            }
        }
        provider.shutdown()
        provider = DataDocumentsProvider().also {
            it.attachInfo(grantContext, requireNotNull(context.packageManager.resolveContentProvider("${context.packageName}.documents", 0)))
        }
        check(File(checkout, "data").mkdirs())
        val data = childId(rootId(), "data")
        val directory = provider.createDocument(data, Document.MIME_TYPE_DIR, "delete-me")
        val file = provider.createDocument(directory, "text/plain", "entry.txt")
        val authority = "${context.packageName}.documents"
        val fileUri = DocumentsContract.buildDocumentUri(authority, file)
        val directoryUri = DocumentsContract.buildDocumentUri(authority, directory)
        val notifications = CopyOnWriteArrayList<Uri>()
        val handlerThread = HandlerThread("documents-test-observer").apply { start() }
        val observer = object : ContentObserver(Handler(handlerThread.looper)) {
            override fun onChange(selfChange: Boolean, uri: Uri?) {
                if (uri != null) notifications += uri
            }
        }
        context.contentResolver.registerContentObserver(Uri.parse("content://$authority"), true, observer)
        provider.deleteDocument(directory)
        try {
            val parentUri = DocumentsContract.buildChildDocumentsUri(authority, data)
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
            while (System.nanoTime() < deadline && (!notifications.contains(fileUri) || !notifications.contains(parentUri))) {
                Thread.sleep(10)
            }
            assertTrue(notifications.contains(fileUri))
            assertTrue(notifications.contains(parentUri))
        } finally {
            context.contentResolver.unregisterContentObserver(observer)
            handlerThread.quitSafely()
        }
        assertTrue(revoked.contains(fileUri))
        assertTrue(revoked.contains(directoryUri))
        assertTrue(revoked.contains(DocumentsContract.buildTreeDocumentUri(authority, file)))
        assertTrue(revoked.contains(DocumentsContract.buildTreeDocumentUri(authority, directory)))
    }

    @Test
    fun maintenanceBlocksAllOperationsAndInvalidatesIdsAfterRecovery() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        check(File(checkout, "data").mkdirs())
        val root = rootId()
        val data = childId(root, "data")
        val file = provider.createDocument(data, "text/plain", "repair.txt")
        DataDocumentsProvider.beginMaintenance(context)
        try {
            assertThrows(java.io.FileNotFoundException::class.java) { provider.queryRoots(null) }
            assertThrows(java.io.FileNotFoundException::class.java) { provider.queryDocument(file, null) }
            assertThrows(java.io.FileNotFoundException::class.java) {
                provider.queryChildDocuments(data, null, sortOrder = null)
            }
            assertThrows(java.io.FileNotFoundException::class.java) { provider.openDocument(file, "r", null) }
            assertThrows(java.io.FileNotFoundException::class.java) { provider.createDocument(data, "text/plain", "blocked") }
            assertThrows(java.io.FileNotFoundException::class.java) { provider.renameDocument(file, "blocked") }
            assertThrows(java.io.FileNotFoundException::class.java) { provider.deleteDocument(file) }
            assertThrows(java.io.FileNotFoundException::class.java) { provider.isChildDocument(root, file) }
        } finally {
            DataDocumentsProvider.endMaintenance(context)
        }
        assertFalse(root == rootId())
        listOf(root, data, file).forEach { id ->
            assertThrows(java.io.FileNotFoundException::class.java) { provider.queryDocument(id, null) }
        }
        assertTrue(childId(childId(rootId(), "data"), "repair.txt").isNotEmpty())
    }

    @Test
    fun unicodeNamesAndEmptyProjectionsRoundTrip() {
        check(File(checkout, "data").mkdirs())
        val root = rootId()
        val data = childId(root, "data")
        val id = provider.createDocument(data, "text/plain", "保存🐇.txt")
        assertEquals(id, childId(data, "保存🐇.txt"))
        provider.queryDocument(id, emptyArray()).use { cursor ->
            assertEquals(1, cursor.count)
            assertEquals(0, cursor.columnCount)
        }
        provider.queryChildDocuments(data, arrayOf("unknown", Document.COLUMN_DISPLAY_NAME), sortOrder = null).use { cursor ->
            assertTrue(cursor.moveToFirst())
            assertTrue(cursor.isNull(0))
            assertEquals("保存🐇.txt", cursor.getString(1))
        }
        provider.queryRoots(emptyArray()).use { cursor ->
            assertEquals(1, cursor.count)
            assertEquals(0, cursor.columnCount)
        }
    }

    @Test
    fun forgedEncodedPathsAreRejectedByEveryOperation() {
        check(File(checkout, "data").mkdirs())
        val root = rootId()
        val data = childId(root, "data")
        val file = provider.createDocument(data, "text/plain", "safe.txt")
        val paths = listOf("../config.yaml", "/data/safe.txt", "data/../config.yaml", "data//safe.txt", "data/./safe.txt", "data2/a", ".git/HEAD", "data/a\u0000", "data/${"a".repeat(256)}")
        paths.forEach { path ->
            val id = file.substringBeforeLast(':') + ":" + java.util.Base64.getUrlEncoder().withoutPadding()
                .encodeToString(path.toByteArray(Charsets.UTF_8))
            assertThrows(java.io.FileNotFoundException::class.java) { provider.queryDocument(id, null) }
            assertThrows(java.io.FileNotFoundException::class.java) { provider.queryChildDocuments(id, null, sortOrder = null) }
            assertThrows(java.io.FileNotFoundException::class.java) { provider.createDocument(id, "text/plain", "new") }
            assertThrows(java.io.FileNotFoundException::class.java) { provider.renameDocument(id, "new") }
            assertThrows(java.io.FileNotFoundException::class.java) { provider.deleteDocument(id) }
            assertThrows(java.io.FileNotFoundException::class.java) { provider.isChildDocument(data, id) }
            assertThrows(java.io.FileNotFoundException::class.java) { provider.openDocument(id, "r", null) }
        }
        assertEquals(file, childId(data, "safe.txt"))
    }

    @Test
    fun concurrentCreatesHaveUniqueIdsAndDoNotOverwrite() {
        check(File(checkout, "data").mkdirs())
        val data = childId(rootId(), "data")
        val pool = java.util.concurrent.Executors.newFixedThreadPool(4)
        try {
            val ids = pool.invokeAll((1..20).map { index ->
                java.util.concurrent.Callable { provider.createDocument(data, "text/plain", "item-$index") }
            }).map { it.get(10, TimeUnit.SECONDS) }
            assertEquals(20, ids.toSet().size)
            provider.queryChildDocuments(data, null, sortOrder = null).use { assertEquals(20, it.count) }
            assertThrows(java.io.FileNotFoundException::class.java) { provider.createDocument(data, "text/plain", "item-1") }
        } finally {
            pool.shutdownNow()
        }
    }

    @Test
    fun deliveredWritableLeaseStopsAcrossMaintenanceAndNeverReactivates() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        check(File(checkout, "data").mkdirs())
        val file = provider.createDocument(childId(rootId(), "data"), "text/plain", "writer.txt")
        val descriptor = provider.openDocument(file, "rw", null)
        val callback = ProxyTestStorageManager.callbackFor(descriptor)
        assertEquals(4, callback.onWrite(0, 4, "safe".toByteArray()))
        DataDocumentsProvider.beginMaintenance(context)
        try {
            assertThrows(android.system.ErrnoException::class.java) { callback.onWrite(0, 4, "bad!".toByteArray()) }
        } finally {
            DataDocumentsProvider.endMaintenance(context)
        }
        try {
            assertThrows(android.system.ErrnoException::class.java) { callback.onWrite(0, 4, "bad!".toByteArray()) }
            val fresh = childId(childId(rootId(), "data"), "writer.txt")
            assertEquals("safe", read(fresh))
        } finally {
            ProxyTestStorageManager.release(descriptor)
        }
    }

    @Test
    fun writableLeasesCloseAndAnnounceThemselvesEvenAfterTheCheckoutMoved() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val workspace = DocumentsWorkspace.get(context)
        check(File(checkout, "data").mkdirs())
        val data = childId(rootId(), "data")
        val id = provider.createDocument(data, "text/plain", "moving.txt")
        val retired = File(checkout.parentFile, "SillyBunny.retired")
        NotificationRecorder(context).use { recorder ->
            // Repair: beginMaintenance closes the delivered writer while the checkout still exists, and says so.
            val fenced = provider.openDocument(id, "rw", null)
            assertEquals(4, ProxyTestStorageManager.callbackFor(fenced).onWrite(0, 4, "safe".toByteArray()))
            recorder.clear()
            DataDocumentsProvider.beginMaintenance(context)
            assertTrue(recorder.awaitAll(documentUri(id), childrenUri(data)))
            check(checkout.renameTo(retired))
            try {
                // The client's own close only arrives after Repair moved the checkout away.
                ProxyTestStorageManager.release(fenced)
                workspace.call { }
            } finally {
                check(retired.renameTo(checkout))
                DataDocumentsProvider.endMaintenance(context)
            }

            // Without maintenance, a writer whose checkout vanished still closes and announces the write.
            val freshData = childId(rootId(), "data")
            val fresh = childId(freshData, "moving.txt")
            val writer = provider.openDocument(fresh, "rw", null)
            assertEquals(4, ProxyTestStorageManager.callbackFor(writer).onWrite(0, 4, "more".toByteArray()))
            recorder.clear()
            check(checkout.renameTo(retired))
            try {
                ProxyTestStorageManager.release(writer)
                workspace.call { }
                assertTrue(recorder.awaitAll(documentUri(fresh), childrenUri(freshData)))
            } finally {
                check(retired.renameTo(checkout))
            }
            assertEquals("more", read(fresh))
        }
        // No background failure was logged on the way (an escaped one would end the app process).
        assertEquals(emptyList<ShadowLog.LogItem>(), ShadowLog.getLogsForTag(DOCUMENTS_TAG))
    }

    @Test
    fun cancelSignalEndsWithOpenAndDoesNotCancelDeliveredLease() {
        check(File(checkout, "data").mkdirs())
        val id = provider.createDocument(childId(rootId(), "data"), "text/plain", "cancel-after-open.txt")
        val signal = CancellationSignal()
        val descriptor = provider.openDocument(id, "rw", signal)
        val callback = ProxyTestStorageManager.callbackFor(descriptor)
        signal.cancel()
        try {
            assertEquals(4, callback.onWrite(0, 4, "safe".toByteArray()))
            assertEquals("safe", read(id))
        } finally {
            ProxyTestStorageManager.release(descriptor)
        }
    }

    @Test
    fun customDataRootDetectionNeverChangesTheExposedTree() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        check(File(checkout, "data").mkdirs())
        val config = File(checkout, "config.yaml")
        config.writeText("dataRoot: ./data\n")
        assertEquals(false, DataDocumentsProvider.usesCustomDataRoot(context))
        config.writeText("dataRoot: '/private/elsewhere'\n")
        assertEquals(true, DataDocumentsProvider.usesCustomDataRoot(context))
        assertTrue(childId(rootId(), "data").isNotEmpty())
        config.writeText("dataRoot: |\n  elsewhere\n")
        assertEquals(null, DataDocumentsProvider.usesCustomDataRoot(context))
    }

    @Test
    fun maintenanceBeginsAndEndsWithoutACheckout() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        // Repair can start before any checkout exists, or fail after renaming the old one away.
        DataDocumentsProvider.beginMaintenance(context)
        assertThrows(java.io.FileNotFoundException::class.java) { provider.queryRoots(null) }
        DataDocumentsProvider.endMaintenance(context)
        provider.queryRoots(null).use { assertEquals(0, it.count) }
        check(File(checkout, "data").mkdirs())
        val oldRoot = rootId()
        val oldData = childId(oldRoot, "data")
        val retired = File(checkout.parentFile, "SillyBunny.retired")
        DataDocumentsProvider.beginMaintenance(context)
        check(checkout.renameTo(retired))
        try {
            DataDocumentsProvider.endMaintenance(context)
            provider.queryRoots(null).use { assertEquals(0, it.count) }
            check(File(checkout, "data").mkdirs())
            assertFalse(oldRoot == rootId())
            assertThrows(java.io.FileNotFoundException::class.java) { provider.queryDocument(oldData, null) }
            assertTrue(childId(rootId(), "data").isNotEmpty())
        } finally {
            retired.deleteRecursively()
        }
    }

    @Test
    fun readOnlyEntriesAreListedReadAndDeletedWithTheirModesPreserved() {
        // Git stores objects read-only; an app UID cannot add a user xattr without write permission.
        val objects = File(checkout, "data/extension/.git/objects/ab").apply { check(mkdirs()) }
        val loose = File(objects, "cdef").apply { writeText("read-only object") }
        check(loose.setWritable(false, false))
        val modeBefore = Files.getPosixFilePermissions(loose.toPath())
        val extension = childId(childId(rootId(), "data"), "extension")
        val looseId = childId(childId(childId(childId(extension, ".git"), "objects"), "ab"), "cdef")
        assertEquals(modeBefore, Files.getPosixFilePermissions(loose.toPath()))
        assertEquals("read-only object", read(looseId))
        provider.deleteDocument(extension)
        assertFalse(Files.exists(File(checkout, "data/extension").toPath(), LinkOption.NOFOLLOW_LINKS))
        assertThrows(java.io.FileNotFoundException::class.java) { provider.queryDocument(looseId, null) }
    }

    @Test
    fun childrenWithoutAnIdentityAreOmittedWithoutFailingTheListing() {
        val dataDirectory = File(checkout, "data").apply { check(mkdirs()) }
        File(dataDirectory, "visible.txt").writeText("visible")
        val unreadable = File(dataDirectory, "unreadable.txt").apply { writeText("hidden") }
        Files.setPosixFilePermissions(unreadable.toPath(), emptySet())
        try {
            val data = childId(rootId(), "data")
            provider.queryChildDocuments(data, arrayOf(Document.COLUMN_DISPLAY_NAME), sortOrder = null).use { cursor ->
                val names = buildList { while (cursor.moveToNext()) add(cursor.getString(0)) }
                assertEquals(listOf("visible.txt"), names)
            }
        } finally {
            check(unreadable.setReadable(true, true) && unreadable.setWritable(true, true))
        }
    }

    @Test
    fun idsCarryNoDeviceNumberAndSurviveABootThatMovesData() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        check(File(checkout, "data/kept").mkdirs())
        val note = File(checkout, "data/kept/note.txt").apply { writeText("kept") }
        val root = rootId()
        val data = childId(root, "data")
        val kept = childId(data, "kept")
        val noteId = childId(kept, "note.txt")
        val parts = noteId.split(':')
        assertEquals(listOf("v2", Os.lstat(note.path).st_ino.toString()), listOf(parts[0], parts[2]))
        assertEquals(5, parts.size)
        // A later boot maps /data on another device-mapper minor (an OTA or a changed partition set):
        // every st_dev differs, while inodes and markers persist.
        provider.shutdown()
        DocumentsWorkspace.get(context).call { }
        PosixTestOs.deviceOffset = 7
        try {
            provider = Robolectric.buildContentProvider(DataDocumentsProvider::class.java).create().get()
            assertEquals(Os.lstat(note.path).st_dev, Files.getAttribute(note.toPath(), "unix:dev") as Long + 7)
            assertEquals(root, rootId())
            listOf(data, kept, noteId).forEach { id ->
                provider.queryDocument(id, arrayOf(Document.COLUMN_DOCUMENT_ID)).use { cursor ->
                    assertTrue(cursor.moveToFirst())
                    assertEquals(id, cursor.getString(0))
                }
            }
            assertEquals(noteId, childId(kept, "note.txt"))
            assertTrue(provider.isChildDocument(data, noteId))
            assertEquals("kept", read(noteId))
            write(noteId, "wt", "rewritten")
            assertEquals("rewritten", read(noteId))
        } finally {
            PosixTestOs.deviceOffset = 0
        }
    }

    @Test
    fun renamingAFolderNeverWalksMarksOrRecordsItsDescendants() {
        val revoked = recordRevocations()
        val deep = File(checkout, "data/ext/a/b").apply { check(mkdirs()) }
        val files = (1..20).map { File(deep, "f$it.txt").apply { writeText("x") } }
        val readOnly = files.first().also { check(it.setWritable(false, false)) }
        val data = childId(rootId(), "data")
        val ext = childId(data, "ext")
        val listedChild = childId(ext, "a")
        val ctimeBefore = Files.getAttribute(readOnly.toPath(), "unix:ctime")
        val renamed = requireNotNull(provider.renameDocument(ext, "ext2"))
        val moved = File(checkout, "data/ext2/a/b")
        assertEquals(0, files.count { marked(File(moved, it.name)) })
        assertEquals(ctimeBefore, Files.getAttribute(File(moved, readOnly.name).toPath(), "unix:ctime"))
        // The ledger holds what was handed out (data, then ext2), never the size of the subtree.
        assertEquals(setOf(data, renamed), issuedLike(data))
        assertTrue(revoked.contains(DocumentsContract.buildDocumentUri(AUTHORITY, listedChild)))
        assertTrue(revoked.contains(DocumentsContract.buildTreeDocumentUri(AUTHORITY, listedChild)))
        listOf(ext, listedChild).forEach { id ->
            assertThrows(java.io.FileNotFoundException::class.java) { provider.queryDocument(id, null) }
        }
        assertEquals(renamed, childId(data, "ext2"))
        assertEquals("x", read(childId(childId(childId(renamed, "a"), "b"), "f2.txt")))
    }

    @Test
    fun foldersWithSymlinksAndSpecialFilesCanBeRenamedAndDeletedWithoutTouchingTargets() {
        val outside = File(checkout, "private").apply { check(mkdirs()) }
        val secret = File(outside, "secret.txt").apply { writeText("secret") }
        val folder = File(checkout, "data/ext").apply { check(mkdirs()) }
        File(folder, "readme.txt").writeText("x")
        Files.createSymbolicLink(File(folder, "to-folder").toPath(), outside.toPath())
        Files.createSymbolicLink(File(folder, "to-file").toPath(), secret.toPath())
        assertEquals(0, ProcessBuilder("mkfifo", File(folder, "pipe").path).start().waitFor())
        val data = childId(rootId(), "data")
        val ext = childId(data, "ext")
        val renamed = requireNotNull(provider.renameDocument(ext, "ext2"))
        assertTrue(Files.isSymbolicLink(File(checkout, "data/ext2/to-folder").toPath()))
        provider.deleteDocument(renamed)
        assertFalse(Files.exists(File(checkout, "data/ext2").toPath(), LinkOption.NOFOLLOW_LINKS))
        assertEquals("secret", secret.readText())
        assertEquals(listOf("secret.txt"), outside.list()?.toList())
        assertThrows(java.io.FileNotFoundException::class.java) { provider.queryDocument(renamed, null) }
    }

    @Test
    fun bulkRenameAndDeleteNotifyOnlyIssuedIdsTheParentAndItsListing() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        repeat(5) { folder ->
            val directory = File(checkout, "data/bulk/d$folder").apply { check(mkdirs()) }
            repeat(40) { File(directory, "f$it.txt").writeText("x") }
        }
        val root = rootId()
        val data = childId(root, "data")
        val bulk = childId(data, "bulk")
        NotificationRecorder(context).use { recorder ->
            recorder.clear()
            val renamed = requireNotNull(provider.renameDocument(bulk, "bulk2"))
            val afterRename = recorder.settle()
            // The folder's issued ID, the parent's document and listing, and the root listing that shows data's
            // modified time. Nothing for the 200 files below, and nothing for the roots.
            assertEquals(setOf(documentUri(bulk), documentUri(data), childrenUri(data), childrenUri(root)), afterRename.toSet())
            assertEquals(4, afterRename.size)
            recorder.clear()
            provider.deleteDocument(renamed)
            val afterDelete = recorder.settle()
            assertEquals(setOf(documentUri(renamed), documentUri(data), childrenUri(data), childrenUri(root)), afterDelete.toSet())
            assertEquals(4, afterDelete.size)
        }
        assertFalse(File(checkout, "data/bulk2").exists())
        assertEquals(setOf(data), issuedLike(data))
    }

    @Test
    fun nameChangesAlsoNotifyTheListingThatShowsTheParentsModifiedTime() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        check(File(checkout, "data/notes").mkdirs())
        val data = childId(rootId(), "data")
        val notes = childId(data, "notes")
        NotificationRecorder(context).use { recorder ->
            recorder.clear()
            val created = provider.createDocument(notes, "text/plain", "draft.txt")
            assertEquals(setOf(documentUri(notes), childrenUri(notes), childrenUri(data)), recorder.settle().toSet())
            recorder.clear()
            val renamed = requireNotNull(provider.renameDocument(created, "final.txt"))
            assertEquals(
                setOf(documentUri(created), documentUri(notes), childrenUri(notes), childrenUri(data)),
                recorder.settle().toSet(),
            )
            recorder.clear()
            provider.deleteDocument(renamed)
            assertEquals(
                setOf(documentUri(renamed), documentUri(notes), childrenUri(notes), childrenUri(data)),
                recorder.settle().toSet(),
            )
        }
    }

    @Test
    fun aPartialDeleteAnnouncesEveryListingThatLostRows() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val sub = File(checkout, "data/tree/sub").apply { check(mkdirs()) }
        File(sub, "a.txt").writeText("a")
        File(sub, "b.txt").writeText("b")
        val data = childId(rootId(), "data")
        val tree = childId(data, "tree")
        val subId = childId(tree, "sub")
        val a = childId(subId, "a.txt")
        val b = childId(subId, "b.txt")
        // Injected failure: the emptied folder refuses to go, so the delete stops after removing its files.
        PosixTestOs.beforeRemove = { path ->
            if (path == sub.path && sub.list().isNullOrEmpty()) throw ErrnoException("remove", OsConstants.EACCES)
        }
        try {
            NotificationRecorder(context).use { recorder ->
                recorder.clear()
                assertThrows(java.io.FileNotFoundException::class.java) { provider.deleteDocument(tree) }
                // The files that are gone, both folders that remain with their listings, and the parent.
                assertEquals(
                    setOf(
                        documentUri(a), documentUri(b), documentUri(tree), childrenUri(tree), documentUri(subId),
                        childrenUri(subId), documentUri(data), childrenUri(data),
                    ),
                    recorder.settle().toSet(),
                )
            }
        } finally {
            PosixTestOs.beforeRemove = null
        }
        assertEquals(emptyList<String>(), sub.list()?.toList())
        assertEquals(setOf(data, tree, subId), issuedLike(data))
        assertThrows(java.io.FileNotFoundException::class.java) { provider.queryDocument(a, null) }
        provider.queryDocument(subId, null).use { assertEquals(1, it.count) }
    }

    @Test
    fun oneServerSaveIntoAListedFolderIsOneQuietRound() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val revoked = recordRevocations()
        val folder = File(checkout, "data/chats").apply { check(mkdirs()) }
        repeat(50) { File(folder, "chat-$it.jsonl").writeText("{}") }
        val data = childId(rootId(), "data")
        val chats = childId(data, "chats")
        val oldChat = childId(chats, "chat-0.jsonl")
        val observer = requireNotNull(DocumentsWorkspace.get(context).call { observers.observerFor(folder) })
        val issuedBefore = issuedLike(data)
        NotificationRecorder(context).use { recorder ->
            // write-file-atomic: a temp file, written, then renamed over the chat. Robolectric has no
            // inotify, so the test delivers the events the kernel reports for that save.
            val temp = File(folder, "chat-0.jsonl.4242").apply { writeText("{\"saved\":true}") }
            Files.move(temp.toPath(), File(folder, "chat-0.jsonl").toPath(), StandardCopyOption.REPLACE_EXISTING)
            listOf(
                FileObserver.CREATE to temp.name,
                FileObserver.CLOSE_WRITE to temp.name,
                FileObserver.MOVED_FROM to temp.name,
                FileObserver.MOVED_TO to "chat-0.jsonl",
            ).forEach { (event, name) -> observer.onEvent(event, name) }
            val notified = recorder.settle()
            // The replaced chat, the folder's document and listing, and data's listing (the folder's modified time).
            assertEquals(
                listOf(documentUri(oldChat), documentUri(chats), childrenUri(chats), childrenUri(data)).sorted(),
                notified.sorted(),
            )
            assertTrue(revoked.contains(DocumentsContract.buildDocumentUri(AUTHORITY, oldChat)))
            // Nothing was identified for the 50 children: no new ledger rows, and the new chat is unmarked.
            assertEquals(issuedBefore - oldChat, issuedLike(data))
            assertFalse(marked(File(folder, "chat-0.jsonl")))
            assertThrows(java.io.FileNotFoundException::class.java) { provider.queryDocument(oldChat, null) }

            // Content written in place reaches the listing and that document, in one round for a burst of events.
            val chat = childId(chats, "chat-1.jsonl")
            File(folder, "chat-1.jsonl").appendText("{\"more\":true}\n")
            recorder.clear()
            repeat(20) { observer.onEvent(FileObserver.CLOSE_WRITE, "chat-1.jsonl") }
            assertEquals(listOf(documentUri(chat), childrenUri(chats)).sorted(), recorder.settle().sorted())

            // A relisting marks the replacement chat; that marking, and other no-op attribute events, are dropped.
            val newChat = childId(chats, "chat-0.jsonl")
            assertTrue(marked(File(folder, "chat-0.jsonl")) && newChat != oldChat)
            recorder.clear()
            observer.onEvent(FileObserver.ATTRIB, "chat-0.jsonl")
            observer.onEvent(FileObserver.ATTRIB, "chat-2.jsonl")
            assertEquals(emptyList<Uri>(), recorder.settle())
        }
    }

    @Test
    fun aCancelDuringTheProxyOpenFailsTheOpenWithTheContentIntact() {
        check(File(checkout, "data").mkdirs())
        val file = File(checkout, "data/keep.txt").apply { writeText("precious") }
        val id = childId(childId(rootId(), "data"), "keep.txt")
        val signal = CancellationSignal()
        ProxyTestStorageManager.duringOpen = { callback ->
            // Until the commit, the pending truncation is only reported; the file still holds its content.
            assertEquals(0L, callback.onGetSize())
            assertEquals("precious", file.readText())
            signal.cancel()
        }
        try {
            assertThrows(OperationCanceledException::class.java) { provider.openDocument(id, "wt", signal) }
        } finally {
            ProxyTestStorageManager.duringOpen = null
        }
        assertEquals("precious", file.readText())
        assertEquals("precious", read(id))
    }

    @Test
    fun maintenanceDuringTheProxyOpenFailsTheOpenWithTheContentIntact() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        check(File(checkout, "data").mkdirs())
        val file = File(checkout, "data/keep.txt").apply { writeText("precious") }
        val id = childId(childId(rootId(), "data"), "keep.txt")
        ProxyTestStorageManager.duringOpen = { DataDocumentsProvider.beginMaintenance(context) }
        try {
            assertThrows(java.io.FileNotFoundException::class.java) { provider.openDocument(id, "rwt", null) }
        } finally {
            ProxyTestStorageManager.duringOpen = null
            DataDocumentsProvider.endMaintenance(context)
        }
        assertEquals("precious", file.readText())
    }

    @Test
    fun failedBackgroundWorkIsLoggedAndTheWorkerKeepsServing() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val workspace = DocumentsWorkspace.get(context)
        workspace.post { throw IllegalStateException("posted") }
        workspace.schedule(1) { throw android.system.ErrnoException("close", android.system.OsConstants.EIO) }
        Thread.sleep(200)
        workspace.call { }
        val failures = ShadowLog.getLogsForTag(DOCUMENTS_TAG).filter { it.type == Log.WARN && it.throwable != null }
        assertEquals(listOf("IllegalStateException", "ErrnoException"), failures.map { it.throwable.javaClass.simpleName })
        check(File(checkout, "data").mkdirs())
        assertTrue(childId(rootId(), "data").isNotEmpty())
    }

    @Test
    fun leafSwappedForAFileCarryingACopiedMarkerIsRejectedBeforeTruncating() {
        check(File(checkout, "data").mkdirs())
        val file = File(checkout, "data/raced.txt").apply { writeText("original") }
        val id = childId(childId(rootId(), "data"), "raced.txt")
        val original = File(checkout, "data/raced.original")
        PosixTestOs.beforeOpen = { path, flags ->
            if (path == file.path && flags and android.system.OsConstants.O_NOFOLLOW != 0 && !original.exists()) {
                // Same name, mode and marker; only the inode differs from what the walk saw.
                check(file.renameTo(original))
                file.writeText("impostor")
                copyMarker(original, file)
            }
        }
        try {
            assertThrows(java.io.FileNotFoundException::class.java) { provider.openDocument(id, "wt", null) }
        } finally {
            PosixTestOs.beforeOpen = null
        }
        assertEquals("original", original.readText())
        assertEquals("impostor", file.readText())
    }

    @Test
    fun intermediateFolderSwappedForASymlinkIsRejectedBeforeTruncating() {
        val nested = File(checkout, "data/nested").apply { check(mkdirs()) }
        val file = File(nested, "inside.txt").apply { writeText("original") }
        val outside = File(checkout, "private").apply { check(mkdirs()) }
        val id = childId(childId(childId(rootId(), "data"), "nested"), "inside.txt")
        // A hard link outside data/ shares the inode, mode and marker; only the opened path differs.
        Files.createLink(File(outside, "inside.txt").toPath(), file.toPath())
        val retired = File(checkout, "data/nested.retired")
        PosixTestOs.beforeOpen = { path, flags ->
            if (path == file.path && flags and android.system.OsConstants.O_NOFOLLOW != 0 && !retired.exists()) {
                check(nested.renameTo(retired))
                Files.createSymbolicLink(nested.toPath(), outside.toPath())
            }
        }
        try {
            assertThrows(java.io.FileNotFoundException::class.java) { provider.openDocument(id, "wt", null) }
        } finally {
            PosixTestOs.beforeOpen = null
        }
        assertEquals("original", File(retired, "inside.txt").readText())
    }

    private class NotificationRecorder(context: Context) : AutoCloseable {
        private val resolver = context.contentResolver
        private val uris = CopyOnWriteArrayList<Uri>()
        private val observer = object : ContentObserver(null) {
            override fun onChange(selfChange: Boolean, uri: Uri?) {
                if (uri != null) uris += uri
            }
        }

        init {
            resolver.registerContentObserver(Uri.parse("content://$AUTHORITY"), true, observer)
        }

        fun clear() = uris.clear()

        /** Everything recorded once nothing new arrived for [quietMillis]. */
        fun settle(quietMillis: Long = 600): List<Uri> {
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
            var seen = -1
            var since = System.nanoTime()
            while (System.nanoTime() < deadline) {
                if (uris.size != seen) {
                    seen = uris.size
                    since = System.nanoTime()
                } else if (System.nanoTime() - since >= TimeUnit.MILLISECONDS.toNanos(quietMillis)) {
                    break
                }
                Thread.sleep(20)
            }
            return uris.toList()
        }

        fun awaitAll(vararg expected: Uri): Boolean {
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
            while (System.nanoTime() < deadline && !uris.containsAll(expected.toList())) Thread.sleep(10)
            return uris.containsAll(expected.toList())
        }

        override fun close() = resolver.unregisterContentObserver(observer)
    }

    private fun recordRevocations(): CopyOnWriteArrayList<Uri> {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val revoked = CopyOnWriteArrayList<Uri>()
        provider.shutdown()
        DocumentsWorkspace.get(context).call { }
        provider = DataDocumentsProvider().apply {
            attachInfo(object : android.content.ContextWrapper(context) {
                override fun revokeUriPermission(uri: Uri, modeFlags: Int) {
                    revoked += uri
                    super.revokeUriPermission(uri, modeFlags)
                }
            }, requireNotNull(context.packageManager.resolveContentProvider(AUTHORITY, 0)))
        }
        return revoked
    }

    /** The IDs in the ledger that belong to the same checkout and generation as [sample]. */
    private fun issuedLike(sample: String): Set<String> {
        val token = sample.split(':')[1]
        return DocumentsWorkspace.get(ApplicationProvider.getApplicationContext<Context>())
            .call { ids.issuedUnder(null) }
            .filter { it.split(':').getOrNull(1) == token }
            .toSet()
    }

    private fun marked(file: File): Boolean = MARKER in
        Files.getFileAttributeView(file.toPath(), UserDefinedFileAttributeView::class.java).list()

    private fun copyMarker(from: File, to: File) {
        val source = Files.getFileAttributeView(from.toPath(), UserDefinedFileAttributeView::class.java)
        val value = java.nio.ByteBuffer.allocate(source.size(MARKER))
        source.read(MARKER, value)
        value.flip()
        Files.getFileAttributeView(to.toPath(), UserDefinedFileAttributeView::class.java).write(MARKER, value)
    }

    private fun documentUri(id: String): Uri = DocumentsContract.buildDocumentUri(AUTHORITY, id)

    private fun childrenUri(id: String): Uri = DocumentsContract.buildChildDocumentsUri(AUTHORITY, id)

    private fun write(id: String, mode: String, value: String) {
        val descriptor = provider.openDocument(id, mode, null)
        try {
            val callback = ProxyTestStorageManager.callbackFor(descriptor)
            val bytes = value.toByteArray(StandardCharsets.UTF_8)
            assertEquals(bytes.size, callback.onWrite(0, bytes.size, bytes))
            callback.onFsync()
        } finally {
            ProxyTestStorageManager.release(descriptor)
        }
    }

    private fun read(id: String): String {
        val descriptor = provider.openDocument(id, "r", null)
        return try {
            val callback = ProxyTestStorageManager.callbackFor(descriptor)
            val bytes = ByteArray(callback.onGetSize().toInt())
            assertEquals(bytes.size, callback.onRead(0, bytes.size, bytes))
            assertEquals(0, callback.onRead(bytes.size.toLong(), 1, ByteArray(1)))
            String(bytes, StandardCharsets.UTF_8)
        } finally {
            ProxyTestStorageManager.release(descriptor)
        }
    }

    private fun childId(parent: String, name: String): String = provider.queryChildDocuments(
        parent, arrayOf(Document.COLUMN_DISPLAY_NAME, Document.COLUMN_DOCUMENT_ID), sortOrder = null,
    ).use { cursor ->
        while (cursor.moveToNext()) if (cursor.getString(0) == name) return@use cursor.getString(1)
        error("Missing fixture child: $name")
    }

    private fun rootId(): String = provider.queryRoots(arrayOf(Root.COLUMN_DOCUMENT_ID)).use { cursor ->
        check(cursor.moveToFirst())
        cursor.getString(0)
    }

    private companion object {
        const val DOCUMENTS_TAG = "SillyBunnyDocuments"
        const val MARKER = "sillybunny.document-id"
        val AUTHORITY = "${ApplicationProvider.getApplicationContext<Context>().packageName}.documents"
    }
}
