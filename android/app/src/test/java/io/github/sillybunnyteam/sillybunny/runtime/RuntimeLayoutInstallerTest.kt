package io.github.sillybunnyteam.sillybunny.runtime

import androidx.test.core.app.ApplicationProvider
import io.github.sillybunnyteam.sillybunny.runtime.RuntimeLayoutException.Reason
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.io.File
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.Paths

@RunWith(RobolectricTestRunner::class)
class RuntimeLayoutInstallerTest {
    @get:Rule
    val temporary = TemporaryFolder()

    private lateinit var payload: RuntimeTestPayload

    private val runtime: Path get() = payload.paths.runtimeDir.toPath()

    @Before
    fun setUp() {
        payload = RuntimeTestPayload(temporary.newFolder("app"))
    }

    @Test
    fun firstLayoutMatchesThePlan() {
        val result = ready(payload.installer().ensure())
        assertEquals(setOf(RefreshReason.MISSING), result.refreshReasons)
        val paths = payload.paths
        assertTrue(Files.isSymbolicLink(runtime))
        assertTrue(GENERATION.matches(Files.readSymbolicLink(runtime).toString()))

        val bin = mapOf("node" to "libnode.so", "git" to "libgit.so", "bash" to "libbash.so", "npm" to "libnpm.so", "npx" to "libnpx.so")
        bin.forEach { (name, native) ->
            assertEquals(File(paths.nativeLibraryDir, native).toPath(), Files.readSymbolicLink(File(paths.binDir, name).toPath()))
        }
        assertEquals(bin.keys, paths.binDir.list()!!.toSet())
        val helpers = paths.gitExecPath.listFiles()!!.sortedBy { it.name }
        assertEquals(listOf("git", "git-add", "git-remote-http", "git-remote-https"), helpers.map { it.name })
        helpers.forEach { helper ->
            val target = Files.readSymbolicLink(helper.toPath())
            assertEquals(paths.nativeLibraryDir.toPath(), target.parent)
            assertTrue(helper.isFile)
        }
        assertEquals("libgit-remote-http.so", Files.readSymbolicLink(File(paths.gitExecPath, "git-remote-https").toPath()).fileName.toString())

        assertEquals("Unnamed repository\n", File(paths.gitTemplateDir, "description").readText())
        assertEquals("#!/bin/sh\n", File(paths.gitTemplateDir, "hooks/pre-commit.sample").readText())
        assertEquals("# exclude\n", File(paths.gitTemplateDir, "info/exclude").readText())
        assertEquals("-----BEGIN CERTIFICATE-----\n", paths.caBundle.readText())
        assertEquals(0, paths.opensslModulesDir.list()!!.size)
        assertEquals("require('../lib/cli.js')(process)\n", paths.npmCli.readText())
        assertTrue(paths.npxCli.isFile)
        assertEquals("lorum\n", File(paths.npmPackageDir, ".npmrc").readText())

        val installed = InstalledRuntime.parse(paths.installedRuntime.readBytes())
        assertEquals(result.installed, installed)
        assertEquals("x86_64", installed!!.abi)
        assertEquals(ApkFingerprint(7, 1_000, paths.nativeLibraryDir.path, sha256(RuntimeManifest.ASSET)), installed.fingerprint)
        assertEquals(4, installed.gitCoreLinks)
        assertEquals(5, installed.npmFiles)
        assertEquals(NpmSyncMode.BATCHED, installed.npmSyncMode)
        listOf(paths.homeDir, paths.statusDir, paths.logsDir, paths.tmpDir).forEach { assertTrue(it.path, it.isDirectory) }

        // Executables are only ever linked: no regular file in the layout is a native.
        val regular = paths.runtimeDir.walkTopDown().filter { Files.isRegularFile(it.toPath(), LinkOption.NOFOLLOW_LINKS) }
        assertTrue(regular.none { it.name.endsWith(".so") })
        assertEquals(listOf(Files.readSymbolicLink(runtime).toString()), generations())
    }

    @Test
    fun matchingLayoutIsKept() {
        ready(payload.installer().ensure())
        val generation = Files.readSymbolicLink(runtime)
        val second = ready(payload.installer().ensure())
        assertTrue(second.refreshReasons.isEmpty())
        assertFalse(second.refreshed)
        assertEquals(generation, Files.readSymbolicLink(runtime))
    }

    @Test
    fun everyFingerprintChangeRefreshes() {
        ready(payload.installer().ensure())
        refreshesWith(setOf(RefreshReason.VERSION_CODE)) { payload.versionCode++ }
        refreshesWith(setOf(RefreshReason.LAST_UPDATE_TIME)) { payload.lastUpdateTime += 5 }
        refreshesWith(setOf(RefreshReason.NATIVE_LIBRARY_DIR, RefreshReason.LAST_UPDATE_TIME)) { payload.reinstall() }
        refreshesWith(setOf(RefreshReason.MANIFEST)) {
            payload.assets["runtime/git-templates/description"] = "Changed\n".toByteArray()
            payload.writeManifest()
        }
        refreshesWith(setOf(RefreshReason.VERSION_CODE, RefreshReason.MANIFEST, RefreshReason.NATIVE_LIBRARY_DIR, RefreshReason.LAST_UPDATE_TIME)) {
            payload.versionCode++
            payload.reinstall()
            payload.assets[RuntimeManifest.CA_BUNDLE] = "new bundle\n".toByteArray()
            payload.writeManifest()
        }
        val paths = payload.paths
        assertEquals(File(paths.nativeLibraryDir, "libnode.so").toPath(), Files.readSymbolicLink(File(paths.binDir, "node").toPath()))
        assertEquals("Changed\n", File(paths.gitTemplateDir, "description").readText())
        assertEquals("new bundle\n", paths.caBundle.readText())
    }

    @Test
    fun missingOrDamagedRecordsRefresh() {
        ready(payload.installer().ensure())
        val record = payload.paths.installedRuntime

        record.writeText("{")
        assertEquals(setOf(RefreshReason.MISSING), ready(payload.installer().ensure()).refreshReasons)

        record.writeText(JSONObject(record.readText()).put("schema", 2).toString())
        assertEquals(setOf(RefreshReason.MISSING), ready(payload.installer().ensure()).refreshReasons)

        record.writeText(JSONObject(record.readText()).put("versionCode", "7").toString())
        assertEquals(setOf(RefreshReason.MISSING), ready(payload.installer().ensure()).refreshReasons)

        assertTrue(record.delete())
        assertEquals(setOf(RefreshReason.MISSING), ready(payload.installer().ensure()).refreshReasons)

        Files.delete(runtime)
        assertEquals(setOf(RefreshReason.MISSING), ready(payload.installer().ensure()).refreshReasons)
        assertEquals(1, generations().size)

        val foreign = temporary.newFolder("foreign")
        File(foreign, "keep").writeText("keep")
        Files.delete(runtime)
        Files.createSymbolicLink(runtime, foreign.toPath())
        assertEquals(setOf(RefreshReason.MISSING), ready(payload.installer().ensure()).refreshReasons)
        assertEquals("keep", File(foreign, "keep").readText())
        assertTrue(GENERATION.matches(Files.readSymbolicLink(runtime).toString()))
        assertTrue(ready(payload.installer().ensure()).refreshReasons.isEmpty())
    }

    @Test
    fun legacyDirectoryIsReplaced() {
        File(payload.filesDir, "runtime/bin").mkdirs()
        File(payload.filesDir, "runtime/bin/node").writeText("an executable copy")
        assertEquals(setOf(RefreshReason.MISSING), ready(payload.installer().ensure()).refreshReasons)
        assertTrue(Files.isSymbolicLink(runtime))
        assertTrue(Files.isSymbolicLink(File(payload.paths.binDir, "node").toPath()))
        assertEquals(listOf(Files.readSymbolicLink(runtime).toString()), payload.filesDir.list()!!.filter { it.startsWith("runtime") && it != "runtime" })
    }

    @Test
    fun interruptedRefreshIsNeverAccepted() {
        ready(payload.installer().ensure())
        val first = Files.readSymbolicLink(runtime).toString()
        payload.reinstall()
        val leftovers = mutableSetOf<String>()
        RuntimeLayoutInstaller.Step.entries.forEach { step ->
            assertThrows(step.name, Interrupted::class.java) {
                payload.installer { if (it == step) throw Interrupted() }.ensure()
            }
            // The previous layout stays published; the interrupted tree is complete but never named by `runtime`.
            assertEquals(first, Files.readSymbolicLink(runtime).toString())
            val staged = generations() - first
            assertEquals(1, staged.size)
            assertTrue(File(payload.filesDir, "${staged.single()}/installed-runtime.json").isFile)
            leftovers += staged
        }
        assertEquals(1, payload.filesDir.list()!!.count { it.startsWith("runtime.link-") })

        val result = ready(payload.installer().ensure())
        assertEquals(setOf(RefreshReason.NATIVE_LIBRARY_DIR, RefreshReason.LAST_UPDATE_TIME), result.refreshReasons)
        val published = Files.readSymbolicLink(runtime).toString()
        assertFalse(published in leftovers)
        assertNotEquals(first, published)
        assertEquals(listOf(published), generations())
        assertEquals(0, payload.filesDir.list()!!.count { it.startsWith("runtime.link-") })
    }

    @Test
    fun failedSwapKeepsThePreviousLayout() {
        ready(payload.installer().ensure())
        val first = Files.readSymbolicLink(runtime).toString()
        payload.versionCode++
        // Removing the new link right before the rename makes rename(2) fail.
        val result = payload.installer { step ->
            if (step == RuntimeLayoutInstaller.Step.LINKED) {
                payload.filesDir.listFiles()!!.filter { it.name.startsWith("runtime.link-") }.forEach { Files.delete(it.toPath()) }
            }
        }.ensure()
        assertEquals(Reason.STORAGE, failed(result).reason)
        assertEquals(first, Files.readSymbolicLink(runtime).toString())
        assertEquals(listOf(first), generations())
        assertEquals(7L, InstalledRuntime.parse(payload.paths.installedRuntime.readBytes())!!.fingerprint.versionCode)
        assertEquals(setOf(RefreshReason.VERSION_CODE), ready(payload.installer().ensure()).refreshReasons)
    }

    @Test
    fun failedBuildKeepsThePreviousLayout() {
        ready(payload.installer().ensure())
        val first = Files.readSymbolicLink(runtime).toString()
        payload.versionCode++
        // The manifest still lists the original bundle, so the tampered asset fails its hash.
        payload.assets[RuntimeManifest.CA_BUNDLE] = "tampered\n".toByteArray()
        assertEquals(Reason.ASSET, failed(payload.installer().ensure()).reason)
        assertEquals(first, Files.readSymbolicLink(runtime).toString())
        assertEquals(listOf(first), generations())
        assertEquals("-----BEGIN CERTIFICATE-----\n", payload.paths.caBundle.readText())
    }

    @Test
    fun payloadProblemsFailWithTheirReason() {
        val cases = listOf<Pair<Reason, RuntimeTestPayload.() -> Unit>>(
            Reason.MANIFEST to { assets.remove(RuntimeManifest.ASSET) },
            Reason.MANIFEST to { assets[RuntimeManifest.ASSET] = "{}".toByteArray() },
            Reason.NATIVES to { File(nativeLibraryDir, "libgit.so").delete() },
            Reason.NATIVES to { File(nativeLibraryDir, "libnode.so").appendText("longer") },
            Reason.ASSET to { assets.remove("runtime/git-templates/info/exclude") },
            Reason.ASSET to { assets[RuntimeManifest.GIT_CORE_LINKS] = "git\tlibgit.so\n".toByteArray() },
            Reason.LINKS to {
                assets[RuntimeManifest.GIT_CORE_LINKS] = "../git\tlibgit.so\n".toByteArray()
                writeManifest()
            },
            Reason.LINKS to {
                assets[RuntimeManifest.GIT_CORE_LINKS] = "git\tlibnot-packaged.so\n".toByteArray()
                writeManifest()
            },
            Reason.LINKS to {
                // Valid lines, but fewer than the manifest's gitCoreLinkCount.
                assets[RuntimeManifest.GIT_CORE_LINKS] = "git\tlibgit.so\n".toByteArray()
                writeManifest()
            },
            Reason.NPM_ARCHIVE to { setNpmJson(npm.copy(version = "0.0.1")) },
            Reason.NPM_ARCHIVE to {
                val zip = TestZip.build(TestZip.file("../escape.js", "x"))
                setNpm(zip, TestZip.record(zip, 1, 1))
            },
            Reason.NPM_ARCHIVE to {
                val zip = TestZip.build(TestZip.Item("link", "x".toByteArray(), mode = TestZip.LINK_MODE))
                setNpm(zip, TestZip.record(zip, 1, 1))
            },
            Reason.NPM_ARCHIVE to {
                // npm.json and the manifest agree, but the archive bytes differ from both.
                assets[RuntimeManifest.NPM_ARCHIVE] = TestZip.build(TestZip.file("other.js", "x"))
            },
        )
        cases.forEachIndexed { index, (reason, breakPayload) ->
            val broken = RuntimeTestPayload(temporary.newFolder("case-$index"))
            broken.breakPayload()
            val error = failed(broken.installer().ensure())
            assertEquals("case $index", reason, error.reason)
            assertEquals("lorum ipsum", error.message)
            assertFalse("case $index", Files.exists(broken.paths.runtimeDir.toPath(), LinkOption.NOFOLLOW_LINKS))
            assertEquals("case $index", 0, broken.filesDir.list()!!.count { it.startsWith("runtime") })
            assertTrue(broken.paths.homeDir.isDirectory)
        }
    }

    @Test
    fun leftoverCleanupTouchesOnlyRuntimeLeftovers() {
        val files = payload.filesDir
        File(files, "SillyBunny/data").mkdirs()
        File(files, "SillyBunny/data/keep.txt").writeText("keep")
        File(files, "runtime-notes.txt").writeText("keep")
        val stale = File(files, "runtime-" + "a".repeat(32))
        File(stale, "bin").mkdirs()
        val outside = File(temporary.root, "outside.txt").apply { writeText("keep") }
        val outsideDir = temporary.newFolder("outside-dir")
        File(outsideDir, "keep").writeText("keep")
        // Deleting a leftover removes its links, never what they point to.
        Files.createSymbolicLink(File(stale, "bin/node").toPath(), outside.toPath())
        Files.createSymbolicLink(File(stale, "linked-dir").toPath(), outsideDir.toPath())
        val link = File(files, "runtime.link-" + "b".repeat(32)).toPath()
        Files.createSymbolicLink(link, Paths.get(stale.name))
        val moved = File(files, "runtime.old-" + "c".repeat(32)).apply { mkdirs() }

        ready(payload.installer().ensure())
        assertFalse(stale.exists())
        assertFalse(Files.exists(link, LinkOption.NOFOLLOW_LINKS))
        assertFalse(moved.exists())
        assertEquals("keep", outside.readText())
        assertEquals("keep", File(outsideDir, "keep").readText())
        assertEquals("keep", File(files, "SillyBunny/data/keep.txt").readText())
        assertEquals("keep", File(files, "runtime-notes.txt").readText())
        assertEquals(1, generations().size)
    }

    @Test
    fun everySyncModeLaysOutTheSameTree() {
        val digests = NpmSyncMode.entries.map { mode ->
            val local = RuntimeTestPayload(temporary.newFolder("mode-$mode"))
            val installed = ready(local.installer(mode).ensure()).installed
            assertEquals(mode, installed.npmSyncMode)
            assertEquals("lorum\n", File(local.paths.npmPackageDir, ".npmrc").readText())
            installed.npmDigest
        }
        assertEquals(1, digests.toSet().size)
    }

    @Test
    fun ensureRefusesTheMainThread() {
        // Robolectric runs tests on the main looper, where a blocking layout must never run.
        assertThrows(IllegalStateException::class.java) { RuntimeLayout.ensure(ApplicationProvider.getApplicationContext()) }
    }

    private fun refreshesWith(expected: Set<RefreshReason>, change: () -> Unit) {
        val before = Files.readSymbolicLink(runtime).toString()
        change()
        val result = ready(payload.installer().ensure())
        assertEquals(expected, result.refreshReasons)
        val after = Files.readSymbolicLink(runtime).toString()
        assertNotEquals(before, after)
        assertEquals(listOf(after), generations())
        assertTrue(ready(payload.installer().ensure()).refreshReasons.isEmpty())
    }

    private fun generations(): List<String> = payload.filesDir.list()!!.filter { GENERATION.matches(it) }.sorted()

    private fun sha256(asset: String) = RuntimeManifest.sha256(payload.assets.getValue(asset))

    private fun ready(result: RuntimeLayoutResult): RuntimeLayoutResult.Ready {
        assertTrue(result.toString(), result is RuntimeLayoutResult.Ready)
        return result as RuntimeLayoutResult.Ready
    }

    private fun failed(result: RuntimeLayoutResult): RuntimeLayoutException {
        assertTrue(result.toString(), result is RuntimeLayoutResult.Failed)
        return (result as RuntimeLayoutResult.Failed).error
    }

    private class Interrupted : RuntimeException()

    private companion object {
        val GENERATION = Regex("runtime-[0-9a-f]{32}")
    }
}
