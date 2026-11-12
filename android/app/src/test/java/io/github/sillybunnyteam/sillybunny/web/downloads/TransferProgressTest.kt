package io.github.sillybunnyteam.sillybunny.web.downloads

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Chunk ordering and size checks, and the recent-URL memory behind duplicate and POST checks. */
class TransferProgressTest {
    @Test
    fun chunksArriveInOrderWithExactSizes() {
        val progress = TransferProgress(declaredSize = 10, chunkBytes = 4)
        assertFalse("seq 1 first", progress.accept(1, 4))
        assertFalse("short non-final chunk", progress.accept(0, 3))
        assertTrue(progress.accept(0, 4))
        assertTrue(progress.accept(1, 4))
        assertFalse("long final chunk", progress.accept(2, 4))
        assertFalse("repeated seq", progress.accept(1, 2))
        assertTrue(progress.accept(2, 2))
        assertEquals(10, progress.received)
        assertFalse("nothing after the declared size", progress.accept(3, 1))
        assertFalse(progress.complete(9))
        assertTrue(progress.complete(10))
    }

    @Test
    fun incompleteOrEmptyTransfers() {
        val progress = TransferProgress(declaredSize = 8, chunkBytes = 4)
        assertTrue(progress.accept(0, 4))
        assertFalse(progress.complete(8))
        val empty = TransferProgress(declaredSize = 0, chunkBytes = 4)
        assertFalse(empty.accept(0, 0))
        assertTrue(empty.complete(0))
    }

    @Test
    fun recentKeysExpireAndEvictOldestFirst() {
        var now = 0L
        val keys = RecentKeys(ttlMillis = 1_000, max = 2, clock = { now })
        keys.add("a")
        now = 500
        keys.add("b")
        assertTrue(keys.contains("a"))
        now = 1_001
        assertFalse("expired", keys.contains("a"))
        assertTrue(keys.contains("b"))
        keys.add("c")
        keys.add("d")
        assertFalse("evicted beyond max", keys.contains("b"))
        assertTrue(keys.consume("c"))
        assertFalse("consumed once", keys.consume("c"))
        assertTrue(keys.contains("d"))
    }

    @Test
    fun reAddingRefreshesAKey() {
        var now = 0L
        val keys = RecentKeys(ttlMillis = 1_000, max = 8, clock = { now })
        keys.add("a")
        now = 900
        keys.add("a")
        keys.add("b")
        now = 1_500
        assertTrue(keys.contains("a"))
        assertTrue(keys.contains("b"))
    }
}
