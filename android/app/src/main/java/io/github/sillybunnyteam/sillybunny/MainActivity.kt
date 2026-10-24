package io.github.sillybunnyteam.sillybunny

import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import io.github.sillybunnyteam.sillybunny.app.AppActions
import io.github.sillybunnyteam.sillybunny.app.AppComponents
import io.github.sillybunnyteam.sillybunny.app.AppContent
import io.github.sillybunnyteam.sillybunny.app.AppTheme
import io.github.sillybunnyteam.sillybunny.app.LaunchCoordinator
import io.github.sillybunnyteam.sillybunny.app.LaunchPreferences
import io.github.sillybunnyteam.sillybunny.firstrun.AndroidNotificationPermission
import io.github.sillybunnyteam.sillybunny.server.LaunchSession
import io.github.sillybunnyteam.sillybunny.settings.LeftoverFolderCounter
import io.github.sillybunnyteam.sillybunny.settings.SettingsDependencies
import io.github.sillybunnyteam.sillybunny.update.AppUpdater
import io.github.sillybunnyteam.sillybunny.update.UpdateActivityHook
import io.github.sillybunnyteam.sillybunny.web.openInBrowser
import kotlinx.coroutines.launch

/**
 * The only activity: the startup sequence of plan §2.4 runs in [LaunchCoordinator], and every server start
 * runs from here while this activity is started, because Android refuses foreground-service starts from the
 * background.
 */
class MainActivity : ComponentActivity() {
    private lateinit var components: AppComponents
    private lateinit var coordinator: LaunchCoordinator
    private lateinit var preferences: LaunchPreferences

    // A denial only hides the server notification, so nothing waits for the answer.
    private val notificationRequest = registerForActivityResult(ActivityResultContracts.RequestPermission()) {}

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        components = AppComponents.get(this)
        preferences = LaunchPreferences(this)
        // Set before the launch check runs, so that an APK install can stop the server and restore it.
        AppUpdater.forActivity(this).serverController = components.serverController
        // Keep SillyBunny's asynchronous updater separate from server startup and later activity work.
        val updates = UpdateActivityHook(this).also { it.attach() }
        coordinator = LaunchCoordinator.forActivity(this, components)
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
        )
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                coordinator.startRequest.collect { requested ->
                    if (requested && coordinator.takeStartRequest()) startServer()
                }
            }
        }
        val actions = AppActions(
            settings = {
                SettingsDependencies.forActivity(
                    activity = this,
                    serverHost = components.server,
                    leftoverFolders = LeftoverFolderCounter(components.leftovers::count),
                )
            },
            openInBrowser = ::openSessionInBrowser,
            onFirstRunShown = ::onFirstRunShown,
            onFirstRunInstalled = coordinator::onFirstRunInstalled,
            onRepairShown = ::askForNotificationsOnce,
        )
        setContent {
            AppTheme {
                AppContent(coordinator, components, actions)
                // The updater owns its lifecycle, source-approval return, and transient dialog.
                updates.Dialog()
            }
        }
    }

    override fun onStart() {
        super.onStart()
        components.onActivityStarted(this)
        if (components.repairStartDeferred.getAndSet(false)) components.repair.startServer()
    }

    override fun onStop() {
        components.onActivityStopped()
        super.onStop()
    }

    private fun startServer() {
        askForNotificationsOnce()
        components.server.start(this)
    }

    /** Plan §4.3 step 1: once per install, before the first server start or setup, on API 33+ only. */
    private fun askForNotificationsOnce() {
        val permission = AndroidNotificationPermission.requestPermission() ?: return
        if (preferences.notificationsAsked) return
        preferences.notificationsAsked = true
        if (ContextCompat.checkSelfPermission(this, permission) != PackageManager.PERMISSION_GRANTED) {
            notificationRequest.launch(permission)
        }
    }

    private fun onFirstRunShown() {
        // The first run's Welcome asks, so a Repair from the first run or the start after it must not ask again.
        preferences.notificationsAsked = true
    }

    private fun openSessionInBrowser(session: LaunchSession) {
        if (!openInBrowser(this, session)) Toast.makeText(this, R.string.web_no_browser, Toast.LENGTH_SHORT).show()
    }
}
