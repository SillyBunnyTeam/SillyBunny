package io.github.sillybunnyteam.sillybunny.documents

import android.content.ContentResolver
import android.content.Context
import android.database.ContentObserver
import android.database.Cursor
import android.net.Uri
import android.os.Build
import android.os.CancellationSignal
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.OperationCanceledException
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import android.provider.DocumentsContract.Root
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.github.sillybunnyteam.sillybunny.DataDocumentsProvider
import io.github.sillybunnyteam.sillybunny.R
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileDescriptor
import java.io.FileNotFoundException
import java.nio.file.Files
import java.nio.file.LinkOption
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class DataDocumentsProviderDeviceTest {
    private lateinit var context: Context
    private lateinit var resolver: ContentResolver
    private lateinit var authority: String
    private lateinit var checkout: File
    private var ownsFixture = false
    private var maintenanceActive = false

    @Before
    fun setUp() {
        assertNotEquals(Looper.getMainLooper(), Looper.myLooper())
        context = InstrumentationRegistry.getInstrumentation().targetContext
        resolver = context.contentResolver
        authority = "${context.packageName}.documents"
        checkout = File(context.filesDir, "SillyBunny")
        assertFalse(
            "Run this suite on a dedicated installation without an existing checkout",
            Files.exists(checkout.toPath(), LinkOption.NOFOLLOW_LINKS),
        )
        assertTrue(checkout.mkdir())
        ownsFixture = true
        val data = File(checkout, "data")
        assertTrue(data.mkdir())
        File(data, "seed.txt").writeText("0123456789")
        val nested = File(data, "nested")
        assertTrue(nested.mkdir())
        File(nested, "inside.txt").writeText("nested fixture")
        File(checkout, "config.yaml").writeText("dataRoot: ./data\n")
        File(checkout, "config.yaml.bak").writeText("hidden backup")
        File(checkout, "server.js").writeText("hidden source")
        assertTrue(File(checkout, ".git").mkdir())
        File(checkout, ".git/HEAD").writeText("ref: refs/heads/main\n")
        assertTrue(File(checkout, "data2").mkdir())
        File(checkout, "data2/private.txt").writeText("hidden sibling")
        DataDocumentsProvider.notifyRootsChanged(context)
    }

    @After
    fun tearDown() {
        if (!ownsFixture) return
        try {
            if (maintenanceActive) endMaintenance()
        } finally {
            assertTrue("Could not remove the owned fixture", checkout.deleteRecursively())
            ownsFixture = false
            DataDocumentsProvider.notifyRootsChanged(context)
        }
    }

    @Test
    fun rootsHonorProjectionAndAdvertiseOnlyImplementedCapabilities() {
        val rootsUri = DocumentsContract.buildRootsUri(authority)
        query(rootsUri).use { cursor ->
            assertEquals(1, cursor.count)
            assertTrue(cursor.moveToFirst())
            assertTrue(cursor.string(Root.COLUMN_ROOT_ID).isNotEmpty())
            assertTrue(cursor.string(Root.COLUMN_DOCUMENT_ID).isNotEmpty())
            assertEquals(context.getString(R.string.app_name), cursor.string(Root.COLUMN_TITLE))
            assertTrue(cursor.int(Root.COLUMN_ICON) != 0)
            val flags = cursor.int(Root.COLUMN_FLAGS)
            assertTrue(flags and Root.FLAG_LOCAL_ONLY != 0)
            assertTrue(flags and Root.FLAG_SUPPORTS_CREATE != 0)
            assertTrue(flags and Root.FLAG_SUPPORTS_IS_CHILD != 0)
            assertEquals(0, flags and (Root.FLAG_SUPPORTS_SEARCH or Root.FLAG_SUPPORTS_RECENTS))
            assertEquals(rootsUri, cursor.notificationUri)
        }

        val projection = arrayOf(Root.COLUMN_TITLE, "unknown_root_column", Root.COLUMN_DOCUMENT_ID)
        query(rootsUri, projection).use { cursor ->
            assertEquals(projection.toList(), cursor.columnNames.toList())
            assertEquals(1, cursor.count)
            assertTrue(cursor.moveToFirst())
            assertEquals(context.getString(R.string.app_name), cursor.getString(0))
            assertTrue(cursor.isNull(1))
            assertTrue(cursor.getString(2).isNotEmpty())
        }
    }

    @Test
    fun rootIsHiddenWithoutCheckoutAndListsOnlyExistingAnchors() {
        val root = rootDocument()
        assertEquals(setOf("data", "config.yaml"), children(root).map { it.name }.toSet())

        assertTrue(File(checkout, "config.yaml").delete())
        assertEquals(listOf("data"), children(root).map { it.name })
        assertTrue(File(checkout, "data").deleteRecursively())
        assertTrue(children(root).isEmpty())

        assertTrue(checkout.deleteRecursively())
        DataDocumentsProvider.notifyRootsChanged(context)
        query(DocumentsContract.buildRootsUri(authority)).use { cursor ->
            assertEquals(0, cursor.count)
        }

        assertTrue(checkout.mkdir())
        DataDocumentsProvider.notifyRootsChanged(context)
        assertTrue(children(rootDocument()).isEmpty())
    }

    @Test
    fun documentAndChildQueriesHonorReorderedAndUnknownColumns() {
        val data = child(rootDocument(), "data")
        val seed = child(data, "seed.txt")
        val projection = arrayOf(
            Document.COLUMN_MIME_TYPE,
            "unknown_document_column",
            Document.COLUMN_DISPLAY_NAME,
            Document.COLUMN_DOCUMENT_ID,
        )
        query(seed, projection).use { cursor ->
            assertEquals(projection.toList(), cursor.columnNames.toList())
            assertEquals(1, cursor.count)
            assertTrue(cursor.moveToFirst())
            assertNotEquals(Document.MIME_TYPE_DIR, cursor.getString(0))
            assertTrue(cursor.isNull(1))
            assertEquals("seed.txt", cursor.getString(2))
            assertEquals(DocumentsContract.getDocumentId(seed), cursor.getString(3))
            assertEquals(seed, cursor.notificationUri)
        }

        val childrenUri = DocumentsContract.buildChildDocumentsUri(
            authority,
            DocumentsContract.getDocumentId(data),
        )
        query(childrenUri, projection).use { cursor ->
            assertEquals(projection.toList(), cursor.columnNames.toList())
            val names = mutableSetOf<String>()
            while (cursor.moveToNext()) {
                assertTrue(cursor.isNull(1))
                assertTrue(cursor.getString(3).isNotEmpty())
                names += cursor.getString(2)
            }
            assertEquals(setOf("seed.txt", "nested"), names)
            assertEquals(childrenUri, cursor.notificationUri)
        }
    }

    @Test
    fun childrenAreImmediateAndNeverExposeCheckoutSiblings() {
        val root = rootDocument()
        val data = child(root, "data")
        val config = child(root, "config.yaml")
        assertEquals(Document.MIME_TYPE_DIR, document(root).mimeType)
        assertEquals(Document.MIME_TYPE_DIR, document(data).mimeType)
        assertNotEquals(Document.MIME_TYPE_DIR, document(config).mimeType)
        assertEquals(setOf("data", "config.yaml"), children(root).map { it.name }.toSet())
        assertEquals(setOf("seed.txt", "nested"), children(data).map { it.name }.toSet())
        assertEquals(listOf("inside.txt"), children(child(data, "nested")).map { it.name })
        assertEquals("nested fixture", read(child(child(data, "nested"), "inside.txt")))
    }

    @Test
    fun nestedCreationAndIsChildWorkThroughRootTreeUris() {
        val root = rootTreeDocument()
        val data = child(root, "data")
        val parent = create(data, Document.MIME_TYPE_DIR, "created-parent")
        val nested = create(parent, Document.MIME_TYPE_DIR, "level-two")
        val leaf = create(nested, TEXT_MIME_TYPE, "leaf.txt")
        assertEquals(Document.MIME_TYPE_DIR, document(parent).mimeType)
        assertTrue(document(parent).flags and Document.FLAG_DIR_SUPPORTS_CREATE != 0)
        assertTrue(document(leaf).flags and Document.FLAG_SUPPORTS_WRITE != 0)
        assertEquals(listOf("level-two"), children(parent).map { it.name })
        assertEquals(listOf("leaf.txt"), children(nested).map { it.name })
        assertTrue(DocumentsContract.isChildDocument(resolver, root, leaf))
        assertTrue(DocumentsContract.isChildDocument(resolver, data, leaf))
        assertTrue(DocumentsContract.isChildDocument(resolver, parent, leaf))
        assertTrue(DocumentsContract.isChildDocument(resolver, nested, leaf))
        assertFalse(DocumentsContract.isChildDocument(resolver, data, child(root, "config.yaml")))
        assertFalse(DocumentsContract.isChildDocument(resolver, nested, child(data, "seed.txt")))
        assertFalse(DocumentsContract.isChildDocument(resolver, leaf, parent))
    }

    @Test
    fun filesAndConfigCanBeWrittenAndRead() {
        val root = rootTreeDocument()
        val file = create(child(root, "data"), TEXT_MIME_TYPE, "written.txt")
        write(file, "wt", "written through SAF")
        assertEquals("written through SAF", read(file))
        query(file, arrayOf(Document.COLUMN_SIZE)).use { cursor ->
            assertTrue(cursor.moveToFirst())
            assertEquals(19L, cursor.getLong(0))
        }

        val config = child(root, "config.yaml")
        assertTrue(document(config).flags and Document.FLAG_SUPPORTS_WRITE != 0)
        assertEquals("dataRoot: ./data\n", read(config))
        write(config, "wt", "dataRoot: data\n")
        assertEquals("dataRoot: data\n", read(config))
    }

    @Test
    fun theRootSummaryFollowsTheConfiguredDataRoot() {
        val rootsUri = DocumentsContract.buildRootsUri(authority)
        val notice = context.getString(R.string.documents_data_root_elsewhere)
        fun summary(): String? = query(rootsUri).use { cursor ->
            assertTrue(cursor.moveToFirst())
            cursor.getString(cursor.getColumnIndexOrThrow(Root.COLUMN_SUMMARY))
        }
        assertEquals(null, summary())

        val config = child(rootTreeDocument(), "config.yaml")
        assertNotifies(listOf(rootsUri)) { write(config, "wt", "dataRoot: ../elsewhere\n") }
        assertEquals(notice, summary())

        // A direct server write reaches the roots through the listed root's observer.
        children(rootDocument())
        assertNotifies(listOf(rootsUri)) { File(checkout, "config.yaml").writeText("dataRoot: ./data/default-user\n") }
        assertEquals(null, summary())

        File(checkout, "config.yaml").writeText("dataRoot: /storage/emulated/0/SillyBunny\n")
        assertEquals(notice, summary())
        assertEquals(setOf("data", "config.yaml"), children(rootDocument()).map { it.name }.toSet())
    }

    @Test
    fun wPreservesTheTailButWtTruncatesShorterReplacements() {
        val data = child(rootTreeDocument(), "data")
        val seed = child(data, "seed.txt")
        write(seed, "w", "ab")
        assertEquals("ab23456789", read(seed))
        write(seed, "wt", "xy")
        assertEquals("xy", read(seed))
        assertEquals(DocumentsContract.getDocumentId(seed), document(child(data, "seed.txt")).id)
    }

    @Test
    fun rwIsSeekableAndRwtTruncates() {
        val seed = child(child(rootTreeDocument(), "data"), "seed.txt")
        open(seed, "rw").use { descriptor ->
            assertEquals(4L, Os.lseek(descriptor.fileDescriptor, 4L, OsConstants.SEEK_SET))
            writeFully(descriptor.fileDescriptor, "XY")
            assertEquals(0L, Os.lseek(descriptor.fileDescriptor, 0L, OsConstants.SEEK_SET))
            assertEquals("0123XY6789", readToEnd(descriptor.fileDescriptor))
        }
        assertEquals("0123XY6789", read(seed))

        open(seed, "rwt").use { descriptor ->
            writeFully(descriptor.fileDescriptor, "z")
            assertEquals(0L, Os.lseek(descriptor.fileDescriptor, 0L, OsConstants.SEEK_SET))
            assertEquals("z", readToEnd(descriptor.fileDescriptor))
        }
        assertEquals("z", read(seed))
    }

    @Test
    fun waAppendsEvenAfterSeekingAndAcrossOpens() {
        val seed = child(child(rootTreeDocument(), "data"), "seed.txt")
        open(seed, "wa").use { descriptor ->
            writeFully(descriptor.fileDescriptor, "-first")
            Os.lseek(descriptor.fileDescriptor, 0L, OsConstants.SEEK_SET)
            writeFully(descriptor.fileDescriptor, "-second")
        }
        write(seed, "wa", "-third")
        assertEquals("0123456789-first-second-third", read(seed))
    }

    @Test
    fun requestedModesEnforceDescriptorReadAndWriteAccess() {
        val seed = child(child(rootTreeDocument(), "data"), "seed.txt")
        open(seed, "r").use { descriptor ->
            assertThrows(ErrnoException::class.java) {
                Os.write(descriptor.fileDescriptor, byteArrayOf(1), 0, 1)
            }
        }
        for (mode in listOf("w", "wt", "wa")) {
            open(seed, mode).use { descriptor ->
                assertThrows(ErrnoException::class.java) {
                    Os.read(descriptor.fileDescriptor, ByteArray(1), 0, 1)
                }
            }
        }
    }

    @Test
    fun fileAndDirectoryRenameAndDeleteUpdateParentListings() {
        val data = child(rootTreeDocument(), "data")
        val parent = create(data, Document.MIME_TYPE_DIR, "before-directory")
        val file = create(parent, TEXT_MIME_TYPE, "before.txt")
        val mutationFlags = Document.FLAG_SUPPORTS_RENAME or Document.FLAG_SUPPORTS_DELETE
        assertEquals(mutationFlags, document(parent).flags and mutationFlags)
        assertEquals(mutationFlags, document(file).flags and mutationFlags)
        write(file, "wt", "preserved across renames")

        val renamedFile = checkNotNull(DocumentsContract.renameDocument(resolver, file, "after.txt"))
        assertEquals("after.txt", document(renamedFile).name)
        assertEquals(listOf("after.txt"), children(parent).map { it.name })
        assertEquals("preserved across renames", read(renamedFile))

        val renamedParent = checkNotNull(
            DocumentsContract.renameDocument(resolver, parent, "after-directory"),
        )
        assertEquals("after-directory", document(renamedParent).name)
        assertEquals(
            setOf("seed.txt", "nested", "after-directory"),
            children(data).map { it.name }.toSet(),
        )
        val movedFile = child(renamedParent, "after.txt")
        assertEquals("preserved across renames", read(movedFile))
        assertTrue(DocumentsContract.deleteDocument(resolver, movedFile))
        assertTrue(children(renamedParent).isEmpty())
        assertUnavailable(movedFile)
        assertTrue(DocumentsContract.deleteDocument(resolver, renamedParent))
        assertEquals(setOf("seed.txt", "nested"), children(data).map { it.name }.toSet())
    }

    @Test
    fun sameNameRenameReturnsTheOriginalValidTreeUri() {
        val data = child(rootTreeDocument(), "data")
        val parent = create(data, Document.MIME_TYPE_DIR, "same-name-directory")
        val file = create(parent, TEXT_MIME_TYPE, "same-name.txt")
        write(file, "wt", "same-name content")

        for (uri in listOf(parent, file)) {
            val before = document(uri)
            assertEquals(uri, DocumentsContract.renameDocument(resolver, uri, before.name))
            assertEquals(before, document(uri))
        }
        assertEquals(parent, child(data, "same-name-directory"))
        assertEquals(file, child(parent, "same-name.txt"))
        assertEquals("same-name content", read(file))
        write(file, "wa", " remains writable")
        assertEquals("same-name content remains writable", read(file))
    }

    @Test
    fun deletedFileAndDescendantIdsCannotReachRecreatedContent() {
        val data = child(rootTreeDocument(), "data")
        val parent = create(data, Document.MIME_TYPE_DIR, "recycled-directory")
        val deletedFile = create(parent, TEXT_MIME_TYPE, "recycled.txt")
        write(deletedFile, "wt", "original")
        assertTrue(DocumentsContract.deleteDocument(resolver, deletedFile))
        assertUnavailable(deletedFile)

        val replacement = create(parent, TEXT_MIME_TYPE, "recycled.txt")
        write(replacement, "wt", "replacement")
        assertNotEquals(
            DocumentsContract.getDocumentId(deletedFile),
            DocumentsContract.getDocumentId(replacement),
        )
        assertUnavailable(deletedFile)
        assertEquals("replacement", read(replacement))

        assertTrue(DocumentsContract.deleteDocument(resolver, parent))
        assertUnavailable(parent)
        assertUnavailable(replacement)
        val replacementParent = create(data, Document.MIME_TYPE_DIR, "recycled-directory")
        val replacementChild = create(replacementParent, TEXT_MIME_TYPE, "recycled.txt")
        assertNotEquals(
            DocumentsContract.getDocumentId(parent),
            DocumentsContract.getDocumentId(replacementParent),
        )
        assertNotEquals(
            DocumentsContract.getDocumentId(replacement),
            DocumentsContract.getDocumentId(replacementChild),
        )
        assertUnavailable(parent)
        assertUnavailable(replacement)
    }

    @Test
    fun externalDeleteAndRecreateNeverRecyclesAnIssuedIdAcrossFiftyReplacements() {
        val backingFile = File(checkout, "data/server-recreated.txt")
        backingFile.writeText("original server content")
        val data = child(rootDocument(), "data")
        val original = child(data, backingFile.name)
        assertEquals("original server content", read(original))
        val issuedIds = mutableSetOf(DocumentsContract.getDocumentId(original))
        var previous = original

        repeat(50) { iteration ->
            assertTrue("External delete failed at iteration $iteration", backingFile.delete())
            // No provider call in the deletion gap: identity checks must not depend on observing it.
            val content = "server replacement $iteration"
            backingFile.writeText(content)
            assertUnavailable(original)
            if (previous != original) assertUnavailable(previous)

            val replacement = child(data, backingFile.name)
            assertTrue(
                "Reused an issued document ID at iteration $iteration",
                issuedIds.add(DocumentsContract.getDocumentId(replacement)),
            )
            assertUnavailable(original)
            assertEquals(content, read(replacement))
            previous = replacement
        }
    }

    @Test
    fun externalWritesNotifyRelistedCursorsAfterDirectoryReplacementAndRecreation() {
        val backingDirectory = File(checkout, "data/server-observed")
        assertTrue(backingDirectory.mkdir())
        val backingFile = File(backingDirectory, "observed.txt")
        backingFile.writeText("initial server content")
        val data = child(rootDocument(), "data")

        for (deleteFirst in listOf(false, true)) {
            val previousDirectory = child(data, backingDirectory.name)
            val previousFile = child(previousDirectory, backingFile.name)
            if (deleteFirst) {
                assertTrue(backingDirectory.deleteRecursively())
            } else {
                Files.move(backingDirectory.toPath(), File(checkout, "server-observed-old").toPath())
            }
            assertTrue(backingDirectory.mkdir())
            backingFile.writeText("replacement baseline")

            val directory = child(data, backingDirectory.name)
            assertNotEquals(
                DocumentsContract.getDocumentId(previousDirectory),
                DocumentsContract.getDocumentId(directory),
            )
            val childrenUri = childDocumentsUri(directory)
            query(childrenUri, DOCUMENT_PROJECTION).use { listing ->
                assertEquals(1, listing.count)
                assertTrue(listing.moveToFirst())
                assertEquals(backingFile.name, listing.string(Document.COLUMN_DISPLAY_NAME))
                val file = DocumentsContract.buildDocumentUri(
                    authority,
                    listing.string(Document.COLUMN_DOCUMENT_ID),
                )
                assertNotEquals(
                    DocumentsContract.getDocumentId(previousFile),
                    DocumentsContract.getDocumentId(file),
                )
                query(file, DOCUMENT_PROJECTION).use { metadata ->
                    assertEquals(1, metadata.count)
                    assertTrue(metadata.moveToFirst())
                    val childrenNotificationUri = checkNotNull(listing.notificationUri)
                    val documentNotificationUri = checkNotNull(metadata.notificationUri)
                    assertEquals(childrenUri, childrenNotificationUri)
                    assertEquals(file, documentNotificationUri)
                    val content = if (deleteFirst) {
                        "write after delete and recreate"
                    } else {
                        "write after replacement"
                    }
                    assertNotifies(listOf(childrenNotificationUri, documentNotificationUri)) {
                        backingFile.writeText(content)
                    }
                    assertEquals(content, read(file))
                }
            }
        }
    }

    @Test
    fun hostileIdsAreRefusedForQueriesOpensMutationsAndChildChecks() {
        val root = rootTreeDocument()
        val data = child(root, "data")
        val seed = child(data, "seed.txt")
        val hostileIds = listOf(
            "",
            ".",
            "..",
            "../config.yaml",
            "data/../../config.yaml",
            "./data/seed.txt",
            File(checkout, "data/seed.txt").absolutePath,
            "file://${File(checkout, "config.yaml").absolutePath}",
            "data2/private.txt",
            ".git/HEAD",
            "config.yaml.bak",
            "unknown-document",
            "data/seed.txt\u0000",
            "data/\u001fseed.txt",
            "%2e%2e%2fconfig.yaml",
            "data%2F..%2Fconfig.yaml",
            "x".repeat(4096),
        )
        for ((index, id) in hostileIds.withIndex()) {
            val direct = DocumentsContract.buildDocumentUri(authority, id)
            val tree = DocumentsContract.buildDocumentUriUsingTree(root, id)
            for (uri in listOf(direct, tree)) {
                assertUnavailable(uri)
                expectRefusal("hostile ID $index child query") {
                    resolver.query(childDocumentsUri(uri), DOCUMENT_PROJECTION, null, null, null)
                        .use { it == null || it.count == 0 }
                }
                expectRefusal("hostile ID $index create") {
                    DocumentsContract.createDocument(resolver, uri, TEXT_MIME_TYPE, "forbidden.txt") == null
                }
                expectRefusal("hostile ID $index rename") {
                    DocumentsContract.renameDocument(resolver, uri, "forbidden.txt") == null
                }
                expectRefusal("hostile ID $index delete") {
                    !DocumentsContract.deleteDocument(resolver, uri)
                }
                expectRefusal("hostile ID $index as child") {
                    !DocumentsContract.isChildDocument(resolver, data, uri)
                }
                expectRefusal("hostile ID $index as parent") {
                    !DocumentsContract.isChildDocument(resolver, uri, seed)
                }
            }
        }
        assertEquals("0123456789", read(seed))
        assertEquals(setOf("seed.txt", "nested"), children(data).map { it.name }.toSet())
        assertEquals(setOf("data", "config.yaml"), children(root).map { it.name }.toSet())
    }

    @Test
    fun unsafeDisplayNamesAreRefusedForBothCreateAndRename() {
        val data = child(rootTreeDocument(), "data")
        val seed = child(data, "seed.txt")
        val unsafeNames = listOf(
            "",
            ".",
            "..",
            "sub/name.txt",
            "/absolute.txt",
            "trailing/",
            "nul\u0000name",
            "control\u001fname",
            "delete\u007fname",
            "control\u0085name",
            "line\nname",
            "tab\tname",
            "x".repeat(256),
            "é".repeat(128),
        )
        for ((index, name) in unsafeNames.withIndex()) {
            for (mimeType in listOf(TEXT_MIME_TYPE, Document.MIME_TYPE_DIR)) {
                expectRefusal("unsafe name $index create $mimeType") {
                    DocumentsContract.createDocument(resolver, data, mimeType, name) == null
                }
            }
            expectRefusal("unsafe name $index rename") {
                DocumentsContract.renameDocument(resolver, seed, name) == null
            }
            assertEquals("seed.txt", document(seed).name)
        }
        assertEquals("0123456789", read(seed))
        assertEquals(setOf("seed.txt", "nested"), children(data).map { it.name }.toSet())
    }

    @Test
    fun rootDataAndConfigProtectionsDoNotDependOnCapabilityFlags() {
        val root = rootTreeDocument()
        val data = child(root, "data")
        val config = child(root, "config.yaml")
        val forbidden = Document.FLAG_SUPPORTS_RENAME or Document.FLAG_SUPPORTS_DELETE
        for (uri in listOf(root, data, config)) {
            assertEquals(0, document(uri).flags and forbidden)
            expectRefusal("protected document rename") {
                DocumentsContract.renameDocument(resolver, uri, "forbidden") == null
            }
            expectRefusal("protected document delete") {
                !DocumentsContract.deleteDocument(resolver, uri)
            }
        }
        assertTrue(document(data).flags and Document.FLAG_DIR_SUPPORTS_CREATE != 0)
        for (uri in listOf(root, config)) {
            assertEquals(0, document(uri).flags and Document.FLAG_DIR_SUPPORTS_CREATE)
            for (mimeType in listOf(TEXT_MIME_TYPE, Document.MIME_TYPE_DIR)) {
                expectRefusal("protected parent create") {
                    DocumentsContract.createDocument(resolver, uri, mimeType, "forbidden") == null
                }
            }
        }
        assertEquals(setOf("data", "config.yaml"), children(root).map { it.name }.toSet())
        assertEquals("dataRoot: ./data\n", read(config))
        assertEquals("permitted.txt", document(create(data, TEXT_MIME_TYPE, "permitted.txt")).name)
    }

    @Test
    fun directoriesAndInvalidModesCannotBeOpened() {
        val root = rootTreeDocument()
        val data = child(root, "data")
        val seed = child(data, "seed.txt")
        for (directory in listOf(root, data, child(data, "nested"))) {
            for (mode in OPEN_MODES) {
                expectRefusal("directory open $mode") {
                    resolver.openFileDescriptor(directory, mode).use { it == null }
                }
            }
        }
        // ContentResolver normalizes some read-only spellings (including "rt") to "r" before dispatch.
        // The direct-provider unit suite checks strict mode validation without that platform rewrite.
        for (mode in listOf("", "a", "invalid")) {
            expectRefusal("invalid open mode '$mode'") {
                resolver.openFileDescriptor(seed, mode).use { it == null }
            }
        }
        assertEquals("0123456789", read(seed))
    }

    @Test
    fun alreadyCanceledOpenCannotReturnADescriptorOrTruncateContent() {
        // Signals cancelled before the call. A cancel or maintenance during the proxy open is timed in the unit suite.
        val seed = child(child(rootTreeDocument(), "data"), "seed.txt")
        for (mode in OPEN_MODES) {
            val signal = CancellationSignal().apply { cancel() }
            assertThrows(OperationCanceledException::class.java) {
                resolver.openFileDescriptor(seed, mode, signal)?.use { }
            }
            assertEquals("0123456789", read(seed))
        }
    }

    @Test
    fun maintenanceRefusesQueriesOpensMutationsAndChildChecks() {
        val root = rootDocument()
        val data = child(root, "data")
        val config = child(root, "config.yaml")
        val seed = child(data, "seed.txt")
        beginMaintenance()
        try {
            assertQueryRefused(DocumentsContract.buildRootsUri(authority))
            for (uri in listOf(root, data, config, seed)) assertUnavailable(uri)
            for (uri in listOf(root, data)) assertQueryRefused(childDocumentsUri(uri))
            for (mode in OPEN_MODES) {
                expectRefusal("maintenance open $mode") {
                    resolver.openFileDescriptor(seed, mode).use { it == null }
                }
            }
            for (mimeType in listOf(TEXT_MIME_TYPE, Document.MIME_TYPE_DIR)) {
                expectRefusal("maintenance create") {
                    DocumentsContract.createDocument(resolver, data, mimeType, "forbidden") == null
                }
            }
            expectRefusal("maintenance rename") {
                DocumentsContract.renameDocument(resolver, seed, "forbidden.txt") == null
            }
            expectRefusal("maintenance delete") {
                !DocumentsContract.deleteDocument(resolver, seed)
            }
            expectRefusal("maintenance child check") {
                !DocumentsContract.isChildDocument(resolver, root, seed)
            }
        } finally {
            endMaintenance()
        }
        val freshRoot = rootTreeDocument()
        assertEquals(setOf("data", "config.yaml"), children(freshRoot).map { it.name }.toSet())
        assertEquals("0123456789", read(child(child(freshRoot, "data"), "seed.txt")))
        assertEquals("dataRoot: ./data\n", read(child(freshRoot, "config.yaml")))
    }

    @Test
    fun maintenancePermanentlyRevokesDeliveredWritersAndOldIds() {
        val root = rootTreeDocument()
        val data = child(root, "data")
        val config = child(root, "config.yaml")
        val seed = child(data, "seed.txt")
        val descriptors = mutableMapOf<String, ParcelFileDescriptor>()
        try {
            for (mode in OPEN_MODES) descriptors[mode] = open(seed, mode)
            descriptors["rw-duplicate"] = ParcelFileDescriptor.dup(
                descriptors.getValue("rw").fileDescriptor,
            )
            val before = "before".toByteArray(Charsets.UTF_8)
            assertEquals(
                before.size,
                Os.pwrite(descriptors.getValue("rw").fileDescriptor, before, 0, before.size, 0L),
            )
            val firstByte = ByteArray(1)
            assertEquals(
                1,
                Os.pread(descriptors.getValue("r").fileDescriptor, firstByte, 0, 1, 0L),
            )
            assertEquals('b'.code.toByte(), firstByte[0])
            assertEquals("before", read(seed))

            beginMaintenance()
            assertDescriptorWritesRefused(descriptors)
            assertUnavailable(seed)
            endMaintenance()

            assertDescriptorWritesRefused(descriptors)
            assertEquals("before", File(checkout, "data/seed.txt").readText())
            for (oldUri in listOf(root, data, config, seed)) {
                assertUnavailable(oldUri)
                assertUnavailable(
                    DocumentsContract.buildDocumentUri(authority, DocumentsContract.getDocumentId(oldUri)),
                )
            }
            val freshRoot = rootTreeDocument()
            val freshData = child(freshRoot, "data")
            val freshSeed = child(freshData, "seed.txt")
            assertNotEquals(
                DocumentsContract.getDocumentId(root),
                DocumentsContract.getDocumentId(freshRoot),
            )
            assertNotEquals(
                DocumentsContract.getDocumentId(seed),
                DocumentsContract.getDocumentId(freshSeed),
            )
            assertEquals("before", read(freshSeed))
            write(freshSeed, "rw", "after!")
            assertEquals("after!", read(freshSeed))
            val freshFile = create(freshData, TEXT_MIME_TYPE, "after-maintenance.txt")
            write(freshFile, "wt", "available again")
            assertEquals("available again", read(freshFile))
        } finally {
            try {
                if (maintenanceActive) endMaintenance()
            } finally {
                descriptors.values.forEach { it.close() }
            }
        }
    }

    @Test
    fun maintenanceBeginsAndEndsWithoutACheckout() {
        // Repair can start before any checkout exists, or fail after renaming the old one away.
        assertTrue(checkout.deleteRecursively())
        beginMaintenance()
        assertQueryRefused(DocumentsContract.buildRootsUri(authority))
        endMaintenance()
        query(DocumentsContract.buildRootsUri(authority)).use { cursor -> assertEquals(0, cursor.count) }
        assertTrue(checkout.mkdir())
        assertTrue(File(checkout, "data").mkdir())
        DataDocumentsProvider.notifyRootsChanged(context)
        assertEquals(listOf("data"), children(rootDocument()).map { it.name })
    }

    @Test
    fun readOnlyFilesAreListedReadAndDeletedWithTheirModePreserved() {
        // Git stores objects read-only, and an app UID needs write permission to add a user xattr.
        // Precondition, logged for the report: the kernel refuses that xattr on a 0444 file this UID owns.
        val probe = File(checkout, "dac-probe").apply { writeText("probe") }
        assertTrue(probe.setReadOnly())
        val readOnlyErrno = try {
            Os.setxattr(probe.path, "user.p510.probe", byteArrayOf(1), 0)
            0
        } catch (failure: ErrnoException) {
            failure.errno
        }
        assertTrue(probe.setWritable(true, true))
        Os.setxattr(probe.path, "user.p510.probe", byteArrayOf(1), 0)
        assertTrue(probe.delete())
        Log.i(
            LOG_TAG,
            "sdk=${Build.VERSION.SDK_INT} dac uid=${Os.getuid()} " +
                "mode0444Setxattr=${OsConstants.errnoName(readOnlyErrno) ?: "ok"} mode0644Setxattr=ok",
        )
        assertEquals(OsConstants.EACCES, readOnlyErrno)
        val objects = File(checkout, "data/extension/.git/objects/ab")
        assertTrue(objects.mkdirs())
        val loose = File(objects, "cdef")
        loose.writeText("read-only object")
        assertTrue(loose.setReadOnly())
        val modeBefore = Os.lstat(loose.path).st_mode
        assertEquals(0, modeBefore and OsConstants.S_IWUSR)
        val extension = child(child(rootTreeDocument(), "data"), "extension")
        val looseUri = child(child(child(child(extension, ".git"), "objects"), "ab"), "cdef")
        assertEquals(modeBefore, Os.lstat(loose.path).st_mode)
        assertEquals("read-only object", read(looseUri))
        assertTrue(DocumentsContract.deleteDocument(resolver, extension))
        assertFalse(Files.exists(File(checkout, "data/extension").toPath(), LinkOption.NOFOLLOW_LINKS))
        assertUnavailable(looseUri)
    }

    @Test
    fun proxyStreamingAndRepeatedOpensStaySeekableWithoutDescriptorLeaks() {
        val data = child(rootDocument(), "data")
        val file = create(data, TEXT_MIME_TYPE, "stream.bin")
        val backing = File(checkout, "data/stream.bin")
        val block = ByteArray(65_536) { (it % 251).toByte() }
        fun roundTrip(openDescriptor: (String) -> ParcelFileDescriptor): Long {
            val start = android.os.SystemClock.elapsedRealtimeNanos()
            openDescriptor("wt").use { descriptor ->
                repeat(64) { assertEquals(block.size, Os.write(descriptor.fileDescriptor, block, 0, block.size)) }
                Os.fsync(descriptor.fileDescriptor)
            }
            openDescriptor("r").use { descriptor ->
                val read = ByteArray(block.size)
                repeat(64) {
                    var offset = 0
                    while (offset < read.size) {
                        val size = Os.read(descriptor.fileDescriptor, read, offset, read.size - offset)
                        assertTrue(size > 0)
                        offset += size
                    }
                    org.junit.Assert.assertArrayEquals(block, read)
                }
            }
            return (android.os.SystemClock.elapsedRealtimeNanos() - start) / 1_000_000
        }
        val rawMillis = roundTrip { mode -> ParcelFileDescriptor.open(backing, ParcelFileDescriptor.parseMode(mode)) }
        val proxyMillis = roundTrip { mode -> open(file, mode) }
        val fdCountBefore = File("/proc/self/fd").list()!!.size
        val heapBefore = Runtime.getRuntime().totalMemory() - Runtime.getRuntime().freeMemory()
        val start = android.os.SystemClock.elapsedRealtimeNanos()
        repeat(200) {
            open(file, "r").use { descriptor ->
                assertEquals(4L, Os.lseek(descriptor.fileDescriptor, 4, OsConstants.SEEK_SET))
                assertEquals(1, Os.read(descriptor.fileDescriptor, ByteArray(1), 0, 1))
            }
        }
        val openMillis = (android.os.SystemClock.elapsedRealtimeNanos() - start) / 1_000_000
        System.gc()
        val heapAfter = Runtime.getRuntime().totalMemory() - Runtime.getRuntime().freeMemory()
        val fdCountAfter = File("/proc/self/fd").list()!!.size
        assertTrue("Proxy descriptor leak: $fdCountBefore -> $fdCountAfter", fdCountAfter <= fdCountBefore + 8)
        Log.i(
            LOG_TAG,
            "sdk=${Build.VERSION.SDK_INT} bytes=4194304 rawMs=$rawMillis proxyMs=$proxyMillis " +
                "opens=200 openMs=$openMillis fdBefore=$fdCountBefore fdAfter=$fdCountAfter " +
                "heapDelta=${heapAfter - heapBefore}",
        )
    }

    @Test
    fun neverListedTreesAreRenamedAndDeletedInOneBoundedRound() {
        val tree = File(checkout, "data/bulk")
        repeat(10) { folder ->
            val directory = File(tree, "d$folder")
            assertTrue(directory.mkdirs())
            repeat(100) { File(directory, "f$it.txt").writeText("x") }
        }
        val sample = File(checkout, "data/bulk2/d3/f7.txt")
        val root = rootDocument()
        val data = child(root, "data")
        val bulk = child(data, "bulk")
        val token = tokenOf(bulk)

        var renameMillis = 0L
        val (renamed, renameNotifications) = recordingNotifications(token) {
            val start = SystemClock.elapsedRealtime()
            checkNotNull(DocumentsContract.renameDocument(resolver, bulk, "bulk2")).also {
                renameMillis = SystemClock.elapsedRealtime() - start
            }
        }
        // Only issued IDs are revoked and announced; nothing below the folder is identified. Besides the folder,
        // the parent's document and listing change, and so does the root listing that shows data's modified time.
        assertFalse(hasMarker(sample))
        assertEquals("x", sample.readText())
        assertEquals(setOf(bulk, data, childDocumentsUri(data), childDocumentsUri(root)), renameNotifications.toSet())
        assertEquals(4, renameNotifications.size)
        assertUnavailable(bulk)

        var deleteMillis = 0L
        val (_, deleteNotifications) = recordingNotifications(token) {
            val start = SystemClock.elapsedRealtime()
            assertTrue(DocumentsContract.deleteDocument(resolver, renamed))
            deleteMillis = SystemClock.elapsedRealtime() - start
        }
        assertFalse(Files.exists(File(checkout, "data/bulk2").toPath(), LinkOption.NOFOLLOW_LINKS))
        assertEquals(setOf(renamed, data, childDocumentsUri(data), childDocumentsUri(root)), deleteNotifications.toSet())
        assertEquals(4, deleteNotifications.size)
        assertUnavailable(renamed)
        assertEquals(setOf("seed.txt", "nested"), children(data).map { it.name }.toSet())

        val plain = File(checkout, "plain-tree")
        repeat(10) { folder ->
            val directory = File(plain, "d$folder")
            assertTrue(directory.mkdirs())
            repeat(100) { File(directory, "f$it.txt").writeText("x") }
        }
        val start = SystemClock.elapsedRealtime()
        assertTrue(plain.deleteRecursively())
        val plainMillis = SystemClock.elapsedRealtime() - start
        Log.i(
            LOG_TAG,
            "sdk=${Build.VERSION.SDK_INT} bulk files=1000 renameMs=$renameMillis " +
                "renameNotifications=${renameNotifications.size} deleteMs=$deleteMillis " +
                "deleteNotifications=${deleteNotifications.size} plainDeleteMs=$plainMillis",
        )
    }

    @Test
    fun foldersHoldingSymlinksAndSpecialFilesCanBeRenamedAndDeleted() {
        val folder = File(checkout, "data/linked")
        assertTrue(folder.mkdir())
        File(folder, "readme.txt").writeText("listed")
        Os.symlink(File(checkout, "server.js").path, File(folder, "to-file").path)
        Os.symlink(File(checkout, "data2").path, File(folder, "to-folder").path)
        val fifo = try {
            Os.mkfifo(File(folder, "pipe").path, 0x180)
            true
        } catch (failure: ErrnoException) {
            Log.i(LOG_TAG, "sdk=${Build.VERSION.SDK_INT} mkfifo refused: ${OsConstants.errnoName(failure.errno)}")
            false
        }
        val data = child(rootTreeDocument(), "data")
        val linked = child(data, "linked")
        assertEquals(listOf("readme.txt"), children(linked).map { it.name })

        val renamed = checkNotNull(DocumentsContract.renameDocument(resolver, linked, "linked2"))
        assertTrue(Files.isSymbolicLink(File(checkout, "data/linked2/to-folder").toPath()))
        assertEquals(listOf("readme.txt"), children(renamed).map { it.name })
        assertTrue(DocumentsContract.deleteDocument(resolver, renamed))
        assertFalse(Files.exists(File(checkout, "data/linked2").toPath(), LinkOption.NOFOLLOW_LINKS))
        // Links were unlinked, never followed: their targets outside data/ are untouched.
        assertEquals("hidden source", File(checkout, "server.js").readText())
        assertEquals("hidden sibling", File(checkout, "data2/private.txt").readText())
        Log.i(LOG_TAG, "sdk=${Build.VERSION.SDK_INT} linked-folder fifo=$fifo renamed+deleted")
    }

    @Test
    fun oneServerSaveIntoAListedFolderIsOneBoundedRound() {
        val folder = File(checkout, "data/chats")
        assertTrue(folder.mkdir())
        repeat(500) { File(folder, "chat-$it.jsonl").writeText("{}") }
        val data = child(rootDocument(), "data")
        val chats = child(data, "chats")
        val listing = children(chats)
        assertEquals(500, listing.size)
        val oldChat = DocumentsContract.buildDocumentUri(authority, listing.single { it.name == "chat-0.jsonl" }.id)
        val token = tokenOf(chats)

        var queryMillis = 0L
        var saveStart = 0L
        val (_, notifications) = recordingNotifications(token) {
            saveStart = SystemClock.elapsedRealtime()
            // write-file-atomic, as the server saves a chat: a temp file, written, then renamed over the chat.
            val temp = File(folder, "chat-0.jsonl.4242")
            temp.writeText("{\"saved\":true}")
            Os.rename(temp.path, File(folder, "chat-0.jsonl").path)
            Thread.sleep(100)
            val queryStart = SystemClock.elapsedRealtime()
            document(chats)
            queryMillis = SystemClock.elapsedRealtime() - queryStart
        }
        // The recorder returns one quiet second after the last notification.
        val settledMillis = SystemClock.elapsedRealtime() - saveStart - 1_000
        // The replaced chat, the folder's document and listing, and data's listing (the folder's modified time).
        val expected = setOf(oldChat, chats, childDocumentsUri(chats), childDocumentsUri(data))
        assertTrue("Unexpected notifications: $notifications", expected.containsAll(notifications))
        assertTrue("Missing notifications: $notifications", notifications.containsAll(expected))
        // At most two rounds even if the debounce split the save; never one notification per child.
        assertTrue("Too many notifications: ${notifications.size}", notifications.size <= 8)
        // The replacement stays unidentified until a client lists it, and the old ID no longer resolves.
        assertFalse(hasMarker(File(folder, "chat-0.jsonl")))
        assertUnavailable(oldChat)
        val relisted = children(chats)
        assertEquals(500, relisted.size)
        assertNotEquals(DocumentsContract.getDocumentId(oldChat), relisted.single { it.name == "chat-0.jsonl" }.id)
        Log.i(
            LOG_TAG,
            "sdk=${Build.VERSION.SDK_INT} save children=500 notifications=${notifications.size} " +
                "queryMs=$queryMillis settledMs=$settledMillis",
        )
    }

    @Test
    fun idsCarryOnlyBootStableFields() {
        val seedFile = File(checkout, "data/seed.txt")
        val seed = child(child(rootDocument(), "data"), "seed.txt")
        val parts = DocumentsContract.getDocumentId(seed).split(':')
        val stat = Os.lstat(seedFile.path)
        Log.i(
            LOG_TAG,
            "sdk=${Build.VERSION.SDK_INT} ids dataDev=${stat.st_dev} fields=${parts.size} " +
                "version=${parts[0]} inodeField=${parts.getOrNull(2) == stat.st_ino.toString()}",
        )
        // v2:<root token>:<inode>:<marker>:<path>. The st_dev of /data is a device-mapper minor that can
        // change between boots, so no ID carries it.
        assertEquals(5, parts.size)
        assertEquals(listOf("v2", stat.st_ino.toString()), listOf(parts[0], parts[2]))
        assertEquals("0123456789", read(seed))
    }

    /**
     * Runs [action] with an observer on the whole authority and returns its result with every notification
     * up to one quiet second. Earlier activity settles first, and notifications for IDs under another root
     * token (an earlier test's fixture) are left out.
     */
    private fun <T> recordingNotifications(token: String, action: () -> T): Pair<T, List<Uri>> {
        val thread = HandlerThread("documents-device-recorder").apply { start() }
        val uris = java.util.concurrent.CopyOnWriteArrayList<Uri>()
        val observer = object : ContentObserver(Handler(thread.looper)) {
            override fun onChange(selfChange: Boolean, uri: Uri?) {
                if (uri != null) uris += uri
            }
        }
        resolver.registerContentObserver(Uri.parse("content://$authority"), true, observer)
        try {
            awaitQuiet(uris)
            uris.clear()
            val result = action()
            awaitQuiet(uris)
            return result to uris.filter { uri ->
                val parts = runCatching { DocumentsContract.getDocumentId(uri) }.getOrNull()?.split(':')
                parts == null || parts.size != 5 || parts[1] == token
            }
        } finally {
            resolver.unregisterContentObserver(observer)
            thread.quitSafely()
            thread.join(TimeUnit.SECONDS.toMillis(5))
        }
    }

    private fun awaitQuiet(uris: List<Uri>, quietMillis: Long = 1_000) {
        val deadline = SystemClock.elapsedRealtime() + 20_000
        var seen = -1
        var since = SystemClock.elapsedRealtime()
        while (SystemClock.elapsedRealtime() < deadline) {
            val now = SystemClock.elapsedRealtime()
            if (uris.size != seen) {
                seen = uris.size
                since = now
            } else if (now - since >= quietMillis) {
                return
            }
            Thread.sleep(25)
        }
    }

    private fun tokenOf(document: Uri): String = DocumentsContract.getDocumentId(document).split(':')[1]

    private fun hasMarker(file: File): Boolean = try {
        Os.getxattr(file.path, "user.sillybunny.document-id")
        true
    } catch (failure: ErrnoException) {
        if (failure.errno != OsConstants.ENODATA) throw failure
        false
    }

    private fun query(uri: Uri, projection: Array<String>? = null): Cursor =
        checkNotNull(resolver.query(uri, projection, null, null, null)) {
            "Provider returned no cursor for a valid URI"
        }

    private fun rootDocument(): Uri = query(
        DocumentsContract.buildRootsUri(authority),
        arrayOf(Root.COLUMN_DOCUMENT_ID),
    ).use { cursor ->
        assertEquals(1, cursor.count)
        assertTrue(cursor.moveToFirst())
        DocumentsContract.buildDocumentUri(authority, cursor.getString(0))
    }

    private fun rootTreeDocument(): Uri {
        val id = DocumentsContract.getDocumentId(rootDocument())
        return DocumentsContract.buildDocumentUriUsingTree(
            DocumentsContract.buildTreeDocumentUri(authority, id),
            id,
        )
    }

    private fun childDocumentsUri(parent: Uri): Uri {
        val id = DocumentsContract.getDocumentId(parent)
        return if (DocumentsContract.isTreeUri(parent)) {
            DocumentsContract.buildChildDocumentsUriUsingTree(parent, id)
        } else {
            DocumentsContract.buildChildDocumentsUri(authority, id)
        }
    }

    private fun children(parent: Uri): List<DocumentRow> =
        query(childDocumentsUri(parent), DOCUMENT_PROJECTION).use { cursor ->
            buildList {
                while (cursor.moveToNext()) add(cursor.documentRow())
            }
        }

    private fun child(parent: Uri, name: String): Uri {
        val id = children(parent).single { it.name == name }.id
        return if (DocumentsContract.isTreeUri(parent)) {
            DocumentsContract.buildDocumentUriUsingTree(parent, id)
        } else {
            DocumentsContract.buildDocumentUri(authority, id)
        }
    }

    private fun document(uri: Uri): DocumentRow = query(uri, DOCUMENT_PROJECTION).use { cursor ->
        assertEquals(1, cursor.count)
        assertTrue(cursor.moveToFirst())
        cursor.documentRow()
    }

    private fun create(parent: Uri, mimeType: String, name: String): Uri =
        checkNotNull(DocumentsContract.createDocument(resolver, parent, mimeType, name))

    private fun open(uri: Uri, mode: String): ParcelFileDescriptor =
        checkNotNull(resolver.openFileDescriptor(uri, mode))

    private fun read(uri: Uri): String =
        ParcelFileDescriptor.AutoCloseInputStream(open(uri, "r"))
            .bufferedReader(Charsets.UTF_8).use { it.readText() }

    private fun write(uri: Uri, mode: String, text: String) {
        open(uri, mode).use { descriptor -> writeFully(descriptor.fileDescriptor, text) }
    }

    private fun writeFully(descriptor: FileDescriptor, text: String) {
        val bytes = text.toByteArray(Charsets.UTF_8)
        var offset = 0
        while (offset < bytes.size) {
            val count = Os.write(descriptor, bytes, offset, bytes.size - offset)
            check(count > 0) { "Write made no progress" }
            offset += count
        }
    }

    private fun readToEnd(descriptor: FileDescriptor): String {
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(1024)
        while (true) {
            val count = Os.read(descriptor, buffer, 0, buffer.size)
            if (count == 0) return output.toByteArray().toString(Charsets.UTF_8)
            output.write(buffer, 0, count)
        }
    }

    private fun assertNotifies(notificationUris: List<Uri>, action: () -> Unit) {
        val thread = HandlerThread("documents-device-observers").apply { start() }
        val observers = mutableListOf<ContentObserver>()
        try {
            val handler = Handler(thread.looper)
            val notifications = notificationUris.associateWith { CountDownLatch(1) }
            for ((expectedUri, latch) in notifications) {
                val observer = object : ContentObserver(handler) {
                    override fun onChange(selfChange: Boolean, uri: Uri?) {
                        if (uri == expectedUri) latch.countDown()
                    }
                }
                observers += observer
                resolver.registerContentObserver(expectedUri, false, observer)
            }
            action()
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
            for ((uri, latch) in notifications) {
                val remaining = (deadline - System.nanoTime()).coerceAtLeast(0L)
                assertTrue(
                    "No change notification for $uri after a direct server write",
                    latch.await(remaining, TimeUnit.NANOSECONDS),
                )
            }
        } finally {
            try {
                observers.forEach { resolver.unregisterContentObserver(it) }
            } finally {
                thread.quitSafely()
                thread.join(TimeUnit.SECONDS.toMillis(5))
                assertFalse("Notification handler did not stop", thread.isAlive)
            }
        }
    }

    private fun assertUnavailable(uri: Uri) {
        assertQueryRefused(uri)
        expectRefusal("unavailable document open") {
            resolver.openFileDescriptor(uri, "r").use { it == null }
        }
    }

    private fun assertQueryRefused(uri: Uri) {
        expectRefusal("unavailable query") {
            resolver.query(uri, null, null, null, null).use { it == null || it.count == 0 }
        }
    }

    private fun expectRefusal(label: String, operation: () -> Boolean) {
        val refused = try {
            operation()
        } catch (error: Exception) {
            when (error) {
                is FileNotFoundException,
                is IllegalArgumentException,
                is SecurityException,
                is UnsupportedOperationException -> true
                else -> throw error
            }
        }
        assertTrue("$label unexpectedly succeeded", refused)
    }

    private fun assertDescriptorWritesRefused(descriptors: Map<String, ParcelFileDescriptor>) {
        // AppFuse can serve cached reads after the fence; backing writes must still fail.
        for ((mode, descriptor) in descriptors) {
            if (mode.contains('w')) {
                assertThrows("$mode descriptor remained writable", ErrnoException::class.java) {
                    Os.pwrite(descriptor.fileDescriptor, byteArrayOf(1), 0, 1, 0L)
                }
            }
        }
    }

    private fun beginMaintenance() {
        maintenanceActive = true
        DataDocumentsProvider.beginMaintenance(context)
    }

    private fun endMaintenance() {
        DataDocumentsProvider.endMaintenance(context)
        maintenanceActive = false
    }

    private fun Cursor.string(column: String): String = getString(getColumnIndexOrThrow(column))

    private fun Cursor.int(column: String): Int = getInt(getColumnIndexOrThrow(column))

    private fun Cursor.documentRow(): DocumentRow = DocumentRow(
        id = string(Document.COLUMN_DOCUMENT_ID),
        name = string(Document.COLUMN_DISPLAY_NAME),
        mimeType = string(Document.COLUMN_MIME_TYPE),
        flags = int(Document.COLUMN_FLAGS),
    )

    private data class DocumentRow(
        val id: String,
        val name: String,
        val mimeType: String,
        val flags: Int,
    )

    companion object {
        private const val LOG_TAG = "P510Documents"
        private const val TEXT_MIME_TYPE = "text/plain"
        private val OPEN_MODES = listOf("r", "w", "wt", "wa", "rw", "rwt")
        private val DOCUMENT_PROJECTION = arrayOf(
            Document.COLUMN_DOCUMENT_ID,
            Document.COLUMN_DISPLAY_NAME,
            Document.COLUMN_MIME_TYPE,
            Document.COLUMN_FLAGS,
        )
    }
}
