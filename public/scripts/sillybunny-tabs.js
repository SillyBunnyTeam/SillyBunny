import { DEFAULT_SCROLL_EDGE_SETTLE_DELAYS, jumpScrollElementToEdge } from './chat-scroll-edges.js';
import { createDeferredPanel } from './deferred-panel.js';
import { createDeferredModule } from './deferred-module.js';
import { hasServerReturnedAfterRestart } from './server-restart-monitor.js';
import { initInstallNotice } from './sillybunny-install-notice.js';
import {
    clampMobileShellText as clampText,
    createMobileShellLifecycle,
    normalizeMobileShellText as normalizeText,
} from './mobile-shell-lifecycle/index.js';
import { isIOSWebKitPlatform, isLegacyIOSWebKitPlatform } from './mobile-send-button.js';
import { initializeMobileBottomBar, syncMobileBottomBar } from './sillybunny-mobile-bottom-bar.js';
import { HOME_STATE_CHANGED_EVENT, initHomeState, isHomeActive } from './sillybunny-home-state.js';
import { CHAT_MODE_CHANGED_EVENT, getLastChatMode, initChatModeMemory, recordChatMode } from './sillybunny-chat-mode-memory.js';
import { initBootMarks } from './sillybunny-boot-marks.js';
import { initSplashPreferences } from './sillybunny-splash-preferences.js';
import { initRetiredKeys } from './sillybunny-retired-keys.js';
import { createSplashCharacterRow } from './sillybunny-splash-setting.js';
import { power_user } from './power-user.js';
import { accountStorage } from './util/AccountStorage.js';
import { initializeMessageActions } from './sillybunny-message-actions.js';
import { initializeToastMotion } from './sillybunny-toast-motion.js';
import './sillybunny-extension-actions.js';
// Listens for the chat from the moment the app loads, because a chat can be on screen before Home has ever rendered.
import './sillybunny-home/greeting-art-boot.js';
import { initializeColorPickers } from './sillybunny-color-picker.js';
import { openActionMenu } from './sillybunny-action-menu.js';
import { isApplePlatform } from './sillybunny-platform.js';
import { createPresetAutosaveToggle, initializePresetAutosave, refreshPresetProtectionUi } from './sillybunny-preset-autosave.js';
import { registerSidePanel } from './sillybunny-editor/side-panel.js';
import { adoptComposerMenus, adoptLegacyPopup } from './sillybunny-editor/sheet-gestures.js';
import { openAlert } from './sillybunny-editor/dialog.js';
import { createButtonRow, createEntryRow, createExpanderRow, createRow, createSwitchRow } from './sillybunny-editor/rows.js';
import { createSearchEntry } from './sillybunny-editor/search-entry.js';
import { bindRovingFocus } from './sillybunny-editor/list-focus.js';
import { createProfileRow, createSelectRow } from './sillybunny-editor/select-row.js';
import { presentMarkdownEngineRow } from './sillybunny-markdown-engine-row.js';
import { openMassDeleteChatDialog } from './sillybunny-chat-dialogs.js';
import {
    animateIn,
    animateOut,
    MOTION_FAST,
    prefersReducedMotion,
    stopMotion,
} from './sillybunny-motion.js';
import { createPresetApiSyncLifecycle } from './preset-api-sync-lifecycle/index.js';
import { fetchWithCsrfRetry } from './csrf-token-refresh.js';
import {
    PERSONA_APPENDICES_DEFAULT_SCOPE_KEY,
    PERSONA_APPENDICES_SELECTIONS_KEY,
} from './sillybunny-conversation/constants.js';
import { conversationState } from './sillybunny-conversation/state.js';
import {
    resolveCharacterBadgeMirrorPlan,
    resolveTopbarAdoptionPlan,
    TOPBAR_ADOPTED_MARKER_ATTRIBUTE,
    TOPBAR_ADOPTION_ATTRIBUTE,
    TOPBAR_EXTENSION_SLOT_ID,
} from './topbar-extension-slot/index.js';

import { escapeRegex } from './util/escape-regex.js';
import { flashHighlight } from './utils.js';
import { extension_settings } from './extensions.js';
import { changePanelApiVisibility, characters, displayVersion, flushCharacterSaveDebounced, getCurrentChatId, getOneCharacter, getThumbnailUrl, parseAvatarSource, refreshCsrfToken, saveSettingsDebounced, this_chid } from '../script.js';
import { addLanguagesToDropdown, t, translate } from './i18n.js';
import { isAdmin, syncUserControls } from './user.js';
import {
    SAMPLING_PARAMETER_DESCRIPTORS,
} from './sampling-parameter-policy.js';
import {
    setSamplingParameterTransmissionState,
    getSamplingParameterViewModel,
} from './openai.js';
import {
    setTextSamplingParameterTransmissionState,
    getTextSamplingParameterViewModel,
    showTGSamplerControls,
} from './textgen-settings.js';
import {
    SB_USER_SETTINGS_CONTAINER_IDS,
    SB_DATA_SECURITY_CONTAINER_ID,
    SB_FLAT_SECTION_CLASS,
    SB_FLAT_SECTION_HEADER_CLASS,
    applyPageWidth,
    applySettingsSectionOrder,
    syncClassicScrollbars,
    flattenNestedSettingsDrawers,
    splitUserSettingsContent,
} from './sillybunny-settings-content.js';
import { normalizeBackendSettingsRows, normalizeSettingsDetail, normalizeSettingsPresentation, setAnimatedBackgroundPresenter } from './sillybunny-settings-presentation.js';
import { createSubpageStack, SB_SUBPAGE_DURATION, SB_SUBPAGE_STORE_CLASS } from './sillybunny-settings-subpage.js';
import { buildExtensionsLead, SB_SUBPAGE_BUILDERS } from './sillybunny-settings-subpage-descriptors.js';
import { watchStrayExtensionDrawers } from './sillybunny-settings-stray-drawers.js';
import { createConnectionsPanel } from './sillybunny-connections-panel.js';
import { createStatusPage } from './sillybunny-editor/status-page.js';
import { initializePromptEditor } from './sillybunny-prompt-editor.js';
// SillyBunny: the Agents shell mounts independently of extension initialization.
import { mountAgentsPanel, getAgentsPanelSearchEntries } from './extensions/in-chat-agents/ui/agent-list.js';
// SillyBunny: character editor controller
import { initCharacterEditor } from './sillybunny-character-editor.js';
import { leaveTemporaryChat } from './sillybunny-temporary-chat.js';
import { isReservedChatName } from './sillybunny-temporary-chat-state.js';
import { collectEntitySearchEntries, primeWorldInfoSearchCache } from './sillybunny-search-entities.js';
import { eventSource, event_types } from './events.js';
import { registerHelpKeys } from './sillybunny-help/help-keys.js';
import { openHelp, openKeyboardShortcuts } from './sillybunny-home/windows.js';
import { BOTTOM_BAR_COMPACT_QUERY, LAYOUT_MOBILE_QUERY } from './sillybunny-editor/breakpoints.js';
const sbMobileShellLifecycle = createMobileShellLifecycle();
const sbPresetApiSyncLifecycle = createPresetApiSyncLifecycle();
const sbSearchRenderRequests = new WeakMap();
const loadServerToolsModule = createDeferredModule(new URL('./sillybunny-server-tools.js', import.meta.url));
const loadDataSecurityModule = createDeferredModule(new URL('./sillybunny-data-security.js', import.meta.url));
const loadAppearanceModule = createDeferredModule(new URL('./sillybunny-appearance.js', import.meta.url));
const loadBackgroundGalleryModule = createDeferredModule(new URL('./sillybunny-background-gallery.js', import.meta.url));
const loadBackendPagesModule = createDeferredModule(new URL('./sillybunny-backend-pages.js', import.meta.url));
const loadSamplingModule = createDeferredModule(new URL('./sillybunny-sampling.js', import.meta.url));
/** Set once the Formatting and Presets rows have been built; the Backend updates call into it. */
let backendPagesModule = null;
let backendPagesPromise;
let serverToolsPromise;
let settingsPanelPromise;
/** Set once the Appearance module has regrouped the upstream rows; the Appearance helpers need it. */
let appearanceModule = null;

/** Appearance holds raw upstream rows until its module has regrouped them, and the settings passes must not reshape them first. */
function isAppearancePending(tabId) {
    return tabId === 'appearance' && appearanceModule === null;
}

async function presentAppearancePage() {
    const container = document.getElementById(SB_USER_SETTINGS_CONTAINER_IDS.appearance);
    try {
        const module = await loadAppearanceModule();
        module.presentAppearance(container);
        appearanceModule = module;
        setAnimatedBackgroundPresenter(module.presentAnimatedBackgrounds);
        // The folder gallery loads with the Appearance page, which stays busy until it has taken over the Global tab, so the header does not change under a reader.
        await loadBackgroundGalleryModule().then(gallery => gallery.initBackgroundGallery()).catch(error => console.error('[Backgrounds] The folder gallery did not load:', error));
    } finally {
        container?.removeAttribute('aria-busy');
    }
}

function loadServerTools() {
    serverToolsPromise ??= loadServerToolsModule().then(module => module.createServerTools({
        createElement, createShellPanel, hasServerReturnedAfterRestart, isShellOpen, isShellTabOpen, setButtonDisabled,
        setServerAdminMessage, setServerAdminPill, wait, waitForAuthorizedRequestHeaders,
    })).catch(error => {
        serverToolsPromise = undefined;
        throw error;
    });
    return serverToolsPromise;
}

/** Opens a Backend page and brings one of its groups into view, as a search result does. */
function revealBackendGroup(tabId, groupId) {
    const group = document.getElementById(groupId);
    // A search jump centres its target, so the title is the target: a tall group would centre below its own heading.
    const target = group?.querySelector('.sb-settings-category-title') ?? group;
    if (target instanceof HTMLElement) revealSearchMatch('left', { tabId, element: target });
}

const backendPagesContext = {
    revealGroup: revealBackendGroup,
    templateMenuSections: holder => getPresetMenuSections(holder, false, { master: false }),
    refreshPresets() {
        const prompting = getShellState('left')?.tabs.get('prompting');
        if (prompting?.panel instanceof HTMLElement) updatePromptingPanel(prompting.panel);
    },
};

/**
 * Loads the Formatting and Presets page module and builds their rows. Search waits for it through `ensureReady`, so a
 * row is found before the page was opened.
 */
function ensureBackendPages() {
    backendPagesPromise ??= markPanelsBusyUntilBuilt('left', ['context', 'prompting'], loadBackendPagesModule().then(module => {
        backendPagesModule = module;
        groupAdvancedFormattingIntoDrawers();
        module.presentFormatting(backendPagesContext);
        updateFormattingGroupVisibility(document.getElementById('AdvancedFormatting'));
        // The Presets groups are built by the update that follows, so build the rows after it and update once more.
        const prompting = getShellState('left')?.tabs.get('prompting');
        if (prompting?.panel instanceof HTMLElement) updatePromptingPanel(prompting.panel);
        for (const tabId of ['context', 'prompting']) {
            const tab = getShellState('left')?.tabs.get(tabId);
            if (tab) tab.searchIndex = null;
        }
    }).catch(error => {
        backendPagesPromise = undefined;
        console.error('[SillyBunny] Could not build the Formatting and Presets rows:', error);
        throw error;
    }));
    return backendPagesPromise;
}

/**
 * Marks the panels that a deferred module fills as busy until it has built them, the way an on-demand panel is marked, so
 * that a screen reader and automated checks can tell a page that is still the raw upstream rows from a built one.
 * @template T
 * @param {'left' | 'right'} shellKey
 * @param {string[]} tabIds
 * @param {Promise<T>} build
 * @returns {Promise<T>}
 */
function markPanelsBusyUntilBuilt(shellKey, tabIds, build) {
    const panels = tabIds
        .map(tabId => getShellState(shellKey)?.tabs.get(tabId)?.panel)
        .filter(panel => panel instanceof HTMLElement);
    for (const panel of panels) panel.setAttribute('aria-busy', 'true');
    const done = () => panels.forEach(panel => panel.removeAttribute('aria-busy'));
    build.then(done, done);
    return build;
}

function initializeSettingsPanel() {
    settingsPanelPromise ??= markPanelsBusyUntilBuilt('right', ['appearance', 'interface', 'messages'], presentAppearancePage().then(() => {
        injectThemePicker();
        // SillyTavern's own settings tab UI is not used here: the settings page sidebar owns
        // navigation, so the inline drawers are opened directly instead.
        openAllInlineDrawers();
        applyDefaultDrawerStates();
        // The theme picker injection can author drawers inside another drawer: the Appearance theme card
        // creates `#sb-interface-drawer`, `#sb-topbar-label-drawer` and
        // `#sb-quick-access-shortcuts-drawer` inside `#AppearanceSection`, all after the split has
        // already run its flatten pass. The flatten pass is therefore repeated once the panel is fully built.
        flattenRightShellSettingsDrawers();
        invalidateUserSettingsTabSearchIndexes();
    })).catch(error => {
        settingsPanelPromise = undefined;
        throw error;
    });
    return settingsPanelPromise;
}

/**
 * Tabs whose collapsible drawers are left alone.
 *
 * Extensions keeps its drawers: each one is a self-contained, independently authored block
 * rather than a stray accordion.
 * Connections preserves upstream drawer content because its descendants carry provider visibility
 * gates; its scoped form pass supplies expander-row presentation without flattening that ancestry.
 */
// SillyBunny: Agents owns shared preference pages, not an extension drawer.
const SB_COLLAPSIBLE_DRAWER_TAB_IDS = Object.freeze(new Set(['extensions', 'connections']));

/**
 * Extensions owns independently authored sections, so it retains the sliding detail stack.
 * Prompting uses its live backend groups on one scrolling page instead.
 */
const SB_SUBPAGE_TAB_IDS = Object.freeze(new Set(['extensions']));

/**
 * Whether a panel's presentation is owned by the subpage stack rather than by the settings passes.
 *
 * @param {string} tabId
 * @returns {boolean}
 */
function isSubpagePanel(tabId) {
    return SB_SUBPAGE_TAB_IDS.has(tabId);
}

/** The stacks installed so far, keyed by `${shellKey}:${tabId}` so a rebuild replaces its own. */
const sbSubpageStacks = new Map();

/**
 * Presents a panel as a list of sections that slide their detail page in from the right.
 *
 * The panel's authored markup is not rewritten. Its children are hidden in place and a section is
 * moved out of that hidden store into the detail page when its row opens, then moved back, so every
 * id, listener, and extension lookup on those nodes keeps working exactly as before.
 *
 * Idempotent: the second call for a panel refreshes the existing stack's rows rather than building a
 * second one beside it, which is what lets it run from both the activation path and the deferred
 * build path.
 *
 * @param {string} shellKey
 * @param {string} tabId
 */
function installSettingsSubpage(shellKey, tabId) {
    const spec = SB_SUBPAGE_BUILDERS[tabId];
    if (!spec) {
        return;
    }

    const panel = getShellState(shellKey)?.tabs.get(tabId)?.panel;
    const scroller = panel?.querySelector(':scope > .sb-shell-panel-scroller');
    if (!(scroller instanceof HTMLElement)) {
        return;
    }

    const key = `${shellKey}:${tabId}`;
    const existing = sbSubpageStacks.get(key);
    if (existing) {
        // The list is discovered (Extensions gains rows as its containers mount), so a revisit
        // refreshes it rather than building a second stack beside the first. The read is deferred so
        // it happens once the rows it would find are back in the panel.
        existing.rebuild(() => spec(panel));
        return;
    }

    const built = spec(panel);
    if (!built?.rows?.length) {
        return;
    }

    // The authored wrapper stays in the document and keeps its ids, but it is out of the layout: the
    // stack draws the panel now, and the rows move its sections into and out of the detail page.
    for (const child of Array.from(scroller.children)) {
        if (child instanceof HTMLElement && !child.classList.contains('sb-subpage')) {
            child.classList.add(SB_SUBPAGE_STORE_CLASS);
        }
    }

    scroller.classList.add('sb-subpage-host');

    const stack = createSubpageStack(scroller, {
        name: tabId,
        backLabel: t`Back`,
        // The detail page gets the same presentation pass a normal panel gets, but scoped to the
        // section that was moved: these panels are skipped by the whole-panel pass, and their
        // sections are only readable as the pass reads them once the section is in its own page.
        onContent: (content, row) => normalizeSettingsDetail(content, { name: tabId, rowLabel: row.label, builtIn: row.builtIn === true }),
    });
    stack.setRows(built.rows);
    sbSubpageStacks.set(key, stack);

    // SillyBunny: the rows the page builds are styled by deferred sheets, so the stack stays out of sight until they apply.
    const sheets = SB_PANEL_STYLESHEETS[`${shellKey}:${tabId}`];
    if (sheets && window.SillyBunnyAssets?.loadStylesheetAsync) {
        stack.root.setAttribute('aria-busy', 'true');
        void Promise.all(sheets.map(sheet => window.SillyBunnyAssets.loadStylesheetAsync(sheet.href, { id: sheet.id })))
            .catch(error => console.warn('Failed to load panel stylesheet:', error))
            .finally(() => stack.root.removeAttribute('aria-busy'));
    }

    // SillyBunny: the page's own groups (the manage, install and notify controls, and Download Extensions &
    // Assets) lead the list. They are moved out of the store, where the CSS hides them, so they are never hidden.
    if (tabId === 'extensions' && panel instanceof HTMLElement) {
        const lead = buildExtensionsLead(panel, built.pinned, {
            // The assets extension mounts after the panel is built, so the index that a search took before it is short of its rows.
            onPresented: () => {
                const tab = getShellState(shellKey)?.tabs.get(tabId);
                if (tab) {
                    tab.searchIndex = null;
                }
            },
        });
        stack.listLead.append(...lead.sections);
        stack.observeWith(lead.disconnect);
    }

    if (built.observe instanceof HTMLElement) {
        // Extension containers mount over the first seconds after the panel is built, so the list is
        // rebuilt from the DOM rather than captured once.
        const observer = new MutationObserver(() => {
            stack.rebuild(() => spec(panel));
            // The list just changed, so what the tab's search index holds for it is now short of a
            // row at best. A search taken before an extension finished mounting must not stick.
            const tab = getShellState(shellKey)?.tabs.get(tabId);
            if (tab) {
                tab.searchIndex = null;
            }
        });
        observer.observe(built.observe, { childList: true, subtree: true });
        stack.observeWith(() => observer.disconnect());
    }
}

function getPresetActionKind(button) {
    if (!(button instanceof HTMLElement)) return null;
    for (const kind of ['import', 'export', 'update', 'rename', 'new', 'restore', 'delete']) {
        if (button.matches(`[data-preset-manager-${kind}]`)) return kind;
    }
    if (button.matches('[data-preset-manager-delete-all]')) {
        return 'deleteAll';
    }
    if (button.matches('[data-preset-manager-restore-defaults]')) return 'restoreDefaults';
    if (button.id === 'import_oai_preset') return 'import';
    if (button.id === 'export_oai_preset') return 'export';
    if (button.id === 'update_oai_preset') return 'update';
    if (button.id === 'new_oai_preset') return 'new';
    if (button.id === 'delete_oai_preset') return 'delete';
    return null;
}

const SB_PRESET_BLOCK_BY_API = Object.freeze({
    kobold: 'kobold_api-presets',
    koboldhorde: 'kobold_api-presets',
    novel: 'novel_api-presets',
    textgenerationwebui: 'textgenerationwebui_api-presets',
    openai: 'openai_api-presets',
});

/** Picker and menu titles reuse each backend's preset heading key, which the locales already translate. */
const SB_PRESET_ROW_TITLES = Object.freeze({
    'kobold_api-presets': ['Kobold Presets', 'kobldpresets'],
    'novel_api-presets': ['NovelAI Presets', 'novelaipresets'],
    'textgenerationwebui_api-presets': ['Text Completion Presets', 'Text Completion presets'],
    'openai_api-presets': ['Chat Completion Presets', 'openaipresets'],
});

const SB_PRESET_MENU_SECTIONS = Object.freeze([
    ['update', 'rename', 'new'],
    ['import', 'export', 'masterImport', 'masterExport'],
    ['restore', 'restoreDefaults'],
    ['delete', 'deleteAll'],
]);

const sbPresetRows = [];

/**
 * An ellipsis marks an action that asks for more input or a confirmation. PresetManager confirms
 * Update and downloads Export at once. Chat Completions saves Update at once and asks before it exports.
 */
function getPresetActionLabels(isChatCompletion) {
    return {
        update: isChatCompletion ? t`Update` : t`Update…`,
        rename: t`Rename…`,
        new: t`Save As…`,
        import: t`Import…`,
        export: isChatCompletion ? t`Export…` : t`Export`,
        masterImport: t`Master Import…`,
        masterExport: t`Master Export…`,
        restore: t`Restore…`,
        restoreDefaults: t`Restore Default Presets…`,
        delete: t`Delete…`,
        deleteAll: t`Delete in Bulk…`,
    };
}

/** Reads the live originals, so call it on every open: PresetManager adds its restore-defaults button late, and autosave marks Update read-only per preset. */
function getPresetMenuSections(block, isChatCompletion, { master = true } = {}) {
    const originals = new Map();
    for (const button of block.querySelectorAll('.menu_button, .menu_button_icon')) {
        const kind = getPresetActionKind(button);
        if (kind && !originals.has(kind)) originals.set(kind, button);
    }
    if (!isChatCompletion && master) {
        originals.set('masterImport', document.getElementById('af_master_import'));
        originals.set('masterExport', document.getElementById('af_master_export'));
    }
    const labels = getPresetActionLabels(isChatCompletion);
    const toItem = kind => {
        const original = originals.get(kind);
        if (!(original instanceof HTMLElement)) return null;
        // An action that does not apply (a preset that cannot be updated) is left out, not drawn dimmed.
        const disabled = original.classList.contains('disabled')
            || original.hasAttribute('disabled')
            || original.getAttribute('aria-disabled') === 'true';
        if (disabled) return null;
        return {
            label: labels[kind],
            icon: original.querySelector('i')?.className,
            ...(kind.startsWith('master') ? { title: original.title } : {}),
            danger: kind === 'delete' || kind === 'deleteAll',
            onSelect: () => original.click(),
        };
    };
    return SB_PRESET_MENU_SECTIONS.map(kinds => ({ items: kinds.map(toItem).filter(Boolean) }));
}

/**
 * Each backend's original preset select row, its buttons, the Chat Completions title card and Master
 * Import/Export stay in the document, hidden, because upstream binds every action to them and the
 * Preset Menu clicks them.
 */
function mountPresetRows(root) {
    for (const blockId of new Set(Object.values(SB_PRESET_BLOCK_BY_API))) {
        const block = root.querySelector(`#${blockId}`);
        const select = block?.querySelector('select[data-preset-manager-for]');
        if (!(select instanceof HTMLSelectElement) || select.closest('[data-sb-preset-row]')) continue;
        // Read before createProfileRow adopts the select into the new row.
        const source = select.parentElement;
        const isChatCompletion = blockId === SB_PRESET_BLOCK_BY_API.openai;
        const title = translate(...SB_PRESET_ROW_TITLES[blockId]);
        const preset = createProfileRow({
            select,
            label: t`Preset`,
            field: `preset-${blockId}`,
            title,
            searchLabel: t`Search Presets`,
            searchPlaceholder: t`Search presets`,
            menuLabel: t`Preset Menu`,
            onMenu: trigger => openActionMenu({ trigger, title, sections: getPresetMenuSections(block, isChatCompletion) }),
        });
        preset.row.dataset.sbPresetRow = '';
        source.before(preset.row);
        source.hidden = true;
        sbPresetRows.push(preset);
    }
    const hidden = root.querySelector('#openai_api-presets > div > .standoutHeader');
    if (hidden instanceof HTMLElement && !hidden.hidden) hidden.hidden = true;
}

/** Keeps Edit Prompts and then the autosave switch directly below the active backend's preset block. */
function placeSharedPresetControls(root, activeApi) {
    let anchor = document.getElementById(SB_PRESET_BLOCK_BY_API[activeApi] ?? '');
    if (!(anchor instanceof HTMLElement) || !root.contains(anchor)) return;
    for (const row of [root.querySelector('[data-sb-edit-prompts]'), root.querySelector('[data-sb-preset-autosave]')]) {
        if (!(row instanceof HTMLElement)) continue;
        // Moving a row that is already in place still queues a mutation, and the drawer observer re-runs this.
        if (anchor.nextElementSibling !== row) anchor.after(row);
        anchor = row;
    }
}

/**
 * Moves the Chat Completions linking switches out of their drawer in Presets into a group after it.
 * Each copy block moves whole: its copy line becomes the row subtitle only while it follows the label,
 * and toggle-dependent.css shows the profile buttons only while their container follows the label.
 */
function mountPresetLinkingGroup(presetsContainer) {
    if (!(presetsContainer instanceof HTMLElement)) return;
    // The Prompting content is still detached from the document here, so document.getElementById() finds nothing.
    const blocks = ['bind_preset_to_connection', 'bind_preset_to_sampling', 'model_sampling_profiles_enabled']
        .map(id => presetsContainer.querySelector(`#${id}`)?.closest('.sb-setting-inline-copy'))
        .filter(block => block instanceof HTMLElement);
    const drawer = blocks[0]?.closest('.inline-drawer');
    if (!(drawer instanceof HTMLElement)) return;
    const group = createBackendPromptGroup('sb-preset-linking', 'Preset API/Sampler Linking');
    group.firstElementChild.replaceWith(createBackendGroupHeader('Preset API/Sampler Linking'));
    group.querySelector(':scope > .sb-prompting-group-body').append(...blocks);
    // The flatten pass would turn the emptied drawer into a headed section inside Presets.
    drawer.remove();
    presetsContainer.after(group);
}

function groupPromptingRowHelpers(root) {
    for (const row of root.querySelectorAll('.sb-prompting-group-body .ds-row')) {
        if (row.parentElement.matches('.sb-prompting-row-with-help') || row.closest('#completion_prompt_manager')) continue;
        const helpers = [];
        for (let helper = row.nextElementSibling; helper?.matches('.toggle-description, .notes, p, small'); helper = helper.nextElementSibling) {
            helpers.push(helper);
        }
        if (helpers.length === 0) continue;
        const wrapper = createElement('div', { className: 'sb-prompting-row-with-help' });
        row.before(wrapper);
        wrapper.append(row, ...helpers);
    }
}

/**
 * Flattens drawers in every Backend and Customize panel, covering drawers authored after the split.
 */
function flattenRightShellSettingsDrawers() {
    const shellState = getShellState('right');
    if (!shellState) {
        return;
    }

    syncBackgroundSettingsSection();
    for (const [tabId, tabState] of shellState.tabs.entries()) {
        if (!SB_COLLAPSIBLE_DRAWER_TAB_IDS.has(tabId) && !isSubpagePanel(tabId) && !isAppearancePending(tabId) && tabState.panel instanceof HTMLElement) {
            flattenNestedSettingsDrawers(tabState.panel, { includeTopLevel: true });
            applySettingsSectionOrder(tabState.panel, tabId);
            normalizeSettingsPresentation(tabState.panel, { name: tabId });
        }
    }
}

/**
 * Drops the cached search index for every Customize tab. The split moves nodes between tabs, so
 * a cached index would keep pointing at detached content.
 */
function invalidateUserSettingsTabSearchIndexes() {
    const shellState = getShellState('right');
    if (!shellState) {
        return;
    }

    for (const tabState of shellState.tabs.values()) {
        tabState.searchIndex = null;
    }
}

/**
 * Every root that holds Customize settings content, in the order a user sees them.
 *
 * Each Customize tab has its own container, so the three containers are the live roots.
 * The legacy block is kept on the list last because it stays in the document and third-party
 * drawers still append into it; it has no settings left, so it contributes nothing in practice.
 *
 * The Data & Security container is here too. Its content is authored inside the settings block, so
 * the drawer expansion, search reveal and drawer persistence must still reach it after the split
 * moves it, so listing it keeps the moved drawer from going inert. It is
 * absent from the document until its panel is built, and the `instanceof` guard covers that.
 *
 * @returns {HTMLElement[]}
 */
function getUserSettingsContentRoots() {
    const roots = [];

    for (const tabId of ['appearance', 'interface', 'messages']) {
        const container = document.getElementById(SB_USER_SETTINGS_CONTAINER_IDS[tabId]);
        if (container instanceof HTMLElement) {
            roots.push(container);
        }
    }

    const dataSecurity = document.getElementById(SB_DATA_SECURITY_CONTAINER_ID);
    if (dataSecurity instanceof HTMLElement) {
        roots.push(dataSecurity);
    }

    const legacyBlock = document.getElementById('user-settings-block-content');
    if (legacyBlock instanceof HTMLElement) {
        roots.push(legacyBlock);
    }

    return roots;
}

function openAllInlineDrawers(root = null) {
    // Open every inline-drawer section so its content is visible.
    const roots = root instanceof HTMLElement ? [root] : getUserSettingsContentRoots();
    for (const current of roots) {
        current.querySelectorAll('.inline-drawer').forEach(drawer => {
            const toggle = drawer.querySelector(':scope > .inline-drawer-toggle');
            const drawerContent = drawer.querySelector(':scope > .inline-drawer-content');
            if (toggle && drawerContent) {
                toggle.setAttribute('aria-expanded', 'true');
                toggle.classList.add('openDrawer');
                drawerContent.style.display = '';
            }
        });
    }
}

/**
 * Re-runs the drawer flatten and the section order for a panel that may have been built after
 * the split.
 *
 * The split flattens and orders the markup it relocates, but some sections author their drawers
 * at runtime (OpenAI groups are built in `openai.js` once its panel is created,
 * and Advanced Formatting and the Appearance theme card are assembled after the split), so both
 * passes are repeated on activation. Both are idempotent, so re-running them costs queries and no
 * DOM churn.
 * Extensions and Connections are skipped for the same reason as in `flattenRightShellSettingsDrawers`, and
 * the stacked panels are skipped here for the reason given on `SB_SUBPAGE_TAB_IDS`.
 *
 * @param {string} shellKey
 * @param {string} tabId
 */
function flattenSettingsPanelDrawers(shellKey, tabId) {
    if (shellKey === 'right') syncBackgroundSettingsSection();
    if (SB_COLLAPSIBLE_DRAWER_TAB_IDS.has(tabId) || isSubpagePanel(tabId) || (shellKey === 'right' && isAppearancePending(tabId))) {
        return;
    }

    const panel = getShellState(shellKey)?.tabs.get(tabId)?.panel;
    if (tabId === 'prompting') {
        updatePromptingPanel(panel);
        return;
    }
    if (shellKey === 'left' && tabId === 'editor') {
        updateEditorPanel(panel);
        return;
    }
    if (panel instanceof HTMLElement) {
        flattenNestedSettingsDrawers(panel, { includeTopLevel: true });
        applySettingsSectionOrder(panel, tabId);
        normalizeSettingsPresentation(panel, { name: tabId });
    }
}

async function prepareShellSearch() {
    // Search also discovers controls in unopened panels, without starting their polling.
    await Promise.allSettled(Object.values(sbState.shells).flatMap(shell =>
        Array.from(shell.tabs.values(), tab => tab.ensureReady?.()),
    ));
}

const SB_STORAGE_KEYS = Object.freeze({
    leftTab: 'sb-left-tab',
    rightTab: 'sb-right-tab',
    surfaceTransparency: 'sb-surface-transparency',
    // The one stored list of label parts, read at every width. The name says desktop, but the list is read at every width.
    topbarLabelDesktopParts: 'sb-topbar-label-desktop-parts',
    // Read once, to seed the list above for a browser that stored only a phone value; nothing writes it.
    topbarLabelMobilePart: 'sb-topbar-label-mobile-part',
    topbarLabelCustomText: 'sb-topbar-label-custom-text',
    chatbarVisible: 'sb-chatbar-visible',
    topbarOffset: 'sb-topbar-offset',
    settingsDrawerStatePrefix: 'sb-settings-inline-drawer',
    shortcutLeft: 'sb-shortcut-left',
    shortcutRight: 'sb-shortcut-right',
    shortcutSlot3: 'sb-shortcut-slot3',
    shortcutSlot4: 'sb-shortcut-slot4',
    shortcutSlot5: 'sb-shortcut-slot5',
    shortcutSlot6: 'sb-shortcut-slot6',
    bottomBarScale: 'sb-bottom-bar-scale',
    bottomChatSecondaryOpen: 'sb-bottom-chat-secondary-open',
    desktopButtonScale: 'sb-desktop-button-scale',
    mobileButtonScale: 'sb-mobile-button-scale',
    settingsDrawerAutoClose: 'sb-settings-drawer-auto-close',
    compactMode: 'sb-compact-mode',
    // Legacy single-key form of `desktopTopbarIconsOnly`; kept as a read-only seed so a bar
    // configured before the split keeps its look.
    topbarIconsOnly: 'sb-topbar-icons-only',
    desktopTopbarIconsOnly: 'sb-desktop-topbar-icons-only',
    // Limit Content Width: `false` lifts the content columns of the settings page and the ceiling of the Window dialogs.
    desktopContentClamp: 'sb-desktop-content-clamp',

    bottomChatBarVisible: 'sb-bottom-chat-bar-visible',
    paperTextureEnabled: 'sb-paper-texture-enabled',
    paperTextureOpacity: 'sb-paper-texture-opacity',
});

// An older shell-tab rail wrote these transient presentation attributes to <html>, and they can
// remain after an upgrade without a full browser restart. Keep the retired storage keys untouched
// for older builds and extensions, but never let stale attributes suppress the top bar.
const SB_LEGACY_NAVIGATION_DATA_ATTRIBUTES = Object.freeze([
    'data-sb-mobile-nav-layout',
    'data-sb-mobile-nav-mode',
    'data-sb-mobile-nav-customize',
    'data-sb-mobile-nav-quick-actions',
    'data-sb-mobile-nav-replacement',
    'data-sb-desktop-nav-layout',
    'data-sb-desktop-nav-mode',
    'data-sb-desktop-nav-customize',
    'data-sb-desktop-nav-quick-actions',
    'data-sb-desktop-nav-replacement',
]);

const SB_SHORTCUT_TARGETS = Object.freeze([
    { value: 'left:connections', label: 'Connections', icon: 'fa-plug' },
    { value: 'left:sampling', label: 'Sampling', icon: 'fa-wave-square' },
    { value: 'left:prompting', label: 'Presets', icon: 'fa-sliders' },
    { value: 'left:editor', label: 'Editor', icon: 'fa-pen-to-square' },
    { value: 'left:context', label: 'Formatting', icon: 'fa-text-height' },
    { value: 'left:agents', label: 'Agents', icon: 'fa-robot' },
    { value: 'characters:world-info', label: 'World Info', icon: 'fa-book-atlas' },
    { value: 'action:search', label: 'Search', icon: 'fa-magnifying-glass' },
    { value: 'right:settings', label: 'Settings', icon: 'fa-screwdriver-wrench' },
    { value: 'right:extensions', label: 'Extensions', icon: 'fa-cubes' },
    { value: 'characters:persona', label: 'Persona', icon: 'fa-face-smile' },
    { value: 'right:background', label: 'Background', icon: 'fa-panorama' },
    { value: 'none', label: 'None', icon: 'fa-circle-minus' },
]);

const SB_SHORTCUT_DEFAULTS = Object.freeze({
    left: 'left:agents',
    right: 'right:extensions',
    slot3: 'none',
    slot4: 'none',
    slot5: 'none',
    slot6: 'none',
});
const SB_SHORTCUT_SLOTS = Object.freeze(['left', 'right', 'slot3', 'slot4', 'slot5', 'slot6']);
const SB_SHORTCUT_DESKTOP_SLOTS = Object.freeze(['slot3', 'slot4', 'slot5', 'slot6']);
const SB_SHORTCUT_STORAGE_KEYS = Object.freeze({
    left: SB_STORAGE_KEYS.shortcutLeft,
    right: SB_STORAGE_KEYS.shortcutRight,
    slot3: SB_STORAGE_KEYS.shortcutSlot3,
    slot4: SB_STORAGE_KEYS.shortcutSlot4,
    slot5: SB_STORAGE_KEYS.shortcutSlot5,
    slot6: SB_STORAGE_KEYS.shortcutSlot6,
});
const SB_SHORTCUT_LABELS = Object.freeze({
    left: 'Left',
    right: 'Right',
    slot3: 'Slot 3 (Desktop)',
    slot4: 'Slot 4 (Desktop)',
    slot5: 'Slot 5 (Desktop)',
    slot6: 'Slot 6 (Desktop)',
});
const SB_PANEL_STYLESHEETS = Object.freeze({
    'left:editor': [
        { href: 'css/sillybunny-editor-shell.css?v=20261118zzu', id: 'deferred-editor-shell-css' },
        { href: 'css/sillybunny-character-editor.css?v=20261123a', id: 'deferred-editor-chrome-css' },
        { href: 'css/sillybunny-entity-list.css?v=20261118zza', id: 'deferred-entity-list-css' },
        { href: 'css/sillybunny-prompt-editor.css?v=20261122j', id: 'deferred-prompt-editor-css' },
    ],
    // SillyBunny: Presets builds the Edit Prompts button row, which the editor shell sheet styles. NovelAI's Logit Bias entries are entity rows, which the entity list sheet styles.
    'left:prompting': [
        { href: 'css/sillybunny-editor-shell.css?v=20261118zzu', id: 'deferred-editor-shell-css' },
        { href: 'css/sillybunny-entity-list.css?v=20261118zza', id: 'deferred-entity-list-css' },
    ],
    'characters:world-info': [
        { href: 'css/world-info.css?v=20261120a', id: 'deferred-world-info-css' },
        // SillyBunny: the rebuilt World Info shell stays deferred like the Prompt Editor.
        { href: 'css/sillybunny-editor-shell.css?v=20261118zzu', id: 'deferred-editor-shell-css' },
        { href: 'css/sillybunny-character-editor.css?v=20261123a', id: 'deferred-editor-chrome-css' },
        { href: 'css/sillybunny-world-info-editor.css?v=20261122g', id: 'deferred-world-info-editor-css' },
    ],
    'characters:persona': [
        // SillyBunny: persona editor assets stay deferred like World Info
        { href: 'css/sillybunny-editor-shell.css?v=20261118zzu', id: 'deferred-editor-shell-css' },
        { href: 'css/sillybunny-character-editor.css?v=20261123a', id: 'deferred-editor-chrome-css' },
        { href: 'css/sillybunny-entity-list.css?v=20261118zza', id: 'deferred-entity-list-css' },
        { href: 'css/sillybunny-persona-editor.css?v=20261122g', id: 'deferred-persona-editor-css' },
        { href: 'css/sillybunny-persona-detail.css?v=20261118zv', id: 'deferred-persona-detail-css' },
    ],
    'characters:characters': [
        // SillyBunny: the shared list and its selection UI stay deferred until the mount gate resolves.
        { href: 'css/sillybunny-entity-list.css?v=20261118zza', id: 'deferred-entity-list-css' },
        { href: 'css/sillybunny-character-editor.css?v=20261123a', id: 'deferred-editor-chrome-css' },
        { href: 'css/sillybunny-character-list.css?v=20261122g', id: 'deferred-character-list-css' },
    ],
    'characters:groups': [
        // SillyBunny: Characters and Groups use the same deferred selection UI.
        { href: 'css/sillybunny-entity-list.css?v=20261118zza', id: 'deferred-entity-list-css' },
        { href: 'css/sillybunny-character-editor.css?v=20261123a', id: 'deferred-editor-chrome-css' },
        { href: 'css/sillybunny-character-list.css?v=20261122g', id: 'deferred-character-list-css' },
    ],
    'characters:import': [
        { href: 'css/sillybunny-editor-shell.css?v=20261118zzu', id: 'deferred-editor-shell-css' },
        { href: 'css/sillybunny-entity-list.css?v=20261118zza', id: 'deferred-entity-list-css' },
        { href: 'css/sillybunny-character-import.css?v=20261118zg', id: 'deferred-character-import-css' },
    ],
    'left:advanced-formatting': [
        { href: 'css/macros.css', id: 'deferred-macros-css' },
    ],
    // SillyBunny: the Extensions list builds button, entry and activatable rows, which the editor shell sheet styles. The Regex page lists its scripts as entity rows.
    'right:extensions': [
        { href: 'css/sillybunny-editor-shell.css?v=20261118zzu', id: 'deferred-editor-shell-css' },
        { href: 'css/sillybunny-entity-list.css?v=20261118zza', id: 'deferred-entity-list-css' },
        { href: 'css/extensions-panel.css?v=20261120b', id: 'deferred-extensions-panel-css' },
    ],
    // SillyBunny: Data & Security builds button, property and text-area rows, which the deferred editor shell sheet styles.
    'right:data-security': [
        { href: 'css/sillybunny-editor-shell.css?v=20261118zzu', id: 'deferred-editor-shell-css' },
    ],
    // SillyBunny: Appearance builds entry, text-area and button rows, which the same sheet styles.
    'right:appearance': [
        { href: 'css/sillybunny-editor-shell.css?v=20261118zzu', id: 'deferred-editor-shell-css' },
    ],
});
const SB_ACCOUNT_STORAGE_READY_MARKER = '__migrated';
/**
 * Drawers whose open state is written by their own code rather than by the generic persistence
 * scan, so the scan must not also write a key for them.
 *
 * OpenAI groups are not on this list: they are flattened, and a flattened section is not a
 * drawer because it has no toggle and no content wrapper, so there is no open state left for
 * either writer to persist.
 */
const SB_INLINE_DRAWER_CUSTOM_PERSISTENCE_SELECTOR = '[id$="prompt_manager_drawer"]';
const SB_STORAGE_PREFIX = 'sb-';
const SB_STORAGE_WRITE_DEBOUNCE_MS = 120;
const SB_MOBILE_ACTION_DEBOUNCE_MS = 140;

let sbInlineDrawerPersistenceObserver = null;
let sbInlineDrawerPersistenceQueued = false;
let sbChatScriptModulePromise = null;
let sbComposerControlsObserver = null;
let sbComposerControlsSyncQueued = false;
let sbStorageFlushTimer = 0;
let sbStorageFlushEventsBound = false;
let sbMessageActionEventsBound = false;
let sbPendingBottomChatScrollCancel = null;
let sbSearchShortcutPreFocusAt = 0;
const sbStorageCache = new Map();
const sbStoragePendingWrites = new Map();
const SB_EXTENSION_ALIASES = {
    'stable-diffusion': ['stable-diffusion', 'sd'],
    'sd': ['stable-diffusion', 'sd'],
};

function debounceAction(callback, wait = SB_MOBILE_ACTION_DEBOUNCE_MS) {
    let lastRun = 0;

    return function debouncedAction(event) {
        const now = performance.now();
        if (now - lastRun < wait) {
            event?.preventDefault?.();
            event?.stopPropagation?.();
            return;
        }

        lastRun = now;
        return callback.call(this, event);
    };
}

function getShortcutTarget(side) {
    const storageKey = SB_SHORTCUT_STORAGE_KEYS[side];
    const stored = migrateShortcutTarget(storageKey ? safeGetItem(storageKey) : null);
    const valid = SB_SHORTCUT_TARGETS.some(t => t.value === stored);
    return valid ? stored : SB_SHORTCUT_DEFAULTS[side] || 'none';
}

function migrateShortcutTarget(target) {
    const migrated = migrateLegacyWorldInfoRoute(target);
    if (typeof migrated !== 'string' || !migrated.startsWith('left:')) return migrated;
    return `left:${migrateTabId('left', migrated.slice(5))}`;
}

function getShortcutButtonId(side) {
    return `sb-shortcut-${side}`;
}

function getShortcutConfig(target) {
    return SB_SHORTCUT_TARGETS.find(t => t.value === target) || SB_SHORTCUT_TARGETS[0];
}

function migrateLegacyWorldInfoRoute(target) {
    // SillyBunny: migrate saved pre-relocation World Info shortcuts to the
    // Characters panel tab instead of reviving the old left-shell route.
    return target === 'left:world-info' ? 'characters:world-info' : target;
}

function migrateTabId(shellKey, tabId) {
    // Saved tab IDs from the older tab layout map onto the current tab IDs.
    const migrations = {
        left: {
            'presets': 'prompting',
            'api': 'connections',
            'advanced-formatting': 'context',
            // sampling and agents stay the same
        },
        right: {
            'settings': 'appearance',
            'background': 'appearance',
            'server': 'data-security',
            'console-logs': 'logs',
            // extensions stays the same
        },
    };

    const shellMigrations = migrations[shellKey];
    if (shellMigrations && shellMigrations[tabId]) {
        return shellMigrations[tabId];
    }

    return tabId;
}

function isSearchShortcutTarget(target) {
    return target === 'action:search';
}

function activateShortcutTarget(target) {
    if (isSearchShortcutTarget(target)) {
        const searchState = getUniversalSearchState();

        if (searchState.expanded) {
            if (performance.now() - sbSearchShortcutPreFocusAt < SB_MOBILE_ACTION_DEBOUNCE_MS * 2) {
                sbSearchShortcutPreFocusAt = 0;
                focusUniversalSearchInput(searchState.input);
                return;
            }

            setUniversalSearchOpenState(false);

            if (searchState.input instanceof HTMLInputElement && document.activeElement === searchState.input) {
                searchState.input.blur();
            }

            return;
        }

        closeAllDropdowns({ except: 'search' });
        setUniversalSearchOpenState(true, { focusInput: true });
        return;
    }

    const [shell, tab] = String(target).split(':');

    // SillyBunny: toggleShellPanel routes every shell through the settings page
    if (shell === 'characters') {
        preloadPanelStylesheets('characters', tab);
        toggleShellPanel(shell, tab || null);
        return;
    }

    if (shell && tab) {
        toggleShellPanel(shell, tab);
    }
}

function isSillyBunnyStorageKey(key) {
    return typeof key === 'string' && key.startsWith(SB_STORAGE_PREFIX);
}

function scheduleSbStorageFlush() {
    if (sbStorageFlushTimer) {
        return;
    }

    sbStorageFlushTimer = window.setTimeout(flushSbStorageWrites, SB_STORAGE_WRITE_DEBOUNCE_MS);
}

function flushSbStorageWrites() {
    if (sbStorageFlushTimer) {
        window.clearTimeout(sbStorageFlushTimer);
        sbStorageFlushTimer = 0;
    }

    if (!sbStoragePendingWrites.size) {
        return;
    }

    const pendingWrites = Array.from(sbStoragePendingWrites.entries());

    for (const [key, write] of pendingWrites) {
        try {
            if (write?.remove) {
                localStorage.removeItem(key);
            } else {
                localStorage.setItem(key, write.value);
            }
            sbStoragePendingWrites.delete(key);
        } catch {
            // Retry on the next flush or page hide if browser storage becomes writable again.
        }
    }
}

function bindSbStorageFlushEvents() {
    if (sbStorageFlushEventsBound || typeof window === 'undefined') {
        return;
    }

    window.addEventListener('pagehide', flushSbStorageWrites);
    window.addEventListener('beforeunload', flushSbStorageWrites);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            flushSbStorageWrites();
        }
    });
    sbStorageFlushEventsBound = true;
}

function safeGetItem(key) {
    if (!isSillyBunnyStorageKey(key)) {
        try { return localStorage.getItem(key); } catch { return null; }
    }

    if (sbStorageCache.has(key)) {
        return sbStorageCache.get(key);
    }

    try {
        const value = localStorage.getItem(key);
        sbStorageCache.set(key, value);
        return value;
    } catch {
        return null;
    }
}

function safeSetItem(key, value) {
    if (!isSillyBunnyStorageKey(key)) {
        try { localStorage.setItem(key, value); } catch {
            // Ignore storage write failures.
        }
        return;
    }

    const stringValue = String(value);
    sbStorageCache.set(key, stringValue);
    sbStoragePendingWrites.set(key, { value: stringValue, remove: false });
    scheduleSbStorageFlush();
}

bindSbStorageFlushEvents();

const SB_IDLE_BRAND_LABEL = 'SillyBunny';
const SB_MOBILE_MEDIA_QUERY = LAYOUT_MOBILE_QUERY;
const SB_SURFACE_TRANSPARENCY = Object.freeze({
    min: 0,
    max: 100,
    step: 5,
    defaultValue: 0,
});
const SB_TOPBAR_SCALE = Object.freeze({
    min: 70,
    max: 150,
    step: 5,
    defaultValue: 100,
});
const SB_PAPER_TEXTURE_OPACITY = Object.freeze({
    min: 0,
    max: 100,
    step: 5,
    defaultValue: 20,
});
const SB_TOPBAR_LABEL_PARTS = Object.freeze([
    {
        id: 'ctx',
        label: 'Context Size',
        description: 'Show the current total Tokens value from the Prompt page',
    },
    {
        id: 'char',
        label: 'Character Name',
        description: 'Show the active character name, or the group name while a group chat is open',
    },
    {
        id: 'custom',
        label: 'Custom Text',
        description: 'Show your own short label in the center of the top bar',
    },
]);
const SB_TOPBAR_LABEL_PART_ORDER = Object.freeze(SB_TOPBAR_LABEL_PARTS.map(part => part.id));
const SB_TOPBAR_LABEL_PART_IDS = new Set(SB_TOPBAR_LABEL_PART_ORDER);
const SB_TOPBAR_LABEL_CUSTOM_TEXT_MAX_LENGTH = 48;
const SB_TOPBAR_DRAG_X_RATIO = 0.36;
const SB_TOPBAR_DRAG_Y_RATIO = 0.24;
const SB_TOPBAR_CONTEXT_REFRESH_DEBOUNCE = 220;
const SB_CHATBAR_SEARCH_DEBOUNCE = 220;
const SB_CHAT_SEARCH_MARK_SELECTOR = 'mark[data-sb-chat-search="true"]';
const SB_INIT_RETRY_DELAY_MS = 150;
const SB_INIT_MAX_RETRIES = 30;

// The libadwaita shell has no Shell Style picker, so legacy sb-theme values are ignored.
const SB_SHELL_THEME = 'clean-minimal';

const SB_MESSAGE_STYLES = Object.freeze([
    { id: '0', label: 'Flat', icon: 'fa-grip-lines' },
    { id: '1', label: 'Bubbles', icon: 'fa-comment-dots' },
    { id: '2', label: 'Document', icon: 'fa-file-lines' },
]);

const SB_SAMPLING_SUBTITLE_HTML = 'Modify model text parameters here - useful for dialing in responses! If you\'re unsure what these all mean, check out <a class="notes-link" href="https://rentry.org/samplersettings" target="_blank" rel="noopener noreferrer">Geechan\'s guide on sampling.</a>';

const SB_WORLD_INFO_SUBTITLE_HTML = 'Advanced: Modify lorebooks for character cards here. For more information, read the guide found <a class="notes-link" href="https://docs.sillytavern.app/usage/core-concepts/worldinfo/" target="_blank" rel="noopener noreferrer">here</a>.';

// `pageWidth: 'wide'` puts a page in the wide column of the settings page (a list, an editor or a grid); a page with none is a preference page.
const SB_CHARACTER_PANEL_TABS = Object.freeze([
    {
        id: 'characters',
        label: 'Characters',
        icon: 'fa-address-book',
        tooltip: 'Open and Manage Character Cards',
        description: 'View or create character cards here for your roleplays and chats!',
        searchAliases: ['character card', 'character list', 'avatars', 'cards'],
        pageWidth: 'wide',
    },
    {
        id: 'groups',
        label: 'Groups',
        icon: 'fa-users',
        tooltip: 'Open and Manage Group Conversations',
        description: 'View or create group chats here for your roleplays and chats!',
        searchAliases: ['group chat', 'group chats', 'group members', 'muting'],
        pageWidth: 'wide',
    },
    {
        id: 'editor',
        label: 'Editor',
        icon: 'fa-pen-to-square',
        tooltip: 'Edit Character Cards and Groups',
        description: 'Edit your character cards or group chats in great detail here!',
        searchAliases: ['character editor', 'group editor', 'edit card', 'first message', 'greetings'],
        pageWidth: 'wide',
    },
    {
        id: 'world-info',
        label: 'World Info',
        icon: 'fa-book-atlas',
        tooltip: 'Manage Lorebooks and World Information',
        description: SB_WORLD_INFO_SUBTITLE_HTML,
        descriptionIsHtml: true,
        searchAliases: ['lorebook', 'lorebooks', 'world info book', 'world', 'entries'],
        pageWidth: 'wide',
    },
    {
        id: 'persona',
        label: 'Persona',
        icon: 'fa-face-smile',
        tooltip: 'Manage User Persona/Personality',
        description: 'Edit your own persona here for roleplay and chats!',
        searchAliases: ['personas', 'persona description', 'impersonate'],
        pageWidth: 'wide',
    },
    {
        id: 'import',
        label: 'Import',
        icon: 'fa-file-import',
        tooltip: 'Add or Import New Character Cards',
        description: 'Directly import character cards here from various sources',
        searchAliases: ['import character', 'import card', 'chub', 'png', 'add character'],
    },
]);
const SB_CHARACTER_PANEL_DEFAULT_TAB = 'characters';


const SB_SHELLS = Object.freeze({
    left: {
        rootPanelId: 'left-nav-panel',
        hostDrawerId: 'ai-config-button',
        hostToggleSelector: '#ai-config-button > .drawer-toggle',
        hostIconSelector: '#leftNavDrawerIcon',
        proxyButtonId: 'sb-left-shell-toggle',
        proxyIcon: 'fa-bars',
        proxyLabel: 'Backend',
        title: 'Backend',
        subtitle: '', // Removed redundant workspace subtext (PR #145 expansion)
        searchPlaceholder: 'Find connections, prompts, samplers, or agents…',
        storageKey: SB_STORAGE_KEYS.leftTab,
        defaultTabId: 'connections',
        baseTab: {
            id: 'connections',
            label: 'Connections',
            icon: 'fa-plug',
            tooltip: 'Modify the API connection to the model backend',
            description: 'Configure the model backend for all AI character responses. We recommend OpenRouter if you\'re unsure.',
            searchAliases: ['API Response Configuration', 'AI Response Configuration', 'Response Config', 'Chat Completion', 'Text Completion', 'API key'],
        },
        embeddedTabs: [],
        customTabs: [
            {
                id: 'sampling',
                label: 'Sampling',
                icon: 'fa-wave-square',
                tooltip: 'Adjust Model Samplers and Parameters',
                description: SB_SAMPLING_SUBTITLE_HTML,
                descriptionIsHtml: true,
                searchPlaceholder: 'Search temperature, top p, repetition penalty, or backend samplers',
                searchExamples: ['temperature', 'top p', 'repetition penalty'],
            },
            {
                id: 'prompting',
                label: 'Presets',
                icon: 'fa-sliders',
                tooltip: 'Change, update, or edit presets and prompts',
                description: 'Manage presets, templates, and generation settings',
                descriptionI18n: 'Manage presets, templates, and generation settings.',
                searchPlaceholder: 'Search presets, instruct mode, markdown, or decorators',
                searchExamples: ['presets', 'instruct', 'markdown', 'decorators'],
                searchAliases: ['Prompting', 'Presets', 'Update Preset', 'Save Preset As', 'Rename Preset', 'Import Preset', 'Export Preset', 'Delete Preset', 'reasoning'],
            },
            {
                id: 'editor',
                label: 'Editor',
                icon: 'fa-pen-to-square',
                tooltip: 'Edit prompt content, order, and placement',
                description: 'Edit prompt content, order, and placement',
                descriptionI18n: 'Edit prompt content, order, and placement',
                searchAliases: ['Prompt Manager', 'Prompts'],
                pageWidth: 'wide',
            },
            {
                id: 'context',
                label: 'Formatting',
                icon: 'fa-text-height',
                tooltip: 'Set miscellaneous formatting settings for the model backend',
                description: 'Adjust token counting, stopping strings, text cleanup, and reasoning display',
                descriptionI18n: 'Adjust token counting, stopping strings, text cleanup, and reasoning display.',
                searchPlaceholder: 'Search formatting, context templates, regex, or text replacements',
                searchExamples: ['formatting', 'context', 'advanced formatting', 'regex', 'replacement'],
                searchAliases: ['Context', 'Advanced Formatting', 'reasoning'],
            },
            {
                id: 'agents',
                label: 'Agents',
                icon: 'fa-robot',
                tooltip: 'Interact with accompanying pre, post, and sidecar agents',
                description: 'Configure your in-chat agents here. They can be configured for pre-gen, post-gen, or as a side companion.',
                pageWidth: 'wide',
            },
        ],
    },
    right: {
        rootPanelId: 'user-settings-block',
        hostDrawerId: 'user-settings-button',
        hostToggleSelector: '#user-settings-button > .drawer-toggle',
        hostIconSelector: '#user-settings-button > .drawer-toggle .drawer-icon',
        proxyButtonId: 'sb-right-shell-toggle',
        proxyIcon: 'fa-gear',
        proxyLabel: 'Customize',
        title: 'Customize',
        subtitle: 'Personalize your workspace, add/remove extensions, modify server settings, or check logs here',
        searchPlaceholder: 'Search themes, interface, messages, or extensions',
        searchExamples: ['theme', 'top bar', 'messages', 'extensions'],
        storageKey: SB_STORAGE_KEYS.rightTab,
        defaultTabId: 'appearance',
        baseTab: {
            id: 'appearance',
            label: 'Appearance',
            icon: 'fa-palette',
            tooltip: 'Change or modify the appearance of the SillyBunny graphical shell',
            description: 'Customize SillyBunny\'s visual appearance, themes, backgrounds, and UI scale',
            searchPlaceholder: 'Search themes, backgrounds, blur, or UI scale',
            searchExamples: ['theme', 'background', 'blur', 'scale'],
            searchAliases: ['colors', 'colours', 'wallpaper', 'fonts', 'UI scale'],
        },
        embeddedTabs: [
            {
                id: 'extensions',
                drawerId: 'extensions-settings-button',
                label: 'Extensions',
                icon: 'fa-cubes',
                tooltip: 'Manage and View All Installed Extensions',
                description: 'Install, manage, and configure SillyTavern extensions here. Backwards compatibility isn\'t guaranteed, but should be applicable.',
                searchPlaceholder: 'Search themes, Quick Reply, Dialogue Colors, or Image Gen',
                searchExamples: ['themes', 'Quick Reply', 'Dialogue Colors', 'Image Gen'],
                searchAliases: ['addons', 'plugins', 'install extension', 'third party'],
            },
        ],
        customTabs: [
            {
                id: 'interface',
                label: 'Interface',
                icon: 'fa-screwdriver-wrench',
                tooltip: 'Toggle UI Settings',
                description: 'Configure interface behavior, power user features, and UI preferences',
                searchPlaceholder: 'Search top bar, auto-scroll, power user, or chat features',
                searchExamples: ['top bar', 'auto-scroll', 'power user'],
                searchAliases: ['UI', 'behavior', 'stscript'],
            },
            {
                id: 'messages',
                label: 'Messages',
                icon: 'fa-message',
                tooltip: 'View All Chat-Related Settings and Configuration',
                description: 'Configure message display, actions, swipes, and interaction preferences',
                searchPlaceholder: 'Search message actions, swipes, auto-scroll, or display',
                searchExamples: ['swipes', 'message actions', 'auto-scroll'],
                searchAliases: ['chat'],
            },
            {
                id: 'data-security',
                label: 'Data & Security',
                icon: 'fa-server',
                tooltip: 'View SillyBunny\'s Server Configuration and Backend',
                description: 'Manage the SillyBunny backend and server settings here',
                searchPlaceholder: 'Search backup, data path, security, or config.yaml',
                searchExamples: ['backup', 'data path', 'security'],
                searchAliases: ['backup', 'restore', 'data path'],
            },
            {
                id: 'logs',
                label: 'Logs',
                icon: 'fa-terminal',
                tooltip: 'View and Gather SillyBunny\'s Backend Logs',
                description: 'View SillyBunny logs for advanced troubleshooting or bug reporting',
                searchPlaceholder: 'Search error, warning, npm, bun, or extension logs',
                searchExamples: ['error', 'warning', 'npm', 'bun'],
                searchAliases: ['console', 'console logs', 'errors', 'troubleshooting'],
            },
        ],
    },
});

const SB_DRAWER_ROUTES = Object.freeze({
    'user-settings-button': { shell: 'right', tab: 'appearance' },
    'sys-settings-button': { shell: 'left', tab: 'connections' },
    'advanced-formatting-button': { shell: 'left', tab: 'context' },
    'WI-SP-button': { shell: 'characters', tab: 'world-info' },
    'extensions-settings-button': { shell: 'right', tab: 'extensions' },
    'persona-management-button': { shell: 'characters', tab: 'persona' },
    'backgrounds-button': { shell: 'right', tab: 'appearance' },
});

const SB_SEARCH_TARGET_SELECTOR = [
    '.ds-row-label',
    '.ds-row-subtitle',
    'label',
    '.checkbox_label',
    '.menu_button',
    '.inline-drawer-toggle',
    `.${SB_FLAT_SECTION_HEADER_CLASS}`,
    '.standoutHeader',
    '.range-block-title',
    '.range-block-header',
    '.extension_name',
    'h3',
    'h4',
    'h5',
    'strong',
    '.bg-header-row-1',
    '.bg-header-row-2',
    '.ch_name',
].join(', ');

/**
 * Subset of `SB_SEARCH_TARGET_SELECTOR` that reads as a section name rather than a control.
 *
 * The sidebar treats a hit here as specific enough to reveal a tab, because the tab's name is
 * unlikely to be on screen while the section it holds is discoverable. Everything else the index
 * collects (individual checkboxes, selects, buttons) is a leaf control whose match says very
 * little about the tab, so it is left to the universal search panel, which is built for browsing.
 */
const SB_SIDEBAR_SECTION_MATCH_SELECTOR = [
    'h3',
    'h4',
    'h5',
    '.standoutHeader',
    '.range-block-title',
    '.range-block-header',
    '.extension_name',
    '.inline-drawer-toggle',
    `.${SB_FLAT_SECTION_HEADER_CLASS}`,
    '.ch_name',
].join(', ');

const SB_UNIVERSAL_SEARCH_PLACEHOLDER = 'Type to search…';
// The accessible name is a title (header capitalisation) while the placeholder is hint text (sentence capitalisation).
const SB_UNIVERSAL_SEARCH_LABEL = 'Type to Search…';
const SB_UNIVERSAL_SEARCH_IDLE_TITLE = 'Search All Settings';
const SB_UNIVERSAL_SEARCH_IDLE_HINT = 'Jump to any workspace or customization control from one place.';
const SB_UNIVERSAL_SEARCH_EMPTY_HINT = 'Could not find query. Try a broader term or a different setting name.';
// The panel shows a short list and reveals the rest on request, so the ceiling belongs to the
// rendered page rather than the match set: `collectGlobalSearchMatches` collects everything and
// `renderUniversalSearchResults` decides how much of it to paint.
const SB_UNIVERSAL_SEARCH_RESULT_LIMIT = 24;
const SB_UNIVERSAL_SEARCH_GROUP_LIMIT = 5;
const SB_UNIVERSAL_SEARCH_DEBOUNCE_MS = 140;
// Entity results read names from data: a few thousand characters and worlds stay cheap, but the
// index is rebuilt per keystroke, so entry bodies are only scanned for the worlds that matched.
const SB_UNIVERSAL_ENTITY_SCAN_LIMIT = 4000;
const SB_MOBILE_VIEWPORT_RESET_FOLLOWUP_MS = 350;
// SillyBunny: the three section buttons of the top bar and the shell each one opens as a settings page.
const SB_TOPBAR_SECTIONS = Object.freeze([
    { key: 'workspace', leadId: 'sb-left-shell-toggle', shellKey: 'left' },
    { key: 'customize', leadId: 'sb-right-shell-toggle', shellKey: 'right' },
    { key: 'characters', leadId: 'sb-character-toggle', shellKey: 'characters' },
]);

// SillyBunny: the one child order of the bar's two groups, in the labelled and the icons-only
// form alike and on phones. Labels, widths and the overflow menu change what shows, never the
// order. The groups sit either side of the centred title.
const SB_TOPBAR_GROUP_ORDER = Object.freeze({
    left: Object.freeze([
        'sb-left-shell-toggle',
        'sb-right-shell-toggle',
        'sb-topbar-divider-search-mobile',
        'sb-topbar-search-toggle',
        'sb-topbar-divider-quick-left',
        'sb-shortcut-left',
        'sb-shortcut-slot3',
        'sb-shortcut-slot4',
    ]),
    right: Object.freeze([
        TOPBAR_EXTENSION_SLOT_ID,
        'sb-shortcut-slot6',
        'sb-shortcut-slot5',
        'sb-shortcut-right',
        'sb-topbar-overflow-toggle',
        'sb-topbar-divider-quick-right',
        'sb-mode-toggle',
        'sb-topbar-divider-mode-mobile',
        'sb-home-toggle',
        'sb-character-toggle',
    ]),
});

// The title shows only while at least this much of it (or all of it, when it is shorter) fits.
const SB_TOPBAR_BRAND_MIN_WIDTH = 60;

// The desktop key wins; the legacy single key seeds it so a bar configured before the split keeps its look.
function readTopbarIconsOnlySetting(storageKey) {
    return normalizeStoredBoolean(
        safeGetItem(storageKey),
        normalizeStoredBoolean(safeGetItem(SB_STORAGE_KEYS.topbarIconsOnly), false),
    );
}

const sbState = {
    initialized: false,
    initRetryTimer: 0,
    initRetryCount: 0,
    initObserver: null,
    inlineDrawerAutoClose: normalizeStoredBoolean(safeGetItem(SB_STORAGE_KEYS.settingsDrawerAutoClose), false),
    theme: SB_SHELL_THEME,
    surfaceTransparency: normalizeSurfaceTransparency(safeGetItem(SB_STORAGE_KEYS.surfaceTransparency)),
    paperTextureEnabled: normalizeStoredBoolean(safeGetItem(SB_STORAGE_KEYS.paperTextureEnabled), false),
    paperTextureOpacity: normalizePaperTextureOpacity(safeGetItem(SB_STORAGE_KEYS.paperTextureOpacity)),
    compactMode: normalizeStoredBoolean(safeGetItem(SB_STORAGE_KEYS.compactMode), false),
    contentClamp: normalizeStoredBoolean(safeGetItem(SB_STORAGE_KEYS.desktopContentClamp), true),
    topbarIconsOnly: {
        desktop: readTopbarIconsOnlySetting(SB_STORAGE_KEYS.desktopTopbarIconsOnly),
    },
    topbarSections: {
        syncFrame: 0,
    },
    topbarFit: {
        frame: 0,
        observer: null,
    },
    topbarExtensions: {
        syncFrame: 0,
        adopting: false,
        observer: null,
    },
    bottomBarScale: normalizeTopbarScale(safeGetItem(SB_STORAGE_KEYS.bottomBarScale)),
    desktopButtonScale: normalizeTopbarScale(safeGetItem(SB_STORAGE_KEYS.desktopButtonScale)),
    mobileButtonScale: normalizeTopbarScale(safeGetItem(SB_STORAGE_KEYS.mobileButtonScale)),
    topbarLabel: {
        desktopParts: readTopbarLabelParts(),
        customText: normalizeTopbarCustomText(safeGetItem(SB_STORAGE_KEYS.topbarLabelCustomText)),
        contextTokens: null,
        refreshTimer: 0,
        refreshInFlight: false,
        refreshPending: false,
        refreshToken: 0,
        bindingRetryTimer: 0,
        boundEventSource: null,
        windowBindingsAttached: false,
    },
    shells: {},
    universalSearch: {
        row: null,
        root: null,
        input: null,
        results: null,
        expanded: false,
        dismissBound: false,
        activeIndex: -1,
        renderTimer: 0,
        renderedQuery: '',
        renderedRows: null,
        expandedAll: false,
        entityPrimeStarted: false,
        skippedWorlds: null,
    },
    characterDrawer: {
        stateObserver: null,
        observedOpen: null,
        lastTab: 'characters',
        closing: false,
    },
    mobileModal: {
        syncFrame: 0,
    },
    chatbar: {
        sidebar: null,
        visible: normalizeStoredBoolean(safeGetItem(SB_STORAGE_KEYS.chatbarVisible), true),
        searchQuery: '',
        searchTimer: 0,
        searchApplyToken: 0,
        refreshTimer: 0,
        refreshToken: 0,
        pendingSearchScroll: false,
        isApplyingSearch: false,
        chatObserver: null,
        sidebarOpen: false,
        bindingRetryTimer: 0,
        boundEventSource: null,
        windowBindingsAttached: false,
        topbarOffset: normalizeTopbarOffset(safeGetItem(SB_STORAGE_KEYS.topbarOffset)),
        renderedTopbarOffset: { x: 0, y: 0 },
        dragging: null,
        dragListenersBound: false,
        chatbarToggleButton: null,
        dragHandleButton: null,
    },
    chatAvatars: {
        observer: null,
        debounceTimer: 0,
        retryTimer: 0,
        sourceCache: new WeakMap(),
    },
    bottomChatBar: {
        chatSelect: null,
        personaBubble: null,
        searchField: null,
        searchInput: null,
        searchStatus: null,
        searchToggleButton: null,
        collapseToggleButton: null,
        secondaryRow: null,
        scrollTopButton: null,
        scrollBottomButton: null,
        managerButton: null,
        massDeleteButton: null,
        autoNameButton: null,
        secondaryOpen: normalizeStoredBoolean(safeGetItem(SB_STORAGE_KEYS.bottomChatSecondaryOpen), true),
        visible: normalizeStoredBoolean(safeGetItem(SB_STORAGE_KEYS.bottomChatBarVisible), true),
        searchOpen: false,
        bindingRetryTimer: 0,
        boundEventSource: null,
        windowBindingsAttached: false,
        outsideClickBound: false,
    },
    importer: {
        refs: null,
        busy: false,
        report: null,
    },
};

// The attribute is written when the module loads, before the shell exists, so a Window or a settings page that opens first is already laid out the user's way.
applyContentClampPreference();
// SillyBunny: the scrollbars of the browser can change while the page is open (a mouse that is plugged in), so a window that is focused again measures them once more.
syncClassicScrollbars();
window.addEventListener('focus', () => syncClassicScrollbars(), { passive: true });

function normalizeTopbarLabelPart(value, fallback = '') {
    const fallbackValue = SB_TOPBAR_LABEL_PART_IDS.has(fallback) ? fallback : '';
    const normalizedValue = normalizeText(value);
    return SB_TOPBAR_LABEL_PART_IDS.has(normalizedValue) ? normalizedValue : fallbackValue;
}

function normalizeTopbarLabelParts(value, fallback = []) {
    let source = value;

    if (typeof source === 'string') {
        const trimmedValue = source.trim();
        if (!trimmedValue) {
            source = [];
        } else {
            try {
                source = JSON.parse(trimmedValue);
            } catch {
                source = trimmedValue.split(',');
            }
        }
    }

    const rawParts = Array.isArray(source) ? source : [source];
    const normalizedParts = SB_TOPBAR_LABEL_PART_ORDER.filter(
        partId => rawParts.some(candidate => normalizeTopbarLabelPart(candidate) === partId),
    );
    const fallbackParts = Array.isArray(fallback)
        ? SB_TOPBAR_LABEL_PART_ORDER.filter(partId => fallback.includes(partId))
        : [];

    return normalizedParts.length ? normalizedParts : fallbackParts;
}

/**
 * The stored list of label parts. A browser that has no list but stored a phone value gets a list of that one part, and an
 * empty phone value gives an empty list, which shows the default label.
 * @returns {string[]}
 */
function readTopbarLabelParts() {
    if (safeGetItem(SB_STORAGE_KEYS.topbarLabelDesktopParts) !== null) {
        return normalizeTopbarLabelParts(safeGetItem(SB_STORAGE_KEYS.topbarLabelDesktopParts), []);
    }

    const phonePart = safeGetItem(SB_STORAGE_KEYS.topbarLabelMobilePart);
    if (phonePart === null) {
        return ['char'];
    }

    const part = normalizeTopbarLabelPart(phonePart, '');
    return part ? [part] : [];
}

/** Writes the list that `readTopbarLabelParts` derived from a phone value, so that the phone key is not read again. */
function seedTopbarLabelParts() {
    if (safeGetItem(SB_STORAGE_KEYS.topbarLabelDesktopParts) !== null || safeGetItem(SB_STORAGE_KEYS.topbarLabelMobilePart) === null) {
        return;
    }

    safeSetItem(SB_STORAGE_KEYS.topbarLabelDesktopParts, JSON.stringify(readTopbarLabelParts()));
    flushSbStorageWrites();
}

function normalizeTopbarCustomText(value) {
    const normalizedValue = String(value ?? '').replace(/\s+/g, ' ').trim();
    return normalizedValue.slice(0, SB_TOPBAR_LABEL_CUSTOM_TEXT_MAX_LENGTH).trim();
}

function normalizeStoredBoolean(value, fallback = false) {
    if (value === null || value === undefined) {
        return fallback;
    }

    if (typeof value === 'boolean') {
        return value;
    }

    const normalizedValue = String(value).trim().toLowerCase();

    if (['true', '1', 'yes', 'on'].includes(normalizedValue)) {
        return true;
    }

    if (['false', '0', 'no', 'off'].includes(normalizedValue)) {
        return false;
    }

    return fallback;
}

function normalizeSurfaceTransparency(value) {
    const numericValue = Number(value);

    if (!Number.isFinite(numericValue)) {
        return SB_SURFACE_TRANSPARENCY.defaultValue;
    }

    const snappedValue = Math.round(numericValue / SB_SURFACE_TRANSPARENCY.step) * SB_SURFACE_TRANSPARENCY.step;
    return Math.min(SB_SURFACE_TRANSPARENCY.max, Math.max(SB_SURFACE_TRANSPARENCY.min, snappedValue));
}

function formatSurfaceTransparency(value) {
    return `${normalizeSurfaceTransparency(value)}%`;
}

function normalizePaperTextureOpacity(value) {
    const numericValue = Number(value);

    if (!Number.isFinite(numericValue)) {
        return SB_PAPER_TEXTURE_OPACITY.defaultValue;
    }

    const snappedValue = Math.round(numericValue / SB_PAPER_TEXTURE_OPACITY.step) * SB_PAPER_TEXTURE_OPACITY.step;
    return Math.min(SB_PAPER_TEXTURE_OPACITY.max, Math.max(SB_PAPER_TEXTURE_OPACITY.min, snappedValue));
}

function formatPaperTextureOpacity(value) {
    return `${normalizePaperTextureOpacity(value)}%`;
}

function clampNumber(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function normalizeTopbarOffset(value) {
    let source = value;

    if (typeof source === 'string' && source.trim()) {
        try {
            source = JSON.parse(source);
        } catch {
            source = null;
        }
    }

    const x = Number(source?.x);
    const y = Number(source?.y);

    return {
        x: Number.isFinite(x) ? Math.round(x) : 0,
        y: Number.isFinite(y) ? Math.round(y) : 0,
    };
}

function normalizeTopbarScale(value) {
    if (value === null || value === undefined || value === '') {
        return SB_TOPBAR_SCALE.defaultValue;
    }

    const numericValue = Number(value);

    if (!Number.isFinite(numericValue)) {
        return SB_TOPBAR_SCALE.defaultValue;
    }

    const snappedValue = Math.round(numericValue / SB_TOPBAR_SCALE.step) * SB_TOPBAR_SCALE.step;
    return Math.min(SB_TOPBAR_SCALE.max, Math.max(SB_TOPBAR_SCALE.min, snappedValue));
}

function formatTopbarScale(value) {
    return `${normalizeTopbarScale(value)}%`;
}

function seedTopbarScaleDefaults() {
    if (safeGetItem(SB_STORAGE_KEYS.bottomBarScale) === null) {
        safeSetItem(SB_STORAGE_KEYS.bottomBarScale, String(SB_TOPBAR_SCALE.defaultValue));
    }

    if (safeGetItem(SB_STORAGE_KEYS.desktopButtonScale) === null) {
        safeSetItem(SB_STORAGE_KEYS.desktopButtonScale, String(SB_TOPBAR_SCALE.defaultValue));
    }

    if (safeGetItem(SB_STORAGE_KEYS.mobileButtonScale) === null) {
        safeSetItem(SB_STORAGE_KEYS.mobileButtonScale, String(SB_TOPBAR_SCALE.defaultValue));
    }
}

function restorePersistedTopbarState() {
    sbState.bottomBarScale = normalizeTopbarScale(safeGetItem(SB_STORAGE_KEYS.bottomBarScale));
    sbState.desktopButtonScale = normalizeTopbarScale(safeGetItem(SB_STORAGE_KEYS.desktopButtonScale));
    sbState.mobileButtonScale = normalizeTopbarScale(safeGetItem(SB_STORAGE_KEYS.mobileButtonScale));
    sbState.topbarLabel.desktopParts = readTopbarLabelParts();
    sbState.topbarLabel.customText = normalizeTopbarCustomText(safeGetItem(SB_STORAGE_KEYS.topbarLabelCustomText));
    sbState.chatbar.visible = normalizeStoredBoolean(safeGetItem(SB_STORAGE_KEYS.chatbarVisible), sbState.chatbar.visible);
    sbState.chatbar.topbarOffset = normalizeTopbarOffset(safeGetItem(SB_STORAGE_KEYS.topbarOffset));
    sbState.compactMode = normalizeStoredBoolean(safeGetItem(SB_STORAGE_KEYS.compactMode), sbState.compactMode);
    sbState.contentClamp = normalizeStoredBoolean(safeGetItem(SB_STORAGE_KEYS.desktopContentClamp), sbState.contentClamp);
    sbState.topbarIconsOnly.desktop = normalizeStoredBoolean(safeGetItem(SB_STORAGE_KEYS.desktopTopbarIconsOnly), sbState.topbarIconsOnly.desktop);
    sbState.bottomChatBar.visible = normalizeStoredBoolean(safeGetItem(SB_STORAGE_KEYS.bottomChatBarVisible), sbState.bottomChatBar.visible);
}

function migrateLegacyNavigationState() {
    const root = document.documentElement;
    for (const attribute of SB_LEGACY_NAVIGATION_DATA_ATTRIBUTES) {
        root.removeAttribute(attribute);
    }
}

function clampTopbarOffset(offset) {
    const maxX = Math.max(0, Math.round(window.innerWidth * SB_TOPBAR_DRAG_X_RATIO));
    const maxY = Math.max(0, Math.round(window.innerHeight * SB_TOPBAR_DRAG_Y_RATIO));
    const normalizedOffset = normalizeTopbarOffset(offset);

    return {
        x: clampNumber(normalizedOffset.x, -maxX, maxX),
        y: clampNumber(normalizedOffset.y, 0, maxY),
    };
}

function getRenderedTopbarOffset() {
    return clampTopbarOffset(getChatbarState().topbarOffset);
}

function applyTopbarOffset() {
    getChatbarState().renderedTopbarOffset = getRenderedTopbarOffset();
}

function setTopbarOffset(offset, { persist = true } = {}) {
    const nextOffset = normalizeTopbarOffset(offset);
    getChatbarState().topbarOffset = nextOffset;

    if (persist) {
        safeSetItem(SB_STORAGE_KEYS.topbarOffset, JSON.stringify(nextOffset));
    }

    applyTopbarOffset();
}

function setBottomBarScale(value, { persist = true } = {}) {
    const nextScale = normalizeTopbarScale(value);
    const scaleFactor = Number((nextScale / 100).toFixed(2)).toString();

    sbState.bottomBarScale = nextScale;
    document.documentElement.style.setProperty('--sb-bottom-bar-scale', scaleFactor);

    if (persist) {
        safeSetItem(SB_STORAGE_KEYS.bottomBarScale, String(nextScale));
    }

    updateThemePickerUi();
}

function setDesktopButtonScale(value, { persist = true } = {}) {
    const nextScale = normalizeTopbarScale(value);
    const scaleFactor = Number((nextScale / 100).toFixed(2)).toString();

    sbState.desktopButtonScale = nextScale;
    document.documentElement.style.setProperty('--sb-desktop-button-scale', scaleFactor);

    if (persist) {
        safeSetItem(SB_STORAGE_KEYS.desktopButtonScale, String(nextScale));
    }

    updateThemePickerUi();
}

function setMobileButtonScale(value, { persist = true } = {}) {
    const nextScale = normalizeTopbarScale(value);
    const scaleFactor = Number((nextScale / 100).toFixed(2)).toString();

    sbState.mobileButtonScale = nextScale;
    document.documentElement.style.setProperty('--sb-mobile-button-scale', scaleFactor);

    if (persist) {
        safeSetItem(SB_STORAGE_KEYS.mobileButtonScale, String(nextScale));
    }

    updateThemePickerUi();
}

function moveElementBefore(element, parent, referenceNode) {
    if (!(element instanceof HTMLElement) || !(parent instanceof HTMLElement)) {
        return;
    }

    if (referenceNode instanceof Node) {
        if (element.parentElement === parent && element.nextElementSibling === referenceNode) {
            return;
        }

        parent.insertBefore(element, referenceNode);
        return;
    }

    if (element.parentElement === parent && element.nextSibling === null) {
        return;
    }

    parent.appendChild(element);
}

function moveElementToStart(element, parent) {
    if (!(element instanceof HTMLElement) || !(parent instanceof HTMLElement)) {
        return;
    }

    if (element.parentElement === parent && element.previousElementSibling === null) {
        return;
    }

    parent.insertBefore(element, parent.firstChild);
}

function moveElementAfter(element, referenceElement, parent) {
    if (!(element instanceof HTMLElement)
        || !(referenceElement instanceof HTMLElement)
        || !(parent instanceof HTMLElement)) {
        return;
    }

    if (element.parentElement === parent && element.previousElementSibling === referenceElement) {
        return;
    }

    parent.insertBefore(element, referenceElement.nextSibling);
}

/*
 * Everything upstream (plus the bundled palette button) ships in #rightSendForm. The phone
 * composer sizes that rail for exactly two buttons, so anything else there is third-party.
 */
const SB_COMPOSER_NATIVE_RIGHT_RAIL_IDS = Object.freeze([
    'stscript_continue',
    'stscript_pause',
    'stscript_stop',
    'mes_stop',
    'mes_impersonate',
    'mes_continue',
    'sb_prose_polisher_but',
    'send_but',
    'qig-input-btn',
]);

const SB_COMPOSER_ADOPTED_ATTRIBUTE = 'data-sb-composer-adopted';

/**
 * Relocates third-party composer buttons between the rails. The right rail is a fixed two-button
 * grid column with no overflow, so extension buttons there used to be hidden outright on phones;
 * the left rail already scrolls, so it can hold any number of them. Desktop keeps them where the
 * extension put them.
 */
function placeComposerExtensionButtons(leftForm, rightForm) {
    const mobile = isMobileViewport();

    if (mobile) {
        for (const child of Array.from(rightForm.children)) {
            if (!(child instanceof HTMLElement) || SB_COMPOSER_NATIVE_RIGHT_RAIL_IDS.includes(child.id)) {
                continue;
            }

            child.setAttribute(SB_COMPOSER_ADOPTED_ATTRIBUTE, 'right');
            leftForm.appendChild(child);
        }

        return;
    }

    for (const child of Array.from(leftForm.querySelectorAll(`:scope > [${SB_COMPOSER_ADOPTED_ATTRIBUTE}='right']`))) {
        child.removeAttribute(SB_COMPOSER_ADOPTED_ATTRIBUTE);
        rightForm.appendChild(child);
    }
}

function placeComposerControls() {
    const leftForm = document.getElementById('leftSendForm');
    const rightForm = document.getElementById('rightSendForm');

    if (!(leftForm instanceof HTMLElement) || !(rightForm instanceof HTMLElement)) {
        return;
    }

    const paletteButton = document.getElementById('qig-input-btn');
    const optionsButton = document.getElementById('options_button');
    const wandButton = document.getElementById('extensionsMenuButton');
    const sendButton = document.getElementById('send_but');

    moveElementToStart(optionsButton, leftForm);

    if (optionsButton instanceof HTMLElement && optionsButton.parentElement === leftForm) {
        moveElementAfter(wandButton, optionsButton, leftForm);
    } else {
        moveElementToStart(wandButton, leftForm);
    }

    moveElementBefore(paletteButton, rightForm, sendButton);
    placeComposerExtensionButtons(leftForm, rightForm);
}

function queueComposerControlPlacement() {
    if (sbComposerControlsSyncQueued) {
        return;
    }

    sbComposerControlsSyncQueued = true;
    window.requestAnimationFrame(() => {
        sbComposerControlsSyncQueued = false;
        placeComposerControls();
    });
}

function bindComposerControlPlacement() {
    const leftForm = document.getElementById('leftSendForm');
    const rightForm = document.getElementById('rightSendForm');

    if (!(leftForm instanceof HTMLElement) || !(rightForm instanceof HTMLElement)) {
        return;
    }

    if (!(sbComposerControlsObserver instanceof MutationObserver)) {
        sbComposerControlsObserver = new MutationObserver(() => queueComposerControlPlacement());
    }

    sbComposerControlsObserver.disconnect();
    sbComposerControlsObserver.observe(leftForm, { childList: true });
    sbComposerControlsObserver.observe(rightForm, { childList: true });
    queueComposerControlPlacement();
}

function setCompactMode(enabled, { persist = true } = {}) {
    const nextEnabled = Boolean(enabled);
    sbState.compactMode = nextEnabled;
    document.documentElement.dataset.sbCompactMode = String(nextEnabled);
    document.body?.classList.toggle('sb-compact-mode', nextEnabled);
    syncTopbarLayoutState();

    if (persist) {
        safeSetItem(SB_STORAGE_KEYS.compactMode, String(nextEnabled));
    }

    queueComposerControlPlacement();
    updateThemePickerUi();
}

// SillyBunny: Limit Content Width is a desktop setting. The clamp is the default and has no attribute; the unclamped view is one
// attribute on the root, so turning it on or off restyles no more than that write does.
function applyContentClampPreference() {
    const root = document.documentElement;
    if (sbState.contentClamp) {
        root.removeAttribute('data-sb-content-clamp');
    } else if (root.getAttribute('data-sb-content-clamp') !== 'off') {
        root.setAttribute('data-sb-content-clamp', 'off');
    }
}

function syncContentClampInput() {
    const input = document.getElementById('sb-desktop-content-clamp-input');

    if (input instanceof HTMLInputElement) {
        input.checked = sbState.contentClamp;
    }
}

// The full sync of the Interface page rewrites attributes of its sliders, so this setter syncs its own switch only.
function setContentClamp(enabled, { persist = true } = {}) {
    sbState.contentClamp = Boolean(enabled);
    applyContentClampPreference();

    if (persist) {
        safeSetItem(SB_STORAGE_KEYS.desktopContentClamp, String(sbState.contentClamp));
    }

    syncContentClampInput();
}

// SillyBunny: the icons-only top bar (the labelled bar without its labels) is a desktop setting. The phone bar
// never has labels, so no value is in force there; a value an earlier build stored for phones stays in storage, unread.
function isTopbarIconsOnlyActive() {
    return !isMobileViewport() && sbState.topbarIconsOnly.desktop;
}

function applyTopbarIconsOnlyPreference() {
    document.documentElement.dataset.sbTopbarIconsOnly = String(isTopbarIconsOnlyActive());
    fitTopbar();
    queueTopbarSectionStateSync();
    scheduleCharacterToggleGhostSync();
}

// `mode` stays in the signature because `window.SillyBunnyShell.setTopbarIconsOnly(mode, value)` is public; only 'desktop' has a value.
function setTopbarIconsOnly(mode, enabled, { persist = true } = {}) {
    if (mode !== 'desktop') return;
    const nextEnabled = Boolean(enabled);

    sbState.topbarIconsOnly.desktop = nextEnabled;

    applyTopbarIconsOnlyPreference();

    if (persist) {
        safeSetItem(SB_STORAGE_KEYS.desktopTopbarIconsOnly, String(nextEnabled));
    }

    updateThemePickerUi();
}

/*
 * Identity-based ownership for the top-bar adoption pass. An id prefix is spoofable and absent
 * on id-less nodes, so registering what our own factory built is the only reliable test. Any
 * future SillyBunny element that becomes a direct child of #top-bar or #top-settings-holder
 * must come from createElement() or it will be adopted as if it were third-party markup.
 */
const sbOwnedElements = new WeakSet();

function isSillyBunnyOwnedElement(node) {
    return node instanceof Element && sbOwnedElements.has(node);
}

function createElement(tagName, { id = '', className = '', text = '', html = '', attrs = {} } = {}) {
    const element = document.createElement(tagName);

    sbOwnedElements.add(element);

    if (id) {
        element.id = id;
    }

    if (className) {
        element.className = className;
    }

    if (text) {
        element.textContent = text;
    }

    if (html) {
        element.innerHTML = html;
    }

    for (const [key, value] of Object.entries(attrs)) {
        element.setAttribute(key, value);
    }

    return element;
}

function wait(ms) {
    return new Promise(resolve => window.setTimeout(resolve, ms));
}

// Row subtitles and section meta lines describe a setting rather than name it: they stay searchable,
// but folding them into `textContent` would turn every label into "NameDescription". Placeholder copy is
// unwritten filler and is neither searchable nor shown.
const SB_SEARCH_DESCRIPTION_SELECTOR = [
    '.ds-row-subtitle',
    '.sb-group-meta',
    '.sb-settings-category-heading > small',
    `.${SB_FLAT_SECTION_HEADER_CLASS} > .flex-container > small`,
].join(', ');
const SB_SEARCH_PLACEHOLDER_SELECTOR = '[data-sb-copy-placeholder]';

/** Text inside `element`, leaving out descendants matching `skipSelector`. */
function getSearchNodeText(element, skipSelector) {
    if (!element.querySelector(skipSelector)) {
        return element.textContent ?? '';
    }
    const parts = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const skipped = node.parentElement?.closest(skipSelector);
        if (skipped && skipped !== element && element.contains(skipped)) continue;
        parts.push(node.data);
    }
    return parts.join(' ');
}

/** The name a row or heading shows, without its description or placeholder copy. */
function getSearchLabelText(element) {
    return getSearchNodeText(element, `${SB_SEARCH_DESCRIPTION_SELECTOR}, ${SB_SEARCH_PLACEHOLDER_SELECTOR}`);
}

function getSearchTextCandidates(element) {
    const extensionContainer = element.closest('.extension_container');
    const extensionName = extensionContainer?.querySelector('.extension_name')?.textContent ?? '';
    const candidates = [
        element.dataset.sbSearchLabel,
        element.matches('.extension_name') ? element.textContent : '',
        extensionName,
        element.getAttribute('aria-label'),
        element.getAttribute('title'),
        element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.placeholder : '',
        element instanceof HTMLSelectElement ? element.selectedOptions?.[0]?.textContent : '',
        element.matches('.range-block, .range-block-title, .range-block-header')
            ? element.closest('.range-block')?.querySelector('.range-block-title, .range-block-header, label, strong, h4, h5')?.textContent
            : '',
        element.matches('.extension_container, .extension_name')
            ? extensionContainer?.querySelector('.extension_name, .inline-drawer-header, .inline-drawer-toggle, h3, h4, strong')?.textContent
            : '',
        getSearchLabelText(element),
    ];

    return candidates
        .map(candidate => String(candidate ?? '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .filter((candidate, index, collection) => collection.indexOf(candidate) === index);
}

function getSearchDisplayText(element, fallback = '') {
    const candidates = getSearchTextCandidates(element);
    const normalizedFallback = normalizeText(fallback);
    const preferredCandidate = candidates.find(candidate => normalizeText(candidate) !== normalizedFallback);
    return clampText(preferredCandidate || candidates[0] || fallback, 110);
}

function getSearchText(element, sectionLabel = '', includeCategoryDescription = false) {
    const descriptionRoot = includeCategoryDescription && element.matches('.sb-settings-category-title')
        ? element.closest('.sb-settings-category-heading') ?? element
        : element;
    return normalizeText([
        ...getSearchTextCandidates(element),
        getSearchNodeText(descriptionRoot, SB_SEARCH_PLACEHOLDER_SELECTOR),
        sectionLabel,
    ].join(' '));
}

function getSearchEntryDedupeKey(tabState, sectionLabel, displayText, { avatarId = '' } = {}) {
    const personaAvatarId = tabState.id === 'persona'
        ? normalizeText(avatarId)
        : '';

    if (personaAvatarId) {
        return `persona::${personaAvatarId}`;
    }

    return [
        tabState.id,
        normalizeText(sectionLabel),
        normalizeText(displayText),
    ].filter(Boolean).join('::');
}

function getUniversalSearchState() {
    return sbState.universalSearch;
}

// One trailing render per typing pause. `flush` is for keys that act on the list immediately.
function scheduleUniversalSearchRender({ flush = false } = {}) {
    const searchState = getUniversalSearchState();
    const input = searchState.input;
    if (!(input instanceof HTMLInputElement) || !searchState.expanded) {
        window.clearTimeout(searchState.renderTimer);
        searchState.renderTimer = 0;
        return;
    }

    window.clearTimeout(searchState.renderTimer);
    if (flush) {
        searchState.renderTimer = 0;
        renderUniversalSearchResults(input.value);
        return;
    }

    searchState.renderTimer = window.setTimeout(() => {
        searchState.renderTimer = 0;
        renderUniversalSearchResults(input.value);
    }, SB_UNIVERSAL_SEARCH_DEBOUNCE_MS);
}

// Loading one book per keystroke would be a request storm, so entry bodies are primed once when
// the panel opens under a fixed budget, then the list is repainted with whatever arrived.
function primeUniversalSearchEntityMetadata() {
    const searchState = getUniversalSearchState();
    if (searchState.entityPrimeStarted) {
        return;
    }
    searchState.entityPrimeStarted = true;
    const skippedWorlds = searchState.skippedWorlds ?? new Set();
    searchState.skippedWorlds = skippedWorlds;
    const names = getSillyTavernContext()?.getWorldInfoNames?.() ?? [];
    void primeWorldInfoSearchCache({ names, skippedWorlds }).then(() => {
        if (getUniversalSearchState().expanded && (getUniversalSearchState().input?.value ?? '').trim()) {
            scheduleUniversalSearchRender({ flush: true });
        }
    }).catch(() => {
        // A failed priming pass leaves world names searchable; only entry bodies are missing.
    });
}

// The panel paints a short list, so a broad query needs a way to ask for the rest. The row carries
// no id of its own, which keeps it out of the arrow-key list, and it is not a result: Enter on it
// still opens the highlighted setting.
function createUniversalSearchShowAllRow(hiddenCount, groupLabel = '') {
    const row = createElement('button', {
        className: 'sb-search-show-all',
        attrs: {
            type: 'button',
            'data-sb-search-show-all': 'true',
        },
    });    row.appendChild(createElement('strong', {
        text: groupLabel
            ? `Show ${hiddenCount} More in ${groupLabel}`
            : `Show All ${hiddenCount} More Results`,
    }));
    row.addEventListener('click', () => {
        const searchState = getUniversalSearchState();
        searchState.expandedAll = true;
        // Go through the open-state setter: it is the path that repaints an already-open panel.
        setUniversalSearchOpenState(true);
    });
    return row;
}

function renderSearchEmptyState(container, title, detail, state = 'no-results') {
    container.replaceChildren();

    const empty = createElement('div', { className: 'sb-search-empty' });
    empty.append(createStatusPage({ state, icon: 'magnifying-glass', title, description: detail, compact: true }).element);
    container.appendChild(empty);
}

function focusUniversalSearchInput(input) {
    if (!(input instanceof HTMLInputElement)) {
        return;
    }

    const applyFocus = () => {
        input.focus({ preventScroll: true });
        input.select();
    };

    applyFocus();
    window.requestAnimationFrame(applyFocus);
}

function requestMobileViewportReset({ restoreScroll = false } = {}) {
    if (!isMobileViewport() || typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') {
        return;
    }

    const dispatchReset = () => window.dispatchEvent(new CustomEvent('sb-mobile-viewport-reset', {
        detail: { restoreScroll: Boolean(restoreScroll) },
    }));

    if (typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(dispatchReset);
    } else {
        dispatchReset();
    }

    window.setTimeout(dispatchReset, SB_MOBILE_VIEWPORT_RESET_FOLLOWUP_MS);
}

function setUniversalSearchOpenState(isOpen, { focusInput = false } = {}) {
    const searchState = getUniversalSearchState();
    const row = searchState.row;
    const root = searchState.root;
    const input = searchState.input;
    const nextOpenState = Boolean(isOpen);
    const wasOpen = Boolean(searchState.expanded);

    searchState.expanded = nextOpenState;
    row?.classList.toggle('is-open', nextOpenState);
    row?.setAttribute('aria-hidden', String(!nextOpenState));
    root?.classList.toggle('is-open', nextOpenState);
    root?.setAttribute('aria-expanded', String(nextOpenState));
    if (input instanceof HTMLInputElement) {
        input.tabIndex = nextOpenState ? 0 : -1;
        input.setAttribute('aria-expanded', String(nextOpenState));
    }

    if (!nextOpenState) {
        window.clearTimeout(searchState.renderTimer);
        searchState.renderTimer = 0;
        searchState.results?.classList.remove('is-visible');
        if (wasOpen) {
            requestMobileViewportReset({ restoreScroll: true });
        }
    } else if (!wasOpen) {
        // Opening paints the current query once; later keystrokes go through the debounce.
        renderUniversalSearchResults(input?.value ?? '');
        primeUniversalSearchEntityMetadata();
    } else if (!searchState.renderTimer && (input?.value ?? '').trim()) {
        scheduleUniversalSearchRender();
    }

    if (focusInput && input instanceof HTMLInputElement) {
        focusUniversalSearchInput(input);
    }

    const searchToggle = document.getElementById('sb-topbar-search-toggle');
    searchToggle?.classList.toggle('is-open', nextOpenState);
    searchToggle?.setAttribute('aria-expanded', String(nextOpenState));

    syncShortcutButtonActiveStates();
}

function clearUniversalSearch({ blur = false } = {}) {
    const searchState = getUniversalSearchState();

    if (searchState.input instanceof HTMLInputElement) {
        searchState.input.value = '';
        if (blur && document.activeElement === searchState.input) {
            searchState.input.blur();
        }
    }

    if (searchState.results instanceof HTMLElement) {
        searchState.results.replaceChildren();
        searchState.results.classList.remove('is-visible');
    }

    searchState.activeIndex = -1;
    searchState.input?.removeAttribute('aria-activedescendant');
    setUniversalSearchOpenState(false);
}

function isActuallyVisible(element) {
    return Boolean(element) && element.getClientRects().length > 0;
}

function getShellState(shellKey) {
    return sbState.shells[shellKey];
}

function getShellConfig(shellKey) {
    return SB_SHELLS[shellKey];
}

function getCharacterPanelTabConfig(tabId) {
    return SB_CHARACTER_PANEL_TABS.find(tab => tab.id === tabId) ?? null;
}

function normalizeCharacterPanelTab(tabId) {
    const normalizedTabId = normalizeText(tabId);
    return getCharacterPanelTabConfig(normalizedTabId) ? normalizedTabId : SB_CHARACTER_PANEL_DEFAULT_TAB;
}

function isMobileViewport() {
    return window.matchMedia(SB_MOBILE_MEDIA_QUERY).matches;
}

function getLayoutViewportScrollAnchor() {
    const scrollingElement = document.scrollingElement;

    return {
        left: Math.max(0, Math.round(window.scrollX || scrollingElement?.scrollLeft || 0)),
        top: Math.max(0, Math.round(window.scrollY || scrollingElement?.scrollTop || 0)),
    };
}

function restoreLayoutViewportScroll(anchor) {
    if (!anchor) {
        return;
    }

    const scrollingElement = document.scrollingElement;
    if (scrollingElement instanceof Element) {
        scrollingElement.scrollLeft = anchor.left;
        scrollingElement.scrollTop = anchor.top;
    }

    if (window.scrollX !== anchor.left || window.scrollY !== anchor.top) {
        window.scrollTo(anchor.left, anchor.top);
    }
}

function queueLayoutViewportScrollRestore(anchor) {
    restoreLayoutViewportScroll(anchor);
    window.requestAnimationFrame(() => restoreLayoutViewportScroll(anchor));
    window.setTimeout(() => restoreLayoutViewportScroll(anchor), 120);
}

const SB_MANAGED_SCROLL_CONTAINER_SELECTOR = '.sb-shell-panel-scroller, .scrollableInner, .scrollableInnerFull, .sb-search-results, #chat';

/** Whether the element would actually move when scrolled, rather than only clipping. */
function isScrollableContainer(element) {
    if (element.scrollHeight - element.clientHeight <= 1) {
        return false;
    }
    const overflowY = window.getComputedStyle(element).overflowY;
    return overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay';
}

function getManagedScrollContainer(target) {
    if (!(target instanceof HTMLElement)) {
        return null;
    }

    // Nearest match first: a panel can nest a taller, non-scrolling wrapper inside the element that
    // really scrolls, and scrolling that wrapper moves nothing.
    const candidates = [];
    for (let element = target; element; element = element.parentElement) {
        if (element.matches(SB_MANAGED_SCROLL_CONTAINER_SELECTOR)) candidates.push(element);
    }

    return candidates.find(isScrollableContainer) ?? candidates[0] ?? null;
}

function scrollElementIntoManagedView(target, { block = 'nearest', behavior = 'auto' } = {}) {
    if (!(target instanceof HTMLElement)) {
        return false;
    }

    const anchor = getLayoutViewportScrollAnchor();
    const scroller = getManagedScrollContainer(target);

    if (!(scroller instanceof HTMLElement) || scroller.clientHeight <= 0) {
        target.scrollIntoView({ block, behavior });
        queueLayoutViewportScrollRestore(anchor);
        return false;
    }

    const scrollerRect = scroller.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const topOverflow = targetRect.top - scrollerRect.top;
    const bottomOverflow = targetRect.bottom - scrollerRect.bottom;
    let delta = 0;

    if (block === 'center') {
        delta = topOverflow - ((scrollerRect.height - targetRect.height) / 2);
    } else if (block === 'end') {
        delta = bottomOverflow;
    } else if (block === 'start') {
        delta = topOverflow;
    } else if (topOverflow < 0) {
        delta = topOverflow;
    } else if (bottomOverflow > 0) {
        delta = bottomOverflow;
    }

    if (Math.abs(delta) > 1) {
        const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        scroller.scrollTo({
            top: clampNumber(scroller.scrollTop + delta, 0, maxScrollTop),
            behavior,
        });
    }

    queueLayoutViewportScrollRestore(anchor);
    return true;
}

function isTouchOnlyDesktopViewport() {
    const hasHover = window.matchMedia('(hover: hover), (any-hover: hover)').matches;
    const hasFinePointer = window.matchMedia('(pointer: fine), (any-pointer: fine)').matches;
    const isTouchMac = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;

    return isTouchMac || (navigator.maxTouchPoints > 0 && !hasHover && !hasFinePointer);
}

function readFiniteViewportNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function getLayoutViewportSize() {
    const doc = document.documentElement;
    const fallbackWidth = window.innerWidth || doc?.clientWidth || 0;
    const fallbackHeight = window.innerHeight || doc?.clientHeight || 0;

    const width = Math.max(0, Math.round(readFiniteViewportNumber(fallbackWidth, 0)));
    const height = Math.max(0, Math.round(readFiniteViewportNumber(fallbackHeight, 0)));

    return {
        width,
        height,
        left: 0,
        top: 0,
        right: width,
        bottom: height,
    };
}

function getVisualViewportSize(fallbackViewport = getLayoutViewportSize()) {
    const visualViewport = window.visualViewport;
    const fallbackWidth = fallbackViewport.width;
    const fallbackHeight = fallbackViewport.height;
    const width = Math.max(0, Math.round(readFiniteViewportNumber(visualViewport?.width, fallbackWidth)));
    const height = Math.max(0, Math.round(readFiniteViewportNumber(visualViewport?.height, fallbackHeight)));

    return {
        width,
        height,
        left: Math.max(0, Math.round(readFiniteViewportNumber(visualViewport?.offsetLeft, 0))),
        top: Math.max(0, Math.round(readFiniteViewportNumber(visualViewport?.offsetTop, 0))),
        right: width,
        bottom: height,
    };
}

function isEditableElement(element) {
    return element instanceof HTMLElement
        && (['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) || element.isContentEditable);
}

function isMobileShellPanelEditableElement(element) {
    return isEditableElement(element)
        && Boolean(element.closest('#left-nav-panel, #user-settings-block, .sb-shell-root, #right-nav-panel'));
}

function isChatComposerEditableElement(element) {
    return isEditableElement(element)
        && Boolean(element.closest('#send_textarea, #send_form, #form_sheld'));
}

function hasOpenMobileShellDrawer() {
    return sbSettingsState.open;
}

function shouldUseStableIOSPanelViewport(layoutViewport, visualViewportSize) {
    if (!isIOSWebKitPlatform() || !isVisualViewportKeyboardOpen(layoutViewport, visualViewportSize)) {
        return false;
    }

    if (isMobileViewport() && !isLegacyIOSWebKitPlatform()) {
        return false;
    }

    const activeElement = document.activeElement;
    if (isChatComposerEditableElement(activeElement)) {
        return false;
    }

    return isMobileShellPanelEditableElement(activeElement) || hasOpenMobileShellDrawer();
}

const MOBILE_COMPOSER_KEYBOARD_PAN_EPSILON_PX = 8;
const MOBILE_COMPOSER_KEYBOARD_PRESHIFT_WINDOW_MS = 700;
const MOBILE_IOS_KEYBOARD_MIN_HEIGHT_PX = 80;

let sbLastIOSKeyboardHeight = 0;
let sbComposerKeyboardPreShiftDeadline = 0;
let sbComposerKeyboardSettleTimer = 0;

function isVisualViewportKeyboardOpen(layoutViewport = getLayoutViewportSize(), visualViewportSize = getVisualViewportSize(layoutViewport)) {
    const keyboardHeight = Math.max(0, layoutViewport.height - visualViewportSize.height);
    return keyboardHeight > MOBILE_IOS_KEYBOARD_MIN_HEIGHT_PX || visualViewportSize.top > 2;
}

/**
 * SillyBunny: old iOS versions can force-scroll the document to reveal the
 * composer caret. Shrink the stable shell by the keyboard height before that
 * reveal while preserving the modern viewport behavior on iOS 26 and newer.
 */
function getComposerKeyboardInset(layoutViewport, visualViewportSize) {
    if (!isLegacyIOSWebKitPlatform() || !isMobileViewport()) {
        return 0;
    }

    const keyboardHeight = Math.max(0, layoutViewport.height - visualViewportSize.height);
    if (keyboardHeight > MOBILE_IOS_KEYBOARD_MIN_HEIGHT_PX) {
        sbLastIOSKeyboardHeight = keyboardHeight;
    }

    if (!isChatComposerEditableElement(document.activeElement)) {
        return 0;
    }

    const withinPreShiftWindow = Date.now() < sbComposerKeyboardPreShiftDeadline;

    if (isVisualViewportKeyboardOpen(layoutViewport, visualViewportSize)) {
        // Do not shrink after Safari has already panned, which would recreate
        // the empty space below the escaped composer.
        if (visualViewportSize.top > MOBILE_COMPOSER_KEYBOARD_PAN_EPSILON_PX) {
            return 0;
        }

        return withinPreShiftWindow ? Math.max(keyboardHeight, sbLastIOSKeyboardHeight) : keyboardHeight;
    }

    return withinPreShiftWindow ? sbLastIOSKeyboardHeight : 0;
}

function handleComposerKeyboardFocusIn(event) {
    if (!isLegacyIOSWebKitPlatform() || !isMobileViewport()) {
        return;
    }

    if (isChatComposerEditableElement(event.target)) {
        sbComposerKeyboardPreShiftDeadline = Date.now() + MOBILE_COMPOSER_KEYBOARD_PRESHIFT_WINDOW_MS;
        window.clearTimeout(sbComposerKeyboardSettleTimer);
        sbComposerKeyboardSettleTimer = window.setTimeout(queueMobileViewportStateSync, MOBILE_COMPOSER_KEYBOARD_PRESHIFT_WINDOW_MS + 50);
    }

    queueMobileViewportStateSync();
}

function handleMobileKeyboardFocusOut() {
    if (!isLegacyIOSWebKitPlatform() || !isMobileViewport()) {
        return;
    }

    queueMobileViewportStateSync();
}

function syncIOSKeyboardBottomInset() {
    const root = document.documentElement;
    let bottomInset = 0;
    let composerControlsActive = false;

    if (isIOSWebKitPlatform()) {
        const layoutViewport = getLayoutViewportSize();
        const visualViewportSize = getVisualViewportSize(layoutViewport);

        if (isVisualViewportKeyboardOpen(layoutViewport, visualViewportSize)) {
            if (isMobileViewport() && !isLegacyIOSWebKitPlatform()) {
                composerControlsActive = isChatComposerEditableElement(document.activeElement);
            } else {
                bottomInset = Math.max(0, Math.round(layoutViewport.height - visualViewportSize.top - visualViewportSize.height));
            }
        }
    }

    const value = `${bottomInset}px`;
    if (root.style.getPropertyValue('--sb-ios-keyboard-bottom-inset') !== value) {
        root.style.setProperty('--sb-ios-keyboard-bottom-inset', value);
    }

    // SillyBunny: the <=768px shell CSS consumes the inset var directly; wide
    // viewports (iPadOS desktop-mode Safari) gate the padding on this class so
    // desktop layouts only pick it up while the software keyboard is open.
    root.classList.toggle('sb-ios-keyboard-inset-active', bottomInset > 0);
    root.classList.toggle('sb-ios-composer-keyboard-controls-active', composerControlsActive);
}

function getShellViewportSize() {
    const layoutViewport = getLayoutViewportSize();
    const visualViewportSize = getVisualViewportSize(layoutViewport);

    const composerKeyboardInset = getComposerKeyboardInset(layoutViewport, visualViewportSize);
    if (composerKeyboardInset > 0) {
        const height = Math.max(0, layoutViewport.height - composerKeyboardInset);
        return { ...layoutViewport, height, bottom: height };
    }

    // Older iOS and wide iPad panels retain the stable layout; modern phone
    // panels fit the visible viewport without a second keyboard-sized reserve.
    if (shouldUseStableIOSPanelViewport(layoutViewport, visualViewportSize)) {
        return layoutViewport;
    }

    return visualViewportSize;
}

function syncShellViewportBounds() {
    const root = document.documentElement;
    const viewportSize = getShellViewportSize();
    const topOffset = Math.max(0, Math.round(getResolvedShellTopbarOffset()));
    const setRootViewportProperty = (property, value) => {
        if (root.style.getPropertyValue(property) !== value) {
            root.style.setProperty(property, value);
        }
    };

    setRootViewportProperty('--sb-shell-viewport-height', `${viewportSize.height}px`);
    setRootViewportProperty('--sb-shell-measured-top-offset', `${topOffset}px`);
    setRootViewportProperty('--sb-shell-available-height', `${Math.max(0, viewportSize.height - topOffset)}px`);
    // SillyBunny: Safari can pan the visible viewport without resizing it.
    setRootViewportProperty('--sb-shell-viewport-top', `${viewportSize.top}px`);

    // SillyBunny: browser-fixes.js may reset document scroll mid-edit once the
    // legacy shell has moved the focused composer above the keyboard.
    const composerKeyboardInset = getComposerKeyboardInset(getLayoutViewportSize(), getVisualViewportSize());
    root.classList.toggle('sb-ios-composer-keyboard-inset-active', composerKeyboardInset > 0);
}

function getMobileFocusedInputScroller(target) {
    if (!(target instanceof HTMLElement)) {
        return null;
    }

    // Shell construction retains compatibility wrappers inside the real panel
    // scroller. Prefer the outer scroll owner, otherwise scroll legacy drawers.
    const shellScroller = target.closest('.sb-shell-panel-scroller');
    if (shellScroller instanceof HTMLElement) {
        return shellScroller;
    }

    const legacyScroller = target.closest('.scrollableInner, .scrollableInnerFull');
    return legacyScroller instanceof HTMLElement ? legacyScroller : null;
}

function syncMobileFocusedInputScroll(target = document.activeElement) {
    if (!isMobileViewport() || !(target instanceof HTMLElement) || target !== document.activeElement || !isEditableElement(target)) {
        return;
    }

    const scroller = getMobileFocusedInputScroller(target);
    if (!scroller) {
        return;
    }

    // visualViewport tracks the keyboard: top grows and height shrinks as the
    // keyboard rises, so (top + height) is the bottom of the visible area.
    const layoutViewport = getLayoutViewportSize();
    const viewportSize = getVisualViewportSize(layoutViewport);

    if (!isVisualViewportKeyboardOpen(layoutViewport, viewportSize)) {
        return;
    }

    const viewportBottom = viewportSize.top + viewportSize.height;
    const rect = target.getBoundingClientRect();
    const overflow = rect.bottom - viewportBottom + 16;

    if (overflow > 0) {
        scroller.scrollTop += overflow;
    }
}

let sbMobileFocusedInputScrollTimer = null;

/**
 * SillyBunny: on mobile the body is fixed/clip, so the browser cannot scroll a
 * focused input above the virtual keyboard the way a normal page would. Follow
 * the keyboard's visual viewport updates until Safari finishes its animation.
 */
function scheduleMobileFocusedInputScroll(event) {
    const target = event?.target instanceof HTMLElement && isEditableElement(event.target)
        ? event.target
        : document.activeElement;

    if (!(target instanceof HTMLElement)) {
        return;
    }

    window.requestAnimationFrame(() => syncMobileFocusedInputScroll(target));

    if (sbMobileFocusedInputScrollTimer !== null) {
        window.clearTimeout(sbMobileFocusedInputScrollTimer);
    }

    sbMobileFocusedInputScrollTimer = window.setTimeout(() => {
        sbMobileFocusedInputScrollTimer = null;
        syncMobileFocusedInputScroll(target);
    }, 360);
}

const MOBILE_POPUP_KEYBOARD_CLEARANCE_PX = 16;

function getMobilePopupDialogForKeyboard(element) {
    if (!(element instanceof HTMLElement)) {
        return null;
    }

    // Framed popups keep themselves above the keyboard (bindKeyboardInset in sillybunny-editor/dialog.js).
    const dialog = element.closest('dialog.popup:not(.sb-dialog)');
    return dialog instanceof HTMLElement && dialog.open ? dialog : null;
}

function clearMobilePopupKeyboardShift(dialog) {
    if (!(dialog instanceof HTMLElement)) {
        return;
    }

    const scroller = dialog.querySelector('[data-sb-keyboard-max-height]');
    if (scroller instanceof HTMLElement) {
        const previousMaxHeight = scroller.dataset.sbKeyboardMaxHeight;
        if (previousMaxHeight) {
            scroller.style.maxHeight = previousMaxHeight;
        } else {
            scroller.style.removeProperty('max-height');
        }
        delete scroller.dataset.sbKeyboardMaxHeight;
    }

    if (dialog.dataset.sbKeyboardStyle !== undefined) {
        dialog.style.cssText = dialog.dataset.sbKeyboardStyle;
    }

    delete dialog.dataset.sbKeyboardAdjusted;
    delete dialog.dataset.sbKeyboardStyle;
}

function clearAllMobilePopupKeyboardShifts(except = null) {
    for (const dialog of document.querySelectorAll('dialog.popup[data-sb-keyboard-adjusted]')) {
        if (dialog !== except) {
            clearMobilePopupKeyboardShift(dialog);
        }
    }
}

/**
 * SillyBunny: popup dialogs are centered against the layout viewport, which
 * does not shrink with the virtual keyboard (interactive-widget=resizes-visual).
 * When a focused popup input sits behind the keyboard, the browser pans the
 * visual viewport to reveal it, pushing the top bar off screen (e.g. the
 * connection profile name popup). Anchor the popup to the measured visible
 * area and cap it there, then scroll its content so the browser never needs
 * to pan. Position comes from visualViewport alone: measuring the dialog to
 * offset it reads a stale rect while the open/keyboard animations run.
 */
function syncMobilePopupKeyboardShift() {
    const activeElement = document.activeElement;
    const dialog = isMobileViewport() && isEditableElement(activeElement)
        ? getMobilePopupDialogForKeyboard(activeElement)
        : null;

    clearAllMobilePopupKeyboardShifts(dialog);

    if (!dialog) {
        return;
    }

    const layoutViewport = getLayoutViewportSize();
    const viewportSize = getVisualViewportSize(layoutViewport);

    if (!isVisualViewportKeyboardOpen(layoutViewport, viewportSize)) {
        clearMobilePopupKeyboardShift(dialog);
        return;
    }

    // Measure without the current shift so a shrinking keyboard relaxes it.
    clearMobilePopupKeyboardShift(dialog);

    // visualViewport tracks the keyboard: top grows and height shrinks as the
    // keyboard rises, so (top + height) is the bottom of the visible area.
    const viewportBottom = viewportSize.top + viewportSize.height;
    const edgeClearance = `${MOBILE_POPUP_KEYBOARD_CLEARANCE_PX}px`;
    const topClearance = `max(${edgeClearance}, env(safe-area-inset-top, 0px))`;
    const bottomClearance = `max(${edgeClearance}, env(safe-area-inset-bottom, 0px))`;
    const availableHeight = `calc(${viewportSize.height}px - ${topClearance} - ${bottomClearance})`;
    const scroller = activeElement.closest('.popup-body, .popup-content');

    dialog.dataset.sbKeyboardStyle = dialog.style.cssText;
    dialog.dataset.sbKeyboardAdjusted = 'true';
    // A modal dialog is fixed to the layout viewport with inset 0 and auto
    // margins, so bottom: auto drops the vertical centering while top pins it
    // to the visible area. Horizontal centering is untouched.
    dialog.style.setProperty('top', `calc(${viewportSize.top}px + ${topClearance})`, 'important');
    dialog.style.setProperty('bottom', 'auto', 'important');
    dialog.style.setProperty('min-height', '0', 'important');
    dialog.style.setProperty('max-height', availableHeight, 'important');

    if (scroller instanceof HTMLElement) {
        scroller.dataset.sbKeyboardMaxHeight = scroller.style.maxHeight;
        scroller.style.maxHeight = availableHeight;

        const scrollOverflow = activeElement.getBoundingClientRect().bottom + MOBILE_POPUP_KEYBOARD_CLEARANCE_PX - viewportBottom;
        if (scrollOverflow > 0) {
            scroller.scrollTop += scrollOverflow;
        }
    }
}

let sbMobilePopupKeyboardSyncTimer = 0;

function scheduleMobilePopupKeyboardSync() {
    window.requestAnimationFrame(syncMobilePopupKeyboardShift);
    window.clearTimeout(sbMobilePopupKeyboardSyncTimer);
    // Run again after the keyboard animation / visualViewport resize settles.
    // iOS takes ~300ms to finish raising the keyboard and panning back.
    sbMobilePopupKeyboardSyncTimer = window.setTimeout(syncMobilePopupKeyboardShift, 400);
}

/** Account storage once its migration marker is present; init() never removes it, so it stays ready. */
let sbReadyAccountStorage = null;

function getShellAccountStorage() {
    if (sbReadyAccountStorage) {
        return sbReadyAccountStorage;
    }

    const storage = getSillyTavernContext()?.accountStorage;

    if (!storage || typeof storage.getState !== 'function') {
        return null;
    }

    try {
        // getState() deep-clones the whole store; only pay for it until readiness is observed once.
        const snapshot = storage.getState();
        if (!snapshot || !Object.hasOwn(snapshot, SB_ACCOUNT_STORAGE_READY_MARKER)) {
            return null;
        }
        sbReadyAccountStorage = storage;
        return storage;
    } catch {
        return null;
    }
}

function getPersistentStorageItem(key) {
    if (!key) {
        return null;
    }

    const localValue = safeGetItem(key);
    const accountStorage = getShellAccountStorage();
    const accountValue = accountStorage ? accountStorage.getItem(key) : null;

    if (accountValue !== null) {
        if (accountValue !== localValue) {
            safeSetItem(key, accountValue);
        }

        return accountValue;
    }

    if (localValue !== null && accountStorage) {
        accountStorage.setItem(key, localValue);
    }

    return localValue;
}

function setPersistentStorageItem(key, value) {
    if (!key) {
        return;
    }

    safeSetItem(key, value);
    getShellAccountStorage()?.setItem(key, value);
}

function getResolvedShellTopbarOffset() {
    const docEl = document.documentElement;
    const docTop = (docEl instanceof HTMLElement && docEl.getClientRects().length > 0)
        ? Math.max(0, Math.round(readFiniteViewportNumber(docEl.getBoundingClientRect().top, 0)))
        : 0;

    // SillyBunny: on mobile the shell's own rect.top is driven by the very
    // CSS var this function feeds back into (--sb-shell-measured-top-offset),
    // so reading it creates a feedback loop. If an overscroll momentarily
    // displaces the shell (e.g. iOS rubber-band), the displaced value is
    // written back, the shell is pushed further, and the chat goes blank
    // even after the page snaps back. Stay off #sheld on mobile.
    const isMobileViewportLike = isMobileViewport() || isTouchOnlyDesktopViewport();
    const fallbackTopOffset = (() => {
        const topbarOffset = Number.parseFloat(
            window.getComputedStyle(document.documentElement).getPropertyValue('--sb-topbar-layout-offset'),
        );
        return Number.isFinite(topbarOffset) ? topbarOffset : 0;
    })();

    if (!isMobileViewportLike) {
        const chatShell = document.getElementById('sheld');
        if (chatShell instanceof HTMLElement && chatShell.getClientRects().length > 0) {
            const chatRect = chatShell.getBoundingClientRect();
            if (Number.isFinite(chatRect.top)) {
                const offset = chatRect.top - docTop;
                if (offset > 0) {
                    return offset;
                }
            }
        }
    }

    const topBar = document.getElementById('top-bar');
    if (topBar instanceof HTMLElement && topBar.getClientRects().length > 0) {
        const topBarRect = topBar.getBoundingClientRect();
        if (Number.isFinite(topBarRect.bottom)) {
            const offset = topBarRect.bottom - docTop;
            if (offset > 0) {
                return offset;
            }
        }
    }

    return fallbackTopOffset;
}

function normalizeMessageStyle(styleId) {
    const select = getMessageStyleSelect();
    const fallbackValue = select?.options?.[0]?.value ?? SB_MESSAGE_STYLES[0].id;
    const value = String(styleId ?? fallbackValue);

    if (!select) {
        return value;
    }

    return Array.from(select.options).some(option => option.value === value) ? value : fallbackValue;
}

function getMessageStyleSelect() {
    const select = document.getElementById('chat_display');
    return select instanceof HTMLSelectElement ? select : null;
}

function getCurrentMessageStyle() {
    return normalizeMessageStyle(getMessageStyleSelect()?.value);
}

function setMessageStyle(styleId) {
    const select = getMessageStyleSelect();
    if (!select) {
        return;
    }

    const nextStyle = normalizeMessageStyle(styleId);
    if (select.value !== nextStyle) {
        select.value = nextStyle;
        select.dispatchEvent(new Event('change', { bubbles: true }));
    }

    updateThemePickerUi();
}

function stripAvatarOrigin(url) {
    const normalizedUrl = String(url ?? '').trim();
    if (!normalizedUrl) {
        return '';
    }

    return normalizedUrl.startsWith(window.location.origin)
        ? normalizedUrl.slice(window.location.origin.length)
        : normalizedUrl;
}

function isAbsoluteAvatarUrl(path) {
    return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(String(path ?? ''));
}

function ensureAvatarPath(path) {
    const normalizedPath = String(path ?? '').trim();
    if (!normalizedPath || isAbsoluteAvatarUrl(normalizedPath)) {
        return normalizedPath;
    }

    return normalizedPath.startsWith('/') ? normalizedPath : `/${normalizedPath}`;
}

function getChatAvatarSources(rawSrc) {
    const source = ensureAvatarPath(stripAvatarOrigin(rawSrc));
    const avatarInfo = parseAvatarSource(source);
    if (!avatarInfo) {
        return { display: '', thumb: '', original: '' };
    }

    const { type, file, original } = avatarInfo;
    const isThumbnail = Object.prototype.hasOwnProperty.call(avatarInfo, 'preset');
    const thumb = type === 'avatar' || type === 'persona'
        ? (isThumbnail ? source : getThumbnailUrl(type, file))
        : ensureAvatarPath(file);

    return {
        display: source || thumb,
        thumb: stripAvatarOrigin(thumb),
        original: stripAvatarOrigin(ensureAvatarPath(original)),
    };
}

function formatAvatarCssUrl(url) {
    const normalizedUrl = stripAvatarOrigin(url);
    return normalizedUrl ? `url(${JSON.stringify(normalizedUrl)})` : '';
}

function updateChatAvatarVariables(root = document) {
    const messages = root instanceof HTMLElement && root.matches('.mes')
        ? [root]
        : Array.from(root.querySelectorAll?.('.mes') ?? []);

    for (const message of messages) {
        if (!(message instanceof HTMLElement)) {
            continue;
        }

        const avatarImg = message.querySelector('.avatar img');
        if (!(avatarImg instanceof HTMLImageElement)) {
            continue;
        }

        const src = avatarImg.getAttribute('src') || avatarImg.getAttribute('data-src') || avatarImg.currentSrc;
        const thumbnailSrc = avatarImg.getAttribute('data-thumbnail-src');
        const originalSrc = avatarImg.getAttribute('data-original-src');
        const cachedSources = sbState.chatAvatars.sourceCache.get(message);
        if (cachedSources?.src === src
            && cachedSources.thumbnailSrc === thumbnailSrc
            && cachedSources.originalSrc === originalSrc) {
            continue;
        }
        sbState.chatAvatars.sourceCache.set(message, { src, thumbnailSrc, originalSrc });

        const srcSources = getChatAvatarSources(src);
        const thumbnailSources = getChatAvatarSources(thumbnailSrc);
        const originalSources = getChatAvatarSources(originalSrc);
        const displayUrl = srcSources.display || thumbnailSources.display || originalSources.display;
        const thumbUrl = thumbnailSources.display || srcSources.thumb || displayUrl;
        const originalUrl = originalSources.display || srcSources.original || thumbnailSources.original || displayUrl;

        if (!displayUrl && !thumbUrl && !originalUrl) {
            continue;
        }

        message.dataset.avatarThumb = thumbUrl;
        message.dataset.avatarOriginal = originalUrl;
        message.dataset.avatar = displayUrl;
        message.style.setProperty('--sb-message-avatar', formatAvatarCssUrl(displayUrl));
        message.style.setProperty('--mes-avatar-thumb-url', formatAvatarCssUrl(thumbUrl));
        message.style.setProperty('--mes-avatar-original-url', formatAvatarCssUrl(originalUrl));
        message.style.setProperty('--mes-avatar-url', formatAvatarCssUrl(displayUrl));
    }
}

function scheduleChatAvatarVariableUpdate(delay = 80) {
    window.clearTimeout(sbState.chatAvatars.debounceTimer);
    sbState.chatAvatars.debounceTimer = window.setTimeout(() => {
        sbState.chatAvatars.debounceTimer = 0;
        updateChatAvatarVariables();
    }, delay);
}

function initChatAvatarVariables() {
    window.updateSillyBunnyChatAvatars = updateChatAvatarVariables;
    updateChatAvatarVariables();

    if (sbState.chatAvatars.observer instanceof MutationObserver) {
        return;
    }

    const chatContainer = document.getElementById('chat');
    if (!(chatContainer instanceof HTMLElement)) {
        if (!sbState.chatAvatars.retryTimer) {
            sbState.chatAvatars.retryTimer = window.setTimeout(() => {
                sbState.chatAvatars.retryTimer = 0;
                initChatAvatarVariables();
            }, SB_INIT_RETRY_DELAY_MS);
        }
        return;
    }

    window.clearTimeout(sbState.chatAvatars.retryTimer);
    sbState.chatAvatars.retryTimer = 0;

    const observer = new MutationObserver(() => scheduleChatAvatarVariableUpdate());
    observer.observe(chatContainer, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src', 'data-src', 'data-thumbnail-src', 'data-original-src'],
    });

    sbState.chatAvatars.observer = observer;
    document.addEventListener('sb:chat-style-updated', () => scheduleChatAvatarVariableUpdate(0));
}

function applyShellTheme() {
    sbState.theme = SB_SHELL_THEME;
    document.documentElement.dataset.sbTheme = SB_SHELL_THEME;
}

function setSurfaceTransparency(value, { persist = true } = {}) {
    const nextTransparency = normalizeSurfaceTransparency(value);
    const surfaceOpacity = Math.max(0, 1 - (nextTransparency / 100));
    const cardOpacity = Math.min(1, surfaceOpacity + 0.12);
    const controlOpacity = Math.min(1, surfaceOpacity + 0.22);
    const overlayOpacity = Math.min(1, surfaceOpacity + 0.08);
    sbState.surfaceTransparency = nextTransparency;

    document.documentElement.style.setProperty('--sb-shell-surface-opacity', surfaceOpacity.toFixed(2));
    document.documentElement.style.setProperty('--sb-shell-surface-opacity-percent', `${(surfaceOpacity * 100).toFixed(0)}%`);
    document.documentElement.style.setProperty('--sb-shell-card-opacity', '1');
    document.documentElement.style.setProperty('--sb-shell-control-opacity', '1');
    document.documentElement.style.setProperty('--sb-shell-overlay-opacity', '1');
    document.documentElement.style.setProperty('--sb-page-surface-opacity', surfaceOpacity.toFixed(2));
    document.documentElement.style.setProperty('--sb-page-card-opacity', cardOpacity.toFixed(2));
    document.documentElement.style.setProperty('--sb-page-control-opacity', controlOpacity.toFixed(2));
    document.documentElement.style.setProperty('--sb-page-overlay-opacity', overlayOpacity.toFixed(2));
    document.documentElement.style.setProperty('--sb-composer-surface-opacity', '1');

    if (persist) {
        safeSetItem(SB_STORAGE_KEYS.surfaceTransparency, String(nextTransparency));
    }

    updateThemePickerUi();
}

function applyPaperTextureOpacity() {
    const enabled = sbState.paperTextureEnabled;
    const opacity = enabled ? normalizePaperTextureOpacity(sbState.paperTextureOpacity) / 100 : 0;
    document.documentElement.style.setProperty('--sb-paper-texture-opacity', opacity.toFixed(2));
}

function setPaperTextureEnabled(enabled, { persist = true } = {}) {
    const nextEnabled = normalizeStoredBoolean(enabled, false);
    sbState.paperTextureEnabled = nextEnabled;
    applyPaperTextureOpacity();

    if (persist) {
        safeSetItem(SB_STORAGE_KEYS.paperTextureEnabled, String(nextEnabled));
    }

    updateThemePickerUi();
}

function setPaperTextureOpacity(value, { persist = true } = {}) {
    const nextOpacity = normalizePaperTextureOpacity(value);
    sbState.paperTextureOpacity = nextOpacity;
    applyPaperTextureOpacity();

    if (persist) {
        safeSetItem(SB_STORAGE_KEYS.paperTextureOpacity, String(nextOpacity));
    }

    updateThemePickerUi();
}

function setTopbarLabelPart(partId, enabled) {
    const normalizedPart = normalizeTopbarLabelPart(partId);
    if (!normalizedPart) {
        return;
    }

    const nextParts = new Set(normalizeTopbarLabelParts(sbState.topbarLabel.desktopParts));
    if (enabled) {
        nextParts.add(normalizedPart);
    } else {
        nextParts.delete(normalizedPart);
    }

    sbState.topbarLabel.desktopParts = normalizeTopbarLabelParts(Array.from(nextParts), []);
    safeSetItem(SB_STORAGE_KEYS.topbarLabelDesktopParts, JSON.stringify(sbState.topbarLabel.desktopParts));
    flushSbStorageWrites();
    updateThemePickerUi();
    updateTopBarBrand();
    scheduleTopbarContextRefresh(0);
}

function setTopbarCustomText(value) {
    const nextText = normalizeTopbarCustomText(value);
    if (sbState.topbarLabel.customText === nextText) {
        return;
    }

    sbState.topbarLabel.customText = nextText;
    safeSetItem(SB_STORAGE_KEYS.topbarLabelCustomText, nextText);
    flushSbStorageWrites();
    updateThemePickerUi();
    updateTopBarBrand();
}

function getSillyTavernContext() {
    // SillyTavern.getContext() throws a TDZ ReferenceError on slow boots when
    // it is called before script.js finishes initializing its module-level
    // `chat` binding. Treat that the same as "context not ready yet".
    try {
        return globalThis.SillyTavern?.getContext?.() ?? null;
    } catch {
        return null;
    }
}

function isExtensionEnabled(name) {
    const context = getSillyTavernContext();
    const disabledExtensions = context?.extensionSettings?.disabledExtensions;

    if (!Array.isArray(disabledExtensions)) {
        return true;
    }

    const normalizedName = normalizeExtensionName(name);
    const aliases = new Set(SB_EXTENSION_ALIASES[normalizedName] ?? [normalizedName]);
    return !disabledExtensions.some(disabled => {
        const normalizedDisabled = normalizeExtensionName(disabled);
        return aliases.has(normalizedDisabled);
    });
}

function normalizeExtensionName(name) {
    return String(name || '').replace(/^third-party\//i, '').toLowerCase();
}

function syncMessageActionExtensionVisibility(root = document) {
    if (typeof root === 'number') {
        root = document.querySelector(`.mes[mesid="${root}"]`) || document;
    }

    if (!root?.querySelectorAll) {
        return;
    }

    root.querySelectorAll('[data-requires-extension]').forEach(button => {
        if (!(button instanceof HTMLElement)) {
            return;
        }

        const requiredExtension = button.dataset.requiresExtension;
        const isEnabled = isExtensionEnabled(requiredExtension);
        button.classList.toggle('displayNone', !isEnabled);
        button.toggleAttribute('aria-hidden', !isEnabled);
        if (!isEnabled) {
            button.setAttribute('tabindex', '-1');
        } else if (button.getAttribute('tabindex') === '-1') {
            button.removeAttribute('tabindex');
        }
    });
}

function bindMessageActionExtensionEvents() {
    if (sbMessageActionEventsBound) {
        return;
    }

    const context = getSillyTavernContext();
    if (!context?.eventSource || !context?.event_types) {
        return;
    }

    sbMessageActionEventsBound = true;
    context.eventSource.on(context.event_types.EXTENSION_SETTINGS_LOADED, () => syncMessageActionExtensionVisibility());
    context.eventSource.on(context.event_types.SETTINGS_UPDATED, () => syncMessageActionExtensionVisibility());
    context.eventSource.on(context.event_types.USER_MESSAGE_RENDERED, data => syncMessageActionExtensionVisibility(data?.element || data));
    context.eventSource.on(context.event_types.CHARACTER_MESSAGE_RENDERED, data => syncMessageActionExtensionVisibility(data?.element || data));
}

function getChatScriptModule() {
    if (!sbChatScriptModulePromise) {
        sbChatScriptModulePromise = import('../script.js');
    }

    return sbChatScriptModulePromise;
}

function getCookieClearDomains(hostname) {
    if (!hostname || hostname === 'localhost' || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) {
        return [''];
    }

    const parts = hostname.split('.').filter(Boolean);
    const domains = [''];

    for (let index = 0; index < parts.length - 1; index++) {
        const domain = parts.slice(index).join('.');
        domains.push(domain, `.${domain}`);
    }

    return [...new Set(domains)];
}

function getCookieClearPaths(pathname) {
    const paths = new Set(['/']);
    const segments = pathname.split('/').filter(Boolean);
    let currentPath = '';

    for (const segment of segments) {
        currentPath += `/${segment}`;
        paths.add(currentPath);
        paths.add(`${currentPath}/`);
    }

    return [...paths];
}

function getCookieClearNames(cookieName) {
    const names = new Set([cookieName]);

    try {
        names.add(encodeURIComponent(decodeURIComponent(cookieName)));
    } catch {
        names.add(encodeURIComponent(cookieName));
    }

    return [...names];
}

// SillyBunny: iOS WebKit keeps cookies outside cache/storage APIs, so expire them explicitly.
function clearAllBrowserCookies() {
    if (!document.cookie) {
        return 0;
    }

    const cookieNames = document.cookie
        .split(';')
        .map(cookie => cookie.trim().split('=')[0])
        .filter(Boolean);
    const domains = getCookieClearDomains(window.location.hostname);
    const paths = getCookieClearPaths(window.location.pathname);
    const expires = 'expires=Thu, 01 Jan 1970 00:00:00 GMT';

    for (const cookieName of cookieNames) {
        for (const clearName of getCookieClearNames(cookieName)) {
            for (const path of paths) {
                document.cookie = `${clearName}=; ${expires}; max-age=0; path=${path}; SameSite=Lax`;

                for (const domain of domains) {
                    if (!domain) {
                        continue;
                    }

                    document.cookie = `${clearName}=; ${expires}; max-age=0; path=${path}; domain=${domain}; SameSite=Lax`;
                }
            }
        }
    }

    return cookieNames.length;
}

async function confirmClearCookiesAndCache() {
    const response = await openAlert({
        heading: 'Clear Cookies & Cache?',
        body: 'This removes browser cache, service worker data, temporary session data, and IndexedDB cache stores for SillyBunny, then reloads the page. Saved settings and account data stay intact. Clearing browser cookies may require you to sign in again.',
        responses: [
            { id: 'cancel', label: t`Cancel` },
            { id: 'clear', label: 'Clear Cookies & Cache', appearance: 'destructive' },
        ],
        // The affirmative label is too wide for two responses at 372px, so the Alert widens to keep Cancel first in a row like its siblings.
        preferWide: true,
    });
    return response === 'clear';
}

async function clearServerCookies() {
    const response = await fetch('/api/cookies/clear', {
        method: 'POST',
        headers: getRequestHeadersFromContext(),
        cache: 'no-store',
    });

    if (!response.ok) {
        throw new Error(`Server cookie clear failed: ${response.status} ${response.statusText}`);
    }

    try {
        return await response.json();
    } catch {
        return { success: true };
    }
}

async function handleClearCookiesAndCacheClick(event) {
    event?.preventDefault();

    const button = document.getElementById('clear_cookies_cache_button');
    if (!(button instanceof HTMLButtonElement) || button.disabled) {
        return;
    }

    button.disabled = true;
    button.classList.add('disabled');
    button.setAttribute('aria-busy', 'true');

    try {
        const confirmed = await confirmClearCookiesAndCache();
        if (!confirmed) {
            button.disabled = false;
            button.classList.remove('disabled');
            button.removeAttribute('aria-busy');
            return;
        }

        const clearFrontendCache = window.SillyBunnyClearFrontendCache;
        if (typeof clearFrontendCache !== 'function') {
            throw new Error('Cache clear helper is not available yet. Reload the page and try again.');
        }

        const didClear = await clearFrontendCache({ skipConfirmation: true });
        if (!didClear) {
            button.disabled = false;
            button.classList.remove('disabled');
            button.removeAttribute('aria-busy');
            return;
        }

        const serverCookieResult = await clearServerCookies();
        const clearedCookieCount = clearAllBrowserCookies();
        globalThis.toastr?.success?.('Cookies and cache cleared. Reloading SillyBunny…', 'Cookies cleared');
        console.info(`[Cache] Expired ${clearedCookieCount} browser cookies and queued ${serverCookieResult?.expirationAttempts ?? 0} server cookie expirations before reload`);
        window.setTimeout(() => window.location.reload(), 1000);
    } catch (error) {
        console.error('Failed to clear cookies and cache', error);
        globalThis.toastr?.error?.(String(error?.message || error), 'Clear failed');
        button.disabled = false;
        button.classList.remove('disabled');
        button.removeAttribute('aria-busy');
    }
}

/** @param {Document|HTMLElement} [root] */
function bindClearCookiesAndCacheButton(root = document) {
    const button = root.querySelector('#clear_cookies_cache_button');
    if (!(button instanceof HTMLButtonElement) || button.dataset.sbCookiesCacheBound === 'true') {
        return;
    }

    button.dataset.sbCookiesCacheBound = 'true';
    button.addEventListener('click', event => {
        void handleClearCookiesAndCacheClick(event);
    });
}

function hasActiveTopBarChat(context = getSillyTavernContext()) {
    return Boolean(context && (context.groupId || (context.characterId !== undefined && context.characterId !== null)));
}

function getTopBarCharacterLabel(context = getSillyTavernContext()) {
    if (!context) {
        return '';
    }

    if (context.groupId) {
        const activeGroup = context.groups?.find(group => String(group?.id) === String(context.groupId));
        return activeGroup?.name?.trim() || '';
    }

    if (context.characterId !== undefined && context.characterId !== null) {
        const activeCharacter = context.characters?.[context.characterId];
        return activeCharacter?.name?.trim() || context.name2?.trim() || '';
    }

    return '';
}

function getDefaultTopBarLabel(context = getSillyTavernContext()) {
    if (isHomeActive()) {
        return t`Home`;
    }

    return getTopBarCharacterLabel(context) || SB_IDLE_BRAND_LABEL;
}

function formatTopbarContextTokens(value) {
    const numericValue = Number(value);

    if (!Number.isFinite(numericValue)) {
        return '';
    }

    return Math.max(0, Math.round(numericValue)).toLocaleString();
}

function getPromptManagerTokenUsage(promptManager) {
    const directValue = Number(promptManager?.tokenUsage);
    if (Number.isFinite(directValue)) {
        return Math.max(0, Math.round(directValue));
    }

    const tokenHandler = promptManager?.getTokenHandler?.();
    const total = Number(tokenHandler?.getTotal?.());
    return Number.isFinite(total) ? Math.max(0, Math.round(total)) : null;
}

function setTopbarContextTokens(tokens) {
    const normalizedValue = Number.isFinite(Number(tokens)) ? Math.max(0, Math.round(Number(tokens))) : null;
    if (sbState.topbarLabel.contextTokens === normalizedValue) {
        return;
    }

    sbState.topbarLabel.contextTokens = normalizedValue;
    updateTopBarBrand();
}

function isTopbarContextLabelEnabled() {
    return sbState.topbarLabel.desktopParts.includes('ctx');
}

function syncTopbarContextTokensFromPromptManager() {
    const context = getSillyTavernContext();
    const promptManager = context?.promptManager;

    if (!hasActiveTopBarChat(context) || context?.mainApi !== 'openai') {
        setTopbarContextTokens(null);
        return;
    }

    setTopbarContextTokens(getPromptManagerTokenUsage(promptManager));
}

function scheduleTopbarContextRefresh(delay = SB_TOPBAR_CONTEXT_REFRESH_DEBOUNCE) {
    window.clearTimeout(sbState.topbarLabel.refreshTimer);

    if (!isTopbarContextLabelEnabled()) {
        syncTopbarContextTokensFromPromptManager();
        return;
    }

    sbState.topbarLabel.refreshTimer = window.setTimeout(() => {
        void refreshTopbarContextTokens();
    }, delay);
}

async function refreshTopbarContextTokens() {
    const context = getSillyTavernContext();
    const promptManager = context?.promptManager;

    if (!hasActiveTopBarChat(context) || context?.mainApi !== 'openai') {
        setTopbarContextTokens(null);
        return;
    }

    if (!promptManager || typeof promptManager.tryGenerate !== 'function') {
        syncTopbarContextTokensFromPromptManager();
        return;
    }

    if (sbState.topbarLabel.refreshInFlight) {
        sbState.topbarLabel.refreshPending = true;
        return;
    }

    sbState.topbarLabel.refreshInFlight = true;
    sbState.topbarLabel.refreshPending = false;
    const refreshToken = ++sbState.topbarLabel.refreshToken;
    syncTopbarContextTokensFromPromptManager();

    try {
        await promptManager.tryGenerate();
    } catch {
        // Ignore dry-run failures and keep the most recent known value.
    } finally {
        sbState.topbarLabel.refreshInFlight = false;
    }

    if (refreshToken !== sbState.topbarLabel.refreshToken) {
        return;
    }

    syncTopbarContextTokensFromPromptManager();

    if (sbState.topbarLabel.refreshPending) {
        sbState.topbarLabel.refreshPending = false;
        scheduleTopbarContextRefresh(80);
    }
}

function getConfiguredTopbarLabelParts() {
    return normalizeTopbarLabelParts(sbState.topbarLabel.desktopParts);
}

function getTopBarLabelPartText(partId, context = getSillyTavernContext()) {
    switch (partId) {
        case 'ctx':
            if (!hasActiveTopBarChat(context) || context?.mainApi !== 'openai') {
                return '';
            }

            return formatTopbarContextTokens(sbState.topbarLabel.contextTokens) || '...';
        case 'char':
            return getTopBarCharacterLabel(context);
        case 'custom':
            return sbState.topbarLabel.customText;
        default:
            return '';
    }
}

function recordRoleplayIfChatShown() {
    if (getCurrentChatId() !== undefined) {
        recordChatMode('roleplay');
    }
}

function returnToChatSurface() {
    // Close every overlay surface without touching the active chat itself.
    window.dispatchEvent(new CustomEvent('sb:close-conversation-workspace'));
    recordRoleplayIfChatShown();
    closeShell('left');
    closeShell('right');
    closeCharacterPanel();
}

function bindTopBarTitle(title) {
    if (!(title instanceof HTMLElement) || title.dataset.sbTopbarTitleBound === 'true') {
        return;
    }

    title.dataset.sbTopbarTitleBound = 'true';
    title.addEventListener('click', event => {
        event.stopPropagation();
        returnToChatSurface();
    });
    title.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        returnToChatSurface();
    });
}

function getTopBarLabel() {
    const context = getSillyTavernContext();
    const parts = getConfiguredTopbarLabelParts()
        .map(partId => normalizeTopbarLabelPart(partId))
        .filter(Boolean);
    const labelParts = SB_TOPBAR_LABEL_PART_ORDER
        .filter(partId => parts.includes(partId))
        .map(partId => getTopBarLabelPartText(partId, context))
        .filter(Boolean);

    return labelParts.length ? labelParts.join(' · ') : getDefaultTopBarLabel(context);
}

function updateTopBarBrand() {
    const title = document.getElementById('sb-topbar-title');
    const brand = document.querySelector('.sb-topbar-brand');

    if (!(title instanceof HTMLElement) || !(brand instanceof HTMLElement)) {
        return;
    }

    const context = getSillyTavernContext();
    const label = getTopBarLabel();
    const isActiveChat = hasActiveTopBarChat(context);

    bindTopBarTitle(title);
    title.textContent = label;
    title.title = label;
    title.setAttribute('aria-label', `${label}. Tap to return to the chat.`);
    title.classList.toggle('is-chat', isActiveChat);
    brand.dataset.brandState = isActiveChat ? 'chat' : 'idle';
    queueTopbarFit();
}

function scheduleTopBarBrandBindingRetry(delay = 240) {
    window.clearTimeout(sbState.topbarLabel.bindingRetryTimer);
    sbState.topbarLabel.bindingRetryTimer = window.setTimeout(() => {
        bindTopBarBrand();
    }, delay);
}

function bindTopBarBrandWindowEvents() {
    if (sbState.topbarLabel.windowBindingsAttached) {
        return;
    }

    const refreshWithContext = () => {
        window.requestAnimationFrame(updateTopBarBrand);
        scheduleTopbarContextRefresh(0);
        bindTopBarBrand();
    };

    window.addEventListener('pageshow', refreshWithContext, { passive: true });
    window.addEventListener('focus', refreshWithContext, { passive: true });
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
            refreshWithContext();
        }
    });

    sbState.topbarLabel.windowBindingsAttached = true;
}

function bindTopBarBrand() {
    const context = getSillyTavernContext();
    const eventSource = context?.eventSource;
    const eventTypes = context?.eventTypes ?? context?.event_types;
    bindTopBarBrandWindowEvents();

    if (!eventSource || !eventTypes) {
        window.requestAnimationFrame(updateTopBarBrand);
        scheduleTopbarContextRefresh(0);
        scheduleTopBarBrandBindingRetry();
        return;
    }

    window.clearTimeout(sbState.topbarLabel.bindingRetryTimer);

    if (sbState.topbarLabel.boundEventSource === eventSource) {
        window.requestAnimationFrame(updateTopBarBrand);
        scheduleTopbarContextRefresh(0);
        return;
    }

    const refresh = () => window.requestAnimationFrame(updateTopBarBrand);
    const refreshWithContext = () => {
        refresh();
        scheduleTopbarContextRefresh();
    };
    const events = [
        eventTypes.APP_READY,
        eventTypes.CHAT_CHANGED,
        eventTypes.CHAT_CREATED,
        eventTypes.GROUP_CHAT_CREATED,
        eventTypes.MESSAGE_EDITED,
        eventTypes.MESSAGE_DELETED,
        eventTypes.MESSAGE_UPDATED,
        eventTypes.CHARACTER_EDITED,
        eventTypes.CHARACTER_RENAMED,
        eventTypes.CHARACTER_DELETED,
        eventTypes.GROUP_UPDATED,
        eventTypes.PERSONA_CHANGED,
        eventTypes.MAIN_API_CHANGED,
        eventTypes.SETTINGS_UPDATED,
        eventTypes.WORLDINFO_SETTINGS_UPDATED,
    ].filter(Boolean);

    for (const eventName of new Set(events)) {
        eventSource.on(eventName, refreshWithContext);
    }

    if (eventTypes.CHAT_COMPLETION_PROMPT_READY) {
        eventSource.on(eventTypes.CHAT_COMPLETION_PROMPT_READY, () => {
            syncTopbarContextTokensFromPromptManager();
            refresh();
        });
    }

    sbState.topbarLabel.boundEventSource = eventSource;
    refresh();
    scheduleTopbarContextRefresh(0);
}

function stopProxyPointerPropagation(element) {
    if (!(element instanceof HTMLElement)) {
        return;
    }

    const stop = event => {
        event.stopPropagation();
    };

    element.addEventListener('mousedown', stop);
    element.addEventListener('pointerdown', stop);
    // Passive: the handler never calls preventDefault, and a non-passive touchstart on every
    // button pulls WebKit off its compositor scrolling path, which stalls scrolling on iOS.
    element.addEventListener('touchstart', stop, { passive: true });
}

// SillyBunny: a button that shows its label is named by it (`name`), so the accessible name contains the visible text; its title stays the tooltip, which assistive technology reads as the description.
function createProxyButton({ id, icon, label, title, name = title, className = '' }, onClick) {
    const button = createElement('button', {
        id,
        className: `sb-proxy-button ${className}`.trim(),
        attrs: {
            type: 'button',
            title,
            'aria-label': name,
            'aria-expanded': 'false',
            'data-sb-proxy-button': 'true',
        },
    });

    button.innerHTML = `<i class="fa-solid ${icon}" aria-hidden="true"></i><span>${label}</span>`;
    stopProxyPointerPropagation(button);
    button.addEventListener('click', debounceAction(onClick));

    return button;
}

// SillyBunny: a 1px rule between two sets of controls on the bar: Quick Access from the shell
// buttons on desktop, and Search and Mode from the section buttons on phones.
function createTopbarClusterDivider(id) {
    return createElement('span', {
        id,
        className: 'sb-topbar-cluster-divider',
        attrs: { 'aria-hidden': 'true' },
    });
}

// SillyBunny: the bar's width is shared by CSS alone while everything fits: three tracks (start,
// title, end) in #sb-topbar-inner, with the title truncated by its own ellipsis. CSS cannot see
// how wide the two groups want to be, so it cannot decide when to give something up. This does,
// from the groups' natural widths. As the bar narrows each step only goes further: the title
// shortens by its own ellipsis, the labels drop as soon as the labelled form leaves too little
// for the title, the title hides, and only then do the Quick Access buttons move into the
// overflow menu (with the title still hidden, so nothing comes back at a narrower width). Each
// verdict is read from the natural widths of that form, measured here with the form applied and
// undone within one task, never from what is on screen now, so a verdict cannot feed back into
// itself.
function resolveTopbarFit({ available, gap, labelsForcedOff, canOverflow, measure }) {
    const readings = new Map();
    const read = step => {
        const key = `${step.labelsOff}|${step.overflow}`;

        if (!readings.has(key)) {
            const widths = measure(step);
            readings.set(key, { groups: widths.start + widths.end, titleNeeded: Math.min(SB_TOPBAR_BRAND_MIN_WIDTH, widths.title) });
        }

        return readings.get(key);
    };
    const fitsWithTitle = step => {
        const { groups, titleNeeded } = read(step);

        return groups + gap * 2 + titleNeeded <= available;
    };

    const labelled = { labelsOff: false, overflow: false };
    const icons = { labelsOff: true, overflow: false };

    if (!labelsForcedOff && fitsWithTitle(labelled)) {
        return { ...labelled, titleHidden: false };
    }

    if (fitsWithTitle(icons)) {
        return { ...icons, titleHidden: false };
    }

    if (!canOverflow || read(icons).groups + gap <= available) {
        return { ...icons, titleHidden: true };
    }

    return { labelsOff: true, overflow: true, titleHidden: true };
}

function readTopbarGroupWidth(group) {
    const gap = Number.parseFloat(getComputedStyle(group).columnGap) || 0;
    let total = 0;
    let count = 0;

    for (const child of group.children) {
        if (!(child instanceof HTMLElement) || child.getClientRects().length === 0) {
            continue;
        }

        const style = getComputedStyle(child);
        total += child.getBoundingClientRect().width
            + (Number.parseFloat(style.marginInlineStart) || 0)
            + (Number.parseFloat(style.marginInlineEnd) || 0);
        count += 1;
    }

    return count > 0 ? Math.ceil(total + gap * (count - 1)) : 0;
}

function setTopbarFitState({ labelsOff, overflow, titleHidden }) {
    const data = document.documentElement.dataset;

    for (const [key, active, value] of [
        ['sbTopbarLabels', labelsOff, 'off'],
        ['sbTopbarOverflow', overflow, 'true'],
        ['sbTopbarTitle', titleHidden, 'hidden'],
    ]) {
        if (active && data[key] !== value) {
            data[key] = value;
        } else if (!active && data[key] !== undefined) {
            delete data[key];
        }
    }
}

function getTopbarQuickAccessTargets() {
    return SB_TOPBAR_GROUP_ORDER.left.concat(SB_TOPBAR_GROUP_ORDER.right)
        .filter(id => id.startsWith('sb-shortcut-'))
        .map(id => getShortcutTarget(id.slice('sb-shortcut-'.length)))
        .filter(target => target !== 'none');
}

function fitTopbar() {
    const inner = document.getElementById('sb-topbar-inner');
    const startGroup = inner?.querySelector(':scope > .sb-topbar-group-left');
    const endGroup = inner?.querySelector(':scope > .sb-topbar-group-right');
    const title = document.getElementById('sb-topbar-title');

    if (!(inner instanceof HTMLElement) || !(startGroup instanceof HTMLElement) || !(endGroup instanceof HTMLElement)) {
        return;
    }

    const available = inner.getBoundingClientRect().width;

    if (available <= 0) {
        return;
    }

    const labelsForcedOff = isTopbarIconsOnlyActive();
    const verdict = resolveTopbarFit({
        available,
        gap: Number.parseFloat(getComputedStyle(inner).columnGap) || 0,
        labelsForcedOff,
        canOverflow: !isMobileViewport() && getTopbarQuickAccessTargets().length > 0,
        measure: step => {
            setTopbarFitState({ ...step, titleHidden: false });

            return {
                start: readTopbarGroupWidth(startGroup),
                end: readTopbarGroupWidth(endGroup),
                title: title instanceof HTMLElement ? title.scrollWidth : 0,
            };
        },
    });

    setTopbarFitState(verdict);
}

function queueTopbarFit() {
    if (sbState.topbarFit.frame) {
        return;
    }

    sbState.topbarFit.frame = window.requestAnimationFrame(() => {
        sbState.topbarFit.frame = 0;
        fitTopbar();
    });
}

// SillyBunny: one observer for the whole bar. A change in the bar's width, or in the size of any
// control in it (a font, a scale, a Quick Access slot, an adopted extension button), queues a fit.
function observeTopbarFit() {
    const inner = document.getElementById('sb-topbar-inner');

    if (!(inner instanceof HTMLElement)) {
        return;
    }

    sbState.topbarFit.observer?.disconnect();
    sbState.topbarFit.observer ??= new ResizeObserver(queueTopbarFit);

    for (const target of [inner, ...inner.querySelectorAll(':scope > .sb-topbar-group > *')]) {
        sbState.topbarFit.observer.observe(target);
    }
}

function getTopbarOverflowLabel() {
    return t`Quick Access`;
}

function openTopbarOverflowMenu() {
    const trigger = document.getElementById('sb-topbar-overflow-toggle');

    if (!(trigger instanceof HTMLElement)) {
        return;
    }

    const items = getTopbarQuickAccessTargets().map(target => {
        const config = getShortcutConfig(target);

        return {
            label: config.label,
            icon: `fa-solid ${config.icon}`,
            title: `Quick Access: ${config.label}`,
            onSelect: () => activateShortcutTarget(target),
        };
    });

    openActionMenu({ trigger, title: getTopbarOverflowLabel(), sections: [{ items }] });
}

function bindSearchShortcutPreFocus(button, targetGetter) {
    if (!(button instanceof HTMLElement) || typeof targetGetter !== 'function') {
        return;
    }

    const openAndFocusSearch = () => {
        if (!isSearchShortcutTarget(targetGetter())) {
            return;
        }

        const searchState = getUniversalSearchState();
        if (searchState.expanded) {
            return;
        }

        closeAllDropdowns({ except: 'search' });
        setUniversalSearchOpenState(true, { focusInput: true });
        sbSearchShortcutPreFocusAt = performance.now();
    };

    button.addEventListener('pointerdown', openAndFocusSearch, { passive: true });
    button.addEventListener('touchstart', openAndFocusSearch, { passive: true });
}

function getChatbarState() {
    return sbState.chatbar;
}

function setTopbarUtilityButtonIcon(button, icon, title) {
    if (!(button instanceof HTMLButtonElement)) {
        return;
    }

    button.title = title;
    button.setAttribute('aria-label', title);

    const iconElement = button.querySelector('i');
    if (iconElement instanceof HTMLElement) {
        iconElement.className = `fa-solid ${icon}`;
    }
}

function updateTopbarUtilityButtons() {
    const state = getChatbarState();
    const toggleButton = state.chatbarToggleButton;
    const dragHandleButton = state.dragHandleButton;
    const isVisible = state.visible;

    if (toggleButton instanceof HTMLButtonElement) {
        setTopbarUtilityButtonIcon(
            toggleButton,
            isVisible ? 'fa-eye-slash' : 'fa-eye',
            isVisible ? 'Hide top chat bar' : 'Show top chat bar',
        );
        setButtonPressed(toggleButton, isVisible);
    }

    if (dragHandleButton instanceof HTMLButtonElement) {
        const dragTitle = isMobileViewport()
            ? 'Drag to move the chat info bar on mobile.'
            : 'Drag to move the chat info bar. Double-click to reset.';
        setTopbarUtilityButtonIcon(dragHandleButton, 'fa-grip-lines', dragTitle);
        setButtonDisabled(dragHandleButton, false);
    }
}

function syncTopbarLayoutState() {
    document.body.classList.add('sb-topbar-compact');
}

function setChatbarVisible(shouldShow, { persist = true } = {}) {
    const nextVisible = Boolean(shouldShow);
    const state = getChatbarState();
    state.visible = nextVisible;

    document.body.classList.toggle('sb-chatbar-hidden', !nextVisible);

    if (persist) {
        safeSetItem(SB_STORAGE_KEYS.chatbarVisible, String(nextVisible));
    }

    updateTopbarUtilityButtons();
    syncTopbarLayoutState();
    scheduleChatbarRefresh(0);
}

function toggleChatbarVisibility() {
    setChatbarVisible(!getChatbarState().visible);
}

function syncChatbarVisibilityState() {
    setChatbarVisible(getChatbarState().visible, { persist: false });
}

function getTopbarDragKey(event) {
    if (!event) {
        return null;
    }

    if (event.changedTouches?.length) {
        return `touch:${event.changedTouches[0].identifier}`;
    }

    if (event.touches?.length) {
        return `touch:${event.touches[0].identifier}`;
    }

    if (typeof event.pointerType === 'string') {
        if (event.pointerType === 'mouse') {
            return 'mouse';
        }

        if (Number.isFinite(event.pointerId)) {
            return `pointer:${event.pointerId}`;
        }
    }

    if (Number.isFinite(event.pointerId)) {
        return `pointer:${event.pointerId}`;
    }

    if (event.type?.startsWith?.('mouse')) {
        return 'mouse';
    }

    return null;
}

function getTopbarDragPoint(event) {
    if (!event) {
        return null;
    }

    if (event.changedTouches?.length) {
        return event.changedTouches[0];
    }

    if (event.touches?.length) {
        return event.touches[0];
    }

    if (Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) {
        return event;
    }

    return null;
}

function updateTopbarDrag(event) {
    const state = getChatbarState();
    const point = getTopbarDragPoint(event);

    if (!state.dragging || !point || getTopbarDragKey(event) !== state.dragging.key) {
        return;
    }

    setTopbarOffset({
        x: state.dragging.startX + (point.clientX - state.dragging.originX),
        y: state.dragging.startY + (point.clientY - state.dragging.originY),
    }, { persist: false });

    if (event.cancelable) {
        event.preventDefault();
    }
}

function endTopbarDrag(event) {
    const state = getChatbarState();

    if (!state.dragging || getTopbarDragKey(event) !== state.dragging.key) {
        return;
    }

    document.body.classList.remove('sb-topbar-dragging');

    const finalOffset = clampTopbarOffset(getChatbarState().renderedTopbarOffset);
    state.dragging = null;
    setTopbarOffset(finalOffset, { persist: true });

    unbindTopbarDragEvents();
}

function unbindTopbarDragEvents() {
    const state = getChatbarState();

    if (!state.dragListenersBound) {
        return;
    }

    state.dragListenersBound = false;
    window.removeEventListener('pointermove', updateTopbarDrag);
    window.removeEventListener('pointerup', endTopbarDrag);
    window.removeEventListener('pointercancel', endTopbarDrag);
    window.removeEventListener('mousemove', updateTopbarDrag);
    window.removeEventListener('mouseup', endTopbarDrag);
    window.removeEventListener('touchmove', updateTopbarDrag);
    window.removeEventListener('touchend', endTopbarDrag);
    window.removeEventListener('touchcancel', endTopbarDrag);
}

function bindTopbarDragEvents() {
    const state = getChatbarState();

    if (state.dragListenersBound) {
        return;
    }

    state.dragListenersBound = true;
    window.addEventListener('pointermove', updateTopbarDrag);
    window.addEventListener('pointerup', endTopbarDrag);
    window.addEventListener('pointercancel', endTopbarDrag);
    window.addEventListener('mousemove', updateTopbarDrag);
    window.addEventListener('mouseup', endTopbarDrag);
    window.addEventListener('touchmove', updateTopbarDrag, { passive: false });
    window.addEventListener('touchend', endTopbarDrag);
    window.addEventListener('touchcancel', endTopbarDrag);
}

function getChatSidebarRefs() {
    return getChatbarState().sidebar;
}

function getRequestHeadersFromContext(context = getSillyTavernContext()) {
    if (typeof context?.getRequestHeaders === 'function') {
        return context.getRequestHeaders();
    }

    return {
        'Content-Type': 'application/json',
    };
}

function getCsrfTokenFromHeaders(headers) {
    if (!headers || typeof headers !== 'object') {
        return '';
    }

    const rawToken = headers['X-CSRF-Token'] ?? headers['x-csrf-token'] ?? '';
    const token = String(rawToken ?? '').trim();

    if (!token || token === 'undefined' || token === 'null') {
        return '';
    }

    return token;
}

async function waitForAuthorizedRequestHeaders(timeoutMs = 15000, context = getSillyTavernContext()) {
    const timeoutAt = Date.now() + timeoutMs;

    while (Date.now() < timeoutAt) {
        const headers = getRequestHeadersFromContext(context);

        if (getCsrfTokenFromHeaders(headers)) {
            return headers;
        }

        await wait(50);
    }

    return getRequestHeadersFromContext(context);
}

async function getAuthorizedRequestHeadersOrNull(timeoutMs = 1500, context = getSillyTavernContext()) {
    const headers = await waitForAuthorizedRequestHeaders(timeoutMs, context);
    return getCsrfTokenFromHeaders(headers) ? headers : null;
}

function normalizeChatFileName(value) {
    return String(value ?? '').replace(/\.jsonl$/i, '').trim();
}

function getChatUiContext() {
    const context = getSillyTavernContext();

    if (!context) {
        return {
            context: null,
            chatId: '',
            group: null,
            character: null,
            hasChat: false,
            canBrowseChats: false,
            canStartNewChat: false,
            label: '',
        };
    }

    const group = context.groupId
        ? context.groups?.find(item => String(item?.id) === String(context.groupId)) ?? null
        : null;
    const character = context.characterId !== undefined && context.characterId !== null
        ? context.characters?.[context.characterId] ?? null
        : null;
    const chatId = normalizeChatFileName(context.getCurrentChatId?.() ?? context.chatId ?? '');
    const canBrowseChats = Boolean(group || character);

    return {
        context,
        chatId,
        group,
        character,
        hasChat: Boolean(chatId),
        canBrowseChats,
        canStartNewChat: canBrowseChats,
        label: String(group?.name ?? character?.name ?? '').trim(),
    };
}

function getChatSortTimestamp(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value > 1e12 ? value : value * 1000;
    }

    if (typeof value === 'string') {
        const numericValue = Number(value);

        if (Number.isFinite(numericValue) && numericValue > 0) {
            return numericValue > 1e12 ? numericValue : numericValue * 1000;
        }

        const parsedValue = Date.parse(value);
        if (Number.isFinite(parsedValue)) {
            return parsedValue;
        }
    }

    return 0;
}

function formatChatTimestamp(value) {
    const timestamp = getChatSortTimestamp(value);
    if (!timestamp) {
        return '';
    }

    try {
        return new Date(timestamp).toLocaleDateString();
    } catch {
        return '';
    }
}

function formatChatPreview(value) {
    return clampText(String(value ?? '').replace(/\s+/g, ' ').trim() || 'No preview yet.', 120);
}

function formatChatTokenEstimate(value) {
    const tokens = Math.round(Number(value) || 0);
    if (tokens <= 0) {
        return '';
    }

    if (tokens >= 1_000_000) {
        return `~${(tokens / 1_000_000).toFixed(tokens < 10_000_000 ? 1 : 0).replace(/\.0$/, '')}m tokens`;
    }

    if (tokens >= 1_000) {
        return `~${(tokens / 1_000).toFixed(tokens < 10_000 ? 1 : 0).replace(/\.0$/, '')}k tokens`;
    }

    return `~${tokens} tokens`;
}

/**
 * A temporary chat has no file; its stand-in id is internal, so the chat bar shows a label instead.
 * @param {string} chatName Chat id or file name
 * @returns {string} Text to show for it
 */
function describeChatName(chatName) {
    return isReservedChatName(chatName) ? t`Temporary Chat` : chatName;
}

function formatChatSelectorLabel(fileName, tokenEstimate = 0) {
    const tokenLabel = formatChatTokenEstimate(tokenEstimate);
    const displayName = describeChatName(fileName);
    return tokenLabel ? `${displayName} (${tokenLabel})` : displayName;
}

function normalizeChatInfo(chatInfo) {
    const rawFileName = chatInfo?.file_name ?? chatInfo?.id ?? chatInfo?.chat_id ?? chatInfo ?? '';
    const fileName = normalizeChatFileName(rawFileName);

    return {
        fileName,
        preview: formatChatPreview(chatInfo?.mes ?? chatInfo?.preview ?? chatInfo?.message ?? ''),
        lastMessage: chatInfo?.last_mes ?? chatInfo?.updated_at ?? chatInfo?.create_date ?? '',
        sortTimestamp: getChatSortTimestamp(chatInfo?.last_mes ?? chatInfo?.updated_at ?? chatInfo?.create_date ?? ''),
        chatItems: Number(chatInfo?.chat_items ?? chatInfo?.message_count ?? 0) || 0,
        tokenEstimate: Number(chatInfo?.token_estimate ?? chatInfo?.tokenEstimate ?? 0) || 0,
        fileSize: String(chatInfo?.file_size ?? '').trim(),
    };
}

function sortChatFiles(files) {
    return [...files].sort((left, right) => {
        if (right.sortTimestamp !== left.sortTimestamp) {
            return right.sortTimestamp - left.sortTimestamp;
        }

        return left.fileName.localeCompare(right.fileName);
    });
}

async function fetchCharacterChatFiles(chatContext) {
    const avatarUrl = chatContext.character?.avatar;

    if (!avatarUrl) {
        return [];
    }

    try {
        const headers = await getAuthorizedRequestHeadersOrNull(2000, chatContext.context);
        if (!headers) {
            return [];
        }

        const response = await fetch('/api/characters/chats', {
            method: 'POST',
            headers,
            body: JSON.stringify({ avatar_url: avatarUrl }),
        });

        if (!response.ok) {
            return [];
        }

        const data = await response.json();
        if (typeof data === 'object' && data?.error === true) {
            return [];
        }

        const chats = Array.isArray(data) ? data : Object.values(data ?? {});
        return sortChatFiles(chats.map(normalizeChatInfo).filter(chat => chat.fileName));
    } catch (error) {
        console.error('Failed to fetch character chats', error);
        return [];
    }
}

async function fetchGroupChatFiles(chatContext) {
    const groupChats = Array.isArray(chatContext.group?.chats) ? chatContext.group.chats : [];

    if (!groupChats.length) {
        return [];
    }

    try {
        const headers = await getAuthorizedRequestHeadersOrNull(2000, chatContext.context);
        if (!headers) {
            return [];
        }

        const chats = await Promise.all(groupChats.map(async chatId => {
            try {
                const response = await fetchWithCsrfRetry('/api/chats/group/info', () => ({
                    method: 'POST',
                    headers: getRequestHeadersFromContext(chatContext.context),
                    body: JSON.stringify({ id: chatId }),
                }), { refreshCsrfToken });

                if (!response.ok) {
                    if (response.status === 404) {
                        return null;
                    }

                    return normalizeChatInfo({ file_name: chatId });
                }

                const chatInfo = normalizeChatInfo(await response.json());
                return chatInfo.fileName ? chatInfo : normalizeChatInfo({ file_name: chatId });
            } catch {
                return normalizeChatInfo({ file_name: chatId });
            }
        }));

        return sortChatFiles(chats.filter(chat => chat?.fileName));
    } catch (error) {
        console.error('Failed to fetch group chats', error);
        return [];
    }
}

async function getChatFilesForContext(chatContext = getChatUiContext()) {
    if (!chatContext.canBrowseChats) {
        return [];
    }

    return chatContext.group
        ? fetchGroupChatFiles(chatContext)
        : fetchCharacterChatFiles(chatContext);
}

async function openChatById(chatId) {
    const nextChatId = normalizeChatFileName(chatId);
    const chatContext = getChatUiContext();

    if (!nextChatId || !chatContext.context) {
        return;
    }

    if (nextChatId === chatContext.chatId) {
        return;
    }

    try {
        if (chatContext.group?.id) {
            await chatContext.context.openGroupChat?.(chatContext.group.id, nextChatId);
        } else {
            await chatContext.context.openCharacterChat?.(nextChatId);
        }
    } finally {
        scheduleChatbarRefresh(80);
    }
}

async function handleRenameChat() {
    const chatContext = getChatUiContext();
    const currentChatId = chatContext.chatId;

    if (!currentChatId || typeof chatContext.context?.renameChat !== 'function') {
        return;
    }

    const newChatName = await chatContext.context.Popup?.show?.input?.('Rename Chat', 'Enter a new chat name:', currentChatId);

    if (!newChatName || String(newChatName).trim() === currentChatId) {
        return;
    }

    try {
        await chatContext.context.renameChat(currentChatId, String(newChatName).trim());
    } catch {
        return;
    }
    scheduleChatbarRefresh(120);
}

async function handleDeleteChat() {
    const chatContext = getChatUiContext();

    if (!chatContext.chatId) {
        return;
    }

    const confirmed = await openAlert({
        heading: t`Delete Chat?`,
        body: t`This action cannot be undone`,
        responses: [
            { id: 'cancel', label: t`Cancel` },
            { id: 'delete', label: t`Delete`, appearance: 'destructive' },
        ],
    });
    if (confirmed !== 'delete') {
        return;
    }

    await chatContext.context?.executeSlashCommandsWithOptions?.('/delchat');
    scheduleChatbarRefresh(150);
}

function setBottomChatActionBusy(button, busy) {
    if (!(button instanceof HTMLElement)) {
        return;
    }

    button.classList.toggle('is-busy', Boolean(busy));
    setButtonDisabled(button, Boolean(busy));
}

async function handleAutoNameChat() {
    const chatContext = getChatUiContext();
    const button = getBottomChatBarState().autoNameButton;

    if (!chatContext.hasChat) {
        return;
    }

    setBottomChatActionBusy(button, true);
    try {
        const { autoLabelCurrentChat } = await getChatScriptModule();
        if (typeof autoLabelCurrentChat !== 'function') {
            throw new Error('Chat auto-name helper is unavailable.');
        }

        await autoLabelCurrentChat();
        scheduleBottomChatBarRefresh(160);
    } catch (error) {
        console.error('[SillyBunny] Failed to auto-name current chat.', error);
        globalThis.toastr?.error?.(String(error?.message || error), 'Auto-name chat');
    } finally {
        setBottomChatActionBusy(button, false);
    }
}

function getMassDeleteOlderThanDays(files, days, currentChatId) {
    const numericDays = Number(days);
    if (!Number.isFinite(numericDays) || numericDays <= 0) {
        return [];
    }

    const cutoff = Date.now() - (numericDays * 24 * 60 * 60 * 1000);
    return files.filter(chatFile => chatFile.fileName !== currentChatId && chatFile.sortTimestamp > 0 && chatFile.sortTimestamp < cutoff);
}

function showBottomChatMassDeleteDialog(files, currentChatId) {
    return openMassDeleteChatDialog(files, currentChatId, {
        getOlderCount: days => getMassDeleteOlderThanDays(files, days, currentChatId).length,
        formatChatTimestamp,
    });
}

async function deleteChatFileForContext(chatContext, fileName, chatModule) {
    if (chatContext.group?.id) {
        const { deleteGroupChatByName } = await import('./group-chats.js');
        return deleteGroupChatByName(chatContext.group.id, fileName);
    }

    if (chatContext.context?.characterId !== undefined && chatContext.context?.characterId !== null) {
        await chatModule.deleteCharacterChatByName(chatContext.context.characterId, fileName);
        return true;
    }

    return false;
}

async function handleMassDeleteChats() {
    const chatContext = getChatUiContext();
    const button = getBottomChatBarState().massDeleteButton;

    if (!chatContext.canBrowseChats) {
        return;
    }

    setBottomChatActionBusy(button, true);
    try {
        const files = await getChatFilesForContext(chatContext);
        const deletableFiles = files.filter(chatFile => chatFile.fileName !== chatContext.chatId);
        if (!deletableFiles.length) {
            globalThis.toastr?.info?.('No saved chats can be deleted for this character or group', 'Mass delete chats');
            return;
        }

        const result = await showBottomChatMassDeleteDialog(files, chatContext.chatId);
        if (!result) {
            return;
        }

        const names = result.mode === 'older'
            ? getMassDeleteOlderThanDays(files, result.days, chatContext.chatId).map(chatFile => chatFile.fileName)
            : result.names;

        if (!names.length) {
            return;
        }

        const confirmed = await openAlert({
            heading: t`Delete Chats?`,
            body: t`Delete ${names.length} chat(s)? This cannot be undone.`,
            responses: [
                { id: 'cancel', label: t`Cancel` },
                { id: 'delete', label: t`Delete`, appearance: 'destructive' },
            ],
        });
        if (confirmed !== 'delete') {
            return;
        }

        const chatModule = await getChatScriptModule();
        for (const fileName of names) {
            await deleteChatFileForContext(chatContext, fileName, chatModule);
        }

        globalThis.toastr?.success?.(`Deleted ${names.length} chat(s)`, 'Mass delete chats');
        scheduleBottomChatBarRefresh(160);
        scheduleChatbarRefresh(160);
        await chatModule.displayPastChats?.();
    } catch (error) {
        console.error('[SillyBunny] Failed to mass delete chats.', error);
        globalThis.toastr?.error?.(String(error?.message || error), 'Mass delete chats');
    } finally {
        setBottomChatActionBusy(button, false);
    }
}

function handleNewChat() {
    document.getElementById('option_start_new_chat')?.click();
    scheduleChatbarRefresh(100);
}

function handleChatManagerClick() {
    document.getElementById('option_select_chat')?.click();
}

function setButtonDisabled(button, disabled) {
    if (!(button instanceof HTMLElement)) {
        return;
    }

    button.toggleAttribute('disabled', Boolean(disabled));
    button.classList.toggle('is-disabled', Boolean(disabled));
}

function setButtonPressed(button, pressed) {
    if (!(button instanceof HTMLElement)) {
        return;
    }

    button.classList.toggle('is-active', Boolean(pressed));
    button.setAttribute('aria-pressed', String(Boolean(pressed)));
}

function setSearchStatusText(statusText) {
    const normalizedText = String(statusText ?? '').trim();

    const status = getBottomChatBarState()?.searchStatus;
    if (!(status instanceof HTMLElement)) {
        return;
    }

    status.textContent = normalizedText;
    status.title = normalizedText;
    status.hidden = !normalizedText;
}

function getChatScrollElement() {
    const chatRoot = document.getElementById('chat');
    return chatRoot instanceof HTMLElement ? chatRoot : null;
}

function getReducedMotionScrollBehavior() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}

function cancelPendingBottomChatScroll() {
    if (typeof sbPendingBottomChatScrollCancel === 'function') {
        sbPendingBottomChatScrollCancel();
        sbPendingBottomChatScrollCancel = null;
    }
}

function scrollCurrentChatToTop() {
    cancelPendingBottomChatScroll();

    const chatRoot = getChatScrollElement();
    if (!(chatRoot instanceof HTMLElement)) {
        return;
    }

    chatRoot.scrollTo({
        top: 0,
        behavior: getReducedMotionScrollBehavior(),
    });
}

function scrollCurrentChatToBottom() {
    cancelPendingBottomChatScroll();

    const context = getSillyTavernContext();

    if (typeof context?.scrollChatToBottom === 'function') {
        context.scrollChatToBottom({ force: true });
    }

    const chatRoot = getChatScrollElement();
    sbPendingBottomChatScrollCancel = jumpScrollElementToEdge(chatRoot, 'bottom', {
        settleDelays: DEFAULT_SCROLL_EDGE_SETTLE_DELAYS,
    });
}

function countRegexMatches(value, regex) {
    const text = String(value ?? '');
    if (!text || !(regex instanceof RegExp)) {
        return 0;
    }

    regex.lastIndex = 0;
    return Array.from(text.matchAll(regex)).length;
}

function createChatFileButton(chatFile, currentChatId, onSelect) {
    const button = createElement('button', {
        className: 'sb-chat-file',
        attrs: {
            type: 'button',
        },
    });

    const dateLabel = formatChatTimestamp(chatFile.lastMessage);
    button.classList.toggle('is-current', chatFile.fileName === currentChatId);
    button.innerHTML = `
        <div class="sb-chat-file-head">
            <strong>${describeChatName(chatFile.fileName)}</strong>
            <small>${dateLabel || ''}</small>
        </div>
        <span class="sb-chat-file-preview">${chatFile.preview}</span>
        <div class="sb-chat-file-meta">
            <small>${chatFile.chatItems ? `${chatFile.chatItems} msg` : ''}</small>
            <small>${chatFile.fileSize || ''}</small>
        </div>
    `;

    button.addEventListener('click', () => {
        void onSelect(chatFile.fileName);
    });

    return button;
}

function renderChatFiles(listRoot, files, currentChatId, { emptyTitle = 'No chats yet.', emptyBody = 'Start a chat to see it here.', onSelect } = {}) {
    if (!(listRoot instanceof HTMLElement)) {
        return;
    }

    listRoot.replaceChildren();

    if (!files.length) {
        const empty = createElement('div', { className: 'sb-chat-files-empty' });
        empty.append(createElement('strong', { text: emptyTitle }), createElement('p', { text: emptyBody }));
        listRoot.appendChild(empty);
        return;
    }

    for (const chatFile of files) {
        listRoot.appendChild(createChatFileButton(chatFile, currentChatId, onSelect));
    }
}

function buildChatSidebar() {
    const existingSidebar = getChatSidebarRefs();
    if (existingSidebar) {
        return existingSidebar;
    }

    const template = document.getElementById('generic_draggable_template');
    const movingDivs = document.getElementById('movingDivs');

    if (!(template instanceof HTMLTemplateElement) || !(movingDivs instanceof HTMLElement)) {
        return null;
    }

    const fragment = template.content.cloneNode(true);
    const root = fragment.querySelector('.draggable');
    const title = fragment.querySelector('.dragTitle');
    const closeButton = fragment.querySelector('.dragClose');

    if (!(root instanceof HTMLElement) || !(title instanceof HTMLElement) || !(closeButton instanceof HTMLElement)) {
        return null;
    }

    root.id = 'sb-chat-sidebar';
    root.classList.remove('draggable');
    root.classList.add('sb-chat-sidebar');
    root.style.top = 'calc(var(--sb-topbar-layout-offset) + 18px)';
    root.style.right = '16px';
    root.style.left = 'auto';
    root.style.bottom = 'auto';

    title.textContent = t`Recent Chats`;

    const body = createElement('div', { className: 'sb-chat-sidebar-body' });
    const list = createElement('div', { className: 'sb-chat-sidebar-list' });
    body.appendChild(list);
    root.appendChild(body);

    closeButton.addEventListener('click', () => setChatSidebarOpenState(false));

    movingDivs.appendChild(root);

    const controller = registerSidePanel({
        id: 'sb-chat-sidebar',
        element: root,
        title: t`Recent Chats`,
        defaultSide: 'left',
        onClose: () => { getChatbarState().sidebarOpen = false; },
    });
    getChatbarState().sidebar = { root, title, list, controller };
    return getChatbarState().sidebar;
}

function isChatSidebarOpen() {
    return Boolean(getChatbarState().sidebarOpen);
}

function setChatSidebarOpenState(shouldOpen, { opener = document.activeElement, restoreFocus = false } = {}) {
    const refs = buildChatSidebar();

    if (!refs?.root) {
        return;
    }

    const isOpen = Boolean(shouldOpen);
    getChatbarState().sidebarOpen = isOpen;
    refs.root.classList.toggle('sb-chat-sidebar-visible', isOpen);

    if (isOpen) {
        void refs.controller.open({ opener });
        scheduleChatbarRefresh(0);
    } else {
        refs.controller.close({ restoreFocus });
    }
}

function toggleChatSidebar() {
    const chatContext = getChatUiContext();
    if (!chatContext.canBrowseChats) {
        return;
    }

    setChatSidebarOpenState(!isChatSidebarOpen(), { restoreFocus: true });
}

function getMobileShellSurfaceForShell(shellKey) {
    if (shellKey === 'left') {
        return sbMobileShellLifecycle.overlays.surface.LEFT_SHELL;
    }

    if (shellKey === 'right') {
        return sbMobileShellLifecycle.overlays.surface.RIGHT_SHELL;
    }

    if (shellKey === 'characters') {
        return sbMobileShellLifecycle.overlays.surface.CHARACTER_PANEL;
    }

    return '';
}

function applyMobileSurfaceExclusivity(decision) {
    if (!decision || !Array.isArray(decision.closeSurfaces)) {
        return;
    }

    const surface = sbMobileShellLifecycle.overlays.surface;
    const closeSurface = {
        [surface.LEFT_SHELL]: () => closeShell('left'),
        [surface.RIGHT_SHELL]: () => closeShell('right'),
        [surface.CHARACTER_PANEL]: () => closeCharacterPanel(),
    };

    for (const closeSurfaceKey of decision.closeSurfaces) {
        const close = closeSurface[closeSurfaceKey];
        if (typeof close !== 'function') {
            throw new Error(`Unknown mobile shell surface: ${closeSurfaceKey}`);
        }

        close();
    }
}

function getCurrentMainApiValue() {
    const mainApiSelect = document.getElementById('main_api');
    const context = getSillyTavernContext();

    return sbPresetApiSyncLifecycle.api.resolveMainValue({
        selectValue: mainApiSelect instanceof HTMLSelectElement ? mainApiSelect.value : '',
        contextMainApi: context?.mainApi,
    });
}

function getSearchTerms(query = getChatbarState().searchQuery) {
    return String(query ?? '')
        .trim()
        .split(/\s+/)
        .map(term => term.trim())
        .filter(Boolean);
}

function createChatSearchRegex(terms = getSearchTerms()) {
    if (!terms.length) {
        return null;
    }

    return new RegExp(`(${terms.map(escapeRegex).join('|')})`, 'gi');
}

function addChatSearchTextSegment(segments, value) {
    const normalizedValue = String(value ?? '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (normalizedValue && !segments.includes(normalizedValue)) {
        segments.push(normalizedValue);
    }
}

function getChatSearchMessageText(message) {
    if (!message || typeof message !== 'object') {
        return '';
    }

    const segments = [];

    addChatSearchTextSegment(segments, message.extra?.display_text);
    addChatSearchTextSegment(segments, message.mes);
    addChatSearchTextSegment(segments, message.extra?.reasoning_display_text);
    addChatSearchTextSegment(segments, message.extra?.reasoning);

    return segments.join('\n');
}

function getChatSearchMatches(regex) {
    const context = getSillyTavernContext();
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    const matches = [];
    let totalMatches = 0;

    if (!(regex instanceof RegExp)) {
        return { matches, totalMatches };
    }

    chat.forEach((message, messageId) => {
        const count = countRegexMatches(getChatSearchMessageText(message), regex);
        if (!count) {
            return;
        }

        matches.push({ messageId, count, message });
        totalMatches += count;
    });

    return { matches, totalMatches };
}

function getChatMessageElement(messageId) {
    const chatRoot = getChatScrollElement();
    if (!(chatRoot instanceof HTMLElement) || !Number.isInteger(messageId)) {
        return null;
    }

    return chatRoot.querySelector(`.mes[mesid="${messageId}"]`);
}

async function waitForNextAnimationFrame() {
    await new Promise(resolve => window.requestAnimationFrame(resolve));
}

async function ensureChatMessageRendered(messageId) {
    if (!Number.isInteger(messageId) || messageId < 0) {
        return null;
    }

    let messageElement = getChatMessageElement(messageId);
    if (messageElement instanceof HTMLElement) {
        return messageElement;
    }

    const context = getSillyTavernContext();
    const chatLength = Array.isArray(context?.chat) ? context.chat.length : 0;
    const renderedMessages = Array.from(document.querySelectorAll('#chat .mes[mesid]'));
    const firstRenderedId = Number(renderedMessages.at(0)?.getAttribute('mesid') ?? NaN);
    const lastRenderedId = Number(renderedMessages.at(-1)?.getAttribute('mesid') ?? NaN);
    const chatModule = await getChatScriptModule().catch(() => null);
    const showMoreMessages = typeof context?.showMoreMessages === 'function'
        ? context.showMoreMessages
        : chatModule?.showMoreMessages;
    const showNewerMessages = typeof context?.showNewerMessages === 'function'
        ? context.showNewerMessages
        : chatModule?.showNewerMessages;
    const redisplayChat = typeof context?.redisplayChat === 'function'
        ? context.redisplayChat
        : chatModule?.redisplayChat;

    if (typeof showMoreMessages === 'function' && Number.isInteger(firstRenderedId) && messageId < firstRenderedId) {
        await showMoreMessages(firstRenderedId - messageId);
        await waitForNextAnimationFrame();
        messageElement = getChatMessageElement(messageId);
        if (messageElement instanceof HTMLElement) {
            return messageElement;
        }
    }

    if (typeof showNewerMessages === 'function' && Number.isInteger(lastRenderedId) && messageId > lastRenderedId) {
        await showNewerMessages(messageId - lastRenderedId);
        await waitForNextAnimationFrame();
        messageElement = getChatMessageElement(messageId);
        if (messageElement instanceof HTMLElement) {
            return messageElement;
        }
    }

    if (typeof redisplayChat === 'function' && chatLength > 0) {
        const fallbackStartIndex = Math.max(0, Math.min(messageId, chatLength - 1));
        if (!getChatMessageElement(fallbackStartIndex)) {
            getChatScrollElement()?.querySelectorAll('.mes, #show_more_messages, #show_newer_messages').forEach(element => element.remove());
        }

        await redisplayChat({ startIndex: fallbackStartIndex, fade: false });
        await waitForNextAnimationFrame();
        return getChatMessageElement(messageId);
    }

    return null;
}

function releaseChatSearchApply(chatbarState, applyToken) {
    window.setTimeout(() => {
        if (applyToken === chatbarState.searchApplyToken) {
            chatbarState.isApplyingSearch = false;
        }
    }, 0);
}

function getChatSearchStatusText(totalMatches, renderedMatches) {
    if (!totalMatches) {
        return 'No matches';
    }

    if (renderedMatches > 0 && renderedMatches < totalMatches) {
        return `${renderedMatches}/${totalMatches} visible`;
    }

    if (!renderedMatches) {
        return `${totalMatches} hidden match${totalMatches === 1 ? '' : 'es'}`;
    }

    return `${totalMatches} match${totalMatches === 1 ? '' : 'es'}`;
}

function clearChatSearchHighlights() {
    for (const mark of document.querySelectorAll(SB_CHAT_SEARCH_MARK_SELECTOR)) {
        if (!(mark instanceof HTMLElement) || !mark.parentNode) {
            continue;
        }

        mark.replaceWith(document.createTextNode(mark.textContent ?? ''));
    }

    document.querySelectorAll('#chat .sb-search-hit').forEach(element => {
        element.classList.remove('sb-search-hit');
    });
    document.getElementById('chat')?.normalize();
    setSearchStatusText('');
}

function highlightMessageText(root, regex) {
    if (!(root instanceof HTMLElement)) {
        return { count: 0, firstMatch: null };
    }

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            if (!node.nodeValue?.trim()) {
                return NodeFilter.FILTER_REJECT;
            }

            const parent = node.parentElement;
            if (!parent
                || parent.closest(SB_CHAT_SEARCH_MARK_SELECTOR)
                || parent.closest('.mes_buttons, .extraMesButtons, .mes_edit_buttons, .mes_reasoning_actions, .mes_bias, .mes_avatar, .avatar, .timestamp, .tokenCounterDisplay, .mesIDDisplay, .swipes-counter')) {
                return NodeFilter.FILTER_REJECT;
            }

            return NodeFilter.FILTER_ACCEPT;
        },
    });

    const textNodes = [];
    while (walker.nextNode()) {
        textNodes.push(walker.currentNode);
    }

    let count = 0;
    let firstMatch = null;

    for (const textNode of textNodes) {
        const textValue = textNode.nodeValue ?? '';
        regex.lastIndex = 0;

        if (!regex.test(textValue)) {
            continue;
        }

        regex.lastIndex = 0;
        const fragment = document.createDocumentFragment();
        let previousIndex = 0;

        for (const match of textValue.matchAll(regex)) {
            const matchValue = match[0];
            const matchIndex = match.index ?? 0;

            if (!matchValue) {
                continue;
            }

            fragment.append(textValue.slice(previousIndex, matchIndex));

            const mark = createElement('mark', {
                className: 'sb-chat-search-hit',
                text: matchValue,
                attrs: {
                    'data-sb-chat-search': 'true',
                },
            });

            if (!firstMatch) {
                firstMatch = mark;
            }

            fragment.appendChild(mark);
            previousIndex = matchIndex + matchValue.length;
            count += 1;
        }

        fragment.append(textValue.slice(previousIndex));
        textNode.parentNode?.replaceChild(fragment, textNode);
    }

    return { count, firstMatch };
}

async function applyChatSearchHighlights({ scrollToFirst = false } = {}) {
    const chatbarState = getChatbarState();
    const terms = getSearchTerms();
    const applyToken = ++chatbarState.searchApplyToken;

    chatbarState.pendingSearchScroll = false;
    clearTimeout(chatbarState.searchTimer);
    chatbarState.isApplyingSearch = true;
    clearChatSearchHighlights();

    if (!terms.length || !getChatUiContext().hasChat) {
        chatbarState.isApplyingSearch = false;
        return;
    }

    const regex = createChatSearchRegex(terms);
    if (!(regex instanceof RegExp)) {
        chatbarState.isApplyingSearch = false;
        return;
    }

    const searchMatches = getChatSearchMatches(regex);
    const firstMatchId = searchMatches.matches[0]?.messageId;

    if (scrollToFirst && Number.isInteger(firstMatchId)) {
        setSearchStatusText('Loading match…');

        try {
            await ensureChatMessageRendered(firstMatchId);
        } catch (error) {
            console.warn('[SillyBunny] Failed to reveal chat search match.', error);
        }

        if (applyToken !== chatbarState.searchApplyToken) {
            chatbarState.isApplyingSearch = false;
            return;
        }
    }

    let renderedMatches = 0;
    let firstMatch = null;

    try {
        for (const node of document.querySelectorAll('#chat .mes_text')) {
            const result = highlightMessageText(node, regex);
            renderedMatches += result.count;
            firstMatch ??= result.firstMatch;
        }
    } finally {
        releaseChatSearchApply(chatbarState, applyToken);
    }

    const totalMatches = Math.max(searchMatches.totalMatches, renderedMatches);
    setSearchStatusText(getChatSearchStatusText(totalMatches, renderedMatches));

    if (scrollToFirst && firstMatch instanceof HTMLElement) {
        scrollElementIntoManagedView(firstMatch, {
            block: 'center',
            behavior: getReducedMotionScrollBehavior(),
        });
    } else if (scrollToFirst && Number.isInteger(firstMatchId)) {
        const messageElement = getChatMessageElement(firstMatchId);
        if (messageElement instanceof HTMLElement) {
            messageElement.classList.add('sb-search-hit');
            window.setTimeout(() => messageElement.classList.remove('sb-search-hit'), 2400);
            scrollElementIntoManagedView(messageElement, {
                block: 'center',
                behavior: getReducedMotionScrollBehavior(),
            });
        }
    }
}

function scheduleChatSearchHighlight({ scrollToFirst = false } = {}) {
    const chatbarState = getChatbarState();
    chatbarState.pendingSearchScroll = chatbarState.pendingSearchScroll || scrollToFirst;

    clearTimeout(chatbarState.searchTimer);
    chatbarState.searchTimer = window.setTimeout(() => {
        const shouldScroll = chatbarState.pendingSearchScroll;
        chatbarState.pendingSearchScroll = false;
        void applyChatSearchHighlights({ scrollToFirst: shouldScroll });
    }, SB_CHATBAR_SEARCH_DEBOUNCE);
}

function setChatSearchQuery(value, { source = null } = {}) {
    const nextValue = String(value ?? '');
    const chatbarState = getChatbarState();

    chatbarState.searchQuery = nextValue;
    chatbarState.searchApplyToken += 1;

    const input = getBottomChatBarState()?.searchInput;
    if (input instanceof HTMLInputElement && input !== source) {
        input.value = nextValue;
    }

    if (!nextValue.trim()) {
        clearTimeout(chatbarState.searchTimer);
        chatbarState.pendingSearchScroll = false;
        chatbarState.isApplyingSearch = false;
        clearChatSearchHighlights();
        return;
    }

    scheduleChatSearchHighlight({ scrollToFirst: true });
}

function createBottomChatButton({ icon, title, className = '' }, onClick) {
    const button = createElement('button', {
        className: `sb-bottom-chat-btn ${className}`.trim(),
        attrs: {
            type: 'button',
            title,
            'aria-label': title,
        },
    });

    button.innerHTML = `<i class="fa-solid ${icon}" aria-hidden="true"></i>`;
    button.addEventListener('click', debounceAction(onClick));

    return button;
}

function createBottomChatSearchField() {
    const field = createElement('label', {
        id: 'sb-bottom-chat-search-field',
        className: 'sb-bottom-chat-search-field',
        attrs: {
            title: 'Search all messages in this chat, including hidden messages',
        },
    });
    const icon = createElement('i', {
        className: 'fa-solid fa-magnifying-glass',
        attrs: {
            'aria-hidden': 'true',
        },
    });
    const input = createElement('input', {
        id: 'sb-bottom-chat-search',
        className: 'text_pole',
        attrs: {
            type: 'search',
            placeholder: 'Search chat…',
            'aria-label': 'Search All Messages in This Chat',
            autocomplete: 'off',
            spellcheck: 'false',
        },
    });
    const status = createElement('small', { className: 'sb-chatbar-search-status sb-bottom-chat-search-status' });

    input.value = getChatbarState().searchQuery;
    status.hidden = true;
    field.append(icon, input, status);
    input.addEventListener('input', () => setChatSearchQuery(input.value, { source: input }));

    return { field, input, status };
}

function setBottomChatButtonIcon(button, iconClass) {
    if (!(button instanceof HTMLElement)) {
        return;
    }

    const icon = button.querySelector('i');
    if (icon instanceof HTMLElement) {
        icon.className = `fa-solid ${iconClass}`;
    }
}

function syncBottomChatBarSecondaryState() {
    const bottomChatBarState = getBottomChatBarState();
    const container = document.getElementById('sb-bottom-chat-bar');
    const isOpen = Boolean(bottomChatBarState.secondaryOpen);
    const isHiddenOnMobile = !isOpen && isMobileViewport();

    container?.classList.toggle('sb-bottom-chat-secondary-collapsed', !isOpen);

    if (bottomChatBarState.secondaryRow instanceof HTMLElement) {
        bottomChatBarState.secondaryRow.hidden = isHiddenOnMobile;
    }

    const button = bottomChatBarState.collapseToggleButton;
    if (button instanceof HTMLElement) {
        const title = isOpen ? 'Hide Chat Actions' : 'Show Chat Actions';

        button.title = title;
        button.setAttribute('aria-label', title);
        button.setAttribute('aria-expanded', String(isOpen));
        setBottomChatButtonIcon(button, isOpen ? 'fa-chevron-up' : 'fa-chevron-down');
    }
}

function syncBottomChatBarSearchState({ focusInput = false } = {}) {
    const bottomChatBarState = getBottomChatBarState();
    const container = document.getElementById('sb-bottom-chat-bar');
    const isOpen = Boolean(bottomChatBarState.searchOpen);
    const isMobileHidden = !isOpen && isMobileViewport();

    container?.classList.toggle('sb-bottom-chat-search-open', isOpen);

    if (bottomChatBarState.searchField instanceof HTMLElement) {
        bottomChatBarState.searchField.hidden = isMobileHidden;
    }

    if (bottomChatBarState.searchInput instanceof HTMLElement) {
        if (isMobileHidden) {
            bottomChatBarState.searchInput.setAttribute('tabindex', '-1');
        } else {
            bottomChatBarState.searchInput.removeAttribute('tabindex');
        }
    }

    const button = bottomChatBarState.searchToggleButton;
    if (button instanceof HTMLElement) {
        const title = isOpen ? 'Hide Chat Search' : 'Search Chat';

        button.title = title;
        button.setAttribute('aria-label', title);
        setButtonPressed(button, isOpen);
    }

    if (focusInput && isOpen && bottomChatBarState.searchInput instanceof HTMLInputElement) {
        window.requestAnimationFrame(() => {
            bottomChatBarState.searchInput.focus({ preventScroll: true });
            bottomChatBarState.searchInput.select();
        });
    }
}

function setBottomChatSecondaryOpen(open, { focusSearch = false } = {}) {
    const bottomChatBarState = getBottomChatBarState();
    const searchInput = bottomChatBarState.searchInput;

    bottomChatBarState.secondaryOpen = Boolean(open);
    safeSetItem(SB_STORAGE_KEYS.bottomChatSecondaryOpen, String(bottomChatBarState.secondaryOpen));
    if (!bottomChatBarState.secondaryOpen) {
        bottomChatBarState.searchOpen = false;
        if (searchInput instanceof HTMLElement && searchInput === document.activeElement) {
            searchInput.blur();
        }
    } else if (focusSearch) {
        bottomChatBarState.searchOpen = true;
    }

    syncBottomChatBarSecondaryState();
    syncBottomChatBarSearchState({ focusInput: focusSearch });
}

function setBottomChatSearchOpen(open, { focusInput = false } = {}) {
    const bottomChatBarState = getBottomChatBarState();
    const searchInput = bottomChatBarState.searchInput;

    bottomChatBarState.searchOpen = Boolean(open);
    if (bottomChatBarState.searchOpen && !bottomChatBarState.secondaryOpen) {
        bottomChatBarState.secondaryOpen = true;
    } else if (!bottomChatBarState.searchOpen && searchInput instanceof HTMLElement && searchInput === document.activeElement) {
        searchInput.blur();
    }

    syncBottomChatBarSecondaryState();
    syncBottomChatBarSearchState({ focusInput });
}

function initChatSearchObserver() {
    const chatRoot = document.getElementById('chat');

    if (!(chatRoot instanceof HTMLElement) || getChatbarState().chatObserver) {
        return;
    }

    const observer = new MutationObserver(() => {
        if (getChatbarState().isApplyingSearch || !getSearchTerms().length) {
            return;
        }

        scheduleChatSearchHighlight({ scrollToFirst: false });
    });

    observer.observe(chatRoot, { childList: true, subtree: true });
    getChatbarState().chatObserver = observer;
}

async function refreshChatbarState() {
    const chatbarState = getChatbarState();
    const refreshToken = ++chatbarState.refreshToken;

    const chatContext = getChatUiContext();
    const files = await getChatFilesForContext(chatContext);

    if (refreshToken !== chatbarState.refreshToken) {
        return;
    }

    const chatNames = files.map(chat => chat.fileName);

    if (chatContext.chatId && !chatNames.includes(chatContext.chatId)) {
        files.unshift(normalizeChatInfo(chatContext.chatId));
    }

    renderChatFiles(getChatSidebarRefs()?.list, files, chatContext.chatId, {
        onSelect: chatId => openChatById(chatId),
    });

    if (!chatContext.canBrowseChats) {
        setChatSidebarOpenState(false);
    }

    if (!chatContext.hasChat) {
        clearChatSearchHighlights();
    } else if (getSearchTerms().length) {
        scheduleChatSearchHighlight({ scrollToFirst: false });
    }
}

function scheduleChatbarRefresh(delay = 0) {
    const chatbarState = getChatbarState();
    const safeDelay = Math.max(0, Number(delay) || 0);

    window.clearTimeout(chatbarState.refreshTimer);
    chatbarState.refreshTimer = window.setTimeout(() => {
        chatbarState.refreshTimer = 0;
        void refreshChatbarState().catch(error => {
            console.warn('[SillyBunny] Failed to refresh chat tools state.', error);
        });
    }, safeDelay);
}

function scheduleChatbarBindingRetry(delay = 240) {
    const chatbarState = getChatbarState();

    window.clearTimeout(chatbarState.bindingRetryTimer);
    chatbarState.bindingRetryTimer = window.setTimeout(() => {
        bindChatbarEvents();
    }, delay);
}

function bindChatbarWindowEvents() {
    const chatbarState = getChatbarState();

    if (chatbarState.windowBindingsAttached) {
        return;
    }

    const refreshWithContext = () => {
        window.requestAnimationFrame(() => scheduleChatbarRefresh(0));
        bindChatbarEvents();
    };

    window.addEventListener('pageshow', refreshWithContext, { passive: true });
    window.addEventListener('focus', refreshWithContext, { passive: true });
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
            refreshWithContext();
        }
    });

    chatbarState.windowBindingsAttached = true;
}

function bindChatbarEvents() {
    const chatbarState = getChatbarState();
    const context = getSillyTavernContext();
    const eventSource = context?.eventSource;
    const eventTypes = context?.eventTypes ?? context?.event_types;

    bindChatbarWindowEvents();
    initChatSearchObserver();

    if (!eventSource || !eventTypes) {
        scheduleChatbarRefresh(0);
        scheduleChatbarBindingRetry();
        return;
    }

    window.clearTimeout(chatbarState.bindingRetryTimer);

    if (chatbarState.boundEventSource === eventSource) {
        scheduleChatbarRefresh(0);
        return;
    }

    const refresh = () => scheduleChatbarRefresh(0);
    const events = [
        eventTypes.APP_READY,
        eventTypes.CHAT_CHANGED,
        eventTypes.CHAT_LOADED,
        eventTypes.CHAT_CREATED,
        eventTypes.GROUP_CHAT_CREATED,
        eventTypes.CHAT_DELETED,
        eventTypes.GROUP_CHAT_DELETED,
        eventTypes.MESSAGE_RECEIVED,
        eventTypes.MESSAGE_UPDATED,
        eventTypes.MESSAGE_EDITED,
        eventTypes.MESSAGE_DELETED,
        eventTypes.MESSAGE_SWIPED,
        eventTypes.MESSAGE_SWIPE_DELETED,
        eventTypes.CONNECTION_PROFILE_LOADED,
        eventTypes.CONNECTION_PROFILE_CREATED,
        eventTypes.CONNECTION_PROFILE_UPDATED,
        eventTypes.CONNECTION_PROFILE_DELETED,
        eventTypes.MAIN_API_CHANGED,
        eventTypes.ONLINE_STATUS_CHANGED,
        eventTypes.SETTINGS_UPDATED,
    ].filter(Boolean);

    for (const eventName of new Set(events)) {
        eventSource.on(eventName, refresh);
    }

    chatbarState.boundEventSource = eventSource;
    scheduleChatbarRefresh(0);
}

function getCanonicalTopSettingsHolder() {
    return Array.from(document.querySelectorAll('#top-settings-holder'))
        .find(element => element instanceof HTMLElement && element.parentElement === document.body)
        ?? document.getElementById('top-settings-holder');
}

function getCharacterDrawerHost() {
    const topSettingsHolder = getCanonicalTopSettingsHolder();
    const hosts = Array.from(document.querySelectorAll('#rightNavHolder')).filter(element => element instanceof HTMLElement);
    const host = hosts.find(element => element.classList.contains('sb-drawer-host') && element.closest('#top-settings-holder') === topSettingsHolder)
        ?? hosts.find(element => element.classList.contains('sb-drawer-host'))
        ?? hosts.find(element => element.closest('#top-settings-holder') === topSettingsHolder)
        ?? document.getElementById('rightNavHolder');

    if (host instanceof HTMLElement && topSettingsHolder instanceof HTMLElement && host.parentElement === topSettingsHolder && topSettingsHolder.firstElementChild !== host) {
        topSettingsHolder.insertBefore(host, topSettingsHolder.firstElementChild);
    }

    return host instanceof HTMLElement ? host : null;
}

function getCharacterPanel() {
    const panel = getCharacterDrawerHost()?.querySelector(':scope > #right-nav-panel')
        ?? document.querySelector('#right-nav-panel.sb-character-drawer-root')
        ?? document.getElementById('right-nav-panel');

    return panel instanceof HTMLElement ? panel : null;
}

function getDrawerRoot(drawerRootOrId) {
    if (drawerRootOrId === 'right-nav-panel') {
        return getCharacterPanel();
    }

    return typeof drawerRootOrId === 'string'
        ? document.getElementById(drawerRootOrId)
        : drawerRootOrId;
}

function getDrawerIcon(drawerIconOrSelector) {
    if (typeof drawerIconOrSelector === 'string') {
        return document.querySelector(drawerIconOrSelector);
    }

    return drawerIconOrSelector;
}

function syncDrawerIconState(drawerIconOrSelector, shouldOpen) {
    const icon = getDrawerIcon(drawerIconOrSelector);

    if (!(icon instanceof HTMLElement)) {
        return;
    }

    icon.classList.toggle('openIcon', Boolean(shouldOpen));
    icon.classList.toggle('closedIcon', !shouldOpen);
}

function isDrawerActuallyOpen(drawerRootOrId) {
    const el = getDrawerRoot(drawerRootOrId);

    if (!(el instanceof HTMLElement) || !el.classList.contains('openDrawer')) {
        return false;
    }

    const styles = getComputedStyle(el);
    return styles.display !== 'none'
        && styles.visibility !== 'hidden'
        && styles.pointerEvents !== 'none'
        && el.getClientRects().length > 0;
}

function getMobileModalRootCandidates() {
    return [
        document.getElementById(getShellConfig('left').rootPanelId),
        document.getElementById(getShellConfig('right').rootPanelId),
        getCharacterPanel(),
    ].filter(element => element instanceof HTMLElement);
}

function isMobileModalRootOpen(root) {
    if (!(root instanceof HTMLElement)) {
        return false;
    }

    return isDrawerActuallyOpen(root);
}

function getActiveMobileModalRoots() {
    if (!isMobileViewport()) {
        return [];
    }

    return getMobileModalRootCandidates().filter(root => isMobileModalRootOpen(root));
}

function setElementInertForMobileModal(element, shouldInert) {
    if (!(element instanceof HTMLElement)) {
        return;
    }

    if (shouldInert) {
        if (!element.hasAttribute('data-sb-mobile-modal-prev-aria-hidden')) {
            element.setAttribute(
                'data-sb-mobile-modal-prev-aria-hidden',
                element.getAttribute('aria-hidden') ?? '',
            );
        }

        element.setAttribute('aria-hidden', 'true');
        if ('inert' in element) {
            element.inert = true;
        }
        return;
    }

    const previousAriaHidden = element.getAttribute('data-sb-mobile-modal-prev-aria-hidden');
    if (previousAriaHidden !== null) {
        if (previousAriaHidden) {
            element.setAttribute('aria-hidden', previousAriaHidden);
        } else {
            element.removeAttribute('aria-hidden');
        }
        element.removeAttribute('data-sb-mobile-modal-prev-aria-hidden');
    }

    if ('inert' in element) {
        element.inert = false;
    }
}

function setMobileModalRootA11y(root, isActiveRoot) {
    if (!(root instanceof HTMLElement)) {
        return;
    }

    if (isActiveRoot) {
        if (!root.hasAttribute('data-sb-mobile-modal-root-prev-aria-hidden')) {
            root.setAttribute(
                'data-sb-mobile-modal-root-prev-aria-hidden',
                root.getAttribute('aria-hidden') ?? '',
            );
        }

        root.setAttribute('aria-hidden', 'false');
        if ('inert' in root) {
            root.inert = false;
        }
        return;
    }

    const previousAriaHidden = root.getAttribute('data-sb-mobile-modal-root-prev-aria-hidden');
    if (previousAriaHidden !== null) {
        if (previousAriaHidden) {
            root.setAttribute('aria-hidden', previousAriaHidden);
        } else {
            root.removeAttribute('aria-hidden');
        }
        root.removeAttribute('data-sb-mobile-modal-root-prev-aria-hidden');
    }
}

function syncMobileModalState() {
    const activeRoots = getActiveMobileModalRoots();
    const activeRootSet = new Set(activeRoots);
    const modalState = sbMobileShellLifecycle.modal.resolveA11yState({
        activeRootIds: activeRoots.map(root => root.id),
    });

    document.body?.classList.toggle('sb-mobile-modal-open', modalState.hasActiveMobileModal);

    for (const root of getMobileModalRootCandidates()) {
        setMobileModalRootA11y(root, activeRootSet.has(root));
    }

    // SillyBunny: only the chat is inerted. Mobile panels dock below the top bar instead of
    // covering it, so its proxy buttons stay reachable and re-tapping one closes the panel,
    // same as on desktop. The full-screen settings page covers the chat (and Home, which lives in it)
    // at every width, so Tab, a screen reader and a click must not reach what it hides.
    // The state flag, not the page's `hidden`, ends the inert at the start of a close: a caller that closes the page and focuses the
    // composer in the same turn (the chat archive does) must find it live while the page still fades out over it.
    setElementInertForMobileModal(document.getElementById('sheld'), modalState.shouldInertShell || sbSettingsState.open);
}

function queueMobileModalStateSync() {
    if (sbState.mobileModal.syncFrame) {
        return;
    }

    sbState.mobileModal.syncFrame = window.requestAnimationFrame(() => {
        sbState.mobileModal.syncFrame = 0;
        syncMobileModalState();
    });
}

function syncTopbarSectionButtonStates() {
    syncCharacterTopbarButtonState();
}

function queueTopbarSectionStateSync() {
    if (sbState.topbarSections.syncFrame) {
        return;
    }

    sbState.topbarSections.syncFrame = window.requestAnimationFrame(() => {
        sbState.topbarSections.syncFrame = 0;
        syncTopbarSectionButtonStates();
    });
}

function isShellOpen(shellKey) {
    return isSettingsPageHosting(shellKey);
}

function isShellTabOpen(shellKey, tabId) {
    const shellState = getShellState(shellKey);
    return Boolean(shellState && isShellOpen(shellKey) && shellState.activeTabId === tabId);
}

function isCharacterPanelOpen() {
    return isSettingsPageHosting('characters');
}

function hasActiveCharacterChat(context = getSillyTavernContext()) {
    if (context?.groupId) {
        return true;
    }

    return Boolean(
        context
        && context.characterId !== undefined
        && context.characterId !== null
        && context.characters?.[context.characterId],
    );
}

async function setCharacterListEntityView(view) {
    const [state, script] = await Promise.all([
        import('./sillybunny-character-list-state.js'),
        import('../script.js'),
    ]);
    // SillyBunny: replace Back's upstream menu state without its extra render.
    script.setMenuType('characters');
    await state.switchCharacterListView(view, { render: false });
}

function syncCharacterListControls(view) {
    const normalizedView = view === 'groups' ? 'groups' : 'characters';
    const createCharacterButton = document.getElementById('rm_button_create');
    const createGroupButton = document.getElementById('rm_button_group_chats');
    const bulkEditButton = document.getElementById('bulkEditButton');
    const bulkSelectAllButton = document.getElementById('bulkSelectAllButton');
    const bulkDeleteButton = document.getElementById('bulkDeleteButton');

    if (createCharacterButton instanceof HTMLElement) {
        createCharacterButton.hidden = normalizedView === 'groups';
    }

    if (createGroupButton instanceof HTMLElement) {
        createGroupButton.hidden = normalizedView !== 'groups';
    }

    for (const button of [bulkEditButton, bulkSelectAllButton, bulkDeleteButton]) {
        if (button instanceof HTMLElement) {
            button.hidden = false;
        }
    }

    for (const actionId of ['character_context_menu_favorite', 'character_context_menu_duplicate', 'character_context_menu_persona']) {
        const action = document.getElementById(actionId)?.closest('li');
        if (action instanceof HTMLElement) {
            action.hidden = normalizedView === 'groups';
        }
    }

    if (bulkEditButton instanceof HTMLElement) {
        bulkEditButton.title = normalizedView === 'groups'
            ? 'Bulk Actions for Group Chats'
            : 'Bulk edit characters\n\nClick to toggle characters\nShift + Click to select/deselect a range of characters\nRight-click for actions';
    }
}

let characterListViewPromise = null;
let characterListViewRevision = 0;

function showCharacterListView(view = 'characters') {
    characterListViewPromise = revealCharacterListView(view, ++characterListViewRevision);
    return characterListViewPromise;
}

async function revealCharacterListView(view, revision) {
    setCharacterEditorEmptyState(false);
    setCharacterPersonaPanelVisible(false);
    setCharacterImportPanelVisible(false);
    setCharacterWorldInfoPanelVisible(false);
    const panel = getCharacterPanel();
    const normalizedView = view === 'groups' ? 'groups' : 'characters';
    sbState.characterDrawer.lastTab = normalizedView;

    setCharacterPanelMenuType(panel, normalizedView);

    syncCharacterListControls(normalizedView);
    const listController = await mountCharacterListController();
    if (revision !== characterListViewRevision) return false;
    await setCharacterListEntityView(normalizedView);
    if (revision !== characterListViewRevision) return false;

    // SillyBunny: list navigation has one render and no synthetic upstream Back refresh.
    for (const id of ['result_info', 'rm_PinAndTabs', 'rm_ch_create_block', 'rm_group_chats_block']) {
        const element = document.getElementById(id);
        if (!(element instanceof HTMLElement)) continue;
        element.classList.remove('sb-active-right-menu');
        element.style.display = 'none';
        element.style.visibility = 'hidden';
        element.style.pointerEvents = 'none';
    }
    const list = document.getElementById('rm_characters_block');
    if (list instanceof HTMLElement) {
        list.classList.add('sb-active-right-menu');
        list.style.display = 'flex';
        list.style.opacity = '1';
        list.style.visibility = 'visible';
        list.style.pointerEvents = 'auto';
    }
    setCharacterPanelMenuType(panel, normalizedView);
    syncCharacterListControls(normalizedView);
    syncCharacterShellTabs(normalizedView);
    await listController.revealActiveEntity(() => revision === characterListViewRevision);
    return true;
}

function showCharacterEditorEmptyState() {
    const panel = getCharacterPanel();
    const infoPanel = document.getElementById('result_info');
    const pinAndTabs = document.getElementById('rm_PinAndTabs');
    const characterEditor = document.getElementById('rm_ch_create_block');
    const groupEditor = document.getElementById('rm_group_chats_block');
    const characterList = document.getElementById('rm_characters_block');

    setCharacterPanelMenuType(panel, 'editor_empty');
    setCharacterPersonaPanelVisible(false);
    setCharacterImportPanelVisible(false);
    setCharacterWorldInfoPanelVisible(false);
    syncCharacterListControls('characters');
    setCharacterEditorEmptyState(true);

    if (infoPanel instanceof HTMLElement) {
        infoPanel.style.display = 'none';
    }

    if (pinAndTabs instanceof HTMLElement) {
        pinAndTabs.style.display = 'none';
    }

    if (characterEditor instanceof HTMLElement) {
        characterEditor.classList.remove('sb-active-right-menu');
        characterEditor.style.display = 'none';
        characterEditor.style.visibility = 'hidden';
        characterEditor.style.pointerEvents = 'none';
    }

    if (groupEditor instanceof HTMLElement) {
        groupEditor.classList.remove('sb-active-right-menu');
        groupEditor.style.display = 'none';
        groupEditor.style.visibility = 'hidden';
        groupEditor.style.pointerEvents = 'none';
    }

    if (characterList instanceof HTMLElement) {
        characterList.classList.remove('sb-active-right-menu');
        characterList.style.display = 'none';
        characterList.style.visibility = 'hidden';
        characterList.style.pointerEvents = 'none';
    }

    syncCharacterShellTabs('editor');
}

function setCharacterEditorEmptyState(visible) {
    let emptyState = document.getElementById('sb_character_editor_empty');

    if (emptyState instanceof HTMLElement) {
        if (!emptyState.classList.contains('sb-status-page')) {
            // The page in the markup is replaced by the shared one, which keeps its id and the id of its one button. The list's New action creates.
            const page = createStatusPage({
                state: 'empty',
                icon: 'address-card',
                // HUMAN: replace — a title in header capitalisation that names the state, and a description that says what to do next.
                title: t`No Character Selected`,
                description: t`Please pick a character card from the character menu, or create a new character`,
                compact: true,
                actions: [
                    { id: 'sb_character_empty_browse', label: t`Browse Characters`, primary: true, onActivate: () => { void showCharacterListView(); } },
                ],
            });
            page.element.id = emptyState.id;
            emptyState.replaceWith(page.element);
            emptyState = page.element;
        }
        emptyState.hidden = !visible;
    }

    syncCharacterTitlebarVisibility();
}

function syncCharacterTitlebarVisibility() {
    const panel = getCharacterPanel();
    const pinAndTabs = document.getElementById('rm_PinAndTabs');

    if (!(panel instanceof HTMLElement) || !(pinAndTabs instanceof HTMLElement)) {
        return;
    }

    const shouldHide = ['characters', 'groups', 'editor_empty', 'world-info', 'persona', 'import', 'conversation'].includes(panel.dataset.menuType ?? '');
    pinAndTabs.style.display = shouldHide ? 'none' : '';
}

function ensureCharacterPersonaPanel() {
    const host = document.getElementById('sb_character_persona_panel');
    const drawer = document.getElementById('persona-management-button');
    const content = document.getElementById('PersonaManagement');

    if (!(host instanceof HTMLElement) || !(drawer instanceof HTMLElement) || !(content instanceof HTMLElement)) {
        return null;
    }

    drawer.classList.add('sb-embedded-drawer');
    drawer.querySelector(':scope > .drawer-toggle')?.classList.add('sb-hidden-toggle');
    content.classList.remove('drawer-content', 'openDrawer', 'closedDrawer', 'fillLeft', 'fillRight', 'pinnedOpen');
    content.classList.add('sb-managed', 'sb-shell-embedded-content');
    content.removeAttribute('style');

    if (drawer.parentElement !== host) {
        host.appendChild(drawer);
    }

    return host;
}

function ensureCharacterWorldInfoPanel() {
    const host = document.getElementById('sb_character_world_info_panel');
    const drawer = document.getElementById('WI-SP-button');
    const content = document.getElementById('WorldInfo');

    if (!(host instanceof HTMLElement) || !(drawer instanceof HTMLElement) || !(content instanceof HTMLElement)) {
        return null;
    }

    host.setAttribute('role', 'tabpanel');
    host.setAttribute('aria-labelledby', 'sb_character_tab_world_info');
    drawer.classList.add('sb-embedded-drawer');
    drawer.querySelector(':scope > .drawer-toggle')?.classList.add('sb-hidden-toggle');
    content.classList.remove('drawer-content', 'openDrawer', 'closedDrawer', 'fillLeft', 'fillRight', 'pinnedOpen');
    content.classList.add('sb-managed', 'sb-shell-embedded-content');
    content.removeAttribute('style');
    content.removeAttribute('data-dragged');
    content.setAttribute('role', 'tabpanel');
    content.setAttribute('aria-labelledby', 'sb_character_tab_world_info');
    content.setAttribute('aria-hidden', String(host.hidden));

    if (drawer.parentElement !== host) {
        host.appendChild(drawer);
    }

    drawer.querySelector('#WI_panel_pin_div')?.classList.add('sb-shell-hidden-control');
    return host;
}

// SillyBunny: lazy-mount the persona editor only after its deferred styles load
let personaEditorMountPromise = null;
let characterListMountPromise = null;
let characterPanelRevealPromise = null;
const deferredCharacterPanels = new WeakMap();

function hideDeferredCharacterPanel(host, content = host, { preserveLayout = false } = {}) {
    if (!(host instanceof HTMLElement)) return;
    const state = deferredCharacterPanels.get(host);
    if (state) {
        state.requested = false;
        state.revision++;
        dismissCharacterPanelStatus(state);
    }
    if (!preserveLayout) host.hidden = true;
    host.setAttribute('aria-hidden', 'true');
    content?.setAttribute('aria-hidden', 'true');
}

function dismissCharacterPanelStatus(state) {
    state.status?.release();
    state.status?.element.remove();
    state.status = null;
}

// A whole string for each panel, never one built from parts, so a translation keeps its word order.
function getDeferredPanelLoadingTitle(panelId) {
    const titles = {
        'world-info': t`Loading World Info`,
        persona: t`Loading Personas`,
    };
    return titles[panelId] ?? t`Loading Page`;
}

function revealDeferredCharacterPanel(host, content, mount, panelId) {
    if (!(host instanceof HTMLElement)) return Promise.resolve(false);
    let state = deferredCharacterPanels.get(host);
    if (!state) {
        state = { status: null, revision: 0, requested: false, reveal: null };
        deferredCharacterPanels.set(host, state);
    }
    if (state.requested) return state.reveal;
    hideDeferredCharacterPanel(host, content);
    state.requested = true;
    const revision = ++state.revision;
    // A fast load shows no loading page, because the page waits like any other. This one keeps its place meanwhile, so that
    // no frame between the old panel and the new one is empty.
    const status = createStatusPage({ state: 'loading', title: getDeferredPanelLoadingTitle(panelId), reserveSpace: true, busy: host });
    status.element.classList.add('sb-character-panel-loading');
    host.after(status.element);
    state.status = status;
    const isCurrent = () => state.requested && state.revision === revision;
    state.reveal = (async () => {
        const controller = await mount();
        await controller?.ready;
        if (!controller || !isCurrent()) return false;
        await controller.prepareReveal?.();
        if (!isCurrent()) return false;
        dismissCharacterPanelStatus(state);
        host.hidden = false;
        host.setAttribute('aria-hidden', 'false');
        content?.setAttribute('aria-hidden', 'false');
        controller.onReveal?.();
        return controller;
    })().catch(error => {
        if (isCurrent()) {
            state.requested = false;
            // HUMAN: add — a description of what to do next.
            status.update({ state: 'error', title: t`Page Not Loaded` });
        }
        throw error;
    });
    state.reveal.catch(error => console.warn('[SillyBunny] Could not reveal the character panel.', error));
    return state.reveal;
}

async function mountCharacterListController() {
    characterListMountPromise ??= import('./sillybunny-character-list.js')
        .then(module => module.mountCharacterList(undefined, { render: false, getNavigationGeneration: getCharacterListNavigationGeneration }))
        .catch(error => {
            characterListMountPromise = null;
            console.warn('[SillyBunny] Could not mount the character list.', error);
            throw error;
        });
    return characterListMountPromise;
}

function getCharacterListNavigationGeneration() {
    // SillyBunny: authoritative page and character-tab revisions exclude close-animation cleanup.
    return `${sbSettingsState.closeGen}:${characterListViewRevision}`;
}
function setCharacterPersonaPanelVisible(visible) {
    const host = visible ? ensureCharacterPersonaPanel() : document.getElementById('sb_character_persona_panel');
    const content = document.getElementById('PersonaManagement');
    if (!visible) return hideDeferredCharacterPanel(host, content);
    characterPanelRevealPromise = revealDeferredCharacterPanel(host, content, () => {
        personaEditorMountPromise ??= import('./sillybunny-persona-editor.js').then(async module => {
            await module.loadPersonaEditorStyles(SB_PANEL_STYLESHEETS['characters:persona']);
            const controller = module.mountPersonaEditor(content);
            await controller.ready;
            return controller;
        }).catch(error => {
            personaEditorMountPromise = null;
            throw error;
        });
        return personaEditorMountPromise;
    }, 'persona');
    return characterPanelRevealPromise;
}

let characterImportMountPromise = null;
function setCharacterImportPanelVisible(visible) {
    const host = document.getElementById('sb_character_import_panel');
    if (!visible) return hideDeferredCharacterPanel(host);
    characterPanelRevealPromise = revealDeferredCharacterPanel(host, host, () => {
        characterImportMountPromise ??= import('./sillybunny-character-import.js').then(async module => {
            await module.loadCharacterImportStyles(SB_PANEL_STYLESHEETS['characters:import']);
            const controller = module.mountCharacterImport(host);
            await controller.ready;
            return controller;
        }).catch(error => {
            characterImportMountPromise = null;
            throw error;
        });
        return characterImportMountPromise;
    });
    return characterPanelRevealPromise;
}

// SillyBunny: defer the rebuilt editor and its styles until this tab is first requested.
let worldInfoEditorMountPromise = null;
function setCharacterWorldInfoPanelVisible(visible, { preserveLayout = false } = {}) {
    const host = visible ? ensureCharacterWorldInfoPanel() : document.getElementById('sb_character_world_info_panel');
    const content = document.getElementById('WorldInfo');
    if (!visible) return hideDeferredCharacterPanel(host, content, { preserveLayout });
    characterPanelRevealPromise = revealDeferredCharacterPanel(host, content, () => {
        worldInfoEditorMountPromise ??= import('./sillybunny-world-info-editor.js').then(async module => {
            await Promise.all(SB_PANEL_STYLESHEETS['characters:world-info'].map(stylesheet =>
                window.SillyBunnyAssets?.loadStylesheetAsync(stylesheet.href, { id: stylesheet.id })));
            const controller = module.mountWorldInfoEditor(content);
            await controller.ready;
            return controller;
        }).catch(error => {
            worldInfoEditorMountPromise = null;
            throw error;
        });
        return worldInfoEditorMountPromise;
    }, 'world-info');
    return characterPanelRevealPromise;
}

function setCharacterPanelMenuType(panel, menuType) {
    if (!(panel instanceof HTMLElement)) {
        return;
    }

    panel.dataset.menuType = menuType;
    if (panel.dataset.menuType !== menuType) {
        panel.setAttribute('data-menu-type', menuType);
    }
}

function isVisibleCharacterDrawerEscapeControl(element) {
    return element instanceof HTMLElement
        && isActuallyVisible(element)
        && !element.closest('[hidden], [aria-hidden="true"], [inert]');
}

function shouldDeferCharacterDrawerEscape(event, panel) {
    if (event.defaultPrevented || event.isComposing) {
        return true;
    }

    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('dialog[open], [role="dialog"], .popup, .popover, .sb-conversation-picker, .sb-conversation-status-picker')) {
        return true;
    }

    if (target?.closest('input, textarea, select, [contenteditable="true"]')
        && target !== panel
        && !target.closest('.sb-shell-close')) {
        return true;
    }

    return [
        '#curEditTextarea',
        '.reasoning_edit_textarea',
        '#mes_stop',
        '#dialogue_popup',
        '#select_chat_popup',
        '#dialogue_del_mes',
        '#floatingPrompt',
        '#cfgConfig',
        '#logprobsViewer',
    ].some(selector => isVisibleCharacterDrawerEscapeControl(document.querySelector(selector)));
}

function bindCharacterDrawerEscapeHandler() {
    const panel = getCharacterPanel();
    if (!(panel instanceof HTMLElement) || panel.dataset.sbCharacterEscapeBound === 'true') {
        return;
    }

    panel.dataset.sbCharacterEscapeBound = 'true';
    panel.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || !panel.classList.contains('openDrawer')) {
            return;
        }

        if (shouldDeferCharacterDrawerEscape(event, panel)) {
            return;
        }

        closeCharacterPanel();
        event.preventDefault();
        event.stopPropagation();
    });
}

async function openCreatorNotesFullscreen() {
    const context = getSillyTavernContext();
    const spoiler = document.getElementById('creator_notes_spoiler');

    if (!context?.callGenericPopup || !spoiler) {
        return;
    }

    // Move the rendered node instead of re-rendering it: formatCreatorNotes() scopes embedded
    // <custom-style> rules to '#creator_notes_spoiler ', and the live textarea sync keeps writing
    // to this same element while the popup is open.
    const anchor = document.createComment('sb-creator-notes-fullscreen');
    spoiler.replaceWith(anchor);

    const wrapper = document.createElement('div');
    wrapper.className = 'sb-creator-notes-fullscreen';
    // SillyBunny: the notes body is a document, so its Window body uses the View surface.
    wrapper.classList.add('sb-document');
    wrapper.append(spoiler);

    try {
        // SillyBunny: formatted Creator's Notes use the shared Window body without changing the live node.
        await context.callGenericPopup(wrapper, context.POPUP_TYPE.TEXT, '', { tier: 'window', title: t`Creator's Notes`, wide: true, large: true });
    } finally {
        if (anchor.isConnected) {
            anchor.replaceWith(spoiler);
        } else {
            document.querySelector('.sb-creator-notes-preview__body')?.prepend(spoiler);
        }
    }
}

function bindCreatorNotesFullscreen() {
    const button = document.getElementById('sb_creator_notes_maximize');
    if (!(button instanceof HTMLButtonElement) || button.dataset.sbBound === 'true') {
        return;
    }

    button.dataset.sbBound = 'true';
    button.addEventListener('click', () => openCreatorNotesFullscreen());
}

function focusCharacterPanelTab(tabId) {
    const normalizedTabId = normalizeCharacterPanelTab(tabId);
    const button = getCharacterPanel()?.querySelector(`[data-sb-character-tab="${CSS.escape(normalizedTabId)}"]`);

    if (button instanceof HTMLElement) {
        button.focus({ preventScroll: true });
    }
}

function hideCharacterMainPanels() {
    const infoPanel = document.getElementById('result_info');
    const pinAndTabs = document.getElementById('rm_PinAndTabs');
    const characterEditor = document.getElementById('rm_ch_create_block');
    const groupEditor = document.getElementById('rm_group_chats_block');
    const characterList = document.getElementById('rm_characters_block');

    if (infoPanel instanceof HTMLElement) {
        infoPanel.style.display = 'none';
    }

    if (pinAndTabs instanceof HTMLElement) {
        pinAndTabs.style.display = 'none';
    }

    if (characterEditor instanceof HTMLElement) {
        characterEditor.style.display = 'none';
        characterEditor.style.visibility = 'hidden';
        characterEditor.style.pointerEvents = 'none';
    }

    if (groupEditor instanceof HTMLElement) {
        groupEditor.style.display = 'none';
        groupEditor.style.visibility = 'hidden';
        groupEditor.style.pointerEvents = 'none';
    }

    if (characterList instanceof HTMLElement) {
        characterList.style.display = 'none';
        characterList.style.visibility = 'hidden';
        characterList.style.pointerEvents = 'none';
    }
}

function openCharacterWorldInfoTab() {
    const panel = getCharacterPanel();
    sbState.characterDrawer.lastTab = 'world-info';

    applyMobileSurfaceExclusivity(sbMobileShellLifecycle.overlays.resolveExclusiveOpen({
        surface: sbMobileShellLifecycle.overlays.surface.CHARACTER_PANEL,
        isMobileViewport: isMobileViewport(),
    }));
    setCharacterPanelMenuType(panel, 'world-info');
    preloadPanelStylesheets('characters', 'world-info');
    setCharacterEditorEmptyState(false);
    setCharacterPersonaPanelVisible(false);
    setCharacterImportPanelVisible(false);
    syncCharacterListControls('characters');
    setCharacterWorldInfoPanelVisible(true);
    hideCharacterMainPanels();

    syncDrawerIconState('#WIDrawerIcon', true);
    syncCharacterShellTabs('world-info');
    syncCharacterTitlebarVisibility();
    window.requestAnimationFrame(() => focusCharacterPanelTab('world-info'));
}

function openCharacterPersonaTab() {
    const panel = getCharacterPanel();
    sbState.characterDrawer.lastTab = 'persona';

    preloadPanelStylesheets('characters', 'persona');
    setCharacterPanelMenuType(panel, 'persona');
    setCharacterEditorEmptyState(false);
    setCharacterImportPanelVisible(false);
    setCharacterWorldInfoPanelVisible(false);
    syncCharacterListControls('characters');
    setCharacterPersonaPanelVisible(true);
    hideCharacterMainPanels();

    syncCharacterShellTabs('persona');
    syncCharacterTitlebarVisibility();
}

function openCharacterImportTab() {
    const panel = getCharacterPanel();
    sbState.characterDrawer.lastTab = 'import';

    setCharacterPanelMenuType(panel, 'import');
    setCharacterEditorEmptyState(false);
    setCharacterPersonaPanelVisible(false);
    setCharacterWorldInfoPanelVisible(false);
    syncCharacterListControls('characters');
    setCharacterImportPanelVisible(true);
    hideCharacterMainPanels();

    syncCharacterShellTabs('import');
    syncCharacterTitlebarVisibility();
}

function preserveCharacterImportTab() {
    const panel = getCharacterPanel();

    if (panel instanceof HTMLElement && panel.dataset.menuType !== 'import') {
        return;
    }

    setCharacterEditorEmptyState(false);
    setCharacterPersonaPanelVisible(false);
    setCharacterWorldInfoPanelVisible(false);
    syncCharacterListControls('characters');
    setCharacterImportPanelVisible(true);
    hideCharacterMainPanels();
    syncCharacterShellTabs('import');
    syncCharacterTitlebarVisibility();
}

function syncCharacterModeToggle() {
    const toggle = document.getElementById('sb_character_mode_toggle');

    if (!(toggle instanceof HTMLElement)) {
        return;
    }

    const activeMode = conversationState.conversationWorkspaceOpen ? 'conversation' : 'roleplay';
    toggle.dataset.activeMode = activeMode;
    toggle.querySelectorAll('[data-sb-character-mode]').forEach((button) => {
        if (!(button instanceof HTMLButtonElement)) {
            return;
        }

        const isActive = button.dataset.sbCharacterMode === activeMode;
        button.classList.toggle('is-active', isActive);
        button.setAttribute('aria-checked', String(isActive));
    });
}

function setCharacterShellMode(mode) {
    const normalizedMode = mode === 'conversation' ? 'conversation' : 'roleplay';
    const isConversationMode = normalizedMode === 'conversation';
    const mobileViewport = isMobileViewport();

    if (conversationState.conversationWorkspaceOpen === isConversationMode) {
        syncCharacterModeToggle();
        if (mobileViewport) {
            closeCharacterPanel();
        }
        return;
    }

    if (isConversationMode) {
        window.dispatchEvent(new CustomEvent('sb:open-conversation-workspace', {
            detail: {
                avatar: characters[this_chid]?.avatar || '',
                showToast: false,
            },
        }));
    } else {
        window.dispatchEvent(new CustomEvent('sb:close-conversation-workspace'));
        recordRoleplayIfChatShown();
    }

    syncCharacterModeToggle();

    if (mobileViewport) {
        closeCharacterPanel();
    }
}

function openCharacterPanelTab(tabId) {
    // SillyBunny: Characters lives in the full-screen settings page.
    const normalizedTabId = normalizeCharacterPanelTab(tabId);
    if (isSettingsPageHosting('characters')) {
        activateSettingsTab('characters', normalizedTabId);
        return;
    }

    openSettingsPage('characters', normalizedTabId);
}

function activateCharacterPanelTabInPlace(tabId) {
    const normalizedTabId = normalizeCharacterPanelTab(tabId);
    sbState.characterDrawer.lastTab = normalizedTabId;

    if (normalizedTabId === 'world-info' || normalizedTabId === 'persona') {
        preloadPanelStylesheets('characters', normalizedTabId);
    }

    const panel = getCharacterPanel();
    if (normalizedTabId === 'persona') {
        setCharacterPanelMenuType(panel, 'persona');
        openCharacterPersonaTab();
    } else if (normalizedTabId === 'import') {
        setCharacterPanelMenuType(panel, 'import');
        openCharacterImportTab();
    } else if (normalizedTabId === 'groups') {
        setCharacterPanelMenuType(panel, 'groups');
        void showCharacterListView('groups');
    } else if (normalizedTabId === 'editor') {
        setCharacterPanelMenuType(panel, 'character_edit');
        void openCharacterEditorTab();
    } else if (normalizedTabId === 'world-info') {
        setCharacterPanelMenuType(panel, 'world-info');
        openCharacterWorldInfoTab();
    } else {
        setCharacterPanelMenuType(panel, 'characters');
        void showCharacterListView();
    }
}

async function openCharacterEditorTab() {
    sbState.characterDrawer.lastTab = 'editor';
    setCharacterEditorEmptyState(false);
    setCharacterPersonaPanelVisible(false);
    setCharacterImportPanelVisible(false);
    setCharacterWorldInfoPanelVisible(false);

    if (await showActiveCharacterEditor()) {
        syncCharacterShellTabs('editor');
        return true;
    }

    showCharacterEditorEmptyState();
    return false;
}

/** The tab of the Characters window that a page of its one panel belongs to; the panel's `data-menu-type` names the page. */
function getCharacterTabIdForMenuType(menuType) {
    if (menuType === 'persona' || menuType === 'import' || menuType === 'world-info' || menuType === 'groups') {
        return menuType;
    }

    return ['character_edit', 'group_edit', 'create', 'group_create', 'editor_empty'].includes(menuType) ? 'editor' : 'characters';
}

function syncCharacterShellTabs(activeTab = null) {
    const panel = getCharacterPanel();
    const menuType = panel?.dataset.menuType;
    const normalizedTab = activeTab ?? getCharacterTabIdForMenuType(menuType);

    // The Characters window shows its pages in one panel, so the page class follows the page that is shown.
    applyPageWidth(panel, getCharacterPanelTabConfig(normalizedTab));

    if (normalizedTab !== 'characters' && normalizedTab !== 'groups') characterListViewRevision++;

    sbState.characterDrawer.lastTab = normalizedTab;

    if (menuType === 'characters' || menuType === 'groups') {
        syncCharacterListControls(menuType);
    }

    syncCharacterModeToggle();

    panel?.querySelectorAll('[data-sb-character-tab]').forEach(tab => {
        if (!(tab instanceof HTMLElement)) {
            return;
        }

        const isActive = tab.dataset.sbCharacterTab === normalizedTab;
        tab.classList.toggle('is-active', isActive);
        tab.setAttribute('aria-selected', String(isActive));
        tab.setAttribute('tabindex', isActive ? '0' : '-1');
    });

    // When the character panel is page-hosted, navigation that bypasses the
    // settings sidebar (editor Back, opening a card, Create) must still move the
    // sidebar selection, or it stays on whichever tab was last clicked.
    if (sbSettingsState.open && sbSettingsState.activeShell === 'characters' && sbSettingsState.activeTabId !== normalizedTab) {
        const settingsTab = getSettingsPageTabs('characters').find(tab => tab.id === normalizedTab);
        if (settingsTab) {
            sbSettingsState.activeTabId = normalizedTab;
            document.querySelectorAll('#sb-settings-tab-list .sb-settings-tab').forEach(button => {
                button.setAttribute('aria-selected', String(button instanceof HTMLElement && button.dataset.sbSettingsTab === normalizedTab));
            });
            renderSettingsPageHeading(settingsTab);
            void settingsSidebarSearch?.activate(normalizedTab);
        }
    }

    document.querySelectorAll('[data-sb-rail-shell-key="characters"]').forEach(button => {
        if (!(button instanceof HTMLElement)) {
            return;
        }

        const isActive = button.dataset.sbRailTabId === normalizedTab;
        button.classList.toggle('is-active', isActive);
        if (isActive) {
            button.setAttribute('aria-current', 'page');
        } else {
            button.removeAttribute('aria-current');
        }
    });

    queueTopbarSectionStateSync();

    if (panel instanceof HTMLElement && panel.classList.contains('openDrawer')) {
        const tabConfig = getCharacterPanelTabConfig(normalizedTab);
        document.dispatchEvent(new CustomEvent('sb:shell-tab-activated', {
            detail: {
                shellKey: 'characters',
                tabId: normalizedTab,
                label: tabConfig?.label || normalizedTab,
            },
        }));
    }
}

async function refreshActiveCharacterBeforeEditorOpen() {
    const context = getSillyTavernContext();
    const characterId = context?.characterId;
    const avatar = context?.groupId ? null : context?.characters?.[characterId]?.avatar;

    if (!avatar) {
        return;
    }

    try {
        await flushCharacterSaveDebounced();
        const refreshedContext = getSillyTavernContext();
        const refreshedCharacterId = refreshedContext?.characterId;
        const refreshedAvatar = refreshedContext?.groupId ? null : refreshedContext?.characters?.[refreshedCharacterId]?.avatar;
        await getOneCharacter(refreshedAvatar || avatar);
    } catch (error) {
        console.warn('Failed to refresh character before opening editor.', error);
    }
}

async function showActiveCharacterEditor() {
    if (!hasActiveCharacterChat()) {
        return false;
    }

    const selectedCharacterButton = document.getElementById('rm_button_selected_ch');
    if (!(selectedCharacterButton instanceof HTMLElement)) {
        return false;
    }

    await refreshActiveCharacterBeforeEditorOpen();
    selectedCharacterButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    setCharacterEditorEmptyState(false);
    setCharacterPersonaPanelVisible(false);
    setCharacterImportPanelVisible(false);
    setCharacterWorldInfoPanelVisible(false);
    syncCharacterShellTabs('editor');
    return true;
}

function syncCharacterDrawerStateFromDom({ force = false } = {}) {
    const panel = getCharacterPanel();

    if (!(panel instanceof HTMLElement)) {
        return;
    }

    const isOpen = panel.classList.contains('openDrawer');
    if (!force && sbState.characterDrawer.observedOpen === isOpen) {
        return;
    }

    sbState.characterDrawer.observedOpen = isOpen;
    syncDrawerIconState('#rightNavDrawerIcon', isOpen);
    syncDrawerIconState('#WIDrawerIcon', isOpen && panel.dataset.menuType === 'world-info');

    if (!isOpen && document.activeElement instanceof HTMLElement && panel.contains(document.activeElement)) {
        document.activeElement.blur();
    }

    syncChatbarVisibilityState();
    queueMobileModalStateSync();
    queueTopbarSectionStateSync();
}

function bindCharacterDrawerStateObserver() {
    const panel = getCharacterPanel();

    if (!(panel instanceof HTMLElement)) {
        return;
    }

    sbState.characterDrawer.stateObserver?.disconnect();
    sbState.characterDrawer.stateObserver = new MutationObserver((mutations) => {
        syncCharacterDrawerStateFromDom();

        if (mutations.some(mutation => mutation.attributeName === 'data-menu-type')) {
            setCharacterEditorEmptyState(panel.dataset.menuType === 'editor_empty');
            setCharacterPersonaPanelVisible(panel.dataset.menuType === 'persona');
            setCharacterImportPanelVisible(panel.dataset.menuType === 'import');
            setCharacterWorldInfoPanelVisible(panel.dataset.menuType === 'world-info');
            syncCharacterTitlebarVisibility();
            syncCharacterShellTabs();
        }
    });
    sbState.characterDrawer.stateObserver.observe(panel, {
        attributes: true,
        attributeFilter: ['class', 'data-menu-type'],
    });
    applyPageWidth(panel, getCharacterPanelTabConfig(getCharacterTabIdForMenuType(panel.dataset.menuType)));
    syncCharacterDrawerStateFromDom({ force: true });
}

function closeCharacterPanel() {
    if (isSettingsPageHosting('characters')) {
        closeSettingsPage();
    }
}

let characterToggleDispatchGuard = false;
let characterToggleSkipExtensionIntercept = false;

function syncCharacterToggleGhostRect() {
    const nativeToggle = getCharacterDrawerHost()?.querySelector(':scope > .drawer-toggle');
    const proxyButton = document.getElementById('sb-character-toggle');
    if (!(nativeToggle instanceof HTMLElement)) return;
    if (!(proxyButton instanceof HTMLElement)) return;
    const proxyRect = proxyButton.getBoundingClientRect();
    nativeToggle.style.left = proxyRect.left + 'px';
    nativeToggle.style.top = proxyRect.top + 'px';
    nativeToggle.style.width = proxyRect.width + 'px';
    nativeToggle.style.height = proxyRect.height + 'px';
}

let characterToggleGhostObserver = null;
function scheduleCharacterToggleGhostSync() {
    window.requestAnimationFrame(syncCharacterToggleGhostRect);
    if (characterToggleGhostObserver) return;
    const observer = new ResizeObserver(syncCharacterToggleGhostRect);
    const attach = () => {
        const proxyButton = document.getElementById('sb-character-toggle');
        if (!proxyButton) return false;
        observer.observe(proxyButton);
        characterToggleGhostObserver = observer;
        return true;
    };
    if (!attach()) {
        const intervalId = window.setInterval(() => {
            if (attach()) window.clearInterval(intervalId);
        }, 250);
        window.setTimeout(() => window.clearInterval(intervalId), 5000);
    }
}
window.addEventListener('resize', syncCharacterToggleGhostRect, { passive: true });
window.matchMedia(SB_MOBILE_MEDIA_QUERY).addEventListener('change', () => {
    // The icons-only setting is in force on the desktop layout only, so crossing the breakpoint re-applies the whole preference.
    applyTopbarIconsOnlyPreference();
    updateTopBarBrand();
    // Crossing the breakpoint also decides which rail third-party composer buttons belong in.
    queueComposerControlPlacement();
});

document.addEventListener('click', (e) => {
    if (characterToggleDispatchGuard) return;
    const nativeToggle = getCharacterDrawerHost()?.querySelector(':scope > .drawer-toggle');
    if (!(nativeToggle instanceof HTMLElement)) return;
    if (!nativeToggle.contains(e.target)) return;
    e.stopPropagation();
    e.preventDefault();
    characterToggleSkipExtensionIntercept = true;
    toggleCharacterPanel();
    characterToggleSkipExtensionIntercept = false;
}, true);

function toggleCharacterPanel({ preferredTab = null } = {}) {
    if (isCharacterPanelOpen()) {
        closeCharacterPanel();
        return;
    }

    const normalizedPreferredTab = preferredTab ? normalizeCharacterPanelTab(preferredTab) : '';

    // SillyBunny: dispatch a cancelable click on the native Characters toggle to give
    // extensions like CharacterLibrary a chance to intercept. If they preventDefault(),
    // they handle the UI themselves and we yield (Sillyanonymous/SillyTavern-CharacterLibrary#28).
    if (characterToggleSkipExtensionIntercept) {
        characterToggleSkipExtensionIntercept = false;
    } else {
        syncCharacterToggleGhostRect();
        const nativeToggle = getCharacterDrawerHost()?.querySelector(':scope > .drawer-toggle');
        if (nativeToggle instanceof HTMLElement) {
            const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
            characterToggleDispatchGuard = true;
            nativeToggle.dispatchEvent(clickEvent);
            characterToggleDispatchGuard = false;
            if (clickEvent.defaultPrevented) {
                return;
            }
        }
    }

    // SillyBunny: the floating drawer is retired; Characters opens in the settings page.
    openSettingsPage('characters', normalizedPreferredTab || sbState.characterDrawer.lastTab || SB_CHARACTER_PANEL_DEFAULT_TAB);
}

function closeAllDropdowns({ except = '', closeSurfaces = true } = {}) {
    if (closeSurfaces) {
        const exemptSurface = getMobileShellSurfaceForShell(except);

        if (exemptSurface) {
            applyMobileSurfaceExclusivity(sbMobileShellLifecycle.overlays.resolveExclusiveOpen({
                surface: exemptSurface,
                isMobileViewport: isMobileViewport(),
            }));
        } else {
            applyMobileSurfaceExclusivity({
                closeSurfaces: sbMobileShellLifecycle.overlays.closeAllSurfaces,
            });
        }
    }

    if (except !== 'search') setUniversalSearchOpenState(false);

    // Close persona picker
    document.getElementById('sb-persona-picker')?.remove();
}

function toggleShellPanel(shellKey, tabId = null) {
    if (shellKey === 'left' && tabId === 'world-info') {
        shellKey = 'characters';
    }

    if (shellKey === 'characters') {
        toggleSettingsPage('characters', tabId ? normalizeCharacterPanelTab(tabId) : null);
        return;
    }

    if (!getShellConfig(shellKey)) {
        return;
    }

    preloadPanelStylesheets(shellKey, tabId);
    toggleSettingsPage(shellKey, tabId);
}

function preloadPanelStylesheets(shellKey, tabId = null) {
    // SillyBunny: old saved/configured left-shell World Info routes should only
    // preload assets for the relocated Characters tab, never recreate a left tab.
    const normalizedTabId = shellKey === 'left' && tabId === 'world-info' ? 'world-info' : tabId;
    const normalizedShellKey = shellKey === 'left' && tabId === 'world-info' ? 'characters' : shellKey;
    const key = `${shellKey}:${tabId || ''}`;
    const normalizedKey = `${normalizedShellKey}:${normalizedTabId || ''}`;
    const stylesheets = SB_PANEL_STYLESHEETS[normalizedKey] ?? SB_PANEL_STYLESHEETS[key];

    if (!stylesheets || !window.SillyBunnyAssets?.loadStylesheetAsync) {
        return;
    }

    // SillyBunny: persona preloads share mount retry cleanup for failed links
    if (normalizedKey === 'characters:persona') {
        return import('./sillybunny-persona-editor.js')
            .then(module => module.loadPersonaEditorStyles(stylesheets))
            .catch(error => console.warn('Failed to load panel stylesheet:', normalizedKey, error));
    }

    if (normalizedKey === 'characters:characters' || normalizedKey === 'characters:groups') {
        return import('./sillybunny-character-list.js')
            .then(module => module.loadCharacterListStyles(stylesheets))
            .catch(error => console.warn('Failed to load panel stylesheet:', normalizedKey, error));
    }

    for (const stylesheet of stylesheets) {
        window.SillyBunnyAssets.loadStylesheetAsync(stylesheet.href, { id: stylesheet.id }).catch(error => {
            console.warn('Failed to load panel stylesheet:', stylesheet.href, error);
        });
    }
}

function isLandingPageVisible() {
    return isHomeActive();
}

// The state that the Home toggle has at load is drawn as it is. Only a change after the user has pressed a key or
// a pointer is a transition, so the pill does not fade in when the app boots to Home.
let homeToggleInitialState = true;
for (const type of ['pointerdown', 'keydown']) {
    globalThis.addEventListener?.(type, () => { homeToggleInitialState = false; }, { capture: true, once: true });
}

function syncHomeButtonState() {
    const homeButton = document.getElementById('sb-home-toggle');
    if (!(homeButton instanceof HTMLButtonElement)) {
        return;
    }

    // SillyBunny: one destination is active at a time, the one on screen. A settings page open over Home
    // is the destination, so Home is current again only once the page closes.
    const isHomeVisible = isHomeActive() && !sbSettingsState.open;
    if (homeToggleInitialState) {
        homeButton.style.transition = 'none';
    }
    setButtonPressed(homeButton, isHomeVisible);
    homeButton.classList.toggle('is-current', isHomeVisible);
    if (homeToggleInitialState) {
        void homeButton.offsetWidth;
        homeButton.style.removeProperty('transition');
    }

    if (isHomeVisible) {
        homeButton.setAttribute('aria-current', 'page');
    } else {
        homeButton.removeAttribute('aria-current');
    }
}

function handleHomeStateChanged() {
    syncHomeButtonState();
    updateTopBarBrand();

    if (!isHomeActive()) {
        return;
    }

    const composer = document.getElementById('form_sheld');
    if (composer?.contains(document.activeElement)) {
        document.activeElement.blur();
    }
}

function bindHomeState() {
    document.addEventListener(HOME_STATE_CHANGED_EVENT, handleHomeStateChanged);
    initHomeState();
    syncHomeButtonState();
}

async function returnToLandingPage() {
    // A temporary chat asks before anything closes, so Cancel leaves the page as it was.
    if (!await leaveTemporaryChat()) {
        return;
    }

    window.dispatchEvent(new CustomEvent('sb:close-conversation-workspace'));
    closeShell('left');
    closeShell('right');
    closeCharacterPanel();

    if (isLandingPageVisible()) {
        document.getElementById('chat')?.scrollTo({
            top: 0,
            behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
        });
        return;
    }

    const context = getSillyTavernContext();

    if (typeof context?.closeCurrentChat === 'function') {
        // A chat that stays open after Conversation closed is a Roleplay chat.
        if (!await context.closeCurrentChat()) {
            recordRoleplayIfChatShown();
        }
        return;
    }

    document.getElementById('option_close_chat')?.click();
}

function syncProxyButtonState(proxyButton, sourceIcon) {
    if (!(proxyButton instanceof HTMLElement)) {
        return;
    }

    // SillyBunny: the page synchronously owns this button; keep drawer state for legacy consumers
    if (proxyButton.id === 'sb-character-toggle' && getCharacterPanel()?.classList.contains('sb-settings-mounted-shell')) {
        proxyButton.classList.remove('is-open', 'is-pinned', 'is-current');
        proxyButton.setAttribute('aria-expanded', String(proxyButton.classList.contains('sb-settings-active')));
        return;
    }
    if (!(sourceIcon instanceof HTMLElement)) return;

    const isOpen = sourceIcon.classList.contains('openIcon');
    const isPinned = sourceIcon.classList.contains('drawerPinnedOpen');
    const isCharacterButton = proxyButton.id === 'sb-character-toggle';

    proxyButton.classList.toggle('is-open', isOpen);
    proxyButton.classList.toggle('is-pinned', isPinned);
    proxyButton.setAttribute('aria-expanded', String(isOpen));

    if (isCharacterButton) {
        proxyButton.classList.remove('is-current');
        proxyButton.removeAttribute('aria-current');
    }
}

function syncCharacterTopbarButtonState() {
    syncProxyButtonState(
        document.getElementById('sb-character-toggle'),
        document.querySelector('#rightNavDrawerIcon'),
    );
}

function observeProxyButton(buttonId, iconSelector) {
    const proxyButton = document.getElementById(buttonId);
    const sourceIcon = document.querySelector(iconSelector);

    if (!(proxyButton instanceof HTMLElement) || !(sourceIcon instanceof HTMLElement)) {
        return;
    }

    syncProxyButtonState(proxyButton, sourceIcon);

    const observer = new MutationObserver(() => {
        syncProxyButtonState(proxyButton, sourceIcon);
    });

    observer.observe(sourceIcon, { attributes: true, attributeFilter: ['class'] });
}

function activateCharacterTopbarButton() {
    // SillyBunny: open Characters through the full-screen settings page, like the other shells
    toggleSettingsPage('characters');
}

function buildUniversalSearchRow() {
    const row = createElement('div', { id: 'sb-topbar-search-row' });
    const search = createElement('div', { id: 'sb-universal-search', className: 'sb-universal-search' });
    const field = createElement('label', { className: 'sb-universal-search-field' });
    const searchIcon = createElement('i', {
        className: 'fa-solid fa-magnifying-glass',
        attrs: {
            'aria-hidden': 'true',
        },
    });
    const searchInput = createElement('input', {
        className: 'text_pole',
        attrs: {
            type: 'search',
            placeholder: SB_UNIVERSAL_SEARCH_PLACEHOLDER,
            'aria-label': SB_UNIVERSAL_SEARCH_LABEL,
            autocomplete: 'off',
            enterkeyhint: 'search',
            spellcheck: 'false',
            role: 'combobox',
            'aria-expanded': 'false',
            'aria-controls': 'sb-universal-search-results',
        },
    });
    const panel = createElement('div', { className: 'sb-universal-search-panel' });
    const searchResults = createElement('div', {
        id: 'sb-universal-search-results',
        className: 'sb-search-results',
        attrs: {
            role: 'listbox',
            'aria-label': 'Universal Search Results',
        },
    });

    field.append(searchIcon, searchInput);
    panel.appendChild(searchResults);
    search.append(field, panel);
    row.appendChild(search);

    row.setAttribute('aria-hidden', 'true');
    search.setAttribute('aria-expanded', 'false');
    searchInput.tabIndex = -1;

    sbState.universalSearch.row = row;
    sbState.universalSearch.root = search;
    sbState.universalSearch.input = searchInput;
    sbState.universalSearch.results = searchResults;
    sbState.universalSearch.expanded = false;

    stopProxyPointerPropagation(search);

    field.addEventListener('click', () => {
        setUniversalSearchOpenState(true, { focusInput: true });
    });

    searchInput.addEventListener('focus', () => {
        setUniversalSearchOpenState(true);
    });

    // Typing is debounced: a render walks every tab's index, so firing one per keystroke spends a
    // panel build on a query the user is still typing. Enter and the open panel flush it early.
    searchInput.addEventListener('input', () => {
        setUniversalSearchOpenState(true);
        scheduleUniversalSearchRender();
    });

    // Delegated so a row replaced by a re-render cannot swallow the click; an unknown index means the
    // row no longer belongs to the visible list and is ignored.
    searchResults.addEventListener('click', event => {
        const button = event.target instanceof Element ? event.target.closest('[data-sb-search-row]') : null;
        if (!(button instanceof HTMLElement)) {
            return;
        }
        const match = getUniversalSearchState().renderedRows?.[Number(button.dataset.sbSearchRow)];
        if (!match) {
            return;
        }
        clearUniversalSearch({ blur: true });
        revealSearchMatch(match.shellKey, match);
    });

    searchInput.addEventListener('keydown', event => {
        const resultButtons = Array.from(searchResults.querySelectorAll('.sb-search-result'));

        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (!resultButtons.length) {
                return;
            }

            const direction = event.key === 'ArrowDown' ? 1 : -1;
            const nextIndex = (sbState.universalSearch.activeIndex + direction + resultButtons.length) % resultButtons.length;
            setUniversalSearchActiveIndex(nextIndex);
            return;
        }

        if (event.key === 'Enter') {
            const firstMatch = resultButtons[sbState.universalSearch.activeIndex] ?? resultButtons[0];            if (firstMatch instanceof HTMLButtonElement) {
                event.preventDefault();
                firstMatch.click();
            }
        }

        if (event.key === 'Escape') {
            event.preventDefault();
            clearUniversalSearch({ blur: true });
        }
    });

    if (!sbState.universalSearch.dismissBound) {
        document.addEventListener('click', event => {
            const searchState = getUniversalSearchState();

            if (!searchState.expanded || !(searchState.root instanceof HTMLElement)) {
                return;
            }

            const searchTrigger = event.target instanceof Element
                ? event.target.closest('[data-sb-universal-search-trigger="true"]')
                : null;
            if (searchTrigger instanceof HTMLElement) {
                return;
            }

            if (event.target instanceof Node && searchState.root.contains(event.target)) {
                return;
            }

            setUniversalSearchOpenState(false);
        });

        sbState.universalSearch.dismissBound = true;
    }

    return row;
}

function buildTopBar() {
    const topBar = document.getElementById('top-bar');
    if (!(topBar instanceof HTMLElement)) {
        return;
    }

    // SillyBunny: preserve children injected by third-party extensions before wiping
    // the bar. They are adopted into the extension slot once the shell layout exists, so
    // extensions targeting #top-bar (e.g. CharacterLibrary in standalone mode) aren't orphaned.
    const preservedExtensionChildren = Array.from(topBar.children)
        .filter(child => child instanceof HTMLElement && !isSillyBunnyOwnedElement(child));

    topBar.replaceChildren();

    const stack = createElement('div', { id: 'sb-topbar-stack' });
    const primaryRow = createElement('div', { id: 'sb-topbar-primary' });
    const searchRow = buildUniversalSearchRow();
    const topBarInner = createElement('div', { id: 'sb-topbar-inner' });
    const leftGroup = createElement('div', { className: 'sb-topbar-group sb-topbar-group-left' });
    const centerGroup = createElement('div', { className: 'sb-topbar-brand' });
    const rightGroup = createElement('div', { className: 'sb-topbar-group sb-topbar-group-right' });
    const extensionSlot = createElement('div', {
        id: TOPBAR_EXTENSION_SLOT_ID,
        attrs: { 'data-sb-topbar-slot-empty': 'true' },
    });

    // SillyBunny: the left and right shell toggles open the full-screen settings page
    const leftButton = createProxyButton(
        {
            id: 'sb-left-shell-toggle',
            icon: getShellConfig('left').proxyIcon,
            label: getShellConfig('left').proxyLabel,
            name: getShellConfig('left').proxyLabel,
            title: 'Open Backend Tools (Ctrl+U)',
        },
        () => toggleSettingsPage('left'),
    );

    const homeButton = createProxyButton(
        {
            id: 'sb-home-toggle',
            icon: 'fa-house',
            label: 'Home',
            name: 'Home',
            title: 'Return to the Landing Page (Ctrl+O)',
        },
        () => {
            void returnToLandingPage();
        },
    );

    const rightButton = createProxyButton(
        {
            id: 'sb-right-shell-toggle',
            icon: getShellConfig('right').proxyIcon,
            label: getShellConfig('right').proxyLabel,
            name: getShellConfig('right').proxyLabel,
            title: 'Open Customization Tools (Ctrl+I)',
        },
        () => toggleSettingsPage('right'),
    );

    const charactersButton = createProxyButton(
        {
            id: 'sb-character-toggle',
            icon: 'fa-address-card',
            label: 'Characters',
            name: 'Characters',
            title: 'Open Character Management (Ctrl+P)',
        },
        activateCharacterTopbarButton,
    );

    const leftShortcutConfig = getShortcutConfig(getShortcutTarget('left'));
    const leftShortcut = createProxyButton(
        {
            id: 'sb-shortcut-left',
            icon: leftShortcutConfig.icon,
            label: leftShortcutConfig.label,
            title: `Quick Access: ${leftShortcutConfig.label}`,
            className: 'sb-proxy-button-icon-only sb-desktop-setting',
        },
        () => activateShortcutTarget(getShortcutTarget('left')),
    );
    bindSearchShortcutPreFocus(leftShortcut, () => getShortcutTarget('left'));

    const rightShortcutConfig = getShortcutConfig(getShortcutTarget('right'));
    const rightShortcut = createProxyButton(
        {
            id: 'sb-shortcut-right',
            icon: rightShortcutConfig.icon,
            label: rightShortcutConfig.label,
            title: `Quick Access: ${rightShortcutConfig.label}`,
            className: 'sb-proxy-button-icon-only sb-desktop-setting',
        },
        () => activateShortcutTarget(getShortcutTarget('right')),
    );
    bindSearchShortcutPreFocus(rightShortcut, () => getShortcutTarget('right'));

    const desktopShortcutButtons = {};
    for (const side of SB_SHORTCUT_DESKTOP_SLOTS) {
        const shortcutConfig = getShortcutConfig(getShortcutTarget(side));
        const shortcut = createProxyButton(
            {
                id: getShortcutButtonId(side),
                icon: shortcutConfig.icon,
                label: shortcutConfig.label,
                title: `Quick Access: ${shortcutConfig.label}`,
                className: 'sb-proxy-button-icon-only sb-desktop-setting',
            },
            () => activateShortcutTarget(getShortcutTarget(side)),
        );
        bindSearchShortcutPreFocus(shortcut, () => getShortcutTarget(side));
        desktopShortcutButtons[side] = shortcut;
    }

    centerGroup.innerHTML = `
        <div id="sb-topbar-title" class="sb-brand-title" role="button" tabindex="0" aria-label="Tap to Return to the Chat">${SB_IDLE_BRAND_LABEL}</div>
    `;

    const quickActionsLeftDivider = createTopbarClusterDivider('sb-topbar-divider-quick-left');
    quickActionsLeftDivider.classList.add('sb-desktop-setting');
    const quickActionsRightDivider = createTopbarClusterDivider('sb-topbar-divider-quick-right');
    quickActionsRightDivider.classList.add('sb-desktop-setting');
    const searchMobileDivider = createTopbarClusterDivider('sb-topbar-divider-search-mobile');
    searchMobileDivider.classList.add('sb-mobile-setting');
    const modeMobileDivider = createTopbarClusterDivider('sb-topbar-divider-mode-mobile');
    modeMobileDivider.classList.add('sb-mobile-setting');

    // SillyBunny: the search toggle goes in the left group after Customize, and the mode toggle goes in the right group before Home
    const searchToggle = createProxyButton(
        {
            id: 'sb-topbar-search-toggle',
            icon: 'fa-magnifying-glass',
            label: 'Search',
            title: 'Search Settings (Ctrl+F)',
            className: 'sb-proxy-button-icon-only',
        },
        () => {
            const searchState = getUniversalSearchState();
            const nextOpen = !searchState.expanded;
            if (nextOpen) {
                closeAllDropdowns({ except: 'search', closeSurfaces: false });
            }
            setUniversalSearchOpenState(nextOpen, { focusInput: nextOpen });
        },
    );
    // The document-level dismiss handler ignores clicks on marked triggers; without this
    // the same click that opens the search row immediately closes it again.
    searchToggle.dataset.sbUniversalSearchTrigger = 'true';

    const modeToggle = createProxyButton(
        {
            id: 'sb-mode-toggle',
            icon: 'fa-masks-theater',
            label: 'Mode',
            title: 'Switch Chat Mode (Ctrl+M)',
            className: 'sb-proxy-button-icon-only',
        },
        () => openModeDropdown(),
    );
    modeToggle.setAttribute('aria-haspopup', 'menu');

    // SillyBunny: where the Quick Access buttons go when the bar has no room for them, even without labels.
    const overflowToggle = createProxyButton(
        {
            id: 'sb-topbar-overflow-toggle',
            icon: 'fa-ellipsis-vertical',
            label: getTopbarOverflowLabel(),
            title: getTopbarOverflowLabel(),
            className: 'sb-proxy-button-icon-only',
        },
        openTopbarOverflowMenu,
    );
    overflowToggle.setAttribute('aria-haspopup', 'menu');

    const controls = new Map([
        leftButton, rightButton, searchMobileDivider, searchToggle, quickActionsLeftDivider, leftShortcut,
        desktopShortcutButtons.slot3, desktopShortcutButtons.slot4, extensionSlot, desktopShortcutButtons.slot6,
        desktopShortcutButtons.slot5, rightShortcut, overflowToggle, quickActionsRightDivider, modeToggle,
        modeMobileDivider, homeButton, charactersButton,
    ].map(control => [control.id, control]));
    leftGroup.append(...SB_TOPBAR_GROUP_ORDER.left.map(id => controls.get(id)));
    rightGroup.append(...SB_TOPBAR_GROUP_ORDER.right.map(id => controls.get(id)));
    topBarInner.append(leftGroup, centerGroup, rightGroup);
    primaryRow.appendChild(topBarInner);

    stack.append(primaryRow, searchRow);
    topBar.append(stack);
    adoptTopbarExtensionNodes(preservedExtensionChildren);

    observeProxyButton('sb-left-shell-toggle', getShellConfig('left').hostIconSelector);
    observeProxyButton('sb-right-shell-toggle', getShellConfig('right').hostIconSelector);
    observeProxyButton('sb-character-toggle', '#rightNavDrawerIcon');
    bindTopbarExtensionAdoption();
    bindTopBarBrand();
    updateTopBarBrand();
    updateTopbarUtilityButtons();
    updateShortcutButton('left');
    updateShortcutButton('right');
    updateShortcutButton('slot3');
    updateShortcutButton('slot4');
    updateShortcutButton('slot5');
    updateShortcutButton('slot6');
    syncTopbarLayoutState();
    syncHomeButtonState();
    scheduleCharacterToggleGhostSync();
    fitTopbar();
    observeTopbarFit();
}

function hideHostToggles() {
    for (const shellConfig of Object.values(SB_SHELLS)) {
        const hostDrawer = document.getElementById(shellConfig.hostDrawerId);
        const hostToggle = hostDrawer?.querySelector(':scope > .drawer-toggle');

        hostDrawer?.classList.add('sb-drawer-host');
        hostToggle?.classList.add('sb-hidden-toggle');
    }

    // SillyBunny: use sb-ghost-toggle (not sb-hidden-toggle) so the native Characters toggle
    // retains a real bounding rect. Extensions like CharacterLibrary anchor dropdowns to this
    // toggle's or its icon child's getBoundingClientRect(); display:none produces a zero rect
    // and sends their dropdowns off-screen (Sillyanonymous/SillyTavern-CharacterLibrary#28).
    const characterDrawer = getCharacterDrawerHost();
    characterDrawer?.classList.add('sb-drawer-host');
    const characterToggle = characterDrawer?.querySelector(':scope > .drawer-toggle');
    characterToggle?.classList.add('sb-ghost-toggle');
    // Apply critical hiding via inline styles to avoid !important budget inflation
    if (characterToggle instanceof HTMLElement) {
        characterToggle.style.visibility = 'hidden';
        characterToggle.style.pointerEvents = 'none';
    }

    // SillyBunny: World Info is not a left or top-level drawer. The upstream drawer ID stays
    // so that selectors written for it keep working until runtime reparents it.
    const worldInfoDrawer = document.getElementById('WI-SP-button');
    worldInfoDrawer?.classList.add('sb-drawer-host');
    worldInfoDrawer?.querySelector(':scope > .drawer-toggle')?.classList.add('sb-hidden-toggle');
}

function getTopbarExtensionSlot() {
    const slot = document.getElementById(TOPBAR_EXTENSION_SLOT_ID);

    return slot instanceof HTMLElement ? slot : null;
}

function getNativeCharacterDrawerIcon() {
    const icon = getCharacterDrawerHost()?.querySelector(':scope #rightNavDrawerIcon')
        ?? document.getElementById('rightNavDrawerIcon');

    return icon instanceof HTMLElement ? icon : null;
}

/**
 * Describes a DOM node for the pure adoption rules. Keeping the DOM reads here lets the
 * decision logic in topbar-extension-slot/index.js stay importable and unit testable.
 */
function describeTopbarNode(node, index) {
    const isElement = node instanceof Element;

    return {
        node,
        key: isElement && node.id ? `id:${node.id}` : `index:${index}`,
        isElement,
        id: isElement ? node.id : '',
        tagName: isElement ? node.tagName : '',
        classNames: isElement ? Array.from(node.classList) : [],
        adoptAttribute: isElement ? node.getAttribute(TOPBAR_ADOPTION_ATTRIBUTE) : null,
        isSillyBunnyOwned: isSillyBunnyOwnedElement(node),
    };
}

function describeCharacterBadge(node, index) {
    const descriptor = describeTopbarNode(node, index);

    return {
        ...descriptor,
        key: `badge:${index}`,
        signature: `${descriptor.tagName}:${descriptor.classNames.join(' ')}`,
    };
}

/**
 * Mirrors extension badges from the ghosted native Characters icon onto the visible proxy
 * button. CharacterLibrary appends its chevron to #rightNavDrawerIcon, which lives inside
 * .sb-ghost-toggle and is therefore invisible, so the affordance never reaches the user.
 * The badges are moved rather than copied: the extension flips visibility through a global
 * document.querySelector, which only ever reaches the first copy.
 */
function syncCharacterToggleBadges() {
    const drawerIcon = getNativeCharacterDrawerIcon();
    const proxyButton = document.getElementById('sb-character-toggle');

    if (!(drawerIcon instanceof HTMLElement) || !(proxyButton instanceof HTMLElement)) {
        return;
    }

    const iconNodes = Array.from(drawerIcon.children);
    const hostNodes = Array.from(proxyButton.querySelectorAll(`:scope > [${TOPBAR_ADOPTED_MARKER_ATTRIBUTE}='true']`));
    const iconBadges = iconNodes.map((node, index) => describeCharacterBadge(node, index));
    const hostBadges = hostNodes.map((node, index) => describeCharacterBadge(node, `host-${index}`));
    const plan = resolveCharacterBadgeMirrorPlan({ iconBadges, hostBadges });
    const byKey = new Map([...iconBadges, ...hostBadges].map(badge => [badge.key, badge.node]));

    for (const key of plan.removeKeys) {
        byKey.get(key)?.remove();
    }

    for (const key of plan.moveKeys) {
        const badge = byKey.get(key);

        if (badge instanceof HTMLElement) {
            badge.setAttribute(TOPBAR_ADOPTED_MARKER_ATTRIBUTE, 'true');
            proxyButton.appendChild(badge);
        }
    }

    proxyButton.classList.toggle(
        'sb-has-adopted-badge',
        proxyButton.querySelector(`:scope > [${TOPBAR_ADOPTED_MARKER_ATTRIBUTE}='true']`) !== null,
    );
}

function syncTopbarExtensionSlotEmptyState() {
    const slot = getTopbarExtensionSlot();

    if (!slot) {
        return;
    }

    slot.dataset.sbTopbarSlotEmpty = String(slot.children.length === 0);
}

/**
 * Moves third-party top-bar controls into the shell's own bar. Upstream's bare
 * `.drawer { width: 100% }` plus this fork's fixed, click-through #top-settings-holder means an
 * injected button otherwise stretches across the whole strip and eats every click meant for the
 * bar underneath it (Sillyanonymous/SillyTavern-CharacterLibrary).
 */
function adoptTopbarExtensionNodes(extraNodes = []) {
    const slot = getTopbarExtensionSlot();

    if (!slot || sbState.topbarExtensions.adopting) {
        return;
    }

    sbState.topbarExtensions.adopting = true;

    try {
        const candidates = [...extraNodes];

        for (const source of [getCanonicalTopSettingsHolder(), document.getElementById('top-bar')]) {
            if (source instanceof HTMLElement) {
                candidates.push(...source.children);
            }
        }

        const descriptors = candidates.map((node, index) => describeTopbarNode(node, index));
        // Only id-bearing slot children can be matched by key; id-less descriptors fall back to a
        // per-pass index, which would collide across the two lists. Those are covered by the
        // parentElement check instead.
        const slotChildKeys = Array.from(slot.children)
            .filter(node => node instanceof Element && node.id)
            .map(node => `id:${node.id}`);
        const plan = resolveTopbarAdoptionPlan({ nodes: descriptors, slotChildKeys });
        const byKey = new Map(descriptors.map(descriptor => [descriptor.key, descriptor.node]));

        for (const key of plan.adoptKeys) {
            const node = byKey.get(key);

            // The parent check, not an "already in place" helper, is what terminates repeated
            // passes: appendChild on a node the slot already holds still mutates childList.
            if (node instanceof HTMLElement && node.parentElement !== slot) {
                slot.appendChild(node);
            }
        }

        syncCharacterToggleBadges();
        syncTopbarExtensionSlotEmptyState();
    } finally {
        sbState.topbarExtensions.adopting = false;
        // Drop the records our own moves just produced before they reach the callback.
        sbState.topbarExtensions.observer?.takeRecords();
    }

    queueTopbarFit();
}

function queueTopbarExtensionAdoption() {
    if (sbState.topbarExtensions.syncFrame) {
        return;
    }

    sbState.topbarExtensions.syncFrame = window.requestAnimationFrame(() => {
        sbState.topbarExtensions.syncFrame = 0;
        adoptTopbarExtensionNodes();
    });
}

function bindTopbarExtensionAdoption() {
    if (!getTopbarExtensionSlot()) {
        return;
    }

    if (!(sbState.topbarExtensions.observer instanceof MutationObserver)) {
        sbState.topbarExtensions.observer = new MutationObserver(() => queueTopbarExtensionAdoption());
    }

    const observer = sbState.topbarExtensions.observer;

    observer.disconnect();

    // childList only: extensions inject direct children, and subtree on #top-bar would fire on
    // every chatbar and search re-render inside #sb-topbar-stack.
    for (const target of [getCanonicalTopSettingsHolder(), document.getElementById('top-bar'), getNativeCharacterDrawerIcon()]) {
        if (target instanceof HTMLElement) {
            observer.observe(target, { childList: true });
        }
    }

    queueTopbarExtensionAdoption();
}

function createShellPanel(tabConfig) {
    const panel = createElement('section', {
        className: 'sb-shell-panel',
        attrs: {
            role: 'tabpanel',
            'data-sb-panel': tabConfig.id,
            'aria-hidden': 'true',
        },
    });

    const scroller = createElement('div', { className: 'sb-shell-panel-scroller' });
    panel.appendChild(scroller);

    return { panel, scroller };
}

function createOnDemandShellPanel(shellKey, tabConfig, build) {
    const { panel, scroller } = createShellPanel(tabConfig);
    const showStatus = options => scroller.replaceChildren(createStatusPage({ compact: true, ...options }).element);

    const showError = error => {
        console.error('[SillyBunny] Could not load panel:', tabConfig.id, error);
        showStatus({
            state: 'error',
            title: t`Settings Not Loaded`,
            description: String(error.message || error),
            actions: [{ label: 'Retry', primary: true, onActivate: () => void lifecycle.activate().catch(showError) }],
        });
    };
    const lifecycle = createDeferredPanel(async () => {
        panel.setAttribute('aria-busy', 'true');
        showStatus({ state: 'loading', title: t`Loading Settings` });
        try {
            const loaded = await build();
            panel.replaceChildren(...loaded.panel.childNodes);
            // Sections built here may author their own drawers, so the flatten runs again on the
            // finished panel rather than relying on the one the split did.
            if (!SB_COLLAPSIBLE_DRAWER_TAB_IDS.has(tabConfig.id) && !isSubpagePanel(tabConfig.id)) {
                flattenNestedSettingsDrawers(panel, { includeTopLevel: true });
                applySettingsSectionOrder(panel, tabConfig.id);
                normalizeSettingsPresentation(panel, { name: tabConfig.id });
            }
            installSettingsSubpage(shellKey, tabConfig.id);
            const tab = getShellState(shellKey)?.tabs.get(tabConfig.id);
            if (tab) {
                tab.searchRoot = loaded.searchRoot;
                tab.searchIndex = null;
            }
            return loaded;
        } finally {
            panel.removeAttribute('aria-busy');
        }
    });

    return {
        panel,
        searchRoot: scroller,
        ensureReady: () => lifecycle.ensureReady().catch(error => {
            showError(error);
            throw error;
        }),
        onActivate: () => void lifecycle.activate().catch(showError),
        onDeactivate: lifecycle.deactivate,
    };
}

function moveChildrenIntoContainer(sourceElement, targetElement) {
    const nodes = Array.from(sourceElement.childNodes);

    for (const node of nodes) {
        targetElement.appendChild(node);
    }
}

function prepareEmbeddedDrawer(drawerId, root = document) {
    const drawer = root.querySelector?.(`#${CSS.escape(drawerId)}`) ?? document.getElementById(drawerId);
    if (!(drawer instanceof HTMLElement)) {
        return null;
    }

    const drawerToggle = drawer.querySelector(':scope > .drawer-toggle');
    const drawerContent = drawer.querySelector(':scope > .drawer-content');

    if (!(drawerContent instanceof HTMLElement)) {
        return null;
    }

    drawer.classList.add('sb-embedded-drawer');
    drawerToggle?.classList.add('sb-hidden-toggle');
    drawerContent.classList.remove('drawer-content');
    drawerContent.classList.remove('openDrawer', 'closedDrawer', 'fillLeft', 'fillRight', 'pinnedOpen');
    drawerContent.classList.add('sb-managed', 'sb-shell-embedded-content');

    drawerContent.removeAttribute('style');
    drawer.style.display = '';
    drawer.style.visibility = '';
    drawer.style.opacity = '';

    if (drawerId === 'WI-SP-button') {
        drawer.querySelector('#WI_panel_pin_div')?.classList.add('sb-shell-hidden-control');
    }

    return { drawer, drawerContent };
}

function syncBackgroundSettingsSection() {
    const appearance = document.getElementById(SB_USER_SETTINGS_CONTAINER_IDS.appearance);
    const gallery = document.getElementById('backgrounds-button');
    if (!appearanceModule || !(appearance instanceof HTMLElement) || !(gallery instanceof HTMLElement)) return;

    let section = appearance.querySelector('#sb-background-settings-section');
    let changed = false;
    if (!(section instanceof HTMLElement)) {
        const group = appearanceModule.createAppearanceGroup({
            id: 'background',
            elementId: 'sb-background-settings-section',
            title: 'Background',
            description: 'Choose backgrounds and adjust their size, blur, opacity, and visibility',
        });
        group.group.id = 'sb-background-settings-controls';
        const heading = group.section.querySelector('.ds-pref-group-heading');
        heading.id = 'sb-background-settings-heading';
        group.group.setAttribute('aria-labelledby', heading.id);
        section = group.section;
        appearance.append(section);
        changed = true;
    }

    const controls = section.querySelector('#sb-background-settings-controls');
    if (!(controls instanceof HTMLElement)) throw new Error('Missing Background settings control group.');

    // The gallery owns its toolbar and layout; the normalizer must not box it around another pill.
    if (gallery.dataset.sbPresentation !== 'manual') gallery.dataset.sbPresentation = 'manual';
    const fitting = appearanceModule.presentBackgroundGallery(gallery);
    if (fitting) {
        controls.append(fitting.row);
        changed = true;
    }
    // The fitting row and the gallery close the group; the slider rows, which Interface injects after the initial split, come before them.
    const closing = controls.querySelector(':scope > .ds-select-row') ?? (gallery.parentElement === controls ? gallery : null);
    // These rows are authored in three tabs.
    for (const id of ['background-blur-block', 'background-opacity-block', 'background_thumbnails_animation', 'sb-surface-transparency-input']) {
        const control = document.getElementById(id);
        const row = id === 'background_thumbnails_animation' && control instanceof HTMLInputElement
            ? appearanceModule.presentBackgroundSwitch(control)
            : control?.closest('.ds-row, .checkbox_label');
        if (!(row instanceof HTMLElement) || row.parentElement === controls) continue;
        controls.insertBefore(row, closing);
        changed = true;
    }

    if (gallery.parentElement !== controls) {
        controls.append(gallery);
        changed = true;
    }
    if (changed) invalidateUserSettingsTabSearchIndexes();
}

/** The Sampling rows module, once the panel has loaded it. */
let samplingModule = null;

const SB_SAMPLING_BACKENDS = Object.freeze([
    {
        id: 'openai',
        apiIds: ['openai'],
        title: 'Chat Completions',
        usesContextSettings: false,
    },
    {
        id: 'textgenerationwebui',
        apiIds: ['textgenerationwebui'],
        title: 'Text Completions',
        usesContextSettings: true,
    },
    {
        id: 'kobold',
        apiIds: ['kobold', 'koboldhorde'],
        title: 'Kobold/Horde',
        usesContextSettings: true,
    },
    {
        id: 'novel',
        apiIds: ['novel'],
        title: 'NovelAI',
        usesContextSettings: true,
    },
]);

const SB_SAMPLING_GROUPS = Object.freeze([
    { id: 'sampling', title: 'Sampling', description: 'Adjust how the AI chooses tokens and how varied its replies can be' },
    { id: 'penalties', title: 'Penalties & Repetition', description: 'Control how the AI reuses tokens and repeats phrases' },
    { id: 'algorithms', title: 'Advanced Algorithms', description: 'Use advanced sampling methods to adjust token choices and repetition' },
    { id: 'tokens', title: 'Token Control', description: 'Set seeds, token preferences, minimum length, and streaming speed limits' },
    // The group has no description; its title keeps the translation key the upstream heading uses.
    { id: 'banned', title: 'Banned Tokens/Strings', i18n: 'Banned Tokens', description: '' },
    { id: 'output', title: 'Output & Generation', description: 'Adjust sampler order, generation options, and output rules' },
]);

/**
 * Shared sampler registry. Each entry maps a canonical sampler id to selectors across backends.
 * Controls are displayed in registry order within their group. Backends with no selector omit the entry.
 * @type {ReadonlyArray<{id: string, group: string, openai?: string|string[], textgenerationwebui?: string|string[], kobold?: string|string[], novel?: string|string[], expander?: boolean, gated?: boolean, description?: string, subtitleSource?: string}>}
 */
const SB_SAMPLER_REGISTRY = Object.freeze([
    // Sampling
    { id: 'sampler_toolbar', group: 'sampling', openai: '#sb_neutralize_chat_samplers', textgenerationwebui: '#samplerResetButton', gated: true },
    { id: 'temperature', group: 'sampling', openai: '#temp_openai', textgenerationwebui: '#temp_textgenerationwebui', kobold: '#temp', novel: '#temp_novel' },
    { id: 'top_k', group: 'sampling', openai: '#top_k_openai', textgenerationwebui: '#top_k_textgenerationwebui', kobold: '#top_k', novel: '#top_k_novel' },
    { id: 'top_p', group: 'sampling', openai: '#top_p_openai', textgenerationwebui: '#top_p_textgenerationwebui', kobold: '#top_p', novel: '#top_p_novel' },
    { id: 'typical_p', group: 'sampling', textgenerationwebui: '#typical_p_textgenerationwebui', kobold: '#typical_p', novel: '#typical_p_novel' },
    { id: 'min_p', group: 'sampling', openai: '#min_p_openai', textgenerationwebui: '#min_p_textgenerationwebui', kobold: '#min_p', novel: '#min_p_novel' },
    { id: 'top_a', group: 'sampling', openai: '#top_a_openai', textgenerationwebui: '#top_a_textgenerationwebui', kobold: '#top_a', novel: '#top_a_novel' },
    { id: 'tfs', group: 'sampling', textgenerationwebui: '#tfs_textgenerationwebui', kobold: '#tfs', novel: '#tail_free_sampling_novel' },
    { id: 'epsilon_cutoff', group: 'sampling', textgenerationwebui: '#epsilon_cutoff_textgenerationwebui' },
    { id: 'eta_cutoff', group: 'sampling', textgenerationwebui: '#eta_cutoff_textgenerationwebui' },
    { id: 'nsigma', group: 'sampling', textgenerationwebui: '#nsigma_textgenerationwebui' },
    { id: 'min_keep', group: 'sampling', textgenerationwebui: '#min_keep_textgenerationwebui' },
    { id: 'skew', group: 'sampling', textgenerationwebui: '#skew_textgenerationwebui' },
    // Penalties
    { id: 'repetition_penalty', group: 'penalties', openai: '#repetition_penalty_openai', textgenerationwebui: '#rep_pen_textgenerationwebui', kobold: '#rep_pen', novel: '#rep_pen_novel' },
    { id: 'rep_pen_range', group: 'penalties', textgenerationwebui: '#rep_pen_range_textgenerationwebui', kobold: '#rep_pen_range', novel: '#rep_pen_size_novel' },
    { id: 'rep_pen_slope', group: 'penalties', textgenerationwebui: '#rep_pen_slope_textgenerationwebui', kobold: '#rep_pen_slope', novel: '#rep_pen_slope_novel' },
    { id: 'rep_pen_decay', group: 'penalties', textgenerationwebui: '#rep_pen_decay_textgenerationwebui' },
    { id: 'encoder_rep_pen', group: 'penalties', textgenerationwebui: '#encoder_rep_pen_textgenerationwebui' },
    { id: 'frequency_penalty', group: 'penalties', openai: '#freq_pen_openai', textgenerationwebui: '#freq_pen_textgenerationwebui', novel: '#rep_pen_freq_novel' },
    { id: 'presence_penalty', group: 'penalties', openai: '#pres_pen_openai', textgenerationwebui: '#presence_pen_textgenerationwebui', novel: '#rep_pen_presence_novel' },
    { id: 'no_repeat_ngram', group: 'penalties', textgenerationwebui: '#no_repeat_ngram_size_textgenerationwebui' },
    // Algorithms
    { id: 'adaptive_p', group: 'algorithms', textgenerationwebui: '#adaptive_p_block', expander: true, description: 'Adjust token choices toward your chosen level of predictability' },
    { id: 'smoothing', group: 'algorithms', textgenerationwebui: '#smoothingBlock', expander: true },
    { id: 'math1_temp', group: 'algorithms', novel: '#math1_temp_novel' },
    { id: 'math1_quad', group: 'algorithms', novel: '#math1_quad_novel' },
    { id: 'math1_quad_entropy_scale', group: 'algorithms', novel: '#math1_quad_entropy_scale_novel' },
    { id: 'xtc', group: 'algorithms', textgenerationwebui: '#xtc_block', expander: true, description: 'Exclude top token choices to encourage more varied replies' },
    { id: 'dry', group: 'algorithms', textgenerationwebui: '#dryBlock', expander: true },
    { id: 'dynatemp', group: 'algorithms', textgenerationwebui: '#dynatemp_block_ooba', expander: true },
    { id: 'mirostat', group: 'algorithms', textgenerationwebui: '#mirostat_block_ooba', kobold: '[name="miroStatBlock-kobold"]', expander: true, subtitleSource: '[data-sb-sampling-control="#mirostat_block_ooba"] .ds-row-subtitle' },
    { id: 'mirostat_tau', group: 'algorithms', novel: '#mirostat_tau_novel' },
    { id: 'mirostat_lr', group: 'algorithms', novel: '#mirostat_lr_novel' },
    { id: 'beam_search', group: 'algorithms', textgenerationwebui: '#beamSearchBlock', expander: true, gated: true },
    { id: 'contrastive_search', group: 'algorithms', textgenerationwebui: '#contrastiveSearchBlock', expander: true, gated: true },
    // Tokens
    { id: 'seed', group: 'tokens', openai: '#seed_openai', textgenerationwebui: '#seed_textgenerationwebui', kobold: '#seed_kobold', subtitleSource: '[data-sb-sampling-control="#seed_textgenerationwebui"] .ds-row-subtitle' },
    { id: 'logit_bias', group: 'tokens', openai: '#openai_logit_bias_preset', textgenerationwebui: '#logit_bias_block_ooba', gated: true },
    { id: 'banned_tokens', group: 'banned', textgenerationwebui: '#banned_tokens_block_ooba', gated: true },
    { id: 'min_length', group: 'tokens', textgenerationwebui: '#min_length_textgenerationwebui', novel: '#min_length_novel', gated: true },
    { id: 'max_tokens_second', group: 'tokens', textgenerationwebui: '#max_tokens_second_textgenerationwebui', gated: true },
    // Output
    { id: 'sampler_order', group: 'output', textgenerationwebui: ['#sampler_order_block_kcpp', '#sampler_order_block_lcpp'], kobold: '#kobold_order', novel: '#novel_order', gated: true },
    { id: 'sampler_priority', group: 'output', textgenerationwebui: ['#sampler_priority_block_ooba', '#sampler_priority_block_aphrodite'], gated: true },
    { id: 'json_schema', group: 'output', textgenerationwebui: '#json_schema_block', gated: true },
    { id: 'do_sample', group: 'output', textgenerationwebui: '#do_sample_textgenerationwebui', gated: true },
    { id: 'add_bos_token', group: 'output', textgenerationwebui: '#add_bos_token_textgenerationwebui', gated: true },
    { id: 'ban_eos_token', group: 'output', textgenerationwebui: '#ban_eos_token_textgenerationwebui', gated: true },
    { id: 'skip_special_tokens', group: 'output', textgenerationwebui: '#skip_special_tokens_textgenerationwebui', gated: true },
    { id: 'ignore_eos_token', group: 'output', textgenerationwebui: '#ignore_eos_token_textgenerationwebui', gated: true },
    { id: 'use_default_badwordsids', group: 'output', kobold: '#use_default_badwordsids', gated: true },
    { id: 'temperature_last', group: 'output', textgenerationwebui: '#temperature_last_textgenerationwebui', gated: true },
    { id: 'include_reasoning', group: 'output', textgenerationwebui: '#include_reasoning_textgenerationwebui', gated: true },
    { id: 'speculative_ngram', group: 'output', textgenerationwebui: '#speculative_ngram_textgenerationwebui', gated: true },
    { id: 'spaces_between_special_tokens', group: 'output', textgenerationwebui: '#spaces_between_special_tokens_textgenerationwebui', gated: true },
    { id: 'cfg', group: 'output', textgenerationwebui: '#cfg_block_ooba', gated: true },
    { id: 'grammar', group: 'output', textgenerationwebui: '#grammar_block_ooba', kobold: '#grammar', gated: true, subtitleSource: '[data-sb-sampling-control="#grammar_block_ooba"] .ds-row-subtitle' },
]);

function getSamplingBackendControls(backendId) {
    return SB_SAMPLER_REGISTRY.flatMap(entry => [entry[backendId] ?? []].flat());
}

const SB_SAMPLER_ENTRY_BY_SELECTOR = Object.freeze(new Map(SB_SAMPLER_REGISTRY.flatMap(entry => SB_SAMPLING_BACKENDS
    .flatMap(backend => [entry[backend.id] ?? []].flat())
    .map(selector => [selector, entry]))));

function getSamplingGroupId(selector) {
    return SB_SAMPLER_ENTRY_BY_SELECTOR.get(selector)?.group ?? 'sampling';
}

/** Text Completions sampler tools: an action row for each button, with the tooltip beside it as the subtitle. */
function getSamplerToolbarControlBlock() {
    const reset = document.getElementById('samplerResetButton');
    if (!(reset instanceof HTMLElement) || !samplingModule) {
        return null;
    }

    const block = createElement('div', { className: 'sb-sampling-sampler-tools-card' });
    for (const button of [reset, document.getElementById('samplerSelectButton')]) {
        if (button instanceof HTMLElement) {
            block.append(samplingModule.createActionRow(button, samplingModule.readTooltip(button.parentElement?.querySelector(':scope > .fa-circle-info'))));
        }
    }

    return block;
}

function neutralizeChatCompletionSamplers() {
    const values = {
        '#temp_openai': 1,
        '#top_p_openai': 1,
        '#top_k_openai': 0,
        '#min_p_openai': 0,
        '#top_a_openai': 0,
        '#repetition_penalty_openai': 1,
        '#freq_pen_openai': 0,
        '#pres_pen_openai': 0,
    };

    for (const [selector, value] of Object.entries(values)) {
        const input = document.querySelector(selector);
        if (input instanceof HTMLInputElement) {
            input.value = String(value);
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }

    ['#claude_disable_temperature', '#claude_disable_top_p'].forEach(selector => {
        const input = document.querySelector(selector);
        if (input instanceof HTMLInputElement) {
            input.checked = false;
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }
    });
}

const SAMPLING_SELECTOR_TO_CANONICAL_ID = Object.freeze({
    '#temp_openai': 'temperature',
    '#temp_textgenerationwebui': 'temperature',
    '#top_p_openai': 'top_p',
    '#top_p_textgenerationwebui': 'top_p',
    '#pres_pen_openai': 'presence_penalty',
    '#presence_pen_textgenerationwebui': 'presence_penalty',
    '#freq_pen_openai': 'frequency_penalty',
    '#freq_pen_textgenerationwebui': 'frequency_penalty',
    '#typical_p_textgenerationwebui': 'typical_p',
});

/**
 * The transmission policy of a sampler, for the wire row that the Sampling module builds after its slider row.
 * @param {string} selector
 * @returns {{parameterId: string, read: Function, write: Function}|null}
 */
function getSamplingWire(selector) {
    const parameterId = SAMPLING_SELECTOR_TO_CANONICAL_ID[selector];
    if (!parameterId || !SAMPLING_PARAMETER_DESCRIPTORS[parameterId]) {
        return null;
    }
    const textGeneration = selector.includes('textgenerationwebui');
    return {
        parameterId,
        read: () => (textGeneration ? getTextSamplingParameterViewModel : getSamplingParameterViewModel)(parameterId),
        write: state => (textGeneration ? setTextSamplingParameterTransmissionState : setSamplingParameterTransmissionState)(parameterId, state),
    };
}

function refreshSamplingTransmission(card, selector) {
    const wire = getSamplingWire(selector);
    if (wire) {
        samplingModule?.syncWireRow(card, wire.read());
    }
}

function decorateSamplingControlCard(card, selector) {
    if (card instanceof HTMLElement && getSamplingWire(selector)) {
        card.dataset.samplingParameter = SAMPLING_SELECTOR_TO_CANONICAL_ID[selector];
    }
}

/** Chat Completions counterpart of the Text Completions sampler tools (`#samplerResetButton` row). */
function getChatSamplerToolbarControlBlock() {
    const existing = document.getElementById('sb_neutralize_chat_samplers');
    if (existing instanceof HTMLElement) return existing.closest('.sb-sampling-sampler-tools-card');
    if (!samplingModule) return null;

    const block = createElement('div', { className: 'sb-sampling-sampler-tools-card' });
    const button = createElement('button', {
        id: 'sb_neutralize_chat_samplers',
        className: 'menu_button whitespacenowrap sb-neutralize-chat-samplers',
        text: 'Neutralize Samplers',
        attrs: { type: 'button', 'data-i18n': 'Neutralize Samplers' },
    });
    button.addEventListener('click', neutralizeChatCompletionSamplers);
    block.append(samplingModule.createActionRow(button, {
        text: 'Set all samplers to their neutral/disabled state.',
        key: 'Set all samplers to their neutral/disabled state.',
    }));
    return block;
}

function getSamplingControlBlock(selector) {
    const input = document.querySelector(selector);
    if (!(input instanceof HTMLElement)) {
        return null;
    }

    if (SB_SAMPLER_ENTRY_BY_SELECTOR.get(selector)?.expander || input.matches('#cfg_block_ooba, #grammar_block_ooba, #json_schema_block, #banned_tokens_block_ooba, #logit_bias_block_ooba, [id^="sampler_order_block_"], [id^="sampler_priority_block_"]')) {
        return input;
    }

    if (input.matches('input[type="checkbox"]')) {
        return input.closest('.checkbox_label') ?? input.parentElement;
    }

    return input.closest('.range-block')
        ?? input.closest('[data-tg-samplers]')
        ?? input.parentElement;
}

function buildSamplingControlCard(selector, root = document) {
    const controlBlock = selector === '#samplerResetButton'
        ? getSamplerToolbarControlBlock()
        : selector === '#sb_neutralize_chat_samplers'
            ? getChatSamplerToolbarControlBlock()
            : getSamplingControlBlock(selector);
    if (!(controlBlock instanceof HTMLElement)) {
        return null;
    }

    const entry = SB_SAMPLER_ENTRY_BY_SELECTOR.get(selector);
    const isExpander = Boolean(entry?.expander);
    let card;
    if (isExpander) {
        const heading = controlBlock.querySelector(':scope > h4');
        // A header toggle may already be normalized; its subtitle is not part of the sampler name.
        const headingCopy = heading?.cloneNode(true);
        headingCopy?.querySelectorAll('.ds-row-subtitle, [data-sb-copy-placeholder]').forEach(node => node.remove());
        const labelText = headingCopy?.textContent.replace(/\s+/g, ' ').trim() || 'lorum ipsum';
        const tooltip = heading?.matches('[title], [data-sttt--title]') ? heading : heading?.querySelector('[title], [data-sttt--title]');
        const subtitleText = entry?.description || tooltip?.getAttribute('title') || tooltip?.getAttribute('data-sttt--title') || 'lorum ipsum';
        // SillyBunny: move header toggles into the expander body as full-width live preference rows.
        for (const label of controlBlock.querySelectorAll(':scope > h4 .checkbox_label')) controlBlock.prepend(label);
        const expander = createExpanderRow({ label: labelText, subtitle: subtitleText, field: `sampler-${entry.id}`, children: [controlBlock] });
        card = expander.row;
        expander.content.classList.add('sb-sampling-multi-card');
        const label = card.querySelector('.ds-row-label');
        const subtitle = card.querySelector('.ds-row-subtitle');
        if (labelText === 'lorum ipsum') label.dataset.sbCopyPlaceholder = 'true';
        if (entry?.description) subtitle.dataset.i18n = entry.description;
        if (subtitleText === 'lorum ipsum') subtitle.dataset.sbCopyPlaceholder = 'true';
    } else {
        card = createElement('div', { className: 'sb-sampling-row' });
        card.appendChild(controlBlock);
    }
    card.classList.add('sb-sampling-control-card');
    card.dataset.sbSamplingControl = selector;
    if (entry) card.dataset.sbSamplerId = entry.id;
    samplingModule?.prepareSamplingBlock(selector, controlBlock, { root });
    // Ungated samplers stay visible for every provider; gating code in openai.js and
    // textgen-settings.js skips elements carrying this marker.
    if (entry && !entry.gated) {
        for (const element of [controlBlock, ...controlBlock.querySelectorAll('[data-source], [data-tg-type]')]) {
            element.setAttribute('data-sb-sampler-ungated', '');
        }
    }
    for (const attributeName of ['data-source', 'data-source-mode', 'data-sb-sampler-ungated']) {
        if (controlBlock.hasAttribute(attributeName)) {
            card.setAttribute(attributeName, controlBlock.getAttribute(attributeName));
        }
    }
    decorateSamplingControlCard(card, selector);
    // The lists stay lists: their entries are data, not settings rows.
    normalizeBackendSettingsRows(card, { skip: '.sb-sampling-list' });
    applySamplingSubtitleSource(card, entry, root);
    samplingModule?.finishSamplingCard(card, { wire: getSamplingWire(selector) });
    addSamplingDescriptionToggles(card);
    return card;
}

/** Slider explanations stay searchable and translated, but open only when the reader needs them. */
function addSamplingDescriptionToggles(card) {
    for (const row of card.querySelectorAll('.ds-row-slider, .sb-sampling-wire')) {
        if (row.querySelector('.sb-sampling-help-toggle')) continue;
        const text = row.querySelector(':scope > .ds-row-text');
        const label = text?.querySelector(':scope > .ds-row-label');
        const subtitle = text?.querySelector(':scope > .ds-row-subtitle:not([data-sb-copy-placeholder])');
        // The wire row of a sampler is named by that sampler's slider.
        const isWire = row.classList.contains('sb-sampling-wire');
        const control = (isWire ? card.querySelector(':scope > .ds-row-slider') : row)?.querySelector('input[type="range"][id]');
        if (!label || !subtitle || !control) continue;
        const key = isWire ? `${control.id}-wire` : control.id;

        label.id ||= `sb-sampler-${key}-label`;
        subtitle.id ||= `sb-sampler-${key}-help`;
        subtitle.classList.add('sb-sampling-help');
        subtitle.hidden = true;
        const button = createElement('button', {
            className: 'sb-sampling-help-toggle',
            attrs: { type: 'button', 'aria-expanded': 'false', 'aria-controls': subtitle.id, 'data-sb-keeps-sensitive': '' },
        });
        const name = createElement('span', {
            className: 'sr-only', text: 'Details',
            attrs: { id: `sb-sampler-${key}-help-label`, 'data-i18n': 'Details' },
        });
        const sliderLabelId = isWire ? card.querySelector(':scope > .ds-row-slider > .ds-row-text > .ds-row-label')?.id : '';
        button.setAttribute('aria-labelledby', [sliderLabelId, label.id, name.id].filter(Boolean).join(' '));
        button.append(createElement('i', { className: 'fa-solid fa-circle-info', attrs: { 'aria-hidden': 'true' } }), name);
        button.addEventListener('click', () => {
            subtitle.hidden = !subtitle.hidden;
            button.setAttribute('aria-expanded', String(!subtitle.hidden));
        });
        text.append(button);
        row.append(subtitle);
        row.classList.add('sb-sampling-help-row');
    }
}

/** Reuses another backend's subtitle (text and i18n key) when this card's native markup has none. */
function applySamplingSubtitleSource(card, entry, root) {
    if (!entry?.subtitleSource) return;
    const placeholder = card.querySelector('.ds-row-subtitle[data-sb-copy-placeholder]');
    const source = root.querySelector(entry.subtitleSource);
    if (!(placeholder instanceof HTMLElement) || !(source instanceof HTMLElement) || source.hasAttribute('data-sb-copy-placeholder')) return;
    const text = source.textContent.trim();
    if (!text) return;
    placeholder.textContent = text;
    delete placeholder.dataset.sbCopyPlaceholder;
    if (source.dataset.i18n) placeholder.dataset.i18n = source.dataset.i18n;
}

/**
 * Text Completions samplers that Chat Completions has no setting for. They are listed in the CC
 * section as inert rows so both lists read the same; gated mechanisms are left out because TC only
 * shows them for some backend types.
 */
const SB_CC_PLACEHOLDER_SAMPLERS = Object.freeze(SB_SAMPLER_REGISTRY.filter(entry => entry.textgenerationwebui && !entry.openai && !entry.gated));
const SB_CC_PLACEHOLDER_SUBTITLE = 'Not available in Chat Completions. Custom endpoints can send it with Additional Parameters.';

/** Registry position of a sampling card, so placeholder rows sort beside real controls. */
function getSamplingCardRank(card) {
    const entry = SB_SAMPLER_ENTRY_BY_SELECTOR.get(card.dataset.sbSamplingControl)
        ?? SB_SAMPLER_REGISTRY.find(candidate => candidate.id === card.dataset.sbSamplerId);
    const index = SB_SAMPLER_REGISTRY.indexOf(entry);
    if (index < 0) return Number.MAX_SAFE_INTEGER;
    const selectors = Object.values(entry).flat().filter(value => typeof value === 'string');
    return index + Math.max(0, selectors.indexOf(card.dataset.sbSamplingControl)) / 100;
}

/** Builds an inert CC row from the live Text Completions card's label; returns null until that card exists. */
function buildChatCompletionPlaceholderCard(entry, root) {
    const source = root.querySelector(`#sb-sampling-textgenerationwebui [data-sb-sampling-control="${entry.textgenerationwebui}"]`);
    const sourceLabel = source?.querySelector(entry.expander ? ':scope > .ds-row-expander__header .ds-row-label' : '.ds-row-label');
    const labelText = sourceLabel?.textContent.replace(/\s+/g, ' ').trim();
    if (!labelText || sourceLabel.hasAttribute('data-sb-copy-placeholder')) return null;

    const card = createElement('div', {
        className: 'sb-sampling-control-card sb-sampling-row sb-sampling-placeholder-card',
        attrs: { 'data-sb-sampling-placeholder': '', 'data-sb-sampler-id': entry.id },
    });
    const badge = createElement('span', { className: 'sb-sampling-unavailable-badge' });
    badge.append(
        createElement('i', { className: 'fa-solid fa-ban', attrs: { 'aria-hidden': 'true' } }),
        createElement('span', { text: 'Unavailable', attrs: { 'data-i18n': 'Unavailable' } }),
    );
    const { row } = createRow({ label: labelText, subtitle: SB_CC_PLACEHOLDER_SUBTITLE, field: `sampler-${entry.id}-unavailable`, suffix: badge });
    // The row has no control to disable, so it takes the insensitive look without `inert`: the reason stays readable to a screen reader.
    row.classList.add('is-insensitive');
    row.setAttribute('aria-disabled', 'true');
    const label = row.querySelector('.ds-row-label');
    const i18nKey = sourceLabel.getAttribute('data-i18n') ?? sourceLabel.querySelector(':scope > [data-i18n]')?.getAttribute('data-i18n');
    if (i18nKey && !i18nKey.startsWith('[')) label.dataset.i18n = i18nKey;
    row.querySelector('.ds-row-subtitle').dataset.i18n = SB_CC_PLACEHOLDER_SUBTITLE;
    card.append(row);
    return card;
}

function syncChatCompletionPlaceholderCards(root) {
    const section = root.querySelector('#sb-sampling-openai');
    if (!(section instanceof HTMLElement)) return false;
    let built = false;
    for (const entry of SB_CC_PLACEHOLDER_SAMPLERS) {
        if (section.querySelector(`[data-sb-sampling-placeholder][data-sb-sampler-id="${entry.id}"]`)) continue;
        const target = section.querySelector(`[data-sb-sampling-group="${entry.group}"] > .ds-pref-group`);
        const card = target instanceof HTMLElement ? buildChatCompletionPlaceholderCard(entry, root) : null;
        if (!card) continue;
        target.append(card);
        built = true;
    }
    return built;
}

function drawerHasControls(drawer) {
    if (!(drawer instanceof HTMLElement)) {
        return false;
    }

    const content = drawer.querySelector('.inline-drawer-content');
    if (!(content instanceof HTMLElement)) {
        return false;
    }

    return Boolean(content.querySelector([
        '.range-block',
        '[data-tg-samplers]',
        'select',
        'textarea',
        'button',
        '.menu_button',
        'input:not([type="hidden"])',
    ].join(',')));
}

function hideEmptyGroupedSettingsDrawers() {
    // Flattened sections are skipped: they have no `.inline-drawer-content` left, so the control
    // test would report them empty and hide a section that only exists while expanded.
    document.querySelectorAll('#range_block_openai .sb-openai-settings-drawer, #textgenerationwebui_api-settings .sb-textgen-drawers > .inline-drawer').forEach(drawer => {
        if (!(drawer instanceof HTMLElement) || !drawer.classList.contains('inline-drawer')) {
            return;
        }

        drawer.style.display = drawerHasControls(drawer) ? '' : 'none';
    });
}

function updateSamplingCardVisibility(section) {
    if (!(section instanceof HTMLElement)) {
        return;
    }

    // Read every card's state before writing any `hidden`, so the pass costs one style flush, not one per card.
    const cardVisibility = Array.from(section.querySelectorAll('[data-sb-sampling-control]'))
        .filter(card => card instanceof HTMLElement)
        .map(card => {
            const content = card.querySelector(':scope > .ds-row-expander-content') ?? card;
            const hasVisibleContent = Array.from(content.children).some(child => child instanceof HTMLElement
                && !child.classList.contains('sb-sampling-wire')
                && getComputedStyle(child).display !== 'none');
            return [card, hasVisibleContent];
        });
    for (const [card, hasVisibleContent] of cardVisibility) {
        if (card.hidden !== !hasVisibleContent) card.hidden = !hasVisibleContent;
    }

    // Track visibility as we write: the `card.hidden` writes have not been flushed yet, so a
    // checkVisibility() here would force the very layout this function is trying to avoid.
    const visibleCards = new Set(cardVisibility.filter(([, visible]) => visible).map(([card]) => card));
    const groups = [];
    for (const group of section.querySelectorAll('[data-sb-sampling-group]')) {
        if (!(group instanceof HTMLElement)) continue;
        // Placeholder rows have no gated content, so they always keep their group visible.
        const hasSamplingCard = Boolean(group.querySelector('[data-sb-sampling-placeholder]'))
            || [...group.querySelectorAll('[data-sb-sampling-control]')].some(card => visibleCards.has(card));
        groups.push([group, !hasSamplingCard]);
    }
    for (const [group, hidden] of groups) {
        if (group.hidden !== hidden) group.hidden = hidden;
    }
}

function sortSamplingSectionCards(section) {
    for (const group of section.querySelectorAll('[data-sb-sampling-group] > .ds-pref-group')) {
        const cards = [...group.querySelectorAll(':scope > [data-sb-sampling-control], :scope > [data-sb-sampling-placeholder]')];
        const sorted = [...cards].sort((a, b) => getSamplingCardRank(a) - getSamplingCardRank(b));
        if (sorted.some((card, index) => card !== cards[index])) group.append(...sorted);
    }
}

function resyncUngatedSamplerVisibility(section, backendId) {
    // Cards built after the backend's own gating pass may still carry its inline display:none.
    $(section).find('[data-sb-sampler-ungated]').filter('[data-source], [data-tg-type]').show();
    if (backendId === 'textgenerationwebui') showTGSamplerControls();
}

function syncSamplingPanelControls(root) {
    if (!(root instanceof HTMLElement)) {
        return;
    }

    for (const backend of SB_SAMPLING_BACKENDS) {
        const section = root.querySelector(`#sb-sampling-${backend.id}`);
        if (!(section instanceof HTMLElement)) {
            continue;
        }

        section.querySelector('.sb-sampling-note')?.remove();

        let builtCards = false;
        const backendControls = getSamplingBackendControls(backend.id);

        for (const selector of backendControls) {
            const groupId = getSamplingGroupId(selector);
            const target = section.querySelector(`[data-sb-sampling-group="${groupId}"] > .ds-pref-group`);
            if (!(target instanceof HTMLElement)) throw new Error(`Missing Sampling group: ${backend.id}/${groupId}`);
            const existingCard = Array.from(section.querySelectorAll('[data-sb-sampling-control]'))
                .find(card => card instanceof HTMLElement && card.dataset.sbSamplingControl === selector);
            if (existingCard instanceof HTMLElement && existingCard.children.length > 0) {
                if (existingCard.parentElement !== target) {
                    target.appendChild(existingCard);
                }
                refreshSamplingTransmission(existingCard, selector);
                continue;
            }

            existingCard?.remove();

            const card = buildSamplingControlCard(selector, root);
            if (card) {
                target.appendChild(card);
                builtCards = true;
            }
        }

        if (backend.id === 'openai' && syncChatCompletionPlaceholderCards(root)) builtCards = true;

        if (builtCards) {
            sortSamplingSectionCards(section);
            section.dataset.sbUngatedResyncPending = 'true';
        }
        // Base gating and manual sampler hiding query the live document, so wait until the panel is attached.
        if (section.dataset.sbUngatedResyncPending && section.isConnected) {
            delete section.dataset.sbUngatedResyncPending;
            resyncUngatedSamplerVisibility(section, backend.id);
        }

        if (!section.querySelector('[data-sb-sampling-control]') && !section.querySelector('[data-sb-sampling-placeholder]')) {
            section.appendChild(createElement('p', {
                className: 'sb-sampling-note',
                text: 'Sampler controls are not ready yet. Reopen the Backend menu after settings finish loading.',
            }));
        }

        updateSamplingCardVisibility(section);
    }

    samplingModule?.syncSamplingDependents(root);
    hideEmptyGroupedSettingsDrawers();
}

function updateSamplingPanelVisibility(root) {
    if (!(root instanceof HTMLElement)) {
        return;
    }

    syncSamplingPanelControls(root);

    const activeApi = getCurrentMainApiValue();
    let activeSection = null;

    for (const section of root.querySelectorAll('[data-sb-sampling-apis]')) {
        if (!(section instanceof HTMLElement)) {
            continue;
        }

        const apiIds = String(section.dataset.sbSamplingApis ?? '').split(',');
        const isActive = apiIds.includes(activeApi);
        section.hidden = !isActive;

        if (isActive) {
            activeSection = section;
        }
    }

    const empty = root.querySelector('#sb-sampling-empty');
    if (empty instanceof HTMLElement) {
        empty.hidden = Boolean(activeSection);
    }
}

// SillyBunny: one line under the page header, without a box: the backend label, and a note when the page has one.
function createBackendSectionHeader({ title = '', modeAttrs = {}, note = '' }) {
    const header = createElement('div', { className: 'sb-backend-section-header' });
    const titleRow = createElement('div', { className: 'sb-backend-title-row' });
    const mode = createElement('span', { className: 'sb-sampling-mode-pill', text: title, attrs: modeAttrs });
    titleRow.append(mode);
    header.append(titleRow);
    if (note) header.append(createElement('p', { className: 'sb-sampling-header-note', text: note, attrs: { 'data-i18n': note } }));
    return header;
}

// SillyBunny: manually built Backend groups share the Messages category-heading anatomy.
function createBackendGroupHeader(title, attrs = {}, description = '') {
    const header = createElement('div', { className: 'sb-settings-flat-header sb-settings-category-header' });
    const heading = createElement('div', { className: 'flex-container flexFlowColumn sb-settings-category-heading' });
    heading.append(createElement('h3', {
        className: 'ds-pref-group-heading sb-settings-category-title',
        text: title,
        attrs: { 'data-i18n': title, ...attrs },
    }));
    if (description) {
        heading.append(createElement('small', {
            text: description,
            attrs: description === 'TODO(copy)' ? { 'data-sb-copy-placeholder': 'true' } : { 'data-i18n': description },
        }));
    }
    header.append(heading);
    return header;
}

async function buildSamplingPanel() {
    samplingModule ??= await loadSamplingModule();
    await samplingModule.loadSamplingStyles();
    const { panel, scroller } = createShellPanel({ id: 'sampling' });
    const column = createElement('div', {
        className: 'sb-shell-column sb-sampling-panel',
        attrs: { 'data-sb-presentation': 'manual' },
    });

    const sections = createElement('div', { className: 'sb-sampling-sections' });
    for (const backend of SB_SAMPLING_BACKENDS) {
        const section = createElement('section', {
            id: `sb-sampling-${backend.id}`,
            className: 'sb-sampling-section',
            attrs: {
                'data-sb-sampling-apis': backend.apiIds.join(','),
            },
        });
        section.append(createBackendSectionHeader({
            title: `Backend: ${backend.title}`,
            note: 'Some backends ignore samplers they do not support',
        }));
        for (const group of SB_SAMPLING_GROUPS) {
            const category = createElement('section', {
                className: 'sb-sampling-group',
                attrs: { 'data-sb-sampling-group': group.id },
            });
            category.append(
                createBackendGroupHeader(group.title, group.i18n ? { 'data-i18n': group.i18n } : {}, group.description),
                createElement('div', { className: 'ds-pref-group' }),
            );
            section.append(category);
        }
        sections.appendChild(section);
    }

    const empty = createElement('div', {
        id: 'sb-sampling-empty',
        className: 'sb-sampling-empty sb-shell-callout',
        html: '<strong>No unified samplers for this backend yet</strong><p>This POC currently supports Chat Completions, Text Completions, Kobold/Kobold Horde, and NovelAI.</p>',
    });

    column.append(sections, empty);
    scroller.appendChild(column);
    let visibilityQueued = false;
    const visibilityObserver = new MutationObserver(mutations => {
        if (visibilityQueued || !mutations.some(({ target }) => target instanceof HTMLElement && target.matches('[data-source], [data-tg-type], [data-tg-samplers]'))) return;
        visibilityQueued = true;
        window.requestAnimationFrame(() => {
            visibilityQueued = false;
            sections.querySelectorAll('.sb-sampling-section').forEach(updateSamplingCardVisibility);
        });
    });
    visibilityObserver.observe(sections, { subtree: true, attributes: true, attributeFilter: ['style'] });

    $('#main_api').on('change.sbSamplingPanel', () => {
        if (isShellTabOpen('left', 'sampling')) updateSamplingPanelVisibility(column);
    });
    $(document).on('change.sbSamplingTransmission', 'select', () => updateSamplingPanelVisibility(column));
    updateSamplingPanelVisibility(column);
    window.requestAnimationFrame(() => updateSamplingPanelVisibility(column));
    window.setTimeout(() => updateSamplingPanelVisibility(column), 250);
    window.setTimeout(() => updateSamplingPanelVisibility(column), 1000);

    return {
        id: 'sampling',
        panel,
        button: null,
        searchRoot: column,
        onActivate: () => updateSamplingPanelVisibility(column),
    };
}

function buildInChatAgentsPanel() {
    const { panel, scroller } = createShellPanel({
        id: 'agents',
    });

    const column = createElement('div', {
        className: 'sb-shell-column ica-agents-column',
        attrs: { 'data-sb-presentation': 'manual' },
    });
    const controller = mountAgentsPanel(column);
    scroller.appendChild(column);

    return {
        id: 'agents',
        panel,
        button: null,
        searchRoot: column,
        onActivate: () => { controller.prepareReveal(); controller.onReveal(); },
    };
}

function createBackendPromptGroup(id, title) {
    const group = createElement('section', { id, className: 'sb-prompting-group' });
    group.append(
        createElement('h3', { className: 'ds-pref-group-heading', text: title, attrs: { 'data-i18n': title } }),
        createElement('div', { className: 'ds-pref-group sb-prompting-group-body' }),
    );
    return group;
}

const SB_EDITOR_UTILITY_PROMPT_IDS = Object.freeze([
    'impersonation_prompt_textarea', 'wi_format_textarea', 'scenario_format_textarea', 'personality_format_textarea',
    'group_nudge_prompt_textarea', 'newchat_prompt_textarea', 'newgroupchat_prompt_textarea',
    'newexamplechat_prompt_textarea', 'continue_nudge_prompt_textarea', 'send_if_empty_textarea',
]);

function prepareEditorPanel(root) {
    if (root.dataset.sbEditorPrepared === 'true') return;
    root.dataset.sbEditorPrepared = 'true';
    root.dataset.sbPresentation = 'manual';
    root.classList.add('sb-prompting-panel', 'sb-editor-panel');
    // The prompt list's header bar carries the presets, the backend, the way back to Presets and the two states, so the list starts under the page header.
    for (const [id, title] of [
        ['sb-editor-utility', 'Utility Prompts'],
        ['sb-editor-sysprompt', 'System Prompt'],
        ['sb-editor-instruct', 'Instruct Template'],
        ['sb-editor-context', 'Context Template'],
    ]) root.append(createBackendPromptGroup(id, title));
}

function buildEditorPanel() {
    const { panel, scroller } = createShellPanel({ id: 'editor' });
    const column = createElement('div', { className: 'sb-shell-column' });
    prepareEditorPanel(column);
    initializePromptEditor(column, { openPresets: () => openShell('left', 'prompting') });
    scroller.append(column);
    return { panel, scroller, searchRoot: column, onActivate: () => {
        groupAdvancedFormattingIntoDrawers();
        updateEditorPanel(panel);
    } };
}

function updateEditorPanel(panel = getShellState('left')?.tabs.get('editor')?.panel) {
    const root = panel?.querySelector('.sb-editor-panel');
    if (!(root instanceof HTMLElement)) return;
    const activeApi = getCurrentMainApiValue();
    const isChatCompletion = activeApi === 'openai';
    const backend = SB_SAMPLING_BACKENDS.find(entry => entry.apiIds.includes(activeApi));
    const mode = root.querySelector('[data-sb-editor-mode]');
    const modeLabel = backend?.title ?? activeApi;
    if (mode && mode.textContent !== modeLabel) mode.textContent = modeLabel;

    const adoptDocument = (id, groupId, wrapperSelector = null) => {
        const field = document.getElementById(id);
        const body = root.querySelector(`#${groupId} > .sb-prompting-group-body`);
        if (!(field instanceof HTMLElement) || !(body instanceof HTMLElement)) return;
        const documentNode = field.closest('[data-sb-editor-document]')
            ?? (wrapperSelector ? field.closest(wrapperSelector) : field.parentElement);
        if (!(documentNode instanceof HTMLElement)) return;
        if (documentNode.dataset.sbEditorDocument !== 'true') documentNode.dataset.sbEditorDocument = 'true';
        if (documentNode.parentElement !== body) body.append(documentNode);
    };

    const manager = document.getElementById('sb-openai-prompt-manager');
    if (manager instanceof HTMLElement) {
        if (manager.parentElement !== root || manager.previousElementSibling) root.prepend(manager);
        if (manager.style.display) manager.style.display = '';
        if (!manager.classList.contains('sb-prompting-group')) manager.classList.add('sb-prompting-group');
        // The flatten pass visits descendants, so include the group's outer drawer via its parent.
        flattenNestedSettingsDrawers(root, { includeTopLevel: true });
        let body = manager.querySelector(':scope > .sb-prompting-group-body');
        if (!(body instanceof HTMLElement)) {
            body = createElement('div', { className: 'ds-pref-group sb-prompting-group-body' });
            for (const child of [...manager.children]) {
                if (!child.classList.contains('sb-settings-flat-header')) body.append(child);
            }
            manager.append(body);
        }
        const block = document.getElementById('completion_prompt_manager')?.closest('.range-block');
        if (block instanceof HTMLElement && !manager.contains(block)) body.append(block);
        if (manager.hidden === isChatCompletion) manager.hidden = !isChatCompletion;
    }
    for (const id of SB_EDITOR_UTILITY_PROMPT_IDS) adoptDocument(id, 'sb-editor-utility', '.range-block');
    for (const id of ['sysprompt_content', 'sysprompt_post_history']) adoptDocument(id, 'sb-editor-sysprompt');
    const sequences = document.getElementById('InstructSequencesColumn');
    const instructBody = root.querySelector('#sb-editor-instruct > .sb-prompting-group-body');
    if (sequences instanceof HTMLElement && sequences.parentElement !== instructBody) instructBody.append(sequences);
    for (const id of ['context_story_string', 'context_story_string_position', 'context_example_separator']) {
        adoptDocument(id, 'sb-editor-context', '[data-cc-null]');
    }
    for (const id of ['sb-editor-utility', 'sb-editor-sysprompt', 'sb-editor-instruct', 'sb-editor-context']) {
        const group = root.querySelector(`#${id}`);
        if (!(group instanceof HTMLElement)) continue;
        const hidden = (id === 'sb-editor-utility' ? !isChatCompletion : isChatCompletion)
            || !group.querySelector('textarea, select, input');
        if (group.hidden !== hidden) group.hidden = hidden;
    }
    root.querySelector('#sb-editor-sysprompt').classList.toggle('disabled', document.getElementById('SystemPromptBlock')?.classList.contains('disabled') ?? false);

    const selectedName = id => {
        const select = document.getElementById(id);
        return select instanceof HTMLSelectElement ? select.selectedOptions[0]?.textContent : null;
    };
    const presetNames = isChatCompletion
        ? [selectedName('settings_preset_openai')]
        : ['sysprompt_select', 'instruct_presets', 'context_presets'].map(id => {
            const title = ({ sysprompt_select: 'System Prompt', instruct_presets: 'Instruct Template', context_presets: 'Context Template' })[id];
            const name = selectedName(id);
            return name ? `${title}: ${name}` : null;
        });
    const names = presetNames.filter(Boolean).join(' · ');
    const meta = root.querySelector('[data-sb-editor-preset]');
    if (meta && meta.textContent !== names) meta.textContent = names;
    refreshPresetProtectionUi();
    for (const group of root.querySelectorAll('.sb-prompting-group:not(#sb-openai-prompt-manager)')) normalizeBackendSettingsRows(group);
    for (const wrapper of root.querySelectorAll('[data-sb-editor-document]:not(.ds-row):not(.sb-settings-row-wrapper)')) wrapper.classList.add('sb-settings-row-wrapper');
    groupPromptingRowHelpers(root);
    const tab = getShellState('left')?.tabs.get('editor');
    if (tab) tab.searchIndex = null;
}

function preparePromptingPanel(root) {
    if (root.dataset.sbPromptingPrepared === 'true') return;
    root.dataset.sbPromptingPrepared = 'true';
    root.classList.add('sb-prompting-panel');
    root.dataset.sbPresentation = 'manual';
    const completionTabs = /** @type {{openAITabManager?: {refreshTabs: () => void}}|undefined} */ (window['ChatCompletionTabs']);
    completionTabs?.openAITabManager?.refreshTabs();
    const configuration = root.querySelector('#ai_response_configuration');
    if (!(configuration instanceof HTMLElement)) return;

    configuration.prepend(createBackendSectionHeader({ modeAttrs: { 'data-sb-prompting-mode': '' } }));
    const presetsContainer = configuration.querySelector('#respective-presets-block');

    for (const [id, title, description] of [
        ['respective-presets-block', 'Presets', 'Choose and manage presets for the current backend'],
        ['common-gen-settings-block', 'Generation Settings', 'Set context and reply limits, streaming, and other generation options'],
    ]) {
        const block = configuration.querySelector(`#${id}`);
        if (!(block instanceof HTMLElement)) continue;
        block.classList.add('sb-prompting-group');
        block.prepend(createBackendGroupHeader(title, {}, description));
        const body = createElement('div', { className: 'ds-pref-group sb-prompting-group-body' });
        for (const child of [...block.children].slice(1)) body.append(child);
        block.append(body);
    }
    const editPrompts = createButtonRow({
        label: t`Edit Prompts`,
        field: 'edit-prompts',
        arrow: true,
        onActivate: () => openShell('left', 'editor'),
    });
    editPrompts.row.dataset.sbEditPrompts = '';
    presetsContainer?.querySelector(':scope > .sb-prompting-group-body')?.append(editPrompts.row);
    mountPresetLinkingGroup(presetsContainer);
    const generation = configuration.querySelector('#pro-settings-block');
    if (generation instanceof HTMLElement) {
        for (const id of ['streaming_textgenerationwebui_block', 'streaming_kobold_block', 'streaming_novel_block']) {
            const streaming = configuration.querySelector(`#${id}`);
            if (streaming) generation.append(streaming);
        }
    }

    const createPromptingGroup = (id, title, description = '') => {
        const existing = configuration.querySelector(`#${CSS.escape(id)}`);
        if (existing instanceof HTMLElement) return existing;
        const group = createBackendPromptGroup(id, title);
        group.firstElementChild.replaceWith(createBackendGroupHeader(title, {}, description));
        configuration.append(group);
        return group;
    };

    for (const [id, title, description] of [
        ['sb-tc-sysprompt', 'System Prompt', 'Choose and manage system prompt presets'],
        ['sb-tc-instruct', 'Instruct Template', 'Choose an instruct template and adjust how it formats messages for the AI'],
        ['sb-tc-context', 'Context Template', 'Choose a context template and adjust its stopping rules'],
        ['sb-tc-names', 'Character Names', 'Choose whether to add the character\'s name outside Instruct Mode'],
        ['sb-reasoning-template', 'Reasoning Template', 'Saves the reasoning prefix, suffix and separator under a name'],
    ]) createPromptingGroup(id, title, description);

    // SillyBunny: keep range_block_openai around its groups for provider visibility and preset lookups.
    const range = configuration.querySelector('#range_block_openai');
    const advanced = configuration.querySelector('#advanced-ai-config-block');
    if (range instanceof HTMLElement && advanced instanceof HTMLElement) advanced.prepend(range);
    mountPresetRows(root);
}

function updatePromptingPanel(panel) {
    if (!(panel instanceof HTMLElement)) return;
    groupAdvancedFormattingIntoDrawers();
    const root = panel.querySelector('.sb-prompting-panel');
    if (!(root instanceof HTMLElement)) return;
    const activeApi = getCurrentMainApiValue();
    const backend = SB_SAMPLING_BACKENDS.find(entry => entry.apiIds.includes(activeApi));
    const mode = root.querySelector('[data-sb-prompting-mode]');
    const modeLabel = `Backend: ${backend?.title ?? activeApi}`;
    if (mode && mode.textContent !== modeLabel) mode.textContent = modeLabel;
    const bindModelPresetBlock = root.querySelector('[name="bindModelPresetBlock"]') ?? document.querySelector('[name="bindModelPresetBlock"]');
    if (bindModelPresetBlock instanceof HTMLElement && bindModelPresetBlock.hidden !== (activeApi === 'openai')) bindModelPresetBlock.hidden = activeApi === 'openai';

    flattenNestedSettingsDrawers(root, { includeTopLevel: true });
    updateEditorPanel();
    const range = root.querySelector('#range_block_openai');
    // SillyBunny: Quick Prompts remain mounted for upstream integrations; the Prompt Manager is their single editor.
    const quickPrompts = root.querySelector('#sb-openai-prompts');
    if (quickPrompts instanceof HTMLElement && !quickPrompts.hidden) quickPrompts.hidden = true;
    const reasoningBody = root.querySelector('#sb-reasoning-template > .sb-prompting-group-body');
    const reasoningDetails = document.getElementById('reasoning_select')?.closest('details');
    if (reasoningBody instanceof HTMLElement && reasoningDetails instanceof HTMLElement) {
        for (const child of [...reasoningDetails.children]) {
            if (child.tagName !== 'SUMMARY') reasoningBody.append(child);
        }
        if (!reasoningDetails.hidden) reasoningDetails.hidden = true;
    }
    const isChatCompletion = activeApi === 'openai';
    const promptingGroupIds = [
        'sb-openai-budget', 'sb-openai-sampling', 'sb-openai-names', 'sb-openai-prefill',
        'sb-openai-request',
        'sb-tc-sysprompt', 'sb-tc-instruct', 'sb-tc-context', 'sb-tc-names',
    ];
    for (const id of promptingGroupIds) {
        const group = root.querySelector(`#${id}`);
        if (!(group instanceof HTMLElement)) continue;
        if (id.startsWith('sb-openai-') && range instanceof HTMLElement && group.parentElement !== range) range.append(group);
        group.classList.toggle('sb-prompting-group', true);
        if (id === 'sb-openai-budget') {
            const title = group.querySelector('.sb-settings-flat-header :is(b, h3)');
            if (title && title.textContent !== 'Generation Settings') title.textContent = 'Generation Settings';
        }
        if (!group.querySelector(':scope > .sb-prompting-group-body')) {
            const body = createElement('div', { className: 'ds-pref-group sb-prompting-group-body' });
            for (const child of [...group.children]) {
                if (!child.classList.contains('sb-settings-flat-header')) body.append(child);
            }
            group.append(body);
        }
        normalizeBackendSettingsRows(group);
        const isTcGroup = id.startsWith('sb-tc-');
        const isCcGroup = id.startsWith('sb-openai-');
        const hidden = id === 'sb-openai-sampling' || (isTcGroup ? isChatCompletion : isCcGroup ? !isChatCompletion : false);
        if (group.hidden !== hidden) group.hidden = hidden;
    }
    // SillyBunny: the Prompt Manager may mount late, so restore the complete Chat Completions order on every update.
    // The check must be "is the tail already in this order", not "is this group last yet": `append` on a
    // node that is already its parent's last child still performs a remove+insert, which is a childList
    // mutation. This function runs from the drawer observer, so a per-group append kept re-triggering the
    // observer every frame and re-flattening the whole Prompting panel in a loop.
    if (range instanceof HTMLElement) {
        // SillyBunny: the Presets module adds the groups for the choice sets and the dependent sets between the upstream ones.
        const openAIReadingOrder = [
            'sb-openai-budget', 'sb-openai-names-behavior', 'sb-openai-continue-postfix', 'sb-openai-names', 'sb-openai-prefill', 'sb-openai-request',
            'sb-openai-function-calling', 'sb-openai-inline-media', 'sb-openai-request-images', 'sb-openai-request-reasoning', 'sb-openai-reasoning-tags',
            'sb-openai-prompt-caching',
        ];
        const orderedGroups = openAIReadingOrder
            .map(id => root.querySelector(`#${id}`))
            .filter(group => group instanceof HTMLElement);
        const currentTail = Array.from(range.children).slice(-orderedGroups.length);
        const isOrdered = orderedGroups.length > 0
            && currentTail.length === orderedGroups.length
            && currentTail.every((child, index) => child === orderedGroups[index]);

        if (!isOrdered) {
            for (const group of orderedGroups) range.append(group);
        }
    }

    const tcOrder = ['sb-tc-sysprompt', 'sb-tc-instruct', 'sb-tc-context', 'sb-tc-names'];
    const commonGroup = root.querySelector('#common-gen-settings-block');
    if (commonGroup instanceof HTMLElement) {
        let anchor = commonGroup;
        for (const id of tcOrder) {
            const group = root.querySelector(`#${id}`);
            if (!(group instanceof HTMLElement)) continue;
            if (group.parentElement !== anchor.parentElement || group.previousElementSibling !== anchor) {
                anchor.after(group);
            }
            anchor = group;
        }
    }
    const reasoning = root.querySelector('#sb-reasoning-template');
    const configuration = root.querySelector('#ai_response_configuration');
    if (reasoning instanceof HTMLElement && configuration instanceof HTMLElement && configuration.lastElementChild !== reasoning) configuration.append(reasoning);
    if (reasoning instanceof HTMLElement) normalizeBackendSettingsRows(reasoning);

    // SillyBunny: the multiple-swipes control is authored as a data-tg-samplers wrapper,
    // not a range-block. Move only that wrapper into the shared Generation Settings group.
    const textgenSwipes = document.getElementById('n_textgenerationwebui')?.closest('[data-tg-samplers="n"]');
    const generationBody = root.querySelector('#common-gen-settings-block > .sb-prompting-group-body');
    if (textgenSwipes instanceof HTMLElement && generationBody instanceof HTMLElement && textgenSwipes.parentElement !== generationBody) {
        generationBody.append(textgenSwipes);
    }
    const presets = root.querySelector('#respective-presets-block');
    const presetsBody = presets?.querySelector(':scope > .sb-prompting-group-body');
    if (presetsBody instanceof HTMLElement && !presetsBody.querySelector('[data-sb-preset-autosave]')) {
        presetsBody.append(createPresetAutosaveToggle());
    }
    placeSharedPresetControls(root, activeApi);
    // Upstream sets some preset selects without a change event, for example when it restores the selection after a source change.
    for (const preset of sbPresetRows) preset.sync();
    if (presets instanceof HTMLElement) normalizeBackendSettingsRows(presets);
    const common = root.querySelector('#common-gen-settings-block');
    if (common instanceof HTMLElement) {
        const contextRow = common.querySelector('#max_context_block');
        const quickContext = contextRow?.querySelector('.quick_context_size_container');
        if (quickContext && contextRow && contextRow.nextElementSibling !== quickContext) contextRow.after(quickContext);
        normalizeBackendSettingsRows(common);
    }
    normalizeBackendSettingsRows(root, { fields: false });
    hideEmptyGroupedSettingsDrawers();
    groupPromptingRowHelpers(root);
    backendPagesModule?.presentPresets(backendPagesContext);
    // Batch writes and reads: interleaving `hidden` writes with checkVisibility() forces a style and
    // layout flush per group, which is what made opening Prompting drop frames on slower devices.
    const measured = [];
    for (const group of root.querySelectorAll('.sb-openai-settings-drawer, .sb-textgen-drawers > .sb-settings-flat-section, .sb-prompting-group')) {
        if (!(group instanceof HTMLElement)) continue;
        const shouldHideByMode = ['sb-openai-sampling', 'sb-openai-prompts'].includes(group.id)
            || (group.id.startsWith('sb-openai-') && !isChatCompletion)
            || (group.id.startsWith('sb-tc-') && isChatCompletion)
            || (group.id === 'sb-preset-linking' && !isChatCompletion);
        // The text-generation sampling sections are source containers for the separate Sampling tab,
        // not Prompting content; only their live controls belong in the sampling cards.
        const isSamplingSourceGroup = group.matches('.sb-textgen-drawers > .sb-settings-flat-section');
        const hidesWhenEmpty = group.id.startsWith('sb-openai-') || group.id.startsWith('sb-tc-');
        const hidden = shouldHideByMode || isSamplingSourceGroup;
        if (group.hidden !== hidden) group.hidden = hidden;
        if (hidesWhenEmpty && !hidden) measured.push(group);
    }
    const emptyGroups = measured.filter(group => ![...group.querySelectorAll('input:not([type="hidden"]), select, textarea, button, .menu_button')]
        .some(control => control instanceof HTMLElement && (control.checkVisibility?.() ?? control.getClientRects().length > 0)));
    for (const group of emptyGroups) group.hidden = true;
    const tab = getShellState('left')?.tabs.get('prompting');
    if (tab) tab.searchIndex = null;
}

function getImporterState() {
    return sbState.importer;
}

function getImporterRefs() {
    return getImporterState().refs;
}

async function requestUserPrivateAction(endpoint, { body = {}, useFormData = false } = {}) {
    const buildRequest = async () => {
        const requestHeaders = await waitForAuthorizedRequestHeaders();
        const headers = useFormData
            ? (() => {
                const multipartHeaders = { ...requestHeaders };
                delete multipartHeaders['Content-Type'];
                delete multipartHeaders['content-type'];
                return multipartHeaders;
            })()
            : requestHeaders;

        return {
            method: 'POST',
            headers,
            body: useFormData ? body : JSON.stringify(body),
        };
    };

    const response = await fetchWithCsrfRetry(endpoint, buildRequest, { refreshCsrfToken });

    const text = await response.text();
    let data = null;

    try {
        data = text ? JSON.parse(text) : {};
    } catch {
        data = { message: text };
    }

    if (!response.ok) {
        throw new Error(data?.error || data?.message || text || `Request failed with status ${response.status}.`);
    }

    return data;
}

function setServerAdminPill(element, label, tone = 'neutral') {
    if (!(element instanceof HTMLElement)) {
        return;
    }

    element.textContent = label;
    element.dataset.tone = tone;
}

function setServerAdminMessage(element, message, tone = 'neutral') {
    if (!(element instanceof HTMLElement)) {
        return;
    }

    element.textContent = String(message ?? '').trim();
    element.dataset.tone = tone;
    element.hidden = !element.textContent;
}

function groupAdvancedFormattingIntoDrawers() {
    const formatting = document.getElementById('AdvancedFormatting');
    if (!(formatting instanceof HTMLElement)) return;
    const groupOrder = ['sb-af-tokenizer', 'sb-af-stopping', 'sb-af-reply-prefix', 'sb-af-cleanup', 'sb-af-reasoning', 'sb-af-reasoning-prompts', 'sb-af-rendering', 'sb-af-advanced'];
    const orderGroups = () => {
        const groups = groupOrder.map(id => formatting.querySelector(`#${id}`)).filter(group => group instanceof HTMLElement);
        const currentGroups = [...formatting.children].filter(child => child.classList.contains('sb-formatting-group'));
        if (groups.length === currentGroups.length && groups.every((group, index) => group === currentGroups[index])) return;
        for (const group of groups) formatting.append(group);
    };
    if (formatting.dataset.sbGrouped === 'true') {
        const replyPrefixBody = formatting.querySelector('#sb-af-reply-prefix > .sb-prompting-group-body');
        const startReplyWith = formatting.querySelector('[name="startReplyWithBlock"]');
        if (startReplyWith instanceof HTMLElement && replyPrefixBody instanceof HTMLElement && startReplyWith.parentElement !== replyPrefixBody && !startReplyWith.dataset.sbEmptiedByOrder) {
            startReplyWith.hidden = false;
            replyPrefixBody.append(startReplyWith);
        }
        orderGroups();
        if (isShellTabOpen('left', 'context')) updateFormattingGroupVisibility(formatting);
        return;
    }

    const columns = formatting.querySelector('.flex-container.spaceEvenly');
    const contextColumn = formatting.querySelector('#ContextSettings');
    const instructColumn = formatting.querySelector('#InstructSettingsColumn');
    const systemColumn = formatting.querySelector('#SystemPromptColumn');
    if (!(columns instanceof HTMLElement) || !(contextColumn instanceof HTMLElement)
        || !(instructColumn instanceof HTMLElement) || !(systemColumn instanceof HTMLElement)) return;

    const startReplyWith = systemColumn.querySelector('[name="startReplyWithBlock"]');

    const createGroup = (id, title, description) => {
        const group = createElement('section', { id, className: 'sb-prompting-group sb-formatting-group sb-settings-category' });
        if (!description) group.dataset.sbDescription = 'none';
        group.append(
            createBackendGroupHeader(title, { 'data-i18n': title }, description),
            createElement('div', { className: 'ds-pref-group sb-prompting-group-body sb-settings-category-body' }),
        );
        formatting.append(group);
        return group.querySelector('.sb-prompting-group-body');
    };
    const bodies = new Map([
        ['tokenizer', createGroup('sb-af-tokenizer', 'Tokenizer & Padding', 'Choose a tokenizer and adjust prompt token counts with padding')],
        ['stopping', createGroup('sb-af-stopping', 'Stopping Strings', 'Choose text that stops generation, with optional macro replacement')],
        ['reply-prefix', createGroup('sb-af-reply-prefix', 'Reply Prefix', 'Set how replies begin and whether that text appears in chat')],
        ['cleanup', createGroup('sb-af-cleanup', 'Text Cleanup', 'Control line breaks, extra spaces, and unfinished sentences in replies')],
        // SillyBunny: the caption of the Reasoning group says that its settings are global.
        ['reasoning', createGroup('sb-af-reasoning', 'Reasoning', 'These settings apply to every chat, whichever template is chosen')],
        ['reasoning-prompts', createGroup('sb-af-reasoning-prompts', 'Add to Prompts')],
        ['rendering', createGroup('sb-af-rendering', 'Rendering', 'Keep specified standalone text from being treated as Markdown')],
        // SillyBunny: the upstream page heading, its documentation link and Master Import/Export are this group (filled by sillybunny-backend-pages.js).
        ['advanced', createGroup('sb-af-advanced', 'Advanced Formatting')],
    ]);

    // SillyBunny: a block that the Formatting and Presets rows emptied stays out of the box it came from.
    const move = (target, body) => {
        if (!(target instanceof HTMLElement) || !(body instanceof HTMLElement) || target.dataset.sbEmptiedByOrder) return;
        body.append(target);
    };
    const moveClosest = (selector, body, ancestorSelector = null) => {
        const target = formatting.querySelector(selector);
        if (!(target instanceof HTMLElement)) return;
        const resolved = ancestorSelector ? target.closest(ancestorSelector) : target;
        move(resolved, body);
    };

    const prompting = getShellState('left')?.tabs.get('prompting')?.panel;
    const promptingGroupBody = id => prompting?.querySelector(`#${id} > .sb-prompting-group-body`);
    const moveToPrompting = (selector, id, ancestorSelector = null) => {
        const target = formatting.querySelector(selector);
        const body = promptingGroupBody(id);
        if (!(target instanceof HTMLElement) || !(body instanceof HTMLElement)) return;
        move(ancestorSelector ? target.closest(ancestorSelector) : target, body);
    };

    const groupBody = id => promptingGroupBody(id);
    const movePromptingNode = (node, id) => {
        const body = groupBody(id);
        if (node instanceof HTMLElement && body instanceof HTMLElement && node.parentElement !== body && !node.dataset.sbEmptiedByOrder) body.append(node);
    };

    moveToPrompting('[name="bindModelPresetBlock"]', 'respective-presets-block');
    document.querySelectorAll('.sb-sampling-section').forEach(updateSamplingCardVisibility);
    const systemPromptBlock = systemColumn.querySelector('#SystemPromptBlock');
    movePromptingNode(systemColumn.querySelector(':scope > .title_restorable[data-cc-null]'), 'sb-tc-sysprompt');
    movePromptingNode(systemPromptBlock, 'sb-tc-sysprompt');
    moveToPrompting('#InstructSettingsColumn', 'sb-tc-instruct');
    movePromptingNode(contextColumn.querySelector(':scope > div > .title_restorable'), 'sb-tc-context');
    movePromptingNode(contextColumn.querySelector(':scope > div > .flex-container.flexNoGap'), 'sb-tc-context');
    const storyBlock = formatting.querySelector('[data-cc-null]:has(#context_story_string)');
    const contextBody = promptingGroupBody('sb-tc-context');
    if (storyBlock instanceof HTMLElement && contextBody instanceof HTMLElement) move(storyBlock, contextBody);
    movePromptingNode(contextColumn.querySelector(':scope > div > div > .flex-container.flexFlowColumn[data-cc-null]'), 'sb-tc-context');
    movePromptingNode(contextColumn.querySelector(':scope > div > div > .flex-container[data-cc-null]'), 'sb-tc-context');
    movePromptingNode(contextColumn.querySelector('#context_use_stop_strings')?.closest('label'), 'sb-tc-context');
    movePromptingNode(contextColumn.querySelector('#context_names_as_stop_strings')?.closest('label'), 'sb-tc-context');
    movePromptingNode(contextColumn.querySelector('#always-force-name2-checkbox')?.closest('label'), 'sb-tc-names');
    moveClosest('[name="tokenizerSettingsBlock"]', bodies.get('tokenizer'));
    moveClosest('div[data-cc-null][data-cc-chat-completion-visible]', bodies.get('stopping'));
    if (startReplyWith instanceof HTMLElement && !startReplyWith.dataset.sbEmptiedByOrder) {
        startReplyWith.hidden = false;
        move(startReplyWith, bodies.get('reply-prefix'));
    }
    moveClosest('#single_line', bodies.get('cleanup'), 'label');
    moveClosest('#collapse-newlines-checkbox', bodies.get('cleanup'), 'label');
    moveClosest('#trim_spaces', bodies.get('cleanup'), 'label');
    moveClosest('#trim_sentences_checkbox', bodies.get('cleanup'), 'label');
    const cleanupHeading = [...contextColumn.querySelectorAll('h4.standoutHeader')]
        .find(heading => heading.textContent?.includes('Context Formatting'));
    cleanupHeading?.setAttribute('hidden', '');
    const reasoningWrapper = systemColumn.querySelector('div:has(.sb-reasoning-toggle-grid)');
    if (reasoningWrapper instanceof HTMLElement) move(reasoningWrapper, bodies.get('reasoning'));
    const renderingControl = formatting.querySelector('#markdown_escape_strings')?.parentElement?.parentElement;
    if (renderingControl instanceof HTMLElement) move(renderingControl, bodies.get('rendering'));

    const miscHeading = [...systemColumn.querySelectorAll('h4')].find(heading => heading.textContent?.trim() === 'Miscellaneous');
    if (miscHeading instanceof HTMLElement) miscHeading.hidden = true;
    // `.flex-container` sets `display: flex`, which outranks `[hidden]`, so the emptied row of columns would stay in the
    // page's flex column as a zero-height item and add one gap above the first group. The marker is what the stylesheet hides.
    columns.hidden = true;
    columns.dataset.sbEmptiedByOrder = 'true';
    formatting.dataset.sbGrouped = 'true';
    orderGroups();
    updateFormattingGroupVisibility(formatting);
    // Normalize switch semantics for Formatting groups without restructuring.
    for (const body of bodies.values()) {
        normalizeBackendSettingsRows(body, { fields: false });
    }

    updateEditorPanel();
    updatePromptingPanel(prompting);
}

function updateFormattingGroupVisibility(formatting) {
    if (!(formatting instanceof HTMLElement)) return;
    const groups = [...formatting.querySelectorAll('.sb-formatting-group')].filter(group => group instanceof HTMLElement);
    // Unhide every group first, then measure all, then write: one layout flush instead of one per group.
    for (const group of groups) {
        if (group.hidden) group.hidden = false;
    }
    const empty = groups.filter(group => ![...group.querySelectorAll('input, select, textarea, button, .menu_button')]
        .some(control => control instanceof HTMLElement && (control.checkVisibility?.() ?? control.getClientRects().length > 0)));
    for (const group of empty) group.hidden = true;
}

function updateSillyTavernImportInteractivity() {
    const state = getImporterState();
    const refs = getImporterRefs();

    if (!refs) {
        return;
    }

    setButtonDisabled(refs.folderButton, state.busy);
    setButtonDisabled(refs.syncButton, state.busy);
    setButtonDisabled(refs.zipButton, state.busy);

    if (refs.pathInput instanceof HTMLInputElement) {
        refs.pathInput.disabled = state.busy;
    }
}

/**
 * Shows the folder import pane only to admins, because the server refuses the folder import and the extension sync to other users.
 * With accounts off, isAdmin() is true.
 */
function updateFolderImportVisibility() {
    // .ds-row sets display: flex, which the hidden attribute does not override.
    for (const row of getImporterRefs()?.folderRows ?? []) {
        if (row instanceof HTMLElement) {
            row.style.display = isAdmin() ? '' : 'none';
        }
    }
}

function setSillyTavernImportBusy(isBusy) {
    getImporterState().busy = Boolean(isBusy);
    updateSillyTavernImportInteractivity();
}

function getExtensionSyncStatusTone(status) {
    if (status === 'failed') {
        return 'danger';
    }

    if (status === 'warning') {
        return 'warn';
    }

    return 'good';
}

function getExtensionSyncStatusLabel(status) {
    if (status === 'failed') {
        return 'Failed';
    }

    if (status === 'warning') {
        return 'Needs Attention';
    }

    return 'Ready';
}

function getExtensionSyncCheckSummary(result) {
    const checks = [];
    const manifestFound = result?.checks?.manifestFound === true;
    const manifestValid = result?.checks?.manifestValid === true;
    const jsEntry = typeof result?.checks?.jsEntry === 'string' ? result.checks.jsEntry.trim() : '';
    const jsEntryExists = result?.checks?.jsEntryExists === true;
    const gitMetadataSkipped = result?.checks?.gitMetadataSkipped === true;

    checks.push(!manifestFound
        ? 'manifest missing'
        : manifestValid
            ? 'manifest OK'
            : 'manifest invalid');
    checks.push(jsEntry
        ? jsEntryExists
            ? `JS entry: ${jsEntry}`
            : `JS missing: ${jsEntry}`
        : 'no JS entry');

    if (gitMetadataSkipped) {
        checks.push('git metadata skipped');
    }

    return checks.join(' · ');
}

function renderSillyTavernExtensionSyncReport(reportData = null) {
    const refs = getImporterRefs();
    const report = refs?.report;
    const summary = refs?.reportSummary;
    const help = refs?.reportHelp;
    const list = refs?.reportList;
    const state = getImporterState();

    state.report = reportData;

    if (!(report instanceof HTMLElement) || !(summary instanceof HTMLElement) || !(help instanceof HTMLElement) || !(list instanceof HTMLElement)) {
        return;
    }

    if (!reportData || !Array.isArray(reportData.results) || reportData.results.length === 0) {
        report.hidden = true;
        summary.textContent = '';
        help.textContent = '';
        list.replaceChildren();
        return;
    }

    const results = reportData.results;
    const readyCount = Number(reportData.readyCount ?? 0) || 0;
    const warningCount = Number(reportData.warningCount ?? 0) || 0;
    const failedCount = Number(reportData.failedCount ?? 0) || 0;
    const syncedCount = readyCount + warningCount;
    const needsAttention = warningCount + failedCount > 0;
    const gitMetadataSkippedCount = Number(reportData.gitMetadataSkippedCount ?? 0)
        || results.filter(result => result?.checks?.gitMetadataSkipped === true).length;

    summary.textContent = reportData.message
        || `Synced ${syncedCount} of ${results.length} third-party extensions.`;
    help.textContent = needsAttention
        ? `If an extension still misbehaves after a reload, contact purachina with the extension name and the report below.${gitMetadataSkippedCount > 0 ? ` Git metadata was skipped on ${gitMetadataSkippedCount} extension${gitMetadataSkippedCount === 1 ? '' : 's'} to avoid permission issues, so built-in update tooling may need a reinstall later.` : ''}`
        : gitMetadataSkippedCount > 0
            ? `Reload when you are ready to activate the synced extensions. Git metadata was skipped on ${gitMetadataSkippedCount} extension${gitMetadataSkippedCount === 1 ? '' : 's'} to avoid permission issues, so built-in update tooling may need a reinstall later.`
            : 'Reload when you are ready to activate the synced extensions.';

    const items = results.map(result => {
        const card = createElement('article', { className: `sb-import-report-item is-${result?.status || 'warning'}` });
        const header = createElement('div', { className: 'sb-import-report-item-header' });
        const titleGroup = createElement('div', { className: 'sb-import-report-item-title' });
        const title = createElement('strong', { text: result?.displayName || result?.name || 'Unknown Extension' });
        const metaParts = [];

        if (result?.version) {
            metaParts.push(`v${result.version}`);
        }

        if (result?.author) {
            metaParts.push(result.author);
        }

        const meta = createElement('small', {
            className: 'sb-import-report-item-meta',
            text: metaParts.join(' • '),
        });
        const pill = createElement('span', { className: 'sb-server-pill' });

        setServerAdminPill(pill, getExtensionSyncStatusLabel(result?.status), getExtensionSyncStatusTone(result?.status));
        titleGroup.append(title);

        if (metaParts.length > 0) {
            titleGroup.append(meta);
        }

        header.append(titleGroup, pill);

        const body = createElement('div', { className: 'sb-import-report-item-body' });
        const copiedFiles = Number(result?.copiedFiles ?? 0) || 0;
        const statusLine = createElement('p', {
            className: 'sb-import-report-item-copy',
            text: result?.status === 'failed'
                ? (result?.error || 'This extension could not be synced.')
                : `Copied ${copiedFiles} file${copiedFiles === 1 ? '' : 's'} into ${result?.name || 'extension'}.`,
        });
        const checksLine = createElement('p', {
            className: 'sb-import-report-item-checks',
            text: getExtensionSyncCheckSummary(result),
        });

        body.append(statusLine, checksLine);

        if (Array.isArray(result?.warnings) && result.warnings.length > 0) {
            const warningList = createElement('ul', { className: 'sb-import-report-warnings' });

            for (const warning of result.warnings) {
                warningList.appendChild(createElement('li', { text: warning }));
            }

            body.appendChild(warningList);
        }

        card.append(header, body);
        return card;
    });

    list.replaceChildren(...items);
    report.hidden = false;
}

function logSillyTavernExtensionSyncReport(reportData) {
    if (!reportData || !Array.isArray(reportData.results)) {
        return;
    }

    console.groupCollapsed(`[SillyBunny] Third-party extension sync report (${reportData.results.length})`);
    console.table(reportData.results.map(result => ({
        name: result?.name || '',
        displayName: result?.displayName || '',
        status: result?.status || '',
        copiedFiles: Number(result?.copiedFiles ?? 0) || 0,
        manifestFound: result?.checks?.manifestFound === true,
        manifestValid: result?.checks?.manifestValid === true,
        jsEntry: result?.checks?.jsEntry || '',
        jsEntryExists: result?.checks?.jsEntryExists === true,
        gitMetadataSkipped: result?.checks?.gitMetadataSkipped === true,
        warningCount: Array.isArray(result?.warnings) ? result.warnings.length : 0,
        error: result?.error || '',
    })));
    console.groupEnd();
}

async function handleSillyTavernFolderImport() {
    const refs = getImporterRefs();

    if (!refs?.pathInput || getImporterState().busy) {
        return;
    }

    const sourcePath = refs.pathInput.value.trim();

    if (!sourcePath) {
        setServerAdminMessage(refs.note, 'Paste the path to your SillyTavern folder or user data folder first.', 'warn');
        toastr.warning('Paste a SillyTavern folder path first', 'Import SillyTavern');
        refs.pathInput.focus({ preventScroll: true });
        return;
    }

    const response = await openAlert({
        heading: 'Import data from this folder into the current SillyBunny account?',
        body: `${sourcePath}\n\nFiles with the same name will be replaced, and the page will reload when the import finishes.`,
        responses: [
            { id: 'cancel', label: t`Cancel` },
            { id: 'import', label: 'Import', appearance: 'destructive' },
        ],
    });
    if (response !== 'import') {
        return;
    }

    setSillyTavernImportBusy(true);
    renderSillyTavernExtensionSyncReport(null);
    setServerAdminMessage(refs.note, 'Importing folder data… This may take a moment for larger libraries.');

    try {
        const result = await requestUserPrivateAction('/api/users/import-sillytavern/folder', {
            body: { sourcePath },
        });

        setServerAdminMessage(refs.note, result?.message || 'Folder import finished. Reloading…', 'good');
        toastr.success(result?.message || 'Folder import finished. Reloading…', 'Import SillyTavern');
        await wait(700);
        location.reload();
    } catch (error) {
        console.error('Failed to import SillyTavern folder.', error);
        setServerAdminMessage(refs.note, error.message || 'Failed to import from that folder path.', 'danger');
        toastr.error(error.message || 'Failed to import from that folder path', 'Import SillyTavern');
    } finally {
        setSillyTavernImportBusy(false);
    }
}

async function handleSillyTavernExtensionSync() {
    const refs = getImporterRefs();

    if (!refs?.pathInput || getImporterState().busy) {
        return;
    }

    const sourcePath = refs.pathInput.value.trim();

    if (!sourcePath) {
        setServerAdminMessage(refs.note, 'Paste the path to your existing SillyTavern folder before syncing extensions.', 'warn');
        toastr.warning('Paste a SillyTavern folder path first', 'Sync Extensions');
        refs.pathInput.focus({ preventScroll: true });
        return;
    }

    const response = await openAlert({
        heading: 'Sync third-party extensions from this SillyTavern folder into the current SillyBunny account?',
        body: `${sourcePath}\n\nMatching extension folders will be replaced. SillyBunny will show a detailed report instead of reloading immediately.`,
        responses: [
            { id: 'cancel', label: t`Cancel` },
            { id: 'sync', label: t`Sync`, appearance: 'destructive' },
        ],
    });
    if (response !== 'sync') {
        return;
    }

    setSillyTavernImportBusy(true);
    renderSillyTavernExtensionSyncReport(null);
    setServerAdminMessage(refs.note, 'Syncing third-party extensions… SillyBunny will validate each one and show a report when it finishes.');

    try {
        const result = await requestUserPrivateAction('/api/users/import-sillytavern/extensions', {
            body: { sourcePath },
        });
        const warningCount = Number(result?.warningCount ?? 0) || 0;
        const failedCount = Number(result?.failedCount ?? 0) || 0;
        const needsAttention = warningCount + failedCount > 0;
        const gitMetadataSkippedCount = Number(result?.gitMetadataSkippedCount ?? 0) || 0;
        const message = needsAttention
            ? `${result?.message || 'Extension sync finished with warnings.'} If something still looks broken after a reload, contact purachina with the report below.`
            : `${result?.message || 'Extension sync finished.'} Reload when you are ready to activate the synced extensions.${gitMetadataSkippedCount > 0 ? ` Git metadata was skipped on ${gitMetadataSkippedCount} extension${gitMetadataSkippedCount === 1 ? '' : 's'} to avoid permission issues, so built-in update tooling may need a reinstall later.` : ''}`;
        const tone = failedCount > 0 ? 'danger' : warningCount > 0 ? 'warn' : 'good';

        renderSillyTavernExtensionSyncReport(result);
        logSillyTavernExtensionSyncReport(result);
        setServerAdminMessage(refs.note, message, tone);

        if (failedCount > 0) {
            toastr.error(result?.message || 'Some extensions could not be synced', 'Sync Extensions');
        } else if (warningCount > 0) {
            toastr.warning(result?.message || 'Extension sync finished with warnings', 'Sync Extensions');
        } else {
            toastr.success(result?.message || 'Extension sync finished', 'Sync Extensions');
        }
    } catch (error) {
        console.error('Failed to sync SillyTavern third-party extensions.', error);
        setServerAdminMessage(refs.note, error.message || 'Failed to sync third-party extensions from that folder.', 'danger');
        toastr.error(error.message || 'Failed to sync third-party extensions from that folder', 'Sync Extensions');
    } finally {
        setSillyTavernImportBusy(false);
    }
}

async function handleSillyTavernZipImport(file) {
    const refs = getImporterRefs();

    if (!(file instanceof File) || getImporterState().busy || !refs) {
        return;
    }

    const response = await openAlert({
        heading: 'Import this SillyTavern backup ZIP into the current SillyBunny account?',
        body: `${file.name}\n\nFiles with the same name will be replaced, and the page will reload when the import finishes.`,
        responses: [
            { id: 'cancel', label: t`Cancel` },
            { id: 'import', label: 'Import', appearance: 'destructive' },
        ],
    });
    if (response !== 'import') {
        if (refs.zipFileInput instanceof HTMLInputElement) {
            refs.zipFileInput.value = '';
        }

        return;
    }

    const formData = new FormData();
    formData.append('avatar', file, file.name);

    setSillyTavernImportBusy(true);
    renderSillyTavernExtensionSyncReport(null);
    setServerAdminMessage(refs.note, 'Importing backup ZIP… This may take a moment for larger libraries.');

    try {
        const result = await requestUserPrivateAction('/api/users/import-sillytavern/zip', {
            body: formData,
            useFormData: true,
        });

        setServerAdminMessage(refs.note, result?.message || 'Backup ZIP imported. Reloading…', 'good');
        toastr.success(result?.message || 'Backup ZIP imported. Reloading…', 'Import SillyTavern');
        await wait(700);
        location.reload();
    } catch (error) {
        console.error('Failed to import SillyTavern backup ZIP.', error);
        setServerAdminMessage(refs.note, error.message || 'Failed to import that backup ZIP.', 'danger');
        toastr.error(error.message || 'Failed to import that backup ZIP', 'Import SillyTavern');
    } finally {
        if (refs.zipFileInput instanceof HTMLInputElement) {
            refs.zipFileInput.value = '';
        }

        setSillyTavernImportBusy(false);
    }
}

function injectSillyTavernImportCard(host, { buildImportGroup }) {
    // Import & Restore lives on the Data & Security tab. It is injected only when that panel is built:
    // before then the settings container is detached, and an earlier call would paint the group into
    // another tab.
    if (!(host instanceof HTMLElement) || host.querySelector('#sb-import-card')) {
        return;
    }

    const built = buildImportGroup();
    const placeholder = host.querySelector('#SillyTavernImportSection');
    if (placeholder) {
        placeholder.replaceWith(built.section);
    } else {
        host.prepend(built.section);
    }

    const { folderButton, syncButton, pathInput, zipButton, zipFileInput, zipFileName } = built;
    getImporterState().refs = {
        card: built.card,
        folderPane: built.folderPane,
        folderRows: built.folderRows,
        pathInput,
        folderButton,
        syncButton,
        zipButton,
        zipFileInput,
        zipFileName,
        note: built.note,
        report: built.report,
        reportSummary: built.reportSummary,
        reportHelp: built.reportHelp,
        reportList: built.reportList,
    };

    folderButton.addEventListener('click', handleSillyTavernFolderImport);
    syncButton.addEventListener('click', handleSillyTavernExtensionSync);
    pathInput.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
            event.preventDefault();
            void handleSillyTavernFolderImport();
        }
    });

    zipButton.addEventListener('click', () => zipFileInput.click());
    zipFileInput.addEventListener('change', () => {
        const [file] = Array.from(zipFileInput.files ?? []);
        zipFileName.textContent = file?.name || 'No ZIP selected yet';

        if (file) {
            void handleSillyTavernZipImport(file);
        }
    });

    updateSillyTavernImportInteractivity();
    updateFolderImportVisibility();
    // isAdmin() is true until the client knows that accounts are on, and then false until /api/users/me answers.
    // getSettings() does both before it emits SETTINGS_LOADED, so a card built after that event already sees the final value.
    eventSource.on(event_types.SETTINGS_LOADED, updateFolderImportVisibility);
}

function createThemeSliderGroup({ title, valueId, inputId, value, min, max, step, ariaLabel, caption, onInput, className = '' }) {
    const sliderGroup = createElement('div', { className: `ds-row ds-row-slider ${className}`.trim() });
    const sliderHeader = createElement('div', { className: 'ds-row-text' });
    const sliderTitle = createElement('label', { className: 'ds-row-label', text: title, attrs: { for: inputId } });
    const sliderValue = createElement('span', { id: valueId, className: 'sb-theme-slider-value' });
    const suffix = createElement('div', { className: 'ds-row-suffix' });
    const sliderInput = createElement('input', {
        id: inputId,
        className: 'sb-theme-slider-input',
        attrs: {
            type: 'range',
            min: String(min),
            max: String(max),
            step: String(step),
            value: String(value),
            'aria-label': ariaLabel,
        },
    });
    const sliderCaption = createElement('p', {
        className: 'ds-row-subtitle',
        text: caption,
    });

    const numberInput = createElement('input', {
        className: 'text_pole',
        attrs: { type: 'number', min: String(min), max: String(max), step: String(step), value: String(value), 'aria-label': ariaLabel, 'data-sb-theme-slider-counter': inputId },
    });
    sliderHeader.append(sliderTitle, sliderCaption);
    sliderValue.hidden = true;
    suffix.append(sliderInput, numberInput, sliderValue);
    sliderGroup.append(sliderHeader, suffix);
    sliderInput.addEventListener('input', () => {
        numberInput.value = sliderInput.value;
        onInput(sliderInput.value);
    });
    numberInput.addEventListener('change', () => {
        if (sliderInput.disabled || !numberInput.value || !numberInput.validity.valid) {
            numberInput.value = sliderInput.value;
            return;
        }
        sliderInput.value = numberInput.value;
        numberInput.value = sliderInput.value;
        onInput(sliderInput.value);
    });
    numberInput.addEventListener('keydown', event => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        numberInput.dispatchEvent(new Event('change'));
    });

    return sliderGroup;
}

/** One part of the top bar label, as a switch: any mix of parts can be on, at every width. */
function createTopbarLabelPartRow(part) {
    const input = createElement('input', {
        id: `sb-topbar-label-desktop-${part.id}`,
        attrs: {
            type: 'checkbox',
            'data-sb-topbar-label-part': part.id,
        },
    });
    return createSwitchRow({
        label: part.label,
        subtitle: part.description,
        field: `topbar-label-${part.id}`,
        input,
        onChange: isChecked => setTopbarLabelPart(part.id, isChecked),
    });
}

function createShortcutSettingsGroup() {
    const rows = [];

    for (const side of SB_SHORTCUT_SLOTS) {
        const select = createElement('select', { id: `sb-shortcut-${side}-select` });
        const currentTarget = getShortcutTarget(side);
        for (const target of SB_SHORTCUT_TARGETS) {
            const option = createElement('option', {
                attrs: { value: target.value },
            });
            option.textContent = target.label;
            option.selected = target.value === currentTarget;
            select.appendChild(option);
        }

        select.addEventListener('change', () => {
            const key = SB_SHORTCUT_STORAGE_KEYS[side];
            if (key) {
                safeSetItem(key, select.value);
            }
            updateShortcutButton(side);
        });

        const shortcutRow = createSelectRow({
            select,
            label: SB_SHORTCUT_LABELS[side] || side,
            field: `shortcut-${side}`,
            searchLabel: t`Search`,
            emptyText: t`No Results`,
        });
        rows.push(shortcutRow);
    }

    const group = appearanceModule.createAppearanceGroup({
        id: 'quick-access-shortcuts',
        elementId: 'sb-quick-access-shortcuts-drawer',
        title: 'Quick Access Shortcuts',
        description: 'Assign a shell tab or universal search to each shortcut button in the top bar. Choose None to hide a button.',
    });
    group.append(...rows);
    // Every Quick Access button carries `sb-desktop-setting`, so the phone bar has none and the group is offered on the desktop page only.
    group.section.classList.add('sb-desktop-setting');
    return group.section;
}

/**
 * One switch row of the Interface page. The input keeps the id and the data attribute that the sync code and the specs read.
 * @param {object} options
 * @param {string} options.id
 * @param {string} options.label
 * @param {string} options.subtitle
 * @param {string} options.field
 * @param {string} [options.dataAttribute] Name of a data attribute that is set on the input.
 * @param {string} [options.dataValue]
 * @param {(checked: boolean) => void} options.onChange
 */
function createInterfaceSwitchRow({ id, label, subtitle, field, dataAttribute, dataValue = '', onChange }) {
    const { row, control } = createSwitchRow({ label, subtitle, field, id, onChange });
    if (dataAttribute) {
        control.setAttribute(dataAttribute, dataValue);
    }
    return row;
}

/**
 * A boxed list of the Interface page, with the id that the page's section order names. The order puts it under its heading.
 * @param {string} id
 * @param {HTMLElement[]} rows
 * @param {string} [enabledBy] Selector of the switch that the rows after it depend on.
 */
function createInterfaceGroupBody(id, rows, enabledBy = '') {
    const body = createElement('div', { id, className: 'ds-pref-group sb-settings-category-body' });
    if (enabledBy) {
        body.dataset.sbEnabledBy = enabledBy;
    }
    body.append(...rows);
    return body;
}

// One switch for the one stored value: `sb-compact-mode` is read and written by `setCompactMode` on every device, so the
// switch belongs to the page and not to the Desktop or the Mobile group.
function createCompactModeRow() {
    return createInterfaceSwitchRow({
        id: 'sb-compact-mode-input',
        label: 'Compact Mode',
        subtitle: 'Reduce spacing, controls, and mobile composer height for denser screens',
        field: 'compact-mode',
        dataAttribute: 'data-sb-compact-mode-input',
        onChange: checked => setCompactMode(checked),
    });
}

// One switch for the one stored value: `sb-bottom-chat-bar-visible` is read and written by `setBottomChatBarVisible` on every
// device. The id keeps its `desktop` segment because specs and the settings inventory name it.
function createBottomChatBarRow() {
    return createInterfaceSwitchRow({
        id: 'sb-desktop-bottom-bar-visible-input',
        label: 'Show Bottom Chat Bar',
        subtitle: 'Display the bottom bar with the chat switcher, persona picker, and chat actions',
        field: 'bottom-bar-visible-desktop',
        dataAttribute: 'data-sb-bottom-bar-visible-input',
        dataValue: 'desktop',
        onChange: checked => setBottomChatBarVisible(checked),
    });
}

function isGuidedGenerationsBarVisible() {
    return extension_settings['guided-generations']?.showActionButtonContainer !== false;
}

function setGuidedGenerationsBarVisible(shouldShow) {
    const nextVisible = Boolean(shouldShow);
    extension_settings['guided-generations'] ??= {};
    extension_settings['guided-generations'].showActionButtonContainer = nextVisible;
    saveSettingsDebounced();
    document.dispatchEvent(new CustomEvent('sb:guided-generations-settings-changed'));
    updateThemePickerUi();
}

// One switch for the one stored value, `extension_settings['guided-generations'].showActionButtonContainer`.
function createGuidedGenerationsBarRow() {
    return createInterfaceSwitchRow({
        id: 'sb-desktop-gg-bar-visible-input',
        label: 'Show Guided Generations Bar',
        subtitle: 'Display the Guided Generations action buttons in the chat composer',
        field: 'gg-bar-visible-desktop',
        dataAttribute: 'data-sb-gg-bar-visible-input',
        dataValue: 'desktop',
        onChange: checked => setGuidedGenerationsBarVisible(checked),
    });
}

// SillyBunny: desktop only. The phone bar never shows labels, so it has no switch for them.
function createTopbarIconsOnlyRow() {
    return createInterfaceSwitchRow({
        id: 'sb-desktop-topbar-icons-only-input',
        label: 'Icons Only Top Bar',
        subtitle: 'Show only icons in the desktop top bar',
        field: 'topbar-icons-only',
        onChange: checked => setTopbarIconsOnly('desktop', checked),
    });
}

/** The user's pin of the Characters page lives in upstream's `NavLockOn`; the hidden pin checkbox applies it. */
function isCharactersPinStored() {
    return accountStorage.getItem('NavLockOn') === 'true';
}

function setCharactersPin(enabled) {
    const pin = document.getElementById('rm_button_panel_pin');
    // The pin's own click handler stores NavLockOn and sets the classes that upstream reads.
    if (pin instanceof HTMLInputElement && pin.checked !== enabled) {
        pin.click();
    }
    if (isCharactersPinStored() !== enabled) {
        accountStorage.setItem('NavLockOn', String(enabled));
    }
}

// SillyBunny: upstream's pin of the Characters page, as a switch. The page stays open after a chat is picked above the phone layout; the stored value is left alone at 768px and below, where it has no effect.
function createCharactersPinRow() {
    return createInterfaceSwitchRow({
        id: 'sb-desktop-pin-characters-input',
        label: t`Keep Characters Open`,
        subtitle: t`The Characters page stays open after you pick a chat`,
        field: 'pin-characters',
        onChange: checked => setCharactersPin(checked),
    });
}

// SillyBunny: desktop only, as the group it sits in. The columns and the Window ceiling exist on the desktop layout only, so the phone page has no switch for them.
function createContentClampRow() {
    return createInterfaceSwitchRow({
        id: 'sb-desktop-content-clamp-input',
        label: t`Limit Content Width`,
        subtitle: t`Clamps the contents of Settings to a specific viewport for wide monitors`,
        field: 'content-clamp',
        onChange: checked => setContentClamp(checked),
    });
}

function createPaperTextureBody() {
    const toggleRow = createInterfaceSwitchRow({
        id: 'sb-paper-texture-enabled-input',
        label: 'Enable Paper Texture',
        subtitle: 'Add a paper texture across the mobile interface',
        field: 'paper-texture',
        onChange: checked => setPaperTextureEnabled(checked),
    });
    const opacitySliderGroup = createThemeSliderGroup({
        title: 'Texture Opacity',
        valueId: 'sb-paper-texture-opacity-value',
        inputId: 'sb-paper-texture-opacity-input',
        value: sbState.paperTextureOpacity,
        min: SB_PAPER_TEXTURE_OPACITY.min,
        max: SB_PAPER_TEXTURE_OPACITY.max,
        step: SB_PAPER_TEXTURE_OPACITY.step,
        ariaLabel: 'Paper Texture Opacity',
        caption: 'Higher values make the paper grain and wash more visible',
        onInput: nextValue => setPaperTextureOpacity(nextValue),
    });

    return createInterfaceGroupBody('sb-paper-texture-settings', [toggleRow, opacitySliderGroup], '#sb-paper-texture-enabled-input');
}

let splashPreferences = null;

/** The first call starts listening for settings events, so the drawer and the startup share one instance. */
function getSplashPreferences() {
    splashPreferences ??= initSplashPreferences({
        eventSource,
        eventTypes: event_types,
        accountStorage,
        storage: window.localStorage,
        readReducedMotion: () => power_user.reduced_motion,
    });
    return splashPreferences;
}

function updateShortcutButton(side) {
    const buttonId = getShortcutButtonId(side);
    const button = document.getElementById(buttonId);
    if (!(button instanceof HTMLElement)) return;

    const target = getShortcutTarget(side);
    const config = getShortcutConfig(target);
    const icon = button.querySelector('i');
    const span = button.querySelector('span');
    const isDisabled = target === 'none';

    if (isDisabled) {
        button.style.setProperty('display', 'none', 'important');
    } else {
        button.style.removeProperty('display');
    }

    if (icon) {
        icon.className = `fa-solid ${config.icon}`;
    }
    if (span) {
        span.textContent = config.label;
    }
    button.title = `Quick Access: ${config.label}`;
    button.setAttribute('aria-label', `Quick Access: ${config.label}`);
    button.dataset.sbUniversalSearchTrigger = String(isSearchShortcutTarget(target));
    syncShortcutButtonActiveStates();
    queueTopbarFit();
}

function syncShortcutButtonActiveStates() {
    const searchExpanded = getUniversalSearchState().expanded;

    for (const side of SB_SHORTCUT_SLOTS) {
        const buttonId = getShortcutButtonId(side);
        const button = document.getElementById(buttonId);

        if (!(button instanceof HTMLButtonElement)) {
            continue;
        }

        const target = getShortcutTarget(side);
        setButtonPressed(button, isSearchShortcutTarget(target) && searchExpanded);
    }

    queueTopbarSectionStateSync();
}

/**
 * The Top Bar Label group and the Custom Text group under it. Both show at every width and read one stored list of parts
 * and one stored text.
 * @returns {HTMLElement[]}
 */
function createTopbarLabelSettingsGroups() {
    const labelGroup = appearanceModule.createAppearanceGroup({
        id: 'topbar-label',
        elementId: 'sb-topbar-label-drawer',
        title: 'Top Bar Label',
        description: 'Choose what the center label shows',
    });
    labelGroup.append(...SB_TOPBAR_LABEL_PARTS.map(part => createTopbarLabelPartRow(part)));

    const customTextInput = createElement('input', {
        id: 'sb-topbar-custom-text-input',
        className: 'sb-topbar-custom-text-input',
        attrs: {
            type: 'text',
            maxlength: String(SB_TOPBAR_LABEL_CUSTOM_TEXT_MAX_LENGTH),
            placeholder: 'SillyBunny',
            'aria-label': 'Top Bar Custom Text',
        },
    });
    const customTextRow = createEntryRow({
        label: 'Custom Text Value',
        field: 'topbar-custom-text',
        input: customTextInput,
        floating: true,
        onInput: value => setTopbarCustomText(value),
    });
    const customTextGroup = appearanceModule.createAppearanceGroup({
        id: 'topbar-custom-text',
        title: 'Custom Text',
        description: 'This only appears in the top bar when the Custom Text switch is enabled above',
    });
    customTextGroup.append(customTextRow);
    customTextGroup.group.dataset.sbEnabledBy = '#sb-topbar-label-desktop-custom';

    return [labelGroup.section, customTextGroup.section];
}

/**
 * Zen Sliders and Mad Lab Mode exclude each other, so one three-way row stands in their place. Their upstream inputs stay,
 * hidden, as the transport the row writes through.
 */
function presentSliderModeRow() {
    const zen = document.getElementById('enableZenSliders');
    const lab = document.getElementById('enableLabMode');
    if (!(zen instanceof HTMLInputElement && lab instanceof HTMLInputElement) || document.getElementById('sb-slider-mode')) return;
    const labels = [zen, lab].map(input => input.closest('.checkbox_label')).filter(label => label instanceof HTMLElement);
    if (labels.length !== 2) return;
    labels[0].before(appearanceModule.createSliderModeRow({ zen, lab }));
    for (const label of labels) {
        // `[hidden]` alone loses to the `display` of the flex classes these labels carry, so the order pass's own marker hides them too.
        label.hidden = true;
        label.dataset.sbEmptiedByOrder = 'true';
    }
}

function injectThemePicker() {
    presentSliderModeRow();
    if (document.getElementById('sb-theme-card')) {
        updateThemePickerUi();
        return;
    }

    const themeBlock = document.getElementById('UI-presets-block');
    if (!(themeBlock instanceof HTMLElement)) {
        return;
    }

    const card = createElement('div', { id: 'sb-theme-card', className: 'sb-theme-card' });
    const surfaceSliderGroup = createThemeSliderGroup({
        title: 'Background Visibility',
        valueId: 'sb-surface-transparency-value',
        inputId: 'sb-surface-transparency-input',
        value: sbState.surfaceTransparency,
        min: SB_SURFACE_TRANSPARENCY.min,
        max: SB_SURFACE_TRANSPARENCY.max,
        step: SB_SURFACE_TRANSPARENCY.step,
        ariaLabel: 'Background Visibility',
        caption: 'Higher values make the home and chat surfaces more transparent so your selected background picture shows through',
        onInput: nextValue => setSurfaceTransparency(nextValue),
    });
    const bottomBarSliderGroup = createThemeSliderGroup({
        title: 'Bottom Bar Size',
        valueId: 'sb-bottom-bar-scale-value',
        inputId: 'sb-bottom-bar-scale-input',
        value: sbState.bottomBarScale,
        min: SB_TOPBAR_SCALE.min,
        max: SB_TOPBAR_SCALE.max,
        step: SB_TOPBAR_SCALE.step,
        ariaLabel: 'Bottom Bar Size',
        caption: 'Resize the bottom chat bar, send form, and action buttons without editing CSS',
        onInput: nextValue => setBottomBarScale(nextValue),
    });
    const desktopButtonSliderGroup = createThemeSliderGroup({
        title: 'Desktop Button Size',
        valueId: 'sb-desktop-button-scale-value',
        inputId: 'sb-desktop-button-scale-input',
        value: sbState.desktopButtonScale,
        min: SB_TOPBAR_SCALE.min,
        max: SB_TOPBAR_SCALE.max,
        step: SB_TOPBAR_SCALE.step,
        ariaLabel: 'Desktop Button Size',
        caption: 'Increase or decrease the desktop top bar and shell navigation buttons without changing mobile controls',
        onInput: nextValue => setDesktopButtonScale(nextValue),
    });
    const mobileButtonSliderGroup = createThemeSliderGroup({
        title: 'Mobile Button Size',
        valueId: 'sb-mobile-button-scale-value',
        inputId: 'sb-mobile-button-scale-input',
        value: sbState.mobileButtonScale,
        min: SB_TOPBAR_SCALE.min,
        max: SB_TOPBAR_SCALE.max,
        step: SB_TOPBAR_SCALE.step,
        ariaLabel: 'Mobile Button Size',
        caption: 'Increase or decrease the mobile nav and mobile chat tool buttons without changing desktop controls',
        onInput: nextValue => setMobileButtonScale(nextValue),
    });
    const topbarLabelSettingsGroups = createTopbarLabelSettingsGroups();
    const splashCharacterRow = createSplashCharacterRow(getSplashPreferences());
    const shortcutSettingsGroup = createShortcutSettingsGroup();

    // The boxed lists of the Interface page. Each has the id that the page's section order names, and the order puts it under its heading.
    // The Background Visibility row starts in the first list; the Appearance Background group takes it from there.
    const interfaceBody = createInterfaceGroupBody('sb-interface-settings-body', [splashCharacterRow.row, createCompactModeRow(), surfaceSliderGroup]);
    const desktopBody = createInterfaceGroupBody('sb-desktop-settings-outlet', [
        createTopbarIconsOnlyRow(),
        desktopButtonSliderGroup,
        createCharactersPinRow(),
        createContentClampRow(),
    ]);
    const mobileBody = createInterfaceGroupBody('sb-mobile-settings-outlet', [mobileButtonSliderGroup]);
    const bottomBarBody = createInterfaceGroupBody('sb-bottom-bar-settings', [
        bottomBarSliderGroup,
        createBottomChatBarRow(),
        createGuidedGenerationsBarRow(),
    ]);
    const paperTextureBody = createPaperTextureBody();

    getMessageStyleSelect()?.addEventListener('change', updateThemePickerUi);
    document.addEventListener('sb:chat-style-updated', updateThemePickerUi);
    // The rows of the page use the shared button, status and insensitive-row rules of the deferred editor sheet.
    void import('./sillybunny-editor/list-shell.js').then(({ loadListEditorStyles }) => loadListEditorStyles()).catch(error => console.warn('Failed to load the editor styles for the Interface page.', error));

    card.append(...topbarLabelSettingsGroups, shortcutSettingsGroup);
    themeBlock.append(card);
    // SillyBunny: keep the shared injection path, then mount Interface controls in their own tab.
    const interfaceRoot = document.getElementById(SB_USER_SETTINGS_CONTAINER_IDS.interface);
    (interfaceRoot instanceof HTMLElement ? interfaceRoot : card).prepend(interfaceBody, desktopBody, mobileBody, bottomBarBody, paperTextureBody);
    updateThemePickerUi();
}

function updateThemePickerUi() {
    if (!document.getElementById('sb-theme-card')) return;

    const sliderInput = document.getElementById('sb-surface-transparency-input');
    const sliderValue = document.getElementById('sb-surface-transparency-value');
    const bottomBarScaleInput = document.getElementById('sb-bottom-bar-scale-input');
    const bottomBarScaleValue = document.getElementById('sb-bottom-bar-scale-value');
    const desktopButtonScaleInput = document.getElementById('sb-desktop-button-scale-input');
    const desktopButtonScaleValue = document.getElementById('sb-desktop-button-scale-value');
    const mobileButtonScaleInput = document.getElementById('sb-mobile-button-scale-input');
    const mobileButtonScaleValue = document.getElementById('sb-mobile-button-scale-value');
    const customTextInputs = document.querySelectorAll('.sb-topbar-custom-text-input');
    const paperTextureEnabledInput = document.getElementById('sb-paper-texture-enabled-input');
    const paperTextureOpacityInput = document.getElementById('sb-paper-texture-opacity-input');
    const paperTextureOpacityValue = document.getElementById('sb-paper-texture-opacity-value');

    if (sliderInput instanceof HTMLInputElement) {
        sliderInput.min = String(SB_SURFACE_TRANSPARENCY.min);
        sliderInput.max = String(SB_SURFACE_TRANSPARENCY.max);
        sliderInput.step = String(SB_SURFACE_TRANSPARENCY.step);
        sliderInput.value = String(sbState.surfaceTransparency);
    }

    if (sliderValue instanceof HTMLElement) {
        sliderValue.textContent = formatSurfaceTransparency(sbState.surfaceTransparency);
    }

    if (bottomBarScaleInput instanceof HTMLInputElement) {
        bottomBarScaleInput.value = String(sbState.bottomBarScale);
    }

    if (bottomBarScaleValue instanceof HTMLElement) {
        bottomBarScaleValue.textContent = formatTopbarScale(sbState.bottomBarScale);
    }

    if (desktopButtonScaleInput instanceof HTMLInputElement) {
        desktopButtonScaleInput.value = String(sbState.desktopButtonScale);
    }

    if (desktopButtonScaleValue instanceof HTMLElement) {
        desktopButtonScaleValue.textContent = formatTopbarScale(sbState.desktopButtonScale);
    }

    if (mobileButtonScaleInput instanceof HTMLInputElement) {
        mobileButtonScaleInput.value = String(sbState.mobileButtonScale);
    }

    if (mobileButtonScaleValue instanceof HTMLElement) {
        mobileButtonScaleValue.textContent = formatTopbarScale(sbState.mobileButtonScale);
    }

    for (const input of document.querySelectorAll('[data-sb-topbar-label-part]')) {
        if (!(input instanceof HTMLInputElement)) {
            continue;
        }

        input.checked = sbState.topbarLabel.desktopParts.includes(normalizeTopbarLabelPart(input.getAttribute('data-sb-topbar-label-part')));
    }

    for (const customTextInput of customTextInputs) {
        if (customTextInput instanceof HTMLInputElement && customTextInput.value !== sbState.topbarLabel.customText) {
            customTextInput.value = sbState.topbarLabel.customText;
        }
    }

    for (const input of document.querySelectorAll('[data-sb-compact-mode-input]')) {
        if (!(input instanceof HTMLInputElement)) {
            continue;
        }

        input.checked = sbState.compactMode;
    }

    for (const input of document.querySelectorAll('[data-sb-bottom-bar-visible-input]')) {
        if (!(input instanceof HTMLInputElement)) {
            continue;
        }

        input.checked = sbState.bottomChatBar.visible;
    }

    const guidedGenerationsBarVisible = isGuidedGenerationsBarVisible();
    for (const input of document.querySelectorAll('[data-sb-gg-bar-visible-input]')) {
        if (!(input instanceof HTMLInputElement)) {
            continue;
        }

        input.checked = guidedGenerationsBarVisible;
    }

    const topbarIconsOnlyInput = document.getElementById('sb-desktop-topbar-icons-only-input');

    if (topbarIconsOnlyInput instanceof HTMLInputElement) {
        topbarIconsOnlyInput.checked = sbState.topbarIconsOnly.desktop;
    }

    syncContentClampInput();

    const charactersPinInput = document.getElementById('sb-desktop-pin-characters-input');

    if (charactersPinInput instanceof HTMLInputElement) {
        // NavLockOn is the stored value; the hidden pin checkbox follows it, as it does at startup on a desktop browser.
        charactersPinInput.checked = isCharactersPinStored();
        const pin = document.getElementById('rm_button_panel_pin');
        if (pin instanceof HTMLInputElement && pin.checked !== charactersPinInput.checked) {
            pin.checked = charactersPinInput.checked;
        }
    }

    if (paperTextureEnabledInput instanceof HTMLInputElement) {
        paperTextureEnabledInput.checked = sbState.paperTextureEnabled;
    }

    if (paperTextureOpacityInput instanceof HTMLInputElement) {
        paperTextureOpacityInput.min = String(SB_PAPER_TEXTURE_OPACITY.min);
        paperTextureOpacityInput.max = String(SB_PAPER_TEXTURE_OPACITY.max);
        paperTextureOpacityInput.step = String(SB_PAPER_TEXTURE_OPACITY.step);
        paperTextureOpacityInput.value = String(sbState.paperTextureOpacity);
        paperTextureOpacityInput.disabled = !sbState.paperTextureEnabled;
    }

    if (paperTextureOpacityValue instanceof HTMLElement) {
        paperTextureOpacityValue.textContent = formatPaperTextureOpacity(sbState.paperTextureOpacity);
    }

    for (const counter of document.querySelectorAll('[data-sb-theme-slider-counter]')) {
        if (!(counter instanceof HTMLInputElement)) continue;
        const rangeId = counter.dataset.sbThemeSliderCounter;
        if (!rangeId) continue;
        const range = document.getElementById(rangeId);
        if (range instanceof HTMLInputElement) {
            counter.value = range.value;
            counter.disabled = range.disabled;
        }
    }
    for (const button of document.querySelectorAll('[data-sb-message-style]')) {
        const isActive = button.getAttribute('data-sb-message-style') === getCurrentMessageStyle();
        button.classList.toggle('is-selected', isActive);
        button.setAttribute('aria-pressed', String(isActive));
    }
}

/**
 * The sections the subpage stacks around `searchRoot` present as rows, with each row's label.
 *
 * A stack keeps its closed sections in the hidden store, moves the open one into its detail page,
 * and moves the panel's own chrome into its list heading. Once a stack is mounted none of that is
 * inside the tab's search root, so the headings are returned as extra roots alongside the sections.
 */
function getSubpageSearchRoots(searchRoot) {
    const sections = new Map();
    const headings = [];
    for (const stack of sbSubpageStacks.values()) {
        if (!stack.host.contains(searchRoot) && !searchRoot.contains(stack.host)) {
            continue;
        }
        headings.push(stack.listLead);
        for (const row of stack.rows) {
            const source = row.source?.();
            if (source instanceof HTMLElement) {
                sections.set(source, row.label);
            }
        }
    }
    return { sections, headings };
}

/**
 * One entry for the page itself, carrying its name, aliases and description.
 *
 * A tab's description never appears as a DOM label, and its aliases exist only for the sidebar, so
 * without this a page is unfindable by the words that describe it ("Prompt Manager", "API Response
 * Configuration"). The entry anchors to the page's heading when one is rendered, so activating it
 * opens the page rather than a control inside it.
 */
function createPageSearchEntry(tabState) {
    const heading = tabState.panel?.querySelector(`.${SB_FLAT_SECTION_HEADER_CLASS}, h3, h4, .standoutHeader`);
    const searchText = normalizeText([
        tabState.label,
        tabState.id,
        ...(tabState.searchAliases ?? []),
    ].join(' '));
    if (searchText.length < 3) {
        return null;
    }
    return {
        element: heading instanceof HTMLElement ? heading : null,
        searchText,
        displayText: tabState.label,
        sectionLabel: tabState.label,
        tabId: tabState.id,
        tabLabel: tabState.label,
        headingMatch: true,
        dedupeKey: `${tabState.id}::page`,
    };
}

function createSearchIndex(tabState) {
    // Persona results come from data; hidden transports and transient editor fields are not search targets.
    if (tabState.id === 'persona') return [];
    const searchRoot = tabState.searchRoot;
    if (!(searchRoot instanceof HTMLElement)) {
        return [];
    }

    const entries = [];
    const seen = new Set();
    const pageEntry = createPageSearchEntry(tabState);
    if (pageEntry) {
        entries.push(pageEntry);
    }
    const excludedSelector = [
        '.sb-search-result',
        '.sb-legacy-search-hidden',
        // Unwritten placeholder copy is not a setting.
        SB_SEARCH_PLACEHOLDER_SELECTOR,
        '.sb-theme-card',
    ].join(', ');
    const { sections: subpageSections, headings: subpageHeadings } = getSubpageSearchRoots(searchRoot);
    const searchRoots = [searchRoot, ...subpageHeadings, ...subpageSections.keys()]
        .filter((root, index) => index === 0 || !searchRoot.contains(root));

    // The Editor retains its existing heading and search structure.
    const includeCategoryTitles = tabState.id !== 'editor';
    const targetSelector = includeCategoryTitles
        ? `${SB_SEARCH_TARGET_SELECTOR}, .sb-settings-category-title`
        : SB_SEARCH_TARGET_SELECTOR;
    for (const element of searchRoots.flatMap(root => Array.from(root.querySelectorAll(targetSelector)))) {
        if (!(element instanceof HTMLElement)) {
            continue;
        }

        if (element.closest(excludedSelector)) {
            continue;
        }

        // The title carries the category description in search; indexing its wrapper adds a second result.
        if (includeCategoryTitles && element.matches('.sb-settings-category-header, .sb-settings-flat-header, .inline-drawer-toggle')
            && element.querySelector('.sb-settings-category-title')) {
            continue;
        }

        // SillyBunny: the subpage store is hidden by CSS, and a match there is only reachable
        // through the row that moves its section onto the detail page (see revealSearchMatch).
        // Store content no row presents has no way on screen, so it is left out.
        let subpageLabel = null;
        for (const [section, label] of subpageSections) {
            if (section.contains(element)) {
                subpageLabel = label;
                break;
            }
        }
        if (subpageLabel === null && element.closest(`.${SB_SUBPAGE_STORE_CLASS}`)) {
            continue;
        }

        const sectionLabel = subpageLabel ?? getSearchSectionLabel(element, tabState.label);
        const searchText = getSearchText(element, sectionLabel, includeCategoryTitles);
        const displayText = getSearchDisplayText(element, sectionLabel);
        const dedupeKey = getSearchEntryDedupeKey(tabState, sectionLabel, displayText);
        // Identical sampler explanations belong to separate live backend sections. Keep both
        // until availability filtering, or the hidden first backend masks the active one's help.
        const indexDedupeKey = [dedupeKey, element.closest('[data-sb-sampling-apis]')?.id].filter(Boolean).join('::');

        // Keep each backend's category title until the active-backend filter runs.
        if (searchText.length < 3 || (seen.has(indexDedupeKey) && !(includeCategoryTitles && element.matches('.sb-settings-category-title')))) {
            continue;
        }

        seen.add(indexDedupeKey);
        entries.push({
            element,
            searchText,
            displayText,
            sectionLabel,
            tabId: tabState.id,
            tabLabel: tabState.label,
            dedupeKey,
        });
    }

    return entries;
}

/**
 * Returns the Characters pages as search destinations, so "Prompt Manager" or "lorebook" finds the
 * page that holds them rather than only a control whose label happens to contain the word.
 */
function getCharacterPanelSearchEntries() {
    const panel = getCharacterPanel();

    return SB_CHARACTER_PANEL_TABS.map((tab) => {
        const button = panel?.querySelector(`[data-sb-character-tab="${CSS.escape(tab.id)}"]`);
        const searchText = normalizeText([
            tab.label,
            tab.id,
            'characters',
            ...(tab.searchAliases ?? []),
        ].join(' '));

        return {
            element: button instanceof HTMLElement ? button : null,
            searchText,
            displayText: tab.label,
            sectionLabel: tab.label,
            tabId: tab.id,
            tabLabel: tab.label,
            headingMatch: true,
            dedupeKey: `characters::${tab.id}`,
        };
    });
}

/**
 * Returns synthetic search entries for all personas from power_user.personas.
 * These are not in the DOM in a searchable form (paginated list), so we read
 * the data directly and provide an action that navigates to the persona.
 */
function getPersonaSearchEntries(tabState) {
    const context = getSillyTavernContext();
    const personas = context?.powerUserSettings?.personas ?? {};
    const personaDescriptions = context?.powerUserSettings?.persona_descriptions ?? {};
    const defaultPersona = context?.powerUserSettings?.default_persona ?? '';
    const entries = [];

    for (const [avatarId, name] of Object.entries(personas)) {
        if (!name || name === '[Unnamed Persona]') continue;
        const personaDescription = personaDescriptions[avatarId]?.description ?? '';
        const personaTitle = personaDescriptions[avatarId]?.title ?? '';
        const searchText = normalizeText([
            name,
            avatarId,
            personaTitle,
            personaDescription,
            avatarId === defaultPersona ? 'default persona' : '',
        ].join(' '));

        if (searchText.length < 2) continue;

        entries.push({
            element: null,
            searchText,
            displayText: name,
            sectionLabel: 'Persona',
            tabId: tabState.id,
            tabLabel: tabState.label,
            dedupeKey: getSearchEntryDedupeKey(tabState, 'Persona', name, { avatarId }),
            action: async () => {
                // SillyBunny: open the exact persona without changing the list search
                const { openPersonaEditor } = await import('./sillybunny-persona-editor.js');
                await openPersonaEditor({ avatarId });
            },
        });
    }

    return entries;
}

function getSearchSectionLabel(element, fallback) {
    const sampler = element.closest('.ds-row-expander[data-sb-sampling-control]');
    const samplerTitle = sampler?.querySelector(':scope > .ds-row-expander__header .ds-row-label')?.textContent.trim();
    if (samplerTitle) return samplerTitle;
    // For extension containers: use the extension's own name/header, not the parent tab label
    const extContainer = element.closest('.extension_container, [id$="-container"]');
    if (extContainer instanceof HTMLElement) {
        const extName = extContainer.querySelector('.extension_name')
            ?? extContainer.querySelector(':scope > .inline-drawer > .inline-drawer-toggle b, :scope > .inline-drawer > .inline-drawer-header b')
            ?? extContainer.querySelector(':scope > .inline-drawer > .inline-drawer-toggle, :scope > .inline-drawer > .inline-drawer-header')
            ?? extContainer.querySelector('h3, h4, strong');
        if (extName) {
            const text = String(extName.textContent ?? '').replace(/\s+/g, ' ').trim();
            if (text) return text;
        }
    }

    // Walk up to the nearest inline-drawer and use its toggle header as the section
    const inlineDrawer = element.closest('.inline-drawer');
    if (inlineDrawer instanceof HTMLElement) {
        const toggle = inlineDrawer.querySelector(':scope > .inline-drawer-toggle');
        if (toggle) {
            const text = getSearchLabelText(toggle).replace(/\s+/g, ' ').trim();
            if (text && text !== fallback) return text;
        }
    }

    // Flattened subsections are no longer drawers, so they are checked separately: without this a
    // control lifted out of, say, Auto-swipe would report the enclosing drawer's name instead.
    const flatSection = element.closest(`.${SB_FLAT_SECTION_CLASS}`);
    if (flatSection instanceof HTMLElement) {
        const heading = flatSection.querySelector(`:scope > .${SB_FLAT_SECTION_HEADER_CLASS}`);
        const text = (heading ? getSearchLabelText(heading) : '').replace(/\s+/g, ' ').trim();
        if (text && text !== fallback) return text;
    }

    // A group that SillyBunny builds names itself by its heading.
    const labelledGroup = element.closest('[data-sb-category] > .ds-pref-group[aria-labelledby]');
    const groupHeading = labelledGroup ? document.getElementById(labelledGroup.getAttribute('aria-labelledby') ?? '') : null;
    const groupText = (groupHeading ? getSearchLabelText(groupHeading) : '').replace(/\s+/g, ' ').trim();
    if (groupText && groupText !== fallback) return groupText;

    const preferred = element.closest('.bg-header-row-1')
        ?? element.closest('.bg-header-row-2')
        ?? element.closest('label, h3, h4, h5, strong');

    const text = (preferred ? getSearchLabelText(preferred) : String(fallback ?? '')).replace(/\s+/g, ' ').trim();
    return text || fallback;
}

// Ranking is coarse on purpose: an exact query name beats a prefix, a prefix beats a word-start,
// and a section heading beats a leaf control. Length is only a tiebreak, so a long descriptive row
// cannot outrank the setting it describes.
function getSearchMatchScore(entry, normalizedQuery, headingMatch) {
    const searchText = entry.searchText;
    const exactMatch = searchText === normalizedQuery;
    const startsWithQuery = searchText.startsWith(normalizedQuery);
    const wordMatch = !exactMatch && !startsWithQuery
        && new RegExp(`(^|\\s)${escapeRegex(normalizedQuery)}`).test(searchText);
    return Number(exactMatch) * 100
        + Number(startsWithQuery) * 20
        + Number(wordMatch) * 8
        + Number(headingMatch) * 5
        - Math.min(entry.displayText.length, 400) / 1000;
}

function getSearchMatchKey(shellKey, entry) {
    return [
        shellKey,
        entry.dedupeKey || [
            entry.tabId,
            normalizeText(entry.sectionLabel),
            normalizeText(entry.displayText),
        ].filter(Boolean).join('::'),
    ].filter(Boolean).join('::');
}

function collectGlobalSearchMatches(query, { limit = Infinity, includeEntities = true } = {}) {
    const normalizedQuery = normalizeText(query);

    if (!normalizedQuery) {
        return [];
    }

    const searchTerms = normalizedQuery.split(' ').filter(Boolean);
    const matches = new Map();
    const availableByEntry = new WeakMap();

    for (const [shellKey, shellState] of Object.entries(sbState.shells)) {
        const shellLabel = getShellConfig(shellKey)?.title || shellKey;

        for (const tabState of shellState.tabs.values()) {
            if (!tabState.searchIndex) {
                tabState.searchIndex = createSearchIndex(tabState);
            }

            const extraEntries = tabState.id === 'persona' ? getPersonaSearchEntries(tabState)
                : tabState.id === 'agents' ? getAgentsPanelSearchEntries(tabState) : [];

            for (const entry of [...(tabState.id === 'agents' ? [] : tabState.searchIndex), ...extraEntries]) {
                // Match first: the visibility check walks ancestors with `getComputedStyle`, and the
                // memo only covers repeated rows, so this filter is what keeps a keystroke cheap.
                if (!searchTerms.every(term => entry.searchText.includes(term))) {
                    continue;
                }
                if (!isSearchEntryAvailable(entry, tabState, availableByEntry)) continue;

                // Whether the hit names a section rather than a control. The universal search panel
                // uses this for ranking; the sidebar needs it to tell a page-level hit from a control.
                const headingMatch = entry.headingMatch === true || (entry.element instanceof HTMLElement
                    && (entry.element.matches(SB_SIDEBAR_SECTION_MATCH_SELECTOR)
                        || (tabState.id !== 'editor' && entry.element.matches('.sb-settings-category-title'))));
                const match = {
                    ...entry,
                    shellKey,
                    shellLabel,
                    headingMatch,
                    score: getSearchMatchScore(entry, normalizedQuery, headingMatch),
                };
                const matchKey = getSearchMatchKey(shellKey, entry);
                const existingMatch = matches.get(matchKey);
                const shouldReplaceMatch = !existingMatch
                    || match.score > existingMatch.score
                    || (match.score === existingMatch.score
                        && typeof match.action === 'function'
                        && typeof existingMatch.action !== 'function');

                if (shouldReplaceMatch) {
                    matches.set(matchKey, match);
                }
            }
        }
    }

    // Characters, groups, World Info books and personas live outside sbState.shells; their entries
    // come from app data rather than the tab DOM.
    if (includeEntities) {
        const searchState = getUniversalSearchState();
        const personas = getPersonaSearchEntries(getCharacterPanelTabConfig('persona'));
        const entities = [
            ...getCharacterPanelSearchEntries(),
            ...personas,
            ...collectEntitySearchEntries(normalizedQuery, {
                limit: SB_UNIVERSAL_ENTITY_SCAN_LIMIT,
                skippedWorlds: searchState.skippedWorlds,
            }),
        ];
        for (const entry of entities) {
            if (!searchTerms.every(term => entry.searchText.includes(term))) continue;
            const headingMatch = entry.headingMatch !== false;
            matches.set(getSearchMatchKey('characters', entry), {
                ...entry,
                shellKey: 'characters',
                shellLabel: 'Characters',
                headingMatch,
                score: getSearchMatchScore(entry, normalizedQuery, headingMatch),
            });
        }
    }

    // A stable tiebreak keeps the panel from reshuffling equal scores between keystrokes.
    return Array.from(matches.values())
        .sort((left, right) => right.score - left.score
            || left.displayText.localeCompare(right.displayText))
        .slice(0, limit);
}

// Intersection-observer-free visibility check is expensive (`getComputedStyle` per ancestor), and a
// single pass asks about the same rows repeatedly. The memo is per pass: visibility can legitimately
// change between renders, so it must never outlive one.
function isSearchEntryAvailable(entry, tabState, availableByEntry = null) {
    if (availableByEntry?.has(entry)) {
        return availableByEntry.get(entry);
    }
    const available = computeSearchEntryAvailability(entry, tabState);
    availableByEntry?.set(entry, available);
    return available;
}

function computeSearchEntryAvailability(entry, tabState) {
    // Keep both device variants indexed so resizing can reveal the newly available controls.
    const unavailableDevice = isMobileViewport() ? '.sb-desktop-setting' : '.sb-mobile-setting';
    if (entry.element instanceof HTMLElement && entry.element.closest(unavailableDevice)) return false;
    if (!['sampling', 'prompting', 'editor'].includes(tabState.id)) return true;
    if (!(entry.element instanceof HTMLElement) || !tabState.searchRoot.contains(entry.element)) return false;
    for (let element = entry.element; element && element !== tabState.searchRoot; element = element.parentElement) {
        // Collapsed sampler help and closed expanders are searchable; their provider/card ancestors still gate availability.
        if (element.matches('.sb-sampling-help[hidden], .ds-row-expander-content[hidden]')) continue;
        if (element.hidden || getComputedStyle(element).display === 'none') return false;
    }
    return true;
}

async function renderUniversalSearchResults(query) {
    const searchState = getUniversalSearchState();
    const results = searchState.results;

    if (!(results instanceof HTMLElement)) {
        return;
    }

    const request = Symbol();
    sbSearchRenderRequests.set(results, request);

    const clearResults = () => {
        results.replaceChildren();
        searchState.activeIndex = -1;
        searchState.input?.removeAttribute('aria-activedescendant');
    };

    if (!searchState.expanded) {
        clearResults();
        results.classList.remove('is-visible');
        return;
    }

    const trimmedQuery = String(query ?? '').trim();

    // A new query starts from the short list: "show all" belongs to the query it was asked for.
    if (trimmedQuery !== searchState.renderedQuery) {
        searchState.renderedQuery = trimmedQuery;
        searchState.expandedAll = false;
    }

    if (!trimmedQuery) {
        results.removeAttribute('aria-busy');
        clearResults();
        renderSearchEmptyState(results, SB_UNIVERSAL_SEARCH_IDLE_TITLE, SB_UNIVERSAL_SEARCH_IDLE_HINT, 'empty');
        results.classList.add('is-visible');
        return;
    }

    // The first query waits for the on-demand settings pages. The list keeps what it shows (the idle state, or the
    // last answer) until the new answer replaces it in one step, so it is never blank while the pages load.
    results.setAttribute('aria-busy', 'true');
    await prepareShellSearch();
    if (sbSearchRenderRequests.get(results) !== request) return;
    results.removeAttribute('aria-busy');
    if (!searchState.expanded) return;
    clearResults();
    const matches = collectGlobalSearchMatches(trimmedQuery, {
        limit: searchState.expandedAll ? Infinity : SB_UNIVERSAL_SEARCH_RESULT_LIMIT,
    });

    // Rows are deduped on what the panel actually shows, so two controls that read identically in
    // one section collapse to one destination instead of filling the list twice.
    const groupedMatches = new Map();
    for (const match of matches) {
        const groupLabel = `${match.shellLabel} · ${match.tabLabel}`;
        if (!groupedMatches.has(groupLabel)) {
            groupedMatches.set(groupLabel, new Map());
        }
        const groupMatches = groupedMatches.get(groupLabel);
        const rowKey = [match.dedupeKey, match.sectionLabel, match.displayText]
            .map(value => normalizeText(value))
            .join('::');
        const existing = groupMatches.get(rowKey);
        if (!existing || match.score > existing.score) {
            groupMatches.set(rowKey, match);
        }
    }

    const totalMatches = matches.length;
    const perGroupLimit = searchState.expandedAll ? Infinity : SB_UNIVERSAL_SEARCH_GROUP_LIMIT;
    // Rows are addressed by position, not by the element: a debounced re-render can replace a row
    // between the pointerdown and the click, and a handler bound to the dead node would do nothing.
    const rows = [];
    searchState.renderedRows = rows;

    for (const [groupLabel, groupMatches] of groupedMatches.entries()) {
        const group = createElement('div', {
            className: 'sb-search-result-group',
            attrs: {
                role: 'group',
                'aria-label': groupLabel,
            },
        });
        group.appendChild(createElement('div', { className: 'sb-search-result-group-label', text: groupLabel }));

        let shown = 0;
        // Two cards can legitimately share a name, so identical rows are counted rather than hidden:
        // three "Bunny Guide" results would otherwise read as three destinations when they are one.
        const shownCounts = new Map();
        for (const match of groupMatches.values()) {
            if (shown >= perGroupLimit) break;
            shown += 1;
            const sectionDisplay = match.sectionLabel === match.tabLabel
                ? match.displayText || match.tabLabel
                : match.sectionLabel;
            const duplicateKey = `${sectionDisplay}::${match.displayText}`;
            shownCounts.set(duplicateKey, (shownCounts.get(duplicateKey) ?? 0) + 1);
            const duplicateIndex = shownCounts.get(duplicateKey);

            const rowIndex = rows.length;
            rows.push(match);
            const button = createElement('button', {
                className: 'sb-search-result',
                attrs: {
                    type: 'button',
                    role: 'option',
                    id: `sb-search-result-${rowIndex}`,
                    'data-sb-search-row': String(rowIndex),
                    'aria-selected': 'false',
                },
            });
            const detailText = normalizeText(match.displayText) === normalizeText(match.sectionLabel)
                ? `Jump straight to this item in ${match.tabLabel}.`
                : match.displayText;

            button.appendChild(createElement('strong', { text: match.description !== undefined ? match.displayText : sectionDisplay }));

            if (match.description !== undefined || sectionDisplay !== match.displayText) {
                button.appendChild(createElement('span', { text: match.description ?? detailText }));
            }

            button.appendChild(createElement('small', {
                text: match.locationLabel ? `${groupLabel} · ${match.sectionLabel}` : typeof match.action === 'function' ? 'Quick action' : 'Jump to setting',
            }));

            if (duplicateIndex > 1) {
                button.classList.add('is-duplicate');
                button.setAttribute('data-sb-search-duplicate', String(duplicateIndex));
            }

            group.appendChild(button);
        }

        const hiddenInGroup = groupMatches.size - shown;
        if (hiddenInGroup > 0) {
            group.appendChild(createUniversalSearchShowAllRow(hiddenInGroup, groupLabel));
        }

        results.appendChild(group);
    }

    if (!results.childElementCount) {
        renderSearchEmptyState(
            results,
            t`No Results Found`,
            SB_UNIVERSAL_SEARCH_EMPTY_HINT,
        );
    } else if (!searchState.expandedAll && totalMatches > rows.length) {
        results.appendChild(createUniversalSearchShowAllRow(totalMatches - rows.length));
    }

    const wasVisible = results.classList.contains('is-visible');
    results.classList.add('is-visible');

    // Animate the results panel on first appearance
    if (!wasVisible) {
        stopMotion(results);
        animateIn(results, [
            { opacity: 0, transform: 'translateY(-4px)' },
            { opacity: 1, transform: 'translateY(0)' },
        ], { duration: MOTION_FAST });
    }

    setUniversalSearchActiveIndex(results.querySelector('.sb-search-result') ? 0 : -1);
}

function setUniversalSearchActiveIndex(index) {
    const searchState = getUniversalSearchState();
    const results = searchState.results;
    const input = searchState.input;

    if (!(results instanceof HTMLElement)) {
        return;
    }

    const buttons = Array.from(results.querySelectorAll('.sb-search-result'));
    searchState.activeIndex = buttons.length ? Math.min(Math.max(index, 0), buttons.length - 1) : -1;

    for (let i = 0; i < buttons.length; i++) {
        const button = buttons[i];
        const active = i === searchState.activeIndex;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-selected', String(active));
        if (active) {
            input?.setAttribute('aria-activedescendant', button.id);
            scrollElementIntoManagedView(button, { block: 'nearest' });
        }
    }

    if (searchState.activeIndex === -1) {
        input?.removeAttribute('aria-activedescendant');
    }
}

function expandHiddenAccordions(target) {
    // SillyBunny: elements in the subpage store are hidden by CSS, not by a closed drawer;
    // clicking their toggles fires jQuery slideToggle and injects inline display:block,
    // overriding the store hide rule and bleeding the old panel into view.
    if (target?.closest('.' + SB_SUBPAGE_STORE_CLASS)) {
        return;
    }

    const helpRow = target.closest('.sb-sampling-help-row');
    const help = helpRow?.querySelector(':scope > .sb-sampling-help');
    if (help?.hidden) {
        helpRow.querySelector('.sb-sampling-help-toggle')?.click();
    }

    const hiddenContents = [];
    const closedExpanders = [];
    let current = target.parentElement;

    while (current) {
        if (current.classList.contains('inline-drawer-content') && getComputedStyle(current).display === 'none') {
            hiddenContents.push(current);
        }
        if (current instanceof HTMLDetailsElement) current.open = true;
        if (current.matches('.ds-row-expander-content[hidden]')) {
            closedExpanders.push(current.parentElement?.querySelector(':scope > .ds-row-expander__header > .ds-row-expander__toggle'));
        }

        current = current.parentElement;
    }

    for (const toggle of closedExpanders.reverse()) {
        if (toggle instanceof HTMLElement) toggle.click();
    }

    for (const content of hiddenContents.reverse()) {
        const toggle = content.previousElementSibling?.classList.contains('inline-drawer-toggle')
            ? content.previousElementSibling
            : content.parentElement?.querySelector(':scope > .inline-drawer-toggle');

        if (toggle instanceof HTMLElement) {
            toggle.click();
        }
    }
}

const SB_SEARCH_HIGHLIGHT_CLASS = 'highlighted-drawer';
const SB_SEARCH_HIGHLIGHT_DURATION_MS = 1800;

function pulseSearchTarget(target) {
    if (!(target instanceof HTMLElement)) {
        return;
    }

    const drawer = target.closest('.inline-drawer');
    const flatSection = target.closest(`.${SB_FLAT_SECTION_CLASS}`);
    const highlightTarget = flatSection instanceof HTMLElement
        ? flatSection
        : drawer instanceof HTMLElement ? drawer : target;

    document.querySelectorAll('.' + SB_SEARCH_HIGHLIGHT_CLASS)
        .forEach(el => el.classList.remove(SB_SEARCH_HIGHLIGHT_CLASS));

    highlightTarget.classList.add(SB_SEARCH_HIGHLIGHT_CLASS);
    window.setTimeout(() => {
        highlightTarget.classList.remove(SB_SEARCH_HIGHLIGHT_CLASS);
    }, SB_SEARCH_HIGHLIGHT_DURATION_MS);
}

function revealSettingsCategoryFor(target) {
    if (!(target instanceof HTMLElement)) {
        return;
    }

    // Content is split across three permanent containers, so a match can live in any of them
    // rather than all settings living in one block.
    const roots = getUserSettingsContentRoots();
    const settingsContent = roots.find(root => root.contains(target));
    if (!settingsContent) {
        return;
    }

    const taggedDrawer = target.closest('.inline-drawer[data-settings-tab]');
    if (taggedDrawer instanceof HTMLElement) {
        const category = taggedDrawer.getAttribute('data-settings-tab');
        if (category) {
            settingsContent.setAttribute('data-active-tab', category);
            const settingsBlock = document.getElementById('user-settings-block');
            if (settingsBlock) {
                settingsBlock.setAttribute('data-active-tab', category);
            }
            document.querySelectorAll('.sb-settings-tab-btn').forEach(btn => {
                btn.classList.toggle('active', btn.getAttribute('data-tab') === category);
            });
            return;
        }
    }

    settingsContent.setAttribute('data-search-active', 'true');
    const tabNav = document.getElementById('sb-settings-tabs');
    if (tabNav) {
        const clearSearchActive = () => {
            settingsContent.removeAttribute('data-search-active');
            tabNav.removeEventListener('click', clearSearchActive);
        };
        tabNav.addEventListener('click', clearSearchActive);
    }
}

/** Counts search jumps, so that the delayed steps of a jump stop when a newer jump replaces it. */
let searchJumpCount = 0;

function revealSearchMatch(shellKey, match) {
    const jump = ++searchJumpCount;
    closeAllDropdowns({ except: shellKey });

    // Entries with a custom action (e.g. persona results) bypass DOM scrolling
    if (typeof match.action === 'function') {
        match.action();
        return;
    }

    if (shellKey === 'characters') {
        openCharacterPanelTab(match.tabId);

        if (match.element instanceof HTMLElement) {
            window.setTimeout(() => {
                expandHiddenAccordions(match.element);
                scrollElementIntoManagedView(match.element, {
                    block: 'center',
                    behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
                });
                pulseSearchTarget(match.element);
            }, 40);
        }

        return;
    }

    openShell(shellKey, match.tabId);
    // The search result already selects a destination, so show it past the mobile sidebar.
    if (isMobileViewport()) setSettingsMobileContentView(true);

    // The jump finishes on timers. A page that the user opens or closes in the meantime must not be
    // undone, so each delayed step stops when the stack shows a different page than it expects.
    const stackKey = `${shellKey}:${match.tabId}`;
    const openRowAtJump = sbSubpageStacks.get(stackKey)?.openRowId ?? null;

    window.setTimeout(() => {
        // SillyBunny: subpage-hosted tabs route through the stack, not through drawer routing.
        // Matches inside the store would otherwise trigger jQuery slideToggle on inline-drawer
        // toggles, injecting inline display:block and bleeding the old panel into view.
        const stack = sbSubpageStacks.get(stackKey);
        if (stack) {
            if (jump !== searchJumpCount || stack.openRowId !== openRowAtJump) {
                return;
            }
            const row = stack.rows.find(r => {
                const source = r.source?.();
                return source instanceof HTMLElement && source.contains(match.element);
            });
            if (row) {
                stack.open(row.id);
                const slideDelay = window.matchMedia('(prefers-reduced-motion: reduce)').matches
                    ? 0
                    : SB_SUBPAGE_DURATION;
                window.setTimeout(() => {
                    if (jump !== searchJumpCount || stack.openRowId !== row.id) return;
                    if (!(match.element instanceof HTMLElement)) return;
                    expandHiddenAccordions(match.element);
                    scrollElementIntoManagedView(match.element, {
                        block: 'center',
                        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
                    });
                    pulseSearchTarget(match.element);
                }, slideDelay + 40);
                return;
            }
            // The match is in the list page's own chrome, which a detail page covers: put the list
            // back before scrolling it, or the scroll would move a page nobody can see.
            if (stack.isOpen()) {
                stack.close({ instant: true });
            }
            if (match.element instanceof HTMLElement) {
                scrollElementIntoManagedView(match.element, {
                    block: 'center',
                    behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
                });
                pulseSearchTarget(match.element);
            }
            return;
        }

        revealSettingsCategoryFor(match.element);
        expandHiddenAccordions(match.element);
        scrollElementIntoManagedView(match.element, {
            block: 'center',
            behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
        });
        pulseSearchTarget(match.element);
    }, 40);
}

function setActiveTab(shellKey, tabId) {
    const shellState = getShellState(shellKey);
    const shellConfig = getShellConfig(shellKey);

    if (shellKey === 'left' && tabId === 'world-info') {
        // SillyBunny: final guard for code paths that still ask for a left-shell World Info
        // route. World Info lives in Characters.
        openCharacterPanelTab('world-info');
        return;
    }

    if (!shellState || !shellState.tabs.has(tabId)) {
        return;
    }

    preloadPanelStylesheets(shellKey, tabId);

    const previousTab = shellState.tabs.get(shellState.activeTabId);
    shellState.activeTabId = tabId;
    safeSetItem(shellConfig.storageKey, tabId);

    for (const [currentTabId, tabState] of shellState.tabs.entries()) {
        const isActive = currentTabId === tabId;
        tabState.panel.classList.toggle('sb-shell-panel-active', isActive);
        tabState.panel.setAttribute('aria-hidden', String(!isActive));
        // Invalidate search index when switching to a tab so stale DOM isn't searched
        if (isActive) tabState.searchIndex = null;
    }

    queueTopbarSectionStateSync();

    const activeTab = shellState.tabs.get(tabId);

    if (previousTab && previousTab.id !== activeTab.id) {
        previousTab.onDeactivate?.();
    }

    if (isSettingsPageHosting(shellKey)) {
        activeTab.onActivate?.();
        installSettingsSubpage(shellKey, tabId);
        flattenSettingsPanelDrawers(shellKey, tabId);
        dispatchShellTabActivated(shellKey, activeTab);
        queueMobileShellActivationRefresh();
    }
}

// SillyBunny: every shell lives in the full-screen settings page.
/** @param {string} shellKey @param {string|null} [tabId] */
function openShell(shellKey, tabId = null) {
    if (shellKey === 'left' && tabId === 'world-info') {
        // World Info lives in Characters, not in the Backend shell.
        openCharacterPanelTab('world-info');
        return;
    }

    if (shellKey === 'characters') {
        openCharacterPanelTab(tabId ?? SB_CHARACTER_PANEL_DEFAULT_TAB);
        return;
    }

    if (getShellConfig(shellKey)) {
        openSettingsPage(shellKey, tabId);
    }
}

function closeShell(shellKey) {
    if (isSettingsPageHosting(shellKey)) {
        closeSettingsPage();
    }
}

function buildShell(shellKey) {
    const shellConfig = getShellConfig(shellKey);
    const shellRoot = document.getElementById(shellConfig.rootPanelId);

    if (!(shellRoot instanceof HTMLElement) || shellRoot.dataset.sbShellReady === 'true') {
        return;
    }

    shellRoot.dataset.sbShellReady = 'true';
    shellRoot.dataset.sbShellKey = shellKey;
    shellRoot.classList.add('sb-shell-root', `sb-shell-root-${shellKey}`);

    if (shellKey === 'right') {
        shellRoot.classList.add('fillRight');
    }

    const originalContent = createElement('div', { className: 'sb-shell-column' });
    moveChildrenIntoContainer(shellRoot, originalContent);
    originalContent.querySelector('#settingsSearch')?.classList.add('sb-legacy-search-hidden');

    // The settings page supplies its own sidebar, title header, and close button, so the
    // in-shell header and horizontal tab rail are not built.
    const frame = createElement('div', { className: 'sb-shell-frame' });
    const main = createElement('div', { className: 'sb-shell-main' });
    const panelBody = createElement('div', { className: 'sb-shell-body' });

    main.append(panelBody);
    frame.append(main);
    shellRoot.appendChild(frame);

    const shellState = {
        activeTabId: migrateTabId(shellKey, shellConfig.storageKey ? safeGetItem(shellConfig.storageKey) : null) || shellConfig.defaultTabId,
        tabs: new Map(),
        root: shellRoot,
    };

    sbState.shells[shellKey] = shellState;

    const basePanel = createShellPanel(shellConfig.baseTab);

    // For left shell, base tab is 'connections' (sys-settings-button content)
    // For right shell, base tab is 'appearance' (user-settings-button content)
    // Each Customize tab owns a permanent container built once by
    // splitUserSettingsContent(). The block the settings were authored in is left in the document
    // for the sake of ids that are looked up globally, and nothing paints it.
    let userSettingsSplit = null;
    if (shellKey === 'left') {
        // SillyBunny: the base tab is the Connections panel, built by hand
        // rather than by the drawer passes or the subpage stack. The upstream drawer stays in the
        // document, detached from the layout, so every id authored inside it (`#main_api`,
        // `#rm_api_block`, and the connection-manager extension's own markup) is still resolvable
        // by the code that looks it up. The panel moves out only the nodes it presents: the profile
        // card and the five provider blocks.
        const apiDrawerPrep = prepareEmbeddedDrawer('sys-settings-button');
        if (apiDrawerPrep) {
            apiDrawerPrep.drawer.removeAttribute('style');
            apiDrawerPrep.drawer.classList.add('sb-legacy-api-drawer');
            shellRoot.appendChild(apiDrawerPrep.drawer);
        }

        const connectionsPanel = createConnectionsPanel({
            createElement,
            getActiveApi: getCurrentMainApiValue,
            applyPanelApiVisibility: changePanelApiVisibility,
        });
        basePanel.scroller.appendChild(connectionsPanel.column);
        basePanel.searchRoot = connectionsPanel.column;
        basePanel.onActivate = () => {
            connectionsPanel.onActivate();
            normalizeBackendSettingsRows(connectionsPanel.column, { fields: false });
        };
        basePanel.connectionsPanel = connectionsPanel;
    } else if (shellKey === 'right') {
        // The toggle row replaces the raw select before any settings pass can turn the select into a drop-down row.
        presentMarkdownEngineRow(originalContent);
        userSettingsSplit = splitUserSettingsContent(originalContent);

        if (userSettingsSplit) {
            // SillyBunny: the Appearance module loads when the page first needs it, so the upstream rows wait unseen until it has built its groups.
            userSettingsSplit.appearance.setAttribute('aria-busy', 'true');
            basePanel.scroller.appendChild(userSettingsSplit.appearance);
        }

        // The split empties the block, so what is left (the legacy header rows, the search input,
        // and the emptied columns) is parked on the shell root and hidden. Keeping it attached
        // rather than detaching it leaves `#user-settings-block-content` resolvable by id for
        // third-party drawers and for the drawer-state code that looks the emptied section up.
        originalContent.classList.add('sb-legacy-settings-remainder');
        shellRoot.appendChild(originalContent);
        watchStrayExtensionDrawers(
            document.getElementById('user-settings-block-content'),
            () => document.getElementById('extensions_settings2'),
        );

        // Backgrounds is its own top-level drawer outside the settings block, so it is appended
        // separately rather than being part of the split.
        const backgroundsPrep = prepareEmbeddedDrawer('backgrounds-button');
        if (backgroundsPrep) {
            basePanel.scroller.appendChild(backgroundsPrep.drawer);
        }

        basePanel.ensureReady = initializeSettingsPanel;
        basePanel.onActivate = () => initializeSettingsPanel().catch(error => {
            console.error('[SillyBunny] Could not initialize settings:', error);
            toastr.error(String(error.message || error));
        });
    }

    registerShellTab(shellKey, shellConfig.baseTab, basePanel);

    const registerEmbeddedTab = (embeddedTab) => {
        const prepared = prepareEmbeddedDrawer(embeddedTab.drawerId, originalContent);
        if (!prepared) {
            return;
        }

        const embeddedPanel = createShellPanel(embeddedTab);
        embeddedPanel.scroller.appendChild(prepared.drawer);
        registerShellTab(shellKey, embeddedTab, embeddedPanel, prepared.drawerContent);
    };

    // Register embedded tabs
    for (const embeddedTab of shellConfig.embeddedTabs) {
        registerEmbeddedTab(embeddedTab);
    }

    // Handle custom tabs
    for (const customTab of shellConfig.customTabs) {
        if (customTab.id === 'sampling') {
            const samplingPanel = createOnDemandShellPanel(shellKey, customTab, buildSamplingPanel);
            registerShellTab(shellKey, customTab, samplingPanel, samplingPanel.searchRoot);
            continue;
        }

        if (customTab.id === 'prompting') {
            // Prompting tab gets presets drawer content (the original left shell content)
            const promptingPanel = createShellPanel(customTab);
            if (shellKey === 'left') {
                preparePromptingPanel(originalContent);
                promptingPanel.scroller.appendChild(originalContent);
            }
            promptingPanel.ensureReady = ensureBackendPages;
            promptingPanel.onActivate = () => {
                updatePromptingPanel(promptingPanel.panel);
                void ensureBackendPages().catch(() => {});
                void getShellState('left')?.tabs.get('sampling')?.ensureReady?.().then(() => updatePromptingPanel(promptingPanel.panel));
            };
            $(document).on('change.sbPromptingPanel', '#main_api, #chat_completion_source, #textgen_type', () => {
                window.requestAnimationFrame(() => updatePromptingPanel(promptingPanel.panel));
            });
            registerShellTab(shellKey, customTab, promptingPanel, originalContent);
            continue;
        }

        if (shellKey === 'left' && customTab.id === 'editor') {
            // Build eagerly so template adoption never parks text bodies in an unmounted workspace.
            const editorPanel = buildEditorPanel();
            registerShellTab(shellKey, customTab, editorPanel, editorPanel.searchRoot);
            $(document).on('change.sbEditorPanel input.sbEditorPanel', '#settings_preset_openai, #sysprompt_select, #instruct_presets, #context_presets, #sysprompt_enabled', () => {
                window.requestAnimationFrame(() => updateEditorPanel(editorPanel.panel));
            });
            const systemBlock = document.getElementById('SystemPromptBlock');
            if (systemBlock instanceof HTMLElement) {
                new MutationObserver(() => updateEditorPanel(editorPanel.panel)).observe(systemBlock, { attributes: true, attributeFilter: ['class'] });
            }
            continue;
        }

        if (customTab.id === 'context') {
            // Context tab gets advanced formatting drawer content
            const formattingPrep = prepareEmbeddedDrawer('advanced-formatting-button');
            if (formattingPrep) {
                const contextPanel = createShellPanel(customTab);
                contextPanel.scroller.appendChild(formattingPrep.drawer);
                contextPanel.ensureReady = ensureBackendPages;
                contextPanel.onActivate = () => {
                    groupAdvancedFormattingIntoDrawers();
                    updateFormattingGroupVisibility(document.getElementById('AdvancedFormatting'));
                    void ensureBackendPages().catch(() => {});
                };
                registerShellTab(shellKey, customTab, contextPanel, formattingPrep.drawerContent);
            }
            continue;
        }

        if (customTab.id === 'agents') {
            const agentPanel = buildInChatAgentsPanel();
            registerShellTab(shellKey, customTab, agentPanel, agentPanel.searchRoot);
            continue;
        }

        if (customTab.id === 'messages') {
            // Messages owns a permanent container built once by splitUserSettingsContent().
            const panel = createShellPanel(customTab);
            if (userSettingsSplit) {
                panel.scroller.appendChild(userSettingsSplit.messages);
            }
            panel.ensureReady = initializeSettingsPanel;
            // Messages authors the animated thumbnails switch that the Background group in Appearance takes in, so direct entry loads the Appearance module too.
            panel.onActivate = basePanel.onActivate;
            registerShellTab(shellKey, customTab, panel);
            continue;
        }

        if (customTab.id === 'interface') {
            // Interface owns a permanent container built once by splitUserSettingsContent().
            const panel = createShellPanel(customTab);
            if (userSettingsSplit) {
                panel.scroller.appendChild(userSettingsSplit.interface);
            }
            panel.ensureReady = initializeSettingsPanel;
            // Interface shares the deferred controls authored by Appearance. Initialize them on
            // direct entry as well as through search, before the post-injection presentation pass.
            panel.onActivate = basePanel.onActivate;
            registerShellTab(shellKey, customTab, panel);
            continue;
        }

        if (customTab.id === 'data-security') {
            const serverPanel = createOnDemandShellPanel(shellKey, customTab, async () => {
                // SillyBunny: the page builds rows that the deferred editor shell sheet styles, so the sheet applies before the first frame.
                await Promise.all(SB_PANEL_STYLESHEETS['right:data-security'].map(stylesheet =>
                    window.SillyBunnyAssets?.loadStylesheetAsync?.(stylesheet.href, { id: stylesheet.id })))
                    .catch(error => console.warn('Failed to load panel stylesheet:', error));
                const loaded = await (await loadServerTools()).buildServerAdminPanel();
                const dataSecurityModule = await loadDataSecurityModule();

                // The split lifts Import & Restore out of the settings block because it manages saved
                // data rather than appearance. It leads the panel, ahead of the server cards, because
                // bringing an existing setup over is the first thing a user comes here to do.
                const dataSecurityContent = userSettingsSplit?.dataSecurity;
                if (dataSecurityContent instanceof HTMLElement) {
                    loaded.searchRoot?.prepend(dataSecurityContent);
                    // SillyBunny: settings loaded while this control was detached from the document.
                    const autoClearCache = dataSecurityContent.querySelector('#auto_clear_cache_on_update');
                    const powerUserSettings = getSillyTavernContext()?.powerUserSettings;
                    if (autoClearCache instanceof HTMLInputElement && powerUserSettings) {
                        autoClearCache.checked = Boolean(powerUserSettings.auto_clear_cache_on_update);
                    }
                    // The language list, the account buttons and the version text are filled by
                    // document-wide lookups that ran while this container was detached. They are
                    // filled again from this container now that it is attached.
                    addLanguagesToDropdown(dataSecurityContent);
                    syncUserControls(dataSecurityContent);
                    const versionDisplay = dataSecurityContent.querySelector('#version_display');
                    if (versionDisplay instanceof HTMLElement && !versionDisplay.textContent.trim()) {
                        versionDisplay.textContent = displayVersion;
                    }
                    // The container was detached while the settings panel initialized, so the work
                    // that normally runs there, opening the drawers and restoring their stored open
                    // state, could not reach it. It is done now that the tree is attached.
                    openAllInlineDrawers(dataSecurityContent);
                    bindInlineDrawerPersistence(dataSecurityContent);
                    // SillyBunny: this action was detached when the initial shell bindings ran.
                    bindClearCookiesAndCacheButton(dataSecurityContent);
                    // SillyBunny: the upstream rows move into boxed-list groups now that every fix-up has run on them.
                    dataSecurityModule.presentDataSecurity(dataSecurityContent);
                    injectSillyTavernImportCard(dataSecurityContent, dataSecurityModule);
                } else {
                    // Without the split there is no Data & Security container to adopt, so the card
                    // leads the server groups rather than going missing.
                    injectSillyTavernImportCard(loaded.searchRoot, dataSecurityModule);
                }

                return loaded;
            });
            registerShellTab(shellKey, customTab, serverPanel, serverPanel.searchRoot);
            continue;
        }

        if (customTab.id === 'logs') {
            const logsPanel = createOnDemandShellPanel(shellKey, customTab, async () => (await loadServerTools()).buildConsoleLogsPanel());
            registerShellTab(shellKey, customTab, logsPanel, logsPanel.searchRoot);
        }
    }

    panelBody.append(...Array.from(shellState.tabs.values()).map(tabState => tabState.panel));

    const storedTabId = migrateTabId(shellKey, migrateLegacyWorldInfoRoute(safeGetItem(shellConfig.storageKey)));
    const nextActiveTab = shellState.tabs.has(storedTabId) ? storedTabId : shellConfig.defaultTabId;
    setActiveTab(shellKey, nextActiveTab);
}

function registerShellTab(shellKey, tabConfig, panelBundle, explicitSearchRoot = null) {
    const shellState = getShellState(shellKey);

    if (!shellState) {
        return;
    }

    // The panel carries its page class for the stylesheet; an extension's own settings page sits in a panel and has the default class.
    applyPageWidth(panelBundle.panel, tabConfig);

    // Tab buttons live in the settings page sidebar; the shell only tracks panel state.
    shellState.tabs.set(tabConfig.id, {
        ...tabConfig,
        panel: panelBundle.panel,
        searchRoot: explicitSearchRoot ?? panelBundle.searchRoot ?? panelBundle.scroller,
        searchIndex: null,
        ensureReady: panelBundle.ensureReady,
        onActivate: panelBundle.onActivate ?? tabConfig.onActivate ?? null,
        onDeactivate: panelBundle.onDeactivate ?? tabConfig.onDeactivate ?? null,
    });
}

function routeDrawerTarget(targetId) {
    const route = SB_DRAWER_ROUTES[targetId];
    if (!route) {
        return false;
    }

    if (route.shell === 'characters') {
        openCharacterPanelTab(route.tab);
        return true;
    }

    preloadPanelStylesheets(route.shell, route.tab);
    openShell(route.shell, route.tab);
    return true;
}

function dispatchShellTabActivated(shellKey, tabState) {
    if (!tabState) {
        return;
    }

    document.dispatchEvent(new CustomEvent('sb:shell-tab-activated', {
        detail: {
            shellKey,
            tabId: tabState.id,
            label: tabState.label,
        },
    }));
}

function queueMobileShellActivationRefresh() {
    if (!isMobileViewport()) {
        return;
    }

    queueMobileViewportStateSync();
}

function getInlineDrawerAutoCloseId(drawer, index = 0) {
    if (!(drawer instanceof HTMLElement)) {
        return '';
    }

    const drawerId = String(drawer.id || '').trim();
    return drawerId ? `id:${drawerId}:index:${index}` : `index:${index}`;
}

function interceptDrawerOpeners() {
    document.addEventListener('click', event => {
        const opener = event.target instanceof Element ? event.target.closest('.drawer-opener') : null;
        const targetId = opener?.getAttribute('data-target');

        if (!targetId || !routeDrawerTarget(targetId)) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
    }, true);

    // Collapse sibling inline-drawers when one is opened, which prevents nested
    // dropdown clutter by keeping only one drawer open per container at a time.
    document.addEventListener('click', event => {
        if (!(event.target instanceof Element)) return;
        const toggle = event.target.closest('.inline-drawer-toggle');
        if (!toggle) return;
        if (!sbState.inlineDrawerAutoClose) return;

        const thisDrawer = toggle.closest('.inline-drawer');
        if (!thisDrawer) return;

        // Only collapse if this toggle is about to OPEN (icon currently points down = closed)
        const icon = thisDrawer.querySelector(':scope > .inline-drawer-header .inline-drawer-icon');
        const isCurrentlyClosed = icon?.classList.contains('fa-circle-chevron-down');
        if (!isCurrentlyClosed) return;

        // Find sibling inline-drawers in the same parent and close any that are open
        const parent = thisDrawer.parentElement;
        if (!parent) return;

        const siblingDrawers = Array.from(parent.children)
            .filter(element => element instanceof HTMLElement && element.classList.contains('inline-drawer'));
        const drawerById = new Map(siblingDrawers.map((drawer, index) => [getInlineDrawerAutoCloseId(drawer, index), drawer]));
        const openedDrawerId = getInlineDrawerAutoCloseId(thisDrawer, siblingDrawers.indexOf(thisDrawer));
        const openDrawerIds = siblingDrawers
            .map((drawer, index) => {
                const siblingIcon = drawer.querySelector(':scope > .inline-drawer-header .inline-drawer-icon');
                return siblingIcon?.classList.contains('fa-circle-chevron-up')
                    ? getInlineDrawerAutoCloseId(drawer, index)
                    : '';
            })
            .filter(Boolean);
        const autoClosePlan = sbMobileShellLifecycle.inlineDrawers.resolveAutoCloseSiblings({
            openedDrawerId,
            openDrawerIds,
            isMobileViewport: isMobileViewport(),
        });

        for (const closeId of autoClosePlan.closeIds) {
            const sibling = drawerById.get(closeId);
            if (!(sibling instanceof HTMLElement)) continue;

            const siblingIcon = sibling.querySelector(':scope > .inline-drawer-header .inline-drawer-icon');
            const siblingContent = sibling.querySelector(':scope > .inline-drawer-content');
            if (!siblingIcon?.classList.contains('fa-circle-chevron-up')) continue;

            // Close it, as ST's handler does
            siblingIcon.classList.replace('fa-circle-chevron-up', 'fa-circle-chevron-down');
            siblingIcon.classList.replace('up', 'down');
            if (window.jQuery && siblingContent) {
                window.jQuery(siblingContent).stop().slideUp();
            } else {
                siblingContent?.style.setProperty('display', 'none');
            }
        }
    }, true);
}

function bindInlineDrawerAutoCloseToggle() {
    const checkbox = document.getElementById('sb_auto_close_inline_drawers');
    if (!(checkbox instanceof HTMLInputElement)) {
        return;
    }

    checkbox.checked = sbState.inlineDrawerAutoClose;

    if (checkbox.dataset.sbBound === 'true') {
        return;
    }

    checkbox.addEventListener('change', () => {
        sbState.inlineDrawerAutoClose = checkbox.checked;
        safeSetItem(SB_STORAGE_KEYS.settingsDrawerAutoClose, String(sbState.inlineDrawerAutoClose));
    });

    checkbox.dataset.sbBound = 'true';
}

function bindWorldInfoRoute() {
    if (!window.jQuery) {
        return;
    }

    window.jQuery('#WIDrawerIcon, #WI-SP-button > .drawer-toggle')
        .off('click.sbShellRoute')
        .on('click.sbShellRoute', function (event) {
            event.preventDefault();
            event.stopImmediatePropagation();

            const characterPanel = getCharacterPanel();
            const worldInfoVisible = characterPanel instanceof HTMLElement
                && characterPanel.classList.contains('openDrawer')
                && characterPanel.dataset.menuType === 'world-info';

            if (worldInfoVisible) {
                closeCharacterPanel();
            } else {
                openCharacterPanelTab('world-info');
            }

            return false;
        });
}

function injectCharacterDrawerControls() {
    getCharacterPanel()?.classList.add('sb-character-drawer-root');
    bindCharacterDrawerEscapeHandler();
    bindCreatorNotesFullscreen();

    const modeToggle = document.getElementById('sb_character_mode_toggle');
    if (modeToggle instanceof HTMLElement && modeToggle.dataset.sbBound !== 'true') {
        // SillyBunny: the Characters panel has no mode toggle. This binding is a no-op guard so upstream code paths that call
        // injectCharacterDrawerControls don't error when the element is absent.
        modeToggle.dataset.sbBound = 'true';
    }

    if (document.documentElement.dataset.sbCharacterModeStateBound !== 'true') {
        document.documentElement.dataset.sbCharacterModeStateBound = 'true';
        window.addEventListener('sb:conversation-workspace-state-changed', syncCharacterModeToggle);
    }
    syncCharacterModeToggle();

    const charactersTab = document.getElementById('sb_character_tab_characters');
    if (charactersTab instanceof HTMLButtonElement && charactersTab.dataset.sbBound !== 'true') {
        charactersTab.dataset.sbBound = 'true';
        charactersTab.addEventListener('click', () => { void showCharacterListView(); });
    }

    const groupsTab = document.getElementById('sb_character_tab_groups');
    if (groupsTab instanceof HTMLButtonElement && groupsTab.dataset.sbBound !== 'true') {
        groupsTab.dataset.sbBound = 'true';
        groupsTab.addEventListener('click', () => { void showCharacterListView('groups'); });
    }

    const editorTab = document.getElementById('sb_character_tab_editor');
    if (editorTab instanceof HTMLButtonElement && editorTab.dataset.sbBound !== 'true') {
        editorTab.dataset.sbBound = 'true';
        editorTab.addEventListener('click', () => { void openCharacterEditorTab(); });
    }

    const personaTab = document.getElementById('sb_character_tab_persona');
    if (personaTab instanceof HTMLButtonElement && personaTab.dataset.sbBound !== 'true') {
        personaTab.dataset.sbBound = 'true';
        personaTab.addEventListener('click', () => openCharacterPersonaTab());
    }

    const worldInfoTab = document.getElementById('sb_character_tab_world_info');
    if (worldInfoTab instanceof HTMLButtonElement && worldInfoTab.dataset.sbBound !== 'true') {
        worldInfoTab.dataset.sbBound = 'true';
        worldInfoTab.addEventListener('click', () => openCharacterWorldInfoTab());
    }

    const importTab = document.getElementById('sb_character_tab_import');
    if (importTab instanceof HTMLButtonElement && importTab.dataset.sbBound !== 'true') {
        importTab.dataset.sbBound = 'true';
        importTab.addEventListener('click', () => openCharacterImportTab());
    }

    if (document.documentElement.dataset.sbCharacterImportPreserveBound !== 'true') {
        document.documentElement.dataset.sbCharacterImportPreserveBound = 'true';
        document.addEventListener('sillybunny:character-import-tab-preserve', () => {
            window.requestAnimationFrame(preserveCharacterImportTab);
        });
    }

    ensureCharacterPersonaPanel();
    ensureCharacterWorldInfoPanel();

    const target = document.getElementById('CharListButtonAndHotSwaps');
    if (!(target instanceof HTMLElement)) {
        return;
    }

    syncCharacterShellTabs();
}

function bindCharacterEditorExitButton() {
    const button = document.getElementById('sb_character_editor_exit');
    if (!(button instanceof HTMLButtonElement) || button.dataset.sbBound === 'true') {
        return;
    }

    button.dataset.sbBound = 'true';
    button.addEventListener('click', () => {
        closeCharacterPanel();
    });
}

function setInlineDrawerExpanded(drawer, expand) {
    if (!(drawer instanceof HTMLElement)) {
        return;
    }

    const icon = drawer.querySelector(':scope > .inline-drawer-header .inline-drawer-icon');
    const content = drawer.querySelector(':scope > .inline-drawer-content');

    if (!(icon instanceof HTMLElement) || !(content instanceof HTMLElement)) {
        return;
    }

    icon.classList.toggle('down', !expand);
    icon.classList.toggle('fa-circle-chevron-down', !expand);
    icon.classList.toggle('up', expand);
    icon.classList.toggle('fa-circle-chevron-up', expand);
    const display = expand ? 'block' : 'none';
    if (content.style.display !== display) content.style.display = display;
}

function getLegacySettingsDrawerStorageKey(drawer) {
    if (!(drawer instanceof HTMLElement)) {
        return null;
    }

    const root = getUserSettingsContentRoots().find(candidate => candidate.contains(drawer));
    if (!root) {
        return null;
    }

    if (drawer.id) {
        return `${SB_STORAGE_KEYS.settingsDrawerStatePrefix}:${drawer.id}`;
    }

    const drawers = Array.from(root.querySelectorAll('.inline-drawer'));
    const index = drawers.indexOf(drawer);
    return index === -1 ? null : `${SB_STORAGE_KEYS.settingsDrawerStatePrefix}:${index}`;
}

function sanitizeInlineDrawerStorageSegment(value, fallback = 'drawer') {
    const normalizedValue = normalizeText(value)
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64);

    return normalizedValue || fallback;
}

function getInlineDrawerHeaderText(drawer) {
    if (!(drawer instanceof HTMLElement)) {
        return '';
    }

    return drawer.querySelector(':scope > .inline-drawer-header b, :scope > .inline-drawer-header strong, :scope > .inline-drawer-header')
        ?.textContent
        ?? '';
}

function getInlineDrawerContextSegment(element) {
    if (!(element instanceof HTMLElement)) {
        return '';
    }

    const elementId = String(element.id || '').trim();
    if (elementId && !elementId.startsWith('select2-') && !/^ui-id-\d+$/i.test(elementId)) {
        return `id:${sanitizeInlineDrawerStorageSegment(elementId, 'scope')}`;
    }

    const worldEntryUid = element.classList.contains('world_entry')
        ? String(element.getAttribute('uid') || element.dataset.uid || '').trim()
        : '';
    if (worldEntryUid) {
        return `world-entry:${sanitizeInlineDrawerStorageSegment(worldEntryUid, 'entry')}`;
    }

    const promptIdentifier = String(element.dataset.pmIdentifier || '').trim();
    if (promptIdentifier) {
        return `prompt:${sanitizeInlineDrawerStorageSegment(promptIdentifier, 'prompt')}`;
    }

    if (element.classList.contains('extension_container')) {
        const extensionName = element.querySelector(':scope > .extension_name, .extension_name')?.textContent ?? '';
        if (extensionName) {
            return `extension:${sanitizeInlineDrawerStorageSegment(extensionName, 'extension')}`;
        }
    }

    return '';
}

function shouldPersistInlineDrawer(drawer) {
    return drawer instanceof HTMLElement
        && !drawer.matches(SB_INLINE_DRAWER_CUSTOM_PERSISTENCE_SELECTOR)
        && !drawer.closest('[data-sb-drawer-persistence="off"]');
}

function getInlineDrawerStorageKey(drawer) {
    if (!shouldPersistInlineDrawer(drawer)) {
        return null;
    }

    const contextSegments = [];
    for (let current = drawer.parentElement; current && current !== document.body; current = current.parentElement) {
        const segment = getInlineDrawerContextSegment(current);
        if (segment) {
            contextSegments.unshift(segment);
        }
    }

    if (!contextSegments.length) {
        return null;
    }

    const siblingInlineDrawers = drawer.parentElement
        ? Array.from(drawer.parentElement.children).filter(element => element instanceof HTMLElement && element.classList.contains('inline-drawer'))
        : [];
    const drawerIndex = Math.max(0, siblingInlineDrawers.indexOf(drawer));
    const drawerLabel = sanitizeInlineDrawerStorageSegment(getInlineDrawerHeaderText(drawer));

    return sbMobileShellLifecycle.inlineDrawers.derivePersistenceKey({
        drawerId: drawer.id ? sanitizeInlineDrawerStorageSegment(drawer.id) : '',
        context: {
            storagePrefix: SB_STORAGE_KEYS.settingsDrawerStatePrefix,
            contextSegments,
            drawerLabel,
            drawerIndex,
        },
    }) || null;
}

function getStoredInlineDrawerExpanded(drawer) {
    const storageKey = getInlineDrawerStorageKey(drawer);
    const storedValue = storageKey ? getPersistentStorageItem(storageKey) : null;

    if (storedValue !== null) {
        return normalizeStoredBoolean(storedValue, false);
    }

    const legacyStorageKey = getLegacySettingsDrawerStorageKey(drawer);
    if (!legacyStorageKey || legacyStorageKey === storageKey) {
        return null;
    }

    const legacyStoredValue = getPersistentStorageItem(legacyStorageKey);
    if (legacyStoredValue === null) {
        return null;
    }

    if (storageKey) {
        setPersistentStorageItem(storageKey, legacyStoredValue);
    }

    return normalizeStoredBoolean(legacyStoredValue, false);
}

function getInlineDrawers(root = document) {
    const drawers = [];

    if (root instanceof HTMLElement && root.classList.contains('inline-drawer')) {
        drawers.push(root);
    }

    if ('querySelectorAll' in root) {
        drawers.push(...root.querySelectorAll('.inline-drawer'));
    }

    return drawers;
}

function bindInlineDrawerPersistence(root = document) {
    for (const drawer of getInlineDrawers(root)) {
        if (!(drawer instanceof HTMLElement) || !shouldPersistInlineDrawer(drawer)) {
            continue;
        }

        const storedExpanded = getStoredInlineDrawerExpanded(drawer);
        if (storedExpanded !== null) {
            setInlineDrawerExpanded(drawer, storedExpanded);
        }

        if (drawer.dataset.sbDrawerPersistenceBound === 'true') {
            continue;
        }

        drawer.addEventListener('inline-drawer-toggle', () => {
            const icon = drawer.querySelector(':scope > .inline-drawer-header .inline-drawer-icon');
            const storageKey = getInlineDrawerStorageKey(drawer);
            if (!(icon instanceof HTMLElement) || !storageKey) {
                return;
            }

            setPersistentStorageItem(storageKey, String(icon.classList.contains('up')));
        });

        drawer.dataset.sbDrawerPersistenceBound = 'true';
    }
}

/**
 * Re-flattens drawers that a panel authored after its own activation pass had already run.
 *
 * The Prompt Manager rebuilds its header with `innerHTML` on every render, which brings back the
 * collapsible `#completion_prompt_manager_drawer` band each time, one refresh after the tab was
 * flattened. The persistence observer already watches these subtrees and is the only thing that
 * reliably fires afterwards, so the flatten rides along with the same debounce. It is idempotent,
 * and it skips any panel with no drawers left, so the common case is one query per panel.
 *
 * Only a visible panel is re-flattened: every activation already runs the full pass through
 * `flattenSettingsPanelDrawers`, so a hidden panel catches up when it is shown. Re-running it on
 * hidden panels would cost a full Prompting rebuild for unrelated mutations (closing search, hotkeys), and
 * the Prompting pass decides group visibility with `checkVisibility()`, which is false for every
 * control inside a hidden panel, so it would hide each group until the next activation re-showed it. Each
 * shell keeps its own active panel and the settings page can be closed, so the active class alone
 * does not mean the panel is on screen.
 */
function reflattenRuntimeDrawers() {
    for (const panel of document.querySelectorAll('section.sb-shell-panel.sb-shell-panel-active[data-sb-panel]')) {
        if (!(panel.checkVisibility?.() ?? panel.getClientRects().length > 0)) continue;
        const tabId = panel.dataset.sbPanel;
        if (tabId === 'prompting') {
            updatePromptingPanel(panel);
            continue;
        }
        if (tabId === 'editor' && panel.closest('[data-sb-shell-key="left"]')) {
            updateEditorPanel(panel);
            continue;
        }
        if (SB_COLLAPSIBLE_DRAWER_TAB_IDS.has(tabId) || isSubpagePanel(tabId) || isAppearancePending(tabId) || !panel.querySelector('.inline-drawer')) {
            continue;
        }
        flattenNestedSettingsDrawers(panel, { includeTopLevel: true });
        normalizeSettingsPresentation(panel, { name: tabId });
    }
}

function queueInlineDrawerPersistenceBind() {
    if (sbInlineDrawerPersistenceQueued) {
        return;
    }

    sbInlineDrawerPersistenceQueued = true;
    window.requestAnimationFrame(() => {
        sbInlineDrawerPersistenceQueued = false;
        bindInlineDrawerPersistence(document.body);
        reflattenRuntimeDrawers();
    });
}

function getInlineDrawerPersistenceRoots() {
    return [
        document.getElementById('left-nav-panel'),
        ...getUserSettingsContentRoots(),
        document.getElementById('WorldInfo'),
        getCharacterPanel(),
    ].filter(element => element instanceof HTMLElement);
}

function ensureInlineDrawerPersistenceObserver() {
    if (sbInlineDrawerPersistenceObserver) {
        return;
    }

    const roots = getInlineDrawerPersistenceRoots();
    if (!roots.length) {
        return;
    }

    sbInlineDrawerPersistenceObserver = new MutationObserver(mutations => {
        // Only newly authored drawers need binding/flattening, not token or autosave text updates.
        const addedDrawer = mutations.some(mutation => [...mutation.addedNodes].some(node => node instanceof Element
            && (node.matches('.inline-drawer') || node.querySelector('.inline-drawer'))));
        if (addedDrawer) queueInlineDrawerPersistenceBind();
    });
    for (const root of roots) {
        sbInlineDrawerPersistenceObserver.observe(root, { childList: true, subtree: true });
    }
}

function applyDefaultDrawerStates() {
    bindInlineDrawerPersistence(document.body);

    for (const drawerId of ['AppearanceSection', 'ChatCharactersSection']) {
        const drawer = document.getElementById(drawerId);
        if (drawer instanceof HTMLElement && getStoredInlineDrawerExpanded(drawer) === null) {
            setInlineDrawerExpanded(drawer, false);
        }
    }

    ensureInlineDrawerPersistenceObserver();
}

function syncMobileViewportState() {
    const viewportSyncStep = sbMobileShellLifecycle.viewportSync.step;
    const syncPlan = sbMobileShellLifecycle.viewportSync.resolveSyncPlan();
    const stepHandlers = {
        [viewportSyncStep.SYNC_SHELL_VIEWPORT_BOUNDS]: () => syncShellViewportBounds(),
        [viewportSyncStep.APPLY_TOPBAR_OFFSET]: () => applyTopbarOffset(),
        [viewportSyncStep.SYNC_CHATBAR_VISIBILITY_STATE]: () => syncChatbarVisibilityState(),
        [viewportSyncStep.UPDATE_TOP_BAR_BRAND]: () => updateTopBarBrand(),
        [viewportSyncStep.SCHEDULE_TOPBAR_CONTEXT_REFRESH]: () => scheduleTopbarContextRefresh(0),
        [viewportSyncStep.SYNC_MOBILE_MODAL_STATE]: () => syncMobileModalState(),
    };

    for (const step of syncPlan.steps) {
        const handler = stepHandlers[step];
        if (typeof handler !== 'function') {
            throw new Error(`Unknown mobile viewport sync step: ${step}`);
        }

        handler();
    }

    // SillyBunny: after viewport sizing settles, give iOS shell scrollers enough
    // bottom inset to move focused bottom fields above the keyboard without
    // locking the document and exposing a blank Safari background.
    syncIOSKeyboardBottomInset();
}

let sbMobileViewportStateFrameId = 0;

function queueMobileViewportStateSync() {
    if (sbMobileViewportStateFrameId) {
        return;
    }

    if (typeof window.requestAnimationFrame !== 'function') {
        syncMobileViewportState();
        return;
    }

    sbMobileViewportStateFrameId = window.requestAnimationFrame(() => {
        sbMobileViewportStateFrameId = 0;
        syncMobileViewportState();
    });
}

const sbMobileShellUiState = { initialized: false };

function initializeMobileShellUi() {
    if (sbMobileShellUiState.initialized) {
        return;
    }
    sbMobileShellUiState.initialized = true;

    document.documentElement.dataset.sbMobileUi = 'chat-bar';
    initializeMobileBottomBar();
    applyMobileShellUiState();

    window.matchMedia(BOTTOM_BAR_COMPACT_QUERY).addEventListener('change', applyMobileShellUiState);
}

function applyMobileShellUiState() {
    const isMobile = window.matchMedia(BOTTOM_BAR_COMPACT_QUERY).matches;
    document.documentElement.dataset.sbMobileUiMode = isMobile ? 'mobile' : 'desktop';
    syncMobileBottomBar(isMobile);
    const search = getUniversalSearchState();
    if (search.expanded) renderUniversalSearchResults(search.input?.value ?? '');
}

function reinitSelect2AfterShell() {
    const modelSelectors = [
        '#mancer_model',
        '#model_togetherai_select',
        '#ollama_model',
        '#tabby_model',
        '#llamacpp_model',
        '#model_infermaticai_select',
        '#model_dreamgen_select',
        '#openrouter_model',
        '#vllm_model',
        '#aphrodite_model',
    ];

    if (isMobileViewport()) {
        // On mobile, destroy Select2 (doesn't work on iOS Safari) and add native filter inputs
        for (const selector of modelSelectors) {
            const $el = $(selector);
            if ($el.length && $el.data('select2')) {
                try {
                    $el.select2('destroy');
                } catch {
                    // Ignore
                }
            }
            injectModelFilterInput($el);
        }
    } else {
        // On desktop, reinitialize Select2 after DOM reparenting
        // SillyBunny: the API controls live in the Connections panel, not in `#rm_api_block`; the
        // block is the fallback before the panel is built.
        const apiDropdownParent = $('.sb-connections-panel').length ? $('.sb-connections-panel') : $('#rm_api_block');
        const select2Defaults = {
            dropdownParent: apiDropdownParent.length ? apiDropdownParent : $(document.body),
            minimumResultsForSearch: 0,
        };
        const allSelectors = [...modelSelectors, '.openrouter_quantizations', '.openrouter_providers', '#nanogpt_allowed_providers', '#nanogpt_ignored_providers'];
        // SillyBunny: API pickers are initialised before the Connections
        // panel exists, so their stored `dropdownParent` is the emptied 1px `#rm_api_block`, which
        // clips every menu. The panel parent must win over the stored config, and pickers outside
        // this list (the openai.js model selects) need the same fix.
        const panelSelects = apiDropdownParent.length
            ? apiDropdownParent.find('select').filter((_, el) => {
                const parent = $(el).data('select2')?.options.get('dropdownParent')?.[0];
                return Boolean(parent) && parent !== apiDropdownParent[0];
            }).toArray()
            : [];
        const targets = new Set([...allSelectors.flatMap(selector => $(selector).toArray()), ...panelSelects]);
        for (const el of targets) {
            const $el = $(el);
            if ($el.data('select2')) {
                try {
                    const config = $el.data('select2').options.options;
                    $el.select2('destroy');
                    $el.select2({ ...select2Defaults, ...config, dropdownParent: select2Defaults.dropdownParent });
                } catch {
                    // Element may not have been initialized yet
                }
            }
        }
    }
}

function injectModelFilterInput($select) {
    if (!$select.length || $select[0].closest('.ds-select-row') || $select.prev('.sb-model-filter').length) {
        return;
    }

    const input = document.createElement('input');
    input.type = 'search';
    input.className = 'sb-model-filter text_pole';
    input.placeholder = 'Filter models…';

    // Store all options for filtering
    const allOptions = Array.from($select[0].options).map(opt => ({
        value: opt.value,
        text: opt.textContent,
        selected: opt.selected,
    }));

    input.addEventListener('input', () => {
        const query = input.value.toLowerCase().trim();
        const select = $select[0];
        const currentValue = select.value;

        // Rebuild options filtered by query
        select.innerHTML = '';
        for (const opt of allOptions) {
            if (!query || opt.text.toLowerCase().includes(query) || opt.value.toLowerCase().includes(query)) {
                const option = document.createElement('option');
                option.value = opt.value;
                option.textContent = opt.text;
                option.selected = opt.value === currentValue;
                select.appendChild(option);
            }
        }
    });

    $select.before(input);
}

function buildBottomChatBar() {
    const container = document.getElementById('sb-bottom-chat-bar');
    if (!(container instanceof HTMLElement)) {
        return;
    }

    container.replaceChildren();

    // Persona bubble
    const personaBubble = createElement('button', {
        id: 'sb-persona-bubble',
        attrs: { type: 'button', title: 'Switch Persona' },
    });
    personaBubble.addEventListener('click', (e) => {
        e.stopPropagation();
        togglePersonaPicker();
    });
    updatePersonaBubble(personaBubble);

    const chatSelect = createElement('select', {
        id: 'sb-bottom-chat-select',
        attrs: { title: 'Switch Chat' },
    });
    chatSelect.addEventListener('change', () => {
        void openChatById(chatSelect.value);
    });

    const collapseToggleBtn = createBottomChatButton({ icon: 'fa-chevron-up', title: 'Hide Chat Actions', className: 'sb-bottom-chat-collapse-toggle' }, () => {
        setBottomChatSecondaryOpen(!getBottomChatBarState().secondaryOpen);
    });
    collapseToggleBtn.setAttribute('aria-controls', 'sb-bottom-chat-secondary-row');
    collapseToggleBtn.setAttribute('aria-expanded', 'true');

    const search = createBottomChatSearchField();
    const searchToggleBtn = createBottomChatButton({ icon: 'fa-magnifying-glass', title: 'Search Chat', className: 'sb-bottom-chat-search-toggle' }, () => {
        const shouldOpen = !getBottomChatBarState().searchOpen;
        setBottomChatSearchOpen(shouldOpen, { focusInput: shouldOpen });
    });
    searchToggleBtn.setAttribute('aria-controls', 'sb-bottom-chat-search-field');
    const navCluster = createElement('div', { className: 'sb-bottom-chat-nav-actions' });
    const managementCluster = createElement('div', { className: 'sb-bottom-chat-management-actions' });
    const secondaryRow = createElement('div', {
        id: 'sb-bottom-chat-secondary-row',
        className: 'sb-bottom-chat-secondary-row',
        attrs: {
            'aria-label': 'Chat Actions',
        },
    });

    const topBtn = createBottomChatButton({ icon: 'fa-arrow-up', title: 'Go to Top of Chat' }, scrollCurrentChatToTop);
    const bottomBtn = createBottomChatButton({ icon: 'fa-arrow-down', title: 'Go to Bottom of Chat' }, scrollCurrentChatToBottom);
    const chatManagerBtn = createBottomChatButton({ icon: 'fa-address-book', title: 'View chat files' }, handleChatManagerClick);
    const newBtn = createBottomChatButton({ icon: 'fa-plus', title: 'New Chat' }, handleNewChat);
    const massDeleteBtn = createBottomChatButton({ icon: 'fa-list-check', title: 'Mass Delete Chats' }, () => { void handleMassDeleteChats(); });
    const autoNameBtn = createBottomChatButton({ icon: 'fa-wand-magic-sparkles', title: 'Ask the LLM to name this chat' }, () => { void handleAutoNameChat(); });
    const renameBtn = createBottomChatButton({ icon: 'fa-pencil', title: 'Rename Chat' }, () => { void handleRenameChat(); });
    const hideBtn = createBottomChatButton({ icon: 'fa-eye-slash', title: 'Hide Bottom Chat Bar' }, () => {
        setBottomChatBarVisible(false);
    });
    const deleteBtn = createBottomChatButton({ icon: 'fa-trash', title: 'Delete chat' }, () => { void handleDeleteChat(); });

    navCluster.append(topBtn, bottomBtn);
    managementCluster.append(chatManagerBtn, newBtn, massDeleteBtn, autoNameBtn, renameBtn, searchToggleBtn, hideBtn, deleteBtn);
    secondaryRow.append(managementCluster);
    const overflowBtn = createBottomChatButton({ icon: 'fa-ellipsis-vertical', title: getBottomChatOverflowLabel(), className: 'sb-bottom-chat-overflow' }, () => {});
    overflowBtn.hidden = true;
    overflowBtn.setAttribute('aria-haspopup', 'menu');
    // A click with no detail comes from the keyboard, which the menu needs to know to take focus.
    overflowBtn.addEventListener('click', event => openBottomChatOverflowMenu(overflowBtn, event.detail === 0));
    container.append(personaBubble, chatSelect, search.field, navCluster, collapseToggleBtn, secondaryRow, overflowBtn);

    // Store references for refresh and late context binding retries.
    Object.assign(getBottomChatBarState(), {
        chatSelect,
        personaBubble,
        searchField: search.field,
        searchInput: search.input,
        searchStatus: search.status,
        searchToggleButton: searchToggleBtn,
        collapseToggleButton: collapseToggleBtn,
        secondaryRow,
        scrollTopButton: topBtn,
        scrollBottomButton: bottomBtn,
        managerButton: chatManagerBtn,
        massDeleteButton: massDeleteBtn,
        autoNameButton: autoNameBtn,
        hideButton: hideBtn,
        overflowButton: overflowBtn,
    });
    observeBottomChatBarFit(container);
    syncBottomChatBarSecondaryState();
    syncBottomChatBarSearchState();
    setBottomChatBarVisible(sbState.bottomChatBar.visible, { persist: false });

    // Defer initial persona bubble update in case user_avatar isn't ready yet
    setTimeout(() => updatePersonaBubble(personaBubble), 100);

    // Close persona picker when clicking outside
    const bottomChatBarState = getBottomChatBarState();
    if (!bottomChatBarState.outsideClickBound) {
        document.addEventListener('click', (e) => {
            const picker = document.getElementById('sb-persona-picker');
            // Only a click of the user dismisses the menu: the app clicks the message box itself a moment after a chat loads.
            if (e.isTrusted && picker && !picker.contains(e.target) && e.target !== bottomChatBarState.personaBubble) {
                picker.remove();
            }
        });
        bottomChatBarState.outsideClickBound = true;
    }

    bindBottomChatBarEvents();
    scheduleBottomChatBarRefresh(0);
}

function getBottomChatOverflowLabel() {
    return t`Chat Actions`;
}

function getBottomChatFoldableButtons() {
    // DOM order is the order the hand learns, and the last button leaves first. The clusters are looked up in the whole
    // document because the phone layout moves them into the chat sheet.
    return [...document.querySelectorAll('.sb-bottom-chat-nav-actions > .sb-bottom-chat-btn, .sb-bottom-chat-management-actions > .sb-bottom-chat-btn')];
}

// SillyBunny: the bottom bar keeps one row (DESIGN.md, Header Bars and Toolbars). CSS shrinks the picker to its floor; this
// decides the next two steps from what overflows: first the search field folds into its icon, then the trailing buttons
// move into the overflow menu one at a time. Every pass starts from the unfolded form and ends within the same task, so a
// verdict never depends on the last one and a wider bar gets its controls back.
function fitBottomChatBar() {
    const bar = document.getElementById('sb-bottom-chat-bar');
    const overflow = getBottomChatBarState().overflowButton;
    if (!(bar instanceof HTMLElement) || !(overflow instanceof HTMLElement)) {
        return;
    }

    const buttons = getBottomChatFoldableButtons();
    let searchFolded = false;
    let keep = buttons.length;
    const apply = () => {
        bar.classList.toggle('sb-bottom-chat-search-folded', searchFolded);
        buttons.forEach((button, index) => {
            button.hidden = index >= keep;
        });
        overflow.hidden = keep >= buttons.length;
    };
    const overflows = () => bar.scrollWidth > bar.clientWidth;

    if (document.documentElement.dataset.sbMobileUiMode === 'mobile') {
        apply();
        return;
    }

    if (bar.clientWidth <= 0) {
        return;
    }

    apply();
    if (overflows()) {
        searchFolded = true;
        apply();
    }
    while (overflows() && keep > 0) {
        keep -= 1;
        apply();
    }
}

function observeBottomChatBarFit(bar) {
    const fitState = getBottomChatBarState();
    if (fitState.fitObserver) {
        return;
    }

    const schedule = () => {
        if (fitState.fitFrame) {
            return;
        }
        fitState.fitFrame = window.requestAnimationFrame(() => {
            fitState.fitFrame = 0;
            fitBottomChatBar();
        });
    };
    fitState.fitObserver = new ResizeObserver(schedule);
    fitState.fitObserver.observe(bar);
    new MutationObserver(schedule).observe(document.documentElement, { attributes: true, attributeFilter: ['data-sb-mobile-ui-mode', 'style'] });
    schedule();
}

function openBottomChatOverflowMenu(trigger, keyboard) {
    const items = getBottomChatFoldableButtons().filter(button => button.hidden).map(button => ({
        label: button.getAttribute('aria-label') || button.title,
        icon: button.querySelector('i')?.className ?? '',
        disabled: button.disabled || button.classList.contains('is-disabled'),
        danger: Boolean(button.querySelector('.fa-trash')),
        onSelect: () => button.click(),
    }));
    openActionMenu({ trigger, title: getBottomChatOverflowLabel(), keyboard, alignment: 'end', sections: [{ items }] });
}

function scheduleBottomChatBarRefresh(delay = 0) {
    window.clearTimeout(sbState.bottomChatBarRefreshTimer || 0);
    sbState.bottomChatBarRefreshTimer = window.setTimeout(() => {
        sbState.bottomChatBarRefreshTimer = 0;
        void refreshBottomChatSelect();
    }, delay);
}

// The entries are written only when they differ from what the picker holds, so a refresh that finds the same chats changes
// nothing in the page.
function writeBottomChatOptions(select, entries) {
    const unchanged = select.options.length === entries.length && entries.every((entry, index) => {
        const option = select.options[index];
        return option.value === entry.value && option.textContent === entry.label && option.selected === entry.selected;
    });
    if (unchanged) {
        return;
    }

    select.replaceChildren(...entries.map(entry => {
        const option = document.createElement('option');
        option.value = entry.value;
        option.textContent = entry.label;
        option.selected = entry.selected;
        return option;
    }));
}

async function refreshBottomChatSelect() {
    const chatSelect = sbState.bottomChatBar?.chatSelect;
    if (!(chatSelect instanceof HTMLSelectElement)) {
        return;
    }

    const chatContext = getChatUiContext();

    setButtonDisabled(sbState.bottomChatBar?.searchInput, !chatContext.hasChat);
    setButtonDisabled(sbState.bottomChatBar?.searchToggleButton, !chatContext.hasChat);
    setButtonDisabled(sbState.bottomChatBar?.scrollTopButton, !chatContext.hasChat);
    setButtonDisabled(sbState.bottomChatBar?.scrollBottomButton, !chatContext.hasChat);
    setButtonDisabled(sbState.bottomChatBar?.managerButton, !chatContext.canBrowseChats);
    setButtonDisabled(sbState.bottomChatBar?.massDeleteButton, !chatContext.canBrowseChats);
    setButtonDisabled(sbState.bottomChatBar?.autoNameButton, !chatContext.hasChat);

    if (!chatContext.context) {
        return;
    }

    const currentChatName = chatContext.chatId;
    const current = { value: '', label: describeChatName(currentChatName) || 'No chat selected', selected: true };

    // The picker shows the current chat at once, before its list arrives, unless it already shows it.
    const showsCurrentChat = [...chatSelect.selectedOptions].some(option => (currentChatName !== '' && option.value === currentChatName)
        || (option.value === '' && option.textContent === current.label));
    if (!chatContext.canBrowseChats || !showsCurrentChat) {
        writeBottomChatOptions(chatSelect, [current]);
    }

    if (!chatContext.canBrowseChats) {
        return;
    }

    try {
        const chats = await getChatFilesForContext(chatContext);
        const entries = chats.filter(chat => chat.fileName).map(chat => ({
            value: chat.fileName,
            label: formatChatSelectorLabel(chat.fileName, chat.tokenEstimate),
            selected: chat.fileName === currentChatName,
        }));

        if (!chats.some(chat => chat.fileName === currentChatName)) {
            entries.unshift(current);
        }

        writeBottomChatOptions(chatSelect, entries);

        if (chatContext.canBrowseChats && chats.length === 0) {
            const attempts = Number(sbState.bottomChatBarRefreshAttempts ?? 0);
            if (attempts < 30) {
                sbState.bottomChatBarRefreshAttempts = attempts + 1;
                scheduleBottomChatBarRefresh(200 + Math.random() * 50);
            }
        } else {
            sbState.bottomChatBarRefreshAttempts = 0;
        }
    } catch {
        const attempts = Number(sbState.bottomChatBarRefreshAttempts ?? 0);
        if (attempts < 30) {
            sbState.bottomChatBarRefreshAttempts = attempts + 1;
            scheduleBottomChatBarRefresh(250 + Math.random() * 50);
        }
    }
}

const PERSONA_APPENDICES_METADATA_KEY = 'persona_appendices';

function getPersonaAppendixScopeKeyFromContext(context) {
    return String(context?.groupId || context?.characters?.[context?.characterId]?.avatar || PERSONA_APPENDICES_DEFAULT_SCOPE_KEY);
}

function normalizePersonaAppendixSelectionsFromContext(context, avatarId) {
    const descriptor = context?.powerUserSettings?.persona_descriptions?.[avatarId];
    if (!descriptor || typeof descriptor !== 'object') {
        return {};
    }

    const source = descriptor[PERSONA_APPENDICES_SELECTIONS_KEY];
    const normalized = {};

    if (source && typeof source === 'object' && !Array.isArray(source)) {
        for (const [scopeKey, activeIds] of Object.entries(source)) {
            if (!Array.isArray(activeIds)) {
                continue;
            }

            const cleanScopeKey = String(scopeKey || PERSONA_APPENDICES_DEFAULT_SCOPE_KEY);
            normalized[cleanScopeKey] = activeIds
                .map(String)
                .filter((id, index, array) => id && array.indexOf(id) === index);
        }
    }

    descriptor[PERSONA_APPENDICES_SELECTIONS_KEY] = normalized;
    return normalized;
}

function getPersonaAppendicesFromContext(context, avatarId) {
    const descriptor = context?.powerUserSettings?.persona_descriptions?.[avatarId];
    const appendices = Array.isArray(descriptor?.appendices) ? descriptor.appendices : [];
    return appendices.map((appendix, index) => ({
        id: String(appendix?.id || `appendix-${index}`),
        name: String(appendix?.name || `Scenario Note ${index + 1}`),
        description: String(appendix?.description || ''),
    }));
}

function getActivePersonaAppendixIdsFromContext(context, avatarId) {
    const selections = normalizePersonaAppendixSelectionsFromContext(context, avatarId);
    const scopeKey = getPersonaAppendixScopeKeyFromContext(context);
    const metadata = context?.chatMetadata?.[PERSONA_APPENDICES_METADATA_KEY];
    const legacyActiveIds = Array.isArray(metadata?.[avatarId]) ? metadata[avatarId] : [];
    const activeIds = Object.prototype.hasOwnProperty.call(selections, scopeKey) ? selections[scopeKey] : legacyActiveIds;
    const availableIds = new Set(getPersonaAppendicesFromContext(context, avatarId).map(appendix => appendix.id));
    return activeIds.map(String).filter((id, index, array) => availableIds.has(id) && array.indexOf(id) === index);
}

function getActivePersonaAppendicesFromContext(context, avatarId) {
    const activeIds = new Set(getActivePersonaAppendixIdsFromContext(context, avatarId));
    return getPersonaAppendicesFromContext(context, avatarId).filter(appendix => activeIds.has(appendix.id));
}

function getPersonaDisplayNameWithAppendices(context, avatarId, name) {
    const appendices = getActivePersonaAppendicesFromContext(context, avatarId);
    if (!appendices.length) {
        return name;
    }

    return `${name} + ${appendices.map(appendix => appendix.name).join(' + ')}`;
}

function composePersonaDescriptionFromContext(context, avatarId, activeIds = null) {
    const descriptor = context?.powerUserSettings?.persona_descriptions?.[avatarId];
    const appendices = getPersonaAppendicesFromContext(context, avatarId);
    const activeIdSet = new Set(activeIds ?? getActivePersonaAppendixIdsFromContext(context, avatarId));
    const chunks = [];
    const baseDescription = String(descriptor?.description ?? '').trim();

    if (baseDescription) {
        chunks.push(baseDescription);
    }

    for (const appendix of appendices) {
        const description = String(appendix.description ?? '').trim();
        if (activeIdSet.has(appendix.id) && description) {
            // SillyBunny: match persona/Conversation note composition
            chunks.push(`(${appendix.name})\n${description}`);
        }
    }

    return chunks.join('\n\n');
}

function syncPersonaDescriptionFromContext(context, avatarId, activeIds = null) {
    if (!context?.powerUserSettings || !avatarId) {
        return;
    }

    const { currentAvatarId } = getCurrentPersonaSelection(context);
    if (currentAvatarId === avatarId) {
        context.powerUserSettings.persona_description = composePersonaDescriptionFromContext(context, avatarId, activeIds);
    }
}

function setActivePersonaAppendixIdsFromContext(context, avatarId, ids) {
    if (!context?.powerUserSettings?.persona_descriptions?.[avatarId] || !avatarId) {
        return;
    }

    const availableIds = new Set(getPersonaAppendicesFromContext(context, avatarId).map(appendix => appendix.id));
    const cleanIds = ids.map(String).filter((id, index, array) => availableIds.has(id) && array.indexOf(id) === index);
    const selections = normalizePersonaAppendixSelectionsFromContext(context, avatarId);
    selections[getPersonaAppendixScopeKeyFromContext(context)] = cleanIds;

    syncPersonaDescriptionFromContext(context, avatarId, cleanIds);
    saveSettingsDebounced();
    const eventTypes = context.eventTypes ?? context.event_types;
    if (context.eventSource && eventTypes?.PERSONA_UPDATED) {
        void context.eventSource.emit(eventTypes.PERSONA_UPDATED, avatarId);
    }
}

function updatePersonaBubble(bubble) {
    if (!(bubble instanceof HTMLElement)) {
        bubble = document.getElementById('sb-persona-bubble');
    }
    if (!bubble) {
        return;
    }

    const { context, currentAvatarId, currentName } = getCurrentPersonaSelection();
    const avatarUrl = currentAvatarId
        ? (context?.getThumbnailUrl?.('persona', currentAvatarId) || `/User Avatars/${currentAvatarId}`)
        : '';

    if (avatarUrl) {
        bubble.style.backgroundImage = `url("${avatarUrl}")`;
    } else {
        bubble.style.backgroundImage = 'none';
    }
    bubble.setAttribute('title', `Persona: ${getPersonaDisplayNameWithAppendices(context, currentAvatarId, currentName)}`);
}

function quoteSlashCommandArgument(value) {
    return `"${String(value ?? '').replace(/(["\\])/g, '\\$1')}"`;
}

function getCurrentPersonaSelection(context = getSillyTavernContext()) {
    const personas = context?.powerUserSettings?.personas ?? {};
    const currentAvatarId = String(context?.userAvatar ?? '').trim();
    const currentName = personas[currentAvatarId] || context?.name1 || 'You';

    return {
        context,
        personas,
        currentAvatarId,
        currentName,
    };
}

function getBottomChatBarState() {
    return sbState.bottomChatBar;
}

function setBottomChatBarVisible(shouldShow, { persist = true } = {}) {
    const nextVisible = Boolean(shouldShow);
    const bottomChatBarState = getBottomChatBarState();
    bottomChatBarState.visible = nextVisible;

    const container = document.getElementById('sb-bottom-chat-bar');
    if (container instanceof HTMLElement) {
        container.classList.toggle('displayNone', !nextVisible);
    }

    if (persist) {
        safeSetItem(SB_STORAGE_KEYS.bottomChatBarVisible, String(nextVisible));
    }

    for (const input of document.querySelectorAll('[data-sb-bottom-bar-visible-input]')) {
        if (input instanceof HTMLInputElement) {
            input.checked = nextVisible;
        }
    }

    const optionIcon = document.querySelector('#option_toggle_bottom_bar i');
    const optionSpan = document.querySelector('#option_toggle_bottom_bar span');
    if (optionIcon instanceof HTMLElement) {
        optionIcon.className = `fa-lg fa-solid ${nextVisible ? 'fa-eye-slash' : 'fa-eye'}`;
    }
    if (optionSpan instanceof HTMLElement) {
        optionSpan.textContent = nextVisible ? 'Hide Bottom Bar' : 'Show Bottom Bar';
        optionSpan.setAttribute('data-i18n', nextVisible ? 'Hide Bottom Bar' : 'Show Bottom Bar');
    }
}

function toggleBottomChatBarVisibility() {
    setBottomChatBarVisible(!getBottomChatBarState().visible);
}

function scheduleBottomChatBarBindingRetry(delay = 240) {
    const bottomChatBarState = getBottomChatBarState();

    window.clearTimeout(bottomChatBarState.bindingRetryTimer);
    bottomChatBarState.bindingRetryTimer = window.setTimeout(() => {
        bindBottomChatBarEvents();
    }, delay);
}

function bindBottomChatBarWindowEvents() {
    const bottomChatBarState = getBottomChatBarState();

    if (bottomChatBarState.windowBindingsAttached) {
        return;
    }

    // A resize changes the layout of the bar and not the chats it lists, so it does not load the list again.
    const syncWithWindow = () => {
        syncBottomChatBarSecondaryState();
        syncBottomChatBarSearchState();
        window.requestAnimationFrame(() => updatePersonaBubble(bottomChatBarState.personaBubble));
    };
    const refreshWithContext = () => {
        syncWithWindow();
        scheduleBottomChatBarRefresh(0);
        bindBottomChatBarEvents();
    };

    window.addEventListener('pageshow', refreshWithContext, { passive: true });
    window.addEventListener('focus', refreshWithContext, { passive: true });
    window.addEventListener('resize', syncWithWindow, { passive: true });
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
            refreshWithContext();
        }
    });

    bottomChatBarState.windowBindingsAttached = true;
}

function bindBottomChatBarEvents() {
    const bottomChatBarState = getBottomChatBarState();
    const personaBubble = bottomChatBarState.personaBubble;
    const context = getSillyTavernContext();
    const eventSource = context?.eventSource;
    const eventTypes = context?.eventTypes ?? context?.event_types;

    const toggleOption = document.getElementById('option_toggle_bottom_bar');
    if (toggleOption instanceof HTMLElement && !toggleOption.dataset.sbBound) {
        toggleOption.addEventListener('click', (event) => {
            event.preventDefault();
            toggleBottomChatBarVisibility();
        });
        toggleOption.dataset.sbBound = 'true';
    }

    bindBottomChatBarWindowEvents();

    if (!eventSource || !eventTypes) {
        scheduleBottomChatBarRefresh(0);
        window.requestAnimationFrame(() => updatePersonaBubble(personaBubble));
        scheduleBottomChatBarBindingRetry();
        return;
    }

    window.clearTimeout(bottomChatBarState.bindingRetryTimer);

    if (bottomChatBarState.boundEventSource === eventSource) {
        scheduleBottomChatBarRefresh(0);
        window.requestAnimationFrame(() => updatePersonaBubble(personaBubble));
        return;
    }

    const refresh = () => scheduleBottomChatBarRefresh(0);
    const refreshPersona = () => {
        window.requestAnimationFrame(() => {
            updatePersonaBubble(bottomChatBarState.personaBubble);
            refreshOpenPersonaPicker();
        });
    };
    const events = [
        eventTypes.APP_READY,
        eventTypes.CHAT_CHANGED,
        eventTypes.CHAT_LOADED,
        eventTypes.CHAT_CREATED,
        eventTypes.GROUP_CHAT_CREATED,
        eventTypes.CHAT_DELETED,
        eventTypes.GROUP_CHAT_DELETED,
        eventTypes.MESSAGE_RECEIVED,
        eventTypes.MESSAGE_UPDATED,
        eventTypes.MESSAGE_EDITED,
        eventTypes.MESSAGE_DELETED,
    ].filter(Boolean);
    const personaEvents = [
        eventTypes.PERSONA_CHANGED,
        eventTypes.PERSONA_UPDATED,
        eventTypes.APP_READY,
        eventTypes.CHAT_CHANGED,
        eventTypes.CHAT_LOADED,
        eventTypes.SETTINGS_UPDATED,
    ].filter(Boolean);

    for (const eventName of new Set(events)) {
        eventSource.on(eventName, refresh);
    }

    for (const eventName of new Set(personaEvents)) {
        eventSource.on(eventName, refreshPersona);
    }

    bottomChatBarState.boundEventSource = eventSource;
    scheduleBottomChatBarRefresh(0);
    refreshPersona();
}

function togglePersonaPicker() {
    const existing = document.getElementById('sb-persona-picker');
    if (existing) {
        existing.remove();
        document.getElementById('sb-persona-bubble')?.focus({ preventScroll: true });
        return;
    }

    openPersonaPicker();
}

function openPersonaPicker({ focus = true, place = null } = {}) {
    const context = getSillyTavernContext();
    if (!context) return;

    const { personas, currentAvatarId } = getCurrentPersonaSelection(context);
    const personaDescriptions = context?.powerUserSettings?.persona_descriptions ?? {};
    const picker = createElement('div', {
        id: 'sb-persona-picker',
        attrs: {
            role: 'dialog',
            'aria-label': 'Switch Persona',
        },
    });
    const optionsList = createElement('div', {
        className: 'sb-persona-options',
        attrs: {
            role: 'listbox',
            'aria-label': 'Choose Persona',
        },
    });
    picker.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            event.preventDefault();
            closePersonaPicker({ restoreFocus: true });
        }
    });

    const keys = Object.keys(personas).filter(avatarId => {
        const name = personas[avatarId];
        // Skip auto-created unnamed entries; always show the active persona
        const isActive = avatarId === currentAvatarId;
        return isActive || (name && name !== '[Unnamed Persona]');
    });

    if (!keys.length) {
        const empty = createElement('div', { className: 'sb-persona-option-empty' });
        // HUMAN: replace — a title in header capitalisation that names the state, and a description that says what to do next.
        empty.append(createStatusPage({ state: 'empty', icon: 'user', title: 'No Personas Defined', compact: true }).element);
        optionsList.appendChild(empty);
    } else {
        for (const avatarId of keys) {
            const name = personas[avatarId] || avatarId;
            const title = personaDescriptions[avatarId]?.title || '';
            const isActive = avatarId === currentAvatarId;
            addPersonaOption(optionsList, avatarId, name, title, isActive, context);
        }
    }

    picker.appendChild(optionsList);
    renderPersonaPickerAppendixControls(picker, context, currentAvatarId);

    const bubble = document.getElementById('sb-persona-bubble');
    if (bubble instanceof HTMLElement) {
        document.body.appendChild(picker);
        positionPersonaPicker(picker, bubble, place);
        // The picker's own key handlers sit on it; with the focus elsewhere (something moved it) Escape must still close it.
        const closeOnEscapeOutside = event => {
            if (!picker.isConnected) {
                document.removeEventListener('keydown', closeOnEscapeOutside, true);
                return;
            }
            if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented || picker.contains(/** @type {Node} */ (event.target))) return;
            event.preventDefault();
            event.stopPropagation();
            closePersonaPicker({ restoreFocus: true });
        };
        document.addEventListener('keydown', closeOnEscapeOutside, true);
        if (focus) {
            const activeOption = picker.querySelector('.sb-persona-option.is-active');
            const firstOption = picker.querySelector('.sb-persona-option');
            const firstControl = picker.querySelector('button, input');
            (activeOption ?? firstOption ?? firstControl)?.focus({ preventScroll: true });
        }
    }
}

function refreshOpenPersonaPicker() {
    const existing = document.getElementById('sb-persona-picker');
    if (!existing) {
        return;
    }

    // The new picker starts where the old one stood: placed like a new one, it is hidden at the corner until the next frame.
    // An old picker that is still hidden has not been placed, so there is nothing to keep.
    const place = existing.style.visibility === 'hidden' ? null : { left: existing.style.left, top: existing.style.top };
    existing.remove();
    openPersonaPicker({ focus: false, place });
}

function renderPersonaPickerAppendixControls(picker, context, avatarId) {
    if (!avatarId) {
        return;
    }

    const appendices = getPersonaAppendicesFromContext(context, avatarId);
    const personas = context?.powerUserSettings?.personas ?? {};
    const personaName = personas[avatarId] || avatarId;
    const activeIds = new Set(getActivePersonaAppendixIdsFromContext(context, avatarId));
    const section = createElement('section', {
        className: 'sb-persona-picker-appendices',
        attrs: { 'aria-label': `Scenario Notes for ${personaName}` },
    });
    const header = createElement('div', { className: 'sb-persona-picker-appendices-header' });
    const title = createElement('strong', { text: 'Use With Scenario Notes' });
    const manageButton = createElement('button', {
        className: 'sb-persona-picker-manage menu_button menu_button_icon',
        attrs: { type: 'button', title: 'Manage Scenario Notes' },
    });
    manageButton.innerHTML = '<i class="fa-solid fa-pen-to-square fa-fw" aria-hidden="true"></i><span>Manage</span>';
    manageButton.addEventListener('click', openPersonaAppendicesManager);
    header.append(title, manageButton);
    section.appendChild(header);

    if (!appendices.length) {
        const empty = createElement('p', { className: 'sb-persona-picker-appendices-empty sb-inline-hint', text: 'No Scenario Notes on this persona yet.' });
        section.appendChild(empty);
        picker.appendChild(section);
        return;
    }

    const controls = createElement('div', { className: 'sb-persona-picker-appendix-toggles' });
    for (const appendix of appendices) {
        const label = createElement('label', { className: 'sb-persona-picker-appendix-toggle' });
        const checkbox = createElement('input', {
            attrs: {
                type: 'checkbox',
                value: appendix.id,
            },
        });
        checkbox.checked = activeIds.has(appendix.id);
        checkbox.addEventListener('change', () => {
            const nextIds = getActivePersonaAppendixIdsFromContext(context, avatarId).filter(id => id !== appendix.id);
            if (checkbox.checked) {
                nextIds.push(appendix.id);
            }
            setActivePersonaAppendixIdsFromContext(context, avatarId, nextIds);
            updatePersonaBubble();
        });

        const labelText = createElement('span', { text: appendix.name });
        label.append(checkbox, labelText);
        controls.appendChild(label);
    }

    section.appendChild(controls);
    picker.appendChild(section);
}

async function openPersonaAppendicesManager() {
    const { currentAvatarId } = getCurrentPersonaSelection();
    closePersonaPicker();
    // SillyBunny: bridge Manage directly to the active persona's notes
    const { openPersonaEditor } = await import('./sillybunny-persona-editor.js');
    await openPersonaEditor({ avatarId: currentAvatarId, section: 'notes' });
}

/**
 * Places the picker above its bubble on the next frame, when its size is known. A new picker is hidden at the corner until
 * then; one that replaces a shown picker (`place`) keeps that picker's position and stays shown.
 * @param {HTMLElement} picker
 * @param {HTMLElement} bubble
 * @param {{ left: string, top: string } | null} [place]
 */
function positionPersonaPicker(picker, bubble, place = null) {
    const bubbleRect = bubble.getBoundingClientRect();
    if (!place) {
        picker.style.visibility = 'hidden';
    }
    picker.style.left = place?.left || '0px';
    picker.style.top = place?.top || '0px';
    picker.style.right = 'auto';
    picker.style.bottom = 'auto';

    requestAnimationFrame(() => {
        const pickerRect = picker.getBoundingClientRect();
        const viewportPadding = 8;
        const left = Math.min(
            Math.max(viewportPadding, bubbleRect.left),
            Math.max(viewportPadding, window.innerWidth - pickerRect.width - viewportPadding),
        );
        const top = Math.max(
            viewportPadding,
            bubbleRect.top - pickerRect.height - viewportPadding,
        );

        picker.style.left = `${Math.round(left)}px`;
        picker.style.top = `${Math.round(top)}px`;
        picker.style.visibility = '';
    });
}

function closePersonaPicker({ restoreFocus = false } = {}) {
    const picker = document.getElementById('sb-persona-picker');
    if (picker) {
        picker.remove();
    }

    if (restoreFocus) {
        document.getElementById('sb-persona-bubble')?.focus({ preventScroll: true });
    }
}

function focusPersonaOption(picker, offset) {
    const options = Array.from(picker.querySelectorAll('.sb-persona-option'));
    const currentIndex = options.indexOf(document.activeElement);
    const nextIndex = currentIndex === -1
        ? 0
        : (currentIndex + offset + options.length) % options.length;
    options[nextIndex]?.focus({ preventScroll: true });
}

async function selectPersonaOption(option, picker, avatarId, context) {
    picker.querySelectorAll('.sb-persona-option').forEach(element => {
        element.classList.toggle('is-active', element === option);
        element.setAttribute('aria-selected', String(element === option));
    });
    closePersonaPicker();
    const execSlash = context?.executeSlashCommandsWithOptions;
    let switched = false;
    if (typeof execSlash === 'function') {
        try {
            await execSlash(`/persona-set ${quoteSlashCommandArgument(avatarId)}`);
            switched = true;
        } catch (error) {
            console.warn('[SillyBunny] Persona switch via slash command failed, falling back to the persona API.', error);
        }
    }

    if (!switched) {
        const { usePersona } = await import('./personas.js');
        await usePersona(avatarId);
    }

    updatePersonaBubble();
    document.getElementById('sb-persona-bubble')?.focus({ preventScroll: true });
}

function addPersonaOption(picker, avatarId, name, title, isActive, context) {
    const option = createElement('button', {
        className: `sb-persona-option${isActive ? ' is-active' : ''}`,
        attrs: {
            type: 'button',
            role: 'option',
            'aria-selected': String(isActive),
        },
    });

    const img = createElement('img', {
        className: 'sb-persona-option-avatar',
        attrs: {
            src: `/User Avatars/${avatarId}`,
            alt: name,
            loading: 'lazy',
        },
    });
    img.addEventListener('error', () => { img.style.display = 'none'; });

    const label = createElement('span', { className: 'sb-persona-option-name' });
    label.textContent = name;
    const info = createElement('div', { className: 'sb-persona-option-info' });
    info.appendChild(label);

    if (title) {
        const desc = createElement('span', { className: 'sb-persona-option-description' });
        desc.textContent = title;
        info.appendChild(desc);
    }

    const activeAppendices = getActivePersonaAppendicesFromContext(context, avatarId);
    if (activeAppendices.length) {
        const chips = createElement('span', { className: 'sb-persona-option-appendices' });
        for (const appendix of activeAppendices) {
            chips.appendChild(createElement('span', { className: 'sb-persona-appendix-chip', text: `+ ${appendix.name}` }));
        }
        info.appendChild(chips);
    }

    option.append(img, info);

    option.addEventListener('click', () => { void selectPersonaOption(option, picker, avatarId, context); });
    option.addEventListener('keydown', event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
            event.preventDefault();
            focusPersonaOption(picker, 1);
        } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
            event.preventDefault();
            focusPersonaOption(picker, -1);
        } else if (event.key === 'Home') {
            event.preventDefault();
            picker.querySelector('.sb-persona-option')?.focus({ preventScroll: true });
        } else if (event.key === 'End') {
            event.preventDefault();
            Array.from(picker.querySelectorAll('.sb-persona-option')).at(-1)?.focus({ preventScroll: true });
        } else if (event.key === 'Escape') {
            event.preventDefault();
            closePersonaPicker({ restoreFocus: true });
        }
    });

    picker.appendChild(option);
}

/**
 * The upstream Options button (☰) is a bare `div`: it gets a button role, a name and a tooltip, and its sheet on a phone
 * takes the same name.
 */
function nameChatActionsButton() {
    const button = document.getElementById('options_button');
    if (!(button instanceof HTMLElement)) return;
    const label = t`Chat Actions`;
    if (!button.hasAttribute('role')) button.setAttribute('role', 'button');
    button.setAttribute('aria-label', label);
    button.title = label;
}

function initAll() {
    if (sbState.initialized) {
        return;
    }

    const leftShellRoot = document.getElementById(getShellConfig('left').rootPanelId);
    const rightShellRoot = document.getElementById(getShellConfig('right').rootPanelId);
    const topBarRoot = document.getElementById('top-bar');
    const bottomChatBarRoot = document.getElementById('sb-bottom-chat-bar');

    if (!(leftShellRoot instanceof HTMLElement)
        || !(rightShellRoot instanceof HTMLElement)
        || !(topBarRoot instanceof HTMLElement)
        || !(bottomChatBarRoot instanceof HTMLElement)) {
        if (!sbState.initObserver && document.body instanceof HTMLElement) {
            sbState.initObserver = new MutationObserver(() => {
                if (!sbState.initialized) {
                    initAll();
                }
            });
            sbState.initObserver.observe(document.body, { childList: true, subtree: true });
        }

        if (!sbState.initRetryTimer && sbState.initRetryCount < SB_INIT_MAX_RETRIES) {
            sbState.initRetryTimer = window.setTimeout(() => {
                sbState.initRetryTimer = 0;
                sbState.initRetryCount += 1;
                initAll();
            }, SB_INIT_RETRY_DELAY_MS);
        }
        return;
    }

    window.clearTimeout(sbState.initRetryTimer);
    sbState.initRetryTimer = 0;
    sbState.initRetryCount = 0;
    sbState.initObserver?.disconnect();
    sbState.initObserver = null;
    sbState.initialized = true;

    // Sizzle caches compiled selectors, not DOM results. Its default 50-entry cache thrashes across
    // the shell's many delegated input selectors, recompiling them for every keystroke.
    if (window.jQuery?.expr) window.jQuery.expr.cacheLength = Math.max(window.jQuery.expr.cacheLength, 512);

    restorePersistedTopbarState();
    migrateLegacyNavigationState();
    seedTopbarScaleDefaults();
    seedTopbarLabelParts();
    hideHostToggles();
    buildShell('left');
    buildShell('right');
    injectCharacterDrawerControls();
    bindCharacterEditorExitButton();
    bindCharacterDrawerStateObserver();
    prewarmSettingsPageRoots();
    applyShellTheme();
    setSurfaceTransparency(sbState.surfaceTransparency, { persist: false });
    setPaperTextureEnabled(sbState.paperTextureEnabled, { persist: false });
    setPaperTextureOpacity(sbState.paperTextureOpacity, { persist: false });
    setCompactMode(sbState.compactMode, { persist: false });
    setContentClamp(sbState.contentClamp, { persist: false });
    setBottomBarScale(sbState.bottomBarScale, { persist: false });
    setDesktopButtonScale(sbState.desktopButtonScale, { persist: false });
    setMobileButtonScale(sbState.mobileButtonScale, { persist: false });
    bindComposerControlPlacement();
    nameChatActionsButton();
    adoptComposerMenus();
    adoptLegacyPopup();
    initChatAvatarVariables();
    buildTopBar();
    // Must follow buildTopBar(): it rearranges the buttons that call creates.
    applyTopbarIconsOnlyPreference();
    initChatModeMemory();
    getSplashPreferences();
    initRetiredKeys({ eventSource, eventTypes: event_types, accountStorage, storage: window.localStorage });
    initBootMarks({ eventSource, eventTypes: event_types });
    bindHomeState();
    buildBottomChatBar();
    // SillyBunny: user input ends the ⬇ scroll-to-bottom ladder so a mid-ladder flick is not snapped back.
    getChatScrollElement()?.addEventListener('wheel', cancelPendingBottomChatScroll, { passive: true });
    getChatScrollElement()?.addEventListener('touchstart', cancelPendingBottomChatScroll, { passive: true });
    // Refresh again after the current JS task, because APP_READY may have already
    // fired before this listener was registered, so the initial call in
    // buildBottomChatBar() may have found no active chat yet.
    scheduleBottomChatBarRefresh(0);
    bindTopbarDragEvents();
    bindChatbarEvents();
    bindClearCookiesAndCacheButton();
    bindMessageActionExtensionEvents();
    syncMessageActionExtensionVisibility();
    scheduleChatbarRefresh(0);
    interceptDrawerOpeners();
    bindWorldInfoRoute();
    applyDefaultDrawerStates();
    // SillyBunny: settings page close button, mode toggle and keyboard shortcuts
    initSettingsPageClose();
    initModeToggle();
    initSettingsKeyboardShortcuts();
    // SillyBunny: character editor controller
    initCharacterEditor();
    bindInlineDrawerAutoCloseToggle();
    syncMobileViewportState();

    window.addEventListener('resize', queueMobileViewportStateSync, { passive: true });
    window.addEventListener('orientationchange', queueMobileViewportStateSync);
    window.visualViewport?.addEventListener('resize', queueMobileViewportStateSync, { passive: true });
    // SillyBunny: iOS can move visualViewport.offsetTop without resizing while the keyboard is open.
    window.visualViewport?.addEventListener('scroll', queueMobileViewportStateSync, { passive: true });

    // SillyBunny: keep focused inputs in mobile settings drawers above the
    // virtual keyboard. The fixed/clipped body blocks native scrolling, so the
    // real panel scroller is nudged manually after viewport changes.
    document.addEventListener('focusin', scheduleMobileFocusedInputScroll);
    document.addEventListener('focusout', scheduleMobileFocusedInputScroll);
    window.visualViewport?.addEventListener('resize', scheduleMobileFocusedInputScroll, { passive: true });
    window.visualViewport?.addEventListener('scroll', scheduleMobileFocusedInputScroll, { passive: true });

    // SillyBunny: popup dialogs sit outside the shell scrollers; shift them
    // above the virtual keyboard instead so the browser never pans the visual
    // viewport away from the top bar (see syncMobilePopupKeyboardShift).
    document.addEventListener('focusin', scheduleMobilePopupKeyboardSync);
    document.addEventListener('focusout', scheduleMobilePopupKeyboardSync);
    window.visualViewport?.addEventListener('resize', scheduleMobilePopupKeyboardSync, { passive: true });
    window.visualViewport?.addEventListener('scroll', scheduleMobilePopupKeyboardSync, { passive: true });

    // SillyBunny: keep iOS drawer scroller padding in sync with keyboard focus;
    // this provides scroll range for bottom inputs without fixing the document.
    if (isIOSWebKitPlatform()) {
        document.addEventListener('focusin', syncIOSKeyboardBottomInset);
        document.addEventListener('focusout', syncIOSKeyboardBottomInset);
        document.addEventListener('focusin', queueMobileViewportStateSync);
        document.addEventListener('focusout', queueMobileViewportStateSync);
    }

    if (isLegacyIOSWebKitPlatform()) {
        document.addEventListener('focusin', handleComposerKeyboardFocusIn);
        document.addEventListener('focusout', handleMobileKeyboardFocusOut);
    }

    // Reinitialize Select2 widgets after shell reparents DOM elements.
    // Select2 bindings break when elements are moved in the DOM.
    reinitSelect2AfterShell();

    // Group Advanced Formatting sections into collapsible drawers
    groupAdvancedFormattingIntoDrawers();

    initializeMobileShellUi();
    initializeMessageActions();
    initializeToastMotion({ translate });
    initializeColorPickers();
    initializePresetAutosave();

    const sillyBunnyShell = /** @type {any} */ (globalThis.SillyBunnyShell || {});
    globalThis.SillyBunnyShell = Object.assign(sillyBunnyShell, {
        openTab(shellKey, tabId) {
            if (shellKey === 'characters') {
                openCharacterPanelTab(tabId);
                // A named page is the page to show: on a phone the pane that is off screen is inert.
                if (tabId && isMobileViewport()) setSettingsMobileContentView(true);
                // SillyBunny: bridges await the atomic reveal, not just module mounting
                if (['persona', 'world-info', 'import'].includes(tabId)) {
                    return characterPanelRevealPromise;
                }
                if (tabId === 'characters' || tabId === 'groups') {
                    return characterListViewPromise;
                }
                return;
            }

            if (SB_SHELLS[shellKey]) {
                openShell(shellKey, tabId);
                // A named page is the page to show: the pane that is off screen on a phone is inert, so the page it names must not be in it.
                if (tabId && isMobileViewport() && sbSettingsState.open) setSettingsMobileContentView(true);
            }
        },
        openCharacters() {
            toggleCharacterPanel();
        },
        closeCharacters() {
            closeCharacterPanel();
        },
        /** Closes the Characters page after a chat is picked, as picking one from its list does, unless the user keeps it open. */
        closeCharactersAfterChatPick() {
            if (isCharactersPinStored() && !isMobileViewport()) return false;
            closeCharacterPanel();
            return true;
        },
        isMobileViewport,
        highlightCharacterEditorTab() {
            const editorTab = document.querySelector('[data-sb-character-tab="editor"]');
            if (editorTab instanceof HTMLElement) {
                flashHighlight($(editorTab), 1000);
            }
        },
        openGlobalSearch({ focusInput = true } = {}) {
            closeAllDropdowns({ except: 'search' });
            setUniversalSearchOpenState(true, { focusInput });
        },
        // Opens the menu and leaves it open; the toggle button itself would close a menu that is already open.
        openModeMenu() {
            if (!document.getElementById('sb-mode-menu')) {
                openModeDropdown();
            }
        },
        // Takes the user to a setting the way a search result does: opens the tab, shows the setting's category and pulses it.
        revealSetting(shellKey, tabId, selector) {
            const element = document.querySelector(selector);
            if (!(element instanceof HTMLElement)) {
                throw new Error(`Setting not found: ${selector}`);
            }
            revealSearchMatch(shellKey, { tabId, element });
        },
        applyTheme() {
            applyShellTheme();
        },
        setSurfaceTransparency(value) {
            setSurfaceTransparency(value);
        },
        // Kept as a no-op for extensions; the top bar scale has no control and is always 100.
        setTopbarScale() {},
        setMobileButtonScale(value) {
            setMobileButtonScale(value);
        },
        setDesktopButtonScale(value) {
            setDesktopButtonScale(value);
        },
        setCompactMode(value) {
            setCompactMode(value);
        },
        setTopbarIconsOnly(mode, value) {
            setTopbarIconsOnly(mode, value);
        },
        // Kept as a no-op for extensions; panels are not resizable drawers.
        setDesktopShellSnapToChatWidth() {},
        setMessageStyle,
        toggleChatSidebar() {
            toggleChatSidebar();
        },
        toggleChatbarVisibility() {
            toggleChatbarVisibility();
        },
        resetTopbarPosition() {
            setTopbarOffset({ x: 0, y: 0 });
        },
        getTheme() {
            return sbState.theme;
        },
        getSurfaceTransparency() {
            return sbState.surfaceTransparency;
        },
        getTopbarScale() {
            return SB_TOPBAR_SCALE.defaultValue;
        },
        getMobileButtonScale() {
            return sbState.mobileButtonScale;
        },
        getDesktopButtonScale() {
            return sbState.desktopButtonScale;
        },
        getCompactMode() {
            return sbState.compactMode;
        },
    });
}

// ── Settings page, mode pill and keyboard shortcuts ──────────────────────

const sbSettingsState = {
    open: false,
    activeShell: /** @type {string|null} */ (null),
    activeTabId: null,
    // Incremented each time a transition starts; guards stale callbacks after a
    // fast reopen or close.
    closeGen: 0,
    pageAnimation: null,
    closeTimer: 0,
    // Mobile only: tracks whether the content pane is visible (true) or the
    // sidebar is visible (false). Always false on desktop.
    mobileContentView: false,
};

function getSettingsPage() {
    return document.getElementById('sb-settings-page');
}

function clearSettingsAnimationState() {
    const page = getSettingsPage();
    if (page?.classList.contains('sb-settings-page--opening')) {
        page.classList.remove('sb-settings-page--opening');
    }
    if (sbSettingsState.pageAnimation) {
        sbSettingsState.pageAnimation.onfinish = null;
        sbSettingsState.pageAnimation.cancel();
        sbSettingsState.pageAnimation = null;
    }

    if (sbSettingsState.closeTimer) {
        clearTimeout(sbSettingsState.closeTimer);
        sbSettingsState.closeTimer = 0;
    }
}

function animateSettingsPage(page, direction, onFinish) {
    if (prefersReducedMotion() || typeof page.animate !== 'function') {
        onFinish();
        return;
    }

    const isOpening = direction === 'in';
    const animation = page.animate(
        [
            {
                opacity: isOpening ? 0 : 1,
                transform: isOpening ? 'scale(0.96)' : 'scale(1)',
            },
            {
                opacity: isOpening ? 1 : 0,
                transform: isOpening ? 'scale(1)' : 'scale(0.97)',
            },
        ],
        {
            duration: isOpening ? 250 : 200,
            easing: 'cubic-bezier(0.22, 0.61, 0.36, 1)',
            fill: 'forwards',
        },
    );

    sbSettingsState.pageAnimation = animation;
    animation.onfinish = () => {
        if (sbSettingsState.pageAnimation !== animation) {
            return;
        }
        sbSettingsState.pageAnimation = null;
        animation.cancel();
        onFinish();
    };
}

function getSettingsPageTabs(shellKey) {
    if (shellKey === 'characters') {
        return [...SB_CHARACTER_PANEL_TABS];
    }

    const shellConfig = getShellConfig(shellKey);
    return [
        shellConfig?.baseTab,
        ...(shellConfig?.embeddedTabs ?? []),
        ...(shellConfig?.customTabs ?? []),
    ].filter(Boolean);
}

function getSettingsPageRoot(shellKey) {
    if (shellKey === 'characters') {
        return getCharacterPanel();
    }

    const shellConfig = getShellConfig(shellKey);
    return shellConfig ? document.getElementById(shellConfig.rootPanelId) : null;
}

function isSettingsPageHosting(shellKey) {
    return sbSettingsState.open && sbSettingsState.activeShell === shellKey;
}

// The page swaps shell sections itself, so only the floating mobile surfaces (nav, chat
// tools, connection strip) are closed here; closing a shell surface would close the page.
function closeMobileSurfacesForSettingsPage(shellKey) {
    const surface = sbMobileShellLifecycle.overlays.surface;
    const shellSurfaces = new Set([surface.LEFT_SHELL, surface.RIGHT_SHELL, surface.CHARACTER_PANEL]);
    const decision = sbMobileShellLifecycle.overlays.resolveExclusiveOpen({
        surface: getMobileShellSurfaceForShell(shellKey),
        isMobileViewport: isMobileViewport(),
    });

    applyMobileSurfaceExclusivity({
        closeSurfaces: decision.closeSurfaces.filter(closeSurfaceKey => !shellSurfaces.has(closeSurfaceKey)),
    });
}

/** @param {string} shellKey @param {string|null} [tabId] */
function openSettingsPage(shellKey, tabId = null) {
    const page = getSettingsPage();
    if (!(page instanceof HTMLElement)) {
        return;
    }

    const tabs = getSettingsPageTabs(shellKey);
    const resolvedTab = tabs.find(tab => tab.id === tabId)?.id
        ?? (shellKey === 'characters' ? sbState.characterDrawer.lastTab : getShellState(shellKey)?.activeTabId)
        ?? getShellConfig(shellKey)?.defaultTabId
        ?? tabs[0]?.id
        ?? null;

    // Already showing this section: switch tabs in place instead of replaying the open.
    if (isSettingsPageHosting(shellKey)) {
        if (resolvedTab && resolvedTab !== sbSettingsState.activeTabId) {
            activateSettingsTab(shellKey, resolvedTab);
        }
        return;
    }

    closeMobileSurfacesForSettingsPage(shellKey);

    const wasOpen = sbSettingsState.open;
    const previousShell = sbSettingsState.activeShell;

    sbSettingsState.open = true;
    sbSettingsState.activeShell = shellKey;
    sbSettingsState.closeGen++;
    clearSettingsAnimationState();
    if (!wasOpen) page.classList.add('sb-settings-page--opening');

    if (previousShell && previousShell !== shellKey) {
        deactivateSettingsPageRoot(previousShell);
    }

    closeAllDropdowns({ except: shellKey, closeSurfaces: false });
    document.getElementById('sb-persona-picker')?.remove();
    document.getElementById('sb-mode-menu')?.remove();

    buildSettingsPageFor(shellKey, resolvedTab);
    mountShellRootInSettingsPage(shellKey, resolvedTab);
    syncSettingsPageActiveButton();

    page.classList.remove('sb-settings-page--content');
    sbSettingsState.mobileContentView = false;

    // On mobile, if opening with a saved tab (not explicitly requested), show content
    // immediately to restore the exact state the user left. If the section was explicitly
    // opened (tabId provided), show the sidebar first to let the user choose.
    if (isMobileViewport() && !tabId && resolvedTab) {
        page.classList.add('sb-settings-page--content');
        sbSettingsState.mobileContentView = true;
    }

    document.documentElement.dataset.sbSettingsOpen = 'true';

    if (wasOpen) {
        // Switching sections while open: no page-level animation, just swap content.
        page.hidden = false;
        syncSettingsPaneInert();
        return;
    }

    page.hidden = false;
    syncSettingsPaneInert();
    animateSettingsPage(page, 'in', () => page.classList.remove('sb-settings-page--opening'));

    // The pane that is off screen on a phone is inert and cannot take focus, so a restored page shows content and focuses Close.
    const entry = () => (isMobileViewport() && !sbSettingsState.mobileContentView
        ? document.querySelector('.sb-settings-tab[aria-selected="true"]') ?? document.querySelector('.sb-settings-tab')
        : document.getElementById('sb-settings-close'));
    entry()?.focus({ preventScroll: true });
    // WebKit can drop a focus() made in the frame that unhides its target, which leaves focus on the opener or on the body and
    // Escape unheard. One retry after the first frame lands it; a focus the user has since moved inside the page stays.
    if (!page.contains(document.activeElement)) {
        requestAnimationFrame(() => {
            const active = document.activeElement;
            if (!sbSettingsState.open || page.contains(active)) return;
            if (active === document.body || active?.closest('#top-bar')) entry()?.focus({ preventScroll: true });
        });
    }
}

function closeSettingsPage() {
    const page = getSettingsPage();
    if (!(page instanceof HTMLElement) || !sbSettingsState.open) {
        return;
    }

    sbSettingsState.open = false;
    sbSettingsState.mobileContentView = false;
    syncMobileModalState();
    const closingShell = sbSettingsState.activeShell;
    const restoreFocus = page.contains(document.activeElement);
    const openerId = SB_TOPBAR_SECTIONS.find(section => section.shellKey === closingShell)?.leadId;
    sbSettingsState.activeTabId = null;
    delete document.documentElement.dataset.sbSettingsOpen;

    const closeGen = ++sbSettingsState.closeGen;
    clearSettingsAnimationState();
    deactivateSettingsPageRoot(closingShell);

    const finishClose = () => {
        if (sbSettingsState.closeGen !== closeGen) {
            return;
        }
        page.hidden = true;
        syncSettingsPaneInert();
        if (sbSettingsState.closeTimer) {
            clearTimeout(sbSettingsState.closeTimer);
            sbSettingsState.closeTimer = 0;
        }
        sbSettingsState.activeShell = null;
        syncChatbarVisibilityState();
        requestMobileViewportReset();
        if (restoreFocus && (document.activeElement === document.body || page.contains(document.activeElement))) {
            document.getElementById(openerId)?.focus({ preventScroll: true });
        }
    };

    animateSettingsPage(page, 'out', finishClose);
    // Fallback for browsers that do not deliver a Web Animations finish event.
    sbSettingsState.closeTimer = setTimeout(finishClose, 300);

    syncSettingsPageActiveButton();
}

function toggleSettingsPage(shellKey, tabId = null) {
    if (isSettingsPageHosting(shellKey)) {
        // A different tab of the open section switches in place; the same section closes.
        if (tabId && tabId !== sbSettingsState.activeTabId) {
            activateSettingsTab(shellKey, tabId);
            return;
        }
        closeSettingsPage();
        return;
    }

    openSettingsPage(shellKey, tabId);
}

/**
 * Writes the page heading for a tab: the label as the title, the tab's long-form description as
 * the sub-title beneath it.
 *
 * The description may be authored as HTML (the sampling sub-title links to an external guide), so
 * it is written with `innerHTML` when flagged. Everything else goes through `textContent`, and a
 * tab with no description clears the sub-title rather than leaving the previous one behind.
 *
 * @param {{label?: string, description?: string, descriptionIsHtml?: boolean, descriptionI18n?: string}|null|undefined} tab
 */
function renderSettingsPageHeading(tab) {
    const titleEl = document.getElementById('sb-settings-content-title');
    const subtitleEl = document.getElementById('sb-settings-content-subtitle');
    if (titleEl) {
        titleEl.textContent = tab?.label ?? '';
    }
    if (!subtitleEl) {
        return;
    }
    const description = tab?.description ?? '';
    if (tab?.descriptionI18n) subtitleEl.setAttribute('data-i18n', tab.descriptionI18n);
    else subtitleEl.removeAttribute('data-i18n');
    if (tab?.descriptionIsHtml === true) {
        subtitleEl.innerHTML = description;
    } else {
        subtitleEl.textContent = description;
    }
}

function buildSettingsPageFor(shellKey, tabId) {
    const tabList = document.getElementById('sb-settings-tab-list');
    const titleEl = document.getElementById('sb-settings-content-title');
    if (!tabList || !titleEl) {
        return;
    }

    const allTabs = getSettingsPageTabs(shellKey);
    if (!allTabs.length) {
        return;
    }
    const sectionTitle = shellKey === 'characters' ? 'Characters' : getShellConfig(shellKey).title;

    const resolvedTabId = allTabs.find(t => t.id === tabId)?.id ?? allTabs[0]?.id ?? null;
    sbSettingsState.activeTabId = resolvedTabId;

    tabList.replaceChildren();

    for (const tab of allTabs) {
        const button = createElement('button', {
            className: 'sb-settings-tab',
            attrs: {
                type: 'button',
                role: 'tab',
                'aria-selected': String(tab.id === resolvedTabId),
                'data-sb-settings-tab': tab.id,
                // Short action-oriented hint; the tab's `description` is the page sub-title instead.
                title: tab.tooltip ?? '',
                'data-sb-search-aliases': (tab.searchAliases ?? []).join('|'),
            },
        });
        button.innerHTML = `<i class="fa-solid ${tab.icon}" aria-hidden="true"></i><span>${tab.label}</span>`;
        button.addEventListener('click', () => activateSettingsTab(shellKey, tab.id));
        tabList.appendChild(button);
    }

    const sidebarTitleEl = document.getElementById('sb-settings-sidebar-title');
    if (sidebarTitleEl) {
        sidebarTitleEl.textContent = sectionTitle;
    }
    const activeTab = allTabs.find(t => t.id === resolvedTabId);
    renderSettingsPageHeading(activeTab ?? { label: sectionTitle });

    // Re-apply an active sidebar filter to the freshly built tab list.
    const searchInput = document.getElementById('sb-settings-search-input');
    if (searchInput instanceof HTMLInputElement && searchInput.value.trim()) {
        void filterSettingsSidebarTabs(searchInput.value);
    }
}

// SillyTavern's keyboard.js MutationObserver rescans a node's whole subtree on every class
// write, even a redundant one. These roots are huge, so batch the change and skip no-ops.
function setRootClassState(element, classStates) {
    const next = new Set(element.classList);
    for (const [className, enabled] of Object.entries(classStates)) {
        if (enabled) {
            next.add(className);
        } else {
            next.delete(className);
        }
    }

    const nextClassName = Array.from(next).join(' ');
    if (nextClassName !== element.className) {
        element.className = nextClassName;
    }
}

function setRootAttribute(element, name, value) {
    if (element.getAttribute(name) !== value) {
        element.setAttribute(name, value);
    }
}

// Shell roots are moved into the page once and stay there; switching sections only
// toggles which one is active. Reparenting on every open would force a full style and layout
// pass over each panel, which would stall the first frames of the open animation.
/** @param {string} shellKey @param {string|null} [tabId] */
function mountShellRootInSettingsPage(shellKey, tabId = null) {
    const host = document.getElementById('sb-settings-shell-host');
    const root = getSettingsPageRoot(shellKey);
    if (!(host instanceof HTMLElement) || !(root instanceof HTMLElement)) {
        return;
    }

    if (root.parentElement !== host) {
        stopMotion(root);
        host.appendChild(root);
    }

    for (const child of host.children) {
        if (child !== root && child.classList.contains('sb-settings-active-root')) {
            child.classList.remove('sb-settings-active-root');
        }
    }

    const isCharacters = shellKey === 'characters';
    // The character panel's layout hangs off `#right-nav-panel.openDrawer`; pinnedOpen keeps
    // SillyTavern's outside-click auto-close from collapsing it while it lives in the page.
    setRootClassState(root, {
        'sb-settings-mounted-shell': true,
        'sb-settings-active-root': true,
        closedDrawer: false,
        openDrawer: isCharacters,
        pinnedOpen: isCharacters,
    });
    setRootAttribute(root, 'aria-hidden', 'false');

    if (isCharacters) {
        injectCharacterDrawerControls();
        activateCharacterPanelTabInPlace(tabId ?? SB_CHARACTER_PANEL_DEFAULT_TAB);
        syncChatbarVisibilityState();
        return;
    }

    const shellState = getShellState(shellKey);
    if (!shellState) {
        return;
    }

    const targetTab = tabId ?? shellState.activeTabId ?? getShellConfig(shellKey).defaultTabId;
    if (targetTab && targetTab !== shellState.activeTabId && shellState.tabs.has(targetTab)) {
        // setActiveTab runs the activation hooks itself while the page hosts this shell.
        setActiveTab(shellKey, targetTab);
        return;
    }

    const activeTab = shellState.tabs.get(shellState.activeTabId);
    activeTab?.onActivate?.();
    // The flatten is part of activation, so the already-active tab has to run it too. Otherwise
    // the base tab, which is active before the page is ever mounted, is the one panel that never
    // gets flattened.
    flattenSettingsPanelDrawers(shellKey, shellState.activeTabId);
    // SillyBunny: the stacked panels have their store wrapper and their stack built from the same
    // activation pass, and this path bypasses `setActiveTab` for the tab that is already active.
    // That tab is the base tab, every time the page is first mounted. Without this the first paint of
    // an Extensions panel is the raw legacy drawer: the wrapper that hides its children
    // does not exist yet, so all of its sections render at once.
    installSettingsSubpage(shellKey, shellState.activeTabId);
    dispatchShellTabActivated(shellKey, activeTab);
    queueMobileShellActivationRefresh();
}

// Roots move into the settings host at startup so SillyTavern's native drawer toggles can
// never reopen them as floating drawers in their original holders.
function prewarmSettingsPageRoots() {
    const host = document.getElementById('sb-settings-shell-host');
    if (!(host instanceof HTMLElement)) {
        return;
    }

    for (const shellKey of ['left', 'right', 'characters']) {
        const root = getSettingsPageRoot(shellKey);
        if (!(root instanceof HTMLElement) || root.parentElement === host) {
            continue;
        }

        host.appendChild(root);
        setRootClassState(root, {
            'sb-settings-mounted-shell': true,
            'sb-settings-active-root': false,
            openDrawer: false,
            closedDrawer: false,
            pinnedOpen: false,
        });
        setRootAttribute(root, 'aria-hidden', 'true');
    }
}

function deactivateSettingsPageRoot(shellKey) {
    const root = getSettingsPageRoot(shellKey);
    if (!(root instanceof HTMLElement)) {
        return;
    }

    if (document.activeElement instanceof HTMLElement && root.contains(document.activeElement)) {
        document.activeElement.blur();
    }

    if (shellKey !== 'characters') {
        const shellState = getShellState(shellKey);
        shellState?.tabs.get(shellState.activeTabId)?.onDeactivate?.();
    } else {
        setCharacterPersonaPanelVisible(false);
        setCharacterImportPanelVisible(false);
        // SillyBunny: upstream WI probes require layout in the closed page; aria-hidden still suspends adapter work
        setCharacterWorldInfoPanelVisible(false, { preserveLayout: true });
    }

    setRootClassState(root, {
        'sb-settings-active-root': false,
        openDrawer: false,
        pinnedOpen: false,
    });
    setRootAttribute(root, 'aria-hidden', 'true');
}

let settingsPaneInertBound = false;

// SillyBunny: a phone shows the sidebar or the page and slides the other one out of a clipped box. The pane that is not showing is
// inert, so Tab, the pointer and a screen reader's cursor all stay in the one that is; a control focused in the clipped pane
// would scroll the box sideways and crop the pane that is showing.
function syncSettingsPaneInert() {
    const page = getSettingsPage();
    const split = page instanceof HTMLElement && !page.hidden && isMobileViewport();
    const showContent = split && page.classList.contains('sb-settings-page--content');
    const sidebar = document.getElementById('sb-settings-sidebar');
    const content = document.getElementById('sb-settings-content');
    if (sidebar) sidebar.inert = showContent;
    if (content) content.inert = split && !showContent;
    syncMobileModalState();
}

function setSettingsMobileContentView(showContent) {
    const page = getSettingsPage();
    if (!(page instanceof HTMLElement)) {
        return;
    }
    sbSettingsState.mobileContentView = showContent;
    page.classList.toggle('sb-settings-page--content', showContent);
    syncSettingsPaneInert();

    if (showContent) {
        document.getElementById('sb-settings-close')?.focus({ preventScroll: true });
    } else {
        // Return focus to the active sidebar tab when going back.
        const activeTab = document.querySelector('.sb-settings-tab[aria-selected="true"]');
        activeTab?.focus({ preventScroll: true });
    }
}

function activateSettingsTab(shellKey, tabId) {
    const tabList = document.getElementById('sb-settings-tab-list');
    if (!tabList) {
        return;
    }

    const allTabs = getSettingsPageTabs(shellKey);
    const selectedTab = allTabs.find(tab => tab.id === tabId);
    if (!selectedTab) {
        return;
    }

    sbSettingsState.activeTabId = tabId;

    if (shellKey === 'characters') {
        activateCharacterPanelTabInPlace(tabId);
    } else {
        setActiveTab(shellKey, tabId);
    }

    tabList.querySelectorAll('.sb-settings-tab').forEach(button => {
        button.setAttribute('aria-selected', String(button.dataset.sbSettingsTab === tabId));
    });

    renderSettingsPageHeading(selectedTab);

    if (isMobileViewport()) {
        setSettingsMobileContentView(true);
    }

    // A search that is still typed filters the page that has just opened.
    void settingsSidebarSearch?.activate(tabId);
}

function syncSettingsPageActiveButton() {
    for (const section of SB_TOPBAR_SECTIONS) {
        const leadButton = document.getElementById(section.leadId);
        if (!(leadButton instanceof HTMLElement)) {
            continue;
        }

        const isActive = sbSettingsState.open && sbSettingsState.activeShell === section.shellKey;
        leadButton.classList.toggle('sb-settings-active', isActive);
        if (section.key === 'characters') {
            leadButton.classList.remove('is-open', 'is-pinned', 'is-current');
            leadButton.setAttribute('aria-expanded', String(isActive));
            if (isActive) leadButton.setAttribute('aria-current', 'page');
            else leadButton.removeAttribute('aria-current');
        }
    }

    syncHomeButtonState();
}

function setSettingsSidebarSearchOpen(isOpen, { focusInput = false } = {}) {
    const toggleBtn = document.getElementById('sb-settings-search-toggle');
    const searchRow = document.getElementById('sb-settings-search-row');
    const searchInput = document.getElementById('sb-settings-search-input');
    if (!(toggleBtn instanceof HTMLElement) || !(searchRow instanceof HTMLElement)) {
        return;
    }

    toggleBtn.setAttribute('aria-expanded', String(isOpen));
    searchRow.classList.toggle('is-expanded', isOpen);
    searchRow.setAttribute('aria-hidden', String(!isOpen));

    if (isOpen) {
        // The module is loaded by the time a letter is typed, so the page list answers at once.
        void loadSettingsSearchModule().catch(() => {});
    }

    if (isOpen && focusInput && searchInput instanceof HTMLElement) {
        // Defer slightly so the max-height transition has started before focus shifts.
        setTimeout(() => searchInput.focus(), 50);
    } else if (!isOpen && searchInput instanceof HTMLInputElement) {
        searchInput.value = '';
        void filterSettingsSidebarTabs('');
    }
}

function initSettingsPageClose() {
    const closeButton = document.getElementById('sb-settings-close');
    if (closeButton instanceof HTMLButtonElement && closeButton.dataset.sbBound !== 'true') {
        closeButton.dataset.sbBound = 'true';
        closeButton.addEventListener('click', closeSettingsPage);
    }

    const sidebarCloseButton = document.getElementById('sb-settings-sidebar-close');
    if (sidebarCloseButton instanceof HTMLButtonElement && sidebarCloseButton.dataset.sbBound !== 'true') {
        sidebarCloseButton.dataset.sbBound = 'true';
        sidebarCloseButton.addEventListener('click', closeSettingsPage);
    }

    // Back button: mobile only. It returns from content view to sidebar view.
    const backButton = document.getElementById('sb-settings-back');
    if (backButton instanceof HTMLButtonElement && backButton.dataset.sbBound !== 'true') {
        backButton.dataset.sbBound = 'true';
        backButton.addEventListener('click', () => {
            setSettingsMobileContentView(false);
        });
    }

    if (!settingsPaneInertBound) {
        settingsPaneInertBound = true;
        window.matchMedia(SB_MOBILE_MEDIA_QUERY).addEventListener('change', syncSettingsPaneInert);
    }

    const page = getSettingsPage();
    if (page instanceof HTMLElement && page.dataset.sbBound !== 'true') {
        page.dataset.sbBound = 'true';
        page.addEventListener('keydown', event => {
            if (event.key === 'Escape') {
                closeSettingsPage();
            }
        });
        // The page's keydown handler only hears keys from inside it. Focus can still sit on the top-bar toggle that opened the
        // page (an engine that refused the focus move), and Escape there must close the page as well.
        document.addEventListener('keydown', event => {
            if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || !sbSettingsState.open) return;
            const target = event.target instanceof Element ? event.target : null;
            if (target && SB_TOPBAR_SECTIONS.some(section => target.id === section.leadId)) {
                closeSettingsPage();
            }
        });
    }

    // A tab loads its page (and on a phone slides the sidebar away), so the arrow keys only move focus and Enter or Space selects.
    const settingsTabList = document.getElementById('sb-settings-tab-list');
    if (settingsTabList instanceof HTMLElement && settingsTabList.dataset.sbRovingBound !== 'true') {
        settingsTabList.dataset.sbRovingBound = 'true';
        bindRovingFocus(settingsTabList, {
            itemSelector: '.sb-settings-tab',
            orientation: 'vertical',
            isSelected: tab => tab.getAttribute('aria-selected') === 'true',
        });
    }

    // Sidebar search toggle button expands/collapses the search row.
    const searchToggleBtn = document.getElementById('sb-settings-search-toggle');
    if (searchToggleBtn instanceof HTMLButtonElement && searchToggleBtn.dataset.sbBound !== 'true') {
        searchToggleBtn.dataset.sbBound = 'true';
        searchToggleBtn.addEventListener('click', () => {
            const isExpanded = searchToggleBtn.getAttribute('aria-expanded') === 'true';
            setSettingsSidebarSearchOpen(!isExpanded, { focusInput: !isExpanded });
        });
    }

    // Sidebar search: narrow the tab list to pages whose name or contents match.
    const searchInput = document.getElementById('sb-settings-search-input');
    if (searchInput instanceof HTMLInputElement && searchInput.dataset.sbBound !== 'true') {
        searchInput.dataset.sbBound = 'true';
        // Escape clears the query before it can close the page; the clear button and Escape both send `input`.
        createSearchEntry({ input: searchInput, variant: 'bar', clearLabel: t`Clear Entry` });
        searchInput.addEventListener('input', () => void filterSettingsSidebarTabs(searchInput.value));
        searchInput.addEventListener('keydown', event => {
            if (event.key === 'Enter') {
                event.preventDefault();
                const firstMatch = document.querySelector('.sb-settings-tab:not(.sb-settings-tab--filtered)');
                firstMatch?.click();
            }
        });
    }
}

let sbSettingsSidebarFilterRequest = 0;
let settingsSidebarSearch = null;

// SillyBunny: the sidebar search loads on first use, so it adds nothing to startup. It does the matching, the page counts,
// the row filter and the text marks; the shell only says what a page is made of and how to reveal a place in it.
const loadSettingsSearchModule = createDeferredModule(new URL('./sillybunny-settings-search.js', import.meta.url));

// Pages that are not made of groups of rows: the prompt editor is a workspace, and the other two answer by what they list.
const SB_SEARCH_NO_ROW_TABS = Object.freeze(new Set(['editor', 'agents', 'extensions']));
// Of those, the ones whose entries still count as hits. The prompt editor's content is not searched.
const SB_SEARCH_ENTRY_TABS = Object.freeze(new Set(['agents', 'extensions']));

function getSettingsSearchRoots(tabId) {
    const shellKey = sbSettingsState.activeShell;
    if (shellKey === 'characters') {
        if (tabId === 'editor') {
            const editors = ['rm_ch_create_block', 'rm_group_chats_block'].map(id => document.getElementById(id)).filter(Boolean);
            const active = editors.filter(editor => editor.classList.contains('sb-active-right-menu'));
            return active.length ? active : editors;
        }
        const hostId = { 'world-info': 'sb_character_world_info_panel', persona: 'sb_character_persona_panel', import: 'sb_character_import_panel' }[tabId];
        const host = hostId ? document.getElementById(hostId) : null;
        // The two lists are entities with their own filters.
        return host instanceof HTMLElement ? [host] : [];
    }

    if (SB_SEARCH_NO_ROW_TABS.has(tabId)) {
        return null;
    }
    const root = getShellState(shellKey)?.tabs.get(tabId)?.searchRoot;
    return root instanceof HTMLElement ? [root] : null;
}

function getSettingsSearchContentMatches(rawQuery) {
    const shellKey = sbSettingsState.activeShell;
    const matches = [];
    for (const match of collectGlobalSearchMatches(rawQuery, { limit: Infinity })) {
        const matchShell = match.shellKey === 'left' && match.tabId === 'world-info' ? 'characters' : match.shellKey;
        if (matchShell !== shellKey || !match.tabId) continue;
        // A page's own name and aliases are matched by the sidebar itself.
        if (match.headingMatch === true && /::page$|^characters::/.test(match.dedupeKey ?? '')) continue;
        const isEntity = match.element === null || match.element === undefined;
        if (shellKey === 'characters' ? !isEntity : !SB_SEARCH_ENTRY_TABS.has(match.tabId)) continue;
        matches.push({ tabId: match.tabId, key: match.dedupeKey || `${match.tabId}::${match.displayText}`, searchText: match.searchText });
    }
    return matches;
}

async function whenSettingsTabReady(tabId) {
    const shellKey = sbSettingsState.activeShell;
    if (shellKey === 'characters') {
        await Promise.allSettled([characterPanelRevealPromise, characterListViewPromise]);
    } else {
        await getShellState(shellKey)?.tabs.get(tabId)?.ensureReady?.();
    }
    // The page's own activation (drawer flatten, section order) runs before the next frame.
    await new Promise(resolve => window.requestAnimationFrame(resolve));
}

function createSettingsSearchAdapter() {
    return {
        getShellKey: () => sbSettingsState.activeShell,
        getTabList: () => document.getElementById('sb-settings-tab-list'),
        getTabs: () => getSettingsPageTabs(sbSettingsState.activeShell).map(tab => ({ id: tab.id, label: tab.label, aliases: tab.searchAliases ?? [] })),
        getActiveTabId: () => sbSettingsState.activeTabId,
        getRoots: getSettingsSearchRoots,
        // The Characters pages are marked, not filtered, except the two settings pages that open in them.
        canHideRows: body => sbSettingsState.activeShell !== 'characters' || Boolean(body.closest('.sb-wi-settings, .sb-persona-settings')),
        getContentMatches: getSettingsSearchContentMatches,
        ensureReady: prepareShellSearch,
        whenTabReady: whenSettingsTabReady,
        changeSelector: '#main_api, #chat_completion_source, #textgen_type',
        pulse: pulseSearchTarget,
        scroll: target => scrollElementIntoManagedView(target, { block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' }),
        expand: expandHiddenAccordions,
        // A phone shows the sidebar or the page, and scrolling the hidden page shifts the clipped pane sideways.
        canReveal: () => !isMobileViewport() || Boolean(getSettingsPage()?.classList.contains('sb-settings-page--content')),
        // Two strings, one per number, as the entry counts of World Info do, so a language with more forms can translate each.
        countDescription: count => count === 1 ? t`${count} matching setting` : t`${count} matching settings`,
        emptyLabel: 'No matching pages',
    };
}

async function filterSettingsSidebarTabs(rawQuery) {
    const request = ++sbSettingsSidebarFilterRequest;
    if (!normalizeText(rawQuery)) {
        // Nothing to restore until a search has run, and the module is loaded by then.
        settingsSidebarSearch?.clear();
        return;
    }
    if (!sbSettingsState.activeShell) {
        return;
    }

    const module = await loadSettingsSearchModule();
    if (request !== sbSettingsSidebarFilterRequest) {
        return;
    }
    settingsSidebarSearch ??= module.createSidebarSearch(createSettingsSearchAdapter());
    await settingsSidebarSearch.update(rawQuery);
}

// ── Mode toggle (top-bar direct toggle) ─────────────────────────────────

const SB_CHAT_MODES = Object.freeze([
    { id: 'roleplay', label: 'Roleplay', icon: 'fa-masks-theater', description: 'Classic character-driven chat mode' },
    { id: 'conversation', label: 'Conversation', icon: 'fa-comments', description: 'Direct conversational AI mode' },
]);

function getActiveChatMode() {
    return conversationState.conversationWorkspaceOpen ? 'conversation' : 'roleplay';
}

// Neither mode is active on Home, so the switcher shows the mode that chats open in.
function getDisplayedChatMode() {
    return isHomeActive() ? getLastChatMode() : getActiveChatMode();
}

let homeRoleplayResumePending = false;

async function resumeRoleplayFromHome() {
    if (homeRoleplayResumePending) {
        return;
    }

    homeRoleplayResumePending = true;
    let resumed = false;
    try {
        const { resumeLatestRoleplayChat } = await import('./welcome-screen.js');
        resumed = await resumeLatestRoleplayChat({ canOpen: isHomeActive });
    } catch (error) {
        console.warn('Could not resume the latest Roleplay chat', error);
    } finally {
        homeRoleplayResumePending = false;
    }

    // The user may have chosen something else while the request ran.
    if (!resumed && isHomeActive() && !isCharacterPanelOpen()) {
        toggleCharacterPanel();
    }
}

function enterChatMode(mode) {
    if (!isHomeActive()) {
        if (mode !== getActiveChatMode()) {
            setCharacterShellMode(mode);
        }
        return;
    }

    if (mode === 'roleplay') {
        void resumeRoleplayFromHome();
        return;
    }

    setCharacterShellMode(mode);
}

function syncModeToggleButton() {
    const mode = SB_CHAT_MODES.find(entry => entry.id === getDisplayedChatMode()) ?? SB_CHAT_MODES[0];
    const modeToggleBtn = document.getElementById('sb-mode-toggle');
    if (!(modeToggleBtn instanceof HTMLElement)) {
        return;
    }

    const btnIcon = modeToggleBtn.querySelector(':scope > i');
    if (btnIcon) {
        btnIcon.className = `fa-solid ${mode.icon}`;
    }
    const label = modeToggleBtn.querySelector(':scope > span');
    if (label) {
        label.textContent = mode.label;
    }
    const title = `Chat Mode: ${mode.label} (Ctrl+M)`;
    modeToggleBtn.title = title;
    modeToggleBtn.setAttribute('aria-label', title);
}

function setModeMenuOpenState(isOpen) {
    const btn = document.getElementById('sb-mode-toggle');
    if (btn instanceof HTMLElement) {
        btn.classList.toggle('is-open', isOpen);
        btn.setAttribute('aria-expanded', String(isOpen));
    }
}

function closeModeDropdown({ restoreFocus = false } = {}) {
    const menu = document.getElementById('sb-mode-menu');
    if (!menu) {
        return;
    }

    setModeMenuOpenState(false);
    animateOut(menu, [
        { opacity: 1, transform: 'translateY(0) scale(1)' },
        { opacity: 0, transform: 'translateY(-4px) scale(0.97)' },
    ], () => {
        menu.remove();
        if (restoreFocus) {
            document.getElementById('sb-mode-toggle')?.focus({ preventScroll: true });
        }
    }, { duration: MOTION_FAST });
}

function toggleChatMode() {
    enterChatMode(getDisplayedChatMode() === 'roleplay' ? 'conversation' : 'roleplay');
}

function openModeDropdown() {
    if (document.getElementById('sb-mode-menu')) {
        closeModeDropdown({ restoreFocus: true });
        return;
    }

    const activeMode = getDisplayedChatMode();
    const menu = createElement('div', {
        id: 'sb-mode-menu',
        attrs: {
            role: 'menu',
            'aria-label': 'Switch Chat Mode',
        },
    });

    for (const mode of SB_CHAT_MODES) {
        const isActive = mode.id === activeMode;
        const item = createElement('button', {
            className: `sb-mode-menu-item${isActive ? ' is-active' : ''}`,
            attrs: {
                type: 'button',
                role: 'menuitemradio',
                'aria-checked': String(isActive),
            },
        });
        item.innerHTML = `<i class="fa-solid ${mode.icon} sb-mode-menu-icon" aria-hidden="true"></i><span class="sb-mode-menu-label">${mode.label}</span><span class="sb-mode-menu-desc">${mode.description}</span><i class="fa-solid fa-check sb-mode-menu-check" aria-hidden="true"></i>`;
        item.addEventListener('click', () => {
            closeModeDropdown({ restoreFocus: true });
            enterChatMode(mode.id);
        });
        menu.appendChild(item);
    }

    menu.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            event.preventDefault();
            closeModeDropdown({ restoreFocus: true });
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const items = Array.from(menu.querySelectorAll('.sb-mode-menu-item'));
            const current = items.indexOf(document.activeElement);
            const next = event.key === 'ArrowDown'
                ? (current + 1) % items.length
                : (current - 1 + items.length) % items.length;
            items[next]?.focus();
        }
    });

    const dismiss = event => {
        if (!document.body.contains(menu)) {
            document.removeEventListener('pointerdown', dismiss, true);
            return;
        }
        const btn = document.getElementById('sb-mode-toggle');
        if (menu.contains(event.target) || btn?.contains(event.target)) {
            return;
        }
        document.removeEventListener('pointerdown', dismiss, true);
        closeModeDropdown();
    };
    document.addEventListener('pointerdown', dismiss, true);

    document.body.appendChild(menu);
    setModeMenuOpenState(true);

    const btn = document.getElementById('sb-mode-toggle');
    if (btn instanceof HTMLElement) {
        const rect = btn.getBoundingClientRect();
        const menuWidth = menu.offsetWidth || 240;
        const insetRight = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sb-safe-area-right')) || 0;
        const left = Math.min(rect.left + rect.width / 2 - menuWidth / 2, window.innerWidth - menuWidth - Math.max(8, insetRight));
        menu.style.setProperty('--sb-mode-menu-top', `${rect.bottom + 6}px`);
        menu.style.setProperty('--sb-mode-menu-left', `${Math.max(8, left)}px`);
    }

    animateIn(menu, [
        { opacity: 0, transform: 'translateY(-4px) scale(0.97)' },
        { opacity: 1, transform: 'translateY(0) scale(1)' },
    ], { duration: MOTION_FAST });
    menu.querySelector('.sb-mode-menu-item')?.focus();

    window.requestAnimationFrame(() => {
        (menu.querySelector('.sb-mode-menu-item.is-active') ?? menu.querySelector('.sb-mode-menu-item'))?.focus();
    });
}

function initModeToggle() {
    if (document.documentElement.dataset.sbModeToggleBound === 'true') {
        return;
    }
    document.documentElement.dataset.sbModeToggleBound = 'true';
    window.addEventListener('sb:conversation-workspace-state-changed', syncModeToggleButton);
    document.addEventListener(HOME_STATE_CHANGED_EVENT, syncModeToggleButton);
    document.addEventListener(CHAT_MODE_CHANGED_EVENT, syncModeToggleButton);
    syncModeToggleButton();
}

// ── Global keyboard shortcuts ────────────────────────────────────────────

/**
 * Keyboard routes for the top-bar destinations.
 *
 * Keys track the top bar left-to-right so the row reads as one memorised sequence. Bare `Ctrl`
 * bindings are safe here because none of them are text-editing keys; `Ctrl+U` (view source) and
 * `Ctrl+P` (print) can still be claimed by the browser first, and no page can prevent that, so the
 * binding is best-effort rather than exclusive.
 *
 * The runs go through `openShell()` rather than the top bar's own `toggleSettingsPage()`, so they
 * land on the remembered tab inside a section that is already open instead of closing it. There is
 * no separate key for closing; Escape and the close button already cover that.
 */
const SB_SETTINGS_SHORTCUTS = Object.freeze([
    { key: 'u', run: () => openShell('left') },
    { key: 'i', run: () => openShell('right') },
    { key: 'o', run: () => { void returnToLandingPage(); } },
    { key: 'p', run: () => openShell('characters') },
]);

function initSettingsKeyboardShortcuts() {
    if (document.documentElement.dataset.sbSettingsShortcutsBound === 'true') {
        return;
    }

    document.documentElement.dataset.sbSettingsShortcutsBound = 'true';

    document.addEventListener('keydown', event => {
        const ctrl = isApplePlatform() ? event.metaKey : event.ctrlKey;
        if (!ctrl || event.altKey) {
            return;
        }

        const key = typeof event.key === 'string' ? event.key.toLowerCase() : '';
        if (!key) {
            return;
        }

        // `Ctrl+F` works inside a field on purpose: it opens search rather than the browser's own
        // find, which cannot reach into the settings page. The destination shortcuts are the
        // opposite: while the user is typing, a stray `Ctrl+P` must not navigate away.
        const active = document.activeElement;
        const isEditable = active instanceof HTMLInputElement ||
            active instanceof HTMLTextAreaElement ||
            active?.isContentEditable === true;

        if (key === 'f') {
            if (isEditable) {
                return;
            }

            event.preventDefault();
            setUniversalSearchOpenState(true, { focusInput: true });
            return;
        }

        if (key === 'm') {
            event.preventDefault();
            toggleChatMode();
            return;
        }

        const shortcut = SB_SETTINGS_SHORTCUTS.find(entry => entry.key === key);
        // Shift-qualified browser chords stay the browser's: `Ctrl+Shift+I` is DevTools inspect and
        // `Ctrl+Shift+P` is Firefox private browsing, so the destination keys fire unshifted only.
        if (!shortcut || isEditable || event.shiftKey) {
            return;
        }

        event.preventDefault();
        shortcut.run();
    });
}

initInstallNotice();

// jQuery UI places an autocomplete list with no collision handling, so Bulk Edit tags, World Info, server history and the
// gallery folder can open past the window edge. The clamp loads when the first list opens, to keep a module out of startup.
window.jQuery?.(document).one('autocompleteopen', event => {
    import('./sillybunny-autocomplete-clamp.js').then(module => module.installAutocompleteClamp(event.target)).catch(() => {});
});

// CFG Scale and Token Probabilities leave the Options menu for a backend that does not use them. The rules load when the
// menu first opens, to keep a module out of startup; the menu fades in, so the first open does not show them for a moment.
{
    const optionsMenu = document.getElementById('options');
    const syncOptionsMenu = () => {
        if (optionsMenu.style.display === 'none') return;
        import('./sillybunny-options-menu.js').then(module => module.syncOptionsMenu(document, getSillyTavernContext())).catch(() => {});
    };
    if (optionsMenu) new MutationObserver(syncOptionsMenu).observe(optionsMenu, { attributes: true, attributeFilter: ['style'] });
}

// Init shell UI as soon as DOM is ready.
// Also re-trigger on APP_READY as a safety net for slow-loading environments.
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAll);
} else {
    window.setTimeout(initAll, 120);
}

// Safety net: ensure init runs after the full app is ready (covers slow VPS /
// slow networks where DOMContentLoaded fires but scripts haven't set up UI).
const ctx = getSillyTavernContext();
if (ctx?.eventSource && ctx?.event_types) {
    bindMessageActionExtensionEvents();
    ctx.eventSource.on(ctx.event_types.APP_READY, () => {
        if (!sbState.initialized) {
            initAll();
        } else {
            bindMessageActionExtensionEvents();
            syncMessageActionExtensionVisibility();
        }
    });
}

// F1 opens Help and Ctrl+? opens Keyboard Shortcuts once the app is ready. The other shell shortcuts
// are bound in initSettingsKeyboardShortcuts().
registerHelpKeys({ eventSource, eventTypes: event_types, openHelp, openShortcuts: openKeyboardShortcuts });
