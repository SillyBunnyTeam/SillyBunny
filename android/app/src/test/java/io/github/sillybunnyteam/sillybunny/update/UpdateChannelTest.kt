package io.github.sillybunnyteam.sillybunny.update

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class UpdateChannelTest {
    @get:Rule
    val temporary = TemporaryFolder()

    @Test
    fun followsUpstreamRatherThanTheLocalBranchName() {
        val checkout = checkout(local = "release", merge = "staging")
        assertEquals("staging", UpdateChannel.trackedBranch(checkout, "release"))
        write(checkout, "HEAD", "ref: refs/heads/local-development\n")
        write(checkout, "config", config(local = "local-development", merge = "release"))
        assertEquals("release", UpdateChannel.trackedBranch(checkout, "staging"))
    }

    @Test
    fun supportsNonOriginRemotesAndQuotedValuesAndCrLf() {
        val checkout = checkout(local = "feature/android", remote = "fork", merge = "release")
        write(checkout, "HEAD", "ref: refs/heads/feature/android\r\n")
        write(checkout, "config", """
            [core]
                repositoryformatversion = 0
                bare = false
            [REMOTE "fork"] ; upstream mirror
                url = https://example.test/repo.git
                fetch = "+refs/heads/*:refs/remotes/fork/*" # all branches
            [branch "feature/android"]
                remote = "fork"
                merge = "refs/heads/release"
        """.trimIndent().replace("\n", "\r\n"))
        assertEquals("release", UpdateChannel.trackedBranch(checkout, "staging"))
    }

    @Test
    fun resolvesRemoteFetchMappingRatherThanGuessingMergeSuffix() {
        val checkout = checkout(merge = "release", fetch = "+refs/heads/release:refs/remotes/origin/staging")
        assertEquals("staging", UpdateChannel.trackedBranch(checkout, "release"))
        write(checkout, "config", config(merge = "topic/one", fetch = "+refs/heads/topic/*:refs/remotes/origin/review/*"))
        assertEquals("review/one", UpdateChannel.trackedBranch(checkout, "release"))
    }

    @Test
    fun acceptsExactlyOneMatchingFetchDestination() {
        val checkout = checkout()
        write(checkout, "config", config() + """

            [remote "origin"]
                fetch = +refs/tags/*:refs/tags/*
        """.trimIndent())
        assertEquals("release", UpdateChannel.trackedBranch(checkout, "staging"))
        write(checkout, "config", config() + """

            [remote "origin"]
                fetch = +refs/heads/release:refs/remotes/origin/other
        """.trimIndent())
        assertEquals("fallback", UpdateChannel.trackedBranch(checkout, "fallback"))
    }

    @Test
    fun fallsBackForDetachedMissingOrUnusualHead() {
        val checkout = checkout()
        val fallback = "staging"
        for (head in listOf(
            "deadbeef1234567890123456789012345678901234\n", "", "ref: refs/tags/v1\n",
            "ref: refs/heads/release\nextra", "ref: refs/heads/../release", "ref: refs/heads/.hidden",
            "ref: refs/heads/release.lock", "ref: refs/heads/release ", "ref: refs/heads/release@{1}",
            "ref: refs/heads/release\r", "ref: refs/heads/release\n\r\n",
            "ref: refs/heads/a\\b", "ref: refs/heads/a//b", "x".repeat(4_097),
        )) {
            write(checkout, "HEAD", head)
            assertEquals(head.take(60), fallback, UpdateChannel.trackedBranch(checkout, fallback))
        }
        File(checkout, ".git/HEAD").delete()
        assertEquals(fallback, UpdateChannel.trackedBranch(checkout, fallback))
        assertEquals(fallback, UpdateChannel.trackedBranch(temporary.newFolder(), fallback))
    }

    @Test
    fun doesNotInterpretWorktreeGitdirFiles() {
        val checkout = temporary.newFolder()
        File(checkout, ".git").writeText("gitdir: /elsewhere/private\n")
        assertEquals("release", UpdateChannel.trackedBranch(checkout, "release"))
    }

    @Test
    fun fallsBackOnMissingDuplicateInvalidOrIncludedConfig() {
        val checkout = checkout()
        val configs = listOf(
            "", "broken", "remote = origin", "[branch release]\nremote=origin",
            config().replace("remote = origin", "remote = ."),
            config().replace("remote = origin", "remote = origin\nremote = fork"),
            config().replace("merge = refs/heads/release", "merge = refs/heads/release\nmerge = refs/heads/staging"),
            config().replace("merge = refs/heads/release", "merge = \"refs/heads/release \""),
            config().replace("merge = refs/heads/release", "merge = refs/tags/release"),
            config().replace("merge = refs/heads/release", "merge = refs/heads/a..b"),
            config().replace("remote = origin", "remote = \"origin"),
            config().replace("fetch = +refs/heads/*:refs/remotes/origin/*", "fetch = +refs/heads/staging:refs/remotes/origin/staging"),
            config().replace("fetch = +refs/heads/*:refs/remotes/origin/*", "fetch = +refs/heads/*:refs/remotes/origin/release"),
            config().replace("fetch = +refs/heads/*:refs/remotes/origin/*", "fetch = +refs/heads/**:refs/remotes/origin/**"),
            config().replace("fetch = +refs/heads/*:refs/remotes/origin/*", "fetch = +refs/heads/*:refs/remotes/other/*"),
            config() + "\n[include]\npath = extra.conf\n",
            config() + "\n[includeIf \"gitdir:somewhere/\"]\npath = extra.conf\n",
            config() + "\n[extensions]\nworktreeConfig = true\n",
            config() + "\n#" + "x".repeat(512 * 1024),
            config().replace("remote = origin", "remote = ori\\\ngin"),
        )
        for (text in configs) {
            write(checkout, "config", text)
            assertEquals(text.takeLast(100), "fallback", UpdateChannel.trackedBranch(checkout, "fallback"))
        }
        File(checkout, ".git/config").delete()
        assertEquals("release", UpdateChannel.trackedBranch(checkout, "release"))
    }

    @Test
    fun honorsNegativeRefspecAndRejectsUnfetchableMerge() {
        val checkout = checkout()
        write(checkout, "config", config() + "\n[remote \"origin\"]\nfetch = ^refs/heads/release\n")
        assertEquals("staging", UpdateChannel.trackedBranch(checkout, "staging"))
        write(checkout, "config", config() + "\n[remote \"origin\"]\nfetch = ^refs/heads/private/*\n")
        assertEquals("release", UpdateChannel.trackedBranch(checkout, "staging"))
    }

    private fun checkout(
        local: String = "release",
        remote: String = "origin",
        merge: String = "release",
        fetch: String = "+refs/heads/*:refs/remotes/$remote/*",
    ): File = temporary.newFolder().also {
        File(it, ".git").mkdir()
        write(it, "HEAD", "ref: refs/heads/$local\n")
        write(it, "config", config(local, remote, merge, fetch))
    }

    private fun config(
        local: String = "release",
        remote: String = "origin",
        merge: String = "release",
        fetch: String = "+refs/heads/*:refs/remotes/$remote/*",
    ): String = """
        [remote "$remote"]
            url = https://example.test/repo.git
            fetch = $fetch
        [branch "$local"]
            remote = $remote
            merge = refs/heads/$merge
    """.trimIndent()

    private fun write(checkout: File, name: String, text: String) {
        File(checkout, ".git/$name").writeText(text)
    }
}
