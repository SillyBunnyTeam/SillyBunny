package io.github.sillybunnyteam.sillybunny.server

import io.github.sillybunnyteam.sillybunny.runtime.RuntimePaths
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.LinkOption

/**
 * The complete environment for `start.sh` and the setup scripts (plan §2.5).
 *
 * It starts from an empty map plus the inherited Android framework roots, so no inherited preload,
 * shell startup file, Bun, npm or Git policy override reaches the scripts. [toString] prints keys
 * only, because one value can be the launch token.
 */
internal class ProcessEnvironment(
    private val variables: Map<String, String>,
) : Map<String, String> by variables {
    override fun toString(): String = "ProcessEnvironment(keys=${variables.keys.sorted()})"

    override fun equals(other: Any?): Boolean = other is ProcessEnvironment && other.variables == variables

    override fun hashCode(): Int = variables.hashCode()

    companion object {
        const val LAUNCH_TOKEN = "SILLYBUNNY_LAUNCH_TOKEN"
        const val NODE_OPTIONS = "NODE_OPTIONS"
        const val NODE_COMPILE_CACHE = "NODE_COMPILE_CACHE"
        const val NODE_ICU_DATA = "NODE_ICU_DATA"
        const val GIT_IDENTITY_NAME = "SillyBunny"
        const val GIT_IDENTITY_EMAIL = "sillybunny@localhost.invalid"

        private val ICU_DAT_FILE = Regex("^icudt[0-9]+[a-z]?\\.dat$")

        /** V8 bytecode compile cache outside the git-tracked checkout directory. */
        fun compileCacheDir(paths: RuntimePaths): File = File(paths.cacheDir, "v8")

        /** Optional external ICU data directory for `small-icu` Node builds (`<runtimeDir>/icu`). */
        fun icuDataDir(paths: RuntimePaths): File = paths.icuDir

        /**
         * True when `<paths.runtimeDir>/icu` is a real directory (following `runtimeDir`'s generation
         * symlink, but refusing a symlinked `icu` leaf) containing a non-empty regular `icudt*.dat` file.
         */
        fun hasBundledIcuData(paths: RuntimePaths): Boolean {
            val dir = paths.icuDir.toPath()
            if (Files.isSymbolicLink(dir) || !Files.isDirectory(dir)) return false
            return try {
                Files.newDirectoryStream(dir).use { entries ->
                    entries.any { entry ->
                        ICU_DAT_FILE.matches(entry.fileName.toString()) &&
                            Files.isRegularFile(entry, LinkOption.NOFOLLOW_LINKS) &&
                            Files.size(entry) > 0L
                    }
                }
            } catch (_: IOException) {
                false
            }
        }

        /** Passed on from the app process when present; API 36+ also has the ART and i18n roots (S2.5). */
        val FRAMEWORK_ROOTS = listOf(
            "ANDROID_ROOT",
            "ANDROID_DATA",
            "ANDROID_TZDATA_ROOT",
            "ANDROID_ART_ROOT",
            "ANDROID_I18N_ROOT",
        )

        /** Never passed on, even when the app process has them. */
        val NEVER_INHERITED = listOf("LD_PRELOAD", "BASH_ENV", "ENV")

        /**
         * Builds the environment as a pure function of its inputs. [launchToken] is set only for the
         * server; setup scripts run without one. [autoUpdate] maps to `SILLYBUNNY_AUTO_UPDATE`, which
         * `start.sh` reads with `is_truthy` (`1`, `true`, `yes`, `on`, any case) and treats as on when
         * unset, so "off" must be an explicit `0`. [maxOldSpaceSizeMb] bounds V8 old-space growth on
         * mobile RAM budgets; [reportDirectory] adds [reportOptions] to `NODE_OPTIONS` for the server.
         */
        fun build(
            paths: RuntimePaths,
            inherited: Map<String, String>,
            versionCode: Long,
            autoUpdate: Boolean,
            launchToken: String?,
            reportDirectory: File? = null,
            maxOldSpaceSizeMb: Int? = null,
        ): ProcessEnvironment {
            val environment = LinkedHashMap<String, String>()
            for (key in FRAMEWORK_ROOTS) {
                inherited[key]?.takeIf { it.isNotEmpty() }?.let { environment[key] = it }
            }
            val certificates = paths.caBundle.absolutePath
            // No bun entry: the in-app updater picks `bun install` whenever it finds bun on PATH (plan §3.4).
            environment["PATH"] = "${paths.binDir.absolutePath}:/system/bin"
            environment["HOME"] = paths.homeDir.absolutePath
            environment["TMPDIR"] = paths.tmpDir.absolutePath
            environment["LD_LIBRARY_PATH"] = paths.nativeLibraryDir.absolutePath
            environment["GIT_EXEC_PATH"] = paths.gitExecPath.absolutePath
            environment["GIT_TEMPLATE_DIR"] = paths.gitTemplateDir.absolutePath
            environment["GIT_CONFIG_NOSYSTEM"] = "1"
            environment["GIT_ATTR_NOSYSTEM"] = "1"
            environment["GIT_SSL_CAINFO"] = certificates
            environment["SSL_CERT_FILE"] = certificates
            environment["CURL_CA_BUNDLE"] = certificates
            environment["OPENSSL_CONF"] = "/dev/null"
            environment["OPENSSL_MODULES"] = paths.opensslModulesDir.absolutePath
            environment["GIT_AUTHOR_NAME"] = GIT_IDENTITY_NAME
            environment["GIT_AUTHOR_EMAIL"] = GIT_IDENTITY_EMAIL
            environment["GIT_COMMITTER_NAME"] = GIT_IDENTITY_NAME
            environment["GIT_COMMITTER_EMAIL"] = GIT_IDENTITY_EMAIL
            environment["SILLYBUNNY_ANDROID_APP"] = "1"
            environment["SILLYBUNNY_ANDROID_APP_VERSION_CODE"] = versionCode.toString()
            environment["SILLYBUNNY_ANDROID_STATUS_DIR"] = paths.statusDir.absolutePath
            environment["SILLYBUNNY_USE_NODE"] = "1"
            environment["SILLYBUNNY_AUTO_UPDATE"] = if (autoUpdate) "1" else "0"
            environment["SILLYBUNNY_SKIP_BROWSER_AUTO_LAUNCH"] = "1"
            environment["SILLYTAVERN_BROWSERLAUNCH_ENABLED"] = "false"
            environment["SILLYTAVERN_LISTEN"] = "false"
            environment["SILLYBUNNY_ANDROID_NPM_CLI"] = paths.npmCli.absolutePath
            environment["SILLYBUNNY_ANDROID_NPX_CLI"] = paths.npxCli.absolutePath
            environment[NODE_COMPILE_CACHE] = compileCacheDir(paths).absolutePath
            if (hasBundledIcuData(paths)) {
                environment[NODE_ICU_DATA] = icuDataDir(paths).absolutePath
            }
            if (launchToken != null) {
                require(LaunchTokens.isValid(launchToken)) { "token" }
                environment[LAUNCH_TOKEN] = launchToken
            }
            if (maxOldSpaceSizeMb != null) {
                require(maxOldSpaceSizeMb > 0) { "maxOldSpaceSizeMb" }
                environment[NODE_OPTIONS] = mergeNodeOptions(environment[NODE_OPTIONS], heapOptions(maxOldSpaceSizeMb))
            }
            if (reportDirectory != null) {
                environment[NODE_OPTIONS] = mergeNodeOptions(environment[NODE_OPTIONS], reportOptions(reportDirectory))
            }
            return ProcessEnvironment(environment)
        }

        /**
         * Scales V8's old-space limit to device RAM so webpack and the Node server trigger major GC
         * before Android's low-memory killer terminates the WebView or server process.
         */
        fun recommendedMaxOldSpaceSizeMb(totalRamBytes: Long): Int = when {
            totalRamBytes <= 0L -> 384
            totalRamBytes <= 3L * 1024 * 1024 * 1024 -> 256
            totalRamBytes <= (9L * 1024 * 1024 * 1024) / 2 -> 384
            totalRamBytes <= (13L * 1024 * 1024 * 1024) / 2 -> 512
            else -> 768
        }

        fun heapOptions(maxOldSpaceSizeMb: Int): List<String> = listOf("--max-old-space-size=$maxOldSpaceSizeMb")

        /**
         * Node's diagnostic report on a fatal error, written into [directory]. `--report-exclude-env` keeps the launch
         * token out of the report, and `--report-exclude-network` the device's interfaces and host names.
         */
        fun reportOptions(directory: File): List<String> = listOf(
            "--report-on-fatalerror",
            "--report-compact",
            "--report-exclude-env",
            "--report-exclude-network",
            "--report-directory=${quoteNodeOption(directory.absolutePath)}",
        )

        /** [existing] first, so for an option given twice the appended one wins, as Node takes the last. */
        fun mergeNodeOptions(existing: String?, options: List<String>): String =
            (listOfNotNull(existing?.trim()?.takeIf { it.isNotEmpty() }) + options).joinToString(" ")

        /**
         * Node splits `NODE_OPTIONS` at spaces outside double quotes; inside them a backslash escapes the next
         * character (`ParseNodeOptionsEnvVar` in Node's `src/node_options.cc`).
         */
        fun quoteNodeOption(value: String): String = "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""
    }
}
