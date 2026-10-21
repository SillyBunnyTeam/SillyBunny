package io.github.sillybunnyteam.sillybunny.server

import android.content.Context
import android.os.CancellationSignal
import kotlinx.coroutines.flow.StateFlow
import java.io.File

/** What the first-run, WebView, Settings and Repair layers see of the server (plan §4.4). */
sealed interface ServerState {
    /** Not running. [userStopped] is true after an explicit Stop, so nothing restarts it on its own. */
    data class Stopped(val userStopped: Boolean) : ServerState

    /** Starting; [attempt] is 1 for an explicit start and higher for automatic restarts. */
    data class Starting(val attempt: Int) : ServerState

    /**
     * Healthy: [session]'s launch cookie gets 204 from the health endpoint. [originChanged] means the
     * port changed since the previous run, so the WebView's client-side storage starts empty.
     */
    data class Running(val session: LaunchSession, val originChanged: Boolean) : ServerState

    data object Stopping : ServerState

    /** Could not start, or gave up under the bounded restart policy. [lastLines] feeds the error screen. */
    data class Failed(val lastLines: List<String>, val canRestart: Boolean) : ServerState
}

/** A long Bash job that must survive backgrounding: the first-run install or Repair (plan §4.3, §4.7). */
class SetupJob(val script: File, val args: List<String>, val workingDir: File)

/** Progress of the one setup job the foreground service may run while the server is stopped. */
sealed interface SetupState {
    data object Idle : SetupState

    /** [lines] is a bounded tail of merged stdout/stderr for streamed progress. */
    data class Running(val job: SetupJob, val lines: List<String>) : SetupState

    data class Finished(val job: SetupJob, val exitCode: Int, val lines: List<String>) : SetupState
}

/** The single process-wide owner of the server process group (task 5.4). */
interface ServerHost {
    val state: StateFlow<ServerState>

    val setup: StateFlow<SetupState>

    /**
     * Runs [job] under the same foreground service as the server, so clone and npm work survives
     * backgrounding. The server must already be stopped. Call only from a visible activity or a user
     * action. Returns false, without starting anything, while the server or another job is running.
     */
    fun runSetup(context: Context, job: SetupJob): Boolean

    /** Stops the running setup job's whole process group; [setup] then reports it finished. */
    fun cancelSetup()

    /** Starts the foreground service. Call only from a visible activity or a user action. */
    fun start(context: Context)

    /**
     * Stops gracefully and blocks until the process group is gone or [timeoutMillis] passes.
     * Never call it on the main thread. Returns true once stopped.
     */
    fun stop(timeoutMillis: Long = 15_000): Boolean

    /** Explicit user restart, also from the Failed state. */
    fun restart(context: Context)

    /** Recent log lines for the in-app log view and error screens; they never contain the token. */
    fun recentLogLines(): List<String>

    /** The rotated log files, oldest first, for sharing. */
    fun logFiles(): List<File>
}

/** Runs one bundled-Bash script (`install.sh`, Repair) with the §2.5 environment in its own process group. */
interface ScriptRunner {
    /**
     * Runs `bash --noprofile --norc <script> <args>` in [workingDir], streaming merged stdout/stderr
     * lines to [onLine], and returns the exit code. Blocks, so never call it on the main thread.
     * Cancelling [cancel] stops the whole process group (SIGTERM, then SIGKILL after a grace period)
     * and then returns.
     */
    fun run(
        script: File,
        args: List<String>,
        workingDir: File,
        onLine: (String) -> Unit,
        cancel: CancellationSignal,
    ): Int
}
