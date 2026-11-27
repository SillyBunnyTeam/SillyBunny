package io.github.sillybunnyteam.sillybunny.web

import android.content.Context
import androidx.core.content.edit
import io.github.sillybunnyteam.sillybunny.server.LaunchSession
import java.security.SecureRandom

/**
 * The app's per-install web origin `http://<label>.localhost:<port>` (plan §3.3, §4.5).
 *
 * - The WebView and the browser load the app from this origin, not from the server's native address
 *   [LaunchSession.origin] (`http://127.0.0.1:<port>`). The launch cookie is set without a `Domain`
 *   attribute, so it is host-only: it goes to `<label>.localhost` and to no other host, never to
 *   `127.0.0.1`, `localhost` or another `*.localhost` name. Cookies are not port-isolated, so a listener
 *   on another loopback port receives it only from a request aimed at `<label>.localhost`, which needs
 *   the label.
 * - Chromium resolves `localhost` and `*.localhost` to loopback itself, with no DNS query (RFC 6761), and
 *   treats the origin as a secure context. Android's own resolver does not: native clients, such as the
 *   app's download fetch and the server health probe, connect to [LaunchSession.origin] instead.
 * - The label is `sb-` plus 26 lowercase base32 characters (128 bits from [SecureRandom]). It is created on
 *   first use and kept in the app's private preferences, which are excluded from backup and device
 *   transfer, so the origin and its client-side storage stay the same for the install. Never log it or put
 *   it in a notification: [toString] leaves it out, and only the handoff URL that Open in browser opens
 *   carries it out of the app on purpose.
 */
class WebAddress internal constructor(internal val label: String) {
    init {
        require(isLabel(label)) { "label" }
    }

    /** The host name of the app's pages: `<label>.localhost`. */
    internal val host: String get() = "$label.localhost"

    /** The web origin of [session]'s pages: `http://<label>.localhost:<port>`, without a trailing slash. */
    fun origin(session: LaunchSession): String = origin(session.port)

    internal fun origin(port: Int): String = "http://$host:$port"

    /** The exact origin the navigation policy compares pages and requests with. */
    internal fun appOrigin(port: Int): AppOrigin = AppOrigin(host, port)

    override fun equals(other: Any?): Boolean = other is WebAddress && other.label == label

    override fun hashCode(): Int = label.hashCode()

    // The label keeps other apps from addressing the cookie's host, so it never appears in logs.
    override fun toString(): String = "WebAddress(label hidden)"

    companion object {
        private const val PREFERENCES = "io.github.sillybunnyteam.sillybunny.web"
        private const val KEY_LABEL = "origin_label"
        private const val PREFIX = "sb-"
        private const val LABEL_BYTES = 16
        private const val ALPHABET = "abcdefghijklmnopqrstuvwxyz234567"
        private val labelPattern = Regex("sb-[a-z2-7]{26}")
        private val anyLabel = Regex("sb-[a-z2-7]{26}", RegexOption.IGNORE_CASE)

        @Volatile
        private var installed: WebAddress? = null

        /** This install's address, read once per process; created and stored on first use. */
        fun forInstall(context: Context): WebAddress {
            installed?.let { return it }
            return synchronized(this) {
                installed ?: read(context.applicationContext).also { installed = it }
            }
        }

        /** Reads the stored label, or creates and stores a new one; no process cache. */
        internal fun read(context: Context): WebAddress {
            val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
            preferences.getString(KEY_LABEL, null)?.takeIf(::isLabel)?.let { return WebAddress(it) }
            val label = newLabel(SecureRandom())
            // Written before first use: another label later would be another origin, without this one's storage.
            // A failed write still serves this process; the next start then creates a new label.
            preferences.edit(commit = true) { putString(KEY_LABEL, label) }
            return WebAddress(label)
        }

        /** `sb-` plus the unpadded lowercase base32 of 16 random bytes: 26 characters. */
        internal fun newLabel(random: SecureRandom): String {
            val bytes = ByteArray(LABEL_BYTES).also(random::nextBytes)
            val out = StringBuilder(PREFIX.length + 26).append(PREFIX)
            var buffer = 0
            var bits = 0
            for (byte in bytes) {
                buffer = (buffer shl 8) or (byte.toInt() and 0xff)
                bits += 8
                while (bits >= 5) {
                    out.append(ALPHABET[(buffer shr (bits - 5)) and 0x1f])
                    bits -= 5
                }
            }
            if (bits > 0) out.append(ALPHABET[(buffer shl (5 - bits)) and 0x1f])
            return out.toString()
        }

        internal fun isLabel(value: String): Boolean = labelPattern.matches(value)

        /** [text] with every label in it replaced by `<label>`, for logs and test output. */
        internal fun redact(text: String): String = anyLabel.replace(text, "<label>")
    }
}
