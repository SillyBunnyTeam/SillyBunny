package io.github.sillybunnyteam.sillybunny.web.downloads

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Untrusted file names and MIME types for saved downloads (plan §4.5). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [37])
class FileNamesTest {
    private val mimeToExtension = mapOf("application/json" to "json", "text/plain" to "txt", "image/png" to "png", "weird/type" to "ex-t")
    private val extensionToMime = mapOf("json" to "application/json", "txt" to "text/plain", "png" to "image/png", "jsonl" to "application/jsonl")

    private fun withExtension(name: String, mime: String?) = FileNames.withExtensionFor(name, mime) { mimeToExtension[it] }

    private fun saveMime(name: String) = FileNames.saveMime(name) { extensionToMime[it] }

    @Test
    fun sanitizeKeepsOneSafeDisplayName() {
        val cases = mapOf(
            "chat.jsonl" to "chat.jsonl",
            "../../etc/passwd" to "passwd",
            "..\\..\\windows\\evil.bat" to "evil.bat",
            "/abs/path/x.json" to "x.json",
            "evil‮gnp.exe" to "evil_gnp.exe",
            "zero​width.txt" to "zero_width.txt",
            "a\u0000b\u001f\u007f\u0085.txt" to "a_b___.txt",
            "a<b>c:d\"e|f?g*h.txt" to "a_b_c_d_e_f_g_h.txt",
            "lone\uD800.txt" to "lone_.txt",
            "  name.txt. . " to "name.txt",
            "CON" to "_CON",
            "nul.txt" to "_nul.txt",
            "com1.log" to "_com1.log",
            "LPT9" to "_LPT9",
            "console.txt" to "console.txt",
            ".json" to "download.json",
            ".JSONL" to "download.jsonl",
            " .charx" to "download.charx",
            ".hidden.txt" to "hidden.txt",
            "***" to "download",
            "" to "download",
            "  " to "download",
            "été.txt" to "été.txt",
            "キャラ.png" to "キャラ.png",
            "Seraphina (1).charx" to "Seraphina (1).charx",
        )
        for ((input, expected) in cases) assertEquals("sanitize(${input.map { it.code }})", expected, FileNames.sanitize(input))
        assertEquals("download", FileNames.sanitize(null))
        assertEquals("custom fallback is sanitized too", "x.txt", FileNames.sanitize("", fallback = "../x.txt"))
    }

    @Test
    fun longNamesKeepTheirExtensionWithin255Bytes() {
        val ascii = FileNames.sanitize("x".repeat(300) + ".json")
        assertEquals("x".repeat(250) + ".json", ascii)
        val multibyte = FileNames.sanitize("é".repeat(200) + ".json")
        assertEquals("é".repeat(125) + ".json", multibyte)
        assertTrue(multibyte.toByteArray(Charsets.UTF_8).size <= 255)
        val emoji = FileNames.sanitize("😀".repeat(100) + ".txt")
        assertTrue("no split surrogate pair", emoji.dropLast(4).chunked(2).all { it == "😀" })
        assertTrue(emoji.toByteArray(Charsets.UTF_8).size <= 255)
        assertEquals("no extension: plain truncation", 255, FileNames.sanitize("y".repeat(400)).length)
    }

    @Test
    fun extensionsComeFromTheMimeTypeOnlyWhenMissing() {
        assertEquals("page.json", withExtension("page", "application/json"))
        assertEquals("page.json", withExtension("page", "Application/JSON; charset=utf-8"))
        assertEquals("keeps an existing extension", "page.txt", withExtension("page.txt", "application/json"))
        assertEquals("octet-stream adds nothing", "blob", withExtension("blob", "application/octet-stream"))
        assertEquals("blank", withExtension("blank", ""))
        assertEquals("blank", withExtension("blank", null))
        assertEquals("unknown", withExtension("unknown", "application/x-unknown"))
        assertEquals("invalid mapped extension is ignored", "odd", withExtension("odd", "weird/type"))
        assertEquals("download.txt", withExtension(FileNames.FALLBACK, "text/plain"))
    }

    @Test
    fun saveMimeFollowsTheNamesExtension() {
        assertEquals("application/json", saveMime("chat.json"))
        assertEquals("application/json", saveMime("CHAT.JSON"))
        assertEquals("application/jsonl", saveMime("chat.jsonl"))
        assertEquals("unknown extension", "application/octet-stream", saveMime("card.charx"))
        assertEquals("no extension", "application/octet-stream", saveMime("noext"))
        assertEquals("application/octet-stream", saveMime(".json"))
    }

    @Test
    fun extensionAndMimeParsing() {
        assertEquals("json", FileNames.extension("a.JSON"))
        assertEquals("gz", FileNames.extension("a.tar.gz"))
        assertNull(FileNames.extension(".json"))
        assertNull(FileNames.extension("a."))
        assertNull(FileNames.extension("a.j-son"))
        assertNull(FileNames.extension("a." + "x".repeat(17)))
        assertEquals("text/plain", FileNames.normalizeMime(" Text/Plain ; charset=utf-8"))
        assertNull(FileNames.normalizeMime("text"))
        assertNull(FileNames.normalizeMime("a/b/c"))
        assertNull(FileNames.normalizeMime("*/*"))
        assertNull(FileNames.normalizeMime(""))
    }

    @Test
    fun contentDispositionNames() {
        assertEquals("résumé.txt", FileNames.fromContentDisposition("attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.txt"))
        assertEquals(
            "filename* wins",
            "résumé.txt",
            FileNames.fromContentDisposition("attachment; filename=\"fallback.txt\"; filename*=utf-8''r%C3%A9sum%C3%A9.txt"),
        )
        assertEquals("café.txt", FileNames.fromContentDisposition("attachment; filename*=ISO-8859-1'en'caf%E9.txt"))
        assertEquals("a\"b;c.txt", FileNames.fromContentDisposition("attachment; filename=\"a\\\"b;c.txt\""))
        assertEquals("report.json", FileNames.fromContentDisposition("attachment; FILENAME=report.json"))
        assertEquals("percent-encoded UTF-8 in filename", "résumé.txt", FileNames.fromContentDisposition("attachment; filename=\"r%C3%A9sum%C3%A9.txt\""))
        assertEquals("invalid escapes stay", "100%zz.txt", FileNames.fromContentDisposition("attachment; filename=\"100%zz.txt\""))
        assertEquals("unknown charset falls back", "plain.txt", FileNames.fromContentDisposition("attachment; filename*=koi8-r''x; filename=plain.txt"))
        assertEquals("malformed UTF-8 falls back", "plain.txt", FileNames.fromContentDisposition("attachment; filename*=UTF-8''%FF; filename=plain.txt"))
        assertNull(FileNames.fromContentDisposition("attachment"))
        assertNull(FileNames.fromContentDisposition("inline; filename=\"\""))
        assertNull(FileNames.fromContentDisposition(null))
        assertNull(FileNames.fromContentDisposition("attachment; filename=" + "a".repeat(9_000)))
    }

    @Test
    fun urlNames() {
        assertEquals("c d.json", FileNames.fromUrl("http://127.0.0.1:41234/a/b/c%20d.json?x=1#f"))
        assertEquals("x.zip", FileNames.fromUrl("HTTPS://example.com/x.zip"))
        assertNull(FileNames.fromUrl("http://127.0.0.1:41234/"))
        assertNull(FileNames.fromUrl("blob:http://127.0.0.1:41234/id"))
        assertNull(FileNames.fromUrl("data:,x"))
        assertNull(FileNames.fromUrl(null))
    }
}
