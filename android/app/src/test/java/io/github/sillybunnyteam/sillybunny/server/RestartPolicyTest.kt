package io.github.sillybunnyteam.sillybunny.server

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [37])
class RestartPolicyTest {
    private var now = 1_000_000L
    private val policy = RestartPolicy(RestartConfig(), clock = { now })

    private fun crash(state: PolicyState, code: Int? = 1) = policy.onExit(state, ExitKind.Unexpected(code))

    @Test
    fun threeRestartsWithDoublingBackoffThenFailed() {
        var state = policy.explicitStart()
        val decisions = mutableListOf<PolicyDecision>()
        repeat(4) {
            val (next, decision) = crash(state)
            state = next
            decisions += decision
            now += 10_000
        }

        assertEquals(
            listOf(
                PolicyDecision.Restart(attempt = 2, delayMillis = 2_000),
                PolicyDecision.Restart(attempt = 3, delayMillis = 4_000),
                PolicyDecision.Restart(attempt = 4, delayMillis = 8_000),
                PolicyDecision.GiveUp,
            ),
            decisions,
        )
        assertEquals(RunIntent.FAILED, state.intent)
    }

    @Test
    fun restartsOlderThanTheWindowNoLongerCount() {
        var state = policy.explicitStart()
        repeat(3) {
            state = crash(state).first
            now += 60_000
        }
        // The first restart was 3 minutes ago; 2 more minutes and 1 ms take it out of the 5-minute window.
        now += 2 * 60_000 + 1

        val (next, decision) = crash(state)

        assertEquals(PolicyDecision.Restart(attempt = 4, delayMillis = 8_000), decision)
        assertEquals(RunIntent.RUN, next.intent)
        assertEquals(3, next.restartTimes.size)
    }

    @Test
    fun anExplicitStartResetsTheBudget() {
        var state = policy.explicitStart()
        repeat(4) { state = crash(state).first }
        assertEquals(RunIntent.FAILED, state.intent)

        state = policy.explicitStart()

        assertEquals(PolicyState(RunIntent.RUN, emptyList()), state)
        assertEquals(PolicyDecision.Restart(2, 2_000), crash(state).second)
    }

    @Test
    fun aUserStopOrACleanExitLeavesTheServerStopped() {
        val running = crash(policy.explicitStart()).first

        assertEquals(
            PolicyState(RunIntent.USER_STOPPED, emptyList()) to PolicyDecision.Stop(userStopped = true),
            policy.onExit(running, ExitKind.Requested),
        )
        assertEquals(
            PolicyState(RunIntent.CLEAN_STOPPED, emptyList()) to PolicyDecision.Stop(userStopped = false),
            policy.onExit(running, ExitKind.Clean),
        )
    }

    @Test
    fun anExitAfterAUserStopNeverRestarts() {
        val stopped = policy.userStop()

        assertEquals(stopped to PolicyDecision.Stop(userStopped = true), crash(stopped, code = null))
        assertEquals(stopped to PolicyDecision.Stop(userStopped = true), policy.onRecreate(stopped, false))
    }

    @Test
    fun nullIntentRecreationRecoversOnlyAServerTheUserStillWants() {
        val running = policy.explicitStart()

        assertEquals(PolicyDecision.Restart(2, 2_000), policy.onRecreate(running, lastExitUserRequested = false).second)
        assertEquals(
            PolicyState(RunIntent.USER_STOPPED, emptyList()) to PolicyDecision.Stop(userStopped = true),
            policy.onRecreate(running, lastExitUserRequested = true),
        )
        val clean = PolicyState(RunIntent.CLEAN_STOPPED, emptyList())
        assertEquals(clean to PolicyDecision.Stop(userStopped = false), policy.onRecreate(clean, false))
        val failed = PolicyState(RunIntent.FAILED, listOf(now))
        assertEquals(failed to PolicyDecision.GiveUp, policy.onRecreate(failed, false))
    }

    @Test
    fun recreationSharesTheRestartBudget() {
        var state = policy.explicitStart()
        repeat(3) {
            state = crash(state).first
            now += 1_000
        }

        assertEquals(PolicyDecision.GiveUp, policy.onRecreate(state, lastExitUserRequested = false).second)
    }

    @Test
    fun timesFromBeforeARebootAreDropped() {
        // elapsedRealtime restarts at boot, so stored times later than now are stale.
        val stale = PolicyState(RunIntent.RUN, listOf(now + 1, now + 2, now + 3))

        val (next, decision) = crash(stale)

        assertEquals(PolicyDecision.Restart(2, 2_000), decision)
        assertEquals(listOf(now), next.restartTimes)
    }

    @Test
    fun backoffIsCappedAndConfigurable() {
        val short = RestartPolicy(RestartConfig(maxRestarts = 10, windowMillis = 1_000, firstBackoffMillis = 50, maxBackoffMillis = 300)) { now }
        var state = short.explicitStart()
        val delays = mutableListOf<Long>()
        repeat(6) {
            val (next, decision) = short.onExit(state, ExitKind.Unexpected(137))
            state = next
            delays += (decision as PolicyDecision.Restart).delayMillis
        }

        assertEquals(listOf(50L, 100L, 200L, 300L, 300L, 300L), delays)
    }

    @Test
    fun thePolicySurvivesProcessDeathThroughTheStore() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val store = ServerStateStore(context)
        assertEquals(PolicyState.INITIAL, store.loadPolicy())

        val state = crash(crash(policy.explicitStart()).first).first
        store.savePolicy(state)

        val restored = ServerStateStore(context).loadPolicy()
        assertEquals(state, restored)
        assertEquals(PolicyDecision.Restart(4, 8_000), crash(restored).second)

        store.savePolicy(policy.userStop())
        assertEquals(PolicyDecision.Stop(userStopped = true), policy.onRecreate(ServerStateStore(context).loadPolicy(), false).second)
    }
}
