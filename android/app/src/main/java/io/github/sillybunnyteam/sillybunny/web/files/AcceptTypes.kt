package io.github.sillybunnyteam.sillybunny.web.files

/** SAF MIME filter for one open request: [type] for `Intent.setType`, [extraMimeTypes] for `EXTRA_MIME_TYPES`. */
internal data class MimeFilter(val type: String, val extraMimeTypes: List<String>)

/**
 * Maps `<input accept>` tokens to a SAF MIME filter (plan §4.5).
 *
 * Only a list made entirely of MIME types filters the picker. A file extension (`.json`), the
 * literal `*.json`, `application/octet-stream`, a wildcard or a malformed token allows every file
 * instead, because SAF filters by provider-reported MIME types and providers often report
 * extension-only files (`.jsonl`, `.charx`, `.settings`) as octet-stream or something unexpected.
 * The page still validates what it receives.
 */
internal object AcceptTypes {
    const val ANY = "*/*"

    // RFC 6838 restricted-name, matched after lowercasing.
    private val mimeName = Regex("[a-z0-9][a-z0-9!#$&^_.+-]{0,126}")

    fun filterFor(acceptTypes: Array<String>?): MimeFilter {
        val tokens = acceptTypes.orEmpty().asSequence()
            .flatMap { it.split(',').asSequence() }
            .map { it.substringBefore(';').trim().lowercase() }
            .filter { it.isNotEmpty() }
            .distinct()
            .toList()
        if (tokens.isEmpty()) return MimeFilter(ANY, emptyList())
        val mimeTypes = tokens.map { token -> filterableMime(token) ?: return MimeFilter(ANY, emptyList()) }
        return if (mimeTypes.size == 1) {
            MimeFilter(mimeTypes.single(), emptyList())
        } else {
            MimeFilter(ANY, mimeTypes)
        }
    }

    /** The token as a MIME filter, or null when it must widen the request to every file. */
    fun filterableMime(token: String): String? {
        val slash = token.indexOf('/')
        if (slash <= 0 || slash != token.lastIndexOf('/')) return null
        val type = token.substring(0, slash)
        val subtype = token.substring(slash + 1)
        if (!mimeName.matches(type)) return null
        if (subtype != "*" && !mimeName.matches(subtype)) return null
        if (token == "application/octet-stream") return null
        return token
    }
}
