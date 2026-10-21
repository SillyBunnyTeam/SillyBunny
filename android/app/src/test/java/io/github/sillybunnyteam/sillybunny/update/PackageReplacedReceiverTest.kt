package io.github.sillybunnyteam.sillybunny.update

import android.Manifest
import android.app.Application
import android.app.Notification
import android.app.NotificationManager
import android.content.Intent
import android.os.Build
import androidx.test.core.app.ApplicationProvider
import io.github.sillybunnyteam.sillybunny.MainActivity
import io.github.sillybunnyteam.sillybunny.PackageReplacedReceiver
import org.junit.Assert.assertEquals
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
class PackageReplacedReceiverTest {
    private val context = ApplicationProvider.getApplicationContext<Application>()
    private val notifications = context.getSystemService(NotificationManager::class.java)

    @Before
    fun resetState() {
        context.getSharedPreferences("app_updates", 0).edit().clear().commit()
        notifications.cancelAll()
        shadowOf(notifications).setNotificationsEnabled(true)
        if (Build.VERSION.SDK_INT >= 33) shadowOf(context).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
    }

    @Test
    fun recordsReplacementAndPostsADirectImmutableTapToStart() {
        PackageReplacedReceiver().onReceive(context, Intent(Intent.ACTION_MY_PACKAGE_REPLACED))

        val notification = notifications.activeNotifications.single().notification
        assertEquals("lorum ipsum", notification.extras.getCharSequence(Notification.EXTRA_TITLE))
        assertEquals("lorum ipsum", notification.extras.getCharSequence(Notification.EXTRA_TEXT))
        assertEquals("lorum ipsum", notifications.getNotificationChannel(notification.channelId).name)
        val pending = shadowOf(notification.contentIntent)
        assertTrue(pending.isActivity)
        assertTrue(pending.isImmutable)
        assertEquals(MainActivity::class.java.name, pending.savedIntent.component!!.className)
        assertEquals(1L, UpdateStore(context).consumeReplacement())
        assertNull(UpdateStore(context).consumeReplacement())
        assertNull(shadowOf(context).nextStartedService)
        assertNull(shadowOf(context).nextStartedActivity)
    }

    @Test
    fun denialStillRecordsTheUpdatedVersionWithoutStartingAnything() {
        shadowOf(notifications).setNotificationsEnabled(false)
        if (Build.VERSION.SDK_INT >= 33) shadowOf(context).denyPermissions(Manifest.permission.POST_NOTIFICATIONS)

        PackageReplacedReceiver().onReceive(context, Intent(Intent.ACTION_MY_PACKAGE_REPLACED))

        assertTrue(notifications.activeNotifications.isEmpty())
        assertEquals(1L, UpdateStore(context).consumeReplacement())
        assertNull(shadowOf(context).nextStartedService)
        assertNull(shadowOf(context).nextStartedActivity)
    }

    @Test
    fun ignoresOtherBroadcasts() {
        PackageReplacedReceiver().onReceive(context, Intent(Intent.ACTION_PACKAGE_REPLACED))
        assertNull(UpdateStore(context).consumeReplacement())
        assertTrue(notifications.activeNotifications.isEmpty())
    }
}
