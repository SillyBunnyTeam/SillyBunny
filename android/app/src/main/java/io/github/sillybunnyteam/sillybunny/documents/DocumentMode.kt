package io.github.sillybunnyteam.sillybunny.documents

import android.os.ParcelFileDescriptor
import android.system.OsConstants
import java.io.FileNotFoundException

internal data class DocumentMode(val readable: Boolean, val writable: Boolean, val truncate: Boolean, val append: Boolean) {
    val openFlags: Int get() = (if (writable) OsConstants.O_RDWR else OsConstants.O_RDONLY) or
        (if (append) OsConstants.O_APPEND else 0)
    val proxyFlags: Int get() = when {
        readable && writable -> ParcelFileDescriptor.MODE_READ_WRITE
        writable -> ParcelFileDescriptor.MODE_WRITE_ONLY
        else -> ParcelFileDescriptor.MODE_READ_ONLY
    }

    companion object {
        fun parse(mode: String): DocumentMode = when (mode) {
            "r" -> DocumentMode(true, false, false, false)
            "w" -> DocumentMode(false, true, false, false)
            "wt" -> DocumentMode(false, true, true, false)
            "wa" -> DocumentMode(false, true, false, true)
            "rw" -> DocumentMode(true, true, false, false)
            "rwt" -> DocumentMode(true, true, true, false)
            else -> throw FileNotFoundException("TODO(copy)")
        }
    }
}
