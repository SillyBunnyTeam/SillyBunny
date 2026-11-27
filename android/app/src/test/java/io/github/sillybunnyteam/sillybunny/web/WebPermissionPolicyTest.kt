package io.github.sillybunnyteam.sillybunny.web

import android.Manifest
import android.net.Uri
import android.webkit.PermissionRequest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [37])
class WebPermissionPolicyTest {
    private val host = "sb-abcdefghijklmnopqrstuvwxyz.localhost"
    private val origin = AppOrigin(host, 41_234)
    private val app = Uri.parse("http://$host:41234/")
    private val everything = arrayOf(
        PermissionRequest.RESOURCE_AUDIO_CAPTURE,
        PermissionRequest.RESOURCE_VIDEO_CAPTURE,
        PermissionRequest.RESOURCE_MIDI_SYSEX,
        PermissionRequest.RESOURCE_PROTECTED_MEDIA_ID,
    )

    @Test
    fun theShippedPolicyGrantsNothing() {
        assertTrue(WebPermissionPolicy.DEFAULT.candidates(app, origin, everything).isEmpty())
    }

    @Test
    fun onlyAllowedResourcesRequestedByTheAppOriginAreCandidates() {
        val policy = WebPermissionPolicy(
            setOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE, PermissionRequest.RESOURCE_PROTECTED_MEDIA_ID),
        )
        assertEquals(
            listOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE, PermissionRequest.RESOURCE_PROTECTED_MEDIA_ID),
            policy.candidates(app, origin, everything + PermissionRequest.RESOURCE_AUDIO_CAPTURE),
        )
        listOf(
            "http://$host:41235/",
            "https://$host:41234/",
            "http://127.0.0.1:41234/",
            "http://localhost:41234/",
            "https://openrouter.ai/",
            "https://example.com/",
            "null",
        ).forEach { assertTrue(it, policy.candidates(Uri.parse(it), origin, everything).isEmpty()) }
        assertTrue(policy.candidates(null, origin, everything).isEmpty())
    }

    @Test
    fun androidPermissionsGateTheResourcesThatNeedThem() {
        val policy = WebPermissionPolicy(everything.toSet())
        val candidates = everything.toList()
        val nothingHeld = { _: String -> false }
        assertEquals(
            listOf(Manifest.permission.RECORD_AUDIO, Manifest.permission.CAMERA),
            policy.missingAndroidPermissions(candidates, nothingHeld),
        )
        assertEquals(
            listOf(PermissionRequest.RESOURCE_MIDI_SYSEX, PermissionRequest.RESOURCE_PROTECTED_MEDIA_ID),
            policy.grantable(candidates, nothingHeld),
        )
        val microphoneOnly = { permission: String -> permission == Manifest.permission.RECORD_AUDIO }
        assertEquals(listOf(Manifest.permission.CAMERA), policy.missingAndroidPermissions(candidates, microphoneOnly))
        assertEquals(
            listOf(
                PermissionRequest.RESOURCE_AUDIO_CAPTURE,
                PermissionRequest.RESOURCE_MIDI_SYSEX,
                PermissionRequest.RESOURCE_PROTECTED_MEDIA_ID,
            ),
            policy.grantable(candidates, microphoneOnly),
        )
    }
}
