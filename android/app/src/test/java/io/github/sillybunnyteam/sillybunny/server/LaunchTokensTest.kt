package io.github.sillybunnyteam.sillybunny.server

import io.github.sillybunnyteam.sillybunny.runtime.RuntimePaths
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.security.SecureRandom

class LaunchTokensTest {
    @Test
    fun tokensAre32SecureRandomBytesAsLowercaseHex() {
        val counting = object : SecureRandom() {
            override fun nextBytes(bytes: ByteArray) {
                for (index in bytes.indices) bytes[index] = (index * 9 + 0xf0).toByte()
            }
        }

        val token = LaunchTokens.generate(counting)

        val expected = (0 until 32).joinToString("") { "%02x".format((it * 9 + 0xf0) and 0xff) }
        assertEquals(expected, token)
        assertTrue(Regex("[0-9a-f]{64}").matches(token))
        assertTrue(LaunchTokens.isValid(token))
    }

    @Test
    fun everyTokenIsNew() {
        val tokens = List(64) { LaunchTokens.generate() }

        assertEquals(tokens.size, tokens.toSet().size)
        tokens.forEach { assertTrue(it, LaunchTokens.isValid(it)) }
    }

    @Test
    fun onlyLowercaseHexOfTheRightLengthIsValid() {
        assertFalse(LaunchTokens.isValid("A".repeat(64)))
        assertFalse(LaunchTokens.isValid("a".repeat(63)))
        assertFalse(LaunchTokens.isValid("a".repeat(65)))
        assertFalse(LaunchTokens.isValid("g".repeat(64)))
        assertFalse(LaunchTokens.isValid(""))
    }

    @Test
    fun noToStringCarriesTheToken() {
        val token = LaunchTokens.generate()
        val session = LaunchSession(50_123, token)
        val paths = RuntimePaths(File("/files"), File("/cache"), File("/lib"))
        val environment = ProcessEnvironment.build(paths, emptyMap(), 1, autoUpdate = true, launchToken = token)
        val spec = LaunchSpecFactory { _, _, env -> LaunchSpec(listOf("/system/bin/sh", "-c", ":"), File("/files"), env, null) }
            .create(paths, session, environment)

        val texts = listOf(
            session.toString(),
            ServerState.Running(session, originChanged = true).toString(),
            environment.toString(),
            spec.toString(),
        )

        texts.forEach { assertFalse(it, it.contains(token)) }
        assertTrue(texts[1].contains("50123"))
    }

    @Test
    fun theSplitterRedactsTheTokenAtEveryReadBoundary() {
        val token = LaunchTokens.generate()
        val output = "start\nheader $token tail\r\nnext\rlast $token".toByteArray()
        for (split in 1 until output.size) {
            val lines = mutableListOf<String>()
            val splitter = RedactingLineSplitter(token) { lines += it }
            splitter.feed(output.copyOfRange(0, split), split)
            splitter.feed(output.copyOfRange(split, output.size), output.size - split)
            splitter.finish()

            assertEquals(
                "split at $split",
                listOf("start", "header [REDACTED] tail", "next", "last [REDACTED]"),
                lines,
            )
        }
    }

    @Test
    fun aTokenCutOffByTheEndOfTheOutputIsRedactedToo() {
        val token = LaunchTokens.generate()
        val lines = mutableListOf<String>()
        val splitter = RedactingLineSplitter(token) { lines += it }
        val output = "value=${token.take(40)}".toByteArray()

        splitter.feed(output, output.size)
        splitter.finish()

        assertEquals(listOf("value=[REDACTED]"), lines)
    }

    @Test
    fun aByteAtATimeStillRedacts() {
        val token = LaunchTokens.generate()
        val lines = mutableListOf<String>()
        val splitter = RedactingLineSplitter(token) { lines += it }

        "a${token}b${token}\n".toByteArray().forEach { splitter.feed(byteArrayOf(it), 1) }
        splitter.finish()

        assertEquals(listOf("a[REDACTED]b[REDACTED]"), lines)
        assertNotEquals(token, lines.single())
    }
}
