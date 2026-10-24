package io.github.sillybunnyteam.sillybunny.update

import android.app.Application
import android.content.Context
import android.content.SharedPreferences
import android.os.FileObserver
import android.os.Handler
import android.os.Looper
import androidx.activity.ComponentActivity
import androidx.annotation.VisibleForTesting
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.ViewModelProvider
import java.io.File
import java.io.IOException
import java.io.InterruptedIOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit

enum class UpdatePhase {
    IDLE,
    CHECKING,
    AVAILABLE,
    REQUIRED,
    DOWNLOADING,
    AWAITING_SOURCE_PERMISSION,
    INSTALLING,
    ERROR,
    UP_TO_DATE,
    UPDATED,
}

data class UpdateUiState(
    val enabled: Boolean = true,
    val visible: Boolean = false,
    val phase: UpdatePhase = UpdatePhase.IDLE,
    val candidate: UpdateCandidate? = null,
    val blocked: BlockedUpdateStatus? = null,
    val downloadedBytes: Long = 0,
    val totalBytes: Long = 0,
    val lastResult: UpdateCheckResult? = null,
    val updatedVersionCode: Long? = null,
    val initialized: Boolean = false,
)

class AppUpdater internal constructor(
    application: Application,
    private val repository: UpdateRepository,
) : AndroidViewModel(application) {
    constructor(application: Application) : this(application, UpdateRepository(application))

    private val context: Application = application
    private val store = UpdateStore(context)
    private val main = Handler(Looper.getMainLooper())
    private val executor = Executors.newSingleThreadExecutor { work ->
        Thread(work, "apk-updater").apply { isDaemon = true }
    }
    private val preferences = context.getSharedPreferences("app_updates", Context.MODE_PRIVATE)
    private val preferenceListener = SharedPreferences.OnSharedPreferenceChangeListener { _, _ ->
        post { refreshInstallResult() }
    }
    private var observer: FileObserver? = null
    private var launched = false
    private var busy = false
    private var manualCheckRequested = false
    private var dismissalGeneration = 0L
    @Volatile
    private var closed = false
    @Volatile
    private var cancelDownload = false
    private var lastInstallResult: InstallResult? = null
    private var permissionScreenLaunched = false
    private var sourceApprovalBeforeLaunch = false

    @Volatile
    var serverController: ServerController = NoOpServerController
    private val installer = UpdateInstaller(
        context,
        object : ServerController {
            override fun stopForUpdate() = serverController.stopForUpdate()

            override fun resumeAfterAbandonedUpdate() = serverController.resumeAfterAbandonedUpdate()
        },
    )

    var state by mutableStateOf(UpdateUiState(enabled = store.enabled))
        private set

    var enabled: Boolean
        get() = state.enabled
        set(value) {
            store.enabled = value
            state = state.copy(enabled = value)
        }

    val lastResult: UpdateCheckResult?
        get() = state.lastResult

    fun onLaunch() {
        if (launched) return
        launched = true
        preferences.registerOnSharedPreferenceChangeListener(preferenceListener)
        enqueue {
            val statusDirectory = File(context.filesDir, "status")
            statusDirectory.mkdirs()
            val statusObserver = object : FileObserver(
                statusDirectory,
                CLOSE_WRITE or MOVED_TO or CREATE or DELETE or MOVED_FROM,
            ) {
                override fun onEvent(event: Int, path: String?) {
                    if (path == "update-blocked.json" && !closed) {
                        loadBlockedStatus()
                    }
                }
            }
            synchronized(this) {
                if (!closed) observer = statusObserver.also { it.startWatching() }
            }
            if (closed) return@enqueue
            installer.reconcileAfterLaunch()
            // A verified download can outlive its process while the install-source grant is pending.
            val verified = store.verifiedDownload()
            if (store.activeSessionId == null) {
                if (verified == null) store.clearDownload()
                File(context.cacheDir, "updates").listFiles()?.forEach { file ->
                    if (file.name.startsWith("update-") && file.extension in setOf("part", "apk")) {
                        store.ownedDownload(file.absolutePath)?.takeIf { it != verified?.apk }?.delete()
                    }
                }
            }
            loadBlockedStatus()
            val replacement = store.consumeReplacement()
            post {
                state = state.copy(initialized = true)
                if (replacement != null) {
                    state = state.copy(
                        visible = true,
                        updatedVersionCode = replacement,
                        phase = if (state.blocked != null) UpdatePhase.REQUIRED else UpdatePhase.UPDATED,
                    )
                }
                refreshInstallResult()
                val approved = sourceApprovalBeforeLaunch
                sourceApprovalBeforeLaunch = false
                val resumed = verified != null && resumeVerifiedDownload(verified, approved)
                if (enabled && !resumed) check(automatic = true)
            }
        }
    }

    fun checkNow() = check(automatic = false)

    fun later() {
        dismissalGeneration++
        manualCheckRequested = false
        if (state.phase == UpdatePhase.DOWNLOADING) cancelDownload = true
        if (state.phase == UpdatePhase.AWAITING_SOURCE_PERMISSION) {
            permissionScreenLaunched = false
            enqueue { store.clearDownload() }
            state = state.copy(phase = UpdatePhase.AVAILABLE)
        }
        state = state.copy(visible = false)
    }

    fun requestUpdate() {
        if (busy || state.phase in installingPhases) return
        val candidate = state.candidate ?: return checkNow()
        busy = true
        cancelDownload = false
        permissionScreenLaunched = false
        state = state.copy(
            visible = true,
            phase = UpdatePhase.DOWNLOADING,
            downloadedBytes = 0,
            totalBytes = candidate.manifest.asset.size,
        )
        enqueue {
            try {
                var lastProgress = 0L
                val apk = repository.download(candidate) { received, total ->
                    if (closed || cancelDownload) throw InterruptedIOException()
                    val now = System.nanoTime()
                    if (received == total || now - lastProgress >= 100_000_000L) {
                        lastProgress = now
                        post { state = state.copy(downloadedBytes = received, totalBytes = total) }
                    }
                }
                if (!store.rememberVerifiedDownload(apk, candidate.manifest.versionCode)) {
                    apk.delete()
                    throw IOException()
                }
                if (closed || cancelDownload) {
                    store.clearDownload()
                    post {
                        busy = false
                        state = state.copy(phase = UpdatePhase.AVAILABLE)
                    }
                    return@enqueue
                }
                post {
                    busy = false
                    if (cancelDownload) {
                        enqueue { store.clearDownload() }
                        state = state.copy(phase = UpdatePhase.AVAILABLE)
                        return@post
                    }
                    if (installer.canInstall()) beginInstall(apk, candidate.manifest.versionCode) else {
                        state = state.copy(phase = UpdatePhase.AWAITING_SOURCE_PERMISSION)
                    }
                }
                if (closed) store.clearDownload()
            } catch (_: Exception) {
                store.clearDownload()
                post {
                    busy = false
                    state = state.copy(phase = if (cancelDownload) UpdatePhase.AVAILABLE else UpdatePhase.ERROR)
                }
            }
        }
    }

    fun takeUnknownSourcesRequest(): Boolean {
        if (state.phase != UpdatePhase.AWAITING_SOURCE_PERMISSION || permissionScreenLaunched) return false
        permissionScreenLaunched = true
        return true
    }

    fun unknownSourcesIntent() = installer.unknownSourcesIntent()

    fun resumeAfterSourceApproval() {
        if (!state.initialized) {
            // Android 11 kills the app when the grant changes. The new process gets the Settings result
            // during its first resume, before the launch work restores the verified download from the store.
            sourceApprovalBeforeLaunch = true
            return
        }
        if (state.phase != UpdatePhase.AWAITING_SOURCE_PERMISSION) return
        permissionScreenLaunched = false
        val candidate = state.candidate
        val apk = store.downloadedApk?.let(::File)
        if (installer.canInstall() && candidate != null && apk?.isFile == true) {
            beginInstall(apk, candidate.manifest.versionCode)
        } else {
            enqueue { store.clearDownload() }
            state = state.copy(visible = true, phase = UpdatePhase.ERROR)
        }
    }

    fun sourceSettingsUnavailable() {
        permissionScreenLaunched = false
        enqueue { store.clearDownload() }
        state = state.copy(visible = true, phase = UpdatePhase.ERROR)
    }

    fun onForeground() {
        if (store.lastInstallResult.outcome == InstallOutcome.AWAITING_USER_ACTION) {
            UpdateForeground.currentActivity()?.let(installer::resumePendingUserAction)
        }
        refreshInstallResult()
        enqueue { loadBlockedStatus() }
    }

    private fun check(automatic: Boolean) {
        if (closed || state.phase in installingPhases) return
        if (!automatic) {
            manualCheckRequested = true
            state = state.copy(visible = true, phase = UpdatePhase.CHECKING)
        }
        if (busy) return
        busy = true
        val startedGeneration = dismissalGeneration
        val retainedPhase = state.phase.takeIf {
            automatic && state.visible && it in setOf(UpdatePhase.ERROR, UpdatePhase.UPDATED)
        }
        enqueue {
            val result = repository.check()
            post {
                busy = false
                val candidate = (result as? UpdateCheckResult.Available)?.candidate
                val keepPreviousPresentation = retainedPhase != null && !manualCheckRequested
                val phase = when {
                    candidate != null -> UpdatePhase.AVAILABLE
                    state.blocked != null -> UpdatePhase.REQUIRED
                    keepPreviousPresentation -> retainedPhase
                    result is UpdateCheckResult.Failed -> UpdatePhase.ERROR
                    state.updatedVersionCode != null -> UpdatePhase.UPDATED
                    else -> UpdatePhase.UP_TO_DATE
                }
                state = state.copy(
                    visible = manualCheckRequested || (startedGeneration == dismissalGeneration &&
                        (candidate != null || state.blocked != null ||
                            state.updatedVersionCode != null || retainedPhase != null)),
                    phase = phase,
                    candidate = candidate,
                    lastResult = result,
                )
                manualCheckRequested = false
            }
        }
    }

    /** Continues a download that waited for the install-source grant in an earlier process. */
    private fun resumeVerifiedDownload(download: UpdateStore.VerifiedDownload, approved: Boolean): Boolean {
        if (!approved || busy || state.phase in installingPhases) {
            enqueue { if (store.verifiedDownload() == download) store.clearDownload() }
            return false
        }
        if (installer.canInstall()) {
            state = state.copy(visible = true)
            beginInstall(download.apk, download.versionCode)
        } else {
            enqueue { store.clearDownload() }
            state = state.copy(visible = true, phase = UpdatePhase.ERROR)
        }
        return true
    }

    private fun beginInstall(apk: File, versionCode: Long) {
        busy = true
        state = state.copy(phase = UpdatePhase.INSTALLING)
        enqueue {
            try {
                installer.install(apk, versionCode)
                post { busy = false }
            } catch (_: UnknownSourcesRequiredException) {
                post {
                    busy = false
                    permissionScreenLaunched = false
                    state = state.copy(visible = true, phase = UpdatePhase.AWAITING_SOURCE_PERMISSION)
                }
            } catch (_: Exception) {
                store.clearDownload()
                post {
                    busy = false
                    state = state.copy(visible = true, phase = UpdatePhase.ERROR)
                }
            }
        }
    }

    private fun loadBlockedStatus() {
        val blocked = BlockedUpdateStatus.read(context.filesDir)?.takeUnless {
            it.satisfiedBy(ApkVerifier.installedVersionCode(context))
        }
        post {
            val appeared = blocked != null && blocked != state.blocked
            state = state.copy(
                blocked = blocked,
                visible = state.visible || appeared,
                phase = when {
                    appeared && state.candidate == null && state.phase !in installingPhases -> UpdatePhase.REQUIRED
                    blocked == null && state.phase == UpdatePhase.REQUIRED -> UpdatePhase.IDLE
                    else -> state.phase
                },
            )
        }
    }

    private fun refreshInstallResult() {
        val result = store.lastInstallResult
        if (lastInstallResult == result) return
        lastInstallResult = result
        val phase = when (result.outcome) {
            InstallOutcome.AWAITING_USER_ACTION, InstallOutcome.VERIFYING -> UpdatePhase.INSTALLING
            InstallOutcome.FAILED, InstallOutcome.ABORTED -> UpdatePhase.ERROR
            InstallOutcome.SUCCESS -> UpdatePhase.UPDATED
            InstallOutcome.IDLE -> return
        }
        state = state.copy(
            visible = state.visible || result.outcome in setOf(
                InstallOutcome.FAILED,
                InstallOutcome.ABORTED,
                InstallOutcome.SUCCESS,
            ),
            phase = phase,
        )
        if (result.outcome in setOf(InstallOutcome.SUCCESS, InstallOutcome.FAILED, InstallOutcome.ABORTED)) {
            store.lastInstallResult = InstallResult()
        }
        if (result.outcome == InstallOutcome.FAILED || result.outcome == InstallOutcome.ABORTED) {
            // The install stopped the server before the user could decline or the session could fail.
            enqueue {
                try {
                    serverController.resumeAfterAbandonedUpdate()
                } catch (_: Exception) {
                    // The server controller reports its own failures; the updater stays usable.
                }
            }
        }
    }

    override fun onCleared() {
        synchronized(this) {
            closed = true
            observer?.stopWatching()
        }
        preferences.unregisterOnSharedPreferenceChangeListener(preferenceListener)
        executor.shutdownNow()
        if (store.activeSessionId == null) store.clearDownload()
    }

    @VisibleForTesting
    internal fun awaitWorkerForTest() {
        val done = CountDownLatch(1)
        enqueue { done.countDown() }
        done.await(10, TimeUnit.SECONDS)
    }

    private fun enqueue(work: () -> Unit) {
        if (closed) return
        try {
            executor.execute { if (!closed) work() }
        } catch (_: RejectedExecutionException) {
            // FileObserver may deliver its final event concurrently with activity teardown.
        }
    }

    private fun post(work: () -> Unit) {
        main.post { if (!closed) work() }
    }

    companion object {
        private val installingPhases = setOf(
            UpdatePhase.DOWNLOADING,
            UpdatePhase.AWAITING_SOURCE_PERMISSION,
            UpdatePhase.INSTALLING,
        )

        fun forActivity(activity: ComponentActivity): AppUpdater =
            ViewModelProvider(
                activity,
                ViewModelProvider.AndroidViewModelFactory(activity.application),
            )[AppUpdater::class.java]
    }
}
