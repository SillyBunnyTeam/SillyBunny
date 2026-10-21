package io.github.sillybunnyteam.sillybunny.update

fun interface ServerController {
    fun stopForUpdate()
}

object NoOpServerController : ServerController {
    override fun stopForUpdate() = Unit
}
