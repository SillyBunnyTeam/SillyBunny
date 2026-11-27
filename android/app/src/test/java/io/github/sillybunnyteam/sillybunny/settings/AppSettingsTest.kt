package io.github.sillybunnyteam.sillybunny.settings

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class AppSettingsTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()

    @Test
    fun gitAutoUpdateDefaultsOnAndPersists() {
        assertTrue(AppSettings(context).autoUpdateGit)
        AppSettings(context).autoUpdateGit = false
        assertFalse(AppSettings(context).autoUpdateGit)
        AppSettings(context).autoUpdateGit = true
        assertTrue(AppSettings(context).autoUpdateGit)
    }
}
