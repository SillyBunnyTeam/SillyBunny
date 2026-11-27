package io.github.sillybunnyteam.sillybunny.web

import android.content.Context
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.util.Locale

/**
 * Serves immutable and public checkout assets directly on WebView's I/O thread, bypassing loopback HTTP
 * and Express middleware for allow-listed static trees while falling back (`null`) on every dynamic,
 * user-scoped, ranged or missing path.
 */
internal class StaticAssetInterceptor(
    private val publicDir: Path,
    private val frontendDistDir: Path,
) {
    constructor(checkoutDir: Path) : this(
        publicDir = checkoutDir.resolve("public"),
        frontendDistDir = checkoutDir.resolve("dist").resolve("frontend"),
    )

    fun intercept(request: WebResourceRequest, app: AppOrigin): WebResourceResponse? {
        val url = request.url ?: return null
        if (!WebNavigationPolicy.isAppUrl(url, app)) return null
        // Main-frame navigations always pass through Express so launch-token/SameSite=Strict enforcement runs.
        if (request.isForMainFrame) return null
        if (!request.method.equals("GET", ignoreCase = true)) return null
        val requestHeaders = request.requestHeaders
        if (requestHeaders != null) {
            for ((headerName, headerValue) in requestHeaders) {
                // Let Express answer Range requests so media and font byte-range probes keep 206 Partial Content.
                if (headerName.equals("Range", ignoreCase = true)) return null
                // Cross-origin / cross-site subresource loads must hit Express so SameSite=Strict and CORP apply.
                if (headerName.equals("Sec-Fetch-Site", ignoreCase = true) &&
                    !headerValue.equals("same-origin", ignoreCase = true)
                ) {
                    return null
                }
                if (headerName.equals("Origin", ignoreCase = true) &&
                    !headerValue.equals(app.url, ignoreCase = true)
                ) {
                    return null
                }
            }
        }

        val rawPath = url.encodedPath ?: return null
        if (!isCleanPathText(rawPath)) return null
        val rawSegments = rawPath.substring(1).split('/')
        if (rawSegments.isEmpty() || rawSegments.any { it.isEmpty() || it == "." || it == ".." }) return null

        val decodedPath = decodePathPercent(rawPath) ?: return null
        if (!isCleanPathText(decodedPath)) return null
        val segments = decodedPath.substring(1).split('/')
        if (segments.isEmpty() || segments.any { it.isEmpty() || it == "." || it == ".." }) return null

        if (isExcluded(decodedPath)) return null

        val fromFrontendAssets: Boolean
        val root: Path
        val relativeSegments: List<String>
        when {
            decodedPath.startsWith(FRONTEND_ASSETS_PREFIX) -> {
                fromFrontendAssets = true
                root = frontendDistDir
                relativeSegments = segments.drop(1)
            }
            PUBLIC_PREFIXES.any { decodedPath.startsWith(it) } -> {
                fromFrontendAssets = false
                root = publicDir
                relativeSegments = segments
            }
            else -> return null
        }
        if (relativeSegments.isEmpty()) return null

        val fileName = relativeSegments.last()
        val dot = fileName.lastIndexOf('.')
        if (dot <= 0 || dot == fileName.length - 1) return null
        val extension = fileName.substring(dot + 1).lowercase(Locale.ROOT)
        val assetType = MIME_TYPES[extension] ?: return null

        val realRoot = try {
            if (!Files.isDirectory(root)) return null
            root.toRealPath()
        } catch (_: IOException) {
            return null
        } catch (_: SecurityException) {
            return null
        }

        var candidate = realRoot
        for (segment in relativeSegments) {
            candidate = candidate.resolve(segment)
        }
        if (!candidate.normalize().startsWith(realRoot)) return null

        val realFile = try {
            candidate.toRealPath()
        } catch (_: IOException) {
            return null
        } catch (_: SecurityException) {
            return null
        }
        // Symlinks inside public/ must never escape into data/, config.yaml, secrets.json, or excluded public paths.
        if (!realFile.startsWith(realRoot) || realFile == realRoot) return null
        if (!fromFrontendAssets) {
            val realPublicPath = "/" + realRoot.relativize(realFile).toString().replace('\\', '/')
            if (isExcluded(realPublicPath)) return null
        }
        if (!Files.isRegularFile(realFile, LinkOption.NOFOLLOW_LINKS)) return null

        val stream = try {
            BufferedInputStream(Files.newInputStream(realFile))
        } catch (_: IOException) {
            return null
        } catch (_: SecurityException) {
            return null
        }

        val cacheControl = when {
            fromFrontendAssets && HASHED_FRONTEND_ASSET.containsMatchIn(fileName) -> CACHE_IMMUTABLE
            fromFrontendAssets -> CACHE_REVALIDATE
            assetType.revalidate -> CACHE_REVALIDATE
            else -> CACHE_STATIC_MEDIA
        }
        return WebResourceResponse(
            assetType.mimeType,
            assetType.encoding,
            200,
            "OK",
            mapOf(
                "X-Content-Type-Options" to "nosniff",
                "Cross-Origin-Resource-Policy" to "same-origin",
                "X-Frame-Options" to "SAMEORIGIN",
                "Referrer-Policy" to "no-referrer",
                "Cache-Control" to cacheControl,
            ),
            stream,
        )
    }

    private class AssetType(
        val mimeType: String,
        val encoding: String?,
        val revalidate: Boolean,
    )

    companion object {
        private const val CHECKOUT_DIR_NAME = "SillyBunny"
        private const val FRONTEND_ASSETS_PREFIX = "/frontend-assets/"
        private val HASHED_FRONTEND_ASSET = Regex("-[a-f0-9]{8,}\\.[a-z0-9]+$", RegexOption.IGNORE_CASE)
        private const val CACHE_IMMUTABLE = "public, max-age=31536000, immutable"
        private const val CACHE_STATIC_MEDIA = "public, max-age=3600"
        private const val CACHE_REVALIDATE = "no-cache"

        private val PUBLIC_PREFIXES = listOf(
            "/scripts/",
            "/css/",
            "/img/",
            "/webfonts/",
            "/locales/",
            "/lib/",
        )

        private val EXACT_EXCLUSIONS = setOf(
            "/",
            "/index.html",
            "/login",
            "/lib.js",
            "/csrf-token",
            "/version",
            "/css/user.css",
        )

        private val PREFIX_EXCLUSIONS = listOf(
            "/api/",
            "/api",
            "/__sillybunny/",
            "/__sillybunny",
            "/characters/",
            "/characters",
            "/backgrounds/",
            "/backgrounds",
            "/thumbnail",
            "/user avatars/",
            "/user avatars",
            "/assets/",
            "/assets",
            "/user/",
            "/user",
            // Third-party extensions live in per-user data directories behind extensionsEnabledFeatureGuard.
            "/scripts/extensions/third-party/",
            "/scripts/extensions/third-party",
        )

        // Chromium rejects ES modules served with legacy application/javascript or text/plain on custom schemes/hooks;
        // text/javascript is the WHATWG standard MIME type required for module scripts.
        private val MIME_TYPES = mapOf(
            "js" to AssetType("text/javascript", "utf-8", revalidate = true),
            "mjs" to AssetType("text/javascript", "utf-8", revalidate = true),
            "css" to AssetType("text/css", "utf-8", revalidate = true),
            "woff2" to AssetType("font/woff2", null, revalidate = false),
            "woff" to AssetType("font/woff", null, revalidate = false),
            "ttf" to AssetType("font/ttf", null, revalidate = false),
            "svg" to AssetType("image/svg+xml", "utf-8", revalidate = false),
            "json" to AssetType("application/json", "utf-8", revalidate = true),
            "png" to AssetType("image/png", null, revalidate = false),
            "webp" to AssetType("image/webp", null, revalidate = false),
            "jpg" to AssetType("image/jpeg", null, revalidate = false),
            "jpeg" to AssetType("image/jpeg", null, revalidate = false),
            "gif" to AssetType("image/gif", null, revalidate = false),
            "ico" to AssetType("image/x-icon", null, revalidate = false),
            "html" to AssetType("text/html", "utf-8", revalidate = true),
        )

        fun forContext(context: Context): StaticAssetInterceptor =
            StaticAssetInterceptor(context.applicationContext.filesDir.toPath().resolve(CHECKOUT_DIR_NAME))

        private fun isCleanPathText(path: String): Boolean {
            if (!path.startsWith("/") || path.startsWith("//")) return false
            if ('\\' in path || '\u0000' in path) return false
            val lower = path.lowercase(Locale.ROOT)
            return "%2e" !in lower && "%2f" !in lower && "%5c" !in lower && "%00" !in lower
        }

        private fun isExcluded(decodedPath: String): Boolean {
            val lower = decodedPath.lowercase(Locale.ROOT)
            if (lower in EXACT_EXCLUSIONS) return true
            return PREFIX_EXCLUSIONS.any { prefix ->
                if (prefix.endsWith("/") || prefix == "/thumbnail") {
                    lower.startsWith(prefix)
                } else {
                    lower == prefix
                }
            }
        }

        /**
         * Single-pass RFC 3986 percent decoder for URL paths. Unlike [java.net.URLDecoder], `+` stays `+`
         * and malformed escapes or invalid UTF-8 sequences return `null`.
         */
        internal fun decodePathPercent(raw: String): String? {
            if ('%' !in raw) return raw
            val out = ByteArrayOutputStream(raw.length)
            var i = 0
            while (i < raw.length) {
                val ch = raw[i]
                if (ch == '%') {
                    if (i + 2 >= raw.length) return null
                    val hi = hexDigit(raw[i + 1])
                    val lo = hexDigit(raw[i + 2])
                    if (hi < 0 || lo < 0) return null
                    out.write((hi shl 4) or lo)
                    i += 3
                } else if (ch.code < 0x80) {
                    out.write(ch.code)
                    i++
                } else {
                    val utf8 = ch.toString().toByteArray(Charsets.UTF_8)
                    out.write(utf8, 0, utf8.size)
                    i++
                }
            }
            val decoder = Charsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
            return try {
                decoder.decode(ByteBuffer.wrap(out.toByteArray())).toString()
            } catch (_: CharacterCodingException) {
                null
            }
        }

        private fun hexDigit(ch: Char): Int = when (ch) {
            in '0'..'9' -> ch - '0'
            in 'a'..'f' -> ch - 'a' + 10
            in 'A'..'F' -> ch - 'A' + 10
            else -> -1
        }
    }
}
