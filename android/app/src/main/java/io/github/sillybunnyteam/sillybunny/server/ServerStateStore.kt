package io.github.sillybunnyteam.sillybunny.server

import android.content.Context
import androidx.core.content.edit

/**
 * The server state that must survive process death: the chosen port, an origin change not reported yet,
 * the run intent and the restart history. Writes commit synchronously, so a user Stop is on disk before
 * the stop begins.
 */
internal class ServerStateStore(context: Context) : PortStore {
    private val preferences = context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    override var port: Int?
        get() = preferences.getInt(PORT, 0).takeIf { it != 0 }
        set(value) = preferences.edit(commit = true) {
            if (value == null) remove(PORT) else putInt(PORT, value)
        }

    override var originChangePending: Boolean
        get() = preferences.getBoolean(ORIGIN_CHANGE_PENDING, false)
        set(value) = preferences.edit(commit = true) { putBoolean(ORIGIN_CHANGE_PENDING, value) }

    // One commit: a host death between two writes could otherwise drop the change or report a false one.
    override fun replacePort(port: Int) = preferences.edit(commit = true) {
        putInt(PORT, port)
        putBoolean(ORIGIN_CHANGE_PENDING, true)
    }

    fun loadPolicy(): PolicyState {
        val name = preferences.getString(INTENT, null)
        val intent = RunIntent.entries.firstOrNull { it.name == name } ?: RunIntent.CLEAN_STOPPED
        val times = preferences.getString(RESTARTS, null).orEmpty().split(',').mapNotNull { it.toLongOrNull() }
        return PolicyState(intent, times)
    }

    fun savePolicy(state: PolicyState) = preferences.edit(commit = true) {
        putString(INTENT, state.intent.name)
        putString(RESTARTS, state.restartTimes.joinToString(","))
    }

    private companion object {
        const val FILE = "server_host"
        const val PORT = "port"
        const val ORIGIN_CHANGE_PENDING = "origin_change_pending"
        const val INTENT = "run_intent"
        const val RESTARTS = "restart_times"
    }
}
