package io.github.sillybunnyteam.sillybunny.server

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream

class SessionProcessTest {
    @get:Rule
    val temporary = TemporaryFolder()

    private class StubProcess : Process() {
        private val out = ByteArrayOutputStream()
        private val input = ByteArrayInputStream(ByteArray(0))
        private val err = ByteArrayInputStream(ByteArray(0))

        override fun getOutputStream(): OutputStream = out
        override fun getInputStream(): InputStream = input
        override fun getErrorStream(): InputStream = err
        override fun waitFor(): Int = 0
        override fun exitValue(): Int = 0
        override fun destroy() {}
    }

    private class FakeProcReader(
        var processes: Map<Int, ProcStat> = emptyMap(),
        var argvs: Map<Int, List<String>?> = emptyMap(),
    ) : ProcReader {
        override fun read(pid: Int): ProcStat? = processes[pid]
        override fun argv(pid: Int): List<String>? = argvs[pid]
        override fun snapshot(uid: Int): Procfs.Snapshot = Procfs.Snapshot(
            processes.filterValues { it.uid == uid },
            emptyList(),
        )
    }

    private fun stat(pid: Int, ppid: Int, startTime: Long, state: String = "S"): ProcStat =
        ProcStat(pid = pid, uid = UID, state = state, ppid = ppid, pgid = PGID, session = PGID, startTime = startTime)

    private fun session(
        leader: ProcStat,
        command: ProcStat?,
        supervisorMarker: String?,
        procfs: FakeProcReader,
    ): SessionProcess = SessionProcess.forTest(
        StubProcess(),
        leader,
        command,
        SessionProcess.HandshakeFiles.create(temporary.root),
        supervisorMarker,
        procfs,
    )

    @Test
    fun servingProcessReturnsNullWhenSupervisorMarkerIsSetAndNoSupervisorChildExists() {
        val leader = stat(pid = PGID, ppid = 1, startTime = 100L)
        val command = stat(pid = COMMAND_PID, ppid = PGID, startTime = 110L)
        val npmChild = stat(pid = 4150, ppid = COMMAND_PID, startTime = 120L)
        val procfs = FakeProcReader(
            processes = mapOf(leader.pid to leader, command.pid to command, npmChild.pid to npmChild),
            argvs = mapOf(
                command.pid to listOf("/lib/libbash.so", "--noprofile", "--norc", "start.sh"),
                npmChild.pid to listOf("/lib/libnode.so", "npm-cli.js", "ci"),
            ),
        )
        val process = session(leader, command, LaunchSpecFactory.SUPERVISOR_MARKER, procfs)

        // Never bind the listener to bash start.sh while no matching node server.js supervisor exists.
        assertNull(process.servingProcess())
    }

    @Test
    fun servingProcessReturnsNullOnMissingSupervisorCmdlineAndAfterSupervisorExits() {
        val leader = stat(pid = PGID, ppid = 1, startTime = 100L)
        val command = stat(pid = COMMAND_PID, ppid = PGID, startTime = 110L)
        val supervisor = stat(pid = 4200, ppid = COMMAND_PID, startTime = 200L)
        val server = stat(pid = 4207, ppid = supervisor.pid, startTime = 250L)
        val procfs = FakeProcReader(
            processes = mapOf(
                leader.pid to leader,
                command.pid to command,
                supervisor.pid to supervisor,
                server.pid to server,
            ),
            argvs = mapOf(
                command.pid to listOf("/lib/libbash.so", "start.sh"),
                supervisor.pid to null,
                server.pid to listOf("/lib/libnode.so", "server.js"),
            ),
        )
        val process = session(leader, command, LaunchSpecFactory.SUPERVISOR_MARKER, procfs)

        // Transient /proc/<pid>/cmdline failure for the supervisor must not fall back to bash start.sh.
        assertNull(process.servingProcess())

        // Once the supervisor's argv is readable, servingProcess() resolves the server child.
        procfs.argvs = mapOf(
            command.pid to listOf("/lib/libbash.so", "start.sh"),
            supervisor.pid to listOf("/lib/libnode.so", "--no-warnings", "server.js"),
            server.pid to listOf("/lib/libnode.so", "server.js"),
        )
        assertEquals(server.pid, process.servingProcess()?.pid)

        // After the supervisor and server exit during start.sh's restart loop, servingProcess() returns null again.
        procfs.processes = mapOf(leader.pid to leader, command.pid to command)
        assertNull(process.servingProcess())
        assertFalse(process.stillRunning(server))
    }

    @Test
    fun servingProcessFallsBackToCommandOnlyWhenSupervisorMarkerIsNull() {
        val leader = stat(pid = PGID, ppid = 1, startTime = 100L)
        val command = stat(pid = COMMAND_PID, ppid = PGID, startTime = 110L)
        val procfs = FakeProcReader(
            processes = mapOf(leader.pid to leader, command.pid to command),
        )
        val process = session(leader, command, supervisorMarker = null, procfs = procfs)

        assertEquals(command.pid, process.servingProcess()?.pid)

        procfs.processes = mapOf(leader.pid to leader)
        assertNull(process.servingProcess())
    }

    private companion object {
        const val UID = 10_123
        const val PGID = 4100
        const val COMMAND_PID = 4106
    }
}
