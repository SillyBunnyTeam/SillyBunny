package io.github.sillybunnyteam.sillybunny.server

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ListenerAnnouncementTest {
    private val port = 50_123

    @Test
    fun theServersPlainAndColoredAnnouncementsMatch() {
        // src/server-main.js: `${APP_NAME} is listening on` plus chalk-green " IPv6: <host>" and " IPv4: <host>".
        assertTrue(ListenerAnnouncement.matches("SillyBunny is listening on IPv4: 127.0.0.1:$port", port))
        assertTrue(ListenerAnnouncement.matches("SillyBunny is listening on IPv6: [::1]:$port IPv4: 127.0.0.1:$port", port))
        assertTrue(
            ListenerAnnouncement.matches(
                "SillyBunny is listening on\u001B[32m IPv6: [::1]:$port\u001B[39m\u001B[32m IPv4: 127.0.0.1:$port\u001B[39m",
                port,
            ),
        )
        assertTrue(ListenerAnnouncement.matches("SillyBunny is listening on IPv4: 127.0.0.1:$port\r", port))
    }

    @Test
    fun onlyTheSessionPortOnIPv4LoopbackCounts() {
        assertFalse(ListenerAnnouncement.matches("SillyBunny is listening on IPv6: [::1]:$port", port))
        assertFalse(ListenerAnnouncement.matches("SillyBunny is listening on IPv4: 127.0.0.1:${port + 1}", port))
        assertFalse(ListenerAnnouncement.matches("SillyBunny is listening on IPv4: 127.0.0.1:${port}0", port))
        assertFalse(ListenerAnnouncement.matches("SillyBunny is listening on IPv4: 127.0.0.1:5012", port))
        assertFalse(ListenerAnnouncement.matches("SillyBunny is listening on IPv4: 0.0.0.0:$port", port))
        assertFalse(ListenerAnnouncement.matches("SillyBunny is listening on IPv4: 127.0.0.10:$port", port))
        assertFalse(ListenerAnnouncement.matches("SillyBunny is listening on IPv4: 127.0.0.1:$port/", port))
    }

    @Test
    fun otherServerOutputNeverMatches() {
        assertFalse(ListenerAnnouncement.matches("127.0.0.1:$port is still in use; waiting for it to be released (attempt 1 of 30).", port))
        assertFalse(ListenerAnnouncement.matches("Warning: failed to start server on IPv4", port))
        assertFalse(ListenerAnnouncement.matches("Go to: http://127.0.0.1:$port/ to open SillyBunny", port))
        assertFalse(ListenerAnnouncement.matches("IPv4: 127.0.0.1:$port", port))
        assertFalse(ListenerAnnouncement.matches("", port))
    }
}
