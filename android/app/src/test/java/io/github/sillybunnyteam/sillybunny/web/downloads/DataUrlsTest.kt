package io.github.sillybunnyteam.sillybunny.web.downloads

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Bounded WHATWG `data:` URL decoding for downloads. */
class DataUrlsTest {
    private fun decode(url: String, maxChars: Int = 1 shl 20, maxBytes: Int = 1 shl 20) = DataUrls.decode(url, maxChars, maxBytes)

    private fun text(url: String): String? = decode(url)?.bytes?.toString(Charsets.UTF_8)

    @Test
    fun base64Bodies() {
        val decoded = checkNotNull(decode("data:text/plain;base64,aGVsbG8="))
        assertEquals("text/plain", decoded.mime)
        assertEquals("hello", decoded.bytes.toString(Charsets.US_ASCII))
        assertEquals("missing padding and whitespace are forgiven", "hello", text("data:;base64,aGVs bG8"))
        assertEquals("percent-encoded padding", "hello", text("data:;base64,aGVsbG8%3D"))
        assertEquals("parameter spacing", "hello", text("data:application/json; base64,aGVsbG8="))
        assertArrayEquals(byteArrayOf(-1, 0, 1), decode("data:application/octet-stream;BASE64,/wAB")?.bytes)
    }

    @Test
    fun invalidBase64IsRefused() {
        assertNull(decode("data:;base64,a"))
        assertNull(decode("data:;base64,a\$bc"))
        assertNull(decode("data:;base64,ab=c"))
    }

    @Test
    fun percentEncodedBodies() {
        assertEquals("a b", text("data:,a%20b"))
        assertEquals("a literal percent stays", "100% sure %zz", text("data:,100% sure %zz"))
        assertEquals("héllo ✓", text("data:text/plain;charset=utf-8,h%C3%A9llo%20%E2%9C%93"))
        assertEquals("non-ASCII is UTF-8 encoded", "é😀", text("data:,é😀"))
        assertEquals("the fragment is dropped", "abc", text("data:,abc#frag"))
    }

    @Test
    fun mimeTypes() {
        assertEquals("text/plain", decode("data:,x")?.mime)
        assertEquals("text/plain", decode("data:;charset=utf-8,x")?.mime)
        assertEquals("image/png", decode("data:IMAGE/PNG;base64,AA==")?.mime)
        assertEquals("text/plain", decode("data:not a type,x")?.mime)
        assertEquals("application/json", decode("data: application/json ;charset=utf-8,{}")?.mime)
    }

    @Test
    fun limitsAndShape() {
        assertNull(decode("data:,abcd", maxChars = 9))
        assertEquals("abcd", text("data:,abcd"))
        assertNull("decoded bytes over the limit", decode("data:,abcd", maxBytes = 3))
        assertNull(decode("data:;base64,aGVsbG8=", maxBytes = 4))
        assertEquals(5, decode("data:;base64,aGVsbG8=", maxBytes = 5)?.bytes?.size)
        assertNull(decode("http://example.com/,x"))
        assertNull(decode("data:text/plain"))
    }

    @Test
    fun keysStayShort() {
        assertEquals("data:,x", DataUrls.key("data:,x"))
        val long = "data:;base64," + "A".repeat(500)
        assertEquals(long.take(64) + "#" + long.length, DataUrls.key(long))
        assertEquals(DataUrls.key(long), TransferKeys.of(long))
    }
}
