package io.github.sillybunnyteam.sillybunny.server

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.IOException
import kotlin.random.Random

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [37])
class PortPolicyTest {
    private class MemoryStore(override var port: Int? = null, override var originChangePending: Boolean = false) : PortStore

    private val sleeps = mutableListOf<Long>()

    private fun policy(store: PortStore, isFree: (Int) -> Boolean) =
        PortPolicy(store, isFree, Random(7), sleep = { sleeps += it })

    @Test
    fun theFirstStartPicksAFreeDynamicPortAndPersistsIt() {
        val store = MemoryStore()
        val checked = mutableListOf<Int>()

        val choice = policy(store) { checked += it; true }.choose()

        assertTrue(choice.port in PortPolicy.RANGE)
        assertFalse(choice.originChanged)
        assertEquals(choice.port, store.port)
        assertEquals(listOf(choice.port), checked)
        assertTrue(sleeps.isEmpty())
    }

    @Test
    fun laterStartsReuseThePersistedPort() {
        val store = MemoryStore(50_001)

        val choice = policy(store) { true }.choose()

        assertEquals(PortPolicy.Choice(50_001, originChanged = false), choice)
        assertEquals(50_001, store.port)
        assertTrue(sleeps.isEmpty())
    }

    @Test
    fun aBrieflyBusyPortIsRetriedAndKept() {
        val store = MemoryStore(50_001)
        var checks = 0

        val choice = policy(store) { port -> port == 50_001 && ++checks > 2 }.choose()

        assertEquals(PortPolicy.Choice(50_001, originChanged = false), choice)
        assertEquals(listOf(400L, 400L), sleeps)
    }

    @Test
    fun aPortThatStaysBusyIsReplacedPersistedAndReportedAsAnOriginChange() {
        val store = MemoryStore(50_001)

        val choice = policy(store) { it != 50_001 }.choose()

        assertNotEquals(50_001, choice.port)
        assertTrue(choice.port in PortPolicy.RANGE)
        assertTrue(choice.originChanged)
        assertEquals(choice.port, store.port)
        assertTrue(store.originChangePending)
        // Five checks of the saved port, 400 ms apart.
        assertEquals(List(4) { 400L }, sleeps)
    }

    @Test
    fun aReplacementIsReportedByEveryChoiceUntilARunningStateClearsIt() {
        val store = MemoryStore(50_001)
        val replaced = policy(store) { it != 50_001 }.choose()

        // A run on the new port that ended before Running, or a new process: the change is still reported.
        val again = policy(store) { true }.choose()
        assertEquals(PortPolicy.Choice(replaced.port, originChanged = true), again)

        // Reported for another port: nothing changes.
        policy(store) { true }.originChangeReported(50_001)
        assertTrue(store.originChangePending)

        policy(store) { true }.originChangeReported(replaced.port)
        assertFalse(store.originChangePending)
        assertEquals(PortPolicy.Choice(replaced.port, originChanged = false), policy(store) { true }.choose())
    }

    @Test
    fun aFirstPortIsNoOriginChange() {
        val store = MemoryStore()

        policy(store) { true }.choose()

        assertFalse(store.originChangePending)
    }

    @Test
    fun theLiveServerPortIsNeverUsedOrReused() {
        assertFalse(PortPolicy.LIVE_SERVER_PORT in PortPolicy.RANGE)
        val store = MemoryStore(PortPolicy.LIVE_SERVER_PORT)
        val checked = mutableListOf<Int>()

        val choice = policy(store) { checked += it; true }.choose()

        assertNotEquals(PortPolicy.LIVE_SERVER_PORT, choice.port)
        assertFalse(PortPolicy.LIVE_SERVER_PORT in checked)
        assertFalse(choice.originChanged)
    }

    @Test
    fun noFreePortFailsWithoutPersistingAnything() {
        val store = MemoryStore(50_001)

        assertThrows(IOException::class.java) { policy(store) { false }.choose() }
        assertEquals(50_001, store.port)
    }

    @Test
    fun theLoopbackCheckSeesARealListener() {
        TestPorts.bindLoopback().use { socket ->
            assertFalse(PortPolicy.loopbackPortFree(socket.localPort))
        }
    }

    @Test
    fun theStoreKeepsThePortAcrossInstances() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val first = ServerStateStore(context)
        assertNull(first.port)

        val choice = PortPolicy(first, { true }, Random(3)).choose()

        assertEquals(choice.port, ServerStateStore(context).port)
        val again = PortPolicy(ServerStateStore(context), { true }, Random(4)).choose()
        assertEquals(PortPolicy.Choice(choice.port, originChanged = false), again)
    }

    @Test
    fun theStoreKeepsAPendingOriginChangeWithItsPortAcrossInstances() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        ServerStateStore(context).port = 50_001
        assertFalse(ServerStateStore(context).originChangePending)

        val replaced = PortPolicy(ServerStateStore(context), { it != 50_001 }, Random(5), sleep = {}).choose()

        val reopened = ServerStateStore(context)
        assertEquals(replaced.port, reopened.port)
        assertTrue(reopened.originChangePending)
        assertEquals(
            PortPolicy.Choice(replaced.port, originChanged = true),
            PortPolicy(ServerStateStore(context), { true }, Random(6)).choose(),
        )
        PortPolicy(ServerStateStore(context), { true }).originChangeReported(replaced.port)
        assertFalse(ServerStateStore(context).originChangePending)
    }
}
