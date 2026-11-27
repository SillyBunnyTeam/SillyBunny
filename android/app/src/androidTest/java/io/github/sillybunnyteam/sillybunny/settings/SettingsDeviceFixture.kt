package io.github.sillybunnyteam.sillybunny.settings

import android.app.Activity
import android.app.Application
import android.content.Context
import android.os.Bundle
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Direction
import androidx.test.uiautomator.StaleObjectException
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import io.github.sillybunnyteam.sillybunny.server.LaunchSession
import io.github.sillybunnyteam.sillybunny.server.ServerHost
import io.github.sillybunnyteam.sillybunny.server.ServerState
import io.github.sillybunnyteam.sillybunny.server.SetupJob
import io.github.sillybunnyteam.sillybunny.server.SetupState
import io.github.sillybunnyteam.sillybunny.update.UpdateUiState
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.regex.Pattern

val deviceRunningState = ServerState.Running(LaunchSession(port = 49_152, token = "0".repeat(64)), originChanged = false)

/** A [ServerHost] that only records calls, so device tests never start a real server. */
class DeviceFakeServerHost(
    initial: ServerState = ServerState.Stopped(userStopped = false),
    @Volatile var logs: List<File> = emptyList(),
    private val stopGate: CountDownLatch? = null,
) : ServerHost {
    private val serverState = MutableStateFlow(initial)
    override val state: StateFlow<ServerState> = serverState
    override val setup: StateFlow<SetupState> = MutableStateFlow(SetupState.Idle)

    val starts = AtomicInteger()
    val stops = AtomicInteger()

    @Volatile var startContext: Context? = null

    @Volatile var stopOnMainThread: Boolean? = null

    override fun runSetup(context: Context, job: SetupJob): Boolean = false

    override fun cancelSetup() = Unit

    override fun start(context: Context) {
        starts.incrementAndGet()
        startContext = context
        serverState.value = ServerState.Starting(attempt = 1)
    }

    override fun stop(timeoutMillis: Long): Boolean {
        stopOnMainThread = Looper.getMainLooper().isCurrentThread
        stops.incrementAndGet()
        serverState.value = ServerState.Stopping
        stopGate?.await(20, TimeUnit.SECONDS)
        serverState.value = ServerState.Stopped(userStopped = true)
        return true
    }

    override fun restart(context: Context) {
        serverState.value = ServerState.Starting(attempt = 1)
    }

    override fun recentLogLines(): List<String> = listOf("device log line")

    override fun logFiles(): List<File> = logs
}

/** Update controls that never reach the network. */
class DeviceUpdateControls : UpdateControls {
    override var state by mutableStateOf(UpdateUiState())
    var checks = 0

    override var enabled: Boolean
        get() = state.enabled
        set(value) {
            state = state.copy(enabled = value)
        }

    override fun checkNow() {
        checks++
    }
}

/**
 * Hosts [SettingsScreen] in the debug `ComponentActivity` from `ui-test-manifest`, inside a MaterialTheme, the way
 * task 5.5's activity will. Every new activity instance gets the content again, so a recreation keeps working.
 */
internal class SettingsScreenHost(
    private val dependencies: (ComponentActivity) -> SettingsDependencies,
    private val callbacks: SettingsCallbacks = SettingsCallbacks(),
) : Application.ActivityLifecycleCallbacks,
    AutoCloseable {
    val ups = AtomicInteger()
    private val app = ApplicationProvider.getApplicationContext<Application>()

    lateinit var scenario: ActivityScenario<ComponentActivity>
        private set

    fun launch(): SettingsScreenHost {
        app.registerActivityLifecycleCallbacks(this)
        scenario = ActivityScenario.launch(ComponentActivity::class.java)
        return this
    }

    override fun onActivityPostCreated(activity: Activity, savedInstanceState: Bundle?) {
        // Only the test host activity, never another activity that happens to start meanwhile.
        if (activity.javaClass != ComponentActivity::class.java) return
        val host = activity as ComponentActivity
        val screenDependencies = dependencies(host)
        host.setContent {
            MaterialTheme {
                SettingsScreen(screenDependencies, callbacks, onNavigateUp = { ups.incrementAndGet() })
            }
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
}

/**
 * The Settings controls, found by test tag: debug builds expose the tags as resource ids. The Compose test rule is
 * not used, because the Espresso 3.5.0 it brings fails on API 37 (`InputManager.getInstance`). UiAutomator only sees
 * controls on screen, so lookups scroll the screen's scrollable container down to its end and then back up.
 */
internal object SettingsUi {
    val device: UiDevice get() = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())

    fun findOrNull(tag: String, timeoutMillis: Long = 10_000): UiObject2? {
        val deadline = SystemClock.uptimeMillis() + timeoutMillis
        var direction = Direction.DOWN
        while (true) {
            device.wait(Until.findObject(By.res(tag)), POLL_MILLIS)?.let { return it }
            if (SystemClock.uptimeMillis() >= deadline) return null
            val container = device.findObject(By.scrollable(true)) ?: continue
            val before = onScreen()
            container.scroll(direction, 0.8f)
            device.waitForIdle()
            // UiAutomator's own can-scroll-further answer misses Compose's scroll events (it says no after every
            // scroll), so the end of the container is where a scroll no longer changes what is on screen.
            if (onScreen() == before) direction = if (direction == Direction.DOWN) Direction.UP else Direction.DOWN
        }
    }

    /** The tagged controls on screen and where they are, to tell whether a scroll moved anything. */
    private fun onScreen(): List<String> = try {
        device.findObjects(By.res(taggedControl)).map { "${it.resourceName}@${it.visibleBounds}" }
    } catch (_: StaleObjectException) {
        emptyList()
    }

    fun find(tag: String, timeoutMillis: Long = 10_000): UiObject2 =
        checkNotNull(findOrNull(tag, timeoutMillis)) { "$tag is not on screen" }

    fun shown(tag: String, timeoutMillis: Long = 10_000): Boolean = findOrNull(tag, timeoutMillis) != null

    fun gone(tag: String, timeoutMillis: Long = 10_000): Boolean =
        device.wait(Until.gone(By.res(tag)), timeoutMillis) == true

    /** On screen right now, without scrolling. Pair an absence check with a state assertion. */
    fun present(tag: String): Boolean = device.hasObject(By.res(tag))

    fun click(tag: String) = find(tag).click()

    /** Waits until [condition] holds, polling every 50 ms. */
    fun eventually(timeoutMillis: Long = 10_000, message: String = "condition", condition: () -> Boolean) {
        val deadline = SystemClock.uptimeMillis() + timeoutMillis
        while (!condition()) {
            check(SystemClock.uptimeMillis() < deadline) { "Timed out waiting for $message" }
            SystemClock.sleep(50)
        }
    }

    /** Runs [command] as the shell user and returns its standard output. */
    fun shell(command: String): String =
        ParcelFileDescriptor.AutoCloseInputStream(
            InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand(command),
        ).use { it.readBytes().toString(Charsets.UTF_8) }

    private const val POLL_MILLIS = 1_000L
    private val taggedControl: Pattern = Pattern.compile("settings_.+")
}
