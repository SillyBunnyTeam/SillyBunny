package io.github.sillybunnyteam.sillybunny.firstrun

import android.os.Bundle

/**
 * The minimal state saved across process death. Lines, the setup log and the checkout state are not saved:
 * a recreated controller derives them from `ServerHost.setup` and the filesystem.
 */
internal data class FirstRunSnapshot(
    val stage: Stage,
    val cellular: Boolean = false,
    val failure: FirstRunFailure? = null,
    val notifications: NotificationStatus = NotificationStatus.NOT_ASKED,
    val battery: BatteryStatus = BatteryStatus.NOT_EXEMPT,
    val cancelRequested: Boolean = false,
    val logsOpen: Boolean = false,
) {
    enum class Stage { WELCOME, CHECKING, METERED, PREPARING, WAITING, INSTALLING, BUSY, FAILED, INSTALLED }

    fun toBundle(): Bundle = Bundle().apply {
        putInt(KEY_VERSION, VERSION)
        putString(KEY_STAGE, stage.name)
        putBoolean(KEY_CELLULAR, cellular)
        putString(KEY_NOTIFICATIONS, notifications.name)
        putString(KEY_BATTERY, battery.name)
        putBoolean(KEY_CANCEL, cancelRequested)
        putBoolean(KEY_LOGS, logsOpen)
        when (failure) {
            null -> Unit
            is FirstRunFailure.LowStorage -> {
                putString(KEY_FAILURE, FAILURE_STORAGE)
                putLong(KEY_AVAILABLE, failure.availableBytes)
                putLong(KEY_REQUIRED, failure.requiredBytes)
            }
            FirstRunFailure.Offline -> putString(KEY_FAILURE, FAILURE_OFFLINE)
            is FirstRunFailure.Layout -> {
                putString(KEY_FAILURE, FAILURE_LAYOUT)
                putString(KEY_REASON, failure.reason)
            }
            is FirstRunFailure.Install -> {
                putString(KEY_FAILURE, FAILURE_INSTALL)
                putInt(KEY_EXIT, failure.exitCode)
            }
            FirstRunFailure.Cancelled -> putString(KEY_FAILURE, FAILURE_CANCELLED)
            FirstRunFailure.Interrupted -> putString(KEY_FAILURE, FAILURE_INTERRUPTED)
            FirstRunFailure.NoCheckout -> putString(KEY_FAILURE, FAILURE_NO_CHECKOUT)
            is FirstRunFailure.MoveAside -> {
                putString(KEY_FAILURE, FAILURE_MOVE_ASIDE)
                putString(KEY_REASON, failure.reason)
            }
            is FirstRunFailure.Unexpected -> {
                putString(KEY_FAILURE, FAILURE_UNEXPECTED)
                putString(KEY_REASON, failure.reason)
            }
        }
    }

    companion object {
        private const val VERSION = 1
        private const val KEY_VERSION = "version"
        private const val KEY_STAGE = "stage"
        private const val KEY_CELLULAR = "cellular"
        private const val KEY_NOTIFICATIONS = "notifications"
        private const val KEY_BATTERY = "battery"
        private const val KEY_CANCEL = "cancelRequested"
        private const val KEY_LOGS = "logsOpen"
        private const val KEY_FAILURE = "failure"
        private const val KEY_AVAILABLE = "availableBytes"
        private const val KEY_REQUIRED = "requiredBytes"
        private const val KEY_REASON = "reason"
        private const val KEY_EXIT = "exitCode"
        private const val FAILURE_STORAGE = "storage"
        private const val FAILURE_OFFLINE = "offline"
        private const val FAILURE_LAYOUT = "layout"
        private const val FAILURE_INSTALL = "install"
        private const val FAILURE_CANCELLED = "cancelled"
        private const val FAILURE_INTERRUPTED = "interrupted"
        private const val FAILURE_NO_CHECKOUT = "noCheckout"
        private const val FAILURE_MOVE_ASIDE = "moveAside"
        private const val FAILURE_UNEXPECTED = "unexpected"

        /** Null for a missing, foreign or unreadable record, so the controller starts fresh. */
        fun fromBundle(bundle: Bundle?): FirstRunSnapshot? {
            if (bundle == null || bundle.getInt(KEY_VERSION) != VERSION) return null
            val stage = enumOrNull<Stage>(bundle.getString(KEY_STAGE)) ?: return null
            val reason = bundle.getString(KEY_REASON).orEmpty()
            val failure = when (bundle.getString(KEY_FAILURE)) {
                FAILURE_STORAGE -> FirstRunFailure.LowStorage(
                    bundle.getLong(KEY_AVAILABLE),
                    bundle.getLong(KEY_REQUIRED),
                )
                FAILURE_OFFLINE -> FirstRunFailure.Offline
                FAILURE_LAYOUT -> FirstRunFailure.Layout(reason)
                FAILURE_INSTALL -> FirstRunFailure.Install(bundle.getInt(KEY_EXIT))
                FAILURE_CANCELLED -> FirstRunFailure.Cancelled
                FAILURE_INTERRUPTED -> FirstRunFailure.Interrupted
                FAILURE_NO_CHECKOUT -> FirstRunFailure.NoCheckout
                FAILURE_MOVE_ASIDE -> FirstRunFailure.MoveAside(reason)
                FAILURE_UNEXPECTED -> FirstRunFailure.Unexpected(reason)
                else -> null
            }
            if (stage == Stage.FAILED && failure == null) return null
            return FirstRunSnapshot(
                stage = stage,
                cellular = bundle.getBoolean(KEY_CELLULAR),
                failure = failure,
                notifications = enumOrNull<NotificationStatus>(bundle.getString(KEY_NOTIFICATIONS))
                    ?: NotificationStatus.NOT_ASKED,
                battery = enumOrNull<BatteryStatus>(bundle.getString(KEY_BATTERY)) ?: BatteryStatus.NOT_EXEMPT,
                cancelRequested = bundle.getBoolean(KEY_CANCEL),
                logsOpen = bundle.getBoolean(KEY_LOGS),
            )
        }

        private inline fun <reified T : Enum<T>> enumOrNull(name: String?): T? =
            enumValues<T>().firstOrNull { it.name == name }
    }
}
