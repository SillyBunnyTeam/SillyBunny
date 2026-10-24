package io.github.sillybunnyteam.sillybunny.server

import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import kotlin.random.Random

/** Where the chosen port, and an origin change not reported yet, are kept between runs. */
internal interface PortStore {
    var port: Int?

    /** True from a port replacement until a Running state on the new port has reported it. */
    var originChangePending: Boolean

    /** Saves a replacement [port] together with a pending origin change; stores that can should write both at once. */
    fun replacePort(port: Int) {
        originChangePending = true
        this.port = port
    }
}

/**
 * Chooses the server's guest-loopback port (plan §2.5, §4.5).
 *
 * The WebView origin includes the port, and drafts, LocalForage caches and IndexedDB stay reachable
 * only while it is stable. So the first start picks a free port in [RANGE] and persists it, and every
 * later start reuses it. A busy port is retried [busyAttempts] times, [busyDelayMillis] apart; if it
 * stays busy, a new port is picked and persisted with a pending origin change. Every choice reports
 * `originChanged` until [originChangeReported] clears it, so a run that ends before it is healthy, or
 * a host death, never loses the change.
 */
internal class PortPolicy(
    private val store: PortStore,
    private val isFree: (Int) -> Boolean = ::loopbackPortFree,
    private val random: Random = Random.Default,
    private val sleep: (Long) -> Unit = Thread::sleep,
    private val busyAttempts: Int = 5,
    private val busyDelayMillis: Long = 400,
) {
    data class Choice(val port: Int, val originChanged: Boolean)

    fun choose(): Choice {
        val saved = store.port?.takeIf { it in RANGE }
        if (saved != null) {
            for (attempt in 1..busyAttempts) {
                if (isFree(saved)) return Choice(saved, originChanged = store.originChangePending)
                if (attempt < busyAttempts) sleep(busyDelayMillis)
            }
        }
        val fresh = pickFree(exclude = saved) ?: throw IOException("port")
        if (saved == null) {
            store.port = fresh
            return Choice(fresh, originChanged = false)
        }
        store.replacePort(fresh)
        return Choice(fresh, originChanged = true)
    }

    /** A Running state on [port] has reported the origin change; later starts on it report none. */
    fun originChangeReported(port: Int) {
        if (store.port == port && store.originChangePending) store.originChangePending = false
    }

    private fun pickFree(exclude: Int?): Int? {
        repeat(MAX_CANDIDATES) {
            val candidate = random.nextInt(RANGE.first, RANGE.last + 1)
            if (candidate != exclude && candidate != LIVE_SERVER_PORT && isFree(candidate)) return candidate
        }
        return null
    }

    companion object {
        /** The dynamic port range; it never contains [LIVE_SERVER_PORT]. */
        val RANGE = 49_152..65_535

        /** SillyBunny's default port, used by desktop installs; never chosen. */
        const val LIVE_SERVER_PORT = 4444

        private const val MAX_CANDIDATES = 64

        private val loopback: InetAddress = InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1))

        /** True when nothing listens on `127.0.0.1:<port>`, using the same address reuse rule as Node. */
        fun loopbackPortFree(port: Int): Boolean = try {
            ServerSocket().use { socket ->
                socket.reuseAddress = true
                socket.bind(InetSocketAddress(loopback, port), 1)
            }
            true
        } catch (_: IOException) {
            false
        }
    }
}
