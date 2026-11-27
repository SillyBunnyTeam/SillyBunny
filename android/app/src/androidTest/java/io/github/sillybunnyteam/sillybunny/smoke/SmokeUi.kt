package io.github.sillybunnyteam.sillybunny.smoke

import android.content.Context
import android.content.Intent
import android.graphics.Rect
import android.os.SystemClock
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Direction
import androidx.test.uiautomator.StaleObjectException
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import java.util.regex.Pattern

/**
 * UiAutomator helpers of the smoke flows. Debug builds expose Compose test tags as resource ids
 * (`testTagsAsResourceId`), so `By.res(tag)` finds a tagged element.
 */
internal class SmokeUi(private val device: UiDevice, private val context: Context) {
    private val packageName: String = context.packageName

    /** Brings the app's launcher activity to the front, unless the app already is. */
    fun launchApp() {
        if (device.currentPackageName == packageName) return
        val intent = checkNotNull(context.packageManager.getLaunchIntentForPackage(packageName)) { "no launcher intent" }
        context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        device.wait(Until.hasObject(By.pkg(packageName).depth(0)), LAUNCH_MILLIS)
    }

    /** On screen right now, without scrolling. */
    fun present(tag: String): Boolean = device.hasObject(By.res(tag))

    /** Any element whose tag matches [pattern] is on screen. */
    fun presentMatching(pattern: String): Boolean = device.hasObject(By.res(Pattern.compile(pattern)))

    /** The tags matching [pattern] on screen right now. */
    fun tagsMatching(pattern: String): List<String> =
        device.findObjects(By.res(Pattern.compile(pattern))).mapNotNull { it.resourceName }

    /**
     * Waits for [tag], scrolling the screen's scrollable column to one end and back meanwhile. An end is where a
     * scroll leaves the tagged elements where they were: [UiObject2.scroll] reports the end only through a scroll
     * event, which a Compose column does not send, so its result would turn back after every scroll.
     */
    fun find(tag: String, timeoutMillis: Long = 10_000): UiObject2? {
        val deadline = SystemClock.uptimeMillis() + timeoutMillis
        var direction = Direction.DOWN
        while (true) {
            device.wait(Until.findObject(By.res(tag)), POLL_MILLIS)?.let { return it }
            if (SystemClock.uptimeMillis() >= deadline) return null
            val column = device.findObject(By.scrollable(true)) ?: continue
            val before = taggedLayout()
            try {
                column.scroll(direction, 0.8f)
            } catch (_: StaleObjectException) {
                continue
            }
            if (taggedLayout() == before) {
                direction = if (direction == Direction.DOWN) Direction.UP else Direction.DOWN
            }
        }
    }

    /** The tagged elements on screen and their bounds, which a scroll moves. */
    private fun taggedLayout(): List<Pair<String?, Rect>> = device.findObjects(By.res(TAGGED)).mapNotNull {
        try {
            it.resourceName to it.visibleBounds
        } catch (_: StaleObjectException) {
            null
        }
    }

    fun click(tag: String, timeoutMillis: Long = 10_000) {
        checkNotNull(find(tag, timeoutMillis)) { "$tag is not on screen" }.click()
    }

    /** Clicks [tag] if it shows up within [timeoutMillis]; false when it did not or vanished meanwhile. */
    fun clickIfShown(tag: String, timeoutMillis: Long = 3_000): Boolean = tap(find(tag, timeoutMillis))

    /** Clicks [target] unless it is gone; screens change under a polling loop. */
    fun tap(target: UiObject2?): Boolean {
        if (target == null) return false
        return try {
            target.click()
            true
        } catch (_: StaleObjectException) {
            false
        }
    }

    /** The first of [tags] that appears within [timeoutMillis], or null. */
    fun waitForAny(tags: List<String>, timeoutMillis: Long): String? {
        val deadline = SystemClock.uptimeMillis() + timeoutMillis
        while (true) {
            tags.firstOrNull { present(it) }?.let { return it }
            if (SystemClock.uptimeMillis() >= deadline) return null
            SystemClock.sleep(POLL_MILLIS)
        }
    }

    fun gone(tag: String, timeoutMillis: Long): Boolean = device.wait(Until.gone(By.res(tag)), timeoutMillis) == true

    /**
     * Allows a runtime-permission dialog if one is on screen or appears within [timeoutMillis]. A tap while the
     * dialog opens can go to a window that takes no input yet (seen on API 37), so the button gets a new tap
     * until the dialog closes.
     */
    fun allowPermission(timeoutMillis: Long = 0): Boolean {
        val selector = By.res(Pattern.compile(".*:id/permission_allow_button"))
        var button = if (timeoutMillis > 0) device.wait(Until.findObject(selector), timeoutMillis) else device.findObject(selector)
        if (button == null) return false
        val deadline = SystemClock.uptimeMillis() + DIALOG_MILLIS
        while (SystemClock.uptimeMillis() < deadline) {
            tap(button)
            if (device.wait(Until.gone(selector), RETAP_MILLIS) == true) return true
            button = device.findObject(selector) ?: return true
        }
        return false
    }

    /**
     * The system installer's confirmation button. AlertDialog-based installers use `button1`; the
     * label match covers installers that draw their own buttons (an English-locale emulator).
     */
    fun installerButton(): UiObject2? =
        device.findObject(By.pkg(INSTALLER).res("android:id/button1"))
            ?: device.findObject(By.pkg(INSTALLER).clickable(true).text(INSTALL_LABEL))

    /** The unchecked "install unknown apps" switch, when Settings shows that screen. */
    fun unknownSourcesSwitch(): UiObject2? = device.findObject(By.pkg(SETTINGS).checkable(true).checked(false))

    fun pressBack() {
        device.pressBack()
    }

    private companion object {
        const val LAUNCH_MILLIS = 30_000L
        const val POLL_MILLIS = 500L
        const val DIALOG_MILLIS = 10_000L
        const val RETAP_MILLIS = 2_000L
        const val SETTINGS = "com.android.settings"
        val TAGGED: Pattern = Pattern.compile(".+")
        val INSTALLER: Pattern = Pattern.compile(".*packageinstaller")
        val INSTALL_LABEL: Pattern = Pattern.compile("(?i)update|install")
    }
}
