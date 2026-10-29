package io.github.sillybunnyteam.sillybunny.web.files

import android.view.View
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.findViewTreeViewModelStoreOwner

/** One value kept for the lifetime of a ViewModelStoreOwner, so it outlives activity recreation. */
internal class RetainedValue(val value: Any, private val onClear: () -> Unit) : ViewModel() {
    override fun onCleared() = onClear()
}

/**
 * Returns the value stored under [key] in this view tree's ViewModelStoreOwner (normally the
 * activity), creating it with [initial] on first use. [onClear] runs once the owner is destroyed
 * for good, not on a configuration change. Without an owner the value is not retained.
 */
internal fun <T : Any> View.retained(key: String, initial: () -> T, onClear: (T) -> Unit): T {
    val owner = findViewTreeViewModelStoreOwner() ?: return initial()
    val factory = object : ViewModelProvider.Factory {
        override fun <V : ViewModel> create(modelClass: Class<V>): V {
            val value = initial()
            return modelClass.cast(RetainedValue(value) { onClear(value) })!!
        }
    }
    @Suppress("UNCHECKED_CAST")
    return ViewModelProvider(owner, factory)[key, RetainedValue::class.java].value as T
}
