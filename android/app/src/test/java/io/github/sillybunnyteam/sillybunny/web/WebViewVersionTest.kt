package io.github.sillybunnyteam.sillybunny.web

import android.net.Uri
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [37])
class WebViewVersionTest {
    @Test
    fun parsesThePlainLeadingMajorNumber() {
        assertEquals(120, WebViewVersion.parseMajor("120.0.6099.230"))
        assertEquals(74, WebViewVersion.parseMajor("74.0.3729.186"))
        assertEquals(111, WebViewVersion.parseMajor("111"))
        assertEquals(111, WebViewVersion.parseMajor(" 111.0 "))
    }

    @Test
    fun unknownAndMalformedVersionsStayUnknown() {
        listOf(null, "", " ", "abc", "v120.0", "-5.0", "1234567.0", "120a.1", ".120", "１２０.0", "12 0.1").forEach {
            assertNull("$it", WebViewVersion.parseMajor(it))
        }
    }

    @Test
    fun onlyAKnownOldMajorWarns() {
        assertFalse(WebViewVersion.isBelowMinimum(null))
        assertTrue(WebViewVersion.isBelowMinimum(WebViewVersion.MINIMUM_MAJOR - 1))
        assertFalse(WebViewVersion.isBelowMinimum(WebViewVersion.MINIMUM_MAJOR))
        assertFalse(WebViewVersion.isBelowMinimum(150))
        assertEquals(111, WebViewVersion.MINIMUM_MAJOR)
    }

    @Test
    fun updateLinksPointAtTheCurrentProviderOnly() {
        assertEquals(
            listOf(
                Uri.parse("market://details?id=com.google.android.webview"),
                Uri.parse("https://play.google.com/store/apps/details?id=com.google.android.webview"),
            ),
            WebViewVersion.updateUris("com.google.android.webview"),
        )
        listOf(null, "", "webview", "com.example&x=y", "com.example/../x", "1com.example", "com..example").forEach {
            assertTrue("$it", WebViewVersion.updateUris(it).isEmpty())
        }
    }
}
