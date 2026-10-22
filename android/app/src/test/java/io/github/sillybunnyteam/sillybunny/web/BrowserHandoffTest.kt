package io.github.sillybunnyteam.sillybunny.web

import android.app.Application
import android.content.Intent
import androidx.test.core.app.ApplicationProvider
import io.github.sillybunnyteam.sillybunny.server.LaunchSession
import java.nio.ByteBuffer
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [37])
class BrowserHandoffTest {
    private val token = "0123456789abcdef".repeat(4)
    private val nonce = ByteArray(16) { it.toByte() }
    private val expiry = 1_700_000_030_000L
    private val address = WebAddress("sb-abcdefghijklmnopqrstuvwxyz")

    @Test
    fun matchesTheServerImplementation() {
        val code = BrowserHandoff.code(token, nonce, expiry)
        // Printed so the same code can be fed back to the Node middleware (see the track report).
        println("handoff vector (Kotlin): $code")
        assertEquals(SERVER_VECTOR, code)
    }

    @Test
    fun serverVectorCarriesItsInputsAndAValidMac() {
        val bytes = Base64.getUrlDecoder().decode(SERVER_VECTOR)
        assertEquals(56, bytes.size)
        assertArrayEquals(nonce, bytes.copyOfRange(0, 16))
        assertEquals(expiry, ByteBuffer.wrap(bytes, 16, 8).long)
        val mac = Mac.getInstance("HmacSHA256").run {
            init(SecretKeySpec(token.toByteArray(Charsets.UTF_8), "HmacSHA256"))
            doFinal("handoff".toByteArray(Charsets.US_ASCII) + bytes.copyOfRange(0, 24))
        }
        assertArrayEquals(mac, bytes.copyOfRange(24, 56))
    }

    @Test
    fun codesAreUnpaddedBase64UrlOf75Characters() {
        val code = BrowserHandoff.code(token, ByteArray(16) { 0xFF.toByte() }, Long.MAX_VALUE)
        assertEquals(BrowserHandoff.CODE_LENGTH, code.length)
        assertTrue(code.matches(Regex("[A-Za-z0-9_-]{75}")))
    }

    @Test(expected = IllegalArgumentException::class)
    fun rejectsAShortNonce() {
        BrowserHandoff.code(token, ByteArray(15), expiry)
    }

    @Test(expected = IllegalArgumentException::class)
    fun rejectsANegativeExpiry() {
        BrowserHandoff.code(token, nonce, -1)
    }

    @Test
    fun uriIsFreshShortLivedAndFreeOfTheToken() {
        val session = LaunchSession(41_234, token)
        val now = 1_800_000_000_000L
        val first = BrowserHandoff.uri(session, address, now)
        val second = BrowserHandoff.uri(session, address, now)
        assertEquals("http", first.scheme)
        // The per-install web origin, so the browser holds the cookie host-only on the label.
        assertEquals("sb-abcdefghijklmnopqrstuvwxyz.localhost", first.host)
        assertEquals(41_234, first.port)
        assertEquals("/__sillybunny/handoff", first.path)
        assertEquals(setOf("c"), first.queryParameterNames)
        assertFalse(first.toString().contains(token))
        val code = first.getQueryParameter("c")!!
        assertEquals(75, code.length)
        val bytes = Base64.getUrlDecoder().decode(code)
        val expiresAt = ByteBuffer.wrap(bytes, 16, 8).long
        assertTrue(expiresAt > now)
        // The server refuses codes that expire more than 60 s ahead.
        assertTrue(expiresAt - now < 60_000)
        assertEquals(code, BrowserHandoff.code(token, bytes.copyOfRange(0, 16), expiresAt))
        assertNotEquals(code, second.getQueryParameter("c"))
    }

    @Test
    fun openInBrowserStartsABrowsableViewIntentForTheHandoff() {
        val app = ApplicationProvider.getApplicationContext<Application>()
        assertTrue(openInBrowser(app, LaunchSession(41_234, token), address))
        val intent = shadowOf(app).nextStartedActivity
        assertEquals(Intent.ACTION_VIEW, intent.action)
        assertTrue(intent.hasCategory(Intent.CATEGORY_BROWSABLE))
        assertTrue(intent.flags and Intent.FLAG_ACTIVITY_NEW_TASK != 0)
        assertEquals("/__sillybunny/handoff", intent.data!!.path)
        assertEquals("http://${address.host}:41234", "${intent.data!!.scheme}://${intent.data!!.authority}")
        assertFalse(intent.dataString!!.contains(token))
    }

    @Test
    fun openInBrowserDefaultsToThisInstallsAddress() {
        val app = ApplicationProvider.getApplicationContext<Application>()
        assertTrue(openInBrowser(app, LaunchSession(41_234, token)))
        val uri = shadowOf(app).nextStartedActivity.data!!
        assertEquals("${WebAddress.forInstall(app).host}:41234", uri.authority)
    }

    @Test
    fun openInBrowserReportsAMissingBrowser() {
        val app = ApplicationProvider.getApplicationContext<Application>()
        shadowOf(app).checkActivities(true)
        assertFalse(openInBrowser(app, LaunchSession(41_234, token)))
    }

    private companion object {
        /** `createHandoffCode(token, { nonce: 00..0f, expiry })` from `src/middleware/launchToken.js`, Node 24. */
        const val SERVER_VECTOR = "AAECAwQFBgcICQoLDA0ODwAAAYvP5d0wgwTfxdwSCIRp_R40FV2xHLDh0Ku86otNDYPib2O5W3g"
    }
}
