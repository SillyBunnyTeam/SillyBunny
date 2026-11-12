package io.github.sillybunnyteam.sillybunny.repair

import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.Paths
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/** The installer mirrors: `read_data_root`, its relative-root refusal and `is_sillybunny_dir`. */
class RepairChecksTest {
    @get:Rule
    val temporary = TemporaryFolder()

    @Test
    fun dataRootIsReadExactlyAsTheInstallerReadsIt() {
        // Each expected value is what scripts/bootstrap/install.sh's read_data_root prints for the same text.
        for ((text, expected) in DATA_ROOT_CASES) {
            assertEquals("config ${text.replace("\n", "\\n").replace("\r", "\\r")}", expected, DataRoot.parse(text))
        }
    }

    @Test
    fun aMissingOrNonRegularConfigMeansTheDefaultRoot() {
        val checkout = temporary.newFolder("checkout")
        assertEquals(DataRoot.DEFAULT, DataRoot.read(checkout))
        File(checkout, "config.yaml").mkdir()
        assertEquals(DataRoot.DEFAULT, DataRoot.read(checkout))
    }

    @Test
    fun aSymlinkedConfigIsFollowedLikeTheInstallersRegularFileTest() {
        val checkout = temporary.newFolder("checkout")
        val elsewhere = temporary.newFile("elsewhere.yaml").apply { writeText("dataRoot: /followed\n") }
        Files.createSymbolicLink(File(checkout, "config.yaml").toPath(), elsewhere.toPath())
        assertEquals("/followed", DataRoot.read(checkout))
    }

    @Test
    fun aConfigWhoseReadingCannotBePredictedIsRefused() {
        val checkout = temporary.newFolder("checkout")
        val config = File(checkout, "config.yaml")
        config.writeBytes(byteArrayOf('d'.code.toByte(), 0xC3.toByte(), 0x28))
        assertThrows(IOException::class.java) { DataRoot.read(checkout) }
        config.writeText("dataRoot: /a\u0000b\n")
        assertThrows(IOException::class.java) { DataRoot.read(checkout) }
        config.writeText("x".repeat(8 * 1024 * 1024 + 1))
        assertThrows(IOException::class.java) { DataRoot.read(checkout) }
    }

    @Test
    fun onlyRelativeRootsTheInstallerRefusesEscapeTheCheckout() {
        for (root in listOf("data/../x", "../x", "./../x", "./", "a/..", "data/../../elsewhere")) {
            assertTrue(root, DataRoot.escapesCheckout(root))
        }
        for (root in listOf("./data", "data", ".", "a..b", "././x", "data/..x", "...", "data/nested")) {
            assertFalse(root, DataRoot.escapesCheckout(root))
        }
        assertTrue(DataRoot.isAbsolute("/abs"))
        assertFalse(DataRoot.isAbsolute("\"/quoted"))
        assertFalse(DataRoot.isAbsolute(" /space"))
    }

    @Test
    fun containmentComparesPathComponentsNeverStringPrefixes() {
        val files = temporary.newFolder("files").toPath()
        val checkout = Files.createDirectory(files.resolve("SillyBunny"))
        assertTrue(PathContainment.isWithin(checkout, checkout))
        assertTrue(PathContainment.isWithin(checkout.resolve("data/default-user"), checkout))
        assertTrue(PathContainment.isWithin(files.resolve("./SillyBunny/./data"), checkout))
        assertFalse(PathContainment.isWithin(files.resolve("SillyBunny2/data"), checkout))
        assertFalse(PathContainment.isWithin(files.resolve("SillyBunny.broken-20261020T000000Z"), checkout))
        assertFalse(PathContainment.isWithin(files, checkout))
        // A path that passes through the checkout counts, even if it climbs back out.
        assertTrue(PathContainment.isWithin(checkout.resolve("../elsewhere"), checkout))
        // A symlink outside the checkout that leads into it counts; one leading away does not.
        val inward = Files.createSymbolicLink(files.resolve("inward"), checkout.resolve("data").also { Files.createDirectory(it) })
        assertTrue(PathContainment.isWithin(inward.resolve("chats"), checkout))
        val outward = Files.createSymbolicLink(checkout.resolve("outward"), Files.createDirectory(files.resolve("away")))
        assertTrue(PathContainment.isWithin(outward, checkout))
        assertFalse(PathContainment.isWithin(files.resolve("away/inside"), checkout))
    }

    @Test
    fun aSillyBunnyFolderIsRecognisedAsTheInstallerDoes() {
        val dir = temporary.newFolder("candidate")
        val manifest = File(dir, "package.json")
        assertFalse(CheckoutChecks.isSillyBunny(dir))
        for (text in listOf(
            "{\"name\":\"sillybunny\"}",
            "{\n  \"name\" :\t \"sillybunny\",\r\n  \"version\": \"1\"\n}",
            "{\"other\": 1,\n\"name\":\"sillybunny\"}",
        )) {
            manifest.writeText(text)
            assertTrue(text, CheckoutChecks.isSillyBunny(dir))
        }
        for (text in listOf(
            "{\"name\":\"sillybunny-extension\"}",
            "{\"name\":\n\"sillybunny\"}",
            "{\"Name\":\"sillybunny\"}",
            "{\"name\":\"SillyBunny\"}",
        )) {
            manifest.writeText(text)
            assertFalse(text, CheckoutChecks.isSillyBunny(dir))
        }
        manifest.delete()
        manifest.mkdir()
        assertFalse(CheckoutChecks.isSillyBunny(dir))
        manifest.delete()
        val target = temporary.newFile("package.json").apply { writeText("{\"name\":\"sillybunny\"}") }
        Files.createSymbolicLink(manifest.toPath(), target.toPath())
        assertTrue(CheckoutChecks.isSillyBunny(dir))
    }

    @Test
    fun aGitCheckoutNeedsARealGitDirectoryWithAHeadFile() {
        val dir = temporary.newFolder("checkout")
        assertFalse(CheckoutChecks.isGitCheckout(dir))
        File(dir, ".git/HEAD").mkdirs()
        assertFalse(CheckoutChecks.isGitCheckout(dir))
        File(dir, ".git/HEAD").delete()
        File(dir, ".git/HEAD").writeText("ref: refs/heads/release\n")
        assertTrue(CheckoutChecks.isGitCheckout(dir))

        val linked = temporary.newFolder("linked")
        Files.createSymbolicLink(linked.toPath().resolve(".git"), File(dir, ".git").toPath())
        assertFalse(CheckoutChecks.isGitCheckout(linked))
        val linkedCheckout = Files.createSymbolicLink(temporary.root.toPath().resolve("alias"), dir.toPath())
        assertFalse(CheckoutChecks.isGitCheckout(linkedCheckout.toFile()))
        assertFalse(CheckoutChecks.isGitCheckout(Paths.get(dir.path, "missing").toFile()))
    }

    companion object {
        /** Config text to the value read_data_root prints; verified against the script itself (p59 report). */
        val DATA_ROOT_CASES = listOf(
            "dataRoot: ./data\n" to "./data",
            "dataRoot: /abs/path\n" to "/abs/path",
            "dataRoot: \"/abs/quoted\"\n" to "/abs/quoted",
            "dataRoot: '/abs/single'\n" to "/abs/single",
            "dataRoot: /abs # comment\n" to "/abs",
            "dataRoot:/nospace\n" to "/nospace",
            "dataRoot:\t \t./tabs  \n" to "./tabs",
            "dataRoot: ./crlf\r\n" to "./crlf",
            "dataRoot: ./x # c\r\n" to "./x",
            "dataRoot: \r\n" to "./data",
            "  dataRoot: /indented\n" to "./data",
            "# dataRoot: /commented\ndataRoot: ./real\n" to "./real",
            "dataRoot: ./first\ndataRoot: ./second\n" to "./first",
            "dataRoot:\n" to "./data",
            "dataRoot: \"\"\n" to "./data",
            "dataRoot: \"\n" to "./data",
            "dataRoot: #only a comment\n" to "./data",
            "dataRoot: 'mixed\"\n" to "mixed",
            "dataRoot: \"/abs with space\" \n" to "/abs with space",
            "dataRoot: '\"/double'\n" to "\"/double",
            "dataRoot:\t\"./q\"\t# c\n" to "./q",
            "DataRoot: /x\n" to "./data",
            "listen: false\ndataRoot: ./data/../..\nport: 8000\n" to "./data/../..",
            "dataRoot: /last" to "/last",
            "port: 8000\n" to "./data",
            "" to "./data",
        )
    }
}
