package io.github.sillybunnyteam.sillybunny.server

import java.io.IOException
import java.net.HttpURLConnection
import java.net.Proxy
import java.net.URL

/** One health request; returns the HTTP status, or [UNREACHABLE] when nothing answered. */
internal fun interface HealthCheck {
    fun status(port: Int, token: String?): Int
}

/**
 * `GET http://127.0.0.1:<port>/__sillybunny/health` with `Cookie: sillybunny_launch=<token>` (plan §3.3).
 * The launch-token gate answers 204 only with the right cookie. No proxy, no redirects, no cache, and
 * errors never carry the request headers. The cookie is the token itself, so [ServerManager] probes only a
 * listener the server announced ([ListenerAnnouncement]).
 */
internal class HealthProbe(
    private val connectTimeoutMillis: Int = 1_000,
    private val readTimeoutMillis: Int = 3_000,
) : HealthCheck {
    override fun status(port: Int, token: String?): Int {
        val connection = try {
            URL("http", HOST, port, PATH).openConnection(Proxy.NO_PROXY) as HttpURLConnection
        } catch (_: IOException) {
            return UNREACHABLE
        }
        return try {
            connection.instanceFollowRedirects = false
            connection.useCaches = false
            connection.connectTimeout = connectTimeoutMillis
            connection.readTimeout = readTimeoutMillis
            connection.setRequestProperty("Connection", "close")
            if (token != null) connection.setRequestProperty("Cookie", "${LaunchSession.COOKIE_NAME}=$token")
            connection.responseCode
        } catch (_: IOException) {
            UNREACHABLE
        } finally {
            connection.disconnect()
        }
    }

    companion object {
        const val HOST = "127.0.0.1"
        const val PATH = "/__sillybunny/health"
        const val HEALTHY = 204
        const val UNREACHABLE = -1
    }
}
