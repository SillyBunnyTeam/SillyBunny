package io.github.sillybunnyteam.sillybunny.server

/**
 * One app-started server run: the guest-loopback port passed as `start.sh -- --port <port>` and the
 * `SILLYBUNNY_LAUNCH_TOKEN` value (32 random bytes as lowercase hex), plan §2.5 and §3.3.
 */
class LaunchSession(val port: Int, val token: String) {
    init {
        require(port in 1..65_535) { "port" }
        require(tokenPattern.matches(token)) { "token" }
    }

    /** Exact WebView origin. Client-side storage stays reachable only while the port stays stable. */
    val origin: String get() = "http://127.0.0.1:$port"

    override fun equals(other: Any?): Boolean =
        other is LaunchSession && other.port == port && other.token == token

    override fun hashCode(): Int = 31 * port + token.hashCode()

    // The token authorizes every request, so it never appears in logs or crash reports.
    override fun toString(): String = "LaunchSession(port=$port)"

    companion object {
        const val COOKIE_NAME = "sillybunny_launch"
        private val tokenPattern = Regex("[0-9a-f]{64}")
    }
}
