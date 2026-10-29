package io.github.sillybunnyteam.sillybunny.update

import android.app.Activity
import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentSender
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.Signature
import android.content.pm.SigningInfo
import android.os.Build
import android.os.Looper
import android.provider.Settings
import androidx.test.core.app.ApplicationProvider
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.io.OutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutionException
import java.util.concurrent.FutureTask
import java.util.concurrent.TimeUnit
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.shadow.api.Shadow
import org.robolectric.shadows.ShadowSigningInfo

@RunWith(RobolectricTestRunner::class)
@Config(
    sdk = [29, 31, 34, 35, 37],
    shadows = [
        UpdateInstallerTest.RecordingPackageInstaller::class,
        UpdateInstallerTest.RecordingParams::class,
        UpdateInstallerTest.RecordingSession::class,
        UpdateInstallerTest.RecordingSessionInfo::class,
        ApkVerifierTest.ArchivePackageManager::class,
        ApkVerifierTest.ArchiveFlagsPackageManager::class,
    ],
)
class UpdateInstallerTest {
    private lateinit var context: Context
    private lateinit var store: UpdateStore
    private lateinit var apk: File
    private val signer = Signature("010203")

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        context.getSharedPreferences("app_updates", Context.MODE_PRIVATE).edit().clear().commit()
        store = UpdateStore(context)
        val updates = File(context.cacheDir, "updates").apply { mkdirs() }
        apk = File(updates, "candidate.apk").apply { writeBytes(ByteArray(150_000) { it.toByte() }) }
        shadowOf(context.packageManager).setCanRequestPackageInstalls(true)
        shadowOf(context.packageManager).getInternalMutablePackageInfo(context.packageName).apply {
            signingInfo = signing(signer)
            longVersionCode = 1
        }
        setArchive()
        state = InstallState()
        UpdateInstaller.resetForTest()
    }

    @After
    fun tearDown() {
        UpdateInstaller.awaitBackgroundWork()
        UpdateForeground.currentActivity()?.let(UpdateForeground::detach)
        store.failInstall(store.activeSessionId)
        File(context.cacheDir, "updates").deleteRecursively()
        UpdateInstaller.resetForTest()
    }

    @Test
    fun callbackIsExplicitMutableOnlyOn31AndLaterAndNeverOneShotOrImmutable() {
        val installer = UpdateInstaller(context)
        val action = installer.newCallbackAction(47)
        val pending = shadowOf(installer.callbackPendingIntent(47, action))
        assertTrue(pending.isBroadcast)
        assertEquals(ComponentName(context, InstallStatusReceiver::class.java), pending.savedIntent.component)
        assertEquals(context.packageName, pending.savedIntent.`package`)
        assertEquals(action, pending.savedIntent.action)
        assertEquals(47, pending.requestCode)
        assertFalse(pending.savedIntent.hasExtra(PackageInstaller.EXTRA_STATUS))
        assertFalse(pending.savedIntent.hasExtra(PackageInstaller.EXTRA_SESSION_ID))
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or
            if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0
        assertEquals(flags, pending.flags)
        assertEquals(flags, UpdateInstaller.callbackPendingIntentFlags())
        assertEquals(0, pending.flags and PendingIntent.FLAG_IMMUTABLE)
        assertEquals(0, pending.flags and PendingIntent.FLAG_ONE_SHOT)
        assertNotEquals(action, installer.newCallbackAction(47))
        assertNotEquals(
            installer.callbackPendingIntent(47, action),
            installer.callbackPendingIntent(47, installer.newCallbackAction(47)),
        )
    }

    @Test
    fun mutableCommitCallbackAcceptsTheSystemStatusFillInWithoutChangingItsIdentity() {
        val application = ApplicationProvider.getApplicationContext<android.app.Application>()
        val installer = UpdateInstaller(context)
        val action = installer.newCallbackAction(47)
        val callback = installer.callbackPendingIntent(47, action)
        callback.send(
            context,
            0,
            Intent()
                .putExtra(PackageInstaller.EXTRA_SESSION_ID, 47)
                .putExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_PENDING_USER_ACTION),
        )
        val delivered = shadowOf(application).broadcastIntents.last()
        assertEquals(action, delivered.action)
        assertEquals(ComponentName(context, InstallStatusReceiver::class.java), delivered.component)
        assertEquals(47, delivered.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1))
        assertEquals(
            PackageInstaller.STATUS_PENDING_USER_ACTION,
            delivered.getIntExtra(PackageInstaller.EXTRA_STATUS, 999),
        )
    }

    @Test
    fun sessionParametersAlwaysRequireAFullUserApprovedUpdateWithoutOwnership() {
        val params = Shadow.extract<RecordingParams>(UpdateInstaller(context).sessionParams(456L))
        assertEquals(PackageInstaller.SessionParams.MODE_FULL_INSTALL, params.mode)
        assertEquals(context.packageName, params.packageName)
        assertEquals(456L, params.sizeBytes)
        assertEquals(
            if (Build.VERSION.SDK_INT >= 31) PackageInstaller.SessionParams.USER_ACTION_REQUIRED else null,
            params.userAction,
        )
        assertFalse(params.requestedOwnership)
    }

    @Test
    fun unknownSourcesSettingsArePackageScopedAndDenialDoesNotStopOrCreateAnything() {
        shadowOf(context.packageManager).setCanRequestPackageInstalls(false)
        var stops = 0
        val installer = UpdateInstaller(context, ServerController { stops++ })
        assertFalse(installer.canInstall())
        assertEquals(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, installer.unknownSourcesIntent().action)
        assertEquals("package:${context.packageName}", installer.unknownSourcesIntent().dataString)
        assertThrows(UnknownSourcesRequiredException::class.java) { worker { installer.install(apk, 2) } }
        assertEquals(0, stops)
        assertEquals(0, state.creates)
        assertEquals(0, state.commits)
        assertNull(store.activeSessionId)
        assertTrue(apk.exists())
    }

    @Test
    fun installationIsRejectedOnMainBeforeStoppingTheServer() {
        var stops = 0
        val installer = UpdateInstaller(context, ServerController { stops++ })
        val error = assertThrows(UpdateInstallException::class.java) { installer.install(apk, 2) }
        assertEquals(UpdateInstallFailure.MAIN_THREAD, error.failure)
        assertEquals(0, stops)
        assertEquals(0, state.creates)
    }

    @Test
    fun installationStopsSynchronouslyOffMainStreamsAndFsyncsBeforeCommittingPersistedState() {
        val bytes = apk.readBytes()
        var stops = 0
        val installer = UpdateInstaller(context, ServerController {
            assertNotEquals(Looper.getMainLooper(), Looper.myLooper())
            assertEquals(0, state.creates)
            assertEquals(0, state.commits)
            stops++
        })
        state.onCommit = {
            assertEquals(1, stops)
            assertTrue(state.fsynced)
            assertTrue(state.outputClosed)
            assertEquals(47, UpdateStore(context).activeSessionId)
            assertEquals(apk.canonicalPath, UpdateStore(context).downloadedApk)
            assertNotNull(UpdateStore(context).activeCallback())
            assertEquals(InstallOutcome.VERIFYING, UpdateStore(context).lastInstallResult.outcome)
        }
        assertEquals(47, worker { installer.install(apk, 2) })
        assertEquals(1, stops)
        assertEquals(1, state.creates)
        assertEquals(1, state.commits)
        assertEquals("base.apk", state.streamName)
        assertEquals(0L, state.offset)
        assertEquals(bytes.size.toLong(), state.length)
        assertArrayEquals(bytes, state.output.toByteArray())
        assertTrue(state.closed)
        assertEquals(0, state.abandons)
        assertEquals(47, store.activeSessionId)
        assertTrue(apk.exists())
    }

    @Test
    fun defaultControllerDoesNotStartOrStopAnyAndroidService() {
        assertEquals(47, worker { UpdateInstaller(context).install(apk, 2) })
        val application = ApplicationProvider.getApplicationContext<android.app.Application>()
        assertNull(shadowOf(application).nextStartedService)
        assertNull(shadowOf(application).nextStoppedService)
    }

    @Test
    fun asyncCommitCanDeliverATerminalCallbackBeforeItReturnsWithoutResurrectingState() {
        state.onCommit = {
            val callback = store.activeCallback()!!
            InstallStatusReceiver().onReceive(
                context,
                Intent(context, InstallStatusReceiver::class.java)
                    .setAction(callback.action)
                    .putExtra(PackageInstaller.EXTRA_SESSION_ID, callback.sessionId)
                    .putExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_SUCCESS),
            )
        }
        assertEquals(47, worker { UpdateInstaller(context).install(apk, 2) })
        assertEquals(InstallOutcome.SUCCESS, store.lastInstallResult.outcome)
        assertNull(store.activeSessionId)
        assertNull(store.downloadedApk)
        assertFalse(apk.exists())
        assertEquals(0, state.abandons)
    }

    @Test
    fun invalidPackageVersionSignerOrHistoricalKeyNeverStopsTheServer() {
        var stops = 0
        val installer = UpdateInstaller(context, ServerController { stops++ })
        val badArchives = listOf(
            packageInfo("foreign.package", 2, signing(signer)),
            packageInfo(context.packageName, 3, signing(signer)),
            packageInfo(context.packageName, 2, signing(Signature("040506"))),
            packageInfo(context.packageName, 2, signing(signer, Signature("040506"))),
        )
        badArchives.forEach { archive ->
            apk.writeText("apk")
            shadowOf(context.packageManager).setPackageArchiveInfo(apk.canonicalPath, archive)
            val error = assertThrows(UpdateInstallException::class.java) { worker { installer.install(apk, 2) } }
            assertEquals(UpdateInstallFailure.INVALID_ARCHIVE, error.failure)
            assertEquals(0, stops)
            assertEquals(0, state.creates)
            assertFalse(apk.exists())
        }
        apk.writeText("apk")
        val current = signing(Signature("040506"))
        Shadow.extract<ShadowSigningInfo>(current).setPastSigningCertificates(arrayOf(signer))
        shadowOf(context.packageManager).getInternalMutablePackageInfo(context.packageName).signingInfo = current
        setArchive()
        assertThrows(UpdateInstallException::class.java) { worker { installer.install(apk, 2) } }
        assertEquals(0, stops)
        assertEquals(0, state.creates)
    }

    @Test
    fun missingInstalledSignerOrMultipleCurrentSignersIsRejected() {
        val installed = shadowOf(context.packageManager).getInternalMutablePackageInfo(context.packageName)
        installed.signingInfo = null
        assertThrows(UpdateInstallException::class.java) { worker { UpdateInstaller(context).install(apk, 2) } }
        apk.writeText("apk")
        installed.signingInfo = signing(signer, Signature("040506"))
        assertThrows(UpdateInstallException::class.java) { worker { UpdateInstaller(context).install(apk, 2) } }
        assertEquals(0, state.creates)
        assertNull(store.activeSessionId)
    }

    @Test
    fun versionThatBecameCurrentDuringSourceApprovalIsRejectedBeforeStopping() {
        shadowOf(context.packageManager).getInternalMutablePackageInfo(context.packageName).longVersionCode = 2
        var stops = 0
        val installer = UpdateInstaller(context, ServerController { stops++ })
        val error = assertThrows(UpdateInstallException::class.java) { worker { installer.install(apk, 2) } }
        assertEquals(UpdateInstallFailure.INVALID_ARCHIVE, error.failure)
        assertEquals(0, stops)
        assertEquals(0, state.creates)
        assertFalse(apk.exists())
    }

    @Test
    fun alreadyActiveSessionIsNotReplacedAndCannotLoseItsDownload() {
        assertTrue(store.beginInstall(8, "old-action", apk, 2))
        var stops = 0
        val installer = UpdateInstaller(context, ServerController { stops++ })
        val error = assertThrows(UpdateInstallException::class.java) { worker { installer.install(apk, 2) } }
        assertEquals(UpdateInstallFailure.ALREADY_INSTALLING, error.failure)
        assertEquals(0, stops)
        assertEquals(0, state.creates)
        assertEquals(8, store.activeSessionId)
        assertTrue(apk.exists())
    }

    @Test
    fun unownedFilesAreRejectedWithoutDeletingThem() {
        val outside = File(context.filesDir, "keep.apk").apply { writeText("keep") }
        try {
            val error = assertThrows(UpdateInstallException::class.java) {
                worker { UpdateInstaller(context).install(outside, 2) }
            }
            assertEquals(UpdateInstallFailure.INVALID_ARCHIVE, error.failure)
            assertTrue(outside.exists())
            assertEquals(0, state.creates)
        } finally {
            outside.delete()
        }
    }

    @Test
    fun createOpenWriteFsyncAndCommitFailuresAbandonAndCleanUpWithoutLeakingRawErrors() {
        listOf("create", "open", "write", "fsync", "commit").forEach { stage ->
            apk.writeText("apk")
            state = InstallState().apply { failAt = stage }
            val error = assertThrows(UpdateInstallException::class.java) {
                worker { UpdateInstaller(context).install(apk, 2) }
            }
            assertEquals(UpdateInstallFailure.SESSION_FAILED, error.failure)
            assertNull(error.message)
            assertNull(error.cause)
            assertNull(store.activeSessionId)
            assertNull(store.downloadedApk)
            assertEquals(InstallOutcome.FAILED, store.lastInstallResult.outcome)
            assertFalse(apk.exists())
            assertEquals(if (stage == "create") 0 else 1, state.abandons)
        }
    }

    @Test
    fun serverStopFailurePreventsSessionCreationAndCleansTheDownload() {
        val installer = UpdateInstaller(context, ServerController { throw IllegalStateException("private detail") })
        val error = assertThrows(UpdateInstallException::class.java) { worker { installer.install(apk, 2) } }
        assertEquals(UpdateInstallFailure.SESSION_FAILED, error.failure)
        assertNull(error.message)
        assertEquals(0, state.creates)
        assertEquals(0, state.commits)
        assertFalse(apk.exists())
    }

    @Test
    fun localCloseFailureDoesNotUndoAnAcceptedCommit() {
        state.failAt = "close"
        assertEquals(47, worker { UpdateInstaller(context).install(apk, 2) })
        assertEquals(1, state.commits)
        assertEquals(0, state.abandons)
        assertEquals(47, store.activeSessionId)
        assertTrue(apk.exists())
    }

    @Test
    fun missingPendingIntentAbandonsAnIdleOwnedSessionAndLeavesTheUiAbleToRetry() {
        beginPendingRecovery()
        state.sessionPresent = true
        state.sessionPackage = context.packageName
        val activity = foregroundActivity()
        assertFalse(UpdateInstaller(context).resumePendingUserAction(activity))
        UpdateInstaller.awaitBackgroundWork()
        assertEquals(1, state.abandons)
        assertEquals(InstallOutcome.ABORTED, store.lastInstallResult.outcome)
        assertNull(store.activeSessionId)
        assertFalse(apk.exists())
        assertNull(shadowOf(activity).nextStartedActivity)
    }

    @Test
    fun consumedConfirmationAlreadyInstallingIsNotAbandonedOrReopened() {
        beginPendingRecovery()
        presentPendingConfirmation()
        store.clearPendingUserAction()
        state.sessionPresent = true
        state.sessionPackage = context.packageName
        state.sessionActive = true
        state.sessionSealed = true
        val activity = foregroundActivity()
        assertFalse(UpdateInstaller(context).resumePendingUserAction(activity))
        UpdateInstaller.awaitBackgroundWork()
        assertEquals(0, state.abandons)
        assertEquals(InstallOutcome.VERIFYING, store.lastInstallResult.outcome)
        assertEquals(47, store.activeSessionId)
        assertTrue(apk.exists())
        assertNull(shadowOf(activity).nextStartedActivity)
    }

    @Test
    fun lostUnpresentedConfirmationIsAbandonedEvenIfDeveloperVerificationKeptTheSessionActive() {
        beginPendingRecovery()
        state.sessionPresent = true
        state.sessionPackage = context.packageName
        state.sessionSealed = true
        state.sessionActive = true
        store.clearPendingUserAction()
        val activity = foregroundActivity()
        assertFalse(UpdateInstaller(context).resumePendingUserAction(activity))
        UpdateInstaller.awaitBackgroundWork()
        assertEquals(1, state.abandons)
        assertEquals(InstallOutcome.ABORTED, store.lastInstallResult.outcome)
        assertNull(store.activeSessionId)
        assertFalse(apk.exists())
        assertNull(shadowOf(activity).nextStartedActivity)
    }

    @Test
    fun launchRecoveryAbandonsAPersistedSessionIfTheProcessDiedImmediatelyBeforeCommit() {
        state.failAt = "process-death"
        assertThrows(SimulatedProcessDeath::class.java) { worker { UpdateInstaller(context).install(apk, 2) } }
        assertEquals(0, state.commits)
        assertEquals(0, state.abandons)
        assertEquals(InstallOutcome.VERIFYING, store.lastInstallResult.outcome)
        assertEquals(47, store.activeSessionId)
        assertTrue(apk.exists())

        worker { UpdateInstaller(context).reconcileAfterLaunch() }
        assertEquals(1, state.abandons)
        assertEquals(InstallOutcome.ABORTED, store.lastInstallResult.outcome)
        assertNull(store.activeSessionId)
        assertFalse(apk.exists())
        apk.writeText("retry")
        assertTrue(store.beginInstall(48, "retry-callback", apk, 2))
    }

    @Test
    fun launchRecoveryReleasesMissingUnsealedAndInactiveVerifyingSessions() {
        listOf("missing", "unsealed", "inactive").forEach { scenario ->
            apk.writeText("apk")
            assertTrue(store.beginInstall(47, "recovery-$scenario", apk, 2))
            state = InstallState().apply {
                sessionPresent = scenario != "missing"
                sessionPackage = context.packageName
                sessionSealed = scenario == "inactive"
                sessionActive = scenario == "unsealed"
            }
            worker { UpdateInstaller(context).reconcileAfterLaunch() }
            assertEquals(if (scenario == "missing") 0 else 1, state.abandons)
            assertEquals(InstallOutcome.ABORTED, store.lastInstallResult.outcome)
            assertNull(store.activeCallback())
            assertNull(store.activeSessionId)
            assertNull(store.downloadedApk)
            assertFalse(apk.exists())
        }
    }

    @Test
    fun launchRecoveryRetainsSealedActiveVerifyingWorkAndCanLaterObserveItGone() {
        assertTrue(store.beginInstall(47, "committed-callback", apk, 2))
        state.sessionPresent = true
        state.sessionPackage = context.packageName
        state.sessionSealed = true
        state.sessionActive = true
        worker { UpdateInstaller(context).reconcileAfterLaunch() }
        assertEquals(InstallOutcome.VERIFYING, store.lastInstallResult.outcome)
        assertEquals(47, store.activeSessionId)
        assertEquals(0, state.abandons)
        assertTrue(apk.exists())
        state.sessionPresent = false
        worker { UpdateInstaller(context).reconcileAfterLaunch() }
        assertEquals(InstallOutcome.ABORTED, store.lastInstallResult.outcome)
        assertNull(store.activeSessionId)
        assertFalse(apk.exists())
    }

    @Test
    fun launchRecoveryDistinguishesLostUnpresentedAndPresentedActiveConfirmations() {
        listOf(false, true).forEach { presented ->
            apk.writeText("apk")
            beginPendingRecovery()
            if (presented) presentPendingConfirmation()
            store.clearPendingUserAction()
            state = InstallState().apply {
                sessionPresent = true
                sessionPackage = context.packageName
                sessionSealed = true
                sessionActive = true
            }
            worker { UpdateInstaller(context).reconcileAfterLaunch() }
            if (presented) {
                assertEquals(InstallOutcome.VERIFYING, store.lastInstallResult.outcome)
                assertEquals(47, store.activeSessionId)
                assertEquals(0, state.abandons)
                assertTrue(apk.exists())
                store.failInstall(47)
            } else {
                assertEquals(InstallOutcome.ABORTED, store.lastInstallResult.outcome)
                assertNull(store.activeSessionId)
                assertEquals(1, state.abandons)
                assertFalse(apk.exists())
            }
        }
    }

    @Test
    fun launchRecoveryKeepsAConfirmationAvailableAcrossSameProcessRecreationWithoutLaunchingIt() {
        beginPendingRecovery()
        val callback = store.activeCallback()!!
        val intent = Intent("fixture.CONFIRM").setComponent(ComponentName("fixture.installer", "fixture.Confirm"))
        store.rememberPendingUserAction(callback, intent)
        state.sessionPresent = true
        state.sessionPackage = context.packageName
        state.sessionSealed = true
        state.sessionActive = false
        worker { UpdateInstaller(context).reconcileAfterLaunch() }
        assertEquals(InstallOutcome.AWAITING_USER_ACTION, store.lastInstallResult.outcome)
        assertEquals(47, store.activeSessionId)
        assertEquals(0, state.abandons)
        assertTrue(apk.exists())
        val activity = foregroundActivity()
        assertTrue(UpdateInstaller(context).resumePendingUserAction(activity))
        assertEquals("fixture.CONFIRM", shadowOf(activity).nextStartedActivity.action)
    }

    @Test
    fun launchRecoveryDoesNotAbortAPresentedConfirmationDuringSameProcessRecreation() {
        beginPendingRecovery()
        presentPendingConfirmation()
        val activity = foregroundActivity()
        state.sessionPresent = true
        state.sessionPackage = context.packageName
        state.sessionSealed = true
        state.sessionActive = true
        worker { UpdateInstaller(context).reconcileAfterLaunch() }
        assertEquals(InstallOutcome.VERIFYING, store.lastInstallResult.outcome)
        assertEquals(0, state.abandons)
        assertEquals(47, store.activeSessionId)
        assertFalse(UpdateInstaller(context).resumePendingUserAction(activity))
        UpdateInstaller.awaitBackgroundWork()
        assertEquals(InstallOutcome.VERIFYING, store.lastInstallResult.outcome)
    }

    @Test
    fun launchRecoveryRecognizesInstalledVersionBeforeMissingSessionOrLostConfirmation() {
        listOf(InstallOutcome.VERIFYING, InstallOutcome.AWAITING_USER_ACTION).forEach { outcome ->
            apk.writeText("apk")
            assertTrue(store.beginInstall(47, "completed-$outcome", apk, 2))
            store.recordInstallResult(store.activeCallback()!!, InstallResult(outcome), terminal = false)
            shadowOf(context.packageManager).getInternalMutablePackageInfo(context.packageName).longVersionCode = 2
            worker { UpdateInstaller(context).reconcileAfterLaunch() }
            assertEquals(InstallOutcome.SUCCESS, store.lastInstallResult.outcome)
            assertNull(store.activeSessionId)
            assertEquals(0, state.abandons)
            assertFalse(apk.exists())
        }
    }

    @Test
    fun launchRecoveryRejectsMainThreadAndDoesNotTouchUnrelatedSessions() {
        val error = assertThrows(UpdateInstallException::class.java) { UpdateInstaller(context).reconcileAfterLaunch() }
        assertEquals(UpdateInstallFailure.MAIN_THREAD, error.failure)
        assertTrue(store.beginInstall(47, "ours", apk, 2))
        state.sessionPresent = true
        state.sessionPackage = "other.package"
        worker { UpdateInstaller(context).reconcileAfterLaunch() }
        assertEquals(0, state.abandons)
        assertEquals(InstallOutcome.FAILED, store.lastInstallResult.outcome)
        assertNull(store.activeSessionId)
        assertFalse(apk.exists())
    }

    @Test
    fun launchRecoveryReleasesUntrackedOwnedSessionsAndUnauthenticatedVerifyingState() {
        state.sessionPresent = true
        state.sessionPackage = context.packageName
        worker { UpdateInstaller(context).reconcileAfterLaunch() }
        assertEquals(InstallResult(), store.lastInstallResult)
        // getMySessions lists only sessions this app created, so one that no install tracks is a leak.
        assertEquals(1, state.abandons)
        state.sessionPresent = true
        store.activeSessionId = 47
        store.downloadedApk = apk.path
        store.lastInstallResult = InstallResult(InstallOutcome.VERIFYING, sessionId = 47)
        worker { UpdateInstaller(context).reconcileAfterLaunch() }
        assertEquals(InstallOutcome.FAILED, store.lastInstallResult.outcome)
        assertEquals(2, state.abandons)
        assertNull(store.activeSessionId)
        assertFalse(apk.exists())
    }

    @Test
    fun launchRecoveryAbandonsASessionLeftUntrackedByProcessDeathWhileStreaming() {
        state.failAt = "death-after-create"
        assertThrows(SimulatedProcessDeath::class.java) { worker { UpdateInstaller(context).install(apk, 2) } }
        assertNull(store.activeSessionId)
        assertTrue(state.sessionPresent)
        state.orphans += 52 to "other.package"
        state.orphans += 53 to context.packageName
        worker { UpdateInstaller(context).reconcileAfterLaunch() }
        assertEquals(1, state.abandons)
        assertFalse(state.sessionPresent)
        assertEquals(listOf(53), state.abandonedOrphans)
        assertEquals(listOf(52), state.orphans.map { it.first })
        assertEquals(InstallResult(), store.lastInstallResult)
    }

    @Test
    fun launchRecoveryReleasesPersistedTerminalSessionMetadataWithoutChangingTheOutcome() {
        assertTrue(store.beginInstall(47, "terminal-callback", apk, 2))
        store.lastInstallResult = InstallResult(InstallOutcome.ABORTED, 3, sessionId = 47)
        state.sessionPresent = true
        state.sessionPackage = context.packageName
        state.sessionSealed = true
        state.sessionActive = true
        worker { UpdateInstaller(context).reconcileAfterLaunch() }
        assertEquals(InstallOutcome.ABORTED, store.lastInstallResult.outcome)
        assertNull(store.activeSessionId)
        assertEquals(1, state.abandons)
        assertFalse(apk.exists())
    }

    @Test
    fun launchRecoveryCannotOverwriteANewerPendingCallbackDeliveredDuringTheSessionQuery() {
        assertTrue(store.beginInstall(47, "query-callback", apk, 2))
        state.sessionPresent = true
        state.sessionPackage = context.packageName
        state.sessionSealed = true
        state.sessionActive = true
        state.onQuery = {
            state.onQuery = null
            InstallStatusReceiver().onReceive(
                context,
                Intent(context, InstallStatusReceiver::class.java)
                    .setAction("query-callback")
                    .putExtra(PackageInstaller.EXTRA_SESSION_ID, 47)
                    .putExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_PENDING_USER_ACTION)
                    .putExtra(Intent.EXTRA_INTENT, Intent("fixture.NEW_CONFIRMATION")),
            )
        }
        worker { UpdateInstaller(context).reconcileAfterLaunch() }
        assertEquals(InstallOutcome.AWAITING_USER_ACTION, store.lastInstallResult.outcome)
        assertNotNull(store.pendingUserAction(store.activeCallback()!!))
        assertFalse(store.userActionPresented(store.activeCallback()!!))
        assertEquals(0, state.abandons)
        assertTrue(apk.exists())
    }

    @Test
    fun launchRecoveryCannotAbandonAnInstallBetweenPersistingItsCallbackAndCommitting() {
        val beforeCommit = CountDownLatch(1)
        val releaseCommit = CountDownLatch(1)
        val recoveryStarted = CountDownLatch(1)
        state.onBeforeCommit = {
            beforeCommit.countDown()
            check(releaseCommit.await(10, TimeUnit.SECONDS))
        }
        val install = FutureTask { UpdateInstaller(context).install(apk, 2) }
        val installing = Thread(install, "install-before-commit")
        val recovery = FutureTask {
            recoveryStarted.countDown()
            UpdateInstaller(context).reconcileAfterLaunch()
        }
        val recovering = Thread(recovery, "launch-recovery")
        try {
            installing.start()
            assertTrue(beforeCommit.await(10, TimeUnit.SECONDS))
            assertEquals(InstallOutcome.VERIFYING, store.lastInstallResult.outcome)
            assertFalse(state.sessionSealed)
            recovering.start()
            assertTrue(recoveryStarted.await(10, TimeUnit.SECONDS))
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
            while (recovering.state != Thread.State.BLOCKED && !recovery.isDone && System.nanoTime() < deadline) {
                Thread.yield()
            }
            assertEquals(Thread.State.BLOCKED, recovering.state)
            assertEquals(0, state.abandons)
            releaseCommit.countDown()
            assertEquals(47, install.get(10, TimeUnit.SECONDS))
            recovery.get(10, TimeUnit.SECONDS)
            assertEquals(1, state.commits)
            assertEquals(0, state.abandons)
            assertEquals(InstallOutcome.VERIFYING, store.lastInstallResult.outcome)
            assertEquals(47, store.activeSessionId)
            assertTrue(apk.exists())
        } finally {
            releaseCommit.countDown()
            installing.interrupt()
            recovering.interrupt()
            installing.join(1_000)
            recovering.join(1_000)
        }
    }

    @Test
    fun recoveryDoesNotAbandonAnUnrelatedOwnedPackageSession() {
        beginPendingRecovery()
        state.sessionPresent = true
        state.sessionPackage = "unrelated.package"
        val activity = foregroundActivity()
        assertFalse(UpdateInstaller(context).resumePendingUserAction(activity))
        UpdateInstaller.awaitBackgroundWork()
        assertEquals(0, state.abandons)
        assertEquals(InstallOutcome.FAILED, store.lastInstallResult.outcome)
        assertNull(store.activeSessionId)
        assertFalse(apk.exists())
    }

    @Test
    fun recoveryQueryOrAbandonFailuresDoNotLeaveAwaitingStateOrExposeRawMessages() {
        listOf("query", "abandon").forEach { failure ->
            apk.writeText("apk")
            beginPendingRecovery()
            state.sessionPresent = true
            state.sessionPackage = context.packageName
            state.failAt = failure
            val activity = foregroundActivity()
            assertFalse(UpdateInstaller(context).resumePendingUserAction(activity))
            UpdateInstaller.awaitBackgroundWork()
            assertEquals(InstallOutcome.FAILED, store.lastInstallResult.outcome)
            assertNull(store.activeSessionId)
            assertFalse(apk.exists())
        }
    }

    @Test
    fun recoveryRecognizesAReplacementWhoseFinalCallbackWasLost() {
        beginPendingRecovery()
        shadowOf(context.packageManager).getInternalMutablePackageInfo(context.packageName).longVersionCode = 2
        val activity = foregroundActivity()
        assertFalse(UpdateInstaller(context).resumePendingUserAction(activity))
        UpdateInstaller.awaitBackgroundWork()
        assertEquals(InstallOutcome.SUCCESS, store.lastInstallResult.outcome)
        assertNull(store.activeSessionId)
        assertFalse(apk.exists())
        assertEquals(0, state.abandons)
    }

    @Test
    fun approvedConfirmationIsKeptWhenTheSessionStaysInactiveAfterConsentAsOnAndroid10To13() {
        installAndPresentConfirmation()
        platformAppliesConsent(reactivates = false)
        val activity = foregroundActivity()
        assertFalse(UpdateInstaller(context).resumePendingUserAction(activity))
        UpdateInstaller.awaitBackgroundWork()
        assertEquals(0, state.abandons)
        assertEquals(InstallOutcome.VERIFYING, store.lastInstallResult.outcome)
        assertEquals(47, store.activeSessionId)
        assertTrue(apk.exists())
        assertNull(shadowOf(activity).nextStartedActivity)

        // A later launch, for example after the process died, must not abandon it either.
        store.clearPendingUserAction()
        worker { UpdateInstaller(context).reconcileAfterLaunch() }
        assertEquals(0, state.abandons)
        assertEquals(InstallOutcome.VERIFYING, store.lastInstallResult.outcome)
        assertEquals(47, store.activeSessionId)
    }

    @Test
    fun processDeathAfterConsentDoesNotAbandonTheApprovedSessionAtLaunch() {
        installAndPresentConfirmation()
        platformAppliesConsent(reactivates = false)
        store.clearPendingUserAction()
        worker { UpdateInstaller(context).reconcileAfterLaunch() }
        assertEquals(0, state.abandons)
        assertEquals(InstallOutcome.VERIFYING, store.lastInstallResult.outcome)
        assertEquals(47, store.activeSessionId)
        assertTrue(apk.exists())
    }

    @Test
    fun confirmationThatReturnsBeforeThePlatformAppliesConsentWaitsInsteadOfAbandoning() {
        var now = 1_000L
        UpdateInstaller.clock = { now }
        installAndPresentConfirmation()
        assertFalse(UpdateInstaller(context).resumePendingUserAction(foregroundActivity()))
        UpdateInstaller.awaitBackgroundWork()
        assertEquals(0, state.abandons)
        assertEquals(InstallOutcome.VERIFYING, store.lastInstallResult.outcome)
        assertEquals(47, store.activeSessionId)

        platformAppliesConsent(reactivates = Build.VERSION.SDK_INT >= 34)
        now += UpdateInstaller.consentGraceMillis
        worker { UpdateInstaller(context).reconcileAfterLaunch() }
        assertEquals(0, state.abandons)
        assertEquals(InstallOutcome.VERIFYING, store.lastInstallResult.outcome)
        assertEquals(47, store.activeSessionId)
        assertTrue(apk.exists())
    }

    @Test
    fun unansweredConfirmationIsReleasedOnlyAfterTheConsentGracePeriod() {
        var now = 1_000L
        UpdateInstaller.clock = { now }
        installAndPresentConfirmation()
        assertFalse(UpdateInstaller(context).resumePendingUserAction(foregroundActivity()))
        UpdateInstaller.awaitBackgroundWork()
        assertEquals(InstallOutcome.VERIFYING, store.lastInstallResult.outcome)

        now += UpdateInstaller.consentGraceMillis - 1
        worker { UpdateInstaller(context).reconcileAfterLaunch() }
        assertEquals(0, state.abandons)
        assertEquals(InstallOutcome.VERIFYING, store.lastInstallResult.outcome)

        now += 1
        worker { UpdateInstaller(context).reconcileAfterLaunch() }
        assertEquals(1, state.abandons)
        assertEquals(InstallOutcome.ABORTED, store.lastInstallResult.outcome)
        assertNull(store.activeSessionId)
        assertFalse(apk.exists())
    }

    @Test
    fun scheduledRecheckReleasesAnUnansweredConfirmationWithoutAnotherLaunch() {
        UpdateInstaller.clock = { TimeUnit.NANOSECONDS.toMillis(System.nanoTime()) }
        UpdateInstaller.consentGraceMillis = 200
        installAndPresentConfirmation()
        assertFalse(UpdateInstaller(context).resumePendingUserAction(foregroundActivity()))
        UpdateInstaller.awaitBackgroundWork()
        assertEquals(InstallOutcome.VERIFYING, store.lastInstallResult.outcome)
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
        while (store.lastInstallResult.outcome == InstallOutcome.VERIFYING && System.nanoTime() < deadline) {
            Thread.sleep(20)
        }
        UpdateInstaller.awaitBackgroundWork()
        assertEquals(InstallOutcome.ABORTED, store.lastInstallResult.outcome)
        assertEquals(1, state.abandons)
        assertNull(store.activeSessionId)
    }

    @Test
    fun approvedSessionThatFinishedBeforeItsResultArrivedEndsWithThePlatformResult() {
        UpdateInstaller.clock = { 1_000L }
        installAndPresentConfirmation()
        // The platform drops a finished session before its final status reaches the receiver.
        state.sessionPresent = false
        assertFalse(UpdateInstaller(context).resumePendingUserAction(foregroundActivity()))
        UpdateInstaller.awaitBackgroundWork()
        assertEquals(InstallOutcome.VERIFYING, store.lastInstallResult.outcome)
        assertEquals(47, store.activeSessionId)

        InstallStatusReceiver().onReceive(
            context,
            Intent(context, InstallStatusReceiver::class.java)
                .setAction(store.activeCallback()!!.action)
                .putExtra(PackageInstaller.EXTRA_SESSION_ID, 47)
                .putExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE_CONFLICT),
        )
        assertEquals(InstallOutcome.FAILED, store.lastInstallResult.outcome)
        assertEquals(PackageInstaller.STATUS_FAILURE_CONFLICT, store.lastInstallResult.status)
        assertEquals(0, state.abandons)
        assertNull(store.activeSessionId)
    }

    @Test
    fun sessionThatVanishedAfterItsConfirmationWithoutAResultIsReleasedAfterTheGracePeriod() {
        var now = 1_000L
        UpdateInstaller.clock = { now }
        installAndPresentConfirmation()
        state.sessionPresent = false
        assertFalse(UpdateInstaller(context).resumePendingUserAction(foregroundActivity()))
        UpdateInstaller.awaitBackgroundWork()
        assertEquals(InstallOutcome.VERIFYING, store.lastInstallResult.outcome)

        now += UpdateInstaller.consentGraceMillis - 1
        worker { UpdateInstaller(context).reconcileAfterLaunch() }
        assertEquals(InstallOutcome.VERIFYING, store.lastInstallResult.outcome)

        now += 1
        worker { UpdateInstaller(context).reconcileAfterLaunch() }
        assertEquals(InstallOutcome.ABORTED, store.lastInstallResult.outcome)
        assertEquals(0, state.abandons)
        assertNull(store.activeSessionId)
        assertFalse(apk.exists())
    }

    @Test
    fun confirmationRecoveryQueriesAndAbandonsSessionsOffTheMainThread() {
        beginPendingRecovery()
        state.sessionPresent = true
        state.sessionPackage = context.packageName
        val activity = foregroundActivity()
        assertFalse(UpdateInstaller(context).resumePendingUserAction(activity))
        UpdateInstaller.awaitBackgroundWork()
        assertEquals(1, state.abandons)
        assertEquals(InstallOutcome.ABORTED, store.lastInstallResult.outcome)
        assertEquals(0, state.mainThreadSessionCalls)

        // A confirmation callback without an intent reaches the same recovery from the receiver.
        apk.writeText("apk")
        assertTrue(store.beginInstall(47, "receiver-callback", apk, 2))
        state.sessionPresent = true
        InstallStatusReceiver().onReceive(
            context,
            Intent(context, InstallStatusReceiver::class.java)
                .setAction("receiver-callback")
                .putExtra(PackageInstaller.EXTRA_SESSION_ID, 47)
                .putExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_PENDING_USER_ACTION),
        )
        UpdateInstaller.awaitBackgroundWork()
        assertEquals(2, state.abandons)
        assertEquals(InstallOutcome.ABORTED, store.lastInstallResult.outcome)
        assertEquals(0, state.mainThreadSessionCalls)

        // Lost callback authentication is released off the main thread as well.
        state.sessionPresent = true
        store.activeSessionId = 47
        store.lastInstallResult = InstallResult(InstallOutcome.AWAITING_USER_ACTION, sessionId = 47)
        assertFalse(UpdateInstaller(context).resumePendingUserAction(activity))
        UpdateInstaller.awaitBackgroundWork()
        assertEquals(3, state.abandons)
        assertEquals(InstallOutcome.FAILED, store.lastInstallResult.outcome)
        assertEquals(0, state.mainThreadSessionCalls)
    }

    private fun installAndPresentConfirmation() {
        assertEquals(47, worker { UpdateInstaller(context).install(apk, 2) })
        // AOSP 10-17 drop the commit's active reference when they send the confirmation intent.
        state.sessionActive = false
        presentPendingConfirmation()
        assertEquals(InstallOutcome.AWAITING_USER_ACTION, store.lastInstallResult.outcome)
    }

    // Installation starts only after consent and moves the session's progress from 0.8 to 0.9.
    // Only Android 14 and later also re-activate the session (PackageInstallerSession.handleInstall).
    private fun platformAppliesConsent(reactivates: Boolean) {
        state.sessionProgress = 0.9f
        state.sessionActive = reactivates
    }

    private fun beginPendingRecovery() {
        assertTrue(store.beginInstall(47, "pending-callback", apk, 2))
        assertTrue(
            store.recordInstallResult(
                store.activeCallback()!!,
                InstallResult(InstallOutcome.AWAITING_USER_ACTION, PackageInstaller.STATUS_PENDING_USER_ACTION),
                terminal = false,
            ),
        )
    }

    private fun presentPendingConfirmation() {
        val activity = foregroundActivity()
        val callback = store.activeCallback()!!
        InstallStatusReceiver().onReceive(
            context,
            Intent(context, InstallStatusReceiver::class.java)
                .setAction(callback.action)
                .putExtra(PackageInstaller.EXTRA_SESSION_ID, callback.sessionId)
                .putExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_PENDING_USER_ACTION)
                .putExtra(Intent.EXTRA_INTENT, Intent("fixture.CONFIRM")),
        )
        assertEquals("fixture.CONFIRM", shadowOf(activity).nextStartedActivity.action)
        UpdateForeground.detach(activity)
    }

    private fun foregroundActivity(): Activity =
        Robolectric.buildActivity(Activity::class.java).setup().get().also(UpdateForeground::attach)

    private fun setArchive() {
        shadowOf(context.packageManager).setPackageArchiveInfo(
            apk.canonicalPath,
            packageInfo(context.packageName, 2, signing(signer)),
        )
    }

    private fun packageInfo(name: String, version: Long, signers: SigningInfo): PackageInfo =
        PackageInfo().apply {
            packageName = name
            longVersionCode = version
            signingInfo = signers
        }

    private fun signing(vararg signers: Signature): SigningInfo = SigningInfo().also {
        Shadow.extract<ShadowSigningInfo>(it).setSignatures(arrayOf(*signers))
    }

    private fun <T> worker(block: () -> T): T {
        val task = FutureTask { block() }
        val thread = Thread(task, "update-installer-test")
        thread.start()
        return try {
            task.get(10, TimeUnit.SECONDS)
        } catch (error: ExecutionException) {
            throw error.cause!!
        } finally {
            thread.interrupt()
            thread.join(1_000)
        }
    }

    @Implements(PackageInstaller.SessionParams::class)
    class RecordingParams {
        var mode = 0
        var packageName: String? = null
        var sizeBytes = 0L
        var userAction: Int? = null
        var requestedOwnership = false

        @Implementation
        fun __constructor__(mode: Int) {
            this.mode = mode
        }

        @Implementation
        fun setAppPackageName(name: String) {
            packageName = name
        }

        @Implementation
        fun setSize(size: Long) {
            sizeBytes = size
        }

        @Implementation(minSdk = 31)
        fun setRequireUserAction(action: Int) {
            userAction = action
        }

        @Implementation(minSdk = 34)
        fun setRequestUpdateOwnership(value: Boolean) {
            requestedOwnership = value
        }
    }

    @Implements(PackageInstaller::class)
    class RecordingPackageInstaller {
        @Implementation
        fun createSession(params: PackageInstaller.SessionParams): Int {
            state.creates++
            state.params = Shadow.extract(params)
            if (state.failAt == "create") throw IOException("private detail")
            state.sessionPresent = true
            state.sessionPackage = state.params?.packageName
            state.sessionActive = true
            return 47
        }

        @Implementation
        fun openSession(sessionId: Int): PackageInstaller.Session {
            check(sessionId == 47)
            if (state.failAt == "open") throw IOException("private detail")
            if (state.failAt == "death-after-create") throw SimulatedProcessDeath()
            return Shadow.newInstanceOf(PackageInstaller.Session::class.java)
        }

        @Implementation
        fun abandonSession(sessionId: Int) {
            if (Looper.myLooper() == Looper.getMainLooper()) state.mainThreadSessionCalls++
            if (state.orphans.removeAll { it.first == sessionId }) {
                state.abandonedOrphans += sessionId
                return
            }
            check(sessionId == 47)
            if (state.failAt == "abandon") throw SecurityException("private detail")
            state.abandons++
            state.sessionPresent = false
        }

        @Implementation
        fun getMySessions(): List<PackageInstaller.SessionInfo> {
            if (Looper.myLooper() == Looper.getMainLooper()) state.mainThreadSessionCalls++
            if (state.failAt == "query") throw SecurityException("private detail")
            state.onQuery?.invoke()
            val sessions = mutableListOf<PackageInstaller.SessionInfo>()
            if (state.sessionPresent) sessions += Shadow.newInstanceOf(PackageInstaller.SessionInfo::class.java)
            state.orphans.forEach { orphan ->
                sessions += Shadow.newInstanceOf(PackageInstaller.SessionInfo::class.java).also {
                    Shadow.extract<RecordingSessionInfo>(it).orphan = orphan
                }
            }
            return sessions
        }
    }

    // Session 47 follows InstallState; orphans are other sessions this app owns and nothing tracks.
    @Implements(PackageInstaller.SessionInfo::class)
    class RecordingSessionInfo {
        var orphan: Pair<Int, String?>? = null

        @Implementation
        fun getSessionId(): Int = orphan?.first ?: 47

        @Implementation
        fun getAppPackageName(): String? = orphan.let { if (it != null) it.second else state.sessionPackage }

        @Implementation
        fun isActive(): Boolean = orphan == null && state.sessionActive

        @Implementation
        fun isSealed(): Boolean = orphan == null && state.sessionSealed

        @Implementation
        fun getProgress(): Float = if (orphan == null) state.sessionProgress else 0f
    }

    @Implements(PackageInstaller.Session::class)
    class RecordingSession {
        @Implementation
        fun openWrite(name: String, offsetBytes: Long, lengthBytes: Long): OutputStream {
            state.streamName = name
            state.offset = offsetBytes
            state.length = lengthBytes
            return object : OutputStream() {
                override fun write(value: Int) {
                    if (state.failAt == "write") throw IOException("private detail")
                    state.output.write(value)
                }

                override fun write(bytes: ByteArray, offset: Int, length: Int) {
                    if (state.failAt == "write") throw IOException("private detail")
                    state.output.write(bytes, offset, length)
                }

                override fun close() {
                    state.outputClosed = true
                }
            }
        }

        @Implementation
        fun fsync(output: OutputStream) {
            check(!state.outputClosed)
            if (state.failAt == "fsync") throw IOException("private detail")
            output.flush()
            state.fsynced = true
        }

        @Implementation
        fun commit(statusReceiver: IntentSender) {
            check(state.outputClosed && state.fsynced)
            if (state.failAt == "commit") throw SecurityException("private detail")
            state.onBeforeCommit?.invoke()
            if (state.failAt == "process-death") throw SimulatedProcessDeath()
            state.commits++
            state.sessionSealed = true
            state.sessionActive = true
            // Commit sets the client progress to 1; the session reports it as 0.8 of the total.
            state.sessionProgress = 0.8f
            state.onCommit?.invoke(statusReceiver)
        }

        @Implementation
        fun close() {
            state.closed = true
            if (!state.sessionSealed) state.sessionActive = false
            if (state.failAt == "close") throw IllegalStateException("private detail")
        }
    }

    private class InstallState {
        var creates = 0
        var commits = 0
        var abandons = 0
        var params: RecordingParams? = null
        var streamName: String? = null
        var offset = -1L
        var length = -1L
        val output = ByteArrayOutputStream()
        var outputClosed = false
        var fsynced = false
        var closed = false
        var failAt: String? = null
        var onCommit: ((IntentSender) -> Unit)? = null
        var onBeforeCommit: (() -> Unit)? = null
        var onQuery: (() -> Unit)? = null
        var sessionPresent = false
        var sessionPackage: String? = null
        var sessionActive = false
        var sessionSealed = false
        var sessionProgress = 0f
        var mainThreadSessionCalls = 0
        val orphans = mutableListOf<Pair<Int, String?>>()
        val abandonedOrphans = mutableListOf<Int>()
    }

    private class SimulatedProcessDeath : Error()

    private companion object {
        var state = InstallState()
    }
}
