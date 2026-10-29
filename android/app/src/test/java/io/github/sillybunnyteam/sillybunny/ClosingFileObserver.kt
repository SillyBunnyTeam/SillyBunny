package io.github.sillybunnyteam.sillybunny

import android.os.FileObserver
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.shadows.ShadowFileObserver
import java.nio.file.WatchService

/**
 * Robolectric's FileObserver shadow opens a WatchService for every observer it constructs and never closes it,
 * so each observer would keep one of the user's 128 inotify instances for the rest of the test JVM. Parallel
 * Gradle runs share that limit, and running out fails every later observer. This shadow closes the service when
 * the observer stops.
 */
@Implements(FileObserver::class)
class ClosingFileObserver : ShadowFileObserver() {
    @Implementation
    override fun stopWatching() {
        super.stopWatching()
        val watchService = ShadowFileObserver::class.java.getDeclaredField("watchService")
        watchService.isAccessible = true
        (watchService.get(this) as WatchService).close()
    }
}
