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
 * Free space required before installing (plan §4.3 step 2).
 *
 * The base is S2.5's measured installed footprint before user data, `du -sk` on API 37 x86_64 right after
 * the first cold start (S2.5, `s25-app-install.md`, task 2.6 table): extracted natives 110,180 KiB,
 * `runtime/` 33,480 KiB, the checkout 691,256 KiB (including `node_modules` 452,092 KiB and `.git`
 * 78,752 KiB) and `home/` with the npm cache 107,904 KiB. That is the plan's "about 940 MB".
 * The first start's `npm ci` runs right after first run, so the whole footprint counts.
 *
 * UNVERIFIED: peak use during the clone and `npm ci` was not measured (task 2.6), so [PEAK_MARGIN_BYTES] is
 * an assumed margin of half the footprint again, which also covers `cacheDir/tmp` (4,844 KiB measured).
 */
object FirstRunStorage {
    const val MEASURED_FOOTPRINT_KIB: Long = 110_180L + 33_480L + 691_256L + 107_904L

    const val MEASURED_FOOTPRINT_BYTES: Long = MEASURED_FOOTPRINT_KIB * 1_024L

    /** UNVERIFIED assumption, pending the peak measurement of task 2.6. */
    const val PEAK_MARGIN_BYTES: Long = MEASURED_FOOTPRINT_BYTES / 2

    /** 1,448,171,520 bytes, about 1.45 GB. UNVERIFIED, see the class documentation. */
    const val REQUIRED_FREE_BYTES: Long = MEASURED_FOOTPRINT_BYTES + PEAK_MARGIN_BYTES
}

/**
 * The download estimate shown on a metered or cellular network (plan §4.3 step 2).
 *
 * Measured by S2.5 (`s25-app-install.md`, task 2.6 table) on x86_64 emulators with TrafficStats UID
 * receive deltas: the clone received 77,466,453 to 79,252,479 bytes; `npm ci --omit=dev` received
 * 96,244,476 to 108,185,048 bytes (the first start's `npm ci` and a standalone one with audit traffic).
 * Installer plus first start totalled about 174 to 178 MB and clone plus standalone `npm ci` about 183 to
 * 187 MB. These are single-run emulator observations, not a mobile guarantee; the values below are the
 * plan's rounded figures.
 */
object InstallDownloadEstimate {
    const val TOTAL_MIN_BYTES: Long = 175_000_000L
    const val TOTAL_MAX_BYTES: Long = 187_000_000L
    const val CLONE_BYTES: Long = 79_000_000L
    const val NPM_CI_MIN_BYTES: Long = 98_000_000L
    const val NPM_CI_MAX_BYTES: Long = 108_000_000L
}
