package io.github.sillybunnyteam.sillybunny.runtime

import android.content.Context
import java.io.File

/**
 * Every on-device path from plan §2.2 and §2.5. All paths derive from the Context, never from a
 * hardcoded `/data/data`, so work profiles, secondary users and Private Space keep working.
 * `nativeLibraryDir` changes on every reinstall, so build a fresh instance per launch.
 */
class RuntimePaths(
    val filesDir: File,
    val cacheDir: File,
    val nativeLibraryDir: File,
) {
    constructor(context: Context) : this(
        context.filesDir,
        context.cacheDir,
        File(context.applicationInfo.nativeLibraryDir),
    )

    val runtimeDir = File(filesDir, "runtime")
    val binDir = File(runtimeDir, "bin")
    val gitExecPath = File(runtimeDir, "libexec/git-core")
    val npmPackageDir = File(runtimeDir, "lib/node_modules/npm")
    val npmCli = File(npmPackageDir, "bin/npm-cli.js")
    val npxCli = File(npmPackageDir, "bin/npx-cli.js")
    val gitTemplateDir = File(runtimeDir, "share/git-core/templates")
    val caBundle = File(runtimeDir, "etc/certs/cert.pem")
    val opensslModulesDir = File(runtimeDir, "openssl-modules")
    val installedRuntime = File(runtimeDir, "installed-runtime.json")

    val homeDir = File(filesDir, "home")
    val statusDir = File(filesDir, "status")
    val logsDir = File(filesDir, "logs")
    val checkoutDir = File(filesDir, "SillyBunny")
    val tmpDir = File(cacheDir, "tmp")

    // Executables run straight from nativeLibraryDir; writable filesDir only ever holds links to them.
    val bash = File(nativeLibraryDir, "libbash.so")
    val node = File(nativeLibraryDir, "libnode.so")
    val git = File(nativeLibraryDir, "libgit.so")
    val npm = File(nativeLibraryDir, "libnpm.so")
    val npx = File(nativeLibraryDir, "libnpx.so")

    /** A checkout that Repair moved aside (plan §4.7); deleted only by explicit user action. */
    fun brokenCheckout(timestamp: String): File = File(filesDir, "SillyBunny.broken-$timestamp")
}
