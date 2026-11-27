package io.github.sillybunnyteam.sillybunny.web

import android.app.Application
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import io.github.sillybunnyteam.sillybunny.server.LaunchSession
import java.security.SecureRandom
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [37])
class WebAddressTest {
    private val app = ApplicationProvider.getApplicationContext<Application>()

    private fun fixed(bytes: ByteArray) = object : SecureRandom() {
        override fun nextBytes(out: ByteArray) {
            bytes.copyInto(out)
        }
    }

    @Test
    fun labelsAreUnpaddedLowercaseBase32Of16Bytes() {
        // RFC 4648 base32 of 00..0f and of sixteen ff bytes, lowercase and unpadded.
        assertEquals("sb-aaaqeayeaudaocajbifqydiob4", WebAddress.newLabel(fixed(ByteArray(16) { it.toByte() })))
        assertEquals("sb-77777777777777777777777774", WebAddress.newLabel(fixed(ByteArray(16) { 0xFF.toByte() })))
        val random = WebAddress.newLabel(SecureRandom())
        assertTrue(random, WebAddress.isLabel(random))
        assertEquals(29, random.length)
        assertNotEquals(random, WebAddress.newLabel(SecureRandom()))
    }

    @Test
    fun onlyWellFormedLabelsAreAccepted() {
        assertTrue(WebAddress.isLabel("sb-abcdefghijklmnopqrstuvwxyz"))
        listOf(
            "sb-abcdefghijklmnopqrstuvwxy",
            "sb-abcdefghijklmnopqrstuvwxyza",
            "sb-ABCDEFGHIJKLMNOPQRSTUVWXYZ",
            "sb-abcdefghijklmnopqrstuvwx18",
            "xx-abcdefghijklmnopqrstuvwxyz",
            "sb-abcdefghijklmnopqrstuvwx.z",
            "",
        ).forEach { assertFalse(it, WebAddress.isLabel(it)) }
    }

    @Test
    fun theOriginIsTheLabelUnderLocalhostOnTheSessionPort() {
        val address = WebAddress("sb-abcdefghijklmnopqrstuvwxyz")
        val session = LaunchSession(41_234, "ab".repeat(32))
        assertEquals("http://sb-abcdefghijklmnopqrstuvwxyz.localhost:41234", address.origin(session))
        assertEquals(AppOrigin("sb-abcdefghijklmnopqrstuvwxyz.localhost", 41_234), address.appOrigin(41_234))
        // The server's native address stays what native clients use.
        assertEquals("http://127.0.0.1:41234", session.origin)
        assertFalse(address.toString().contains("abcdefghijklmnopqrstuvwxyz"))
        assertEquals(address, WebAddress("sb-abcdefghijklmnopqrstuvwxyz"))
    }

    @Test
    fun redactionHidesEveryLabel() {
        val text = "Access from origin 'http://sb-abcdefghijklmnopqrstuvwxyz.localhost:41234' to " +
            "http://SB-AAAQEAYEAUDAOCAJBIFQYDIOB4.localhost:1/ blocked; sb-short stays"
        assertEquals(
            "Access from origin 'http://<label>.localhost:41234' to http://<label>.localhost:1/ blocked; sb-short stays",
            WebAddress.redact(text),
        )
    }

    @Test
    fun theLabelIsCreatedOnceAndKeptInPrivatePreferences() {
        val first = WebAddress.read(app)
        assertTrue(WebAddress.isLabel(first.label))
        assertEquals(first, WebAddress.read(app))
        val stored = app.getSharedPreferences("io.github.sillybunnyteam.sillybunny.web", Context.MODE_PRIVATE)
        assertEquals(first.label, stored.getString("origin_label", null))
        // A damaged value is replaced, not used as a host name.
        stored.edit().putString("origin_label", "Bad Label").commit()
        val replaced = WebAddress.read(app)
        assertNotEquals(first, replaced)
        assertEquals(replaced.label, stored.getString("origin_label", null))
    }

    @Test
    fun forInstallReadsOncePerProcess() {
        assertSame(WebAddress.forInstall(app), WebAddress.forInstall(app))
    }

    @Test(expected = IllegalArgumentException::class)
    fun rejectsABadLabel() {
        WebAddress("localhost")
    }
}
