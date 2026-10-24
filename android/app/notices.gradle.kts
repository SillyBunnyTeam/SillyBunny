// Android library notices for the SillyBunny APK (plan §2.1, §4.6, §5.3; task 4.5).
//
// generate<Variant>SillyBunnyLibraryNotices writes build/generated/sillybunny/library-notices/<variant>/: the
// android-libraries.json that `android/runtime/notices.py --android-libraries` reads, and the license texts it
// names. It lists every Maven artifact the variant's resolved runtime classpath ships (platforms and Kotlin
// Multiplatform umbrella modules ship no artifact of their own). An artifact's license is its POM's <license>, or
// the nearest parent POM's when its own declares none (Maven inheritance), and must equal one (name, url) pair of
// android/runtime/licenses/android/licenses.json exactly; that file maps the pair to a committed text and its
// SHA-256. The source URL is the https <url> or git <connection> of the nearest POM that declares an <scm>.
// An artifact without a POM, a license or an https source URL, or with an unlisted license or several licenses,
// fails the build: nothing is guessed. Gradle resolves the POMs from the build's own repositories; license texts
// are committed, never downloaded. runtime-packaging.gradle.kts hands the output to notices.py.
//
// verifySillyBunnyLibraryNotices runs the same code over fixture POMs and checks the committed table. Every
// generate task depends on it, and so does `check`.

import groovy.json.JsonSlurper
import java.io.File
import java.net.URI
import java.net.URISyntaxException
import java.security.MessageDigest
import java.util.Locale
import javax.xml.XMLConstants
import javax.xml.parsers.DocumentBuilderFactory
import org.codehaus.groovy.runtime.InvokerHelper
import org.gradle.api.artifacts.component.ModuleComponentIdentifier
import org.gradle.api.artifacts.component.ProjectComponentIdentifier
import org.gradle.api.artifacts.result.ResolvedArtifactResult
import org.gradle.maven.MavenModule
import org.gradle.maven.MavenPomArtifact
import org.w3c.dom.Element
import org.xml.sax.ErrorHandler
import org.xml.sax.SAXParseException

/** Finds the POM of one `group:module:version`, or returns null when no repository has it. */
fun interface PomLookup {
    fun pom(coordinates: String): File?
}

/** One POM <license>, as written (trimmed). */
data class PomLicense(val name: String?, val url: String?)

/** A license the build accepts: the exact POM (name, url) pairs that mean it, and the committed text it shows. */
class KnownLicense(val spdx: String, val text: File, val pairs: Set<PomLicense>)

/** One entry of android-libraries.json. */
data class LibraryNotice(val name: String, val version: String, val spdx: String, val sourceUrl: String, val text: File)

/** The android-libraries.json rules, shared by the generate and verify tasks. */
object LibraryNotices {
    const val FILE = "android-libraries.json"

    // Texts are listed under their committed path, as notices.py lists its npm license supplements.
    const val TEXT_DIRECTORY = "android/runtime/licenses/android"
    private const val MAX_PARENTS = 16
    private val COORDINATE = Regex("[A-Za-z0-9][A-Za-z0-9._-]*")
    private val TEXT_NAME = Regex("[A-Za-z0-9][A-Za-z0-9._-]*")
    private val SHA256 = Regex("[0-9a-f]{64}")

    private class Pom(
        val coordinates: String,
        val parent: String?,
        val licenses: List<PomLicense>,
        val scm: Boolean,
        val scmUrl: String?,
        val scmConnection: String?,
    )

    /** The licenses in [table] (licenses.json); each text lies beside it and must match its recorded SHA-256. */
    fun rules(table: File): List<KnownLicense> {
        val document = JsonSlurper().parse(table) as? Map<*, *>
        val entries = document?.get("licenses") as? List<*>
        if (document?.get("schema") != 1 || entries.isNullOrEmpty()) {
            throw GradleException("$table: schema 1 with a non-empty \"licenses\" list expected.")
        }
        val rules = entries.mapIndexed { index, item ->
            val entry = item as? Map<*, *> ?: throw GradleException("$table: licenses[$index] must be an object.")
            val spdx = entry["spdx"] as? String
            val name = entry["file"] as? String
            val sha256 = entry["sha256"] as? String
            val pairs = (entry["pom"] as? List<*>).orEmpty().map { pair ->
                val value = pair as? Map<*, *> ?: throw GradleException("$table: licenses[$index].pom entries must be objects.")
                PomLicense(value["name"] as? String, value["url"] as? String)
            }
            if (spdx.isNullOrBlank() || name == null || !TEXT_NAME.matches(name) || sha256 == null || !SHA256.matches(sha256) ||
                pairs.isEmpty() || pairs.any { it.name.isNullOrBlank() }
            ) {
                throw GradleException("$table: licenses[$index] needs spdx, file, a lowercase sha256 and named pom pairs.")
            }
            val text = File(table.parentFile, name)
            if (!text.isFile || sha256(text) != sha256) {
                throw GradleException("$text does not match the SHA-256 that $table records for it.")
            }
            KnownLicense(spdx, text, pairs.toSet())
        }
        val pairs = rules.flatMap { it.pairs }
        val repeated = pairs.groupingBy { it }.eachCount().filterValues { it > 1 }.keys
        if (repeated.isNotEmpty()) throw GradleException("$table lists a POM license more than once: $repeated")
        return rules
    }

    /**
     * The android-libraries.json entries for [components] (`group:module:version`). [others] names shipped
     * artifacts that come from no Maven module. Fails once, listing every problem.
     */
    fun libraries(components: List<String>, others: List<String>, lookup: PomLookup, rules: List<KnownLicense>): List<LibraryNotice> {
        val problems = others.map { "$it: not a Maven artifact, so no POM declares its license" }.toMutableList()
        val known = rules.flatMap { rule -> rule.pairs.map { it to rule } }.toMap()
        val result = components.sorted().mapNotNull { coordinates ->
            val parts = coordinates.split(':')
            if (parts.size != 3 || !COORDINATE.matches(parts[0]) || !COORDINATE.matches(parts[1]) || parts[2].isBlank() ||
                parts[2] != parts[2].trim()
            ) {
                problems += "$coordinates: not group:module:version coordinates"
                return@mapNotNull null
            }
            val chain = try {
                chain(coordinates, lookup)
            } catch (error: GradleException) {
                problems += error.message.orEmpty()
                return@mapNotNull null
            }
            val declaring = chain.firstOrNull { it.licenses.isNotEmpty() }
            val license = when {
                declaring == null -> {
                    problems += "$coordinates: no license in its POM or any parent POM (${chain.joinToString { it.coordinates }})"
                    null
                }
                declaring.licenses.size > 1 -> {
                    problems += "$coordinates: ${declaring.coordinates} declares ${declaring.licenses.size} licenses " +
                        "${declaring.licenses}; one is expected"
                    null
                }
                else -> known[declaring.licenses.single()] ?: run {
                    problems += "$coordinates: unknown license ${declaring.licenses.single()} (from ${declaring.coordinates}); " +
                        "add its exact name and url to android/runtime/licenses/android/licenses.json with its text"
                    null
                }
            }
            val sourceUrl = sourceUrl(coordinates, chain, problems)
            if (license == null || sourceUrl == null) return@mapNotNull null
            LibraryNotice("${parts[0]}:${parts[1]}", parts[2], license.spdx, sourceUrl, license.text)
        }
        if (problems.isNotEmpty()) {
            throw GradleException("The Android library notices cannot be generated:" + problems.joinToString("") { "\n  - $it" })
        }
        return result
    }

    /** Writes android-libraries.json and the license texts it names into [output], replacing its contents. */
    fun write(libraries: List<LibraryNotice>, output: File) {
        output.deleteRecursively()
        val texts = File(output, TEXT_DIRECTORY).also { it.mkdirs() }
        libraries.map { it.text }.distinct().forEach { it.copyTo(File(texts, it.name)) }
        val entries = libraries.sortedBy { it.name }.map {
            sortedMapOf(
                "licenses" to listOf("$TEXT_DIRECTORY/${it.text.name}"),
                "name" to it.name,
                "sourceUrl" to it.sourceUrl,
                "spdx" to it.spdx,
                "version" to it.version,
            )
        }
        File(output, FILE).writeText(json(sortedMapOf("libraries" to entries, "schema" to 1)) + "\n")
    }

    // Maven inheritance: the nearest POM that declares <scm> decides; never fall back further, never rewrite http.
    private fun sourceUrl(coordinates: String, chain: List<Pom>, problems: MutableList<String>): String? {
        val pom = chain.firstOrNull { it.scm }
        if (pom == null) {
            problems += "$coordinates: no <scm> in its POM or any parent POM, so no source URL"
            return null
        }
        val candidates = listOfNotNull(pom.scmUrl, pom.scmConnection?.removePrefix("scm:git:"))
        return candidates.firstOrNull(::isHttpsUrl) ?: run {
            problems += "$coordinates: the <scm> of ${pom.coordinates} has no https url or git connection ($candidates)"
            null
        }
    }

    /** The URL rule notices.py applies to sourceUrl. */
    fun isHttpsUrl(value: String): Boolean {
        if (value.isEmpty() || value.any { it.code <= 0x20 || it.code >= 0x7f || it == '\\' }) return false
        val uri = try {
            URI(value)
        } catch (_: URISyntaxException) {
            return false
        }
        return uri.scheme == "https" && !uri.host.isNullOrEmpty() && uri.rawUserInfo == null && uri.rawQuery == null &&
            uri.rawFragment == null && (uri.port == -1 || uri.port == 443)
    }

    private fun chain(coordinates: String, lookup: PomLookup): List<Pom> {
        val chain = mutableListOf<Pom>()
        var next: String? = coordinates
        while (next != null) {
            if (chain.any { it.coordinates == next } || chain.size > MAX_PARENTS) {
                throw GradleException("$coordinates: its parent POMs loop or nest more than $MAX_PARENTS deep")
            }
            val file = lookup.pom(next) ?: throw GradleException("$coordinates: no POM for $next in the build's repositories")
            chain += parse(next, file)
            next = chain.last().parent
        }
        return chain
    }

    private fun parse(coordinates: String, file: File): Pom {
        val factory = DocumentBuilderFactory.newInstance().apply {
            // POMs are downloaded data: no DOCTYPE, so no external entities.
            setFeature("http://apache.org/xml/features/disallow-doctype-decl", true)
            setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true)
            isXIncludeAware = false
            isExpandEntityReferences = false
        }
        val root = try {
            factory.newDocumentBuilder().apply {
                setErrorHandler(object : ErrorHandler {
                    override fun warning(exception: SAXParseException) {}

                    override fun error(exception: SAXParseException) {
                        throw exception
                    }

                    override fun fatalError(exception: SAXParseException) {
                        throw exception
                    }
                })
            }.parse(file).documentElement
        } catch (error: Exception) {
            throw GradleException("$coordinates: $file is not a readable POM (${error.message})")
        }
        val (group, module, version) = coordinates.split(':')
        // groupId and version may be inherited; whatever the POM states must be the coordinates asked for.
        if (root.tagName != "project" || text(root, "artifactId") != module ||
            text(root, "groupId").let { it != null && it != group } || text(root, "version").let { it != null && it != version }
        ) {
            throw GradleException("$coordinates: $file describes another module")
        }
        val parent = child(root, "parent")?.let { element ->
            val values = listOf("groupId", "artifactId", "version").map { text(element, it) }
            values.filterNotNull().takeIf { it.size == 3 }?.joinToString(":")
                ?: throw GradleException("$coordinates: $file has an incomplete <parent>")
        }
        val licenses = child(root, "licenses")?.let { element ->
            children(element, "license").map { PomLicense(text(it, "name"), text(it, "url")) }
        }.orEmpty()
        val scm = child(root, "scm")
        return Pom(coordinates, parent, licenses, scm != null, scm?.let { text(it, "url") }, scm?.let { text(it, "connection") })
    }

    private fun children(element: Element, tag: String): List<Element> {
        val nodes = element.childNodes
        return (0 until nodes.length).mapNotNull { nodes.item(it) as? Element }.filter { it.tagName == tag }
    }

    private fun child(element: Element, tag: String): Element? = children(element, tag).firstOrNull()

    private fun text(element: Element, tag: String): String? = child(element, tag)?.textContent?.trim()?.takeIf { it.isNotEmpty() }

    fun sha256(file: File): String =
        MessageDigest.getInstance("SHA-256").digest(file.readBytes()).joinToString("") { "%02x".format(Locale.ROOT, it) }

    fun json(value: Any?, indent: String = ""): String = when (value) {
        is String -> buildString {
            append('"')
            value.forEach { character ->
                when {
                    character == '"' -> append("\\\"")
                    character == '\\' -> append("\\\\")
                    character.code < 0x20 || character.code > 0x7e -> append("\\u%04x".format(Locale.ROOT, character.code))
                    else -> append(character)
                }
            }
            append('"')
        }
        is Int -> value.toString()
        is Map<*, *> -> value.entries.joinToString(",\n", "{\n", "\n$indent}") {
            "$indent    ${json(it.key.toString())}: ${json(it.value, "$indent    ")}"
        }
        is List<*> -> if (value.isEmpty()) "[]" else value.joinToString(",\n", "[\n", "\n$indent]") { "$indent    ${json(it, "$indent    ")}" }
        else -> throw GradleException("Unsupported value ${value?.let { it::class }} in $FILE.")
    }
}

/** Writes the variant's android-libraries.json and license texts (see the header). */
abstract class GenerateSillyBunnyLibraryNotices : DefaultTask() {
    /** `group:module:version` of every Maven module whose artifacts the variant ships, sorted. */
    @get:Input
    abstract val components: ListProperty<String>

    /** Shipped artifacts of no Maven module (local files); each one fails the task. */
    @get:Input
    abstract val otherArtifacts: ListProperty<String>

    @get:InputFile
    @get:PathSensitive(PathSensitivity.NONE)
    abstract val rules: RegularFileProperty

    @get:InputDirectory
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val texts: DirectoryProperty

    @get:Internal
    abstract val poms: Property<PomLookup>

    @get:OutputDirectory
    abstract val output: DirectoryProperty

    @TaskAction
    fun generate() {
        val libraries = LibraryNotices.libraries(components.get(), otherArtifacts.get(), poms.get(), LibraryNotices.rules(rules.get().asFile))
        LibraryNotices.write(libraries, output.get().asFile)
        logger.info("SillyBunny notices: ${libraries.size} Android libraries in ${output.get().asFile}")
    }
}

/** Checks the generator against fixture POMs and the committed license table. */
abstract class VerifySillyBunnyLibraryNotices : DefaultTask() {
    @get:InputFile
    @get:PathSensitive(PathSensitivity.NONE)
    abstract val rules: RegularFileProperty

    @get:InputDirectory
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val texts: DirectoryProperty

    @get:OutputFile
    abstract val report: RegularFileProperty

    @TaskAction
    fun verify() {
        val work = temporaryDir.also { it.deleteRecursively(); it.mkdirs() }
        val table = rules.get().asFile
        val known = LibraryNotices.rules(table)
        val apache = known.single { it.spdx == "Apache-2.0" }
        val apacheLicense = "The Apache Software License, Version 2.0" to "http://www.apache.org/licenses/LICENSE-2.0.txt"
        val poms = mapOf(
            "fixture:plain:1.0" to pom("fixture", "plain", "1.0", licenses = listOf(apacheLicense), scmUrl = "https://example.com/plain"),
            "fixture:child:1.0" to pom(null, "child", null, parent = "fixture:parent:2"),
            "fixture:parent:2" to pom("fixture", "parent", "2", licenses = listOf(apacheLicense), scmUrl = "https://example.com/parent"),
            "fixture:connection:1.0" to pom(
                "fixture", "connection", "1.0", licenses = listOf(apacheLicense),
                scmUrl = "http://example.com/connection", scmConnection = "scm:git:https://example.com/connection.git",
            ),
            "fixture:none:1.0" to pom("fixture", "none", "1.0", parent = "fixture:bare:1", scmUrl = "https://example.com/none"),
            "fixture:bare:1" to pom("fixture", "bare", "1"),
            "fixture:unknown:1.0" to pom(
                "fixture", "unknown", "1.0", scmUrl = "https://example.com/unknown",
                licenses = listOf("GNU General Public License v3.0" to "https://www.gnu.org/licenses/gpl-3.0.txt"),
            ),
            "fixture:near:1.0" to pom(
                "fixture", "near", "1.0", scmUrl = "https://example.com/near",
                licenses = listOf("The Apache Software License, Version 2.0" to "https://www.apache.org/licenses/LICENSE-2.0"),
            ),
            "fixture:two:1.0" to pom(
                "fixture", "two", "1.0", scmUrl = "https://example.com/two",
                licenses = listOf(apacheLicense, "MIT" to "https://opensource.org/licenses/MIT"),
            ),
            "fixture:nosource:1.0" to pom("fixture", "nosource", "1.0", licenses = listOf(apacheLicense)),
            "fixture:httpscm:1.0" to pom(
                "fixture", "httpscm", "1.0", parent = "fixture:parent:2", licenses = listOf(apacheLicense),
                scmUrl = "http://example.com/httpscm",
            ),
            "fixture:loop:1.0" to pom("fixture", "loop", "1.0", parent = "fixture:loop:1.0"),
            "fixture:doctype:1.0" to "<?xml version=\"1.0\"?>\n<!DOCTYPE project [<!ENTITY name SYSTEM \"file:///etc/hostname\">]>\n" +
                pom("fixture", "doctype", "1.0", licenses = listOf("&name;" to "https://example.com"), scmUrl = "https://example.com/d"),
            "fixture:mismatch:1.0" to pom("fixture", "other", "1.0", licenses = listOf(apacheLicense), scmUrl = "https://example.com/m"),
        ).mapValues { (coordinates, contents) -> File(work, "$coordinates.pom".replace(':', '_')).apply { writeText(contents) } }
        val lookup = PomLookup { poms[it] }
        val lines = mutableListOf<String>()
        fun expect(case: String, condition: Boolean) {
            lines += (if (condition) "ok   " else "FAIL ") + case
        }

        val good = LibraryNotices.libraries(listOf("fixture:plain:1.0", "fixture:child:1.0", "fixture:connection:1.0"), emptyList(), lookup, known)
        val output = File(work, "output")
        LibraryNotices.write(good, output)
        val expected = """
            {
                "libraries": [
                    {
                        "licenses": [
                            "android/runtime/licenses/android/LICENSE-2.0.txt"
                        ],
                        "name": "fixture:child",
                        "sourceUrl": "https://example.com/parent",
                        "spdx": "Apache-2.0",
                        "version": "1.0"
                    },
                    {
                        "licenses": [
                            "android/runtime/licenses/android/LICENSE-2.0.txt"
                        ],
                        "name": "fixture:connection",
                        "sourceUrl": "https://example.com/connection.git",
                        "spdx": "Apache-2.0",
                        "version": "1.0"
                    },
                    {
                        "licenses": [
                            "android/runtime/licenses/android/LICENSE-2.0.txt"
                        ],
                        "name": "fixture:plain",
                        "sourceUrl": "https://example.com/plain",
                        "spdx": "Apache-2.0",
                        "version": "1.0"
                    }
                ],
                "schema": 1
            }
        """.trimIndent() + "\n"
        expect("known licenses, a parent's license and scm, an https git connection", File(output, LibraryNotices.FILE).readText() == expected)
        expect(
            "the committed text is copied under its committed path",
            File(output, "${LibraryNotices.TEXT_DIRECTORY}/LICENSE-2.0.txt").readBytes().contentEquals(apache.text.readBytes()),
        )
        val failures = listOf(
            Triple("no license anywhere", listOf("fixture:none:1.0"), "fixture:none:1.0: no license"),
            Triple("an unlisted license", listOf("fixture:unknown:1.0"), "fixture:unknown:1.0: unknown license"),
            Triple("a listed name with another url", listOf("fixture:near:1.0"), "fixture:near:1.0: unknown license"),
            Triple("several licenses", listOf("fixture:two:1.0"), "fixture:two:1.0: fixture:two:1.0 declares 2 licenses"),
            Triple("no scm", listOf("fixture:nosource:1.0"), "fixture:nosource:1.0: no <scm>"),
            Triple("an http-only scm is not replaced by a parent's", listOf("fixture:httpscm:1.0"), "fixture:httpscm:1.0: the <scm> of fixture:httpscm:1.0"),
            Triple("no POM", listOf("fixture:missing:1.0"), "fixture:missing:1.0: no POM"),
            Triple("a parent loop", listOf("fixture:loop:1.0"), "fixture:loop:1.0: its parent POMs loop"),
            Triple("a DOCTYPE", listOf("fixture:doctype:1.0"), "is not a readable POM"),
            Triple("a POM of another module", listOf("fixture:mismatch:1.0"), "describes another module"),
            Triple("malformed coordinates", listOf("fixture:plain"), "fixture:plain: not group:module:version"),
        )
        failures.forEach { (case, components, message) ->
            val error = runCatching { LibraryNotices.libraries(components, emptyList(), lookup, known) }.exceptionOrNull()
            expect("$case fails", error is GradleException && message in error.message.orEmpty())
        }
        val local = runCatching { LibraryNotices.libraries(listOf("fixture:plain:1.0"), listOf("libs/local.jar"), lookup, known) }.exceptionOrNull()
        expect("a local file fails", local is GradleException && "libs/local.jar: not a Maven artifact" in local.message.orEmpty())
        val all = runCatching { LibraryNotices.libraries(listOf("fixture:none:1.0", "fixture:two:1.0"), emptyList(), lookup, known) }.exceptionOrNull()
        expect("every problem is listed", all is GradleException && "fixture:none:1.0" in all.message.orEmpty() && "fixture:two:1.0" in all.message.orEmpty())

        val tampered = File(work, "tables/licenses.json").apply {
            parentFile.mkdirs()
            writeText(table.readText().replace(LibraryNotices.sha256(apache.text), "0".repeat(64)))
        }
        apache.text.copyTo(File(tampered.parentFile, apache.text.name))
        expect("a text that does not match its SHA-256 fails", runCatching { LibraryNotices.rules(tampered) }.exceptionOrNull() is GradleException)
        expect("https URLs only", listOf("https://a.example/x", "https://a.example:443/x").all(LibraryNotices::isHttpsUrl) &&
            listOf("http://a.example", "https://a.example/x#y", "https://a.example/?q", "https://u@a.example", "https://a.example:8443", "https://a.example/ x")
                .none(LibraryNotices::isHttpsUrl))

        report.get().asFile.apply {
            parentFile.mkdirs()
            writeText(lines.joinToString("\n", postfix = "\n"))
        }
        val failed = lines.filter { it.startsWith("FAIL") }
        if (failed.isNotEmpty()) throw GradleException("The Android library notices generator failed its checks:\n" + failed.joinToString("\n"))
        logger.lifecycle("SillyBunny notices: the library notices generator passed ${lines.size} checks (${report.get().asFile})")
    }

    private fun pom(
        group: String?,
        artifact: String,
        version: String?,
        parent: String? = null,
        licenses: List<Pair<String, String>> = emptyList(),
        scmUrl: String? = null,
        scmConnection: String? = null,
    ): String = buildString {
        append("<project xmlns=\"http://maven.apache.org/POM/4.0.0\">\n")
        parent?.split(':')?.let { (g, a, v) -> append("  <parent><groupId>$g</groupId><artifactId>$a</artifactId><version>$v</version></parent>\n") }
        group?.let { append("  <groupId>$it</groupId>\n") }
        append("  <artifactId>$artifact</artifactId>\n")
        version?.let { append("  <version>$it</version>\n") }
        if (licenses.isNotEmpty()) {
            append("  <licenses>\n")
            licenses.forEach { (name, url) -> append("    <license>\n      <name>$name</name>\n      <url>$url</url>\n    </license>\n") }
            append("  </licenses>\n")
        }
        if (scmUrl != null || scmConnection != null) {
            append("  <scm>")
            scmUrl?.let { append("<url>$it</url>") }
            scmConnection?.let { append("<connection>$it</connection>") }
            append("</scm>\n")
        }
        append("</project>\n")
    }
}

// The variant API lives in the Android Gradle Plugin's class loader; reach it dynamically (see runtime-packaging.gradle.kts).
fun Any.agpGet(property: String): Any? = InvokerHelper.getProperty(this, property)

fun Any.agpCall(method: String, vararg arguments: Any?): Any? = InvokerHelper.invokeMethod(this, method, arguments)

val libraryNoticesTable = rootProject.layout.projectDirectory.file("runtime/licenses/android/licenses.json")
val libraryNoticesTexts = rootProject.layout.projectDirectory.dir("runtime/licenses/android")
val verifyLibraryNotices = tasks.register<VerifySillyBunnyLibraryNotices>("verifySillyBunnyLibraryNotices") {
    rules.set(libraryNoticesTable)
    texts.set(libraryNoticesTexts)
    report.set(layout.buildDirectory.file("reports/sillybunny/library-notices-verify.txt"))
}
tasks.named("check") { dependsOn(verifyLibraryNotices) }

// One POM per module and version, read through the build's repositories (dependencyResolutionManagement).
val resolvedPoms = mutableMapOf<String, File?>()
val pomLookup = PomLookup { coordinates ->
    synchronized(resolvedPoms) {
        if (coordinates in resolvedPoms) return@PomLookup resolvedPoms[coordinates]
        val (group, module, version) = coordinates.split(':')
        val pom = dependencies.createArtifactResolutionQuery()
            .forModule(group, module, version)
            .withArtifacts(MavenModule::class.java, MavenPomArtifact::class.java)
            .execute()
            .resolvedComponents
            .flatMap { it.getArtifacts(MavenPomArtifact::class.java) }
            .filterIsInstance<ResolvedArtifactResult>()
            .map { it.file }
            .singleOrNull()
        resolvedPoms[coordinates] = pom
        pom
    }
}

fun configureLibraryNotices(variant: Any) {
    val name = variant.agpGet("name") as String
    val variantName = name.replaceFirstChar { it.uppercase(Locale.ROOT) }
    val shipped = (variant.agpGet("runtimeConfiguration") as Configuration).incoming.artifactView { lenient(false) }.artifacts.resolvedArtifacts
    // Named and placed as runtime-packaging.gradle.kts expects.
    tasks.register<GenerateSillyBunnyLibraryNotices>("generate${variantName}SillyBunnyLibraryNotices") {
        components.set(
            shipped.map { artifacts ->
                artifacts.mapNotNull { it.id.componentIdentifier as? ModuleComponentIdentifier }
                    .map { "${it.group}:${it.module}:${it.version}" }.distinct().sorted()
            },
        )
        // The app's own project modules are SillyBunny code, not third-party libraries.
        otherArtifacts.set(
            shipped.map { artifacts ->
                artifacts.filter { it.id.componentIdentifier !is ModuleComponentIdentifier && it.id.componentIdentifier !is ProjectComponentIdentifier }
                    .map { it.id.displayName }.sorted()
            },
        )
        rules.set(libraryNoticesTable)
        texts.set(libraryNoticesTexts)
        poms.set(pomLookup)
        output.set(layout.buildDirectory.dir("generated/sillybunny/library-notices/$name"))
        dependsOn(verifyLibraryNotices)
    }
}

val libraryNoticesComponents: Any = extensions.getByName("androidComponents")
libraryNoticesComponents.agpCall(
    "onVariants",
    libraryNoticesComponents.agpCall("selector")!!.agpCall("all"),
    { variant: Any -> configureLibraryNotices(variant) },
)
