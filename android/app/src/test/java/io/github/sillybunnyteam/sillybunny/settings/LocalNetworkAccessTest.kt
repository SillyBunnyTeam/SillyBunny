package io.github.sillybunnyteam.sillybunny.settings

import android.app.Application
import android.provider.Settings
import androidx.test.core.app.ApplicationProvider
import io.github.sillybunnyteam.sillybunny.settings.LocalNetworkStatus.BLOCKED
import io.github.sillybunnyteam.sillybunny.settings.LocalNetworkStatus.DENIED
import io.github.sillybunnyteam.sillybunny.settings.LocalNetworkStatus.GRANTED
import io.github.sillybunnyteam.sillybunny.settings.LocalNetworkStatus.NOT_ASKED
import io.github.sillybunnyteam.sillybunny.settings.LocalNetworkStatus.NOT_REQUIRED
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [37])
class LocalNetworkAccessTest {
    private val app: Application get() = ApplicationProvider.getApplicationContext()

    @Test
    @Config(sdk = [29, 36])
    fun belowApi37ThereIsNothingToAsk() {
        val access = AndroidLocalNetworkAccess(app)
        assertNull(access.permission)
        assertEquals(NOT_REQUIRED, access.status())
        assertEquals(NOT_REQUIRED, access.onRequestResult(granted = false, canAskAgain = false))
        assertEquals(NOT_REQUIRED, AndroidLocalNetworkAccess(app).status())
    }

    @Test
    fun onApi37ItIsAskedUntilTheSystemStopsShowingTheDialog() {
        val access = AndroidLocalNetworkAccess(app)
        assertEquals(LOCAL_NETWORK_PERMISSION, access.permission)
        assertEquals(NOT_ASKED, access.status())
        // A first answer without a rationale can be a dismissed dialog, so the next tap still asks.
        assertEquals(DENIED, access.onRequestResult(granted = false, canAskAgain = false))
        assertEquals(DENIED, access.onRequestResult(granted = false, canAskAgain = true))
        assertEquals(BLOCKED, access.onRequestResult(granted = false, canAskAgain = false))
        assertEquals(BLOCKED, access.onRequestResult(granted = false, canAskAgain = false))
        // A rationale again means the dialog shows again, for example after a change in system settings.
        assertEquals(DENIED, access.onRequestResult(granted = false, canAskAgain = true))
    }

    @Test
    fun theLastDenialSurvivesProcessDeath() {
        assertEquals(DENIED, AndroidLocalNetworkAccess(app).onRequestResult(granted = false, canAskAgain = true))
        // A new instance stands in for a new process: only the stored answer is left.
        val restarted = AndroidLocalNetworkAccess(app)
        assertEquals(DENIED, restarted.status())
        assertEquals(BLOCKED, restarted.onRequestResult(granted = false, canAskAgain = false))
        assertEquals(BLOCKED, AndroidLocalNetworkAccess(app).status())
    }

    @Test
    fun aGrantWinsAndARevocationShowsTheLastDenialAgain() {
        val access = AndroidLocalNetworkAccess(app)
        access.onRequestResult(granted = false, canAskAgain = false)
        access.onRequestResult(granted = false, canAskAgain = false)
        assertEquals(BLOCKED, access.status())

        // Granted on the system settings page.
        shadowOf(app).grantPermissions(LOCAL_NETWORK_PERMISSION)
        assertEquals(GRANTED, access.status())
        assertEquals(GRANTED, access.onRequestResult(granted = false, canAskAgain = false))
        assertEquals(GRANTED, access.onRequestResult(granted = true, canAskAgain = false))

        // Revoked there again: the row keeps opening the settings page rather than a dialog that may not show.
        shadowOf(app).denyPermissions(LOCAL_NETWORK_PERMISSION)
        assertEquals(BLOCKED, AndroidLocalNetworkAccess(app).status())
    }

    @Test
    fun aGrantedAnswerIsShownWithoutStoringAnything() {
        val access = AndroidLocalNetworkAccess(app)
        shadowOf(app).grantPermissions(LOCAL_NETWORK_PERMISSION)
        assertEquals(GRANTED, access.onRequestResult(granted = true, canAskAgain = false))
        shadowOf(app).denyPermissions(LOCAL_NETWORK_PERMISSION)
        assertEquals(NOT_ASKED, access.status())
    }

    @Test
    fun everyTransition() {
        val cases = listOf(
            Triple(NOT_REQUIRED, true, true) to NOT_REQUIRED,
            Triple(NOT_REQUIRED, false, false) to NOT_REQUIRED,
            Triple(NOT_ASKED, true, false) to GRANTED,
            Triple(NOT_ASKED, false, true) to DENIED,
            Triple(NOT_ASKED, false, false) to DENIED,
            Triple(DENIED, false, true) to DENIED,
            Triple(DENIED, false, false) to BLOCKED,
            Triple(DENIED, true, false) to GRANTED,
            Triple(BLOCKED, false, false) to BLOCKED,
            Triple(BLOCKED, false, true) to DENIED,
            Triple(BLOCKED, true, false) to GRANTED,
            Triple(GRANTED, false, false) to GRANTED,
        )
        for ((input, expected) in cases) {
            val (current, granted, canAskAgain) = input
            assertEquals("$input", expected, LocalNetworkAccess.afterAnswer(current, granted, canAskAgain))
        }
    }

    @Test
    fun theSettingsPageIsTheAppsOwnPage() {
        val intent = LocalNetworkAccess.settingsIntent("io.example.app")
        assertEquals(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, intent.action)
        assertEquals("package:io.example.app", intent.dataString)
    }
}
