package io.github.sillybunnyteam.sillybunny.runtime

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class GitCoreLinksTest {
    private val natives = setOf("libgit.so", "libgit-remote-http.so", "libngtcp2_crypto_ossl.so")

    @Test
    fun parsesTheTabSeparatedMapInOrder() {
        val links = GitCoreLinks.parse(
            "git\tlibgit.so\ngit-remote-http\tlibgit-remote-http.so\ngit-remote-https\tlibgit-remote-http.so\n" +
                "git-credential-cache--daemon\tlibgit.so\ngit_odd+name.1\tlibngtcp2_crypto_ossl.so\n",
            natives,
        )
        assertEquals(
            listOf("git", "git-remote-http", "git-remote-https", "git-credential-cache--daemon", "git_odd+name.1"),
            links.keys.toList(),
        )
        assertEquals("libgit-remote-http.so", links.getValue("git-remote-https"))
    }

    @Test
    fun rejectsHostileLines() {
        listOf(
            "",
            "git\tlibgit.so",
            "\n",
            "git\tlibgit.so\n\ngit-add\tlibgit.so\n",
            "git\tlibgit.so\r\n",
            "git libgit.so\n",
            "git\tlibgit.so\textra\n",
            "git\t\n",
            "\tlibgit.so\n",
            "../git\tlibgit.so\n",
            "sub/git\tlibgit.so\n",
            ".\tlibgit.so\n",
            "..\tlibgit.so\n",
            ".hidden\tlibgit.so\n",
            "-option\tlibgit.so\n",
            "git\u0000\tlibgit.so\n",
            "gi t\tlibgit.so\n",
            "gït\tlibgit.so\n",
            " git\tlibgit.so\n",
            "git\t libgit.so\n",
            "git\tlibmissing.so\n",
            "git\t../libgit.so\n",
            "git\t/system/lib64/libc.so\n",
            "git\tlibgit.so\ngit\tlibgit-remote-http.so\n",
            "x".repeat(256) + "\tlibgit.so\n",
        ).forEach { text ->
            val error = assertThrows(text, RuntimeLayoutException::class.java) { GitCoreLinks.parse(text, natives) }
            assertEquals(text, RuntimeLayoutException.Reason.LINKS, error.reason)
        }
    }

    @Test
    fun rejectsNativesThatAreNotPackagedLibraries() {
        // Even a listed native must look like an extracted library name.
        val odd = setOf("libgit.so", "git", "libgit.so.2")
        assertThrows(RuntimeLayoutException::class.java) { GitCoreLinks.parse("git\tgit\n", odd) }
        assertThrows(RuntimeLayoutException::class.java) { GitCoreLinks.parse("git\tlibgit.so.2\n", odd) }
    }

    @Test
    fun boundsTheNumberOfLinks() {
        val atLimit = (1..GitCoreLinks.MAX_LINKS).joinToString("") { "git-$it\tlibgit.so\n" }
        assertEquals(GitCoreLinks.MAX_LINKS, GitCoreLinks.parse(atLimit, natives).size)
        assertThrows(RuntimeLayoutException::class.java) {
            GitCoreLinks.parse(atLimit + "git-extra\tlibgit.so\n", natives)
        }
    }
}
