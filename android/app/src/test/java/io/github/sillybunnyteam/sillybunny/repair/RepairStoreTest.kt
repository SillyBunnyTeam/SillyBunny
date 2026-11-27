package io.github.sillybunnyteam.sillybunny.repair

import java.io.File
import java.io.IOException
import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The persisted Repair record: its format, atomic replacement and refusal of anything it cannot trust. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [37])
class RepairStoreTest {
    @get:Rule
    val temporary = TemporaryFolder()

    private val file by lazy { File(temporary.root, "no_backup/repair-record.json") }
    private val store by lazy { RepairStore(file) }

    @Test
    fun noRecordLoadsAsNull() {
        assertNull(store.load())
        store.clear()
        assertNull(store.load())
    }

    @Test
    fun everyFieldSurvivesARoundTrip() {
        val record = RepairRecord(
            phase = RepairPhase.FAILED,
            startedAt = Instant.parse("2026-10-21T07:15:30.123Z"),
            source = "SillyBunny.broken-20261021T071531Z",
            ref = "staging",
            failure = RepairFailure.INSTALL_FAILED,
            preexisting = listOf("SillyBunny.broken-20261021T071531Z-2"),
            movingAt = Instant.parse("2026-10-21T07:15:31.900Z"),
            partials = listOf("SillyBunny.broken-20261021T072000Z", "SillyBunny.broken-20261021T072500Z-3"),
        )
        store.save(record)
        assertEquals(record, store.load())
        assertFalse(File(file.path + ".tmp").exists())

        val minimal = RepairRecord(RepairPhase.STOPPING, Instant.parse("2026-10-21T07:15:30Z"))
        store.save(minimal)
        assertEquals(minimal, store.load())
        store.clear()
        assertNull(store.load())
        assertFalse(file.exists())
    }

    @Test
    fun theStoredFormatIsVersionedJsonNamingFoldersOnly() {
        store.save(
            RepairRecord(
                phase = RepairPhase.REINSTALLING,
                startedAt = Instant.parse("2026-10-21T07:15:30Z"),
                source = "SillyBunny.broken-20261021T071531Z",
                ref = "release",
            ),
        )
        val json = org.json.JSONObject(file.readText())
        assertEquals(1, json.getInt("version"))
        assertEquals("REINSTALLING", json.getString("phase"))
        assertEquals("2026-10-21T07:15:30Z", json.getString("startedAt"))
        assertEquals("SillyBunny.broken-20261021T071531Z", json.getString("source"))
        assertEquals("release", json.getString("ref"))
        assertEquals(0, json.getJSONArray("preexisting").length())
        assertEquals(0, json.getJSONArray("partials").length())
        assertFalse(json.has("failure"))
        assertFalse(json.has("movingAt"))
    }

    @Test
    fun aLeftoverTemporaryFileNeverReplacesTheRecord() {
        val record = RepairRecord(RepairPhase.QUIESCING, Instant.parse("2026-10-21T07:15:30Z"))
        store.save(record)
        File(file.path + ".tmp").writeText("{\"version\":1,\"phase\":\"FAILED\"")
        assertEquals(record, store.load())
        store.save(record.copy(phase = RepairPhase.STOPPING))
        assertEquals(RepairPhase.STOPPING, store.load()?.phase)
    }

    @Test
    fun aRecordThatCannotBeTrustedIsUnreadableNotAbsent() {
        file.parentFile!!.mkdirs()
        val valid = """{"version":1,"phase":"FAILED","startedAt":"2026-10-21T07:15:30Z","source":"SillyBunny.broken-20261021T071531Z"}"""
        file.writeText(valid)
        assertEquals("SillyBunny.broken-20261021T071531Z", store.load()?.source)
        val broken = listOf(
            "",
            "{",
            "[]",
            valid.replace("\"version\":1", "\"version\":2"),
            valid.replace("FAILED", "SOMETHING_ELSE"),
            valid.replace("2026-10-21T07:15:30Z", "yesterday"),
            valid.replace("SillyBunny.broken-20261021T071531Z", "../../elsewhere"),
            valid.replace("SillyBunny.broken-20261021T071531Z", "SillyBunny"),
            valid.replace("}", ",\"ref\":\"--upload-pack=x\"}"),
            valid.replace("}", ",\"ref\":\"\"}"),
            valid.replace("}", ",\"partials\":[\"/data/elsewhere\"]}"),
            valid.replace("}", ",\"preexisting\":[\"SillyBunny.broken-x\"]}"),
            valid.replace("}", ",\"failure\":\"NOT_A_REASON\"}"),
            "{\"version\":1,\"phase\":\"FAILED\",\"startedAt\":\"" + "9".repeat(70_000) + "\"}",
        )
        for (text in broken) {
            file.writeText(text)
            assertThrows(text.take(80), IOException::class.java) { store.load() }
        }
        file.delete()
        file.mkdir()
        assertThrows(IOException::class.java) { store.load() }
    }

    @Test
    fun aRecordThatCannotBeWrittenSurfacesAsAnIOException() {
        temporary.newFile("blocker")
        val blocked = RepairStore(File(temporary.root, "blocker/repair-record.json"))
        assertThrows(IOException::class.java) {
            blocked.save(RepairRecord(RepairPhase.STOPPING, Instant.EPOCH))
        }
        assertNull(blocked.load())
    }

    @Test
    fun aMoveInFlightOnlyClaimsNewFoldersCarryingItsStamp() {
        val at = Instant.parse("2026-10-21T07:15:31.900Z")
        val record = RepairRecord(
            phase = RepairPhase.MOVING_ASIDE,
            startedAt = at,
            preexisting = listOf("SillyBunny.broken-20261021T071531Z"),
            movingAt = at,
        )
        assertFalse(record.mayHaveMade("SillyBunny.broken-20261021T071531Z"))
        assertTrue(record.mayHaveMade("SillyBunny.broken-20261021T071531Z-2"))
        assertFalse(record.mayHaveMade("SillyBunny.broken-20261021T071530Z"))
        assertFalse(record.mayHaveMade("SillyBunny.broken-20261021T071532Z"))
        assertFalse(record.copy(phase = RepairPhase.REINSTALLING).mayHaveMade("SillyBunny.broken-20261021T071531Z-2"))
        assertTrue(record.copy(phase = RepairPhase.MOVING_PARTIAL_ASIDE).mayHaveMade("SillyBunny.broken-20261021T071531Z-2"))
        assertTrue(record.copy(movingAt = null).mayHaveMade("SillyBunny.broken-20261021T071530Z"))

        assertEquals(Instant.parse("2026-10-21T07:15:31Z"), movedAsideAt("SillyBunny.broken-20261021T071531Z-14"))
        assertNull(movedAsideAt("SillyBunny.broken-20261321T071531Z"))
        assertNull(movedAsideAt("SillyBunny"))
        assertTrue(stampedAt("SillyBunny.broken-20261021T071531Z", at))
    }
}
