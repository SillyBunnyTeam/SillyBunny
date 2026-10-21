package io.github.sillybunnyteam.sillybunny.runtime

import org.json.JSONObject
import java.io.File
import java.io.FileNotFoundException
import java.io.InputStream

/**
 * A small but complete runtime payload: fake natives in a nativeLibraryDir, the runtime assets, npm.zip,
 * npm.json and a matching runtime-manifest.json, served the way the APK serves its assets.
 */
internal class RuntimeTestPayload(private val root: File) {
    val filesDir = File(root, "files")
    val cacheDir = File(root, "cache")
    var nativeLibraryDir = File(root, "lib-1")
        private set
    var versionCode = 7L
    var lastUpdateTime = 1_000L
    val assets = sortedMapOf<String, ByteArray>()
    val natives = NATIVES.associateWith { "native $it".toByteArray() }.toSortedMap()
    val npmItems = listOf(
        TestZip.file(".npmrc", "lorum\n"),
        TestZip.file("package.json", "{\"name\":\"npm\",\"version\":\"11.19.1\"}"),
        TestZip.file("bin/npm-cli.js", "require('../lib/cli.js')(process)\n"),
        TestZip.file("bin/npx-cli.js", "require('../lib/cli.js')(process)\n"),
        TestZip.file("lib/cli.js", "module.exports = () => {}\n".repeat(40)),
    )
    lateinit var npm: NpmArchiveRecord
        private set
    private var installs = 1

    init {
        writeNatives(nativeLibraryDir)
        assets[RuntimeManifest.GIT_CORE_LINKS] = LINKS.toByteArray()
        assets[RuntimeManifest.CA_BUNDLE] = "-----BEGIN CERTIFICATE-----\n".toByteArray()
        assets["runtime/git-templates/description"] = "Unnamed repository\n".toByteArray()
        assets["runtime/git-templates/hooks/pre-commit.sample"] = "#!/bin/sh\n".toByteArray()
        assets["runtime/git-templates/info/exclude"] = "# exclude\n".toByteArray()
        assets["THIRD_PARTY_NOTICES"] = "notices\n".toByteArray()
        setNpm(TestZip.build(npmItems))
    }

    val paths: RuntimePaths get() = RuntimePaths(filesDir, cacheDir, nativeLibraryDir)

    val source: RuntimeSource = object : RuntimeSource {
        override val versionCode: Long get() = this@RuntimeTestPayload.versionCode
        override val lastUpdateTime: Long get() = this@RuntimeTestPayload.lastUpdateTime

        override fun open(path: String): InputStream = assets[path]?.inputStream() ?: throw FileNotFoundException(path)
    }

    fun installer(
        mode: NpmSyncMode = NpmSyncMode.BATCHED,
        checkpoint: (RuntimeLayoutInstaller.Step) -> Unit = {},
    ) = RuntimeLayoutInstaller(paths, source, mode, checkpoint)

    /** What `adb install -r` does: the same natives in a new nativeLibraryDir, and a new lastUpdateTime. */
    fun reinstall() {
        installs++
        nativeLibraryDir = File(root, "lib-$installs")
        writeNatives(nativeLibraryDir)
        lastUpdateTime += 1
    }

    /** Replaces npm.zip, describing it with [record] in npm.json and in the manifest. */
    fun setNpm(zip: ByteArray, record: NpmArchiveRecord = npmRecord(zip)) {
        npm = record
        assets[RuntimeManifest.NPM_ARCHIVE] = zip
        setNpmJson(record)
    }

    /** Rewrites npm.json only; the manifest keeps describing [npm]. */
    fun setNpmJson(record: NpmArchiveRecord) {
        assets[RuntimeManifest.NPM_JSON] = npmJson(record).toByteArray()
        writeManifest()
    }

    /** Regenerates runtime-manifest.json from the current assets, natives and [npm], as the build does. */
    fun writeManifest() {
        assets[RuntimeManifest.ASSET] = manifestJson(npm).toByteArray()
    }

    fun manifestJson(npm: NpmArchiveRecord): String {
        val nativeRecords = JSONObject()
        natives.forEach { (name, bytes) -> nativeRecords.put(name, record(bytes)) }
        val assetRecords = JSONObject()
        assets.filterKeys { it != RuntimeManifest.ASSET }.forEach { (path, bytes) -> assetRecords.put(path, record(bytes)) }
        return JSONObject()
            .put("schema", 1)
            .put(
                "versions",
                JSONObject().put("node", "24.22.0").put("npm", "11.19.1").put("git", "2.56.0").put("bash", "5.3.9"),
            )
            .put("termuxPackages", JSONObject().put("bash", "5.3.9").put("git", "2.56.0"))
            .put("abis", JSONObject().put("x86_64", JSONObject().put("natives", nativeRecords)))
            .put("assets", assetRecords)
            .put(
                "npm",
                JSONObject().put("version", npm.version).put("sha256", npm.sha256).put("size", npm.size)
                    .put("files", npm.files).put("contentBytes", npm.contentBytes),
            )
            .put("gitCoreLinkCount", LINKS.lines().count { it.isNotEmpty() })
            .put("sources", JSONObject().put("termuxLockSha256", "0".repeat(64)))
            .toString(4)
    }

    fun npmRecord(zip: ByteArray) = TestZip.record(zip, npmItems.size, npmItems.sumOf { it.data.size.toLong() })

    private fun npmJson(record: NpmArchiveRecord) = JSONObject()
        .put("schema", 1)
        .put("version", record.version)
        .put("sha256", record.sha256)
        .put("size", record.size)
        .put("files", record.files)
        .put("contentBytes", record.contentBytes)
        .put("source", JSONObject().put("nodeTag", "v24.22.0"))
        .toString(4)

    private fun record(bytes: ByteArray) = JSONObject().put("sha256", RuntimeManifest.sha256(bytes)).put("size", bytes.size)

    private fun writeNatives(directory: File) {
        directory.mkdirs()
        natives.forEach { (name, bytes) -> File(directory, name).writeBytes(bytes) }
    }

    companion object {
        val NATIVES = listOf(
            "libbash.so",
            "libgit.so",
            "libgit-remote-http.so",
            "libnode.so",
            "libnpm.so",
            "libnpx.so",
            "libz1.so",
        )
        const val LINKS = "git\tlibgit.so\ngit-add\tlibgit.so\ngit-remote-http\tlibgit-remote-http.so\n" +
            "git-remote-https\tlibgit-remote-http.so\n"
    }
}
