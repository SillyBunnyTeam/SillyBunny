package io.github.sillybunnyteam.sillybunny.server

import io.github.sillybunnyteam.sillybunny.runtime.RuntimePaths
import java.io.File
import java.io.IOException

/**
 * One command to run in its own process group. The supervisor is the command's direct child whose
 * command line contains [supervisorMarker]; without a marker the stop goes straight to the group.
 */
internal class LaunchSpec(
    val argv: List<String>,
    val workingDir: File,
    val environment: ProcessEnvironment,
    val supervisorMarker: String?,
) {
    init {
        require(argv.isNotEmpty()) { "argv" }
    }

    // The environment prints keys only; the argv never carries the token.
    override fun toString(): String = "LaunchSpec(argv=$argv, workingDir=$workingDir, environment=$environment)"
}

/** A launch that cannot work until first run or Repair restores its files; restarting cannot help. */
internal class LaunchUnavailableException(what: String) : IOException(what)

/**
 * Builds the server launch (plan §2.3). Production always uses [PRODUCTION]; device tests replace it
 * through `ServerDependencies`, never through an intent.
 */
internal fun interface LaunchSpecFactory {
    fun create(paths: RuntimePaths, session: LaunchSession, environment: ProcessEnvironment): LaunchSpec

    companion object {
        /** `libbash.so --noprofile --norc start.sh -- --port <P>` in the checkout; the port is never an env variable. */
        val PRODUCTION = LaunchSpecFactory { paths, session, environment ->
            if (!paths.bash.canExecute()) throw LaunchUnavailableException("bash")
            if (!File(paths.checkoutDir, "start.sh").isFile) throw LaunchUnavailableException("start.sh")
            LaunchSpec(
                listOf(paths.bash.absolutePath, "--noprofile", "--norc", "start.sh", "--", "--port", session.port.toString()),
                paths.checkoutDir,
                environment,
                SUPERVISOR_MARKER,
            )
        }

        /** `start.sh` runs `node server.js` (the supervisor), which spawns the server child the same way. */
        const val SUPERVISOR_MARKER = "server.js"
    }
}
