package io.github.sillybunnyteam.sillybunny.server

import android.Manifest
import android.app.Notification
import android.app.NotificationManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.SystemClock
import android.system.Os
import android.system.OsConstants
import androidx.activity.ComponentActivity
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import io.github.sillybunnyteam.sillybunny.R
import io.github.sillybunnyteam.sillybunny.server.ServerDeviceFixture.Companion.MODE_GRACEFUL
import io.github.sillybunnyteam.sillybunny.server.ServerDeviceFixture.Companion.MODE_STUBBORN_GROUP
import io.github.sillybunnyteam.sillybunny.server.ServerDeviceFixture.Companion.MODE_STUBBORN_SUPERVISOR
import io.github.sillybunnyteam.sillybunny.server.ServerDeviceFixture.Companion.SHELL_VARIABLES
import io.github.sillybunnyteam.sillybunny.server.ServerDeviceFixture.Companion.VERSION_CODE
import io.github.sillybunnyteam.sillybunny.server.ServerDeviceFixture.Companion.awaitOwnSession
import io.github.sillybunnyteam.sillybunny.server.ServerDeviceFixture.Companion.groupMembers
import io.github.sillybunnyteam.sillybunny.server.ServerDeviceFixture.Companion.isForegroundService
import io.github.sillybunnyteam.sillybunny.server.ServerDeviceFixture.Companion.isServiceRunning
import io.github.sillybunnyteam.sillybunny.server.ServerDeviceFixture.Companion.sleeperAlive
import io.github.sillybunnyteam.sillybunny.server.ServerDeviceFixture.Companion.stillAlive
import io.github.sillybunnyteam.sillybunny.server.ServerDeviceFixture.Companion.timing
import io.github.sillybunnyteam.sillybunny.server.ServerDeviceFixture.Companion.waitFor
import io.github.sillybunnyteam.sillybunny.server.ServerDeviceFixture.Companion.waitUntil
import io.github.sillybunnyteam.sillybunny.update.ServerController
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket

/**
 * Task 5.4 on a device: the real foreground service, setsid handshake, process group, health gate, restart
 * policy, stop escalation and setup jobs, with `/system/bin/sh` stand-ins for `start.sh` and the server
 * ([ServerDeviceFixture]). Every start comes from a visible activity. Timings go to logcat as `P54Timing`.
 */
@RunWith(AndroidJUnit4::class)
class ServerServiceDeviceTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private lateinit var fixture: ServerDeviceFixture
    private lateinit var scenario: ActivityScenario<ComponentActivity>

    @Before
    fun setUp() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            instrumentation.uiAutomation.grantRuntimePermission(context.packageName, Manifest.permission.POST_NOTIFICATIONS)
        }
        fixture = ServerDeviceFixture()
        scenario = ActivityScenario.launch(ComponentActivity::class.java)
    }

    @After
    fun tearDown() {
        try {
            if (::scenario.isInitialized) scenario.close()
        } finally {
            if (::fixture.isInitialized) fixture.close()
        }
    }

    @Test
    fun aStartFromAVisibleActivityRunsItsOwnGroupInTheForegroundWithTheExactEnvironment() {
        val manager = fixture.build()
        val started = SystemClock.elapsedRealtime()
        startFromActivity(manager)
        val running = awaitRunning(manager)
        timing("start-to-running ms=${SystemClock.elapsedRealtime() - started} api=${Build.VERSION.SDK_INT}")
        assertEquals(fixture.responder.port, running.session.port)
        assertEquals("http://127.0.0.1:${fixture.responder.port}", running.session.origin)
        assertFalse(running.originChanged)

        waitUntil("foreground", 10_000) { isForegroundService(context) }
        val service = checkNotNull(manager.attachedService())
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            assertEquals(ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE, service.foregroundServiceType)
        }

        // A session and process group of its own, outside the app's, holding every process of the run.
        val ids = awaitIds(manager)
        val app = checkNotNull(Procfs.read(Os.getpid()))
        assertNotEquals(app.pgid, ids.processGroup)
        assertNotEquals(app.session, ids.processGroup)
        val members = groupMembers(ids.processGroup)
        assertTrue(members.all { it.session == ids.processGroup })
        assertTrue(members.map { it.pid }.containsAll(listOfNotNull(ids.shell, ids.command, ids.supervisor, ids.server)))
        assertEquals(
            listOf(ServerDeviceFixture.SH, "launcher.sh", "--", "--port", running.session.port.toString()),
            Procfs.argv(ids.command),
        )

        // Exactly the plan 2.5 environment with Node's report options: nothing inherited beyond the framework roots.
        val environment = fixture.environmentOf(ids.command)
        val expected = ProcessEnvironment.build(
            fixture.paths,
            System.getenv(),
            VERSION_CODE,
            false,
            running.session.token,
            reportDirectory = CrashRecords(fixture.crashDir).reportsDir,
        )
        val tokenKey = ProcessEnvironment.LAUNCH_TOKEN
        assertTrue("the session's launch token", environment[tokenKey] == running.session.token)
        assertEquals(
            expected.toMap().filterKeys { it != tokenKey },
            environment.filterKeys { it != tokenKey && it !in SHELL_VARIABLES },
        )

        // The launcher printed the token; the log and the state only ever hold the redaction.
        waitUntil("launcher output", 10_000) { fixture.serverLogText().contains("launch token=") }
        val log = fixture.serverLogText()
        assertTrue(log.contains("launch token=${RedactingLineSplitter.REDACTED}"))
        assertTrue(log.contains("SillyBunny is listening on"))
        assertTrue(log.contains("[sillybunny-android] healthy afterMs="))
        assertNoToken(log)
        assertNoToken(manager.recentLogLines().joinToString("\n"))
        assertNoToken(running.toString())

        assertTrue(manager.stop())
        assertEquals(ServerState.Stopped(userStopped = true), manager.state.value)
        assertTrue(groupMembers(ids.processGroup).isEmpty())
        awaitReleased()
    }

    @Test
    fun theNotificationsStopActionStopsTheWholeGroup() {
        val manager = fixture.build()
        startFromActivity(manager)
        awaitRunning(manager)
        val ids = awaitIds(manager)
        val notifications = context.getSystemService(NotificationManager::class.java)
        val posted = waitFor("server notification", 15_000) {
            notifications.activeNotifications.firstOrNull { it.id == ServerNotifications.NOTIFICATION_ID }
        }
        val notification = posted.notification
        assertEquals(ServerNotifications.CHANNEL_ID, notification.channelId)
        val channel = notifications.getNotificationChannel(ServerNotifications.CHANNEL_ID)
        assertEquals(NotificationManager.IMPORTANCE_LOW, channel.importance)
        assertEquals(context.getString(R.string.server_notification_channel), channel.name.toString())
        assertTrue(notification.flags and Notification.FLAG_FOREGROUND_SERVICE != 0)
        assertTrue(notification.flags and Notification.FLAG_ONGOING_EVENT != 0)
        assertEquals(
            context.getString(R.string.server_notification_title),
            notification.extras.getCharSequence(Notification.EXTRA_TITLE)?.toString(),
        )
        assertEquals(
            context.getString(R.string.server_notification_running),
            notification.extras.getCharSequence(Notification.EXTRA_TEXT)?.toString(),
        )
        assertNotNull(notification.contentIntent)
        val stop = notification.actions.single()
        assertEquals(context.getString(R.string.server_notification_stop), stop.title.toString())
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            assertTrue(stop.actionIntent.isImmutable)
            assertTrue(notification.contentIntent.isImmutable)
        }
        val members = groupMembers(ids.processGroup)
        assertTrue(members.size >= 4)

        // The same PendingIntent SystemUI sends when the action is tapped.
        val sent = SystemClock.elapsedRealtime()
        stop.actionIntent.send()
        waitFor("user stop", 20_000) { manager.state.value.takeIf { it == ServerState.Stopped(userStopped = true) } }
        val timings = checkNotNull(manager.lastStopTimings)
        timing("notification-stop ms=${SystemClock.elapsedRealtime() - sent} step=${timings.stoppedBy} totalMs=${timings.totalMillis}")
        assertEquals(StopStep.SUPERVISOR_TERM, timings.stoppedBy)
        assertTrue(groupMembers(ids.processGroup).isEmpty())
        assertTrue(members.none { stillAlive(it) })
        assertEquals(RunIntent.USER_STOPPED, ServerStateStore(context).loadPolicy().intent)
        awaitReleased()
        waitUntil("notification removed", 10_000) {
            notifications.activeNotifications.none { it.id == ServerNotifications.NOTIFICATION_ID }
        }
    }

    @Test
    fun aKilledServerChildIsRestartedWithANewTokenOnTheSamePort() {
        val manager = fixture.build()
        startFromActivity(manager)
        val first = awaitRunning(manager)
        val ids = awaitIds(manager)
        val members = groupMembers(ids.processGroup)
        val killed = SystemClock.elapsedRealtime()
        Os.kill(checkNotNull(ids.server), Signals.SIGKILL)
        val second = awaitRunning(manager, after = first.session)
        timing("restart-after-child-kill ms=${SystemClock.elapsedRealtime() - killed}")
        assertEquals(first.session.port, second.session.port)
        assertFalse(second.originChanged)
        assertTrue("a new token for every spawn", first.session.token != second.session.token)

        // The old group is gone as a whole, and the new run is a new group with the new token.
        assertTrue(groupMembers(ids.processGroup).isEmpty())
        assertTrue(members.none { stillAlive(it) })
        val next = awaitIds(manager)
        assertNotEquals(ids.processGroup, next.processGroup)
        assertTrue(fixture.environmentOf(next.command)[ProcessEnvironment.LAUNCH_TOKEN] == second.session.token)
        waitUntil("restart markers", 10_000) {
            val log = fixture.serverLogText()
            log.contains("[sillybunny-android] exit code=137") &&
                log.contains("[sillybunny-android] restart attempt=2 delayMs=200")
        }
        assertTrue(isForegroundService(context))
        assertNoToken(fixture.serverLogText())

        assertTrue(manager.stop())
        awaitReleased()
    }

    @Test
    fun aKilledSupervisorsOrphanedServerChildIsStoppedBeforeTheRestart() {
        val manager = fixture.build()
        startFromActivity(manager)
        val first = awaitRunning(manager)
        val ids = awaitIds(manager)
        val server = checkNotNull(Procfs.read(checkNotNull(ids.server)))
        Os.kill(checkNotNull(ids.supervisor), Signals.SIGKILL)
        awaitRunning(manager, after = first.session)
        assertFalse(stillAlive(server))
        assertTrue(groupMembers(ids.processGroup).isEmpty())
        waitUntil("cleanup marker", 10_000) {
            fixture.serverLogText().contains("[sillybunny-android] cleanup step=group_term")
        }

        assertTrue(manager.stop())
        awaitReleased()
    }

    @Test
    fun theFourthUnexpectedExitInTheWindowFailsAndOnlyAnExplicitRestartRecovers() {
        val manager = fixture.build()
        startFromActivity(manager)
        var running = awaitRunning(manager)
        val started = SystemClock.elapsedRealtime()
        for (kill in 1..4) {
            Os.kill(checkNotNull(awaitIds(manager).server), Signals.SIGKILL)
            if (kill < 4) running = awaitRunning(manager, after = running.session)
        }
        val failed = waitFor("Failed", 30_000) { manager.state.value as? ServerState.Failed }
        timing("four-kills-to-failed ms=${SystemClock.elapsedRealtime() - started}")
        assertTrue(failed.canRestart)
        assertTrue(failed.lastLines.size in 1..ServerManager.FAILED_LINES)
        assertTrue(failed.lastLines.contains("[sillybunny-android] gave-up"))
        assertNoToken(failed.lastLines.joinToString("\n"))
        assertEquals(4, fixture.specs.sessions.size)
        assertEquals(RunIntent.FAILED, ServerStateStore(context).loadPolicy().intent)
        awaitReleased()

        // Nothing restarts it on its own.
        Thread.sleep(2_000)
        assertTrue(manager.state.value is ServerState.Failed)
        assertNull(manager.currentProcessIds())
        assertEquals(4, fixture.specs.sessions.size)

        onActivity { manager.restart(it) }
        awaitRunning(manager, after = running.session)
        assertEquals(5, fixture.specs.sessions.size)
        assertTrue(manager.stop())
        awaitReleased()
    }

    @Test
    fun killsSpreadBeyondAShortenedWindowKeepRestarting() {
        val window = 4_000L
        val manager = fixture.build(restart = RestartConfig(windowMillis = window, firstBackoffMillis = 200, maxBackoffMillis = 800))
        startFromActivity(manager)
        var running = awaitRunning(manager)
        for (kill in 1..4) {
            // Each earlier restart has left the window by the time of the next kill.
            Thread.sleep(window + 500)
            Os.kill(checkNotNull(awaitIds(manager).server), Signals.SIGKILL)
            running = awaitRunning(manager, after = running.session)
        }
        assertEquals(5, fixture.specs.sessions.size)
        assertEquals(RunIntent.RUN, ServerStateStore(context).loadPolicy().intent)
        waitUntil("restart markers", 10_000) {
            fixture.serverLogText().split('\n').count { it == "[sillybunny-android] restart attempt=2 delayMs=200" } == 4
        }

        assertTrue(manager.stop())
        awaitReleased()
    }

    @Test
    fun runningWaitsForTheHealthGateToAcceptTheSessionCookie() {
        fixture.responder.healthy = false
        val manager = fixture.build()
        startFromActivity(manager)
        awaitIds(manager)
        waitUntil("rejected probes", 10_000) { fixture.responder.rejected.get() >= 3 }
        assertEquals(ServerState.Starting(1), manager.state.value)
        assertEquals(0, fixture.responder.authorized.get())

        val opened = SystemClock.elapsedRealtime()
        fixture.responder.healthy = true
        val running = awaitRunning(manager, timeoutMillis = 5_000)
        timing("health-gate-open-to-running ms=${SystemClock.elapsedRealtime() - opened}")
        assertTrue(fixture.responder.authorized.get() >= 1)
        // Only the session's own cookie opens the gate.
        val probe = HealthProbe()
        assertEquals(403, probe.status(running.session.port, LaunchTokens.generate()))
        assertEquals(403, probe.status(running.session.port, null))
        assertEquals(HealthProbe.HEALTHY, probe.status(running.session.port, running.session.token))

        assertTrue(manager.stop())
        awaitReleased()
    }

    @Test
    fun noRequestReachesTheSessionPortBeforeTheServerAnnouncesItsListener() {
        // Until the stand-in announces, the responder on the port plays another app listening there.
        fixture.setListenDelay(4)
        val manager = fixture.build()
        startFromActivity(manager)
        awaitIds(manager)
        val started = SystemClock.elapsedRealtime()
        Thread.sleep(2_000)
        assertEquals(0, fixture.responder.requests())
        assertEquals(ServerState.Starting(1), manager.state.value)
        assertFalse(fixture.serverLogText().contains("is listening on"))

        val running = awaitRunning(manager, timeoutMillis = 15_000)
        timing("server-up-to-running-with-4s-announce-delay ms=${SystemClock.elapsedRealtime() - started}")
        assertTrue(fixture.serverLogText().contains("SillyBunny is listening on"))
        assertTrue(fixture.responder.authorized.get() >= 1)
        assertEquals(fixture.responder.port, running.session.port)

        assertTrue(manager.stop())
        awaitReleased()
    }

    @Test
    fun probesPauseWhileTheAnnouncingServerChildIsReplacedAndResumeOnceItsSuccessorAnnounces() {
        fixture.responder.healthy = false
        val manager = fixture.build()
        startFromActivity(manager)
        waitUntil("rejected probes", 15_000) { fixture.responder.rejected.get() >= 3 }
        val first = checkNotNull(Procfs.read(checkNotNull(awaitIds(manager).server)))

        // As after an in-app restart: the child exits 75, and the supervisor's next child announces 4 s later.
        fixture.setListenDelay(4)
        Os.kill(first.pid, OsConstants.SIGUSR1)
        waitUntil("first server child gone", 5_000) { !stillAlive(first) }
        Thread.sleep(300)
        val quiet = fixture.responder.requests()
        Thread.sleep(2_000)
        assertEquals(quiet, fixture.responder.requests())
        assertEquals(ServerState.Starting(1), manager.state.value)

        waitUntil("probes after the next announcement", 15_000) { fixture.responder.requests() > quiet }
        fixture.responder.healthy = true
        val running = awaitRunning(manager, timeoutMillis = 10_000)
        // The same start.sh run and token throughout.
        assertEquals(listOf(running.session), fixture.specs.sessions.toList())
        val log = fixture.serverLogText()
        assertEquals(2, log.split('\n').count { it.contains("SillyBunny is listening on") })
        assertTrue(log.contains("supervisor child exit=75"))

        assertTrue(manager.stop())
        awaitReleased()
    }

    @Test
    fun aDescendantInASessionOfItsOwnIsStoppedWithTheRun() {
        fixture.enableDetachedChild()
        val manager = fixture.build()
        startFromActivity(manager)
        awaitRunning(manager)
        val ids = awaitIds(manager)
        val detached = awaitOwnSession(waitFor("detached child", 10_000) { fixture.detachedPidOf(checkNotNull(ids.server)) })
        // setsid made it a session and group leader outside the run's group.
        assertEquals(detached.pid, detached.pgid)
        assertNotEquals(ids.processGroup, detached.pgid)
        assertTrue(sleeperAlive(detached.pid))

        val called = SystemClock.elapsedRealtime()
        assertTrue(manager.stop())
        val callMillis = SystemClock.elapsedRealtime() - called
        val timings = checkNotNull(manager.lastStopTimings)
        timing(
            "stop-with-detached-child step=${timings.stoppedBy} supervisorMs=${timings.supervisorPhaseMillis} " +
                "groupTermMs=${timings.groupTermPhaseMillis} totalMs=${timings.totalMillis} callMs=$callMillis api=${Build.VERSION.SDK_INT}",
        )
        assertFalse(stillAlive(detached))
        assertTrue(groupMembers(ids.processGroup).isEmpty())
        // The group ended through the supervisor; the detached child then got SIGTERM at once.
        assertEquals(StopStep.GROUP_TERM, timings.stoppedBy)
        assertTrue(timings.supervisorPhaseMillis < StopConfig().supervisorGraceMillis)
        awaitReleased()
    }

    @Test
    fun aDescendantInASessionOfItsOwnIsStoppedBeforeACrashRestart() {
        fixture.enableDetachedChild()
        val manager = fixture.build()
        startFromActivity(manager)
        val first = awaitRunning(manager)
        val ids = awaitIds(manager)
        val detached = awaitOwnSession(waitFor("detached child", 10_000) { fixture.detachedPidOf(checkNotNull(ids.server)) })
        assertNotEquals(ids.processGroup, detached.pgid)
        // Longer than the run's periodic look at its members, which finds the child through its live parent.
        Thread.sleep(2_500)

        Os.kill(checkNotNull(ids.server), Signals.SIGKILL)
        awaitRunning(manager, after = first.session)

        // The cleanup before the restart stopped it, although its parent was already gone.
        assertFalse(stillAlive(detached))
        assertTrue(groupMembers(ids.processGroup).isEmpty())
        waitUntil("cleanup marker", 10_000) {
            fixture.serverLogText().contains("[sillybunny-android] cleanup step=group_term")
        }
        val next = awaitIds(manager)
        val nextDetached = awaitOwnSession(waitFor("next detached child", 10_000) { fixture.detachedPidOf(checkNotNull(next.server)) })
        assertTrue(manager.stop())
        assertFalse(stillAlive(nextDetached))
        awaitReleased()
    }

    @Test
    fun aBusyPersistedPortIsRetriedThenReplacedAndReportedAsAnOriginChange() {
        val busyPort = fixture.responder.port
        fixture.responders.remove(busyPort)
        fixture.responder.close()
        ServerSocket().use { blocker ->
            blocker.bind(InetSocketAddress(InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1)), busyPort), 1)
            val manager = fixture.build()
            val started = SystemClock.elapsedRealtime()
            startFromActivity(manager)
            val running = awaitRunning(manager)
            val elapsed = SystemClock.elapsedRealtime() - started
            timing("busy-port-to-running ms=$elapsed")
            assertTrue(running.originChanged)
            assertNotEquals(busyPort, running.session.port)
            assertTrue(running.session.port in PortPolicy.RANGE)
            assertEquals(running.session.port, ServerStateStore(context).port)
            // That Running state reported the change, so the manager clears it right after publishing it.
            waitUntil("origin change reported", 5_000) { !ServerStateStore(context).originChangePending }
            // Five checks 400 ms apart before giving the port up.
            assertTrue(elapsed >= 4 * 400)
            assertTrue(manager.stop())
            awaitReleased()

            // The next start reuses the new port, with no further origin change.
            startFromActivity(manager)
            val again = awaitRunning(manager, after = running.session)
            assertEquals(running.session.port, again.session.port)
            assertFalse(again.originChanged)
            assertTrue(manager.stop())
            awaitReleased()
        }
    }

    @Test
    fun eachStopStepEndsTheWholeGroupWithinItsBound() {
        val manager = fixture.build()
        val expected = linkedMapOf(
            MODE_GRACEFUL to StopStep.SUPERVISOR_TERM,
            MODE_STUBBORN_SUPERVISOR to StopStep.GROUP_TERM,
            MODE_STUBBORN_GROUP to StopStep.GROUP_KILL,
        )
        for ((mode, step) in expected) {
            fixture.setMode(mode)
            startFromActivity(manager)
            awaitRunning(manager)
            val ids = awaitIds(manager)
            val members = groupMembers(ids.processGroup)
            val called = SystemClock.elapsedRealtime()
            assertTrue(manager.stop())
            val callMillis = SystemClock.elapsedRealtime() - called
            val timings = checkNotNull(manager.lastStopTimings)
            timing(
                "stop mode=$mode step=${timings.stoppedBy} supervisorMs=${timings.supervisorPhaseMillis} " +
                    "groupTermMs=${timings.groupTermPhaseMillis} killMs=${timings.killPhaseMillis} " +
                    "totalMs=${timings.totalMillis} callMs=$callMillis api=${Build.VERSION.SDK_INT}",
            )
            assertEquals(mode, step, timings.stoppedBy)
            assertTrue(groupMembers(ids.processGroup).isEmpty())
            assertTrue(members.none { stillAlive(it) })
            assertTrue(callMillis < 15_000)
            awaitReleased()
        }
    }

    @Test
    fun stopForUpdateBlocksUntilTheWholeGroupIsGone() {
        fixture.setMode(MODE_STUBBORN_SUPERVISOR)
        val manager = fixture.build()
        startFromActivity(manager)
        awaitRunning(manager)
        val ids = awaitIds(manager)
        val members = groupMembers(ids.processGroup)
        val controller: ServerController = manager.serverController

        val called = SystemClock.elapsedRealtime()
        controller.stopForUpdate()
        val callMillis = SystemClock.elapsedRealtime() - called
        // When it returns, the whole group is already gone and nothing will restart it.
        assertTrue(groupMembers(ids.processGroup).isEmpty())
        assertTrue(members.none { stillAlive(it) })
        assertEquals(ServerState.Stopped(userStopped = true), manager.state.value)
        assertEquals(RunIntent.USER_STOPPED, ServerStateStore(context).loadPolicy().intent)
        val timings = checkNotNull(manager.lastStopTimings)
        timing("stopForUpdate callMs=$callMillis step=${timings.stoppedBy} totalMs=${timings.totalMillis}")
        assertEquals(StopStep.GROUP_TERM, timings.stoppedBy)
        // It waited out the supervisor's grace period and stayed inside its own bound.
        assertTrue(callMillis >= StopConfig().supervisorGraceMillis)
        assertTrue(callMillis < ServerManager.UPDATE_STOP_MILLIS)
        awaitReleased()

        // With nothing running it returns at once.
        val again = SystemClock.elapsedRealtime()
        controller.stopForUpdate()
        assertTrue(SystemClock.elapsedRealtime() - again < 2_000)
    }

    @Test
    fun stopForUpdateCancelsASetupJobAndWaitsForItsGroup() {
        val manager = fixture.build()
        val pids = File(fixture.checkout, "setup.pids")
        val job = SetupJob(fixture.setupScript(), listOf("600", "0", pids.path), fixture.checkout)
        assertTrue(onActivity { manager.runSetup(it, job) })
        val members = waitFor("setup pids", 10_000) { readPids(pids) }.mapNotNull { Procfs.read(it) }
        assertEquals(2, members.size)

        val called = SystemClock.elapsedRealtime()
        manager.serverController.stopForUpdate()
        timing("stopForUpdate-setup callMs=${SystemClock.elapsedRealtime() - called}")
        val finished = manager.setup.value as SetupState.Finished
        assertEquals(143, finished.exitCode)
        assertTrue(members.none { stillAlive(it) })
        awaitReleased()
    }

    @Test
    fun aSetupJobKeepsRunningAfterTheAppIsBackgroundedAndBlocksServerStarts() {
        val manager = fixture.build()
        val pids = File(fixture.checkout, "setup.pids")
        val job = SetupJob(fixture.setupScript(), listOf("40", "0", pids.path), fixture.checkout)
        val started = SystemClock.elapsedRealtime()
        assertTrue(onActivity { manager.runSetup(it, job) })
        // One job at a time, and no server start while it runs.
        val other = SetupJob(fixture.setupScript(), listOf("1", "0", File(fixture.checkout, "other.pids").path), fixture.checkout)
        assertFalse(onActivity { manager.runSetup(it, other) })
        onActivity { manager.start(it) }
        assertTrue(manager.recentLogLines().contains("[sillybunny-android] start-refused reason=setup-running"))
        waitUntil("foreground", 10_000) { isForegroundService(context) }
        val members = waitFor("setup pids", 10_000) { readPids(pids) }.mapNotNull { Procfs.read(it) }
        assertEquals(2, members.size)

        UiDevice.getInstance(instrumentation).pressHome()
        waitUntil("activity stopped", 10_000) { scenario.state == Lifecycle.State.CREATED }
        assertTrue(isForegroundService(context))
        waitUntil("progress in the background", 15_000) {
            (manager.setup.value as? SetupState.Running)?.lines?.contains("setup step 10") == true
        }
        assertTrue(isForegroundService(context))
        val finished = waitFor("setup finished", 30_000) { manager.setup.value as? SetupState.Finished }
        timing("setup-40-steps ms=${SystemClock.elapsedRealtime() - started}")
        assertTrue(finished.job === job)
        assertEquals(0, finished.exitCode)
        assertTrue(finished.lines.contains("setup step 40"))
        assertEquals("setup done", finished.lines.last())
        // The background child it left behind went with its group.
        assertTrue(members.none { stillAlive(it) })

        // Full output in setup.log; the job ran with the plan 2.5 environment and no launch token.
        val log = fixture.setupLogText()
        assertTrue(log.contains("setup step 1\n"))
        assertTrue(log.contains("setup done\n"))
        assertTrue(log.contains("[sillybunny-android] setup exit code=0"))
        val environment = ServerDeviceFixture.parseEnvironment(File(pids.path + ".env"))
        assertFalse(environment.containsKey(ProcessEnvironment.LAUNCH_TOKEN))
        assertEquals(
            ProcessEnvironment.build(fixture.paths, System.getenv(), VERSION_CODE, false, null).toMap(),
            environment.filterKeys { it !in SHELL_VARIABLES },
        )
        // The refused start never launched anything.
        assertTrue(fixture.specs.sessions.isEmpty())
        assertTrue(manager.state.value is ServerState.Stopped)
        awaitReleased()
    }

    @Test
    fun aSetupJobIsRefusedWhileTheServerRunsAndAllowedOnceItStopped() {
        val manager = fixture.build()
        startFromActivity(manager)
        awaitRunning(manager)
        val job = SetupJob(fixture.setupScript(), listOf("1", "0", File(fixture.checkout, "setup.pids").path), fixture.checkout)
        assertFalse(onActivity { manager.runSetup(it, job) })
        assertEquals(SetupState.Idle, manager.setup.value)

        assertTrue(manager.stop())
        assertTrue(onActivity { manager.runSetup(it, job) })
        val finished = waitFor("setup finished", 20_000) { manager.setup.value as? SetupState.Finished }
        assertEquals(0, finished.exitCode)
        awaitReleased()
    }

    @Test
    fun cancellingASetupJobStopsItsWholeGroup() {
        val manager = fixture.build()
        val pids = File(fixture.checkout, "setup.pids")
        val job = SetupJob(fixture.setupScript(), listOf("600", "0", pids.path), fixture.checkout)
        assertTrue(onActivity { manager.runSetup(it, job) })
        val members = waitFor("setup pids", 10_000) { readPids(pids) }.mapNotNull { Procfs.read(it) }
        assertEquals(2, members.size)
        waitUntil("progress", 10_000) {
            (manager.setup.value as? SetupState.Running)?.lines?.contains("setup step 3") == true
        }

        val cancelled = SystemClock.elapsedRealtime()
        manager.cancelSetup()
        val finished = waitFor("cancelled", 20_000) { manager.setup.value as? SetupState.Finished }
        timing("setup-cancel ms=${SystemClock.elapsedRealtime() - cancelled}")
        assertEquals(143, finished.exitCode)
        assertTrue(members.none { stillAlive(it) })
        awaitReleased()

        // The server may start again once the job is done.
        startFromActivity(manager)
        awaitRunning(manager)
        assertTrue(manager.stop())
        awaitReleased()
    }

    @Test
    fun cancellingASetupJobAlsoStopsItsDescendantInASessionOfItsOwn() {
        val manager = fixture.build()
        val pids = File(fixture.checkout, "setup.pids")
        val job = SetupJob(fixture.setupScript(), listOf("600", "0", pids.path, "detached"), fixture.checkout)
        assertTrue(onActivity { manager.runSetup(it, job) })
        val members = waitFor("setup pids", 10_000) { readPids(pids) }.mapNotNull { Procfs.read(it) }
        assertEquals(2, members.size)
        val detached = awaitOwnSession(File(pids.path + ".detached").readText().trim().toInt())
        assertNotEquals(members[0].pgid, detached.pgid)
        waitUntil("progress", 10_000) {
            (manager.setup.value as? SetupState.Running)?.lines?.contains("setup step 3") == true
        }

        val cancelled = SystemClock.elapsedRealtime()
        manager.cancelSetup()
        val finished = waitFor("cancelled", 20_000) { manager.setup.value as? SetupState.Finished }
        timing("setup-cancel-with-detached-child ms=${SystemClock.elapsedRealtime() - cancelled}")
        assertEquals(143, finished.exitCode)
        assertTrue(members.none { stillAlive(it) })
        assertFalse(stillAlive(detached))
        awaitReleased()
    }

    @Test
    fun aCommandThatExitsRightAfterStartingABackgroundJobLeavesNothingBehind() {
        fixture.enableQuickExit()
        val manager = fixture.build()
        startFromActivity(manager)
        val failed = waitFor("Failed", 30_000) { manager.state.value as? ServerState.Failed }
        assertTrue(failed.canRestart)
        assertEquals(4, fixture.specs.sessions.size)
        val orphans = fixture.orphanPids()
        assertEquals(4, orphans.size)
        assertTrue(orphans.none { sleeperAlive(it) })
        waitUntil("cleanup markers", 10_000) {
            fixture.serverLogText().split('\n').count { it.startsWith("[sillybunny-android] cleanup step=group_term") } == 4
        }
        awaitReleased()
    }

    @Test
    fun aBackgroundJobStartedJustBeforeASetupScriptExitsIsStoppedWithItsGroup() {
        val manager = fixture.build()
        val pids = File(fixture.checkout, "setup.pids")
        val job = SetupJob(fixture.setupScript(), listOf("0", "0", pids.path), fixture.checkout)
        val started = SystemClock.elapsedRealtime()
        assertTrue(onActivity { manager.runSetup(it, job) })
        val finished = waitFor("setup finished", 20_000) { manager.setup.value as? SetupState.Finished }
        val elapsed = SystemClock.elapsedRealtime() - started
        timing("setup-short-job ms=$elapsed")
        assertEquals(0, finished.exitCode)
        val background = checkNotNull(readPids(pids))[1]
        assertFalse(sleeperAlive(background))
        // SIGTERM was enough: no SIGKILL grace period ran out.
        assertTrue(elapsed < BashScriptRunner.CANCEL_STOP.groupTermGraceMillis)
        awaitReleased()
    }

    @Test
    fun nodesLogcatOnlyReportsReachTheServerLogAfterAnUnexpectedExit() {
        fixture.enableNativeReport()
        val manager = fixture.build()
        startFromActivity(manager)
        val first = awaitRunning(manager)
        val ids = awaitIds(manager)
        Os.kill(checkNotNull(ids.server), Signals.SIGKILL)
        awaitRunning(manager, after = first.session)
        waitUntil("native log", 15_000) {
            fixture.serverLogText().contains("[sillybunny-android] native-log tag=${LogcatNativeLog.TAG}")
        }
        assertTrue(fixture.serverLogText().contains("launcher native report pid=${ids.command}"))

        assertTrue(manager.stop())
        awaitReleased()
    }

    private fun <T> onActivity(block: (ComponentActivity) -> T): T {
        var result: Result<T>? = null
        scenario.onActivity { result = runCatching { block(it) } }
        return checkNotNull(result).getOrThrow()
    }

    private fun startFromActivity(manager: ServerManager) = onActivity { manager.start(it) }

    private fun awaitRunning(
        manager: ServerManager,
        after: LaunchSession? = null,
        timeoutMillis: Long = 30_000,
    ): ServerState.Running = waitFor("Running", timeoutMillis) {
        (manager.state.value as? ServerState.Running)?.takeIf { it.session != after }
    }

    private fun awaitIds(manager: ServerManager): ProcessIds = waitFor("supervisor and server", 15_000) {
        manager.currentProcessIds()?.takeIf { it.supervisor != null && it.server != null }
    }

    private fun awaitReleased() = waitUntil("service released", 15_000) { !isServiceRunning(context) }

    /** Booleans only, so a failing check never prints a token either. */
    private fun assertNoToken(text: String) {
        assertFalse("a launch token reached the text", fixture.specs.sessions.any { text.contains(it.token) })
    }

    private fun readPids(file: File): List<Int>? {
        if (!file.isFile) return null
        val text = file.readText()
        if (!text.endsWith("\n")) return null
        return text.trim().split(' ').mapNotNull { it.toIntOrNull() }.takeIf { it.size == 2 }
    }
}
