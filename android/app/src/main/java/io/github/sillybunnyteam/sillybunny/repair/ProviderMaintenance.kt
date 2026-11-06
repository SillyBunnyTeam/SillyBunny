package io.github.sillybunnyteam.sillybunny.repair

import android.content.Context
import io.github.sillybunnyteam.sillybunny.DataDocumentsProvider

/**
 * The DocumentsProvider calls Repair needs to quiesce external writers (plan §4.7 "External writers",
 * §4.8). [DocumentsProviderMaintenance] is the production implementation.
 *
 * Repair calls [beginMaintenance] after stopping the server and before it moves anything, and calls
 * [endMaintenance] and then [notifyRootsChanged] on every later success and failure path, including on the
 * next launch after process death. A launch without an unfinished Repair also calls [endMaintenance], so a
 * provider that a failed end left closed reopens. Every call comes from a background thread.
 */
interface ProviderMaintenance {
    /** Rejects new provider operations and fences open provider descriptors. May block briefly. */
    fun beginMaintenance(context: Context)

    /** Reopens the provider. Must be a no-op when maintenance is not active. */
    fun endMaintenance(context: Context)

    /** Tells file managers that the provider's roots changed (the checkout was replaced). */
    fun notifyRootsChanged(context: Context)
}

/**
 * [ProviderMaintenance] on [DataDocumentsProvider]'s maintenance API (task 5.10). Beginning closes the
 * provider's delivered descriptors and revokes every issued document ID and grant; ending revokes them
 * again and starts a new ID generation, so file managers must ask for access again after Repair. Both
 * block on the provider's I/O worker and are safe without a checkout; ending is a no-op when inactive.
 */
object DocumentsProviderMaintenance : ProviderMaintenance {
    override fun beginMaintenance(context: Context) = DataDocumentsProvider.beginMaintenance(context)

    override fun endMaintenance(context: Context) = DataDocumentsProvider.endMaintenance(context)

    override fun notifyRootsChanged(context: Context) = DataDocumentsProvider.notifyRootsChanged(context)
}
