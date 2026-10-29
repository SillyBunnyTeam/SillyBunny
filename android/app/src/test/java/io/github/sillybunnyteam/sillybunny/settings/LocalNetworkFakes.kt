package io.github.sillybunnyteam.sillybunny.settings

import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger

/** The permission's name, spelled out so the Compose tests can run below API 37. */
internal const val LOCAL_NETWORK_PERMISSION = "android.permission.ACCESS_LOCAL_NETWORK"

/**
 * A [LocalNetworkAccess] whose status the test sets. Answers follow the real transitions; [permission] null stands
 * for a system below API 37.
 */
internal class FakeLocalNetwork(
    override val permission: String? = LOCAL_NETWORK_PERMISSION,
    @Volatile var current: LocalNetworkStatus = LocalNetworkStatus.NOT_ASKED,
) : LocalNetworkAccess {
    /** Every answer as (granted, canAskAgain). */
    val answers = CopyOnWriteArrayList<Pair<Boolean, Boolean>>()
    val reads = AtomicInteger()

    override fun status(): LocalNetworkStatus {
        reads.incrementAndGet()
        return if (permission == null) LocalNetworkStatus.NOT_REQUIRED else current
    }

    override fun onRequestResult(granted: Boolean, canAskAgain: Boolean): LocalNetworkStatus {
        answers += granted to canAskAgain
        current = LocalNetworkAccess.afterAnswer(status(), granted, canAskAgain)
        return current
    }
}
