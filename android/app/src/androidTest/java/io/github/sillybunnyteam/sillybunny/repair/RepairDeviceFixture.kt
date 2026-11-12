package io.github.sillybunnyteam.sillybunny.repair

import android.app.Activity
import android.app.ActivityManager
import android.app.Application
import android.content.Context
import android.os.Bundle
import android.os.SystemClock
import android.system.Os
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.Composable
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Direction
import androidx.test.uiautomator.StaleObjectException
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import io.github.sillybunnyteam.sillybunny.server.ServerHost
import io.github.sillybunnyteam.sillybunny.server.ServerState
import io.github.sillybunnyteam.sillybunny.server.SetupJob
import io.github.sillybunnyteam.sillybunny.server.SetupState
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import java.util.regex.Pattern

/**
 * A [ServerHost] whose setup jobs really run: `/system/bin/sh <script> <args>` in [SetupJob.workingDir], with its
 * merged output streamed into [setup] and its exit code published as [SetupState.Finished], as the real host does.
 * [cancelSetup] stops the process. The server itself is only recorded.
 */
class ShellScriptServerHost(private val environment: Map<String, String>) : ServerHost {
    private val serverState = MutableStateFlow<ServerState>(ServerState.Stopped(userStopped = false))
    private val setupState = MutableStateFlow<SetupState>(SetupState.Idle)
    private val lock = Any()

    @Volatile
    private var process: Process? = null

    override val state: StateFlow<ServerState> = serverState
    override val setup: StateFlow<SetupState> = setupState

    val starts = AtomicInteger()
    val stops = AtomicInteger()
    val cancels = AtomicInteger()
    val jobs = CopyOnWriteArrayList<SetupJob>()

    override fun runSetup(context: Context, job: SetupJob): Boolean {
        synchronized(lock) {
            if (setupState.value is SetupState.Running) return false
            jobs += job
            setupState.value = SetupState.Running(job, emptyList())
            val builder = ProcessBuilder(listOf("/system/bin/sh", job.script.path) + job.args)
                .directory(job.workingDir)
                .redirectErrorStream(true)
            builder.environment().putAll(environment)
            val started = try {
                builder.start()
            } catch (failure: IOException) {
                setupState.value = SetupState.Finished(job, -1, listOf(failure.toString()))
                return true
            }
            process = started
            Thread({ pump(job, started) }, "p59-setup-job").apply {
                isDaemon = true
                start()
            }
        }
        return true
    }

    private fun pump(job: SetupJob, running: Process) {
        val lines = mutableListOf<String>()
        try {
            running.inputStream.bufferedReader().useLines { sequence ->
                for (line in sequence) {
                    lines += line
                    setupState.value = SetupState.Running(job, lines.takeLast(TAIL))
                }
            }
        } catch (_: IOException) {
            // The process was stopped while its output was read; the exit code below says how it ended.
        }
        val code = running.waitFor()
        synchronized(lock) {
            process = null
            setupState.value = SetupState.Finished(job, code, lines.takeLast(TAIL))
        }
    }

    override fun cancelSetup() {
        cancels.incrementAndGet()
        process?.destroy()
    }

    override fun start(context: Context) {
        starts.incrementAndGet()
        serverState.value = ServerState.Starting(attempt = 1)
    }

    override fun stop(timeoutMillis: Long): Boolean {
        stops.incrementAndGet()
        serverState.value = ServerState.Stopped(userStopped = true)
        return true
    }

    override fun restart(context: Context) = Unit

    override fun recentLogLines(): List<String> = emptyList()

    override fun logFiles(): List<File> = emptyList()

    /** Waits until no job runs, so a test never leaves its script behind. */
    fun awaitIdle(timeoutMillis: Long = 30_000) {
        val deadline = SystemClock.uptimeMillis() + timeoutMillis
        while (setupState.value is SetupState.Running && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(50)
        process?.destroyForcibly()
    }

    private companion object {
        const val TAIL = 200
    }
}

/**
 * The stand-in for `install.sh`: records its arguments, then lays out a minimal Git checkout at `--dir` and copies
 * `config.yaml` and `data/` from `--migrate-from`, as the real migration does. It waits while the gate file is
 * missing, and exits with the code in the exit file. A `--ref` named in the missing-ref file fails at once with
 * exit 128 and leaves nothing behind, as the real script's clone of a branch deleted upstream does. Its first
 * output line numbers the run, so a test can tell one run's output on screen from the previous one's.
 */
const val FAKE_INSTALL_SCRIPT = """
printf '%s\n' "${'$'}@" > "${'$'}P59_ARGS_FILE"
runs=${'$'}(( ${'$'}(cat "${'$'}P59_RUNS_FILE" 2>/dev/null || echo 0) + 1 ))
echo "${'$'}runs" > "${'$'}P59_RUNS_FILE"
echo "install.sh run ${'$'}runs"
dir=
from=
ref=
while [ ${'$'}# -gt 0 ]; do
    case "${'$'}1" in
        --dir) dir=${'$'}2; shift 2 ;;
        --migrate-from) from=${'$'}2; shift 2 ;;
        --ref) ref=${'$'}2; shift 2 ;;
        *) shift ;;
    esac
done
if [ -f "${'$'}P59_MISSING_REF_FILE" ] && [ "${'$'}(cat "${'$'}P59_MISSING_REF_FILE")" = "${'$'}ref" ]; then
    echo "fatal: Remote branch ${'$'}ref not found in upstream origin"
    exit 128
fi
echo "Cloning into '${'$'}dir'..."
mkdir -p "${'$'}dir/.git" || exit 3
echo 'ref: refs/heads/release' > "${'$'}dir/.git/HEAD"
echo '{ "name": "sillybunny" }' > "${'$'}dir/package.json"
waited=0
while [ ! -f "${'$'}P59_GATE_FILE" ] && [ ${'$'}waited -lt 1200 ]; do
    sleep 0.1
    waited=${'$'}((waited + 1))
done
echo "Copying your data from ${'$'}from."
if [ -f "${'$'}from/config.yaml" ]; then cp "${'$'}from/config.yaml" "${'$'}dir/config.yaml" || exit 4; fi
if [ -d "${'$'}from/data" ]; then cp -R "${'$'}from/data" "${'$'}dir/data" || exit 5; fi
code=${'$'}(cat "${'$'}P59_EXIT_FILE" 2>/dev/null)
echo "exit ${'$'}{code:-0}"
exit "${'$'}{code:-0}"
"""

/**
 * The bound for steps that cross system_server: ending maintenance revokes grants and notifies, and finishing or
 * bringing back an activity goes through the activity manager. A loaded emulator can stall those for tens of
 * seconds; the bound only matters when a step never finishes.
 */
const val SLOW_STEP_MILLIS = 60_000L

/** Lays out checkouts on the device the way install.sh and Git leave them. */
object DeviceCheckouts {
    const val CHAT = "data/default-user/chats/chat.jsonl"

    /** A SillyBunny Git install with user data; [tracking] makes its branch track `origin/<tracking>`. */
    fun create(dir: File, tracking: String? = null): File {
        check(File(dir, "data/default-user/chats").mkdirs())
        check(File(dir, "scripts").mkdirs())
        check(File(dir, ".git").mkdirs())
        File(dir, "package.json").writeText("{\n  \"name\": \"sillybunny\",\n  \"version\": \"1.0.0\"\n}\n")
        File(dir, "config.yaml").writeText("dataRoot: ./data\n")
        File(dir, CHAT).writeText("user data")
        File(dir, "scripts/self-update.sh").writeText("#!/usr/bin/env bash\n")
        File(dir, ".git/HEAD").writeText("ref: refs/heads/local-work\n")
        if (tracking != null) {
            File(dir, ".git/config").writeText(
                "[remote \"origin\"]\n" +
                    "\turl = https://example.test/repo.git\n" +
                    "\tfetch = +refs/heads/*:refs/remotes/origin/*\n" +
                    "[branch \"local-work\"]\n" +
                    "\tremote = origin\n" +
                    "\tmerge = refs/heads/$tracking\n",
            )
        }
        return dir
    }
}

/**
 * Deletes a test fixture without following links, making its directories accessible first (tests lock some of
 * them). Used only on folders the test created.
 */
fun deleteTree(path: Path) {
    if (!Files.exists(path, LinkOption.NOFOLLOW_LINKS)) return
    if (Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS)) {
        Os.chmod(path.toString(), "700".toInt(8))
        Files.newDirectoryStream(path).use { entries -> entries.toList() }.forEach(::deleteTree)
    }
    Files.delete(path)
}

/**
 * Hosts [content] in the debug `ComponentActivity` from `ui-test-manifest`, the way task 5.5's activity will, and
 * tracks whether it is started, which is the visibility Repair checks before `runSetup` and before starting the
 * server. Every new activity instance gets the content again.
 */
class ScreenHost(private val content: @Composable () -> Unit) : Application.ActivityLifecycleCallbacks, AutoCloseable {
    private val app = ApplicationProvider.getApplicationContext<Application>()
    private val started = AtomicInteger()

    lateinit var scenario: ActivityScenario<ComponentActivity>
        private set

    val visible: Boolean get() = started.get() > 0

    fun launch(): ScreenHost {
        app.registerActivityLifecycleCallbacks(this)
        scenario = ActivityScenario.launch(ComponentActivity::class.java)
        return this
    }

    /**
     * Brings the stopped activity's task back to the front, as the launcher or recents would. A real Home press
     * leaves nothing for `ActivityScenario.moveToState(RESUMED)` to finish, and Android 10 refuses app switches for
     * about 5 s after Home, so the move is retried until it lands.
     */
    fun bringToFront(timeoutMillis: Long = SLOW_STEP_MILLIS) {
        var taskId = -1
        scenario.onActivity { taskId = it.taskId }
        val manager = app.getSystemService(ActivityManager::class.java)
        val deadline = SystemClock.uptimeMillis() + timeoutMillis
        while (!visible) {
            check(SystemClock.uptimeMillis() < deadline) { "Task $taskId did not come back to the front" }
            checkNotNull(manager.appTasks.firstOrNull { it.taskInfo?.taskId == taskId }) { "No app task $taskId" }.moveToFront()
            val retryAt = SystemClock.uptimeMillis() + 1_000
            while (!visible && SystemClock.uptimeMillis() < retryAt) SystemClock.sleep(50)
        }
    }

    override fun onActivityPostCreated(activity: Activity, savedInstanceState: Bundle?) {
        if (activity.javaClass != ComponentActivity::class.java) return
        (activity as ComponentActivity).setContent { content() }
    }

    override fun onActivityStarted(activity: Activity) {
        if (activity.javaClass == ComponentActivity::class.java) started.incrementAndGet()
    }

    override fun onActivityStopped(activity: Activity) {
        if (activity.javaClass == ComponentActivity::class.java) started.decrementAndGet()
    }

    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit

    override fun onActivityResumed(activity: Activity) = Unit

    override fun onActivityPaused(activity: Activity) = Unit

    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit

    override fun onActivityDestroyed(activity: Activity) = Unit

    override fun close() {
        try {
            scenario.close()
        } finally {
            app.unregisterActivityLifecycleCallbacks(this)
        }
    }
}

/**
 * The Repair and leftover-folder controls, found by test tag: debug builds expose the tags as resource ids. The
 * Compose test rule is not used, because the Espresso 3.5.0 it brings fails on API 37 (`InputManager.getInstance`).
 * UiAutomator only sees controls on screen, so lookups scroll the screen's scrollable container both ways.
 */
object RepairUi {
    val device: UiDevice get() = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())

    fun findOrNull(tag: String, timeoutMillis: Long = 10_000): UiObject2? {
        val deadline = SystemClock.uptimeMillis() + timeoutMillis
        var direction = Direction.DOWN
        while (true) {
            device.wait(Until.findObject(By.res(tag)), POLL_MILLIS)?.let { return it }
            if (SystemClock.uptimeMillis() >= deadline) return null
            // The screen's own column, never the output box nested in it.
            val container = scrollables().maxByOrNull { it.second }?.first ?: continue
            val before = onScreen()
            try {
                container.scroll(direction, 0.8f)
            } catch (_: StaleObjectException) {
                continue
            }
            device.waitForIdle()
            // UiAutomator's can-scroll-further answer misses Compose scrolling, so the end of the container is
            // where a scroll no longer changes what is on screen.
            if (onScreen() == before) direction = if (direction == Direction.DOWN) Direction.UP else Direction.DOWN
        }
    }

    private fun scrollables(): List<Pair<UiObject2, Int>> = try {
        device.findObjects(By.scrollable(true)).map { it to it.visibleBounds.height() * it.visibleBounds.width() }
    } catch (_: StaleObjectException) {
        emptyList()
    }

    private fun onScreen(): List<String> = try {
        device.findObjects(By.res(taggedControl)).map { "${it.resourceName}@${it.visibleBounds}" }
    } catch (_: StaleObjectException) {
        emptyList()
    }

    fun find(tag: String, timeoutMillis: Long = 10_000): UiObject2 =
        checkNotNull(findOrNull(tag, timeoutMillis)) { "$tag is not on screen" }

    fun shown(tag: String, timeoutMillis: Long = 10_000): Boolean = findOrNull(tag, timeoutMillis) != null

    fun gone(tag: String, timeoutMillis: Long = 10_000): Boolean = device.wait(Until.gone(By.res(tag)), timeoutMillis) == true

    /** On screen right now, without scrolling. Pair an absence check with a state assertion. */
    fun present(tag: String): Boolean = device.hasObject(By.res(tag))

    /** The control tagged [tag] is on screen right now and shows [text] in itself or a descendant. */
    fun showsText(tag: String, text: String): Boolean =
        device.hasObject(By.res(tag).hasDescendant(By.textContains(text))) || device.hasObject(By.res(tag).textContains(text))

    fun click(tag: String) {
        var attempt = 1
        while (true) {
            try {
                find(tag).click()
                break
            } catch (stale: StaleObjectException) {
                // The screen recomposed between finding the control and clicking it. UiAutomator throws this before
                // sending any touch, so finding the control again cannot click twice.
                if (attempt++ >= STALE_RETRIES) throw stale
            }
        }
        device.waitForIdle()
    }

    fun eventually(timeoutMillis: Long = 10_000, message: String = "condition", condition: () -> Boolean) {
        val deadline = SystemClock.uptimeMillis() + timeoutMillis
        while (!condition()) {
            check(SystemClock.uptimeMillis() < deadline) { "Timed out waiting for $message" }
            SystemClock.sleep(50)
        }
    }

    private const val POLL_MILLIS = 1_000L
    private const val STALE_RETRIES = 5
    private val taggedControl: Pattern = Pattern.compile("(repair|leftover)_.+")
}
