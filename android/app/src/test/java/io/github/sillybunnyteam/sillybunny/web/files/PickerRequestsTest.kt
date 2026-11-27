package io.github.sillybunnyteam.sillybunny.web.files

import android.app.Activity
import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import androidx.test.core.app.ApplicationProvider
import io.github.sillybunnyteam.sillybunny.web.files.PickerRequests.MODE_OPEN
import io.github.sillybunnyteam.sillybunny.web.files.PickerRequests.MODE_OPEN_FOLDER
import io.github.sillybunnyteam.sillybunny.web.files.PickerRequests.MODE_OPEN_MULTIPLE
import io.github.sillybunnyteam.sillybunny.web.files.PickerRequests.MODE_SAVE
import io.github.sillybunnyteam.sillybunny.web.files.PickerRequests.PERMISSION_MODE_READ
import io.github.sillybunnyteam.sillybunny.web.files.PickerRequests.PERMISSION_MODE_READ_WRITE
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** SAF intents for chooser requests and the checks on their results (plan §4.5). MIME lookups use the API 37 platform table. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [37])
class PickerRequestsTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val held = mutableMapOf<Uri, Int>()
    private val policy = ContentUriPolicy(context, ownAuthorities = { setOf("app.own.files") }) { uri, needed ->
        (held[uri] ?: 0) and needed == needed
    }
    private val read = ContentUriPolicy.READ
    private val readWrite = ContentUriPolicy.READ or ContentUriPolicy.WRITE

    private fun request(mode: Int, permission: Int = PERMISSION_MODE_READ, accept: Array<String>? = null, hint: String? = null, sdk: Int = 37) =
        checkNotNull(PickerRequests.create(mode, permission, accept, hint, sdk))

    private fun document(id: String, grant: Int = readWrite): Uri =
        DocumentsContract.buildDocumentUri("com.android.externalstorage.documents", id).also { held[it] = grant }

    private fun result(uris: List<Uri>, flags: Int = readWrite): Intent {
        val intent = Intent().setData(uris.first()).addFlags(flags)
        if (uris.size > 1) {
            intent.clipData = ClipData.newRawUri("", uris.first()).apply { uris.drop(1).forEach { addItem(ClipData.Item(it)) } }
        }
        return intent
    }

    @Test
    fun openUsesOpenDocument() {
        val open = request(MODE_OPEN, accept = arrayOf(".json", ".settings"))
        assertEquals(Intent.ACTION_OPEN_DOCUMENT, open.intent.action)
        assertTrue(open.intent.hasCategory(Intent.CATEGORY_OPENABLE))
        assertEquals("*/*", open.intent.type)
        assertFalse(open.intent.hasExtra(Intent.EXTRA_ALLOW_MULTIPLE))
        assertFalse(open.intent.hasExtra(Intent.EXTRA_MIME_TYPES))
        assertEquals(PickerKind.OPEN, open.kind)
        assertFalse(open.requireWrite)
        assertEquals("image/*", request(MODE_OPEN, accept = arrayOf("image/*")).intent.type)
    }

    @Test
    fun openMultipleAllowsMultipleAndExtraMimeTypes() {
        val multiple = request(MODE_OPEN_MULTIPLE, accept = arrayOf("image/png", "image/jpeg"), sdk = 29)
        assertTrue(multiple.intent.getBooleanExtra(Intent.EXTRA_ALLOW_MULTIPLE, false))
        assertArrayEquals(arrayOf("image/png", "image/jpeg"), multiple.intent.getStringArrayExtra(Intent.EXTRA_MIME_TYPES))
        assertEquals("*/*", multiple.intent.type)
        assertEquals(PickerKind.OPEN_MULTIPLE, multiple.kind)
    }

    @Test
    fun folderAndReadWriteModesNeedApi37() {
        assertNull(PickerRequests.create(MODE_OPEN_FOLDER, PERMISSION_MODE_READ, null, null, 36))
        val folder = request(MODE_OPEN_FOLDER, PERMISSION_MODE_READ_WRITE)
        assertEquals(Intent.ACTION_OPEN_DOCUMENT_TREE, folder.intent.action)
        assertEquals(PickerKind.FOLDER, folder.kind)
        assertTrue(folder.requireWrite)
        assertFalse(request(MODE_OPEN_FOLDER).requireWrite)
        assertFalse(request(MODE_OPEN, PERMISSION_MODE_READ_WRITE, sdk = 36).requireWrite)
        assertTrue(request(MODE_OPEN, PERMISSION_MODE_READ_WRITE).requireWrite)
        assertNull("unknown mode", PickerRequests.create(7, PERMISSION_MODE_READ, null, null, 37))
    }

    @Test
    fun saveUsesCreateDocumentWithASafeName() {
        val save = request(MODE_SAVE, accept = arrayOf("application/json"), hint = "../chat")
        assertEquals(Intent.ACTION_CREATE_DOCUMENT, save.intent.action)
        assertTrue(save.intent.hasCategory(Intent.CATEGORY_OPENABLE))
        assertEquals("chat.json", save.intent.getStringExtra(Intent.EXTRA_TITLE))
        assertEquals("application/json", save.intent.type)
        assertTrue("saves always need write access", save.requireWrite)
        assertEquals(PickerKind.SAVE, save.kind)
        val unnamed = request(MODE_SAVE)
        assertEquals("download", unnamed.intent.getStringExtra(Intent.EXTRA_TITLE))
        assertEquals("application/octet-stream", unnamed.intent.type)
        val wildcard = request(MODE_SAVE, accept = arrayOf("image/*"), hint = "picture")
        assertEquals("a wildcard names no extension", "picture", wildcard.intent.getStringExtra(Intent.EXTRA_TITLE))
        assertEquals("image/png", request(MODE_SAVE, hint = "a.png").intent.type)
    }

    @Test
    fun resultUrisAreDataThenClipItemsWithoutDuplicates() {
        val a = document("primary:a.json")
        val b = document("primary:b.json")
        assertEquals(listOf(a, b), PickerResults.uris(result(listOf(a, b))))
        assertEquals(listOf(a), PickerResults.uris(Intent().setData(a)))
        assertEquals(emptyList<Uri>(), PickerResults.uris(null))
        val clipOnly = Intent().apply { clipData = ClipData.newRawUri("", b) }
        assertEquals(listOf(b), PickerResults.uris(clipOnly))
    }

    @Test
    fun acceptedResults() {
        val a = document("primary:a.json")
        val b = document("primary:b.json")
        assertArrayEquals(arrayOf(a), PickerResults.accept(Activity.RESULT_OK, result(listOf(a, b), read), request(MODE_OPEN), policy))
        assertArrayEquals(arrayOf(a, b), PickerResults.accept(Activity.RESULT_OK, result(listOf(a, b), read), request(MODE_OPEN_MULTIPLE), policy))
        val tree = DocumentsContract.buildTreeDocumentUri("com.android.externalstorage.documents", "primary:Download").also { held[it] = readWrite }
        assertArrayEquals(arrayOf(tree), PickerResults.accept(Activity.RESULT_OK, result(listOf(tree)), request(MODE_OPEN_FOLDER, PERMISSION_MODE_READ_WRITE), policy))
        val save = document("primary:new.json")
        assertArrayEquals(arrayOf(save), PickerResults.accept(Activity.RESULT_OK, result(listOf(save)), request(MODE_SAVE), policy))
    }

    @Test
    fun cancelledOrEmptyResultsAreNull() {
        val a = document("primary:a.json")
        assertNull(PickerResults.accept(Activity.RESULT_CANCELED, result(listOf(a)), request(MODE_OPEN), policy))
        assertNull(PickerResults.accept(Activity.RESULT_OK, null, request(MODE_OPEN), policy))
        assertNull(PickerResults.accept(Activity.RESULT_OK, Intent(), request(MODE_OPEN), policy))
    }

    @Test
    fun oneUnacceptableUriRejectsTheResult() {
        val good = document("primary:good.json")
        val untrusted = listOf(
            Uri.parse("file:///data/data/app/shared_prefs/x.xml"),
            Uri.parse("content://app.own.files/logs/server.log"),
            Uri.parse("content://${context.packageName}/x"),
            Uri.parse("content://${context.packageName}.documents/document/x"),
            Uri.parse("https://example.com/x.json"),
            DocumentsContract.buildDocumentUri("com.android.externalstorage.documents", "primary:not-held"),
        )
        for (bad in untrusted) {
            assertNull("$bad alone", PickerResults.accept(Activity.RESULT_OK, result(listOf(bad), read), request(MODE_OPEN), policy))
            assertNull("$bad among others", PickerResults.accept(Activity.RESULT_OK, result(listOf(good, bad), read), request(MODE_OPEN_MULTIPLE), policy))
        }
    }

    @Test
    fun grantsMustBeInTheResultAndHeld() {
        val readOnly = document("primary:ro.json", grant = read)
        assertNull("no flags", PickerResults.accept(Activity.RESULT_OK, result(listOf(readOnly), 0), request(MODE_OPEN), policy))
        assertArrayEquals(arrayOf(readOnly), PickerResults.accept(Activity.RESULT_OK, result(listOf(readOnly), read), request(MODE_OPEN), policy))
        assertNull("write flag but no held write grant", PickerResults.accept(Activity.RESULT_OK, result(listOf(readOnly), readWrite), request(MODE_SAVE), policy))
        val writable = document("primary:rw.json")
        assertNull("held, but the result lacks the write flag", PickerResults.accept(Activity.RESULT_OK, result(listOf(writable), read), request(MODE_SAVE), policy))
        assertNull(
            "read-write open needs the write flag",
            PickerResults.accept(Activity.RESULT_OK, result(listOf(writable), read), request(MODE_OPEN, PERMISSION_MODE_READ_WRITE), policy),
        )
        val notTree = document("primary:Download")
        assertNull("folder needs a tree URI", PickerResults.accept(Activity.RESULT_OK, result(listOf(notTree)), request(MODE_OPEN_FOLDER), policy))
    }
}
