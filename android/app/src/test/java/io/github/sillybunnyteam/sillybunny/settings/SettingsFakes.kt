package io.github.sillybunnyteam.sillybunny.settings

import android.content.Context
import android.content.Intent
import android.os.Looper
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.FileProvider
import io.github.sillybunnyteam.sillybunny.server.LaunchSession
import io.github.sillybunnyteam.sillybunny.server.ServerHost
import io.github.sillybunnyteam.sillybunny.server.ServerState
import io.github.sillybunnyteam.sillybunny.server.SetupJob
import io.github.sillybunnyteam.sillybunny.server.SetupState
import io.github.sillybunnyteam.sillybunny.update.UpdateUiState
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import java.io.File
import java.lang.reflect.Modifier
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

val runningState = ServerState.Running(LaunchSession(port = 49_152, token = "0".repeat(64)), originChanged = false)

open class FakeServerHost(
    initial: ServerState = ServerState.Stopped(userStopped = false),
    @Volatile var lines: List<String> = emptyList(),
    @Volatile var logs: List<File> = emptyList(),
) : ServerHost {
    private val serverState = MutableStateFlow(initial)
    private val setupState = MutableStateFlow<SetupState>(SetupState.Idle)
    override val state: StateFlow<ServerState> = serverState
    override val setup: StateFlow<SetupState> = setupState

    val starts = AtomicInteger()
    val restarts = AtomicInteger()
    val stops = AtomicInteger()
    val lineReads = AtomicInteger()

    @Volatile var startContext: Context? = null

    @Volatile var stopThread: Thread? = null

    @Volatile var stopOnMainThread: Boolean? = null

    /** When set, stop() waits for it, so tests can observe the in-progress state. */
    @Volatile var stopGate: CountDownLatch? = null

    fun emit(state: ServerState) {
        serverState.value = state
    }

    fun emitSetup(state: SetupState) {
        setupState.value = state
    }

    override fun runSetup(context: Context, job: SetupJob): Boolean = false

    override fun cancelSetup() = Unit

    override fun start(context: Context) {
        starts.incrementAndGet()
        startContext = context
        serverState.value = ServerState.Starting(attempt = 1)
    }

    override fun stop(timeoutMillis: Long): Boolean {
        stopThread = Thread.currentThread()
        stopOnMainThread = Looper.getMainLooper().isCurrentThread
        stops.incrementAndGet()
        serverState.value = ServerState.Stopping
        stopGate?.await(10, TimeUnit.SECONDS)
        serverState.value = ServerState.Stopped(userStopped = true)
        return true
    }

    override fun restart(context: Context) {
        restarts.incrementAndGet()
        serverState.value = ServerState.Starting(attempt = 1)
    }

    override fun recentLogLines(): List<String> {
        lineReads.incrementAndGet()
        return lines
    }

    override fun logFiles(): List<File> = logs
}

class FakeUpdateControls(initial: UpdateUiState = UpdateUiState()) : UpdateControls {
    override var state by mutableStateOf(initial)
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

class FakeBattery(
    @Volatile var exempt: Boolean = false,
    @Volatile var intents: List<Intent> = listOf(Intent(ACTION)),
) : BatteryOptimizations {
    val reads = AtomicInteger()

    override fun isExempt(): Boolean {
        reads.incrementAndGet()
        return exempt
    }

    override fun shortcutIntents(exempt: Boolean): List<Intent> = intents

    companion object {
        const val ACTION = "io.github.sillybunnyteam.sillybunny.test.BATTERY"
        const val FALLBACK_ACTION = "io.github.sillybunnyteam.sillybunny.test.BATTERY_LIST"
    }
}

class FakeLeftovers(@Volatile var count: Int = 0) : LeftoverFolderCounter {
    val reads = AtomicInteger()

    override fun count(): Int {
        reads.incrementAndGet()
        return count
    }
}

fun fakeDependencies(
    context: Context,
    host: ServerHost = FakeServerHost(),
    updates: UpdateControls = FakeUpdateControls(),
    battery: BatteryOptimizations = FakeBattery(),
    leftovers: LeftoverFolderCounter = FakeLeftovers(),
    notices: NoticesSource = NoticesSource { null },
    versions: RuntimeVersionsSource = RuntimeVersionsSource { emptyList() },
    ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
) = SettingsDependencies(
    serverHost = host,
    appSettings = AppSettings(context),
    updates = updates,
    battery = battery,
    leftoverFolders = leftovers,
    notices = notices,
    runtimeVersions = versions,
    ioDispatcher = ioDispatcher,
)

/**
 * FileProvider caches its roots per authority in a static map for the life of the process, while Robolectric
 * gives every test a new data directory; without this a later test's snapshot would be outside the cached root.
 */
fun resetFileProviderRoots() {
    FileProvider::class.java.declaredFields
        .filter { Modifier.isStatic(it.modifiers) && MutableMap::class.java.isAssignableFrom(it.type) }
        .forEach { field ->
            field.isAccessible = true
            val roots = field.get(null) as MutableMap<*, *>
            synchronized(roots) { roots.clear() }
        }
}
