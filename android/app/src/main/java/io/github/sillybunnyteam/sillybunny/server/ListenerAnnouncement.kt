package io.github.sillybunnyteam.sillybunny.server

/**
 * Recognizes the server's own announcement that it holds the session port. `src/server-main.js` prints
 * `SillyBunny is listening on [IPv6: [::1]:<P>] IPv4: 127.0.0.1:<P>` once `server.listen` succeeded, possibly
 * with ANSI colors, on the output only this app reads.
 *
 * The launch token goes to `127.0.0.1:<P>` only after this line: before it, any other app could be listening on
 * the port. While the server holds the port, no other UID can bind it (Node sets no `SO_REUSEPORT`). Only the
 * IPv4 part counts, because the probe and the WebView use 127.0.0.1; an IPv6-only listener proves nothing there.
 */
internal object ListenerAnnouncement {
    private val ansi = Regex("\u001B\\[[0-?]*[ -/]*[@-~]")
    private val announcement = Regex("""\bis listening on\b.*\bIPv4: 127\.0\.0\.1:(\d{1,5})(?=\s|$)""")

    fun matches(line: String, port: Int): Boolean {
        if (!line.contains("listening")) return false
        val found = announcement.find(ansi.replace(line, "")) ?: return false
        return found.groupValues[1].toIntOrNull() == port
    }
}
