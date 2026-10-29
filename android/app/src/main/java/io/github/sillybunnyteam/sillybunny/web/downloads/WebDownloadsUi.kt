package io.github.sillybunnyteam.sillybunny.web.downloads

import android.content.Context
import androidx.activity.compose.LocalActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import io.github.sillybunnyteam.sillybunny.BuildConfig
import io.github.sillybunnyteam.sillybunny.R
import io.github.sillybunnyteam.sillybunny.web.WebAddress
import io.github.sillybunnyteam.sillybunny.web.WebDownloads
import io.github.sillybunnyteam.sillybunny.web.files.retained

/**
 * The app's downloads and page exports for a WebView shown in this composition (plan §4.5). Pass it
 * to the WebView screen, which calls [WebDownloads.attach] before the first load, offers navigations
 * to [WebDownloads.handleNavigation] and calls [WebDownloads.detach] before destroying the WebView.
 * Everything is saved to a document the user creates with `ACTION_CREATE_DOCUMENT`. [address] must be
 * the one the WebView screen uses: the bridge serves exactly its web origin, and downloads carry cookies
 * only for it.
 *
 * When the installed WebView lacks `DOCUMENT_START_SCRIPT` or `WEB_MESSAGE_LISTENER`, page exports
 * cannot be captured; the first one that is lost shows a dialog (copy `TODO(copy)`) whose action
 * calls [onOpenInBrowser], for example the shell's Open in browser.
 *
 * Lifetime: the returned instance lives in a ViewModel of the activity, so it survives activity
 * recreation together with a WebView that the host keeps across it; its exports and an open
 * destination picker carry on (the launcher's key is saved state and each composition re-binds the
 * launcher). It is released, cancelling every export, when the activity finishes for good. If this
 * composable leaves the composition without a configuration change, an open picker's export is
 * cancelled because its result can no longer arrive; queued exports wait until it returns.
 */
@Composable
fun rememberWebDownloads(
    onOpenInBrowser: () -> Unit,
    address: WebAddress = WebAddress.forInstall(LocalContext.current),
): WebDownloads = rememberWebTransfers(onOpenInBrowser) { WebTransfers(it, originOf = address::origin) }

/** [rememberWebDownloads] with a custom engine, for tests. */
@Composable
internal fun rememberWebTransfers(onOpenInBrowser: () -> Unit, create: (Context) -> WebTransfers): WebTransfers {
    val view = LocalView.current
    val context = LocalContext.current.applicationContext
    val transfers = remember(view) { view.retained(RETAINED_KEY, { create(context) }, WebTransfers::release) }
    val activity = LocalActivity.current
    val launcher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
        transfers::onDestinationResult,
    )
    DisposableEffect(transfers, launcher) {
        transfers.bind { intent -> launcher.launch(intent) }
        onDispose { transfers.unbind(changingConfigurations = activity?.isChangingConfigurations == true) }
    }
    val openInBrowser by rememberUpdatedState(onOpenInBrowser)
    if (transfers.unsupportedPrompt) {
        AlertDialog(
            onDismissRequest = transfers::dismissUnsupported,
            title = { Text(stringResource(R.string.web_transfer_unsupported_title)) },
            text = { Text(stringResource(R.string.web_transfer_unsupported_message)) },
            confirmButton = {
                TextButton(
                    onClick = {
                        transfers.dismissUnsupported()
                        openInBrowser()
                    },
                    modifier = Modifier.testTag(OPEN_IN_BROWSER_TAG),
                ) { Text(stringResource(R.string.web_transfer_open_in_browser)) }
            },
            dismissButton = {
                TextButton(
                    onClick = transfers::dismissUnsupported,
                    modifier = Modifier.testTag(DISMISS_TAG),
                ) { Text(stringResource(R.string.web_transfer_dismiss)) }
            },
            // Debug builds only: lets device tests find the buttons by tag without the Compose test rule.
            modifier = Modifier.semantics { testTagsAsResourceId = BuildConfig.DEBUG },
        )
    }
    return transfers
}

internal const val OPEN_IN_BROWSER_TAG = "web_transfer_open_in_browser"
internal const val DISMISS_TAG = "web_transfer_dismiss"
private const val RETAINED_KEY = "io.github.sillybunnyteam.sillybunny.web.downloads.transfers"
