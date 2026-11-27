package io.github.sillybunnyteam.sillybunny.update

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import java.io.File
import java.nio.file.Files
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29, 31, 34, 35, 37])
class UpdateStoreTest {
    private lateinit var context: Context
    private lateinit var store: UpdateStore
    private lateinit var updates: File

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        context.getSharedPreferences("app_updates", Context.MODE_PRIVATE).edit().clear().commit()
        updates = File(context.cacheDir, "updates")
        updates.deleteRecursively()
        check(updates.mkdirs())
        store = UpdateStore(context)
    }

    @After
    fun tearDown() {
        updates.deleteRecursively()
    }

    @Test
    fun defaultsAreIdleAndEnabledAndSettingsSurviveNewInstances() {
        assertTrue(store.enabled)
        assertEquals(InstallResult(), store.lastInstallResult)
        assertNull(store.activeSessionId)
        assertNull(store.downloadedApk)
        assertNull(store.consumeReplacement())

        val result = InstallResult(InstallOutcome.ABORTED, 3, -115, 2, 41)
        store.enabled = false
        store.lastInstallResult = result
        assertFalse(UpdateStore(context).enabled)
        assertEquals(result, UpdateStore(context).lastInstallResult)

        store.lastInstallResult = InstallResult(InstallOutcome.SUCCESS)
        assertEquals(InstallResult(InstallOutcome.SUCCESS), UpdateStore(context).lastInstallResult)
    }

    @Test
    fun replacementIsConsumedOnceAndDoesNotDependOnNotificationAccess() {
        store.recordReplacement(12)
        assertEquals(12L, UpdateStore(context).consumeReplacement())
        assertNull(store.consumeReplacement())
        store.recordReplacement(0)
        store.recordReplacement(-1)
        assertNull(store.consumeReplacement())
    }

    @Test
    fun callbackAndDownloadArePersistedTogetherBeforeCommit() {
        val apk = download()
        assertTrue(store.beginInstall(5, "session-token", apk, 2))
        val restored = UpdateStore(context)
        assertEquals(5, restored.activeSessionId)
        assertEquals(UpdateStore.InstallCallback(5, "session-token"), restored.activeCallback())
        assertEquals(apk.canonicalPath, restored.downloadedApk)
        assertEquals(InstallResult(InstallOutcome.VERIFYING, sessionId = 5), restored.lastInstallResult)
        assertFalse(restored.beginInstall(6, "other-token", apk, 3))
        assertEquals(5, restored.activeSessionId)
    }

    @Test
    fun nonterminalResultsRetainStateAndTerminalResultsReleaseOnlyTheActiveDownload() {
        val apk = download()
        val unrelated = File(updates, "unrelated.apk").apply { writeText("keep") }
        assertTrue(store.beginInstall(5, "token", apk, 2))
        val callback = store.activeCallback()!!
        val awaiting = InstallResult(InstallOutcome.AWAITING_USER_ACTION, -1)
        assertTrue(store.recordInstallResult(callback, awaiting, terminal = false))
        assertEquals(5, store.activeSessionId)
        assertTrue(apk.exists())

        val failure = InstallResult(InstallOutcome.FAILED, 6, -4)
        assertTrue(store.recordInstallResult(callback, failure, terminal = true))
        assertEquals(failure.copy(sessionId = 5), store.lastInstallResult)
        assertNull(store.activeSessionId)
        assertNull(store.activeCallback())
        assertNull(store.downloadedApk)
        assertFalse(apk.exists())
        assertTrue(unrelated.exists())
    }

    @Test
    fun staleCallbackCannotOverwriteANewSessionOrDeleteItsDownload() {
        val apk = download()
        assertTrue(store.beginInstall(5, "token", apk, 2))
        listOf(UpdateStore.InstallCallback(4, "token"), UpdateStore.InstallCallback(5, "foreign")).forEach {
            assertFalse(store.recordInstallResult(it, InstallResult(InstallOutcome.SUCCESS), terminal = true))
        }
        assertEquals(5, store.activeSessionId)
        assertTrue(apk.exists())
        store.activeSessionId = 6
        assertNull(store.activeCallback())
        store.failInstall(5)
        assertEquals(6, store.activeSessionId)
        assertTrue(apk.exists())
    }

    @Test
    fun replacementCompletesMatchingSessionWhenTheOldProcessMissesItsCallback() {
        val apk = download()
        assertTrue(store.beginInstall(5, "token", apk, 2))
        store.recordReplacement(1)
        assertEquals(5, store.activeSessionId)
        assertTrue(apk.exists())
        store.recordReplacement(2)
        assertEquals(2L, UpdateStore(context).consumeReplacement())
        assertEquals(InstallResult(InstallOutcome.SUCCESS, sessionId = 5), store.lastInstallResult)
        assertNull(store.activeSessionId)
        assertNull(store.activeCallback())
        assertNull(store.downloadedApk)
        assertFalse(apk.exists())
    }

    @Test
    fun clearDownloadUnlinksOnlyTheRecordedValidatedFile() {
        val apk = download()
        val part = File(updates, "candidate.apk.part").apply { writeText("partial") }
        store.downloadedApk = apk.path
        store.clearDownload()
        assertFalse(apk.exists())
        assertTrue(part.exists())
        assertNull(store.downloadedApk)
        store.downloadedApk = part.path
        store.clearDownload()
        assertFalse(part.exists())
    }

    @Test
    fun arbitraryOrTamperedPathsNeverDeleteOutsideTheUpdatesDirectory() {
        val outside = File(context.filesDir, "precious.apk").apply { writeText("keep") }
        val sibling = File(context.cacheDir, "updates-other").apply { mkdirs() }
        val siblingApk = File(sibling, "precious.apk").apply { writeText("keep") }
        val nested = File(updates, "nested").apply { mkdirs() }
        val nestedApk = File(nested, "precious.apk").apply { writeText("keep") }
        val notAnApk = File(updates, "settings.json").apply { writeText("keep") }
        val directory = File(updates, "directory.apk").apply { mkdir() }
        try {
            listOf(
                outside.path,
                siblingApk.path,
                nestedApk.path,
                notAnApk.path,
                directory.path,
                "../precious.apk",
            ).forEach {
                store.downloadedApk = it
                assertNull(store.downloadedApk)
                // Simulate corrupt/stale state without trusting the setter's validation.
                context.getSharedPreferences("app_updates", Context.MODE_PRIVATE)
                    .edit().putString("downloaded_apk", it).commit()
                store.clearDownload()
            }
            assertTrue(outside.exists())
            assertTrue(siblingApk.exists())
            assertTrue(nestedApk.exists())
            assertTrue(notAnApk.exists())
            assertTrue(directory.isDirectory)
        } finally {
            outside.delete()
            sibling.deleteRecursively()
        }
    }

    @Test
    fun symbolicFilesAndSymbolicUpdateDirectoryAreNeverFollowed() {
        val outside = File(context.filesDir, "precious.apk").apply { writeText("keep") }
        val link = File(updates, "linked.apk")
        try {
            Files.createSymbolicLink(link.toPath(), outside.toPath())
            assertNull(store.ownedDownload(link.path))
            context.getSharedPreferences("app_updates", Context.MODE_PRIVATE)
                .edit().putString("downloaded_apk", link.path).commit()
            store.clearDownload()
            assertTrue(Files.isSymbolicLink(link.toPath()))
            assertTrue(outside.exists())
            Files.delete(link.toPath())
            assertTrue(updates.delete())
            Files.createSymbolicLink(updates.toPath(), context.filesDir.toPath())
            assertNull(store.ownedDownload(File(updates, outside.name).path))
            Files.delete(updates.toPath())
            assertTrue(updates.mkdir())
        } finally {
            if (Files.isSymbolicLink(updates.toPath())) Files.delete(updates.toPath())
            outside.delete()
        }
    }

    @Test
    fun unknownOutcomeFallsBackAndSessionResetDropsItsAuthentication() {
        context.getSharedPreferences("app_updates", Context.MODE_PRIVATE)
            .edit().putString("install_outcome", "unknown").commit()
        assertEquals(InstallOutcome.IDLE, store.lastInstallResult.outcome)
        assertTrue(store.beginInstall(5, "token", download(), 2))
        assertNotNull(store.activeCallback())
        store.activeSessionId = null
        assertNull(UpdateStore(context).activeCallback())
    }

    @Test
    fun presentationSurvivesLossOfTransientStateButIsScopedToTheAuthenticatedSession() {
        val apk = download()
        assertTrue(store.beginInstall(5, "token", apk, 2))
        val callback = store.activeCallback()!!
        assertFalse(store.userActionPresented(callback))
        assertFalse(store.setUserActionPresented(callback, true))
        assertTrue(store.recordInstallResult(callback, InstallResult(InstallOutcome.AWAITING_USER_ACTION, -1), false))
        assertTrue(store.setUserActionPresented(callback, true))
        store.clearPendingUserAction()
        assertTrue(UpdateStore(context).userActionPresented(callback))
        listOf(UpdateStore.InstallCallback(4, "token"), UpdateStore.InstallCallback(5, "foreign")).forEach {
            assertFalse(store.userActionPresented(it))
            assertFalse(store.setUserActionPresented(it, false))
        }
        assertTrue(store.userActionPresented(callback))
        store.activeSessionId = null
        assertTrue(store.beginInstall(6, "next-token", apk, 3))
        val next = store.activeCallback()!!
        assertFalse(store.userActionPresented(next))
        assertFalse(store.userActionPresented(callback))
        assertFalse(store.setUserActionPresented(callback, true))
    }

    @Test
    fun eachNewAwaitingCallbackResetsPresentationAndTerminalCleanupRemovesIt() {
        assertTrue(store.beginInstall(5, "token", download(), 2))
        val callback = store.activeCallback()!!
        val awaiting = InstallResult(InstallOutcome.AWAITING_USER_ACTION, -1)
        assertTrue(store.recordInstallResult(callback, awaiting, false))
        assertTrue(store.setUserActionPresented(callback, true))
        assertTrue(store.recordInstallResult(callback, awaiting, false))
        assertFalse(UpdateStore(context).userActionPresented(callback))
        assertTrue(store.setUserActionPresented(callback, true))
        assertTrue(store.recordInstallResult(callback, InstallResult(InstallOutcome.ABORTED, 3), true))
        assertFalse(store.userActionPresented(callback))
        assertFalse(context.getSharedPreferences("app_updates", Context.MODE_PRIVATE).contains("user_action_presented"))
    }

    @Test
    fun recoveryCannotOverwriteAChangedResultOrAnUnrelatedCallback() {
        assertTrue(store.beginInstall(5, "token", download(), 2))
        val callback = store.activeCallback()!!
        val beforeCallback = store.lastInstallResult
        val awaiting = InstallResult(InstallOutcome.AWAITING_USER_ACTION, -1, sessionId = 5)
        assertTrue(store.recordInstallResult(callback, awaiting, false))
        assertFalse(
            store.recordInstallResult(
                callback,
                InstallResult(InstallOutcome.ABORTED, 3),
                terminal = true,
                expectedResult = beforeCallback,
            ),
        )
        assertEquals(awaiting, store.lastInstallResult)
        assertEquals(5, store.activeSessionId)
        assertTrue(File(store.downloadedApk!!).exists())
    }

    @Test
    fun verifiedDownloadStaysDurableUntilAnInstallOrCleanupTakesIt() {
        val apk = download()
        assertTrue(store.rememberVerifiedDownload(apk, 2))
        assertEquals(UpdateStore.VerifiedDownload(apk.canonicalFile, 2), UpdateStore(context).verifiedDownload())
        // A plain path update drops the version, so a different file cannot inherit it.
        store.downloadedApk = apk.path
        assertNull(store.verifiedDownload())
        assertTrue(store.rememberVerifiedDownload(apk, 2))
        assertTrue(store.beginInstall(5, "token", apk, 2))
        assertNull(store.verifiedDownload())
        assertEquals(apk.canonicalPath, store.downloadedApk)
        store.failInstall(5)
        assertFalse(apk.exists())

        val next = download()
        assertTrue(store.rememberVerifiedDownload(next, 3))
        store.clearDownload()
        assertNull(store.verifiedDownload())
        assertFalse(next.exists())
        assertFalse(store.rememberVerifiedDownload(File(context.filesDir, "outside.apk"), 3))
        assertFalse(store.rememberVerifiedDownload(download(), 0))
        assertNull(store.verifiedDownload())
    }

    @Test
    fun consentWaitIsConditionalAndEndsWithAnyNewResultOrSession() {
        val apk = download()
        assertTrue(store.beginInstall(5, "token", apk, 2))
        val callback = store.activeCallback()!!
        val awaiting = InstallResult(InstallOutcome.AWAITING_USER_ACTION, -1, sessionId = 5)
        assertTrue(store.recordInstallResult(callback, awaiting, false))
        assertFalse(store.beginConsentWait(callback, awaiting.copy(status = 0), 100))
        assertFalse(store.beginConsentWait(UpdateStore.InstallCallback(5, "foreign"), awaiting, 100))
        assertNull(store.consentWaitStartedAt(callback))

        assertTrue(store.beginConsentWait(callback, awaiting, 100))
        assertEquals(InstallResult(InstallOutcome.VERIFYING, sessionId = 5), UpdateStore(context).lastInstallResult)
        assertEquals(100L, UpdateStore(context).consentWaitStartedAt(callback))
        assertNull(store.consentWaitStartedAt(UpdateStore.InstallCallback(5, "foreign")))
        assertTrue(store.recordInstallResult(callback, InstallResult(InstallOutcome.VERIFYING), false))
        assertNull(store.consentWaitStartedAt(callback))

        assertTrue(store.beginConsentWait(callback, store.lastInstallResult, 200))
        assertEquals(200L, store.consentWaitStartedAt(callback))
        store.activeSessionId = null
        assertTrue(store.beginInstall(6, "next-token", apk, 3))
        assertNull(store.consentWaitStartedAt(store.activeCallback()!!))
        assertFalse(context.getSharedPreferences("app_updates", Context.MODE_PRIVATE).contains("consent_wait_started"))
    }

    private fun download(): File = File(updates, "candidate.apk").apply { writeText("apk") }
}
