package io.github.sillybunnyteam.sillybunny.firstrun

import android.Manifest
import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.os.StatFs
import android.provider.Settings
import androidx.core.content.ContextCompat
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.nio.file.Files
import java.nio.file.LinkOption

/** `POST_NOTIFICATIONS` through `checkSelfPermission`; not a runtime permission below API 33. */
class AndroidNotificationPermission(context: Context) : NotificationPermission {
    private val context = context.applicationContext

    override val required: Boolean
        get() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU

    override fun isGranted(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true
        return ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
    }

    companion object {
        /** The permission to request, or null where none is needed. */
        fun requestPermission(): String? =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) Manifest.permission.POST_NOTIFICATIONS else null
    }
}

class AndroidBatteryExemption(context: Context) : BatteryExemption {
    private val context = context.applicationContext

    override fun isExempt(): Boolean =
        context.getSystemService(PowerManager::class.java)?.isIgnoringBatteryOptimizations(context.packageName) == true
}

/**
 * The battery-exemption screens, in the order to try them: the system dialog for
 * `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` (the permission is in the manifest), then the settings list.
 */
object BatteryExemptionIntents {
    // BatteryLife is a Play policy check. The APK is sideloaded, not on Play, and the exemption stays optional
    // and never forced (plan §4.2, §4.3 step 1).
    @SuppressLint("BatteryLife")
    fun request(packageName: String): Intent =
        Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.fromParts("package", packageName, null))

    fun settingsList(): Intent = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)

    fun candidates(packageName: String): List<Intent> = listOf(request(packageName), settingsList())

    /**
     * Launches the first candidate that resolves and returns it, or null when none does. Resolution is
     * decided by the launch itself (`ActivityNotFoundException`), so package-visibility filtering cannot
     * hide an available screen.
     */
    fun launchFirst(packageName: String, launch: (Intent) -> Unit): Intent? {
        for (intent in candidates(packageName)) {
            try {
                launch(intent)
                return intent
            } catch (_: ActivityNotFoundException) {
                // Try the next screen.
            }
        }
        return null
    }
}

/** `StatFs` on the directory that holds `filesDir`. */
class StatFsStorageProbe(private val directory: File) : StorageProbe {
    override fun availableBytes(): Long = StatFs(directory.path).availableBytes
}

/** The default network through `ConnectivityManager` and `NetworkCapabilities`. */
class ConnectivityNetworkProbe(context: Context) : NetworkProbe {
    private val context = context.applicationContext

    override fun current(): NetworkKind {
        val manager = context.getSystemService(ConnectivityManager::class.java) ?: return NetworkKind.NONE
        val network = manager.activeNetwork ?: return NetworkKind.NONE
        val capabilities = manager.getNetworkCapabilities(network) ?: return NetworkKind.NONE
        return classify(capabilities)
    }

    companion object {
        fun classify(capabilities: NetworkCapabilities): NetworkKind = when {
            !capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) ||
                !capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) -> NetworkKind.NONE
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> NetworkKind.CELLULAR
            capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) -> NetworkKind.UNMETERED
            else -> NetworkKind.METERED
        }
    }
}

/**
 * Reads `checkoutDir` with `NOFOLLOW_LINKS`, so a symlink there is reported, never followed.
 *
 * INSTALLED needs a regular `.git/index`. `git clone` writes `.git/HEAD` first and files in index order, and
 * commits `.git/index` (renaming `.git/index.lock`) only once the whole tree is written, so a clone killed at
 * any point before that has no index, even when `package.json` is already there. `install.sh --no-start`
 * runs no index-writing git command after the clone, so a committed index means the install finished.
 *
 * A `.git/index.lock` next to a committed index is not checked: only a later git command killed mid-way
 * (such as a self-update) leaves one, and that checkout still runs.
 */
class FileCheckoutInspector(private val checkoutDir: File) : CheckoutInspector {
    override fun status(): CheckoutStatus {
        val path = checkoutDir.toPath()
        if (!Files.exists(path, LinkOption.NOFOLLOW_LINKS)) return CheckoutStatus.ABSENT
        if (!Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS)) return CheckoutStatus.PARTIAL
        val empty = try {
            Files.newDirectoryStream(path).use { !it.iterator().hasNext() }
        } catch (_: IOException) {
            return CheckoutStatus.PARTIAL
        }
        if (empty) return CheckoutStatus.EMPTY
        val git = path.resolve(".git")
        val installed = Files.isDirectory(git, LinkOption.NOFOLLOW_LINKS) &&
            Files.isRegularFile(git.resolve("HEAD"), LinkOption.NOFOLLOW_LINKS) &&
            Files.isRegularFile(git.resolve("index"), LinkOption.NOFOLLOW_LINKS) &&
            Files.isRegularFile(path.resolve("package.json"), LinkOption.NOFOLLOW_LINKS)
        return if (installed) CheckoutStatus.INSTALLED else CheckoutStatus.PARTIAL
    }
}

/** The tail of one log file: at most [maxBytes] from its end, then at most [maxLines] lines. */
class SetupLogFileReader(
    private val file: File,
    private val maxBytes: Int = 256 * 1_024,
    private val maxLines: Int = 2_000,
) : SetupLogReader {
    override fun read(): List<String> {
        if (!file.isFile) return emptyList()
        val text = RandomAccessFile(file, "r").use { input ->
            val length = input.length()
            // One byte before the window shows whether the window starts on a line boundary.
            val start = (length - maxBytes - 1).coerceAtLeast(0)
            val bytes = ByteArray((length - start).toInt())
            input.seek(start)
            input.readFully(bytes)
            val decoded = String(bytes, Charsets.UTF_8)
            // A cut-off first line is dropped rather than shown half.
            if (start > 0) decoded.substringAfter('\n', "") else decoded
        }
        return text.lines().dropLastWhile { it.isEmpty() }.takeLast(maxLines)
    }
}
