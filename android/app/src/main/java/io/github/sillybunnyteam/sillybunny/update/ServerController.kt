package io.github.sillybunnyteam.sillybunny.update

fun interface ServerController {
    fun stopForUpdate()

    /**
     * Runs off the main thread after an update ended without replacing the app: the user cancelled or
     * declined, or the install failed or was abandoned. It can run more than once, and also when
     * [stopForUpdate] never ran, so restore only a server that [stopForUpdate] stopped.
     *
     * It can also run while no activity is visible, because the result can arrive after the user left, and it
     * is not called again for that result. A restore that needs the foreground (a foreground-service start)
     * must therefore wait for the next visible activity instead of failing now.
     */
    fun resumeAfterAbandonedUpdate() = Unit
}

object NoOpServerController : ServerController {
    override fun stopForUpdate() = Unit
}
