package io.github.sillybunnyteam.sillybunny.web

import android.Manifest
import android.net.Uri
import android.webkit.PermissionRequest

/**
 * Web permission decisions (plan §4.5): grant only resources in [allowedResources], only when the
 * exact app origin asks, and only once the matching Android permission is held. Everything else is
 * denied. The shipped frontend uses no camera, microphone, MIDI or protected media (S2.7b), so the
 * default allowlist is empty.
 */
internal class WebPermissionPolicy(val allowedResources: Set<String> = emptySet()) {
    /** Requested resources this policy could grant, before Android permissions are considered. */
    fun candidates(requestOrigin: Uri?, app: AppOrigin, resources: Array<String>): List<String> {
        if (!WebNavigationPolicy.isAppUrl(requestOrigin, app)) return emptyList()
        return resources.filter { it in allowedResources }.distinct()
    }

    /** Android permissions that [candidates] still need, given [isGranted]. */
    fun missingAndroidPermissions(candidates: List<String>, isGranted: (String) -> Boolean): List<String> =
        candidates.mapNotNull(::androidPermissionFor).distinct().filterNot(isGranted)

    /** The subset of [candidates] whose Android permission (if any) is held. */
    fun grantable(candidates: List<String>, isGranted: (String) -> Boolean): List<String> =
        candidates.filter { resource -> androidPermissionFor(resource)?.let(isGranted) ?: true }

    companion object {
        val DEFAULT = WebPermissionPolicy()

        fun androidPermissionFor(resource: String): String? = when (resource) {
            PermissionRequest.RESOURCE_AUDIO_CAPTURE -> Manifest.permission.RECORD_AUDIO
            PermissionRequest.RESOURCE_VIDEO_CAPTURE -> Manifest.permission.CAMERA
            else -> null
        }
    }
}
