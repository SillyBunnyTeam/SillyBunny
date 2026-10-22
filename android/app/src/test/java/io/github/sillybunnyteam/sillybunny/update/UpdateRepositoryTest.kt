package io.github.sillybunnyteam.sillybunny.update

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import java.io.File
import java.io.IOException
import java.net.URI
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29])
class UpdateRepositoryTest {
    private lateinit var context: Context
    private lateinit var server: UpdateTestServer
    private lateinit var checkout: File
    private lateinit var updates: File

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        checkout = File(context.filesDir, "SillyBunny")
        updates = File(context.cacheDir, "updates")
        checkout.deleteRecursively()
        updates.deleteRecursively()
        server = UpdateTestServer()
        shadowOf(context.packageManager).installPackage(CoreTestFixtures.packageInfo(context, 1))
    }

    @After
    fun tearDown() {
        server.close()
        checkout.deleteRecursively()
        updates.deleteRecursively()
    }

    @Test
    fun customStableManifestUsesItsOriginalAssetSibling() {
        server.json("/latest/android-update.json", CoreTestFixtures.manifest(version = 8).toString())
        val result = repository().check() as UpdateCheckResult.Available
        assertEquals(8L, result.candidate.manifest.versionCode)
        assertEquals(server.url("/latest/${CoreTestFixtures.APK_NAME}"), result.candidate.downloadUrl)
        assertEquals(listOf("/latest/android-update.json"), server.requests.toList())
    }

    @Test
    fun officialLatestPinsTheManifestReleaseTagWithoutAnApiRequest() {
        val manifest = candidate().manifest.copy(releaseTag = "v2.0.0-rc.1")
        val repository = repository(manifestUrl = OFFICIAL_LATEST_MANIFEST)
        assertEquals(
            "https://github.com/SillyBunnyTeam/SillyBunny/releases/download/v2.0.0-rc.1/${CoreTestFixtures.APK_NAME}",
            repository.stableDownloadUrl(manifest),
        )
        assertTrue(server.requests.isEmpty())
    }

    @Test
    fun officialLatestPercentEncodesTheTagWithoutAddingPathQueryOrFragment() {
        val manifest = candidate().manifest.copy(releaseTag = "v2.0.0+build.β")
        val repository = repository(manifestUrl = OFFICIAL_LATEST_MANIFEST)
        val url = URI(repository.stableDownloadUrl(manifest)!!)
        assertEquals(
            "/SillyBunnyTeam/SillyBunny/releases/download/v2.0.0%2Bbuild.%CE%B2/${CoreTestFixtures.APK_NAME}",
            url.rawPath,
        )
        assertEquals(null, url.rawQuery)
        assertEquals(null, url.rawFragment)
    }

    @Test
    fun officialLatestRejectsUnsafeReleaseTagsRatherThanResolvingThemAsUrls() {
        val repository = repository(manifestUrl = OFFICIAL_LATEST_MANIFEST)
        val manifest = candidate().manifest
        for (tag in listOf(
            "", " ", ".", "..", "../v2", "/v2", "v2/../../other", "v2\\other", "v2?download=other",
            "v2#fragment", "%2e%2e", "v2%2fother", "v2\r\n", "v2\u007f", "v2\u0085", "v2\ud800",
            "v2.lock", "v2..0", "v2@{1}", "v2/next", "v".repeat(257),
        )) {
            assertEquals(tag, null, repository.stableDownloadUrl(manifest.copy(releaseTag = tag)))
        }
        assertTrue(server.requests.isEmpty())
    }

    @Test
    fun pinningDoesNotRewriteCustomStableUrlsOrArbitraryLoopbackFixtures() {
        val manifest = candidate().manifest
        for (base in listOf(
            server.url("/anywhere/android-update.json"),
            server.url("/SillyBunnyTeam/SillyBunny/releases/latest/download/android-update.json"),
            "https://downloads.example.test/latest/android-update.json",
            "https://github.com/AnotherTeam/AnotherRepo/releases/latest/download/android-update.json",
            "https://github.com/SillyBunnyTeam/SillyBunny/releases/download/fixed-tag/android-update.json",
        )) {
            assertEquals(
                URI(base).resolve(CoreTestFixtures.APK_NAME).toString(),
                repository(manifestUrl = base).stableDownloadUrl(manifest),
            )
        }
    }

    @Test
    fun pinnedCandidateDownloadsTheCheckedReleaseAfterLatestAdvances() {
        val latestPath = "/SillyBunnyTeam/SillyBunny/releases/latest/download"
        val manifestPath = "$latestPath/android-update.json"
        val root = CoreTestFixtures.manifest(version = 2).put("releaseTag", "v2.0.0")
        val payload = CoreTestFixtures.payload
        server.json(manifestPath, root.toString())
        server.bytes("/SillyBunnyTeam/SillyBunny/releases/download/v2.0.0/${CoreTestFixtures.APK_NAME}", payload)
        val checked = (repository(manifestUrl = server.url(manifestPath)).check() as UpdateCheckResult.Available).candidate

        val pinned = repository(manifestUrl = OFFICIAL_LATEST_MANIFEST).stableDownloadUrl(checked.manifest)!!
        // Mirror only the URL origin so this exercises real HTTP without GitHub or custom TLS.
        val mirrored = checked.copy(downloadUrl = server.url(URI(pinned).rawPath))
        server.json(manifestPath, CoreTestFixtures.manifest(version = 3).toString())
        server.bytes("$latestPath/${CoreTestFixtures.APK_NAME}", ByteArray(payload.size) { 42 })

        val apk = downloadRepository { file, version, signer ->
            version == 2L && signer.contentEquals(CoreTestFixtures.signer) && file.readBytes().contentEquals(payload)
        }.download(mirrored)
        assertTrue(apk.readBytes().contentEquals(payload))
        assertEquals(listOf(
            manifestPath,
            "/SillyBunnyTeam/SillyBunny/releases/download/v2.0.0/${CoreTestFixtures.APK_NAME}",
        ), server.requests.toList())
    }

    @Test
    @Config(sdk = [29, 31, 34, 35, 37])
    fun comparesInstalledPackageManagerLongVersionRatherThanBuildConfig() {
        val version = Int.MAX_VALUE.toLong() + 22
        shadowOf(context.packageManager).installPackage(CoreTestFixtures.packageInfo(context, version))
        server.json("/latest/android-update.json", CoreTestFixtures.manifest(version = version).toString())
        assertEquals(UpdateCheckResult.UpToDate, repository().check())
        server.json("/latest/android-update.json", CoreTestFixtures.manifest(version = version - 1).toString())
        assertEquals(UpdateCheckResult.UpToDate, repository().check())
        server.json("/latest/android-update.json", CoreTestFixtures.manifest(version = version + 1).toString())
        val result = repository().check() as UpdateCheckResult.Available
        assertEquals(version + 1, result.candidate.manifest.versionCode)
    }

    @Test
    fun stableFailsClosedForNetworkMalformedManifestPrereleaseAndSignerMismatch() {
        assertFailure(UpdateCheckFailure.NETWORK, repository().check())
        server.json("/latest/android-update.json", "{broken")
        assertFailure(UpdateCheckFailure.INVALID_MANIFEST, repository().check())
        server.json("/latest/android-update.json", CoreTestFixtures.manifest(prerelease = true).toString())
        assertFailure(UpdateCheckFailure.INVALID_MANIFEST, repository().check())
        server.json("/latest/android-update.json", CoreTestFixtures.manifest(signer = "00".repeat(32)).toString())
        assertFailure(UpdateCheckFailure.SIGNER_MISMATCH, repository().check())
    }

    @Test
    fun localReleaseTrackingStagingUsesReleasesApiAndMissingCheckoutUsesFallback() {
        val git = File(checkout, ".git").apply { mkdirs() }
        File(git, "HEAD").writeText("ref: refs/heads/release\n")
        File(git, "config").writeText("""
            [branch "release"]
                remote = origin
                merge = refs/heads/staging
            [remote "origin"]
                fetch = +refs/heads/*:refs/remotes/origin/*
        """.trimIndent())
        server.json("/releases", "[]")
        server.json("/latest/android-update.json", CoreTestFixtures.manifest().toString())
        assertEquals(UpdateCheckResult.UpToDate, repository(defaultRef = "release").check())
        assertEquals(listOf("/releases"), server.requests.toList())
        checkout.deleteRecursively()
        assertTrue(repository(defaultRef = "release").check() is UpdateCheckResult.Available)
        assertEquals(UpdateCheckResult.UpToDate, repository(defaultRef = "staging").check())
    }

    @Test
    fun aggregatesEveryNonDraftManifestInOrderAndChoosesHighestEligibleVersion() {
        val releases = JSONArray()
        releases.put(JSONObject().put("draft", "false").put("assets", JSONArray()))
        releases.put(CoreTestFixtures.release(server.url("/draft/android-update.json"), draft = true))
        releases.put(CoreTestFixtures.release(null))
        releases.put(JSONObject().put("draft", false).put("assets", "malformed"))
        releases.put("malformed release")
        releases.put(JSONObject.NULL)

        addRelease(releases, "/invalid", "not JSON")
        addRelease(releases, "/first", CoreTestFixtures.manifest(version = 9, prerelease = true).toString())
        addRelease(releases, "/mismatched", CoreTestFixtures.manifest(version = 200, signer = "00".repeat(32)).toString())
        addRelease(releases, "/old", CoreTestFixtures.manifest(version = 1).toString())
        addRelease(releases, "/network", null)
        val futureSdk = CoreTestFixtures.manifest(version = 400).put("minSdk", 30)
        addRelease(releases, "/future-sdk", futureSdk.toString())
        val wrongAbi = CoreTestFixtures.manifest(version = 500)
        wrongAbi.getJSONObject("assets").remove(CoreTestFixtures.ABI)
        addRelease(releases, "/wrong-abi", wrongAbi.toString())
        val highest = CoreTestFixtures.release(server.url("/highest/android-update.json"), server.url("/release-asset/actual.apk"))
        highest.put("prerelease", false)
        releases.put(highest)
        server.json("/highest/android-update.json", CoreTestFixtures.manifest(version = 12).toString())
        addRelease(releases, "/last", CoreTestFixtures.manifest(version = 10, prerelease = true).toString())
        server.json("/releases", releases.toString())

        val result = repository(defaultRef = "staging").check() as UpdateCheckResult.Available
        assertEquals(12L, result.candidate.manifest.versionCode)
        assertEquals(server.url("/release-asset/actual.apk"), result.candidate.downloadUrl)
        assertEquals(listOf(
            "/releases", "/invalid/android-update.json", "/first/android-update.json",
            "/mismatched/android-update.json", "/old/android-update.json", "/network/android-update.json",
            "/future-sdk/android-update.json", "/wrong-abi/android-update.json", "/highest/android-update.json",
            "/last/android-update.json",
        ), server.requests.toList())
    }

    @Test
    fun capsQualifyingManifestsAtTwentyAndDoesNotStopAtFirstEligibleCandidate() {
        val releases = JSONArray()
        repeat(30) { index ->
            releases.put(CoreTestFixtures.release(server.url("/draft$index/android-update.json"), draft = true))
            releases.put(CoreTestFixtures.release(null))
        }
        for (index in 1..25) {
            addRelease(releases, "/r$index", CoreTestFixtures.manifest(version = index + 1L, prerelease = true).toString())
        }
        server.json("/releases", releases.toString())
        val result = repository(defaultRef = "staging").check() as UpdateCheckResult.Available
        assertEquals(21L, result.candidate.manifest.versionCode)
        assertEquals(listOf("/releases") + (1..20).map { "/r$it/android-update.json" }, server.requests.toList())
    }

    @Test
    fun waitsForEachManifestBodyBeforeRequestingTheNext() {
        val firstStarted = CountDownLatch(1)
        val releaseFirst = CountDownLatch(1)
        val secondStarted = CountDownLatch(1)
        val firstBody = CoreTestFixtures.manifest(version = 2).toString().toByteArray()
        val secondBody = CoreTestFixtures.manifest(version = 3).toString().toByteArray()
        server.json("/releases", JSONArray().apply {
            put(CoreTestFixtures.release(server.url("/first/android-update.json")))
            put(CoreTestFixtures.release(server.url("/second/android-update.json")))
        }.toString())
        server.handle("/first/android-update.json") { exchange ->
            exchange.sendResponseHeaders(200, firstBody.size.toLong())
            firstStarted.countDown()
            check(releaseFirst.await(5, TimeUnit.SECONDS))
            exchange.responseBody.use { it.write(firstBody) }
        }
        server.handle("/second/android-update.json") { exchange ->
            secondStarted.countDown()
            exchange.sendResponseHeaders(200, secondBody.size.toLong())
            exchange.responseBody.use { it.write(secondBody) }
        }
        val executor = Executors.newSingleThreadExecutor()
        try {
            val result = executor.submit<UpdateCheckResult> { repository(defaultRef = "staging").check() }
            assertTrue(firstStarted.await(5, TimeUnit.SECONDS))
            assertFalse(secondStarted.await(150, TimeUnit.MILLISECONDS))
            releaseFirst.countDown()
            assertEquals(3L, (result.get(5, TimeUnit.SECONDS) as UpdateCheckResult.Available).candidate.manifest.versionCode)
            assertEquals(0L, secondStarted.count)
        } finally {
            releaseFirst.countDown()
            executor.shutdownNow()
        }
    }

    @Test
    fun skipsMalformedAssetMetadataWithoutConsumingTheManifestFetchBudget() {
        val releases = JSONArray()
        repeat(25) { releases.put(CoreTestFixtures.release("file:///not-allowed")) }
        val duplicate = CoreTestFixtures.release(server.url("/duplicate/android-update.json"))
        duplicate.getJSONArray("assets").put(CoreTestFixtures.asset("android-update.json", server.url("/other/android-update.json")))
        releases.put(duplicate)
        addRelease(releases, "/valid", CoreTestFixtures.manifest(version = 6).toString())
        server.json("/releases", releases.toString())
        assertTrue(repository(defaultRef = "staging").check() is UpdateCheckResult.Available)
        assertEquals(listOf("/releases", "/valid/android-update.json"), server.requests.toList())
    }

    @Test
    fun prereleaseDownloadFallsBackToItsOwnOriginalManifestSibling() {
        val releases = JSONArray().put(CoreTestFixtures.release(server.url("/v3/android-update.json")))
        server.json("/releases", releases.toString())
        server.json("/v3/android-update.json", CoreTestFixtures.manifest(version = 3, prerelease = true).toString())
        val result = repository(defaultRef = "staging").check() as UpdateCheckResult.Available
        assertEquals(server.url("/v3/${CoreTestFixtures.APK_NAME}"), result.candidate.downloadUrl)
    }

    @Test
    fun neverOffersWrongSignerButContinuesScanningForEligibleCandidates() {
        val releases = JSONArray()
        addRelease(releases, "/wrong", CoreTestFixtures.manifest(version = 100, signer = "00".repeat(32)).toString())
        server.json("/releases", releases.toString())
        assertFailure(UpdateCheckFailure.SIGNER_MISMATCH, repository(defaultRef = "staging").check())
        addRelease(releases, "/right", CoreTestFixtures.manifest(version = 4).toString())
        server.json("/releases", releases.toString())
        assertEquals(4L, (repository(defaultRef = "staging").check() as UpdateCheckResult.Available).candidate.manifest.versionCode)
    }

    @Test
    fun reportsPrereleaseFailuresWithoutCrashingAndTreatsNoNewVersionAsCurrent() {
        val repository = repository(defaultRef = "staging")
        assertFailure(UpdateCheckFailure.NETWORK, repository.check())
        server.json("/releases", "{}")
        assertFailure(UpdateCheckFailure.INVALID_MANIFEST, repository.check())
        server.json("/releases", "[] trailing")
        assertFailure(UpdateCheckFailure.INVALID_MANIFEST, repository.check())
        server.json("/releases", "[]")
        assertEquals(UpdateCheckResult.UpToDate, repository.check())
        val releases = JSONArray()
        addRelease(releases, "/bad", "{}")
        server.json("/releases", releases.toString())
        assertFailure(UpdateCheckFailure.INVALID_MANIFEST, repository.check())
        addRelease(releases, "/network", null)
        server.json("/releases", releases.toString())
        assertFailure(UpdateCheckFailure.NETWORK, repository.check())
        // "/network" is listed above the installed version, so it may hold a newer APK.
        addRelease(releases, "/current", CoreTestFixtures.manifest(version = 1).toString())
        server.json("/releases", releases.toString())
        assertFailure(UpdateCheckFailure.NETWORK, repository.check())
    }

    @Test
    fun prereleaseNetworkFailureAboveTheInstalledVersionIsNotReportedAsUpToDate() {
        val releases = JSONArray()
        addRelease(releases, "/rc3", null)
        addRelease(releases, "/rc2", CoreTestFixtures.manifest(version = 1, prerelease = true).toString())
        server.json("/releases", releases.toString())
        assertFailure(UpdateCheckFailure.NETWORK, repository(defaultRef = "staging").check())
    }

    @Test
    fun prereleaseFailuresBelowTheInstalledVersionStillReportUpToDate() {
        val releases = JSONArray()
        addRelease(releases, "/current", CoreTestFixtures.manifest(version = 1, prerelease = true).toString())
        addRelease(releases, "/older-network", null)
        addRelease(releases, "/older-invalid", "{}")
        server.json("/releases", releases.toString())
        assertEquals(UpdateCheckResult.UpToDate, repository(defaultRef = "staging").check())
    }

    @Test
    fun officialLatestDownloadsFromTheReleaseThatServedTheManifest() {
        // Plan §6.1 re-attaches an unchanged APK and manifest to a newer release, so releaseTag can name an
        // older release that maintainers may later delete. GitHub's latest/download redirect names the host.
        val https = CannedHttps()
        val hosting = "https://github.com/SillyBunnyTeam/SillyBunny/releases/download/v2.0.1/android-update.json"
        val blob = "https://release-assets.githubusercontent.com/github-production-release-asset/1/manifest?sig=fixture"
        https.redirect(OFFICIAL_LATEST_MANIFEST, hosting)
        https.redirect(hosting, blob)
        https.body(blob, CoreTestFixtures.manifest(version = 2).toString().toByteArray())
        val result = repository(manifestUrl = OFFICIAL_LATEST_MANIFEST, http = https.client()).check()
            as UpdateCheckResult.Available
        assertEquals("v1.2.0", result.candidate.manifest.releaseTag)
        assertEquals(
            "https://github.com/SillyBunnyTeam/SillyBunny/releases/download/v2.0.1/${CoreTestFixtures.APK_NAME}",
            result.candidate.downloadUrl,
        )
        assertEquals(listOf(OFFICIAL_LATEST_MANIFEST, hosting, blob), https.requests.toList())
    }

    @Test
    fun officialLatestFallsBackToTheManifestTagWithoutAUsableHostingRedirect() {
        val pinned = "https://github.com/SillyBunnyTeam/SillyBunny/releases/download/v1.2.0/${CoreTestFixtures.APK_NAME}"
        val manifest = CoreTestFixtures.manifest(version = 2).toString().toByteArray()
        val direct = CannedHttps().apply { body(OFFICIAL_LATEST_MANIFEST, manifest) }
        val unusual = listOf(
            "https://github.com/SillyBunnyTeam/SillyBunny/releases/download/v2.0.1/other.json",
            "https://github.com/OtherOwner/SillyBunny/releases/download/v2.0.1/android-update.json",
            "https://github.com/SillyBunnyTeam/SillyBunny/releases/download/bad..tag/android-update.json",
            "https://github.com/SillyBunnyTeam/SillyBunny/releases/download/v2.0.1/android-update.json?x=1",
            "https://github.com:8443/SillyBunnyTeam/SillyBunny/releases/download/v2.0.1/android-update.json",
        )
        val clients = listOf(direct.client()) + unusual.map { hop ->
            CannedHttps().apply {
                redirect(OFFICIAL_LATEST_MANIFEST, hop)
                body(hop, manifest)
            }.client()
        }
        clients.forEach { client ->
            val result = repository(manifestUrl = OFFICIAL_LATEST_MANIFEST, http = client).check()
                as UpdateCheckResult.Available
            assertEquals(pinned, result.candidate.downloadUrl)
        }
    }

    @Test
    fun invalidOrDuplicateApkUrlsDoNotSuppressAnotherGoodRelease() {
        val releases = JSONArray()
        releases.put(CoreTestFixtures.release(server.url("/bad-url/android-update.json"), "http://localhost/forbidden.apk"))
        server.json("/bad-url/android-update.json", CoreTestFixtures.manifest(version = 99).toString())
        val duplicate = CoreTestFixtures.release(server.url("/duplicate-apk/android-update.json"), server.url("/one.apk"))
        duplicate.getJSONArray("assets").put(CoreTestFixtures.asset(CoreTestFixtures.APK_NAME, server.url("/two.apk")))
        releases.put(duplicate)
        server.json("/duplicate-apk/android-update.json", CoreTestFixtures.manifest(version = 100).toString())
        addRelease(releases, "/valid", CoreTestFixtures.manifest(version = 7).toString())
        server.json("/releases", releases.toString())
        assertEquals(7L, (repository(defaultRef = "staging").check() as UpdateCheckResult.Available).candidate.manifest.versionCode)
    }

    @Test
    fun missingInstalledSignerOrVersionFailsBeforeNetwork() {
        val missing = CoreTestFixtures.packageInfo(context, 1).apply { signingInfo = null }
        shadowOf(context.packageManager).installPackage(missing)
        assertFailure(UpdateCheckFailure.INVALID_PACKAGE, repository().check())
        shadowOf(context.packageManager).installPackage(CoreTestFixtures.packageInfo(context, 1))
        val repository = UpdateRepository(
            context, http = UpdateHttpClient(true), installedVersionCode = { null },
        )
        assertFailure(UpdateCheckFailure.INVALID_PACKAGE, repository.check())
        val throwing = UpdateRepository(context, installedSigner = { throw IllegalStateException() })
        assertFailure(UpdateCheckFailure.INVALID_PACKAGE, throwing.check())
        assertTrue(server.requests.isEmpty())
    }

    @Test
    fun verifiedDownloadRenamesOnlyAfterArchiveCheckAndReturnsPrivateApk() {
        val candidate = candidate()
        server.bytes("/apk", CoreTestFixtures.payload)
        val progress = mutableListOf<Long>()
        var verified = false
        val repository = downloadRepository { apk, version, signer ->
            assertEquals("part", apk.extension)
            assertEquals(updates.canonicalFile, apk.parentFile!!.canonicalFile)
            assertEquals(2L, version)
            assertTrue(CoreTestFixtures.signer.contentEquals(signer))
            assertTrue(apk.readBytes().contentEquals(CoreTestFixtures.payload))
            assertEquals(listOf(apk.name), updates.list()!!.toList())
            verified = true
            true
        }
        val apk = repository.download(candidate) { received, _ -> progress.add(received) }
        assertTrue(verified)
        assertTrue(apk.isFile)
        assertEquals("apk", apk.extension)
        assertEquals(listOf(apk.name), updates.list()!!.toList())
        assertEquals(0L, progress.first())
        assertEquals(CoreTestFixtures.payload.size.toLong(), progress.last())
    }

    @Test
    fun downloadCleansSizeHashNetworkAndArchiveFailuresWithoutTouchingUnrelatedFiles() {
        updates.mkdirs()
        val unrelated = File(updates, "existing.apk").apply { writeText("retained") }
        server.bytes("/short", CoreTestFixtures.payload.copyOf(10), chunked = true)
        server.bytes("/long", CoreTestFixtures.payload + byteArrayOf(1), chunked = true)
        server.bytes("/hash", CoreTestFixtures.payload)
        val repository = downloadRepository { _, _, _ -> throw AssertionError("archive check must follow hash and size") }
        val normal = candidate()
        for (path in listOf("/short", "/long", "/hash", "/missing")) {
            val value = normal.copy(
                downloadUrl = server.url(path),
                manifest = if (path == "/hash") normal.manifest.copy(asset = normal.manifest.asset.copy(sha256 = "00".repeat(32))) else normal.manifest,
            )
            assertThrows(IOException::class.java) { repository.download(value) }
            assertEquals(listOf(unrelated.name), updates.list()!!.toList())
        }
        server.bytes("/apk", CoreTestFixtures.payload)
        assertThrows(IOException::class.java) { downloadRepository { _, _, _ -> false }.download(normal) }
        assertEquals(listOf(unrelated.name), updates.list()!!.toList())
        assertThrows(IllegalStateException::class.java) {
            downloadRepository { _, _, _ -> throw IllegalStateException() }.download(normal)
        }
        assertEquals(listOf(unrelated.name), updates.list()!!.toList())
        assertEquals("retained", unrelated.readText())
    }

    @Test
    fun defaultArchiveVerifierRejectsNonApkPayloadAndDeletesIt() {
        server.bytes("/apk", CoreTestFixtures.payload)
        assertThrows(IOException::class.java) { repository().download(candidate()) }
        assertTrue(updates.listFiles().isNullOrEmpty())
    }

    @Test
    fun rechecksInstalledSignerAndVersionAtDownloadTimeBeforeCreatingFiles() {
        val normal = candidate()
        val repository = downloadRepository { _, _, _ -> true }
        shadowOf(context.packageManager).installPackage(CoreTestFixtures.packageInfo(context, 2))
        assertThrows(IOException::class.java) { repository.download(normal) }
        shadowOf(context.packageManager).installPackage(CoreTestFixtures.packageInfo(context, 1).apply { signingInfo = null })
        assertThrows(IOException::class.java) { repository.download(normal) }
        shadowOf(context.packageManager).installPackage(CoreTestFixtures.packageInfo(context, 1))
        val mismatch = normal.copy(manifest = normal.manifest.copy(signingCertSha256 = "00".repeat(32)))
        assertThrows(IOException::class.java) { repository.download(mismatch) }
        assertFalse(updates.exists())
        assertTrue(server.requests.isEmpty())
    }

    @Test
    fun rejectsHandConstructedUnsafeCandidatesWithoutNetworkOrFiles() {
        val normal = candidate()
        val repository = downloadRepository { _, _, _ -> true }
        val invalid = listOf(
            normal.copy(downloadUrl = "http://localhost/update.apk"),
            normal.copy(manifest = normal.manifest.copy(minSdk = 30)),
            normal.copy(manifest = normal.manifest.copy(asset = normal.manifest.asset.copy(size = 0))),
            normal.copy(manifest = normal.manifest.copy(asset = normal.manifest.asset.copy(size = UpdateManifestParser.MAX_APK_BYTES + 1))),
            normal.copy(manifest = normal.manifest.copy(asset = normal.manifest.asset.copy(name = "../update.apk"))),
            normal.copy(manifest = normal.manifest.copy(asset = normal.manifest.asset.copy(sha256 = "invalid"))),
        )
        invalid.forEach { value -> assertThrows(IOException::class.java) { repository.download(value) } }
        assertFalse(updates.exists())
        assertTrue(server.requests.isEmpty())
    }

    private fun candidate(): UpdateCandidate = UpdateCandidate(
        UpdateManifestParser.parse(CoreTestFixtures.manifest().toString(), CoreTestFixtures.ABI, 29)!!,
        server.url("/apk"),
    )

    private fun repository(
        defaultRef: String = "release",
        manifestUrl: String = server.url("/latest/android-update.json"),
        http: UpdateHttpClient = UpdateHttpClient(allowDebugLoopback = true),
    ): UpdateRepository = UpdateRepository(
        context,
        manifestUrl = manifestUrl,
        releasesApiUrl = server.url("/releases"),
        http = http,
        supportedAbis = listOf(CoreTestFixtures.ABI),
        sdk = 29,
        defaultRef = defaultRef,
    )

    private fun downloadRepository(verifier: (File, Long, ByteArray) -> Boolean): UpdateRepository =
        UpdateRepository(
            context,
            http = UpdateHttpClient(allowDebugLoopback = true),
            supportedAbis = listOf(CoreTestFixtures.ABI),
            sdk = 29,
            defaultRef = "release",
            archiveVerifier = verifier,
        )

    private fun addRelease(releases: JSONArray, path: String, json: String?) {
        val manifestPath = "$path/android-update.json"
        releases.put(CoreTestFixtures.release(server.url(manifestPath)))
        if (json != null) server.json(manifestPath, json)
    }

    private fun assertFailure(reason: UpdateCheckFailure, result: UpdateCheckResult) {
        assertEquals(UpdateCheckResult.Failed(reason), result)
    }

    private companion object {
        const val OFFICIAL_LATEST_MANIFEST =
            "https://github.com/SillyBunnyTeam/SillyBunny/releases/latest/download/android-update.json"
    }
}
