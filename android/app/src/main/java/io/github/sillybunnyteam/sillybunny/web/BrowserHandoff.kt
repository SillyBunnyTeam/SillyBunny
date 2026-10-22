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

    /** A fresh single-use handoff URL for [session]; it expires [LIFETIME_MILLIS] after [nowMillis]. */
    fun uri(session: LaunchSession, nowMillis: Long = System.currentTimeMillis()): Uri {
        val nonce = ByteArray(NONCE_BYTES).also { random.nextBytes(it) }
        val code = code(session.token, nonce, nowMillis + LIFETIME_MILLIS)
        return "${session.origin}$PATH?c=$code".toUri()
    }
}

/**
 * Opens the app's UI in the user's browser through a fresh handoff code (plan §3.3, §4.5). Returns false
 * when no browser could be started. Settings and the WebView screen's fallbacks call this.
 *
 * What follows in the browser, measured with Chrome 145 on API 37:
 * - The code keeps the token out of the URL, but redeeming it gives the browser the launch token itself,
 *   as the session cookie `sillybunny_launch` for 127.0.0.1. Cookies are not port-isolated, so the browser
 *   sends the token to every 127.0.0.1 port for as long as its process keeps the cookie. A page that any
 *   app opens there on another loopback port receives it with its image, WebSocket and favicon requests.
 *   The app's navigation controls do not reach the browser.
 * - The server answers the code with a page that moves to `/` itself, and that same-origin navigation
 *   carries the `SameSite=Strict` cookie. A 302 to `/` landed Chrome on the gate's 403 page instead: the
 *   redirect belonged to a navigation that another app started, so Chrome did not send the cookie with it.
 */
fun openInBrowser(context: Context, session: LaunchSession): Boolean =
    startViewIntent(context, BrowserHandoff.uri(session))

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
