package io.github.sillybunnyteam.sillybunny.firstrun

import android.app.Activity
import android.app.ActivityManager
import android.app.Application
import android.content.Context
import android.os.Bundle
import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Direction
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import io.github.sillybunnyteam.sillybunny.BuildConfig
import io.github.sillybunnyteam.sillybunny.runtime.RuntimePaths
import io.github.sillybunnyteam.sillybunny.server.ServerHost
import io.github.sillybunnyteam.sillybunny.server.ServerState
import io.github.sillybunnyteam.sillybunny.server.SetupJob
import io.github.sillybunnyteam.sillybunny.server.SetupState
import java.io.File
import java.io.IOException
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread
import kotlinx.coroutines.flow.MutableStateFlow

/**
 * A `ServerHost` for device tests. It runs each setup job as `/system/bin/sh <script> <args>` on a background
 * thread, streams the merged output into [setup] and the setup log, and cancels with SIGTERM. Like the real
 * host, the job lives outside any activity, so it keeps running while the screens come and go.
 */
internal class ShellServerHost(private val setupLog: File) : ServerHost {
    override val state = MutableStateFlow<ServerState>(ServerState.Stopped(userStopped = false))
    override val setup = MutableStateFlow<SetupState>(SetupState.Idle)

    val jobs = CopyOnWriteArrayList<SetupJob>()

    /** Calls to [cancelSetup], the user's Cancel. */
    val cancels = AtomicInteger()

    /** Every output line of every job so far. */
    val streamed = AtomicInteger()

    @Volatile
    private var process: Process? = null

    @Synchronized
    override fun runSetup(context: Context, job: SetupJob): Boolean {
        if (setup.value is SetupState.Running) return false
        jobs += job
        setup.value = SetupState.Running(job, emptyList())
        thread(name = "firstrun-test-setup", isDaemon = true) { run(job) }
        return true
    }

    private fun run(job: SetupJob) {
        val lines = ArrayList<String>()
        val exitCode = try {
            setupLog.parentFile?.mkdirs()
            val started = ProcessBuilder(listOf("/system/bin/sh", job.script.path) + job.args)
                .directory(job.workingDir)
                .redirectErrorStream(true)
                .start()
            process = started
            setupLog.bufferedWriter().use { log ->
                started.inputStream.bufferedReader().forEachLine { line ->
                    log.appendLine(line)
                    log.flush()
                    lines += line
                    streamed.incrementAndGet()
                    setup.value = SetupState.Running(job, lines.takeLast(MAX_LINES))
                }
            }
            started.waitFor()
        } catch (error: IOException) {
            lines += "shell failed: ${error.message}"
            SHELL_FAILED
        } finally {
            process = null
        }
        setup.value = SetupState.Finished(job, exitCode, lines.takeLast(MAX_LINES))
    }

    override fun cancelSetup() {
        cancels.incrementAndGet()
        process?.destroy()
    }

    /** Ends a job a test left running, without counting as a user cancel. */
    fun stopForTest() {
        process?.destroy()
    }

    /** The number of lines the running job has streamed, or -1 when no job runs. */
    fun runningLines(): Int = (setup.value as? SetupState.Running)?.lines?.size ?: -1

    override fun start(context: Context) = Unit

    override fun stop(timeoutMillis: Long): Boolean = true

    override fun restart(context: Context) = Unit

    override fun recentLogLines(): List<String> = emptyList()

    override fun logFiles(): List<File> = listOf(setupLog)

    private companion object {
        const val MAX_LINES = 2_000
        const val SHELL_FAILED = 127
    }
}

/**
 * A private `filesDir` with a fake `install.sh`. The script checks the first-run arguments, notes in `starts`
 * whether `--dir` existed when it began, streams lines until the test calls [release], then acts on [mode]:
 * `success` writes a checkout and commits `.git/index` last, as git does, then exits 0; `partial` leaves a
 * half clone and exits 1; anything else exits 1 with nothing written. [otherJob] stands in for another setup
 * job such as Repair: it streams until [releaseOther] and exits 0.
 */
internal class FirstRunDeviceFixture(context: Context, name: String) {
    private val appContext = context.applicationContext
    val root = File(appContext.filesDir, "firstrun-device-test/$name").apply {
        deleteRecursively()
        mkdirs()
    }
    val paths = RuntimePaths(
        File(root, "files").apply { mkdirs() },
        File(root, "cache").apply { mkdirs() },
        File(appContext.applicationInfo.nativeLibraryDir),
    )
    val script = File(root, "install.sh").apply { writeText(SCRIPT) }
    private val otherScript = File(root, "other.sh").apply { writeText(OTHER_SCRIPT) }
    val setupLogFile = File(paths.logsDir, FirstRunDependencies.SETUP_LOG_FILE_NAME)
    val host = ShellServerHost(setupLogFile)

    fun mode(value: String) = File(root, "mode").writeText(value)

    fun release() {
        File(root, "go").createNewFile()
    }

    /** A Repair-shaped job: the first-run arguments plus `--migrate-from`, so it is never the first-run job. */
    fun otherJob(): SetupJob = SetupJob(
        otherScript,
        FirstRunInstall.args(paths, BuildConfig.DEFAULT_REF) +
            listOf("--migrate-from", File(paths.filesDir, "SillyBunny.broken-20261020T000000Z").path, "--allow-git-source"),
        paths.filesDir,
    )

    fun releaseOther() {
        File(root, "go-other").createNewFile()
    }

    /** One entry per script start: `present` or `absent`, the state of `--dir` at that moment. */
    fun starts(): List<String> = File(root, "starts").takeIf { it.isFile }?.readLines().orEmpty()

    /**
     * The flow's dependencies. The probes and the layout step are fakes: the emulator's network may not be
     * validated, and the real layout belongs to task 5.5. [realPermissions] keeps the real notification and
     * battery adapters; otherwise notifications need no request, so Continue never opens the system dialog.
     */
    fun dependencies(realPermissions: Boolean = false): FirstRunDependencies {
        val notifications = if (realPermissions) {
            AndroidNotificationPermission(appContext)
        } else {
            object : NotificationPermission {
                override val required = false

                override fun isGranted() = true
            }
        }
        val battery = if (realPermissions) AndroidBatteryExemption(appContext) else BatteryExemption { false }
        return FirstRunDependencies(
            context = appContext,
            paths = paths,
            serverHost = host,
            installScript = script,
            layout = { RuntimeLayoutOutcome.Ready },
            notifications = notifications,
            battery = battery,
            storage = { FirstRunStorage.REQUIRED_FREE_BYTES * 2 },
            network = { NetworkKind.UNMETERED },
        )
    }

    /** Lets any waiting script end, stops it, and removes this fixture's own folder. */
    fun close() {
        release()
        releaseOther()
        host.stopForTest()
        eventually(5_000) { host.setup.value !is SetupState.Running }
        root.deleteRecursively()
    }

    companion object {
        /** Every regular file under [dir], relative path to content. */
        fun tree(dir: File): Map<String, String> =
            dir.walkTopDown().filter { it.isFile }.associate { it.relativeTo(dir).path to it.readText() }

        fun eventually(timeoutMillis: Long = 10_000, condition: () -> Boolean) {
            val deadline = SystemClock.uptimeMillis() + timeoutMillis
            while (!condition()) {
                check(SystemClock.uptimeMillis() < deadline) { "Condition not met within $timeoutMillis ms" }
                SystemClock.sleep(50)
            }
        }

        private val SCRIPT = """
            here="${'$'}{0%/*}"
            if [ "${'$'}1" != --no-start ] || [ "${'$'}2" != --dir ] || [ "${'$'}4" != --ref ] || [ -z "${'$'}5" ] || [ "${'$'}6" != --use-node ] || [ "${'$'}#" != 6 ]; then
                echo "unexpected arguments: ${'$'}*"
                exit 2
            fi
            dir="${'$'}3"
            if [ -e "${'$'}dir" ]; then echo present >> "${'$'}here/starts"; else echo absent >> "${'$'}here/starts"; fi
            echo "Cloning into '${'$'}dir'..."
            i=0
            while [ ! -e "${'$'}here/go" ]; do
                i=${'$'}((i + 1))
                echo "Receiving objects: ${'$'}i"
                if [ "${'$'}i" -ge 1500 ]; then echo "timed out"; exit 98; fi
                sleep 0.2 2>/dev/null || sleep 1
            done
            case "${'$'}(cat "${'$'}here/mode" 2>/dev/null)" in
                success)
                    mkdir -p "${'$'}dir/.git" && echo 'ref: refs/heads/staging' > "${'$'}dir/.git/HEAD" &&
                        echo '{"name":"sillybunny"}' > "${'$'}dir/package.json" &&
                        echo DIRC > "${'$'}dir/.git/index.lock" && mv "${'$'}dir/.git/index.lock" "${'$'}dir/.git/index" || exit 3
                    echo "Done."
                    exit 0
                    ;;
                partial)
                    mkdir -p "${'$'}dir/.git" && echo 'ref: refs/heads/staging' > "${'$'}dir/.git/HEAD" &&
                        echo 'half' > "${'$'}dir/half.js" || exit 3
                    echo "fatal: early EOF"
                    exit 1
                    ;;
                *)
                    echo "fatal: unable to access the repository"
                    exit 1
                    ;;
            esac
        """.trimIndent() + "\n"

        private val OTHER_SCRIPT = """
            here="${'$'}{0%/*}"
            i=0
            while [ ! -e "${'$'}here/go-other" ]; do
                i=${'$'}((i + 1))
                echo "Migrating: ${'$'}i"
                if [ "${'$'}i" -ge 1500 ]; then echo "timed out"; exit 98; fi
                sleep 0.2 2>/dev/null || sleep 1
            done
            echo "Done."
            exit 0
        """.trimIndent() + "\n"
    }
}

/**
 * Hosts [FirstRunScreen] in the debug `ComponentActivity` from `ui-test-manifest`, the way task 5.5's activity
 * will: every new activity instance asks [FirstRun.controller] for its controller and sets the content, so a
 * recreation gets the same controller back and a new activity gets a new one.
 */
internal class FirstRunScreenHost(private val dependencies: FirstRunDependencies) :
    Application.ActivityLifecycleCallbacks,
    AutoCloseable {
    val installed = AtomicInteger()
    val repairs = AtomicInteger()
    val shares = AtomicInteger()
    private val app = ApplicationProvider.getApplicationContext<Application>()

    @Volatile
    private var latest: FirstRunController? = null

    lateinit var scenario: ActivityScenario<ComponentActivity>
        private set

    /** The newest activity instance's controller. */
    val controller: FirstRunController
        get() = checkNotNull(latest) { "No first-run activity yet" }

    fun launch(): FirstRunScreenHost {
        app.registerActivityLifecycleCallbacks(this)
        scenario = ActivityScenario.launch(ComponentActivity::class.java)
        return this
    }

    /**
     * Brings the stopped activity's task back to the front, as the launcher or recents would, and waits until it
     * is started. A real Home press leaves nothing for `ActivityScenario.moveToState(RESUMED)` to finish, so it
     * cannot do this itself. Android 10 refuses app switches for about 5 s after Home (logcat: "Move to front
     * request from <uid> stopped"), so the move is retried until it lands.
     */
    fun bringToFront(timeoutMillis: Long = 20_000) {
        var taskId = -1
        scenario.onActivity { taskId = it.taskId }
        val manager = app.getSystemService(ActivityManager::class.java)
        val deadline = SystemClock.uptimeMillis() + timeoutMillis
        while (!controller.state.value.visible) {
            check(SystemClock.uptimeMillis() < deadline) { "Task $taskId did not come back to the front" }
            val task = manager.appTasks.firstOrNull { it.taskInfo?.taskId == taskId }
            checkNotNull(task) { "No app task $taskId" }.moveToFront()
            val retryAt = SystemClock.uptimeMillis() + BRING_TO_FRONT_RETRY_MILLIS
            while (!controller.state.value.visible && SystemClock.uptimeMillis() < retryAt) SystemClock.sleep(50)
        }
    }

    override fun onActivityPostCreated(activity: Activity, savedInstanceState: Bundle?) {
        // Only the test host activity, never an app activity that happens to start meanwhile.
        if (activity.javaClass != ComponentActivity::class.java) return
        val host = activity as ComponentActivity
        val controller = FirstRun.controller(host, dependencies)
        latest = controller
        host.setContent {
            FirstRunScreen(
                controller = controller,
                onInstalled = { installed.incrementAndGet() },
                onRepair = { repairs.incrementAndGet() },
                onShareLogs = { shares.incrementAndGet() },
            )
        }
    }

    override fun close() {
        try {
            scenario.close()
        } finally {
            app.unregisterActivityLifecycleCallbacks(this)
        }
    }

    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit

    override fun onActivityStarted(activity: Activity) = Unit

    override fun onActivityResumed(activity: Activity) = Unit

    override fun onActivityPaused(activity: Activity) = Unit

    override fun onActivityStopped(activity: Activity) = Unit

    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit

    override fun onActivityDestroyed(activity: Activity) = Unit

    private companion object {
        const val BRING_TO_FRONT_RETRY_MILLIS = 1_000L
    }
}

/**
 * The first-run controls, found by test tag: debug builds expose the tags as resource IDs. The Compose test rule
 * is not used, because the Espresso 3.5.0 it brings fails on API 37 (`InputManager.getInstance`). UiAutomator
 * only sees controls on screen, so lookups scroll the screen's column, down to its end and then back up.
 */
internal object FirstRunUi {
    private val device get() = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())

    fun findOrNull(tag: String, timeoutMillis: Long = 10_000): UiObject2? {
        val deadline = SystemClock.uptimeMillis() + timeoutMillis
        var direction = Direction.DOWN
        while (true) {
            device.wait(Until.findObject(By.res(tag)), POLL_MILLIS)?.let { return it }
            if (SystemClock.uptimeMillis() >= deadline) return null
            val column = device.findObject(By.scrollable(true)) ?: continue
            if (!column.scroll(direction, 0.8f)) {
                direction = if (direction == Direction.DOWN) Direction.UP else Direction.DOWN
            }
        }
    }

    fun find(tag: String, timeoutMillis: Long = 10_000): UiObject2 =
        checkNotNull(findOrNull(tag, timeoutMillis)) { "$tag is not on screen" }

    fun shown(tag: String, timeoutMillis: Long = 10_000): Boolean = findOrNull(tag, timeoutMillis) != null

    fun gone(tag: String, timeoutMillis: Long = 10_000): Boolean =
        device.wait(Until.gone(By.res(tag)), timeoutMillis) == true

    /** On screen right now, without scrolling. Pair an absence check with a state assertion. */
    fun present(tag: String): Boolean = device.hasObject(By.res(tag))

    fun click(tag: String) = find(tag).click()

    private const val POLL_MILLIS = 1_000L
}
