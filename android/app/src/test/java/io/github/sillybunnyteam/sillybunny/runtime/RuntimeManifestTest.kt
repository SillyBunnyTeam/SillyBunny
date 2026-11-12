package io.github.sillybunnyteam.sillybunny.runtime

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.io.File

@RunWith(RobolectricTestRunner::class)
class RuntimeManifestTest {
    @get:Rule
    val temporary = TemporaryFolder()

    @Test
    fun parsesTheGeneratedManifest() {
        val payload = RuntimeTestPayload(temporary.newFolder())
        val bytes = payload.assets.getValue(RuntimeManifest.ASSET)
        val manifest = RuntimeManifest.parse(bytes)
        assertEquals(RuntimeManifest.sha256(bytes), manifest.sha256)
        assertEquals(mapOf("node" to "24.22.0", "npm" to "11.19.1", "git" to "2.56.0", "bash" to "5.3.9"), manifest.versions)
        assertEquals(setOf("x86_64"), manifest.natives.keys)
        assertEquals(RuntimeTestPayload.NATIVES.toSet(), manifest.natives.getValue("x86_64").keys)
        assertEquals(payload.npm, manifest.npm)
        assertEquals(4, manifest.gitCoreLinkCount)
        assertEquals(
            RuntimeFileRecord(RuntimeManifest.sha256(payload.assets.getValue(RuntimeManifest.CA_BUNDLE)), 28),
            manifest.assets[RuntimeManifest.CA_BUNDLE],
        )
        assertEquals("x86_64", manifest.matchAbi(payload.nativeLibraryDir))
        File(payload.nativeLibraryDir, "libz1.so").appendText("!")
        assertNull(manifest.matchAbi(payload.nativeLibraryDir))
    }

    @Test
    fun rejectsEveryDeviationFromSchemaOne() {
        val payload = RuntimeTestPayload(temporary.newFolder())
        val valid = String(payload.assets.getValue(RuntimeManifest.ASSET), Charsets.UTF_8)
        val natives = "abis/x86_64/natives"
        val edits = listOf<(JSONObject) -> Unit>(
            { it.put("schema", 2) },
            { it.put("schema", "1") },
            { it.remove("versions") },
            { it.getJSONObject("versions").put("node", 24) },
            { it.getJSONObject("versions").put("git", "") },
            { it.getJSONObject("abis").put("mips", it.getJSONObject("abis").getJSONObject("x86_64")) },
            { it.put("abis", JSONObject()) },
            { it.at(natives).remove("libnode.so") },
            { it.at(natives).put("node", it.at(natives).getJSONObject("libnode.so")) },
            { it.at(natives).put("../libx.so", it.at(natives).getJSONObject("libnode.so")) },
            { it.at("$natives/libnode.so").put("size", -1) },
            { it.at("$natives/libnode.so").put("size", 1.5) },
            { it.at("$natives/libnode.so").put("size", "12") },
            { it.at("$natives/libnode.so").put("sha256", "A".repeat(64)) },
            { it.at("$natives/libnode.so").put("sha256", "0".repeat(63)) },
            { it.getJSONObject("assets").remove(RuntimeManifest.CA_BUNDLE) },
            { it.getJSONObject("assets").put("../escape", it.at("assets").getJSONObject(RuntimeManifest.CA_BUNDLE)) },
            { it.getJSONObject("assets").put("/absolute", it.at("assets").getJSONObject(RuntimeManifest.CA_BUNDLE)) },
            { it.getJSONObject("assets").put("runtime//double", it.at("assets").getJSONObject(RuntimeManifest.CA_BUNDLE)) },
            { it.getJSONObject("npm").put("size", it.getJSONObject("npm").getLong("size") + 1) },
            { it.getJSONObject("npm").put("files", 0) },
            { it.getJSONObject("npm").remove("contentBytes") },
            { it.put("gitCoreLinkCount", 0) },
            { it.put("gitCoreLinkCount", true) },
        )
        edits.forEachIndexed { index, edit ->
            val json = JSONObject(valid).also(edit).toString()
            val error = assertThrows("edit $index", RuntimeLayoutException::class.java) {
                RuntimeManifest.parse(json.toByteArray())
            }
            assertEquals("edit $index", RuntimeLayoutException.Reason.MANIFEST, error.reason)
        }
        listOf("", "[]", "{", "not json").forEach { text ->
            assertThrows(text, RuntimeLayoutException::class.java) { RuntimeManifest.parse(text.toByteArray()) }
        }
        val oversized = ByteArray(RuntimeManifest.MAX_BYTES + 1) { ' '.code.toByte() }
        assertThrows(RuntimeLayoutException::class.java) { RuntimeManifest.parse(oversized) }
    }

    @Test
    fun parsesNpmJsonStrictly() {
        val payload = RuntimeTestPayload(temporary.newFolder())
        val valid = String(payload.assets.getValue(RuntimeManifest.NPM_JSON), Charsets.UTF_8)
        assertEquals(payload.npm, RuntimeManifest.parseNpmRecord(valid.toByteArray()))
        listOf<(JSONObject) -> Unit>(
            { it.put("schema", 2) },
            { it.put("size", "4") },
            { it.put("files", NpmArchive.MAX_FILES + 1) },
            { it.put("contentBytes", NpmArchive.MAX_CONTENT_BYTES + 1) },
            { it.put("sha256", "xyz") },
            { it.remove("version") },
        ).forEachIndexed { index, edit ->
            val error = assertThrows("edit $index", RuntimeLayoutException::class.java) {
                RuntimeManifest.parseNpmRecord(JSONObject(valid).also(edit).toString().toByteArray())
            }
            assertEquals(RuntimeLayoutException.Reason.NPM_ARCHIVE, error.reason)
        }
    }

    @Test
    fun assetPathsMustBePlainRelativePaths() {
        listOf("runtime/npm.zip", "THIRD_PARTY_NOTICES", "runtime/git-templates/hooks/pre-commit.sample").forEach {
            assertEquals(it, true, RuntimeManifest.isSafeAssetPath(it))
        }
        listOf("", "/abs", "../x", "a/../b", "a/./b", "a//b", "a\\b", "sp ace", "café", "x".repeat(1025)).forEach {
            assertEquals(it, false, RuntimeManifest.isSafeAssetPath(it))
        }
    }

    private fun JSONObject.at(path: String): JSONObject =
        path.split('/').fold(this) { node, key -> node.getJSONObject(key) }
}
