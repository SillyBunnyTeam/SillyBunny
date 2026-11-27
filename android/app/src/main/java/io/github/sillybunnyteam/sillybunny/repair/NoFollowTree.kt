package io.github.sillybunnyteam.sillybunny.repair

import java.io.File
import java.io.IOException
import java.nio.file.DirectoryIteratorException
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.Paths
import java.nio.file.SecureDirectoryStream
import java.nio.file.attribute.BasicFileAttributeView
import java.nio.file.attribute.BasicFileAttributes

/**
 * Walks and deletes one folder without ever following a symbolic link. Every operation is relative to an
 * open directory descriptor ([SecureDirectoryStream]: `openat` with `O_NOFOLLOW`, `fstatat` with
 * `AT_SYMLINK_NOFOLLOW`, `unlinkat`), so a link is removed or skipped, never traversed, and a directory swapped
 * for a link mid-walk cannot redirect the walk outside the folder. Where the platform offers no
 * [SecureDirectoryStream], both operations throw [Unsupported] before touching anything.
 *
 * [fault] runs before each operation with the entry's path relative to the folder (the folder itself is
 * the empty path), so tests can make an entry fail as an unreadable or undeletable one does.
 */
internal class NoFollowTree(
    private val nanoTime: () -> Long = System::nanoTime,
    private val fault: (Operation, Path) -> Unit = { _, _ -> },
) {
    enum class Operation { OPEN_DIRECTORY, READ_ATTRIBUTES, DELETE }

    class Unsupported : IOException("No SecureDirectoryStream on this platform")

    /** [remaining] counts known entries still present after the attempt, the folder itself included. */
    class DeleteReport(val removed: Int, val remaining: Int, val examples: List<String>)

    /** Sizes the regular files below `parent/name`; links and special files count as entries, unsized. */
    @Throws(IOException::class)
    fun measure(parent: File, name: String, limits: SizeLimits): FolderSize {
        val walk = SizeWalk(limits, nanoTime() + limits.maxMillis * 1_000_000)
        openSecure(parent.toPath()).use { container ->
            fault(Operation.OPEN_DIRECTORY, ROOT)
            container.newDirectoryStream(folderName(name), LinkOption.NOFOLLOW_LINKS).use { root ->
                walk.visit(root, ROOT, depth = 1)
            }
        }
        return FolderSize(walk.bytes, walk.entries, walk.approximate)
    }

    /**
     * Deletes `parent/name` and everything in it. An entry that cannot be removed is reported and left in
     * place; nothing is retried, made writable or followed.
     */
    @Throws(IOException::class)
    fun delete(parent: File, name: String, maxDepth: Int = MAX_DELETE_DEPTH): DeleteReport {
        val deletion = Deletion(maxDepth)
        openSecure(parent.toPath()).use { container ->
            val folder = folderName(name)
            val opened = try {
                fault(Operation.OPEN_DIRECTORY, ROOT)
                container.newDirectoryStream(folder, LinkOption.NOFOLLOW_LINKS)
            } catch (_: IOException) {
                null
            }
            if (opened == null) {
                deletion.failed(ROOT)
            } else {
                val listed = opened.use { deletion.clear(it, ROOT, depth = 1) }
                if (listed) deletion.remove(ROOT) { container.deleteDirectory(folder) }
            }
        }
        return DeleteReport(deletion.removed, deletion.remaining, deletion.examples)
    }

    private fun openSecure(directory: Path): SecureDirectoryStream<Path> {
        val stream = Files.newDirectoryStream(directory)
        if (stream !is SecureDirectoryStream<*>) {
            stream.close()
            throw Unsupported()
        }
        @Suppress("UNCHECKED_CAST")
        return stream as SecureDirectoryStream<Path>
    }

    private fun attributes(directory: SecureDirectoryStream<Path>, name: Path, shown: Path): BasicFileAttributes {
        fault(Operation.READ_ATTRIBUTES, shown)
        return directory.getFileAttributeView(name, BasicFileAttributeView::class.java, LinkOption.NOFOLLOW_LINKS)
            .readAttributes()
    }

    private fun open(directory: SecureDirectoryStream<Path>, name: Path, shown: Path): SecureDirectoryStream<Path> {
        fault(Operation.OPEN_DIRECTORY, shown)
        return directory.newDirectoryStream(name, LinkOption.NOFOLLOW_LINKS)
    }

    private inner class SizeWalk(private val limits: SizeLimits, private val deadline: Long) {
        var bytes = 0L
        var entries = 0

        /** A bound was hit or an entry could not be read, so [bytes] is a lower bound. */
        var approximate = false

        // Only a bound ends the walk; an unreadable entry is skipped and the walk goes on.
        private var stopped = false

        private fun exhausted(): Boolean {
            if (!stopped && (entries >= limits.maxEntries || nanoTime() - deadline > 0)) {
                stopped = true
                approximate = true
            }
            return stopped
        }

        fun visit(directory: SecureDirectoryStream<Path>, shown: Path, depth: Int) {
            try {
                for (entry in directory) {
                    if (exhausted()) return
                    val name = entryName(entry) ?: continue
                    val child = shown.resolve(name)
                    entries++
                    val attributes = try {
                        attributes(directory, name, child)
                    } catch (_: IOException) {
                        approximate = true
                        continue
                    }
                    if (attributes.isRegularFile) {
                        bytes += attributes.size()
                    } else if (attributes.isDirectory) {
                        if (depth >= limits.maxDepth) {
                            approximate = true
                            continue
                        }
                        try {
                            open(directory, name, child).use { visit(it, child, depth + 1) }
                        } catch (_: IOException) {
                            approximate = true
                        }
                    }
                }
            } catch (_: DirectoryIteratorException) {
                approximate = true
            }
        }
    }

    private inner class Deletion(private val maxDepth: Int) {
        var removed = 0
        var remaining = 0
        val examples = mutableListOf<String>()

        /** Removes what it can below [directory]; false when the listing itself failed (already reported). */
        fun clear(directory: SecureDirectoryStream<Path>, shown: Path, depth: Int): Boolean {
            // Read every name first: removing entries while the listing is open may skip or repeat some.
            val names = try {
                directory.mapNotNull { entryName(it) }
            } catch (_: DirectoryIteratorException) {
                failed(shown)
                return false
            }
            for (name in names) {
                val child = shown.resolve(name)
                val attributes = try {
                    attributes(directory, name, child)
                } catch (_: IOException) {
                    failed(child)
                    continue
                }
                if (!attributes.isDirectory) {
                    // unlinkat(2) without AT_REMOVEDIR removes a symbolic link itself, never its target.
                    remove(child) { directory.deleteFile(name) }
                    continue
                }
                if (depth >= maxDepth) {
                    failed(child)
                    continue
                }
                val opened = try {
                    open(directory, name, child)
                } catch (_: IOException) {
                    // Unreadable, or swapped for a link since it was checked: leave it.
                    null
                }
                if (opened == null) {
                    failed(child)
                    continue
                }
                val listed = opened.use { clear(it, child, depth + 1) }
                if (listed) remove(child) { directory.deleteDirectory(name) }
            }
            return true
        }

        fun remove(shown: Path, action: () -> Unit) {
            try {
                fault(Operation.DELETE, shown)
                action()
                removed++
            } catch (_: IOException) {
                failed(shown)
            }
        }

        fun failed(shown: Path) {
            remaining++
            if (examples.size < MAX_EXAMPLES) examples.add(shown.toString().ifEmpty { "." })
        }
    }

    companion object {
        // Each open level holds two descriptors; 128 levels stay far below the per-process limit.
        const val MAX_DELETE_DEPTH = 128
        private const val MAX_EXAMPLES = 20
        private val ROOT: Path = Paths.get("")

        /** Directory listings only ever yield single names; anything else is skipped, never resolved. */
        private fun entryName(entry: Path): Path? {
            val name = entry.fileName ?: return null
            val text = name.toString()
            return if (text.isNotEmpty() && text != "." && text != ".." && '/' !in text) name else null
        }

        private fun folderName(name: String): Path {
            require(name.isNotEmpty() && name != "." && name != ".." && '/' !in name) { "Not a folder name" }
            return Paths.get(name)
        }
    }
}
