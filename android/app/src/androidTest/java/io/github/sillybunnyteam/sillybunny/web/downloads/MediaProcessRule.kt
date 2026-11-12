package io.github.sillybunnyteam.sillybunny.web.downloads

import android.content.Context
import android.net.Uri
import android.os.SystemClock
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import androidx.test.core.app.ApplicationProvider
import org.junit.internal.AssumptionViolatedException
import org.junit.rules.TestRule
import org.junit.runner.Description
import org.junit.runners.model.MultipleFailureException
import org.junit.runners.model.Statement

/** How long a provider may still be busy with a close after the size it recorded shows. */
internal const val SETTLE_MILLIS = 2_000L

/**
 * Fails a test during which a media process died: `android.process.media`, home of the downloads
 * provider behind DocumentsUI's Downloads root, or the MediaProvider module. A document removed while
 * the downloads provider still handles the close of its writer crashes that process. The system
 * restarts it, so a test would not notice otherwise, and this app survives unless it held one of its
 * documents. The rule wraps the test's `@Before` and `@After` methods, so their cleanup counts too.
 */
internal class MediaProcessRule : TestRule {
    override fun apply(base: Statement, description: Description): Statement = object : Statement() {
        override fun evaluate() {
            MediaProcesses.wake()
            val before = MediaProcesses.pids()
            val crashesBefore = MediaProcesses.crashes()
            val errors = mutableListOf<Throwable>()
            try {
                base.evaluate()
            } catch (error: Throwable) {
                errors += error
            }
            // The provider handles a close moments after it, on a thread of its own.
            Thread.sleep(SETTLE_MILLIS)
            val after = MediaProcesses.pids()
            val crashes = MediaProcesses.crashes() - crashesBefore
            val gone = before.filter { (name, pid) -> after[name] != pid }
            HostWeb.note("media processes ${description.methodName}: before=$before after=$after crashes=$crashes")
            if (gone.isNotEmpty() || crashes > 0) {
                errors += AssertionError(
                    "a media process died during the test: before=$before after=$after crashes=$crashes\n" +
                        MediaProcesses.crashTail(),
                )
            }
            if (errors.size == 1 && errors[0] is AssumptionViolatedException) throw errors[0]
            MultipleFailureException.assertEmpty(errors)
        }
    }
}

/** The device's media processes, read through the instrumentation's shell. */
internal object MediaProcesses {
    private val context: Context get() = ApplicationProvider.getApplicationContext()
    private val names = listOf(
        "android.process.media",
        "com.google.android.providers.media.module",
        "com.android.providers.media.module",
    )

    /** Starts the downloads provider's process if it is not running, so its pid can be compared. */
    fun wake() {
        runCatching {
            context.contentResolver.query(Uri.parse("content://downloads/my_downloads"), arrayOf("_id"), null, null, null)?.close()
        }
    }

    /** Pids of the media processes running now, by process name. */
    fun pids(): Map<String, String> = names.mapNotNull { name ->
        shell("pidof $name").trim().takeIf { it.isNotEmpty() }?.let { name to it }
    }.toMap()

    /** Fatal exceptions of a media process in the crash log so far. */
    fun crashes(): Int = shell("logcat -b crash -d").lineSequence().count { line -> names.any { "Process: $it," in line } }

    fun crashTail(): String = shell("logcat -b crash -d -t 40")

    private fun shell(command: String): String = HostWeb.device.executeShellCommand(command)
}

/** Documents the tests saved through the real picker. */
internal object Documents {
    private val context: Context get() = ApplicationProvider.getApplicationContext()

    fun name(uri: Uri): String? = runCatching {
        context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
            ?.use { if (it.moveToFirst()) it.getString(0) else null }
    }.getOrNull()

    fun listed(uri: Uri): Boolean = name(uri) != null

    /**
     * Removes [uri], if still listed, once its provider has handled the last close of a writer. The
     * downloads provider records the size a writer left from a listener that runs after the close, and
     * then updates MediaStore; a removal racing that listener crashes the provider's process. So this
     * waits until the reported size is the file's, at most [timeoutMillis], and [SETTLE_MILLIS] more.
     */
    fun remove(uri: Uri, timeoutMillis: Long = 10_000) {
        if (!listed(uri)) return
        awaitSettled(uri, timeoutMillis)
        runCatching { DocumentsContract.deleteDocument(context.contentResolver, uri) }
            .onFailure { HostWeb.note("cleanup of $uri failed: $it") }
    }

    private fun awaitSettled(uri: Uri, timeoutMillis: Long) {
        val deadline = SystemClock.uptimeMillis() + timeoutMillis
        while (SystemClock.uptimeMillis() < deadline) {
            val reported = reportedSize(uri)
            val actual = fileSize(uri)
            if (reported == null || actual == null || reported == actual) break
            Thread.sleep(100)
        }
        Thread.sleep(SETTLE_MILLIS)
    }

    private fun reportedSize(uri: Uri): Long? = runCatching {
        context.contentResolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)
            ?.use { if (it.moveToFirst() && !it.isNull(0)) it.getLong(0) else null }
    }.getOrNull()

    // Read-only: the downloads provider adds no close listener to a reader.
    private fun fileSize(uri: Uri): Long? = runCatching {
        context.contentResolver.openFileDescriptor(uri, "r")?.use { it.statSize }
    }.getOrNull()?.takeIf { it >= 0 }
}
