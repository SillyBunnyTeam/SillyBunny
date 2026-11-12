package io.github.sillybunnyteam.sillybunny.server

import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import kotlin.random.Random

/** Host-side test listeners use random free loopback ports in 20000-60999, never 4444. */
internal object TestPorts {
    private val loopback: InetAddress = InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1))

    fun bindLoopback(ports: IntRange = 20_000..60_999): ServerSocket {
        require(ports.first >= 20_000 && ports.last <= 60_999)
        repeat(200) {
            val port = Random.nextInt(ports.first, ports.last + 1)
            val socket = ServerSocket()
            try {
                socket.reuseAddress = true
                socket.bind(InetSocketAddress(loopback, port), 50)
                return socket
            } catch (_: IOException) {
                socket.close()
            }
        }
        throw IOException("no free test port")
    }
}
