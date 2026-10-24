package io.github.sillybunnyteam.sillybunny.runtime

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class InstalledRuntimeTest {
    private val fingerprint = ApkFingerprint(42, 1_700_000_000_000, "/data/app/~~a==/pkg-b==/lib/x86_64", "1".repeat(64))
    private val installed = InstalledRuntime(
        fingerprint = fingerprint,
        abi = "x86_64",
        versions = mapOf("bash" to "5.3.9", "git" to "2.56.0", "node" to "24.22.0", "npm" to "11.19.1"),
        gitCoreLinks = 148,
        npmFiles = 2128,
        npmContentBytes = 14_582_310,
        npmDigest = "2".repeat(64),
        npmSyncMode = NpmSyncMode.BATCHED,
    )

    @Test
    fun roundTripsThroughJson() {
        assertEquals(installed, InstalledRuntime.parse(installed.toJson().toByteArray()))
    }

    @Test
    fun reportsEveryDifferenceFromTheInstalledApk() {
        assertEquals(emptySet<RefreshReason>(), installed.refreshReasons(fingerprint))
        assertEquals(setOf(RefreshReason.VERSION_CODE), installed.refreshReasons(fingerprint.copy(versionCode = 43)))
        assertEquals(setOf(RefreshReason.LAST_UPDATE_TIME), installed.refreshReasons(fingerprint.copy(lastUpdateTime = 1)))
        assertEquals(
            setOf(RefreshReason.NATIVE_LIBRARY_DIR),
            installed.refreshReasons(fingerprint.copy(nativeLibraryDir = "/data/app/~~c==/pkg-d==/lib/x86_64")),
        )
        assertEquals(setOf(RefreshReason.MANIFEST), installed.refreshReasons(fingerprint.copy(manifestSha256 = "3".repeat(64))))
        assertEquals(
            RefreshReason.entries.toSet() - RefreshReason.MISSING,
            installed.refreshReasons(ApkFingerprint(1, 2, "/other", "4".repeat(64))),
        )
    }

    @Test
    fun rejectsIncompleteOrMistypedRecords() {
        val valid = installed.toJson()
        listOf<(JSONObject) -> Unit>(
            { it.put("schema", 2) },
            { it.remove("versionCode") },
            { it.put("versionCode", "42") },
            { it.put("lastUpdateTime", -1) },
            { it.put("nativeLibraryDir", "") },
            { it.put("manifestSha256", "short") },
            { it.getJSONObject("npm").put("syncMode", "SOMETIMES") },
            { it.getJSONObject("npm").remove("digest") },
            { it.getJSONObject("versions").put("node", 24) },
        ).forEachIndexed { index, edit ->
            assertNull("edit $index", InstalledRuntime.parse(JSONObject(valid).also(edit).toString().toByteArray()))
        }
        assertNull(InstalledRuntime.parse("{".toByteArray()))
        assertNull(InstalledRuntime.parse(ByteArray(InstalledRuntime.MAX_BYTES + 1) { ' '.code.toByte() }))
    }
}
