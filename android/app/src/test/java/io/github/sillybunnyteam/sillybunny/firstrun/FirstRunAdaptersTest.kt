package io.github.sillybunnyteam.sillybunny.firstrun

import android.Manifest
import android.app.Application
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.PowerManager
import android.provider.Settings
import androidx.test.core.app.ApplicationProvider
import io.github.sillybunnyteam.sillybunny.BuildConfig
import io.github.sillybunnyteam.sillybunny.runtime.RuntimePaths
import io.github.sillybunnyteam.sillybunny.server.SetupJob
import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowNetworkCapabilities
import org.robolectric.shadows.ShadowStatFs

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [37])
class FirstRunAdaptersTest {
    @get:Rule
    val temporary = TemporaryFolder()

    private val application = ApplicationProvider.getApplicationContext<Application>()

    @Test
    fun storageComesFromStatFsOnFilesDir() {
        val directory = temporary.newFolder("files")
        ShadowStatFs.registerStats(directory, 1_000_000, 600_000, 500_000)
        assertEquals(500_000L * ShadowStatFs.BLOCK_SIZE, StatFsStorageProbe(directory).availableBytes())
    }

    @Test
    fun networksAreClassifiedByValidationTransportAndMeteredness() {
        fun capabilities(vararg capabilities: Int, transport: Int): NetworkCapabilities =
            ShadowNetworkCapabilities.newInstance().also { caps ->
                shadowOf(caps).addTransportType(transport)
                capabilities.forEach { shadowOf(caps).addCapability(it) }
            }
        val internet = NetworkCapabilities.NET_CAPABILITY_INTERNET
        val validated = NetworkCapabilities.NET_CAPABILITY_VALIDATED
        val notMetered = NetworkCapabilities.NET_CAPABILITY_NOT_METERED
        val wifi = NetworkCapabilities.TRANSPORT_WIFI
        val cellular = NetworkCapabilities.TRANSPORT_CELLULAR

        assertEquals(NetworkKind.UNMETERED, ConnectivityNetworkProbe.classify(capabilities(internet, validated, notMetered, transport = wifi)))
        assertEquals(NetworkKind.METERED, ConnectivityNetworkProbe.classify(capabilities(internet, validated, transport = wifi)))
        assertEquals(NetworkKind.CELLULAR, ConnectivityNetworkProbe.classify(capabilities(internet, validated, transport = cellular)))
        assertEquals(
            NetworkKind.CELLULAR,
            ConnectivityNetworkProbe.classify(capabilities(internet, validated, notMetered, transport = cellular)),
        )
        assertEquals(NetworkKind.NONE, ConnectivityNetworkProbe.classify(capabilities(internet, notMetered, transport = wifi)))
        assertEquals(NetworkKind.NONE, ConnectivityNetworkProbe.classify(capabilities(validated, notMetered, transport = wifi)))
    }

    @Test
    fun theActiveNetworkIsReadThroughConnectivityManager() {
        val manager = application.getSystemService(ConnectivityManager::class.java)
        val network = manager.activeNetwork!!
        val validatedWifi = ShadowNetworkCapabilities.newInstance().also {
            shadowOf(it).addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            shadowOf(it).addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            shadowOf(it).addCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
            shadowOf(it).addCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
        }
        shadowOf(manager).setNetworkCapabilities(network, validatedWifi)
        assertEquals(NetworkKind.UNMETERED, ConnectivityNetworkProbe(application).current())

        shadowOf(manager).setNetworkCapabilities(network, null)
        assertEquals(NetworkKind.NONE, ConnectivityNetworkProbe(application).current())

        shadowOf(manager).setDefaultNetworkActive(false)
        assertEquals(NetworkKind.NONE, ConnectivityNetworkProbe(application).current())
    }

    @Test
    @Config(sdk = [29])
    fun notificationsNeedNoRuntimePermissionOnApi29() {
        val permission = AndroidNotificationPermission(application)
        assertFalse(permission.required)
        assertTrue(permission.isGranted())
        assertNull(AndroidNotificationPermission.requestPermission())
    }

    @Test
    fun notificationsAreARuntimePermissionOnApi37() {
        val permission = AndroidNotificationPermission(application)
        assertTrue(permission.required)
        assertFalse(permission.isGranted())
        assertEquals(Manifest.permission.POST_NOTIFICATIONS, AndroidNotificationPermission.requestPermission())
        shadowOf(application).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
        assertTrue(permission.isGranted())
    }

    @Test
    fun theBatteryExemptionComesFromPowerManager() {
        val exemption = AndroidBatteryExemption(application)
        assertFalse(exemption.isExempt())
        shadowOf(application.getSystemService(PowerManager::class.java))
            .setIgnoringBatteryOptimizations(application.packageName, true)
        assertTrue(exemption.isExempt())
    }

    @Test
    fun theExemptionDialogComesFirstAndTheSettingsListIsTheFallback() {
        val request = BatteryExemptionIntents.request("pkg")
        assertEquals(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, request.action)
        assertEquals("package:pkg", request.dataString)
        assertEquals(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS, BatteryExemptionIntents.settingsList().action)

        val tried = mutableListOf<String?>()
        val dialog = BatteryExemptionIntents.launchFirst("pkg") { tried += it.action }
        assertEquals(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, dialog!!.action)
        assertEquals(listOf(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS), tried)

        tried.clear()
        val fallback = BatteryExemptionIntents.launchFirst("pkg") { intent: Intent ->
            tried += intent.action
            if (intent.action == Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS) throw ActivityNotFoundException()
        }
        assertEquals(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS, fallback!!.action)
        assertEquals(2, tried.size)

        assertNull(BatteryExemptionIntents.launchFirst("pkg") { throw ActivityNotFoundException() })
    }

    @Test
    fun theCheckoutInspectorNeverFollowsSymlinks() {
        val checkout = File(temporary.root, "SillyBunny")
        val inspector = FileCheckoutInspector(checkout)
        assertEquals(CheckoutStatus.ABSENT, inspector.status())

        checkout.mkdirs()
        assertEquals(CheckoutStatus.EMPTY, inspector.status())

        File(checkout, ".git").mkdirs()
        assertEquals(CheckoutStatus.PARTIAL, inspector.status())
        File(checkout, ".git/HEAD").writeText("ref: refs/heads/staging\n")
        assertEquals(CheckoutStatus.PARTIAL, inspector.status())
        File(checkout, "package.json").writeText("{}")
        assertEquals(CheckoutStatus.PARTIAL, inspector.status())
        File(checkout, ".git/index").writeText("DIRC")
        assertEquals(CheckoutStatus.INSTALLED, inspector.status())

        val link = File(temporary.root, "Linked")
        Files.createSymbolicLink(link.toPath(), checkout.toPath())
        assertEquals(CheckoutStatus.PARTIAL, FileCheckoutInspector(link).status())

        val file = temporary.newFile("plain")
        assertEquals(CheckoutStatus.PARTIAL, FileCheckoutInspector(file).status())

        val linkedGit = File(temporary.root, "LinkedGit").apply { mkdirs() }
        File(linkedGit, "package.json").writeText("{}")
        Files.createSymbolicLink(File(linkedGit, ".git").toPath(), File(checkout, ".git").toPath())
        assertEquals(CheckoutStatus.PARTIAL, FileCheckoutInspector(linkedGit).status())
    }

    @Test
    fun aCloneCountsAsInstalledOnlyOnceGitHasCommittedItsIndex() {
        val checkout = File(temporary.root, "SillyBunny")
        val inspector = FileCheckoutInspector(checkout)
        // Killed during the checkout: package.json is written, the index is still in index.lock.
        File(checkout, ".git").mkdirs()
        File(checkout, ".git/HEAD").writeText("ref: refs/heads/staging\n")
        File(checkout, ".git/index.lock").writeText("")
        File(checkout, "package.json").writeText("{}")
        assertEquals(CheckoutStatus.PARTIAL, inspector.status())

        // Only a regular file counts as the index.
        val index = File(checkout, ".git/index")
        index.mkdirs()
        assertEquals(CheckoutStatus.PARTIAL, inspector.status())
        assertTrue(index.delete())
        Files.createSymbolicLink(index.toPath(), temporary.newFile("index-elsewhere").toPath())
        assertEquals(CheckoutStatus.PARTIAL, inspector.status())
        assertTrue(index.delete())

        // git renames index.lock to index once the whole tree is written.
        assertTrue(File(checkout, ".git/index.lock").renameTo(index))
        assertEquals(CheckoutStatus.INSTALLED, inspector.status())

        // A stale lock beside a committed index is left by a later git command killed mid-way; the checkout
        // still runs, so it stays installed.
        File(checkout, ".git/index.lock").writeText("")
        assertEquals(CheckoutStatus.INSTALLED, inspector.status())
    }

    @Test
    fun theSetupLogIsABoundedTail() {
        val log = File(temporary.root, "setup.log")
        assertEquals(emptyList<String>(), SetupLogFileReader(log).read())

        log.writeText("one\ntwo\nthree\n")
        assertEquals(listOf("one", "two", "three"), SetupLogFileReader(log).read())
        assertEquals(listOf("two", "three"), SetupLogFileReader(log, maxLines = 2).read())
        // A window that starts mid-line drops that line; one that starts on a boundary keeps it.
        assertEquals(listOf("three"), SetupLogFileReader(log, maxBytes = 8).read())
        assertEquals(listOf("two", "three"), SetupLogFileReader(log, maxBytes = 10).read())
        assertEquals(listOf("one", "two", "three"), SetupLogFileReader(log, maxBytes = 14).read())
    }

    @Test
    fun theInstallJobMatchesOnlyFirstRunArguments() {
        val paths = RuntimePaths(File("/data/files"), File("/data/cache"), File("/data/lib"))
        val script = File("/data/files/runtime/install.sh")
        val job = FirstRunInstall.job(script, paths, "release")
        assertEquals(
            listOf(
                "--no-start", "--dir", "/data/files/SillyBunny", "--ref", "release", "--use-node",
                "--repo", BuildConfig.REPO_URL,
            ),
            job.args,
        )
        assertEquals(File("/data/files"), job.workingDir)
        assertTrue(FirstRunInstall.isFirstRunJob(SetupJob(File("/other"), job.args, File("/")), paths, "release"))
        assertFalse(FirstRunInstall.isFirstRunJob(job, paths, "staging"))
        val repair = SetupJob(
            script,
            job.args + listOf("--migrate-from", "/data/files/SillyBunny.broken-1", "--allow-git-source"),
            paths.filesDir,
        )
        assertFalse(FirstRunInstall.isFirstRunJob(repair, paths, "release"))
    }

    @Test
    fun theStorageThresholdIsTheMeasuredPeakPlusTheMargin() {
        assertEquals(873_276L, FirstRunStorage.MEASURED_PEAK_KIB)
        assertEquals(894_234_624L, FirstRunStorage.MEASURED_PEAK_BYTES)
        assertEquals(447_117_312L, FirstRunStorage.PEAK_MARGIN_BYTES)
        assertEquals(1_341_351_936L, FirstRunStorage.REQUIRED_FREE_BYTES)
    }

    @Test
    fun theDownloadEstimateAddsUp() {
        assertEquals(InstallDownloadEstimate.TOTAL_MAX_BYTES, InstallDownloadEstimate.CLONE_BYTES + InstallDownloadEstimate.NPM_CI_MAX_BYTES)
        assertTrue(InstallDownloadEstimate.TOTAL_MIN_BYTES <= InstallDownloadEstimate.CLONE_BYTES + InstallDownloadEstimate.NPM_CI_MIN_BYTES)
    }
}
