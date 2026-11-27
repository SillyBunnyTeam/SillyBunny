package io.github.sillybunnyteam.sillybunny.web.files

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Process

/**
 * Checks SAF results before the page or a save uses them (plan §4.5).
 *
 * Picker results are untrusted. When a result carries URI grants, the system verifies that the
 * picker may grant them, except for URIs this app can already open by itself: its own providers
 * and `file:` paths. Those are exactly what a hostile picker could use to expose app-private data,
 * so only `content:` URIs outside this app's providers are accepted. Being able to open a URI is not
 * enough: the result must carry the read (and, where needed, write) grant, and the system must
 * report that grant as held. No URI is converted to a path.
 */
internal class ContentUriPolicy(
    private val context: Context,
    ownAuthorities: () -> Set<String> = { declaredAuthorities(context) },
    private val holdsGrant: (Uri, Int) -> Boolean = { uri, flags ->
        context.checkUriPermission(uri, Process.myPid(), Process.myUid(), flags) ==
            PackageManager.PERMISSION_GRANTED
    },
) {
    private val authorities by lazy(LazyThreadSafetyMode.NONE, ownAuthorities)

    /** True for a `content:` URI that does not point into one of this app's own providers. */
    fun isForeignContent(uri: Uri): Boolean {
        if (!"content".equals(uri.scheme, ignoreCase = true)) return false
        // The host drops a cross-user "10@" prefix and any port from the authority.
        val host = uri.host?.trim().orEmpty()
        return host.isNotEmpty() && !isOwnAuthority(host)
    }

    fun isOwnAuthority(host: String): Boolean {
        val packageName = context.packageName
        return host.equals(packageName, ignoreCase = true) ||
            host.startsWith("$packageName.", ignoreCase = true) ||
            authorities.any { it.equals(host, ignoreCase = true) }
    }

    /** True when the result [flags] grant [needed] and this app now holds that access to [uri]. */
    fun hasGrant(uri: Uri, flags: Int, needed: Int): Boolean =
        flags and needed == needed && holdsGrant(uri, needed)

    companion object {
        const val READ = Intent.FLAG_GRANT_READ_URI_PERMISSION
        const val WRITE = Intent.FLAG_GRANT_WRITE_URI_PERMISSION

        fun declaredAuthorities(context: Context): Set<String> {
            val manager = context.packageManager
            val info = try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    manager.getPackageInfo(
                        context.packageName,
                        PackageManager.PackageInfoFlags.of(PackageManager.GET_PROVIDERS.toLong()),
                    )
                } else {
                    @Suppress("DEPRECATION")
                    manager.getPackageInfo(context.packageName, PackageManager.GET_PROVIDERS)
                }
            } catch (_: PackageManager.NameNotFoundException) {
                return emptySet()
            }
            return info.providers.orEmpty()
                .flatMap { it.authority.orEmpty().split(';') }
                .map { it.trim() }
                .filter { it.isNotEmpty() }
                .toSet()
        }
    }
}
