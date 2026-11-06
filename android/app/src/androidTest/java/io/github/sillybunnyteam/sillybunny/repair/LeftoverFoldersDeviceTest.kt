package io.github.sillybunnyteam.sillybunny.repair

import android.content.Context
import android.os.Build
import android.system.Os
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import io.github.sillybunnyteam.sillybunny.checkout.BrokenCheckouts
import io.github.sillybunnyteam.sillybunny.runtime.RuntimePaths
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.SecureDirectoryStream
import java.time.Instant
import java.util.concurrent.atomic.AtomicInteger

/**
 * Leftover folders on the device filesystem (plan §4.6): listing, the separate delete screen, the confirmation
 * naming the folder, and a deletion that never follows a link out of the folder. Run it on a dedicated
 * installation: it asserts that no checkout and no moved-aside folder exist, and removes what it creates.
 */
@RunWith(AndroidJUnit4::class)
class LeftoverFoldersDeviceTest {
    private val context: Context = InstrumentationRegistry.getInstrumentation().targetContext
    private val paths = RuntimePaths(context)
    private val closes = AtomicInteger()
    private lateinit var store: RepairStore
    private lateinit var outside: File
    private var screen: ScreenHost? = null
    private var owned = false

    @Before
    fun setUp() {
        assertFalse("Run this suite on a dedicated installation without a checkout", exists(paths.checkoutDir))
        assertTrue("Run this suite on a dedicated installation without leftover folders", BrokenCheckouts.list(paths).isEmpty())
        owned = true
        store = RepairStore(File(context.noBackupFilesDir, "p59-device-record.json")).also { it.clear() }
        outside = File(context.filesDir, "p59-outside")
        deleteTree(outside.toPath())
        assertTrue(outside.mkdirs())
    }

    @After
    fun tearDown() {
        if (!owned) return
        try {
            screen?.close()
        } finally {
            BrokenCheckouts.list(paths).forEach { deleteTree(it.toPath()) }
            deleteTree(outside.toPath())
            store.clear()
            owned = false
        }
    }

    /** The size walk and the deletion refuse to run without these; this release must offer them. */
    @Test
    fun theFilesDirectoryOffersNoFollowDirectoryStreams() {
        Files.newDirectoryStream(context.filesDir.toPath()).use { stream ->
            Log.i(TAG, "sdk=${Build.VERSION.SDK_INT} directory stream=${stream.javaClass.name}")
            assertTrue(stream is SecureDirectoryStream<*>)
        }
    }

    @Test
    fun aConfirmedDeletionRemovesOnlyTheNamedFolderAndNeverALinkTarget() {
        val name = "SillyBunny.broken-20261022T101500Z"
        val folder = leftover(name)
        val outsideFile = File(outside, "keep.txt").apply { writeText("outside data") }
        val outsideDir = File(outside, "dir").apply { assertTrue(mkdirs()) }
        File(outsideDir, "big.bin").writeBytes(ByteArray(OUTSIDE_BYTES))
        Os.symlink(outsideFile.path, File(folder, "file-link").path)
        Os.symlink(outsideDir.path, File(folder, "dir-link").path)
        val kept = leftover("SillyBunny.broken-20261021T080000Z")
        store.save(RepairRecord(RepairPhase.FAILED, Instant.now(), source = kept.name, ref = "release"))
        val folders = LeftoverFolders(paths, store)
        // Four entries below the folder plus two links, counted but never followed or sized.
        assertEquals(FolderSize(USER_DATA_BYTES, 6, approximate = false), folders.measure(name))

        screen = ScreenHost { LeftoverFoldersScreen(folders, onClose = { closes.incrementAndGet() }) }.launch()
        assertTrue(RepairUi.shown(RepairTags.leftoverItem(kept.name)))
        RepairUi.click(RepairTags.leftoverItem(name))
        assertTrue(RepairUi.shown(RepairTags.LEFTOVER_DELETE_SCREEN))
        assertEquals(name, RepairUi.find(RepairTags.LEFTOVER_DELETE_NAME).text)
        assertTrue(RepairUi.shown(RepairTags.leftoverMovedAt(name)))
        assertTrue(RepairUi.shown(RepairTags.leftoverSize(name)))
        // Opening the folder deletes nothing, and neither does dismissing the confirmation.
        RepairUi.click(RepairTags.LEFTOVER_DELETE)
        assertTrue(RepairUi.shown(RepairTags.LEFTOVER_DELETE_DIALOG))
        assertEquals(name, RepairUi.find(RepairTags.LEFTOVER_DELETE_DIALOG_NAME).text)
        RepairUi.click(RepairTags.LEFTOVER_DELETE_DISMISS)
        assertTrue(RepairUi.gone(RepairTags.LEFTOVER_DELETE_DIALOG))
        assertTrue(File(folder, DeviceCheckouts.CHAT).isFile)

        RepairUi.click(RepairTags.LEFTOVER_DELETE)
        RepairUi.click(RepairTags.LEFTOVER_DELETE_CONFIRM)
        assertTrue(RepairUi.shown(RepairTags.LEFTOVER_DELETED, SLOW_STEP_MILLIS))
        assertFalse(exists(folder))
        assertEquals("outside data", outsideFile.readText())
        assertEquals(OUTSIDE_BYTES.toLong(), File(outsideDir, "big.bin").length())
        assertEquals(listOf(kept), BrokenCheckouts.list(paths))

        // The list no longer has it; the folder an unfinished Repair migrates from offers no deletion.
        RepairUi.click(RepairTags.LEFTOVER_BACK)
        assertTrue(RepairUi.shown(RepairTags.LEFTOVER_LIST))
        assertTrue(RepairUi.gone(RepairTags.leftoverItem(name)))
        RepairUi.click(RepairTags.leftoverItem(kept.name))
        assertTrue(RepairUi.shown(RepairTags.leftoverProtection(kept.name)))
        assertFalse(RepairUi.present(RepairTags.LEFTOVER_DELETE))
        assertEquals(DeleteRefusal.REPAIR_SOURCE, folders.refusal(kept.name))
        assertEquals("user data", File(kept, DeviceCheckouts.CHAT).readText())
        assertEquals(0, closes.get())
    }

    @Test
    fun anUnreadableSubfolderIsReportedAndLeftInPlace() {
        val name = "SillyBunny.broken-20261020T090000Z"
        val folder = leftover(name)
        val locked = File(folder, "data/default-user")
        Os.chmod(locked.path, 0)
        val folders = LeftoverFolders(paths, store)
        // The walk counts the locked folder but cannot read it, so the size is a lower bound.
        assertEquals(FolderSize(0, 2, approximate = true), folders.measure(name))

        screen = ScreenHost { LeftoverFoldersScreen(folders, onClose = { closes.incrementAndGet() }) }.launch()
        RepairUi.click(RepairTags.leftoverItem(name))
        assertTrue(RepairUi.shown(RepairTags.leftoverApproximate(name)))
        RepairUi.click(RepairTags.LEFTOVER_DELETE)
        RepairUi.click(RepairTags.LEFTOVER_DELETE_CONFIRM)
        assertTrue(RepairUi.shown(RepairTags.LEFTOVER_PARTIAL, SLOW_STEP_MILLIS))
        // The locked folder, then its parent and the folder itself, which are not empty.
        assertTrue(RepairUi.find(RepairTags.LEFTOVER_REMOVED).hasObject(By.text("0")))
        assertTrue(RepairUi.find(RepairTags.LEFTOVER_REMAINING).hasObject(By.text("3")))
        assertEquals(listOf("data/default-user", "data", "."), RepairUi.find(RepairTags.LEFTOVER_EXAMPLES).text.lines())
        // Nothing was made accessible to force the deletion: the locked folder and its contents stay.
        assertEquals(0, Os.lstat(locked.path).st_mode and "777".toInt(8))
        Os.chmod(locked.path, "700".toInt(8))
        assertEquals("user data", File(folder, DeviceCheckouts.CHAT).readText())
    }

    private fun leftover(name: String): File {
        val folder = File(context.filesDir, name)
        DeviceCheckouts.create(folder, tracking = "release")
        // Only the user's data: the size walk then has a known total.
        listOf("package.json", "config.yaml", "scripts", ".git").forEach { deleteTree(File(folder, it).toPath()) }
        return folder
    }

    private fun exists(file: File) = Files.exists(file.toPath(), LinkOption.NOFOLLOW_LINKS)

    private companion object {
        const val TAG = "LeftoverFoldersDevice"
        const val USER_DATA_BYTES = 9L
        const val OUTSIDE_BYTES = 64 * 1024
    }
}
