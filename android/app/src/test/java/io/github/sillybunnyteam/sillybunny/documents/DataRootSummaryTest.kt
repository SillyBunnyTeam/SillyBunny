package io.github.sillybunnyteam.sillybunny.documents

import android.content.Context
import android.database.ContentObserver
import android.net.Uri
import android.os.FileObserver
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import android.provider.DocumentsContract.Root
import androidx.test.core.app.ApplicationProvider
import io.github.sillybunnyteam.sillybunny.ClosingFileObserver
import io.github.sillybunnyteam.sillybunny.DataDocumentsProvider
import io.github.sillybunnyteam.sillybunny.R
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode
import java.io.File
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit

/** The Files app root's summary when `config.yaml` sends the server's data away from the `data` folder it shows. */
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
class DataRootSummaryTest {
    private val context: Context get() = ApplicationProvider.getApplicationContext()
    private lateinit var checkout: File
    private lateinit var outside: File
    private lateinit var config: File
    private lateinit var provider: DataDocumentsProvider
    private val links = mutableListOf<Path>()
    private val notice: String get() = context.getString(R.string.documents_data_root_elsewhere)

    @Before
    fun setUp() {
        checkout = File(context.filesDir, "SillyBunny")
        outside = File(context.filesDir, "outside")
        checkout.deleteRecursively()
        outside.deleteRecursively()
        check(File(checkout, "data").mkdirs())
        check(outside.mkdirs())
        config = File(checkout, "config.yaml")
        provider = Robolectric.buildContentProvider(DataDocumentsProvider::class.java).create().get()
    }

    @After
    fun tearDown() {
        PosixTestOs.beforeOpen = null
        // Removed first, so the recursive deletes below never walk through a link.
        links.forEach { Files.deleteIfExists(it) }
        provider.shutdown()
        DocumentsWorkspace.get(context).call { }
        checkout.deleteRecursively()
        outside.deleteRecursively()
    }

    @Test
    fun valuesThatKeepTheDataInTheSharedFolderShowNoSummary() {
        val root = checkout.canonicalPath
        val alias = link(File(context.cacheDir, "files-alias"), context.filesDir.canonicalFile)
        val inside = listOf(
            "port: 8000\n",
            "dataRoot: ./data\n",
            "dataRoot: data\n",
            "dataRoot: \"./data/\"\n",
            "dataRoot: './data'\n",
            "dataRoot: ./data # the default\n",
            "dataRoot: \"./data\"  # quoted\n",
            "\"dataRoot\": ./data\n",
            "dataRoot : ./data   \n",
            "dataRoot: ./data/sub\n",
            "dataRoot: ./other/../data\n",
            "dataRoot: ../SillyBunny/data\n",
            "dataRoot: $root/data\n",
            "dataRoot: $root/data/default-user\n",
            "dataRoot: $alias/SillyBunny/data\n",
            "# dataRoot: ./elsewhere\nport: 8000\n",
            "server:\n  dataRoot: ./elsewhere\n",
        )
        for (text in inside) assertSummary(text, elsewhere = false)
    }

    @Test
    fun valuesThatMoveTheDataElsewhereShowTheSummary() {
        val outsideRoot = outside.canonicalPath
        val elsewhere = listOf(
            "dataRoot: ./elsewhere\n",
            "dataRoot: ../elsewhere\n",
            "dataRoot: ./data/../elsewhere\n",
            "dataRoot: data2\n",
            "dataRoot: .\n",
            "dataRoot: ''\n",
            "dataRoot: /private/elsewhere\n",
            "dataRoot: '/private/elsewhere'\n",
            "dataRoot: $outsideRoot/data\n",
            "dataRoot: ./elsewhere # moved\n",
            "dataRoot: 'it''s here'\n",
            "port: 8000\r\ndataRoot: ./elsewhere\r\n",
            "\uFEFFdataRoot: ./elsewhere\n",
        )
        for (text in elsewhere) assertSummary(text, elsewhere = true)
    }

    @Test
    fun valuesThisReaderCannotBeSureOfShowNoSummary() {
        val unknown = listOf(
            "dataRoot:\n",
            "dataRoot: ~\n",
            "dataRoot: null\n",
            "dataRoot: |\n  elsewhere\n",
            "dataRoot: >\n  elsewhere\n",
            "dataRoot:\n  ./elsewhere\n",
            "dataRoot: ./elsewhere\n  continued\n",
            "dataRoot: ./elsewhere\ndataRoot: ./data\n",
            "dataRoot: &root ./elsewhere\n",
            "dataRoot: *root\n",
            "dataRoot: !!str ./elsewhere\n",
            "dataRoot: [./elsewhere]\n",
            "dataRoot: {path: ./elsewhere}\n",
            "dataRoot: \"./else\\u0077here\"\n",
            "dataRoot: \"./elsewhere\n",
            "dataRoot: './elsewhere\n",
            "dataRoot: key: value\n",
            "dataRoot: ./elsewhere\n" + "#".repeat(65_536),
        )
        for (text in unknown) assertSummary(text, elsewhere = null)
    }

    @Test
    fun aMissingConfigShowsNoSummary() {
        assertEquals(null, DataDocumentsProvider.dataRootElsewhere(context))
        assertNull(summary())
    }

    @Test
    fun aDataFolderThatLinksElsewhereShowsTheSummary() {
        val data = File(checkout, "data")
        check(data.delete())
        link(data, outside)
        assertSummary("dataRoot: ./data\n", elsewhere = true)
    }

    @Test
    fun aLinkedConfigKeepsTheRootAndShowsNoSummary() {
        val target = File(outside, "config.yaml").apply { writeText("dataRoot: ./elsewhere\n") }
        link(config, target)
        provider.queryRoots(arrayOf(Root.COLUMN_ROOT_ID, Root.COLUMN_SUMMARY)).use { cursor ->
            assertEquals(1, cursor.count)
            check(cursor.moveToFirst())
            assertNull(cursor.getString(1))
        }
        assertEquals(null, DataDocumentsProvider.dataRootElsewhere(context))
    }

    @Test
    fun theDefaultProjectionCarriesTheSummary() {
        config.writeText("dataRoot: ./elsewhere\n")
        provider.queryRoots(null).use { cursor ->
            check(cursor.moveToFirst())
            assertEquals(notice, cursor.getString(cursor.getColumnIndexOrThrow(Root.COLUMN_SUMMARY)))
            assertEquals("SillyBunny", cursor.getString(cursor.getColumnIndexOrThrow(Root.COLUMN_TITLE)))
        }
    }

    @Test
    fun configIsReadOnlyWhenTheSummaryIsAskedFor() {
        config.writeText("dataRoot: ./elsewhere\n")
        val opens = CopyOnWriteArrayList<String>()
        PosixTestOs.beforeOpen = { path, _ -> if (path.endsWith("/config.yaml")) opens += path }
        provider.queryRoots(arrayOf(Root.COLUMN_ROOT_ID, Root.COLUMN_TITLE)).use { assertEquals(1, it.count) }
        assertTrue(opens.isEmpty())
        assertEquals(notice, summary())
        assertEquals(1, opens.size)
    }

    @Test
    fun theSharedTreeStaysTheSameWithACustomDataRoot() {
        File(checkout, "data/kept.txt").writeText("kept")
        config.writeText("dataRoot: /private/elsewhere\n")
        assertEquals(notice, summary())
        val root = rootId()
        assertEquals(setOf("data", "config.yaml"), names(root))
        assertEquals(setOf("kept.txt"), names(childId(root, "data")))
    }

    @Test
    fun aConfigWrittenThroughTheProviderUpdatesTheRoots() {
        config.writeText("dataRoot: ./data\n")
        assertNull(summary())
        val id = childId(rootId(), "config.yaml")
        Recorder().use { recorder ->
            write(id, "dataRoot: ./elsewhere\n")
            assertTrue(recorder.await(rootsUri()))
        }
        assertEquals(notice, summary())
    }

    @Test
    fun aConfigChangedByTheServerUpdatesTheRootsAndADataChangeDoesNot() {
        config.writeText("dataRoot: ./data\n")
        val root = rootId()
        assertEquals(setOf("data", "config.yaml"), names(root))
        val observer = requireNotNull(DocumentsWorkspace.get(context).call { observers.observerFor(checkout.canonicalFile) })
        Recorder().use { recorder ->
            // Robolectric has no inotify, so the test delivers the event the kernel reports for the server's save.
            config.writeText("dataRoot: ../elsewhere\n")
            observer.onEvent(FileObserver.CLOSE_WRITE, "config.yaml")
            assertTrue(recorder.await(rootsUri()))
            assertEquals(notice, summary())

            File(checkout, "data/new.txt").writeText("new")
            check(File(checkout, "data").setLastModified(System.currentTimeMillis() + 5_000))
            recorder.clear()
            observer.onEvent(FileObserver.ATTRIB, "data")
            val notified = recorder.settle()
            assertTrue(notified.isNotEmpty())
            assertFalse(rootsUri() in notified)
        }
    }

    private fun link(link: File, target: File): Path =
        Files.createSymbolicLink(link.toPath(), target.toPath()).also { links.add(it) }

    private fun assertSummary(text: String, elsewhere: Boolean?) {
        config.writeText(text)
        val label = text.replace("\n", "\\n").take(80)
        assertEquals(label, elsewhere, DataDocumentsProvider.dataRootElsewhere(context))
        assertEquals(label, if (elsewhere == true) notice else null, summary())
    }

    private fun summary(): String? = provider.queryRoots(arrayOf(Root.COLUMN_SUMMARY)).use { cursor ->
        check(cursor.moveToFirst())
        cursor.getString(0)
    }

    private fun rootId(): String = provider.queryRoots(arrayOf(Root.COLUMN_DOCUMENT_ID)).use { cursor ->
        check(cursor.moveToFirst())
        cursor.getString(0)
    }

    private fun names(parent: String): Set<String> =
        provider.queryChildDocuments(parent, arrayOf(Document.COLUMN_DISPLAY_NAME), sortOrder = null).use { cursor ->
            buildSet { while (cursor.moveToNext()) add(cursor.getString(0)) }
        }

    private fun childId(parent: String, name: String): String = provider.queryChildDocuments(
        parent, arrayOf(Document.COLUMN_DISPLAY_NAME, Document.COLUMN_DOCUMENT_ID), sortOrder = null,
    ).use { cursor ->
        while (cursor.moveToNext()) if (cursor.getString(0) == name) return@use cursor.getString(1)
        error("Missing fixture child: $name")
    }

    private fun write(id: String, value: String) {
        val descriptor = provider.openDocument(id, "wt", null)
        try {
            val callback = ProxyTestStorageManager.callbackFor(descriptor)
            val bytes = value.toByteArray(StandardCharsets.UTF_8)
            assertEquals(bytes.size, callback.onWrite(0, bytes.size, bytes))
            callback.onFsync()
        } finally {
            ProxyTestStorageManager.release(descriptor)
        }
    }

    private fun rootsUri(): Uri = DocumentsContract.buildRootsUri("${context.packageName}.documents")

    private inner class Recorder : AutoCloseable {
        private val uris = CopyOnWriteArrayList<Uri>()
        private val observer = object : ContentObserver(null) {
            override fun onChange(selfChange: Boolean, uri: Uri?) {
                if (uri != null) uris += uri
            }
        }

        init {
            context.contentResolver.registerContentObserver(Uri.parse("content://${context.packageName}.documents"), true, observer)
        }

        fun clear() = uris.clear()

        fun await(expected: Uri): Boolean {
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
            while (System.nanoTime() < deadline && expected !in uris) Thread.sleep(10)
            return expected in uris
        }

        /** Everything recorded once nothing new arrived for half a second. */
        fun settle(): List<Uri> {
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
            var seen = -1
            var since = System.nanoTime()
            while (System.nanoTime() < deadline) {
                if (uris.size != seen) {
                    seen = uris.size
                    since = System.nanoTime()
                } else if (System.nanoTime() - since >= TimeUnit.MILLISECONDS.toNanos(500)) {
                    break
                }
                Thread.sleep(20)
            }
            return uris.toList()
        }

        override fun close() = context.contentResolver.unregisterContentObserver(observer)
    }
}
