package io.github.sillybunnyteam.sillybunny.web.downloads

import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The page script's message protocol: strict parsing and the native replies. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [37])
class BridgeMessagesTest {
    private val limits = TransferLimits()
    private val small = TransferLimits(chunkBytes = 8)
    private val doc = "0123456789abcdef"
    private val id = "fedcba9876543210fedcba9876543210"

    private fun parse(text: String) = BridgeMessages.parse(text, limits)

    @Test
    fun everyMessageType() {
        assertEquals(doc, (parse("""{"t":"hello","doc":"$doc"}""") as BridgeMessage.Hello).doc)
        assertEquals(doc, (parse("""{"t":"bye","doc":"$doc"}""") as BridgeMessage.Bye).doc)
        val begin = parse("""{"t":"begin","doc":"$doc","id":"$id","name":"chat.jsonl","mime":"application/jsonl","size":12,"key":"blob:http://127.0.0.1:1/x"}""")
            as BridgeMessage.Begin
        assertEquals(doc, begin.doc)
        assertEquals(id, begin.id)
        assertEquals("chat.jsonl", begin.name)
        assertEquals("application/jsonl", begin.mime)
        assertEquals(12, begin.size)
        assertEquals("blob:http://127.0.0.1:1/x", begin.key)
        val chunk = parse("""{"t":"chunk","id":"$id","seq":2,"data":"aGVsbG8="}""") as BridgeMessage.Chunk
        assertEquals(2, chunk.seq)
        assertArrayEquals("hello".toByteArray(), chunk.bytes)
        assertEquals(12, (parse("""{"t":"end","id":"$id","size":12}""") as BridgeMessage.End).size)
        assertEquals(id, (parse("""{"t":"abort","id":"$id"}""") as BridgeMessage.Abort).id)
        assertEquals(doc, (parse("""{"t":"fail","doc":"$doc"}""") as BridgeMessage.Fail).doc)
        val get = parse("""{"t":"get","doc":"$doc","url":"http://127.0.0.1:1/a","name":"a.json"}""") as BridgeMessage.Get
        assertEquals("http://127.0.0.1:1/a", get.url)
        assertEquals("a.json", get.name)
        assertEquals("http://127.0.0.1:1/f", (parse("""{"t":"post","doc":"$doc","url":"http://127.0.0.1:1/f"}""") as BridgeMessage.Post).url)
    }

    @Test
    fun optionalFieldsDegradeInsteadOfFailing() {
        val begin = parse("""{"t":"begin","doc":"$doc","id":"$id","size":0,"name":"${"n".repeat(1_025)}","mime":5,"key":"http://x/"}""")
            as BridgeMessage.Begin
        assertNull("over-long name", begin.name)
        assertNull("non-string mime", begin.mime)
        assertNull("keys are only blob: or data:", begin.key)
        assertNull((parse("""{"t":"get","doc":"$doc","url":"http://127.0.0.1:1/a"}""") as BridgeMessage.Get).name)
    }

    @Test
    fun malformedMessagesAreNull() {
        val bad = listOf(
            "", "not json", "[]", "\"hello\"", """{"doc":"$doc"}""", """{"t":5,"doc":"$doc"}""", """{"t":"other","doc":"$doc"}""",
            """{"t":"hello","doc":"0123456789ABCDEF"}""", """{"t":"hello","doc":"0123"}""", """{"t":"hello","doc":"${"a".repeat(65)}"}""",
            """{"t":"hello","doc":"zz23456789abcdef"}""", """{"t":"hello"}""",
            """{"t":"begin","doc":"$doc","id":"$id","size":-1}""", """{"t":"begin","doc":"$doc","id":"$id","size":1.5}""",
            """{"t":"begin","doc":"$doc","id":"$id","size":"12"}""", """{"t":"begin","doc":"$doc","id":"$id"}""",
            """{"t":"chunk","id":"$id","seq":2147483648,"data":"AA=="}""", """{"t":"chunk","id":"$id","seq":-1,"data":"AA=="}""",
            """{"t":"chunk","id":"$id","seq":0,"data":"%%%"}""", """{"t":"chunk","id":"$id","seq":0,"data":5}""",
            """{"t":"end","id":"$id"}""", """{"t":"get","doc":"$doc"}""", """{"t":"get","doc":"$doc","url":"${"u".repeat(8_193)}"}""",
            """{"t":"post","doc":"$doc"}""",
        )
        for (text in bad) assertNull(text.take(80), parse(text))
        assertNull("longer than a chunk envelope", parse("""{"t":"hello","doc":"$doc","pad":"${"p".repeat(limits.maxMessageChars)}"}"""))
    }

    @Test
    fun binaryFrames() {
        val frame = byteArrayOf(0, 0, 0, 7, 0, 0, 1, 2, 9, 8, 7)
        val parsed = checkNotNull(BridgeMessages.parseFrame(frame, small))
        assertEquals(7, parsed.slot)
        assertEquals(258, parsed.seq)
        assertEquals(3, parsed.length)
        assertNull("header only", BridgeMessages.parseFrame(ByteArray(8), small))
        assertNull("over a chunk", BridgeMessages.parseFrame(ByteArray(8 + 9), small))
        assertEquals(8, BridgeMessages.parseFrame(ByteArray(8 + 8), small)?.length)
        assertNull("high bit slot", BridgeMessages.parseFrame(byteArrayOf(-128, 0, 0, 0, 0, 0, 0, 0, 1), small))
        assertNull("high bit seq", BridgeMessages.parseFrame(byteArrayOf(0, 0, 0, 1, -1, 0, 0, 0, 1), small))
    }

    @Test
    fun repliesAndScripts() {
        val ready = JSONObject(BridgeMessages.ready(id, 3, small, binary = true))
        assertEquals("ready", ready.getString("t"))
        assertEquals(3, ready.getInt("slot"))
        assertEquals(8, ready.getInt("chunk"))
        assertEquals(4, ready.getInt("win"))
        assertTrue(ready.getBoolean("bin"))
        assertEquals(5, JSONObject(BridgeMessages.ack(id, 5)).getInt("seq"))
        assertEquals("done", JSONObject(BridgeMessages.done(id)).getString("t"))
        assertEquals("refused", JSONObject(BridgeMessages.cancel(id, "refused")).getString("reason"))
        val script = BridgeMessages.saveUrlScript("blob:x\"');alert(1)// ")
        assertTrue(script, script.contains("t.saveUrl(\"blob:x\\\"');alert(1)\\/\\/"))
        assertTrue(TransferLimits().maxMessageChars > 256 * 1024 / 3 * 4)
    }
}
