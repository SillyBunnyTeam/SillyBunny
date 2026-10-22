package io.github.sillybunnyteam.sillybunny.web.downloads

import java.net.URI
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Cookie and redirect rules for app-owned downloads (plan §3.3, §4.5). */
class DownloadPolicyTest {
    private val app = WebOrigin("http", "127.0.0.1", 41234)
    private val policy = DownloadPolicy(app)
    private val base = "http://127.0.0.1:41234"

    @Test
    fun originsUseExplicitPorts() {
        assertEquals(WebOrigin("http", "example.com", 80), WebOrigin.parse("HTTP://Example.COM/a"))
        assertEquals(WebOrigin("https", "example.com", 443), WebOrigin.parse("https://example.com"))
        assertEquals(WebOrigin.parse("http://h/"), WebOrigin.parse("http://h:80/"))
        assertEquals(WebOrigin("http", "::1", 8080), WebOrigin.of(URI("http://[::1]:8080/")))
        assertEquals("http://127.0.0.1:41234", app.toString())
        assertNull(WebOrigin.parse("ftp://example.com/"))
    }

    @Test
    fun parseAcceptsOnlyAbsoluteHttpWithoutCredentials() {
        assertNotNull(DownloadPolicy.parse("$base/a?b=c"))
        assertEquals("$base/a", DownloadPolicy.parse("$base/a#frag").toString())
        for (bad in listOf(
            "", "/relative", "mailto:x@example.com", "javascript:alert(1)", "file:///etc/passwd", "blob:$base/id",
            "http://user:pass@127.0.0.1:41234/", "http:///nohost", "http://127.0.0.1:0/", "http://127.0.0.1:65536/",
            "http://127.0.0.1:41234/a b", "http://127.0.0.1:41234/a\tb", "http://127.0.0.1:41234\\@evil.com/",
            "http://127.0.0.1:41234/\u007f", "http://" + "a".repeat(8_200),
        )) {
            assertNull(bad, DownloadPolicy.parse(bad))
        }
    }

    @Test
    fun whatwgLegalCharactersAreEscapedAfterTheAuthority() {
        val parsed = checkNotNull(DownloadPolicy.parse("$base/a|b^c?q={x}&r=[1]`\"<>"))
        assertEquals("127.0.0.1", parsed.host)
        assertEquals("/a%7Cb%5Ec", parsed.rawPath)
        assertEquals("q=%7Bx%7D&r=%5B1%5D%60%22%3C%3E", parsed.rawQuery)
        assertEquals("http://[::1]:80/a%7C", DownloadPolicy.escapeForUri("http://[::1]:80/a|"))
        assertEquals("untouched when nothing needs escaping", "$base/a%20b", DownloadPolicy.escapeForUri("$base/a%20b"))
    }

    @Test
    fun startSendsCookiesOnlyToTheExactAppOrigin() {
        val own = checkNotNull(policy.start("$base/backups/x.zip"))
        assertTrue(own.sendCookies)
        assertFalse(own.leftApp)
        assertNull("another loopback port", policy.start("http://127.0.0.1:41235/x"))
        assertNull("same port, other loopback name", policy.start("http://localhost:41234/x"))
        assertNull("https on the app port is another origin", policy.start("https://127.0.0.1:41234/x"))
        assertNull("public cleartext", policy.start("http://example.com/x"))
        val public = checkNotNull(policy.start("https://example.com/file.png"))
        assertFalse(public.sendCookies)
        assertTrue(public.leftApp)
        for (local in listOf(
            "https://localhost/x", "https://a.localhost/x", "https://127.0.0.1/x", "https://127.1/x",
            "https://2130706433/x", "https://0x7f.1/x", "https://0177.0.0.1/x", "https://012.0.0.1/x", "https://[::1]/x",
            "https://[::ffff:127.0.0.1]/x", "https://10.0.0.2/x", "https://192.168.1.10/x", "https://172.16.5.4/x",
            "https://169.254.169.254/x", "https://100.64.0.1/x", "https://0.0.0.0/x", "https://224.0.0.1/x",
        )) {
            assertNull(local, policy.start(local))
        }
    }

    @Test
    fun redirectsAreCheckedPerHop() {
        val first = checkNotNull(policy.start("$base/redirect"))
        val same = checkNotNull(policy.redirect(first, "/bytes?n=1"))
        assertEquals("$base/bytes?n=1", same.url.toString())
        assertTrue(same.sendCookies)
        assertNull("other loopback port", policy.redirect(first, "http://127.0.0.1:41235/x"))
        assertNull("other port on localhost", policy.redirect(first, "http://localhost:4444/x"))
        assertNull("private address", policy.redirect(first, "https://192.168.0.1/x"))
        val outside = checkNotNull(policy.redirect(first, "https://cdn.example.com/x"))
        assertFalse(outside.sendCookies)
        assertTrue(outside.leftApp)
        assertNull("a chain that left never returns", policy.redirect(outside, "$base/x"))
        val relative = checkNotNull(policy.redirect(outside, "/x"))
        assertEquals("https://cdn.example.com/x", relative.url.toString())
        assertFalse(relative.sendCookies)
        val further = checkNotNull(policy.redirect(outside, "https://other.example.org/y"))
        assertFalse(further.sendCookies)
        assertNull(policy.redirect(first, ""))
        assertNull(policy.redirect(first, "   "))
        assertNull(policy.redirect(first, "http://[bad"))
        assertNull(policy.redirect(first, "/" + "a".repeat(8_200)))
        assertEquals("$base/a%7Cb", policy.redirect(first, "/a|b")?.url.toString())
    }

    @Test
    fun localHostClassification() {
        val local = listOf(
            "localhost", "LOCALHOST.", "x.localhost", "127.0.0.1", "127.255.255.254", "0.0.0.0", "10.1.2.3",
            "172.16.0.1", "172.31.255.255", "192.168.0.1", "169.254.1.1", "100.64.0.1", "100.127.255.255",
            "224.0.0.1", "255.255.255.255", "1.2.3", "1.2.3.4.5", "2130706433", "0x7f000001", "0x7f.0.0.1",
            "127.0x0.0.1", "0177.0.0.1", "010.0.0.1", "8.8.8.08", "1.2.3.256", "[::1]", "::1", "fe80::1", "",
        )
        for (host in local) assertTrue(host, DownloadPolicy.isLocalHost(host))
        val public = listOf("8.8.8.8", "172.32.0.1", "100.128.0.1", "192.169.0.1", "example.com", "1.0.0.1", "203.0.113.0", "a0.example")
        for (host in public) assertFalse(host, DownloadPolicy.isLocalHost(host))
    }

    @Test
    fun transferKeysDropFragmentsForHttpOnly() {
        assertEquals("$base/a", TransferKeys.of("$base/a#x"))
        assertEquals("blob:$base/id#x", TransferKeys.of("blob:$base/id#x"))
    }
}
