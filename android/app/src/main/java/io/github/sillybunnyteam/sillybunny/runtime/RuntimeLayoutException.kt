package io.github.sillybunnyteam.sillybunny.runtime

import java.io.IOException

/**
 * The runtime layout could not be made to match the installed APK. [reason] says which part failed; the
 * message is the user-facing placeholder text, so callers may show it as is.
 */
class RuntimeLayoutException(
    val reason: Reason,
    cause: Throwable? = null,
) : IOException(MESSAGE, cause) {
    enum class Reason {
        /** `runtime-manifest.json` is missing, unreadable or not schema 1. */
        MANIFEST,

        /** The installed APK lacks a native the manifest lists for its ABI, or one differs in size. */
        NATIVES,

        /** A runtime asset is missing or does not match its manifest hash. */
        ASSET,

        /** `git-core-links.txt` is malformed, or names an unsafe link or an unknown native. */
        LINKS,

        /** `npm.json` or `npm.zip` fails verification, or the archive holds an unsafe entry. */
        NPM_ARCHIVE,

        /** Writing, syncing or swapping the layout failed. */
        STORAGE,
    }

    companion object {
        const val MESSAGE = "TODO(copy)"
    }
}
