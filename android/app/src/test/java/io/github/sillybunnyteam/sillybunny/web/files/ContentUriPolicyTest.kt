package io.github.sillybunnyteam.sillybunny.web.files

import android.content.Context
import android.content.ContextWrapper
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Process
import android.provider.DocumentsContract
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Which picker results the page or a save may use (plan §4.5). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29, 37])
class ContentUriPolicyTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val app = context.packageName
    private val read = ContentUriPolicy.READ
    private val write = ContentUriPolicy.WRITE

    @Test
    fun onlyContentUrisOfOtherProvidersAreForeign() {
        val policy = ContentUriPolicy(context, ownAuthorities = { setOf("org.example.shared.app.provider") }) { _, _ -> true }
        val foreign = listOf(
            "content://com.android.externalstorage.documents/document/primary%3Aa.json",
            "content://com.android.providers.downloads.documents/document/14",
            "content://media/external/downloads/52",
            "CONTENT://media/external/file/1",
            "content://10@com.android.externalstorage.documents/document/x",
        )
        for (uri in foreign) assertTrue(uri, policy.isForeignContent(Uri.parse(uri)))
        val refused = listOf(
            "file:///data/data/$app/files/x", "file:///sdcard/Download/x.json", "https://example.com/x", "x.json", "content:///nohost",
            "content://$app/x", "content://${app.uppercase()}/x", "content://$app.files/logs/x", "content://$app.documents/document/x",
            "content://10@$app.files/x", "content://org.example.shared.app.provider/x", "content://ORG.EXAMPLE.SHARED.APP.PROVIDER/x",
        )
        for (uri in refused) assertFalse(uri, policy.isForeignContent(Uri.parse(uri)))
    }

    @Test
    fun grantsMustBeFlaggedAndHeld() {
        val asked = mutableListOf<Int>()
        var holds = true
        val policy = ContentUriPolicy(context, ownAuthorities = { emptySet() }) { _, needed ->
            asked += needed
            holds
        }
        val uri = Uri.parse("content://com.android.externalstorage.documents/document/primary%3Aa.json")
        assertTrue(policy.hasGrant(uri, read, read))
        assertTrue(policy.hasGrant(uri, read or write, read or write))
        assertEquals(listOf(read, read or write), asked)
        assertFalse("flags lack write", policy.hasGrant(uri, read, read or write))
        assertFalse("flags lack read", policy.hasGrant(uri, write, read))
        assertEquals("the system is not asked when flags already fail", 2, asked.size)
        holds = false
        assertFalse("flagged but not held", policy.hasGrant(uri, read, read))
    }

    @Test
    fun defaultGrantCheckAsksTheSystem() {
        val asked = mutableListOf<String>()
        var answer = PackageManager.PERMISSION_DENIED
        val system = object : ContextWrapper(context) {
            override fun checkUriPermission(uri: Uri, pid: Int, uid: Int, modeFlags: Int): Int {
                asked += "$uri $pid $uid $modeFlags"
                return answer
            }
        }
        val policy = ContentUriPolicy(system, ownAuthorities = { emptySet() })
        val uri = DocumentsContract.buildDocumentUri("com.android.externalstorage.documents", "primary:granted.json")
        assertFalse("flagged, but the system reports no grant", policy.hasGrant(uri, read, read))
        answer = PackageManager.PERMISSION_GRANTED
        assertTrue(policy.hasGrant(uri, read or write, read or write))
        val self = "${Process.myPid()} ${Process.myUid()}"
        assertEquals("this process is asked for exactly the needed access", listOf("$uri $self $read", "$uri $self ${read or write}"), asked)
    }

    @Test
    fun declaredProvidersAreOwnAuthorities() {
        val declared = ContentUriPolicy.declaredAuthorities(context)
        assertTrue(declared.toString(), "$app.files" in declared && "$app.documents" in declared)
        val policy = ContentUriPolicy(context) { _, _ -> true }
        assertTrue(policy.isOwnAuthority("$app.files"))
        assertFalse(policy.isForeignContent(Uri.parse("content://$app.files/x")))
    }
}
