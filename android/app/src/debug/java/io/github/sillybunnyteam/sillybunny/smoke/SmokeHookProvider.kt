package io.github.sillybunnyteam.sillybunny.smoke

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri
import android.os.Binder
import android.os.Bundle
import android.os.Process
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import io.github.sillybunnyteam.sillybunny.server.ServerManager
import io.github.sillybunnyteam.sillybunny.server.ServerState
import io.github.sillybunnyteam.sillybunny.web.BrowserHandoff
import java.security.SecureRandom
import org.json.JSONObject

/**
 * The debug-only hook of the Android smoke (plan §7.1, `tests/android-smoke/adb.js` `Adb#hook`):
 *
 * - `content call --uri content://<applicationId>.smoke --method state` gives the server state, and the
 *   port while it runs;
 * - `--method handoff` gives a fresh single-use handoff code for the running server, which the smoke
 *   redeems through `adb forward` to get the launch cookie;
 * - `--method kill --arg <pid>` sends SIGKILL to a process of the app, as a crash of the server would end it.
 *   The signal comes from the app's own process, because on API 29 `run-as` may signal the app's processes
 *   but not kill them (SELinux).
 *
 * Each reply is a Bundle with one string, `json`. The launch token never leaves the process: a handoff
 * code proves it without revealing it, and expires after [BrowserHandoff.LIFETIME_MILLIS].
 */
class SmokeHookProvider : ContentProvider() {
    private val random = SecureRandom()

    override fun onCreate(): Boolean = true

    override fun call(method: String, arg: String?, extras: Bundle?): Bundle {
        // The manifest's DUMP permission already keeps apps out; this also refuses anything but adb.
        val caller = Binder.getCallingUid()
        if (caller != SHELL_UID && caller != ROOT_UID && caller != Process.myUid()) {
            throw SecurityException("The smoke hook answers only adb.")
        }
        val reply = when (method) {
            METHOD_STATE -> state(ServerManager.existing()?.state?.value)
            METHOD_HANDOFF -> handoff(ServerManager.existing()?.state?.value)
            METHOD_KILL -> kill(arg)
            else -> JSONObject().put("error", "unknown-method")
        }
        return Bundle().apply { putString(KEY_JSON, reply.toString()) }
    }

    private fun state(state: ServerState?): JSONObject {
        val reply = JSONObject().put("state", name(state))
        when (state) {
            is ServerState.Running -> reply.put("port", state.session.port).put("originChanged", state.originChanged)
            is ServerState.Starting -> reply.put("attempt", state.attempt)
            is ServerState.Stopped -> reply.put("userStopped", state.userStopped)
            // The lines can quote server output; the smoke collects the log files instead.
            is ServerState.Failed -> reply.put("lastLines", state.lastLines.size).put("canRestart", state.canRestart)
            ServerState.Stopping, null -> Unit
        }
        return reply
    }

    private fun handoff(state: ServerState?): JSONObject {
        if (state !is ServerState.Running) {
            return JSONObject().put("error", "not-running").put("state", name(state))
        }
        val nonce = ByteArray(BrowserHandoff.NONCE_BYTES).also(random::nextBytes)
        val expiry = System.currentTimeMillis() + BrowserHandoff.LIFETIME_MILLIS
        return JSONObject()
            .put("code", BrowserHandoff.code(state.session.token, nonce, expiry))
            .put("path", BrowserHandoff.PATH)
            .put("port", state.session.port)
    }

    /** The app's own process is refused: the reply could not reach adb. kill(2) refuses other users' processes. */
    private fun kill(arg: String?): JSONObject {
        val pid = arg?.toIntOrNull()
        if (pid == null || pid <= 0 || pid == Process.myPid()) {
            return JSONObject().put("error", "bad-pid")
        }
        return try {
            Os.kill(pid, OsConstants.SIGKILL)
            JSONObject().put("killed", pid)
        } catch (e: ErrnoException) {
            JSONObject().put("error", OsConstants.errnoName(e.errno) ?: "errno-${e.errno}")
        }
    }

    private fun name(state: ServerState?): String = when (state) {
        null -> "None"
        is ServerState.Stopped -> "Stopped"
        is ServerState.Starting -> "Starting"
        is ServerState.Running -> "Running"
        ServerState.Stopping -> "Stopping"
        is ServerState.Failed -> "Failed"
    }

    override fun query(
        uri: Uri,
        projection: Array<out String>?,
        selection: String?,
        selectionArgs: Array<out String>?,
        sortOrder: String?,
    ): Cursor? = null

    override fun getType(uri: Uri): String? = null

    override fun insert(uri: Uri, values: ContentValues?): Uri? = throw UnsupportedOperationException()

    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int =
        throw UnsupportedOperationException()

    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int =
        throw UnsupportedOperationException()

    private companion object {
        const val METHOD_STATE = "state"
        const val METHOD_HANDOFF = "handoff"
        const val METHOD_KILL = "kill"
        const val KEY_JSON = "json"
        const val SHELL_UID = 2000
        const val ROOT_UID = 0
    }
}
