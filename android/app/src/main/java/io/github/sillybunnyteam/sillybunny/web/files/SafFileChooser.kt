package io.github.sillybunnyteam.sillybunny.web.files

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.widget.Toast
import androidx.activity.compose.LocalActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.ActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import io.github.sillybunnyteam.sillybunny.R
import io.github.sillybunnyteam.sillybunny.web.WebFileChooser

/**
 * The app's SAF file chooser for a WebView shown in this composition (plan §4.5). Pass it to the
 * WebView screen, whose `onShowFileChooser` calls [WebFileChooser.show].
 *
 * - Open and multiple-open use `ACTION_OPEN_DOCUMENT` with `CATEGORY_OPENABLE`, a MIME filter from
 *   the accept list (extension-only and `*.json` accepts allow every file) and every returned
 *   `ClipData` URI. Save mode uses `ACTION_CREATE_DOCUMENT`. On API 37, folder mode uses
 *   `ACTION_OPEN_DOCUMENT_TREE` and the read-write permission mode requires a write grant; modes a
 *   device cannot serve are cancelled.
 * - Results are untrusted: see [ContentUriPolicy]. An unusable result cancels the request. URIs are
 *   never converted to paths.
 * - Each request is completed exactly once, with URIs or null. One picker is open at a time: a
 *   request made while a picker is open is cancelled, so the open picker's answer goes to the
 *   request that opened it.
 *
 * Lifetime: the chooser and its pending request live in a ViewModel of the activity, and the
 * launcher's key is saved state, so an open picker survives activity recreation and answers the
 * request of a WebView that the host keeps across it (as the app's WebView shell does). Each
 * composition re-binds its launcher. [WebFileChooser.cancelPending] completes the pending request
 * with null; the shell calls it when it destroys a WebView. When this composable leaves the
 * composition without a configuration change, the pending request is cancelled, because its
 * result can no longer arrive.
 */
@Composable
fun rememberWebFileChooser(): WebFileChooser = rememberSafFileChooser { SafFileChooser(it) }

/** [rememberWebFileChooser] with a custom chooser, for tests; [create] receives the application context. */
@Composable
internal fun rememberSafFileChooser(create: (Context) -> SafFileChooser): SafFileChooser {
    val view = LocalView.current
    val context = LocalContext.current.applicationContext
    val chooser = remember(view) {
        view.retained(RETAINED_KEY, { create(context) }, SafFileChooser::release)
    }
    val activity = LocalActivity.current
    val launcher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
        chooser::onResult,
    )
    DisposableEffect(chooser, launcher) {
        chooser.bind { intent -> launcher.launch(intent) }
        onDispose { chooser.unbind(changingConfigurations = activity?.isChangingConfigurations == true) }
    }
    return chooser
}

private const val RETAINED_KEY = "io.github.sillybunnyteam.sillybunny.web.files.chooser"

/** The [WebFileChooser] behind [rememberWebFileChooser]; main thread only. */
internal class SafFileChooser(
    private val context: Context,
    private val policy: ContentUriPolicy = ContentUriPolicy(context),
    private val sdk: Int = Build.VERSION.SDK_INT,
    private val notify: (Int) -> Unit = { Toast.makeText(context, it, Toast.LENGTH_SHORT).show() },
) : WebFileChooser {
    private var launch: ((Intent) -> Unit)? = null
    private var pending: Pending? = null

    /** True from a launch until its result arrives, even when its request was cancelled meanwhile. */
    internal var pickerOpen = false
        private set

    internal val hasPending: Boolean get() = pending != null

    /** Connects the current activity's launcher; requests made while unbound are cancelled. */
    fun bind(launch: (Intent) -> Unit) {
        this.launch = launch
    }

    /**
     * Disconnects the launcher. Unless the activity is only changing configurations, an open picker's
     * result can no longer arrive, so its request is cancelled.
     */
    fun unbind(changingConfigurations: Boolean) {
        launch = null
        if (!changingConfigurations) {
            pickerOpen = false
            cancelPending()
        }
    }

    override fun show(
        webView: WebView,
        callback: ValueCallback<Array<Uri>>,
        params: WebChromeClient.FileChooserParams,
    ): Boolean {
        val launcher = launch
        if (pickerOpen || launcher == null) {
            callback.onReceiveValue(null)
            return true
        }
        cancelPending()
        val request = PickerRequests.create(
            params.mode,
            permissionMode(params),
            params.acceptTypes,
            params.filenameHint,
            sdk,
        )
        if (request == null) {
            callback.onReceiveValue(null)
            return true
        }
        val entry = Pending(callback, request)
        pending = entry
        pickerOpen = true
        try {
            launcher(request.intent)
        } catch (_: ActivityNotFoundException) {
            pickerOpen = false
            finish(entry, null)
            notify(R.string.web_files_rejected)
        } catch (_: IllegalStateException) {
            // The launcher was unregistered underneath us; no picker can open.
            pickerOpen = false
            finish(entry, null)
        }
        return true
    }

    fun onResult(result: ActivityResult) {
        pickerOpen = false
        val entry = pending ?: return
        val uris = PickerResults.accept(result.resultCode, result.data, entry.request, policy)
        if (uris == null && result.resultCode == Activity.RESULT_OK) notify(R.string.web_files_rejected)
        finish(entry, uris)
    }

    override fun cancelPending() {
        pending?.let { finish(it, null) }
    }

    /** The owning activity is finishing for good. */
    fun release() {
        launch = null
        pickerOpen = false
        cancelPending()
    }

    private fun finish(entry: Pending, uris: Array<Uri>?) {
        if (pending === entry) pending = null
        entry.complete(uris)
    }

    private fun permissionMode(params: WebChromeClient.FileChooserParams): Int =
        if (sdk >= PickerRequests.FOLDER_MODES_API && Build.VERSION.SDK_INT >= Build.VERSION_CODES.CINNAMON_BUN) {
            params.permissionMode
        } else {
            PickerRequests.PERMISSION_MODE_READ
        }

    private class Pending(callback: ValueCallback<Array<Uri>>, val request: PickerRequest) {
        private var callback: ValueCallback<Array<Uri>>? = callback

        fun complete(uris: Array<Uri>?) {
            val target = callback ?: return
            callback = null
            target.onReceiveValue(uris)
        }
    }
}
