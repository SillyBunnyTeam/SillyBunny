package io.github.sillybunnyteam.sillybunny.firstrun

import android.app.Application
import android.os.Bundle
import androidx.test.core.app.ApplicationProvider
import io.github.sillybunnyteam.sillybunny.server.SetupState
import io.github.sillybunnyteam.sillybunny.settings.FakeLocalNetwork
import io.github.sillybunnyteam.sillybunny.settings.LOCAL_NETWORK_PERMISSION
import io.github.sillybunnyteam.sillybunny.settings.LocalNetworkAccess
import io.github.sillybunnyteam.sillybunny.settings.LocalNetworkStatus.BLOCKED
import io.github.sillybunnyteam.sillybunny.settings.LocalNetworkStatus.DENIED
import io.github.sillybunnyteam.sillybunny.settings.LocalNetworkStatus.GRANTED
import io.github.sillybunnyteam.sillybunny.settings.LocalNetworkStatus.NOT_ASKED
import io.github.sillybunnyteam.sillybunny.settings.LocalNetworkStatus.NOT_REQUIRED
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** The optional local-network item with the real adapter: it never gates the install, and denials persist. */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [37])
class FirstRunLocalNetworkTest {
    @get:Rule
    val temporary = TemporaryFolder()

    private lateinit var fixture: FirstRunFixture
    private val app: Application get() = ApplicationProvider.getApplicationContext()

    @Before
    fun setUp() {
        fixture = FirstRunFixture(temporary.root)
    }

    private fun TestScope.controller(
        restored: Bundle? = null,
        localNetwork: LocalNetworkAccess? = null,
    ): FirstRunController {
        val controller = FirstRunController(
            fixture.dependencies(StandardTestDispatcher(testScheduler), localNetwork = localNetwork),
            backgroundScope,
            restored,
        )
        controller.setVisible(true)
        runCurrent()
        return controller
    }

    private fun TestScope.answer(controller: FirstRunController, granted: Boolean, canAskAgain: Boolean) {
        controller.onLocalNetworkPermissionResult(granted, canAskAgain)
        runCurrent()
    }

    private fun TestScope.install(controller: FirstRunController) {
        controller.continueFromWelcome()
        runCurrent()
        assertTrue(controller.state.value.stage is FirstRunStage.Installing)
        val job = fixture.host.jobs.single()
        fixture.writeInstalledCheckout()
        fixture.host.setup.value = SetupState.Finished(job, 0, listOf("done"))
        runCurrent()
        assertEquals(FirstRunStage.Installed, controller.state.value.stage)
    }

    @Test
    @Config(sdk = [29, 36])
    fun belowApi37ThereIsNothingToOffer() = runTest {
        val controller = controller()
        assertEquals(NOT_REQUIRED, controller.state.value.localNetwork)
        assertNull(controller.localNetworkPermission)
    }

    @Test
    fun theFirstRunFinishesWithoutEverAsking() = runTest {
        val controller = controller()
        assertEquals(NOT_ASKED, controller.state.value.localNetwork)
        assertEquals(LOCAL_NETWORK_PERMISSION, controller.localNetworkPermission)
        install(controller)
        assertEquals(NOT_ASKED, controller.state.value.localNetwork)
    }

    @Test
    fun theFirstRunFinishesAfterTheSystemStopsAsking() = runTest {
        val controller = controller()
        answer(controller, granted = false, canAskAgain = true)
        assertEquals(DENIED, controller.state.value.localNetwork)
        answer(controller, granted = false, canAskAgain = false)
        assertEquals(BLOCKED, controller.state.value.localNetwork)
        assertEquals(FirstRunStage.Welcome, controller.state.value.stage)
        install(controller)
        assertEquals(BLOCKED, controller.state.value.localNetwork)
    }

    @Test
    fun anAnswerThatArrivesAfterProcessDeathIsKept() = runTest {
        val first = controller()
        answer(first, granted = false, canAskAgain = true)
        val saved = first.saveState()

        // The process died while the second dialog showed: a new controller restores the screen, and the
        // re-registered launcher hands it the answer.
        val restored = controller(saved)
        assertEquals(DENIED, restored.state.value.localNetwork)
        answer(restored, granted = false, canAskAgain = false)
        assertEquals(BLOCKED, restored.state.value.localNetwork)

        // A later cold start, without saved state, reads the stored answer.
        assertEquals(BLOCKED, controller().state.value.localNetwork)
    }

    @Test
    fun accessGrantedInSystemSettingsShowsWhenTheScreenReturns() = runTest {
        val controller = controller()
        answer(controller, granted = false, canAskAgain = true)
        answer(controller, granted = false, canAskAgain = false)
        controller.setVisible(false)
        shadowOf(app).grantPermissions(LOCAL_NETWORK_PERMISSION)
        controller.setVisible(true)
        runCurrent()
        assertEquals(GRANTED, controller.state.value.localNetwork)
    }

    @Test
    fun answersAreRecordedOnTheIoDispatcherInTheOrderTheyArrive() = runTest {
        val access = FakeLocalNetwork()
        val controller = controller(localNetwork = access)
        controller.onLocalNetworkPermissionResult(granted = false, canAskAgain = true)
        controller.refreshPermissions()
        controller.onLocalNetworkPermissionResult(granted = false, canAskAgain = false)
        assertTrue("nothing is read or written by the caller", access.answers.isEmpty())
        runCurrent()
        assertEquals(listOf(false to true, false to false), access.answers)
        assertEquals(BLOCKED, controller.state.value.localNetwork)
    }
}
