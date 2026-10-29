package io.github.sillybunnyteam.sillybunny.web.files

import org.junit.Assert.assertEquals
import org.junit.Test

/** `<input accept>` to SAF MIME filter mapping (plan §4.5). */
class AcceptTypesTest {
    private val any = MimeFilter("*/*", emptyList())

    private fun filter(vararg accept: String) = AcceptTypes.filterFor(arrayOf(*accept))

    @Test
    fun missingOrBlankAcceptAllowsEveryFile() {
        assertEquals(any, AcceptTypes.filterFor(null))
        assertEquals(any, filter())
        assertEquals(any, filter(""))
        assertEquals(any, filter(" , ", ""))
    }

    @Test
    fun oneMimeTypeFiltersThePicker() {
        assertEquals(MimeFilter("image/png", emptyList()), filter("image/png"))
        assertEquals(MimeFilter("image/*", emptyList()), filter("IMAGE/*"))
        assertEquals(MimeFilter("application/json", emptyList()), filter(" application/json; charset=utf-8 "))
        assertEquals("duplicates collapse", MimeFilter("image/png", emptyList()), filter("image/png", "image/PNG"))
    }

    @Test
    fun severalMimeTypesUseExtraMimeTypes() {
        val expected = MimeFilter("*/*", listOf("image/png", "image/jpeg"))
        assertEquals(expected, filter("image/png,image/jpeg"))
        assertEquals(expected, filter("image/png", "image/jpeg"))
        assertEquals(MimeFilter("*/*", listOf("image/*", "video/mp4")), filter("image/*, video/mp4"))
    }

    @Test
    fun extensionsAndUnfilterableTokensAllowEveryFile() {
        val widening = listOf(
            ".json", "*.json", ".jsonl,.charx", ".settings", "application/octet-stream", "*/*", "*",
            "image", "/png", "image/", "a/b/c", "image/png,.json", ".zip,application/zip", "text/<script>",
            "image/*,application/octet-stream",
        )
        for (accept in widening) assertEquals(accept, any, filter(accept))
    }

    @Test
    fun filterableMimeChecksBothHalves() {
        assertEquals("text/plain", AcceptTypes.filterableMime("text/plain"))
        assertEquals("application/vnd.api+json", AcceptTypes.filterableMime("application/vnd.api+json"))
        assertEquals(null, AcceptTypes.filterableMime("*/plain"))
        assertEquals(null, AcceptTypes.filterableMime("text/pla in"))
        assertEquals(null, AcceptTypes.filterableMime("application/octet-stream"))
    }
}
