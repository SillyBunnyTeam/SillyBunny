package io.github.sillybunnyteam.sillybunny.documents

import android.content.ContentValues
import android.database.DatabaseUtils
import android.database.sqlite.SQLiteDatabase
import android.os.ParcelFileDescriptor
import android.system.Os
import java.io.File
import java.io.FileDescriptor
import java.io.FileNotFoundException
import java.util.Base64

/**
 * Document IDs and the ledger of every ID handed out, which delete, rename, the observers and maintenance
 * use to revoke grants and to find the cursors worth notifying.
 *
 * Format: `v2:<root token>:<inode>:<marker>:<relative path>`. IDs live on in persisted grants across
 * reboots, so they hold only boot-stable parts. `st_dev` is left out on purpose: `/data` is a device-mapper
 * device whose minor number can change between boots (for example an OTA boot that maps snapshot devices
 * before userdata), which would orphan every saved ID. The random per-inode marker already makes IDs
 * unique; the dev/inode comparisons between a walk and its open stay, because they happen within one boot.
 */
internal class DocumentIds(private val files: DocumentFiles, stateDirectory: File, private val root: () -> String) {
    private val database by lazy {
        SQLiteDatabase.openOrCreateDatabase(File(stateDirectory, "documents-ids.db"), null).apply {
            execSQL("CREATE TABLE IF NOT EXISTS issued (id TEXT PRIMARY KEY NOT NULL, relative TEXT NOT NULL)")
            execSQL("CREATE INDEX IF NOT EXISTS issued_relative ON issued(relative)")
        }
    }

    /** The ID to hand out for [entry]: marks the entry on first sight and records the ID. */
    fun id(entry: DocumentFiles.Entry): String {
        val relative = entry.relative ?: return root()
        val id = format(entry, files.identity(entry))
        record(id, relative)
        return id
    }

    /** The entry's ID if it already carries a marker. Never marks the entry or records anything. */
    fun existing(entry: DocumentFiles.Entry): String? {
        if (entry.relative == null) return root()
        return files.existingIdentity(entry)?.let { format(entry, it) }
    }

    /** Runs [block] in one ledger transaction, so a listing records its new IDs with a single commit. */
    fun <T> batch(block: () -> T): T {
        database.beginTransactionNonExclusive()
        try {
            return block().also { database.setTransactionSuccessful() }
        } finally {
            database.endTransaction()
        }
    }

    fun issuedUnder(relative: String?): List<String> {
        val selection = if (relative == null) null else UNDER
        val args = relative?.let { arrayOf(it, "$it/", "$it/") }
        return database.query("issued", arrayOf("id"), selection, args, null, null, null).use { cursor ->
            buildList { while (cursor.moveToNext()) add(cursor.getString(0)) }
        }
    }

    /** IDs recorded for exactly [relative]; at most one of them still resolves. */
    fun issuedAt(relative: String): List<String> =
        database.query("issued", arrayOf("id"), "relative = ?", arrayOf(relative), null, null, null).use { cursor ->
            buildList { while (cursor.moveToNext()) add(cursor.getString(0)) }
        }

    fun forget(id: String) {
        database.delete("issued", "id = ?", arrayOf(id))
    }

    fun forgetUnder(relative: String) {
        database.delete("issued", UNDER, arrayOf(relative, "$relative/", "$relative/"))
    }

    fun clear() {
        database.delete("issued", null, null)
    }

    fun resolve(id: String): DocumentFiles.Entry {
        if (id == root()) return files.root()
        val relative = parse(id).relative
        val entry = files.resolve(relative)
        if (existing(entry) != id) throw FileNotFoundException("TODO(copy)")
        // A valid ID that an over-cautious revocation forgot is recorded again, so later deletes still revoke it.
        record(id, relative)
        return entry
    }

    fun verifyOpened(id: String, descriptor: FileDescriptor) {
        val expected = parse(id).marker
        ParcelFileDescriptor.dup(descriptor).use { duplicate ->
            // The procfs handle pins the opened inode even if its pathname was replaced after resolution.
            val marker = Os.getxattr("/proc/self/fd/${duplicate.fd}", DocumentFiles.ID_ATTRIBUTE)
            if (String(marker, Charsets.US_ASCII) != expected) throw FileNotFoundException("TODO(copy)")
        }
    }

    private fun format(entry: DocumentFiles.Entry, marker: String): String {
        val relative = requireNotNull(entry.relative)
        val encoded = Base64.getUrlEncoder().withoutPadding().encodeToString(relative.toByteArray(Charsets.UTF_8))
        return "$VERSION:${rootToken()}:${entry.stat.st_ino}:$marker:$encoded"
    }

    private fun rootToken(): String = Base64.getUrlEncoder().withoutPadding()
        .encodeToString(root().removePrefix("root:").toByteArray(Charsets.US_ASCII))

    private class Parsed(val marker: String, val relative: String)

    private fun parse(id: String): Parsed {
        if (id.length > 8192 || !id.matches(ID_PATTERN)) throw FileNotFoundException("TODO(copy)")
        val parts = id.split(':')
        if (parts.size != 5 || parts[0] != VERSION || parts[1] != rootToken()) throw FileNotFoundException("TODO(copy)")
        val relative = try {
            String(Base64.getUrlDecoder().decode(parts[4]), Charsets.UTF_8)
        } catch (_: IllegalArgumentException) {
            throw FileNotFoundException("TODO(copy)")
        }
        return Parsed(parts[3], relative)
    }

    private fun record(id: String, relative: String) {
        if (DatabaseUtils.queryNumEntries(database, "issued", "id = ?", arrayOf(id)) > 0) return
        val values = ContentValues().apply {
            put("id", id)
            put("relative", relative)
        }
        database.insertWithOnConflict("issued", null, values, SQLiteDatabase.CONFLICT_IGNORE)
    }

    companion object {
        private const val VERSION = "v2"
        private const val UNDER = "relative = ? COLLATE BINARY OR substr(relative, 1, length(?)) = ? COLLATE BINARY"
        private val ID_PATTERN = Regex("v2:[A-Za-z0-9_-]+:[0-9]+:[a-f0-9-]{36}:[A-Za-z0-9_-]+")
    }
}
