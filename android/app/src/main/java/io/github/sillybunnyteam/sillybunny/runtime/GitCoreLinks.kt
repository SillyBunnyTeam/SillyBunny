package io.github.sillybunnyteam.sillybunny.runtime

/**
 * `assets/runtime/git-core-links.txt` (P4-T §6): one `<basename><TAB><native filename>` line per Git helper,
 * each line ending in LF. Every helper becomes a `libexec/git-core/<basename>` symlink to the native.
 */
object GitCoreLinks {
    const val MAX_LINKS = 1024
    private const val MAX_NAME = 255

    // A plain file name: no separators, no leading dot or dash, so never ".", "..", hidden or option-like.
    private val BASENAME = Regex("[A-Za-z0-9][A-Za-z0-9_.+-]*")

    /**
     * Parses [text] strictly into helper basename to native filename, in file order. Empty lines, CR,
     * missing or extra fields, duplicates, unsafe names and natives outside [natives] all fail with
     * [RuntimeLayoutException.Reason.LINKS].
     */
    fun parse(text: String, natives: Set<String>): Map<String, String> {
        if (text.isEmpty() || !text.endsWith('\n')) fail()
        val links = LinkedHashMap<String, String>()
        for (line in text.substring(0, text.length - 1).split('\n')) {
            val fields = line.split('\t')
            if (fields.size != 2) fail()
            val (name, native) = fields
            if (name.length > MAX_NAME || !BASENAME.matches(name)) fail()
            if (native !in natives || !RuntimeManifest.NATIVE_NAME.matches(native)) fail()
            if (links.put(name, native) != null || links.size > MAX_LINKS) fail()
        }
        return links
    }

    private fun fail(): Nothing = throw RuntimeLayoutException(RuntimeLayoutException.Reason.LINKS)
}
