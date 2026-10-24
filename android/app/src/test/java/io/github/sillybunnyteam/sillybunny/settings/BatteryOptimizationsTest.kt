package io.github.sillybunnyteam.sillybunny.settings

import android.content.Context
import android.os.PowerManager
import android.provider.Settings
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29, 37])
class BatteryOptimizationsTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val battery = SystemBatteryOptimizations(context)

    @Test
    fun readsTheExemptionFromPowerManager() {
        val power = shadowOf(context.getSystemService(PowerManager::class.java))
        power.setIgnoringBatteryOptimizations(context.packageName, false)
        assertFalse(battery.isExempt())
        power.setIgnoringBatteryOptimizations(context.packageName, true)
        assertTrue(battery.isExempt())
    }

    @Test
    fun aNotExemptAppTriesThePerAppRequestThenTheSystemList() {
        val intents = battery.shortcutIntents(exempt = false)
        assertEquals(
            listOf(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS),
            intents.map { it.action },
        )
        assertEquals("package:${context.packageName}", intents[0].dataString)
        assertNull(intents[1].data)
    }

    @Test
    fun anExemptAppOnlyGetsTheSystemList() {
        // The request screen closes at once for an exempt app, so only the list can change anything.
        val intents = battery.shortcutIntents(exempt = true)
        assertEquals(listOf(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS), intents.map { it.action })
    }
}
