package io.github.sillybunnyteam.sillybunny.web.files

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.webkit.WebView
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.github.sillybunnyteam.sillybunny.R
import io.github.sillybunnyteam.sillybunny.web.downloads.HostRegistry
import io.github.sillybunnyteam.sillybunny.web.downloads.HostWeb
import io.github.sillybunnyteam.sillybunny.web.downloads.Media
import io.github.sillybunnyteam.sillybunny.web.downloads.TransferFixture
import io.github.sillybunnyteam.sillybunny.web.downloads.TransferHost
import io.github.sillybunnyteam.sillybunny.web.downloads.onMain
import org.json.JSONArray
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The SAF file chooser end to end (plan §4.5) in a real WebView: `<input type=file>` and File System
 * Access calls on `chooser.html` reach [SafFileChooser], whose launches are answered through
 * [HostRegistry] with MediaStore items standing in for picked documents.
 */
@RunWith(AndroidJUnit4::class)
class SafFileChooserDeviceTest {
    private val fixture = TransferFixture()
    private val context: Context get() = ApplicationProvider.getApplicationContext()
    private var host: TransferHost? = null

    @After
    fun tearDown() {
        try {
            host?.close()
        } finally {
            Media.cleanup()
        }
    }

    private fun launch(): TransferHost {
        val launched = TransferHost(fixture)
        host = launched
        return launched.launch("chooser.html")
    }

    /** The `cancel` event on file inputs arrived in Chromium 113. */
    private val cancelEvents: Boolean get() = HostWeb.webViewMajor() >= 113

    private fun file(name: String, mime: String, text: String): Uri = Media.create(name, mime, text.toByteArray())

    private fun names(view: WebView, id: String): List<String> {
        val files = JSONArray(HostWeb.waitResult(view, id))
        return (0 until files.length()).map { files.getJSONObject(it).getString("name") }
    }

    private fun assertCancelled(host: TransferHost, view: WebView, id: String) {
        if (cancelEvents) HostWeb.waitResult(view, "${id}Cancel")
        assertNull("no files for $id", HostWeb.result(view, id))
        assertFalse(host.chooser().let { onMain { it.hasPending } })
    }

    @Test
    fun singleOpen() {
        val host = launch()
        val view = host.webView()
        HostWeb.tap(view, "single")
        val launch = host.registry.next()
        assertEquals(Intent.ACTION_OPEN_DOCUMENT, launch.action)
        assertTrue(launch.intent.hasCategory(Intent.CATEGORY_OPENABLE))
        assertEquals("extension accepts allow every file", "*/*", launch.type)
        assertFalse(launch.intent.hasExtra(Intent.EXTRA_ALLOW_MULTIPLE))
        assertFalse(launch.intent.hasExtra(Intent.EXTRA_MIME_TYPES))
        val uri = file("card.json", "application/json", """{"a":1}""")
        assertTrue(host.registry.answer(launch, Activity.RESULT_OK, Media.result(listOf(uri), ContentUriPolicy.READ)))
        assertEquals(listOf(Media.displayName(uri)), names(view, "single"))
        assertEquals("""{"a":1}""", HostWeb.waitResult(view, "singleText"))
        assertFalse(host.chooser().let { onMain { it.hasPending } })
        assertEquals(0, host.count(R.string.web_files_rejected))
    }

    @Test
    fun multipleOpenReturnsEveryClipItem() {
        val host = launch()
        val view = host.webView()
        HostWeb.tap(view, "multi")
        val launch = host.registry.next()
        assertEquals(Intent.ACTION_OPEN_DOCUMENT, launch.action)
        assertTrue(launch.intent.getBooleanExtra(Intent.EXTRA_ALLOW_MULTIPLE, false))
        assertEquals("*/*", launch.type)
        assertFalse(launch.intent.hasExtra(Intent.EXTRA_MIME_TYPES))
        val uris = listOf(
            file("one.json", "application/json", "1"),
            file("two.yaml", "application/x-yaml", "2"),
            file("three.charx", "application/octet-stream", "3"),
        )
        // `data` repeats the first ClipData item; it must not be returned twice.
        assertTrue(host.registry.answer(launch, Activity.RESULT_OK, Media.result(uris, ContentUriPolicy.READ)))
        assertEquals(uris.map(Media::displayName), names(view, "multi"))
    }

    @Test
    fun acceptListsBecomeMimeFilters() {
        val host = launch()
        val view = host.webView()
        class Case(val id: String, val type: String, val extra: List<String>?, val multiple: Boolean)
        val cases = listOf(
            Case("mime", "*/*", listOf("image/png", "image/jpeg"), multiple = true),
            Case("wild", "image/*", null, multiple = false),
            Case("star", "*/*", null, multiple = true),
            Case("any", "*/*", null, multiple = true),
            Case("label", "*/*", null, multiple = false),
        )
        for (case in cases) {
            HostWeb.tap(view, case.id)
            val launch = host.registry.next()
            HostWeb.note("${case.id}: ${host.chooserCalls.last()} -> $launch")
            assertEquals(case.id, case.type, launch.type)
            assertEquals(case.id, case.extra, launch.intent.getStringArrayExtra(Intent.EXTRA_MIME_TYPES)?.toList())
            assertEquals(case.id, case.multiple, launch.intent.getBooleanExtra(Intent.EXTRA_ALLOW_MULTIPLE, false))
            assertTrue(host.registry.cancel(launch))
            assertCancelled(host, view, if (case.id == "label") "hidden" else case.id)
        }
        assertEquals(0, host.count(R.string.web_files_rejected))
    }

    @Test
    fun untrustedResultsAreRejected() {
        val host = launch()
        val view = host.webView()
        val app = context.packageName
        val read = ContentUriPolicy.READ
        val good = file("good.json", "application/json", "{}")
        val cases = listOf(
            "file path" to Intent().setData(Uri.parse("file:///data/data/$app/shared_prefs/settings.xml")).addFlags(read),
            "own FileProvider" to Intent().setData(Uri.parse("content://$app.files/logs/server.log")).addFlags(read),
            "own DocumentsProvider" to Intent().setData(Uri.parse("content://$app.documents/document/data")).addFlags(read),
            "package authority" to Intent().setData(Uri.parse("content://$app/anything")).addFlags(read),
            "no grant flags" to Media.result(listOf(good), flags = 0),
            "grant flags without a held grant" to Media.result(listOf(file("ungranted.json", "application/json", "{}")), read, grant = false),
        )
        for ((index, case) in cases.withIndex()) {
            HostWeb.tap(view, "single")
            val launch = host.registry.next()
            assertTrue(host.registry.answer(launch, Activity.RESULT_OK, case.second))
            host.waitNotice(R.string.web_files_rejected, index + 1)
            assertCancelled(host, view, "single")
            HostWeb.note("rejected: ${case.first}")
        }
        // One bad item rejects a multiple selection.
        HostWeb.tap(view, "multi")
        val launch = host.registry.next()
        val mixed = Media.result(listOf(good, Uri.parse("file:///sdcard/Download/x.json")), read)
        assertTrue(host.registry.answer(launch, Activity.RESULT_OK, mixed))
        host.waitNotice(R.string.web_files_rejected, cases.size + 1)
        assertCancelled(host, view, "multi")
    }

    @Test
    fun unusualNamesAndOctetStreamFilesPassThrough() {
        val host = launch()
        val view = host.webView()
        HostWeb.tap(view, "any")
        val launch = host.registry.next()
        val uris = listOf(
            file("データ.jsonl", "application/octet-stream", "{\"a\":1}\n"),
            file("x.settings", "application/octet-stream", "s=1"),
            file(".json", "application/json", "{}"),
            file("Seraphina (1).charx", "application/octet-stream", "PK"),
        )
        HostWeb.note("stored names ${uris.map(Media::displayName)}")
        assertTrue(host.registry.answer(launch, Activity.RESULT_OK, Media.result(uris, ContentUriPolicy.READ)))
        assertEquals(uris.map(Media::displayName), names(view, "any"))
        assertEquals("{\"a\":1}\n", HostWeb.waitResult(view, "anyText"))
    }

    @Test
    fun cancelledPickerCancelsTheInput() {
        val host = launch()
        val view = host.webView()
        HostWeb.tap(view, "single")
        assertTrue(host.registry.cancel(host.registry.next()))
        assertCancelled(host, view, "single")
        assertEquals("a cancel is no rejection", 0, host.count(R.string.web_files_rejected))
    }

    @Test
    fun activationShortlyAfterATapOpensThePickerButNotAfterItExpires() {
        val host = launch()
        val view = host.webView()
        HostWeb.tap(view, "later")
        val launch = host.registry.next(5_000)
        assertEquals("true", HostWeb.waitResult(view, "laterClicked"))
        assertTrue(host.registry.cancel(launch))
        HostWeb.tap(view, "tooLate")
        HostWeb.waitResult(view, "tooLateClicked", 10_000)
        if (HostWeb.webViewMajor() >= 100) {
            host.registry.none(2_000)
        } else {
            HostWeb.note("WebView ${HostWeb.webViewMajor()}: chooser after 6 s: ${host.chooserCalls.size} calls")
            runCatching { host.registry.cancel(host.registry.next(2_000)) }
        }
    }

    @Test
    fun detachedInputOpens() {
        val host = launch()
        val view = host.webView()
        HostWeb.tap(view, "detached")
        val launch = host.registry.next()
        assertEquals("mixed extension and MIME accepts allow every file", "*/*", launch.type)
        val zip = Media.create("pack.zip", "application/zip", byteArrayOf(0x50, 0x4b, 3, 4))
        assertTrue(host.registry.answer(launch, Activity.RESULT_OK, Media.result(listOf(zip), ContentUriPolicy.READ)))
        assertEquals(listOf(Media.displayName(zip)), names(view, "detached"))
    }

    @Test
    fun pendingRequestSurvivesActivityRecreation() {
        val host = launch()
        val view = host.webView()
        HostWeb.tap(view, "single")
        val launch = host.registry.next()
        host.scenario.recreate()
        assertSame(view, host.webView())
        assertTrue(host.chooser().let { onMain { it.hasPending && it.pickerOpen } })
        val uri = file("after-rotation.json", "application/json", "[1]")
        assertTrue(host.registry.answer(launch, Activity.RESULT_OK, Media.result(listOf(uri), ContentUriPolicy.READ)))
        assertEquals(listOf(Media.displayName(uri)), names(view, "single"))
        assertEquals("[1]", HostWeb.waitResult(view, "singleText"))
    }

    @Test
    fun cancelPendingCompletesWithNullAndALateResultIsIgnored() {
        val host = launch()
        val view = host.webView()
        HostWeb.tap(view, "single")
        val launch = host.registry.next()
        host.chooser().let { onMain { it.cancelPending() } }
        assertCancelled(host, view, "single")
        val uri = file("late.json", "application/json", "{}")
        assertTrue(host.registry.answer(launch, Activity.RESULT_OK, Media.result(listOf(uri), ContentUriPolicy.READ)))
        Thread.sleep(1_000)
        assertNull(HostWeb.result(view, "single"))
        assertFalse(host.chooser().let { onMain { it.pickerOpen } })
        HostWeb.tap(view, "single")
        assertTrue(host.registry.cancel(host.registry.next()))
    }

    @Test
    fun requestWhileAPickerIsOpenIsCancelled() {
        val host = launch()
        val view = host.webView()
        HostWeb.tap(view, "single")
        val first = host.registry.next()
        val calls = host.chooserCalls.size
        HostWeb.tap(view, "any")
        host.registry.none()
        // WebView itself may hold the second request until the first picker closes (Blink queues file
        // choosers per page); if it offers the request now instead, the chooser cancels it at once.
        val offered = host.chooserCalls.size > calls
        HostWeb.note("second input while a picker is open: offered=$offered")
        if (offered && cancelEvents) HostWeb.waitResult(view, "anyCancel")
        assertNull(HostWeb.result(view, "any"))
        assertTrue("the first request still waits", host.chooser().let { onMain { it.hasPending } })
        val uri = file("first.json", "application/json", "{\"first\":true}")
        assertTrue(host.registry.answer(first, Activity.RESULT_OK, Media.result(listOf(uri), ContentUriPolicy.READ)))
        assertEquals("the open picker answered the request that opened it", listOf(Media.displayName(uri)), names(view, "single"))
        val queued = if (offered) null else host.registry.poll(5_000)
        HostWeb.note("held second request offered after the first picker closed: ${queued != null}")
        if (queued != null) {
            assertTrue(host.registry.cancel(queued))
            assertCancelled(host, view, "any")
        }
        // Nothing is left stuck: a new request opens a picker again.
        HostWeb.text(view, "delete window.results.anyCancel")
        HostWeb.tap(view, "any")
        val next = host.registry.next()
        assertTrue(host.registry.cancel(next))
        assertCancelled(host, view, "any")
    }

    @Test
    fun fileSystemAccessModes() {
        assumeTrue("File System Access modes are API 37", Build.VERSION.SDK_INT >= Build.VERSION_CODES.CINNAMON_BUN)
        val host = launch()
        val view = host.webView()
        val api = HostWeb.text(view, "typeof window.showSaveFilePicker + ',' + typeof window.showOpenFilePicker + ',' + typeof window.showDirectoryPicker")
        HostWeb.note("WebView ${HostWeb.webViewMajor()} File System Access: $api")
        assumeTrue("no File System Access in this WebView: $api", api == "function,function,function")

        // Save: ACTION_CREATE_DOCUMENT named after the suggestion, written by the page.
        HostWeb.tap(view, "fsSave")
        var launch = host.registry.next()
        HostWeb.note("fsSave: ${host.chooserCalls.last()} -> $launch")
        assertEquals(Intent.ACTION_CREATE_DOCUMENT, launch.action)
        assertEquals("saved.json", launch.title)
        assertEquals("application/json", launch.type)
        val saved = Media.destination("fs-save")
        assertTrue(host.registry.answer(launch, Activity.RESULT_OK, Media.result(listOf(saved), Media.READ_WRITE)))
        HostWeb.waitFor("fsSave result") { HostWeb.result(view, "fsSave") != "started" }
        HostWeb.note("fsSave result ${HostWeb.result(view, "fsSave")}")
        assertTrue(checkNotNull(HostWeb.result(view, "fsSave")).startsWith("saved"))
        assertArrayEquals("{\"saved\":true}".toByteArray(), Media.read(saved))

        // A save destination without a write grant is refused.
        HostWeb.tap(view, "fsSave")
        launch = host.registry.next()
        val readOnly = Media.destination("fs-save-ro")
        assertTrue(host.registry.answer(launch, Activity.RESULT_OK, Media.result(listOf(readOnly), ContentUriPolicy.READ)))
        host.waitNotice(R.string.web_files_rejected)
        HostWeb.waitFor("fsSave refused") { HostWeb.result(view, "fsSave")?.startsWith("error") == true }

        // Folder: ACTION_OPEN_DOCUMENT_TREE; a result that is not a tree URI is refused.
        HostWeb.tap(view, "fsDir")
        launch = host.registry.next()
        HostWeb.note("fsDir: ${host.chooserCalls.last()} -> $launch")
        assertEquals(Intent.ACTION_OPEN_DOCUMENT_TREE, launch.action)
        val notTree = file("not-a-tree.json", "application/json", "{}")
        assertTrue(host.registry.answer(launch, Activity.RESULT_OK, Media.result(listOf(notTree), Media.READ_WRITE)))
        host.waitNotice(R.string.web_files_rejected, 2)
        HostWeb.waitFor("fsDir refused") { HostWeb.result(view, "fsDir")?.startsWith("error") == true }

        // Open for writing: the permission mode WebView asks for decides whether a write grant is needed.
        HostWeb.tap(view, "fsOpenWrite")
        launch = host.registry.next()
        val call = host.chooserCalls.last()
        HostWeb.note("fsOpenWrite: $call -> $launch")
        assertEquals(Intent.ACTION_OPEN_DOCUMENT, launch.action)
        val editable = file("editable.json", "application/json", "{}")
        assertTrue(host.registry.answer(launch, Activity.RESULT_OK, Media.result(listOf(editable), Media.READ_WRITE)))
        HostWeb.waitFor("fsOpenWrite result") { HostWeb.result(view, "fsOpenWrite") != "started" }
        HostWeb.note("fsOpenWrite result ${HostWeb.result(view, "fsOpenWrite")} content=${Media.read(editable)?.toString(Charsets.UTF_8)}")
        if (call.split(' ').getOrNull(2) == PickerRequests.PERMISSION_MODE_READ_WRITE.toString()) {
            assertTrue(checkNotNull(HostWeb.result(view, "fsOpenWrite")).startsWith("written"))
            assertArrayEquals("edited".toByteArray(), Media.read(editable))
        }
    }
}
