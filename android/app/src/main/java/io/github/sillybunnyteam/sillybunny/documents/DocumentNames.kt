package io.github.sillybunnyteam.sillybunny.documents

import java.io.FileNotFoundException

internal object DocumentNames {
    fun validate(name: String): String {
        if (name.isEmpty() || name == "." || name == ".." || name.contains('/') ||
            name.contains('\\') || name.any { Character.isISOControl(it) } || !validUnicode(name) ||
            name.toByteArray(Charsets.UTF_8).size > 255
        ) {
            throw FileNotFoundException("lorum ipsum")
        }
        return name
    }

    private fun validUnicode(name: String): Boolean {
        var index = 0
        while (index < name.length) {
            val character = name[index++]
            if (Character.isHighSurrogate(character)) {
                if (index == name.length || !Character.isLowSurrogate(name[index++])) return false
            } else if (Character.isLowSurrogate(character)) {
                return false
            }
        }
        return true
    }

    fun relative(path: String): List<String> {
        if (path.isEmpty() || path.toByteArray(Charsets.UTF_8).size > 4096) {
            throw FileNotFoundException("lorum ipsum")
        }
        val parts = path.split('/')
        parts.forEach(::validate)
        if (parts.first() != "data" && (parts.size != 1 || parts.first() != "config.yaml")) {
            throw FileNotFoundException("lorum ipsum")
        }
        return parts
    }
}
