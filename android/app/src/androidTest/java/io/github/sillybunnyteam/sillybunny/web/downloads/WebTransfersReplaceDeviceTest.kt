package io.github.sillybunnyteam.sillybunny.web.downloads

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.github.sillybunnyteam.sillybunny.R
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TestRule
import org.junit.runner.RunWith

/**
 * Saving over an existing document in the real DocumentsUI, which hands back that document. It must
 * never be removed, and it is only emptied once the new export is complete: not for a Save that comes
 * after its export is gone, and not for a download or export cancelled while it arrives.
 */
@RunWith(AndroidJUnit4::class)
class WebTransfersReplaceDeviceTest {
    @get:Rule
    val mediaProcesses: TestRule = MediaProcessRule()

    private val fixture = TransferFixture()
    private val context: Context get() = ApplicationProvider.getApplicationContext()
    private var host: TransferHost? = null
    private val made = mutableListOf<Uri>()

    @Before
    fun setUp() {
        fixture.reset()
    }

    @After
    fun tearDown() {
        try {
            // While the activity lives, the picker's grants still allow removing what the test saved. The
            // app closed these documents moments ago: removing one before the downloads provider has
            // handled that close would crash the provider.
            made.forEach { Documents.remove(it) }
        } finally {
            host?.close()
        }
    }

    private fun launch(): TransferHost {
        val launched = TransferHost(fixture, realPicker = true)
        host = launched
        launched.launch()
        HostWeb.note("bridged=${launched.bridged()} webview=${HostWeb.webViewMajor()}")
        return launched
    }

    /** A host whose WebView has the bridge; skips the test on a WebView without it. */
    private fun bridgedHost(): TransferHost {
        val launched = launch()
        assumeTrue("no bridge on WebView ${HostWeb.webViewMajor()}", launched.bridged())
        return launched
    }

    /** Runs `fx.<call>`, saves its export under the picker's suggested name and returns the new document. */
    private fun saveNew(host: TransferHost, call: String): Uri {
        HostWeb.fx(host.webView(), call)
        RealPicker.save()
        host.waitNotice(R.string.web_transfer_saved, timeoutMillis = 30_000)
        val document = host.outputs.last()
        made += document
        HostWeb.note("saved $document as ${nameOf(document)}")
        return document
    }

    /** [document] is still listed with content [sha256], was opened only for its first save and never removed. */
    private fun assertKept(host: TransferHost, document: Uri, sha256: String) {
        // A removal or a write would run moments after the result, on a worker thread.
        Thread.sleep(2_000)
        assertNotNull("still listed", nameOf(document))
        assertEquals("content kept", sha256, Media.sha256(document))
        assertEquals("opened only for its first save", 1, host.outputs.count { it == document })
        assertEquals("nothing removed", emptyList<Uri>(), host.discarded.toList())
    }

    /** Control: a page export over an earlier one replaces all of its content in the same document. */
    @Test
    fun replacingWritesTheWholeExportToTheSameDocument() {
        val host = bridgedHost()
        val view = host.webView()
        val name = "p56b-replace-${System.currentTimeMillis()}.json"
        val existing = saveNew(host, "helper(3000, 51, ${js(name)}, 'application/json')")
        assertEquals(patternSha256(3000, 51), Media.sha256(existing))
        // Shorter than what the document holds, so nothing of the old content may be left.
        HostWeb.fx(view, "helper(1200, 52, ${js(name)}, 'application/json')")
        RealPicker.replace(checkNotNull(nameOf(existing)))
        host.waitNotice(R.string.web_transfer_saved, 2, 30_000)
        assertEquals("the picker hands back the replaced document", existing, host.outputs.last())
        assertEquals(patternSha256(1200, 52), Media.sha256(existing))
        assertEquals(emptyList<Uri>(), host.discarded.toList())
        assertEquals(0, host.count(R.string.web_transfer_failed))
    }

    /** The page navigates while the picker is open; the user then saves over an earlier export. */
    @Test
    fun aSaveOverADocumentAfterThePageLeftKeepsIt() {
        val host = bridgedHost()
        val view = host.webView()
        val name = "p56b-late-${System.currentTimeMillis()}.json"
        val existing = saveNew(host, "helper(1000, 61, ${js(name)}, 'application/json')")
        val before = checkNotNull(Media.sha256(existing))
        HostWeb.fx(view, "helper(1000, 62, ${js(name)}, 'application/json')")
        checkNotNull(RealPicker.saveButton()) { "picker not shown: ${RealPicker.screen()}" }
        HostWeb.fx(view, "navigate('/page2.html')")
        HostWeb.waitFor("page2 behind the picker", 20_000) { HostWeb.title(view) == "fixture-page2" }
        host.waitIdle()
        RealPicker.replace(checkNotNull(nameOf(existing)))
        // The Save cannot be honoured, and the user is told so.
        host.waitNotice(R.string.web_transfer_failed)
        RealPicker.gone()
        assertKept(host, existing, before)
        assertEquals(1, host.count(R.string.web_transfer_saved))
        assertEquals(1, host.count(R.string.web_transfer_failed))
    }

    /**
     * Without the bridge too: the WebView goes away while the picker is open, as when its renderer dies
     * or the session changes, and the user then saves over an earlier export.
     */
    @Test
    fun aSaveOverADocumentAfterTheWebViewWentAwayKeepsIt() {
        val host = launch()
        val view = host.webView()
        val body = "earlier ${System.nanoTime()}"
        // Named from the anchor with the bridge; download.txt, or a numbered variant, without it.
        val existing = saveNew(host, "dataBase64(${js(body)}, ${js("p56b-gone-${System.currentTimeMillis()}.txt")})")
        assertEquals(body, Media.read(existing)?.toString(Charsets.UTF_8))
        val before = checkNotNull(Media.sha256(existing))
        HostWeb.fx(view, "dataBase64(${js("later ${System.nanoTime()}")}, 'p56b-gone-later.txt')")
        checkNotNull(RealPicker.saveButton()) { "picker not shown: ${RealPicker.screen()}" }
        val transfers = host.transfers()
        onMain { transfers.detach(view) }
        host.waitIdle()
        RealPicker.replace(checkNotNull(nameOf(existing)))
        host.waitNotice(R.string.web_transfer_failed)
        RealPicker.gone()
        assertKept(host, existing, before)
        assertEquals(1, host.count(R.string.web_transfer_failed))
    }

    /**
     * Without the bridge too: an HTTP download picked over an earlier one is cancelled while its body
     * still arrives, and the document keeps its content; a complete download then replaces it.
     */
    @Test
    fun aDownloadCancelledWhileItArrivesKeepsTheDocument() {
        val host = launch()
        val view = host.webView()
        val name = "p56b-http-${System.currentTimeMillis()}.json"
        val disposition = Uri.encode("attachment; filename=\"$name\"")
        fun download(query: String) = "navigate(${js("/bytes?$query&type=application%2Fjson&disposition=$disposition")})"
        val existing = saveNew(host, download("n=3000&seed=71"))
        val before = checkNotNull(Media.sha256(existing))
        assertEquals(patternSha256(3000, 71), before)
        val shown = checkNotNull(nameOf(existing))
        // About 4 MB in 64 KiB pieces 500 ms apart: the body still arrives long after the pick.
        HostWeb.fx(view, download("n=4000000&seed=72&delay=500"))
        RealPicker.replace(shown)
        RealPicker.gone()
        Thread.sleep(2_000)
        assertEquals("the body still arrives", 1, host.activeTransfers())
        val transfers = host.transfers()
        onMain { transfers.detach(view) }
        host.waitIdle()
        assertKept(host, existing, before)
        assertEquals("cancelled quietly", 0, host.count(R.string.web_transfer_failed))
        // Attached again: a complete download, shorter than the document, replaces all of it.
        onMain { transfers.attach(view, fixture.session) }
        HostWeb.fx(view, download("n=1500&seed=73"))
        RealPicker.replace(shown)
        host.waitNotice(R.string.web_transfer_saved, 2, 30_000)
        assertEquals(existing, host.outputs.last())
        assertEquals(patternSha256(1500, 73), Media.sha256(existing))
        assertEquals(emptyList<Uri>(), host.discarded.toList())
        assertEquals(0, host.count(R.string.web_transfer_failed))
    }

    /** The page leaves while a large export streams over an earlier one: the old or the whole new content, never a part. */
    @Test
    fun anExportCancelledWhileItStreamsKeepsTheDocument() {
        val host = bridgedHost()
        val view = host.webView()
        val name = "p56b-stream-${System.currentTimeMillis()}.json"
        val existing = saveNew(host, "helper(3000, 81, ${js(name)}, 'application/json')")
        val before = checkNotNull(Media.sha256(existing))
        val size = 32 shl 20
        HostWeb.text(view, "window.fx.helper($size, 82, ${js(name)}, 'application/json')", 120_000)
        RealPicker.replace(checkNotNull(nameOf(existing)))
        RealPicker.gone()
        HostWeb.fx(view, "navigate('/page2.html')")
        HostWeb.waitFor("page2", 20_000) { HostWeb.title(view) == "fixture-page2" }
        host.waitIdle(120_000)
        Thread.sleep(2_000)
        val after = Media.sha256(existing)
        val outcome = when (after) {
            before -> "kept"
            patternSha256(size.toLong(), 82) -> "replaced"
            else -> "partial $after"
        }
        HostWeb.note(
            "page left during a replacing export: $outcome saved=${host.count(R.string.web_transfer_saved)} " +
                "failed=${host.count(R.string.web_transfer_failed)}",
        )
        assertNotNull("still listed", nameOf(existing))
        assertTrue("the old or the whole new content: $outcome", outcome == "kept" || outcome == "replaced")
        assertEquals(emptyList<Uri>(), host.discarded.toList())
    }

    private fun nameOf(uri: Uri): String? = runCatching {
        context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
            ?.use { if (it.moveToFirst()) it.getString(0) else null }
    }.getOrNull()

    private fun js(value: String): String = JSONObject.quote(value)
}
