package io.github.sillybunnyteam.sillybunny.server

import android.Manifest
import android.app.NotificationManager
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.ComponentActivity
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.github.sillybunnyteam.sillybunny.server.ServerDeviceFixture.Companion.isForegroundService
import io.github.sillybunnyteam.sillybunny.server.ServerDeviceFixture.Companion.isServiceRunning
import io.github.sillybunnyteam.sillybunny.server.ServerDeviceFixture.Companion.waitFor
import io.github.sillybunnyteam.sillybunny.server.ServerDeviceFixture.Companion.waitUntil
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * A denied notification permission (API 33+) only hides the notification: the service still promotes and
 * the server still runs and stops. Run this class on its own after
 * `pm revoke <package> android.permission.POST_NOTIFICATIONS`; [ServerServiceDeviceTest] grants it.
 */
@RunWith(AndroidJUnit4::class)
class ServerNotificationDeniedDeviceTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    @Test
    fun aDeniedNotificationPermissionNeverBlocksTheServer() {
        assumeTrue(Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
        assumeTrue(context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_DENIED)
        assertFalse(context.getSystemService(NotificationManager::class.java).areNotificationsEnabled())
        ServerDeviceFixture().use { fixture ->
            ActivityScenario.launch(ComponentActivity::class.java).use { scenario ->
                val manager = fixture.build()
                scenario.onActivity { manager.start(it) }
                waitFor("Running", 30_000) { manager.state.value as? ServerState.Running }
                waitUntil("foreground", 10_000) { isForegroundService(context) }
                assertTrue(manager.stop())
                assertTrue(manager.state.value == ServerState.Stopped(userStopped = true))
                waitUntil("service released", 15_000) { !isServiceRunning(context) }
            }
        }
    }
}
