package io.github.sillybunnyteam.sillybunny.web

import android.content.Context
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.activity.compose.LocalActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.res.colorResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.DialogProperties
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStoreOwner
import androidx.lifecycle.findViewTreeViewModelStoreOwner
import io.github.sillybunnyteam.sillybunny.BuildConfig
import io.github.sillybunnyteam.sillybunny.R
import io.github.sillybunnyteam.sillybunny.server.LaunchSession

/**
 * The app's WebView screen (plan §4.5): shows the SillyBunny UI of [session] full screen.
 *
 * - Loads `session.origin + "/"` only after the launch cookie was set and the provider reported success;
 *   [WebDownloads.attach] runs before that first load.
 * - Survives configuration changes without a reload: the WebView belongs to a `ViewModel` of the
 *   nearest `ViewModelStoreOwner` (the activity), not to this composition. Leaving and re-entering
 *   composition, and activity recreation, keep the page, its history, open dialogs and fullscreen.
 *   A different [session] replaces the WebView; so does renderer death. One screen per activity.
 * - [fileChooser]: the latest instance serves new `<input type=file>` requests. [downloads]: the
 *   instance passed when a WebView is created serves that WebView until it is destroyed. Teardown
 *   calls [WebFileChooser.cancelPending] and then [WebDownloads.detach].
 * - Back leaves fullscreen first, then goes back in WebView history; with neither, Back is not
 *   intercepted, so the system handles it. The server keeps running either way.
 */
@Composable
fun WebScreen(
    session: LaunchSession,
    modifier: Modifier = Modifier,
    fileChooser: WebFileChooser = NoWebFileChooser,
    downloads: WebDownloads = NoWebDownloads,
) {
    val view = LocalView.current
    val shell = remember(view) {
        val owner = checkNotNull(view.findViewTreeViewModelStoreOwner()) { "WebScreen needs a ViewModelStoreOwner" }
        retainedWebShell(owner, view.context)
    }
    WebScreenContent(shell, session, fileChooser, downloads, modifier)
}

/** The [WebShell] kept for [owner]; created on first use and released when [owner] is destroyed for good. */
internal fun retainedWebShell(owner: ViewModelStoreOwner, context: Context): WebShell {
    val appContext = context.applicationContext
    val factory = WebShellHolder.factory { WebShell(appContext) }
    return ViewModelProvider(owner, factory)[WebShellHolder.KEY, WebShellHolder::class.java].shell()
}

/** Test tags of the screen's own UI; debug builds expose them as resource IDs for UiAutomator. */
internal object WebScreenTags {
    const val CONTENT = "web_content"
    const val FULLSCREEN = "web_fullscreen"
    const val DIALOG = "web_dialog"
    const val DIALOG_ACCEPT = "web_dialog_accept"
    const val DIALOG_DISMISS = "web_dialog_dismiss"
    const val DIALOG_TEXT = "web_dialog_text"
    const val VERSION_WARNING = "web_version_warning"
    const val VERSION_UPDATE = "web_version_update"
    const val VERSION_DISMISS = "web_version_dismiss"
    const val OPEN_IN_BROWSER = "web_open_in_browser"
    const val LOAD_FAILED = "web_load_failed"
    const val RETRY = "web_retry"
}

@Composable
internal fun WebScreenContent(
    shell: WebShell,
    session: LaunchSession,
    fileChooser: WebFileChooser,
    downloads: WebDownloads,
    modifier: Modifier = Modifier,
) {
    // After every composition, so the WebView starts once the container below exists.
    SideEffect { shell.bind(session, fileChooser, downloads) }
    val context = LocalContext.current
    val openInBrowser = {
        if (!shell.openInBrowser(context)) {
            Toast.makeText(context, R.string.web_no_browser, Toast.LENGTH_SHORT).show()
        }
    }
    val fullscreen = shell.fullscreen
    BackHandler(enabled = fullscreen != null || shell.canGoBack) { shell.onBack() }
    PermissionRequests(shell)
    Box(modifier.fillMaxSize().background(colorResource(R.color.charcoal_canvas)).debugTestTags()) {
        AndroidView(
            factory = { viewContext -> FrameLayout(viewContext).also(shell::mount) },
            modifier = Modifier
                .fillMaxSize()
                .windowInsetsPadding(WindowInsets.safeDrawing)
                .testTag(WebScreenTags.CONTENT),
            onRelease = shell::unmount,
        )
        if (shell.loadFailed) {
            LoadFailedPanel(onRetry = shell::retry, onOpenInBrowser = openInBrowser)
        }
        shell.versionWarning?.let {
            VersionWarningBanner(
                onOpenInBrowser = openInBrowser,
                onUpdate = {
                    if (!shell.openWebViewUpdate(context)) {
                        Toast.makeText(context, R.string.web_no_browser, Toast.LENGTH_SHORT).show()
                    }
                },
                onDismiss = shell::dismissVersionWarning,
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .windowInsetsPadding(WindowInsets.safeDrawing),
            )
        }
        if (fullscreen != null) {
            key(fullscreen) { FullscreenLayer(fullscreen) }
        }
    }
    shell.dialog?.let { dialog ->
        key(dialog) { JsDialogUi(dialog) { accept -> shell.answerDialog(dialog, accept) } }
    }
}

/** Asks for the Android permissions a pending web permission request needs, once per request. */
@Composable
private fun PermissionRequests(shell: WebShell) {
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        shell.onAndroidPermissionsResult(it)
    }
    val pending = shell.permissionRequest
    LaunchedEffect(pending) {
        if (pending != null && !pending.launched) {
            pending.launched = true
            launcher.launch(pending.missing.toTypedArray())
        }
    }
}

/** The page's fullscreen custom view over everything, with the system bars hidden. */
@Composable
private fun FullscreenLayer(fullscreen: WebShell.FullscreenView) {
    AndroidView(
        factory = { context ->
            FrameLayout(context).apply {
                setBackgroundColor(android.graphics.Color.BLACK)
                // Touches that the custom view leaves unhandled must not reach the page below.
                isClickable = true
            }
        },
        modifier = Modifier.fillMaxSize().testTag(WebScreenTags.FULLSCREEN),
        update = { container ->
            val view = fullscreen.view
            if (view.parent !== container) {
                (view.parent as? ViewGroup)?.removeView(view)
                container.addView(view, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
            }
        },
        onRelease = { container -> container.removeAllViews() },
    )
    val window = LocalActivity.current?.window ?: return
    val view = LocalView.current
    DisposableEffect(window, view) {
        val controller = WindowCompat.getInsetsController(window, view)
        controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        controller.hide(WindowInsetsCompat.Type.systemBars())
        onDispose { controller.show(WindowInsetsCompat.Type.systemBars()) }
    }
}

/** A page's `alert`, `confirm`, `prompt` or `beforeunload` dialog; the answer goes back to the page. */
@Composable
private fun JsDialogUi(dialog: WebShell.JsDialog, onAnswer: (Boolean) -> Unit) {
    val leaving = dialog is WebShell.JsDialog.BeforeUnload
    AlertDialog(
        onDismissRequest = { onAnswer(false) },
        confirmButton = {
            TextButton(onClick = { onAnswer(true) }, modifier = Modifier.testTag(WebScreenTags.DIALOG_ACCEPT)) {
                Text(stringResource(if (leaving) R.string.web_dialog_leave else R.string.web_dialog_ok))
            }
        },
        dismissButton = if (dialog is WebShell.JsDialog.Alert) {
            null
        } else {
            {
                TextButton(onClick = { onAnswer(false) }, modifier = Modifier.testTag(WebScreenTags.DIALOG_DISMISS)) {
                    Text(stringResource(if (leaving) R.string.web_dialog_stay else R.string.web_dialog_cancel))
                }
            }
        },
        title = if (leaving) {
            { Text(stringResource(R.string.web_dialog_leave_title)) }
        } else {
            null
        },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                if (dialog.message.isNotEmpty()) Text(dialog.message)
                if (dialog is WebShell.JsDialog.Prompt) {
                    OutlinedTextField(
                        value = dialog.text,
                        onValueChange = { dialog.text = it },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth().padding(top = 8.dp).testTag(WebScreenTags.DIALOG_TEXT),
                    )
                }
            }
        },
        modifier = Modifier.testTag(WebScreenTags.DIALOG).debugTestTags(),
        // Like a browser's: only an explicit answer or Back closes it.
        properties = DialogProperties(dismissOnClickOutside = false),
    )
}

/** Non-blocking notice that the WebView provider is older than [WebViewVersion.MINIMUM_MAJOR]. */
@Composable
private fun VersionWarningBanner(
    onOpenInBrowser: () -> Unit,
    onUpdate: () -> Unit,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Surface(
        modifier = modifier.fillMaxWidth().padding(8.dp).testTag(WebScreenTags.VERSION_WARNING),
        shape = MaterialTheme.shapes.medium,
        tonalElevation = 6.dp,
        shadowElevation = 6.dp,
    ) {
        Column(Modifier.padding(16.dp)) {
            Text(stringResource(R.string.web_version_warning))
            FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                TextButton(onClick = onOpenInBrowser, modifier = Modifier.testTag(WebScreenTags.OPEN_IN_BROWSER)) {
                    Text(stringResource(R.string.web_open_in_browser))
                }
                TextButton(onClick = onUpdate, modifier = Modifier.testTag(WebScreenTags.VERSION_UPDATE)) {
                    Text(stringResource(R.string.web_update_webview))
                }
                TextButton(onClick = onDismiss, modifier = Modifier.testTag(WebScreenTags.VERSION_DISMISS)) {
                    Text(stringResource(R.string.web_dismiss))
                }
            }
        }
    }
}

/** Shown when the launch cookie could not be set or the renderer keeps dying. */
@Composable
private fun LoadFailedPanel(onRetry: () -> Unit, onOpenInBrowser: () -> Unit) {
    Box(
        Modifier
            .fillMaxSize()
            .background(colorResource(R.color.charcoal_canvas))
            .windowInsetsPadding(WindowInsets.safeDrawing)
            .padding(24.dp)
            .testTag(WebScreenTags.LOAD_FAILED),
        contentAlignment = Alignment.Center,
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(stringResource(R.string.web_load_failed), color = colorResource(R.color.linen_text))
            FlowRow(horizontalArrangement = Arrangement.Center) {
                TextButton(onClick = onRetry, modifier = Modifier.testTag(WebScreenTags.RETRY)) {
                    Text(stringResource(R.string.web_retry))
                }
                TextButton(onClick = onOpenInBrowser, modifier = Modifier.testTag(WebScreenTags.OPEN_IN_BROWSER)) {
                    Text(stringResource(R.string.web_open_in_browser))
                }
            }
        }
    }
}

// Debug builds only: lets device tests find the screen's own controls without the Compose test rule.
private fun Modifier.debugTestTags(): Modifier = semantics { testTagsAsResourceId = BuildConfig.DEBUG }
