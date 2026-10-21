package io.github.sillybunnyteam.sillybunny.update

import java.util.Locale
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29])
class UpdateManifestTest {
    @Test
    fun selectsPrimaryAbiAndNormalizesHashes() {
        val root = CoreTestFixtures.manifest(version = 9)
        val signer = CoreTestFixtures.hex(CoreTestFixtures.signer).uppercase(Locale.ROOT)
        root.put("signingCertSha256", signer.chunked(2).joinToString(":"))
        root.put("inputsHash", "EF".repeat(32))
        root.getJSONObject("assets").put("armeabi-v7a", JSONObject().apply {
            put("name", "SillyBunny-android-armeabi-v7a.apk")
            put("sha256", "CD".repeat(32))
            put("size", 42)
        })

        val manifest = parse(root)!!
        assertEquals(9L, manifest.versionCode)
        assertEquals(CoreTestFixtures.APK_NAME, manifest.asset.name)
        assertEquals(CoreTestFixtures.hex(CoreTestFixtures.signer), manifest.signingCertSha256)
        assertEquals("ef".repeat(32), manifest.inputsHash)
        assertEquals("cd".repeat(32), UpdateManifestParser.parse(root.toString(), "armeabi-v7a", 29)!!.asset.sha256)
    }

    @Test
    fun requiresEverySchemaFieldAndItsExactType() {
        val invalid = mapOf(
            "schema" to listOf<Any>("1", true, 0, 2, JSONObject.NULL),
            "versionCode" to listOf<Any>("2", false, 0, -1, JSONObject.NULL),
            "versionName" to listOf<Any>(2, true, "", " ", JSONObject.NULL),
            "prerelease" to listOf<Any>("false", 0, JSONObject.NULL),
            "releaseTag" to listOf<Any>(2, false, "", JSONObject.NULL),
            "defaultRef" to listOf<Any>(2, false, "main", "Release", JSONObject.NULL),
            "minSdk" to listOf<Any>("29", true, 0, -1, 30, Long.MAX_VALUE, JSONObject.NULL),
            "signingCertSha256" to listOf<Any>(false, 1, "a".repeat(63), "gg".repeat(32), JSONObject.NULL),
            "inputsHash" to listOf<Any>(false, 1, "a".repeat(65), "ab:".repeat(32), JSONObject.NULL),
            "assets" to listOf<Any>(false, "assets", JSONObject(), JSONObject.NULL),
            "runtime" to listOf<Any>(false, "runtime", JSONObject(), JSONObject.NULL),
        )
        for ((field, values) in invalid) {
            val missing = CoreTestFixtures.manifest().apply { remove(field) }
            assertNull("missing $field", parse(missing))
            for (value in values) {
                assertNull("$field = $value", parse(CoreTestFixtures.manifest().put(field, value)))
            }
        }
    }

    @Test
    fun rejectsFractionalExponentialOverflowAndCoercedIntegers() {
        val root = CoreTestFixtures.manifest().toString()
        for (number in listOf("2.0", "2e0", "2E+1", "9223372036854775808", "NaN", "Infinity", "02", "+2")) {
            assertNull(number, UpdateManifestParser.parse(root.replace("\"versionCode\":2", "\"versionCode\":$number"), CoreTestFixtures.ABI, 29))
        }
        assertNull(UpdateManifestParser.parse(root.replace("\"schema\":1", "\"schema\":1.0"), CoreTestFixtures.ABI, 29))
        assertNull(UpdateManifestParser.parse(root.replace("\"minSdk\":29", "\"minSdk\":29.0"), CoreTestFixtures.ABI, 29))
        assertNotNull(parse(CoreTestFixtures.manifest(version = Long.MAX_VALUE)))
    }

    @Test
    fun validatesAllAssetsWithoutPathOrAbiTraversal() {
        for (name in listOf("../update.apk", "/update.apk", "a/b.apk", "a\\b.apk", "a%2fb.apk", "a?b.apk", "a#b.apk", "a..b.apk", ".apk", "a.apk.exe", "a\u0000.apk")) {
            val root = CoreTestFixtures.manifest()
            root.getJSONObject("assets").getJSONObject(CoreTestFixtures.ABI).put("name", name)
            assertNull(name, parse(root))
        }
        for (abi in listOf("../arm64-v8a", "arm64/v8a", "ARM64", "", "a".repeat(33))) {
            val root = CoreTestFixtures.manifest()
            root.getJSONObject("assets").put(abi, root.getJSONObject("assets").getJSONObject(CoreTestFixtures.ABI))
            assertNull(abi, parse(root))
        }
        val wrongAbi = CoreTestFixtures.manifest()
        assertNull(UpdateManifestParser.parse(wrongAbi.toString(), "x86_64", 29))
        assertNull(UpdateManifestParser.parse(wrongAbi.toString(), "../arm64-v8a", 29))
    }

    @Test
    fun enforcesPositiveBoundedIntegerAssetSizeAndHash() {
        for (size in listOf<Any>(0, -1, "12", true, UpdateManifestParser.MAX_APK_BYTES + 1, Long.MAX_VALUE, JSONObject.NULL)) {
            val root = CoreTestFixtures.manifest()
            root.getJSONObject("assets").getJSONObject(CoreTestFixtures.ABI).put("size", size)
            assertNull(size.toString(), parse(root))
        }
        val boundary = CoreTestFixtures.manifest()
        boundary.getJSONObject("assets").getJSONObject(CoreTestFixtures.ABI).put("size", UpdateManifestParser.MAX_APK_BYTES)
        assertEquals(UpdateManifestParser.MAX_APK_BYTES, parse(boundary)!!.asset.size)
        val valid = CoreTestFixtures.manifest().toString()
        for (number in listOf("131073.0", "131073e0", "9223372036854775808")) {
            val json = valid.replace("\"size\":131073", "\"size\":$number")
            assertNull(number, UpdateManifestParser.parse(json, CoreTestFixtures.ABI, 29))
        }
        for (hash in listOf("a".repeat(63), "ab:".repeat(32), "xx".repeat(32), "ab".repeat(32) + " ")) {
            val root = CoreTestFixtures.manifest()
            root.getJSONObject("assets").getJSONObject(CoreTestFixtures.ABI).put("sha256", hash)
            assertNull(hash, parse(root))
        }
    }

    @Test
    fun requiresRuntimeFieldsWithNullableBunOnly() {
        for (field in listOf("node", "git", "bash", "npm", "bun")) {
            val root = CoreTestFixtures.manifest()
            root.getJSONObject("runtime").remove(field)
            assertNull(field, parse(root))
        }
        for (field in listOf("node", "git", "bash", "npm")) {
            for (value in listOf<Any>(42, false, "", JSONObject.NULL)) {
                val root = CoreTestFixtures.manifest()
                root.getJSONObject("runtime").put(field, value)
                assertNull("$field=$value", parse(root))
            }
        }
        assertNotNull(parse(CoreTestFixtures.manifest().apply { getJSONObject("runtime").put("bun", "1.3.0") }))
    }

    @Test
    fun rejectsHostileSyntaxDuplicateKeysTrailingDataAndUnicode() {
        val valid = CoreTestFixtures.manifest().toString()
        val hostile = listOf(
            "", "null", "[]", "{", "/* comment */$valid", "$valid {}", "$valid trailing",
            valid.replaceFirst("{", "{\"schema\":1,"),
            valid.replaceFirst("{", "{\"unknown\":\"raw\nnewline\","),
            valid.dropLast(1) + ",}",
            valid.replace("\"schema\"", "'schema'"),
            valid.replace("\"prerelease\":false", "\"prerelease\":FALSE"),
            valid.replace("\"versionName\":\"1.2.0\"", "\"versionName\":\"\\q\""),
            valid.replace("\"versionName\":\"1.2.0\"", "\"versionName\":\"\\ud800\""),
            "\uFEFF$valid",
        )
        hostile.forEach { assertNull(it.take(80), UpdateManifestParser.parse(it, CoreTestFixtures.ABI, 29)) }
    }

    @Test
    fun boundsDepthEntriesAndUtf8BytesBeforeAllocatingTree() {
        val valid = CoreTestFixtures.manifest().toString()
        val deep = valid.dropLast(1) + ",\"extra\":" + "[".repeat(64) + "0" + "]".repeat(64) + "}"
        assertNull(UpdateManifestParser.parse(deep, CoreTestFixtures.ABI, 29))
        val entries = valid.dropLast(1) + ",\"extra\":[" + List(4_097) { "0" }.joinToString(",") + "]}"
        assertNull(UpdateManifestParser.parse(entries, CoreTestFixtures.ABI, 29))
        val large = valid.dropLast(1) + ",\"extra\":\"" + "é".repeat(UpdateJson.MAX_BYTES / 2) + "\"}"
        assertNull(UpdateManifestParser.parse(large, CoreTestFixtures.ABI, 29))
        assertNull(UpdateManifestParser.parse(valid, CoreTestFixtures.ABI, 0))
    }

    private fun parse(root: JSONObject): UpdateManifest? =
        UpdateManifestParser.parse(root.toString(), CoreTestFixtures.ABI, 29)
}
