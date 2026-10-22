package io.github.sillybunnyteam.sillybunny.web.downloads

import com.sun.net.httpserver.HttpServer
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.URI
import java.net.URL
import java.util.concurrent.CopyOnWriteArrayList
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** App-owned GETs: redirects followed by hand and checked per hop, cookies only on app-origin hops. */
class HttpFetchTest {
    private val app = WebOrigin("http", "127.0.0.1", 41234)
    private val policy = DownloadPolicy(app)

    /** A scripted connection: answers with [status], [headers] and [body], and records what was sent. */
    private class FakeConnection(url: URL, private val status: Int, private val headers: Map<String, String>, private val body: ByteArray) :
        HttpURLConnection(url) {
        val sent = LinkedHashMap<String, String>()
        var disconnected = false

        override fun connect() = Unit

        override fun disconnect() {
            disconnected = true
        }

        override fun usingProxy(): Boolean = false

        override fun getResponseCode(): Int = status

        override fun getHeaderField(name: String): String? = headers[name]

        override fun getContentType(): String? = headers["Content-Type"]

        override fun getContentLengthLong(): Long = headers["Content-Length"]?.toLong() ?: -1

        override fun getInputStream(): InputStream = ByteArrayInputStream(body)

        override fun setRequestProperty(key: String, value: String) {
            sent[key] = value
        }
    }

    private class Script(val routes: Map<String, Triple<Int, Map<String, String>, ByteArray>>) {
        val connections = CopyOnWriteArrayList<FakeConnection>()

        fun connect(uri: URI): HttpURLConnection {
            val (status, headers, body) = routes[uri.toString()] ?: throw AssertionError("unexpected request to $uri")
            return FakeConnection(uri.toURL(), status, headers, body).also { connections += it }
        }
    }

    private fun fetch(script: Script, cookies: String? = "sillybunny_launch=t") =
        HttpFetch(policy, { cookies }, "UA/1", connect = script::connect)

    @Test
    fun sameOriginRedirectKeepsCookiesAndGet() {
        val script = Script(
            mapOf(
                "http://127.0.0.1:41234/a" to Triple(302, mapOf("Location" to "/b?x=1"), ByteArray(0)),
                "http://127.0.0.1:41234/b?x=1" to Triple(200, mapOf("Content-Type" to "application/json", "Content-Length" to "2", "Content-Disposition" to "attachment; filename=b.json"), "{}".toByteArray()),
            ),
        )
        val response = checkNotNull(fetch(script).open(checkNotNull(policy.start("http://127.0.0.1:41234/a"))))
        assertEquals("http://127.0.0.1:41234/b?x=1", response.url.toString())
        assertEquals("application/json", response.mime)
        assertEquals("attachment; filename=b.json", response.disposition)
        assertEquals(2, response.length)
        assertEquals(2, script.connections.size)
        for (connection in script.connections) {
            assertEquals("GET", connection.requestMethod)
            assertFalse(connection.instanceFollowRedirects)
            assertFalse(connection.useCaches)
            assertEquals("sillybunny_launch=t", connection.sent["Cookie"])
            assertEquals("identity", connection.sent["Accept-Encoding"])
            assertEquals("UA/1", connection.sent["User-Agent"])
        }
        assertTrue("redirect hop closed", script.connections.first().disconnected)
    }

    @Test
    fun cookiesNeverFollowARedirectOutOfTheApp() {
        val script = Script(
            mapOf(
                "http://127.0.0.1:41234/a" to Triple(307, mapOf("Location" to "https://cdn.example.com/f"), ByteArray(0)),
                "https://cdn.example.com/f" to Triple(200, emptyMap(), "x".toByteArray()),
            ),
        )
        assertTrue(fetch(script).open(checkNotNull(policy.start("http://127.0.0.1:41234/a"))) != null)
        assertEquals("sillybunny_launch=t", script.connections[0].sent["Cookie"])
        assertNull(script.connections[1].sent["Cookie"])
    }

    @Test
    fun refusedHopsAndFailuresEndTheChain() {
        val start = checkNotNull(policy.start("http://127.0.0.1:41234/a"))
        for (location in listOf("http://127.0.0.1:41235/x", "http://localhost:41234/x", "https://192.168.0.2/x", "http://example.com/x")) {
            val script = Script(mapOf("http://127.0.0.1:41234/a" to Triple(302, mapOf("Location" to location), ByteArray(0))))
            assertNull(location, fetch(script).open(start))
            assertEquals("never connected to $location", 1, script.connections.size)
        }
        for (status in listOf(500, 404, 304, 204 + 100)) {
            val script = Script(mapOf("http://127.0.0.1:41234/a" to Triple(status, emptyMap(), ByteArray(0))))
            assertNull("status $status", fetch(script).open(start))
        }
        val noLocation = Script(mapOf("http://127.0.0.1:41234/a" to Triple(302, emptyMap(), ByteArray(0))))
        assertNull(fetch(noLocation).open(start))
    }

    @Test
    fun tooManyRedirects() {
        val routes = (0..6).associate { "http://127.0.0.1:41234/r$it" to Triple(302, mapOf("Location" to "/r${it + 1}"), ByteArray(0)) }
        val script = Script(routes)
        assertNull(fetch(script).open(checkNotNull(policy.start("http://127.0.0.1:41234/r0"))))
        assertEquals(DownloadPolicy.MAX_REDIRECTS + 1, script.connections.size)
    }

    @Test
    fun blankCookiesAndAgentsAreNotSent() {
        val script = Script(mapOf("http://127.0.0.1:41234/a" to Triple(200, emptyMap(), ByteArray(0))))
        HttpFetch(policy, { " " }, null, connect = script::connect).open(checkNotNull(policy.start("http://127.0.0.1:41234/a")))
        assertFalse(script.connections.single().sent.containsKey("Cookie"))
        assertFalse(script.connections.single().sent.containsKey("User-Agent"))
    }

    @Test
    fun copyBoundedEnforcesLimits() {
        val data = ByteArray(200_000) { it.toByte() }
        val out = ByteArrayOutputStream()
        assertEquals(200_000, HttpFetch.copyBounded(ByteArrayInputStream(data), out, 200_000))
        assertArrayEquals(data, out.toByteArray())
        expectIo("too large") { HttpFetch.copyBounded(ByteArrayInputStream(data), ByteArrayOutputStream(), 199_999) }
        expectIo("cancelled") { HttpFetch.copyBounded(ByteArrayInputStream(data), ByteArrayOutputStream(), Long.MAX_VALUE, keepGoing = { false }) }
        expectIo("no space") { HttpFetch.copyBounded(ByteArrayInputStream(data), ByteArrayOutputStream(), Long.MAX_VALUE, hasRoom = { it < 100_000 }) }
    }

    private fun expectIo(message: String, block: () -> Unit) {
        try {
            block()
            fail("expected $message")
        } catch (error: IOException) {
            assertEquals(message, error.message)
        }
    }

    /** The same chain over a real loopback socket. */
    @Test
    fun realServerSeesGetCookiesAndNoAutomaticRedirects() {
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        val seen = CopyOnWriteArrayList<String>()
        server.createContext("/") { exchange ->
            seen += "${exchange.requestMethod} ${exchange.requestURI} cookie=${exchange.requestHeaders.getFirst("Cookie")}"
            if (exchange.requestURI.path == "/start") {
                exchange.responseHeaders.add("Location", "/file")
                exchange.sendResponseHeaders(302, -1)
            } else {
                val body = "payload".toByteArray()
                exchange.responseHeaders.add("Content-Disposition", "attachment; filename=\"p.txt\"")
                exchange.sendResponseHeaders(200, body.size.toLong())
                exchange.responseBody.use { it.write(body) }
            }
            exchange.close()
        }
        server.start()
        try {
            val port = server.address.port
            val local = DownloadPolicy(WebOrigin("http", "127.0.0.1", port))
            val fetch = HttpFetch(local, { "sillybunny_launch=t" }, "UA/1")
            val response = checkNotNull(fetch.open(checkNotNull(local.start("http://127.0.0.1:$port/start"))))
            val body = response.connection.inputStream.use { it.readBytes() }
            response.connection.disconnect()
            assertEquals("payload", body.toString(Charsets.UTF_8))
            assertEquals("attachment; filename=\"p.txt\"", response.disposition)
            assertEquals(listOf("GET /start cookie=sillybunny_launch=t", "GET /file cookie=sillybunny_launch=t"), seen.toList())
        } finally {
            server.stop(0)
        }
    }
}
