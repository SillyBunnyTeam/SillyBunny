package io.github.sillybunnyteam.sillybunny.server

import java.security.SecureRandom

/**
 * Launch tokens (plan §3.3): 32 `SecureRandom` bytes as lowercase hex, new for every server process the
 * app starts. Callers keep the value out of logs, exceptions, notifications and intents.
 */
internal object LaunchTokens {
    const val BYTES = 32

    private val pattern = Regex("[0-9a-f]{${BYTES * 2}}")
    private val secureRandom = SecureRandom()
    private val digits = "0123456789abcdef".toCharArray()

    fun generate(random: SecureRandom = secureRandom): String {
        val bytes = ByteArray(BYTES)
        random.nextBytes(bytes)
        val text = CharArray(BYTES * 2)
        bytes.forEachIndexed { index, value ->
            val unsigned = value.toInt() and 0xff
            text[index * 2] = digits[unsigned ushr 4]
            text[index * 2 + 1] = digits[unsigned and 0x0f]
        }
        bytes.fill(0)
        return String(text)
    }

    fun isValid(token: String): Boolean = pattern.matches(token)
}
