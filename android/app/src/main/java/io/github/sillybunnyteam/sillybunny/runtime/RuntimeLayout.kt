package io.github.sillybunnyteam.sillybunny.runtime

import android.content.Context
import android.os.Looper
import io.github.sillybunnyteam.sillybunny.BuildConfig

/**
 * Plan §2.4 step 1: makes `filesDir/runtime` match the installed APK before anything runs from it.
 *
 * Call [ensure] on every launch, off the main thread, before starting the server, the first-run install or
 * Repair, and use only a [RuntimeLayoutResult.Ready] layout. It is idempotent: when `installed-runtime.json`
 * still matches the APK (versionCode, lastUpdateTime, nativeLibraryDir, runtime-manifest SHA-256) it only
 * reads the manifest and that record; otherwise it rebuilds the layout and swaps it in atomically.
 */
object RuntimeLayout {
    /**
     * How npm's files are made durable before the swap. Measured against per-file fsync on the API 29
     * and API 37 emulators (P5.2 report).
     */
    val npmSyncMode = NpmSyncMode.BATCHED

    private val lock = Any()

    fun ensure(context: Context): RuntimeLayoutResult {
        check(Looper.myLooper() != Looper.getMainLooper())
        if (!BuildConfig.HAS_RUNTIME) return RuntimeLayoutResult.Unavailable
        val app = context.applicationContext
        return synchronized(lock) {
            RuntimeLayoutInstaller(RuntimePaths(app), AndroidRuntimeSource(app), npmSyncMode).ensure()
        }
    }
}
