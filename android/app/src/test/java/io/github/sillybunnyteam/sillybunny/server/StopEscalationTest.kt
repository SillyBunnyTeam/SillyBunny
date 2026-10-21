package io.github.sillybunnyteam.sillybunny.server

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.TimeUnit

class StopEscalationTest {
    private var nowNanos = 0L
    private val config = StopConfig(supervisorGraceMillis = 6_000, groupTermGraceMillis = 3_000, killGraceMillis = 2_000, pollMillis = 20)
    private val escalation = StopEscalation(config, nanoTime = { nowNanos }, sleep = { nowNanos += TimeUnit.MILLISECONDS.toNanos(it) })

    private fun advance(millis: Long) {
        nowNanos += TimeUnit.MILLISECONDS.toNanos(millis)
    }

    /** A fake process group whose members leave after a delay once a given signal arrives. */
    private inner class FakeGroup(
        private val supervisorKnown: Boolean = true,
        private val supervisorExitMillis: Long? = null,
        private val groupTermExitMillis: Long? = null,
        private val killExitMillis: Long? = 0,
    ) : StopTarget {
        val signals = mutableListOf<String>()
        private var goneAtNanos: Long? = null

        private fun leaveAfter(millis: Long?) {
            if (millis == null) return
            val at = nowNanos + TimeUnit.MILLISECONDS.toNanos(millis)
            goneAtNanos = minOf(goneAtNanos ?: at, at)
        }

        override fun signalSupervisor(signal: Int): Boolean {
            if (!supervisorKnown) return false
            signals += "supervisor:$signal"
            leaveAfter(supervisorExitMillis)
            return true
        }

        override fun signalGroup(signal: Int): Boolean {
            signals += "group:$signal"
            leaveAfter(if (signal == Signals.SIGKILL) killExitMillis else groupTermExitMillis)
            return true
        }

        override fun isGone(): Boolean = goneAtNanos?.let { nowNanos - it >= 0 } == true
    }

    /**
     * A group that empties [groupExitMillis] after the supervisor's SIGTERM, plus one member with a session of
     * its own (a detached `git clone`) that the supervisor never stops and that leaves on [escapedLeavesOn].
     */
    private inner class GroupWithDetachedMember(
        private val groupExitMillis: Long,
        private val escapedLeavesOn: Int,
    ) : StopTarget {
        val signals = mutableListOf<String>()
        private var groupGoneAtNanos: Long? = null
        private var escapedGone = false

        override fun signalSupervisor(signal: Int): Boolean {
            signals += "supervisor:$signal"
            groupGoneAtNanos = nowNanos + TimeUnit.MILLISECONDS.toNanos(groupExitMillis)
            return true
        }

        override fun signalGroup(signal: Int): Boolean {
            signals += "group:$signal"
            if (signal == escapedLeavesOn) escapedGone = true
            return true
        }

        override fun isGroupEmpty(): Boolean = groupGoneAtNanos?.let { nowNanos - it >= 0 } == true

        override fun isGone(): Boolean = isGroupEmpty() && escapedGone
    }

    @Test
    fun aMemberOutsideTheGroupIsSignalledAsSoonAsTheGroupItselfIsEmpty() {
        val group = GroupWithDetachedMember(groupExitMillis = 40, escapedLeavesOn = Signals.SIGTERM)

        val timings = escalation.stop(group)

        assertEquals(StopStep.GROUP_TERM, timings.stoppedBy)
        assertEquals(listOf("supervisor:15", "group:15"), group.signals)
        // The supervisor's 6 s grace period ended with the group, not with its deadline.
        assertEquals(40L, timings.supervisorPhaseMillis)
        assertEquals(40L, timings.totalMillis)
    }

    @Test
    fun aMemberOutsideTheGroupThatIgnoresSigtermIsKilled() {
        val group = GroupWithDetachedMember(groupExitMillis = 40, escapedLeavesOn = Signals.SIGKILL)

        val timings = escalation.stop(group)

        assertEquals(StopStep.GROUP_KILL, timings.stoppedBy)
        assertEquals(listOf("supervisor:15", "group:15", "group:9"), group.signals)
        assertEquals(40L, timings.supervisorPhaseMillis)
        assertEquals(3_000L, timings.groupTermPhaseMillis)
        assertTrue(timings.gone)
    }

    @Test
    fun theGracefulSupervisorPathEndsTheStop() {
        val group = FakeGroup(supervisorExitMillis = 40)

        val timings = escalation.stop(group)

        assertEquals(StopStep.SUPERVISOR_TERM, timings.stoppedBy)
        assertEquals(listOf("supervisor:15"), group.signals)
        assertTrue(timings.supervisorSignalled)
        assertEquals(40L, timings.supervisorPhaseMillis)
        assertEquals(40L, timings.totalMillis)
        assertTrue(timings.gone)
    }

    @Test
    fun aSupervisorThatIgnoresSigtermIsFollowedByGroupSigterm() {
        val group = FakeGroup(supervisorExitMillis = null, groupTermExitMillis = 140)

        val timings = escalation.stop(group)

        assertEquals(StopStep.GROUP_TERM, timings.stoppedBy)
        assertEquals(listOf("supervisor:15", "group:15"), group.signals)
        assertEquals(6_000L, timings.supervisorPhaseMillis)
        assertEquals(140L, timings.groupTermPhaseMillis)
        assertEquals(0L, timings.killPhaseMillis)
        assertEquals(6_140L, timings.totalMillis)
    }

    @Test
    fun aGroupThatIgnoresSigtermIsKilled() {
        val group = FakeGroup(supervisorExitMillis = null, groupTermExitMillis = null, killExitMillis = 20)

        val timings = escalation.stop(group)

        assertEquals(StopStep.GROUP_KILL, timings.stoppedBy)
        assertEquals(listOf("supervisor:15", "group:15", "group:9"), group.signals)
        assertEquals(3_000L, timings.groupTermPhaseMillis)
        assertEquals(20L, timings.killPhaseMillis)
        assertEquals(9_020L, timings.totalMillis)
        assertTrue(timings.gone)
    }

    @Test
    fun somethingThatSurvivesSigkillIsReportedAsNotGone() {
        val group = FakeGroup(supervisorExitMillis = null, groupTermExitMillis = null, killExitMillis = null)

        val timings = escalation.stop(group)

        assertEquals(StopStep.NOT_GONE, timings.stoppedBy)
        assertFalse(timings.gone)
        assertEquals(listOf("supervisor:15", "group:15", "group:9"), group.signals)
        assertEquals(11_000L, timings.totalMillis)
    }

    @Test
    fun withoutAKnownSupervisorTheStopStartsAtTheGroup() {
        val group = FakeGroup(supervisorKnown = false, groupTermExitMillis = 60)

        val timings = escalation.stop(group)

        assertEquals(StopStep.GROUP_TERM, timings.stoppedBy)
        assertFalse(timings.supervisorSignalled)
        assertEquals(listOf("group:15"), group.signals)
        assertEquals(60L, timings.totalMillis)
    }

    @Test
    fun scriptsSkipTheSupervisorStep() {
        val group = FakeGroup(supervisorExitMillis = 0, groupTermExitMillis = 0)

        val timings = escalation.stop(group, supervisorFirst = false)

        assertEquals(StopStep.GROUP_TERM, timings.stoppedBy)
        assertEquals(listOf("group:15"), group.signals)
    }

    @Test
    fun anAlreadyGoneGroupIsNotSignalled() {
        val group = FakeGroup(supervisorExitMillis = 0)
        group.signalSupervisor(Signals.SIGTERM)
        group.signals.clear()
        advance(1)

        val timings = escalation.stop(group)

        assertEquals(StopStep.ALREADY_GONE, timings.stoppedBy)
        assertTrue(group.signals.isEmpty())
    }

    @Test
    fun theDefaultGracePeriodsOutlastTheSupervisorsOwnForceKill() {
        val defaults = StopConfig()

        // src/server-supervisor.js force-kills its child after 5 s; the app waits a little longer first.
        assertTrue(defaults.supervisorGraceMillis > 5_000)
        assertEquals(0L, BashScriptRunner.CANCEL_STOP.supervisorGraceMillis)
    }
}
