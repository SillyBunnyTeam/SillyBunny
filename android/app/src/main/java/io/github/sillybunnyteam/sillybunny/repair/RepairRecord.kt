package io.github.sillybunnyteam.sillybunny.repair

import android.content.Context
import io.github.sillybunnyteam.sillybunny.checkout.BrokenCheckouts
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileNotFoundException
import java.io.FileOutputStream
import java.io.IOException
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
import java.time.DateTimeException
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException
import java.time.temporal.ChronoUnit

/** The step an unfinished Repair reached. Each is persisted before that step's side effect (plan §4.7). */
enum class RepairPhase {
    /** Stopping the server; nothing has moved yet. */
    STOPPING,

    /** Beginning provider maintenance; nothing has moved yet. */
    QUIESCING,

    /** Renaming the checkout aside; [RepairRecord.movingAt] and [RepairRecord.preexisting] identify its new name. */
    MOVING_ASIDE,

    /** A retry is renaming a partial new checkout aside; [RepairRecord.source] stays the original folder. */
    MOVING_PARTIAL_ASIDE,

    /** `install.sh --migrate-from <source>` is running in the server host's foreground service. */
    REINSTALLING,

    /** The last attempt failed; [RepairRecord.source] still holds the data and a retry migrates from it. */
    FAILED,
}

/**
 * The persisted state of an unfinished Repair. A record exists from the user's confirmation until the
 * reinstall succeeds. Folders are stored by name inside `filesDir`, never as paths.
 */
data class RepairRecord(
    val phase: RepairPhase,
    val startedAt: Instant,
    /** The moved-aside folder holding the user's data: every attempt migrates from it. Null until it moves. */
    val source: String? = null,
    /**
     * The `--ref` for every attempt: computed once from [source]'s tracking configuration, or the default
     * branch once the user chose [RepairController.retryWithDefaultRef]. Later retries keep it.
     */
    val ref: String? = null,
    val failure: RepairFailure? = null,
    /** Moved-aside folder names that existed just before the rename now in flight. */
    val preexisting: List<String> = emptyList(),
    /** The instant passed to `BrokenCheckouts.moveAside` for the rename now in flight; the new name carries it. */
    val movingAt: Instant? = null,
    /** Partial checkouts that retries moved aside. They never become the migration source. */
    val partials: List<String> = emptyList(),
) {
    /** True when the rename this record has in flight may have made the moved-aside folder [name]. */
    internal fun mayHaveMade(name: String): Boolean {
        if (phase != RepairPhase.MOVING_ASIDE && phase != RepairPhase.MOVING_PARTIAL_ASIDE) return false
        if (name in preexisting) return false
        val at = movingAt ?: return true
        return stampedAt(name, at)
    }
}

private val movedAsideName = Regex("""SillyBunny\.broken-(\d{8}T\d{6}Z)(?:-\d+)?""")
private val movedAsideStamp = DateTimeFormatter.ofPattern("yyyyMMdd'T'HHmmss'Z'").withZone(ZoneOffset.UTC)

/** When a moved-aside folder was moved, read from its name to the second; null for any other name. */
internal fun movedAsideAt(name: String): Instant? {
    val stamp = movedAsideName.matchEntire(name)?.groupValues?.get(1) ?: return null
    return try {
        Instant.from(movedAsideStamp.parse(stamp))
    } catch (_: DateTimeException) {
        null
    }
}

/** True when [name] carries the stamp that `BrokenCheckouts.moveAside(paths, at)` gives its folders. */
internal fun stampedAt(name: String, at: Instant): Boolean = movedAsideAt(name) == at.truncatedTo(ChronoUnit.SECONDS)

/**
 * Stores the one [RepairRecord] as JSON at `noBackupFilesDir/repair-record.json` (tests pass their own file).
 * Every write goes to a synced temporary file that is renamed over the record, then the directory is synced,
 * so a write either fully lands or leaves the previous record. Every failure surfaces as an [IOException].
 */
class RepairStore(private val file: File) {
    constructor(context: Context) : this(File(context.noBackupFilesDir, FILE_NAME))

    private val temporary = File(file.path + ".tmp")

    /** The stored record, or null when there is none. Throws when a record exists but cannot be read. */
    @Throws(IOException::class)
    fun load(): RepairRecord? = synchronized(this) {
        val bytes = try {
            FileInputStream(file).use { input ->
                val output = ByteArrayOutputStream()
                val buffer = ByteArray(4_096)
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    output.write(buffer, 0, count)
                    if (output.size() > MAX_BYTES) throw IOException("Repair record too large")
                }
                output.toByteArray()
            }
        } catch (_: FileNotFoundException) {
            if (!file.exists()) return null
            throw IOException("Unreadable Repair record")
        }
        return try {
            decode(JSONObject(String(bytes, Charsets.UTF_8)))
        } catch (failure: JSONException) {
            throw IOException("Unreadable Repair record", failure)
        } catch (failure: IllegalArgumentException) {
            throw IOException("Unreadable Repair record", failure)
        } catch (failure: DateTimeParseException) {
            throw IOException("Unreadable Repair record", failure)
        }
    }

    @Throws(IOException::class)
    fun save(record: RepairRecord) {
        synchronized(this) {
            file.parentFile?.mkdirs()
            FileOutputStream(temporary).use { output ->
                output.write(encode(record).toString().toByteArray(Charsets.UTF_8))
                output.fd.sync()
            }
            Files.move(temporary.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE)
            syncDirectory()
        }
    }

    /** Removes the record. The temporary file goes first, so a failed clear always leaves the record itself. */
    @Throws(IOException::class)
    fun clear() {
        synchronized(this) {
            Files.deleteIfExists(temporary.toPath())
            Files.deleteIfExists(file.toPath())
            syncDirectory()
        }
    }

    // Makes the rename durable before the step it guards renames the checkout. Best effort: a platform that
    // cannot open a directory as a channel still gets the atomic rename.
    private fun syncDirectory() {
        val directory = file.parentFile ?: return
        try {
            FileChannel.open(directory.toPath(), StandardOpenOption.READ).use { it.force(true) }
        } catch (_: IOException) {
            // Nothing more to do; see above.
        }
    }

    private fun encode(record: RepairRecord) = JSONObject().apply {
        put("version", VERSION)
        put("phase", record.phase.name)
        put("startedAt", record.startedAt.toString())
        record.source?.let { put("source", it) }
        record.ref?.let { put("ref", it) }
        record.failure?.let { put("failure", it.name) }
        put("preexisting", JSONArray(record.preexisting))
        record.movingAt?.let { put("movingAt", it.toString()) }
        put("partials", JSONArray(record.partials))
    }

    private fun decode(json: JSONObject): RepairRecord {
        require(json.getInt("version") == VERSION) { "Unsupported Repair record version" }
        return RepairRecord(
            phase = RepairPhase.valueOf(json.getString("phase")),
            startedAt = Instant.parse(json.getString("startedAt")),
            source = json.optionalString("source")?.also(::requireFolderName),
            ref = json.optionalString("ref")?.also {
                require(it.isNotEmpty() && !it.startsWith('-')) { "Not a usable ref" }
            },
            failure = json.optionalString("failure")?.let(RepairFailure::valueOf),
            preexisting = json.names("preexisting"),
            movingAt = json.optionalString("movingAt")?.let(Instant::parse),
            partials = json.names("partials"),
        )
    }

    private fun JSONObject.optionalString(key: String): String? =
        if (has(key) && !isNull(key)) getString(key) else null

    private fun JSONObject.names(key: String): List<String> {
        val array = optJSONArray(key) ?: return emptyList()
        return List(array.length()) { array.getString(it).also(::requireFolderName) }
    }

    // A record only ever names moved-aside folders directly inside filesDir, never another path.
    private fun requireFolderName(name: String) =
        require(BrokenCheckouts.isBrokenCheckoutName(name)) { "Not a moved-aside folder name" }

    companion object {
        const val FILE_NAME = "repair-record.json"
        private const val VERSION = 1
        private const val MAX_BYTES = 64 * 1024
    }
}
