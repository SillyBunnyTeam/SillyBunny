package io.github.sillybunnyteam.sillybunny.server

import io.github.sillybunnyteam.sillybunny.runtime.RuntimePaths
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class ProcessEnvironmentTest {
    private val files = "/data/user/0/io.github.sillybunnyteam.sillybunny/files"
    private val cache = "/data/user/0/io.github.sillybunnyteam.sillybunny/cache"
    private val libs = "/data/app/~~abc/io.github.sillybunnyteam.sillybunny-xyz/lib/x86_64"
    private val paths = RuntimePaths(File(files), File(cache), File(libs))
    private val token = "0123456789abcdef".repeat(4)

    private val frameworkRoots = mapOf(
        "ANDROID_ROOT" to "/system",
        "ANDROID_DATA" to "/data",
        "ANDROID_TZDATA_ROOT" to "/apex/com.android.tzdata",
        "ANDROID_ART_ROOT" to "/apex/com.android.art",
        "ANDROID_I18N_ROOT" to "/apex/com.android.i18n",
    )

    /** Everything an app process may inherit that must never reach the scripts. */
    private val hostile = mapOf(
        "LD_PRELOAD" to "/data/data/com.termux/files/usr/lib/libtermux-exec.so",
        "BASH_ENV" to "/sdcard/bashenv",
        "ENV" to "/sdcard/env",
        "PATH" to "/data/data/com.termux/files/usr/bin:/home/user/.bun/bin:/system/bin",
        "HOME" to "/",
        "BUN_INSTALL" to "/home/user/.bun",
        "SILLYBUNNY_USE_BUN" to "1",
        "SILLYBUNNY_BUN_SMOL" to "1",
        "NODE_OPTIONS" to "--require /sdcard/evil.js",
        "GIT_CONFIG_GLOBAL" to "/sdcard/gitconfig",
        "npm_config_prefix" to "/sdcard/npm",
        "CLASSPATH" to "/system/framework/framework.jar",
        "BOOTCLASSPATH" to "/apex/com.android.art/javalib/core-oj.jar",
        "SILLYBUNNY_LAUNCH_TOKEN" to "f".repeat(64),
    )

    private fun expected(autoUpdate: String, launchToken: String?): Map<String, String> {
        val runtime = "$files/runtime"
        val certificates = "$runtime/etc/certs/cert.pem"
        val values = linkedMapOf(
            "ANDROID_ROOT" to "/system",
            "ANDROID_DATA" to "/data",
            "ANDROID_TZDATA_ROOT" to "/apex/com.android.tzdata",
            "ANDROID_ART_ROOT" to "/apex/com.android.art",
            "ANDROID_I18N_ROOT" to "/apex/com.android.i18n",
            "PATH" to "$runtime/bin:/system/bin",
            "HOME" to "$files/home",
            "TMPDIR" to "$cache/tmp",
            "LD_LIBRARY_PATH" to libs,
            "GIT_EXEC_PATH" to "$runtime/libexec/git-core",
            "GIT_TEMPLATE_DIR" to "$runtime/share/git-core/templates",
            "GIT_CONFIG_NOSYSTEM" to "1",
            "GIT_ATTR_NOSYSTEM" to "1",
            "GIT_SSL_CAINFO" to certificates,
            "SSL_CERT_FILE" to certificates,
            "CURL_CA_BUNDLE" to certificates,
            "OPENSSL_CONF" to "/dev/null",
            "OPENSSL_MODULES" to "$runtime/openssl-modules",
            "GIT_AUTHOR_NAME" to "SillyBunny",
            "GIT_AUTHOR_EMAIL" to "sillybunny@localhost.invalid",
            "GIT_COMMITTER_NAME" to "SillyBunny",
            "GIT_COMMITTER_EMAIL" to "sillybunny@localhost.invalid",
            "SILLYBUNNY_ANDROID_APP" to "1",
            "SILLYBUNNY_ANDROID_APP_VERSION_CODE" to "4021",
            "SILLYBUNNY_ANDROID_STATUS_DIR" to "$files/status",
            "SILLYBUNNY_USE_NODE" to "1",
            "SILLYBUNNY_AUTO_UPDATE" to autoUpdate,
            "SILLYBUNNY_SKIP_BROWSER_AUTO_LAUNCH" to "1",
            "SILLYTAVERN_BROWSERLAUNCH_ENABLED" to "false",
            "SILLYTAVERN_LISTEN" to "false",
            "SILLYBUNNY_ANDROID_NPM_CLI" to "$runtime/lib/node_modules/npm/bin/npm-cli.js",
            "SILLYBUNNY_ANDROID_NPX_CLI" to "$runtime/lib/node_modules/npm/bin/npx-cli.js",
        )
        if (launchToken != null) values["SILLYBUNNY_LAUNCH_TOKEN"] = launchToken
        return values
    }

    @Test
    fun serverEnvironmentIsExactlyThePlanTable() {
        val environment = ProcessEnvironment.build(paths, frameworkRoots + hostile, 4021, autoUpdate = true, launchToken = token)

        assertEquals(expected("1", token), environment.toMap())
        assertEquals(expected("1", token).keys.toList(), environment.keys.toList())
    }

    @Test
    fun setupEnvironmentHasNoLaunchTokenEvenWhenInherited() {
        val environment = ProcessEnvironment.build(paths, frameworkRoots + hostile, 4021, autoUpdate = true, launchToken = null)

        assertEquals(expected("1", null), environment.toMap())
        assertFalse(environment.containsKey(ProcessEnvironment.LAUNCH_TOKEN))
    }

    @Test
    fun autoUpdateOffIsAnExplicitZeroBecauseStartShDefaultsToOn() {
        val on = ProcessEnvironment.build(paths, emptyMap(), 1, autoUpdate = true, launchToken = null)
        val off = ProcessEnvironment.build(paths, emptyMap(), 1, autoUpdate = false, launchToken = null)

        // start.sh's is_truthy accepts 1/true/yes/on and treats an unset value as on.
        assertEquals("1", on["SILLYBUNNY_AUTO_UPDATE"])
        assertEquals("0", off["SILLYBUNNY_AUTO_UPDATE"])
    }

    @Test
    fun unsetVariablesAndNoBunEverReachTheScripts() {
        val environment = ProcessEnvironment.build(paths, frameworkRoots + hostile, 4021, autoUpdate = false, launchToken = token)

        for (key in ProcessEnvironment.NEVER_INHERITED) assertFalse(key, environment.containsKey(key))
        for (key in listOf("BUN_INSTALL", "SILLYBUNNY_USE_BUN", "SILLYBUNNY_BUN_SMOL", "NODE_OPTIONS", "GIT_CONFIG_GLOBAL")) {
            assertFalse(key, environment.containsKey(key))
        }
        // Exactly the bundled bin directory and /system/bin: no inherited entry, so no bun executable.
        assertEquals(listOf("$files/runtime/bin", "/system/bin"), environment.getValue("PATH").split(':'))
        assertFalse(environment.keys.any { it.startsWith("BUN_") || it.contains("_BUN_") || it.endsWith("_BUN") })
        assertFalse(environment.keys.any { it.startsWith("npm_config", ignoreCase = true) })
    }

    @Test
    fun onlyPresentNonEmptyFrameworkRootsAreInherited() {
        val api29 = mapOf("ANDROID_ROOT" to "/system", "ANDROID_DATA" to "/data", "ANDROID_TZDATA_ROOT" to "", "PATH" to "/sbin")
        val environment = ProcessEnvironment.build(paths, api29, 1, autoUpdate = true, launchToken = null)

        assertEquals("/system", environment["ANDROID_ROOT"])
        assertEquals("/data", environment["ANDROID_DATA"])
        assertFalse(environment.containsKey("ANDROID_TZDATA_ROOT"))
        assertFalse(environment.containsKey("ANDROID_ART_ROOT"))
        assertFalse(environment.containsKey("ANDROID_I18N_ROOT"))
    }

    @Test
    fun theBuilderIsPure() {
        val first = ProcessEnvironment.build(paths, frameworkRoots, 7, autoUpdate = true, launchToken = token)
        val second = ProcessEnvironment.build(paths, LinkedHashMap(frameworkRoots), 7, autoUpdate = true, launchToken = token)

        assertEquals(first, second)
        assertEquals(first.hashCode(), second.hashCode())
    }

    @Test
    fun toStringPrintsKeysOnly() {
        val environment = ProcessEnvironment.build(paths, frameworkRoots, 7, autoUpdate = true, launchToken = token)

        val text = environment.toString()
        assertFalse(text.contains(token))
        assertFalse(text.contains(files))
        assertTrue(text.contains(ProcessEnvironment.LAUNCH_TOKEN))
    }

    @Test
    fun onlyTheServerGetsNodesFatalErrorReportAndNeverTheInheritedNodeOptions() {
        val reports = File("$files/crash/reports")
        val server = ProcessEnvironment.build(
            paths,
            frameworkRoots + hostile,
            4021,
            autoUpdate = true,
            launchToken = token,
            reportDirectory = reports,
        )
        val setup = ProcessEnvironment.build(paths, frameworkRoots + hostile, 4021, autoUpdate = true, launchToken = null)

        val options = server.getValue(ProcessEnvironment.NODE_OPTIONS)
        assertEquals(
            "--report-on-fatalerror --report-compact --report-exclude-env --report-exclude-network " +
                "--report-directory=\"$files/crash/reports\"",
            options,
        )
        assertEquals(expected("1", token) + (ProcessEnvironment.NODE_OPTIONS to options), server.toMap())
        assertFalse(options.contains("evil"))
        assertFalse(setup.containsKey(ProcessEnvironment.NODE_OPTIONS))
    }

    @Test
    fun theReportOptionsFollowAValueThatIsAlreadySet() {
        val options = ProcessEnvironment.reportOptions(File("/data/files/crash/reports"))
        val joined = options.joinToString(" ")

        assertEquals("--max-old-space-size=512 $joined", ProcessEnvironment.mergeNodeOptions(" --max-old-space-size=512 ", options))
        assertEquals(joined, ProcessEnvironment.mergeNodeOptions(null, options))
        assertEquals(joined, ProcessEnvironment.mergeNodeOptions("  ", options))
    }

    @Test
    fun theReportDirectoryIsQuotedTheWayNodeSplitsNodeOptions() {
        assertEquals("\"$files/crash/reports\"", ProcessEnvironment.quoteNodeOption("$files/crash/reports"))
        // A space stays inside the quotes; a quote and a backslash get a backslash.
        assertEquals("\"/tmp/a b/c\\\"d\\\\e\"", ProcessEnvironment.quoteNodeOption("/tmp/a b/c\"d\\e"))
    }

    @Test
    fun anInvalidTokenIsRejectedWithoutEchoingIt() {
        val bad = "ABCDEF".repeat(11)
        val error = assertThrows(IllegalArgumentException::class.java) {
            ProcessEnvironment.build(paths, emptyMap(), 7, autoUpdate = true, launchToken = bad)
        }
        assertFalse(error.message.orEmpty().contains(bad))
    }
}
