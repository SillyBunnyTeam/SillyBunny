package io.github.sillybunnyteam.sillybunny.server

import com.sun.net.httpserver.HttpServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import java.net.InetSocketAddress
import java.util.Collections

class HealthProbeTest {
    private val token = LaunchTokens.generate()
    private val requests: MutableList<Pair<String, String?>> = Collections.synchronizedList(mutableListOf())
    private lateinit var server: HttpServer
    private var port = 0

    @Before
    fun startGate() {
        // A JDK server playing the launch-token gate: 204 only with the exact cookie, otherwise 403.
        val socket = TestPorts.bindLoopback()
        port = socket.localPort
        socket.close()
        server = HttpServer.create(InetSocketAddress("127.0.0.1", port), 0)
        server.createContext("/") { exchange ->
            val cookie = exchange.requestHeaders.getFirst("Cookie")
            requests += exchange.requestURI.toString() to cookie
            val status = when {
                exchange.requestURI.path != HealthProbe.PATH -> 404
                cookie == "${LaunchSession.COOKIE_NAME}=$token" -> 204
                else -> 403
            }
            exchange.sendResponseHeaders(status, -1)
            exchange.close()
        }
        server.start()
    }

    @After
    fun stopGate() {
        server.stop(0)
    }

    @Test
    fun theProbeIsHealthyOnlyWithTheLaunchCookie() {
        val probe = HealthProbe()

        assertEquals(HealthProbe.HEALTHY, probe.status(port, token))
        assertEquals(403, probe.status(port, LaunchTokens.generate()))
        assertEquals(403, probe.status(port, null))

        assertEquals(HealthProbe.PATH to "sillybunny_launch=$token", requests[0])
        assertNull(requests[2].second)
    }

    @Test
    fun nothingListeningIsUnreachable() {
        server.stop(0)

        assertEquals(HealthProbe.UNREACHABLE, HealthProbe(connectTimeoutMillis = 500).status(port, token))
    }

    @Test
    fun aStalledServerTimesOutAsUnreachable() {
        TestPorts.bindLoopback().use { silent ->
            // Accepts the connection (backlog) but never answers.
            assertEquals(
                HealthProbe.UNREACHABLE,
                HealthProbe(connectTimeoutMillis = 500, readTimeoutMillis = 300).status(silent.localPort, token),
            )
        }
    }

    @Test
    fun redirectsAreNeverFollowed() {
        server.removeContext("/")
        server.createContext("/") { exchange ->
            requests += exchange.requestURI.toString() to exchange.requestHeaders.getFirst("Cookie")
            exchange.responseHeaders.add("Location", "/elsewhere")
            exchange.sendResponseHeaders(302, -1)
            exchange.close()
        }

        assertEquals(302, HealthProbe().status(port, token))
        assertEquals(listOf(HealthProbe.PATH), requests.map { it.first })
    }
}
