package io.github.sillybunnyteam.sillybunny.repair

import android.util.Log
import io.github.sillybunnyteam.sillybunny.checkout.BrokenCheckouts
import io.github.sillybunnyteam.sillybunny.runtime.RuntimePaths
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.yield
import java.io.File
import java.io.IOException
import java.nio.file.InvalidPathException
import java.nio.file.Path
import java.nio.file.Paths
import java.time.Instant
import java.util.concurrent.atomic.AtomicBoolean

/** A moved-aside `SillyBunny.broken-<timestamp>` folder (plan §4.6). */
data class LeftoverFolder(
    val name: String,
    val file: File,
    /** When it was moved aside, read from its name; null when the name carries no readable timestamp. */
    val movedAt: Instant?,
    /** Why deleting it is refused right now, or null when it may be deleted. */
    val protection: DeleteRefusal?,
)

/** [approximate] is true when a bound was hit or an entry could not be read: the folder is at least this big. */
data class FolderSize(val bytes: Long, val entries: Int, val approximate: Boolean)

/** Bounds for one folder's size walk. Hitting any of them marks the size approximate. */
data class SizeLimits(val maxEntries: Int = 200_000, val maxMillis: Long = 5_000, val maxDepth: Int = 128)

enum class DeleteRefusal {
    /** Not a moved-aside folder directly inside `filesDir` (or it is a link). */
    NOT_A_LEFTOVER,

    /** An unfinished Repair migrates from it (or may: its record cannot be read). */
    REPAIR_SOURCE,

    /** It holds the current checkout's data root or `config.yaml`, directly or through a link. */
    HOLDS_DATA_ROOT,

    /** The current `config.yaml` cannot be read, so whether the folder holds the data root is unknown. */
    DATA_ROOT_UNKNOWN,

    /** The platform cannot delete without following links. */
    UNSUPPORTED,
}

sealed interface DeleteResult {
    data class Refused(val reason: DeleteRefusal) : DeleteResult

    data class Deleted(val removedEntries: Int) : DeleteResult

    /** Some entries could not be removed; they and the folder stay. [examples] are folder-relative paths. */
    data class Partial(val removedEntries: Int, val remainingEntries: Int, val examples: List<String>) : DeleteResult
}

data class DeleteOutcome(val name: String, val result: DeleteResult)

/** [loading] is true until the first listing lands and during each later one. */
data class LeftoverState(
    val loading: Boolean = true,
    val folders: List<LeftoverFolder> = emptyList(),
    val sizes: Map<String, FolderSize> = emptyMap(),
    val deleting: String? = null,
    val lastOutcome: DeleteOutcome? = null,
)

/**
 * Lists, measures and deletes moved-aside folders (plan §4.6). It never deletes anything on its own: only
 * [delete], called after the user confirmed one named folder on the separate screen, removes anything.
 * Pass the same [RepairStore] file as the [RepairController], so the folder an unfinished Repair migrates
 * from is never deleted.
 */
class LeftoverFolders internal constructor(
    private val paths: RuntimePaths,
    private val store: RepairStore,
    dispatcher: CoroutineDispatcher,
    private val limits: SizeLimits,
    private val tree: NoFollowTree,
) {
    constructor(
        paths: RuntimePaths,
        store: RepairStore,
        dispatcher: CoroutineDispatcher = Dispatchers.IO,
        limits: SizeLimits = SizeLimits(),
    ) : this(paths, store, dispatcher, limits, NoFollowTree())

    private val scope = CoroutineScope(
        SupervisorJob() + dispatcher + CoroutineExceptionHandler { _, failure ->
            Log.w(TAG, "Leftover folder work stopped by an unexpected error", failure)
        },
    )
    private val mutableState = MutableStateFlow(LeftoverState())
    private val deleting = AtomicBoolean(false)
    private var refreshJob: Job? = null

    val state: StateFlow<LeftoverState> = mutableState.asStateFlow()

    /** The number of moved-aside folders, for Settings' entry. One directory listing: call it off the main thread. */
    fun count(): Int = BrokenCheckouts.list(paths).size

    /** Lists the folders, then measures them one at a time, off the main thread. */
    fun refresh() {
        synchronized(this) {
            refreshJob?.cancel()
            refreshJob = scope.launch { load() }
        }
    }

    /** Deletes the one folder the user confirmed by name. False while another deletion runs. */
    fun delete(name: String): Boolean {
        if (!deleting.compareAndSet(false, true)) return false
        mutableState.update { it.copy(deleting = name, lastOutcome = null) }
        scope.launch {
            try {
                val result = try {
                    deleteNow(name)
                } catch (failure: Exception) {
                    Log.w(TAG, "Deleting a leftover folder failed", failure)
                    DeleteResult.Partial(0, 1, listOf("."))
                }
                mutableState.update { it.copy(deleting = null, lastOutcome = DeleteOutcome(name, result)) }
            } finally {
                deleting.set(false)
            }
            refresh()
        }
        return true
    }

    fun clearOutcome() {
        mutableState.update { it.copy(lastOutcome = null) }
    }

    /** The folders, oldest first, each with its current deletion refusal. Blocking. */
    fun list(): List<LeftoverFolder> {
        val guard = guard()
        return BrokenCheckouts.list(paths).map { folder ->
            LeftoverFolder(folder.name, folder, movedAsideAt(folder.name), guard.refusal(folder))
        }
    }

    /** One folder's size, bounded by [SizeLimits], never following links. Blocking. */
    fun measure(name: String): FolderSize = try {
        tree.measure(paths.filesDir, name, limits)
    } catch (failure: IOException) {
        Log.w(TAG, "Could not measure a leftover folder", failure)
        FolderSize(0, 0, approximate = true)
    } catch (failure: IllegalArgumentException) {
        FolderSize(0, 0, approximate = true)
    }

    /** Why [name] cannot be deleted now, or null. Blocking. */
    fun refusal(name: String): DeleteRefusal? {
        val folder = BrokenCheckouts.list(paths).firstOrNull { it.name == name } ?: return DeleteRefusal.NOT_A_LEFTOVER
        return guard().refusal(folder)
    }

    /** Checks the refusals again, then deletes [name] without following links. Blocking. */
    fun deleteNow(name: String): DeleteResult {
        refusal(name)?.let { return DeleteResult.Refused(it) }
        val report = try {
            tree.delete(paths.filesDir, name)
        } catch (_: NoFollowTree.Unsupported) {
            return DeleteResult.Refused(DeleteRefusal.UNSUPPORTED)
        } catch (failure: IOException) {
            Log.w(TAG, "Could not open the folders to delete from", failure)
            return DeleteResult.Partial(0, 1, listOf("."))
        }
        return if (report.remaining == 0) {
            DeleteResult.Deleted(report.removed)
        } else {
            DeleteResult.Partial(report.removed, report.remaining, report.examples)
        }
    }

    private suspend fun load() {
        mutableState.update { it.copy(loading = true) }
        val folders = try {
            list()
        } catch (failure: Exception) {
            Log.w(TAG, "Could not list the leftover folders", failure)
            mutableState.update { it.copy(loading = false) }
            return
        }
        val names = folders.map { it.name }.toSet()
        mutableState.update { current ->
            current.copy(loading = false, folders = folders, sizes = current.sizes.filterKeys { it in names })
        }
        for (folder in folders) {
            yield()
            val size = measure(folder.name)
            mutableState.update { it.copy(sizes = it.sizes + (folder.name to size)) }
        }
    }

    private fun guard(): Guard {
        val record = try {
            Result.success(store.load())
        } catch (failure: IOException) {
            Result.failure(failure)
        }
        return Guard(record, protectedPaths())
    }

    /** The current checkout, its data root (absolute, or relative to it) and its `config.yaml`. */
    private fun protectedPaths(): List<Path>? {
        val checkout = paths.checkoutDir.toPath()
        val root = try {
            DataRoot.read(paths.checkoutDir)
        } catch (_: IOException) {
            return null
        }
        val data = try {
            if (DataRoot.isAbsolute(root)) Paths.get(root) else checkout.resolve(root)
        } catch (_: InvalidPathException) {
            return null
        }
        return listOf(checkout, data, checkout.resolve("config.yaml"))
    }

    private class Guard(private val record: Result<RepairRecord?>, private val held: List<Path>?) {
        fun refusal(folder: File): DeleteRefusal? {
            // An unreadable record could name any folder as the data's source, so all of them stay.
            val repair = record.getOrElse { return DeleteRefusal.REPAIR_SOURCE }
            if (repair != null) {
                if (repair.source == folder.name) return DeleteRefusal.REPAIR_SOURCE
                // Interrupted mid-rename, the source has no name yet: any folder that rename could have made stays.
                if (repair.source == null && repair.phase == RepairPhase.MOVING_ASIDE && repair.mayHaveMade(folder.name)) {
                    return DeleteRefusal.REPAIR_SOURCE
                }
            }
            val paths = held ?: return DeleteRefusal.DATA_ROOT_UNKNOWN
            return if (paths.any { PathContainment.isWithin(it, folder.toPath()) }) DeleteRefusal.HOLDS_DATA_ROOT else null
        }
    }

    private companion object {
        const val TAG = "SillyBunnyLeftovers"
    }
}
