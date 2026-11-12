package io.github.sillybunnyteam.sillybunny.server

import java.util.concurrent.TimeUnit

/** What a stop can signal: the server's process group and, inside it, the supervisor. */
internal interface StopTarget {
    /** Sends [signal] to the supervisor only; false when no live supervisor is known. */
    fun signalSupervisor(signal: Int): Boolean

    /** Sends [signal] to the whole process group; false when no verified member is left to signal. */
    fun signalGroup(signal: Int): Boolean

    /** True once every member of the group, and the app's own process handle, has exited. */
    fun isGone(): Boolean

    /**
     * True once nothing is left inside the process group itself, even if members that left it (for example
     * with a session of their own) still run. Targets without such members just report [isGone].
     */
    fun isGroupEmpty(): Boolean = isGone()
}

/** Linux signal numbers; the same on every Android ABI. */
internal object Signals {
    const val SIGKILL = 9
    const val SIGTERM = 15
}

internal enum class StopStep {
    ALREADY_GONE,

    /** The supervisor's graceful IPC shutdown path ended the whole group (plan §2.3). */
    SUPERVISOR_TERM,
    GROUP_TERM,
    GROUP_KILL,

    /** Something survived SIGKILL's grace period; the caller reports the stop as failed. */
    NOT_GONE,
}

/** Measured phase durations of one stop, in milliseconds. */
internal data class StopTimings(
    val stoppedBy: StopStep,
    val supervisorSignalled: Boolean,
    val supervisorPhaseMillis: Long,
    val groupTermPhaseMillis: Long,
    val killPhaseMillis: Long,
    val totalMillis: Long,
) {
    val gone: Boolean get() = stoppedBy != StopStep.NOT_GONE
}

/**
 * Grace periods for each step. The supervisor force-kills its child after 5 s
 * (`src/server-supervisor.js:31`), so its graceful path gets a little longer than that.
 */
internal data class StopConfig(
    val supervisorGraceMillis: Long = 6_000,
    val groupTermGraceMillis: Long = 3_000,
    val killGraceMillis: Long = 2_000,
    val pollMillis: Long = 20,
)

/**
 * Plan §4.4: SIGTERM to the supervisor, a bounded wait, SIGTERM to the process group, a bounded wait,
 * then SIGKILL to the group. Each step ends as soon as the whole group is gone. The supervisor's wait also
 * ends once the group itself is empty: members that left it get the group signals next, without waiting
 * out the supervisor's grace period.
 */
internal class StopEscalation(
    private val config: StopConfig = StopConfig(),
    private val nanoTime: () -> Long = System::nanoTime,
    private val sleep: (Long) -> Unit = Thread::sleep,
) {
    fun stop(target: StopTarget, supervisorFirst: Boolean = true): StopTimings {
        val started = nanoTime()
        if (target.isGone()) return StopTimings(StopStep.ALREADY_GONE, false, 0, 0, 0, millisSince(started))

        var supervisorSignalled = false
        var supervisorPhase = 0L
        if (supervisorFirst) {
            val phase = nanoTime()
            supervisorSignalled = target.signalSupervisor(Signals.SIGTERM)
            if (supervisorSignalled) {
                val groupEmpty = waitUntil(config.supervisorGraceMillis) { target.isGroupEmpty() }
                supervisorPhase = millisSince(phase)
                if (groupEmpty && target.isGone()) {
                    return StopTimings(StopStep.SUPERVISOR_TERM, true, supervisorPhase, 0, 0, millisSince(started))
                }
            }
        }

        val termPhase = nanoTime()
        target.signalGroup(Signals.SIGTERM)
        val termGone = waitGone(target, config.groupTermGraceMillis)
        val groupTermPhase = millisSince(termPhase)
        if (termGone) {
            return StopTimings(
                StopStep.GROUP_TERM,
                supervisorSignalled,
                supervisorPhase,
                groupTermPhase,
                0,
                millisSince(started),
            )
        }

        val killPhase = nanoTime()
        target.signalGroup(Signals.SIGKILL)
        val killGone = waitGone(target, config.killGraceMillis)
        return StopTimings(
            if (killGone) StopStep.GROUP_KILL else StopStep.NOT_GONE,
            supervisorSignalled,
            supervisorPhase,
            groupTermPhase,
            millisSince(killPhase),
            millisSince(started),
        )
    }

    private fun waitGone(target: StopTarget, graceMillis: Long): Boolean = waitUntil(graceMillis) { target.isGone() }

    private fun waitUntil(graceMillis: Long, done: () -> Boolean): Boolean {
        val deadline = nanoTime() + TimeUnit.MILLISECONDS.toNanos(graceMillis)
        while (true) {
            if (done()) return true
            if (nanoTime() - deadline >= 0) return false
            sleep(config.pollMillis)
        }
    }

    private fun millisSince(start: Long): Long = TimeUnit.NANOSECONDS.toMillis(nanoTime() - start)
}
