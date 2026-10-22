package io.github.sillybunnyteam.sillybunny.update

import org.junit.Assert.assertEquals
import org.junit.Test

class ServerControllerTest {
    @Test
    fun defaultControllerIsInertAndTheInterfaceAcceptsASynchronousHook() {
        NoOpServerController.stopForUpdate()
        NoOpServerController.resumeAfterAbandonedUpdate()
        var calls = 0
        val controller = ServerController { calls++ }
        controller.stopForUpdate()
        // A stop-only hook keeps compiling and treats a resume as a no-op.
        controller.resumeAfterAbandonedUpdate()
        assertEquals(1, calls)
    }
}
