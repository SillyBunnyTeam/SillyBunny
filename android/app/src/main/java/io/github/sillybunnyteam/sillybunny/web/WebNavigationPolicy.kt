package io.github.sillybunnyteam.sillybunny.web

import android.net.Uri
import java.net.URLEncoder

/** What the WebView screen does with a navigation that its page started (plan §4.5). */
internal enum class WebRoute {
    /** Let the WebView load it: the exact app origin, or content inside a subframe. */
    InApp,

    /** Hand it to another app with `ACTION_VIEW`: external web pages, `mailto:` and `tel:`. */
    External,

    /** Neither load it nor hand it off. */
    Block,
}

/**
 * The exact origin of the app's pages, `http://<host>:<port>` (plan §4.5). [toString] leaves [host] out:
 * it is the per-install label of [WebAddress].
 */
internal class AppOrigin(host: String, val port: Int) {
    val host: String = host.lowercase()

    /** `http://<host>:<port>`, without a trailing slash. */
    val url: String get() = "http://$host:$port"

    override fun equals(other: Any?): Boolean = other is AppOrigin && other.host == host && other.port == port

    override fun hashCode(): Int = 31 * host.hashCode() + port

    override fun toString(): String = "AppOrigin(port=$port)"
}

/**
 * Link and request policy for the app WebView. Pure functions over [Uri], so the rules stay testable.
 *
 * - Only the exact app origin ([AppOrigin]: `http`, the per-install `<label>.localhost` host, the session
 *   port, no user info) loads in-app as a page. Every port is a different origin.
 * - Local names are never loaded as a page, handed to a browser, or requested where a WebView hook sees
 *   the request, unless they are exactly the app origin ([isLocalHost]: `localhost`, `*.localhost`, which
 *   includes the label on other ports, 127.0.0.0/8, 0.0.0.0/8 and IPv6 literals). The launch cookie is
 *   host-only on the label, so only the label on another port would receive it; the other names stay
 *   refused so that pages cannot reach other local services either. Requests that reach no hook stay
 *   outside this policy: WebSocket handshakes, and the redirect hops of subresource and subframe requests
 *   other than CORS `fetch` and XHR.
 * - Other `http(s)` pages open in another app; other schemes follow a short allowlist, and `intent:`
 *   URLs are never parsed into intents.
 * - The OpenRouter sign-in (plan §4.5, integration item 7) is the one external page that loads in-app,
 *   by [isOpenRouterStart] and [openRouterReturn]; the shell applies those rules before [route].
 */
internal object WebNavigationPolicy {
    /** The OpenRouter origin whose sign-in page may load in the app WebView. */
    const val OPENROUTER_ORIGIN = "https://openrouter.ai"

    /** The path of the server's OpenRouter callback (`/callback/:source?` in `src/server-main.js`). */
    const val OPENROUTER_CALLBACK_PATH = "/callback/openrouter"

    /** Schemes other than `http(s)` that a user's tap may hand to another app. */
    private val externalSchemes = setOf("mailto", "tel")

    /** Schemes that a subframe may load inside its own frame (embeds, `srcdoc`, generated content). */
    private val subframeSchemes = setOf("about", "data", "blob")

    /** True for a URL on exactly the app origin [app]. */
    fun isAppUrl(url: Uri?, app: AppOrigin): Boolean {
        if (url == null || !url.isHierarchical) return false
        return url.scheme.equals("http", ignoreCase = true) &&
            url.host.equals(app.host, ignoreCase = true) &&
            url.userInfo == null &&
            effectivePort(url) == app.port
    }

    /** True for a URL on exactly the origin of [origin]: scheme, host and port, without user info. */
    fun isSameOrigin(url: Uri?, origin: Uri): Boolean {
        if (url == null || !url.isHierarchical || url.userInfo != null) return false
        val host = url.host
        return !host.isNullOrEmpty() &&
            url.scheme.equals(origin.scheme, ignoreCase = true) &&
            host.equals(origin.host, ignoreCase = true) &&
            effectivePort(url) == effectivePort(origin)
    }

    /**
     * Routes a navigation. [isMainFrame] is true for top-level and new-window navigations. [hasGesture]
     * gates only the non-web schemes: web pages open without a fresh gesture because the frontend starts
     * some of them after awaited work.
     */
    fun route(url: Uri, app: AppOrigin, isMainFrame: Boolean, hasGesture: Boolean): WebRoute {
        if (isAppUrl(url, app)) return WebRoute.InApp
        val scheme = url.scheme?.lowercase() ?: return WebRoute.Block
        if (scheme == "http" || scheme == "https") {
            val host = url.host
            return when {
                host.isNullOrEmpty() || isLocalHost(host) -> WebRoute.Block
                !isMainFrame -> WebRoute.InApp
                else -> WebRoute.External
            }
        }
        if (!isMainFrame) {
            return if (scheme in subframeSchemes) WebRoute.InApp else WebRoute.Block
        }
        return if (scheme in externalSchemes && hasGesture) WebRoute.External else WebRoute.Block
    }

    /**
     * True for a request the shell answers itself instead of sending: an `http(s)` or `ws(s)` request to a
     * local name ([isLocalHost]) other than the app's own host and port. Without an app origin yet, every
     * local request is refused.
     */
    fun refusesRequest(url: Uri, app: AppOrigin?): Boolean {
        val scheme = url.scheme?.lowercase() ?: return false
        if (scheme != "http" && scheme != "https" && scheme != "ws" && scheme != "wss") return false
        val host = url.host ?: return true
        if (!isLocalHost(host)) return false
        return app == null || !host.equals(app.host, ignoreCase = true) || effectivePort(url) != app.port
    }

    /**
     * Local names: `localhost` and `*.localhost` (Chromium resolves them to loopback itself), IPv4
     * 127.0.0.0/8 and 0.0.0.0/8, and every IPv6 literal (public pages by IPv6 literal are rare enough to
     * refuse rather than classify every notation). Hosts that look numeric but are not a plain dotted quad
     * count as local too: resolvers accept shorthand such as `127.1` or `2130706433`, although WebView
     * reports canonical hosts.
     */
    fun isLocalHost(host: String): Boolean {
        val name = host.lowercase().removePrefix("[").removeSuffix("]").trimEnd('.')
        if (name.isEmpty() || name == "localhost" || name.endsWith(".localhost")) return true
        if (':' in name) return true
        val numeric = name.all { it.isDigit() || it == '.' } || name.startsWith("0x") || ".0x" in name
        if (!numeric) return false
        val parts = name.split('.')
        if (parts.size != 4) return true
        val octets = parts.map { part ->
            part.takeIf { it.isNotEmpty() && it.all(Char::isDigit) && (it.length == 1 || it[0] != '0') }
                ?.toIntOrNull()?.takeIf { it in 0..255 }
                ?: return true
        }
        return octets[0] == 127 || octets[0] == 0
    }

    /**
     * True for the frontend's start of the OpenRouter sign-in (`authorizeOpenRouter` in
     * `public/scripts/secrets.js`): `<provider>/auth` whose `callback_url` is exactly the app origin's
     * [OPENROUTER_CALLBACK_PATH].
     */
    fun isOpenRouterStart(url: Uri, provider: Uri, app: AppOrigin): Boolean {
        if (!isSameOrigin(url, provider) || url.path != "/auth") return false
        val callbacks = try {
            url.getQueryParameters("callback_url")
        } catch (_: UnsupportedOperationException) {
            return false
        }
        return callbacks.size == 1 && callbacks[0] == app.url + OPENROUTER_CALLBACK_PATH
    }

    /**
     * For a navigation to the app origin's OpenRouter callback, the URL the server's callback route would
     * have led to; null for any other URL. The route (`/callback/:source?` in `src/server-main.js`) answers
     * `307` to `/?source=openrouter&query=<query>`, where `<query>` is the raw text between the first and the
     * second `?` of the request URL, and both values are form-encoded as `URLSearchParams` does. The frontend
     * reads them in `checkOpenRouterAuth`.
     */
    fun openRouterReturn(url: Uri, app: AppOrigin): String? {
        if (!isAppUrl(url, app) || url.path != OPENROUTER_CALLBACK_PATH) return null
        val query = url.toString().substringBefore('#').substringAfter('?', "").substringBefore('?')
        val search = StringBuilder("source=").append(formEncode("openrouter"))
        if (query.isNotEmpty()) search.append("&query=").append(formEncode(query))
        return "${app.url}/?$search"
    }

    /** `application/x-www-form-urlencoded` like `URLSearchParams`: `*-._` and alphanumerics stay, space is `+`. */
    private fun formEncode(value: String): String = URLEncoder.encode(value, "UTF-8")

    private fun effectivePort(url: Uri): Int {
        if (url.port != -1) return url.port
        return when (url.scheme?.lowercase()) {
            "http", "ws" -> 80
            "https", "wss" -> 443
            else -> -1
        }
    }
}
