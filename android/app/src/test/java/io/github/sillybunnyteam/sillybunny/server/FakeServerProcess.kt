package io.github.sillybunnyteam.sillybunny.server

import java.io.IOException
import java.io.InputStream
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * A process group without processes: output is fed by the test, and signals end it the way the real
 * group does (a graceful supervisor exits 0, a group SIGTERM 143, SIGKILL 137) unless told to ignore them.
 */
internal class FakeServerProcess(val spec: LaunchSpec) : ServerProcess {
    private val chunks = LinkedBlockingQueue<ByteArray>()
    private val exited = CountDownLatch(1)

    @Volatile
    private var status: Int? = null

    val signals = CopyOnWriteArrayList<String>()

    @Volatile
    var supervisorExitsGracefully = true

    @Volatile
    var groupTermExits = true

    @Volatile
    var killExits = true

    /** Members left behind after the command itself exited, as after a supervisor SIGKILL. */
    @Volatile
    var leftovers = false

    @Volatile
    var released = false
        private set

    /** The server child serving HTTP; [replaceServerChild] swaps it the way the supervisor does after exit 75. */
    @Volatile
    var serverChild: ProcStat? = child(SERVER_PID)
        private set

    /** The `--port` value of the launch, for [announceListening]. */
    val port: Int? get() = spec.argv.indexOf("--port").takeIf { it >= 0 }?.let { spec.argv.getOrNull(it + 1)?.toIntOrNull() }

    override val output: InputStream = object : InputStream() {
        private var current = ByteArray(0)
        private var position = 0
        private var ended = false

        override fun read(): Int {
            val one = ByteArray(1)
            return if (read(one, 0, 1) < 0) -1 else one[0].toInt() and 0xff
        }

        override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
            if (ended) return -1
            while (position >= current.size) {
                current = try {
                    chunks.take()
                } catch (_: InterruptedException) {
                    throw IOException("interrupted")
                }
                position = 0
                if (current.isEmpty()) {
                    ended = true
                    return -1
                }
            }
            val count = minOf(length, current.size - position)
            System.arraycopy(current, position, buffer, offset, count)
            position += count
            return count
        }
    }

    fun write(text: String) {
        chunks.put(text.toByteArray(Charsets.UTF_8))
    }

    fun print(line: String) = write("$line\n")

    /** What `src/server-main.js` prints once it listens, colored as chalk would color it. */
    fun announceListening(port: Int = checkNotNull(this.port)) =
        print("SillyBunny is listening on\u001B[32m IPv6: [::1]:$port\u001B[39m\u001B[32m IPv4: 127.0.0.1:$port\u001B[39m")

    /** The supervisor replaced its server child (exit 75 or 76); the new child has announced nothing yet. */
    fun replaceServerChild() {
        serverChild = child((serverChild?.pid ?: SERVER_PID) + 1)
    }

    /** The server child exited and the supervisor has not started another one. */
    fun loseServerChild() {
        serverChild = null
    }

    /** The command exits with [code]; the output ends once nothing is left behind. */
    @Synchronized
    fun exit(code: Int) {
        if (status != null) return
        status = code
        exited.countDown()
        if (!leftovers) chunks.put(ByteArray(0))
    }

    @Synchronized
    private fun clearLeftovers() {
        if (leftovers) {
            leftovers = false
            chunks.put(ByteArray(0))
        }
    }

    override fun waitForExit(timeoutMillis: Long): Boolean = exited.await(timeoutMillis, TimeUnit.MILLISECONDS)

    override val exitCode: Int? get() = if (exited.count == 0L) status else null

    override fun signalSupervisor(signal: Int): Boolean {
        signals += "supervisor:$signal"
        if (supervisorExitsGracefully && signal == Signals.SIGTERM) exit(0)
        return true
    }

    override fun signalGroup(signal: Int): Boolean {
        signals += "group:$signal"
        val dies = if (signal == Signals.SIGKILL) killExits else groupTermExits
        if (dies) {
            exit(128 + signal)
            clearLeftovers()
        }
        return true
    }

    override fun isGone(): Boolean = exited.count == 0L && !leftovers

    override fun ids(): ProcessIds = ProcessIds(processGroup = 4100, shell = 4100, command = 4106, supervisor = 4200, server = 4207)

    override fun servingProcess(): ProcStat? = serverChild?.takeIf { exited.count != 0L }

    override fun stillRunning(server: ProcStat): Boolean = exited.count != 0L && serverChild?.same(server) == true

    override fun release() {
        released = true
        chunks.put(ByteArray(0))
    }

    private companion object {
        const val SERVER_PID = 4207

        fun child(pid: Int) = ProcStat(pid, uid = 10_123, state = "S", ppid = 4200, pgid = 4100, session = 4100, startTime = pid * 10L)
    }
}
