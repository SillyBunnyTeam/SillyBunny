package io.github.sillybunnyteam.sillybunny.update

import android.Manifest
import android.app.Activity
import android.app.Application
import android.app.NotificationManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import java.io.File
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29, 31, 34, 35, 37])
class InstallStatusReceiverTest {
    private lateinit var context: Application
    private lateinit var store: UpdateStore
    private lateinit var apk: File
    private lateinit var notifications: NotificationManager
    private val receiver = InstallStatusReceiver()
    private val sessionId = 47
    private val action = "fixture.update.CALLBACK.secret"

    @Before
    fun setUp() {
        UpdateInstaller.resetForTest()
        context = androidx.test.core.app.ApplicationProvider.getApplicationContext()
        context.getSharedPreferences("app_updates", Context.MODE_PRIVATE).edit().clear().commit()
        store = UpdateStore(context)
        val updates = File(context.cacheDir, "updates").apply { mkdirs() }
        apk = File(updates, "candidate.apk").apply { writeText("apk") }
        notifications = requireNotNull(context.getSystemService(NotificationManager::class.java))
        shadowOf(notifications).setNotificationsEnabled(true)
        if (Build.VERSION.SDK_INT >= 33) {
            shadowOf(context).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    @After
    fun tearDown() {
        UpdateInstaller.awaitBackgroundWork()
        UpdateForeground.currentActivity()?.let(UpdateForeground::detach)
        store.failInstall(store.activeSessionId)
        File(context.cacheDir, "updates").deleteRecursively()
        notifications.cancelAll()
        UpdateInstaller.resetForTest()
    }

    @Test
    fun callbacksWithoutAnActiveAuthenticatedSessionAreIgnored() {
        receiver.onReceive(context, callback(PackageInstaller.STATUS_SUCCESS))
        assertEquals(InstallResult(), store.lastInstallResult)
        store.activeSessionId = sessionId
        receiver.onReceive(context, callback(PackageInstaller.STATUS_SUCCESS))
        assertEquals(InstallResult(), store.lastInstallResult)
        assertTrue(apk.exists())
        assertNull(shadowOf(context).nextStartedActivity)
    }

    @Test
    fun staleSessionWrongActionWrongComponentAndMissingExtrasCannotFinishTheInstall() {
        begin()
        val foreign = listOf(
            callback(0).putExtra(PackageInstaller.EXTRA_SESSION_ID, sessionId + 1),
            callback(0).setAction("foreign"),
            callback(0).setComponent(ComponentName(context.packageName, "foreign.Receiver")),
            callback(0).setComponent(null),
            callback(0).apply { removeExtra(PackageInstaller.EXTRA_SESSION_ID) },
            callback(0).apply { removeExtra(PackageInstaller.EXTRA_STATUS) },
        )
        foreign.forEach { intent ->
            receiver.onReceive(context, intent)
            assertEquals(sessionId, store.activeSessionId)
            assertEquals(InstallOutcome.VERIFYING, store.lastInstallResult.outcome)
            assertTrue(apk.exists())
        }
        assertEquals(0, shadowOf(notifications).size())
    }

    @Test
    fun pendingUserActionStartsTheSystemIntentOnlyWhileForeground() {
        begin()
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        UpdateForeground.attach(activity)
        try {
            val userAction = userAction()
            receiver.onReceive(
                context,
                callback(PackageInstaller.STATUS_PENDING_USER_ACTION).putExtra(Intent.EXTRA_INTENT, userAction),
            )
            assertEquals(userAction.action, shadowOf(activity).nextStartedActivity.action)
            assertEquals(InstallOutcome.AWAITING_USER_ACTION, store.lastInstallResult.outcome)
            assertEquals(sessionId, store.activeSessionId)
            assertTrue(apk.exists())
            assertEquals(0, shadowOf(notifications).size())
            assertTrue(UpdateStore(context).userActionPresented(store.activeCallback()!!))
            assertFalse(UpdateInstaller(context).resumePendingUserAction(activity))
            assertEquals(InstallOutcome.AWAITING_USER_ACTION, store.lastInstallResult.outcome)
            assertNull(shadowOf(activity).nextStartedActivity)
        } finally {
            UpdateForeground.detach(activity)
        }
    }

    @Test
    fun backgroundPendingActionUsesAnImmutableDirectActivityNotification() {
        begin()
        val userAction = userAction()
        receiver.onReceive(
            context,
            callback(PackageInstaller.STATUS_PENDING_USER_ACTION).putExtra(Intent.EXTRA_INTENT, userAction),
        )
        val notification = shadowOf(notifications).getNotification(UpdateNotifications.INSTALL_ID)
        assertNotNull(notification)
        val pending = shadowOf(notification.contentIntent)
        assertTrue(pending.isActivity)
        assertTrue(pending.isImmutable)
        assertEquals(userAction.action, pending.savedIntent.action)
        assertEquals(userAction.component, pending.savedIntent.component)
        assertNull(shadowOf(context).nextStartedActivity)
        assertNull(shadowOf(context).nextStartedService)
        assertEquals(sessionId, store.activeSessionId)
        assertTrue(apk.exists())
        assertFalse(UpdateStore(context).userActionPresented(store.activeCallback()!!))
    }

    @Test
    fun deniedNotificationsStillPreservePendingActionStateForTheUi() {
        begin()
        shadowOf(notifications).setNotificationsEnabled(false)
        receiver.onReceive(
            context,
            callback(PackageInstaller.STATUS_PENDING_USER_ACTION).putExtra(Intent.EXTRA_INTENT, userAction()),
        )
        assertEquals(InstallOutcome.AWAITING_USER_ACTION, UpdateStore(context).lastInstallResult.outcome)
        assertEquals(sessionId, store.activeSessionId)
        assertEquals(0, shadowOf(notifications).size())
        assertNull(shadowOf(context).nextStartedActivity)
    }

    @Test
    fun aSecondBackgroundVerificationPromptResetsThePriorPresentationBeforeItCanBeLost() {
        begin()
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        UpdateForeground.attach(activity)
        receiver.onReceive(
            context,
            callback(PackageInstaller.STATUS_PENDING_USER_ACTION).putExtra(Intent.EXTRA_INTENT, userAction()),
        )
        assertNotNull(shadowOf(activity).nextStartedActivity)
        val identity = store.activeCallback()!!
        assertTrue(store.userActionPresented(identity))
        UpdateForeground.detach(activity)
        shadowOf(notifications).setNotificationsEnabled(false)
        receiver.onReceive(
            context,
            callback(PackageInstaller.STATUS_PENDING_USER_ACTION)
                .putExtra(Intent.EXTRA_INTENT, userAction().putExtra("fixture.prompt", "verification")),
        )
        assertFalse(UpdateStore(context).userActionPresented(identity))
        store.clearPendingUserAction()
        assertFalse(UpdateStore(context).userActionPresented(identity))
    }

    @Test
    fun backgroundActionWithDeniedNotificationsResumesTheOriginalConfirmationOnlyOnce() {
        begin()
        shadowOf(notifications).setNotificationsEnabled(false)
        val original = userAction().putExtra("fixture.confirmation", "original")
        receiver.onReceive(
            context,
            callback(PackageInstaller.STATUS_PENDING_USER_ACTION).putExtra(Intent.EXTRA_INTENT, original),
        )
        original.putExtra("fixture.confirmation", "changed after delivery")
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        UpdateForeground.attach(activity)
        val installer = UpdateInstaller(context)
        assertTrue(installer.resumePendingUserAction(activity))
        val confirmation = shadowOf(activity).nextStartedActivity
        assertEquals(userAction().action, confirmation.action)
        assertEquals(userAction().component, confirmation.component)
        assertEquals("original", confirmation.getStringExtra("fixture.confirmation"))
        assertFalse(installer.resumePendingUserAction(activity))
        assertNull(shadowOf(activity).nextStartedActivity)
        assertEquals(InstallOutcome.AWAITING_USER_ACTION, store.lastInstallResult.outcome)
        assertEquals(sessionId, store.activeSessionId)
        assertEquals(0, shadowOf(notifications).size())
        assertTrue(
            context.getSharedPreferences("app_updates", Context.MODE_PRIVATE).all.values.none {
                it is Intent || it == "original"
            },
        )

        UpdateForeground.detach(activity)
        UpdateForeground.attach(activity)
        assertFalse(installer.resumePendingUserAction(activity))
        UpdateInstaller.awaitBackgroundWork()
        // The session is already gone, so the platform's final status is still on its way.
        assertEquals(InstallOutcome.VERIFYING, store.lastInstallResult.outcome)
        receiver.onReceive(context, callback(PackageInstaller.STATUS_FAILURE_ABORTED))
        assertEquals(InstallOutcome.ABORTED, store.lastInstallResult.outcome)
        assertNull(store.activeSessionId)
        assertFalse(apk.exists())
        assertNull(shadowOf(activity).nextStartedActivity)
    }

    @Test
    @Config(sdk = [34, 35, 37])
    fun deniedPostPermissionDoesNotPreventForegroundRecovery() {
        begin()
        shadowOf(context).denyPermissions(Manifest.permission.POST_NOTIFICATIONS)
        receiver.onReceive(
            context,
            callback(PackageInstaller.STATUS_PENDING_USER_ACTION).putExtra(Intent.EXTRA_INTENT, userAction()),
        )
        assertEquals(0, shadowOf(notifications).size())
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        UpdateForeground.attach(activity)
        assertTrue(UpdateInstaller(context).resumePendingUserAction(activity))
        assertEquals(userAction().action, shadowOf(activity).nextStartedActivity.action)
        assertNull(shadowOf(notifications).getNotification(UpdateNotifications.INSTALL_ID))
    }

    @Test
    fun notificationTapConsumesItsOneShotActionSoForegroundRecoveryCannotOpenItAgain() {
        begin()
        receiver.onReceive(
            context,
            callback(PackageInstaller.STATUS_PENDING_USER_ACTION).putExtra(Intent.EXTRA_INTENT, userAction()),
        )
        val notification = shadowOf(notifications).getNotification(UpdateNotifications.INSTALL_ID)
        assertTrue(shadowOf(notification.contentIntent).flags and android.app.PendingIntent.FLAG_ONE_SHOT != 0)
        notification.contentIntent.send()
        assertEquals(userAction().action, shadowOf(context).nextStartedActivity.action)

        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        UpdateForeground.attach(activity)
        assertFalse(UpdateInstaller(context).resumePendingUserAction(activity))
        UpdateInstaller.awaitBackgroundWork()
        assertNull(shadowOf(activity).nextStartedActivity)
        // The tapped confirmation's session is already gone, so its final status is still on its way.
        assertEquals(InstallOutcome.VERIFYING, store.lastInstallResult.outcome)
        receiver.onReceive(context, callback(PackageInstaller.STATUS_FAILURE_ABORTED))
        assertEquals(InstallOutcome.ABORTED, store.lastInstallResult.outcome)
        assertNull(store.activeSessionId)
        assertNull(shadowOf(notifications).getNotification(UpdateNotifications.INSTALL_ID))
    }

    @Test
    fun recoveryAfterProcessLossAbandonsOnlyTheOwnedNonresumableSessionAndAllowsRetry() {
        val platform = context.packageManager.packageInstaller
        val ownedId = platform.createSession(
            PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
                setAppPackageName(context.packageName)
            },
        )
        assertTrue(store.beginInstall(ownedId, action, apk, 2))
        receiver.onReceive(
            context,
            callback(PackageInstaller.STATUS_PENDING_USER_ACTION)
                .putExtra(PackageInstaller.EXTRA_SESSION_ID, ownedId)
                .putExtra(Intent.EXTRA_INTENT, userAction()),
        )
        store.clearPendingUserAction()
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        UpdateForeground.attach(activity)
        assertFalse(UpdateInstaller(context).resumePendingUserAction(activity))
        UpdateInstaller.awaitBackgroundWork()
        assertEquals(InstallOutcome.ABORTED, store.lastInstallResult.outcome)
        assertNull(platform.getSessionInfo(ownedId))
        assertNull(store.activeSessionId)
        assertFalse(apk.exists())
        assertNull(shadowOf(activity).nextStartedActivity)
        apk.writeText("retry")
        assertTrue(store.beginInstall(ownedId + 1, "retry-callback", apk, 2))
    }

    @Test
    fun recoveryStartFailureReleasesANonresumableSessionRatherThanLooping() {
        begin()
        shadowOf(notifications).setNotificationsEnabled(false)
        receiver.onReceive(
            context,
            callback(PackageInstaller.STATUS_PENDING_USER_ACTION).putExtra(Intent.EXTRA_INTENT, userAction()),
        )
        val activity = Robolectric.buildActivity(RejectingActivity::class.java).setup().get()
        UpdateForeground.attach(activity)
        assertFalse(UpdateInstaller(context).resumePendingUserAction(activity))
        UpdateInstaller.awaitBackgroundWork()
        assertEquals(InstallOutcome.FAILED, store.lastInstallResult.outcome)
        assertNull(store.activeSessionId)
        assertFalse(apk.exists())
        assertFalse(UpdateInstaller(context).resumePendingUserAction(activity))
    }

    @Test
    fun aStaleCallbackCannotRestoreAnOldConfirmationForTheNextInstall() {
        begin()
        receiver.onReceive(
            context,
            callback(PackageInstaller.STATUS_PENDING_USER_ACTION).putExtra(Intent.EXTRA_INTENT, userAction()),
        )
        store.activeSessionId = null
        assertTrue(store.beginInstall(sessionId + 1, "next-callback", apk, 3))
        receiver.onReceive(
            context,
            callback(PackageInstaller.STATUS_PENDING_USER_ACTION).putExtra(Intent.EXTRA_INTENT, userAction()),
        )
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        UpdateForeground.attach(activity)
        assertFalse(UpdateInstaller(context).resumePendingUserAction(activity))
        assertEquals(InstallOutcome.VERIFYING, store.lastInstallResult.outcome)
        assertEquals(sessionId + 1, store.activeSessionId)
        assertNull(shadowOf(activity).nextStartedActivity)
        assertTrue(apk.exists())
    }

    @Test
    fun terminalResultClearsTheTransientConfirmationAndCannotBeRecoveredLater() {
        begin()
        val identity = store.activeCallback()!!
        receiver.onReceive(
            context,
            callback(PackageInstaller.STATUS_PENDING_USER_ACTION).putExtra(Intent.EXTRA_INTENT, userAction()),
        )
        assertNotNull(store.pendingUserAction(identity))
        receiver.onReceive(context, callback(PackageInstaller.STATUS_FAILURE_ABORTED))
        assertNull(store.pendingUserAction(identity))
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        UpdateForeground.attach(activity)
        assertFalse(UpdateInstaller(context).resumePendingUserAction(activity))
        assertEquals(InstallOutcome.ABORTED, store.lastInstallResult.outcome)
        assertNull(shadowOf(activity).nextStartedActivity)
    }

    @Test
    fun packageReplacementClearsTheTransientConfirmationAndNotification() {
        begin()
        val identity = store.activeCallback()!!
        receiver.onReceive(
            context,
            callback(PackageInstaller.STATUS_PENDING_USER_ACTION).putExtra(Intent.EXTRA_INTENT, userAction()),
        )
        assertNotNull(store.pendingUserAction(identity))
        store.recordReplacement(2)
        assertNull(store.pendingUserAction(identity))
        assertEquals(InstallOutcome.SUCCESS, store.lastInstallResult.outcome)
        assertNull(shadowOf(notifications).getNotification(UpdateNotifications.INSTALL_ID))
    }

    @Test
    fun recoveryRequiresTheSuppliedCurrentlyForegroundActivity() {
        begin()
        shadowOf(notifications).setNotificationsEnabled(false)
        receiver.onReceive(
            context,
            callback(PackageInstaller.STATUS_PENDING_USER_ACTION).putExtra(Intent.EXTRA_INTENT, userAction()),
        )
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        val other = Robolectric.buildActivity(Activity::class.java).setup().get()
        assertFalse(UpdateInstaller(context).resumePendingUserAction(activity))
        UpdateForeground.attach(other)
        assertFalse(UpdateInstaller(context).resumePendingUserAction(activity))
        assertEquals(InstallOutcome.AWAITING_USER_ACTION, store.lastInstallResult.outcome)
        assertEquals(sessionId, store.activeSessionId)
        assertNull(shadowOf(activity).nextStartedActivity)
        UpdateForeground.attach(activity)
        assertTrue(UpdateInstaller(context).resumePendingUserAction(activity))
    }

    @Test
    fun missingCallbackAuthenticationOnRecoveryDoesNotLeaveAnAwaitingResult() {
        store.lastInstallResult = InstallResult(InstallOutcome.AWAITING_USER_ACTION, -1, sessionId = sessionId)
        store.activeSessionId = sessionId
        store.downloadedApk = apk.path
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        UpdateForeground.attach(activity)
        assertFalse(UpdateInstaller(context).resumePendingUserAction(activity))
        UpdateInstaller.awaitBackgroundWork()
        assertEquals(InstallOutcome.FAILED, store.lastInstallResult.outcome)
        assertNull(store.activeSessionId)
        assertFalse(apk.exists())
        assertNull(shadowOf(activity).nextStartedActivity)
    }

    @Test
    fun missingOrWrongTypeUserActionIntentDoesNotCrashOrDiscardTheSession() {
        begin()
        receiver.onReceive(context, callback(PackageInstaller.STATUS_PENDING_USER_ACTION))
        receiver.onReceive(
            context,
            callback(PackageInstaller.STATUS_PENDING_USER_ACTION).putExtra(Intent.EXTRA_INTENT, "wrong type"),
        )
        assertEquals(InstallOutcome.AWAITING_USER_ACTION, store.lastInstallResult.outcome)
        assertEquals(sessionId, store.activeSessionId)
        assertTrue(apk.exists())
        assertEquals(0, shadowOf(notifications).size())
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        UpdateForeground.attach(activity)
        assertFalse(UpdateInstaller(context).resumePendingUserAction(activity))
        UpdateInstaller.awaitBackgroundWork()
        assertEquals(InstallOutcome.ABORTED, store.lastInstallResult.outcome)
        assertNull(store.activeSessionId)
        assertFalse(apk.exists())
        apk.writeText("retry")
        assertTrue(store.beginInstall(sessionId + 1, "retry-callback", apk, 2))
    }

    @Test
    fun unavailableForegroundInstallerFallsBackToATapNotification() {
        begin()
        val activity = Robolectric.buildActivity(RejectingActivity::class.java).setup().get()
        UpdateForeground.attach(activity)
        try {
            receiver.onReceive(
                context,
                callback(PackageInstaller.STATUS_PENDING_USER_ACTION).putExtra(Intent.EXTRA_INTENT, userAction()),
            )
            assertNotNull(shadowOf(notifications).getNotification(UpdateNotifications.INSTALL_ID))
            assertEquals(sessionId, store.activeSessionId)
            assertFalse(UpdateStore(context).userActionPresented(store.activeCallback()!!))
        } finally {
            UpdateForeground.detach(activity)
        }
    }

    @Test
    fun successPersistsAndCleansTheDownloadAndSessionWithoutStartingTheServer() {
        begin()
        UpdateNotifications.postUserAction(context, userAction())
        receiver.onReceive(context, callback(PackageInstaller.STATUS_SUCCESS))
        assertEquals(InstallResult(InstallOutcome.SUCCESS, 0, sessionId = sessionId), store.lastInstallResult)
        assertNull(store.activeSessionId)
        assertNull(store.activeCallback())
        assertNull(store.downloadedApk)
        assertFalse(apk.exists())
        assertNull(shadowOf(notifications).getNotification(UpdateNotifications.INSTALL_ID))
        assertNull(shadowOf(context).nextStartedActivity)
        assertNull(shadowOf(context).nextStartedService)
        receiver.onReceive(context, callback(PackageInstaller.STATUS_FAILURE))
        assertEquals(InstallOutcome.SUCCESS, store.lastInstallResult.outcome)
    }

    @Test
    fun everyPublicFailureAndUnknownPositiveStatusAreTerminalAndKeepOnlyNumericDiagnostics() {
        listOf(
            PackageInstaller.STATUS_FAILURE,
            PackageInstaller.STATUS_FAILURE_BLOCKED,
            PackageInstaller.STATUS_FAILURE_ABORTED,
            PackageInstaller.STATUS_FAILURE_INVALID,
            PackageInstaller.STATUS_FAILURE_CONFLICT,
            PackageInstaller.STATUS_FAILURE_STORAGE,
            PackageInstaller.STATUS_FAILURE_INCOMPATIBLE,
            8, // STATUS_FAILURE_TIMEOUT, public starting at API 34.
            999,
        ).forEach { status ->
            apk.writeText("apk")
            begin()
            receiver.onReceive(
                context,
                callback(status)
                    .putExtra("android.content.pm.extra.LEGACY_STATUS", -115)
                    .putExtra(PackageInstaller.EXTRA_STATUS_MESSAGE, "private raw system message"),
            )
            val expected = if (status == PackageInstaller.STATUS_FAILURE_ABORTED) {
                InstallOutcome.ABORTED
            } else InstallOutcome.FAILED
            assertEquals(InstallResult(expected, status, -115, sessionId = sessionId), store.lastInstallResult)
            assertNull(store.activeSessionId)
            assertNull(store.downloadedApk)
            assertFalse(apk.exists())
            assertFalse(
                context.getSharedPreferences("app_updates", Context.MODE_PRIVATE)
                    .all.values.contains("private raw system message"),
            )
        }
    }

    @Test
    fun unfamiliarNegativeProgressIncludingStreamingRemainsNonterminal() {
        begin()
        listOf(-2, -55).forEach { status ->
            receiver.onReceive(context, callback(status))
            assertEquals(InstallResult(InstallOutcome.VERIFYING, status, sessionId = sessionId), store.lastInstallResult)
            assertEquals(sessionId, store.activeSessionId)
            assertNotNull(store.activeCallback())
            assertTrue(apk.exists())
        }
    }

    @Test
    @Config(sdk = [29, 31, 34, 35])
    fun developerVerificationExtraOnOlderVersionsIsNotTreatedAsAnExplanationRequest() {
        begin()
        receiver.onReceive(
            context,
            callback(PackageInstaller.STATUS_FAILURE_ABORTED)
                .putExtra("android.content.pm.extra.DEVELOPER_VERIFICATION_FAILURE_REASON", 2)
                .putExtra(Intent.EXTRA_INTENT, userAction()),
        )
        assertEquals(InstallOutcome.ABORTED, store.lastInstallResult.outcome)
        assertNull(store.lastInstallResult.developerVerificationReason)
        assertEquals(0, shadowOf(notifications).size())
    }

    @Test
    @Config(sdk = [36])
    fun developerVerificationReasonIsNotReadOn36Point0() {
        assertEquals(Build.VERSION_CODES_FULL.BAKLAVA, Build.VERSION.SDK_INT_FULL)
        begin()
        receiver.onReceive(
            context,
            callback(PackageInstaller.STATUS_FAILURE_ABORTED)
                .putExtra("android.content.pm.extra.DEVELOPER_VERIFICATION_FAILURE_REASON", 2)
                .putExtra(Intent.EXTRA_INTENT, userAction()),
        )
        assertEquals(InstallOutcome.ABORTED, store.lastInstallResult.outcome)
        assertNull(store.lastInstallResult.developerVerificationReason)
        assertEquals(0, shadowOf(notifications).size())
    }

    @Test
    @Config(sdk = [37])
    fun developerVerificationAbortedRetainsReasonAndOffersTheOptionalSystemExplanation() {
        begin()
        receiver.onReceive(
            context,
            callback(PackageInstaller.STATUS_FAILURE_ABORTED)
                .putExtra(
                    PackageInstaller.EXTRA_DEVELOPER_VERIFICATION_FAILURE_REASON,
                    PackageInstaller.DEVELOPER_VERIFICATION_FAILED_REASON_DEVELOPER_BLOCKED,
                )
                .putExtra(Intent.EXTRA_INTENT, userAction()),
        )
        assertEquals(InstallOutcome.ABORTED, store.lastInstallResult.outcome)
        assertEquals(2, store.lastInstallResult.developerVerificationReason)
        assertNull(store.activeSessionId)
        assertFalse(apk.exists())
        val notification = shadowOf(notifications).getNotification(UpdateNotifications.INSTALL_ID)
        assertNotNull(notification)
        assertTrue(shadowOf(notification.contentIntent).isActivity)
        assertNull(shadowOf(context).nextStartedService)
    }

    @Test
    @Config(sdk = [37])
    fun developerVerificationCanExplainInForegroundOrAbortWithoutAnExplanation() {
        begin()
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        UpdateForeground.attach(activity)
        try {
            receiver.onReceive(
                context,
                callback(PackageInstaller.STATUS_FAILURE_ABORTED)
                    .putExtra(PackageInstaller.EXTRA_DEVELOPER_VERIFICATION_FAILURE_REASON, 1)
                    .putExtra(Intent.EXTRA_INTENT, userAction()),
            )
            assertEquals(userAction().action, shadowOf(activity).nextStartedActivity.action)
            assertEquals(1, store.lastInstallResult.developerVerificationReason)
            assertNull(store.activeSessionId)
            assertEquals(0, shadowOf(notifications).size())
            apk.writeText("apk")
            begin()
            receiver.onReceive(
                context,
                callback(PackageInstaller.STATUS_FAILURE_ABORTED)
                    .putExtra(PackageInstaller.EXTRA_DEVELOPER_VERIFICATION_FAILURE_REASON, 0),
            )
            assertEquals(0, store.lastInstallResult.developerVerificationReason)
            assertEquals(0, shadowOf(notifications).size())
        } finally {
            UpdateForeground.detach(activity)
        }
    }

    @Test
    fun foregroundReferenceDoesNotLetAnOldActivityDetachANewOneAndRejectsFinishedActivities() {
        val old = Robolectric.buildActivity(Activity::class.java).setup().get()
        val current = Robolectric.buildActivity(Activity::class.java).setup().get()
        UpdateForeground.attach(old)
        UpdateForeground.attach(current)
        UpdateForeground.detach(old)
        assertSame(current, UpdateForeground.currentActivity())
        current.finish()
        assertNull(UpdateForeground.currentActivity())
        UpdateForeground.detach(current)
    }

    @Test
    fun destroyedActivityCannotReceiveAnInstallerLaunch() {
        val controller = Robolectric.buildActivity(Activity::class.java).setup()
        val activity = controller.get()
        UpdateForeground.attach(activity)
        controller.pause().stop().destroy()
        assertNull(UpdateForeground.currentActivity())
        UpdateForeground.detach(activity)
    }

    private fun begin() {
        assertTrue(store.beginInstall(sessionId, action, apk, 2))
    }

    private fun callback(status: Int): Intent = Intent(context, InstallStatusReceiver::class.java)
        .setAction(action)
        .putExtra(PackageInstaller.EXTRA_SESSION_ID, sessionId)
        .putExtra(PackageInstaller.EXTRA_STATUS, status)

    private fun userAction(): Intent = Intent("fixture.update.CONFIRM")
        .setComponent(ComponentName("fixture.installer", "fixture.installer.ConfirmActivity"))

    class RejectingActivity : Activity() {
        override fun startActivity(intent: Intent) {
            throw android.content.ActivityNotFoundException()
        }
    }
}
