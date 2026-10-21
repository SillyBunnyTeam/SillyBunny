package io.github.sillybunnyteam.sillybunny.server

import io.github.sillybunnyteam.sillybunny.runtime.RuntimePaths

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
        const val GIT_IDENTITY_NAME = "SillyBunny"
        const val GIT_IDENTITY_EMAIL = "sillybunny@localhost.invalid"

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
         * unset, so "off" must be an explicit `0`.
         */
        fun build(
            paths: RuntimePaths,
            inherited: Map<String, String>,
            versionCode: Long,
            autoUpdate: Boolean,
            launchToken: String?,
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
            if (launchToken != null) {
                require(LaunchTokens.isValid(launchToken)) { "token" }
                environment[LAUNCH_TOKEN] = launchToken
            }
            return ProcessEnvironment(environment)
        }
    }
}
