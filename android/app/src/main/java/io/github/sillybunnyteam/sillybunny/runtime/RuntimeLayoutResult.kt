package io.github.sillybunnyteam.sillybunny.runtime

/** The outcome of [RuntimeLayout.ensure]. */
sealed interface RuntimeLayoutResult {
    /** `filesDir/runtime` matches the installed APK, so [paths] are ready for the §2.5 environment. */
    data class Ready(
        val paths: RuntimePaths,
        val installed: InstalledRuntime,
        /** Why this call rebuilt the layout; empty when the existing layout already matched. */
        val refreshReasons: Set<RefreshReason>,
        val elapsedMillis: Long,
    ) : RuntimeLayoutResult {
        val refreshed: Boolean get() = refreshReasons.isNotEmpty()
    }

    /** This APK was built without the runtime payload (`BuildConfig.HAS_RUNTIME` is false). */
    data object Unavailable : RuntimeLayoutResult

    /**
     * The layout could not be made to match this APK. A previous layout, if any, is left in place but is not
     * valid for this APK, so nothing may run from it.
     */
    data class Failed(val error: RuntimeLayoutException) : RuntimeLayoutResult
}
