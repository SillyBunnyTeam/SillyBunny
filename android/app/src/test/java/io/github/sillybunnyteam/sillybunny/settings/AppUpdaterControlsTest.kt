package io.github.sillybunnyteam.sillybunny.settings

import android.app.Application
import android.content.Context
import android.os.Looper
import androidx.activity.ComponentActivity
import androidx.test.core.app.ApplicationProvider
import io.github.sillybunnyteam.sillybunny.update.AppUpdater
import io.github.sillybunnyteam.sillybunny.update.UpdatePhase
import io.github.sillybunnyteam.sillybunny.update.UpdateStore
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.ProxySelector
import java.net.ServerSocket
import java.net.SocketAddress
import java.net.URI
import java.util.concurrent.TimeUnit
import kotlin.random.Random

@RunWith(RobolectricTestRunner::class)
class AppUpdaterControlsTest {
    private val context = ApplicationProvider.getApplicationContext<Application>()
    private val controller = Robolectric.buildActivity(ComponentActivity::class.java)
    private val defaultProxySelector: ProxySelector? = ProxySelector.getDefault()

    @Before
    fun prepare() {
        context.getSharedPreferences("app_updates", Context.MODE_PRIVATE).edit().clear().commit()
        // The real updater's check must never reach the network from a unit test: any HTTP(S) it attempts
        // goes to a closed loopback port and fails at once.
        val closed = InetSocketAddress(InetAddress.getLoopbackAddress(), closedLoopbackPort())
        ProxySelector.setDefault(object : ProxySelector() {
            override fun select(uri: URI?): List<Proxy> = listOf(Proxy(Proxy.Type.HTTP, closed))

            override fun connectFailed(uri: URI?, address: SocketAddress?, error: IOException?) = Unit
        })
        controller.setup()
    }

    @After
    fun close() {
        controller.get().viewModelStore.clear()
        controller.pause().stop().destroy()
        ProxySelector.setDefault(defaultProxySelector)
        context.getSharedPreferences("app_updates", Context.MODE_PRIVATE).edit().clear().commit()
    }

    @Test
    fun theSwitchPersistsThroughTheActivityUpdater() {
        val updater = AppUpdater.forActivity(controller.get())
        val controls = SettingsDependencies.forActivity(controller.get(), FakeServerHost()).updates
        assertTrue(controls.enabled)
        controls.enabled = false
        assertFalse(updater.enabled)
        assertFalse(UpdateStore(context).enabled)
        assertSame(updater.state, controls.state)
        controls.enabled = true
        assertTrue(UpdateStore(context).enabled)
    }

    @Test
    fun checkNowAsksTheUpdaterWhichShowsItsOwnDialog() {
        val updater = AppUpdater.forActivity(controller.get())
        val controls = AppUpdaterControls(updater)
        controls.enabled = false
        controls.checkNow()
        // The manual check starts at once and makes the updater's dialog visible; Settings installs nothing.
        assertEquals(UpdatePhase.CHECKING, controls.state.phase)
        assertTrue(controls.state.visible)
        assertFalse(controls.enabled)
        // The result Settings shows is the updater's own, retained in its state.
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
        while (controls.state.lastResult == null && System.nanoTime() < deadline) {
            shadowOf(Looper.getMainLooper()).idle()
            Thread.sleep(10)
        }
        assertNotNull(controls.state.lastResult)
        assertSame(updater.lastResult, controls.state.lastResult)
        assertTrue(controls.state.phase != UpdatePhase.CHECKING)
    }

    private fun closedLoopbackPort(): Int {
        repeat(50) {
            val port = Random.nextInt(20_000, 61_000)
            try {
                ServerSocket(port, 1, InetAddress.getLoopbackAddress()).close()
                return port
            } catch (_: IOException) {
                // In use; try another one.
            }
        }
        error("No free loopback port")
    }
}
