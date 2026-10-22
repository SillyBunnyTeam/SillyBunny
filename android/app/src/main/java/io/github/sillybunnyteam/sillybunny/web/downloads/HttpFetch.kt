package io.github.sillybunnyteam.sillybunny.web.downloads

import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URI

/**
 * App-owned HTTP(S) GET for a download (plan §4.5). Redirects are followed by hand, each hop checked
 * by [DownloadPolicy], so WebView cookies reach only the exact app origin and never follow a
 * redirect to another origin or port. Only GET is ever sent: a POST download is never replayed.
 */
internal class HttpFetch(
    private val policy: DownloadPolicy,
    private val cookies: (String) -> String?,
    private val userAgent: String?,
    private val timeoutMillis: Int = 30_000,
    private val connect: (URI) -> HttpURLConnection = { it.toURL().openConnection() as HttpURLConnection },
) {
    class Response(
        val connection: HttpURLConnection,
        val url: URI,
        val disposition: String?,
        val mime: String?,
        /** Declared body length, or -1 when unknown. */
        val length: Long,
    )

    /**
     * Follows the chain from [first] to a 2xx response; null when a hop is refused, the server fails
     * or there are too many redirects. [onConnection] sees each connection so a caller can abort it.
     */
    @Throws(IOException::class)
    fun open(first: DownloadHop, onConnection: (HttpURLConnection) -> Unit = {}): Response? {
        var hop = first
        repeat(policy.maxRedirects + 1) {
            val connection = connect(hop.url)
            onConnection(connection)
            connection.instanceFollowRedirects = false
            connection.useCaches = false
            connection.connectTimeout = timeoutMillis
            connection.readTimeout = timeoutMillis
            connection.requestMethod = "GET"
            connection.setRequestProperty("Accept-Encoding", "identity")
            userAgent?.takeIf { it.isNotBlank() }?.let { connection.setRequestProperty("User-Agent", it) }
            if (hop.sendCookies) {
                cookies(hop.url.toString())?.takeIf { it.isNotBlank() }?.let { connection.setRequestProperty("Cookie", it) }
            }
            val status = connection.responseCode
            if (status in 200..299) {
                return Response(
                    connection,
                    hop.url,
                    connection.getHeaderField("Content-Disposition"),
                    connection.contentType,
                    connection.contentLengthLong,
                )
            }
            val location = if (status in REDIRECTS) connection.getHeaderField("Location") else null
            connection.disconnect()
            hop = location?.let { policy.redirect(hop, it) } ?: return null
        }
        return null
    }

    companion object {
        private val REDIRECTS = setOf(301, 302, 303, 307, 308)
        private const val BUFFER_BYTES = 64 * 1024

        /**
         * Copies [input] to [output] while [keepGoing] holds, failing once more than [maxBytes] arrive
         * or [hasRoom] refuses the running total. Returns the bytes copied.
         */
        @Throws(IOException::class)
        fun copyBounded(
            input: InputStream,
            output: OutputStream,
            maxBytes: Long,
            keepGoing: () -> Boolean = { true },
            hasRoom: (Long) -> Boolean = { true },
        ): Long {
            val buffer = ByteArray(BUFFER_BYTES)
            var total = 0L
            while (true) {
                if (!keepGoing()) throw IOException("cancelled")
                val read = input.read(buffer)
                if (read < 0) return total
                total += read
                if (total > maxBytes) throw IOException("too large")
                if (!hasRoom(total)) throw IOException("no space")
                output.write(buffer, 0, read)
            }
        }
    }
}
