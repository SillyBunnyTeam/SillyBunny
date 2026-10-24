package io.github.sillybunnyteam.sillybunny.web

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.net.Uri
import androidx.core.net.toUri
import io.github.sillybunnyteam.sillybunny.server.LaunchSession
import java.nio.ByteBuffer
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * Browser handoff codes (plan §3.3), the Kotlin side of `src/middleware/launchToken.js`:
 * unpadded base64url of `nonce || expiry || mac`, 56 bytes or 75 characters, where `nonce` is 16 random
 * bytes, `expiry` is unsigned 64-bit big-endian Unix milliseconds and `mac` is HMAC-SHA256 keyed with the
 * UTF-8 launch token over `ASCII("handoff") || nonce || expiry`. The token itself never enters a URL.
 */
object BrowserHandoff {
    const val PATH = "/__sillybunny/handoff"
    const val NONCE_BYTES = 16
    const val CODE_LENGTH = 75

    /** How long a code stays valid. The server rejects codes that expire more than 60 s ahead. */
    const val LIFETIME_MILLIS = 30_000L

    private val random = SecureRandom()

    fun code(token: String, nonce: ByteArray, expiryMillis: Long): String {
        require(nonce.size == NONCE_BYTES) { "nonce" }
        require(expiryMillis >= 0) { "expiry" }
        val payload = ByteBuffer.allocate(NONCE_BYTES + Long.SIZE_BYTES)
            .put(nonce)
            .putLong(expiryMillis)
            .array()
        val mac = Mac.getInstance("HmacSHA256").run {
            init(SecretKeySpec(token.toByteArray(Charsets.UTF_8), "HmacSHA256"))
            update("handoff".toByteArray(Charsets.US_ASCII))
            doFinal(payload)
        }
        return Base64.getUrlEncoder().withoutPadding().encodeToString(payload + mac)
    }

    /**
     * A fresh single-use handoff URL for [session] on [address]'s web origin; it expires [LIFETIME_MILLIS]
     * after [nowMillis].
     */
    fun uri(session: LaunchSession, address: WebAddress, nowMillis: Long = System.currentTimeMillis()): Uri {
        val nonce = ByteArray(NONCE_BYTES).also { random.nextBytes(it) }
        val code = code(session.token, nonce, nowMillis + LIFETIME_MILLIS)
        return "${address.origin(session)}$PATH?c=$code".toUri()
    }
}

/**
 * Opens the app's UI in the user's browser through a fresh handoff code (plan §3.3, §4.5), on the app's
 * per-install web origin `http://<label>.localhost:<port>` ([WebAddress]). Returns false when no browser
 * could be started. Settings and the WebView screen's fallbacks call this.
 *
 * What the browser gets, measured with Chrome 145 on API 37 (integration track p56int):
 * - The `ACTION_VIEW` URL carries the label and a single-use code, never the token. Whoever handles the
 *   intent (the default browser, or the app the user picks) can redeem the code once, within
 *   [BrowserHandoff.LIFETIME_MILLIS], and so obtain the token.
 * - The server answers the code with a page that moves to `/` itself and sets the launch token as the
 *   host-only session cookie `sillybunny_launch` for `<label>.localhost`. The browser sends it to that host
 *   on every port, and to no other host: not to `127.0.0.1`, `localhost` or other `*.localhost` names. A
 *   page that another app opens on its own loopback port receives the cookie only if that app knows the
 *   label. The cookie lasts while the browser keeps its session cookies; the token is valid for the whole
 *   server run. The app's navigation controls do not reach the browser.
 */
fun openInBrowser(context: Context, session: LaunchSession, address: WebAddress = WebAddress.forInstall(context)): Boolean =
    startViewIntent(context, BrowserHandoff.uri(session, address))

/** Starts `ACTION_VIEW` for [uri] as a browsable link; false when nothing can handle it. */
internal fun startViewIntent(context: Context, uri: Uri): Boolean {
    val intent = Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE)
    val activity = context.findActivity()
    if (activity == null) intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    return try {
        (activity ?: context).startActivity(intent)
        true
    } catch (_: ActivityNotFoundException) {
        false
    } catch (_: SecurityException) {
        false
    }
}

internal fun Context.findActivity(): Activity? {
    var current: Context? = this
    while (current is ContextWrapper) {
        if (current is Activity) return current
        current = current.baseContext
    }
    return null
}
