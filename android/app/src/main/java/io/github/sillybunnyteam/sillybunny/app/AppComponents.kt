package io.github.sillybunnyteam.sillybunny.app

import android.content.Context
import androidx.annotation.VisibleForTesting
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.core.content.edit
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStoreOwner
import io.github.sillybunnyteam.sillybunny.BuildConfig
import io.github.sillybunnyteam.sillybunny.DataDocumentsProvider
import io.github.sillybunnyteam.sillybunny.firstrun.CheckoutInspector
import io.github.sillybunnyteam.sillybunny.firstrun.FileCheckoutInspector
import io.github.sillybunnyteam.sillybunny.firstrun.FirstRun
import io.github.sillybunnyteam.sillybunny.firstrun.FirstRunController
import io.github.sillybunnyteam.sillybunny.firstrun.FirstRunDependencies
import io.github.sillybunnyteam.sillybunny.firstrun.FirstRunViewModel
import io.github.sillybunnyteam.sillybunny.firstrun.RuntimeLayoutOutcome
import io.github.sillybunnyteam.sillybunny.firstrun.RuntimeLayoutStep
import io.github.sillybunnyteam.sillybunny.repair.DocumentsProviderMaintenance
import io.github.sillybunnyteam.sillybunny.repair.LeftoverFolders
import io.github.sillybunnyteam.sillybunny.repair.RepairController
import io.github.sillybunnyteam.sillybunny.repair.RepairStore
import io.github.sillybunnyteam.sillybunny.runtime.RuntimeLayout
import io.github.sillybunnyteam.sillybunny.runtime.RuntimeLayoutException
import io.github.sillybunnyteam.sillybunny.runtime.RuntimeLayoutResult
import io.github.sillybunnyteam.sillybunny.runtime.RuntimePaths
import io.github.sillybunnyteam.sillybunny.server.LaunchSession
import io.github.sillybunnyteam.sillybunny.server.ServerHost
import io.github.sillybunnyteam.sillybunny.server.ServerManager
import io.github.sillybunnyteam.sillybunny.update.ServerController
import io.github.sillybunnyteam.sillybunny.web.WebScreen
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import java.io.File
import java.io.IOException
import java.time.Instant
import java.util.concurrent.atomic.AtomicBoolean

/**
 * What every launch of this process shares (plan §2.4): the server host, the one [RepairController] and the
 * [LeftoverFolders], which use one [RepairStore] so that Leftovers never deletes the folder an unfinished Repair
 * migrates from. Everything here keeps the application context only, because activities come and go.
 *
 * @param repairStartDeferred set when Repair succeeded while no activity was visible; the next started activity
 *   takes it and starts the server ([RepairController.startServer]).
 * @param webContent the web route's content below the app bar; tests replace the WebView's platform parts.
 */
internal class AppComponents(
    val paths: RuntimePaths,
    val server: ServerHost,
    val serverController: ServerController,
    val onActivityStarted: (Context) -> Unit,
    val onActivityStopped: () -> Unit,
    val layout: () -> RuntimeLayoutResult,
    val checkout: CheckoutInspector,
    val repair: RepairController,
    val leftovers: LeftoverFolders,
    val repairStartDeferred: AtomicBoolean,
    val firstRunDependencies: () -> FirstRunDependencies,
    val notifyRootsChanged: () -> Unit,
    val defaultRef: String = BuildConfig.DEFAULT_REF,
    val io: CoroutineDispatcher = Dispatchers.IO,
    val webContent: @Composable (LaunchSession, Modifier) -> Unit = { session, modifier ->
        WebScreen(session, modifier)
    },
) {
    /** Written when the launch's layout fails, so Share logs explains a runtime error screen. */
    val layoutLog = File(paths.logsDir, LAYOUT_LOG)

    /** Every log Share logs offers, oldest first. Blocking. */
    fun logFiles(): List<File> = listOfNotNull(layoutLog.takeIf { it.isFile }) + server.logFiles()

    /** Blocking; one line naming the layout failure, which replaces the previous one. */
    fun recordLayoutFailure(detail: String, now: Instant = Instant.now()) {
        try {
            paths.logsDir.mkdirs()
            layoutLog.writeText("$now runtime-layout $detail\n")
        } catch (_: IOException) {
            // The error screen still shows; Share logs then has the server logs only.
        }
    }

    /** Blocking; a ready layout makes an earlier failure line stale. */
    fun clearLayoutFailure() {
        layoutLog.delete()
    }

    /**
     * The first-run controller for [generation]: every generation is a new flow that reads the checkout afresh, so
     * a first run that ended once never resumes as finished when the checkout is gone again.
     */
    fun firstRunController(owner: ViewModelStoreOwner, generation: Int): FirstRunController {
        val provider = ViewModelProvider(owner, FirstRun.factory(firstRunDependencies()))
        return provider["$FIRST_RUN_KEY:$generation", FirstRunViewModel::class.java].controller
    }

    companion object {
        const val LAYOUT_LOG = "runtime-layout.log"
        private const val FIRST_RUN_KEY = "io.github.sillybunnyteam.sillybunny.app.FirstRun"
        private const val MAX_CAUSES = 4

        @Volatile
        private var instance: AppComponents? = null

        fun get(context: Context): AppComponents = instance ?: synchronized(this) {
            instance ?: production(context.applicationContext).also { instance = it }
        }

        /** Tests install fakes before the activity starts; production code never calls this. */
        @VisibleForTesting
        fun replaceForTest(components: AppComponents?) {
            synchronized(this) { instance = components }
        }

        private fun production(app: Context): AppComponents {
            val manager = ServerManager.get(app)
            val paths = RuntimePaths(app)
            val store = RepairStore(app)
            val deferred = AtomicBoolean(false)
            val layout = { RuntimeLayout.ensure(app) }
            val checkout = FileCheckoutInspector(paths.checkoutDir)
            val repair = RepairController(
                context = app,
                paths = paths,
                serverHost = manager,
                maintenance = DocumentsProviderMaintenance,
                installScript = paths.installScript,
                isVisible = { manager.activityVisible },
                onServerStartDeferred = { deferred.set(true) },
                store = store,
            )
            return AppComponents(
                paths = paths,
                server = manager,
                serverController = manager.serverController,
                onActivityStarted = manager::onActivityStarted,
                onActivityStopped = manager::onActivityStopped,
                layout = layout,
                checkout = checkout,
                repair = repair,
                leftovers = LeftoverFolders(paths, store),
                repairStartDeferred = deferred,
                firstRunDependencies = {
                    FirstRunDependencies(
                        context = app,
                        paths = paths,
                        serverHost = manager,
                        installScript = paths.installScript,
                        layout = layoutStep(layout),
                        checkout = checkout,
                    )
                },
                notifyRootsChanged = { DataDocumentsProvider.notifyRootsChanged(app) },
            )
        }

        /**
         * The first run's layout step over [layout]: Ready continues, and any other result fails with the error's
         * message.
         */
        fun layoutStep(layout: () -> RuntimeLayoutResult): RuntimeLayoutStep = RuntimeLayoutStep {
            when (val result = layout()) {
                is RuntimeLayoutResult.Ready -> RuntimeLayoutOutcome.Ready
                is RuntimeLayoutResult.Failed ->
                    RuntimeLayoutOutcome.Failed(result.error.message ?: RuntimeLayoutException.MESSAGE)
                RuntimeLayoutResult.Unavailable -> RuntimeLayoutOutcome.Failed(RuntimeLayoutException.MESSAGE)
            }
        }

        /** The cause chain for a log line, outermost first and bounded, because a chain can be long. */
        fun causes(first: Throwable?): String = generateSequence(first) { it.cause }
            .take(MAX_CAUSES)
            .joinToString("") { " cause=${it.javaClass.name}: ${it.message.orEmpty()}" }
    }
}

/** Whether this install already asked for `POST_NOTIFICATIONS`; the app asks at most once (plan §4.3 step 1). */
internal class LaunchPreferences(context: Context) {
    private val preferences = context.applicationContext.getSharedPreferences(NAME, Context.MODE_PRIVATE)

    var notificationsAsked: Boolean
        get() = preferences.getBoolean(KEY_NOTIFICATIONS_ASKED, false)
        set(value) = preferences.edit { putBoolean(KEY_NOTIFICATIONS_ASKED, value) }

    private companion object {
        const val NAME = "io.github.sillybunnyteam.sillybunny.app"
        const val KEY_NOTIFICATIONS_ASKED = "notifications_asked"
    }
}
