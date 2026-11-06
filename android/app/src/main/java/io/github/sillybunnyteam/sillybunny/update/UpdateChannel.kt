package io.github.sillybunnyteam.sillybunny.update

import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.file.Files
import java.nio.file.LinkOption
import java.util.Locale

object UpdateChannel {
    private val sectionPattern =
        Regex("\\[([A-Za-z][A-Za-z0-9.-]*)(?:[ \\t]+\"([^\"\\\\]+)\")?][ \\t]*(?:[#;].*)?")
    private val keyPattern = Regex("([A-Za-z][A-Za-z0-9-]*)(?:[ \\t]*=[ \\t]*(.*))?")
    private val remotePattern = Regex("[A-Za-z0-9][A-Za-z0-9._-]{0,63}")

    fun trackedBranch(checkout: File, defaultRef: String): String {
        return try {
            readTrackedBranch(checkout) ?: defaultRef
        } catch (_: Exception) {
            defaultRef
        }
    }

    private fun readTrackedBranch(checkout: File): String? {
        val git = File(checkout, ".git")
        // Worktree gitdir indirection and external/include config are deliberately not interpreted.
        if (!Files.isDirectory(git.toPath(), LinkOption.NOFOLLOW_LINKS)) return null
        val rawHead = readText(File(git, "HEAD"), 4_096) ?: return null
        val head = when {
            rawHead.endsWith("\r\n") -> rawHead.dropLast(2)
            rawHead.endsWith('\n') -> rawHead.dropLast(1)
            else -> rawHead
        }
        if (!head.startsWith("ref: refs/heads/")) return null
        val localBranch = head.removePrefix("ref: refs/heads/")
        if (!validRef("refs/heads/$localBranch")) return null
        val config = parseConfig(readText(File(git, "config"), 512 * 1024) ?: return null)
            ?: return null
        val branch = config[Section("branch", localBranch)] ?: return null
        val remote = branch["remote"]?.singleOrNull()?.takeIf(remotePattern::matches) ?: return null
        if (remote == "." || remote.endsWith('.') || ".." in remote) return null
        val merge = branch["merge"]?.singleOrNull() ?: return null
        if (!merge.startsWith("refs/heads/") || !validRef(merge)) return null
        val fetch = config[Section("remote", remote)]?.get("fetch") ?: return null
        if (fetch.isEmpty() || fetch.size > 128) return null

        val destinations = mutableSetOf<String>()
        for (spec in fetch) {
            if (spec.startsWith('^')) {
                val source = spec.drop(1)
                if (!validRefPattern(source) || ':' in source) return null
                if (matchSource(source, merge) != null) return null
                continue
            }
            val parts = spec.removePrefix("+").split(':')
            if (parts.size != 2) return null
            val source = parts[0]
            val destination = parts[1]
            if (!validRefPattern(source) || !validRefPattern(destination) ||
                source.count { it == '*' } != destination.count { it == '*' }
            ) return null
            val capture = matchSource(source, merge) ?: continue
            destinations.add(if ('*' in destination) destination.replace("*", capture) else destination)
        }
        val upstream = destinations.singleOrNull() ?: return null
        val prefix = "refs/remotes/$remote/"
        if (!upstream.startsWith(prefix) || !validRef(upstream)) return null
        return upstream.removePrefix(prefix).takeUnless { it == "HEAD" }
    }

    private data class Section(val name: String, val subsection: String?)

    private fun parseConfig(text: String): Map<Section, Map<String, List<String>>>? {
        if (text.any { it.code < 0x20 && it != '\n' && it != '\r' && it != '\t' }) return null
        val result = linkedMapOf<Section, MutableMap<String, MutableList<String>>>()
        var section: Section? = null
        val lines = text.split('\n')
        if (lines.size > 16_384) return null
        for (raw in lines) {
            val line = raw.removeSuffix("\r").trim(' ', '\t')
            if (line.isEmpty() || line.startsWith('#') || line.startsWith(';')) continue
            if (line.startsWith('[')) {
                val match = sectionPattern.matchEntire(line) ?: return null
                val name = match.groupValues[1].lowercase(Locale.ROOT)
                if (name == "include" || name == "includeif") return null
                section = Section(name, match.groups[2]?.value)
                result.getOrPut(section) { linkedMapOf() }
                if (result.size > 2_048) return null
                continue
            }
            val current = section ?: return null
            val match = keyPattern.matchEntire(line) ?: return null
            val key = match.groupValues[1].lowercase(Locale.ROOT)
            val value = parseValue(match.groups[2]?.value ?: "true") ?: return null
            if (current.name == "extensions" && key == "worktreeconfig") return null
            val values = result.getValue(current).getOrPut(key) { mutableListOf() }
            if (current.name in setOf("branch", "remote") && key != "fetch" && values.isNotEmpty()) {
                return null
            }
            values.add(value)
        }
        return result
    }

    private fun parseValue(raw: String): String? {
        val result = StringBuilder()
        var quoted = false
        var pendingSpace = StringBuilder()
        for (char in raw) {
            when {
                char == '\\' || char == '\r' || char == '\n' -> return null
                char == '"' -> {
                    if (pendingSpace.isNotEmpty() && result.isNotEmpty()) result.append(pendingSpace)
                    pendingSpace = StringBuilder()
                    quoted = !quoted
                }
                !quoted && (char == '#' || char == ';') -> break
                !quoted && (char == ' ' || char == '\t') -> pendingSpace.append(char)
                else -> {
                    if (pendingSpace.isNotEmpty() && result.isNotEmpty()) result.append(pendingSpace)
                    pendingSpace = StringBuilder()
                    result.append(char)
                }
            }
        }
        return if (quoted) null else result.toString()
    }

    private fun matchSource(pattern: String, ref: String): String? {
        val star = pattern.indexOf('*')
        if (star < 0) return if (pattern == ref) "" else null
        val prefix = pattern.substring(0, star)
        val suffix = pattern.substring(star + 1)
        if (!ref.startsWith(prefix) || !ref.endsWith(suffix) || ref.length < prefix.length + suffix.length) {
            return null
        }
        return ref.substring(prefix.length, ref.length - suffix.length)
    }

    private fun validRefPattern(value: String): Boolean =
        value.count { it == '*' } <= 1 && validRef(value.replace("*", "wildcard"))

    private fun validRef(value: String): Boolean {
        if (!value.startsWith("refs/") || value.length > 1_024 ||
            value.endsWith('/') || value.endsWith('.') || ".." in value || "@{" in value ||
            value.any { it.code <= 0x20 || it.code >= 0x7f || it in "~^:?*[\\" }
        ) return false
        return value.split('/').all { it.isNotEmpty() && !it.startsWith('.') && !it.endsWith(".lock") }
    }

    private fun readText(file: File, limit: Int): String? {
        if (!Files.isRegularFile(file.toPath(), LinkOption.NOFOLLOW_LINKS)) return null
        val bytes = file.inputStream().use { input ->
            val output = ByteArrayOutputStream()
            val buffer = ByteArray(4_096)
            while (true) {
                val count = input.read(buffer, 0, minOf(buffer.size, limit + 1 - output.size()))
                if (count < 0) break
                output.write(buffer, 0, count)
                if (output.size() > limit) return null
            }
            output.toByteArray()
        }
        return Charsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(bytes)).toString()
    }
}
