package io.github.sillybunnyteam.sillybunny.runtime

import java.io.File
import java.io.IOException
import java.nio.file.DirectoryIteratorException
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.Paths
import java.nio.file.StandardCopyOption
import java.util.UUID

/**
 * Makes `filesDir/runtime` match the installed APK (plan §2.2, §2.4 step 1).
 *
 * `filesDir/runtime` is a relative symlink to one finished generation directory, `runtime-<32 hex>`. A
 * refresh builds a new generation beside it, writes `installed-runtime.json` last, then renames a new link
 * over `runtime` in one atomic rename(2). The previous generation stays until that rename has succeeded.
 * An interrupted run leaves only generations and links that `runtime` does not name; the next call deletes
 * them and never accepts them. Executables are never copied: every link targets the current
 * `nativeLibraryDir`.
 */
internal class RuntimeLayoutInstaller(
    private val paths: RuntimePaths,
    private val source: RuntimeSource,
    private val npmSyncMode: NpmSyncMode,
    private val checkpoint: (Step) -> Unit = {},
) {
    /** Points where a test can interrupt a refresh: the new tree is complete; its link exists. */
    enum class Step { STAGED, LINKED }

    fun ensure(): RuntimeLayoutResult {
        val started = System.nanoTime()
        return try {
            createDataDirectories()
            val manifestBytes = read(RuntimeManifest.ASSET, RuntimeManifest.MAX_BYTES, Reason.MANIFEST)
            val manifest = RuntimeManifest.parse(manifestBytes)
            val fingerprint = ApkFingerprint(
                versionCode = source.versionCode,
                lastUpdateTime = source.lastUpdateTime,
                nativeLibraryDir = paths.nativeLibraryDir.path,
                manifestSha256 = manifest.sha256,
            )
            val current = currentGeneration()
            val installed = current?.let(::readInstalled)
            removeLeftovers(keep = current)
            val reasons = installed?.refreshReasons(fingerprint) ?: setOf(RefreshReason.MISSING)
            if (installed != null && reasons.isEmpty()) {
                RuntimeLayoutResult.Ready(paths, installed, reasons, elapsedMillis(started))
            } else {
                val (generation, record) = build(manifest, fingerprint)
                publish(generation)
                removeLeftovers(keep = generation)
                RuntimeLayoutResult.Ready(paths, record, reasons, elapsedMillis(started))
            }
        } catch (error: RuntimeLayoutException) {
            RuntimeLayoutResult.Failed(error)
        } catch (error: IOException) {
            RuntimeLayoutResult.Failed(RuntimeLayoutException(Reason.STORAGE, error))
        }
    }

    /** HOME, status, logs and TMPDIR (plan §2.2, §2.5) exist before anything is spawned. */
    private fun createDataDirectories() {
        listOf(paths.filesDir, paths.homeDir, paths.statusDir, paths.logsDir, paths.cacheDir, paths.tmpDir).forEach {
            if (!it.isDirectory && !it.mkdirs() && !it.isDirectory) throw RuntimeLayoutException(Reason.STORAGE)
        }
    }

    /** The generation `runtime` names, or null when it is missing, not a symlink or names anything else. */
    private fun currentGeneration(): File? {
        val link = paths.runtimeDir.toPath()
        if (!Files.isSymbolicLink(link)) return null
        val target = Files.readSymbolicLink(link).toString()
        if (!GENERATION.matches(target)) return null
        return File(paths.filesDir, target).takeIf { Files.isDirectory(it.toPath(), LinkOption.NOFOLLOW_LINKS) }
    }

    private fun readInstalled(generation: File): InstalledRuntime? {
        val record = inside(generation, paths.installedRuntime)
        if (!Files.isRegularFile(record.toPath(), LinkOption.NOFOLLOW_LINKS)) return null
        return try {
            InstalledRuntime.parse(LayoutFiles.readBounded(record.inputStream(), InstalledRuntime.MAX_BYTES, Reason.STORAGE))
        } catch (_: IOException) {
            null
        }
    }

    /** Deletes generations, links and moved-aside trees that are not [keep]; failures retry next launch. */
    private fun removeLeftovers(keep: File?) {
        paths.filesDir.listFiles().orEmpty().forEach { entry ->
            if (entry.name == keep?.name || !(GENERATION.matches(entry.name) || LEFTOVER.matches(entry.name))) {
                return@forEach
            }
            try {
                LayoutFiles.deleteTree(entry.toPath())
            } catch (_: IOException) {
                // A leftover is never named by `runtime`, so it is harmless until the next attempt.
            } catch (_: DirectoryIteratorException) {
                // Same as above, raised while listing a leftover directory.
            }
        }
    }

    private fun build(manifest: RuntimeManifest, fingerprint: ApkFingerprint): Pair<File, InstalledRuntime> {
        val abi = manifest.matchAbi(paths.nativeLibraryDir) ?: throw RuntimeLayoutException(Reason.NATIVES)
        val natives = manifest.natives.getValue(abi)
        val generation = File(paths.filesDir, "runtime-" + UUID.randomUUID().toString().replace("-", ""))
        Files.createDirectory(generation.toPath())
        val directories = mutableListOf(generation.toPath())

        fun directory(file: File): File {
            val path = file.toPath()
            if (!Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS)) {
                file.parentFile?.let(::directory)
                Files.createDirectory(path)
                directories.add(path)
            }
            return file
        }

        try {
            val bin = directory(inside(generation, paths.binDir))
            binLinks().forEach { (name, native) -> Files.createSymbolicLink(File(bin, name).toPath(), native.toPath()) }

            val linkText = String(readVerified(RuntimeManifest.GIT_CORE_LINKS, manifest), Charsets.UTF_8)
            val links = GitCoreLinks.parse(linkText, natives.keys)
            if (links.size != manifest.gitCoreLinkCount) throw RuntimeLayoutException(Reason.LINKS)
            val gitCore = directory(inside(generation, paths.gitExecPath))
            links.forEach { (name, native) ->
                Files.createSymbolicLink(File(gitCore, name).toPath(), File(paths.nativeLibraryDir, native).toPath())
            }

            val templates = directory(inside(generation, paths.gitTemplateDir))
            manifest.assets.filterKeys { it.startsWith(RuntimeManifest.GIT_TEMPLATES) }.forEach { (asset, record) ->
                val file = File(templates, asset.removePrefix(RuntimeManifest.GIT_TEMPLATES))
                directory(file.parentFile!!)
                copyAsset(asset, record, file)
            }
            val caBundle = inside(generation, paths.caBundle)
            directory(caBundle.parentFile!!)
            copyAsset(RuntimeManifest.CA_BUNDLE, manifest.assets.getValue(RuntimeManifest.CA_BUNDLE), caBundle)
            directory(inside(generation, paths.opensslModulesDir))

            // npm.json must agree with the manifest, and the archive with npm.json, before anything is extracted.
            val npm = RuntimeManifest.parseNpmRecord(readVerified(RuntimeManifest.NPM_JSON, manifest))
            if (npm != manifest.npm) throw RuntimeLayoutException(Reason.NPM_ARCHIVE)
            val archive = NpmArchive.open(read(RuntimeManifest.NPM_ARCHIVE, NpmArchive.MAX_ARCHIVE_BYTES, Reason.NPM_ARCHIVE), npm)
            val npmPackage = inside(generation, paths.npmPackageDir)
            // Created here so the directory sync below covers npm's parents; the archive syncs its own tree.
            directory(npmPackage.parentFile!!)
            archive.extractTo(npmPackage, npmSyncMode)

            val installed = InstalledRuntime(
                fingerprint = fingerprint,
                abi = abi,
                versions = manifest.versions,
                gitCoreLinks = links.size,
                npmFiles = archive.files,
                npmContentBytes = archive.contentBytes,
                npmDigest = archive.digest,
                npmSyncMode = npmSyncMode,
            )
            // Written last: a generation holding this record is complete.
            LayoutFiles.writeNew(inside(generation, paths.installedRuntime).toPath(), installed.toJson().toByteArray(Charsets.UTF_8))
            directories.forEach(LayoutFiles::syncDirectory)
            checkpoint(Step.STAGED)
            return generation to installed
        } catch (error: IOException) {
            deleteQuietly(generation.toPath())
            throw error
        }
    }

    private fun publish(generation: File) {
        val id = generation.name.removePrefix("runtime-")
        val link = File(paths.filesDir, "runtime.link-$id").toPath()
        try {
            Files.createSymbolicLink(link, Paths.get(generation.name))
            checkpoint(Step.LINKED)
            val runtime = paths.runtimeDir.toPath()
            if (Files.exists(runtime, LinkOption.NOFOLLOW_LINKS) && !Files.isSymbolicLink(runtime)) {
                // A real directory here was never published by this installer; the leftover cleanup deletes it.
                Files.move(runtime, File(paths.filesDir, "runtime.old-$id").toPath(), StandardCopyOption.ATOMIC_MOVE)
            }
            // rename(2) replaces the previous link in one step, so `runtime` always names a complete tree.
            Files.move(link, runtime, StandardCopyOption.ATOMIC_MOVE)
        } catch (error: IOException) {
            deleteQuietly(link)
            deleteQuietly(generation.toPath())
            throw error
        }
        LayoutFiles.syncDirectory(paths.filesDir.toPath())
    }

    private fun binLinks(): Map<String, File> = mapOf(
        "node" to paths.node,
        "git" to paths.git,
        "bash" to paths.bash,
        "npm" to paths.npm,
        "npx" to paths.npx,
    )

    /** [file], a path below `runtime/` in [RuntimePaths], placed inside [generation] instead. */
    private fun inside(generation: File, file: File): File = File(generation, file.relativeTo(paths.runtimeDir).path)

    private fun read(asset: String, limit: Int, reason: Reason): ByteArray = try {
        LayoutFiles.readBounded(source.open(asset), limit, reason)
    } catch (error: RuntimeLayoutException) {
        throw error
    } catch (error: IOException) {
        // Includes FileNotFoundException: an APK without this asset cannot be laid out.
        throw RuntimeLayoutException(reason, error)
    }

    private fun readVerified(asset: String, manifest: RuntimeManifest): ByteArray {
        val record = manifest.assets[asset] ?: throw RuntimeLayoutException(Reason.ASSET)
        val limit = minOf(record.size, RuntimeManifest.MAX_BYTES.toLong()).toInt()
        val bytes = read(asset, limit, Reason.ASSET)
        if (bytes.size.toLong() != record.size || RuntimeManifest.sha256(bytes) != record.sha256) {
            throw RuntimeLayoutException(Reason.ASSET)
        }
        return bytes
    }

    private fun copyAsset(asset: String, record: RuntimeFileRecord, target: File) {
        val input = try {
            source.open(asset)
        } catch (error: IOException) {
            throw RuntimeLayoutException(Reason.ASSET, error)
        }
        LayoutFiles.copyVerified(input, target.toPath(), record)
    }

    private fun deleteQuietly(path: Path) {
        try {
            LayoutFiles.deleteTree(path)
        } catch (_: IOException) {
            // Removed by the leftover cleanup of the next launch.
        } catch (_: DirectoryIteratorException) {
            // Same as above.
        }
    }

    private fun elapsedMillis(started: Long): Long = (System.nanoTime() - started) / 1_000_000

    private companion object {
        val GENERATION = Regex("runtime-[0-9a-f]{32}")
        val LEFTOVER = Regex("runtime\\.(link|old)-[0-9a-f]{32}")
    }
}

private typealias Reason = RuntimeLayoutException.Reason
