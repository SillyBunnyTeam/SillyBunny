package io.github.sillybunnyteam.sillybunny.update

import android.content.Context
import android.content.pm.PackageInfo
import android.content.pm.Signature
import android.content.pm.SigningInfo
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import java.io.Closeable
import java.io.IOException
import java.net.InetSocketAddress
import java.security.MessageDigest
import java.util.Collections
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import org.json.JSONArray
import org.json.JSONObject
import org.robolectric.Shadows.shadowOf

internal object CoreTestFixtures {
    const val ABI = "arm64-v8a"
    const val APK_NAME = "SillyBunny-android-arm64-v8a.apk"
    val certificate = Signature(byteArrayOf(1, 3, 5, 7, 9))
    val signer: ByteArray = MessageDigest.getInstance("SHA-256").digest(certificate.toByteArray())
    val payload = ByteArray(131_073) { (it % 251).toByte() }

    fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it.toInt() and 0xff) }

    fun hash(bytes: ByteArray): String = hex(MessageDigest.getInstance("SHA-256").digest(bytes))

    fun manifest(
        version: Long = 2,
        prerelease: Boolean = false,
        signer: String = hex(this.signer),
        payload: ByteArray = this.payload,
    ): JSONObject = JSONObject().apply {
        put("schema", 1)
        put("versionCode", version)
        put("versionName", "1.$version.0")
        put("prerelease", prerelease)
        put("releaseTag", "v1.$version.0")
        put("defaultRef", if (prerelease) "staging" else "release")
        put("minSdk", 29)
        put("signingCertSha256", signer)
        put("inputsHash", "ab".repeat(32))
        put("assets", JSONObject().put(ABI, JSONObject().apply {
            put("name", APK_NAME)
            put("sha256", hash(payload))
            put("size", payload.size)
        }))
        put("runtime", JSONObject().apply {
            put("node", "24.10.0")
            put("bun", JSONObject.NULL)
            put("git", "2.51.0")
            put("bash", "5.3")
            put("npm", "11.6.0")
        })
    }

    fun release(manifestUrl: String?, apkUrl: String? = null, draft: Boolean = false): JSONObject =
        JSONObject().apply {
            put("draft", draft)
            put("prerelease", true)
            put("assets", JSONArray().apply {
                if (manifestUrl != null) put(asset("android-update.json", manifestUrl))
                if (apkUrl != null) put(asset(APK_NAME, apkUrl))
            })
        }

    fun asset(name: String, url: String): JSONObject = JSONObject().apply {
        put("name", name)
        put("browser_download_url", url)
    }

    fun signingInfo(current: Array<Signature>, history: Array<Signature> = current): SigningInfo =
        SigningInfo().also {
            shadowOf(it).setSignatures(current)
            shadowOf(it).setPastSigningCertificates(history)
        }

    fun packageInfo(context: Context, version: Long, signers: Array<Signature> = arrayOf(certificate)): PackageInfo =
        PackageInfo().apply {
            packageName = context.packageName
            setLongVersionCode(version)
            applicationInfo = context.applicationInfo
            signingInfo = CoreTestFixtures.signingInfo(signers)
        }
}

internal class UpdateTestServer : Closeable {
    private val handlers = ConcurrentHashMap<String, (HttpExchange) -> Unit>()
    private val executor = Executors.newCachedThreadPool { task ->
        Thread(task, "update-http-test").apply { isDaemon = true }
    }
    private val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
    val requests: MutableList<String> = Collections.synchronizedList(mutableListOf())

    init {
        server.executor = executor
        server.createContext("/") { exchange ->
            val path = exchange.requestURI.path
            requests.add(path)
            try {
                val handler = handlers[path]
                if (handler == null) exchange.sendResponseHeaders(404, -1) else handler(exchange)
            } catch (_: IOException) {
                // Oversize and timeout tests deliberately close the socket before the response ends.
            } finally {
                exchange.close()
            }
        }
        server.start()
    }

    fun url(path: String): String = "http://127.0.0.1:${server.address.port}$path"

    fun handle(path: String, handler: (HttpExchange) -> Unit) {
        handlers[path] = handler
    }

    fun json(path: String, value: String, chunked: Boolean = false) {
        bytes(path, value.toByteArray(Charsets.UTF_8), chunked = chunked)
    }

    fun bytes(path: String, value: ByteArray, status: Int = 200, chunked: Boolean = false) {
        handle(path) { exchange ->
            exchange.sendResponseHeaders(status, if (chunked) 0 else value.size.toLong())
            exchange.responseBody.use { it.write(value) }
        }
    }

    fun redirect(path: String, location: String, status: Int = 302) {
        handle(path) { exchange ->
            exchange.responseHeaders.set("Location", location)
            exchange.sendResponseHeaders(status, -1)
        }
    }

    override fun close() {
        server.stop(0)
        executor.shutdownNow()
    }
}
