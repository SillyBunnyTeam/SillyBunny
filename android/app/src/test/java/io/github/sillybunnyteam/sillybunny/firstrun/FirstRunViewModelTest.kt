package io.github.sillybunnyteam.sillybunny.firstrun

import android.os.Bundle
import android.os.Looper
import androidx.activity.ComponentActivity
import io.github.sillybunnyteam.sillybunny.server.SetupState
import kotlinx.coroutines.Dispatchers
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** [FirstRun.controller] across configuration changes, process death and a new activity. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [37])
class FirstRunViewModelTest {
    @get:Rule
    val temporary = TemporaryFolder()

    private lateinit var fixture: FirstRunFixture
    private lateinit var dependencies: FirstRunDependencies

    @Before
    fun setUp() {
        fixture = FirstRunFixture(temporary.root)
        fixture.notifications.required = false
        dependencies = fixture.dependencies(Dispatchers.Main)
    }

    private fun idle() = shadowOf(Looper.getMainLooper()).idle()

    @Test
    fun aConfigurationChangeKeepsTheControllerAndProcessDeathKeepsItsRecord() {
        fixture.network = NetworkKind.CELLULAR
        val first = Robolectric.buildActivity(ComponentActivity::class.java).setup()
        val controller = FirstRun.controller(first.get(), dependencies)
        controller.setVisible(true)
        idle()
        controller.continueFromWelcome()
        idle()
        assertEquals(FirstRunStage.MeteredWarning(cellular = true), controller.state.value.stage)

        first.recreate()
        assertSame(controller, FirstRun.controller(first.get(), dependencies))

        val saved = Bundle()
        first.pause().stop().saveInstanceState(saved).destroy()
        val second = Robolectric.buildActivity(ComponentActivity::class.java).setup(saved)
        val restored = FirstRun.controller(second.get(), dependencies)
        idle()
        assertNotSame(controller, restored)
        assertEquals(FirstRunStage.MeteredWarning(cellular = true), restored.state.value.stage)
        assertTrue(fixture.host.jobs.isEmpty())
        second.pause().stop().destroy()
    }

    @Test
    fun aNewActivityFindsTheInstallThatKeptRunning() {
        val first = Robolectric.buildActivity(ComponentActivity::class.java).setup()
        val controller = FirstRun.controller(first.get(), dependencies)
        controller.setVisible(true)
        idle()
        controller.continueFromWelcome()
        idle()
        val job = fixture.host.jobs.single()
        fixture.host.setup.value = SetupState.Running(job, listOf("Cloning"))
        idle()
        // Back finished the activity; the job runs on in the foreground service.
        first.pause().stop().destroy()

        val second = Robolectric.buildActivity(ComponentActivity::class.java).setup()
        val next = FirstRun.controller(second.get(), dependencies)
        idle()
        assertNotSame(controller, next)
        assertEquals(FirstRunStage.Installing(listOf("Cloning"), cancelling = false), next.state.value.stage)
        assertEquals(1, fixture.host.jobs.size)
        second.pause().stop().destroy()
    }
}
