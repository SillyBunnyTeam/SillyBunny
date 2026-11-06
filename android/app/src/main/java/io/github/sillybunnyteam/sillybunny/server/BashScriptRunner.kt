package io.github.sillybunnyteam.sillybunny.server

import android.os.CancellationSignal
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/** The interpreter argv and environment for one script run. */
internal class ScriptLaunch(val interpreter: List<String>, val environment: ProcessEnvironment)

/**
 * [ScriptRunner] for `bash --noprofile --norc <script> <args>` with the §2.5 environment and no launch
 * token, in its own session and process group through the same handshake as the server.
 *
 * Lines reach `onLine` on the thread that called [run]. A cancel sends SIGTERM to the whole group and
 * SIGKILL after [stopConfig]'s grace periods; members a script leaves behind are stopped the same way
 * once it exits. Throws [IOException] only when the process cannot be started; a signal already
 * cancelled before the start returns [CANCELLED_BEFORE_START] without starting anything.
 */
internal class BashScriptRunner(
    private val launcher: ProcessLauncher,
    private val stopConfig: StopConfig = CANCEL_STOP,
    private val prepare: () -> ScriptLaunch,
) : ScriptRunner {
    override fun run(
        script: File,
        args: List<String>,
        workingDir: File,
        onLine: (String) -> Unit,
        cancel: CancellationSignal,
    ): Int {
        if (cancel.isCanceled) return CANCELLED_BEFORE_START
        val launch = prepare()
        val spec = LaunchSpec(launch.interpreter + script.absolutePath + args, workingDir, launch.environment, null)
        val process = launcher.launch(spec)
        val lines = LinkedBlockingQueue<Any>()
        val reader = Thread({
            pumpLines(process.output, RedactingLineSplitter(null) { lines.put(it) })
            lines.put(END)
        }, "script-output").apply {
            isDaemon = true
            start()
        }
        val escalation = StopEscalation(stopConfig)
        var finished = false
        try {
            var signalled = false
            while (!process.waitForExit(POLL_MILLIS)) {
                drain(lines, onLine)
                if (cancel.isCanceled && !signalled) {
                    signalled = true
                    escalation.stop(process, supervisorFirst = false)
                }
            }
            // Background jobs the script started are still members of its group.
            if (!process.isGone()) escalation.stop(process, supervisorFirst = false)
            val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(OUTPUT_DRAIN_MILLIS)
            while (reader.isAlive || lines.isNotEmpty()) {
                val remaining = TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime())
                if (remaining <= 0) break
                val next = lines.poll(remaining.coerceAtMost(POLL_MILLIS), TimeUnit.MILLISECONDS) ?: continue
                if (next === END) break
                onLine(next as String)
            }
            drain(lines, onLine)
            finished = true
            return process.exitCode ?: UNKNOWN_STATUS
        } finally {
            if (!finished && !process.isGone()) escalation.stop(process, supervisorFirst = false)
            process.release()
        }
    }

    private fun drain(lines: LinkedBlockingQueue<Any>, onLine: (String) -> Unit) {
        while (true) {
            val next = lines.poll() ?: return
            if (next !== END) onLine(next as String)
        }
    }

    companion object {
        /** 128 + SIGTERM, the status a script stopped by a cancel normally reports. */
        const val CANCELLED_BEFORE_START = 143
        const val UNKNOWN_STATUS = -1

        /** No supervisor for scripts: SIGTERM the group, then SIGKILL after 5 s. */
        val CANCEL_STOP = StopConfig(supervisorGraceMillis = 0, groupTermGraceMillis = 5_000, killGraceMillis = 2_000)

        private const val POLL_MILLIS = 50L
        private const val OUTPUT_DRAIN_MILLIS = 2_000L
        private val END = Any()
    }
}

/**
 * Reads [input] to its end through [splitter]. It never throws, and it keeps reading after a line consumer
 * fails (dropping the rest), so a writer never blocks on a full pipe.
 */
internal fun pumpLines(input: InputStream, splitter: RedactingLineSplitter, afterChunk: () -> Unit = {}) {
    val buffer = ByteArray(8192)
    var delivering = true
    try {
        while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            if (!delivering) continue
            try {
                if (count > 0) splitter.feed(buffer, count)
                afterChunk()
            } catch (_: RuntimeException) {
                delivering = false
            }
        }
    } catch (_: IOException) {
        // The stream was closed after the group ended.
    }
    if (!delivering) return
    try {
        splitter.finish()
        afterChunk()
    } catch (_: RuntimeException) {
        // A failed consumer has nothing left to receive.
    }
}
