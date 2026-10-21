package io.github.sillybunnyteam.sillybunny.update

import io.github.sillybunnyteam.sillybunny.BuildConfig
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.security.MessageDigest

class UpdateHttpClient(
    private val allowDebugLoopback: Boolean = BuildConfig.DEBUG,
    private val connectTimeoutMillis: Int = 15_000,
    private val readTimeoutMillis: Int = 30_000,
    private val maxRedirects: Int = 5,
) {
    init {
        require(connectTimeoutMillis > 0 && readTimeoutMillis > 0 && maxRedirects in 0..10)
    }

    fun fetchJson(url: String): String = withResponse(url, "application/json") { connection ->
        val length = contentLength(connection)
        if (length != null && length > UpdateJson.MAX_BYTES) throw IOException()
        val output = ByteArrayOutputStream()
        connection.inputStream.use { input ->
            val buffer = ByteArray(8_192)
            while (true) {
                val count = input.read(buffer, 0, minOf(buffer.size, UpdateJson.MAX_BYTES + 1 - output.size()))
                if (count < 0) break
                output.write(buffer, 0, count)
                if (output.size() > UpdateJson.MAX_BYTES) throw IOException()
            }
        }
        if (length != null && output.size().toLong() != length) throw IOException()
        Charsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(output.toByteArray())).toString()
    }

    fun download(
        url: String,
        destination: File,
        expectedSize: Long,
        expectedSha256: String,
        onProgress: (Long, Long) -> Unit = { _, _ -> },
    ) {
        var complete = false
        try {
            if (expectedSize !in 1..UpdateManifestParser.MAX_APK_BYTES ||
                !UpdateManifestParser.isSha256(expectedSha256)
            ) throw IOException()
            val expectedHash = ApkVerifier.normalizeFingerprint(expectedSha256) ?: throw IOException()
            withResponse(url, "application/vnd.android.package-archive") { connection ->
                val length = contentLength(connection)
                if (length != null && length != expectedSize) throw IOException()
                val digest = MessageDigest.getInstance("SHA-256")
                var received = 0L
                onProgress(0, expectedSize)
                connection.inputStream.use { input ->
                    FileOutputStream(destination).use { output ->
                        val buffer = ByteArray(32_768)
                        while (true) {
                            val count = input.read(buffer, 0, minOf(buffer.size.toLong(), expectedSize - received + 1).toInt())
                            if (count < 0) break
                            if (received + count > expectedSize) throw IOException()
                            output.write(buffer, 0, count)
                            digest.update(buffer, 0, count)
                            received += count
                            onProgress(received, expectedSize)
                        }
                        if (received != expectedSize || !MessageDigest.isEqual(digest.digest(), expectedHash)) {
                            throw IOException()
                        }
                        output.fd.sync()
                    }
                }
            }
            complete = true
        } finally {
            if (!complete) destination.delete()
        }
    }

    internal fun isAllowedUrl(url: String): Boolean = try {
        validatedUrl(url)
        true
    } catch (_: Exception) {
        false
    }

    internal fun redirectAllowed(from: String, to: String): Boolean = try {
        val source = validatedUrl(from)
        val target = validatedUrl(to)
        source.protocol == "https" && target.protocol == "https"
    } catch (_: Exception) {
        false
    }

    private fun <T> withResponse(url: String, accept: String, read: (HttpURLConnection) -> T): T {
        var current = validatedUrl(url)
        var redirects = 0
        while (true) {
            if (Thread.currentThread().isInterrupted) throw IOException()
            val connection = current.openConnection() as? HttpURLConnection ?: throw IOException()
            try {
                connection.instanceFollowRedirects = false
                connection.connectTimeout = connectTimeoutMillis
                connection.readTimeout = readTimeoutMillis
                connection.useCaches = false
                connection.requestMethod = "GET"
                connection.setRequestProperty("Accept", accept)
                connection.setRequestProperty("Accept-Encoding", "identity")
                connection.setRequestProperty("User-Agent", "SillyBunny-Android-Updater")
                val status = connection.responseCode
                if (status in setOf(301, 302, 303, 307, 308)) {
                    if (redirects++ >= maxRedirects) throw IOException()
                    val location = connection.getHeaderField("Location") ?: throw IOException()
                    if (location.length > MAX_URL_LENGTH) throw IOException()
                    val next = validatedUrl(current.toURI().resolve(URI(location)).toString())
                    if (!redirectAllowed(current.toString(), next.toString())) throw IOException()
                    current = next
                    continue
                }
                if (status != HttpURLConnection.HTTP_OK) throw IOException()
                val encoding = connection.getHeaderField("Content-Encoding")
                if (encoding != null && !encoding.equals("identity", ignoreCase = true)) throw IOException()
                return read(connection)
            } finally {
                connection.disconnect()
            }
        }
    }

    private fun validatedUrl(value: String): URL {
        if (value.length !in 1..MAX_URL_LENGTH || value.any { it.code <= 0x20 || it.code == 0x7f || it == '\\' }) {
            throw IOException()
        }
        val uri = URI(value)
        if (!uri.isAbsolute || uri.host.isNullOrEmpty() || uri.rawUserInfo != null || uri.rawFragment != null ||
            uri.port != -1 && uri.port !in 1..65_535
        ) throw IOException()
        if (uri.scheme != "https" &&
            !(allowDebugLoopback && uri.scheme == "http" && uri.host == "127.0.0.1")
        ) throw IOException()
        return uri.toURL()
    }

    private fun contentLength(connection: HttpURLConnection): Long? {
        val value = connection.getHeaderField("Content-Length") ?: return null
        if (value.isEmpty() || value.any { it !in '0'..'9' }) throw IOException()
        return value.toLongOrNull()?.takeIf { it >= 0 } ?: throw IOException()
    }

    private companion object {
        const val MAX_URL_LENGTH = 8_192
    }
}
