package io.github.sillybunnyteam.sillybunny.server

import android.app.ActivityManager
import android.app.NotificationManager
import android.content.Context
import android.os.SystemClock
import android.system.ErrnoException
import android.system.Os
import android.util.Log
import androidx.test.platform.app.InstrumentationRegistry
import io.github.sillybunnyteam.sillybunny.ServerService
import io.github.sillybunnyteam.sillybunny.runtime.RuntimePaths
import org.junit.Assert.fail
import java.io.Closeable
import java.io.File
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import kotlin.random.Random

/**
 * Drives the real [ServerManager], [ServerService] and [SessionProcess] on a device with a test-only launch
 * spec: `/system/bin/sh` stand-ins for `start.sh` (the command), the Node supervisor and the server child,
 * plus an `install.sh` stand-in for setup jobs. Tests reach it only through [ServerManager.replaceForTest];
 * no intent or production code path selects it.
 */
internal class ServerDeviceFixture : Closeable {
    val context: Context = InstrumentationRegistry.getInstrumentation().targetContext
    private val root = File(context.filesDir, "p54-device/${UUID.randomUUID()}")
    val paths = RuntimePaths(
        File(root, "files"),
        File(context.cacheDir, "p54-device/${root.name}"),
        File(context.applicationInfo.nativeLibraryDir),
    )
    val checkout: File = paths.checkoutDir
    val specs = ShellLaunchSpecs(checkout)

    /** Launch-token gates by port; a session on a new port gets one when its spec is created. */
    val responders = ConcurrentHashMap<Int, HealthResponder>()

    /** The gate on the port the policy reuses, which the fixture persists before every test. */
    val responder: HealthResponder

    init {
        resetPersistentState(context)
        check(checkout.mkdirs()) { "checkout" }
        writeScripts()
        setMode(MODE_GRACEFUL)
        responder = HealthResponder(freeDynamicPort())
        responders[responder.port] = responder
        ServerStateStore(context).port = responder.port
        specs.onSession = { session -> responderFor(session.port).token = session.token }
    }

    fun build(
        stop: StopConfig = StopConfig(),
        restart: RestartConfig = RestartConfig(firstBackoffMillis = 200, maxBackoffMillis = 800),
    ): ServerManager {
        val controlDir = File(paths.cacheDir, "control")
        val dependencies = ServerDependencies(
            paths = { paths },
            logsDir = paths.logsDir,
            controlDir = controlDir,
            launcher = SessionLauncher(controlDir),
            versionCode = { VERSION_CODE },
            autoUpdate = { false },
            lastExitUserRequested = { ExitHistory.lastExitUserRequested(context) },
            launchSpecs = specs,
            scriptInterpreter = { listOf(SH) },
            health = HealthProbe(),
            restart = restart,
            stop = stop,
            healthPollMillis = 100,
            startupTimeoutMillis = 60_000,
            // A responder already holds its port, which stands in for the server's own listener there.
            portFree = { port -> responders.containsKey(port) || PortPolicy.loopbackPortFree(port) },
        )
        return ServerManager(context, dependencies).also { ServerManager.replaceForTest(it) }
    }

    /** `graceful`, `stubborn-supervisor` (the supervisor ignores SIGTERM) or `stubborn-group` (only SIGKILL works). */
    fun setMode(mode: String) = File(checkout, "mode").writeText(mode)

    /** Makes the launcher write one `nodejs` logcat entry per start, as Node's C++ error reports do. */
    fun enableNativeReport() = File(checkout, "native-report").writeText("1")

    /** Makes the launcher start a background `sleep 600` and exit 3 at once, before any supervisor. */
    fun enableQuickExit() = File(checkout, "quick-exit").writeText("1")

    /** Makes every server child that starts from now on wait [seconds] before it announces its listener. */
    fun setListenDelay(seconds: Int) = File(checkout, "listen-delay").writeText("$seconds\n")

    /** Makes every server child start a `sleep 600` in a session of its own, as Node's `detached` spawns do. */
    fun enableDetachedChild() = File(checkout, "detached-child").writeText("1")

    /** The PID of the detached child that server child [serverPid] started, once it is written. */
    fun detachedPidOf(serverPid: Int): Int? = File(checkout, "detached.$serverPid").takeIf { it.isFile }
        ?.readText()?.takeIf { it.endsWith("\n") }?.trim()?.toIntOrNull()

    /** The PIDs of the background jobs that quick-exit launchers left behind. */
    fun orphanPids(): List<Int> = checkout.listFiles().orEmpty()
        .filter { it.name.startsWith("orphan.") }
        .mapNotNull { it.readText().trim().toIntOrNull() }

    fun setupScript(): File = File(checkout, "setup.sh")

    /** What the launcher (`start.sh`'s stand-in, the command) saw as its environment. */
    fun environmentOf(commandPid: Int): Map<String, String> = parseEnvironment(File(checkout, "env.$commandPid"))

    fun serverLogText(): String = logText(ServerManager.SERVER_LOG)

    fun setupLogText(): String = logText(ServerManager.SETUP_LOG)

    private fun logText(name: String): String = paths.logsDir.listFiles().orEmpty()
        .filter { it.name.startsWith(name) }
        .sortedByDescending { it.name }
        .joinToString("\n") { it.readText() }

    private fun responderFor(port: Int): HealthResponder = responders.computeIfAbsent(port, ::HealthResponder)

    override fun close() {
        var failure: Throwable? = null
        try {
            ServerManager.replaceForTest(null)
        } catch (error: Throwable) {
            failure = error
        }
        responders.values.forEach(HealthResponder::close)
        // A failed test must not leave its process groups behind for the next one, and a passing one has none.
        val leftovers = killLeftovers()
        if (leftovers > 0 && failure == null) failure = AssertionError("$leftovers processes outlived the test")
        try {
            waitUntil("service stopped", 10_000) { !isServiceRunning(context) }
        } catch (error: Throwable) {
            failure = failure ?: error
        }
        context.getSystemService(NotificationManager::class.java).cancel(ServerNotifications.NOTIFICATION_ID)
        resetPersistentState(context)
        root.deleteRecursively()
        paths.cacheDir.deleteRecursively()
        failure?.let { throw it }
    }

    /**
     * Kills every live process of this app's UID in a session other than the app's own (only setsid made
     * those) and returns how many there were.
     */
    private fun killLeftovers(): Int {
        val self = Procfs.read(Os.getpid()) ?: return 0
        val snapshot = try {
            Procfs.snapshot(Os.getuid())
        } catch (_: IOException) {
            return 0
        }
        var killed = 0
        for (process in snapshot.processes.values) {
            if (process.pid == self.pid || !process.live || process.session == self.session) continue
            val argv = Procfs.argv(process.pid)
            try {
                Os.kill(process.pid, Signals.SIGKILL)
                killed++
                Log.w(TAG, "killed leftover pid=${process.pid} pgid=${process.pgid} argv=$argv")
            } catch (_: ErrnoException) {
                // Already gone.
            }
        }
        return killed
    }

    private fun writeScripts() {
        File(checkout, "launcher.sh").writeText(
            """
            # Stand-in for start.sh: runs the supervisor in the foreground and exits with its status.
            dir=${'$'}(pwd)
            echo "launcher pid=${'$'}${'$'} args=${'$'}*"
            echo "launch token=${'$'}SILLYBUNNY_LAUNCH_TOKEN"
            /system/bin/env > "${'$'}dir/env.${'$'}${'$'}"
            if [ -f "${'$'}dir/native-report" ]; then
                /system/bin/log -t nodejs -p e "launcher native report pid=${'$'}${'$'}"
            fi
            if [ -f "${'$'}dir/quick-exit" ]; then
                /system/bin/sleep 600 &
                echo "${'$'}!" > "${'$'}dir/orphan.${'$'}${'$'}"
                exit 3
            fi
            /system/bin/sh "${'$'}dir/supervisor.sh" "${'$'}@"
            code=${'$'}?
            echo "launcher exit=${'$'}code"
            exit "${'$'}code"
            """.trimIndent() + "\n",
        )
        File(checkout, "supervisor.sh").writeText(
            """
            # Stand-in for the Node supervisor: replaces a server child that exits 75, as src/server-supervisor.js
            # does; SIGTERM asks the child to shut down, then exits 0.
            dir=${'$'}(pwd)
            mode=${'$'}(cat "${'$'}dir/mode")
            echo "supervisor pid=${'$'}${'$'} mode=${'$'}mode"
            child=
            shutdown() {
                echo "supervisor shutdown"
                if [ -n "${'$'}child" ]; then
                    kill -TERM "${'$'}child" 2>/dev/null
                    wait "${'$'}child"
                fi
                exit 0
            }
            case "${'$'}mode" in
                stubborn-*) trap 'echo "supervisor ignores TERM"' TERM ;;
                *) trap shutdown TERM ;;
            esac
            while :; do
                /system/bin/sh "${'$'}dir/server.sh" "${'$'}@" &
                child=${'$'}!
                while :; do
                    wait "${'$'}child"
                    code=${'$'}?
                    kill -0 "${'$'}child" 2>/dev/null || break
                done
                echo "supervisor child exit=${'$'}code"
                [ "${'$'}code" -eq 75 ] || exit "${'$'}code"
            done
            """.trimIndent() + "\n",
        )
        File(checkout, "server.sh").writeText(
            """
            # Stand-in for the server child: announces its listener the way src/server-main.js does (the test's
            # responder already holds the port), then prints a tick every second until stopped. SIGUSR1 makes it
            # exit 75, as an in-app restart does.
            dir=${'$'}(pwd)
            mode=${'$'}(cat "${'$'}dir/mode")
            echo "server pid=${'$'}${'$'} args=${'$'}*"
            port=
            while [ ${'$'}# -gt 0 ]; do
                if [ "${'$'}1" = --port ]; then port=${'$'}2; fi
                shift
            done
            if [ -f "${'$'}dir/detached-child" ]; then
                /system/bin/setsid /system/bin/sleep 600 &
                echo "${'$'}!" > "${'$'}dir/detached.${'$'}${'$'}"
            fi
            sleeper=
            case "${'$'}mode" in
                stubborn-group) trap 'echo "server ignores TERM"' TERM ;;
                *) trap 'kill "${'$'}sleeper" 2>/dev/null; echo "server shutdown"; exit 0' TERM ;;
            esac
            trap 'kill "${'$'}sleeper" 2>/dev/null; echo "server restarts"; exit 75' USR1
            if [ -f "${'$'}dir/listen-delay" ]; then
                /system/bin/sleep "${'$'}(cat "${'$'}dir/listen-delay")" &
                sleeper=${'$'}!
                wait "${'$'}sleeper"
            fi
            printf 'SillyBunny is listening on\033[32m IPv4: 127.0.0.1:%s\033[39m\n' "${'$'}port"
            n=0
            while :; do
                n=${'$'}((n + 1))
                echo "server tick ${'$'}n"
                /system/bin/sleep 1 &
                sleeper=${'$'}!
                wait "${'$'}sleeper"
            done
            """.trimIndent() + "\n",
        )
        File(checkout, "setup.sh").writeText(
            """
            # Stand-in for install.sh: <steps> <exit code> <pid file> [detached]. Leaves a background child behind,
            # as npm can, and with "detached" also a child in a session of its own.
            steps=${'$'}1
            code=${'$'}2
            echo "setup pid=${'$'}${'$'} steps=${'$'}steps"
            /system/bin/env > "${'$'}3.env"
            if [ "${'$'}4" = detached ]; then
                /system/bin/setsid /system/bin/sleep 600 &
                echo "${'$'}!" > "${'$'}3.detached"
            fi
            /system/bin/sleep 600 &
            echo "${'$'}${'$'} ${'$'}!" > "${'$'}3"
            i=0
            while [ "${'$'}i" -lt "${'$'}steps" ]; do
                i=${'$'}((i + 1))
                echo "setup step ${'$'}i"
                /system/bin/sleep 0.2
            done
            echo "setup done"
            exit "${'$'}code"
            """.trimIndent() + "\n",
        )
    }

    companion object {
        const val TAG = "P54Device"
        const val TIMING_TAG = "P54Timing"
        const val SH = "/system/bin/sh"
        const val VERSION_CODE = 4_054L
        const val MODE_GRACEFUL = "graceful"
        const val MODE_STUBBORN_SUPERVISOR = "stubborn-supervisor"
        const val MODE_STUBBORN_GROUP = "stubborn-group"

        /** Variables a POSIX shell may add for its children on top of what it was given. */
        val SHELL_VARIABLES = setOf("PWD", "OLDPWD", "SHLVL", "_")

        fun resetPersistentState(context: Context) {
            context.getSharedPreferences("server_host", Context.MODE_PRIVATE).edit().clear().commit()
        }

        /** A free guest-loopback port in the server's dynamic range; never 4444. */
        fun freeDynamicPort(): Int {
            repeat(200) {
                val port = Random.nextInt(PortPolicy.RANGE.first, PortPolicy.RANGE.last + 1)
                if (port != PortPolicy.LIVE_SERVER_PORT && PortPolicy.loopbackPortFree(port)) return port
            }
            throw IOException("no free port")
        }

        fun parseEnvironment(file: File): Map<String, String> =
            file.readLines().filter { it.contains('=') }.associate { it.substringBefore('=') to it.substringAfter('=') }

        @Suppress("DEPRECATION")
        fun runningService(context: Context): ActivityManager.RunningServiceInfo? =
            context.getSystemService(ActivityManager::class.java).getRunningServices(Int.MAX_VALUE)
                .firstOrNull { it.service.className == ServerService::class.java.name }

        fun isServiceRunning(context: Context): Boolean = runningService(context) != null

        fun isForegroundService(context: Context): Boolean = runningService(context)?.foreground == true

        /** Live members of [pgid] owned by this app's UID, read from `/proc`. */
        fun groupMembers(pgid: Int): List<ProcStat> = Procfs.snapshot(Os.getuid()).liveInGroup(pgid)

        /** True while the process [seen] earlier (same PID and start time) is still alive. */
        fun stillAlive(seen: ProcStat): Boolean = Procfs.read(seen.pid)?.let { seen.same(it) && it.live } == true

        /**
         * The `/proc` identity of [pid] once `setsid` has run in it. The stand-ins write `$!` right after the
         * fork, so the child may still be in its parent's session for a moment.
         */
        fun awaitOwnSession(pid: Int): ProcStat = waitFor("pid $pid in a session of its own", 10_000) {
            Procfs.read(pid)?.takeIf { it.live && it.session == it.pid }
        }

        /** True while [pid] is still one of the stand-ins' background `sleep 600` jobs. */
        fun sleeperAlive(pid: Int): Boolean =
            Procfs.read(pid)?.live == true && Procfs.argv(pid) == listOf("/system/bin/sleep", "600")

        fun <T : Any> waitFor(what: String, timeoutMillis: Long, probe: () -> T?): T {
            val deadline = SystemClock.elapsedRealtime() + timeoutMillis
            while (true) {
                probe()?.let { return it }
                if (SystemClock.elapsedRealtime() > deadline) fail("timed out after $timeoutMillis ms waiting for $what")
                Thread.sleep(20)
            }
        }

        fun waitUntil(what: String, timeoutMillis: Long, condition: () -> Boolean) {
            waitFor(what, timeoutMillis) { if (condition()) Unit else null }
        }

        fun timing(text: String) {
            Log.i(TIMING_TAG, text)
        }
    }
}

/** The command `sh launcher.sh -- --port <P>` in the checkout, with `supervisor.sh` as the supervisor marker. */
internal class ShellLaunchSpecs(private val checkout: File) : LaunchSpecFactory {
    val sessions = CopyOnWriteArrayList<LaunchSession>()

    @Volatile
    var onSession: (LaunchSession) -> Unit = {}

    override fun create(paths: RuntimePaths, session: LaunchSession, environment: ProcessEnvironment): LaunchSpec {
        sessions += session
        onSession(session)
        return LaunchSpec(
            listOf(ServerDeviceFixture.SH, "launcher.sh", "--", "--port", session.port.toString()),
            checkout,
            environment,
            "supervisor.sh",
        )
    }
}

/**
 * An in-process stand-in for the launch-token gate on a session port: `GET /__sillybunny/health` gets 204
 * only with `Cookie: sillybunny_launch=<current token>` while [healthy], and 403 otherwise. Until the
 * stand-in server announces its listener, it also stands for another app listening on the port.
 */
internal class HealthResponder(val port: Int) : Closeable {
    @Volatile
    var token: String? = null

    @Volatile
    var healthy = true

    val authorized = AtomicInteger()
    val rejected = AtomicInteger()

    /** Every request that reached the port, with or without the cookie. */
    fun requests(): Int = authorized.get() + rejected.get()
    private val socket = ServerSocket().apply {
        reuseAddress = true
        bind(InetSocketAddress(InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1)), port), 50)
    }
    private val thread = Thread({ acceptLoop() }, "health-responder-$port").apply {
        isDaemon = true
        start()
    }

    private fun acceptLoop() {
        while (!socket.isClosed) {
            val client = try {
                socket.accept()
            } catch (_: IOException) {
                return
            }
            try {
                client.use(::answer)
            } catch (_: IOException) {
                // A probe that gave up; the next one gets a fresh connection.
            }
        }
    }

    private fun answer(client: Socket) {
        client.soTimeout = 2_000
        val reader = client.getInputStream().bufferedReader(Charsets.ISO_8859_1)
        val request = reader.readLine() ?: return
        var cookie: String? = null
        while (true) {
            val line = reader.readLine() ?: break
            if (line.isEmpty()) break
            if (line.startsWith("Cookie:", ignoreCase = true)) cookie = line.substringAfter(':').trim()
        }
        val expected = token
        val ok = healthy && request.startsWith("GET ${HealthProbe.PATH} ") && expected != null &&
            cookie == "${LaunchSession.COOKIE_NAME}=$expected"
        val response = if (ok) {
            authorized.incrementAndGet()
            "HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n"
        } else {
            rejected.incrementAndGet()
            "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        }
        client.getOutputStream().apply {
            write(response.toByteArray(Charsets.ISO_8859_1))
            flush()
        }
    }

    override fun close() {
        try {
            socket.close()
        } catch (_: IOException) {
            // Closing only ends the accept loop.
        }
        thread.join(2_000)
    }
}
