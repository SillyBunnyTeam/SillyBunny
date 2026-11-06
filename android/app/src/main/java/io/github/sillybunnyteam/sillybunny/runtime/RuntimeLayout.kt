package io.github.sillybunnyteam.sillybunny.runtime

import android.content.Context
import android.os.Looper
import io.github.sillybunnyteam.sillybunny.BuildConfig
import io.github.sillybunnyteam.sillybunny.runtime.RuntimeLayoutException.Reason
import java.io.IOException
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.nio.file.attribute.PosixFilePermission

/**
 * Plan §2.4 step 1: makes `filesDir/runtime` match the installed APK before anything runs from it.
 *
 * Call [ensure] on every launch, off the main thread, before starting the server, the first-run install or
 * Repair, and use only a [RuntimeLayoutResult.Ready] layout. It is idempotent: when `installed-runtime.json`
 * still matches the APK (versionCode, lastUpdateTime, nativeLibraryDir, runtime-manifest SHA-256) it only
 * reads the manifest and that record; otherwise it rebuilds the layout and swaps it in atomically.
 */
object RuntimeLayout {
    /**
     * How npm's files are made durable before the swap. Measured against per-file fsync on the API 29
     * and API 37 emulators (P5.2 report).
     */
    val npmSyncMode = NpmSyncMode.BATCHED

    private val lock = Any()

    fun ensure(context: Context): RuntimeLayoutResult {
        check(Looper.myLooper() != Looper.getMainLooper())
        if (!BuildConfig.HAS_RUNTIME) return RuntimeLayoutResult.Unavailable
        val app = context.applicationContext
        return synchronized(lock) {
            val source = AndroidRuntimeSource(app)
            when (val result = RuntimeLayoutInstaller(RuntimePaths(app), source, npmSyncMode).ensure()) {
                is RuntimeLayoutResult.Ready -> InstallScriptLayout.ensure(result, source)
                else -> result
            }
        }
    }
}

/**
 * Lays out the APK's `install.sh` as [RuntimePaths.installScript], inside the runtime generation that the
 * installer published: first run and Repair run it before any checkout exists. Bash runs it as its script
 * argument, so the file is read-only and not executable.
 *
 * Its SHA-256 is part of `runtime-manifest.json`, so a new script always comes with a new generation. A
 * missing or different file (a launch that stopped between the generation swap and this step) is copied
 * again and renamed into place in one step; a matching one is only read.
 */
internal object InstallScriptLayout {
    const val ASSET = "runtime/install.sh"
    private const val PARTIAL = ".install.sh.partial"
    private val READ_ONLY = setOf(PosixFilePermission.OWNER_READ)

    fun ensure(ready: RuntimeLayoutResult.Ready, source: RuntimeSource): RuntimeLayoutResult = try {
        val bytes = try {
            LayoutFiles.readBounded(source.open(RuntimeManifest.ASSET), RuntimeManifest.MAX_BYTES, Reason.MANIFEST)
        } catch (error: RuntimeLayoutException) {
            throw error
        } catch (error: IOException) {
            throw RuntimeLayoutException(Reason.MANIFEST, error)
        }
        val manifest = RuntimeManifest.parse(bytes)
        // The installer accepted the layout for exactly this manifest; any other would describe another APK.
        if (manifest.sha256 != ready.installed.fingerprint.manifestSha256) throw RuntimeLayoutException(Reason.MANIFEST)
        val record = manifest.assets[ASSET] ?: throw RuntimeLayoutException(Reason.ASSET)
        val target = ready.paths.installScript.toPath()
        if (!matches(target, record)) replace(source, record, target)
        ready
    } catch (error: RuntimeLayoutException) {
        RuntimeLayoutResult.Failed(error)
    } catch (error: IOException) {
        RuntimeLayoutResult.Failed(RuntimeLayoutException(Reason.STORAGE, error))
    }

    private fun matches(target: Path, record: RuntimeFileRecord): Boolean {
        if (!Files.isRegularFile(target, LinkOption.NOFOLLOW_LINKS)) return false
        if (Files.getPosixFilePermissions(target, LinkOption.NOFOLLOW_LINKS) != READ_ONLY) return false
        if (Files.size(target) != record.size) return false
        return RuntimeManifest.sha256(Files.readAllBytes(target)) == record.sha256
    }

    private fun replace(source: RuntimeSource, record: RuntimeFileRecord, target: Path) {
        val directory = checkNotNull(target.parent)
        Files.createDirectories(directory)
        val partial = directory.resolve(PARTIAL)
        Files.deleteIfExists(partial)
        val input = try {
            source.open(ASSET)
        } catch (error: IOException) {
            throw RuntimeLayoutException(Reason.ASSET, error)
        }
        try {
            LayoutFiles.copyVerified(input, partial, record)
            Files.setPosixFilePermissions(partial, READ_ONLY)
            // rename(2) replaces a wrong file in one step, so the script is never seen half written.
            Files.move(partial, target, StandardCopyOption.ATOMIC_MOVE)
        } catch (error: IOException) {
            Files.deleteIfExists(partial)
            throw error
        }
        LayoutFiles.syncDirectory(directory)
    }
}
