package io.github.sillybunnyteam.sillybunny.web

import android.net.Uri

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
 * Link and request policy for the app WebView. Pure functions over [Uri], so the rules stay testable.
 *
 * - Only the exact app origin (`http`, host `127.0.0.1`, the session port, no user info) loads in-app as
 *   a page. Comparing the host alone is not enough: every port on `127.0.0.1` is a different origin.
 * - `127.0.0.1` on any other port is never loaded as a page, handed to a browser, or requested where a
 *   WebView hook sees the request. Cookies are not port-isolated (RFC 6265 §8.5) and other ports are the
 *   same site, so such a request would carry the `SameSite=Strict` launch cookie to whatever listens
 *   there. Requests that reach no hook stay outside this policy: WebSocket handshakes, and the redirect
 *   hops of subresource and subframe requests other than CORS `fetch` and XHR.
 * - Other `http(s)` pages open in another app; other schemes follow a short allowlist, and `intent:`
 *   URLs are never parsed into intents.
 */
internal object WebNavigationPolicy {
    const val LOOPBACK_HOST = "127.0.0.1"

    /** Schemes other than `http(s)` that a user's tap may hand to another app. */
    private val externalSchemes = setOf("mailto", "tel")

    /** Schemes that a subframe may load inside its own frame (embeds, `srcdoc`, generated content). */
    private val subframeSchemes = setOf("about", "data", "blob")

    /** True for a URL on exactly the app origin `http://127.0.0.1:<port>`. */
    fun isAppUrl(url: Uri?, port: Int): Boolean {
        if (url == null || !url.isHierarchical) return false
        return url.scheme.equals("http", ignoreCase = true) &&
            url.host == LOOPBACK_HOST &&
            url.userInfo == null &&
            effectivePort(url) == port
    }

    /**
     * Routes a navigation. [isMainFrame] is true for top-level and new-window navigations. [hasGesture]
     * gates only the non-web schemes: web pages open without a fresh gesture because the frontend starts
     * some of them after awaited work, for example the OpenRouter sign-in.
     */
    fun route(url: Uri, port: Int, isMainFrame: Boolean, hasGesture: Boolean): WebRoute {
        if (isAppUrl(url, port)) return WebRoute.InApp
        val scheme = url.scheme?.lowercase() ?: return WebRoute.Block
        if (scheme == "http" || scheme == "https") {
            val host = url.host
            return when {
                host.isNullOrEmpty() || host == LOOPBACK_HOST -> WebRoute.Block
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
     * True for a request the WebView would send with the launch cookie to a listener other than the app
     * server: host `127.0.0.1` on another port, for any scheme that carries cookies.
     */
    fun leaksLaunchCookie(url: Uri, port: Int): Boolean {
        val scheme = url.scheme?.lowercase() ?: return false
        if (scheme != "http" && scheme != "https" && scheme != "ws" && scheme != "wss") return false
        return url.host == LOOPBACK_HOST && effectivePort(url) != port
    }

    private fun effectivePort(url: Uri): Int {
        if (url.port != -1) return url.port
        return when (url.scheme?.lowercase()) {
            "http", "ws" -> 80
            "https", "wss" -> 443
            else -> -1
        }
    }
}
