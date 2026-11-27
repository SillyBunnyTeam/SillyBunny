package io.github.sillybunnyteam.sillybunny.runtime

import android.content.Context
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.content.res.AssetManager
import android.os.Build
import java.io.IOException
import java.io.InputStream

/** Where the layout installer reads the installed APK's identity and its runtime payload. */
interface RuntimeSource {
    val versionCode: Long
    val lastUpdateTime: Long

    /** Opens an APK asset; a missing asset throws [java.io.FileNotFoundException]. */
    @Throws(IOException::class)
    fun open(path: String): InputStream
}

/** The running APK: its package record and its assets. */
internal class AndroidRuntimeSource(private val context: Context) : RuntimeSource {
    private val packageInfo: PackageInfo = context.packageManager.let { manager ->
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            manager.getPackageInfo(context.packageName, PackageManager.PackageInfoFlags.of(0))
        } else {
            @Suppress("DEPRECATION")
            manager.getPackageInfo(context.packageName, 0)
        }
    }

    override val versionCode: Long get() = packageInfo.longVersionCode

    override val lastUpdateTime: Long get() = packageInfo.lastUpdateTime

    override fun open(path: String): InputStream = context.assets.open(path, AssetManager.ACCESS_STREAMING)
}
