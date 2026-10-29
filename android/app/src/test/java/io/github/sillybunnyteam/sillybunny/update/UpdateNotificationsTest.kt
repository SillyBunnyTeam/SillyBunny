package io.github.sillybunnyteam.sillybunny.update

import android.Manifest
import android.app.Application
import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ComponentName
import android.content.ContextWrapper
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.test.core.app.ApplicationProvider
import io.github.sillybunnyteam.sillybunny.MainActivity
import io.github.sillybunnyteam.sillybunny.R
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29, 31, 34, 35, 37])
class UpdateNotificationsTest {
    private lateinit var context: Application
    private lateinit var manager: NotificationManager

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        manager = requireNotNull(context.getSystemService(NotificationManager::class.java))
        shadowOf(manager).setNotificationsEnabled(true)
        manager.cancelAll()
        if (Build.VERSION.SDK_INT >= 33) {
            shadowOf(context).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    @Test
    fun channelIsIdempotentAndUsesTheOwnedResource() {
        UpdateNotifications.ensureChannel(context)
        UpdateNotifications.ensureChannel(context)
        val channel = requireNotNull(manager.getNotificationChannel(UpdateNotifications.CHANNEL_ID))
        assertNotNull(channel)
        assertEquals(context.getString(R.string.update_notification_channel), channel.name)
        assertEquals(NotificationManager.IMPORTANCE_DEFAULT, channel.importance)
    }

    @Test
    fun replacementUsesAnImmutableDirectMainActivityIntentWithoutStartingAnything() {
        UpdateNotifications.postReplaced(context)
        val notification = shadowOf(manager).getNotification(UpdateNotifications.REPLACED_ID)
        assertNotNull(notification)
        assertEquals(UpdateNotifications.CHANNEL_ID, notification.channelId)
        assertEquals(context.getString(R.string.update_replaced_title), notification.extras.getString(Notification.EXTRA_TITLE))
        assertEquals(context.getString(R.string.update_replaced_body), notification.extras.getString(Notification.EXTRA_TEXT))
        assertEquals(R.drawable.ic_update_notification, notification.smallIcon.resId)
        assertTrue(notification.flags and Notification.FLAG_AUTO_CANCEL != 0)
        val pending = shadowOf(notification.contentIntent)
        assertTrue(pending.isActivity)
        assertFalse(pending.isBroadcast)
        assertEquals(PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE, pending.flags)
        assertNull(pending.options)
        assertEquals(ComponentName(context, MainActivity::class.java), pending.savedIntent.component)
        assertEquals(
            Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP,
            pending.savedIntent.flags,
        )
        assertNull(shadowOf(context).nextStartedActivity)
        assertNull(shadowOf(context).nextStartedService)
    }

    @Test
    fun userActionNotificationDirectlyOpensTheSuppliedInstallerAndCannotReplaceTheLaunchNotification() {
        val installer = Intent("fixture.CONFIRM")
            .setComponent(ComponentName("fixture.installer", "fixture.installer.ConfirmActivity"))
            .putExtra("fixture.session", 24)
        UpdateNotifications.postReplaced(context)
        UpdateNotifications.postUserAction(context, installer)
        val notification = shadowOf(manager).getNotification(UpdateNotifications.INSTALL_ID)
        val pending = shadowOf(notification.contentIntent)
        assertTrue(pending.isActivity)
        assertEquals(
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_ONE_SHOT,
            pending.flags,
        )
        assertNull(pending.options)
        assertEquals(installer.component, pending.savedIntent.component)
        assertEquals(installer.action, pending.savedIntent.action)
        assertEquals(24, pending.savedIntent.getIntExtra("fixture.session", -1))
        assertTrue(pending.savedIntent.flags and Intent.FLAG_ACTIVITY_NEW_TASK != 0)
        assertEquals(0, installer.flags)
        assertEquals(context.getString(R.string.update_install_title), notification.extras.getString(Notification.EXTRA_TITLE))
        assertEquals(context.getString(R.string.update_install_body), notification.extras.getString(Notification.EXTRA_TEXT))
        assertNotNull(shadowOf(manager).getNotification(UpdateNotifications.REPLACED_ID))
        assertNull(shadowOf(context).nextStartedActivity)
        assertNull(shadowOf(context).nextStartedService)
    }

    @Test
    fun disabledNotificationsAreHarmlessAndTheChannelStillExists() {
        shadowOf(manager).setNotificationsEnabled(false)
        UpdateNotifications.postReplaced(context)
        UpdateNotifications.postUserAction(context, Intent("fixture.CONFIRM"))
        assertEquals(0, shadowOf(manager).size())
        assertNotNull(manager.getNotificationChannel(UpdateNotifications.CHANNEL_ID))
        assertNull(shadowOf(context).nextStartedActivity)
        assertNull(shadowOf(context).nextStartedService)
    }

    @Test
    @Config(sdk = [34, 35, 37])
    fun deniedPostNotificationsIsHandledEvenWhenTheManagerReportsEnabled() {
        shadowOf(context).denyPermissions(Manifest.permission.POST_NOTIFICATIONS)
        assertEquals(PackageManager.PERMISSION_DENIED, context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS))
        UpdateNotifications.postReplaced(context)
        UpdateNotifications.postUserAction(context, Intent("fixture.CONFIRM"))
        assertEquals(0, shadowOf(manager).size())
    }

    @Test
    fun securityExceptionsDoNotEscapeFromTheNotificationLayer() {
        val denied = object : ContextWrapper(context) {
            override fun getSystemService(name: String): Any {
                throw SecurityException()
            }
        }
        UpdateNotifications.ensureChannel(denied)
        UpdateNotifications.postReplaced(denied)
        UpdateNotifications.postUserAction(denied, Intent("fixture.CONFIRM"))
        UpdateNotifications.cancelInstall(denied)
        assertEquals(0, shadowOf(manager).size())
    }

    @Test
    fun cancellingInstallationLeavesTheReplacementNotificationAlone() {
        UpdateNotifications.postReplaced(context)
        UpdateNotifications.postUserAction(context, Intent("fixture.CONFIRM"))
        UpdateNotifications.cancelInstall(context)
        assertNull(shadowOf(manager).getNotification(UpdateNotifications.INSTALL_ID))
        assertNotNull(shadowOf(manager).getNotification(UpdateNotifications.REPLACED_ID))
    }
}
