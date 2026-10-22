package io.github.sillybunnyteam.sillybunny.web

import android.net.Uri
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [37])
class WebNavigationPolicyTest {
    private val port = 41_234

    private fun route(url: String, mainFrame: Boolean = true, gesture: Boolean = true) =
        WebNavigationPolicy.route(Uri.parse(url), port, mainFrame, gesture)

    @Test
    fun onlyTheExactSchemeHostAndPortAreTheApp() {
        assertTrue(WebNavigationPolicy.isAppUrl(Uri.parse("http://127.0.0.1:41234/"), port))
        assertTrue(WebNavigationPolicy.isAppUrl(Uri.parse("http://127.0.0.1:41234/chats?x=1#top"), port))
        assertTrue(WebNavigationPolicy.isAppUrl(Uri.parse("HTTP://127.0.0.1:41234/"), port))
        listOf(
            "http://127.0.0.1:41235/",
            "https://127.0.0.1:41234/",
            "http://localhost:41234/",
            "http://[::1]:41234/",
            "http://user@127.0.0.1:41234/",
            "http://127.0.0.1/",
            "ws://127.0.0.1:41234/",
            "blob:http://127.0.0.1:41234/0f3a",
            "data:text/html,x",
            "file:///sdcard/x",
        ).forEach { assertFalse(it, WebNavigationPolicy.isAppUrl(Uri.parse(it), port)) }
        assertFalse(WebNavigationPolicy.isAppUrl(null, port))
    }

    @Test
    fun theAppOriginStaysInApp() {
        assertEquals(WebRoute.InApp, route("http://127.0.0.1:41234/x"))
        assertEquals(WebRoute.InApp, route("http://127.0.0.1:41234/x", mainFrame = false))
        assertEquals(WebRoute.InApp, route("http://127.0.0.1:41234/callback/openrouter?code=1", gesture = false))
    }

    @Test
    fun externalPagesOpenOutsideOnlyFromTheMainFrame() {
        assertEquals(WebRoute.External, route("https://openrouter.ai/auth?callback_url=x"))
        // Some frontend navigations start after awaited work, without a fresh gesture.
        assertEquals(WebRoute.External, route("http://example.com/", gesture = false))
        assertEquals(WebRoute.External, route("http://localhost:41234/"))
        assertEquals(WebRoute.InApp, route("https://www.youtube.com/embed/x", mainFrame = false))
    }

    @Test
    fun otherLoopbackPortsAreNeitherLoadedNorHandedOff() {
        listOf("http://127.0.0.1:41235/", "https://127.0.0.1:41234/", "http://127.0.0.1/", "https://127.0.0.1/").forEach {
            assertEquals(it, WebRoute.Block, route(it))
            assertEquals(it, WebRoute.Block, route(it, mainFrame = false))
        }
    }

    @Test
    fun otherSchemesFollowAShortAllowlistAndIntentUrlsAreNeverParsed() {
        assertEquals(WebRoute.External, route("mailto:someone@example.com"))
        assertEquals(WebRoute.External, route("tel:+15550100"))
        assertEquals(WebRoute.Block, route("mailto:someone@example.com", gesture = false))
        assertEquals(WebRoute.Block, route("tel:+15550100", mainFrame = false))
        listOf(
            "intent://scan/#Intent;scheme=zxing;package=com.example;end",
            "intent:#Intent;action=android.intent.action.DIAL;end",
            "android-app://com.example/https/example.com/",
            "market://details?id=com.example",
            "sms:5550100",
            "javascript:alert(1)",
            "file:///data/data/x",
            "content://io.github.sillybunnyteam.sillybunny.documents/x",
            "chrome://crash",
            "about:blank",
            "blob:http://127.0.0.1:41234/0f3a",
            "data:text/plain,hi",
            "ftp://example.com/",
            "ws://example.com/",
            "http:///nohost",
            "nonsense",
        ).forEach { assertEquals(it, WebRoute.Block, route(it)) }
    }

    @Test
    fun subframesMayHoldGeneratedContentButNothingElse() {
        listOf("about:blank", "about:srcdoc", "data:text/html,x", "blob:http://127.0.0.1:41234/0f3a").forEach {
            assertEquals(it, WebRoute.InApp, route(it, mainFrame = false))
        }
        listOf("intent:#Intent;end", "file:///x", "content://x/y", "javascript:1", "mailto:a@b.c").forEach {
            assertEquals(it, WebRoute.Block, route(it, mainFrame = false))
        }
    }

    @Test
    fun theLaunchCookieWouldLeakOnlyToOtherLoopbackPorts() {
        listOf(
            "http://127.0.0.1:41235/x",
            "https://127.0.0.1:443/",
            "http://127.0.0.1/",
            "ws://127.0.0.1:9000/",
            "wss://127.0.0.1:9000/",
        ).forEach { assertTrue(it, WebNavigationPolicy.leaksLaunchCookie(Uri.parse(it), port)) }
        listOf(
            "http://127.0.0.1:41234/x",
            "ws://127.0.0.1:41234/",
            "https://example.com/",
            "http://localhost:41235/",
            "data:text/plain,x",
            "blob:http://127.0.0.1:41235/x",
        ).forEach { assertFalse(it, WebNavigationPolicy.leaksLaunchCookie(Uri.parse(it), port)) }
    }
}
