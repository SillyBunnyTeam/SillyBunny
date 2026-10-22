package io.github.sillybunnyteam.sillybunny.documents

import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import android.system.StructStat
import java.io.File
import java.io.FileDescriptor
import java.io.FileNotFoundException
import java.nio.file.Path
import java.util.UUID

internal class DocumentFiles(filesDir: File) {
    private val base: Path = filesDir.canonicalFile.toPath()
    private val identityLock = Any()
    val checkout: File = base.resolve("SillyBunny").toFile()

    data class Entry(val file: File, val relative: String?, val stat: StructStat) {
        val directory: Boolean get() = OsConstants.S_ISDIR(stat.st_mode)
    }

    fun root(): Entry = walk(emptyList())

    fun resolve(relative: String): Entry = walk(DocumentNames.relative(relative))

    /**
     * One child of a directory that was just resolved, checked like the last component of a walk: a safe
     * name, `lstat`, and only a regular file or a real directory. The root's children are the fixed anchors.
     */
    fun child(parent: Entry, name: String): Entry {
        val relative = parent.relative?.let { "$it/$name" } ?: return resolve(name)
        DocumentNames.relative(relative)
        val path = parent.file.toPath().resolve(name)
        val stat = Os.lstat(path.toString())
        if (!OsConstants.S_ISDIR(stat.st_mode) && !OsConstants.S_ISREG(stat.st_mode)) {
            throw FileNotFoundException("lorum ipsum")
        }
        return Entry(path.toFile(), relative, stat)
    }

    /** The entry's random marker, written on first sight. */
    fun identity(entry: Entry): String {
        val path = entry.file.path
        val bytes = synchronized(identityLock) {
            try {
                Os.getxattr(path, ID_ATTRIBUTE)
            } catch (failure: ErrnoException) {
                if (failure.errno != OsConstants.ENODATA) throw failure
                val value = UUID.randomUUID().toString().toByteArray(Charsets.US_ASCII)
                try {
                    mark(path, value, entry.stat)
                } catch (conflict: ErrnoException) {
                    if (conflict.errno != OsConstants.EEXIST) throw conflict
                }
                Os.getxattr(path, ID_ATTRIBUTE)
            }
        }
        return verified(entry, bytes)
    }

    /** The entry's marker if it already has one. Never writes, so checking an ID cannot mark a file. */
    fun existingIdentity(entry: Entry): String? {
        val bytes = try {
            Os.getxattr(entry.file.path, ID_ATTRIBUTE)
        } catch (failure: ErrnoException) {
            if (failure.errno == OsConstants.ENODATA) return null
            throw failure
        }
        return verified(entry, bytes)
    }

    private fun verified(entry: Entry, bytes: ByteArray): String {
        val value = String(bytes, Charsets.US_ASCII)
        if (!value.matches(UUID_PATTERN)) throw FileNotFoundException("lorum ipsum")
        val current = Os.lstat(entry.file.path)
        if (current.st_dev != entry.stat.st_dev || current.st_ino != entry.stat.st_ino || current.st_mode != entry.stat.st_mode) {
            throw FileNotFoundException("lorum ipsum")
        }
        return value
    }

    private fun mark(path: String, value: ByteArray, stat: StructStat) {
        try {
            Os.setxattr(path, ID_ATTRIBUTE, value, XATTR_CREATE)
        } catch (denied: ErrnoException) {
            // A user.* xattr needs inode write permission, so read-only entries (git objects in extension
            // clones) could never get an ID. Grant owner write only while marking, then restore the exact mode.
            val mode = stat.st_mode and MODE_BITS
            if (denied.errno != OsConstants.EACCES || mode and OsConstants.S_IWUSR != 0) throw denied
            Os.chmod(path, mode or OsConstants.S_IWUSR)
            try {
                Os.setxattr(path, ID_ATTRIBUTE, value, XATTR_CREATE)
            } finally {
                Os.chmod(path, mode)
            }
        }
    }

    private fun walk(parts: List<String>): Entry {
        var path = base
        var stat: StructStat? = null
        val components = listOf("SillyBunny") + parts
        components.forEachIndexed { index, component ->
            path = path.resolve(component)
            val current = Os.lstat(path.toString())
            stat = current
            if (OsConstants.S_ISLNK(current.st_mode) ||
                (!OsConstants.S_ISDIR(current.st_mode) && !OsConstants.S_ISREG(current.st_mode)) ||
                (index < components.lastIndex && !OsConstants.S_ISDIR(current.st_mode))
            ) {
                throw FileNotFoundException("lorum ipsum")
            }
            // A same-UID server/plugin can race this walk; it already has direct access to private data.
            // Refuse symlinks anyway, then verify the opened path and inode before any file I/O.
            if (path.toFile().canonicalFile.toPath() != path) throw FileNotFoundException("lorum ipsum")
        }
        if (!path.startsWith(checkout.toPath())) throw FileNotFoundException("lorum ipsum")
        val entry = Entry(path.toFile(), parts.takeIf { it.isNotEmpty() }?.joinToString("/"), stat!!)
        if (parts.isEmpty() && !entry.directory) throw FileNotFoundException("lorum ipsum")
        if (parts == listOf("data") && !entry.directory) throw FileNotFoundException("lorum ipsum")
        if (parts == listOf("config.yaml") && entry.directory) throw FileNotFoundException("lorum ipsum")
        return entry
    }

    fun open(entry: Entry, flags: Int): FileDescriptor {
        val fd = Os.open(
            entry.file.path,
            flags or OsConstants.O_NOFOLLOW or OsConstants.O_CLOEXEC or OsConstants.O_NONBLOCK,
            0,
        )
        try {
            val actual = Os.fstat(fd)
            android.os.ParcelFileDescriptor.dup(fd).use { duplicate ->
                val path = Os.readlink("/proc/self/fd/${duplicate.fd}")
                val opened = File(path).toPath()
                if (!opened.startsWith(checkout.toPath()) || opened != entry.file.toPath() ||
                    actual.st_dev != entry.stat.st_dev || actual.st_ino != entry.stat.st_ino ||
                    actual.st_mode != entry.stat.st_mode || !OsConstants.S_ISREG(actual.st_mode)
                ) {
                    throw FileNotFoundException("lorum ipsum")
                }
            }
            return fd
        } catch (failure: Throwable) {
            Os.close(fd)
            throw failure
        }
    }

    /**
     * Deletes [entry] and, for a directory, everything below it, children first. `remove(3)` unlinks anything
     * that is not a directory, so a symlink goes itself and is never followed, and hidden entries (sockets,
     * FIFOs) go with their folder. Only a directory that still has entries is listed and descended into, so a
     * file costs one call. Nothing is marked or recorded. Throws on the first entry that cannot go; an entry
     * that vanished meanwhile (the server deleting it too) is not a failure.
     */
    fun deleteTree(entry: Entry) {
        val pending = ArrayDeque<Path>()
        pending.addLast(entry.file.toPath())
        while (pending.isNotEmpty()) {
            val path = pending.last()
            val errno = try {
                Os.remove(path.toString())
                0
            } catch (failure: ErrnoException) {
                if (failure.errno !in REMOVE_RETRY_ERRNOS) throw failure
                failure.errno
            }
            if (errno == 0 || errno == OsConstants.ENOENT) {
                pending.removeLast()
                continue
            }
            // A directory with entries. Same-UID code could swap it for a symlink; refuse one that is not itself.
            if (path.toFile().canonicalFile.toPath() != path) throw FileNotFoundException("lorum ipsum")
            val names = path.toFile().list()
            if (names.isNullOrEmpty()) throw FileNotFoundException("lorum ipsum")
            names.forEach { name -> pending.addLast(path.resolve(name)) }
        }
    }

    companion object {
        const val ID_ATTRIBUTE = "user.sillybunny.document-id"
        const val XATTR_CREATE = 1
        private const val MODE_BITS = 0xfff
        val UUID_PATTERN = Regex("[a-f0-9-]{36}")

        // remove(3) outcomes that are not failures: gone already, or a directory that still has entries.
        private val REMOVE_RETRY_ERRNOS = setOf(OsConstants.ENOENT, OsConstants.ENOTEMPTY, OsConstants.EEXIST)
    }
}
