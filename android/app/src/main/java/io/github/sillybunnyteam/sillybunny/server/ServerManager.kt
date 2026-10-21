package io.github.sillybunnyteam.sillybunny.server

import android.app.Service
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.CancellationSignal
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.annotation.VisibleForTesting
import androidx.core.content.ContextCompat
import io.github.sillybunnyteam.sillybunny.ServerService
import io.github.sillybunnyteam.sillybunny.runtime.RuntimePaths
import io.github.sillybunnyteam.sillybunny.settings.AppSettings
import io.github.sillybunnyteam.sillybunny.update.ServerController
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.lang.ref.WeakReference
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/** Starts [ServerService] with an action; unit tests replace it. */
internal fun interface ServiceStarter {
    fun start(context: Context, action: String)
}

/** Everything [ServerManager] uses from outside, so tests can replace any part. */
internal data class ServerDependencies(
    val paths: () -> RuntimePaths,
    val logsDir: File,
    val controlDir: File,
    val launcher: ProcessLauncher,
    val versionCode: () -> Long,
    val autoUpdate: () -> Boolean,
    val lastExitUserRequested: () -> Boolean,
    val launchSpecs: LaunchSpecFactory = LaunchSpecFactory.PRODUCTION,
    val scriptInterpreter: (RuntimePaths) -> List<String> = { listOf(it.bash.absolutePath, "--noprofile", "--norc") },
    val health: HealthCheck = HealthProbe(),
    val clock: () -> Long = SystemClock::elapsedRealtime,
    val restart: RestartConfig = RestartConfig(),
    val stop: StopConfig = StopConfig(),
    val scriptStop: StopConfig = BashScriptRunner.CANCEL_STOP,
    val healthPollMillis: Long = 250,
    val startupTimeoutMillis: Long = 30 * 60_000L,
    val inheritedEnvironment: () -> Map<String, String> = { System.getenv() },
    val portFree: (Int) -> Boolean = PortPolicy::loopbackPortFree,
    val portBusyDelayMillis: Long = 400,
    val serviceStarter: ServiceStarter = PLATFORM_STARTER,
    val nativeLog: NativeLog = LogcatNativeLog(),
) {
    companion object {
        val PLATFORM_STARTER = ServiceStarter { context, action ->
            ContextCompat.startForegroundService(context, ServerService.intent(context, action))
        }

        fun production(context: Context): ServerDependencies {
            val app = context.applicationContext
            // logsDir does not depend on nativeLibraryDir, which every launch resolves afresh.
            val stable = RuntimePaths(app.filesDir, app.cacheDir, File(app.applicationInfo.nativeLibraryDir.orEmpty()))
            val controlDir = File(stable.cacheDir, "server-process")
            return ServerDependencies(
                paths = { RuntimePaths(app) },
                logsDir = stable.logsDir,
                controlDir = controlDir,
                launcher = SessionLauncher(controlDir),
                versionCode = { installedVersionCode(app) },
                autoUpdate = { AppSettings(app).autoUpdateGit },
                lastExitUserRequested = { ExitHistory.lastExitUserRequested(app) },
            )
        }

        private fun installedVersionCode(context: Context): Long = try {
            val info = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                context.packageManager.getPackageInfo(context.packageName, PackageManager.PackageInfoFlags.of(0))
            } else {
                @Suppress("DEPRECATION")
                context.packageManager.getPackageInfo(context.packageName, 0)
            }
            info.longVersionCode
        } catch (_: PackageManager.NameNotFoundException) {
            0
        }
    }
}

/**
 * The single process-wide [ServerHost] (task 5.4). It owns the server's process group (`start.sh` under
 * an app-owned `setsid` session), its logs, health probe, bounded restart policy and stop, and the one
 * setup job, all kept alive by [ServerService].
 *
 * - Obtain it with [ServerManager.get].
 * - Wire [serverController] into `AppUpdater.serverController`.
 * - [start], [restart] and [runSetup] start a foreground service: call them only while an activity is
 *   visible or from a user action. [stop] blocks: never call it on the main thread.
 * - Every state change happens on one worker thread, in call order.
 * - The health probe, which carries the launch token, starts only after the server's own output announced
 *   its listener on the session port, and only while the announcing server child still runs.
 * - Restarts and recovery only ever rerun `start.sh`: they never touch `data/` or `config.yaml`, never
 *   clone and never run Repair.
 */
class ServerManager internal constructor(
    context: Context,
    internal val dependencies: ServerDependencies,
) : ServerHost {
    // No Context field: the manager lives in a static field for the whole process.
    private val store = ServerStateStore(context.applicationContext)
    private val policy = RestartPolicy(dependencies.restart, dependencies.clock)
    private val ports = PortPolicy(store, dependencies.portFree, busyDelayMillis = dependencies.portBusyDelayMillis)
    private val escalation = StopEscalation(dependencies.stop)
    private val serverLog = RotatingLogFile(dependencies.logsDir, SERVER_LOG, LOG_FILE_BYTES, SERVER_LOG_FILES)
    private val setupLog = RotatingLogFile(dependencies.logsDir, SETUP_LOG, SETUP_LOG_FILE_BYTES, SETUP_LOG_FILES)
    private val tail = LineTail(TAIL_LINES)
    private val setupTail = LineTail(SETUP_TAIL_LINES)
    private val main = Handler(Looper.getMainLooper())
    private val worker: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor { task ->
        Thread(task, "server-host").apply { isDaemon = true }
    }

    @Volatile
    private var workerThread: Thread? = null

    // Guarded by lock: what the foreground service is kept for (null when idle), and requests that the
    // worker has not handled yet, so finishing one run never releases a service a newer request needs.
    private val lock = Any()
    private var mode: ServiceMode? = null
    private var pendingServerRequests = 0
    private var pendingSetup: PendingSetup? = null

    @Volatile
    private var setupCancel: CancellationSignal? = null

    // Written on the worker thread only; [run] is also read for diagnostics and after a test shutdown.
    private var policyState: PolicyState = store.loadPolicy()

    @Volatile
    private var run: ServerRun? = null
    private var scheduledRestart: ScheduledFuture<*>? = null

    // Weak: the platform owns the running service; this only forwards to it while it exists.
    @Volatile
    private var service: WeakReference<ServerService>? = null

    /** The measured phases of the most recent stop, for diagnostics and device tests. */
    @Volatile
    internal var lastStopTimings: StopTimings? = null
        private set

    private val mutableState = MutableStateFlow(initialState(policyState))
    override val state: StateFlow<ServerState> = mutableState.asStateFlow()

    private val mutableSetup = MutableStateFlow<SetupState>(SetupState.Idle)
    override val setup: StateFlow<SetupState> = mutableSetup.asStateFlow()

    /** The awaited, bounded stop that the APK updater calls on its worker thread; never throws. */
    val serverController: ServerController = ServerController { stopForUpdate() }

    /**
     * Runs one bundled-Bash script with the §2.5 environment (no launch token) in its own process group.
     * [runSetup] uses it under the foreground service; it blocks, so never call it on the main thread.
     */
    val scriptRunner: ScriptRunner = BashScriptRunner(dependencies.launcher, dependencies.scriptStop) {
        val paths = dependencies.paths()
        prepareDirectories(paths)
        ScriptLaunch(
            dependencies.scriptInterpreter(paths),
            ProcessEnvironment.build(
                paths,
                dependencies.inheritedEnvironment(),
                dependencies.versionCode(),
                dependencies.autoUpdate(),
                launchToken = null,
            ),
        )
    }

    init {
        worker.execute {
            workerThread = Thread.currentThread()
            restoreAfterProcessStart()
        }
    }

    override fun start(context: Context) = requestServer(context, ServerService.ACTION_START)

    override fun restart(context: Context) = requestServer(context, ServerService.ACTION_RESTART)

    override fun stop(timeoutMillis: Long): Boolean {
        if (Thread.currentThread() === workerThread) return handleStop()
        val stopped = AtomicBoolean(false)
        val done = CountDownLatch(1)
        try {
            worker.execute {
                try {
                    stopped.set(handleStop())
                } finally {
                    done.countDown()
                }
            }
        } catch (_: RejectedExecutionException) {
            return run == null
        }
        return try {
            done.await(timeoutMillis, TimeUnit.MILLISECONDS) && stopped.get()
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
            false
        }
    }

    override fun runSetup(context: Context, job: SetupJob): Boolean {
        val cancel = CancellationSignal()
        val previous: SetupState
        synchronized(lock) {
            if (mode != null) return false
            val current = mutableState.value
            if (current is ServerState.Starting || current is ServerState.Running || current is ServerState.Stopping) {
                return false
            }
            mode = ServiceMode.SETUP
            pendingSetup = PendingSetup(job, cancel)
            setupCancel = cancel
            previous = mutableSetup.value
            mutableSetup.value = SetupState.Running(job, emptyList())
        }
        val started = try {
            dependencies.serviceStarter.start(context, ServerService.ACTION_SETUP)
            true
        } catch (_: RuntimeException) {
            false
        }
        if (!started) {
            synchronized(lock) {
                mode = null
                pendingSetup = null
                setupCancel = null
                mutableSetup.value = previous
            }
            return false
        }
        worker.execute(::handleSetup)
        return true
    }

    override fun cancelSetup() {
        setupCancel?.cancel()
    }

    override fun recentLogLines(): List<String> = tail.snapshot()

    override fun logFiles(): List<File> = (setupLog.files() + serverLog.files()).sortedBy { it.lastModified() }

    /**
     * Stops everything before an APK install (plan §5.5): cancels a setup job, then stops the server
     * (as a user stop, so nothing restarts it), and blocks until both are gone or [UPDATE_STOP_MILLIS]
     * passes. Never throws into the updater.
     */
    fun stopForUpdate() {
        try {
            val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(UPDATE_STOP_MILLIS)
            setupCancel?.cancel()
            while (mutableSetup.value is SetupState.Running && System.nanoTime() - deadline < 0) Thread.sleep(50)
            val remaining = TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime())
            if (remaining > 0) stop(remaining)
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
        } catch (_: RuntimeException) {
            // The updater must be able to continue whatever happened here.
        }
    }

    /** The current run's process IDs, for device tests. */
    @VisibleForTesting
    internal fun currentProcessIds(): ProcessIds? = run?.process?.ids()

    /** The service instance that currently forwards its commands here, for device tests. */
    @VisibleForTesting
    internal fun attachedService(): ServerService? = service?.get()

    internal fun attachService(service: ServerService) {
        if (this.service?.get() !== service) this.service = WeakReference(service)
    }

    internal fun detachService(service: ServerService) {
        if (this.service?.get() === service) this.service = null
    }

    /**
     * [ServerService.onStartCommand], on the main thread: promote first, then hand the work to the worker.
     * Every action that [ServiceStarter] sends came through `startForegroundService`, so the service promotes
     * even when the worker already finished that request; it then leaves the foreground again if idle.
     */
    internal fun onStartCommand(service: ServerService, action: String?): Int = when (action) {
        ServerService.ACTION_START, ServerService.ACTION_RESTART -> {
            val promoted = service.promote(currentMode() ?: ServiceMode.SERVER)
            if (!promoted) execute(::onServerPromotionRefused)
            requestRelease()
            if (promoted) Service.START_STICKY else Service.START_NOT_STICKY
        }
        ServerService.ACTION_SETUP -> {
            // A setup job must not run without the service that keeps it alive.
            if (!service.promote(currentMode() ?: ServiceMode.SETUP)) setupCancel?.cancel()
            requestRelease()
            Service.START_NOT_STICKY
        }
        ServerService.ACTION_STOP -> {
            execute { handleStop() }
            Service.START_NOT_STICKY
        }
        null -> onStickyRecreate()
        else -> {
            requestRelease()
            Service.START_NOT_STICKY
        }
    }

    private fun requestServer(context: Context, action: String) {
        synchronized(lock) {
            if (mode == ServiceMode.SETUP) {
                marker("start-refused reason=setup-running")
                return
            }
            mode = ServiceMode.SERVER
            pendingServerRequests++
        }
        val started = try {
            dependencies.serviceStarter.start(context, action)
            true
        } catch (_: RuntimeException) {
            // For example ForegroundServiceStartNotAllowedException when called from the background.
            false
        }
        execute { if (started) handleServerRequest(action) else handleStartRefused() }
    }

    private fun onStickyRecreate(): Int {
        if (synchronized(lock) { mode != null }) return Service.START_STICKY
        if (store.loadPolicy().intent != RunIntent.RUN) {
            requestRelease()
            return Service.START_NOT_STICKY
        }
        synchronized(lock) {
            mode = ServiceMode.SERVER
            pendingServerRequests++
        }
        execute(::handleRecreated)
        return Service.START_STICKY
    }

    private fun handleServerRequest(action: String) {
        synchronized(lock) { pendingServerRequests-- }
        if (action == ServerService.ACTION_RESTART) {
            run?.let(::stopRun)
        } else if (run != null) {
            return
        }
        cancelScheduledRestart()
        policyState = policy.explicitStart().also(store::savePolicy)
        launch(attempt = 1)
    }

    private fun handleStartRefused() {
        synchronized(lock) { pendingServerRequests-- }
        marker("start-refused reason=foreground-service")
        if (run == null && scheduledRestart == null) {
            publish(ServerState.Failed(tail.last(FAILED_LINES), canRestart = true))
            endServerMode()
        }
    }

    private fun onServerPromotionRefused() {
        // The start command can reach the service before its request reaches the worker; handle the
        // request first, so the refusal always has the last word.
        if (synchronized(lock) { pendingServerRequests } > 0) {
            schedule(PROMOTION_RETRY_MILLIS, ::onServerPromotionRefused)
            return
        }
        marker("start-refused reason=foreground-promotion")
        cancelScheduledRestart()
        run?.let(::stopRun)
        giveUp(canRestart = true)
    }

    private fun handleRecreated() {
        synchronized(lock) { pendingServerRequests-- }
        if (run != null || scheduledRestart != null) return
        val (next, decision) = policy.onRecreate(policyState, dependencies.lastExitUserRequested())
        policyState = next.also(store::savePolicy)
        marker("recreated decision=${describe(decision)}")
        if (decision !is PolicyDecision.Restart) {
            apply(decision)
            return
        }
        main.post {
            val promoted = service?.get()?.promote(ServiceMode.SERVER) == true
            execute {
                if (promoted) {
                    scheduleRestart(decision)
                } else {
                    marker("recreate-refused reason=foreground-promotion")
                    publish(ServerState.Stopped(userStopped = false))
                    endServerMode()
                }
            }
        }
    }

    private fun handleStop(): Boolean {
        cancelScheduledRestart()
        // Persisted before the stop starts, so a host death mid-stop still never resurrects the server.
        policyState = policy.userStop().also(store::savePolicy)
        val gone = run?.let(::stopRun) ?: true
        publish(ServerState.Stopped(userStopped = true))
        endServerMode()
        return gone
    }

    private fun launch(attempt: Int) {
        publish(ServerState.Starting(attempt))
        val session: LaunchSession
        val originChanged: Boolean
        val spec: LaunchSpec
        try {
            val paths = dependencies.paths()
            prepareDirectories(paths)
            val choice = ports.choose()
            session = LaunchSession(choice.port, LaunchTokens.generate())
            originChanged = choice.originChanged
            val environment = ProcessEnvironment.build(
                paths,
                dependencies.inheritedEnvironment(),
                dependencies.versionCode(),
                dependencies.autoUpdate(),
                session.token,
            )
            spec = dependencies.launchSpecs.create(paths, session, environment)
        } catch (error: LaunchUnavailableException) {
            marker("start-unavailable missing=${error.message}")
            giveUp(canRestart = false)
            return
        } catch (error: IOException) {
            marker("start-failed reason=${error.message}")
            giveUp(canRestart = true)
            return
        } catch (_: RuntimeException) {
            marker("start-failed reason=launch")
            giveUp(canRestart = true)
            return
        }
        marker("start attempt=$attempt port=${session.port} originChanged=$originChanged")
        // Taken before the spawn, so the native-log query also covers reports from the first moments.
        val launchedEpochMillis = System.currentTimeMillis()
        val process = try {
            dependencies.launcher.launch(spec)
        } catch (_: IOException) {
            marker("spawn-failed")
            applyExit(ExitKind.Unexpected(null))
            return
        }
        val current = ServerRun(process, session, originChanged, launchedEpochMillis)
        run = current
        current.pump.start()
        current.monitor.start()
    }

    private fun onHealthy(target: ServerRun) {
        if (run !== target || target.stopRequested) return
        marker("healthy afterMs=${TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - target.startedNanos)}")
        publish(ServerState.Running(target.session, target.originChanged))
        // Persisted until now, so a run that ended early or a host death never loses the origin change.
        if (target.originChanged) ports.originChangeReported(target.session.port)
    }

    /** On the output pump: the server announced its listener, so tie it to the server child running now. */
    private fun onListenerAnnounced(target: ServerRun) {
        val server = try {
            target.process.servingProcess()
        } catch (_: RuntimeException) {
            null
        }
        if (server != null) target.listener.set(server)
    }

    private fun onStartupTimeout(target: ServerRun) {
        if (run !== target || target.stopRequested) return
        marker("startup-timeout")
        stopRun(target)
        giveUp(canRestart = true)
    }

    private fun onExited(target: ServerRun) {
        if (run !== target || target.stopRequested) return
        val code = target.process.exitCode
        marker("exit code=${code ?: "unknown"}")
        // The command is gone, but members such as the server child of a killed supervisor may remain.
        if (!target.process.isGone()) {
            val timings = escalation.stop(target.process, supervisorFirst = false)
            marker("cleanup step=${timings.stoppedBy.name.lowercase()} totalMs=${timings.totalMillis}")
        }
        finishRun(target)
        if (code != 0) {
            appendNativeLog(target.startedEpochMillis, target.session.token, ::appendServerLine)
            serverLog.flush()
        }
        applyExit(if (code == 0) ExitKind.Clean else ExitKind.Unexpected(code))
    }

    private fun applyExit(kind: ExitKind) {
        val (next, decision) = policy.onExit(policyState, kind)
        policyState = next.also(store::savePolicy)
        apply(decision)
    }

    private fun apply(decision: PolicyDecision) {
        when (decision) {
            is PolicyDecision.Stop -> {
                publish(ServerState.Stopped(decision.userStopped))
                endServerMode()
            }
            is PolicyDecision.Restart -> scheduleRestart(decision)
            PolicyDecision.GiveUp -> {
                marker("gave-up")
                publish(ServerState.Failed(tail.last(FAILED_LINES), canRestart = true))
                endServerMode()
            }
        }
    }

    private fun scheduleRestart(decision: PolicyDecision.Restart) {
        marker("restart attempt=${decision.attempt} delayMs=${decision.delayMillis}")
        publish(ServerState.Starting(decision.attempt))
        scheduledRestart = worker.schedule({
            scheduledRestart = null
            if (run == null && policyState.intent == RunIntent.RUN) launch(decision.attempt)
        }, decision.delayMillis, TimeUnit.MILLISECONDS)
    }

    private fun cancelScheduledRestart() {
        scheduledRestart?.cancel(false)
        scheduledRestart = null
    }

    private fun giveUp(canRestart: Boolean) {
        policyState = policy.giveUp(policyState).also(store::savePolicy)
        publish(ServerState.Failed(tail.last(FAILED_LINES), canRestart))
        endServerMode()
    }

    /** Plan §4.4 escalation; returns true once the whole group is gone. */
    private fun stopRun(target: ServerRun): Boolean {
        target.stopRequested = true
        publish(ServerState.Stopping)
        val timings = escalation.stop(target.process)
        lastStopTimings = timings
        marker(
            "stop step=${timings.stoppedBy.name.lowercase()} supervisorMs=${timings.supervisorPhaseMillis} " +
                "groupTermMs=${timings.groupTermPhaseMillis} killMs=${timings.killPhaseMillis} totalMs=${timings.totalMillis}",
        )
        finishRun(target)
        return timings.gone
    }

    private fun finishRun(target: ServerRun) {
        try {
            target.process.waitForExit(1_000)
            target.pump.join(1_000)
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
        }
        target.process.release()
        serverLog.flush()
        if (run === target) run = null
    }

    private fun monitor(target: ServerRun) {
        var healthy = false
        var timedOut = false
        val deadline = target.startedNanos + TimeUnit.MILLISECONDS.toNanos(dependencies.startupTimeoutMillis)
        try {
            while (true) {
                val probing = !healthy && !timedOut && !target.stopRequested
                if (target.process.waitForExit(if (probing) dependencies.healthPollMillis else EXIT_POLL_MILLIS)) {
                    execute { onExited(target) }
                    return
                }
                if (!probing) continue
                // The token goes only to a listener the server announced, while that same server child runs:
                // before the announcement, or after its child is gone, the port may belong to another app.
                if (target.listenerReady() &&
                    dependencies.health.status(target.session.port, target.session.token) == HealthProbe.HEALTHY
                ) {
                    healthy = true
                    execute { onHealthy(target) }
                } else if (System.nanoTime() - deadline >= 0) {
                    timedOut = true
                    execute { onStartupTimeout(target) }
                }
            }
        } catch (_: InterruptedException) {
            // Only a test shutdown interrupts the monitor.
        }
    }

    private fun handleSetup() {
        val pending = synchronized(lock) { pendingSetup.also { pendingSetup = null } } ?: return
        setupTail.clear()
        setupLog.rotateNow()
        Thread({ runSetupJob(pending) }, "server-setup").apply {
            isDaemon = true
            start()
        }
    }

    private fun runSetupJob(pending: PendingSetup) {
        val job = pending.job
        val startedEpochMillis = System.currentTimeMillis()
        setupMarker("setup start script=${job.script.name}")
        val code = try {
            scriptRunner.run(job.script, job.args, job.workingDir, { line -> setupLine(job, line) }, pending.cancel)
        } catch (_: IOException) {
            SETUP_START_FAILED
        } catch (_: RuntimeException) {
            SETUP_START_FAILED
        }
        setupMarker("setup exit code=$code")
        // npm runs on the bundled Node, whose fatal reports go to logcat too.
        if (code != 0) appendNativeLog(startedEpochMillis, null) { line -> setupLine(job, line) }
        setupLog.flush()
        execute { finishSetup(job, code) }
    }

    private fun setupLine(job: SetupJob, line: String) {
        setupLog.append(line)
        // Flushed per line: if the host dies mid-job, the last lines are the ones that explain it.
        setupLog.flush()
        tail.add(line)
        setupTail.add(line)
        val current = mutableSetup.value
        if (current is SetupState.Running && current.job === job) mutableSetup.value = SetupState.Running(job, setupTail.snapshot())
    }

    private fun setupMarker(text: String) {
        val line = "$MARKER $text"
        setupLog.append(line)
        setupLog.flush()
        tail.add(line)
    }

    private fun finishSetup(job: SetupJob, code: Int) {
        synchronized(lock) {
            setupCancel = null
            mutableSetup.value = SetupState.Finished(job, code, setupTail.snapshot())
            if (mode == ServiceMode.SETUP) mode = null
        }
        requestRelease()
    }

    private fun endServerMode() {
        synchronized(lock) {
            if (mode == ServiceMode.SERVER && pendingServerRequests == 0) mode = null
        }
        requestRelease()
    }

    private fun currentMode(): ServiceMode? = synchronized(lock) { mode }

    /** Leaves the foreground only if nothing needs the service when the main thread gets to it. */
    private fun requestRelease() {
        main.post {
            if (synchronized(lock) { mode == null }) service?.get()?.release()
        }
    }

    private fun restoreAfterProcessStart() {
        dependencies.controlDir.listFiles()?.forEach { it.delete() }
        val newest = logFiles().lastOrNull()
        if (newest != null) tail.addAll(lastLines(newest, TAIL_LINES))
        val current = mutableState.value
        if (current is ServerState.Failed && current.lastLines.isEmpty()) {
            publish(ServerState.Failed(tail.last(FAILED_LINES), current.canRestart))
        }
    }

    private fun prepareDirectories(paths: RuntimePaths) {
        for (directory in listOf(paths.homeDir, paths.tmpDir, paths.statusDir, paths.logsDir)) {
            if (!directory.isDirectory && !directory.mkdirs()) throw IOException("directories")
        }
    }

    private fun appendServerLine(line: String) {
        serverLog.append(line)
        tail.add(line)
    }

    /** Adds Node's logcat-only error reports since [sinceEpochMillis] to a log, redacting [token]. */
    private fun appendNativeLog(sinceEpochMillis: Long, token: String?, sink: (String) -> Unit) {
        val lines = try {
            dependencies.nativeLog.linesSince(sinceEpochMillis)
        } catch (_: RuntimeException) {
            emptyList()
        }
        if (lines.isEmpty()) return
        sink("$MARKER native-log tag=${LogcatNativeLog.TAG} lines=${lines.size}")
        val splitter = RedactingLineSplitter(token, onLine = sink)
        for (line in lines) {
            val bytes = (line + "\n").toByteArray(Charsets.UTF_8)
            splitter.feed(bytes, bytes.size)
        }
        splitter.finish()
    }

    /** Host events in the server log: fixed keys and numbers only, never the token. Rare, so flushed at once. */
    private fun marker(text: String) {
        appendServerLine("$MARKER $text")
        serverLog.flush()
    }

    private fun publish(value: ServerState) {
        mutableState.value = value
    }

    private fun execute(task: () -> Unit) {
        try {
            worker.execute(task)
        } catch (_: RejectedExecutionException) {
            // Only after a test shutdown.
        }
    }

    private fun schedule(delayMillis: Long, task: () -> Unit) {
        try {
            worker.schedule(task, delayMillis, TimeUnit.MILLISECONDS)
        } catch (_: RejectedExecutionException) {
            // Only after a test shutdown.
        }
    }

    @VisibleForTesting
    internal fun shutdownForTest() {
        setupCancel?.cancel()
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20)
        while (mutableSetup.value is SetupState.Running && System.nanoTime() - deadline < 0) Thread.sleep(50)
        stop(20_000)
        worker.shutdownNow()
        serverLog.close()
        setupLog.close()
    }

    private inner class ServerRun(
        val process: ServerProcess,
        val session: LaunchSession,
        val originChanged: Boolean,
        val startedEpochMillis: Long,
    ) {
        @Volatile
        var stopRequested = false
        val startedNanos = System.nanoTime()

        /** The server child that announced its listener on the session port ([ListenerAnnouncement]). */
        val listener = AtomicReference<ProcStat?>(null)
        val pump = Thread({
            val splitter = RedactingLineSplitter(session.token) { line ->
                appendServerLine(line)
                if (ListenerAnnouncement.matches(line, session.port)) onListenerAnnounced(this@ServerRun)
            }
            pumpLines(process.output, splitter) { serverLog.flush() }
        }, "server-output").apply { isDaemon = true }
        val monitor = Thread({ monitor(this) }, "server-monitor").apply { isDaemon = true }

        /** True while the server child that announced the listener still runs; forgets it once it is gone. */
        fun listenerReady(): Boolean {
            val server = listener.get() ?: return false
            if (process.stillRunning(server)) return true
            listener.compareAndSet(server, null)
            return false
        }
    }

    private class PendingSetup(val job: SetupJob, val cancel: CancellationSignal)

    companion object {
        const val SERVER_LOG = "server.log"
        const val SETUP_LOG = "setup.log"
        internal const val MARKER = "[sillybunny-android]"
        internal const val TAIL_LINES = 500
        internal const val FAILED_LINES = 50
        internal const val SETUP_TAIL_LINES = 200

        /** [SetupState.Finished.exitCode] when the job's process could not be started at all. */
        const val SETUP_START_FAILED = -1

        /** The overall bound of [stopForUpdate]. */
        const val UPDATE_STOP_MILLIS = 20_000L

        private const val LOG_FILE_BYTES = 2L * 1024 * 1024
        private const val SERVER_LOG_FILES = 3
        private const val SETUP_LOG_FILE_BYTES = 8L * 1024 * 1024
        private const val SETUP_LOG_FILES = 2
        private const val EXIT_POLL_MILLIS = 1_000L
        private const val PROMOTION_RETRY_MILLIS = 20L

        @Volatile
        private var instance: ServerManager? = null

        /**
         * The process-wide manager, created on first use; [context] may be any context of this app. Use it
         * as the [ServerHost] for the UI layers, and wire its [serverController] into the APK updater.
         */
        @JvmStatic
        fun get(context: Context): ServerManager = instance ?: synchronized(this) {
            instance ?: ServerManager(context, ServerDependencies.production(context)).also { instance = it }
        }

        /** The process-wide manager if one exists, without creating it. */
        internal fun existing(): ServerManager? = instance

        /** Tests swap in a manager built with test dependencies; production code never calls this. */
        @VisibleForTesting
        internal fun replaceForTest(manager: ServerManager?) {
            val previous = synchronized(this) { instance.also { instance = manager } }
            if (previous != null && previous !== manager) previous.shutdownForTest()
        }

        private fun initialState(state: PolicyState): ServerState = when (state.intent) {
            RunIntent.USER_STOPPED -> ServerState.Stopped(userStopped = true)
            RunIntent.FAILED -> ServerState.Failed(emptyList(), canRestart = true)
            RunIntent.RUN, RunIntent.CLEAN_STOPPED -> ServerState.Stopped(userStopped = false)
        }

        private fun describe(decision: PolicyDecision): String = when (decision) {
            is PolicyDecision.Stop -> if (decision.userStopped) "stay-user-stopped" else "stay-stopped"
            is PolicyDecision.Restart -> "restart attempt=${decision.attempt}"
            PolicyDecision.GiveUp -> "failed"
        }

        private fun lastLines(file: File, count: Int): List<String> = try {
            RandomAccessFile(file, "r").use { input ->
                val start = maxOf(0L, input.length() - 256 * 1024)
                input.seek(start)
                val bytes = ByteArray((input.length() - start).toInt())
                input.readFully(bytes)
                val lines = String(bytes, Charsets.UTF_8).split('\n').dropLastWhile { it.isEmpty() }
                // The first line may be cut mid-way when the read started inside it.
                (if (start > 0) lines.drop(1) else lines).takeLast(count)
            }
        } catch (_: IOException) {
            emptyList()
        }
    }
}
