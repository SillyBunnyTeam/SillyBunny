package io.github.sillybunnyteam.sillybunny.update

import org.junit.Assert.assertEquals
import org.junit.Test

class ServerControllerTest {
    @Test
    fun defaultControllerIsInertAndTheInterfaceAcceptsASynchronousHook() {
        NoOpServerController.stopForUpdate()
        var calls = 0
        val controller = ServerController { calls++ }
        controller.stopForUpdate()
        assertEquals(1, calls)
    }
}
