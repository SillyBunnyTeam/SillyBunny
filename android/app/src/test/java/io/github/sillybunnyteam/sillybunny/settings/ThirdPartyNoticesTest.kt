package io.github.sillybunnyteam.sillybunny.settings

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import io.github.sillybunnyteam.sillybunny.BuildConfig
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeFalse
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.io.IOException
import java.security.MessageDigest

@RunWith(RobolectricTestRunner::class)
class ThirdPartyNoticesTest {
    private fun loaded(source: NoticesSource = NoticesFixture.source()): ThirdPartyNotices {
        val result = ThirdPartyNotices.load(source)
        assertTrue("expected a loaded pair, got $result", result is NoticesLoad.Loaded)
        return (result as NoticesLoad.Loaded).notices
    }

    private fun reason(source: NoticesSource): NoticesLoad.Reason {
        val result = ThirdPartyNotices.load(source)
        assertTrue("expected an unavailable pair, got $result", result is NoticesLoad.Unavailable)
        return (result as NoticesLoad.Unavailable).reason
    }

    private fun withIndex(edit: (JSONObject) -> Unit): NoticesSource {
        val root = JSONObject(NoticesFixture.indexJson)
        edit(root)
        return NoticesFixture.source(index = root.toString().toByteArray())
    }

    private fun component(root: JSONObject, index: Int): JSONObject = root.getJSONArray("components").getJSONObject(index)

    @Test
    fun theGeneratorsOutputLoadsWithEveryComponent() {
        val notices = loaded()
        assertEquals(NoticesFixture.componentIds, notices.components.map { it.id })
        val node = notices.components[0]
        assertEquals("node", node.name)
        assertEquals("24.22.0", node.version)
        assertEquals("MIT", node.spdx)
        assertEquals("node", node.section)
        val npm = notices.components[1]
        assertNull("a JSON null SPDX stays unknown", npm.spdx)
        assertEquals(listOf("LICENSE", "NOTICE"), npm.licenses.map { it.path })
    }

    @Test
    fun noticeTextDecodesEachLicenseWithItsDeclaredEncoding() {
        val notices = loaded()
        val latin1 = notices.components.single { it.id == "termux/libfixture" }
        val text = notices.noticeText(latin1)
        assertTrue(text, text.startsWith("### libfixture\nversion: 1.0.0\n"))
        assertTrue(text, text.contains("Licence CeCILL fixture été\n"))
        val npm = notices.noticeText(notices.components.single { it.id == "npm/fixture-pkg" })
        assertTrue(npm, npm.contains("fixture-pkg notice ✓\n"))
        assertTrue(npm, npm.contains("#### LICENSE") && npm.contains("#### NOTICE"))
    }

    @Test
    fun fullTextIsTheWholeFileWithMixedEncodingsDecoded() {
        val notices = loaded()
        val full = notices.fullText()
        assertTrue(full.startsWith("THIRD_PARTY_NOTICES\n\n## android\n"))
        assertTrue(full.contains("fixture-pkg notice ✓"))
        assertTrue(full.contains("Licence CeCILL fixture été"))
        // Every component's notice appears in the full text, in index order.
        var from = 0
        for (component in notices.components) {
            val at = full.indexOf(notices.noticeText(component), from)
            assertTrue(component.id, at >= from)
            from = at
        }
    }

    @Test
    fun chunksSplitOnLineBoundaries() {
        assertEquals(listOf("a\nb", "c\nd", "e"), ThirdPartyNotices.chunks("a\nb\nc\nd\ne", lines = 2))
        assertEquals(listOf("a", "b"), ThirdPartyNotices.chunks("a\nb\n", lines = 1))
        assertEquals(emptyList<String>(), ThirdPartyNotices.chunks(""))
        val full = loaded().fullText()
        val chunks = ThirdPartyNotices.chunks(full, lines = 3)
        assertTrue(chunks.all { chunk -> chunk.count { it == '\n' } < 3 })
        // A newline that ends a block is the boundary itself, so only a final one can be dropped.
        val joined = chunks.joinToString("\n")
        assertTrue(joined == full || joined + "\n" == full)
    }

    @Test
    fun anUnknownSchemaIsUnavailable() {
        assertEquals(NoticesLoad.Reason.UNKNOWN_SCHEMA, reason(withIndex { it.put("schema", 2) }))
        assertEquals(NoticesLoad.Reason.UNKNOWN_SCHEMA, reason(withIndex { it.put("schema", 0) }))
    }

    @Test
    fun malformedIndexesAreUnavailable() {
        val cases = mapOf(
            "not JSON" to NoticesFixture.source(index = "{".toByteArray()),
            "a JSON array" to NoticesFixture.source(index = "[]".toByteArray()),
            "no schema" to withIndex { it.remove("schema") },
            "text schema" to withIndex { it.put("schema", "1") },
            "fractional schema" to withIndex { it.put("schema", 1.5) },
            "no components" to withIndex { it.remove("components") },
            "no notices record" to withIndex { it.remove("notices") },
            "other notices file" to withIndex { it.getJSONObject("notices").put("file", "NOTICE") },
            "wrong byte length" to withIndex { it.getJSONObject("notices").put("byteLength", 1) },
            "wrong digest" to withIndex { it.getJSONObject("notices").put("sha256", "0".repeat(64)) },
            "short digest" to withIndex { it.getJSONObject("notices").put("sha256", "abc") },
            "component beyond the text" to withIndex { component(it, 3).put("length", 10_000) },
            "negative offset" to withIndex { component(it, 0).put("offset", -1) },
            "overlapping components" to withIndex { component(it, 1).put("offset", 50) },
            "duplicate id" to withIndex { component(it, 1).put("id", "node") },
            "missing name" to withIndex { component(it, 0).remove("name") },
            "blank version" to withIndex { component(it, 0).put("version", " ") },
            "numeric SPDX" to withIndex { component(it, 0).put("spdx", 7) },
            "no licenses" to withIndex { component(it, 0).put("licenses", org.json.JSONArray()) },
            "unknown encoding" to withIndex {
                component(it, 0).getJSONArray("licenses").getJSONObject(0).put("encoding", "utf-16")
            },
            "license outside its component" to withIndex {
                component(it, 0).getJSONArray("licenses").getJSONObject(0).put("offset", 0)
            },
            "text offset" to withIndex { component(it, 0).put("offset", "42") },
        )
        for ((name, source) in cases) {
            assertEquals(name, NoticesLoad.Reason.MALFORMED, reason(source))
        }
    }

    @Test
    fun aChangedTextFailsItsDigest() {
        val text = NoticesFixture.text.also { it[it.size - 3] = 'X'.code.toByte() }
        assertEquals(NoticesLoad.Reason.MALFORMED, reason(NoticesFixture.source(text = text)))
    }

    @Test
    fun aMatchingDigestOverDifferentBytesStillValidatesRanges() {
        // A consistent digest is not enough: every range must still sit inside the text.
        val text = NoticesFixture.text.copyOf(100)
        val digest = MessageDigest.getInstance("SHA-256").digest(text).joinToString("") { "%02x".format(it) }
        val source = withIndex {
            it.getJSONObject("notices").put("byteLength", 100).put("sha256", digest)
        }.let { index -> NoticesSource { name -> if (name == ThirdPartyNotices.NOTICES_ASSET) text.inputStream() else index.open(name) } }
        assertEquals(NoticesLoad.Reason.MALFORMED, reason(source))
    }

    @Test
    fun missingAssetsAreUnavailable() {
        assertEquals(NoticesLoad.Reason.MISSING, reason(NoticesFixture.source(index = null)))
        assertEquals(NoticesLoad.Reason.MISSING, reason(NoticesFixture.source(text = null)))
        assertEquals(NoticesLoad.Reason.MISSING, reason(NoticesSource { null }))
    }

    @Test
    fun unreadableSourcesAreUnavailableInsteadOfThrowing() {
        assertEquals(NoticesLoad.Reason.MALFORMED, reason(NoticesSource { throw IOException("broken") }))
        assertEquals(NoticesLoad.Reason.MALFORMED, reason(NoticesSource { throw IllegalStateException("broken") }))
    }

    @Test
    fun oversizedFilesAreRejectedWithoutReadingThemWhole() {
        val huge = object : java.io.InputStream() {
            var served = 0L

            override fun read(): Int = if (served++ < ThirdPartyNotices.MAX_INDEX_BYTES + 1L) ' '.code else -1

            override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
                if (served > ThirdPartyNotices.MAX_INDEX_BYTES) return -1
                buffer.fill(' '.code.toByte(), offset, offset + length)
                served += length
                return length
            }
        }
        assertEquals(NoticesLoad.Reason.MALFORMED, reason(NoticesSource { huge }))
        assertTrue(huge.served <= ThirdPartyNotices.MAX_INDEX_BYTES + 64 * 1024)
    }

    @Test
    fun aDebugBuildWithoutNoticesAssetsShowsTheEmptyState() {
        // Notices are packaged only with the runtime.
        assumeFalse("This build packages the runtime and its notices", BuildConfig.HAS_RUNTIME)
        val context = ApplicationProvider.getApplicationContext<Context>()
        assertEquals(NoticesLoad.Reason.MISSING, reason(AssetNoticesSource(context.assets)))
    }
}
