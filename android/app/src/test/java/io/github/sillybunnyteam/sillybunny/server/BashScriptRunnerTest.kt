package io.github.sillybunnyteam.sillybunny.server

import android.os.CancellationSignal
import io.github.sillybunnyteam.sillybunny.runtime.RuntimePaths
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File
import java.io.IOException
import java.util.concurrent.CopyOnWriteArrayList

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [37])
class BashScriptRunnerTest {
    private val paths = RuntimePaths(File("/files"), File("/cache"), File("/lib"))
    private val environment = ProcessEnvironment.build(paths, mapOf("ANDROID_ROOT" to "/system"), 9, autoUpdate = true, launchToken = null)
    private val launched = CopyOnWriteArrayList<FakeServerProcess>()
    private var configure: (FakeServerProcess) -> Unit = {}
    private val fastStop = StopConfig(supervisorGraceMillis = 0, groupTermGraceMillis = 200, killGraceMillis = 200, pollMillis = 5)
    private val runner = BashScriptRunner(
        launcher = { spec -> FakeServerProcess(spec).also { configure(it); launched += it } },
        stopConfig = fastStop,
    ) { ScriptLaunch(listOf("/lib/libbash.so", "--noprofile", "--norc"), environment) }

    private val script = File("/files/SillyBunny-install.sh")

    @Test
    fun theScriptRunsUnderBashWithTheEnvironmentAndStreamsLinesOnTheCallingThread() {
        configure = { process ->
            Thread {
                process.print("cloning")
                process.write("npm ci\r\nin")
                process.write("it done\nno newline")
                process.exit(0)
            }.start()
        }
        val lines = mutableListOf<String>()
        val caller = Thread.currentThread()
        val threads = mutableSetOf<Thread>()

        val code = runner.run(script, listOf("--no-start", "--dir", "/files/SillyBunny"), File("/files"), { line ->
            lines += line
            threads += Thread.currentThread()
        }, CancellationSignal())

        assertEquals(0, code)
        assertEquals(listOf("cloning", "npm ci", "init done", "no newline"), lines)
        assertEquals(setOf(caller), threads)
        val spec = launched.single().spec
        assertEquals(
            listOf("/lib/libbash.so", "--noprofile", "--norc", script.absolutePath, "--no-start", "--dir", "/files/SillyBunny"),
            spec.argv,
        )
        assertEquals(File("/files"), spec.workingDir)
        assertSame(environment, spec.environment)
        assertFalse(spec.environment.containsKey(ProcessEnvironment.LAUNCH_TOKEN))
        assertTrue(launched.single().released)
        assertTrue(launched.single().signals.isEmpty())
    }

    @Test
    fun aFailingScriptReportsItsExitCode() {
        configure = { process -> Thread { process.print("fatal: no ref"); process.exit(3) }.start() }

        assertEquals(3, runner.run(script, emptyList(), File("/files"), {}, CancellationSignal()))
    }

    @Test
    fun cancellingStopsTheWholeGroup() {
        val cancel = CancellationSignal()
        configure = { process -> Thread { process.print("working") }.start() }
        val lines = mutableListOf<String>()

        val code = runner.run(script, emptyList(), File("/files"), { line ->
            lines += line
            cancel.cancel()
        }, cancel)

        assertEquals(128 + Signals.SIGTERM, code)
        assertEquals(listOf("group:15"), launched.single().signals)
        assertEquals(listOf("working"), lines)
    }

    @Test
    fun aGroupThatIgnoresSigtermIsKilledAfterTheGracePeriod() {
        val cancel = CancellationSignal()
        configure = { process ->
            process.groupTermExits = false
            Thread { process.print("stubborn") }.start()
        }

        val code = runner.run(script, emptyList(), File("/files"), { cancel.cancel() }, cancel)

        assertEquals(128 + Signals.SIGKILL, code)
        assertEquals(listOf("group:15", "group:9"), launched.single().signals)
    }

    @Test
    fun backgroundJobsLeftByAFinishedScriptAreStopped() {
        configure = { process ->
            process.leftovers = true
            Thread { process.print("spawned a daemon"); process.exit(0) }.start()
        }

        val code = runner.run(script, emptyList(), File("/files"), {}, CancellationSignal())

        assertEquals(0, code)
        assertEquals(listOf("group:15"), launched.single().signals)
        assertTrue(launched.single().isGone())
    }

    @Test
    fun aSignalCancelledBeforeTheStartRunsNothing() {
        val cancel = CancellationSignal().apply { cancel() }

        val code = runner.run(script, emptyList(), File("/files"), {}, cancel)

        assertEquals(BashScriptRunner.CANCELLED_BEFORE_START, code)
        assertTrue(launched.isEmpty())
    }

    @Test
    fun aScriptThatCannotStartThrows() {
        val failing = BashScriptRunner({ throw IOException("setsid") }, fastStop) {
            ScriptLaunch(listOf("/lib/libbash.so"), environment)
        }

        assertThrows(IOException::class.java) { failing.run(script, emptyList(), File("/files"), {}, CancellationSignal()) }
    }

    @Test
    fun aFailingLineConsumerStillStopsTheGroup() {
        configure = { process ->
            process.groupTermExits = true
            Thread { process.print("first") }.start()
        }

        assertThrows(IllegalStateException::class.java) {
            runner.run(script, emptyList(), File("/files"), { throw IllegalStateException("consumer") }, CancellationSignal())
        }
        assertEquals(listOf("group:15"), launched.single().signals)
        assertTrue(launched.single().released)
    }
}
