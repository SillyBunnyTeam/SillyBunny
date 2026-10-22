package io.github.sillybunnyteam.sillybunny.documents

import android.os.Handler
import android.os.ParcelFileDescriptor
import android.os.ProxyFileDescriptorCallback
import android.os.storage.StorageManager
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import android.system.StructStat
import android.system.StructTimespec
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.annotation.Resetter
import org.robolectric.shadow.api.Shadow
import org.robolectric.shadows.ShadowParcelFileDescriptor
import org.robolectric.shadows.ShadowStorageManager
import org.robolectric.util.ReflectionHelpers
import java.io.File
import java.io.FileDescriptor
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.channels.ClosedChannelException
import java.nio.channels.FileChannel
import java.nio.channels.NonReadableChannelException
import java.nio.channels.NonWritableChannelException
import java.nio.file.AccessDeniedException
import java.nio.file.DirectoryNotEmptyException
import java.nio.file.FileAlreadyExistsException
import java.nio.file.FileSystemException
import java.nio.file.FileSystemLoopException
import java.nio.file.Files
import java.nio.file.InvalidPathException
import java.nio.file.LinkOption
import java.nio.file.NoSuchFileException
import java.nio.file.NotDirectoryException
import java.nio.file.OpenOption
import java.nio.file.Path
import java.nio.file.StandardOpenOption
import java.nio.file.attribute.FileTime
import java.nio.file.attribute.PosixFilePermission
import java.nio.file.attribute.PosixFilePermissions
import java.nio.file.attribute.UserDefinedFileAttributeView
import sun.misc.Unsafe

@Implements(Os::class)
class PosixTestOs {
    companion object {
        private data class Handle(
            val descriptor: FileDescriptor,
            val channel: FileChannel,
            val flags: Int,
        )

        private val handles = mutableMapOf<Int, Handle>()
        var beforeOpen: ((String, Int) -> Unit)? = null

        // Runs before every remove(3); a test throws from it to make one removal fail.
        var beforeRemove: ((String) -> Unit)? = null

        // Added to every st_dev, like a boot that maps /data on another device-mapper minor.
        @Volatile
        var deviceOffset = 0L
        private val attributesLock = Any()
        private val descriptorNumber = FileDescriptor::class.java.getDeclaredField("fd").apply {
            isAccessible = true
        }
        private val unsafe: Unsafe by lazy {
            Unsafe::class.java.getDeclaredField("theUnsafe").apply { isAccessible = true }.get(null) as Unsafe
        }

        @JvmStatic
        @Implementation
        fun stat(path: String): StructStat = posix("stat") {
            attributes(Path.of(path), follow = true)
        }

        @JvmStatic
        @Implementation
        fun lstat(path: String): StructStat = posix("lstat") {
            attributes(Path.of(path), follow = false)
        }

        @JvmStatic
        @Implementation
        fun fstat(fd: FileDescriptor): StructStat = posix("fstat") {
            attributes(descriptorPath(fd), follow = true)
        }

        @JvmStatic
        @Implementation
        fun readlink(path: String): String = posix("readlink") {
            Files.readSymbolicLink(Path.of(path)).toString()
        }

        @JvmStatic
        @Implementation
        fun open(path: String, flags: Int, mode: Int): FileDescriptor = posix("open") {
            beforeOpen?.invoke(path, flags)
            val target = Path.of(path)
            val access = flags and OsConstants.O_ACCMODE
            if (access !in listOf(OsConstants.O_RDONLY, OsConstants.O_WRONLY, OsConstants.O_RDWR)) {
                throw ErrnoException("open", OsConstants.EINVAL)
            }
            val writable = access != OsConstants.O_RDONLY
            val create = flags and OsConstants.O_CREAT != 0
            val exclusive = create && flags and OsConstants.O_EXCL != 0
            val permissions = PosixFilePermissions.asFileAttribute(
                PosixFilePermission.entries.filterIndexed { index, _ -> mode and (1 shl (8 - index)) != 0 }.toSet(),
            )
            val options = mutableSetOf<OpenOption>()
            if (access != OsConstants.O_WRONLY) options += StandardOpenOption.READ
            if (writable) options += StandardOpenOption.WRITE
            if (flags and OsConstants.O_NOFOLLOW != 0) options += LinkOption.NOFOLLOW_LINKS
            if (writable && create) {
                options += if (exclusive) StandardOpenOption.CREATE_NEW else StandardOpenOption.CREATE
            } else if (create) {
                // NIO ignores CREATE on a read-only channel, although POSIX permits O_RDONLY | O_CREAT.
                try {
                    Files.createFile(target, permissions)
                } catch (exists: FileAlreadyExistsException) {
                    if (exclusive) throw exists
                }
            }
            if (writable && flags and OsConstants.O_TRUNC != 0) options += StandardOpenOption.TRUNCATE_EXISTING
            if (flags and OsConstants.O_SYNC != 0) options += StandardOpenOption.SYNC
            val channel = FileChannel.open(target, options, permissions)
            try {
                // Reading the JDK field through Unsafe avoids requiring a sun.nio.ch --add-opens.
                val field = channel.javaClass.getDeclaredField("fd")
                @Suppress("DEPRECATION")
                val descriptor = unsafe.getObject(channel, unsafe.objectFieldOffset(field)) as FileDescriptor
                synchronized(handles) { handles[number(descriptor)] = Handle(descriptor, channel, flags) }
                descriptor
            } catch (failure: Throwable) {
                channel.close()
                throw failure
            }
        }

        @JvmStatic
        @Implementation
        fun dup(fd: FileDescriptor): FileDescriptor = posix("dup") {
            val number = number(fd)
            val info = Files.readAllLines(Path.of("/proc/self/fdinfo/$number"))
            val flags = synchronized(handles) { handles[number]?.flags }
                ?: info.first { it.startsWith("flags:") }.substringAfter(':').trim().toInt(8)
            val position = info.first { it.startsWith("pos:") }.substringAfter(':').trim().toLong()
            // Reopening procfs preserves the actual inode, including renamed/unlinked files, but
            // does not share the kernel offset like dup(2). These duplicates are for verification.
            val duplicateFlags = flags and (OsConstants.O_ACCMODE or OsConstants.O_APPEND or OsConstants.O_SYNC)
            val duplicate = open(descriptorPath(fd).toString(), duplicateFlags, 0)
            try {
                lseek(duplicate, position, OsConstants.SEEK_SET)
                duplicate
            } catch (failure: Throwable) {
                close(duplicate)
                throw failure
            }
        }

        @JvmStatic
        @Implementation
        fun close(fd: FileDescriptor) = posix("close") {
            val handle = synchronized(handles) { handles.remove(number(fd)) }
                ?: throw ErrnoException("close", OsConstants.EBADF)
            handle.channel.close()
        }

        @JvmStatic
        @Implementation
        fun pread(fd: FileDescriptor, bytes: ByteArray, offset: Int, count: Int, position: Long): Int =
            pread(fd, ByteBuffer.wrap(bytes, offset, count), position)

        @JvmStatic
        @Implementation
        fun pread(fd: FileDescriptor, buffer: ByteBuffer, position: Long): Int = posix("pread") {
            if (position < 0) throw ErrnoException("pread", OsConstants.EINVAL)
            handle(fd, "pread").channel.read(buffer, position).coerceAtLeast(0)
        }

        @JvmStatic
        @Implementation
        fun pwrite(fd: FileDescriptor, bytes: ByteArray, offset: Int, count: Int, position: Long): Int =
            pwrite(fd, ByteBuffer.wrap(bytes, offset, count), position)

        @JvmStatic
        @Implementation
        fun pwrite(fd: FileDescriptor, buffer: ByteBuffer, position: Long): Int = posix("pwrite") {
            if (position < 0) throw ErrnoException("pwrite", OsConstants.EINVAL)
            val handle = handle(fd, "pwrite")
            synchronized(handle) {
                val target = if (handle.flags and OsConstants.O_APPEND != 0) handle.channel.size() else position
                handle.channel.write(buffer, target)
            }
        }

        @JvmStatic
        @Implementation
        fun read(fd: FileDescriptor, bytes: ByteArray, offset: Int, count: Int): Int =
            read(fd, ByteBuffer.wrap(bytes, offset, count))

        @JvmStatic
        @Implementation
        fun read(fd: FileDescriptor, buffer: ByteBuffer): Int = posix("read") {
            val handle = handle(fd, "read")
            synchronized(handle) { handle.channel.read(buffer).coerceAtLeast(0) }
        }

        @JvmStatic
        @Implementation
        fun write(fd: FileDescriptor, bytes: ByteArray, offset: Int, count: Int): Int =
            write(fd, ByteBuffer.wrap(bytes, offset, count))

        @JvmStatic
        @Implementation
        fun write(fd: FileDescriptor, buffer: ByteBuffer): Int = posix("write") {
            val handle = handle(fd, "write")
            synchronized(handle) {
                if (handle.flags and OsConstants.O_APPEND != 0) handle.channel.position(handle.channel.size())
                handle.channel.write(buffer)
            }
        }

        @JvmStatic
        @Implementation
        fun lseek(fd: FileDescriptor, offset: Long, whence: Int): Long = posix("lseek") {
            val handle = handle(fd, "lseek")
            synchronized(handle) {
                val base = when (whence) {
                    OsConstants.SEEK_SET -> 0L
                    OsConstants.SEEK_CUR -> handle.channel.position()
                    OsConstants.SEEK_END -> handle.channel.size()
                    else -> throw ErrnoException("lseek", OsConstants.EINVAL)
                }
                val position = Math.addExact(base, offset)
                if (position < 0) throw ErrnoException("lseek", OsConstants.EINVAL)
                handle.channel.position(position)
                position
            }
        }

        @JvmStatic
        @Implementation
        fun ftruncate(fd: FileDescriptor, length: Long) = posix("ftruncate") {
            if (length < 0) throw ErrnoException("ftruncate", OsConstants.EINVAL)
            val handle = handle(fd, "ftruncate")
            if (handle.flags and OsConstants.O_ACCMODE == OsConstants.O_RDONLY) {
                throw ErrnoException("ftruncate", OsConstants.EBADF)
            }
            synchronized(handle) {
                val position = handle.channel.position()
                if (length > handle.channel.size()) {
                    handle.channel.write(ByteBuffer.wrap(byteArrayOf(0)), length - 1)
                } else {
                    handle.channel.truncate(length)
                }
                // FileChannel.truncate moves the cursor; ftruncate(2) must leave it alone.
                handle.channel.position(position)
                Unit
            }
        }

        @JvmStatic
        @Implementation
        fun fsync(fd: FileDescriptor) = posix("fsync") { handle(fd, "fsync").channel.force(true) }

        @JvmStatic
        @Implementation
        fun fdatasync(fd: FileDescriptor) = posix("fdatasync") { handle(fd, "fdatasync").channel.force(false) }

        @JvmStatic
        @Implementation
        fun remove(path: String) = posix("remove") {
            beforeRemove?.invoke(path)
            // remove(3): unlinks anything but a directory (a symlink itself), and removes an empty directory.
            Files.delete(Path.of(path))
        }

        @JvmStatic
        @Implementation
        fun chmod(path: String, mode: Int) = posix("chmod") {
            // NIO follows symlinks like chmod(2). Set-ID and sticky bits are not modelled here.
            Files.setPosixFilePermissions(
                Path.of(path),
                PosixFilePermission.entries.filterIndexed { index, _ -> mode and (1 shl (8 - index)) != 0 }.toSet(),
            )
        }

        @JvmStatic
        @Implementation
        fun getxattr(path: String, name: String): ByteArray = posix("getxattr") {
            synchronized(attributesLock) {
                // WSL tests run as root, which bypasses DAC. An app UID needs read permission here.
                requireOwnerPermission(path, PosixFilePermission.OWNER_READ, "getxattr")
                val attribute = attributeName(name, "getxattr")
                val view = Files.getFileAttributeView(Path.of(path), UserDefinedFileAttributeView::class.java)
                    ?: throw ErrnoException("getxattr", OsConstants.ENOTSUP)
                if (attribute !in runCatching { view.list() }.getOrElse {
                        throw ErrnoException("getxattr", OsConstants.ENODATA, it)
                    }
                ) throw ErrnoException("getxattr", OsConstants.ENODATA)
                val buffer = ByteBuffer.allocate(view.size(attribute))
                view.read(attribute, buffer)
                buffer.flip()
                ByteArray(buffer.remaining()).also { buffer.get(it) }
            }
        }

        @JvmStatic
        @Implementation
        fun setxattr(path: String, name: String, value: ByteArray, flags: Int) = posix("setxattr") {
            synchronized(attributesLock) {
                if (flags !in 0..2) throw ErrnoException("setxattr", OsConstants.EINVAL)
                // As above: an app UID needs inode write permission to add a user.* attribute.
                requireOwnerPermission(path, PosixFilePermission.OWNER_WRITE, "setxattr")
                val attribute = attributeName(name, "setxattr")
                val view = Files.getFileAttributeView(Path.of(path), UserDefinedFileAttributeView::class.java)
                    ?: throw ErrnoException("setxattr", OsConstants.ENOTSUP)
                val attributes = runCatching { view.list() }.getOrElse {
                    throw ErrnoException("setxattr", OsConstants.ENOTSUP, it)
                }
                val exists = attribute in attributes
                if (flags == 1 && exists) throw ErrnoException("setxattr", OsConstants.EEXIST)
                if (flags == 2 && !exists) throw ErrnoException("setxattr", OsConstants.ENODATA)
                view.write(attribute, ByteBuffer.wrap(value))
                Unit
            }
        }

        @JvmStatic
        @Resetter
        fun reset() {
            beforeOpen = null
            deviceOffset = 0
            val opened = synchronized(handles) { handles.values.toList().also { handles.clear() } }
            opened.forEach { runCatching { it.channel.close() } }
        }

        internal fun number(fd: FileDescriptor): Int {
            if (!fd.valid()) throw ErrnoException("fd", OsConstants.EBADF)
            return descriptorNumber.getInt(fd)
        }

        private fun descriptorPath(fd: FileDescriptor): Path = Path.of("/proc/self/fd/${number(fd)}")

        private fun handle(fd: FileDescriptor, function: String): Handle = synchronized(handles) {
            val current = handles[number(fd)]
            if (current == null || !current.channel.isOpen || !current.descriptor.valid()) {
                throw ErrnoException(function, OsConstants.EBADF)
            }
            current
        }

        private fun attributes(path: Path, follow: Boolean): StructStat {
            val options = if (follow) emptyArray() else arrayOf(LinkOption.NOFOLLOW_LINKS)
            val values = Files.readAttributes(path, "unix:*", *options)
            fun long(name: String): Long = (values.getValue(name) as Number).toLong()
            fun time(name: String): StructTimespec {
                val instant = (values.getValue(name) as FileTime).toInstant()
                return StructTimespec(instant.epochSecond, instant.nano.toLong())
            }
            // unix:* supplies identity/type/timestamps, but the JDK omits allocation statistics.
            // GNU stat supplies those without opening FIFOs; use our PID for procfs in the child.
            val childPath = if (path.startsWith("/proc/self")) {
                "/proc/${ProcessHandle.current().pid()}/${Path.of("/proc/self").relativize(path)}"
            } else {
                path.toString()
            }
            val command = mutableListOf("stat")
            if (follow) command += "--dereference"
            command += listOf("--printf=%o %b", "--", childPath)
            val process = ProcessBuilder(command).redirectErrorStream(true).start()
            val output = process.inputStream.bufferedReader().use { it.readText() }
            if (process.waitFor() != 0) throw IOException(output)
            val allocation = output.trim().split(' ').map(String::toLong)
            return StructStat(
                long("dev") + deviceOffset, long("ino"), long("mode").toInt(), long("nlink"), long("uid").toInt(),
                long("gid").toInt(), long("rdev"), long("size"), time("lastAccessTime"),
                time("lastModifiedTime"), time("ctime"), allocation[0], allocation[1],
            )
        }

        private fun requireOwnerPermission(path: String, permission: PosixFilePermission, function: String) {
            if (permission !in Files.getPosixFilePermissions(Path.of(path))) {
                throw ErrnoException(function, OsConstants.EACCES)
            }
        }

        private fun attributeName(name: String, function: String): String {
            if (!name.startsWith("user.")) throw ErrnoException(function, OsConstants.ENOTSUP)
            val attribute = name.removePrefix("user.")
            if (attribute.isEmpty() || '\u0000' in attribute) throw ErrnoException(function, OsConstants.EINVAL)
            return attribute
        }

        private inline fun <T> posix(function: String, operation: () -> T): T = try {
            operation()
        } catch (failure: ErrnoException) {
            throw failure
        } catch (failure: Exception) {
            val errno = when (failure) {
                is NoSuchFileException -> OsConstants.ENOENT
                is DirectoryNotEmptyException -> OsConstants.ENOTEMPTY
                is FileAlreadyExistsException -> OsConstants.EEXIST
                is AccessDeniedException -> OsConstants.EACCES
                is NotDirectoryException -> OsConstants.ENOTDIR
                is FileSystemLoopException -> OsConstants.ELOOP
                is ClosedChannelException, is NonReadableChannelException, is NonWritableChannelException -> OsConstants.EBADF
                is InvalidPathException, is IllegalArgumentException -> OsConstants.EINVAL
                is ArithmeticException -> OsConstants.EOVERFLOW
                is UnsupportedOperationException -> OsConstants.ENOTSUP
                else -> {
                    val reason = ((failure as? FileSystemException)?.reason ?: failure.message).orEmpty().lowercase()
                    when {
                        "too many levels" in reason -> OsConstants.ELOOP
                        "is a directory" in reason -> OsConstants.EISDIR
                        "not a directory" in reason -> OsConstants.ENOTDIR
                        "no such file" in reason -> OsConstants.ENOENT
                        "no data available" in reason -> OsConstants.ENODATA
                        "not supported" in reason -> OsConstants.ENOTSUP
                        "file name too long" in reason -> OsConstants.ENAMETOOLONG
                        "permission denied" in reason -> OsConstants.EACCES
                        else -> OsConstants.EIO
                    }
                }
            }
            throw ErrnoException(function, errno, failure)
        }
    }
}

@Implements(StorageManager::class)
class ProxyTestStorageManager : ShadowStorageManager() {
    @Implementation
    fun openProxyFileDescriptor(
        mode: Int,
        callback: ProxyFileDescriptorCallback,
        @Suppress("UNUSED_PARAMETER") handler: Handler?,
    ): ParcelFileDescriptor {
        // Runs where AppFuse would mount and open the proxy, for user leases only (not the API 29 sentinel).
        if (callback is DocumentProxy) duringOpen?.invoke(callback)
        val placeholder = File.createTempFile("documents-proxy-", ".tmp", RuntimeEnvironment.getApplication().cacheDir)
        try {
            val descriptor = ParcelFileDescriptor.open(placeholder, mode)
            synchronized(callbacks) {
                callbacks[descriptor.fd] = CapturedProxy(descriptor, callback, placeholder)
            }
            // This is only a callback carrier. OS I/O on the placeholder is NOT proxy-mediated.
            return descriptor
        } catch (failure: Throwable) {
            placeholder.delete()
            throw failure
        }
    }

    companion object {
        private data class CapturedProxy(
            val descriptor: ParcelFileDescriptor,
            val callback: ProxyFileDescriptorCallback,
            val placeholder: File,
        )

        private val callbacks = mutableMapOf<Int, CapturedProxy>()

        @Volatile
        var duringOpen: ((ProxyFileDescriptorCallback) -> Unit)? = null

        @JvmStatic
        fun callbackFor(descriptor: ParcelFileDescriptor): ProxyFileDescriptorCallback = synchronized(callbacks) {
            val captured = callbacks[descriptor.fd]
            check(captured?.descriptor === descriptor) { "No proxy callback for this descriptor" }
            captured.callback
        }

        @JvmStatic
        fun release(descriptor: ParcelFileDescriptor) {
            val captured = synchronized(callbacks) {
                val entry = callbacks.entries.firstOrNull { it.value.descriptor === descriptor }
                entry?.let { callbacks.remove(it.key) }
            }
            try {
                captured?.callback?.onRelease()
            } finally {
                try {
                    descriptor.close()
                } finally {
                    captured?.placeholder?.delete()
                }
            }
        }

        @JvmStatic
        @Resetter
        fun resetProxies() {
            duringOpen = null
            val descriptors = synchronized(callbacks) { callbacks.values.map { it.descriptor } }
            descriptors.forEach { runCatching { release(it) } }
        }
    }
}

@Implements(ParcelFileDescriptor::class)
class PosixTestParcelFileDescriptor : ShadowParcelFileDescriptor() {
    private var duplicate: FileDescriptor? = null
    private var duplicateClosed = false

    @Implementation
    public override fun getFileDescriptor(): FileDescriptor = duplicate ?: super.getFileDescriptor()

    @Implementation
    public override fun getFd(): Int {
        check(!duplicateClosed) { "Already closed" }
        return duplicate?.let(PosixTestOs::number) ?: super.getFd()
    }

    @Implementation
    public override fun getStatSize(): Long = duplicate?.let { PosixTestOs.fstat(it).st_size } ?: super.getStatSize()

    @Implementation
    public override fun close() {
        val descriptor = duplicate
        if (descriptor == null) {
            super.close()
        } else if (!duplicateClosed) {
            duplicateClosed = true
            try {
                PosixTestOs.close(descriptor)
            } finally {
                // The real PFD owns a CloseGuard even though this shadow owns the host channel.
                super.close()
            }
        }
    }

    @Implementation
    public override fun dup(): ParcelFileDescriptor = duplicateDescriptor(fileDescriptor)

    companion object {
        @JvmStatic
        @Implementation(methodName = "dup")
        fun duplicateDescriptor(fd: FileDescriptor): ParcelFileDescriptor {
            val duplicate = PosixTestOs.dup(fd)
            try {
                val descriptor = ReflectionHelpers.callConstructor(
                    ParcelFileDescriptor::class.java,
                    ReflectionHelpers.ClassParameter.from(FileDescriptor::class.java, duplicate),
                )
                Shadow.extract<PosixTestParcelFileDescriptor>(descriptor).duplicate = duplicate
                return descriptor
            } catch (failure: Throwable) {
                PosixTestOs.close(duplicate)
                throw failure
            }
        }
    }
}
