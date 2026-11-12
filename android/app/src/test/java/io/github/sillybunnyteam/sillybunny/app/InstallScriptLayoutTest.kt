package io.github.sillybunnyteam.sillybunny.app

import io.github.sillybunnyteam.sillybunny.runtime.InstallScriptLayout
import io.github.sillybunnyteam.sillybunny.runtime.RuntimeLayoutException
import io.github.sillybunnyteam.sillybunny.runtime.RuntimeLayoutResult
import io.github.sillybunnyteam.sillybunny.runtime.RuntimeTestPayload
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.attribute.BasicFileAttributes
import java.nio.file.attribute.PosixFilePermission

/** The bundled `install.sh` inside the published runtime generation: read-only, not executable, and verified. */
@RunWith(RobolectricTestRunner::class)
class InstallScriptLayoutTest {
    @get:Rule
    val temporary = TemporaryFolder()

    private lateinit var payload: RuntimeTestPayload
    private val script = "#!/usr/bin/env bash\necho installing\n".toByteArray()

    private val target: Path get() = payload.paths.installScript.toPath()

    @Before
    fun setUp() {
        payload = RuntimeTestPayload(temporary.newFolder("app"))
        payload.assets[InstallScriptLayout.ASSET] = script
        payload.writeManifest()
    }

    private fun ready(): RuntimeLayoutResult.Ready = payload.installer().ensure() as RuntimeLayoutResult.Ready

    private fun layout(): RuntimeLayoutResult = InstallScriptLayout.ensure(ready(), payload.source)

    private fun permissions() = Files.getPosixFilePermissions(target, LinkOption.NOFOLLOW_LINKS)

    private fun fileKey(): Any = Files.readAttributes(target, BasicFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS).fileKey()

    private fun reason(result: RuntimeLayoutResult) = (result as RuntimeLayoutResult.Failed).error.reason

    @Test
    fun theScriptIsLaidOutReadOnlyInsideTheGeneration() {
        assertTrue(layout() is RuntimeLayoutResult.Ready)
        assertArrayEquals(script, Files.readAllBytes(target))
        assertEquals(setOf(PosixFilePermission.OWNER_READ), permissions())
        assertTrue(Files.isRegularFile(target, LinkOption.NOFOLLOW_LINKS))
        // runtime/ is the generation symlink, so the script belongs to the generation the installer published.
        val generation = payload.paths.runtimeDir.toPath().toRealPath()
        assertTrue(target.toRealPath().startsWith(generation))
        assertEquals("share/sillybunny/install.sh", payload.paths.runtimeDir.toPath().relativize(target).toString())
    }

    @Test
    fun aMatchingScriptIsOnlyRead() {
        layout()
        val key = fileKey()
        assertTrue(layout() is RuntimeLayoutResult.Ready)
        assertEquals(key, fileKey())
    }

    @Test
    fun wrongContentOrPermissionsAreReplaced() {
        layout()
        Files.setPosixFilePermissions(target, setOf(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE))
        Files.write(target, "echo tampered\n".toByteArray())
        Files.setPosixFilePermissions(target, setOf(PosixFilePermission.OWNER_READ))
        assertTrue(layout() is RuntimeLayoutResult.Ready)
        assertArrayEquals(script, Files.readAllBytes(target))

        Files.setPosixFilePermissions(target, setOf(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_EXECUTE))
        assertTrue(layout() is RuntimeLayoutResult.Ready)
        assertEquals(setOf(PosixFilePermission.OWNER_READ), permissions())
        assertFalse(Files.exists(target.resolveSibling(".install.sh.partial"), LinkOption.NOFOLLOW_LINKS))
    }

    @Test
    fun aSymbolicLinkInItsPlaceIsReplacedNotFollowed() {
        layout()
        val elsewhere = temporary.newFile("elsewhere.sh").toPath()
        Files.write(elsewhere, script)
        Files.delete(target)
        Files.createSymbolicLink(target, elsewhere)
        assertTrue(layout() is RuntimeLayoutResult.Ready)
        assertFalse(Files.isSymbolicLink(target))
        assertArrayEquals(script, Files.readAllBytes(elsewhere))
    }

    @Test
    fun aManifestWithoutTheScriptFailsTheLayout() {
        payload.assets.remove(InstallScriptLayout.ASSET)
        payload.writeManifest()
        assertEquals(RuntimeLayoutException.Reason.ASSET, reason(layout()))
    }

    @Test
    fun aScriptThatDiffersFromItsRecordFailsTheLayout() {
        val ready = ready()
        // The asset changes after the manifest recorded it, as a corrupted APK asset would.
        payload.assets[InstallScriptLayout.ASSET] = "echo other\n".toByteArray()
        assertEquals(RuntimeLayoutException.Reason.ASSET, reason(InstallScriptLayout.ensure(ready, payload.source)))
        assertFalse(Files.exists(target, LinkOption.NOFOLLOW_LINKS))
        assertFalse(Files.exists(target.resolveSibling(".install.sh.partial"), LinkOption.NOFOLLOW_LINKS))
    }

    @Test
    fun aManifestOtherThanTheLayoutsFailsTheLayout() {
        val ready = ready()
        payload.assets[InstallScriptLayout.ASSET] = "echo newer\n".toByteArray()
        payload.writeManifest()
        assertEquals(RuntimeLayoutException.Reason.MANIFEST, reason(InstallScriptLayout.ensure(ready, payload.source)))
    }
}
