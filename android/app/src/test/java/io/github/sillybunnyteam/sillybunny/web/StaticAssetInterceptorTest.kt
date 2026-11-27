package io.github.sillybunnyteam.sillybunny.web

import android.net.Uri
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import java.nio.file.Files
import java.nio.file.Path
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class StaticAssetInterceptorTest {
    @get:Rule
    val temp = TemporaryFolder()

    private lateinit var checkout: Path
    private lateinit var publicDir: Path
    private lateinit var frontendDistDir: Path
    private lateinit var interceptor: StaticAssetInterceptor

    private val address = WebAddress(LABEL)
    private val app = address.appOrigin(PORT)
    private val origin = app.url

    @Before
    fun setUp() {
        checkout = temp.newFolder("SillyBunny").toPath()
        publicDir = Files.createDirectories(checkout.resolve("public"))
        frontendDistDir = Files.createDirectories(checkout.resolve("dist/frontend"))

        // Sensitive files beside public/ that must never be reachable through traversal or symlinks.
        write(checkout.resolve("config.yaml"), "port: 8000\n")
        write(checkout.resolve("secrets.json"), "{\"api_key\":\"secret\"}\n")
        write(checkout.resolve("data/secrets.json"), "{\"user_secret\":true}\n")
        write(checkout.resolve("data/_css/user.css"), "body { color: red; }\n")
        write(checkout.resolve("data/_webpack/lib.js"), "window.webpack = 1;\n")

        // Valid static assets in public/ and dist/frontend/.
        write(frontendDistDir.resolve("app-deadbeef.js"), "export const bundled = 1;\n")
        write(frontendDistDir.resolve("style-1234abcd.css"), "body { margin: 0; }\n")
        write(frontendDistDir.resolve("asset-manifest.json"), "{\"assets\":{}}\n")
        write(publicDir.resolve("scripts/main.js"), "export const main = true;\n")
        write(publicDir.resolve("scripts/helper.mjs"), "export default 42;\n")
        write(publicDir.resolve("scripts/a+b.js"), "export const plus = 1;\n")
        write(publicDir.resolve("scripts/extensions/regex/engine.js"), "export const regex = 1;\n")
        write(publicDir.resolve("css/style.css"), "html { background: #000; }\n")
        write(publicDir.resolve("img/logo.png"), byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47))
        write(publicDir.resolve("img/hero.webp"), "RIFFwebp".toByteArray())
        write(publicDir.resolve("img/photo.jpg"), byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte()))
        write(publicDir.resolve("img/photo2.jpeg"), byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xEE.toByte()))
        write(publicDir.resolve("img/spin.gif"), "GIF89a".toByteArray())
        write(publicDir.resolve("img/favicon.ico"), byteArrayOf(0, 0, 1, 0))
        write(publicDir.resolve("img/icon.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"/>")
        write(publicDir.resolve("webfonts/Adwaita.woff2"), "wOF2".toByteArray())
        write(publicDir.resolve("webfonts/Adwaita.woff"), "wOFF".toByteArray())
        write(publicDir.resolve("webfonts/Adwaita.ttf"), byteArrayOf(0, 1, 0, 0))
        write(publicDir.resolve("locales/en-us.json"), "{\"hello\":\"Hello\"}")
        write(publicDir.resolve("lib/purify.min.js"), "window.DOMPurify = {};\n")
        write(publicDir.resolve("lib/template.html"), "<div>ok</div>")

        // Files placed at excluded paths inside public/ to prove the exclusion rules win even if a file exists.
        write(publicDir.resolve("index.html"), "<!doctype html><title>raw</title>")
        write(publicDir.resolve("lib.js"), "// stale public copy")
        write(publicDir.resolve("css/user.css"), "/* public default user.css */")
        write(publicDir.resolve("scripts/extensions/third-party/foo/index.js"), "export const ext = 1;")
        write(publicDir.resolve("characters/Alice.png"), byteArrayOf(1, 2, 3))
        write(publicDir.resolve("backgrounds/room.jpg"), byteArrayOf(4, 5, 6))
        write(publicDir.resolve("User Avatars/default.png"), byteArrayOf(7, 8, 9))
        write(publicDir.resolve("assets/custom.png"), byteArrayOf(10, 11))
        write(publicDir.resolve("user/profile.json"), "{}")

        interceptor = StaticAssetInterceptor(checkout)
    }

    @Test
    fun servesAllowListedAssetsWithStrictMimeTypesAndHeaders() {
        assertServed(
            path = "/frontend-assets/app-deadbeef.js",
            expectedMime = "text/javascript",
            expectedEncoding = "utf-8",
            expectedCache = "public, max-age=31536000, immutable",
            expectedText = "export const bundled = 1;\n",
        )
        assertServed(
            path = "/frontend-assets/style-1234abcd.css",
            expectedMime = "text/css",
            expectedEncoding = "utf-8",
            expectedCache = "public, max-age=31536000, immutable",
            expectedText = "body { margin: 0; }\n",
        )
        assertServed(
            path = "/frontend-assets/asset-manifest.json",
            expectedMime = "application/json",
            expectedEncoding = "utf-8",
            expectedCache = "no-cache",
            expectedText = "{\"assets\":{}}\n",
        )
        assertServed(
            path = "/scripts/main.js?v=123#section",
            expectedMime = "text/javascript",
            expectedEncoding = "utf-8",
            expectedCache = "no-cache",
            expectedText = "export const main = true;\n",
        )
        assertServed(
            path = "/scripts/helper.mjs",
            expectedMime = "text/javascript",
            expectedEncoding = "utf-8",
            expectedCache = "no-cache",
            expectedText = "export default 42;\n",
        )
        // Literal '+' in URL paths must not be converted to a space.
        assertServed(
            path = "/scripts/a+b.js",
            expectedMime = "text/javascript",
            expectedEncoding = "utf-8",
            expectedCache = "no-cache",
            expectedText = "export const plus = 1;\n",
        )
        assertServed(
            path = "/scripts/extensions/regex/engine.js",
            expectedMime = "text/javascript",
            expectedEncoding = "utf-8",
            expectedCache = "no-cache",
            expectedText = "export const regex = 1;\n",
        )
        assertServed(
            path = "/css/style.css",
            expectedMime = "text/css",
            expectedEncoding = "utf-8",
            expectedCache = "no-cache",
            expectedText = "html { background: #000; }\n",
        )
        assertServed(
            path = "/locales/en-us.json",
            expectedMime = "application/json",
            expectedEncoding = "utf-8",
            expectedCache = "no-cache",
            expectedText = "{\"hello\":\"Hello\"}",
        )
        assertServed(
            path = "/lib/purify.min.js",
            expectedMime = "text/javascript",
            expectedEncoding = "utf-8",
            expectedCache = "no-cache",
            expectedText = "window.DOMPurify = {};\n",
        )
        assertServed(
            path = "/lib/template.html",
            expectedMime = "text/html",
            expectedEncoding = "utf-8",
            expectedCache = "no-cache",
            expectedText = "<div>ok</div>",
        )

        val mediaCases = listOf(
            "/img/logo.png" to ("image/png" to null),
            "/img/hero.webp" to ("image/webp" to null),
            "/img/photo.jpg" to ("image/jpeg" to null),
            "/img/photo2.jpeg" to ("image/jpeg" to null),
            "/img/spin.gif" to ("image/gif" to null),
            "/img/favicon.ico" to ("image/x-icon" to null),
            "/img/icon.svg" to ("image/svg+xml" to "utf-8"),
            "/webfonts/Adwaita.woff2" to ("font/woff2" to null),
            "/webfonts/Adwaita.woff" to ("font/woff" to null),
            "/webfonts/Adwaita.ttf" to ("font/ttf" to null),
        )
        for ((path, expected) in mediaCases) {
            val response = checkNotNull(intercept(path)) { "expected response for $path" }
            assertEquals(path, 200, response.statusCode)
            assertEquals(path, expected.first, response.mimeType)
            assertEquals(path, expected.second, response.encoding)
            assertEquals(path, "nosniff", response.responseHeaders["X-Content-Type-Options"])
            assertEquals(path, "public, max-age=3600", response.responseHeaders["Cache-Control"])
            val diskBytes = Files.readAllBytes(publicDir.resolve(path.removePrefix("/")))
            assertArrayEquals(path, diskBytes, response.data.use { it.readBytes() })
        }
    }

    @Test
    fun explicitExclusionsAlwaysFallThroughToExpress() {
        val excludedPaths = listOf(
            "/",
            "/index.html",
            "/INDEX.HTML",
            "/login",
            "/lib.js",
            "/LIB.JS",
            "/api/status",
            "/api/settings/get",
            "/csrf-token",
            "/version",
            "/__sillybunny/handoff?c=abc",
            "/characters/Alice.png",
            "/backgrounds/room.jpg",
            "/thumbnail?type=avatar&file=Alice.png",
            "/thumbnails/Alice.png",
            "/User%20Avatars/default.png",
            "/assets/custom.png",
            "/user/profile.json",
            "/css/user.css",
            "/css/USER.CSS",
            "/css/user.css?v=1",
            "/scripts/extensions/third-party/foo.js",
            "/scripts/extensions/third-party/foo/index.js",
            "/Scripts/Extensions/Third-Party/foo/index.js",
        )
        for (path in excludedPaths) {
            assertNull("expected null fallthrough for $path", intercept(path))
        }
    }

    @Test
    fun rejectsTraversalAndEncodedPathAttacksBeforeAndAfterDecoding() {
        val attacks = listOf(
            "/scripts/../../config.yaml",
            "/scripts/../../secrets.json",
            "/scripts/../lib.js",
            "/scripts/./main.js",
            "/frontend-assets/../../secrets.json",
            "/scripts/%2e%2e/config.yaml",
            "/scripts/%2E%2E/%2E%2E/secrets.json",
            "/scripts/%2e/main.js",
            "/scripts/sub%2f..%2f..%2fsecrets.json",
            "/scripts/sub%2Fmain.js",
            "/scripts/sub%5cmain.js",
            "/scripts/sub%5C..%5C..%5Csecrets.json",
            "/scripts/%252e%252e/secrets.json",
            "/scripts/%252f../secrets.json",
            "/scripts/%255c../secrets.json",
            "/scripts/main%00.js",
            "/scripts/main%2500.js",
            "/scripts/main\u0000.js",
            "/scripts/..\\secrets.json",
            "/scripts/sub\\main.js",
            "//scripts/main.js",
            "/scripts//main.js",
            "/scripts/",
            "/frontend-assets/",
            "/scripts/%ZZ.js",
            "/scripts/trunc%2",
            "/scripts/%C0%AF../secrets.json",
        )
        for (attack in attacks) {
            assertNull("traversal must be rejected: $attack", intercept(attack))
        }
    }

    @Test
    fun blocksSymlinkEscapeOutsideRootWhileAllowingSafeInternalLinks() {
        val escapedFileLink = publicDir.resolve("scripts/escaped-secrets.json")
        val escapedDirLink = publicDir.resolve("scripts/escaped-data")
        val internalLink = publicDir.resolve("scripts/alias-main.js")
        val symlinksSupported = try {
            Files.createSymbolicLink(escapedFileLink, checkout.resolve("secrets.json"))
            Files.createSymbolicLink(escapedDirLink, checkout.resolve("data"))
            Files.createSymbolicLink(internalLink, publicDir.resolve("scripts/main.js"))
            true
        } catch (_: UnsupportedOperationException) {
            false
        } catch (_: java.nio.file.FileSystemException) {
            // Windows without Developer Mode refuses unprivileged symlink creation.
            false
        }
        assumeTrue("Filesystem does not permit unprivileged symlinks", symlinksSupported)

        assertNull(intercept("/scripts/escaped-secrets.json"))
        assertNull(intercept("/scripts/escaped-data/secrets.json"))

        val safe = checkNotNull(intercept("/scripts/alias-main.js"))
        assertEquals("export const main = true;\n", safe.data.use { it.reader().readText() })
    }

    @Test
    fun rejectsNonGetRangeHeadersWrongOriginsMissingFilesAndUnmappedExtensions() {
        // Non-GET methods must go to Express.
        for (method in listOf("POST", "HEAD", "PUT", "DELETE", "OPTIONS")) {
            assertNull(method, intercept("/scripts/main.js", method = method))
        }

        // Range requests must go to Express so 206 Partial Content works.
        assertNull(intercept("/webfonts/Adwaita.woff2", headers = mapOf("Range" to "bytes=0-63")))
        assertNull(intercept("/img/logo.png", headers = mapOf("range" to "bytes=0-")))

        // Non-app origins must never be served.
        val wrongOrigins = listOf(
            "http://127.0.0.1:$PORT/scripts/main.js",
            "http://localhost:$PORT/scripts/main.js",
            "http://${address.host}:${PORT + 1}/scripts/main.js",
            "http://other.localhost:$PORT/scripts/main.js",
            "https://${address.host}:$PORT/scripts/main.js",
            "http://user@${address.host}:$PORT/scripts/main.js",
            "https://example.com/scripts/main.js",
        )
        for (url in wrongOrigins) {
            assertNull(url, interceptor.intercept(TestRequest(url), app))
        }

        // Missing files, directories and unmapped extensions fall through cleanly.
        assertNull(intercept("/scripts/missing.js"))
        Files.createDirectories(publicDir.resolve("scripts/folder.js"))
        assertNull(intercept("/scripts/folder.js"))
        write(publicDir.resolve("scripts/sound.mp3"), byteArrayOf(1, 2, 3))
        assertNull(intercept("/scripts/sound.mp3"))
        write(publicDir.resolve("scripts/.hidden"), "x")
        assertNull(intercept("/scripts/.hidden"))
    }

    @Test
    fun rejectsMainFrameCrossSiteHeadersAndInternalSymlinksToExcludedPathsAndMatchesFrontendCacheRules() {
        // Main-frame navigations must hit Express so SameSite=Strict launch-token auth is enforced.
        assertNull(intercept("/lib/template.html", mainFrame = true))
        assertNull(intercept("/scripts/main.js", mainFrame = true))

        // Cross-site or cross-origin subresource headers fall through to Express.
        assertNull(intercept("/scripts/main.js", headers = mapOf("Sec-Fetch-Site" to "cross-site")))
        assertNull(intercept("/scripts/main.js", headers = mapOf("Sec-Fetch-Site" to "same-site")))
        assertNull(intercept("/scripts/main.js", headers = mapOf("Sec-Fetch-Site" to "none")))
        assertNull(intercept("/scripts/main.js", headers = mapOf("Origin" to "https://openrouter.ai")))

        // Same-origin headers remain intercepted and include helmet-equivalent framing/CORP headers.
        val sameOrigin = checkNotNull(
            intercept(
                "/scripts/main.js",
                headers = mapOf("Sec-Fetch-Site" to "same-origin", "Origin" to origin),
            ),
        )
        assertEquals("same-origin", sameOrigin.responseHeaders["Cross-Origin-Resource-Policy"])
        assertEquals("SAMEORIGIN", sameOrigin.responseHeaders["X-Frame-Options"])
        assertEquals("no-referrer", sameOrigin.responseHeaders["Referrer-Policy"])
        sameOrigin.data.close()

        // Unhashed files under /frontend-assets/ must revalidate instead of being marked immutable.
        write(frontendDistDir.resolve("unhashed.js"), "export const plain = 1;\n")
        assertServed(
            path = "/frontend-assets/unhashed.js",
            expectedMime = "text/javascript",
            expectedEncoding = "utf-8",
            expectedCache = "no-cache",
            expectedText = "export const plain = 1;\n",
        )

        // Internal symlinks pointing at excluded paths inside public/ must still fall through.
        val aliasExcluded = publicDir.resolve("scripts/alias-user.css")
        val symlinksSupported = try {
            Files.createSymbolicLink(aliasExcluded, publicDir.resolve("css/user.css"))
            true
        } catch (_: UnsupportedOperationException) {
            false
        } catch (_: java.nio.file.FileSystemException) {
            false
        }
        if (symlinksSupported) {
            assertNull(intercept("/scripts/alias-user.css"))
        }
    }

    private fun intercept(
        path: String,
        method: String = "GET",
        headers: Map<String, String> = emptyMap(),
        mainFrame: Boolean = false,
    ): WebResourceResponse? = interceptor.intercept(TestRequest("$origin$path", method, headers, mainFrame), app)

    private fun assertServed(
        path: String,
        expectedMime: String,
        expectedEncoding: String?,
        expectedCache: String,
        expectedText: String,
    ) {
        val response = checkNotNull(intercept(path)) { "expected response for $path" }
        assertEquals(path, 200, response.statusCode)
        assertEquals(path, "OK", response.reasonPhrase)
        assertEquals(path, expectedMime, response.mimeType)
        assertEquals(path, expectedEncoding, response.encoding)
        assertEquals(path, "nosniff", response.responseHeaders["X-Content-Type-Options"])
        assertEquals(path, "same-origin", response.responseHeaders["Cross-Origin-Resource-Policy"])
        assertEquals(path, "SAMEORIGIN", response.responseHeaders["X-Frame-Options"])
        assertEquals(path, "no-referrer", response.responseHeaders["Referrer-Policy"])
        assertEquals(path, expectedCache, response.responseHeaders["Cache-Control"])
        assertEquals(path, expectedText, response.data.use { it.bufferedReader().readText() })
    }

    private fun write(path: Path, text: String) = write(path, text.toByteArray(Charsets.UTF_8))

    private fun write(path: Path, bytes: ByteArray) {
        Files.createDirectories(path.parent)
        Files.write(path, bytes)
    }

    private class TestRequest(
        private val rawUrl: String,
        private val method: String = "GET",
        private val headers: Map<String, String> = emptyMap(),
        private val mainFrame: Boolean = false,
    ) : WebResourceRequest {
        private val parsed: Uri = Uri.parse(rawUrl)

        override fun getUrl(): Uri = parsed

        override fun isForMainFrame(): Boolean = mainFrame

        override fun isRedirect(): Boolean = false

        override fun hasGesture(): Boolean = false

        override fun getMethod(): String = method

        override fun getRequestHeaders(): Map<String, String> = headers
    }

    private companion object {
        const val LABEL = "sb-abcdefghijklmnopqrstuvwxyz"
        const val PORT = 41_234
    }
}
