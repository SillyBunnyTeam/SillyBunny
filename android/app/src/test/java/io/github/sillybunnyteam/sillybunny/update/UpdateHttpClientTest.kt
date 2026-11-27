package io.github.sillybunnyteam.sillybunny.update

import java.io.File
import java.io.IOException
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29])
class UpdateHttpClientTest {
    @get:Rule
    val temporary = TemporaryFolder()
    private lateinit var server: UpdateTestServer
    private val client = UpdateHttpClient(allowDebugLoopback = true)

    @Before
    fun setUp() {
        server = UpdateTestServer()
    }

    @After
    fun tearDown() {
        server.close()
    }

    @Test
    fun fetchesJsonButRejectsCleartextRedirectsEvenForDebugFixtures() {
        server.json("/data", "{\"value\":\"é\"}")
        assertEquals("{\"value\":\"é\"}", client.fetchJson(server.url("/data")))
        for ((index, status) in listOf(301, 302, 303, 307, 308).withIndex()) {
            server.redirect("/redirect$index", "/data", status)
            assertThrows(IOException::class.java) { client.fetchJson(server.url("/redirect$index")) }
        }
        assertEquals(6, server.requests.size)
    }

    @Test
    fun releasePolicyRejectsAllHttpAndDebugAllowsOnlyExactLoopback() {
        val release = UpdateHttpClient(allowDebugLoopback = false)
        server.json("/data", "{}")
        assertThrows(IOException::class.java) { release.fetchJson(server.url("/data")) }
        assertTrue(server.requests.isEmpty())
        assertTrue(release.isAllowedUrl("https://github.com/releases/android-update.json"))
        for (url in listOf(
            "http://localhost:1234/data", "http://127.0.0.2/data", "http://[::1]/data",
            "http://127.1/data", "http://2130706433/data", "http://0177.0.0.1/data",
            "http://127.0.0.1.example.test/data", "http://user@127.0.0.1/data",
            "http://127.0.0.1/data#fragment", "http://127.0.0.1:0/data",
            "http://127.0.0.1:65536/data", "HTTP://127.0.0.1/data", "file:///data",
            "https://example.test\\@127.0.0.1/data", "https://example.test/data\r\nHeader:value",
            "https://example.test/" + "a".repeat(8_192),
        )) assertFalse(url.take(100), client.isAllowedUrl(url))
    }

    @Test
    fun neverAllowsHttpsDowngradeEvenToDebugFixtures() {
        assertFalse(client.redirectAllowed("https://github.com/manifest", server.url("/data")))
        assertFalse(client.redirectAllowed("https://github.com/manifest", "http://github.com/apk"))
        assertTrue(client.redirectAllowed("https://github.com/manifest", "https://objects.githubusercontent.com/blob?token=test"))
        assertFalse(client.redirectAllowed("https://github.com/manifest", "https://user@objects.githubusercontent.com/blob"))
        assertFalse(client.redirectAllowed(server.url("/data"), "https://example.test/data"))
    }

    @Test
    fun fixtureRedirectsCannotChangeOriginOrUseLocalhostAliases() {
        UpdateTestServer().use { other ->
            other.json("/data", "{}")
            server.redirect("/other-port", other.url("/data"))
            server.redirect("/alias", server.url("/data").replace("127.0.0.1", "localhost"))
            assertThrows(IOException::class.java) { client.fetchJson(server.url("/other-port")) }
            assertThrows(IOException::class.java) { client.fetchJson(server.url("/alias")) }
            assertTrue(other.requests.isEmpty())
        }
    }

    @Test
    fun rejectsCleartextLoopsAndAbsentMalformedOrUnsuccessfulResponses() {
        server.redirect("/loop", "/loop")
        assertThrows(IOException::class.java) { client.fetchJson(server.url("/loop")) }
        assertEquals(1, server.requests.size)
        server.handle("/missing-location") { it.sendResponseHeaders(302, -1) }
        server.redirect("/invalid-location", "http://[invalid")
        server.bytes("/partial", "{}".toByteArray(), status = 206)
        server.handle("/empty") { it.sendResponseHeaders(204, -1) }
        for (path in listOf("/missing-location", "/invalid-location", "/partial", "/empty", "/not-found")) {
            assertThrows(path, Exception::class.java) { client.fetchJson(server.url(path)) }
        }
    }

    @Test
    fun enforcesJsonLimitForContentLengthAndChunkedBodiesAtByteBoundary() {
        val boundary = ByteArray(UpdateJson.MAX_BYTES) { ' '.code.toByte() }
        server.bytes("/boundary", boundary)
        server.bytes("/large-header", boundary + byteArrayOf(32))
        server.bytes("/large-chunked", boundary + byteArrayOf(32), chunked = true)
        assertEquals(UpdateJson.MAX_BYTES, client.fetchJson(server.url("/boundary")).length)
        assertThrows(IOException::class.java) { client.fetchJson(server.url("/large-header")) }
        assertThrows(IOException::class.java) { client.fetchJson(server.url("/large-chunked")) }
    }

    @Test
    fun rejectsMalformedUtf8AndUnexpectedCompression() {
        server.bytes("/utf8", byteArrayOf(0xc3.toByte(), 0x28))
        server.handle("/encoded") { exchange ->
            exchange.responseHeaders.set("Content-Encoding", "gzip")
            exchange.sendResponseHeaders(200, 2)
            exchange.responseBody.use { it.write("{}".toByteArray()) }
        }
        assertThrows(Exception::class.java) { client.fetchJson(server.url("/utf8")) }
        assertThrows(IOException::class.java) { client.fetchJson(server.url("/encoded")) }
    }

    @Test
    fun readTimeoutIsFinite() {
        server.handle("/slow") { exchange ->
            exchange.sendResponseHeaders(200, 0)
            Thread.sleep(300)
            exchange.responseBody.use { it.write("{}".toByteArray()) }
        }
        val shortTimeout = UpdateHttpClient(allowDebugLoopback = true, connectTimeoutMillis = 100, readTimeoutMillis = 50)
        assertThrows(IOException::class.java) { shortTimeout.fetchJson(server.url("/slow")) }
    }

    @Test
    fun streamsApkWithExactSizeSha256AndMonotonicProgress() {
        val payload = CoreTestFixtures.payload
        server.bytes("/apk", payload, chunked = true)
        val file = File(temporary.root, "update.part")
        val progress = mutableListOf<Pair<Long, Long>>()
        client.download(server.url("/apk"), file, payload.size.toLong(), CoreTestFixtures.hash(payload)) { received, size ->
            progress.add(received to size)
        }
        assertTrue(file.readBytes().contentEquals(payload))
        assertEquals(0L to payload.size.toLong(), progress.first())
        assertEquals(payload.size.toLong() to payload.size.toLong(), progress.last())
        assertTrue(progress.zipWithNext().all { (a, b) -> a.first <= b.first })
        assertTrue(progress.all { it.second == payload.size.toLong() && it.first <= it.second })
    }

    @Test
    fun rejectsShortLongWrongHashAndOversizeApksAndDeletesPartialFile() {
        val payload = CoreTestFixtures.payload
        server.bytes("/short", payload.copyOf(payload.size - 1), chunked = true)
        server.bytes("/long", payload + byteArrayOf(1), chunked = true)
        server.bytes("/wrong-length-header", payload + byteArrayOf(1))
        server.bytes("/wrong-hash", payload)
        for (path in listOf("/short", "/long", "/wrong-length-header", "/wrong-hash")) {
            val file = temporary.newFile("${path.drop(1)}.part")
            assertThrows(IOException::class.java) {
                client.download(
                    server.url(path), file, payload.size.toLong(),
                    if (path == "/wrong-hash") "00".repeat(32) else CoreTestFixtures.hash(payload),
                )
            }
            assertFalse(path, file.exists())
        }
        val requestsBefore = server.requests.size
        for (size in listOf(0L, -1L, UpdateManifestParser.MAX_APK_BYTES + 1)) {
            val file = temporary.newFile()
            assertThrows(IOException::class.java) { client.download(server.url("/apk"), file, size, CoreTestFixtures.hash(payload)) }
            assertFalse(file.exists())
        }
        assertEquals(requestsBefore, server.requests.size)
    }

    @Test
    fun cleansPartialOnNetworkFailureOrProgressCallbackFailure() {
        server.bytes("/apk", CoreTestFixtures.payload)
        val file = temporary.newFile("failure.part")
        assertThrows(IllegalStateException::class.java) {
            client.download(server.url("/apk"), file, CoreTestFixtures.payload.size.toLong(), CoreTestFixtures.hash(CoreTestFixtures.payload)) { received, _ ->
                if (received > 0) throw IllegalStateException()
            }
        }
        assertFalse(file.exists())
        assertThrows(IOException::class.java) { client.download(server.url("/missing"), file, 1, "00".repeat(32)) }
        assertFalse(file.exists())
    }
}
