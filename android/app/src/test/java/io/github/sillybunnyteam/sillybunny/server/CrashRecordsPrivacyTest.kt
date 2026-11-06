package io.github.sillybunnyteam.sillybunny.server

import android.content.Context
import android.provider.DocumentsContract.Document
import android.provider.DocumentsContract.Root
import androidx.core.content.FileProvider
import androidx.test.core.app.ApplicationProvider
import io.github.sillybunnyteam.sillybunny.ClosingFileObserver
import io.github.sillybunnyteam.sillybunny.DataDocumentsProvider
import io.github.sillybunnyteam.sillybunny.documents.DocumentsWorkspace
import io.github.sillybunnyteam.sillybunny.documents.PosixTestOs
import io.github.sillybunnyteam.sillybunny.documents.PosixTestParcelFileDescriptor
import io.github.sillybunnyteam.sillybunny.documents.ProxyTestStorageManager
import io.github.sillybunnyteam.sillybunny.settings.LogSharing
import io.github.sillybunnyteam.sillybunny.settings.resetFileProviderRoots
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
import java.nio.file.Files

/** The crash records and Node's reports stay out of reach of both providers the app exports. */
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
class CrashRecordsPrivacyTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val checkout = File(context.filesDir, "SillyBunny")
    private val token = LaunchTokens.generate()
    private lateinit var provider: DataDocumentsProvider

    @Before
    fun setUp() {
        checkout.deleteRecursively()
        CrashRecords.directory(context).deleteRecursively()
        resetFileProviderRoots()
        provider = Robolectric.buildContentProvider(DataDocumentsProvider::class.java).create().get()
    }

    @After
    fun tearDown() {
        provider.shutdown()
        DocumentsWorkspace.get(context).call { }
        checkout.deleteRecursively()
    }

    @Test
    fun theDocumentsProviderNeverListsOrOpensARecordOrAReport() {
        File(checkout, "data/default-user").mkdirs()
        File(checkout, "data/default-user/settings.json").writeText("{}")
        File(checkout, "config.yaml").writeText("port: 8000")
        val (record, report) = recordAndReport()
        // Not something the app makes; even such a link is not followed.
        Files.createSymbolicLink(File(checkout, "data/crash").toPath(), CrashRecords.directory(context).toPath())

        val names = ArrayList<String>()
        walk(rootId(), names)

        assertEquals(listOf("config.yaml", "data", "default-user", "settings.json"), names.sorted())
        for (file in listOf(record, report, CrashRecords.directory(context))) {
            assertFalse(file.canonicalPath.startsWith(checkout.canonicalPath + File.separator))
        }
        val hostile = listOf(
            record.absolutePath,
            record.name,
            "crash/records/${record.name}",
            "../crash/records/${record.name}",
            "data/../../crash/records/${record.name}",
            report.absolutePath,
        )
        for (id in hostile) {
            assertThrows(FileNotFoundException::class.java) { provider.queryDocument(id, null) }
            assertThrows(FileNotFoundException::class.java) { provider.openDocument(id, "r", null) }
        }
    }

    @Test
    fun theFileProviderServesSnapshotsButNoRecordOrReport() {
        val (record, report) = recordAndReport()
        val snapshot = LogSharing.createSnapshot(context, emptyList())!!

        val uri = FileProvider.getUriForFile(context, LogSharing.authority(context), snapshot)
        assertEquals("/shared/logs/${snapshot.name}", uri.path)
        for (file in listOf(record, report, CrashRecords(CrashRecords.directory(context)).recordsDir)) {
            assertThrows(IllegalArgumentException::class.java) {
                FileProvider.getUriForFile(context, LogSharing.authority(context), file)
            }
        }
        // The snapshot holds the record with the token replaced.
        assertTrue(snapshot.readText().contains("cookie=${RedactingLineSplitter.REDACTED}"))
        assertFalse(snapshot.readText().contains(token))
    }

    /** A written record, and a raw report as Node leaves it before the next exit. */
    private fun recordAndReport(): Pair<File, File> {
        val records = CrashRecords(CrashRecords.directory(context))
        val reports = records.prepareReports()!!
        val now = System.currentTimeMillis()
        val record = records.write(
            CrashRecords.Crash(now, 134, 1_000, now - 1_000, token, listOf("cookie=$token"), emptyList()),
        )!!
        val report = File(reports, "report.20261024.120040.4300.0.001.json").apply { writeText("{}") }
        return record to report
    }

    private fun walk(id: String, names: MutableList<String>) {
        val projection = arrayOf(Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE)
        provider.queryChildDocuments(id, projection, sortOrder = null).use { cursor ->
            while (cursor.moveToNext()) {
                names += cursor.getString(1)
                if (cursor.getString(2) == Document.MIME_TYPE_DIR) walk(cursor.getString(0), names)
            }
        }
    }

    private fun rootId(): String = provider.queryRoots(arrayOf(Root.COLUMN_DOCUMENT_ID)).use { cursor ->
        check(cursor.moveToFirst())
        cursor.getString(0)
    }
}
