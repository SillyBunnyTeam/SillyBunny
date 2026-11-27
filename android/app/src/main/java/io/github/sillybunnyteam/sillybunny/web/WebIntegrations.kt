package io.github.sillybunnyteam.sillybunny.web

import android.net.Uri
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import io.github.sillybunnyteam.sillybunny.server.LaunchSession

/**
 * File choosing for the WebView screen (plan §4.5). The shell's `onShowFileChooser` calls [show];
 * an implementation that returns true completes [callback] exactly once.
 */
interface WebFileChooser {
    fun show(
        webView: WebView,
        callback: ValueCallback<Array<Uri>>,
        params: WebChromeClient.FileChooserParams,
    ): Boolean

    /** Completes any outstanding request with null, for example when the WebView is torn down. */
    fun cancelPending()
}

/**
 * Downloads and exports for the WebView screen (plan §4.5). The shell calls [attach] once per
 * WebView before its first load, offers `blob:`/`data:` and download-like navigations to
 * [handleNavigation] before its own link routing, and calls [detach] before destroying the WebView.
 */
interface WebDownloads {
    fun attach(webView: WebView, session: LaunchSession)

    /** Returns true when the navigation was taken as a download, so the shell must not route it. */
    fun handleNavigation(webView: WebView, url: Uri, isMainFrame: Boolean, hasGesture: Boolean): Boolean

    fun detach(webView: WebView)
}

/** Cancels every request, so the page sees an aborted picker. Used until a real chooser is wired in. */
object NoWebFileChooser : WebFileChooser {
    override fun show(
        webView: WebView,
        callback: ValueCallback<Array<Uri>>,
        params: WebChromeClient.FileChooserParams,
    ): Boolean {
        callback.onReceiveValue(null)
        return true
    }

    override fun cancelPending() = Unit
}

/** Takes no downloads. Used until a real implementation is wired in. */
object NoWebDownloads : WebDownloads {
    override fun attach(webView: WebView, session: LaunchSession) = Unit

    override fun handleNavigation(webView: WebView, url: Uri, isMainFrame: Boolean, hasGesture: Boolean) = false

    override fun detach(webView: WebView) = Unit
}
