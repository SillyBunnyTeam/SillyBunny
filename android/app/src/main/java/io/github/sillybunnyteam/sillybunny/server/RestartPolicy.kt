package io.github.sillybunnyteam.sillybunny.server

/** What the app last decided about the server; persisted so a sticky recreation decides correctly. */
internal enum class RunIntent {
    /** Explicitly started and not stopped since: a host death may be recovered within the restart budget. */
    RUN,

    /** Stopped by the user (or for an APK update): nothing restarts it on its own. */
    USER_STOPPED,

    /** Never started, or exited cleanly with status 0. */
    CLEAN_STOPPED,

    /** Gave up under the restart policy; only an explicit start or restart runs it again. */
    FAILED,
}

/** Plan §4.4: at most [maxRestarts] automatic restarts within [windowMillis], with doubling backoff. */
internal data class RestartConfig(
    val maxRestarts: Int = 3,
    val windowMillis: Long = 5 * 60_000L,
    val firstBackoffMillis: Long = 2_000L,
    val maxBackoffMillis: Long = 30_000L,
)

/** The persisted part of the policy: the intent and the policy-clock times of recent automatic restarts. */
internal data class PolicyState(val intent: RunIntent, val restartTimes: List<Long>) {
    companion object {
        val INITIAL = PolicyState(RunIntent.CLEAN_STOPPED, emptyList())
    }
}

/** How a server process ended. */
internal sealed interface ExitKind {
    /** The app asked it to stop. */
    data object Requested : ExitKind

    /** Exit status 0. */
    data object Clean : ExitKind

    /** Any other status, a signal, or an unknown status (for example the whole host died). */
    data class Unexpected(val code: Int?) : ExitKind
}

internal sealed interface PolicyDecision {
    data class Stop(val userStopped: Boolean) : PolicyDecision

    /** Start again after [delayMillis]; [attempt] counts from 1 for the explicit start. */
    data class Restart(val attempt: Int, val delayMillis: Long) : PolicyDecision

    data object GiveUp : PolicyDecision
}

/**
 * The bounded restart policy as a pure state machine (plan §4.4, R2 §2). [clock] must keep running
 * across process death, so production uses `SystemClock.elapsedRealtime`; times from before a reboot
 * (later than now) are dropped. Exit 75 never reaches this policy: `start.sh`'s own loop handles it.
 */
internal class RestartPolicy(
    val config: RestartConfig = RestartConfig(),
    private val clock: () -> Long,
) {
    /** A fresh explicit start or restart always runs and resets the budget. */
    fun explicitStart(): PolicyState = PolicyState(RunIntent.RUN, emptyList())

    fun userStop(): PolicyState = PolicyState(RunIntent.USER_STOPPED, emptyList())

    /** A deliberate give-up outside the exit path, for example a startup that never became healthy. */
    fun giveUp(state: PolicyState): PolicyState = state.copy(intent = RunIntent.FAILED)

    fun onExit(state: PolicyState, exit: ExitKind): Pair<PolicyState, PolicyDecision> = when (exit) {
        ExitKind.Requested -> userStop() to PolicyDecision.Stop(userStopped = true)
        ExitKind.Clean -> PolicyState(RunIntent.CLEAN_STOPPED, emptyList()) to PolicyDecision.Stop(userStopped = false)
        is ExitKind.Unexpected -> unexpected(state)
    }

    /**
     * A `START_STICKY` recreation with a null intent: the previous host process died. Only a server the
     * user still wants running is recovered, within the same budget. On API 30+ [lastExitUserRequested]
     * reports `REASON_USER_REQUESTED` (force stop, Task Manager Stop and similar), which is never
     * resurrected; it is ambiguous, so it only affects recreation and never an explicit start.
     */
    fun onRecreate(state: PolicyState, lastExitUserRequested: Boolean): Pair<PolicyState, PolicyDecision> =
        when (state.intent) {
            RunIntent.RUN ->
                if (lastExitUserRequested) userStop() to PolicyDecision.Stop(userStopped = true) else unexpected(state)
            RunIntent.USER_STOPPED -> state to PolicyDecision.Stop(userStopped = true)
            RunIntent.CLEAN_STOPPED -> state to PolicyDecision.Stop(userStopped = false)
            RunIntent.FAILED -> state to PolicyDecision.GiveUp
        }

    private fun unexpected(state: PolicyState): Pair<PolicyState, PolicyDecision> {
        if (state.intent != RunIntent.RUN) {
            return state to PolicyDecision.Stop(userStopped = state.intent == RunIntent.USER_STOPPED)
        }
        val now = clock()
        val recent = state.restartTimes.filter { it <= now && now - it < config.windowMillis }
        if (recent.size >= config.maxRestarts) {
            return PolicyState(RunIntent.FAILED, recent) to PolicyDecision.GiveUp
        }
        val times = recent + now
        val shift = (times.size - 1).coerceAtMost(30)
        val delay = (config.firstBackoffMillis shl shift).coerceIn(0, config.maxBackoffMillis)
        return PolicyState(RunIntent.RUN, times) to PolicyDecision.Restart(attempt = times.size + 1, delayMillis = delay)
    }
}
