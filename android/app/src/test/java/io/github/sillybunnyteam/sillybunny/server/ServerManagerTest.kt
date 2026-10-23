package io.github.sillybunnyteam.sillybunny.server

import android.app.Application
import android.app.Notification
import android.app.Service
import android.content.Intent
import android.os.CancellationSignal
import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import com.sun.net.httpserver.HttpServer
import io.github.sillybunnyteam.sillybunny.ServerService
import io.github.sillybunnyteam.sillybunny.runtime.RuntimePaths
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.io.File
import java.io.IOException
import java.net.InetSocketAddress
import java.nio.file.Files
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [37])
class ServerManagerTest {
    @get:Rule
    val temporary = TemporaryFolder()

    private val context: Application = ApplicationProvider.getApplicationContext()
    private val clock = AtomicLong(50_000_000)
    private val servers = CopyOnWriteArrayList<FakeServerProcess>()
    private val scripts = CopyOnWriteArrayList<FakeServerProcess>()
    private val probes = CopyOnWriteArrayList<Pair<Int, String?>>()
    private val starts = CopyOnWriteArrayList<String>()

    @Volatile
    private var healthy = true

    @Volatile
    private var launchFailure: IOException? = null

    /** By default the fake server announces its listener at once, as the real one does once it listens. */
    @Volatile
    private var configureServer: (FakeServerProcess) -> Unit = { it.announceListening() }

    @Volatile
    private var configureScript: (FakeServerProcess) -> Unit = {}

    @Volatile
    private var nativeLines: List<String> = emptyList()
    private val nativeQueries = CopyOnWriteArrayList<Long>()

    private var refuseServiceStarts = false
    private var lastExitUserRequested = false
    private var portFree: (Int) -> Boolean = { true }
    private var service: ServerService? = null
    private var startId = 0
    private lateinit var paths: RuntimePaths
    private lateinit var manager: ServerManager

    private val launcher = ProcessLauncher { spec ->
        launchFailure?.let { throw it }
        FakeServerProcess(spec).also { process ->
            if (spec.argv.first() == FAKE_BASH) {
                configureScript(process)
                scripts += process
            } else {
                configureServer(process)
                servers += process
            }
        }
    }

    private val testSpecs = LaunchSpecFactory { runtime, session, environment ->
        LaunchSpec(listOf(FAKE_START, "--", "--port", session.port.toString()), runtime.checkoutDir, environment, "server.js")
    }

    @Before
    fun preparePaths() {
        paths = RuntimePaths(File(temporary.root, "files"), File(temporary.root, "cache"), File(temporary.root, "lib"))
    }

    @After
    fun shutDown() {
        ServerManager.replaceForTest(null)
    }

    private fun build(
        launchSpecs: LaunchSpecFactory = testSpecs,
        startupTimeoutMillis: Long = 30_000,
        stop: StopConfig = StopConfig(supervisorGraceMillis = 300, groupTermGraceMillis = 300, killGraceMillis = 300, pollMillis = 5),
        health: HealthCheck = HealthCheck { port, token ->
            probes += port to token
            if (healthy) HealthProbe.HEALTHY else HealthProbe.UNREACHABLE
        },
    ): ServerManager {
        val dependencies = ServerDependencies(
            paths = { paths },
            logsDir = paths.logsDir,
            controlDir = File(temporary.root, "control"),
            launcher = launcher,
            versionCode = { 42 },
            autoUpdate = { false },
            lastExitUserRequested = { lastExitUserRequested },
            launchSpecs = launchSpecs,
            scriptInterpreter = { listOf(FAKE_BASH, "--noprofile", "--norc") },
            health = health,
            clock = { clock.get() },
            restart = RestartConfig(firstBackoffMillis = 10, maxBackoffMillis = 40),
            stop = stop,
            scriptStop = StopConfig(supervisorGraceMillis = 0, groupTermGraceMillis = 300, killGraceMillis = 300, pollMillis = 5),
            healthPollMillis = 10,
            startupTimeoutMillis = startupTimeoutMillis,
            inheritedEnvironment = { mapOf("ANDROID_ROOT" to "/system", "LD_PRELOAD" to "/data/local/tmp/preload.so") },
            portFree = { portFree(it) },
            portBusyDelayMillis = 1,
            serviceStarter = ServiceStarter { _, action ->
                starts += action
                if (refuseServiceStarts) throw IllegalStateException("not allowed from the background")
                deliver(ServerService.intent(context, action))
            },
            nativeLog = NativeLog { since ->
                nativeQueries += since
                nativeLines
            },
        )
        return ServerManager(context, dependencies).also {
            ServerManager.replaceForTest(it)
            manager = it
        }
    }

    /** Creates the service on first use, as the platform does, and runs one start command on it. */
    private fun deliver(intent: Intent?): Int {
        val current = service ?: Robolectric.buildService(ServerService::class.java).create().get().also { service = it }
        return current.onStartCommand(intent, 0, ++startId)
    }

    private fun idleMain() = shadowOf(Looper.getMainLooper()).idle()

    // Generous: it returns as soon as the probe holds, and a loaded host once took over 5 s to spawn the first fake server.
    private fun <T : Any> await(what: String, timeoutMillis: Long = 20_000, probe: () -> T?): T {
        val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMillis)
        while (true) {
            idleMain()
            probe()?.let { return it }
            if (System.nanoTime() - deadline > 0) fail("timed out waiting for $what; state=${manager.state.value}")
            Thread.sleep(5)
        }
    }

    private fun awaitState(what: String, predicate: (ServerState) -> Boolean): ServerState =
        await(what) { manager.state.value.takeIf(predicate) }

    private fun awaitRunning(processes: Int): ServerState.Running {
        await("server $processes") { servers.getOrNull(processes - 1) }
        return awaitState("running $processes") {
            it is ServerState.Running && it.session.token == servers[processes - 1].spec.environment[ProcessEnvironment.LAUNCH_TOKEN]
        } as ServerState.Running
    }

    /** The worker clears a pending origin change right after it publishes the Running state that reports it. */
    private fun awaitOriginChangeReported() {
        await("origin change reported") { true.takeIf { !ServerStateStore(context).originChangePending } }
    }

    private fun shadowService() = shadowOf(service!!)

    private fun foregroundNotification(): Notification = shadowService().lastForegroundNotification!!

    private fun inForeground(): Boolean = service != null && !shadowService().isForegroundStopped

    private fun policy(): PolicyState = ServerStateStore(context).loadPolicy()

    @Test
    fun startPromotesAndReportsRunningOnlyOnceTheTokenHealthCheckPasses() {
        healthy = false
        build().start(context)

        assertEquals(listOf(ServerService.ACTION_START), starts)
        assertTrue(inForeground())
        val process = await("launch") { servers.firstOrNull() }
        await("probes") { probes.takeIf { it.size >= 3 } }
        assertEquals(ServerState.Starting(1), manager.state.value)

        healthy = true
        val running = awaitRunning(1)

        val session = running.session
        assertFalse(running.originChanged)
        assertTrue(session.port in PortPolicy.RANGE)
        assertTrue(LaunchTokens.isValid(session.token))
        assertEquals(listOf(FAKE_START, "--", "--port", session.port.toString()), process.spec.argv)
        assertEquals(paths.checkoutDir, process.spec.workingDir)
        val environment = process.spec.environment
        assertEquals(session.token, environment[ProcessEnvironment.LAUNCH_TOKEN])
        assertEquals("42", environment["SILLYBUNNY_ANDROID_APP_VERSION_CODE"])
        assertEquals("0", environment["SILLYBUNNY_AUTO_UPDATE"])
        assertEquals("/system", environment["ANDROID_ROOT"])
        assertFalse(environment.containsKey("LD_PRELOAD"))
        assertTrue(probes.all { it == session.port to session.token })
        for (directory in listOf(paths.homeDir, paths.tmpDir, paths.statusDir, paths.logsDir)) assertTrue(directory.isDirectory)
        assertEquals(session.port, ServerStateStore(context).port)
        assertEquals(RunIntent.RUN, policy().intent)
        assertEquals(ProcessIds(4100, 4100, 4106, 4200, 4207), manager.currentProcessIds())
    }

    @Test
    fun aListenerOnTheSessionPortBeforeTheServerAnnouncesItNeverGetsTheCookie() {
        // Another app's listener holds the persisted port and answers 204 to anything, until the server announces.
        val cookies = CopyOnWriteArrayList<String>()
        val port = TestPorts.bindLoopback(SESSION_TEST_PORTS).use { it.localPort }
        val listener = HttpServer.create(InetSocketAddress("127.0.0.1", port), 0).apply {
            createContext("/") { exchange ->
                cookies += exchange.requestHeaders.getFirst("Cookie").orEmpty()
                exchange.sendResponseHeaders(HealthProbe.HEALTHY, -1)
                exchange.close()
            }
            start()
        }
        try {
            ServerStateStore(context).port = port
            configureServer = { it.print("checking for updates") }
            build(health = HealthProbe(connectTimeoutMillis = 500, readTimeoutMillis = 1_000)).start(context)
            val process = await("launch") { servers.firstOrNull() }
            await("output") { manager.recentLogLines().takeIf { it.contains("checking for updates") } }

            // About 30 probe intervals pass: none of them reaches the listener, and nothing is Running.
            Thread.sleep(300)
            assertTrue(cookies.isEmpty())
            assertEquals(ServerState.Starting(1), manager.state.value)

            process.announceListening()
            val running = awaitRunning(1)
            assertEquals(port, running.session.port)
            assertEquals("${LaunchSession.COOKIE_NAME}=${running.session.token}", cookies.first())
        } finally {
            listener.stop(0)
        }
    }

    @Test
    fun onlyTheServersIPv4AnnouncementForTheSessionPortOpensTheProbe() {
        configureServer = {}
        build().start(context)
        val process = await("launch") { servers.firstOrNull() }
        val port = checkNotNull(process.port)

        process.print("SillyBunny is listening on IPv6: [::1]:$port")
        process.print("SillyBunny is listening on IPv4: 127.0.0.1:${port + 1}")
        process.print("would be listening on IPv4: 127.0.0.1:$port")
        // An announcement while no server child can be identified is ignored too.
        process.loseServerChild()
        process.announceListening()
        process.print("end of startup output")
        await("output") { manager.recentLogLines().takeIf { it.contains("end of startup output") } }
        Thread.sleep(100)
        assertTrue(probes.isEmpty())
        assertEquals(ServerState.Starting(1), manager.state.value)

        process.replaceServerChild()
        process.announceListening()
        awaitRunning(1)
        assertTrue(probes.all { it.first == port })
    }

    @Test
    fun probesStopOnceTheAnnouncingServerChildIsReplacedAndResumeOnlyAfterTheNextAnnouncement() {
        healthy = false
        build().start(context)
        val process = await("launch") { servers.firstOrNull() }
        await("probes") { probes.takeIf { it.size >= 3 } }

        // The supervisor replaced its child (exit 75): the port is free until the new child listens.
        process.replaceServerChild()
        Thread.sleep(50)
        val quiet = probes.size
        Thread.sleep(250)
        assertEquals(quiet, probes.size)
        assertEquals(ServerState.Starting(1), manager.state.value)

        process.announceListening()
        await("probes again") { probes.takeIf { it.size > quiet } }
        healthy = true
        awaitRunning(1)
        // The same start.sh run, so the same token, throughout.
        assertEquals(1, servers.size)
    }

    @Test
    fun theNotificationIsOngoingWithAnImmutableStopActionThatStopsGracefully() {
        build().start(context)
        val process = await("launch") { servers.firstOrNull() }
        awaitRunning(1)

        val notification = foregroundNotification()
        assertEquals(ServerNotifications.CHANNEL_ID, notification.channelId)
        assertEquals(ServerNotifications.NOTIFICATION_ID, shadowService().lastForegroundNotificationId)
        assertTrue(notification.flags and Notification.FLAG_ONGOING_EVENT != 0)
        assertEquals("TODO(copy)", notification.extras.getCharSequence(Notification.EXTRA_TITLE).toString())
        assertEquals("TODO(copy)", notification.extras.getCharSequence(Notification.EXTRA_TEXT).toString())
        val action = notification.actions.single()
        assertEquals("TODO(copy)", action.title.toString())
        val stop = shadowOf(action.actionIntent)
        assertTrue(stop.isService)
        assertTrue(stop.isImmutable)
        assertEquals(ServerService.ACTION_STOP, stop.savedIntent.action)
        assertEquals(ServerService::class.java.name, stop.savedIntent.component!!.className)
        assertNull(stop.savedIntent.extras)
        assertTrue(shadowOf(notification.contentIntent).isImmutable)

        assertEquals(Service.START_NOT_STICKY, deliver(stop.savedIntent))
        awaitState("stopped") { it == ServerState.Stopped(userStopped = true) }

        assertEquals(listOf("supervisor:15"), process.signals)
        assertEquals(StopStep.SUPERVISOR_TERM, manager.lastStopTimings!!.stoppedBy)
        assertTrue(process.released)
        await("released") { (!inForeground()).takeIf { it } }
        assertTrue(shadowService().notificationShouldRemoved)
        assertEquals(PolicyState(RunIntent.USER_STOPPED, emptyList()), policy())
        Thread.sleep(100)
        assertEquals(1, servers.size)
    }

    @Test
    fun unexpectedExitsRestartWithBackoffThreeTimesThenFailWithTheLastLines() {
        build().start(context)
        val first = awaitRunning(1)

        for (count in 1..3) {
            servers[count - 1].print("crash number $count")
            servers[count - 1].exit(1)
            val next = awaitRunning(count + 1)
            assertEquals(first.session.port, next.session.port)
            assertNotEquals(first.session.token, next.session.token)
            assertEquals(count, policy().restartTimes.size)
        }
        servers[3].print("crash number 4")
        servers[3].exit(137)

        val failed = awaitState("failed") { it is ServerState.Failed } as ServerState.Failed
        assertTrue(failed.canRestart)
        assertTrue(failed.lastLines.contains("crash number 4"))
        assertTrue(failed.lastLines.size <= ServerManager.FAILED_LINES)
        assertEquals(RunIntent.FAILED, policy().intent)
        val markers = manager.recentLogLines().filter { it.startsWith(ServerManager.MARKER) }
        assertTrue(markers.contains("${ServerManager.MARKER} restart attempt=2 delayMs=10"))
        assertTrue(markers.contains("${ServerManager.MARKER} restart attempt=3 delayMs=20"))
        assertTrue(markers.contains("${ServerManager.MARKER} restart attempt=4 delayMs=40"))
        await("released") { (!inForeground()).takeIf { it } }
        Thread.sleep(100)
        assertEquals(4, servers.size)

        manager.restart(context)

        awaitRunning(5)
        assertEquals(PolicyState(RunIntent.RUN, emptyList()), policy())
    }

    @Test
    fun restartsOutsideTheWindowDoNotCount() {
        build().start(context)
        awaitRunning(1)
        for (count in 1..6) {
            servers[count - 1].exit(1)
            awaitRunning(count + 1)
            // Each crash comes two minutes after the previous one, so at most three fall in five minutes.
            clock.addAndGet(2 * 60_000L)
        }
        assertTrue(policy().restartTimes.size <= 3)
    }

    @Test
    fun aCleanExitLeavesTheServerStopped() {
        build().start(context)
        awaitRunning(1)

        servers[0].exit(0)

        awaitState("stopped") { it == ServerState.Stopped(userStopped = false) }
        assertEquals(RunIntent.CLEAN_STOPPED, policy().intent)
        await("released") { (!inForeground()).takeIf { it } }
        Thread.sleep(100)
        assertEquals(1, servers.size)
        assertTrue(nativeQueries.isEmpty())
    }

    @Test
    fun nodesLogcatOnlyErrorReportsReachTheLogAfterAnUnexpectedExit() {
        val started = System.currentTimeMillis()
        build().start(context)
        val running = awaitRunning(1)
        val token = running.session.token
        nativeLines = listOf("E/nodejs ( 4207): Uncaught Error: boom", "E/nodejs ( 4207): token=$token")

        servers[0].exit(1)
        awaitRunning(2)

        val logged = manager.recentLogLines()
        assertTrue(logged.contains("${ServerManager.MARKER} native-log tag=nodejs lines=2"))
        assertTrue(logged.contains("E/nodejs ( 4207): Uncaught Error: boom"))
        assertTrue(logged.contains("E/nodejs ( 4207): token=[REDACTED]"))
        assertFalse(logged.any { it.contains(token) })
        val serverLog = File(paths.logsDir, ServerManager.SERVER_LOG).readText()
        assertTrue(serverLog.contains("Uncaught Error: boom"))
        assertFalse(serverLog.contains(token))
        val since = nativeQueries.single()
        assertTrue(since >= started && since <= System.currentTimeMillis())
    }

    @Test
    fun aFailedSetupJobGetsNodesLogcatOnlyReports() {
        build()
        nativeLines = listOf("E/nodejs ( 5100): FATAL ERROR: Reached heap limit")
        configureScript = { process -> Thread { process.print("npm ci"); process.exit(1) }.start() }

        assertTrue(manager.runSetup(context, job()))

        val finished = await("finished") { manager.setup.value as? SetupState.Finished }
        assertEquals(1, finished.exitCode)
        assertTrue(finished.lines.contains("E/nodejs ( 5100): FATAL ERROR: Reached heap limit"))
        assertTrue(File(paths.logsDir, ServerManager.SETUP_LOG).readText().contains("FATAL ERROR: Reached heap limit"))
        assertEquals(1, nativeQueries.size)
    }

    @Test
    fun anOrphanLeftByAKilledSupervisorIsStoppedBeforeTheRestart() {
        build().start(context)
        awaitRunning(1)
        servers[0].leftovers = true

        servers[0].exit(137)

        awaitRunning(2)
        assertEquals(listOf("group:15"), servers[0].signals)
        assertTrue(servers[0].isGone())
    }

    @Test
    fun stopEscalatesFromTheSupervisorToTheGroupAndReportsTimings() {
        build().start(context)
        val process = await("launch") { servers.firstOrNull() }
        awaitRunning(1)
        process.supervisorExitsGracefully = false
        process.groupTermExits = false

        assertTrue(manager.stop(10_000))

        assertEquals(listOf("supervisor:15", "group:15", "group:9"), process.signals)
        val timings = manager.lastStopTimings!!
        assertEquals(StopStep.GROUP_KILL, timings.stoppedBy)
        assertTrue(timings.supervisorPhaseMillis >= 300)
        assertTrue(timings.groupTermPhaseMillis >= 300)
        assertEquals(ServerState.Stopped(userStopped = true), manager.state.value)
        assertTrue(manager.recentLogLines().any { it.startsWith("${ServerManager.MARKER} stop step=group_kill") })
    }

    @Test
    fun aStopThatCannotEndTheGroupReportsFailure() {
        build().start(context)
        val process = await("launch") { servers.firstOrNull() }
        awaitRunning(1)
        process.supervisorExitsGracefully = false
        process.groupTermExits = false
        process.killExits = false

        assertFalse(manager.stop(10_000))
        assertEquals(StopStep.NOT_GONE, manager.lastStopTimings!!.stoppedBy)
        assertEquals(RunIntent.USER_STOPPED, policy().intent)
        process.exit(0)
    }

    @Test
    fun stopForUpdateBlocksUntilTheGroupIsGoneAndNeverThrows() {
        build().start(context)
        val process = await("launch") { servers.firstOrNull() }
        awaitRunning(1)
        process.supervisorExitsGracefully = false
        var goneWhenReturned = false

        val updater = Thread {
            manager.serverController.stopForUpdate()
            goneWhenReturned = process.isGone()
        }.apply { start() }
        updater.join(15_000)

        assertFalse(updater.isAlive)
        assertTrue(goneWhenReturned)
        assertEquals(ServerState.Stopped(userStopped = true), manager.state.value)
        assertEquals(RunIntent.USER_STOPPED, policy().intent)

        // Nothing running and a stop that keeps failing still return normally.
        manager.serverController.stopForUpdate()
    }

    @Test
    fun stopForUpdateCancelsASetupJobFirst() {
        build()
        configureScript = { process -> Thread { process.print("cloning") }.start() }
        assertTrue(manager.runSetup(context, job()))
        await("script") { scripts.firstOrNull() }

        manager.serverController.stopForUpdate()

        val finished = manager.setup.value as SetupState.Finished
        assertEquals(128 + Signals.SIGTERM, finished.exitCode)
        assertEquals(listOf("group:15"), scripts.single().signals)
    }

    @Test
    fun stickyRecreationRecoversAServerTheUserStillWants() {
        ServerStateStore(context).savePolicy(PolicyState(RunIntent.RUN, emptyList()))
        build()

        assertEquals(Service.START_STICKY, deliver(null))

        val running = awaitRunning(1)
        assertNotNull(running)
        assertTrue(inForeground())
        assertTrue(manager.recentLogLines().contains("${ServerManager.MARKER} recreated decision=restart attempt=2"))
        assertEquals(1, policy().restartTimes.size)
    }

    @Test
    fun stickyRecreationNeverResurrectsAUserStoppedServer() {
        ServerStateStore(context).savePolicy(PolicyState(RunIntent.USER_STOPPED, emptyList()))
        build()

        assertEquals(Service.START_NOT_STICKY, deliver(null))
        idleMain()

        assertEquals(ServerState.Stopped(userStopped = true), manager.state.value)
        assertFalse(shadowService().lastForegroundNotification != null && inForeground())
        assertEquals(startId, shadowService().stopSelfResultId)
        Thread.sleep(100)
        assertTrue(servers.isEmpty())
    }

    @Test
    fun stickyRecreationAfterAUserRequestedExitStaysStopped() {
        ServerStateStore(context).savePolicy(PolicyState(RunIntent.RUN, emptyList()))
        lastExitUserRequested = true
        build()

        deliver(null)

        awaitState("stopped") { it == ServerState.Stopped(userStopped = true) }
        assertEquals(RunIntent.USER_STOPPED, policy().intent)
        Thread.sleep(100)
        assertTrue(servers.isEmpty())
    }

    @Test
    fun stickyRecreationSharesTheRestartBudget() {
        val now = clock.get()
        ServerStateStore(context).savePolicy(PolicyState(RunIntent.RUN, listOf(now - 3_000, now - 2_000, now - 1_000)))
        build()

        deliver(null)

        val failed = awaitState("failed") { it is ServerState.Failed } as ServerState.Failed
        assertTrue(failed.canRestart)
        Thread.sleep(100)
        assertTrue(servers.isEmpty())
    }

    @Test
    fun aRefusedPromotionLeavesNothingRunning() {
        build()
        deliver(Intent("unused"))
        shadowService().setThrowInStartForeground(IllegalStateException("not allowed"))

        manager.start(context)

        val failed = awaitState("failed") { it is ServerState.Failed } as ServerState.Failed
        assertTrue(failed.canRestart)
        Thread.sleep(100)
        assertTrue(servers.all { it.isGone() })
    }

    @Test
    fun aBackgroundStartThatThePlatformRefusesFailsWithoutRunning() {
        refuseServiceStarts = true
        build().start(context)

        val failed = awaitState("failed") { it is ServerState.Failed } as ServerState.Failed
        assertTrue(failed.canRestart)
        assertTrue(manager.recentLogLines().contains("${ServerManager.MARKER} start-refused reason=foreground-service"))
        Thread.sleep(100)
        assertTrue(servers.isEmpty())
    }

    @Test
    fun theTokenNeverReachesTheLogsOrTheState() {
        build().start(context)
        val process = await("launch") { servers.firstOrNull() }
        val running = awaitRunning(1)
        val token = running.session.token

        process.write("token=${token.take(20)}")
        process.write("${token.drop(20)} cookie\n")
        process.print("again $token")
        await("lines") { manager.recentLogLines().takeIf { lines -> lines.any { it.startsWith("again") } } }
        manager.stop(10_000)

        val logged = paths.logsDir.listFiles()!!.joinToString("\n") { it.readText() }
        assertTrue(logged.contains("token=[REDACTED] cookie"))
        assertTrue(logged.contains("again [REDACTED]"))
        assertFalse(logged.contains(token))
        assertFalse(manager.recentLogLines().any { it.contains(token) })
        assertFalse(running.toString().contains(token))
        assertFalse(process.spec.toString().contains(token))
        assertFalse(foregroundNotification().extras.toString().contains(token))
    }

    @Test
    fun aPortThatStaysBusyIsReplacedAndReportedAsAnOriginChange() {
        ServerStateStore(context).port = 50_001
        portFree = { it != 50_001 }
        build().start(context)

        val running = awaitRunning(1)

        assertTrue(running.originChanged)
        assertNotEquals(50_001, running.session.port)
        assertEquals(running.session.port, ServerStateStore(context).port)
        awaitOriginChangeReported()
        manager.stop(10_000)

        manager.start(context)
        val again = awaitRunning(2)
        assertFalse(again.originChanged)
        assertEquals(running.session.port, again.session.port)
    }

    @Test
    fun anOriginChangeIsReportedByTheFirstRunningStateEvenAfterARunThatEndedEarly() {
        ServerStateStore(context).port = 50_001
        portFree = { it != 50_001 }
        // The first run on the new port exits before it ever announces a listener.
        configureServer = { process -> if (servers.isNotEmpty()) process.announceListening() }
        build().start(context)
        val first = await("first run") { servers.firstOrNull() }
        val replacement = checkNotNull(first.port)
        assertNotEquals(50_001, replacement)
        assertEquals(replacement, ServerStateStore(context).port)
        assertTrue(ServerStateStore(context).originChangePending)

        first.exit(1)

        val running = awaitRunning(2)
        assertEquals(replacement, running.session.port)
        assertTrue(running.originChanged)
        awaitOriginChangeReported()
        manager.stop(10_000)
        manager.start(context)
        assertFalse(awaitRunning(3).originChanged)
    }

    @Test
    fun aPendingOriginChangeOutlivesTheManagerThatPickedThePort() {
        ServerStateStore(context).port = 50_001
        portFree = { it != 50_001 }
        configureServer = {}
        build().start(context)
        val replacement = checkNotNull(await("first run") { servers.firstOrNull() }.port)
        // The manager goes away (as with the host process) before the run on the new port was ever healthy.
        ServerManager.replaceForTest(null)
        assertTrue(ServerStateStore(context).originChangePending)

        configureServer = { it.announceListening() }
        build().start(context)

        val running = awaitRunning(2)
        assertEquals(replacement, running.session.port)
        assertTrue(running.originChanged)
        awaitOriginChangeReported()
    }

    @Test
    fun aMissingRuntimeOrCheckoutFailsWithoutRestarting() {
        build(launchSpecs = LaunchSpecFactory.PRODUCTION).start(context)

        val failed = awaitState("failed") { it is ServerState.Failed } as ServerState.Failed
        assertFalse(failed.canRestart)
        assertTrue(manager.recentLogLines().contains("${ServerManager.MARKER} start-unavailable missing=bash"))
        assertTrue(servers.isEmpty())
    }

    @Test
    fun aServerThatCannotBeSpawnedRestartsWithinTheBudgetThenFails() {
        launchFailure = IOException("handshake")
        build().start(context)

        val failed = awaitState("failed") { it is ServerState.Failed } as ServerState.Failed
        assertTrue(failed.canRestart)
        assertEquals(4, manager.recentLogLines().count { it == "${ServerManager.MARKER} spawn-failed" })
    }

    @Test
    fun aServerThatNeverBecomesHealthyGivesUp() {
        healthy = false
        build(startupTimeoutMillis = 200).start(context)
        val process = await("launch") { servers.firstOrNull() }

        val failed = awaitState("failed") { it is ServerState.Failed } as ServerState.Failed

        assertTrue(failed.canRestart)
        assertTrue(process.isGone())
        assertEquals(RunIntent.FAILED, policy().intent)
    }

    @Test
    fun setupRunsUnderTheServiceOnlyWhileTheServerIsStopped() {
        build().start(context)
        awaitRunning(1)
        val job = job()

        assertFalse(manager.runSetup(context, job))
        assertTrue(manager.stop(10_000))

        configureScript = { process ->
            Thread {
                for (index in 1..250) process.print("step $index")
                Thread.sleep(500)
                process.exit(0)
            }.start()
        }
        assertTrue(manager.runSetup(context, job))
        assertFalse(manager.runSetup(context, job()))
        manager.start(context)
        val script = await("script") { scripts.firstOrNull() }
        val running = manager.setup.value as SetupState.Running
        assertEquals(job, running.job)
        assertTrue(foregroundNotification().actions.isNullOrEmpty())

        val finished = await("finished") { manager.setup.value as? SetupState.Finished }

        assertEquals(0, finished.exitCode)
        assertEquals(ServerManager.SETUP_TAIL_LINES, finished.lines.size)
        assertEquals("step 250", finished.lines.last())
        assertEquals(
            listOf(FAKE_BASH, "--noprofile", "--norc", job.script.absolutePath) + job.args,
            script.spec.argv,
        )
        assertEquals(job.workingDir, script.spec.workingDir)
        assertFalse(script.spec.environment.containsKey(ProcessEnvironment.LAUNCH_TOKEN))
        val setupLog = File(paths.logsDir, ServerManager.SETUP_LOG).readLines()
        assertTrue(setupLog.containsAll((1..250).map { "step $it" }))
        assertTrue(manager.logFiles().map { it.name }.containsAll(listOf(ServerManager.SETUP_LOG, ServerManager.SERVER_LOG)))
        await("released") { (!inForeground()).takeIf { it } }
        // The start requested during setup was refused, not queued.
        assertEquals(1, servers.size)
        assertEquals(ServerState.Stopped(userStopped = true), manager.state.value)
        // A successful job never reads logcat.
        assertTrue(nativeQueries.isEmpty())
    }

    @Test
    fun cancelSetupStopsTheJobsWholeGroup() {
        build()
        configureScript = { process -> Thread { process.print("cloning into SillyBunny") }.start() }
        assertTrue(manager.runSetup(context, job()))
        await("first line") { (manager.setup.value as? SetupState.Running)?.lines?.takeIf { it.isNotEmpty() } }

        manager.cancelSetup()

        val finished = await("finished") { manager.setup.value as? SetupState.Finished }
        assertEquals(128 + Signals.SIGTERM, finished.exitCode)
        assertEquals(listOf("group:15"), scripts.single().signals)
        assertTrue(manager.runSetup(context, job()))
    }

    @Test
    fun aDeniedSetupServiceCancelsTheJob() {
        build()
        deliver(Intent("unused"))
        shadowService().setThrowInStartForeground(IllegalStateException("not allowed"))
        configureScript = { process -> Thread { process.print("cloning") }.start() }

        assertTrue(manager.runSetup(context, job()))

        val finished = await("finished") { manager.setup.value as? SetupState.Finished }
        assertNotEquals(0, finished.exitCode)
    }

    @Test
    fun anAbandonedUpdateRestoresTheServerItStoppedWhileAnActivityIsVisible() {
        build()
        manager.onActivityStarted(context)
        manager.start(context)
        awaitRunning(1)
        onUpdaterThread { manager.serverController.stopForUpdate() }
        assertEquals(ServerState.Stopped(userStopped = true), manager.state.value)

        onUpdaterThread { manager.serverController.resumeAfterAbandonedUpdate() }

        awaitRunning(2)
        assertTrue(manager.recentLogLines().contains("${ServerManager.MARKER} update-abandoned restore=start"))
        // The same result again, or a later one, restores nothing more.
        onUpdaterThread { manager.serverController.resumeAfterAbandonedUpdate() }
        settle()
        assertEquals(2, servers.size)
        assertEquals(listOf(ServerService.ACTION_START, ServerService.ACTION_START), starts)
    }

    @Test
    fun anAbandonedUpdateWithoutAVisibleActivityRestoresAtTheNextActivityStart() {
        build()
        manager.onActivityStarted(context)
        manager.start(context)
        awaitRunning(1)
        manager.onActivityStopped()
        assertFalse(manager.activityVisible)
        onUpdaterThread { manager.serverController.stopForUpdate() }

        onUpdaterThread { manager.serverController.resumeAfterAbandonedUpdate() }
        onUpdaterThread { manager.serverController.resumeAfterAbandonedUpdate() }

        // No foreground-service start from the background: the platform would refuse it.
        settle()
        assertEquals(listOf(ServerService.ACTION_START), starts)
        assertEquals(1, servers.size)
        assertEquals(ServerState.Stopped(userStopped = true), manager.state.value)

        manager.onActivityStarted(context)
        assertTrue(manager.activityVisible)
        awaitRunning(2)
        assertEquals(listOf(ServerService.ACTION_START, ServerService.ACTION_START), starts)
        manager.onActivityStopped()
        manager.onActivityStarted(context)
        settle()
        assertEquals(2, servers.size)
    }

    @Test
    fun anAbandonedUpdateRestoresOnlyAServerThatTheUpdateStopped() {
        build()
        manager.onActivityStarted(context)
        // Nothing ran when the update stopped everything.
        onUpdaterThread { manager.serverController.stopForUpdate() }
        onUpdaterThread { manager.serverController.resumeAfterAbandonedUpdate() }
        settle()
        assertTrue(starts.isEmpty())

        // A result without any stop for an update leaves a running server alone.
        manager.start(context)
        awaitRunning(1)
        onUpdaterThread { manager.serverController.resumeAfterAbandonedUpdate() }
        settle()
        assertEquals(listOf(ServerService.ACTION_START), starts)
        assertEquals(1, servers.size)
        assertTrue(manager.state.value is ServerState.Running)
    }

    @Test
    fun anExplicitStartReplacesAPendingRestore() {
        build()
        manager.onActivityStarted(context)
        manager.start(context)
        awaitRunning(1)
        manager.onActivityStopped()
        onUpdaterThread { manager.serverController.stopForUpdate() }
        onUpdaterThread { manager.serverController.resumeAfterAbandonedUpdate() }

        manager.start(context)
        awaitRunning(2)
        manager.onActivityStarted(context)

        settle()
        assertEquals(2, servers.size)
        assertFalse(manager.recentLogLines().any { it.contains("update-abandoned") })
    }

    @Test
    fun aStaleGitLockIsRemovedRightBeforeTheServerIsSpawned() {
        val lock = gitLock()
        build().start(context)

        awaitRunning(1)

        assertFalse(lock.exists())
        assertTrue(manager.recentLogLines().contains("${ServerManager.MARKER} stale-git-lock removed"))
    }

    @Test
    fun aStaleGitLockIsRemovedRightBeforeASetupJobIsSpawned() {
        val lock = gitLock()
        build()
        configureScript = { it.exit(0) }

        assertTrue(manager.runSetup(context, job()))

        await("finished") { manager.setup.value as? SetupState.Finished }
        assertFalse(lock.exists())
        val setupLog = File(paths.logsDir, ServerManager.SETUP_LOG).readLines()
        assertTrue(setupLog.contains("${ServerManager.MARKER} stale-git-lock removed"))
    }

    @Test
    fun aGitLockIsKeptWhileTheServerRuns() {
        build().start(context)
        awaitRunning(1)
        val lock = gitLock()
        configureScript = { it.exit(0) }

        assertEquals(0, runScript())

        assertTrue(lock.exists())
        assertFalse(manager.recentLogLines().any { it.contains("stale-git-lock") })
    }

    @Test
    fun aGitLockIsKeptWhileASetupJobRuns() {
        build()
        assertTrue(manager.runSetup(context, job()))
        await("script") { scripts.firstOrNull() }
        val lock = gitLock()
        configureScript = { it.exit(0) }

        assertEquals(0, runScript())
        assertTrue(lock.exists())

        // Once the job is gone, nothing holds the lock any more.
        manager.cancelSetup()
        await("finished") { manager.setup.value as? SetupState.Finished }
        assertEquals(0, runScript())
        assertFalse(lock.exists())
    }

    @Test
    fun onlyARegularLockFileInARealGitDirectoryIsRemoved() {
        val target = File(temporary.root, "elsewhere.lock").apply { writeText("") }
        val git = File(paths.checkoutDir, ".git").apply { mkdirs() }
        val link = File(git, "index.lock")
        Files.createSymbolicLink(link.toPath(), target.toPath())
        build().start(context)

        awaitRunning(1)

        assertTrue(Files.isSymbolicLink(link.toPath()))
        assertTrue(target.exists())
    }

    /** Runs [block] on its own thread, as the APK updater's worker does, and waits for it. */
    private fun onUpdaterThread(block: () -> Unit) {
        val thread = Thread(block, "apk-updater").apply { start() }
        thread.join(15_000)
        assertFalse(thread.isAlive)
    }

    /** Gives a wrongly started server time to appear before the test checks that none did. */
    private fun settle() {
        Thread.sleep(150)
        idleMain()
    }

    private fun gitLock(): File = File(paths.checkoutDir, ".git/index.lock").apply {
        parentFile!!.mkdirs()
        writeText("")
    }

    private fun runScript(): Int = manager.scriptRunner.run(
        File(paths.filesDir, "check.sh"), emptyList(), paths.filesDir, {}, CancellationSignal(),
    )

    private fun job() = SetupJob(
        File(paths.checkoutDir, "scripts/bootstrap/install.sh"),
        listOf("--no-start", "--dir", paths.checkoutDir.path, "--ref", "staging", "--use-node"),
        paths.filesDir,
    )

    private companion object {
        const val FAKE_START = "fake-start.sh"
        const val FAKE_BASH = "fake-bash"

        /** Host test ports (20000-60999) that are also server session ports (49152-65535). */
        val SESSION_TEST_PORTS = PortPolicy.RANGE.first..60_999
    }
}
