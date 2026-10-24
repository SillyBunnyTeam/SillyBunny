package io.github.sillybunnyteam.sillybunny.server

import android.system.ErrnoException
import android.system.Os
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.IOException
import java.io.InputStream
import java.util.UUID
import java.util.concurrent.TimeUnit

/** The PIDs of one run (plan §2.3): session shell, command (`bash start.sh`), supervisor and server. */
internal data class ProcessIds(
    val processGroup: Int,
    val shell: Int,
    val command: Int,
    val supervisor: Int?,
    val server: Int?,
)

/** A process group the server manager or a script runner owns. */
internal interface ServerProcess : StopTarget {
    /** Merged stdout and stderr of every member. */
    val output: InputStream

    /** Waits up to [timeoutMillis] for the command and its session shell to exit; true once they have. */
    fun waitForExit(timeoutMillis: Long): Boolean

    /** The command's exit status once [waitForExit] returned true, otherwise null. */
    val exitCode: Int?

    fun ids(): ProcessIds

    /**
     * The process serving HTTP for this run right now: the supervisor's server child (plan §2.3), identified
     * by PID and start time. Null when none can be found. The supervisor replaces its child after exit 75 or
     * 76, so a listener announcement is valid only while the same child runs ([stillRunning]).
     */
    fun servingProcess(): ProcStat?

    /** True while [server], as returned by [servingProcess], is still that same live process. */
    fun stillRunning(server: ProcStat): Boolean

    /** Deletes the handshake files and closes the output; call once the group is gone. */
    fun release()
}

internal fun interface ProcessLauncher {
    fun launch(spec: LaunchSpec): ServerProcess
}

/** Starts every command through [SessionProcess], keeping handshake files in [controlDir]. */
internal class SessionLauncher(private val controlDir: File) : ProcessLauncher {
    override fun launch(spec: LaunchSpec): ServerProcess = SessionProcess.start(spec, controlDir)
}

/** One `/proc/<pid>/stat` reading; [startTime] makes the identity safe against PID reuse. */
internal class ProcStat(
    val pid: Int,
    val uid: Int,
    val state: String,
    val ppid: Int,
    val pgid: Int,
    val session: Int,
    val startTime: Long,
) {
    val live: Boolean get() = state != "Z" && state != "X"

    fun same(other: ProcStat?): Boolean =
        other != null && other.pid == pid && other.uid == uid && other.startTime == startTime

    companion object {
        private val whitespace = Regex("\\s+")

        /** Parses `/proc/<pid>/stat`, whose command name may itself contain spaces and parentheses. */
        fun parse(pid: Int, uid: Int, raw: String): ProcStat? {
            val open = raw.indexOf('(')
            val close = raw.lastIndexOf(')')
            if (open < 1 || close < open || raw.substring(0, open).trim() != pid.toString()) return null
            val fields = raw.substring(close + 1).trim().split(whitespace)
            if (fields.size < 20) return null
            return try {
                // fields[0] is kernel field 3 (state); starttime is kernel field 22.
                ProcStat(
                    pid,
                    uid,
                    fields[0],
                    fields[1].toInt(),
                    fields[2].toInt(),
                    fields[3].toInt(),
                    fields[19].toLong(),
                )
            } catch (_: NumberFormatException) {
                null
            }
        }
    }
}

internal object Procfs {
    class Snapshot(val processes: Map<Int, ProcStat>, val unreadable: List<Int>) {
        fun liveInGroup(pgid: Int): List<ProcStat> = processes.values.filter { it.live && it.pgid == pgid }
    }

    fun read(pid: Int): ProcStat? = try {
        ProcStat.parse(pid, Os.stat("/proc/$pid").st_uid, readText(File("/proc/$pid/stat"), 4096))
    } catch (_: ErrnoException) {
        null
    } catch (_: IOException) {
        null
    }

    /** The NUL-separated argument vector from `/proc/<pid>/cmdline`, or null once the process is gone. */
    fun argv(pid: Int): List<String>? = try {
        readText(File("/proc/$pid/cmdline"), 16_384).split('\u0000').dropLastWhile { it.isEmpty() }
    } catch (_: IOException) {
        null
    }

    /** Every process owned by [uid]; same-UID entries that vanish mid-read are reported as unreadable. */
    fun snapshot(uid: Int): Snapshot {
        val names = File("/proc").list() ?: throw IOException("proc")
        val processes = LinkedHashMap<Int, ProcStat>()
        val unreadable = ArrayList<Int>()
        for (name in names) {
            val pid = name.toIntOrNull() ?: continue
            val owner = try {
                Os.stat("/proc/$name").st_uid
            } catch (_: ErrnoException) {
                continue
            }
            if (owner != uid) continue
            val stat = try {
                ProcStat.parse(pid, owner, readText(File("/proc/$name/stat"), 4096))
            } catch (_: IOException) {
                null
            }
            when {
                stat != null -> processes[pid] = stat
                File("/proc/$name").exists() -> unreadable += pid
            }
        }
        return Snapshot(processes, unreadable)
    }

    fun readText(file: File, limit: Int): String = FileInputStream(file).use { input ->
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(minOf(limit, 8192))
        while (output.size() < limit) {
            val count = input.read(buffer, 0, minOf(buffer.size, limit - output.size()))
            if (count < 0) break
            output.write(buffer, 0, count)
        }
        String(output.toByteArray(), Charsets.UTF_8)
    }
}

/**
 * A command in its own session and process group, started through the app-owned `setsid` shell
 * handshake proven in S2.5 (adapted from its `ProcessRunner`; no `run-as`).
 *
 * `setsid /system/bin/sh -c <wrapper>` writes its PID and waits. The app checks that PID is a same-UID
 * session and group leader outside the app's own group, then opens a gate; the shell starts the command,
 * writes the command's PID and, when the command ends, its exit status. The shell traps SIGTERM, so a
 * group SIGTERM still records the command's status. Every signal first checks, by PID and start time,
 * that a process this object saw in the group is still a member, so a reused group ID is never signalled.
 * [waitForExit] keeps that list current, so a member whose parents already exited (for example the server
 * child of a killed supervisor) can still be verified and stopped. The list also holds descendants that
 * started a session or group of their own (Node's `detached` spawns, `setsid`), found through their live
 * parent; they get every group signal one by one and count until they exit. After the exit status the shell
 * waits (bounded) for an acknowledgement, which the app writes only after one last look at the group while
 * the shell still vouches for it, so even a background job the command started just before it exited is known.
 */
internal class SessionProcess private constructor(
    private val process: Process,
    private val leader: ProcStat,
    private val commandPid: Int,
    private val command: ProcStat?,
    private val files: HandshakeFiles,
    private val supervisorMarker: String?,
) : ServerProcess {
    private val uid = leader.uid
    private val pgid = leader.pid

    // Replaced as a whole under the monitor, read without it. Dead members are pruned, the leader is kept.
    @Volatile
    private var members: List<ProcStat> = listOfNotNull(leader, command)

    @Volatile
    private var nextTrackNanos = 0L

    @Volatile
    private var supervisor: ProcStat? = null

    @Volatile
    private var exitStatus: Int? = null

    @Volatile
    private var exited = false

    @Volatile
    private var acknowledged = false

    override val output: InputStream get() = process.inputStream

    override val exitCode: Int? get() = exitStatus

    override fun waitForExit(timeoutMillis: Long): Boolean {
        if (exited) return true
        val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMillis)
        while (true) {
            trackMembers()
            acknowledgeExit()
            val alive = process.isAlive
            if (!alive && !leaderAlive()) {
                // One last look while remembered members can still vouch for what is left in the group.
                snapshotOrNull()?.let(::remember)
                recordExit()
                return true
            }
            val remaining = TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime())
            if (remaining <= 0) return false
            if (alive) {
                // The shell's own exit wakes this at once. The slice bounds how stale the member list gets and,
                // because the shell waits for the acknowledgement, how late the command's exit is noticed.
                process.waitFor(remaining.coerceAtMost(TRACK_INTERVAL_MILLIS), TimeUnit.MILLISECONDS)
            } else {
                Thread.sleep(remaining.coerceAtMost(50))
            }
        }
    }

    override fun signalSupervisor(signal: Int): Boolean {
        // A last look while every parent still runs: once the supervisor's graceful path has ended the group,
        // a descendant that left it could no longer be traced to this run.
        snapshotOrNull()?.let(::remember)
        val target = findSupervisor() ?: return false
        val current = Procfs.read(target.pid) ?: return false
        if (!target.same(current) || !current.live || current.pgid != pgid) return false
        return kill(target.pid, signal)
    }

    override fun signalGroup(signal: Int): Boolean {
        val snapshot = snapshotOrNull() ?: return false
        remember(snapshot)
        val escaped = signalEscaped(snapshot, signal)
        if (!verifiedMemberAlive(snapshot)) return escaped
        return kill(-pgid, signal) || escaped
    }

    override fun isGone(): Boolean {
        acknowledgeExit()
        if (process.isAlive) return false
        val snapshot = snapshotOrNull() ?: return false
        remember(snapshot)
        if (snapshot.liveInGroup(pgid).isNotEmpty() || snapshot.unreadable.isNotEmpty()) return false
        // A member that left the group (setsid or setpgid of its own), or a descendant of one, counts until it exits.
        return members.none { member -> snapshot.processes[member.pid]?.let { member.same(it) && it.live } == true }
    }

    override fun isGroupEmpty(): Boolean {
        acknowledgeExit()
        if (process.isAlive) return false
        val snapshot = snapshotOrNull() ?: return false
        remember(snapshot)
        return snapshot.liveInGroup(pgid).isEmpty() && snapshot.unreadable.isEmpty()
    }

    override fun ids(): ProcessIds {
        val found = findSupervisor()
        val server = found?.let { parent ->
            snapshotOrNull()?.liveInGroup(pgid)?.firstOrNull { it.ppid == parent.pid }?.pid
        }
        return ProcessIds(pgid, leader.pid, commandPid, found?.pid, server)
    }

    override fun servingProcess(): ProcStat? {
        val supervisor = findSupervisor()
        val snapshot = snapshotOrNull() ?: return null
        remember(snapshot)
        if (supervisor == null) {
            // No supervisor to ask (a launch without one): the command itself stands in for the server.
            return command?.takeIf { known -> snapshot.processes[known.pid]?.let { known.same(it) && it.live } == true }
        }
        val children = snapshot.liveInGroup(pgid).filter { it.ppid == supervisor.pid && it.session == pgid }
        val marker = supervisorMarker
        // Node's supervisor runs its child with the same `server.js` argv; without one, a lone child is the server.
        val servers = if (marker == null) emptyList() else children.filter { namesMarker(it.pid, marker) }
        return servers.maxByOrNull { it.startTime } ?: children.singleOrNull() ?: supervisor
    }

    override fun stillRunning(server: ProcStat): Boolean =
        Procfs.read(server.pid)?.let { server.same(it) && it.live } == true

    override fun release() {
        files.delete()
        try {
            process.inputStream.close()
        } catch (_: IOException) {
            // Already closed by the reader.
        }
    }

    private fun recordExit() {
        synchronized(this) {
            if (exited) return
            exitStatus = parseStatus(files.exit) ?: try {
                process.exitValue()
            } catch (_: IllegalThreadStateException) {
                null
            }
            exited = true
        }
    }

    /**
     * Once the command's exit status is written, remembers the group while the waiting shell still proves it
     * is ours, then lets the shell exit. Members found here can be stopped after the shell is gone.
     */
    private fun acknowledgeExit() {
        if (acknowledged || !files.exit.isFile || parseStatus(files.exit) == null) return
        synchronized(this) {
            if (acknowledged) return
            snapshotOrNull()?.let(::remember)
            try {
                files.ack.writeText("1\n")
            } catch (_: IOException) {
                // The shell stops waiting on its own.
            }
            acknowledged = true
        }
    }

    private fun leaderAlive(): Boolean = Procfs.read(leader.pid)?.let { leader.same(it) && it.live } == true

    /** The supervisor: a direct child of the command whose argv names [supervisorMarker] (`server.js`). */
    private fun findSupervisor(): ProcStat? {
        supervisor?.let { known ->
            if (Procfs.read(known.pid)?.let { known.same(it) && it.live } == true) return known
        }
        val marker = supervisorMarker ?: return null
        val snapshot = snapshotOrNull() ?: return null
        remember(snapshot)
        val found = snapshot.liveInGroup(pgid).firstOrNull { candidate ->
            candidate.ppid == commandPid && namesMarker(candidate.pid, marker)
        }
        supervisor = found
        return found
    }

    /** True when an element of the process's argv is [marker] or a path ending in it. */
    private fun namesMarker(pid: Int, marker: String): Boolean =
        Procfs.argv(pid)?.any { it == marker || it.endsWith("/$marker") } == true

    private fun snapshotOrNull(): Procfs.Snapshot? = try {
        Procfs.snapshot(uid)
    } catch (_: IOException) {
        null
    }

    /** Remembers new group members at most every [TRACK_INTERVAL_NANOS]; called while waiting for the exit. */
    private fun trackMembers() {
        val now = System.nanoTime()
        if (now - nextTrackNanos < 0) return
        nextTrackNanos = now + TRACK_INTERVAL_NANOS
        snapshotOrNull()?.let(::remember)
    }

    private fun verifiedMemberAlive(snapshot: Procfs.Snapshot): Boolean = members.any { member ->
        snapshot.processes[member.pid]?.let {
            member.same(it) && it.live && it.pgid == pgid && it.session == pgid
        } == true
    }

    /**
     * Drops members that have exited and adds current group members, but adds only while a verified member
     * proves the group is still ours. A process that left the group stays remembered until it exits. Live
     * descendants of live members are added whatever their session or group.
     */
    @Synchronized
    private fun remember(snapshot: Procfs.Snapshot) {
        val verified = verifiedMemberAlive(snapshot)
        val kept = members.filter { member ->
            member === leader || snapshot.processes[member.pid]?.let { member.same(it) && it.live } == true
        }
        val added = if (verified) {
            snapshot.liveInGroup(pgid).filter { current -> current.session == pgid && kept.none { it.same(current) } }
        } else {
            emptyList()
        }
        val known = kept + added
        members = (known + newDescendants(known, snapshot)).take(MAX_TRACKED)
    }

    /**
     * Live same-UID processes, not yet live known members, whose parent is one, to a fixed point. Parents match
     * by PID and start time and a child never starts before its parent, so a reused PID adds nothing. These
     * are mostly descendants with a session of their own (Node's `detached` spawns, such as a plugin's `git clone`).
     */
    private fun newDescendants(known: List<ProcStat>, snapshot: Procfs.Snapshot): List<ProcStat> {
        val parents = HashMap<Int, ProcStat>()
        for (member in known) {
            val current = snapshot.processes[member.pid] ?: continue
            if (member.same(current) && current.live) parents[member.pid] = current
        }
        val found = ArrayList<ProcStat>()
        var grew = true
        while (grew && parents.size < MAX_TRACKED) {
            grew = false
            for (candidate in snapshot.processes.values) {
                if (!candidate.live || parents.containsKey(candidate.pid)) continue
                val parent = parents[candidate.ppid] ?: continue
                if (candidate.startTime < parent.startTime) continue
                parents[candidate.pid] = candidate
                found += candidate
                grew = true
            }
        }
        return found
    }

    /** Sends [signal] to each live remembered member outside the group; true if any was signalled. */
    private fun signalEscaped(snapshot: Procfs.Snapshot, signal: Int): Boolean {
        var signalled = false
        for (member in members) {
            val current = snapshot.processes[member.pid] ?: continue
            if (member.same(current) && current.live && current.pgid != pgid && kill(member.pid, signal)) signalled = true
        }
        return signalled
    }

    private fun kill(target: Int, signal: Int): Boolean = try {
        Os.kill(target, signal)
        true
    } catch (_: ErrnoException) {
        false
    }

    class HandshakeFiles(val pid: File, val gate: File, val exit: File, val child: File, val ack: File) {
        fun delete() {
            pid.delete()
            gate.delete()
            exit.delete()
            child.delete()
            ack.delete()
        }

        companion object {
            fun create(directory: File): HandshakeFiles {
                if (!directory.isDirectory && !directory.mkdirs()) throw IOException("control")
                val id = UUID.randomUUID().toString()
                return HandshakeFiles(
                    File(directory, "$id.pid"),
                    File(directory, "$id.gate"),
                    File(directory, "$id.exit"),
                    File(directory, "$id.child"),
                    File(directory, "$id.ack"),
                )
            }
        }
    }

    companion object {
        private const val SETSID = "/system/bin/setsid"
        private const val SHELL = "/system/bin/sh"
        private const val HANDSHAKE_MILLIS = 10_000L
        private const val MAX_TRACKED = 4096
        private const val TRACK_INTERVAL_MILLIS = 1_000L
        private val TRACK_INTERVAL_NANOS = TimeUnit.MILLISECONDS.toNanos(TRACK_INTERVAL_MILLIS)

        /**
         * The session shell, adapted from S2.5: `$1` PID file, `$2` gate, `$3` exit file, `$4` command PID file,
         * `$5` exit acknowledgement, awaited for at most 10 s so that a dead app never keeps the shell around.
         */
        private val WRAPPER = listOf(
            "umask 077",
            "printf '%s\\n' \"\$\$\" > \"\$1\" || exit 125",
            "n=0",
            "while [ ! -f \"\$2\" ]; do n=\$((n+1)); [ \"\$n\" -lt 500 ] || exit 124; /system/bin/sleep 0.02; done",
            "exit_file=\$3",
            "child_file=\$4",
            "ack_file=\$5",
            "shift 5",
            "trap ':' TERM",
            "\"\$@\" & child=\$!",
            "printf '%s\\n' \"\$child\" > \"\$child_file\"",
            "while :; do wait \"\$child\"; code=\$?; kill -0 \"\$child\" 2>/dev/null || break; done",
            "printf '%s\\n' \"\$code\" > \"\$exit_file\"",
            "n=0",
            "while [ ! -f \"\$ack_file\" ]; do n=\$((n+1)); [ \"\$n\" -lt 500 ] || break; /system/bin/sleep 0.02; done",
            "exit \"\$code\"",
        ).joinToString("; ")

        fun start(spec: LaunchSpec, controlDir: File): SessionProcess {
            if (!File(SETSID).canExecute()) throw IOException("setsid")
            val files = HandshakeFiles.create(controlDir)
            val argv = listOf(
                SETSID,
                SHELL,
                "-c",
                WRAPPER,
                "sillybunny-session",
                files.pid.absolutePath,
                files.gate.absolutePath,
                files.exit.absolutePath,
                files.child.absolutePath,
                files.ack.absolutePath,
            ) + spec.argv
            val builder = ProcessBuilder(argv).directory(spec.workingDir).redirectErrorStream(true)
            // An allowlisted environment: nothing from the app process leaks in except §2.5's framework roots.
            builder.environment().clear()
            builder.environment().putAll(spec.environment)
            val process = try {
                builder.start()
            } catch (error: IOException) {
                files.delete()
                throw error
            }
            try {
                process.outputStream.close()
            } catch (_: IOException) {
                // Nothing reads stdin.
            }
            var verifiedLeader: ProcStat? = null
            try {
                val uid = Os.getuid()
                // The app's own process group, which the new session must never be.
                val appGroup = Procfs.read(Os.getpid())?.pgid ?: throw IOException("handshake")
                val leaderPid = awaitPid(files.pid, process)
                val leader = Procfs.read(leaderPid)
                if (leader == null || leaderPid <= 1 || leader.uid != uid || leader.pgid != leaderPid ||
                    leader.session != leaderPid || leaderPid == appGroup
                ) {
                    throw IOException("handshake")
                }
                verifiedLeader = leader
                files.gate.writeText("1\n")
                val commandPid = awaitPid(files.child, process)
                val command = Procfs.read(commandPid)?.takeIf { it.live }
                if (command != null && (command.uid != uid || command.ppid != leaderPid ||
                        command.pgid != leaderPid || command.session != leaderPid)
                ) {
                    throw IOException("handshake")
                }
                return SessionProcess(process, leader, commandPid, command, files, spec.supervisorMarker)
            } catch (error: Exception) {
                verifiedLeader?.let { leader ->
                    if (Procfs.read(leader.pid)?.let { leader.same(it) } == true) {
                        try {
                            Os.kill(-leader.pid, Signals.SIGKILL)
                        } catch (_: ErrnoException) {
                            // Already gone.
                        }
                    }
                }
                process.destroyForcibly()
                files.delete()
                throw if (error is IOException) error else IOException("handshake", error)
            }
        }

        private fun awaitPid(file: File, process: Process): Int {
            val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(HANDSHAKE_MILLIS)
            var lastLook = false
            while (true) {
                val text = try {
                    Procfs.readText(file, 64)
                } catch (_: IOException) {
                    ""
                }
                if (text.endsWith("\n")) {
                    return text.trim().toIntOrNull()?.takeIf { it > 1 } ?: throw IOException("handshake")
                }
                // The shell writes the file before it can exit, so a dead shell gets one more look.
                if (lastLook || System.nanoTime() - deadline >= 0) throw IOException("handshake")
                if (!process.isAlive) lastLook = true else Thread.sleep(5)
            }
        }

        private fun parseStatus(file: File): Int? {
            val text = try {
                Procfs.readText(file, 64)
            } catch (_: IOException) {
                return null
            }
            if (!text.endsWith("\n")) return null
            return text.trim().toIntOrNull()?.takeIf { it in 0..255 }
        }
    }
}
