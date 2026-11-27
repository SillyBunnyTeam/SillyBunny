package io.github.sillybunnyteam.sillybunny.update

import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner

class UpdateActivityHook(private val activity: ComponentActivity) : DefaultLifecycleObserver {
    val updater = AppUpdater.forActivity(activity)
    private var foreground by mutableStateOf(false)
    private var returnedFromSourceSettings = false
    private val sourceSettings = activity.activityResultRegistry.register(
        "apk-update-source-approval",
        activity,
        ActivityResultContracts.StartActivityForResult(),
    ) {
        if (foreground) updater.resumeAfterSourceApproval() else returnedFromSourceSettings = true
    }

    fun attach() {
        activity.lifecycle.addObserver(this)
        updater.onLaunch()
    }

    override fun onResume(owner: LifecycleOwner) {
        foreground = true
        UpdateForeground.attach(activity)
        if (returnedFromSourceSettings) {
            returnedFromSourceSettings = false
            updater.resumeAfterSourceApproval()
        }
        updater.onForeground()
    }

    override fun onPause(owner: LifecycleOwner) {
        foreground = false
        UpdateForeground.detach(activity)
    }

    override fun onDestroy(owner: LifecycleOwner) {
        UpdateForeground.detach(activity)
        activity.lifecycle.removeObserver(this)
    }

    @Composable
    fun Dialog() {
        val state = updater.state
        LaunchedEffect(state.phase, foreground) {
            if (foreground && updater.takeUnknownSourcesRequest()) {
                try {
                    sourceSettings.launch(updater.unknownSourcesIntent())
                } catch (_: RuntimeException) {
                    updater.sourceSettingsUnavailable()
                }
            }
        }
        UpdateDialog(state, updater::requestUpdate, updater::checkNow, updater::later)
    }
}
