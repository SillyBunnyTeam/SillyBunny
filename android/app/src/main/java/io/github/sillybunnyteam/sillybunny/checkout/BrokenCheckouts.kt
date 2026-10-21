package io.github.sillybunnyteam.sillybunny.checkout

import io.github.sillybunnyteam.sillybunny.runtime.RuntimePaths
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.StandardCopyOption
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

/**
 * Moves a checkout aside instead of deleting it (plan §4.3 step 6, §4.7 step 2), and finds the folders
 * that leaves behind. First run and Repair both use it, so their folders share one naming scheme.
 */
object BrokenCheckouts {
    private const val MAX_ATTEMPTS = 100
    private val stamp = DateTimeFormatter.ofPattern("yyyyMMdd'T'HHmmss'Z'").withZone(ZoneOffset.UTC)
    private val name = Regex("""SillyBunny\.broken-(\d{8}T\d{6}Z)(?:-([1-9]\d{0,2}))?""")

    /**
     * Renames [RuntimePaths.checkoutDir] to a fresh `SillyBunny.broken-<UTC timestamp>[-n]` folder and
     * returns it. Throws [IOException] when the checkout is missing or a symlink, or when the rename is
     * not a single atomic `rename(2)`. Nothing is ever copied, deleted or replaced.
     */
    @Throws(IOException::class)
    fun moveAside(paths: RuntimePaths, now: Instant): File {
        val source = paths.checkoutDir.toPath()
        if (!Files.isDirectory(source, LinkOption.NOFOLLOW_LINKS)) {
            throw IOException("No checkout directory to move aside: $source")
        }
        val base = stamp.format(now)
        for (attempt in 1..MAX_ATTEMPTS) {
            val target = paths.brokenCheckout(if (attempt == 1) base else "$base-$attempt")
            if (Files.exists(target.toPath(), LinkOption.NOFOLLOW_LINKS)) continue
            // ATOMIC_MOVE never falls back to copy-and-delete. Should another writer win the race for
            // this name, rename(2) can only replace an empty directory, so no data is lost either way.
            Files.move(source, target.toPath(), StandardCopyOption.ATOMIC_MOVE)
            return target
        }
        throw IOException("No free name to move the checkout aside for $base")
    }

    /** True for names [moveAside] creates. */
    fun isBrokenCheckoutName(fileName: String): Boolean = name.matches(fileName)

    /** The moved-aside folders directly inside `filesDir`, oldest first. Files and symlinks are ignored. */
    fun list(paths: RuntimePaths): List<File> =
        paths.filesDir.listFiles().orEmpty()
            .mapNotNull { file ->
                val match = name.matchEntire(file.name) ?: return@mapNotNull null
                if (!Files.isDirectory(file.toPath(), LinkOption.NOFOLLOW_LINKS)) return@mapNotNull null
                Triple(match.groupValues[1], match.groupValues[2].toIntOrNull() ?: 1, file)
            }
            .sortedWith(compareBy({ it.first }, { it.second }))
            .map { it.third }
}
