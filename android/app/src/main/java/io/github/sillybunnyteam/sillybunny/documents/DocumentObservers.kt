package io.github.sillybunnyteam.sillybunny.documents

import android.os.FileObserver
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import android.system.StructStat
import java.io.File

/**
 * Bounded `FileObserver`s on directories that clients listed, so direct server writes reach their cursors.
 *
 * Events are coalesced per directory: at most one refresh is pending, and it runs [DEBOUNCE_MILLIS] after the
 * first event, so one server save (temp file, write, rename) costs one round. A refresh compares names,
 * inodes and the exposed metadata (mode, size, mtime) with the last snapshot. It never computes IDs for new
 * children, so it neither marks files nor records IDs, and it notifies only what changed: the directory's
 * children URI, its document URI and its parent's listing when names changed (both show the directory's
 * modified time), the issued IDs of changed or replaced children, and the roots URI when `config.yaml` changed.
 * Events that leave the exposed state unchanged, such as the provider's own marking or the provider's own
 * mutations (recorded through [created], [removed] and [written]), are dropped without a refresh.
 */
internal class DocumentObservers(private val workspace: DocumentsWorkspace) {
    /** What one listing row exposed; [id] stays null until a listing hands the child an ID. */
    data class Child(val inode: Long, val mode: Int, val size: Long, val modified: Long, val id: String?) {
        fun sameFile(stat: StructStat): Boolean =
            inode == stat.st_ino && mode and OsConstants.S_IFMT == stat.st_mode and OsConstants.S_IFMT

        fun sameState(stat: StructStat): Boolean =
            inode == stat.st_ino && mode == stat.st_mode && size == stat.st_size && modified == modifiedNanos(stat)

        fun updated(stat: StructStat): Child = copy(mode = stat.st_mode, size = stat.st_size, modified = modifiedNanos(stat))

        companion object {
            fun of(entry: DocumentFiles.Entry, id: String?): Child = Child(
                entry.stat.st_ino,
                entry.stat.st_mode,
                entry.stat.st_size,
                modifiedNanos(entry.stat),
                id,
            )

            private fun modifiedNanos(stat: StructStat): Long = stat.st_mtim.tv_sec * 1_000_000_000L + stat.st_mtim.tv_nsec
        }
    }

    private inner class Watched(val documentId: String, val directory: DocumentFiles.Entry, var children: Map<String, Child>) {
        var pending = false
        val observer: FileObserver = object : FileObserver(directory.file, EVENTS) {
            override fun onEvent(event: Int, path: String?) {
                workspace.post { handle(this@Watched, event and ALL_EVENTS, path) }
            }
        }
    }

    private val watched = linkedMapOf<String, Watched>()

    fun listed(directory: DocumentFiles.Entry, documentId: String, children: Map<String, Child>) {
        val path = directory.file.path
        val existing = watched[path]
        if (existing != null && existing.documentId == documentId &&
            existing.directory.stat.st_dev == directory.stat.st_dev && existing.directory.stat.st_ino == directory.stat.st_ino
        ) {
            existing.children.forEach { (name, old) ->
                if (old.id != null && children[name]?.id != old.id) retireChild(directory, name)
            }
            existing.children = children
            // Most recently listed last, so eviction drops the directory nobody has looked at longest.
            watched.remove(path)
            watched[path] = existing
            return
        }
        if (existing != null) retire(existing)
        while (watched.size >= MAX_DIRECTORIES) {
            val oldest = watched.keys.first()
            watched.remove(oldest)?.observer?.stopWatching()
        }
        val watch = Watched(documentId, directory, children)
        watched[path] = watch
        watch.observer.startWatching()
    }

    /** The provider created or replaced [entry] itself and handed out [id]. */
    fun created(entry: DocumentFiles.Entry, id: String) {
        val watch = parentWatch(entry.file) ?: return
        watch.children = watch.children + (entry.file.name to Child.of(entry, id))
    }

    /** The provider deleted or renamed [entry] away; its listing row and watches under it are gone. */
    fun removed(entry: DocumentFiles.Entry) {
        parentWatch(entry.file)?.let { it.children = it.children - entry.file.name }
        if (entry.directory) {
            val root = entry.file.toPath()
            watched.keys.filter { File(it).toPath().startsWith(root) }.forEach { path ->
                watched.remove(path)?.observer?.stopWatching()
            }
        }
    }

    /** A provider lease wrote [relative]; record its new metadata so the close event is not a second round. */
    fun written(relative: String) {
        val file = File(workspace.files.checkout, relative)
        val watch = parentWatch(file) ?: return
        val known = watch.children[file.name] ?: return
        val stat = try {
            Os.lstat(file.path)
        } catch (_: ErrnoException) {
            return
        }
        if (known.sameFile(stat)) watch.children = watch.children + (file.name to known.updated(stat))
    }

    fun clear() {
        watched.values.forEach { it.observer.stopWatching() }
        watched.clear()
    }

    private fun parentWatch(file: File): Watched? = file.parent?.let { watched[it] }

    /** The registered observer for a listed directory. Robolectric has no inotify, so tests drive it directly. */
    internal fun observerFor(directory: File): FileObserver? = watched[directory.path]?.observer

    private fun handle(watch: Watched, event: Int, name: String?) {
        if (watched[watch.directory.file.path] !== watch || !workspace.isAvailable) return
        // A pending refresh compares everything; until it runs, further events cost nothing.
        if (watch.pending) return
        if (name != null) {
            // The checkout itself is the synthetic root: server files beside data and config.yaml are not listed.
            if (watch.directory.relative == null && name !in ROOT_CHILDREN) return
            if (unchanged(watch, name)) return
        }
        watch.pending = true
        workspace.schedule(DEBOUNCE_MILLIS) {
            watch.pending = false
            if (watched[watch.directory.file.path] === watch && isAvailable) refresh(watch)
        }
    }

    /** True when [name] still looks exactly as the snapshot says, including still being absent. */
    private fun unchanged(watch: Watched, name: String): Boolean {
        val known = watch.children[name]
        val stat = try {
            Os.lstat(File(watch.directory.file, name).path)
        } catch (failure: ErrnoException) {
            return known == null && failure.errno == OsConstants.ENOENT
        }
        return known != null && known.sameState(stat)
    }

    private fun refresh(watch: Watched) {
        val directory = current(watch)
        val names = directory?.let {
            if (it.relative == null) ROOT_CHILDREN else it.file.list()?.toList()
        }
        if (directory == null || names == null) {
            retire(watch)
            return
        }
        val next = linkedMapOf<String, Child>()
        var namesChanged = false
        var rowsChanged = false
        val changedIds = mutableListOf<String>()
        names.sorted().forEach { name ->
            val entry = try {
                workspace.files.child(directory, name)
            } catch (_: Exception) {
                // A vanished, special, symlink or unsafe entry is never part of the exposed listing.
                return@forEach
            }
            val old = watch.children[name]
            when {
                old == null -> {
                    next[name] = Child.of(entry, null)
                    namesChanged = true
                }
                !old.sameFile(entry.stat) -> {
                    if (old.id != null) retireChild(directory, name)
                    next[name] = Child.of(entry, null)
                    namesChanged = true
                }
                old.sameState(entry.stat) -> next[name] = old
                else -> {
                    // Same inode, new metadata. A recycled inode lacks the old marker, so its old ID is stale.
                    val kept = old.id?.takeIf { id ->
                        try {
                            workspace.ids.existing(entry) == id
                        } catch (_: Exception) {
                            false
                        }
                    }
                    if (old.id != null && kept == null) retireChild(directory, name)
                    kept?.let(changedIds::add)
                    next[name] = Child.of(entry, kept)
                    rowsChanged = true
                }
            }
        }
        watch.children.forEach { (name, old) ->
            if (name !in next) {
                if (old.id != null) retireChild(directory, name)
                namesChanged = true
            }
        }
        // The roots cursor's summary comes from config.yaml, which the server or a shell can write directly.
        val configChanged = directory.relative == null && watch.children[CONFIG] != next[CONFIG]
        watch.children = next
        if (namesChanged) {
            workspace.notifyDocument(watch.documentId)
            // The directory's modified time changed with its names, and its parent's listing shows that time.
            watch.directory.relative?.let(workspace::notifyListingOf)
        }
        if (namesChanged || rowsChanged) workspace.notifyChildren(watch.documentId)
        changedIds.forEach(workspace::notifyDocument)
        if (configChanged) workspace.notifyRoots()
    }

    /** The directory at the watched path, if it is still the document that was listed. */
    private fun current(watch: Watched): DocumentFiles.Entry? = try {
        val relative = watch.directory.relative
        val entry = if (relative == null) workspace.files.root() else workspace.files.resolve(relative)
        val sameInode = entry.stat.st_dev == watch.directory.stat.st_dev && entry.stat.st_ino == watch.directory.stat.st_ino
        entry.takeIf { sameInode && workspace.ids.existing(it) == watch.documentId }
    } catch (_: Exception) {
        null
    }

    /** The watched directory was replaced or vanished: drop the watch and every stale grant below it. */
    private fun retire(watch: Watched) {
        watch.observer.stopWatching()
        if (watched[watch.directory.file.path] === watch) watched.remove(watch.directory.file.path)
        (workspace.revokeStale(watch.directory.relative) + watch.documentId).distinct().forEach(workspace::notifyDocument)
        workspace.notifyChildren(watch.documentId)
        // Its row in the parent's listing vanished or now shows another directory.
        watch.directory.relative?.let(workspace::notifyListingOf)
    }

    /**
     * A child that had an ID was replaced or vanished. Revokes and announces the IDs issued at or below it
     * that no longer resolve; a child without an ID has none, since only listings hand out IDs.
     */
    private fun retireChild(directory: DocumentFiles.Entry, name: String) {
        val relative = directory.relative?.let { "$it/$name" } ?: name
        workspace.revokeStale(relative).forEach(workspace::notifyDocument)
    }

    companion object {
        private const val MAX_DIRECTORIES = 64
        private const val DEBOUNCE_MILLIS = 100L
        private const val CONFIG = "config.yaml"
        private val ROOT_CHILDREN = listOf("data", CONFIG)
        private const val EVENTS = FileObserver.CLOSE_WRITE or FileObserver.MOVED_FROM or FileObserver.MOVED_TO or
            FileObserver.CREATE or FileObserver.DELETE or FileObserver.DELETE_SELF or FileObserver.MOVE_SELF or FileObserver.ATTRIB
    }
}
