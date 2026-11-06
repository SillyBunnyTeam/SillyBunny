package io.github.sillybunnyteam.sillybunny.firstrun

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.createSavedStateHandle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory

/**
 * Keeps one [FirstRunController] across configuration changes. Its minimal record goes into the
 * [SavedStateHandle], so it also survives process death.
 */
class FirstRunViewModel(handle: SavedStateHandle, dependencies: FirstRunDependencies) : ViewModel() {
    val controller = FirstRunController(dependencies, viewModelScope, handle.get<Bundle>(STATE_KEY))

    init {
        handle.setSavedStateProvider(STATE_KEY) { controller.saveState() }
    }

    companion object {
        const val STATE_KEY = "io.github.sillybunnyteam.sillybunny.firstrun.state"
    }
}

/** How the activity obtains the first-run flow. */
object FirstRun {
    /**
     * The activity's first-run controller, created on first use. Later calls, including after a
     * configuration change, return the same controller and ignore [dependencies]. The first [dependencies]
     * live as long as the ViewModel, so they must not reference [activity] (see [FirstRunDependencies]).
     */
    fun controller(activity: ComponentActivity, dependencies: FirstRunDependencies): FirstRunController =
        ViewModelProvider(activity, factory(dependencies))[FirstRunViewModel::class.java].controller

    internal fun factory(dependencies: FirstRunDependencies): ViewModelProvider.Factory = viewModelFactory {
        initializer { FirstRunViewModel(createSavedStateHandle(), dependencies) }
    }
}
