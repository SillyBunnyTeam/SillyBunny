package io.github.sillybunnyteam.sillybunny.firstrun

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import io.github.sillybunnyteam.sillybunny.checkout.BrokenCheckouts
import io.github.sillybunnyteam.sillybunny.runtime.RuntimePaths
import io.github.sillybunnyteam.sillybunny.server.ServerHost
import io.github.sillybunnyteam.sillybunny.server.ServerState
import io.github.sillybunnyteam.sillybunny.server.SetupJob
import io.github.sillybunnyteam.sillybunny.server.SetupState
import io.github.sillybunnyteam.sillybunny.settings.AndroidLocalNetworkAccess
import io.github.sillybunnyteam.sillybunny.settings.LocalNetworkAccess
import java.io.File
import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.flow.MutableStateFlow

/** A `ServerHost` whose setup state the test drives directly. */
internal class FakeServerHost : ServerHost {
    override val state = MutableStateFlow<ServerState>(ServerState.Stopped(userStopped = false))
    override val setup = MutableStateFlow<SetupState>(SetupState.Idle)

    val jobs = mutableListOf<SetupJob>()
    var accept = true
    var failure: RuntimeException? = null

    /** When false, `runSetup` returns true without publishing `Running`, as an asynchronous host might. */
    var publishRunning = true
    var cancelCount = 0
    var onRunSetup: (SetupJob) -> Unit = {}

    override fun runSetup(context: Context, job: SetupJob): Boolean {
        failure?.let { throw it }
        onRunSetup(job)
        if (!accept) return false
        jobs += job
        if (publishRunning) setup.value = SetupState.Running(job, emptyList())
        return true
    }

    override fun cancelSetup() {
        cancelCount++
    }

    override fun start(context: Context) = Unit

    override fun stop(timeoutMillis: Long): Boolean = true

    override fun restart(context: Context) = Unit

    override fun recentLogLines(): List<String> = emptyList()

    override fun logFiles(): List<File> = emptyList()
}

internal class FakeNotificationPermission(
    override var required: Boolean = true,
    var granted: Boolean = false,
) : NotificationPermission {
    override fun isGranted(): Boolean = !required || granted
}

/** Real temporary directories plus fakes for every probe. */
internal class FirstRunFixture(root: File) {
    val filesDir = File(root, "files").apply { mkdirs() }
    val paths = RuntimePaths(filesDir, File(root, "cache").apply { mkdirs() }, File(root, "native").apply { mkdirs() })
    val script = File(filesDir, "runtime/install.sh")
    val host = FakeServerHost()
    val notifications = FakeNotificationPermission()
    var exempt = false
    var availableBytes = FirstRunStorage.REQUIRED_FREE_BYTES * 2
    var network = NetworkKind.UNMETERED
    var layout: () -> RuntimeLayoutOutcome = { RuntimeLayoutOutcome.Ready }
    var setupLog = listOf("setup one", "setup two")
    var layoutCalls = 0
    var storageCalls = 0
    var networkCalls = 0

    /** Runs on the IO dispatcher each time the controller reads `checkoutDir`, before it is read. */
    var onInspect: () -> Unit = {}
    val clock: Clock = Clock.fixed(Instant.parse("2026-10-21T12:00:00Z"), ZoneOffset.UTC)

    /** [localNetwork] null keeps the real adapter, which has no permission to offer below API 37. */
    fun dependencies(
        io: CoroutineDispatcher,
        context: Context = ApplicationProvider.getApplicationContext(),
        localNetwork: LocalNetworkAccess? = null,
    ): FirstRunDependencies = FirstRunDependencies(
        context = context,
        paths = paths,
        serverHost = host,
        installScript = script,
        layout = {
            layoutCalls++
            layout()
        },
        defaultRef = REF,
        notifications = notifications,
        battery = { exempt },
        localNetwork = localNetwork ?: AndroidLocalNetworkAccess(context),
        storage = {
            storageCalls++
            availableBytes
        },
        network = {
            networkCalls++
            network
        },
        checkout = {
            onInspect()
            FileCheckoutInspector(paths.checkoutDir).status()
        },
        setupLog = { setupLog },
        clock = clock,
        ioDispatcher = io,
    )

    fun installJob(): SetupJob = FirstRunInstall.job(script, paths, REF)

    /** p59's Repair job: the first-run arguments plus `--migrate-from <moved folder> --allow-git-source`. */
    fun repairJob(): SetupJob = SetupJob(
        script,
        FirstRunInstall.args(paths, REF) +
            listOf("--migrate-from", File(filesDir, "SillyBunny.broken-20261020T000000Z").path, "--allow-git-source"),
        filesDir,
    )

    /** A clone that stopped half-way: git metadata and some files, but no `package.json`. */
    fun writePartialCheckout(): Map<String, String> {
        write(".git/HEAD", "ref: refs/heads/staging\n")
        write(".git/objects/pack/pack-1.pack", "partial pack")
        write("src/server.js", "partial source")
        return tree(paths.checkoutDir)
    }

    /**
     * A clone killed during its checkout, as `git clone` leaves it: `.git/HEAD`, the index still in
     * `.git/index.lock`, and the files that sort up to `package.json`, but no `start.sh` and no `.git/index`.
     */
    fun writeKilledClone(): Map<String, String> {
        write(".git/HEAD", "ref: refs/heads/staging\n")
        write(".git/index.lock", "")
        write(".gitignore", "x\n")
        write("package.json", "{\"name\":\"sillybunny\"}\n")
        return tree(paths.checkoutDir)
    }

    /** A finished clone: git commits `.git/index` only after the whole tree is written. */
    fun writeInstalledCheckout(): Map<String, String> {
        write(".git/HEAD", "ref: refs/heads/staging\n")
        write(".git/index", "DIRC")
        write("package.json", "{\"name\":\"sillybunny\"}\n")
        write("start.sh", "#!/bin/sh\n")
        return tree(paths.checkoutDir)
    }

    /** Repair's install.sh part-way through: cloning into `checkoutDir` and copying the user's data there. */
    fun writeRepairInProgress(): Map<String, String> {
        write(".git/HEAD", "ref: refs/heads/staging\n")
        write("data/default-user/chats/a.jsonl", "user chat")
        return tree(paths.checkoutDir)
    }

    fun brokenCheckouts(): List<File> = BrokenCheckouts.list(paths)

    private fun write(relative: String, text: String) {
        val file = File(paths.checkoutDir, relative)
        file.parentFile!!.mkdirs()
        file.writeText(text)
    }

    companion object {
        const val REF = "staging"

        /** Every regular file under [dir], relative path to content. */
        fun tree(dir: File): Map<String, String> =
            dir.walkTopDown().filter { it.isFile }.associate { it.relativeTo(dir).path to it.readText() }
    }
}
