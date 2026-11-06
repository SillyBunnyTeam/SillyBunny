package io.github.sillybunnyteam.sillybunny.firstrun

import io.github.sillybunnyteam.sillybunny.BuildConfig
import io.github.sillybunnyteam.sillybunny.runtime.RuntimePaths
import io.github.sillybunnyteam.sillybunny.server.SetupJob
import java.io.File

/** The first-run `install.sh` job (plan §4.3 step 4). There is no runtime picker and no branch picker. */
object FirstRunInstall {
    /**
     * `install.sh --no-start --dir <checkoutDir> --ref <ref> --use-node --repo <BuildConfig.REPO_URL>`. The
     * explicit `--repo` lets debug builds clone the fixture remote that `-PdebugRepoUrl` names; release builds
     * pass the official URL, which is also install.sh's default.
     */
    fun args(paths: RuntimePaths, ref: String): List<String> =
        listOf(
            "--no-start", "--dir", paths.checkoutDir.path, "--ref", ref, "--use-node", "--repo", BuildConfig.REPO_URL,
        )

    fun job(script: File, paths: RuntimePaths, ref: String): SetupJob =
        SetupJob(script = script, args = args(paths, ref), workingDir = paths.filesDir)

    /**
     * True for a job with exactly the first-run arguments, so a recreated controller recognises an install it
     * did not start itself. Repair's jobs add `--migrate-from`, so they never match.
     */
    fun isFirstRunJob(job: SetupJob, paths: RuntimePaths, ref: String): Boolean = job.args == args(paths, ref)
}

/**
 * Free space required before installing (plan §4.3 step 2): the measured peak plus a margin.
 *
 * [MEASURED_PEAK_KIB] is the largest `du -sk` of the app's data directory in task 2.6 (plan §4.3, measured
 * 2026-10-23): sampled every 2 s through the whole first run, the first start's `npm ci` and the first page
 * load, on x86_64 emulators with API 37 and API 29, cloning `feat/android-apk`. Usage only grew, so the peak is
 * the installed size: the checkout with `node_modules` and `.git`, the npm cache in `home/`, `runtime/`, the
 * logs and the WebView data. The extracted natives are not part of it, because the APK installer writes them
 * before the app can run this check.
 *
 * The margin of half the peak covers the growth of the repository and of the npm tree in later releases, and
 * file systems that store small files less compactly than the measured ext4 emulators. On those emulators, `df`
 * showed about 15% less used space than `du`, so the `du` base already over-counts small files there.
 */
object FirstRunStorage {
    const val MEASURED_PEAK_KIB: Long = 873_276L

    const val MEASURED_PEAK_BYTES: Long = MEASURED_PEAK_KIB * 1_024L

    const val PEAK_MARGIN_BYTES: Long = MEASURED_PEAK_BYTES / 2

    /** 1,341,351,936 bytes, about 1.34 GB. */
    const val REQUIRED_FREE_BYTES: Long = MEASURED_PEAK_BYTES + PEAK_MARGIN_BYTES
}

/**
 * The download estimate shown on a metered or cellular network (plan §4.3 step 2).
 *
 * Measured in task 2.6 (plan §4.3, 2026-10-23) with per-UID netstats on x86_64 emulators while the first run
 * cloned `feat/android-apk` and the first start ran `npm ci`: the clone received 80,588,344 to 80,664,362 bytes
 * and `npm ci` 98,455,121 to 98,681,097 bytes, 179.1 to 179.3 MB together. S2.5's standalone `npm ci` with audit
 * traffic received up to 108,185,048 bytes. These are emulator observations, not a mobile guarantee. The values
 * below are rounded, and the maximums include the audit traffic.
 */
object InstallDownloadEstimate {
    const val TOTAL_MIN_BYTES: Long = 179_000_000L
    const val TOTAL_MAX_BYTES: Long = 189_000_000L
    const val CLONE_BYTES: Long = 81_000_000L
    const val NPM_CI_MIN_BYTES: Long = 98_000_000L
    const val NPM_CI_MAX_BYTES: Long = 108_000_000L
}
