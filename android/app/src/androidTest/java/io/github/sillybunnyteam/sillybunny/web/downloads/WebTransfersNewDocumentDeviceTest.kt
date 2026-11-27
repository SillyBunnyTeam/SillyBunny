package io.github.sillybunnyteam.sillybunny.web.downloads

import android.net.Uri
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.github.sillybunnyteam.sillybunny.R
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TestRule
import org.junit.runner.RunWith

/**
 * Saving into a new document of the real DocumentsUI, whose Downloads root belongs to the downloads
 * provider in `android.process.media`. A save that is cancelled or fails after the app opened the
 * document removes it, and that removal must never crash the provider ([MediaProcessRule]). Each case
 * runs [ROUNDS] times, since the crash it guards against is a race with the provider's close listener.
 */
@RunWith(AndroidJUnit4::class)
class WebTransfersNewDocumentDeviceTest {
    @get:Rule
    val mediaProcesses: TestRule = MediaProcessRule()

    private val fixture = TransferFixture()
    private var host: TransferHost? = null

    @Before
    fun setUp() {
        fixture.reset()
    }

    @After
    fun tearDown() {
        try {
            // Documents the app kept or failed to remove. While the activity lives, the picker's grants allow it.
            host?.outputs?.toSet()?.forEach { Documents.remove(it) }
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

    /** Saves under the picker's suggested name and returns the new document once the app opened it for writing. */
    private fun saveAndAwaitOpen(host: TransferHost, round: Int): Uri {
        RealPicker.save()
        HostWeb.waitFor("the new document opened", 30_000) { host.outputs.size > round }
        return host.outputs[round]
    }

    /** The app removed [document], and DocumentsUI no longer lists it. */
    private fun assertRemoved(host: TransferHost, document: Uri) {
        HostWeb.waitFor("$document removed", 20_000) { document in host.discarded }
        HostWeb.waitFor("$document no longer listed", 20_000) { !Documents.listed(document) }
    }

    /** The page leaves while a large export streams into the new document. */
    @Test
    fun aPageExportCutOffByNavigationRemovesTheNewDocument() {
        val host = launch()
        assumeTrue("no bridge on WebView ${HostWeb.webViewMajor()}", host.bridged())
        val view = host.webView()
        var cut = 0
        repeat(ROUNDS) { round ->
            val name = "p56b-new-export-$round-${System.currentTimeMillis()}.bin"
            val saved = host.count(R.string.web_transfer_saved)
            val failed = host.count(R.string.web_transfer_failed)
            HostWeb.text(view, "window.fx.helper(${64 shl 20}, ${40 + round}, ${js(name)}, 'application/octet-stream')", 120_000)
            val document = saveAndAwaitOpen(host, round)
            HostWeb.fx(view, "navigate('/page2.html')")
            HostWeb.waitFor("page2", 20_000) { HostWeb.title(view) == "fixture-page2" }
            host.waitIdle(120_000)
            if (host.count(R.string.web_transfer_saved) > saved) {
                // The whole export was in before the page left: a kept save, which this round cannot test.
                HostWeb.note("round $round: the export was complete before the page left")
                Documents.remove(document)
            } else {
                cut++
                host.waitNotice(R.string.web_transfer_failed, failed + 1)
                assertRemoved(host, document)
            }
            host.open("transfers.html")
        }
        HostWeb.note("page exports cut off while streaming: $cut of $ROUNDS")
        assertTrue("no export was cut off while it streamed", cut > 0)
    }

    /** Without the bridge too: the WebView goes away while a download streams into the new document. */
    @Test
    fun aDownloadCancelledWhileItStreamsRemovesTheNewDocument() {
        val host = launch()
        val view = host.webView()
        val transfers = host.transfers()
        repeat(ROUNDS) { round ->
            val disposition = "attachment; filename=\"p56b-new-http-$round-${System.currentTimeMillis()}.bin\""
            // About 16 MB in 64 KiB pieces 100 ms apart: the body arrives for some 25 s.
            HostWeb.fx(view, "navigate('/bytes?n=16000000&seed=${50 + round}&delay=100&disposition=' + encodeURIComponent(${js(disposition)}))")
            val document = saveAndAwaitOpen(host, round)
            Thread.sleep(1_000)
            assertEquals("the body still arrives", 1, host.activeTransfers())
            onMain { transfers.detach(view) }
            host.waitIdle()
            assertRemoved(host, document)
            onMain { transfers.attach(view, fixture.session) }
        }
        assertEquals("cancelled quietly", 0, host.count(R.string.web_transfer_failed))
        assertEquals(0, host.count(R.string.web_transfer_saved))
    }

    /** Without the bridge too: the server breaks off a download that streams into the new document. */
    @Test
    fun aDownloadThatBreaksOffRemovesTheNewDocument() {
        val host = launch()
        val view = host.webView()
        repeat(ROUNDS) { round ->
            val disposition = "attachment; filename=\"p56b-new-cut-$round-${System.currentTimeMillis()}.bin\""
            val failed = host.count(R.string.web_transfer_failed)
            // The connection breaks after about 8 MB of 16 MB, some 12 s in, well after the pick.
            HostWeb.fx(
                view,
                "navigate('/bytes?n=16000000&seed=${60 + round}&delay=100&cut=8000000&disposition=' + encodeURIComponent(${js(disposition)}))",
            )
            val document = saveAndAwaitOpen(host, round)
            host.waitNotice(R.string.web_transfer_failed, failed + 1, 60_000)
            assertRemoved(host, document)
            host.waitIdle()
        }
        assertEquals(0, host.count(R.string.web_transfer_saved))
    }

    private fun js(value: String): String = JSONObject.quote(value)

    private companion object {
        const val ROUNDS = 3
    }
}
