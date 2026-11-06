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
class WebNavigationPolicyTest {
    private val host = "$LABEL.localhost"
    private val app = AppOrigin(host, 41_234)
    private val openRouter = Uri.parse(WebNavigationPolicy.OPENROUTER_ORIGIN)

    private fun route(url: String, mainFrame: Boolean = true, gesture: Boolean = true) =
        WebNavigationPolicy.route(Uri.parse(url), app, mainFrame, gesture)

    private fun refuses(url: String, origin: AppOrigin? = app) = WebNavigationPolicy.refusesRequest(Uri.parse(url), origin)

    @Test
    fun onlyTheExactSchemeHostAndPortAreTheApp() {
        assertTrue(WebNavigationPolicy.isAppUrl(Uri.parse("http://$host:41234/"), app))
        assertTrue(WebNavigationPolicy.isAppUrl(Uri.parse("http://$host:41234/chats?x=1#top"), app))
        assertTrue(WebNavigationPolicy.isAppUrl(Uri.parse("HTTP://${host.uppercase()}:41234/"), app))
        listOf(
            "http://$host:41235/",
            "https://$host:41234/",
            "http://$host/",
            "http://$host.:41234/",
            "http://x.$host:41234/",
            "http://user@$host:41234/",
            "ws://$host:41234/",
            // The server's native address is not the web origin.
            "http://127.0.0.1:41234/",
            "http://localhost:41234/",
            "http://sb-other.localhost:41234/",
            "http://[::1]:41234/",
            "blob:http://$host:41234/0f3a",
            "data:text/html,x",
            "file:///sdcard/x",
        ).forEach { assertFalse(it, WebNavigationPolicy.isAppUrl(Uri.parse(it), app)) }
        assertFalse(WebNavigationPolicy.isAppUrl(null, app))
    }

    @Test
    fun theAppOriginHidesItsHostWhenPrinted() {
        assertEquals("http://$host:41234", app.url)
        assertFalse(app.toString().contains(LABEL))
        assertEquals(app, AppOrigin(host.uppercase(), 41_234))
    }

    @Test
    fun theAppOriginStaysInApp() {
        assertEquals(WebRoute.InApp, route("http://$host:41234/x"))
        assertEquals(WebRoute.InApp, route("http://$host:41234/x", mainFrame = false))
        assertEquals(WebRoute.InApp, route("http://$host:41234/callback/openrouter?code=1", gesture = false))
    }

    @Test
    fun externalPagesOpenOutsideOnlyFromTheMainFrame() {
        assertEquals(WebRoute.External, route("https://openrouter.ai/auth?callback_url=x"))
        // Some frontend navigations start after awaited work, without a fresh gesture.
        assertEquals(WebRoute.External, route("http://example.com/", gesture = false))
        assertEquals(WebRoute.External, route("http://192.168.1.20:5000/"))
        assertEquals(WebRoute.InApp, route("https://www.youtube.com/embed/x", mainFrame = false))
    }

    @Test
    fun localNamesAreNeitherLoadedNorHandedOff() {
        listOf(
            "http://127.0.0.1:41234/",
            "http://127.0.0.1:41235/",
            "https://127.0.0.1/",
            "http://127.8.9.10:80/",
            "http://0.0.0.0:41234/",
            "http://localhost:41234/",
            "http://LOCALHOST:41235/",
            "http://localhost.:41235/",
            "http://other.localhost:41235/",
            "http://$host:41235/",
            "https://$host:41234/",
            "http://[::1]:41235/",
            "http://[::ffff:127.0.0.1]:41235/",
            "http://[::]:41235/",
            "http://127.1:41235/",
            "http://2130706433:41235/",
            "http://0x7f.0.0.1:41235/",
            "http://0177.0.0.1:41235/",
        ).forEach {
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
            "blob:http://$host:41234/0f3a",
            "data:text/plain,hi",
            "ftp://example.com/",
            "ws://example.com/",
            "http:///nohost",
            "nonsense",
        ).forEach { assertEquals(it, WebRoute.Block, route(it)) }
    }

    @Test
    fun subframesMayHoldGeneratedContentButNothingElse() {
        listOf("about:blank", "about:srcdoc", "data:text/html,x", "blob:http://$host:41234/0f3a").forEach {
            assertEquals(it, WebRoute.InApp, route(it, mainFrame = false))
        }
        listOf("intent:#Intent;end", "file:///x", "content://x/y", "javascript:1", "mailto:a@b.c").forEach {
            assertEquals(it, WebRoute.Block, route(it, mainFrame = false))
        }
    }

    @Test
    fun requestsToLocalNamesAreRefusedExceptTheAppOrigin() {
        listOf(
            "http://$host:41235/x",
            "ws://$host:9000/",
            "https://$host:443/",
            "http://127.0.0.1:41234/x",
            "http://127.0.0.1:41235/x",
            "https://127.0.0.1:443/",
            "ws://127.0.0.1:9000/",
            "wss://127.0.0.1:9000/",
            "http://localhost:41235/",
            "http://sb-other.localhost:41234/",
            "http://0.0.0.0:41235/",
            "http://[::1]:41235/",
            "http://127.1:41235/",
        ).forEach { assertTrue(it, refuses(it)) }
        listOf(
            "http://$host:41234/x",
            "ws://$host:41234/",
            "https://example.com/",
            "http://example.com:41235/",
            "http://192.168.1.20:5000/",
            "data:text/plain,x",
            "blob:http://$host:41235/x",
            "about:blank",
        ).forEach { assertFalse(it, refuses(it)) }
        // Before a session exists, every local request is refused.
        assertTrue(refuses("http://$host:41234/x", origin = null))
        assertFalse(refuses("https://example.com/", origin = null))
    }

    @Test
    fun localNamesAreRecognised() {
        listOf("localhost", "LOCALHOST", "localhost.", "a.b.localhost", "127.0.0.1", "127.255.0.9", "0.0.0.0", "[::1]", "::", "fe80::1", "127.1", "0x7f000001", "017700000001")
            .forEach { assertTrue(it, WebNavigationPolicy.isLocalHost(it)) }
        listOf("example.com", "localhost.example.com", "notlocalhost", "192.168.1.20", "10.0.2.2", "8.8.8.8", "openrouter.ai")
            .forEach { assertFalse(it, WebNavigationPolicy.isLocalHost(it)) }
    }

    @Test
    fun theOpenRouterStartNeedsTheProviderAuthPageAndTheAppsOwnCallback() {
        val callback = Uri.encode("http://$host:41234/callback/openrouter")
        fun starts(url: String) = WebNavigationPolicy.isOpenRouterStart(Uri.parse(url), openRouter, app)
        assertTrue(starts("https://openrouter.ai/auth?callback_url=$callback&code_challenge=abc&code_challenge_method=S256"))
        assertTrue(starts("https://openrouter.ai:443/auth?callback_url=$callback"))
        listOf(
            "http://openrouter.ai/auth?callback_url=$callback",
            "https://evil.openrouter.ai/auth?callback_url=$callback",
            "https://openrouter.ai.evil.example/auth?callback_url=$callback",
            "https://openrouter.ai/keys?callback_url=$callback",
            "https://openrouter.ai/auth",
            "https://openrouter.ai/auth?callback_url=${Uri.encode("http://$host:41235/callback/openrouter")}",
            "https://openrouter.ai/auth?callback_url=${Uri.encode("http://127.0.0.1:41234/callback/openrouter")}",
            "https://openrouter.ai/auth?callback_url=${Uri.encode("http://$host:41234/callback/other")}",
            "https://openrouter.ai/auth?callback_url=$callback&callback_url=$callback",
            "https://user@openrouter.ai/auth?callback_url=$callback",
        ).forEach { assertFalse(it, starts(it)) }
    }

    @Test
    fun theOpenRouterReturnIsWhatTheServersCallbackRouteLeadsTo() {
        fun back(url: String) = WebNavigationPolicy.openRouterReturn(Uri.parse(url), app)
        // src/server-main.js: `/callback/:source?` answers 307 to `/?` + URLSearchParams({ source, query }).
        assertEquals("http://$host:41234/?source=openrouter&query=code%3Dabc-123", back("http://$host:41234/callback/openrouter?code=abc-123"))
        // Like URLSearchParams: escapes are encoded again, `+` becomes %2B and a space `+`.
        assertEquals(
            "http://$host:41234/?source=openrouter&query=code%3Da%252Bb%25C3%25A9%26state%3Dx%2By",
            back("http://$host:41234/callback/openrouter?code=a%2Bb%C3%A9&state=x+y"),
        )
        assertEquals("http://$host:41234/?source=openrouter&query=a%3Dx+y", back("http://$host:41234/callback/openrouter?a=x y"))
        // The query is the text between the first and the second `?`; the fragment never reaches the server.
        assertEquals("http://$host:41234/?source=openrouter&query=code%3D1", back("http://$host:41234/callback/openrouter?code=1?more#frag"))
        assertEquals("http://$host:41234/?source=openrouter", back("http://$host:41234/callback/openrouter"))
        assertEquals("http://$host:41234/?source=openrouter", back("http://$host:41234/callback/openrouter?"))
        assertNull(back("http://$host:41234/callback/other?code=1"))
        assertNull(back("http://$host:41235/callback/openrouter?code=1"))
        assertNull(back("http://127.0.0.1:41234/callback/openrouter?code=1"))
        assertNull(back("https://openrouter.ai/callback/openrouter?code=1"))
    }

    @Test
    fun sameOriginComparesSchemeHostAndEffectivePort() {
        assertTrue(WebNavigationPolicy.isSameOrigin(Uri.parse("https://openrouter.ai/x"), openRouter))
        assertTrue(WebNavigationPolicy.isSameOrigin(Uri.parse("https://OpenRouter.ai:443/"), openRouter))
        listOf("http://openrouter.ai/", "https://openrouter.ai:8443/", "https://www.openrouter.ai/", "https://a@openrouter.ai/", "about:blank")
            .forEach { assertFalse(it, WebNavigationPolicy.isSameOrigin(Uri.parse(it), openRouter)) }
        assertFalse(WebNavigationPolicy.isSameOrigin(null, openRouter))
    }

    private companion object {
        const val LABEL = "sb-abcdefghijklmnopqrstuvwxyz"
    }
}
