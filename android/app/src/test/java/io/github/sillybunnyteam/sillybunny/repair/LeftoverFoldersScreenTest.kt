package io.github.sillybunnyteam.sillybunny.repair

import androidx.activity.ComponentActivity
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import io.github.sillybunnyteam.sillybunny.runtime.RuntimePaths
import kotlinx.coroutines.Dispatchers
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File
import java.nio.file.Files
import java.nio.file.LinkOption

/**
 * The leftover-folder list and its separate, confirmed deletion screen (plan §4.6). Nodes are found by test tag
 * only; the one text check is the folder name the confirmation must show, which is data, not copy.
 */
// API 37 is not here: the Espresso 3.5.0 that Compose UI tests bring fails on it (InputManager.getInstance).
// The device suite covers API 37 with UiAutomator instead.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29, 36])
class LeftoverFoldersScreenTest {
    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>()

    @get:Rule
    val temporary = TemporaryFolder()

    private var state by mutableStateOf(LeftoverState())
    private val deletes = mutableListOf<String>()
    private var clears = 0
    private var closes = 0

    private val older = leftover("SillyBunny.broken-20261020T101010Z")
    private val newer = leftover("SillyBunny.broken-20261021T070001Z-2")
    private val guarded = leftover("SillyBunny.broken-20261021T080000Z", DeleteRefusal.REPAIR_SOURCE)

    private fun leftover(name: String, protection: DeleteRefusal? = null) =
        LeftoverFolder(name, File("/data/user/0/app/files", name), movedAsideAt(name), protection)

    private fun show() {
        compose.setContent {
            RepairTheme {
                LeftoverFoldersContent(
                    state = state,
                    onDelete = { deletes += it },
                    onClearOutcome = { clears++ },
                    onClose = { closes++ },
                )
            }
        }
        compose.waitForIdle()
    }

    private fun exists(tag: String): Boolean {
        compose.waitForIdle()
        // Clickable rows merge their children, so tagged details live in the unmerged tree.
        return compose.onAllNodesWithTag(tag, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
    }

    private fun click(tag: String) {
        compose.onNodeWithTag(tag).performScrollTo().performClick()
        compose.waitForIdle()
    }

    private fun clickInDialog(tag: String) {
        compose.onNodeWithTag(tag).performClick()
        compose.waitForIdle()
    }

    private fun back() {
        // The handler must see the latest state, so let it compose first.
        compose.waitForIdle()
        compose.runOnUiThread { compose.activity.onBackPressedDispatcher.onBackPressed() }
        compose.waitForIdle()
    }

    @Test
    fun theListLoadsThenShowsEmptyAndLeaves() {
        show()
        assertTrue(exists(RepairTags.LEFTOVER_LIST))
        assertTrue(exists(RepairTags.LEFTOVER_LOADING))
        state = LeftoverState(loading = false)
        assertFalse(exists(RepairTags.LEFTOVER_LOADING))
        assertTrue(exists(RepairTags.LEFTOVER_EMPTY))
        click(RepairTags.LEFTOVER_CLOSE)
        back()
        assertEquals(2, closes)
        assertTrue(deletes.isEmpty())
    }

    @Test
    fun eachFolderShowsItsNameDateSizeAndProtection() {
        state = LeftoverState(
            loading = false,
            folders = listOf(older, newer, guarded),
            sizes = mapOf(
                older.name to FolderSize(1_048_576, 12, approximate = false),
                guarded.name to FolderSize(4_096, 200_000, approximate = true),
            ),
        )
        show()
        for (folder in listOf(older, newer, guarded)) {
            assertTrue(folder.name, exists(RepairTags.leftoverItem(folder.name)))
            assertTrue(folder.name, exists(RepairTags.leftoverMovedAt(folder.name)))
        }
        assertTrue(exists(RepairTags.leftoverSize(older.name)))
        assertFalse(exists(RepairTags.leftoverApproximate(older.name)))
        assertTrue(exists(RepairTags.leftoverMeasuring(newer.name)))
        assertTrue(exists(RepairTags.leftoverApproximate(guarded.name)))
        assertTrue(exists(RepairTags.leftoverProtection(guarded.name)))
        assertFalse(exists(RepairTags.leftoverProtection(older.name)))
        // A name without a readable timestamp still lists, without a date.
        val undated = LeftoverFolder("SillyBunny.broken-20261399T000000Z", File("/x"), null, null)
        state = state.copy(folders = listOf(undated))
        assertTrue(exists(RepairTags.leftoverItem(undated.name)))
        assertFalse(exists(RepairTags.leftoverMovedAt(undated.name)))
        // Nothing on the list deletes anything.
        assertFalse(exists(RepairTags.LEFTOVER_DELETE))
        assertTrue(deletes.isEmpty())
    }

    @Test
    fun deletingTakesASeparateScreenAndAConfirmationNamingTheFolder() {
        state = LeftoverState(loading = false, folders = listOf(older, newer), sizes = mapOf(older.name to FolderSize(10, 1, false)))
        show()
        click(RepairTags.leftoverItem(older.name))
        assertTrue(exists(RepairTags.LEFTOVER_DELETE_SCREEN))
        assertFalse(exists(RepairTags.LEFTOVER_LIST))
        compose.onNodeWithTag(RepairTags.LEFTOVER_DELETE_NAME).assertTextEquals(older.name)
        assertTrue(exists(RepairTags.leftoverSize(older.name)))
        assertTrue(deletes.isEmpty())

        click(RepairTags.LEFTOVER_DELETE)
        assertTrue(exists(RepairTags.LEFTOVER_DELETE_DIALOG))
        compose.onNodeWithTag(RepairTags.LEFTOVER_DELETE_DIALOG_NAME).assertTextEquals(older.name)
        assertTrue(deletes.isEmpty())
        clickInDialog(RepairTags.LEFTOVER_DELETE_DISMISS)
        assertFalse(exists(RepairTags.LEFTOVER_DELETE_DIALOG))
        assertTrue(deletes.isEmpty())

        click(RepairTags.LEFTOVER_DELETE)
        clickInDialog(RepairTags.LEFTOVER_DELETE_CONFIRM)
        assertEquals(listOf(older.name), deletes)
        assertFalse(exists(RepairTags.LEFTOVER_DELETE_DIALOG))

        // While it runs: no second delete, and neither back nor the back action leaves.
        state = state.copy(deleting = older.name)
        assertTrue(exists(RepairTags.LEFTOVER_DELETING))
        assertFalse(exists(RepairTags.LEFTOVER_DELETE))
        compose.onNodeWithTag(RepairTags.LEFTOVER_BACK).assertIsNotEnabled()
        back()
        assertTrue(exists(RepairTags.LEFTOVER_DELETE_SCREEN))

        state = state.copy(
            deleting = null,
            folders = listOf(newer),
            lastOutcome = DeleteOutcome(older.name, DeleteResult.Deleted(13)),
        )
        assertTrue(exists(RepairTags.LEFTOVER_DELETED))
        assertFalse(exists(RepairTags.LEFTOVER_DELETE))
        assertFalse(exists(RepairTags.deleteRefusal(DeleteRefusal.NOT_A_LEFTOVER)))
        back()
        assertTrue(exists(RepairTags.LEFTOVER_LIST))
        assertEquals(1, clears)
        assertEquals(0, closes)
        assertEquals(listOf(older.name), deletes)
    }

    @Test
    fun aProtectedOrVanishedFolderCannotBeDeleted() {
        state = LeftoverState(loading = false, folders = listOf(guarded, older))
        show()
        click(RepairTags.leftoverItem(guarded.name))
        assertTrue(exists(RepairTags.LEFTOVER_DELETE_SCREEN))
        assertTrue(exists(RepairTags.leftoverProtection(guarded.name)))
        assertFalse(exists(RepairTags.LEFTOVER_DELETE))
        click(RepairTags.LEFTOVER_BACK)
        assertTrue(exists(RepairTags.LEFTOVER_LIST))

        click(RepairTags.leftoverItem(older.name))
        state = state.copy(folders = listOf(guarded))
        assertTrue(exists(RepairTags.deleteRefusal(DeleteRefusal.NOT_A_LEFTOVER)))
        assertFalse(exists(RepairTags.LEFTOVER_DELETE))
        assertTrue(deletes.isEmpty())
        for (reason in DeleteRefusal.entries) {
            state = state.copy(folders = listOf(leftover(older.name, reason)))
            assertTrue(reason.name, exists(RepairTags.leftoverProtection(older.name)))
            assertFalse(reason.name, exists(RepairTags.LEFTOVER_DELETE))
        }
    }

    @Test
    fun partialAndRefusedDeletionsAreReported() {
        state = LeftoverState(
            loading = false,
            folders = listOf(older),
            lastOutcome = DeleteOutcome(older.name, DeleteResult.Partial(5, 2, listOf("locked", "."))),
        )
        show()
        click(RepairTags.leftoverItem(older.name))
        for (tag in listOf(
            RepairTags.LEFTOVER_PARTIAL,
            RepairTags.LEFTOVER_REMOVED,
            RepairTags.LEFTOVER_REMAINING,
            RepairTags.LEFTOVER_EXAMPLES,
        )) {
            assertTrue(tag, exists(tag))
        }
        // An outcome is shown once; no immediate second attempt from the same screen.
        assertFalse(exists(RepairTags.LEFTOVER_DELETE))
        for (reason in DeleteRefusal.entries) {
            state = state.copy(lastOutcome = DeleteOutcome(older.name, DeleteResult.Refused(reason)))
            assertTrue(reason.name, exists(RepairTags.deleteRefusal(reason)))
        }
        // Another folder's outcome is not shown here.
        state = state.copy(lastOutcome = DeleteOutcome(newer.name, DeleteResult.Deleted(1)))
        assertFalse(exists(RepairTags.LEFTOVER_DELETED))
        assertTrue(exists(RepairTags.LEFTOVER_DELETE))
    }

    @Test
    fun theScreenListsMeasuresAndDeletesRealFoldersOnlyAfterConfirmation() {
        val paths = RuntimePaths(
            File(temporary.root, "files").apply { mkdirs() },
            File(temporary.root, "cache").apply { mkdirs() },
            File(temporary.root, "lib"),
        )
        TestCheckouts.create(paths.checkoutDir, config = "dataRoot: ./data\n")
        val outside = File(temporary.root, "outside.txt").apply { writeText("keep me") }
        val target = File(paths.filesDir, "SillyBunny.broken-20261020T000000Z")
        File(target, "data/default-user").mkdirs()
        File(target, "data/default-user/settings.json").writeText("{}")
        Files.createSymbolicLink(File(target, "link-out").toPath(), outside.toPath())
        val kept = File(paths.filesDir, "SillyBunny.broken-20261021T000000Z").apply { mkdirs() }
        val folders = LeftoverFolders(paths, RepairStore(File(temporary.root, "no_backup/repair-record.json")), Dispatchers.Unconfined)
        var leaves = 0
        compose.setContent { LeftoverFoldersScreen(folders, onClose = { leaves++ }) }

        assertTrue(exists(RepairTags.leftoverItem(target.name)))
        assertTrue(exists(RepairTags.leftoverItem(kept.name)))
        assertTrue(exists(RepairTags.leftoverSize(target.name)))
        assertEquals(FolderSize(2, 4, approximate = false), folders.state.value.sizes[target.name])
        assertTrue(target.isDirectory)

        click(RepairTags.leftoverItem(target.name))
        click(RepairTags.LEFTOVER_DELETE)
        assertTrue(target.isDirectory)
        clickInDialog(RepairTags.LEFTOVER_DELETE_CONFIRM)
        assertTrue(exists(RepairTags.LEFTOVER_DELETED))
        assertFalse(Files.exists(target.toPath(), LinkOption.NOFOLLOW_LINKS))
        assertEquals("keep me", outside.readText())
        assertTrue(kept.isDirectory)
        assertEquals(listOf(kept.name), folders.state.value.folders.map { it.name })

        back()
        assertTrue(exists(RepairTags.LEFTOVER_LIST))
        assertFalse(exists(RepairTags.leftoverItem(target.name)))
        back()
        assertEquals(1, leaves)
    }
}
