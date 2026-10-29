package io.github.sillybunnyteam.sillybunny.runtime

import android.os.Bundle
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.github.sillybunnyteam.sillybunny.BuildConfig
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.nio.file.Files
import java.util.concurrent.TimeUnit

/**
 * Runs the real layout in the app process (the instrumentation shares it) and executes the bundled tools
 * from it. Host scripts drive the refresh cases: `-e expectRefresh true|false` and
 * `-e expectReasons A,B` assert the decision of the first [RuntimeLayout.ensure] call of a launch.
 */
@RunWith(AndroidJUnit4::class)
class RuntimeLayoutDeviceTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val arguments = InstrumentationRegistry.getArguments()

    /** A debug build without the runtime inputs has nothing to lay out, so these tests are skipped there. */
    @Before
    fun requireRuntime() {
        assumeTrue(BuildConfig.HAS_RUNTIME)
    }

    @Test
    fun layoutMatchesTheInstalledApk() {
        val result = ready(RuntimeLayout.ensure(context))
        report(
            "layout",
            "refreshed=${result.refreshed} reasons=${result.refreshReasons.sorted()} elapsedMs=${result.elapsedMillis} " +
                "abi=${result.installed.abi} sync=${result.installed.npmSyncMode} nativeLibraryDir=${result.paths.nativeLibraryDir}",
        )
        arguments.getString("expectRefresh")?.let { assertEquals(it.toBoolean(), result.refreshed) }
        arguments.getString("expectReasons")?.let { expected ->
            assertEquals(expected.split(',').map { RefreshReason.valueOf(it) }.toSet(), result.refreshReasons)
        }
        val warm = ready(RuntimeLayout.ensure(context))
        assertFalse(warm.refreshed)
        report("warm", "elapsedMs=${warm.elapsedMillis}")
    }

    @Test
    fun bundledToolsRunFromTheAppProcess() {
        val result = ready(RuntimeLayout.ensure(context))
        val paths = result.paths
        val versions = linkedMapOf<String, String>()
        for (tool in listOf("node", "git", "bash", "npm", "npx")) {
            val (code, output) = run(paths, File(paths.binDir, tool).path, "--version")
            assertEquals("$tool: $output", 0, code)
            versions[tool] = output.lineSequence().first()
        }
        assertEquals("v" + result.installed.versions.getValue("node"), versions["node"])
        assertEquals("git version " + result.installed.versions.getValue("git").substringBefore('-'), versions["git"])
        assertTrue(versions["bash"], versions.getValue("bash").startsWith("GNU bash, version "))
        assertEquals(result.installed.versions.getValue("npm"), versions["npm"])
        assertEquals(result.installed.versions.getValue("npm"), versions["npx"])
        val (code, execPath) = run(paths, File(paths.binDir, "git").path, "--exec-path")
        assertEquals(execPath, 0, code)
        assertEquals(paths.gitExecPath.path, execPath)
        report("tools", versions.entries.joinToString(" | ") { "${it.key}: ${it.value}" } + " | exec-path: $execPath")
    }

    @Test
    fun everyGitHelperLinkResolves() {
        val result = ready(RuntimeLayout.ensure(context))
        val paths = result.paths
        val helpers = paths.gitExecPath.listFiles().orEmpty()
        assertEquals(148, helpers.size)
        assertEquals(result.installed.gitCoreLinks, helpers.size)
        helpers.forEach { helper ->
            assertTrue(helper.name, Files.isSymbolicLink(helper.toPath()))
            val target = Files.readSymbolicLink(helper.toPath())
            assertEquals(helper.name, paths.nativeLibraryDir.toPath(), target.parent)
            assertTrue(helper.name, Files.isRegularFile(target))
        }
        assertTrue(helpers.any { it.name == "git-remote-https" })
        report("helpers", "${helpers.size} links resolve into ${paths.nativeLibraryDir}")
    }

    /** Times every npm extraction strategy on this device, in a throwaway directory. */
    @Test
    fun npmExtractionStrategies() {
        val manifest = RuntimeManifest.parse(context.assets.open(RuntimeManifest.ASSET).use { it.readBytes() })
        val archive = NpmArchive.open(context.assets.open(RuntimeManifest.NPM_ARCHIVE).use { it.readBytes() }, manifest.npm)
        val rounds = arguments.getString("rounds")?.toInt() ?: 3
        val scratch = File(context.filesDir, "measure-npm")
        LayoutFiles.deleteTree(scratch.toPath())
        val timings = linkedMapOf<NpmSyncMode, MutableList<Long>>()
        try {
            repeat(rounds) { round ->
                NpmSyncMode.entries.forEach { mode ->
                    val target = File(scratch, "$mode-$round")
                    val started = System.nanoTime()
                    archive.extractTo(target, mode)
                    timings.getOrPut(mode) { mutableListOf() }.add((System.nanoTime() - started) / 1_000_000)
                    LayoutFiles.deleteTree(target.toPath())
                }
            }
        } finally {
            LayoutFiles.deleteTree(scratch.toPath())
        }
        report(
            "npm",
            "files=${archive.files} bytes=${archive.contentBytes} " +
                timings.entries.joinToString(" ") { (mode, millis) -> "$mode=${millis.joinToString("/")}ms" },
        )
    }

    private fun run(paths: RuntimePaths, vararg command: String): Pair<Int, String> {
        val builder = ProcessBuilder(*command).directory(paths.homeDir).redirectErrorStream(true)
        val environment = builder.environment()
        val inherited = environment.filterKeys { it in FRAMEWORK_ROOTS }
        environment.clear()
        environment.putAll(inherited)
        // The §2.5 essentials for running the bundled tools.
        environment.putAll(
            mapOf(
                "PATH" to "${paths.binDir}:/system/bin",
                "HOME" to paths.homeDir.path,
                "TMPDIR" to paths.tmpDir.path,
                "LD_LIBRARY_PATH" to paths.nativeLibraryDir.path,
                "GIT_EXEC_PATH" to paths.gitExecPath.path,
                "GIT_TEMPLATE_DIR" to paths.gitTemplateDir.path,
                "GIT_CONFIG_NOSYSTEM" to "1",
                "GIT_ATTR_NOSYSTEM" to "1",
                "GIT_SSL_CAINFO" to paths.caBundle.path,
                "SSL_CERT_FILE" to paths.caBundle.path,
                "CURL_CA_BUNDLE" to paths.caBundle.path,
                "OPENSSL_CONF" to "/dev/null",
                "OPENSSL_MODULES" to paths.opensslModulesDir.path,
                "SILLYBUNNY_ANDROID_NPM_CLI" to paths.npmCli.path,
                "SILLYBUNNY_ANDROID_NPX_CLI" to paths.npxCli.path,
            ),
        )
        val process = builder.start()
        process.outputStream.close()
        val output = process.inputStream.bufferedReader().use { it.readText() }
        assertTrue(command.joinToString(" "), process.waitFor(120, TimeUnit.SECONDS))
        return process.exitValue() to output.trim()
    }

    private fun ready(result: RuntimeLayoutResult): RuntimeLayoutResult.Ready {
        assertTrue(result.toString(), result is RuntimeLayoutResult.Ready)
        return result as RuntimeLayoutResult.Ready
    }

    private fun report(key: String, value: String) {
        Log.i(TAG, "$key: $value")
        instrumentation.sendStatus(REPORT_CODE, Bundle().apply { putString("runtime-$key", value) })
    }

    private companion object {
        const val TAG = "SillyBunnyRuntime"
        const val REPORT_CODE = 2
        val FRAMEWORK_ROOTS = setOf("ANDROID_ROOT", "ANDROID_DATA", "ANDROID_TZDATA_ROOT", "ANDROID_ART_ROOT", "ANDROID_I18N_ROOT")
    }
}
