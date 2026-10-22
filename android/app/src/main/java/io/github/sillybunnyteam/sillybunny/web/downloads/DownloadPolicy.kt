package io.github.sillybunnyteam.sillybunny.web.downloads

import java.net.URI
import java.net.URISyntaxException

/** A scheme, host and port; ports are explicit, so `http://h` and `http://h:80` are equal. */
internal data class WebOrigin(val scheme: String, val host: String, val port: Int) {
    override fun toString(): String = "$scheme://$host:$port"

    companion object {
        fun of(uri: URI): WebOrigin? {
            val scheme = uri.scheme?.lowercase() ?: return null
            val host = uri.host?.lowercase()?.removePrefix("[")?.removeSuffix("]")?.takeIf { it.isNotEmpty() }
                ?: return null
            val port = when {
                uri.port != -1 -> uri.port
                scheme == "http" -> 80
                scheme == "https" -> 443
                else -> return null
            }
            return WebOrigin(scheme, host, port)
        }

        fun parse(url: String): WebOrigin? = DownloadPolicy.parse(url)?.let(::of)
    }
}

/** One request of a download chain and whether it may carry the app's WebView cookies. */
internal class DownloadHop(val url: URI, val sendCookies: Boolean, val leftApp: Boolean)

/**
 * Cookie and redirect rules for app-owned HTTP downloads (plan §3.3, §4.5). Cookies are not
 * port-isolated, so the app's cookies (including `sillybunny_launch`) go only to the exact app
 * origin, and only while every earlier hop had that origin too. A chain that leaves the app origin
 * never gets cookies again, never returns to the app origin and never reaches loopback or private
 * addresses, so an outside redirect cannot aim the app's credentials at a local server. Cleartext
 * is allowed only on the app origin. Every request is a GET; callers never replay a POST.
 */
internal class DownloadPolicy(private val app: WebOrigin, val maxRedirects: Int = MAX_REDIRECTS) {
    fun start(url: String): DownloadHop? {
        val uri = parse(url) ?: return null
        val origin = WebOrigin.of(uri) ?: return null
        return when {
            origin == app -> DownloadHop(uri, sendCookies = true, leftApp = false)
            isPublicHttps(origin) -> DownloadHop(uri, sendCookies = false, leftApp = true)
            else -> null
        }
    }

    fun redirect(from: DownloadHop, location: String): DownloadHop? {
        val trimmed = location.trim()
        if (trimmed.isEmpty() || trimmed.length > MAX_URL_CHARS) return null
        val resolved = try {
            from.url.resolve(URI(escapeForUri(trimmed)))
        } catch (_: URISyntaxException) {
            return null
        } catch (_: IllegalArgumentException) {
            return null
        }
        val uri = parse(resolved.toString()) ?: return null
        val origin = WebOrigin.of(uri) ?: return null
        return when {
            !from.leftApp && origin == app -> DownloadHop(uri, sendCookies = true, leftApp = false)
            isPublicHttps(origin) -> DownloadHop(uri, sendCookies = false, leftApp = true)
            else -> null
        }
    }

    private fun isPublicHttps(origin: WebOrigin): Boolean = origin.scheme == "https" && !isLocalHost(origin.host)

    companion object {
        const val MAX_REDIRECTS = 5
        const val MAX_URL_CHARS = 8_192

        /** An absolute HTTP(S) URL without credentials or fragment, or null. */
        fun parse(value: String): URI? {
            if (value.length !in 1..MAX_URL_CHARS || value.any { it.code <= 0x20 || it.code == 0x7f || it == '\\' }) {
                return null
            }
            val uri = try {
                URI(escapeForUri(value.substringBefore('#')))
            } catch (_: URISyntaxException) {
                return null
            }
            val scheme = uri.scheme?.lowercase()
            if (!uri.isAbsolute || uri.isOpaque || (scheme != "http" && scheme != "https")) return null
            if (uri.host.isNullOrEmpty() || uri.rawUserInfo != null) return null
            if (uri.port != -1 && uri.port !in 1..65_535) return null
            return uri
        }

        /**
         * Percent-encodes the characters that WHATWG URL serialization leaves as they are after the
         * authority (for example `|`, `^`, `{` and `[` in a path or query) but `java.net.URI` rejects.
         */
        internal fun escapeForUri(value: String): String {
            val authority = value.indexOf("://").let { if (it < 0) 0 else it + 3 }
            val rest = value.indexOfAny(charArrayOf('/', '?', '#'), authority).let { if (it < 0) value.length else it }
            if ((rest until value.length).none { value[it] in URI_ESCAPED }) return value
            return buildString(value.length + 16) {
                append(value, 0, rest)
                for (index in rest until value.length) {
                    val char = value[index]
                    if (char in URI_ESCAPED) {
                        append('%').append(HEX[char.code shr 4]).append(HEX[char.code and 0xf])
                    } else {
                        append(char)
                    }
                }
            }
        }

        private const val URI_ESCAPED = "|^{}`[]\"<>"
        private const val HEX = "0123456789ABCDEF"

        /**
         * Loopback, unspecified, link-local, shared and private IPv4 addresses, every IPv6 literal and
         * `localhost` names. Public downloads by IPv6 literal are rare enough to refuse rather than
         * classify every IPv6 notation.
         */
        fun isLocalHost(host: String): Boolean {
            val name = host.lowercase().removePrefix("[").removeSuffix("]").trimEnd('.')
            if (name.isEmpty() || name == "localhost" || name.endsWith(".localhost")) return true
            if (':' in name) return true
            // Resolvers also accept shorthand such as 127.1, 2130706433 or 0x7f.1, and read a leading
            // zero as octal (0177.0.0.1 is 127.0.0.1), so any numeric host that is not a plain dotted
            // quad of decimal octets counts as local.
            val numeric = name.all { it.isDigit() || it == '.' } || name.startsWith("0x") || ".0x" in name
            if (!numeric) return false
            val parts = name.split('.')
            if (parts.size != 4) return true
            val octets = parts.map { part ->
                part.takeIf { it.isNotEmpty() && it.all(Char::isDigit) && (it.length == 1 || it[0] != '0') }
                    ?.toIntOrNull()?.takeIf { it in 0..255 }
                    ?: return true
            }
            val (first, second) = octets
            return first == 127 || first == 0 || first == 10 || (first == 172 && second in 16..31) ||
                (first == 192 && second == 168) || (first == 169 && second == 254) ||
                (first == 100 && second in 64..127) || first >= 224
        }
    }
}

/**
 * Short keys for URLs seen by the page script, the navigation hook and the download listener, so
 * one export is recognized on every path. HTTP(S) keys drop the fragment; `data:` keys are shortened.
 */
internal object TransferKeys {
    fun of(url: String): String = when {
        url.startsWith("data:", ignoreCase = true) -> DataUrls.key(url)
        url.startsWith("http:", ignoreCase = true) || url.startsWith("https:", ignoreCase = true) ->
            url.substringBefore('#')
        else -> url
    }
}
