package io.github.sillybunnyteam.sillybunny.server

import android.app.Application
import androidx.test.core.app.ApplicationProvider
import io.github.sillybunnyteam.sillybunny.runtime.RuntimePaths
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

/** The production launch that every device test replaces with `/system/bin/sh` stand-ins (plan §2.3, §2.5). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [37])
class LaunchSpecTest {
    @get:Rule
    val temporary = TemporaryFolder()

    private lateinit var paths: RuntimePaths
    private val session = LaunchSession(51_234, LaunchTokens.generate())

    @Before
    fun preparePaths() {
        paths = RuntimePaths(File(temporary.root, "files"), File(temporary.root, "cache"), File(temporary.root, "lib"))
    }

    private fun environment() = ProcessEnvironment.build(
        paths,
        mapOf("ANDROID_ROOT" to "/system"),
        versionCode = 7,
        autoUpdate = true,
        launchToken = session.token,
    )

    private fun installBash() {
        check(paths.nativeLibraryDir.mkdirs())
        check(paths.bash.createNewFile() && paths.bash.setExecutable(true))
    }

    private fun installStartScript() {
        check(paths.checkoutDir.mkdirs())
        File(paths.checkoutDir, "start.sh").writeText("#!/usr/bin/env bash\n")
    }

    @Test
    fun theServerRunsAsBashStartShWithThePortOnlyInArgv() {
        installBash()
        installStartScript()
        val environment = environment()

        val spec = LaunchSpecFactory.PRODUCTION.create(paths, session, environment)

        assertEquals(
            listOf(paths.bash.absolutePath, "--noprofile", "--norc", "start.sh", "--", "--port", "51234"),
            spec.argv,
        )
        assertEquals(File(temporary.root, "files/SillyBunny"), spec.workingDir)
        assertEquals(paths.checkoutDir, spec.workingDir)
        assertEquals("server.js", spec.supervisorMarker)
        assertEquals(LaunchSpecFactory.SUPERVISOR_MARKER, spec.supervisorMarker)
        // The environment passes through unchanged: the factory adds nothing, the port least of all.
        assertSame(environment, spec.environment)
        assertFalse(spec.environment.values.any { it.contains("51234") })
        assertFalse(spec.toString().contains(session.token))
    }

    @Test
    fun aMissingOrNonExecutableBashOrAMissingStartShIsUnavailable() {
        installStartScript()
        assertEquals("bash", unavailable().message)

        check(paths.nativeLibraryDir.mkdirs() && paths.bash.createNewFile())
        check(paths.bash.setExecutable(false))
        assertEquals("bash", unavailable().message)

        check(paths.bash.setExecutable(true))
        File(paths.checkoutDir, "start.sh").delete()
        assertEquals("start.sh", unavailable().message)

        // A directory named start.sh is no script either.
        check(File(paths.checkoutDir, "start.sh").mkdir())
        assertEquals("start.sh", unavailable().message)
    }

    @Test
    fun productionDependenciesUseThisLaunchAndRunScriptsWithTheBundledBash() {
        val context: Application = ApplicationProvider.getApplicationContext()

        val dependencies = ServerDependencies.production(context)

        assertSame(LaunchSpecFactory.PRODUCTION, dependencies.launchSpecs)
        assertEquals(listOf(paths.bash.absolutePath, "--noprofile", "--norc"), dependencies.scriptInterpreter(paths))
        assertTrue(dependencies.launcher is SessionLauncher)
        assertTrue(dependencies.health is HealthProbe)
    }

    private fun unavailable(): LaunchUnavailableException = assertThrows(LaunchUnavailableException::class.java) {
        LaunchSpecFactory.PRODUCTION.create(paths, session, environment())
    }
}
