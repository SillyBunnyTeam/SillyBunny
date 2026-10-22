package io.github.sillybunnyteam.sillybunny.repair

import android.content.Context
import io.github.sillybunnyteam.sillybunny.server.ServerHost
import io.github.sillybunnyteam.sillybunny.server.ServerState
import io.github.sillybunnyteam.sillybunny.server.SetupJob
import io.github.sillybunnyteam.sillybunny.server.SetupState
import kotlinx.coroutines.flow.MutableStateFlow
import java.io.File

/** A `ServerHost` whose stop result and setup jobs the test drives; every call is appended to [events]. */
internal class FakeRepairServerHost(private val events: MutableList<String> = mutableListOf()) : ServerHost {
    override val state = MutableStateFlow<ServerState>(ServerState.Stopped(userStopped = false))
    override val setup = MutableStateFlow<SetupState>(SetupState.Idle)

    var stopResult = true
    var stopFailure: RuntimeException? = null
    val stopTimeouts = mutableListOf<Long>()
    var onStop: () -> Unit = {}

    var accept = true
    var runSetupFailure: RuntimeException? = null
    val jobs = mutableListOf<SetupJob>()

    /** Runs inside `runSetup` after `Running` is published, for example to finish the job at once. */
    var onRunSetup: (SetupJob) -> Unit = {}

    var cancelCount = 0
    var onCancel: () -> Unit = {}

    var startCount = 0
    var startFailure: RuntimeException? = null

    override fun runSetup(context: Context, job: SetupJob): Boolean {
        events += "runSetup"
        runSetupFailure?.let { throw it }
        if (!accept) return false
        jobs += job
        setup.value = SetupState.Running(job, emptyList())
        onRunSetup(job)
        return true
    }

    /** Appends output lines to the running job. */
    fun emit(vararg lines: String) {
        val running = setup.value as SetupState.Running
        setup.value = running.copy(lines = running.lines + lines)
    }

    /** Finishes the running job with [exitCode], keeping its lines. */
    fun finish(exitCode: Int, vararg lines: String) {
        val running = setup.value as SetupState.Running
        setup.value = SetupState.Finished(running.job, exitCode, running.lines + lines)
    }

    override fun cancelSetup() {
        events += "cancelSetup"
        cancelCount++
        onCancel()
    }

    override fun start(context: Context) {
        events += "start"
        startFailure?.let { throw it }
        startCount++
    }

    override fun stop(timeoutMillis: Long): Boolean {
        events += "stop"
        stopTimeouts += timeoutMillis
        onStop()
        stopFailure?.let { throw it }
        return stopResult
    }

    override fun restart(context: Context) = Unit

    override fun recentLogLines(): List<String> = emptyList()

    override fun logFiles(): List<File> = emptyList()
}

/** Records maintenance calls in [events]; [inMaintenance] is what a provider would currently enforce. */
internal class FakeMaintenance(private val events: MutableList<String> = mutableListOf()) : ProviderMaintenance {
    var begins = 0
    var ends = 0
    var notifies = 0
    var inMaintenance = false
    var beginFailure: RuntimeException? = null
    var endFailure: RuntimeException? = null
    var onBegin: () -> Unit = {}

    /** Runs as the provider reopens, before anything else can write through it. */
    var onEnd: () -> Unit = {}

    override fun beginMaintenance(context: Context) {
        events += "begin"
        begins++
        // A provider may persist its gate before failing, so a failed begin still needs an end.
        inMaintenance = true
        onBegin()
        beginFailure?.let { throw it }
    }

    override fun endMaintenance(context: Context) {
        events += "end"
        ends++
        onEnd()
        endFailure?.let { throw it }
        inMaintenance = false
    }

    override fun notifyRootsChanged(context: Context) {
        events += "notify"
        notifies++
    }
}

/** Builds checkouts on disk the way install.sh and Git leave them. */
internal object TestCheckouts {
    /** A SillyBunny checkout with user data; [tracking] adds a `.git` whose branch tracks `origin/<tracking>`. */
    fun create(
        dir: File,
        config: String? = null,
        packageName: String = "sillybunny",
        tracking: String? = null,
    ): File {
        dir.mkdirs()
        File(dir, "package.json").writeText("{\n  \"name\": \"$packageName\",\n  \"version\": \"1.0.0\"\n}\n")
        if (config != null) File(dir, "config.yaml").writeText(config)
        File(dir, "data/default-user/chats").mkdirs()
        File(dir, "data/default-user/chats/chat.jsonl").writeText("user data")
        if (tracking != null) track(dir, local = "local-work", upstream = tracking)
        return dir
    }

    fun track(dir: File, local: String, upstream: String) {
        File(dir, ".git").mkdirs()
        File(dir, ".git/HEAD").writeText("ref: refs/heads/$local\n")
        File(dir, ".git/config").writeText(
            """
            [remote "origin"]
                url = https://example.test/repo.git
                fetch = +refs/heads/*:refs/remotes/origin/*
            [branch "$local"]
                remote = origin
                merge = refs/heads/$upstream
            """.trimIndent(),
        )
    }

    /** What a successful reinstall leaves: a real Git checkout. */
    fun installed(dir: File): File {
        File(dir, ".git").mkdirs()
        File(dir, ".git/HEAD").writeText("ref: refs/heads/release\n")
        File(dir, "package.json").writeText("{ \"name\": \"sillybunny\" }\n")
        return dir
    }
}
