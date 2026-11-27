package io.github.sillybunnyteam.sillybunny.app

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.test.core.app.ApplicationProvider
import io.github.sillybunnyteam.sillybunny.firstrun.CheckoutStatus
import io.github.sillybunnyteam.sillybunny.firstrun.FakeNotificationPermission
import io.github.sillybunnyteam.sillybunny.firstrun.FileCheckoutInspector
import io.github.sillybunnyteam.sillybunny.firstrun.FirstRunDependencies
import io.github.sillybunnyteam.sillybunny.firstrun.FirstRunStorage
import io.github.sillybunnyteam.sillybunny.firstrun.NetworkKind
import io.github.sillybunnyteam.sillybunny.firstrun.RuntimeLayoutOutcome
import io.github.sillybunnyteam.sillybunny.repair.FakeMaintenance
import io.github.sillybunnyteam.sillybunny.repair.LeftoverFolders
import io.github.sillybunnyteam.sillybunny.repair.RepairController
import io.github.sillybunnyteam.sillybunny.repair.RepairStore
import io.github.sillybunnyteam.sillybunny.runtime.ApkFingerprint
import io.github.sillybunnyteam.sillybunny.runtime.InstalledRuntime
import io.github.sillybunnyteam.sillybunny.runtime.NpmSyncMode
import io.github.sillybunnyteam.sillybunny.runtime.RuntimeLayoutResult
import io.github.sillybunnyteam.sillybunny.runtime.RuntimePaths
import io.github.sillybunnyteam.sillybunny.server.LaunchSession
import io.github.sillybunnyteam.sillybunny.server.ServerHost
import io.github.sillybunnyteam.sillybunny.server.ServerState
import io.github.sillybunnyteam.sillybunny.server.SetupJob
import io.github.sillybunnyteam.sillybunny.server.SetupState
import io.github.sillybunnyteam.sillybunny.update.ServerController
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import java.io.File
import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset
import java.util.concurrent.atomic.AtomicBoolean

/** A `ServerHost` whose states the test publishes; it counts the calls the app makes. */
internal class FakeAppServerHost : ServerHost {
    override val state = MutableStateFlow<ServerState>(ServerState.Stopped(userStopped = false))
    override val setup = MutableStateFlow<SetupState>(SetupState.Idle)

    val events = mutableListOf<String>()
    val jobs = mutableListOf<SetupJob>()
    var logs = emptyList<File>()

    val starts: Int get() = events.count { it == "start" }
    val restarts: Int get() = events.count { it == "restart" }

    override fun runSetup(context: Context, job: SetupJob): Boolean {
        events += "runSetup"
        jobs += job
        setup.value = SetupState.Running(job, emptyList())
        return true
    }

    override fun cancelSetup() {
        events += "cancelSetup"
    }

    override fun start(context: Context) {
        events += "start"
    }

    override fun stop(timeoutMillis: Long): Boolean {
        events += "stop"
        return true
    }

    override fun restart(context: Context) {
        events += "restart"
    }

    override fun recentLogLines(): List<String> = emptyList()

    override fun logFiles(): List<File> = logs
}

internal class RecordingServerController : ServerController {
    var stops = 0
    var resumes = 0

    override fun stopForUpdate() {
        stops++
    }

    override fun resumeAfterAbandonedUpdate() {
        resumes++
    }
}

/**
 * Real temporary directories, a real Repair controller and first-run dependencies over [host], and fakes for
 * the runtime layout and the checkout. Every dispatcher is unconfined, so the launch runs inside the call that
 * starts it.
 */
internal class AppFixture(root: File, val context: Context = ApplicationProvider.getApplicationContext()) {
    val filesDir = File(root, "files").apply { mkdirs() }
    val paths = RuntimePaths(filesDir, File(root, "cache").apply { mkdirs() }, File(root, "native").apply { mkdirs() })
    val host = FakeAppServerHost()
    val controller = RecordingServerController()
    val repairStore = RepairStore(File(root, "repair-record.json"))
    val maintenance = FakeMaintenance()
    val repairStartDeferred = AtomicBoolean(false)
    var visible = true

    /** What the next layout call returns; [layoutCalls] counts the calls. */
    var layout: () -> RuntimeLayoutResult = { ready() }
    var layoutCalls = 0

    /** What the next checkout read returns; [checkoutReads] counts the reads. */
    var checkout: () -> CheckoutStatus = { FileCheckoutInspector(paths.checkoutDir).status() }
    var checkoutReads = 0

    var activityStarts = 0
    var activityStops = 0
    var rootsChanged = 0
    var webContent: @Composable (LaunchSession, Modifier) -> Unit = { _, _ -> }

    val repair = RepairController(
        context = context,
        paths = paths,
        serverHost = host,
        maintenance = maintenance,
        installScript = paths.installScript,
        isVisible = { visible },
        onServerStartDeferred = { repairStartDeferred.set(true) },
        store = repairStore,
        defaultRef = REF,
        dispatcher = Dispatchers.Unconfined,
    )
    val leftovers = LeftoverFolders(paths, repairStore, Dispatchers.Unconfined)

    val components: AppComponents by lazy {
        AppComponents(
            paths = paths,
            server = host,
            serverController = controller,
            onActivityStarted = { activityStarts++ },
            onActivityStopped = { activityStops++ },
            layout = {
                layoutCalls++
                layout()
            },
            checkout = {
                checkoutReads++
                checkout()
            },
            repair = repair,
            leftovers = leftovers,
            repairStartDeferred = repairStartDeferred,
            firstRunDependencies = ::firstRunDependencies,
            notifyRootsChanged = { rootsChanged++ },
            defaultRef = REF,
            io = Dispatchers.Unconfined,
            webContent = { session, modifier -> webContent(session, modifier) },
        )
    }

    fun ready(): RuntimeLayoutResult = RuntimeLayoutResult.Ready(
        paths = paths,
        installed = InstalledRuntime(
            fingerprint = ApkFingerprint(1, 1, paths.nativeLibraryDir.path, "0".repeat(64)),
            abi = "x86_64",
            versions = emptyMap(),
            gitCoreLinks = 0,
            npmFiles = 0,
            npmContentBytes = 0,
            npmDigest = "",
            npmSyncMode = NpmSyncMode.BATCHED,
        ),
        refreshReasons = emptySet(),
        elapsedMillis = 0,
    )

    fun firstRunDependencies(): FirstRunDependencies = FirstRunDependencies(
        context = context,
        paths = paths,
        serverHost = host,
        installScript = paths.installScript,
        layout = { RuntimeLayoutOutcome.Ready },
        defaultRef = REF,
        notifications = FakeNotificationPermission(required = false),
        battery = { true },
        storage = { FirstRunStorage.REQUIRED_FREE_BYTES * 2 },
        network = { NetworkKind.UNMETERED },
        checkout = { checkout() },
        setupLog = { emptyList() },
        clock = Clock.fixed(Instant.parse("2026-10-22T12:00:00Z"), ZoneOffset.UTC),
        ioDispatcher = Dispatchers.Unconfined,
    )

    /** A finished clone, as the first-run inspector counts it. */
    fun writeInstalledCheckout() {
        write(".git/HEAD", "ref: refs/heads/$REF\n")
        write(".git/index", "DIRC")
        write("package.json", "{\"name\":\"sillybunny\"}\n")
        write("start.sh", "#!/bin/sh\n")
    }

    private fun write(relative: String, text: String) {
        val file = File(paths.checkoutDir, relative)
        file.parentFile!!.mkdirs()
        file.writeText(text)
    }

    companion object {
        const val REF = "staging"
        val SESSION = LaunchSession(41_234, "ab".repeat(32))
        val OTHER_SESSION = LaunchSession(41_235, "cd".repeat(32))
    }
}
