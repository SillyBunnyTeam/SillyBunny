package io.github.sillybunnyteam.sillybunny

import android.app.Service
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class ScaffoldTest {
    @Test
    fun packagedResourcesAreAvailable() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        assertEquals("SillyBunny", context.getString(R.string.app_name))
    }

    @Test
    fun serverServiceStaysInert() {
        val service = Robolectric.buildService(ServerService::class.java).create().get()
        assertEquals(Service.START_NOT_STICKY, service.onStartCommand(null, 0, 1))
    }
}
