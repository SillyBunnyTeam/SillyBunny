// Runtime packaging for the SillyBunny APK (plan §2.1, §4.1, §4.6, §4.9, §5.3; tasks 4.5, 5.2 and 5.3).
//
// Staging contract. Every input is generated and ignored by git, never committed:
// - android/runtime/out/<abi>/jniLibs/*.so and out/<abi>/runtime-files.json: Termux natives
//   (android/runtime/fetch-termux.sh, which replaces the whole out/ directory on every run).
// - android/runtime/out/assets/runtime/{certs/cert.pem,git-core-links.txt,git-templates/}: shared assets.
// - android/runtime/out/licenses/<package>/: the Termux license files (fetch-termux.sh), for the notices.
// - <sillybunny.nodeDir, default android/runtime/node-out>/<abi>/libnode.so plus node.json:
//   {"schema":1,"version":"24.22.0","abis":{"<abi>":{"sha256":"<hex>","size":<bytes>}},"source":{...}}
// - <sillybunny.npmDir, default android/runtime/npm-out>/npm.zip plus npm.json:
//   {"schema":1,"version":"11.19.1","sha256":"<hex>","size":<bytes>,"files":<n>,"contentBytes":<bytes>,
//    "source":{...}}
// - <sillybunny.nodeTarball, default android/runtime/cache/sources/objects/<sources.lock node.source.sha256>>:
//   the pinned Node source tarball, for the notices (android/runtime/build-sources.sh downloads, authenticates
//   and keeps it there).
//
// Order: fetch-termux.sh, fetch-node.py, build-npm.py and build-sources.sh stage the inputs (the release recipe runs
// build-sources.sh before build-npm.py --offline); then Gradle generates the notices and builds. THIRD_PARTY_NOTICES and THIRD_PARTY_NOTICES.json are generated, never staged:
// generate<Variant>SillyBunnyNotices runs android/runtime/notices.py over the Termux license files, the Node
// tarball (LICENSE and deps/npm), the committed android/runtime/licenses/npm texts and the Android library list
// that notices.gradle.kts generates, so fetch-termux.sh replacing out/ cannot drop them.
//
// A debuggable variant packages every split ABI whose inputs are complete, and the notices when their inputs
// exist. Without inputs it still builds, with a warning, no runtime payload and BuildConfig.HAS_RUNTIME=false,
// so builds from `git archive` copies need neither the inputs nor an NDK. Non-debuggable (release) variants, and
// every variant under -PrequireRuntime, need every input for every split ABI, the notices inputs included, and
// fail clearly otherwise. The notices run android/runtime/notices.py, which needs a POSIX host (Linux or macOS;
// WSL on Windows), so on a Windows host they count as missing.
// Every packaged node.json and npm.json must match android/runtime.lock's node and npm pins. A build that requires
// the runtime also fails when npm.json names no source tarball while npm is pinned, and when node.json names none
// once the lock pins a Node binary it packages; a debuggable build only warns about a missing source tarball.
// What the lock leaves unpinned only warns, because the release decision refuses unpinned releases.
// -Psillybunny.ndkDir=<dir> points the trampoline build at an NDK outside the SDK; its revision must
// equal android.ndkVersion.

import groovy.json.JsonSlurper
import java.io.File
import java.io.InputStream
import java.security.MessageDigest
import java.util.Locale
import java.util.Properties
import java.util.zip.ZipEntry
import java.util.zip.ZipFile
import javax.inject.Inject
import org.codehaus.groovy.runtime.InvokerHelper
import org.gradle.process.ExecOperations

/** SHA-256 and byte size of one runtime file. */
data class RuntimeRecord(val sha256: String, val size: Long)

/** Collects every problem of one check, then fails once with all of them. */
class RuntimeProblems(private val title: String) {
    private val items = mutableListOf<String>()

    fun add(problem: String) {
        items += problem
    }

    fun check(condition: Boolean, problem: () -> String) {
        if (!condition) items += problem()
    }

    fun throwIfAny() {
        if (items.isNotEmpty()) {
            throw GradleException(title + items.joinToString("") { "\n  - $it" })
        }
    }
}

/** Shared, script-independent helpers for the runtime packaging tasks. */
abstract class SillyBunnyRuntimeTask : DefaultTask() {
    protected fun sha256(input: InputStream): RuntimeRecord {
        val digest = MessageDigest.getInstance("SHA-256")
        val buffer = ByteArray(1 shl 16)
        var size = 0L
        input.use {
            while (true) {
                val read = it.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
                size += read
            }
        }
        return RuntimeRecord(digest.digest().joinToString("") { "%02x".format(Locale.ROOT, it) }, size)
    }

    protected fun sha256(file: File): RuntimeRecord = sha256(file.inputStream())

    protected fun parseObject(file: File): Map<*, *> =
        JsonSlurper().parse(file) as? Map<*, *> ?: throw GradleException("$file must hold a JSON object.")

    protected fun Map<*, *>.string(key: String, owner: Any): String =
        (this[key] as? String)?.takeIf { it.isNotBlank() } ?: throw GradleException("$owner: \"$key\" must be a string.")

    protected fun Map<*, *>.count(key: String, owner: Any): Long {
        val value = this[key]
        if (value !is Int && value !is Long || (value as Number).toLong() < 0) {
            throw GradleException("$owner: \"$key\" must be a non-negative integer.")
        }
        return (value as Number).toLong()
    }

    protected fun Map<*, *>.sha256(key: String, owner: Any): String =
        string(key, owner).takeIf { SHA256.matches(it) } ?: throw GradleException("$owner: \"$key\" must be lowercase SHA-256 hex.")

    protected fun Map<*, *>.child(key: String, owner: Any): Map<*, *> =
        this[key] as? Map<*, *> ?: throw GradleException("$owner: \"$key\" must be an object.")

    protected fun json(value: Any?, indent: String = ""): String = when (value) {
        null -> "null"
        is String -> buildString {
            append('"')
            value.forEach { character ->
                when {
                    character == '"' -> append("\\\"")
                    character == '\\' -> append("\\\\")
                    character == '\n' -> append("\\n")
                    character.code < 0x20 || character.code > 0x7e -> append("\\u%04x".format(Locale.ROOT, character.code))
                    else -> append(character)
                }
            }
            append('"')
        }
        is Boolean, is Int, is Long, is java.math.BigInteger -> value.toString()
        // JsonSlurper reads every decimal as BigDecimal; the plain form keeps the copied `source` objects byte-stable.
        is java.math.BigDecimal -> value.toPlainString()
        is Map<*, *> -> if (value.isEmpty()) "{}" else value.entries.joinToString(",\n", "{\n", "\n$indent}") {
            "$indent    ${json(it.key.toString())}: ${json(it.value, "$indent    ")}"
        }
        is List<*> -> if (value.isEmpty()) "[]" else value.joinToString(",\n", "[\n", "\n$indent]") {
            "$indent    ${json(it, "$indent    ")}"
        }
        is Number -> throw GradleException("Unsupported number type ${value::class} in the runtime manifest.")
        else -> throw GradleException("Unsupported manifest value ${value::class}.")
    }

    /** Sorted copy of a parsed JSON value, so generated JSON is byte-stable. */
    protected fun canonical(value: Any?): Any? = when (value) {
        is Map<*, *> -> value.entries.associate { it.key.toString() to canonical(it.value) }.toSortedMap()
        is List<*> -> value.map { canonical(it) }
        else -> value
    }

    companion object {
        val SHA256 = Regex("[0-9a-f]{64}")

        // The same path rule the app applies to npm.zip entries before extracting them.
        val SAFE_SEGMENT = Regex("[A-Za-z0-9._@+~-]+")
    }
}

/** Builds the npm/npx trampoline for one ABI with the pinned NDK (plan §4.9). */
abstract class BuildSillyBunnyTrampoline : DefaultTask() {
    @get:InputFile
    @get:PathSensitive(PathSensitivity.NONE)
    abstract val source: RegularFileProperty

    @get:Input
    abstract val target: Property<String>

    @get:Input
    abstract val ndkVersion: Property<String>

    @get:Internal
    abstract val ndkDirectory: DirectoryProperty

    @get:OutputFile
    abstract val output: RegularFileProperty

    @get:Inject
    abstract val execOperations: ExecOperations

    @TaskAction
    fun build() {
        val ndk = ndkDirectory.get().asFile
        val properties = Properties()
        val sourceProperties = File(ndk, "source.properties")
        if (sourceProperties.isFile) sourceProperties.inputStream().use { properties.load(it) }
        val revision = properties.getProperty("Pkg.Revision")
        if (revision != ndkVersion.get()) {
            throw GradleException(
                "The npm/npx trampoline needs NDK ${ndkVersion.get()}, but $ndk has revision ${revision ?: "none"}. " +
                    "Install it in the SDK or pass -Psillybunny.ndkDir=<NDK ${ndkVersion.get()}>.",
            )
        }
        val os = System.getProperty("os.name").lowercase(Locale.ROOT)
        val host = when {
            os.startsWith("windows") -> "windows-x86_64"
            os.startsWith("mac") -> "darwin-x86_64"
            else -> "linux-x86_64"
        }
        val suffix = if (host.startsWith("windows")) ".exe" else ""
        val toolchain = File(ndk, "toolchains/llvm/prebuilt/$host")
        val out = output.get().asFile
        out.parentFile.mkdirs()
        // Same flags as the S2.5 build: PIE, 16 KB LOAD alignment, full RELRO, stripped.
        execOperations.exec {
            commandLine(
                File(toolchain, "bin/clang$suffix").path,
                "--target=${target.get()}",
                "--sysroot=${File(toolchain, "sysroot").path}",
                "-std=c11", "-Oz", "-fPIE", "-pie", "-fvisibility=hidden", "-Wall", "-Wextra", "-Werror",
                "-Wl,--build-id=sha1", "-Wl,-z,max-page-size=16384", "-Wl,-z,relro,-z,now",
                source.get().asFile.path, "-o", out.path,
            )
        }
        execOperations.exec {
            commandLine(File(toolchain, "bin/llvm-strip$suffix").path, "--strip-all", out.path)
        }
    }
}

/**
 * Runs android/runtime/notices.py (p45b): the Termux license files, the pinned Node source tarball (its LICENSE,
 * src/node_version.h and deps/npm, checked against android/runtime/sources.lock), the committed npm license texts
 * and the variant's Android library list give THIRD_PARTY_NOTICES and its index THIRD_PARTY_NOTICES.json.
 */
abstract class GenerateSillyBunnyNotices : DefaultTask() {
    @get:InputFile
    @get:PathSensitive(PathSensitivity.NONE)
    abstract val script: RegularFileProperty

    @get:InputFile
    @get:PathSensitive(PathSensitivity.NONE)
    abstract val runtimeLock: RegularFileProperty

    @get:InputFile
    @get:PathSensitive(PathSensitivity.NONE)
    abstract val sourcesLock: RegularFileProperty

    @get:InputDirectory
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val termuxLicenses: DirectoryProperty

    @get:InputFile
    @get:PathSensitive(PathSensitivity.NONE)
    abstract val nodeTarball: RegularFileProperty

    @get:InputDirectory
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val npmLicenses: DirectoryProperty

    /** notices.gradle.kts's output: android-libraries.json and the license texts it names. */
    @get:InputDirectory
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val androidLibraries: DirectoryProperty

    @get:Input
    abstract val requireNode: Property<Boolean>

    @get:OutputDirectory
    abstract val output: DirectoryProperty

    @get:Inject
    abstract val execOperations: ExecOperations

    @TaskAction
    fun generate() {
        val out = output.get().asFile.also { it.deleteRecursively(); it.mkdirs() }
        val arguments = mutableListOf(
            "python3", "-I", "-B", script.get().asFile.path,
            "--runtime-lock", runtimeLock.get().asFile.path,
            "--sources-lock", sourcesLock.get().asFile.path,
            "--licenses-root", termuxLicenses.get().asFile.path,
            "--node-tarball", nodeTarball.get().asFile.path,
            "--npm-licenses", npmLicenses.get().asFile.path,
            "--android-libraries", androidLibraries.get().file(ANDROID_LIBRARIES).asFile.path,
            "--output-root", File(out, "assets").path,
        )
        if (requireNode.get()) arguments += "--require-node"
        val errors = java.io.ByteArrayOutputStream()
        val result = execOperations.exec {
            commandLine(arguments)
            errorOutput = errors
            isIgnoreExitValue = true
        }
        if (result.exitValue != 0) {
            throw GradleException(
                "android/runtime/notices.py failed (exit ${result.exitValue}): ${errors.toString(Charsets.UTF_8).trim()}",
            )
        }
    }

    companion object {
        // Must equal LibraryNotices.FILE in notices.gradle.kts.
        const val ANDROID_LIBRARIES = "android-libraries.json"
    }
}

/** Verifies the runtime inputs and stages the per-ABI natives, the runtime assets and runtime-manifest.json. */
abstract class PrepareSillyBunnyRuntime : SillyBunnyRuntimeTask() {
    @get:Input
    abstract val abis: ListProperty<String>

    @get:Input
    abstract val missing: ListProperty<String>

    /** generate<Variant>SillyBunnyNotices's output; unset when a debuggable build lacks the notices inputs. */
    @get:Optional
    @get:InputDirectory
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val noticesDirectory: DirectoryProperty

    /** p45b: what a debuggable build lacks for the notices when [noticesDirectory] is unset, for its warning. */
    @get:Input
    abstract val noticesMissing: ListProperty<String>

    /** p45b: true when the build requires the runtime, so pinned payloads must name their source tarball. */
    @get:Input
    abstract val attributionRequired: Property<Boolean>

    @get:Internal
    abstract val termuxDirectory: DirectoryProperty

    @get:Internal
    abstract val nodeDirectory: DirectoryProperty

    @get:Internal
    abstract val npmDirectory: DirectoryProperty

    @get:InputFiles
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val inputFiles: ConfigurableFileCollection

    @get:InputFile
    @get:PathSensitive(PathSensitivity.NONE)
    abstract val runtimeLock: RegularFileProperty

    /** scripts/bootstrap/install.sh: first run and Repair run it before any checkout exists (plan §4.3, §4.7). */
    @get:InputFile
    @get:PathSensitive(PathSensitivity.NONE)
    abstract val installScript: RegularFileProperty

    @get:InputFiles
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val trampolines: ConfigurableFileCollection

    @get:OutputDirectory
    abstract val jniLibsDir: DirectoryProperty

    @get:OutputDirectory
    abstract val assetsDir: DirectoryProperty

    @TaskAction
    fun prepare() {
        val absent = RuntimeProblems("The SillyBunny runtime payload is required for this build, but inputs are missing:")
        missing.get().forEach(absent::add)
        absent.throwIfAny()
        val problems = RuntimeProblems("The SillyBunny runtime inputs are inconsistent:")
        val termux = termuxDirectory.get().asFile
        val nodeDir = nodeDirectory.get().asFile
        val npmDir = npmDirectory.get().asFile
        val jniLibs = jniLibsDir.get().asFile.also { it.deleteRecursively(); it.mkdirs() }
        val assets = assetsDir.get().asFile.also { it.deleteRecursively(); it.mkdirs() }

        val lockFile = runtimeLock.get().asFile
        val lockSha256 = sha256(lockFile).sha256
        val lock = parseObject(lockFile)
        val termuxVersions = sortedMapOf<String, String>()
        (lock.child("termux", lockFile)["packages"] as? List<*>)?.forEach { item ->
            val record = item as? Map<*, *> ?: return@forEach
            termuxVersions[record.string("name", lockFile)] = record.string("version", lockFile)
        }

        val node = parseObject(File(nodeDir, "node.json"))
        problems.check(node["schema"] == 1) { "node.json: schema must be 1" }
        val nodeVersion = node.string("version", "node.json")
        val nodeAbis = node.child("abis", "node.json")
        val nodeSource = node.child("source", "node.json")
        // p45b: read npm.json before the per-ABI checks, so the pin problems are reported with theirs.
        val npmJsonFile = File(npmDir, "npm.json")
        val npm = parseObject(npmJsonFile)
        checkPins(lock, node, npm, abis.get(), attributionRequired.get(), problems)

        val natives = sortedMapOf<String, Any?>()
        var sharedAssets: Map<String, RuntimeRecord>? = null
        var linkCount: Long? = null
        for (abi in abis.get()) {
            val filesJson = File(termux, "$abi/runtime-files.json")
            val files = parseObject(filesJson)
            problems.check(files["schema"] == 1 && files["abi"] == abi) { "$filesJson: schema 1 for $abi expected" }
            problems.check(files["lockSha256"] == lockSha256) {
                "$filesJson was generated from another android/runtime.lock; rerun android/runtime/fetch-termux.sh"
            }
            val records = sortedMapOf<String, RuntimeRecord>()
            (files["files"] as? List<*>).orEmpty().forEach { item ->
                val record = item as? Map<*, *> ?: return@forEach
                val path = record.string("path", filesJson)
                records[path] = RuntimeRecord(record.sha256("sha256", filesJson), record.count("size", filesJson))
            }
            records.forEach { (path, record) ->
                val file = File(termux, path)
                problems.check(file.isFile && sha256(file) == record) { "$file does not match $filesJson" }
            }
            val elfNames = (files["elfs"] as? List<*>).orEmpty().mapNotNull { (it as? Map<*, *>)?.get("name") as? String }.toSet()
            val abiNatives = records.filterKeys { it.startsWith("$abi/jniLibs/") }.mapKeys { it.key.substringAfterLast('/') }
            val present = File(termux, "$abi/jniLibs").list().orEmpty().toSet()
            problems.check(abiNatives.keys == elfNames && present == elfNames) {
                "$termux/$abi/jniLibs must hold exactly the ELFs listed in $filesJson"
            }
            problems.check(elfNames.none { it in TOOL_NATIVES }) { "Termux natives for $abi reuse a Node or trampoline name" }
            val abiAssets = records.filterKeys { it.startsWith("assets/runtime/") }.mapKeys { it.key.removePrefix("assets/") }
            if (sharedAssets == null) sharedAssets = abiAssets
            problems.check(sharedAssets == abiAssets) { "Termux runtime assets differ between ABIs" }
            val count = files.count("gitCoreLinkCount", filesJson)
            if (linkCount == null) linkCount = count
            problems.check(linkCount == count) { "gitCoreLinkCount differs between ABIs" }

            val nodeRecord = (nodeAbis[abi] as? Map<*, *>)?.let {
                RuntimeRecord(it.sha256("sha256", "node.json $abi"), it.count("size", "node.json $abi"))
            }
            val nodeFile = File(nodeDir, "$abi/libnode.so")
            problems.check(nodeRecord != null && nodeFile.isFile && sha256(nodeFile) == nodeRecord) {
                "$nodeFile does not match node.json"
            }
            val trampoline = trampolines.files.singleOrNull { it.parentFile.name == abi }
            problems.check(trampoline?.isFile == true) { "The npm/npx trampoline for $abi was not built" }
            problems.throwIfAny()

            val abiDir = File(jniLibs, abi).also { it.mkdirs() }
            abiNatives.keys.forEach { File(termux, "$abi/jniLibs/$it").copyTo(File(abiDir, it)) }
            nodeFile.copyTo(File(abiDir, "libnode.so"))
            // One binary serves both names; it picks npm or npx from argv[0].
            trampoline!!.copyTo(File(abiDir, "libnpm.so"))
            trampoline.copyTo(File(abiDir, "libnpx.so"))
            val trampolineRecord = sha256(trampoline)
            natives[abi] = sortedMapOf(
                "natives" to (abiNatives + mapOf(
                    "libnode.so" to nodeRecord!!,
                    "libnpm.so" to trampolineRecord,
                    "libnpx.so" to trampolineRecord,
                )).toSortedMap().mapValues { recordJson(it.value) },
            )
        }
        val runtimeAssets = sharedAssets.orEmpty().toSortedMap()
        val links = runtimeAssets["runtime/git-core-links.txt"]
        problems.check(links != null && "runtime/certs/cert.pem" in runtimeAssets) {
            "The Termux runtime assets lack git-core-links.txt or certs/cert.pem"
        }
        val linkLines = File(termux, "assets/runtime/git-core-links.txt").takeIf { it.isFile }?.readLines().orEmpty()
        problems.check(linkLines.count { it.isNotEmpty() }.toLong() == linkCount) {
            "git-core-links.txt does not hold gitCoreLinkCount entries"
        }

        val npmZip = File(npmDir, "npm.zip")
        problems.check(npm["schema"] == 1) { "npm.json: schema must be 1" }
        val npmRecord = RuntimeRecord(npm.sha256("sha256", npmJsonFile), npm.count("size", npmJsonFile))
        val npmFiles = npm.count("files", npmJsonFile)
        val npmContentBytes = npm.count("contentBytes", npmJsonFile)
        val npmVersion = npm.string("version", npmJsonFile)
        val npmSource = npm.child("source", npmJsonFile)
        problems.check(npmZip.isFile && sha256(npmZip) == npmRecord) { "$npmZip does not match npm.json" }
        problems.throwIfAny()
        checkNpmArchive(npmZip, npmFiles, npmContentBytes, problems)
        problems.throwIfAny()

        val assetRecords = sortedMapOf<String, RuntimeRecord>()
        runtimeAssets.forEach { (path, record) ->
            File(termux, "assets/$path").copyTo(File(assets, path))
            assetRecords[path] = record
        }
        npmZip.copyTo(File(assets, NPM_ARCHIVE))
        assetRecords[NPM_ARCHIVE] = npmRecord
        npmJsonFile.copyTo(File(assets, NPM_JSON))
        assetRecords[NPM_JSON] = sha256(npmJsonFile)
        // Recorded like every runtime asset, so the app lays out exactly the script this APK was built with.
        val script = installScript.get().asFile
        script.copyTo(File(assets, INSTALL_SCRIPT))
        assetRecords[INSTALL_SCRIPT] = sha256(script)
        // p45b: the notices come only from generate<Variant>SillyBunnyNotices, never from out/, which fetch-termux.sh
        // replaces and which holds Termux's notices alone.
        val notices = noticesDirectory.orNull?.asFile
        if (notices == null) {
            logger.warn(
                "SillyBunny runtime: the APK ships without ${NOTICES.joinToString(" and ")}, because the notices " +
                    "inputs are missing: ${noticesMissing.get().joinToString("; ")}.",
            )
        }
        NOTICES.forEach { name ->
            val notice = File(notices ?: return@forEach, "assets/$name")
            problems.check(notice.isFile) { "$notice was not generated" }
            if (notice.isFile) {
                notice.copyTo(File(assets, name))
                assetRecords[name] = sha256(notice)
            }
        }
        // `versions` stays a flat name-to-string map: Settings lists it as is.
        val manifest = sortedMapOf(
            "schema" to 1,
            "versions" to sortedMapOf(
                "node" to nodeVersion,
                "npm" to npmVersion,
                "git" to termuxVersions["git"],
                "bash" to termuxVersions["bash"],
            ),
            "termuxPackages" to termuxVersions,
            "abis" to natives,
            "assets" to assetRecords.mapValues { recordJson(it.value) }.toSortedMap(),
            "npm" to sortedMapOf(
                "version" to npmVersion,
                "sha256" to npmRecord.sha256,
                "size" to npmRecord.size,
                "files" to npmFiles,
                "contentBytes" to npmContentBytes,
            ),
            "gitCoreLinkCount" to linkCount,
            "sources" to sortedMapOf(
                "termuxLockSha256" to lockSha256,
                "node" to canonical(nodeSource),
                "npm" to canonical(npmSource),
            ),
        )
        problems.check(termuxVersions["git"] != null && termuxVersions["bash"] != null) {
            "android/runtime.lock does not pin git and bash"
        }
        problems.throwIfAny()
        File(assets, MANIFEST).writeText(json(manifest) + "\n")
    }

    private fun recordJson(record: RuntimeRecord) = sortedMapOf("sha256" to record.sha256, "size" to record.size)

    /**
     * p45b: inputsHash covers android/runtime.lock, so the APK must carry exactly the Node and npm it pins. Each
     * disagreement of node.json or npm.json with the lock's node and npm blocks is a problem that names the field,
     * both values and the producer to rerun.
     *
     * When [attributionRequired] (a build that requires the runtime), a file that names no source tarball is a
     * problem too: npm.json whenever npm is pinned, because the release decision counts npm as pinned by the Node
     * tarball alone and npm.json's source is npm.zip's only tie to it; node.json once the lock pins a binary this
     * build packages, because fetch-node.py's GHCR staging always names the tarball. One warning covers the rest:
     * what the lock leaves unpinned (a null block, or a binary whose sha256 stays null until the runtime workflow
     * first publishes, which the release decision refuses to release), and a missing source tarball in a debuggable
     * build or in node.json while the binaries it packages are unpinned (the only Node builds before the first
     * publish are local ones, such as S2.1's, that no node-build.json ties to the pinned tarball).
     */
    private fun checkPins(
        lock: Map<*, *>,
        node: Map<*, *>,
        npm: Map<*, *>,
        packaged: List<String>,
        attributionRequired: Boolean,
        problems: RuntimeProblems,
    ) {
        val unchecked = mutableListOf<String>()
        fun compare(field: String, staged: Any?, pinField: String, pinned: Any?, producer: String) {
            val same = if (staged is Number && pinned is Number) staged.toLong() == pinned.toLong() else staged == pinned
            problems.check(same) { "$field is ${json(staged)}, but android/runtime.lock $pinField is ${json(pinned)}; rerun $producer" }
        }
        val nodePin = lock["node"] as? Map<*, *>
        val tarballPin = nodePin?.get("source") as? Map<*, *>
        fun checkSourceTarball(file: String, source: Any?, required: Boolean, producer: String) {
            val tarball = (source as? Map<*, *>)?.get("tarball")
            when {
                tarball != null -> {
                    val record = tarball as? Map<*, *>
                    compare("$file source.tarball.filename", record?.get("filename"), "node.source.tarball", tarballPin?.get("tarball"), producer)
                    compare("$file source.tarball.sha256", record?.get("sha256"), "node.source.tarballSha256", tarballPin?.get("tarballSha256"), producer)
                }
                required -> problems.add(
                    "$file source.tarball is absent, but android/runtime.lock node.source.tarball is ${json(tarballPin?.get("tarball"))} " +
                        "(node.source.tarballSha256 ${json(tarballPin?.get("tarballSha256"))}); rerun $producer",
                )
                else -> unchecked += "$file source.tarball (absent)"
            }
        }
        if (nodePin == null) {
            unchecked += "node (null)"
        } else {
            compare("node.json version", node["version"], "node.version", nodePin["version"], FETCH_NODE)
            val binaries = nodePin["binaries"] as? Map<*, *>
            val binaryPinned = packaged.any { abi -> (binaries?.get(abi) as? Map<*, *>)?.get("sha256") != null }
            checkSourceTarball("node.json", node["source"], attributionRequired && binaryPinned, FETCH_NODE)
            val staged = node["abis"] as? Map<*, *>
            packaged.forEach { abi ->
                val pin = binaries?.get(abi) as? Map<*, *>
                if (pin?.get("sha256") == null) {
                    unchecked += "node.binaries.$abi.sha256 (null)"
                } else {
                    val record = staged?.get(abi) as? Map<*, *>
                    compare("node.json abis.$abi.sha256", record?.get("sha256"), "node.binaries.$abi.sha256", pin["sha256"], FETCH_NODE)
                    compare("node.json abis.$abi.size", record?.get("size"), "node.binaries.$abi.size", pin["size"], FETCH_NODE)
                }
            }
        }
        val npmPin = lock["npm"] as? Map<*, *>
        if (npmPin == null) {
            unchecked += "npm (null)"
        } else {
            compare("npm.json version", npm["version"], "npm.version", npmPin["version"], BUILD_NPM)
            // "node" is the only npm source: the copy bundled in the pinned Node source tarball.
            problems.check(npmPin["source"] == "node") { "android/runtime.lock npm.source is ${json(npmPin["source"])}; only \"node\" is supported" }
            checkSourceTarball("npm.json", npm["source"], attributionRequired, BUILD_NPM)
        }
        if (unchecked.isNotEmpty()) {
            logger.warn(
                "SillyBunny runtime: not checked against android/runtime.lock, because it is unpinned or unattributed: " +
                    "${unchecked.joinToString()}. A release build fails without a source tarball once npm, or the Node " +
                    "binaries it packages, are pinned; the release decision refuses unpinned releases.",
            )
        }
    }

    /**
     * Applies the app's npm.zip rules and limits (NpmArchive.open and parse), so an archive every device would
     * reject fails the build instead. Keep the two in step.
     */
    private fun checkNpmArchive(archive: File, files: Long, contentBytes: Long, problems: RuntimeProblems) {
        val bytes = archive.readBytes()
        problems.check(bytes.size <= NPM_MAX_ARCHIVE_BYTES) { "$archive is over the app's $NPM_MAX_ARCHIVE_BYTES-byte limit" }
        val eocd = (bytes.size - 22 downTo maxOf(0, bytes.size - 22 - 0xFFFF)).firstOrNull {
            u32(bytes, it) == 0x06054b50L && it + 22 + u16(bytes, it + 20) == bytes.size
        }
        if (eocd == null) {
            problems.add("$archive has no ZIP end record")
            return
        }
        val total = u16(bytes, eocd + 10)
        val directoryStart = u32(bytes, eocd + 16)
        // One disk, and a central directory that ends right at the end record: no ZIP64 records, no other data.
        if (u16(bytes, eocd + 4) != 0 || u16(bytes, eocd + 6) != 0 || u16(bytes, eocd + 8) != total ||
            total == 0xFFFF || directoryStart + u32(bytes, eocd + 12) != eocd.toLong()
        ) {
            problems.add("$archive spans disks, needs ZIP64 or has data after its central directory")
            return
        }
        var position = directoryStart.toInt()
        val names = mutableSetOf<String>()
        val filePaths = mutableListOf<String>()
        var sum = 0L
        repeat(total) {
            if (position + 46 > eocd || u32(bytes, position) != 0x02014b50L) {
                problems.add("$archive has a malformed central directory")
                return
            }
            val flags = u16(bytes, position + 8)
            val method = u16(bytes, position + 10)
            val compressed = u32(bytes, position + 20)
            val size = u32(bytes, position + 24)
            val nameLength = u16(bytes, position + 28)
            val next = position + 46 + nameLength + u16(bytes, position + 30) + u16(bytes, position + 32)
            val localHeader = u32(bytes, position + 42)
            if (next > eocd || u16(bytes, position + 34) != 0) {
                problems.add("$archive has a malformed central directory")
                return
            }
            // ISO-8859-1 keeps every byte, as in the app; the segment rule then rejects anything outside plain ASCII.
            val name = String(bytes, position + 46, nameLength, Charsets.ISO_8859_1)
            val directory = name.endsWith('/')
            val path = name.removeSuffix("/")
            val segments = path.split('/')
            problems.check(
                path.isNotEmpty() && path.length <= NPM_MAX_PATH && segments.size <= NPM_MAX_DEPTH &&
                    segments.all { it != "." && it != ".." && SAFE_SEGMENT.matches(it) },
            ) { "unsafe npm.zip entry \"$name\"" }
            problems.check(names.add(path)) { "duplicate npm.zip entry \"$name\"" }
            problems.check((flags and 0x2041) == 0 && (method == 0 || method == 8)) { "unsupported npm.zip entry \"$name\"" }
            problems.check(compressed != 0xFFFFFFFFL && size != 0xFFFFFFFFL && localHeader != 0xFFFFFFFFL) {
                "npm.zip entry \"$name\" needs ZIP64"
            }
            // Like the app, read the upper half of the external attributes as a Unix mode whatever the host.
            val type = (u32(bytes, position + 38) ushr 16) and 0xF000
            problems.check(type == 0L || type == (if (directory) 0x4000L else 0x8000L)) {
                "npm.zip entry \"$name\" is a link or special file"
            }
            if (directory) {
                problems.check(size == 0L) { "npm.zip directory entry \"$name\" has content" }
            } else {
                problems.check(method != 0 || compressed == size) { "stored npm.zip entry \"$name\" has mismatched sizes" }
                problems.check(localHeaderMatches(bytes, localHeader, name, method, compressed, directoryStart)) {
                    "npm.zip entry \"$name\" does not match its local header"
                }
                filePaths += path
                sum += size
            }
            position = next
        }
        problems.check(position.toLong() == eocd.toLong()) { "$archive has data between its central directory and end record" }
        problems.check(filePaths.size <= NPM_MAX_FILES && sum <= NPM_MAX_CONTENT_BYTES) {
            "$archive holds ${filePaths.size} files / $sum bytes, over the app's $NPM_MAX_FILES / $NPM_MAX_CONTENT_BYTES limit"
        }
        // A file may not also be the parent directory of another entry.
        val parents = names.flatMap { path -> path.indices.filter { path[it] == '/' }.map { path.substring(0, it) } }.toSet()
        filePaths.filter { it in parents }.forEach { problems.add("npm.zip file \"$it\" is also a directory") }
        problems.check(filePaths.size.toLong() == files && sum == contentBytes) {
            "$archive holds ${filePaths.size} files / $sum bytes, npm.json says $files / $contentBytes"
        }
    }

    /** The app's local-header check: the same method and name, no unsupported flags, data inside the archive. */
    private fun localHeaderMatches(bytes: ByteArray, header: Long, name: String, method: Int, compressed: Long, limit: Long): Boolean {
        if (header + 30 > limit || u32(bytes, header.toInt()) != 0x04034b50L) return false
        val at = header.toInt()
        if (u16(bytes, at + 8) != method || (u16(bytes, at + 6) and 0x2041) != 0) return false
        val nameLength = u16(bytes, at + 26)
        val start = header + 30 + nameLength + u16(bytes, at + 28)
        return start + compressed <= limit && String(bytes, at + 30, nameLength, Charsets.ISO_8859_1) == name
    }

    private fun u16(bytes: ByteArray, at: Int): Int = (bytes[at].toInt() and 0xFF) or ((bytes[at + 1].toInt() and 0xFF) shl 8)

    private fun u32(bytes: ByteArray, at: Int): Long = u16(bytes, at).toLong() or (u16(bytes, at + 2).toLong() shl 16)

    companion object {
        const val MANIFEST = "runtime-manifest.json"
        const val NPM_ARCHIVE = "runtime/npm.zip"
        const val NPM_JSON = "runtime/npm.json"
        const val INSTALL_SCRIPT = "runtime/install.sh"
        val NOTICES = listOf("THIRD_PARTY_NOTICES", "THIRD_PARTY_NOTICES.json")
        val TOOL_NATIVES = setOf("libnode.so", "libnpm.so", "libnpx.so")
        const val FETCH_NODE = "android/runtime/fetch-node.py"
        const val BUILD_NPM = "android/runtime/build-npm.py"

        // NpmArchive's limits.
        const val NPM_MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
        const val NPM_MAX_FILES = 20_000
        const val NPM_MAX_CONTENT_BYTES = 512L * 1024 * 1024
        const val NPM_MAX_PATH = 1024
        const val NPM_MAX_DEPTH = 64
    }
}

/**
 * Checks the built APKs: every runtime native matches runtime-manifest.json, every 64-bit ELF has 16 KB
 * PT_LOAD alignment (ARM32 is reported, not failed), natives stay compressed for extraction, and the
 * runtime assets match the manifest.
 */
abstract class VerifySillyBunnyRuntime : SillyBunnyRuntimeTask() {
    @get:InputFiles
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val apkDirectory: DirectoryProperty

    @get:InputFile
    @get:PathSensitive(PathSensitivity.NONE)
    abstract val manifest: RegularFileProperty

    @get:Input
    abstract val abis: ListProperty<String>

    @get:OutputFile
    abstract val report: RegularFileProperty

    @TaskAction
    fun verify() {
        val problems = RuntimeProblems("The packaged SillyBunny runtime does not match its manifest:")
        val manifestFile = manifest.get().asFile
        val parsed = parseObject(manifestFile)
        val expectedNatives = parsed.child("abis", manifestFile)
        val expectedAssets = parsed.child("assets", manifestFile)
        val manifestRecord = sha256(manifestFile)
        val lines = mutableListOf<String>()
        val apks = apkDirectory.get().asFile.listFiles { file -> file.isFile && file.name.endsWith(".apk") }.orEmpty().sorted()
        problems.check(apks.isNotEmpty()) { "no APK in ${apkDirectory.get().asFile}" }
        val packagedAbis = abis.get().toSortedSet()
        val seen = sortedSetOf<String>()
        val arm32 = mutableListOf<String>()
        for (apk in apks) {
            lines += "${apk.name} (${apk.length()} bytes)"
            ZipFile(apk).use { zip ->
                val libs = zip.entries().asSequence().filter { !it.isDirectory && it.name.startsWith("lib/") }.toList()
                val byAbi = libs.groupBy({ it.name.split('/')[1] }, { it.name.substringAfterLast('/') })
                for ((abi, names) in byAbi.toSortedMap()) {
                    val wanted = (expectedNatives[abi] as? Map<*, *>)?.get("natives") as? Map<*, *>
                    if (abi in packagedAbis) {
                        seen += abi
                        problems.check(wanted != null) { "${apk.name}: the manifest has no natives for $abi" }
                        wanted?.keys?.forEach { name ->
                            problems.check(name in names) { "${apk.name} lacks lib/$abi/$name" }
                        }
                    } else {
                        // A debug split whose inputs are incomplete ships without runtime natives.
                        lines += "  no runtime natives for $abi"
                        problems.check(wanted == null && names.none { it in RUNTIME_TOOLS }) {
                            "${apk.name} carries runtime natives for $abi that the manifest does not describe"
                        }
                    }
                }
                libs.forEach { entry -> checkNative(zip, entry, expectedNatives, problems, lines, arm32) }
                val packagedManifest = zip.getEntry("assets/${PrepareSillyBunnyRuntime.MANIFEST}")
                problems.check(packagedManifest != null && sha256(zip.getInputStream(packagedManifest)) == manifestRecord) {
                    "${apk.name}: assets/${PrepareSillyBunnyRuntime.MANIFEST} differs from the generated manifest"
                }
                expectedAssets.forEach { (path, value) ->
                    val record = value as Map<*, *>
                    val entry = zip.getEntry("assets/$path")
                    problems.check(entry != null && sha256(zip.getInputStream(entry)) == RuntimeRecord(record["sha256"] as String, (record["size"] as Number).toLong())) {
                        "${apk.name}: assets/$path differs from the manifest"
                    }
                }
            }
        }
        problems.check(seen == packagedAbis) { "packaged runtime ABIs $seen, expected $packagedAbis" }
        if (arm32.isNotEmpty()) {
            // Termux's ARM32 packages are 4 KB-aligned by design (P4-T); report them, never fail.
            logger.lifecycle("SillyBunny runtime: ${arm32.size} ARM32 natives keep 4 KB PT_LOAD alignment: ${arm32.joinToString()}")
        }
        report.get().asFile.apply {
            parentFile.mkdirs()
            writeText(lines.joinToString("\n", postfix = "\n"))
        }
        problems.throwIfAny()
        logger.lifecycle("SillyBunny runtime verified: ${seen.joinToString()} (${report.get().asFile})")
    }

    private fun checkNative(
        zip: ZipFile,
        entry: ZipEntry,
        expected: Map<*, *>,
        problems: RuntimeProblems,
        lines: MutableList<String>,
        arm32: MutableList<String>,
    ) {
        val (abi, name) = entry.name.split('/', limit = 3).let { it[1] to it.getOrElse(2) { "" } }
        val head = zip.getInputStream(entry).use { it.readNBytes(1 shl 16) }
        val record = sha256(zip.getInputStream(entry))
        val wanted = ((expected[abi] as? Map<*, *>)?.get("natives") as? Map<*, *>)?.get(name) as? Map<*, *>
        if (wanted != null) {
            problems.check(record == RuntimeRecord(wanted["sha256"] as String, (wanted["size"] as Number).toLong())) {
                "${entry.name} does not match its manifest hash"
            }
        }
        // useLegacyPackaging keeps natives compressed, so the installer extracts them to nativeLibraryDir.
        problems.check(entry.method == ZipEntry.DEFLATED) { "${entry.name} is stored; keep jniLibs.useLegacyPackaging = true" }
        val loads = loads(head)
        if (loads == null) {
            problems.add("${entry.name} is not a little-endian ELF")
            return
        }
        val (elfClass, aligns) = loads
        val minimum = aligns.minOrNull() ?: 0L
        val role = if (wanted != null) "runtime" else "other"
        lines += "  ${entry.name}: $role, ELF$elfClass, ${aligns.size} PT_LOAD, min align 0x${minimum.toString(16)}, sha256 ${record.sha256}"
        if (elfClass == 64) {
            problems.check(aligns.isNotEmpty() && minimum >= 0x4000) { "${entry.name} has PT_LOAD alignment below 16 KB" }
        } else if (minimum < 0x4000) {
            arm32 += name
        }
    }

    /** ELF class and PT_LOAD alignments, or null when [head] is not a little-endian ELF. */
    private fun loads(head: ByteArray): Pair<Int, List<Long>>? {
        if (head.size < 52 || head[0] != 0x7f.toByte() || head[1] != 'E'.code.toByte() ||
            head[2] != 'L'.code.toByte() || head[3] != 'F'.code.toByte() || head[5] != 1.toByte()
        ) {
            return null
        }
        fun u(at: Int, width: Int): Long = (0 until width).fold(0L) { value, index ->
            value or ((head[at + index].toLong() and 0xFF) shl (8 * index))
        }
        val elfClass = if (head[4] == 2.toByte()) 64 else if (head[4] == 1.toByte()) 32 else return null
        val wide = elfClass == 64
        val phoff = if (wide) u(0x20, 8) else u(0x1C, 4)
        val entrySize = u(if (wide) 0x36 else 0x2A, 2).toInt()
        val count = u(if (wide) 0x38 else 0x2C, 2).toInt()
        if (phoff + entrySize.toLong() * count > head.size) return null
        val aligns = (0 until count).mapNotNull { index ->
            val at = (phoff + entrySize.toLong() * index).toInt()
            if (u(at, 4) != 1L) return@mapNotNull null
            val offset = if (wide) u(at + 8, 8) else u(at + 4, 4)
            val vaddr = if (wide) u(at + 16, 8) else u(at + 8, 4)
            val align = if (wide) u(at + 48, 8) else u(at + 28, 4)
            // A LOAD whose offset and address disagree modulo its alignment cannot be mapped at that alignment.
            if (align > 0 && (vaddr - offset) % align != 0L) 0L else align
        }
        return elfClass to aligns
    }

    companion object {
        val RUNTIME_TOOLS = setOf("libnode.so", "libnpm.so", "libnpx.so", "libgit.so", "libbash.so")
    }
}

// A script plugin cannot compile against the Android Gradle Plugin: its classes live in the plugin's
// class loader, and a buildscript copy of the API is a different class. So this script reaches the
// variant API through Groovy's dynamic invoker, the way a Groovy build script reaches it.
fun Any.agpGet(property: String): Any? = InvokerHelper.getProperty(this, property)

fun Any.agpCall(method: String, vararg arguments: Any?): Any? = InvokerHelper.invokeMethod(this, method, arguments)

val sillyBunnyAndroid: Any = extensions.getByName("android")
val sillyBunnyComponents: Any = extensions.getByName("androidComponents")
val runtimeRequired = providers.gradleProperty("requireRuntime").isPresent
val runtimeTermuxDir = rootProject.file("runtime/out")
val runtimeNodeDir = providers.gradleProperty("sillybunny.nodeDir").orNull?.let { rootProject.file(it) }
    ?: rootProject.file("runtime/node-out")
val runtimeNpmDir = providers.gradleProperty("sillybunny.npmDir").orNull?.let { rootProject.file(it) }
    ?: rootProject.file("runtime/npm-out")
val runtimeNdkOverride = providers.gradleProperty("sillybunny.ndkDir").orNull?.let { rootProject.file(it) }

// p45b: the pinned Node source tarball for the notices. build-sources.sh --require-node and build-npm.py keep it in
// the shared download cache under its SHA-256, which android/runtime/sources.lock pins (fetch-node.py does so only
// in build-node.sh's --build-inputs mode).
val runtimeNodeTarball: File? = providers.gradleProperty("sillybunny.nodeTarball").orNull?.let { rootProject.file(it) }
    ?: rootProject.file("runtime/sources.lock").takeIf { it.isFile }?.let { lock ->
        (((JsonSlurper().parse(lock) as? Map<*, *>)?.get("node") as? Map<*, *>)?.get("source") as? Map<*, *>)?.get("sha256") as? String
    }?.let { rootProject.file("runtime/cache/sources/objects/$it") }
val trampolineTargets = mapOf(
    "arm64-v8a" to "aarch64-linux-android",
    "armeabi-v7a" to "armv7a-linux-androideabi",
    "x86_64" to "x86_64-linux-android",
)
val trampolineTasks = mutableMapOf<String, TaskProvider<BuildSillyBunnyTrampoline>>()

fun missingSharedRuntimeInputs(): List<String> = buildList {
    if (!File(runtimeTermuxDir, "assets/runtime/git-core-links.txt").isFile) {
        add("Termux runtime assets in $runtimeTermuxDir/assets/runtime (run android/runtime/fetch-termux.sh)")
    }
    if (!File(runtimeNpmDir, "npm.zip").isFile || !File(runtimeNpmDir, "npm.json").isFile) {
        add("npm: $runtimeNpmDir/npm.zip and npm.json (or -Psillybunny.npmDir=<dir>)")
    }
}

// p45b: android/runtime/notices.py runs only on a POSIX host: it locks its output with fcntl and refuses paths
// holding a backslash. Everything else here, BuildSillyBunnyTrampoline included, still works on a Windows host.
val noticesHostSupported = !System.getProperty("os.name").lowercase(Locale.ROOT).startsWith("windows")

// p45b: a debuggable build only warns when one of these is missing; a build that requires the runtime fails on it.
fun missingNoticeInputs(): List<String> = buildList {
    if (!noticesHostSupported) {
        add("a POSIX host for android/runtime/notices.py (Linux or macOS; on Windows, build in WSL)")
    }
    if (!File(runtimeTermuxDir, "licenses").isDirectory) {
        add("Termux license files in $runtimeTermuxDir/licenses (run android/runtime/fetch-termux.sh)")
    }
    if (runtimeNodeTarball?.isFile != true) {
        add(
            "the pinned Node source tarball ${runtimeNodeTarball ?: "(android/runtime/sources.lock pins no Node)"} for the notices " +
                "(run android/runtime/build-sources.sh --require-node, or pass -Psillybunny.nodeTarball=<file>)",
        )
    }
}

fun missingRuntimeInputs(abi: String): List<String> = buildList {
    if (!File(runtimeTermuxDir, "$abi/runtime-files.json").isFile) {
        add("Termux natives for $abi in $runtimeTermuxDir/$abi (run android/runtime/fetch-termux.sh)")
    }
    if (!File(runtimeNodeDir, "$abi/libnode.so").isFile || !File(runtimeNodeDir, "node.json").isFile) {
        add("Node for $abi: $runtimeNodeDir/$abi/libnode.so and node.json (or -Psillybunny.nodeDir=<dir>)")
    }
    if (abi !in trampolineTargets) add("no npm/npx trampoline target for $abi")
}

fun runtimeNativeNames(abis: List<String>): Set<String> =
    abis.flatMapTo(sortedSetOf("libnode.so", "libnpm.so", "libnpx.so")) { abi ->
        val files = File(runtimeTermuxDir, "$abi/runtime-files.json")
        if (!files.isFile) return@flatMapTo emptyList()
        ((JsonSlurper().parse(files) as? Map<*, *>)?.get("elfs") as? List<*>).orEmpty()
            .mapNotNull { (it as? Map<*, *>)?.get("name") as? String }
    }

fun trampolineTask(abi: String, minSdk: Int): TaskProvider<BuildSillyBunnyTrampoline> = trampolineTasks.getOrPut(abi) {
    val suffix = abi.split('-', '_').joinToString("") { part -> part.replaceFirstChar { it.uppercase(Locale.ROOT) } }
    tasks.register<BuildSillyBunnyTrampoline>("buildSillyBunnyTrampoline$suffix") {
        source.set(layout.projectDirectory.file("src/main/cpp/npm-trampoline.c"))
        target.set(trampolineTargets.getValue(abi) + minSdk)
        ndkVersion.set(sillyBunnyAndroid.agpGet("ndkVersion") as String)
        if (runtimeNdkOverride != null) {
            ndkDirectory.set(runtimeNdkOverride)
        } else {
            @Suppress("UNCHECKED_CAST")
            val sdkNdk = sillyBunnyComponents.agpGet("sdkComponents")!!.agpGet("ndkDirectory") as Provider<Directory>
            ndkDirectory.set(sdkNdk)
        }
        output.set(layout.buildDirectory.file("intermediates/sillybunny/trampoline/$abi/libnpm.so"))
    }
}

fun configureRuntimePackaging(variant: Any) {
    val name = variant.agpGet("name") as String
    val variantName = name.replaceFirstChar { it.uppercase(Locale.ROOT) }
    val splitAbis = (variant.agpGet("outputs") as List<*>).flatMap { output ->
        (output!!.agpGet("filters") as Collection<*>)
            .filter { it!!.agpGet("filterType").toString() == "ABI" }
            .map { it!!.agpGet("identifier") as String }
    }.distinct().sorted().ifEmpty { trampolineTargets.keys.sorted() }
    val buildType = sillyBunnyAndroid.agpGet("buildTypes")!!.agpCall("getByName", variant.agpGet("buildType"))!!
    val required = runtimeRequired || buildType.agpCall("isDebuggable") != true
    val sharedMissing = missingSharedRuntimeInputs()
    val abis = when {
        required -> splitAbis
        sharedMissing.isEmpty() -> splitAbis.filter { missingRuntimeInputs(it).isEmpty() }
        else -> emptyList()
    }
    val missingNotices = missingNoticeInputs()
    val missingInputs = if (required) sharedMissing + missingNotices + abis.flatMap(::missingRuntimeInputs) else emptyList()
    val packaged = required || abis.isNotEmpty()
    val buildConfigField = Class.forName("com.android.build.api.variant.BuildConfigField", true, variant.javaClass.classLoader)
        .getConstructor(String::class.java, java.io.Serializable::class.java, String::class.java)
        .newInstance("boolean", packaged, "Whether this APK carries the bundled runtime payload (plan 2.1).")
    @Suppress("UNCHECKED_CAST")
    val buildConfigFields = variant.agpGet("buildConfigFields") as MapProperty<String, Any>
    buildConfigFields.put("HAS_RUNTIME", buildConfigField)
    if (!packaged) {
        logger.warn("SillyBunny runtime inputs are missing; $name builds without the bundled runtime (BuildConfig.HAS_RUNTIME=false).")
        return
    }
    val skipped = splitAbis - abis.toSet()
    if (skipped.isNotEmpty()) {
        logger.warn("SillyBunny runtime: $name packages ${abis.joinToString()}; inputs are incomplete for ${skipped.joinToString()}.")
    }
    // Hashes in runtime-manifest.json must describe the exact bytes the installer extracts, so never strip.
    @Suppress("UNCHECKED_CAST")
    val keepDebugSymbols = variant.agpGet("packaging")!!.agpGet("jniLibs")!!.agpGet("keepDebugSymbols") as SetProperty<String>
    keepDebugSymbols.addAll(runtimeNativeNames(abis).map { "**/$it" })
    val minSdk = variant.agpGet("minSdk")!!.agpGet("apiLevel") as Int
    // With inputs missing the prepare task fails first with the list of them, so never build the trampoline then.
    val trampolineBuilds = if (missingInputs.isEmpty()) abis.map { trampolineTask(it, minSdk) } else emptyList()

    // p45b: registered only when the notices inputs exist; without them, a build that requires the runtime fails in
    // prepare, which lists what is missing.
    val notices = if (missingNotices.isNotEmpty()) null else tasks.register<GenerateSillyBunnyNotices>("generate${variantName}SillyBunnyNotices") {
        script.set(rootProject.layout.projectDirectory.file("runtime/notices.py"))
        runtimeLock.set(rootProject.layout.projectDirectory.file("runtime.lock"))
        sourcesLock.set(rootProject.layout.projectDirectory.file("runtime/sources.lock"))
        termuxLicenses.set(File(runtimeTermuxDir, "licenses"))
        nodeTarball.set(runtimeNodeTarball)
        npmLicenses.set(rootProject.layout.projectDirectory.dir("runtime/licenses/npm"))
        // notices.gradle.kts registers this task and writes this directory.
        androidLibraries.set(layout.buildDirectory.dir("generated/sillybunny/library-notices/$name"))
        dependsOn("generate${variantName}SillyBunnyLibraryNotices")
        requireNode.set(required)
        output.set(layout.buildDirectory.dir("intermediates/sillybunny/notices/$name"))
    }

    val prepare = tasks.register<PrepareSillyBunnyRuntime>("prepare${variantName}SillyBunnyRuntime") {
        this.abis.set(abis)
        missing.set(missingInputs)
        termuxDirectory.set(runtimeTermuxDir)
        nodeDirectory.set(runtimeNodeDir)
        npmDirectory.set(runtimeNpmDir)
        notices?.let { task -> noticesDirectory.set(task.flatMap { it.output }) }
        // p45b: a required build refuses unattributed pinned payloads; a debuggable one says why it lacks notices.
        noticesMissing.set(missingNotices)
        attributionRequired.set(required)
        inputFiles.from(
            fileTree(runtimeTermuxDir) {
                abis.forEach { include("$it/jniLibs/**", "$it/runtime-files.json") }
                include("assets/runtime/**")
            },
            fileTree(runtimeNodeDir) {
                include("node.json")
                abis.forEach { include("$it/libnode.so") }
            },
            fileTree(runtimeNpmDir) { include("npm.zip", "npm.json") },
        )
        runtimeLock.set(rootProject.layout.projectDirectory.file("runtime.lock"))
        // android/release/inputs-hash.mjs lists this file in EXTRA_INPUTS, because it lies outside android/.
        installScript.set(rootProject.file("../scripts/bootstrap/install.sh"))
        trampolineBuilds.forEach { build -> trampolines.from(build.flatMap { it.output }) }
    }
    val sources = variant.agpGet("sources")!!
    sources.agpGet("jniLibs")!!.agpCall("addGeneratedSourceDirectory", prepare, { task: PrepareSillyBunnyRuntime -> task.jniLibsDir })
    sources.agpGet("assets")!!.agpCall("addGeneratedSourceDirectory", prepare, { task: PrepareSillyBunnyRuntime -> task.assetsDir })

    val apkArtifact = Class.forName("com.android.build.api.artifact.SingleArtifact\$APK", true, variant.javaClass.classLoader)
        .getField("INSTANCE").get(null)
    @Suppress("UNCHECKED_CAST")
    val apks = variant.agpGet("artifacts")!!.agpCall("get", apkArtifact) as Provider<Directory>
    val verify = tasks.register<VerifySillyBunnyRuntime>("verify${variantName}SillyBunnyRuntime") {
        apkDirectory.set(apks)
        manifest.set(prepare.flatMap { it.assetsDir.file(PrepareSillyBunnyRuntime.MANIFEST) })
        this.abis.set(abis)
        report.set(layout.buildDirectory.file("reports/sillybunny/runtime-$name.txt"))
    }
    tasks.named { it == "assemble$variantName" || it == "lint$variantName" }.configureEach { dependsOn(verify) }
}

sillyBunnyComponents.agpCall(
    "onVariants",
    sillyBunnyComponents.agpCall("selector")!!.agpCall("all"),
    { variant: Any -> configureRuntimePackaging(variant) },
)
