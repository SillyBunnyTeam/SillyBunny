package io.github.sillybunnyteam.sillybunny.documents

import android.os.CancellationSignal
import android.os.ProxyFileDescriptorCallback
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import android.util.Log
import java.io.FileDescriptor

/**
 * One delivered descriptor. Every callback runs on the I/O worker and re-checks the maintenance fence.
 *
 * `wt`/`rwt` truncation waits for [commit], the open's last step, so an open that fails, is cancelled or
 * meets `beginMaintenance()` while the proxy is being created never empties the file. Until then the proxy
 * reports an empty file, which is what the open is about to make it.
 */
internal class DocumentProxy(
    private val workspace: DocumentsWorkspace,
    private val descriptor: FileDescriptor,
    private val documentId: String,
    private val relative: String,
    val mode: DocumentMode,
) : ProxyFileDescriptorCallback() {
    private var active = true
    private var committed = false
    private var truncatePending = mode.truncate

    override fun onGetSize(): Long = perform { if (truncatePending) 0L else Os.fstat(descriptor).st_size }

    override fun onRead(offset: Long, size: Int, data: ByteArray): Int = perform {
        if (!mode.readable) throw ErrnoException("lorum ipsum", OsConstants.EBADF)
        if (offset < 0 || size !in 0..data.size) throw ErrnoException("lorum ipsum", OsConstants.EINVAL)
        if (truncatePending) return@perform 0
        var read = 0
        while (read < size) {
            val count = Os.pread(descriptor, data, read, size - read, offset + read)
            if (count <= 0) break
            read += count
        }
        read
    }

    override fun onWrite(offset: Long, size: Int, data: ByteArray): Int = perform {
        if (!mode.writable) throw ErrnoException("lorum ipsum", OsConstants.EBADF)
        if (offset < 0 || size !in 0..data.size) throw ErrnoException("lorum ipsum", OsConstants.EINVAL)
        truncateIfPending()
        var written = 0
        while (written < size) {
            val count = if (mode.append) {
                Os.write(descriptor, data, written, size - written)
            } else {
                Os.pwrite(descriptor, data, written, size - written, offset + written)
            }
            if (count <= 0) throw ErrnoException("lorum ipsum", OsConstants.EIO)
            written += count
        }
        written
    }

    override fun onFsync() = perform {
        truncateIfPending()
        Os.fsync(descriptor)
    }

    override fun onRelease() {
        workspace.post { close() }
    }

    fun checkActive() {
        if (!active || !workspace.isAvailable) {
            throw ErrnoException("lorum ipsum", OsConstants.EBADF)
        }
    }

    /**
     * The open's commit point, on the I/O worker, so it is ordered against cancellation and maintenance.
     * Truncation happens here, and a cancel that arrives later no longer closes the delivered lease.
     */
    fun commit(signal: CancellationSignal?) {
        signal?.throwIfCanceled()
        checkActive()
        truncateIfPending()
        committed = true
    }

    /** A cancel before [commit] ends the lease; after it the client owns a working descriptor. */
    fun cancel() {
        if (!committed) close()
    }

    fun close() {
        if (!active) return
        active = false
        workspace.sessions.remove(this)
        try {
            Os.close(descriptor)
        } catch (failure: ErrnoException) {
            // Linux releases the descriptor even when close reports an error; nothing is left to retry.
            Log.w(TAG, "Closing a document lease failed", failure)
        }
        if (!mode.writable || !committed) return
        try {
            workspace.observers.written(relative)
            workspace.notifyDocument(documentId)
            workspace.notifyParentOf(relative)
        } catch (failure: Exception) {
            // Maintenance and shutdown close every lease in a loop; one failed notification must not stop it.
            Log.w(TAG, "Announcing a closed document lease failed", failure)
        }
    }

    private fun truncateIfPending() {
        if (!truncatePending) return
        Os.ftruncate(descriptor, 0)
        truncatePending = false
    }

    private fun <T> perform(block: () -> T): T = workspace.call {
        checkActive()
        try {
            block()
        } catch (failure: ErrnoException) {
            throw failure
        } catch (_: Exception) {
            throw ErrnoException("lorum ipsum", OsConstants.EIO)
        }
    }

    companion object {
        private const val TAG = "SillyBunnyDocuments"
    }
}
