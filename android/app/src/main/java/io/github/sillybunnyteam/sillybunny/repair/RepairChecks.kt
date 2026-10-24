package io.github.sillybunnyteam.sillybunny.repair

import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path

/**
 * Reads `config.yaml`'s `dataRoot` exactly as `scripts/bootstrap/install.sh`'s `read_data_root` does, because
 * that reading decides what the installer copies: a relative root is copied into the new checkout and an
 * absolute root is reused in place. The file is only ever read, never modified.
 */
internal object DataRoot {
    const val DEFAULT = "./data"
    private const val MAX_CONFIG_BYTES = 8 * 1024 * 1024
    private const val PREFIX = "dataRoot:"

    /**
     * The root, or [DEFAULT] when `config.yaml` is not a regular file. Throws when it exists but cannot be read,
     * is not valid UTF-8 or holds a NUL byte: the installer's reading of such a file cannot be predicted.
     */
    @Throws(IOException::class)
    fun read(checkout: File): String {
        // `[[ -f "$config" ]]` follows symlinks.
        val config = File(checkout, "config.yaml").toPath()
        if (!Files.isRegularFile(config)) return DEFAULT
        val text = try {
            Charsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(readBounded(config, MAX_CONFIG_BYTES)))
                .toString()
        } catch (failure: CharacterCodingException) {
            throw IOException("config.yaml is not UTF-8", failure)
        }
        // Bash drops NUL bytes from command substitutions, so the installer would read another value.
        if ('\u0000' in text) throw IOException("config.yaml holds a NUL byte")
        return parse(text)
    }

    /**
     * The rest of the first line that starts with `dataRoot:`, minus the whitespace after the key (the
     * installer's `sed -n` substitution piped to `head -n 1`), then the installer's trims in its order: from
     * the first `#` on, one trailing CR, trailing whitespace, one leading quote and one trailing quote. An
     * empty result means [DEFAULT].
     */
    fun parse(text: String): String {
        val line = text.split('\n').firstOrNull { it.startsWith(PREFIX) } ?: return DEFAULT
        var value = line.substring(PREFIX.length).trimStart(::isPosixSpace)
        val comment = value.indexOf('#')
        if (comment >= 0) value = value.substring(0, comment)
        value = value.removeSuffix("\r").trimEnd(::isPosixSpace)
        if (value.startsWith('"') || value.startsWith('\'')) value = value.substring(1)
        if (value.endsWith('"') || value.endsWith('\'')) value = value.dropLast(1)
        return value.ifEmpty { DEFAULT }
    }

    fun isAbsolute(root: String): Boolean = root.startsWith('/')

    /** install.sh refuses a relative root whose `/<root>/` (one leading `./` removed) holds `/../` or is `//`. */
    fun escapesCheckout(relative: String): Boolean {
        val wrapped = "/${relative.removePrefix("./")}/"
        return "/../" in wrapped || wrapped == "//"
    }

    /** `[[:space:]]` in the C locale the app runs install.sh in. */
    private fun isPosixSpace(char: Char): Boolean =
        char == ' ' || char == '\t' || char == '\n' || char == '\r' || char == '\u000B' || char == '\u000C'
}

/** Component-wise path containment, never a string-prefix test (`SillyBunny2` is not inside `SillyBunny`). */
internal object PathContainment {
    /**
     * True when [path] is [dir] or lies below it in any combination of their raw (only `.` dropped),
     * normalized and symlink-resolved forms. The raw form keeps `..`, so a path that passes through [dir]
     * counts as inside even when it climbs back out: renaming [dir] would still change where it leads.
     */
    fun isWithin(path: Path, dir: Path): Boolean {
        val candidates = forms(path)
        val containers = forms(dir)
        return candidates.any { candidate -> containers.any { container -> candidate.startsWith(container) } }
    }

    private fun forms(path: Path): List<Path> {
        val absolute = path.toAbsolutePath()
        val raw = absolute.fold(absolute.root) { result, part ->
            if (part.toString() == ".") result else result.resolve(part)
        }
        val canonical = try {
            absolute.toFile().canonicalFile.toPath()
        } catch (_: IOException) {
            null
        }
        return listOfNotNull(raw, absolute.normalize(), canonical)
    }
}

internal object CheckoutChecks {
    private const val MAX_PACKAGE_BYTES = 8 * 1024 * 1024
    private val projectName = Regex("\"name\"[ \t\r\u000B\u000C]*:[ \t\r\u000B\u000C]*\"sillybunny\"")

    /**
     * install.sh's `is_sillybunny_dir`: `package.json` is a regular file (following symlinks, like `-f`)
     * with a line matching `"name"[[:space:]]*:[[:space:]]*"sillybunny"`. Unreadable counts as false,
     * as grep failing does there.
     */
    fun isSillyBunny(dir: File): Boolean {
        val manifest = File(dir, "package.json").toPath()
        if (!Files.isRegularFile(manifest)) return false
        val text = try {
            String(readBounded(manifest, MAX_PACKAGE_BYTES), Charsets.UTF_8)
        } catch (_: IOException) {
            return false
        }
        // The character class excludes '\n', so one search over the whole text equals grep's per-line search.
        return projectName.containsMatchIn(text)
    }

    /** Repair's success test: a real directory with a real `.git` directory holding a `HEAD` file. */
    fun isGitCheckout(dir: File): Boolean {
        val root = dir.toPath()
        return Files.isDirectory(root, LinkOption.NOFOLLOW_LINKS) &&
            Files.isDirectory(root.resolve(".git"), LinkOption.NOFOLLOW_LINKS) &&
            Files.isRegularFile(root.resolve(".git").resolve("HEAD"), LinkOption.NOFOLLOW_LINKS)
    }
}

/** Reads at most [limit] bytes; a longer file throws instead of being silently truncated. */
@Throws(IOException::class)
internal fun readBounded(path: Path, limit: Int): ByteArray = Files.newInputStream(path).use { input ->
    val output = ByteArrayOutputStream()
    val buffer = ByteArray(8_192)
    while (true) {
        val count = input.read(buffer)
        if (count < 0) break
        output.write(buffer, 0, count)
        if (output.size() > limit) throw IOException("File too large: $path")
    }
    output.toByteArray()
}
