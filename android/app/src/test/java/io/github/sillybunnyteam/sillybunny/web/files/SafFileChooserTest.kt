package io.github.sillybunnyteam.sillybunny.web.files

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import androidx.activity.result.ActivityResult
import androidx.test.core.app.ApplicationProvider
import io.github.sillybunnyteam.sillybunny.R
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The chooser's request lifecycle: exactly-once completion, one picker at a time, recreation and teardown. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [37])
class SafFileChooserTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val held = mutableMapOf<Uri, Int>()
    private val notices = mutableListOf<Int>()
    private val launches = mutableListOf<Intent>()
    private val webView by lazy { WebView(context) }

    private fun chooser(sdk: Int = 37) = SafFileChooser(
        context,
        policy = ContentUriPolicy(context, ownAuthorities = { emptySet() }) { uri, needed -> (held[uri] ?: 0) and needed == needed },
        sdk = sdk,
        notify = { notices += it },
    )

    private class Params(
        private val mode: Int = PickerRequests.MODE_OPEN,
        private val accept: Array<String> = arrayOf(""),
        private val hint: String? = null,
        private val permission: Int = PickerRequests.PERMISSION_MODE_READ,
    ) : WebChromeClient.FileChooserParams() {
        override fun getMode(): Int = mode

        override fun getAcceptTypes(): Array<String> = accept

        override fun isCaptureEnabled(): Boolean = false

        override fun getTitle(): CharSequence? = null

        override fun getFilenameHint(): String? = hint

        override fun createIntent(): Intent = Intent(Intent.ACTION_GET_CONTENT)

        override fun getPermissionMode(): Int = permission
    }

    /** Records what the page would receive; `completions` counts every call. */
    private class Callback : ValueCallback<Array<Uri>> {
        val completions = mutableListOf<Array<Uri>?>()

        override fun onReceiveValue(value: Array<Uri>?) {
            completions += value
        }
    }

    private fun document(name: String, grant: Int = ContentUriPolicy.READ or ContentUriPolicy.WRITE): Uri =
        DocumentsContract.buildDocumentUri("com.android.externalstorage.documents", "primary:$name").also { held[it] = grant }

    private fun ok(uri: Uri, flags: Int = ContentUriPolicy.READ or ContentUriPolicy.WRITE) =
        ActivityResult(Activity.RESULT_OK, Intent().setData(uri).addFlags(flags))

    @Test
    fun unboundRequestIsCancelledAtOnce() {
        val callback = Callback()
        assertTrue(chooser().show(webView, callback, Params()))
        assertEquals(listOf<Array<Uri>?>(null), callback.completions)
    }

    @Test
    fun resultCompletesTheRequestExactlyOnce() {
        val chooser = chooser().apply { bind { launches += it } }
        val callback = Callback()
        assertTrue(chooser.show(webView, callback, Params(accept = arrayOf("image/png"))))
        assertEquals(Intent.ACTION_OPEN_DOCUMENT, launches.single().action)
        assertEquals("image/png", launches.single().type)
        assertTrue(chooser.pickerOpen && chooser.hasPending)
        val uri = document("a.png")
        chooser.onResult(ok(uri, ContentUriPolicy.READ))
        chooser.onResult(ok(uri, ContentUriPolicy.READ))
        chooser.cancelPending()
        assertEquals(1, callback.completions.size)
        assertArrayEquals(arrayOf(uri), callback.completions.single())
        assertFalse(chooser.pickerOpen || chooser.hasPending)
        assertEquals(emptyList<Int>(), notices)
    }

    @Test
    fun aRequestWhileThePickerIsOpenIsCancelled() {
        val chooser = chooser().apply { bind { launches += it } }
        val first = Callback()
        val second = Callback()
        chooser.show(webView, first, Params())
        chooser.show(webView, second, Params(mode = PickerRequests.MODE_OPEN_MULTIPLE))
        assertEquals(1, launches.size)
        assertEquals(listOf<Array<Uri>?>(null), second.completions)
        assertTrue(first.completions.isEmpty())
        val uri = document("first.json")
        chooser.onResult(ok(uri))
        assertArrayEquals(arrayOf(uri), first.completions.single())
    }

    @Test
    fun cancelPendingKeepsThePickerOpenUntilItsResultArrives() {
        val chooser = chooser().apply { bind { launches += it } }
        val callback = Callback()
        chooser.show(webView, callback, Params())
        chooser.cancelPending()
        assertEquals(listOf<Array<Uri>?>(null), callback.completions)
        assertTrue("the picker is still on screen", chooser.pickerOpen)
        val meanwhile = Callback()
        chooser.show(webView, meanwhile, Params())
        assertEquals(listOf<Array<Uri>?>(null), meanwhile.completions)
        chooser.onResult(ok(document("late.json")))
        assertEquals("the late result goes nowhere", 1, callback.completions.size)
        assertFalse(chooser.pickerOpen)
        val next = Callback()
        chooser.show(webView, next, Params())
        assertEquals(2, launches.size)
        assertTrue(next.completions.isEmpty())
    }

    @Test
    fun configurationChangeKeepsTheRequest() {
        val chooser = chooser().apply { bind { launches += it } }
        val callback = Callback()
        chooser.show(webView, callback, Params())
        chooser.unbind(changingConfigurations = true)
        assertTrue(chooser.hasPending && chooser.pickerOpen)
        chooser.bind { launches += it }
        val uri = document("rotated.json")
        chooser.onResult(ok(uri))
        assertArrayEquals(arrayOf(uri), callback.completions.single())
    }

    @Test
    fun leavingForGoodCancels() {
        val chooser = chooser().apply { bind { launches += it } }
        val callback = Callback()
        chooser.show(webView, callback, Params())
        chooser.unbind(changingConfigurations = false)
        assertEquals(listOf<Array<Uri>?>(null), callback.completions)
        assertFalse(chooser.pickerOpen || chooser.hasPending)
        val released = Callback()
        chooser.bind { launches += it }
        chooser.show(webView, released, Params())
        chooser.release()
        assertEquals(listOf<Array<Uri>?>(null), released.completions)
        val afterRelease = Callback()
        chooser.show(webView, afterRelease, Params())
        assertEquals("unbound after release", listOf<Array<Uri>?>(null), afterRelease.completions)
    }

    @Test
    fun unusableResultsAreRejectedWithANotice() {
        val chooser = chooser().apply { bind { launches += it } }
        val callback = Callback()
        chooser.show(webView, callback, Params())
        chooser.onResult(ok(Uri.parse("file:///data/data/${context.packageName}/files/secret")))
        assertEquals(listOf<Array<Uri>?>(null), callback.completions)
        assertEquals(listOf(R.string.web_files_rejected), notices)
        val cancelled = Callback()
        chooser.show(webView, cancelled, Params())
        chooser.onResult(ActivityResult(Activity.RESULT_CANCELED, null))
        assertEquals(listOf<Array<Uri>?>(null), cancelled.completions)
        assertEquals("a cancel is no rejection", 1, notices.size)
    }

    @Test
    fun launcherFailures() {
        val missing = chooser().apply { bind { throw ActivityNotFoundException() } }
        val callback = Callback()
        missing.show(webView, callback, Params())
        assertEquals(listOf<Array<Uri>?>(null), callback.completions)
        assertEquals(listOf(R.string.web_files_rejected), notices)
        assertFalse(missing.pickerOpen)
        val unregistered = chooser().apply { bind { throw IllegalStateException("unregistered") } }
        val other = Callback()
        unregistered.show(webView, other, Params())
        assertEquals(listOf<Array<Uri>?>(null), other.completions)
        assertFalse(unregistered.pickerOpen)
    }

    @Test
    fun modesTheDeviceCannotServeAreCancelled() {
        val old = chooser(sdk = 36).apply { bind { launches += it } }
        val callback = Callback()
        old.show(webView, callback, Params(mode = PickerRequests.MODE_OPEN_FOLDER))
        assertEquals(listOf<Array<Uri>?>(null), callback.completions)
        assertTrue(launches.isEmpty())
    }

    @Test
    fun readWritePermissionModeRequiresAWriteGrant() {
        val chooser = chooser().apply { bind { launches += it } }
        val readOnly = Callback()
        chooser.show(webView, readOnly, Params(permission = PickerRequests.PERMISSION_MODE_READ_WRITE))
        chooser.onResult(ok(document("ro.json"), ContentUriPolicy.READ))
        assertEquals(listOf<Array<Uri>?>(null), readOnly.completions)
        val writable = Callback()
        chooser.show(webView, writable, Params(permission = PickerRequests.PERMISSION_MODE_READ_WRITE))
        val uri = document("rw.json")
        chooser.onResult(ok(uri))
        assertArrayEquals(arrayOf(uri), writable.completions.single())
    }

    @Test
    fun saveModeUsesCreateDocument() {
        val chooser = chooser().apply { bind { launches += it } }
        val callback = Callback()
        chooser.show(webView, callback, Params(mode = PickerRequests.MODE_SAVE, hint = "saved.json"))
        assertEquals(Intent.ACTION_CREATE_DOCUMENT, launches.single().action)
        assertEquals("saved.json", launches.single().getStringExtra(Intent.EXTRA_TITLE))
        chooser.onResult(ok(document("saved.json"), ContentUriPolicy.READ))
        assertNull("a save destination needs write access", callback.completions.single())
    }
}

/** On API 29 the permission mode does not exist; a read grant is enough. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29])
class SafFileChooserApi29Test {
    private val context: Context = ApplicationProvider.getApplicationContext()

    @Test
    fun permissionModeIsIgnoredBeforeApi37() {
        val uri = DocumentsContract.buildDocumentUri("com.android.externalstorage.documents", "primary:a.json")
        val chooser = SafFileChooser(
            context,
            policy = ContentUriPolicy(context, ownAuthorities = { emptySet() }) { _, needed -> needed == ContentUriPolicy.READ },
            sdk = 29,
            notify = {},
        )
        val launches = mutableListOf<Intent>()
        chooser.bind { launches += it }
        val received = mutableListOf<Array<Uri>?>()
        val params = object : WebChromeClient.FileChooserParams() {
            override fun getMode(): Int = PickerRequests.MODE_OPEN

            override fun getAcceptTypes(): Array<String> = arrayOf(".json")

            override fun isCaptureEnabled(): Boolean = false

            override fun getTitle(): CharSequence? = null

            override fun getFilenameHint(): String? = null

            override fun createIntent(): Intent = Intent()
        }
        chooser.show(WebView(context), { received += it }, params)
        chooser.onResult(ActivityResult(Activity.RESULT_OK, Intent().setData(uri).addFlags(ContentUriPolicy.READ)))
        assertArrayEquals(arrayOf(uri), received.single())
    }
}
