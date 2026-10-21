package io.github.sillybunnyteam.sillybunny.update

import java.io.File
import java.nio.file.Files
import java.nio.file.LinkOption

data class BlockedUpdateStatus(
    val requiredVersionCode: Long? = null,
    val installedVersionCode: Long? = null,
    val reason: String? = null,
    val upstream: String? = null,
    val branch: String? = null,
) {
    companion object {
        private const val MAX_STATUS_BYTES = 65_536
        private val integer = Regex("0|[1-9][0-9]*")

        fun read(filesDir: File): BlockedUpdateStatus? {
            val file = File(filesDir, "status/update-blocked.json")
            if (!file.exists()) return null
            if (!Files.isRegularFile(file.toPath(), LinkOption.NOFOLLOW_LINKS)) return BlockedUpdateStatus()
            return try {
                file.inputStream().use { input ->
                    val bytes = ByteArray(MAX_STATUS_BYTES + 1)
                    var count = 0
                    while (count < bytes.size) {
                        val read = input.read(bytes, count, bytes.size - count)
                        if (read < 0) break
                        count += read
                    }
                    if (count > MAX_STATUS_BYTES) BlockedUpdateStatus() else parse(String(bytes, 0, count, Charsets.UTF_8))
                }
            } catch (_: Exception) {
                BlockedUpdateStatus()
            }
        }

        fun parse(json: String): BlockedUpdateStatus {
            if (json.length > MAX_STATUS_BYTES) return BlockedUpdateStatus()
            return try {
                val value = UpdateJson.parse(json) as? Map<*, *> ?: return BlockedUpdateStatus()
                BlockedUpdateStatus(
                    requiredVersionCode = value.integer("required")?.takeIf { it > 0 },
                    installedVersionCode = value.integer("installed")?.takeIf { it >= 0 },
                    reason = (value["reason"] as? String)?.takeIf { it in setOf("newer", "missing", "invalid") },
                    upstream = value["upstream"] as? String,
                    branch = value["branch"] as? String,
                )
            } catch (_: Exception) {
                BlockedUpdateStatus()
            }
        }

        private fun Map<*, *>.integer(key: String): Long? {
            val literal = (this[key] as? UpdateJson.Number)?.literal ?: return null
            return literal.takeIf(integer::matches)?.toLongOrNull()
        }
    }
}
