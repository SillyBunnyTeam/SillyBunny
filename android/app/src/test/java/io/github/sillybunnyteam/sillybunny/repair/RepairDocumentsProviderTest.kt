package io.github.sillybunnyteam.sillybunny.repair

import android.content.Context
import android.provider.DocumentsContract.Document
import android.provider.DocumentsContract.Root
import android.system.ErrnoException
import androidx.test.core.app.ApplicationProvider
import io.github.sillybunnyteam.sillybunny.ClosingFileObserver
import io.github.sillybunnyteam.sillybunny.DataDocumentsProvider
import io.github.sillybunnyteam.sillybunny.checkout.BrokenCheckouts
import io.github.sillybunnyteam.sillybunny.documents.DocumentsWorkspace
import io.github.sillybunnyteam.sillybunny.documents.PosixTestOs
import io.github.sillybunnyteam.sillybunny.documents.PosixTestParcelFileDescriptor
import io.github.sillybunnyteam.sillybunny.documents.ProxyTestStorageManager
import io.github.sillybunnyteam.sillybunny.runtime.RuntimePaths
import io.github.sillybunnyteam.sillybunny.server.ServerHost
import kotlinx.coroutines.Dispatchers
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode
import java.io.File
import java.io.FileNotFoundException

/**
 * Repair against the real DocumentsProvider through [DocumentsProviderMaintenance] (plan §4.7 "External writers",
 * §4.8): a writable descriptor delivered before Repair never writes again, neither into the moved-aside folder nor
 * into the new checkout, and every document ID from before Repair stops resolving. Uses the provider suite's
 * POSIX and proxy-descriptor shadows, and the file-observer shadow that returns each inotify instance it opens.
 */
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
class RepairDocumentsProviderTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val host = FakeRepairServerHost()
    private lateinit var paths: RuntimePaths
    private lateinit var store: RepairStore
    private lateinit var provider: DataDocumentsProvider

    private val chatPath = "data/default-user/chats/chat.jsonl"
    private val fence get() = File(context.noBackupFilesDir, "documents-maintenance")

    @Before
    fun setUp() {
        paths = RuntimePaths(context.filesDir, context.cacheDir, File(context.filesDir, "lib"))
        paths.checkoutDir.deleteRecursively()
        TestCheckouts.create(paths.checkoutDir, config = "dataRoot: ./data\n", tracking = "release")
        store = RepairStore(File(context.noBackupFilesDir, "p59-repair-record.json"))
        provider = Robolectric.buildContentProvider(DataDocumentsProvider::class.java).create().get()
    }

    @After
    fun tearDown() {
        try {
            DataDocumentsProvider.endMaintenance(context)
        } finally {
            provider.shutdown()
            DocumentsWorkspace.get(context).call { }
            paths.checkoutDir.deleteRecursively()
            BrokenCheckouts.list(paths).forEach { it.deleteRecursively() }
        }
    }

    private fun controller(serverHost: ServerHost = host) = RepairController(
        context = context,
        paths = paths,
        serverHost = serverHost,
        maintenance = DocumentsProviderMaintenance,
        installScript = File(context.cacheDir, "install.sh"),
        isVisible = { true },
        store = store,
        defaultRef = "staging",
        dispatcher = Dispatchers.Unconfined,
    )

    /** What install.sh --migrate-from leaves on success: a checkout holding copies of the moved folder's data. */
    private fun installSucceeds(source: File) {
        TestCheckouts.installed(paths.checkoutDir)
        File(source, "data").copyRecursively(File(paths.checkoutDir, "data"))
        File(source, "config.yaml").copyTo(File(paths.checkoutDir, "config.yaml"))
        host.finish(0, "Done.")
    }

    @Test
    fun aWriterOpenedBeforeRepairNeverWritesAgainAndOldIdsStopResolving() {
        val root = rootId()
        val data = childId(root, "data")
        val config = childId(root, "config.yaml")
        val chat = childId(childId(childId(data, "default-user"), "chats"), "chat.jsonl")
        val writer = provider.openDocument(chat, "rw", null)
        try {
            val callback = ProxyTestStorageManager.callbackFor(writer)
            assertEquals(4, callback.onWrite(0, 4, "safe".toByteArray()))

            val repair = controller()
            assertTrue(repair.start())
            val source = BrokenCheckouts.list(paths).single()
            assertEquals(RepairStep.REINSTALLING, (repair.state.value as RepairState.Running).step)
            // While install.sh copies the moved folder the provider is closed and the delivered writer is fenced.
            assertTrue(fence.exists())
            assertThrows(ErrnoException::class.java) { callback.onWrite(0, 4, "late".toByteArray()) }
            assertThrows(FileNotFoundException::class.java) { provider.queryRoots(null) }
            assertThrows(FileNotFoundException::class.java) { provider.openDocument(chat, "r", null) }

            installSucceeds(source)
            assertTrue(repair.state.value is RepairState.Succeeded)
            assertFalse(fence.exists())

            // The writer stays fenced after Repair; neither folder took a late write.
            assertThrows(ErrnoException::class.java) { callback.onWrite(0, 4, "late".toByteArray()) }
            assertEquals("safe data", File(source, chatPath).readText())
            assertEquals("safe data", File(paths.checkoutDir, chatPath).readText())
            for (id in listOf(root, data, config, chat)) {
                assertThrows(id, FileNotFoundException::class.java) { provider.queryDocument(id, null) }
                assertThrows(id, FileNotFoundException::class.java) { provider.openDocument(id, "r", null) }
            }

            // The new checkout has new IDs, and writes through them land in it, never in the moved folder.
            val freshRoot = rootId()
            assertNotEquals(root, freshRoot)
            val freshChat = childId(childId(childId(childId(freshRoot, "data"), "default-user"), "chats"), "chat.jsonl")
            assertNotEquals(chat, freshChat)
            assertEquals("safe data", read(freshChat))
            write(freshChat, "wt", "new data")
            assertEquals("new data", File(paths.checkoutDir, chatPath).readText())
            assertEquals("safe data", File(source, chatPath).readText())
        } finally {
            ProxyTestStorageManager.release(writer)
        }
    }

    @Test
    fun aFailedReinstallReopensTheProviderAndARetryGetsFreshIds() {
        val root = rootId()
        val repair = controller()
        assertTrue(repair.start())
        val source = BrokenCheckouts.list(paths).single()
        host.finish(1, "fatal: early EOF")
        assertEquals(RepairFailure.INSTALL_FAILED, (repair.state.value as RepairState.Failed).reason)

        // Maintenance ended on the failure: the provider answers again, without a root while no checkout exists.
        assertFalse(fence.exists())
        provider.queryRoots(null).use { assertEquals(0, it.count) }
        assertThrows(FileNotFoundException::class.java) { provider.queryDocument(root, null) }

        assertTrue(repair.retry())
        assertTrue(fence.exists())
        installSucceeds(source)
        assertTrue(repair.state.value is RepairState.Succeeded)
        assertFalse(fence.exists())
        val freshRoot = rootId()
        assertNotEquals(root, freshRoot)
        assertEquals("user data", read(childId(childId(childId(childId(freshRoot, "data"), "default-user"), "chats"), "chat.jsonl")))
    }

    @Test
    fun processDeathMidReinstallKeepsTheProviderFencedUntilLaunchRecovery() {
        val chat = childId(childId(childId(childId(rootId(), "data"), "default-user"), "chats"), "chat.jsonl")
        val writer = provider.openDocument(chat, "rw", null)
        try {
            val callback = ProxyTestStorageManager.callbackFor(writer)
            assertTrue(controller().start())
            val source = BrokenCheckouts.list(paths).single()
            // The process dies here: nothing in it ends maintenance, and the fence is on disk.
            assertTrue(fence.exists())

            val relaunched = controller(serverHost = FakeRepairServerHost())
            assertTrue(relaunched.resumeOnLaunch())
            val failed = relaunched.state.value as RepairState.Failed
            assertEquals(RepairFailure.INTERRUPTED, failed.reason)
            assertEquals(source, failed.source)
            assertFalse(fence.exists())
            provider.queryRoots(null).use { assertEquals(0, it.count) }
            assertThrows(ErrnoException::class.java) { callback.onWrite(0, 4, "late".toByteArray()) }
            assertEquals("user data", File(source, chatPath).readText())
        } finally {
            ProxyTestStorageManager.release(writer)
        }
    }

    private fun rootId(): String = provider.queryRoots(arrayOf(Root.COLUMN_DOCUMENT_ID)).use { cursor ->
        check(cursor.moveToFirst())
        cursor.getString(0)
    }

    private fun childId(parent: String, name: String): String = provider.queryChildDocuments(
        parent, arrayOf(Document.COLUMN_DISPLAY_NAME, Document.COLUMN_DOCUMENT_ID), sortOrder = null,
    ).use { cursor ->
        while (cursor.moveToNext()) if (cursor.getString(0) == name) return@use cursor.getString(1)
        error("Missing fixture child: $name")
    }

    private fun read(id: String): String {
        val descriptor = provider.openDocument(id, "r", null)
        return try {
            val callback = ProxyTestStorageManager.callbackFor(descriptor)
            val bytes = ByteArray(callback.onGetSize().toInt())
            assertEquals(bytes.size, callback.onRead(0, bytes.size, bytes))
            String(bytes, Charsets.UTF_8)
        } finally {
            ProxyTestStorageManager.release(descriptor)
        }
    }

    private fun write(id: String, mode: String, value: String) {
        val descriptor = provider.openDocument(id, mode, null)
        try {
            val callback = ProxyTestStorageManager.callbackFor(descriptor)
            val bytes = value.toByteArray(Charsets.UTF_8)
            assertEquals(bytes.size, callback.onWrite(0, bytes.size, bytes))
            callback.onFsync()
        } finally {
            ProxyTestStorageManager.release(descriptor)
        }
    }
}
