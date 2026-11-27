package io.github.sillybunnyteam.sillybunny.web

import android.content.Context
import android.content.pm.PackageInfo
import android.net.Uri
import androidx.core.net.toUri
import androidx.webkit.WebViewCompat

/**
 * The installed WebView provider's version (plan §4.5). The provider's `PackageInfo.versionName` is a
 * nullable, package-defined string, so only a plain leading major number counts; anything else stays
 * unknown, and unknown never shows the warning. Not the user agent, `versionCode` or a fixed package.
 */
internal object WebViewVersion {
    /** Proposed minimum provider major version; plan §4.5 starting proposal, UNVERIFIED. */
    const val MINIMUM_MAJOR = 111

    private val major = Regex("[0-9]{1,6}")
    private val packageName = Regex("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+")

    /** The leading dot-separated component of [versionName] as a number, or null when unknown. */
    fun parseMajor(versionName: String?): Int? {
        val first = versionName?.trim()?.substringBefore('.') ?: return null
        return if (major.matches(first)) first.toInt() else null
    }

    fun isBelowMinimum(major: Int?): Boolean = major != null && major < MINIMUM_MAJOR

    /** The current provider package, or null when the provider cannot be determined. */
    fun currentPackage(context: Context): PackageInfo? =
        try {
            WebViewCompat.getCurrentWebViewPackage(context)
        } catch (_: RuntimeException) {
            null
        }

    /** Store links for updating the provider [providerPackage], most specific first; empty if invalid. */
    fun updateUris(providerPackage: String?): List<Uri> {
        if (providerPackage == null || !packageName.matches(providerPackage)) return emptyList()
        return listOf(
            "market://details?id=$providerPackage".toUri(),
            "https://play.google.com/store/apps/details?id=$providerPackage".toUri(),
        )
    }
}
