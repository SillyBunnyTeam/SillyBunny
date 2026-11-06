package io.github.sillybunnyteam.sillybunny.settings

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.calculateEndPadding
import androidx.compose.foundation.layout.calculateStartPadding
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.SemanticsPropertyKey
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import io.github.sillybunnyteam.sillybunny.R
import io.github.sillybunnyteam.sillybunny.update.UpdatePhase

/** Test tags of every Settings element. With `testTagsAsResourceId`, UiAutomator sees them as resource ids. */
object SettingsTags {
    const val MAIN = "settings_main"
    const val LOGS = "settings_logs"
    const val LICENSES = "settings_licenses"
    const val NAVIGATE_UP = "settings_navigate_up"

    const val SERVER_STATUS = "settings_server_status"
    const val SERVER_STOP = "settings_server_stop"
    const val SERVER_START = "settings_server_start"
    const val SERVER_PROGRESS = "settings_server_progress"
    const val OPEN_IN_BROWSER = "settings_open_in_browser"

    const val AUTO_UPDATE_GIT = "settings_auto_update_git"
    const val RESTART_SERVER = "settings_restart_server"
    const val APP_UPDATES = "settings_app_updates"
    const val CHECK_NOW = "settings_check_now"

    const val RUNTIME = "settings_runtime"
    const val BATTERY = "settings_battery"
    const val LOCAL_NETWORK = "settings_local_network"
    const val DATA_ELSEWHERE = "settings_data_elsewhere"

    const val VIEW_LOGS = "settings_view_logs"
    const val SHARE_LOGS = "settings_share_logs"
    const val REPAIR = "settings_repair"
    const val LEFTOVER_FOLDERS = "settings_leftover_folders"
    const val OPEN_LICENSES = "settings_open_licenses"

    const val LOGS_TEXT = "settings_logs_text"
    const val LOGS_EMPTY = "settings_logs_empty"
    const val LOGS_SHARE = "settings_logs_share"

    const val SHARE_DIALOG = "settings_share_dialog"
    const val SHARE_WARNING = "settings_share_warning"
    const val SHARE_CONFIRM = "settings_share_confirm"
    const val SHARE_CANCEL = "settings_share_cancel"
    const val SHARE_PROGRESS = "settings_share_progress"
    const val SHARE_NO_LOGS = "settings_share_no_logs"
    const val SHARE_FAILED = "settings_share_failed"

    const val LICENSES_LOADING = "settings_licenses_loading"
    const val LICENSES_EMPTY = "settings_licenses_empty"
    const val LICENSES_LIST = "settings_licenses_list"
    const val LICENSES_FULL_TEXT_TOGGLE = "settings_licenses_full_text_toggle"

    /** The first chunk of the full `THIRD_PARTY_NOTICES` text. */
    const val LICENSES_FULL_TEXT = "settings_licenses_full_text"

    /** Followed by a component id, for example `settings_license_termux/git`. */
    const val LICENSE_COMPONENT_PREFIX = "settings_license_"

    /** Followed by a component id: the first chunk of that component's notice text. */
    const val LICENSE_NOTICE_PREFIX = "settings_license_notice_"
}

/** State the screens expose to tests and automation, so they never depend on the placeholder copy. */
object SettingsSemantics {
    /** `STOPPED`, `STARTING`, `RUNNING`, `STOPPING` or `FAILED`. */
    val ServerStatus = SemanticsPropertyKey<String>("SettingsServerStatus")
    val UpdatePhaseShown = SemanticsPropertyKey<UpdatePhase>("SettingsUpdatePhase")

    /** `NONE`, `UP_TO_DATE`, `AVAILABLE` or `FAILED_<UpdateCheckFailure>`. */
    val UpdateResultShown = SemanticsPropertyKey<String>("SettingsUpdateResult")
    val BatteryExempt = SemanticsPropertyKey<Boolean>("SettingsBatteryExempt")
    val LocalNetwork = SemanticsPropertyKey<LocalNetworkStatus>("SettingsLocalNetwork")
    val LeftoverCount = SemanticsPropertyKey<Int>("SettingsLeftoverCount")

    /** `component=version` pairs in display order. */
    val RuntimeVersions = SemanticsPropertyKey<List<String>>("SettingsRuntimeVersions")
    val LogLines = SemanticsPropertyKey<List<String>>("SettingsLogLines")

    /** A [NoticesLoad.Reason] name. */
    val NoticesUnavailable = SemanticsPropertyKey<String>("SettingsNoticesUnavailable")
}

private const val DISABLED_ALPHA = 0.38f

/**
 * Splits a Scaffold's content padding for edge-to-edge scrolling: the top bar's share goes outside the scroll
 * container ([belowTopBar]), so nothing scrolls under the opaque bar, and the system-bar insets go inside it
 * ([insideScroll]), so content scrolls behind the navigation bar yet its end stays reachable above it.
 */
internal fun Modifier.belowTopBar(padding: PaddingValues): Modifier = padding(top = padding.calculateTopPadding())

@Composable
internal fun PaddingValues.insideScroll(): PaddingValues {
    val direction = LocalLayoutDirection.current
    return PaddingValues(
        start = calculateStartPadding(direction),
        end = calculateEndPadding(direction),
        bottom = calculateBottomPadding(),
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun SettingsTopBar(
    title: String,
    onNavigateUp: () -> Unit,
    actions: @Composable RowScope.() -> Unit = {},
) {
    TopAppBar(
        title = { Text(title) },
        navigationIcon = {
            IconButton(onClick = onNavigateUp, modifier = Modifier.testTag(SettingsTags.NAVIGATE_UP)) {
                Icon(BackArrow, contentDescription = stringResource(R.string.settings_navigate_up))
            }
        },
        actions = actions,
    )
}

@Composable
internal fun SettingsSectionHeader(text: String) {
    Text(
        text = text,
        style = MaterialTheme.typography.titleSmall,
        color = MaterialTheme.colorScheme.primary,
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 16.dp, top = 24.dp, end = 16.dp, bottom = 4.dp)
            .semantics { heading() },
    )
}

/** One Settings row. Without [onClick] it is read-only; [modifier] may carry toggleable semantics instead. */
@Composable
internal fun SettingsEntry(
    headline: String,
    tag: String,
    modifier: Modifier = Modifier,
    supporting: String? = null,
    enabled: Boolean = true,
    onClick: (() -> Unit)? = null,
    trailing: (@Composable () -> Unit)? = null,
) {
    val click = if (onClick != null) Modifier.clickable(enabled = enabled, onClick = onClick) else Modifier
    ListItem(
        headlineContent = { Text(headline) },
        modifier = modifier
            .fillMaxWidth()
            .then(click)
            .testTag(tag)
            .alpha(if (enabled) 1f else DISABLED_ALPHA),
        supportingContent = supporting?.let { text -> { Text(text) } },
        trailingContent = trailing,
        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
    )
}

/** A plain stroked back arrow, mirrored for right-to-left layouts; the app ships no icon library. */
private val BackArrow: ImageVector by lazy {
    ImageVector.Builder(
        name = "SettingsBack",
        defaultWidth = 24.dp,
        defaultHeight = 24.dp,
        viewportWidth = 24f,
        viewportHeight = 24f,
        autoMirror = true,
    ).path(
        stroke = SolidColor(Color.Black),
        strokeLineWidth = 2f,
        strokeLineCap = StrokeCap.Round,
        strokeLineJoin = StrokeJoin.Round,
    ) {
        moveTo(19f, 12f)
        lineTo(5f, 12f)
        moveTo(11f, 6f)
        lineTo(5f, 12f)
        lineTo(11f, 18f)
    }.build()
}
