package io.github.sillybunnyteam.sillybunny.update

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class BlockedUpdateStatusTest {
    @get:Rule
    val temporaryFolder = TemporaryFolder()

    @Test
    fun missingStatusDoesNotRequireAnUpdate() {
        assertNull(BlockedUpdateStatus.read(temporaryFolder.root))
    }

    @Test
    fun preservesTheGateFieldsWithoutRequiringEveryField() {
        val status = BlockedUpdateStatus.parse(
            """{"required":7,"installed":1,"reason":"newer","upstream":"abc","branch":"staging"}""",
        )
        assertEquals(7L, status.requiredVersionCode)
        assertEquals(1L, status.installedVersionCode)
        assertEquals("newer", status.reason)
        assertEquals("abc", status.upstream)
        assertEquals("staging", status.branch)
        assertNull(BlockedUpdateStatus.parse("""{"required":null,"reason":"missing"}""").requiredVersionCode)
    }

    @Test
    fun malformedOrOversizedStatusStillRequiresThePrompt() {
        val statusFile = File(temporaryFolder.root, "status/update-blocked.json")
        statusFile.parentFile!!.mkdirs()
        listOf("", "[]", "null", "{", "x".repeat(65_537)).forEach {
            statusFile.writeText(it)
            assertNotNull(BlockedUpdateStatus.read(temporaryFolder.root))
            assertNull(BlockedUpdateStatus.read(temporaryFolder.root)!!.requiredVersionCode)
        }
        assertEquals(BlockedUpdateStatus(), BlockedUpdateStatus.parse(" ".repeat(65_537) + "{}"))
    }

    @Test
    fun ignoresWrongTypesAndUnknownReasonsInsteadOfCoercing() {
        val status = BlockedUpdateStatus.parse(
            """{"required":"7","installed":1.5,"reason":"unknown","upstream":12,"branch":false}""",
        )
        assertEquals(BlockedUpdateStatus(), status)
        assertNull(BlockedUpdateStatus.parse("""{"required":-1,"installed":0}""").requiredVersionCode)
        assertNull(BlockedUpdateStatus.parse("""{"installed":-0}""").installedVersionCode)
        assertEquals(0L, BlockedUpdateStatus.parse("""{"installed":0}""").installedVersionCode)
    }

    @Test
    fun unreadableStatusIsStillTreatedAsBlocked() {
        File(temporaryFolder.root, "status/update-blocked.json").mkdirs()
        assertEquals(BlockedUpdateStatus(), BlockedUpdateStatus.read(temporaryFolder.root))
    }

    @Test
    fun deeplyNestedStatusCannotOverflowTheParser() {
        val nested = "[".repeat(20_000) + "0" + "]".repeat(20_000)
        assertEquals(BlockedUpdateStatus(), BlockedUpdateStatus.parse("""{"required":$nested}"""))
    }
}
