package io.github.sillybunnyteam.sillybunny.settings

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.collapse
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.expand
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import io.github.sillybunnyteam.sillybunny.R
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Open-source licenses (plan §5.3): every component of `THIRD_PARTY_NOTICES.json` with its name, version
 * and license, each expandable to its notice text, plus the full `THIRD_PARTY_NOTICES` text. A missing,
 * malformed or unknown-schema pair shows an empty state, as in debug builds without runtime inputs.
 */
@Composable
fun SettingsLicensesScreen(
    source: NoticesSource,
    onNavigateUp: () -> Unit,
    modifier: Modifier = Modifier,
    ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
) {
    val load by produceState<NoticesLoad?>(initialValue = null, source, ioDispatcher) {
        value = withContext(ioDispatcher) { ThirdPartyNotices.load(source) }
    }
    Scaffold(
        modifier = modifier.testTag(SettingsTags.LICENSES),
        topBar = { SettingsTopBar(stringResource(R.string.settings_licenses_title), onNavigateUp) },
        contentWindowInsets = WindowInsets.safeDrawing,
    ) { padding ->
        when (val result = load) {
            null -> {
                val loading = stringResource(R.string.settings_licenses_loading)
                Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(
                        modifier = Modifier.testTag(SettingsTags.LICENSES_LOADING).semantics { contentDescription = loading },
                    )
                }
            }
            is NoticesLoad.Unavailable -> Box(
                modifier = Modifier.fillMaxSize().padding(padding).padding(24.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = stringResource(R.string.settings_licenses_empty),
                    modifier = Modifier
                        .testTag(SettingsTags.LICENSES_EMPTY)
                        .semantics { this[SettingsSemantics.NoticesUnavailable] = result.reason.name },
                )
            }
            is NoticesLoad.Loaded -> NoticesList(result.notices, padding, ioDispatcher)
        }
    }
}

/** Keys of the decoded texts and their list items: the full text, or `c:` and a component id. */
private const val FULL_TEXT_KEY = "full"

private fun componentKey(id: String) = "c:$id"

@Composable
private fun NoticesList(notices: ThirdPartyNotices, padding: PaddingValues, ioDispatcher: CoroutineDispatcher) {
    var expanded by rememberSaveable(saver = expandedSaver) { mutableStateOf(emptySet<String>()) }
    var fullTextShown by rememberSaveable { mutableStateOf(false) }
    val byKey = remember(notices) { notices.components.associateBy { componentKey(it.id) } }
    // Notice texts can be megabytes, so each is decoded and split off the main thread, once, when first shown.
    val decoded = remember(notices) { mutableStateMapOf<String, List<String>>() }
    val shown = expanded.map(::componentKey).toSet() + if (fullTextShown) setOf(FULL_TEXT_KEY) else emptySet()
    LaunchedEffect(notices, shown) {
        for (key in shown) {
            if (key in decoded) continue
            val component = byKey[key]
            if (key != FULL_TEXT_KEY && component == null) continue
            decoded[key] = withContext(ioDispatcher) {
                ThirdPartyNotices.chunks(if (component == null) notices.fullText() else notices.noticeText(component))
            }
        }
    }
    val unknownLicense = stringResource(R.string.settings_licenses_unknown_license)
    val loading = stringResource(R.string.settings_licenses_loading)
    LazyColumn(
        modifier = Modifier.fillMaxSize().belowTopBar(padding).testTag(SettingsTags.LICENSES_LIST),
        contentPadding = padding.insideScroll(),
    ) {
        item(key = FULL_TEXT_KEY) {
            ExpandableRow(
                expanded = fullTextShown,
                onToggle = { fullTextShown = !fullTextShown },
                tag = SettingsTags.LICENSES_FULL_TEXT_TOGGLE,
                headline = stringResource(R.string.settings_licenses_full_text),
            )
        }
        if (fullTextShown) noticeItems(FULL_TEXT_KEY, decoded[FULL_TEXT_KEY], SettingsTags.LICENSES_FULL_TEXT, loading)
        for (component in notices.components) {
            val key = componentKey(component.id)
            val open = component.id in expanded
            item(key = key) {
                ExpandableRow(
                    expanded = open,
                    onToggle = { expanded = if (open) expanded - component.id else expanded + component.id },
                    tag = SettingsTags.LICENSE_COMPONENT_PREFIX + component.id,
                    headline = component.name,
                    supporting = stringResource(
                        R.string.settings_licenses_component_details,
                        component.version,
                        component.spdx ?: unknownLicense,
                    ),
                )
            }
            if (open) noticeItems(key, decoded[key], SettingsTags.LICENSE_NOTICE_PREFIX + component.id, loading)
        }
    }
}

/** The blocks of one decoded text, or a progress row until it is decoded. The first block carries [firstTag]. */
private fun LazyListScope.noticeItems(key: String, chunks: List<String>?, firstTag: String, loading: String) {
    if (chunks == null) {
        item(key = "$key#loading") {
            Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(Modifier.semantics { contentDescription = loading })
            }
        }
    } else {
        items(count = chunks.size, key = { "$key#$it" }) { index ->
            NoticeBlock(chunks[index], if (index == 0) firstTag else null)
        }
    }
}

@Composable
private fun ExpandableRow(
    expanded: Boolean,
    onToggle: () -> Unit,
    tag: String,
    headline: String,
    supporting: String? = null,
) {
    ListItem(
        headlineContent = { Text(headline) },
        supportingContent = supporting?.let { text -> { Text(text) } },
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onToggle)
            .semantics {
                if (expanded) {
                    collapse { onToggle(); true }
                } else {
                    expand { onToggle(); true }
                }
            }
            .testTag(tag),
        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
    )
}

@Composable
private fun NoticeBlock(text: String, tag: String?) {
    SelectionContainer {
        Text(
            text = text,
            fontFamily = FontFamily.Monospace,
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp)
                .then(if (tag != null) Modifier.testTag(tag) else Modifier),
        )
    }
}

private val expandedSaver = listSaver<MutableState<Set<String>>, String>(
    save = { it.value.toList() },
    restore = { mutableStateOf(it.toSet()) },
)
