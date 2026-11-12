package io.github.sillybunnyteam.sillybunny.server

import android.app.Notification
import android.app.PendingIntent
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import io.github.sillybunnyteam.sillybunny.R
import io.github.sillybunnyteam.sillybunny.ServerService
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [37])
class ServerNotificationsTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()

    private fun onlyAction(mode: ServiceMode): Notification.Action =
        ServerNotifications.build(context, mode).actions.single()

    private fun assertStartsTheServiceWith(action: String, intent: PendingIntent) {
        val pending = shadowOf(intent)
        assertTrue(pending.isService)
        assertTrue(pending.isImmutable)
        assertEquals(action, pending.savedIntent.action)
        assertEquals(context.packageName, pending.savedIntent.component!!.packageName)
        assertEquals(ServerService::class.java.name, pending.savedIntent.component!!.className)
        assertNull(pending.savedIntent.extras)
    }

    @Test
    fun theSetupNotificationOffersCancelAndNoStop() {
        val notification = ServerNotifications.build(context, ServiceMode.SETUP)
        val cancel = notification.actions.single()

        assertEquals(context.getString(R.string.server_notification_cancel_setup), cancel.title.toString())
        assertStartsTheServiceWith(ServerService.ACTION_CANCEL_SETUP, cancel.actionIntent)
        assertEquals(cancel.actionIntent, ServerNotifications.cancelSetupIntent(context))
        assertTrue(shadowOf(notification.contentIntent).isImmutable)
    }

    @Test
    fun theServerNotificationKeepsItsStopAndOffersNoCancel() {
        val stop = onlyAction(ServiceMode.SERVER)

        assertEquals(context.getString(R.string.server_notification_stop), stop.title.toString())
        assertStartsTheServiceWith(ServerService.ACTION_STOP, stop.actionIntent)
        assertEquals(stop.actionIntent, ServerNotifications.stopIntent(context))
        assertNotEquals(stop.actionIntent, ServerNotifications.cancelSetupIntent(context))
        assertNotEquals(ServerService.ACTION_STOP, ServerService.ACTION_CANCEL_SETUP)
    }
}
