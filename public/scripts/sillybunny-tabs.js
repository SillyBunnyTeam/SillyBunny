import { DEFAULT_SCROLL_EDGE_SETTLE_DELAYS, jumpScrollElementToEdge } from './chat-scroll-edges.js';
import {
    createMobileShellLifecycle,
    MOBILE_SHELL_NAV_TOGGLE_ACTION,
} from './mobile-shell-lifecycle/index.js';
import { createPresetApiSyncLifecycle } from './preset-api-sync-lifecycle/index.js';
import { fetchWithCsrfRetry } from './csrf-token-refresh.js';
import { hasServerReturnedAfterRestart } from './server-restart-monitor.js';
import { flashHighlight, showFontAwesomePicker } from './utils.js';
import { flushCharacterSaveDebounced, getOneCharacter, refreshCsrfToken, saveSettingsDebounced } from '../script.js';

const sbMobileShellLifecycle = createMobileShellLifecycle();
const sbPresetApiSyncLifecycle = createPresetApiSyncLifecycle();

const SB_STORAGE_KEYS = Object.freeze({
    leftTab: 'sb-left-tab',
    rightTab: 'sb-right-tab',
    leftShellSize: 'sb-left-shell-size',
    rightShellSize: 'sb-right-shell-size',
    desktopShellSnapToChatWidth: 'sb-desktop-shell-snap-to-chat-width',
    characterDrawerRightLocked: 'sb-character-drawer-right-locked',
    theme: 'sb-theme',
    surfaceTransparency: 'sb-surface-transparency',
    topbarScaleDesktop: 'sb-topbar-scale-desktop',
    topbarScaleMobile: 'sb-topbar-scale-mobile',
    topbarLabelDesktopParts: 'sb-topbar-label-desktop-parts',
    topbarLabelMobilePart: 'sb-topbar-label-mobile-part',
    topbarLabelCustomText: 'sb-topbar-label-custom-text',
    chatbarVisible: 'sb-chatbar-visible',
    topbarOffset: 'sb-topbar-offset',
    settingsDrawerStatePrefix: 'sb-settings-inline-drawer',
    shortcutLeft: 'sb-shortcut-left',
    shortcutRight: 'sb-shortcut-right',
    bottomBarScale: 'sb-bottom-bar-scale',
    bottomChatSecondaryOpen: 'sb-bottom-chat-secondary-open',
    desktopButtonScale: 'sb-desktop-button-scale',
    mobileButtonScale: 'sb-mobile-button-scale',
    desktopNavLayout: 'sb-desktop-nav-layout',
    desktopNavIconOnly: 'sb-desktop-nav-icon-only',
    desktopNavShowCustomize: 'sb-desktop-nav-show-customize',
    desktopNavShowQuickActions: 'sb-desktop-nav-show-quick-actions',
    desktopNavReplaceQuickActions: 'sb-desktop-nav-replace-quick-actions',
    desktopNavReplacementTarget: 'sb-desktop-nav-replacement-target',
    desktopQuickActions: 'sb-desktop-quick-actions-v2',
    mobileNavLayout: 'sb-mobile-nav-layout',
    mobileNavIconOnly: 'sb-mobile-nav-icon-only',
    mobileNavShowCustomize: 'sb-mobile-nav-show-customize',
    mobileNavShowQuickActions: 'sb-mobile-nav-show-quick-actions',
    mobileNavReplaceQuickActions: 'sb-mobile-nav-replace-quick-actions',
    mobileNavReplacementTarget: 'sb-mobile-nav-replacement-target',
    mobileQuickActions: 'sb-mobile-quick-actions-v2',
    mobileQuickActionsLegacy: 'sb-mobile-quick-actions',
    settingsDrawerAutoClose: 'sb-settings-drawer-auto-close',
    compactMode: 'sb-compact-mode',
    frontendIcon: 'sb-frontend-icon',
    characterEditorSubTab: 'sb-character-editor-sub-tab',
});

const SB_SHORTCUT_TARGETS = Object.freeze([
    { value: 'left:presets', label: 'Presets', icon: 'fa-sliders' },
    { value: 'left:api', label: 'API', icon: 'fa-plug' },
    { value: 'left:sampling', label: 'Sampling', icon: 'fa-wave-square' },
    { value: 'left:advanced-formatting', label: 'Formatting', icon: 'fa-text-height' },
    { value: 'characters:world-info', label: 'World Info', icon: 'fa-book-atlas' },
    { value: 'left:agents', label: 'Agents', icon: 'fa-robot' },
    { value: 'action:search', label: 'Search', icon: 'fa-magnifying-glass' },
    { value: 'right:settings', label: 'Settings', icon: 'fa-screwdriver-wrench' },
    { value: 'right:extensions', label: 'Extensions', icon: 'fa-cubes' },
    { value: 'characters:persona', label: 'Persona', icon: 'fa-face-smile' },
    { value: 'right:background', label: 'Background', icon: 'fa-panorama' },
]);

const SB_SHORTCUT_DEFAULTS = Object.freeze({
    left: 'left:agents',
    right: 'action:search',
});
const SB_PANEL_STYLESHEETS = Object.freeze({
    'characters:world-info': [
        { href: 'css/world-info.css?v=20260425b', id: 'deferred-world-info-css' },
    ],
    'characters:persona': [
        { href: 'css/personas.css?v=20260609a', id: 'deferred-personas-css' },
    ],
    'left:advanced-formatting': [
        { href: 'css/macros.css', id: 'deferred-macros-css' },
    ],
    'right:extensions': [
        { href: 'css/extensions-panel.css?v=20260425a', id: 'deferred-extensions-panel-css' },
    ],
});
const SB_FRONTEND_ICON_DEFAULT = 'pixel';
const SB_FRONTEND_ICONS = Object.freeze([
    {
        id: 'pixel',
        label: 'Pixel',
        description: 'Classic square icon.',
        src: 'img/sillybunny-pixel-logo-og.png',
    },
    {
        id: 'badge',
        label: 'Badge',
        description: 'Clean badge icon.',
        src: 'img/sillybunny-badge.png',
    },
]);
const SB_ACCOUNT_STORAGE_READY_MARKER = '__migrated';
const SB_INLINE_DRAWER_CUSTOM_PERSISTENCE_SELECTOR = '.sb-openai-settings-drawer, .sb-openai-settings-subdrawer, [id$="prompt_manager_drawer"]';
const SB_STORAGE_PREFIX = 'sb-';
const SB_STORAGE_WRITE_DEBOUNCE_MS = 120;
const SB_MOBILE_ACTION_DEBOUNCE_MS = 140;
const SB_SHELL_FOCUSABLE_SELECTOR = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
].join(',');

let sbInlineDrawerPersistenceObserver = null;
let sbInlineDrawerPersistenceQueued = false;
let sbChatScriptModulePromise = null;
let sbMainScriptModulePromise = null;
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
    const stored = migrateLegacyWorldInfoRoute(safeGetItem(side === 'left' ? SB_STORAGE_KEYS.shortcutLeft : SB_STORAGE_KEYS.shortcutRight));
    const valid = SB_SHORTCUT_TARGETS.some(t => t.value === stored);
    return valid ? stored : SB_SHORTCUT_DEFAULTS[side];
}

function getShortcutConfig(target) {
    return SB_SHORTCUT_TARGETS.find(t => t.value === target) || SB_SHORTCUT_TARGETS[0];
}

function migrateLegacyWorldInfoRoute(target) {
    // SillyBunny: migrate saved pre-relocation World Info shortcuts to the
    // Characters panel tab instead of reviving the old left-shell route.
    return target === 'left:world-info' ? 'characters:world-info' : target;
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

    if (shell === 'characters') {
        if (!tab || tab === 'characters') {
            void setCharacterListEntityView('characters');
        }
        preloadPanelStylesheets('characters', tab);
        toggleShellPanel(shell, tab);
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
    sbStoragePendingWrites.clear();

    for (const [key, write] of pendingWrites) {
        try {
            if (write?.remove) {
                localStorage.removeItem(key);
            } else {
                localStorage.setItem(key, write.value);
            }
        } catch {
            // Keep the previous safe localStorage semantics: storage failures are non-fatal.
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

function safeRemoveItem(key) {
    if (!isSillyBunnyStorageKey(key)) {
        try { localStorage.removeItem(key); } catch {
            // Ignore storage removal failures.
        }
        return;
    }

    sbStorageCache.set(key, null);
    sbStoragePendingWrites.set(key, { remove: true });
    scheduleSbStorageFlush();
}

bindSbStorageFlushEvents();

const SB_IDLE_BRAND_LABEL = 'SillyBunny';
const SB_MOBILE_MEDIA_QUERY = '(max-width: 768px)';
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
const SB_TOPBAR_LABEL_PARTS = Object.freeze([
    {
        id: 'ctx',
        label: 'Context Size',
        description: 'Show the current total Tokens value from the Prompt page.',
    },
    {
        id: 'char',
        label: 'Character Name',
        description: 'Show the active character name, or the group name while a group chat is open.',
    },
    {
        id: 'custom',
        label: 'Custom Text',
        description: 'Show your own short label in the center of the top bar.',
    },
]);
const SB_TOPBAR_LABEL_PART_ORDER = Object.freeze(SB_TOPBAR_LABEL_PARTS.map(part => part.id));
const SB_TOPBAR_LABEL_PART_IDS = new Set(SB_TOPBAR_LABEL_PART_ORDER);
const SB_TOPBAR_LABEL_CUSTOM_TEXT_MAX_LENGTH = 48;
const SB_TOPBAR_DRAG_X_RATIO = 0.36;
const SB_TOPBAR_DRAG_Y_RATIO = 0.24;
const SB_TOPBAR_CONTEXT_REFRESH_DEBOUNCE = 220;
const SB_CONSOLE_LOG_LIMIT = 260;
const SB_CONSOLE_LOG_REFRESH_MS = 2500;
const SB_CONSOLE_LOG_STICKY_THRESHOLD = 28;
const SB_CHATBAR_SEARCH_DEBOUNCE = 220;
const SB_CHAT_SEARCH_MARK_SELECTOR = 'mark[data-sb-chat-search="true"]';
const SB_DESKTOP_SHELL_LAYOUT = Object.freeze({
    minWidth: 600,
    maxWidth: 900,
    ratio: 0.55,
    laptopViewportMin: 1001,
    laptopViewportMax: 1440,
    laptopMinWidth: 680,
    laptopMaxWidth: 920,
    laptopRatio: 0.6,
    laptopGutter: 28,
    compactMaxWidth: 900,
    compactViewportWidth: 1100,
    compactGap: 20,
    gutterMin: 20,
    gutterRatio: 0.04,
    gutterMax: 80,
    fullWidthMaxHeight: 860,
});
const SB_DESKTOP_SHELL_RESIZE = Object.freeze({
    minWidth: 420,
    minHeight: 320,
    bottomGap: 16,
});
const SB_SHELL_TOGGLE_GUARD_MS = 260;
const SB_INIT_RETRY_DELAY_MS = 150;
const SB_INIT_MAX_RETRIES = 30;

const SB_THEMES = Object.freeze([
    {
        id: 'windows-aero',
        label: 'Windows Aero',
    },
    {
        id: 'clean-minimal',
        label: 'Clean Minimal',
    },
    {
        id: 'gnome-adwaita',
        label: 'GNOME Adwaita',
    },
    {
        id: 'cozy-warm',
        label: 'Cozy Warm',
    },
    {
        id: 'hypr-glow',
        label: 'Hypr Glow',
    },
    {
        id: 'slate-flat',
        label: 'Slate Flat',
    },
]);

const SB_MESSAGE_STYLES = Object.freeze([
    { id: '0', label: 'Flat', icon: 'fa-grip-lines' },
    { id: '1', label: 'Bubbles', icon: 'fa-comment-dots' },
    { id: '2', label: 'Document', icon: 'fa-file-lines' },
]);

const SB_CHARACTER_TAB_COPY = Object.freeze({
    characters: {
        title: 'Character Menu',
        subtitle: 'Browse, create, and tune the cast for your chats from one place.',
        description: 'Move between characters, groups, personas, lore, and imports without leaving the writing workspace.',
    },
    groups: {
        title: 'Group Menu',
        subtitle: 'Build and organize group casts for multi-character scenes.',
        description: 'Sort group chats, check members, and return to character cards without losing your place.',
    },
    editor: {
        title: 'Card Editor',
        subtitle: 'Shape the selected card details, prompts, greetings, and metadata.',
        description: 'Use the subtabs to keep core identity, definitions, greetings, and metadata separated.',
    },
    'world-info': {
        title: 'World Info',
        subtitle: 'Manage lorebooks and world details from the character workspace.',
        description: 'Create, edit, import, and activate World Info entries without leaving the Characters menu.',
    },
    persona: {
        title: 'Persona',
        subtitle: 'Choose how you appear in chat and connect personas to characters.',
        description: 'Edit persona details, locks, and defaults in the same flow as your character work.',
    },
    import: {
        title: 'Import',
        subtitle: 'Add cards from files or links, then fold them into your local cast.',
        description: 'PNG, JSON, YAML, CHARX, BYAF, and supported URL imports stay one tab away.',
    },
});

const SB_CHARACTER_EDITOR_SUB_TABS = Object.freeze([
    'char-info',
    'definitions',
    'greetings',
    'metadata',
]);
const SB_CHARACTER_EDITOR_DEFAULT_SUB_TAB = 'char-info';
const SB_CHARACTER_EDITOR_SPOILER_FREE_VISIBLE_TABS = Object.freeze(['char-info', 'metadata']);

const SB_CHARACTER_PANEL_TABS = Object.freeze([
    { id: 'characters', label: 'Characters', icon: 'fa-address-book' },
    { id: 'groups', label: 'Groups', icon: 'fa-users' },
    { id: 'editor', label: 'Editor', icon: 'fa-pen-to-square' },
    { id: 'world-info', label: 'World Info', icon: 'fa-book-atlas' },
    { id: 'persona', label: 'Persona', icon: 'fa-face-smile' },
    { id: 'import', label: 'Import', icon: 'fa-file-import' },
]);
const SB_CHARACTER_PANEL_DEFAULT_TAB = 'characters';

const SB_PERSONA_HELP_LINK_HTML = '<a class="notes-link sb-character-title-help" href="https://docs.sillytavern.app/usage/core-concepts/personas/" target="_blank"><span class="fa-solid fa-circle-question note-link-span"></span></a>';

const SB_SHELLS = Object.freeze({
    left: {
        rootPanelId: 'left-nav-panel',
        hostDrawerId: 'ai-config-button',
        hostToggleSelector: '#ai-config-button > .drawer-toggle',
        hostIconSelector: '#leftNavDrawerIcon',
        proxyButtonId: 'sb-left-shell-toggle',
        proxyIcon: 'fa-bars',
        proxyLabel: 'Workspace',
        title: 'Workspace',
        subtitle: '', // Removed redundant workspace subtext (PR #145 expansion)
        searchPlaceholder: 'Find presets, samplers, lore, or tools...',
        storageKey: SB_STORAGE_KEYS.leftTab,
        defaultTabId: 'presets',
        baseTab: {
            id: 'presets',
            label: 'Presets',
            icon: 'fa-sliders',
        },
        embeddedTabs: [
            {
                id: 'api',
                drawerId: 'sys-settings-button',
                label: 'API',
                icon: 'fa-plug',
            },
            {
                id: 'advanced-formatting',
                drawerId: 'advanced-formatting-button',
                label: 'Formatting',
                icon: 'fa-text-height',
            },
        ],
        customTabs: [
            {
                id: 'sampling',
                label: 'Sampling',
                icon: 'fa-wave-square',
                searchPlaceholder: 'Search temperature, top p, repetition penalty, or backend samplers',
                searchExamples: ['temperature', 'top p', 'repetition penalty'],
            },
            {
                id: 'agents',
                label: 'Agents',
                icon: 'fa-robot',
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
        subtitle: 'Personalize your workspace, add/remove extensions, modify server settings, or check logs here.',
        searchPlaceholder: 'Search themes, top bar, backgrounds, or extensions',
        searchExamples: ['theme', 'top bar', 'Appearance', 'notify extension updates'],
        storageKey: SB_STORAGE_KEYS.rightTab,
        defaultTabId: 'settings',
        baseTab: {
            id: 'settings',
            label: 'Settings',
            icon: 'fa-screwdriver-wrench',
            searchPlaceholder: 'Search Appearance, top bar, chat style, blur, or update notices',
            searchExamples: ['theme', 'top bar', 'Appearance', 'notify extension updates'],
        },
        embeddedTabs: [
            {
                id: 'extensions',
                drawerId: 'extensions-settings-button',
                label: 'Extensions',
                icon: 'fa-cubes',
                searchPlaceholder: 'Search themes, Quick Reply, Dialogue Colors, or Image Gen',
                searchExamples: ['themes', 'Quick Reply', 'Dialogue Colors', 'Image Gen'],
            },
            {
                id: 'background',
                drawerId: 'backgrounds-button',
                label: 'Background',
                icon: 'fa-panorama',
                searchPlaceholder: 'Search background names, blur, fit, or vibe words',
                searchExamples: ['cozy', 'landscape', 'blur', 'fit'],
            },
        ],
        customTabs: [
            {
                id: 'server',
                label: 'Server',
                icon: 'fa-server',
                searchPlaceholder: 'Search update, restart, config.yaml, or branch',
                searchExamples: ['update', 'restart', 'config.yaml', 'branch'],
            },
            {
                id: 'console-logs',
                label: 'Console Logs',
                icon: 'fa-terminal',
                searchPlaceholder: 'Search error, warning, npm, bun, or extension logs',
                searchExamples: ['error', 'warning', 'npm', 'bun'],
            },
        ],
    },
});

const SB_DRAWER_ROUTES = Object.freeze({
    'user-settings-button': { shell: 'right', tab: 'settings' },
    'sys-settings-button': { shell: 'left', tab: 'api' },
    'advanced-formatting-button': { shell: 'left', tab: 'advanced-formatting' },
    'WI-SP-button': { shell: 'characters', tab: 'world-info' },
    'extensions-settings-button': { shell: 'right', tab: 'extensions' },
    'persona-management-button': { shell: 'characters', tab: 'persona' },
    'backgrounds-button': { shell: 'right', tab: 'background' },
});

const SB_SEARCH_TARGET_SELECTOR = [
    'label',
    '.checkbox_label',
    '.menu_button',
    '.inline-drawer-toggle',
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

const SB_UNIVERSAL_SEARCH_PLACEHOLDER = 'Type to search...';
const SB_UNIVERSAL_SEARCH_IDLE_TITLE = 'Search all settings';
const SB_UNIVERSAL_SEARCH_IDLE_HINT = 'Jump to any workspace or customization control from one place.';
const SB_UNIVERSAL_SEARCH_EMPTY_HINT = 'Could not find query. Try a broader term or a different setting name.';
const SB_UNIVERSAL_SEARCH_RESULT_LIMIT = 10;
const SB_MOBILE_QUICK_ACTION_LIMIT = sbMobileShellLifecycle.railModel.limits.quickActionLimit;
const SB_MOBILE_QUICK_ACTION_ICON_FALLBACK = sbMobileShellLifecycle.railModel.limits.iconFallback;
let sbIsSyncingRailActions = false;
const SB_MOBILE_NAV_CLOSED_ICON = 'fa-compass';
const SB_MOBILE_VIEWPORT_RESET_FOLLOWUP_MS = 350;
const SB_FONT_AWESOME_STYLE_CLASSES = Object.freeze(new Set(['fa-solid', 'fa-regular', 'fa-brands']));
const SB_MOBILE_NAV_LAYOUTS = Object.freeze(['horizontal', 'vertical']);
const SB_MOBILE_DEFAULT_QUICK_ACTIONS = Object.freeze([
    { type: 'tab', shellKey: 'left', tabId: 'presets', icon: 'fa-sliders', label: 'Presets' },
    { type: 'tab', shellKey: 'left', tabId: 'api', icon: 'fa-plug', label: 'API' },
    { type: 'tab', shellKey: 'left', tabId: 'sampling', icon: 'fa-wave-square', label: 'Sampling' },
    { type: 'tab', shellKey: 'left', tabId: 'advanced-formatting', icon: 'fa-text-height', label: 'Formatting' },
    { type: 'tab', shellKey: 'characters', tabId: 'world-info', icon: 'fa-book-atlas', label: 'World Info' },
    { type: 'tab', shellKey: 'left', tabId: 'agents', icon: 'fa-robot', label: 'Agents' },
]);
const SB_DESKTOP_DEFAULT_QUICK_ACTIONS = Object.freeze([
    { type: 'tab', shellKey: 'characters', tabId: 'world-info', icon: 'fa-book-atlas', label: 'World Info' },
]);
const SB_MOBILE_NAV_PAGE_TARGET_DEFAULT = 'left:presets';
const SB_MOBILE_NAV_PAGE_TARGETS = Object.freeze([
    { value: 'left:presets', shellKey: 'left', tabId: 'presets', label: 'Presets', icon: 'fa-sliders' },
    { value: 'left:api', shellKey: 'left', tabId: 'api', label: 'API', icon: 'fa-plug' },
    { value: 'left:sampling', shellKey: 'left', tabId: 'sampling', label: 'Sampling', icon: 'fa-wave-square' },
    { value: 'left:advanced-formatting', shellKey: 'left', tabId: 'advanced-formatting', label: 'Formatting', icon: 'fa-text-height' },
    { value: 'characters:world-info', shellKey: 'characters', tabId: 'world-info', label: 'World Info', icon: 'fa-book-atlas' },
    { value: 'left:agents', shellKey: 'left', tabId: 'agents', label: 'Agents', icon: 'fa-robot' },
    { value: 'right:settings', shellKey: 'right', tabId: 'settings', label: 'Settings', icon: 'fa-screwdriver-wrench' },
    { value: 'right:extensions', shellKey: 'right', tabId: 'extensions', label: 'Extensions', icon: 'fa-cubes' },
    { value: 'right:background', shellKey: 'right', tabId: 'background', label: 'Background', icon: 'fa-panorama' },
    { value: 'right:server', shellKey: 'right', tabId: 'server', label: 'Server', icon: 'fa-server' },
    { value: 'right:console-logs', shellKey: 'right', tabId: 'console-logs', label: 'Console Logs', icon: 'fa-terminal' },
]);

const sbState = {
    initialized: false,
    initRetryTimer: 0,
    initRetryCount: 0,
    initObserver: null,
    landingPageObserver: null,
    landingPageSyncFrame: 0,
    inlineDrawerAutoClose: normalizeStoredBoolean(safeGetItem(SB_STORAGE_KEYS.settingsDrawerAutoClose), false),
    theme: normalizeTheme(safeGetItem(SB_STORAGE_KEYS.theme)),
    frontendIcon: normalizeFrontendIcon(safeGetItem(SB_STORAGE_KEYS.frontendIcon)),
    surfaceTransparency: normalizeSurfaceTransparency(safeGetItem(SB_STORAGE_KEYS.surfaceTransparency)),
    compactMode: normalizeStoredBoolean(safeGetItem(SB_STORAGE_KEYS.compactMode), false),
    bottomBarScale: normalizeTopbarScale(safeGetItem(SB_STORAGE_KEYS.bottomBarScale)),
    desktopButtonScale: normalizeTopbarScale(safeGetItem(SB_STORAGE_KEYS.desktopButtonScale)),
    mobileButtonScale: normalizeTopbarScale(safeGetItem(SB_STORAGE_KEYS.mobileButtonScale)),
    topbarScale: {
        desktop: normalizeTopbarScale(safeGetItem(SB_STORAGE_KEYS.topbarScaleDesktop)),
        mobile: normalizeTopbarScale(safeGetItem(SB_STORAGE_KEYS.topbarScaleMobile)),
    },
    topbarLabel: {
        desktopParts: safeGetItem(SB_STORAGE_KEYS.topbarLabelDesktopParts) === null
            ? ['char']
            : normalizeTopbarLabelParts(safeGetItem(SB_STORAGE_KEYS.topbarLabelDesktopParts), []),
        mobilePart: safeGetItem(SB_STORAGE_KEYS.topbarLabelMobilePart) === null
            ? 'char'
            : normalizeTopbarLabelPart(safeGetItem(SB_STORAGE_KEYS.topbarLabelMobilePart), ''),
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
    },
    shellSizing: {
        overrides: {
            left: normalizeShellSize(safeGetItem(SB_STORAGE_KEYS.leftShellSize)),
            right: normalizeShellSize(safeGetItem(SB_STORAGE_KEYS.rightShellSize)),
        },
        snapToChatWidth: normalizeStoredBoolean(safeGetItem(SB_STORAGE_KEYS.desktopShellSnapToChatWidth), false),
        activeResize: null,
    },
    characterDrawer: {
        rightLocked: normalizeStoredBoolean(safeGetItem(SB_STORAGE_KEYS.characterDrawerRightLocked), false),
        stateObserver: null,
        observedOpen: null,
        lastTab: 'characters',
    },
    mobileModal: {
        syncFrame: 0,
    },
    mobileNav: {
        lastOpenedAt: 0,
        quickActionContainer: null,
        quickActionSection: null,
        quickActionDivider: null,
        layout: normalizeMobileNavLayout(safeGetItem(SB_STORAGE_KEYS.mobileNavLayout)),
        iconOnly: normalizeStoredBoolean(safeGetItem(SB_STORAGE_KEYS.mobileNavIconOnly), false),
        showCustomize: normalizeStoredBoolean(safeGetItem(SB_STORAGE_KEYS.mobileNavShowCustomize), true),
        showQuickActions: normalizeStoredBoolean(safeGetItem(SB_STORAGE_KEYS.mobileNavShowQuickActions), false),
        replaceQuickActions: normalizeStoredBoolean(safeGetItem(SB_STORAGE_KEYS.mobileNavReplaceQuickActions), false),
        replacementTarget: normalizeMobileNavReplacementTarget(safeGetItem(SB_STORAGE_KEYS.mobileNavReplacementTarget)),
    },
    desktopNav: {
        layout: normalizeMobileNavLayout(safeGetItem(SB_STORAGE_KEYS.desktopNavLayout)),
        iconOnly: normalizeStoredBoolean(safeGetItem(SB_STORAGE_KEYS.desktopNavIconOnly), false),
        showCustomize: normalizeStoredBoolean(safeGetItem(SB_STORAGE_KEYS.desktopNavShowCustomize), true),
        showQuickActions: normalizeStoredBoolean(safeGetItem(SB_STORAGE_KEYS.desktopNavShowQuickActions), false),
        replaceQuickActions: normalizeStoredBoolean(safeGetItem(SB_STORAGE_KEYS.desktopNavReplaceQuickActions), false),
        replacementTarget: normalizeMobileNavReplacementTarget(safeGetItem(SB_STORAGE_KEYS.desktopNavReplacementTarget)),
    },
    desktopQuickActions: [],
    mobileQuickActions: [],
    chatbar: {
        desktop: null,
        sidebar: null,
        mobileTools: null,
        visible: normalizeStoredBoolean(safeGetItem(SB_STORAGE_KEYS.chatbarVisible), true),
        searchQuery: '',
        searchTimer: 0,
        searchApplyToken: 0,
        refreshTimer: 0,
        refreshToken: 0,
        pendingSearchScroll: false,
        isApplyingSearch: false,
        chatObserver: null,
        sourceObserver: null,
        sourceSelectObserver: null,
        sourceObservedElement: null,
        sourceChangeHandler: null,
        connectionStripOpen: false,
        sidebarOpen: false,
        mobileToolsOpen: false,
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
        searchOpen: false,
        bindingRetryTimer: 0,
        boundEventSource: null,
        windowBindingsAttached: false,
        outsideClickBound: false,
    },
    serverAdmin: {
        refs: null,
        originalConfig: '',
        lastModifiedMs: 0,
        thumbnailLastModifiedMs: 0,
        thumbnailSettingsLoaded: false,
        lastStatusData: null,
        busy: false,
        restarting: false,
        configLoaded: false,
    },
    consoleLogs: {
        refs: null,
        entries: [],
        latestId: 0,
        captureStartedAt: 0,
        totalBuffered: 0,
        refreshTimer: 0,
        busy: false,
        paused: false,
        lastUpdatedAt: 0,
        lastError: '',
    },
    importer: {
        refs: null,
        busy: false,
        report: null,
    },
};

function normalizeTheme(themeId) {
    return SB_THEMES.some(theme => theme.id === themeId) ? themeId : 'clean-minimal';
}

function normalizeFrontendIcon(iconId) {
    const normalizedIconId = normalizeText(iconId);
    return SB_FRONTEND_ICONS.some(icon => icon.id === normalizedIconId) ? normalizedIconId : SB_FRONTEND_ICON_DEFAULT;
}

function getFrontendIconConfig(iconId = sbState.frontendIcon) {
    const normalizedIconId = normalizeFrontendIcon(iconId);
    return SB_FRONTEND_ICONS.find(icon => icon.id === normalizedIconId) || SB_FRONTEND_ICONS[0];
}

function getFrontendIconSrc(iconId = sbState.frontendIcon, { absolute = true } = {}) {
    const src = getFrontendIconConfig(iconId).src;
    return absolute ? `/${src}` : src;
}

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

function normalizeMobileNavLayout(value) {
    const normalizedValue = normalizeText(value);
    return SB_MOBILE_NAV_LAYOUTS.includes(normalizedValue) ? normalizedValue : 'horizontal';
}

function getNavState(mode) {
    return mode === 'desktop' ? sbState.desktopNav : sbState.mobileNav;
}

function getQuickActionState(mode) {
    return mode === 'desktop' ? sbState.desktopQuickActions : sbState.mobileQuickActions;
}

function getActiveShellRailMode() {
    return isMobileViewport() ? 'mobile' : 'desktop';
}

function getMobileNavCustomizeLocationLabel(mode = 'mobile') {
    return getNavState(mode).layout === 'horizontal'
        ? 'Show Workspace and Customize buttons in top bar'
        : 'Show Workspace and Customize shortcuts in each side rail';
}

function normalizeMobileNavReplacementTarget(value) {
    const normalizedValue = String(value ?? '').trim();
    return SB_MOBILE_NAV_PAGE_TARGETS.some(target => target.value === normalizedValue)
        ? normalizedValue
        : SB_MOBILE_NAV_PAGE_TARGET_DEFAULT;
}

function getMobileNavReplacementTargetConfig(target = sbState.mobileNav.replacementTarget) {
    const normalizedTarget = normalizeMobileNavReplacementTarget(target);
    return SB_MOBILE_NAV_PAGE_TARGETS.find(item => item.value === normalizedTarget)
        ?? SB_MOBILE_NAV_PAGE_TARGETS[0];
}

function createNavReplacementQuickAction(target) {
    const config = getMobileNavReplacementTargetConfig(target);
    return normalizeMobileQuickAction({
        type: 'tab',
        shellKey: config.shellKey,
        tabId: config.tabId,
        icon: config.icon,
        label: config.label,
    });
}

function normalizeShellSize(value) {
    let source = value;

    if (typeof source === 'string') {
        const trimmedValue = source.trim();

        if (!trimmedValue) {
            return null;
        }

        try {
            source = JSON.parse(trimmedValue);
        } catch {
            return null;
        }
    }

    const width = Number(source?.width);
    const height = Number(source?.height);

    if (!Number.isFinite(width) || !Number.isFinite(height)) {
        return null;
    }

    return {
        width: Math.max(0, Math.round(width)),
        height: Math.max(0, Math.round(height)),
    };
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

function getMobileQuickActionTabConfig(shellKey, tabId) {
    if (shellKey === 'characters') {
        return getCharacterPanelTabConfig(tabId);
    }

    const shellConfig = getShellConfig(shellKey);
    if (!shellConfig || !tabId) {
        return null;
    }

    return [
        shellConfig.baseTab,
        ...(Array.isArray(shellConfig.embeddedTabs) ? shellConfig.embeddedTabs : []),
        ...(Array.isArray(shellConfig.customTabs) ? shellConfig.customTabs : []),
    ].find(tab => tab?.id === tabId) || null;
}

function normalizeFontAwesomeIcon(value, fallback = SB_MOBILE_QUICK_ACTION_ICON_FALLBACK) {
    const fallbackIcon = clampText(fallback || SB_MOBILE_QUICK_ACTION_ICON_FALLBACK, 60);
    const iconClass = String(value ?? '')
        .trim()
        .split(/\s+/)
        .find(token => /^fa-[a-z0-9-]+$/i.test(token) && !SB_FONT_AWESOME_STYLE_CLASSES.has(token.toLowerCase()));

    return clampText(iconClass?.toLowerCase() || fallbackIcon, 60);
}

function getMobileQuickActionContext(value) {
    const route = sbMobileShellLifecycle.railModel.resolveQuickActionRoute(value);
    return {
        shellConfig: route.shellKey === 'characters' ? null : getShellConfig(route.shellKey),
        tabConfig: route.tabId ? getMobileQuickActionTabConfig(route.shellKey, route.tabId) : null,
    };
}

function normalizeMobileQuickAction(value) {
    const { shellConfig, tabConfig } = getMobileQuickActionContext(value);
    return sbMobileShellLifecycle.railModel.normalizeQuickAction({
        action: value,
        shellConfig,
        tabConfig,
        limits: sbMobileShellLifecycle.railModel.limits,
    });
}

function normalizeMobileQuickActionList(actions) {
    const seen = new Set();
    const nextActions = [];

    if (!Array.isArray(actions)) {
        return nextActions;
    }

    for (const action of actions) {
        const normalizedAction = normalizeMobileQuickAction(action);
        if (!normalizedAction) {
            continue;
        }

        const key = getMobileQuickActionKey(normalizedAction);
        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        nextActions.push(normalizedAction);

        if (nextActions.length >= SB_MOBILE_QUICK_ACTION_LIMIT) {
            break;
        }
    }

    return nextActions;
}

function getDefaultMobileQuickActions() {
    return normalizeMobileQuickActionList(SB_MOBILE_DEFAULT_QUICK_ACTIONS);
}

function getDefaultDesktopQuickActions() {
    return normalizeMobileQuickActionList(SB_DESKTOP_DEFAULT_QUICK_ACTIONS);
}

function migrateLegacyMobileQuickAction(action) {
    if (!action || typeof action !== 'object') {
        return action;
    }

    // SillyBunny: account storage may still contain the pre-relocation mobile
    // World Info route; normalize it to the Characters tab on read.
    const legacyShellKey = normalizeText(action.shellKey || action.shell);
    const legacyTabId = normalizeText(action.tabId || action.tab);
    if (legacyShellKey !== 'left' || legacyTabId !== 'world-info') {
        return action;
    }

    return {
        ...action,
        shellKey: 'characters',
        tabId: 'world-info',
    };
}

function parseMobileQuickActionStorage(storedValue) {
    if (storedValue === null) {
        return null;
    }

    try {
        const parsedValue = JSON.parse(storedValue);
        if (!Array.isArray(parsedValue)) {
            return null;
        }

        return normalizeMobileQuickActionList(parsedValue.map(migrateLegacyMobileQuickAction));
    } catch {
        return null;
    }
}

function loadMobileQuickActions() {
    const storedActions = parseMobileQuickActionStorage(safeGetItem(SB_STORAGE_KEYS.mobileQuickActions));
    if (storedActions) {
        return storedActions;
    }

    const defaultActions = getDefaultMobileQuickActions();
    const legacyActions = parseMobileQuickActionStorage(safeGetItem(SB_STORAGE_KEYS.mobileQuickActionsLegacy));
    const nextActions = legacyActions
        ? normalizeMobileQuickActionList([...defaultActions, ...legacyActions])
        : defaultActions;

    safeSetItem(SB_STORAGE_KEYS.mobileQuickActions, JSON.stringify(nextActions));
    return nextActions;
}

function loadDesktopQuickActions() {
    const storedActions = parseMobileQuickActionStorage(safeGetItem(SB_STORAGE_KEYS.desktopQuickActions));
    if (storedActions) {
        return storedActions;
    }

    const nextActions = getDefaultDesktopQuickActions();
    safeSetItem(SB_STORAGE_KEYS.desktopQuickActions, JSON.stringify(nextActions));
    return nextActions;
}

function saveMobileQuickActions() {
    safeSetItem(SB_STORAGE_KEYS.mobileQuickActions, JSON.stringify(sbState.mobileQuickActions));
}

function saveDesktopQuickActions() {
    safeSetItem(SB_STORAGE_KEYS.desktopQuickActions, JSON.stringify(sbState.desktopQuickActions));
}

function getMobileQuickActionKey(action) {
    const normalizedAction = normalizeMobileQuickAction(action);
    return sbMobileShellLifecycle.railModel.getQuickActionKey(normalizedAction);
}

function createMobileQuickActionFromMatch(match) {
    const normalizedMatch = normalizeMobileQuickAction({
        type: 'custom',
        shellKey: match?.shellKey,
        tabId: match?.tabId,
        icon: SB_MOBILE_QUICK_ACTION_ICON_FALLBACK,
        sectionLabel: match?.sectionLabel,
        displayText: match?.displayText,
        dedupeKey: match?.dedupeKey,
        label: match?.displayText || match?.sectionLabel,
    });

    return normalizedMatch;
}

function setQuickActionsForMode(mode, actions, { persist = true } = {}) {
    const normalizedActions = normalizeMobileQuickActionList(actions);

    if (mode === 'desktop') {
        sbState.desktopQuickActions = normalizedActions;

        if (persist) {
            saveDesktopQuickActions();
        }

        renderMobileQuickActionSettingsList('desktop');
        refreshMobileQuickActionSearchResults('desktop');
        syncMobileShellRailActions();
        return;
    }

    sbState.mobileQuickActions = normalizedActions;

    if (persist) {
        saveMobileQuickActions();
    }

    renderMobileQuickActionSettingsList('mobile');
    refreshMobileQuickActionSearchResults('mobile');
    refreshMobileNavQuickActions();
    syncMobileShellRailActions();
}

function setMobileQuickActions(actions, options = {}) {
    setQuickActionsForMode('mobile', actions, options);
}

function setDesktopQuickActions(actions, options = {}) {
    setQuickActionsForMode('desktop', actions, options);
}

function addQuickActionFromMatch(mode, match) {
    const action = createMobileQuickActionFromMatch(match);
    if (!action) {
        return false;
    }

    const currentActions = getQuickActionState(mode);
    if (currentActions.length >= SB_MOBILE_QUICK_ACTION_LIMIT) {
        return false;
    }

    const actionKey = getMobileQuickActionKey(action);
    if (currentActions.some(existingAction => getMobileQuickActionKey(existingAction) === actionKey)) {
        return false;
    }

    setQuickActionsForMode(mode, [...currentActions, action]);
    return true;
}

function removeQuickAction(mode, actionKey) {
    setQuickActionsForMode(mode, getQuickActionState(mode).filter(action => getMobileQuickActionKey(action) !== actionKey));
}

function setQuickActionIcon(mode, actionKey, iconClass) {
    setQuickActionsForMode(mode, getQuickActionState(mode).map(action => {
        if (getMobileQuickActionKey(action) !== actionKey) {
            return action;
        }

        return {
            ...action,
            icon: normalizeFontAwesomeIcon(iconClass),
        };
    }));
}

async function chooseQuickActionIcon(mode, actionKey) {
    const action = getQuickActionState(mode).find(action => getMobileQuickActionKey(action) === actionKey);
    const normalizedAction = normalizeMobileQuickAction(action);

    if (!normalizedAction || normalizedAction.type !== 'custom') {
        return;
    }

    const iconClass = await showFontAwesomePicker();
    if (iconClass === null) {
        return;
    }

    setQuickActionIcon(mode, actionKey, iconClass);
}

function resetMobileQuickActions() {
    setMobileQuickActions(getDefaultMobileQuickActions());
}

function resetDesktopQuickActions() {
    setDesktopQuickActions(getDefaultDesktopQuickActions());
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
    if (safeGetItem(SB_STORAGE_KEYS.topbarScaleDesktop) === null) {
        safeSetItem(SB_STORAGE_KEYS.topbarScaleDesktop, String(SB_TOPBAR_SCALE.defaultValue));
    }

    if (safeGetItem(SB_STORAGE_KEYS.topbarScaleMobile) === null) {
        safeSetItem(SB_STORAGE_KEYS.topbarScaleMobile, String(SB_TOPBAR_SCALE.defaultValue));
    }

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
    sbState.topbarScale.desktop = normalizeTopbarScale(safeGetItem(SB_STORAGE_KEYS.topbarScaleDesktop));
    sbState.topbarScale.mobile = normalizeTopbarScale(safeGetItem(SB_STORAGE_KEYS.topbarScaleMobile));
    sbState.bottomBarScale = normalizeTopbarScale(safeGetItem(SB_STORAGE_KEYS.bottomBarScale));
    sbState.desktopButtonScale = normalizeTopbarScale(safeGetItem(SB_STORAGE_KEYS.desktopButtonScale));
    sbState.mobileButtonScale = normalizeTopbarScale(safeGetItem(SB_STORAGE_KEYS.mobileButtonScale));
    sbState.frontendIcon = normalizeFrontendIcon(safeGetItem(SB_STORAGE_KEYS.frontendIcon));
    sbState.topbarLabel.desktopParts = safeGetItem(SB_STORAGE_KEYS.topbarLabelDesktopParts) === null
        ? ['char']
        : normalizeTopbarLabelParts(safeGetItem(SB_STORAGE_KEYS.topbarLabelDesktopParts), []);
    sbState.topbarLabel.mobilePart = safeGetItem(SB_STORAGE_KEYS.topbarLabelMobilePart) === null
        ? 'char'
        : normalizeTopbarLabelPart(safeGetItem(SB_STORAGE_KEYS.topbarLabelMobilePart), '');
    sbState.topbarLabel.customText = normalizeTopbarCustomText(safeGetItem(SB_STORAGE_KEYS.topbarLabelCustomText));
    sbState.chatbar.visible = normalizeStoredBoolean(safeGetItem(SB_STORAGE_KEYS.chatbarVisible), sbState.chatbar.visible);
    sbState.chatbar.topbarOffset = normalizeTopbarOffset(safeGetItem(SB_STORAGE_KEYS.topbarOffset));
    sbState.compactMode = normalizeStoredBoolean(safeGetItem(SB_STORAGE_KEYS.compactMode), sbState.compactMode);
    sbState.shellSizing.snapToChatWidth = normalizeStoredBoolean(
        safeGetItem(SB_STORAGE_KEYS.desktopShellSnapToChatWidth),
        sbState.shellSizing.snapToChatWidth,
    );
    sbState.mobileNav.layout = normalizeMobileNavLayout(safeGetItem(SB_STORAGE_KEYS.mobileNavLayout));
    sbState.mobileNav.iconOnly = normalizeStoredBoolean(safeGetItem(SB_STORAGE_KEYS.mobileNavIconOnly), sbState.mobileNav.iconOnly);
    sbState.mobileNav.showCustomize = normalizeStoredBoolean(safeGetItem(SB_STORAGE_KEYS.mobileNavShowCustomize), sbState.mobileNav.showCustomize);
    sbState.mobileNav.showQuickActions = normalizeStoredBoolean(safeGetItem(SB_STORAGE_KEYS.mobileNavShowQuickActions), sbState.mobileNav.showQuickActions);
    sbState.mobileNav.replaceQuickActions = normalizeStoredBoolean(safeGetItem(SB_STORAGE_KEYS.mobileNavReplaceQuickActions), sbState.mobileNav.replaceQuickActions);
    sbState.mobileNav.replacementTarget = normalizeMobileNavReplacementTarget(safeGetItem(SB_STORAGE_KEYS.mobileNavReplacementTarget));
    sbState.desktopNav.layout = normalizeMobileNavLayout(safeGetItem(SB_STORAGE_KEYS.desktopNavLayout));
    sbState.desktopNav.iconOnly = normalizeStoredBoolean(safeGetItem(SB_STORAGE_KEYS.desktopNavIconOnly), sbState.desktopNav.iconOnly);
    sbState.desktopNav.showCustomize = normalizeStoredBoolean(safeGetItem(SB_STORAGE_KEYS.desktopNavShowCustomize), sbState.desktopNav.showCustomize);
    sbState.desktopNav.showQuickActions = normalizeStoredBoolean(safeGetItem(SB_STORAGE_KEYS.desktopNavShowQuickActions), sbState.desktopNav.showQuickActions);
    sbState.desktopNav.replaceQuickActions = normalizeStoredBoolean(safeGetItem(SB_STORAGE_KEYS.desktopNavReplaceQuickActions), sbState.desktopNav.replaceQuickActions);
    sbState.desktopNav.replacementTarget = normalizeMobileNavReplacementTarget(safeGetItem(SB_STORAGE_KEYS.desktopNavReplacementTarget));
    sbState.desktopQuickActions = loadDesktopQuickActions();
    sbState.mobileQuickActions = loadMobileQuickActions();
    sbState.characterDrawer.rightLocked = normalizeStoredBoolean(
        getPersistentStorageItem(SB_STORAGE_KEYS.characterDrawerRightLocked),
        sbState.characterDrawer.rightLocked,
    );
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
    const dragSurface = document.getElementById('sb-chatbar-layer');
    const renderedOffset = getRenderedTopbarOffset();

    getChatbarState().renderedTopbarOffset = renderedOffset;

    if (!(dragSurface instanceof HTMLElement)) {
        return;
    }

    dragSurface.style.setProperty('--sb-topbar-offset-x', `${renderedOffset.x}px`);
    dragSurface.style.setProperty('--sb-topbar-offset-y', `${renderedOffset.y}px`);
}

function setTopbarOffset(offset, { persist = true } = {}) {
    const nextOffset = normalizeTopbarOffset(offset);
    getChatbarState().topbarOffset = nextOffset;

    if (persist) {
        safeSetItem(SB_STORAGE_KEYS.topbarOffset, JSON.stringify(nextOffset));
    }

    applyTopbarOffset();
}

function setTopbarScale(mode, value, { persist = true } = {}) {
    const storageKey = mode === 'mobile'
        ? SB_STORAGE_KEYS.topbarScaleMobile
        : mode === 'desktop'
            ? SB_STORAGE_KEYS.topbarScaleDesktop
            : '';

    if (!storageKey) {
        return;
    }

    const nextScale = normalizeTopbarScale(value);
    const scaleFactor = Number((nextScale / 100).toFixed(2)).toString();

    sbState.topbarScale[mode] = nextScale;
    document.documentElement.style.setProperty(`--sb-topbar-scale-${mode}`, scaleFactor);

    if (persist) {
        safeSetItem(storageKey, String(nextScale));
    }

    if (getChatDesktopRefs()) {
        scheduleChatbarRefresh(0);
    }

    updateThemePickerUi();
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

function applyMobileNavPreferences() {
    const quickActionsShown = sbState.mobileNav.showQuickActions;
    const useIconOnly = sbState.mobileNav.layout === 'vertical' && sbState.mobileNav.iconOnly;
    document.documentElement.dataset.sbMobileNavLayout = sbState.mobileNav.layout;
    document.documentElement.dataset.sbMobileNavMode = useIconOnly ? 'icon-only' : 'labeled';
    document.documentElement.dataset.sbMobileNavCustomize = sbState.mobileNav.showCustomize ? 'shown' : 'hidden';
    document.documentElement.dataset.sbMobileNavQuickActions = quickActionsShown ? 'shown' : 'hidden';
    document.documentElement.dataset.sbMobileNavReplacement = sbState.mobileNav.replaceQuickActions ? 'shown' : 'hidden';
}

function applyDesktopNavPreferences() {
    const quickActionsShown = sbState.desktopNav.showQuickActions;
    const useIconOnly = sbState.desktopNav.layout === 'vertical' && sbState.desktopNav.iconOnly;
    document.documentElement.dataset.sbDesktopNavLayout = sbState.desktopNav.layout;
    document.documentElement.dataset.sbDesktopNavMode = useIconOnly ? 'icon-only' : 'labeled';
    document.documentElement.dataset.sbDesktopNavCustomize = sbState.desktopNav.showCustomize ? 'shown' : 'hidden';
    document.documentElement.dataset.sbDesktopNavQuickActions = quickActionsShown ? 'shown' : 'hidden';
    document.documentElement.dataset.sbDesktopNavReplacement = sbState.desktopNav.replaceQuickActions ? 'shown' : 'hidden';
}

function setMobileNavLayout(layout, { persist = true } = {}) {
    const nextLayout = normalizeMobileNavLayout(layout);
    sbState.mobileNav.layout = nextLayout;
    applyMobileNavPreferences();

    if (persist) {
        safeSetItem(SB_STORAGE_KEYS.mobileNavLayout, nextLayout);
    }

    syncMobileShellRailActions();
    updateThemePickerUi();
}

function setMobileNavIconOnly(enabled, { persist = true } = {}) {
    const nextEnabled = Boolean(enabled);
    sbState.mobileNav.iconOnly = nextEnabled;
    applyMobileNavPreferences();

    if (persist) {
        safeSetItem(SB_STORAGE_KEYS.mobileNavIconOnly, String(nextEnabled));
    }

    updateThemePickerUi();
}

function setMobileNavShowCustomize(enabled, { persist = true } = {}) {
    const nextEnabled = Boolean(enabled);
    sbState.mobileNav.showCustomize = nextEnabled;
    applyMobileNavPreferences();

    if (persist) {
        safeSetItem(SB_STORAGE_KEYS.mobileNavShowCustomize, String(nextEnabled));
    }

    syncMobileShellRailActions();
    updateThemePickerUi();
}

function setMobileNavShowQuickActions(enabled, { persist = true } = {}) {
    const nextEnabled = Boolean(enabled);
    sbState.mobileNav.showQuickActions = nextEnabled;
    applyMobileNavPreferences();

    if (persist) {
        safeSetItem(SB_STORAGE_KEYS.mobileNavShowQuickActions, String(nextEnabled));
    }

    refreshMobileNavQuickActions();
    syncMobileShellRailActions();
    updateThemePickerUi();
}

function setMobileNavReplaceQuickActions(enabled, { persist = true } = {}) {
    const nextEnabled = Boolean(enabled);
    sbState.mobileNav.replaceQuickActions = nextEnabled;
    applyMobileNavPreferences();

    if (persist) {
        safeSetItem(SB_STORAGE_KEYS.mobileNavReplaceQuickActions, String(nextEnabled));
    }

    refreshMobileNavQuickActions();
    syncMobileShellRailActions();
    updateMobileNavButtonLabel();
    updateThemePickerUi();
}

function setMobileNavReplacementTarget(target, { persist = true } = {}) {
    const nextTarget = normalizeMobileNavReplacementTarget(target);
    sbState.mobileNav.replacementTarget = nextTarget;

    if (persist) {
        safeSetItem(SB_STORAGE_KEYS.mobileNavReplacementTarget, nextTarget);
    }

    updateMobileNavButtonLabel();
    updateThemePickerUi();
}

function setDesktopNavLayout(layout, { persist = true } = {}) {
    const nextLayout = normalizeMobileNavLayout(layout);
    sbState.desktopNav.layout = nextLayout;
    applyDesktopNavPreferences();

    if (persist) {
        safeSetItem(SB_STORAGE_KEYS.desktopNavLayout, nextLayout);
    }

    syncMobileShellRailActions();
    updateThemePickerUi();
}

function setDesktopNavIconOnly(enabled, { persist = true } = {}) {
    const nextEnabled = Boolean(enabled);
    sbState.desktopNav.iconOnly = nextEnabled;
    applyDesktopNavPreferences();

    if (persist) {
        safeSetItem(SB_STORAGE_KEYS.desktopNavIconOnly, String(nextEnabled));
    }

    updateThemePickerUi();
}

function setDesktopNavShowCustomize(enabled, { persist = true } = {}) {
    const nextEnabled = Boolean(enabled);
    sbState.desktopNav.showCustomize = nextEnabled;
    applyDesktopNavPreferences();

    if (persist) {
        safeSetItem(SB_STORAGE_KEYS.desktopNavShowCustomize, String(nextEnabled));
    }

    syncMobileShellRailActions();
    updateThemePickerUi();
}

function setDesktopNavShowQuickActions(enabled, { persist = true } = {}) {
    const nextEnabled = Boolean(enabled);
    sbState.desktopNav.showQuickActions = nextEnabled;
    applyDesktopNavPreferences();

    if (persist) {
        safeSetItem(SB_STORAGE_KEYS.desktopNavShowQuickActions, String(nextEnabled));
    }

    syncMobileShellRailActions();
    updateThemePickerUi();
}

function setDesktopNavReplaceQuickActions(enabled, { persist = true } = {}) {
    const nextEnabled = Boolean(enabled);
    sbState.desktopNav.replaceQuickActions = nextEnabled;
    applyDesktopNavPreferences();

    if (persist) {
        safeSetItem(SB_STORAGE_KEYS.desktopNavReplaceQuickActions, String(nextEnabled));
    }

    syncMobileShellRailActions();
    updateThemePickerUi();
}

function setDesktopNavReplacementTarget(target, { persist = true } = {}) {
    const nextTarget = normalizeMobileNavReplacementTarget(target);
    sbState.desktopNav.replacementTarget = nextTarget;

    if (persist) {
        safeSetItem(SB_STORAGE_KEYS.desktopNavReplacementTarget, nextTarget);
    }

    syncMobileShellRailActions();
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

function setDesktopShellSnapToChatWidth(enabled, { persist = true } = {}) {
    const nextEnabled = Boolean(enabled);
    sbState.shellSizing.snapToChatWidth = nextEnabled;
    document.documentElement.dataset.sbDesktopShellSnapToChatWidth = String(nextEnabled);

    if (persist) {
        safeSetItem(SB_STORAGE_KEYS.desktopShellSnapToChatWidth, String(nextEnabled));
    }

    syncDesktopShellSizing();
    updateThemePickerUi();
}

function syncCharacterDrawerLockButton() {
    const button = document.getElementById('sb-character-right-lock');
    if (!(button instanceof HTMLButtonElement)) {
        return;
    }

    const isRightLocked = Boolean(sbState.characterDrawer.rightLocked);
    setButtonPressed(button, isRightLocked);
    button.title = isRightLocked ? 'Keep Characters centered' : 'Lock Characters to right';
    button.setAttribute('aria-label', button.title);
}

function syncCharacterDrawerLockPosition() {
    const panel = getCharacterPanel();
    if (!(panel instanceof HTMLElement)) {
        return;
    }

    if (isMovingUIActive()) {
        if (panel.dataset.sbCharacterLockInline === 'right') {
            for (const property of ['left', 'right', 'margin-left', 'margin-right']) {
                panel.style.removeProperty(property);
            }

            delete panel.dataset.sbCharacterLockInline;
        }

        return;
    }

    if (!sbState.characterDrawer.rightLocked || isMobileViewport()) {
        if (panel.dataset.sbCharacterLockInline === 'right') {
            for (const property of ['left', 'right', 'margin-left', 'margin-right']) {
                panel.style.removeProperty(property);
            }

            delete panel.dataset.sbCharacterLockInline;
        }
        return;
    }

    panel.style.setProperty('left', 'auto', 'important');
    panel.style.setProperty('right', '0px', 'important');
    panel.style.setProperty('margin-left', '0px', 'important');
    panel.style.setProperty('margin-right', '0px', 'important');
    panel.dataset.sbCharacterLockInline = 'right';
}

function setCharacterDrawerRightLock(enabled, { persist = true } = {}) {
    const nextEnabled = Boolean(enabled);
    sbState.characterDrawer.rightLocked = nextEnabled;
    document.documentElement.dataset.sbCharacterDrawerLock = nextEnabled ? 'right' : 'center';

    if (persist) {
        setPersistentStorageItem(SB_STORAGE_KEYS.characterDrawerRightLocked, String(nextEnabled));
    }

    syncCharacterDrawerLockPosition();
    syncCharacterDrawerLockButton();
}

function createElement(tagName, { id = '', className = '', text = '', html = '', attrs = {} } = {}) {
    const element = document.createElement(tagName);

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

function normalizeText(value) {
    return String(value ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function normalizeCharacterEditorSubTab(tabId) {
    const normalizedTabId = normalizeText(tabId);
    return SB_CHARACTER_EDITOR_SUB_TABS.includes(normalizedTabId) ? normalizedTabId : SB_CHARACTER_EDITOR_DEFAULT_SUB_TAB;
}

function isCharacterSpoilerFreeFieldsHidden() {
    const form = document.getElementById('form_create');
    return form instanceof HTMLElement && form.dataset.sbSpoilerFreeFieldsHidden === 'true';
}

function resolveCharacterEditorSubTab(tabId) {
    const normalizedTabId = normalizeCharacterEditorSubTab(tabId);
    if (!isCharacterSpoilerFreeFieldsHidden() || SB_CHARACTER_EDITOR_SPOILER_FREE_VISIBLE_TABS.includes(normalizedTabId)) {
        return normalizedTabId;
    }

    return 'metadata';
}

function isCharacterEditorMenuType(menuType) {
    return ['character_edit', 'create'].includes(menuType ?? '');
}

function clampText(value, maxLength = 120) {
    const normalizedValue = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (normalizedValue.length <= maxLength) {
        return normalizedValue;
    }

    return `${normalizedValue.slice(0, maxLength - 1).trimEnd()}…`;
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
        element.textContent,
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

function getSearchText(element, sectionLabel = '') {
    return normalizeText([
        ...getSearchTextCandidates(element),
        sectionLabel,
    ].join(' '));
}

function getPersonaSearchAvatarId(element) {
    if (!(element instanceof HTMLElement)) {
        return '';
    }

    const directAvatarId = element.closest('.avatar-container[data-avatar-id], .avatar[data-avatar-id]')?.getAttribute('data-avatar-id');
    if (directAvatarId) {
        return directAvatarId;
    }

    if (!element.matches('.persona_name')) {
        return '';
    }

    return document.querySelector('#user_avatar_block .avatar-container.selected[data-avatar-id]')?.getAttribute('data-avatar-id')
        ?? '';
}

function getSearchEntryDedupeKey(tabState, sectionLabel, displayText, { element = null, avatarId = '' } = {}) {
    const personaAvatarId = tabState.id === 'persona'
        ? normalizeText(
            avatarId
            || getPersonaSearchAvatarId(element),
        )
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

function renderSearchEmptyState(container, title, detail) {
    container.replaceChildren();

    const empty = createElement('div', { className: 'sb-search-empty' });
    const emptyTitle = createElement('strong', { text: title });
    const emptyCopy = createElement('span', { text: detail });
    empty.append(emptyTitle, emptyCopy);
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
        searchState.results?.classList.remove('is-visible');
        if (wasOpen) {
            requestMobileViewportReset({ restoreScroll: true });
        }
    } else {
        renderUniversalSearchResults(input?.value ?? '');
    }

    if (focusInput && input instanceof HTMLInputElement) {
        focusUniversalSearchInput(input);
    }

    queueMobileShellDrawerBoundsSync();
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

function getCharacterPanelSearchEntries() {
    const panel = getCharacterPanel();

    return SB_CHARACTER_PANEL_TABS.map((tab) => {
        const button = panel?.querySelector(`[data-sb-character-tab="${CSS.escape(tab.id)}"]`);
        const searchText = normalizeText([tab.label, tab.id, 'characters'].join(' '));

        return {
            element: button instanceof HTMLElement ? button : null,
            searchText,
            displayText: tab.label,
            sectionLabel: tab.label,
            tabId: tab.id,
            tabLabel: tab.label,
            dedupeKey: `characters::${tab.id}`,
        };
    });
}

function isMobileViewport() {
    return window.matchMedia(SB_MOBILE_MEDIA_QUERY).matches;
}

function prefersReducedMotion() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function getShellProxyButton(shellKey) {
    const shellConfig = getShellConfig(shellKey);
    const proxyButton = shellConfig?.proxyButtonId ? document.getElementById(shellConfig.proxyButtonId) : null;
    return proxyButton instanceof HTMLElement ? proxyButton : null;
}

function getShellActivePanel(shellState) {
    return shellState?.tabs.get(shellState.activeTabId)?.panel ?? null;
}

function getShellFocusTarget(shellState) {
    if (shellState?.headerTitle instanceof HTMLElement) {
        return shellState.headerTitle;
    }

    const panel = getShellActivePanel(shellState);
    const focusable = Array.from(panel?.querySelectorAll(SB_SHELL_FOCUSABLE_SELECTOR) ?? [])
        .find(element => element instanceof HTMLElement
            && isActuallyVisible(element)
            && !element.closest('[hidden], [aria-hidden="true"], [inert]'));

    if (focusable instanceof HTMLElement) {
        return focusable;
    }

    return shellState?.nav instanceof HTMLElement ? shellState.nav : null;
}

function focusShellPanel(shellKey, { force = false } = {}) {
    const shellState = getShellState(shellKey);
    const shellRoot = shellState?.root;

    if (!(shellRoot instanceof HTMLElement) || !shellRoot.classList.contains('openDrawer')) {
        return;
    }

    const activeElement = document.activeElement;
    if (!force && activeElement instanceof HTMLElement && shellRoot.contains(activeElement)) {
        return;
    }

    const target = getShellFocusTarget(shellState);
    if (target instanceof HTMLElement) {
        target.focus({ preventScroll: true });
    }
}

function rememberShellFocusOrigin(shellKey) {
    const shellState = getShellState(shellKey);
    const shellRoot = shellState?.root;
    const activeElement = document.activeElement;

    if (!shellState || !(activeElement instanceof HTMLElement)) {
        return;
    }

    if (shellRoot instanceof HTMLElement && shellRoot.contains(activeElement)) {
        return;
    }

    shellState.restoreFocusTarget = activeElement;
}

function restoreShellFocus(shellKey) {
    const shellState = getShellState(shellKey);
    const restoreTarget = shellState?.restoreFocusTarget;
    const proxyButton = getShellProxyButton(shellKey);
    const target = restoreTarget instanceof HTMLElement && document.contains(restoreTarget)
        ? restoreTarget
        : proxyButton;

    if (shellState) {
        delete shellState.restoreFocusTarget;
    }

    if (target instanceof HTMLElement && !target.hasAttribute('disabled')) {
        target.focus({ preventScroll: true });
    }
}

function scrollShellTabButtonIntoView(nav, button, { smooth = false } = {}) {
    if (!(nav instanceof HTMLElement) || !(button instanceof HTMLElement)) {
        return;
    }

    if (!isActuallyVisible(button)) {
        return;
    }

    const navRect = nav.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    const leftOverflow = buttonRect.left - navRect.left;
    const rightOverflow = buttonRect.right - navRect.right;

    if (leftOverflow >= 0 && rightOverflow <= 0) {
        return;
    }

    nav.scrollBy({
        left: leftOverflow < 0 ? leftOverflow : rightOverflow,
        behavior: smooth && !prefersReducedMotion() ? 'smooth' : 'auto',
    });
}

function isTouchOnlyDesktopViewport() {
    const hasHover = window.matchMedia('(hover: hover), (any-hover: hover)').matches;
    const hasFinePointer = window.matchMedia('(pointer: fine), (any-pointer: fine)').matches;
    const isTouchMac = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;

    return isTouchMac || (navigator.maxTouchPoints > 0 && !hasHover && !hasFinePointer);
}

function canResizeDesktopShells() {
    return !isMobileViewport() && !isTouchOnlyDesktopViewport();
}

function readFiniteViewportNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function getShellViewportSize() {
    const doc = document.documentElement;
    const visualViewport = window.visualViewport;
    const fallbackWidth = window.innerWidth || doc?.clientWidth || 0;
    const fallbackHeight = window.innerHeight || doc?.clientHeight || 0;
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

function syncShellViewportBounds() {
    if (sbIsSyncingRailActions) {
        return;
    }

    const root = document.documentElement;
    const viewportSize = getShellViewportSize();
    const topOffset = Math.max(0, Math.round(getResolvedShellTopbarOffset()));

    root.style.setProperty('--sb-shell-viewport-height', `${viewportSize.height}px`);
    root.style.setProperty('--sb-shell-measured-top-offset', `${topOffset}px`);
    root.style.setProperty('--sb-shell-available-height', `${Math.max(0, viewportSize.height - topOffset)}px`);
    // SillyBunny: iOS Safari shifts the visual viewport (visualViewport.offsetTop > 0)
    // when the keyboard opens; without this var the shell stays anchored at
    // the layout viewport top and the composer floats mid-screen.
    root.style.setProperty('--sb-shell-viewport-top', `${viewportSize.top}px`);
}

function getMobileShellBoundDrawers() {
    return Array.from(new Set([
        ...document.querySelectorAll('#left-nav-panel, #user-settings-block, .sb-shell-root, #right-nav-panel'),
        ...document.querySelectorAll('#top-settings-holder #right-nav-panel'),
    ])).filter(drawer => drawer instanceof HTMLElement);
}

function applyMobileDrawerBoundsDecision(drawer, decision) {
    if (!(drawer instanceof HTMLElement) || !decision) {
        return;
    }

    if (decision.action === sbMobileShellLifecycle.drawerBounds.action.BIND) {
        drawer.dataset.sbMobileViewportBound = 'true';
    } else if (decision.action === sbMobileShellLifecycle.drawerBounds.action.CLEAR) {
        delete drawer.dataset.sbMobileViewportBound;
    }

    for (const property of decision.styleRemovals) {
        drawer.style.removeProperty(property);
    }

    for (const { property, value, priority } of decision.styleWrites) {
        drawer.style.setProperty(property, value, priority);
    }
}

function syncMobileShellDrawerBounds() {
    const drawers = getMobileShellBoundDrawers();

    if (!drawers.length) {
        return;
    }

    const mobileViewport = isMobileViewport();
    const viewportSize = mobileViewport ? getShellViewportSize() : null;
    const baseTopOffset = mobileViewport ? getResolvedShellTopbarOffset() : 0;

    for (const drawer of drawers) {
        const isOpen = drawer.classList.contains('openDrawer');
        const drawerStyles = mobileViewport && isOpen ? window.getComputedStyle(drawer) : null;

        applyMobileDrawerBoundsDecision(drawer, sbMobileShellLifecycle.drawerBounds.resolveBounds({
            isMobileViewport: mobileViewport,
            isOpen,
            isViewportBound: drawer.dataset.sbMobileViewportBound === 'true',
            viewportHeight: viewportSize?.height ?? 0,
            baseTopOffset,
            shellGap: drawerStyles ? Number.parseFloat(drawerStyles.getPropertyValue('--sb-mobile-shell-gap')) || 0 : 0,
        }));
    }
}

function queueMobileShellDrawerBoundsSync() {
    const schedule = sbMobileShellLifecycle.viewportSync.resolveDrawerBoundsSchedule({
        isMobileViewport: isMobileViewport(),
        hasAnimationFrame: typeof window.requestAnimationFrame === 'function',
        followupDelayMs: SB_MOBILE_VIEWPORT_RESET_FOLLOWUP_MS,
    });

    if (!schedule.shouldSchedule) {
        return;
    }

    const sync = () => {
        syncShellViewportBounds();
        syncMobileShellDrawerBounds();
    };

    if (schedule.useAnimationFrame) {
        window.requestAnimationFrame(sync);
    } else {
        sync();
    }

    window.setTimeout(sync, schedule.followupDelayMs);
}

function isMovingUIActive() {
    return document.body?.classList.contains('movingUI') ?? false;
}

function isDesktopResizableShell(shellKey) {
    return shellKey === 'left' || shellKey === 'right' || shellKey === 'characters';
}

function getShellSizingKey(shellKey) {
    return ['left', 'right', 'characters'].includes(shellKey) ? 'right' : shellKey;
}

function getShellAccountStorage() {
    const storage = getSillyTavernContext()?.accountStorage;

    if (!storage || typeof storage.getState !== 'function') {
        return null;
    }

    try {
        const snapshot = storage.getState();
        return snapshot && Object.hasOwn(snapshot, SB_ACCOUNT_STORAGE_READY_MARKER) ? storage : null;
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

function getPersistedShellSize(shellKey) {
    const storageKey = getShellSizeStorageKey(shellKey);

    if (!storageKey) {
        return null;
    }

    const localSize = normalizeShellSize(safeGetItem(storageKey));
    const accountStorage = getShellAccountStorage();
    const accountSize = accountStorage ? normalizeShellSize(accountStorage.getItem(storageKey)) : null;

    if (accountSize) {
        if (!areShellSizesEqual(localSize, accountSize)) {
            safeSetItem(storageKey, JSON.stringify(accountSize));
        }

        return accountSize;
    }

    if (localSize && accountStorage) {
        accountStorage.setItem(storageKey, JSON.stringify(localSize));
    }

    return localSize;
}

function hydratePersistedShellSizes() {
    const persistedSize = getPersistedShellSize('right') ?? getPersistedShellSize('left');

    if (persistedSize) {
        sbState.shellSizing.overrides.left = persistedSize;
        sbState.shellSizing.overrides.right = persistedSize;
    }
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

function getShellViewportTop(root, viewportSize = getShellViewportSize()) {
    let top = getResolvedShellTopbarOffset();

    if (root instanceof HTMLElement && root.classList.contains('openDrawer') && root.getClientRects().length > 0) {
        const rect = root.getBoundingClientRect();
        if (Number.isFinite(rect.top)) {
            top = rect.top;
        }
    }

    return clampNumber(Math.round(top), viewportSize.top, viewportSize.bottom);
}

function getChatViewportWidth(viewportSize = getShellViewportSize()) {
    const chatShell = document.getElementById('sheld');

    if (chatShell instanceof HTMLElement && chatShell.getClientRects().length > 0) {
        const rect = chatShell.getBoundingClientRect();
        const visibleWidth = Math.min(rect.right, viewportSize.right) - Math.max(rect.left, viewportSize.left);

        if (Number.isFinite(visibleWidth) && visibleWidth > 0) {
            return Math.round(visibleWidth);
        }
    }

    const sheldWidthStr = window.getComputedStyle(document.documentElement).getPropertyValue('--sheldWidth').trim();
    const sheldWidthValue = Number.parseFloat(sheldWidthStr);

    if (!Number.isFinite(sheldWidthValue)) {
        return viewportSize.width;
    }

    if (sheldWidthStr.endsWith('px')) {
        return Math.round(sheldWidthValue);
    }

    return Math.round((sheldWidthValue / 100) * viewportSize.width);
}

function isShellSnapToChatWidthEnabled(shellKey) {
    return Boolean(sbState.shellSizing.snapToChatWidth)
        && isDesktopResizableShell(shellKey)
        && !isMobileViewport();
}

function getShellSizeStorageKey(shellKey) {
    const sizingKey = getShellSizingKey(shellKey);

    if (sizingKey === 'left') {
        return SB_STORAGE_KEYS.leftShellSize;
    }

    if (sizingKey === 'right') {
        return SB_STORAGE_KEYS.rightShellSize;
    }

    return '';
}

function getDesktopShellDimensions(shellKey = '') {
    const viewportSize = getShellViewportSize();
    const viewportWidth = viewportSize.width;
    const viewportHeight = viewportSize.height;
    const maxShellWidth = shellKey === 'right' ? Math.min(SB_DESKTOP_SHELL_LAYOUT.maxWidth, 760) : SB_DESKTOP_SHELL_LAYOUT.maxWidth;

    if (isShellSnapToChatWidthEnabled(shellKey)) {
        const snappedWidth = clampNumber(
            getChatViewportWidth(viewportSize),
            Math.min(SB_DESKTOP_SHELL_LAYOUT.minWidth, viewportWidth),
            viewportWidth,
        );

        return {
            width: snappedWidth,
            maxWidth: snappedWidth,
        };
    }

    if (
        ['left', 'right'].includes(shellKey)
        && viewportWidth >= SB_DESKTOP_SHELL_LAYOUT.laptopViewportMin
        && viewportWidth <= SB_DESKTOP_SHELL_LAYOUT.laptopViewportMax
    ) {
        const laptopWidth = clampNumber(
            viewportWidth * SB_DESKTOP_SHELL_LAYOUT.laptopRatio,
            SB_DESKTOP_SHELL_LAYOUT.laptopMinWidth,
            SB_DESKTOP_SHELL_LAYOUT.laptopMaxWidth,
        );
        const maxWidth = Math.max(0, viewportWidth - SB_DESKTOP_SHELL_LAYOUT.laptopGutter);
        const resolvedWidth = Math.min(laptopWidth, maxWidth);

        return {
            width: resolvedWidth,
            maxWidth: resolvedWidth,
        };
    }

    if (isMobileViewport() || (viewportHeight <= SB_DESKTOP_SHELL_LAYOUT.fullWidthMaxHeight && shellKey !== 'characters')) {
        return {
            width: viewportWidth,
            maxWidth: viewportWidth,
        };
    }

    if (viewportWidth <= SB_DESKTOP_SHELL_LAYOUT.compactViewportWidth) {
        const compactWidth = Math.max(0, Math.min(SB_DESKTOP_SHELL_LAYOUT.compactMaxWidth, viewportWidth - SB_DESKTOP_SHELL_LAYOUT.compactGap));
        return {
            width: compactWidth,
            maxWidth: compactWidth,
        };
    }

    // SillyBunny: cap shell width to the active chat width (--sheldWidth) so settings
    // panels narrow when the user reduces the chat width, matching standard ST behaviour.
    const sheldWidthStr = window.getComputedStyle(document.documentElement).getPropertyValue('--sheldWidth').trim();
    const sheldWidthVw = parseFloat(sheldWidthStr);
    const chatWidthPx = Number.isFinite(sheldWidthVw) ? Math.round((sheldWidthVw / 100) * viewportWidth) : viewportWidth;
    const desiredWidth = clampNumber(
        Math.min(viewportWidth * SB_DESKTOP_SHELL_LAYOUT.ratio, chatWidthPx),
        SB_DESKTOP_SHELL_LAYOUT.minWidth,
        maxShellWidth,
    );
    const gutter = clampNumber(
        viewportWidth * SB_DESKTOP_SHELL_LAYOUT.gutterRatio,
        SB_DESKTOP_SHELL_LAYOUT.gutterMin,
        SB_DESKTOP_SHELL_LAYOUT.gutterMax,
    );
    const maxWidth = Math.max(0, viewportWidth - gutter);
    const resolvedWidth = Math.min(desiredWidth, maxWidth);

    return {
        width: resolvedWidth,
        maxWidth: resolvedWidth,
    };
}

function getDesktopShellResizeBounds(shellKey = '') {
    const viewportSize = getShellViewportSize();
    const viewportWidth = Math.max(0, Math.round(viewportSize.width));
    const viewportHeight = Math.max(0, Math.round(viewportSize.height));
    const root = isDesktopResizableShell(shellKey) ? getResizableShellRoot(shellKey) : null;
    const shellTop = getShellViewportTop(root, viewportSize);
    const defaultDimensions = getDesktopShellDimensions(shellKey);
    const defaultWidth = Math.max(0, Math.min(Math.round(defaultDimensions.width), viewportWidth));
    const snapWidth = isShellSnapToChatWidthEnabled(shellKey) ? defaultWidth : null;
    const maxHeight = Math.max(0, Math.round(viewportHeight - shellTop - SB_DESKTOP_SHELL_RESIZE.bottomGap));

    return {
        defaultWidth,
        defaultHeight: maxHeight,
        minWidth: snapWidth ?? Math.min(SB_DESKTOP_SHELL_RESIZE.minWidth, viewportWidth),
        maxWidth: snapWidth ?? viewportWidth,
        minHeight: Math.min(SB_DESKTOP_SHELL_RESIZE.minHeight, maxHeight),
        maxHeight,
    };
}

function clampShellSize(size, bounds = getDesktopShellResizeBounds()) {
    const normalizedSize = normalizeShellSize(size);

    if (!normalizedSize) {
        return null;
    }

    return {
        width: clampNumber(normalizedSize.width, bounds.minWidth, bounds.maxWidth),
        height: clampNumber(normalizedSize.height, bounds.minHeight, bounds.maxHeight),
    };
}

function areShellSizesEqual(left, right) {
    return Boolean(left) && Boolean(right)
        && left.width === right.width
        && left.height === right.height;
}

function getShellSizeOverride(shellKey) {
    return isDesktopResizableShell(shellKey) ? sbState.shellSizing.overrides.right ?? sbState.shellSizing.overrides.left ?? null : null;
}

function setShellSizeOverride(shellKey, size, { persist = true } = {}) {
    if (!isDesktopResizableShell(shellKey)) {
        return null;
    }

    const nextSize = clampShellSize(size, getDesktopShellResizeBounds(shellKey));

    sbState.shellSizing.overrides.left = nextSize;
    sbState.shellSizing.overrides.right = nextSize;

    if (!persist) {
        return nextSize;
    }

    const accountStorage = getShellAccountStorage();
    const storageKeys = [SB_STORAGE_KEYS.leftShellSize, SB_STORAGE_KEYS.rightShellSize];

    if (nextSize) {
        const serializedSize = JSON.stringify(nextSize);
        for (const storageKey of storageKeys) {
            safeSetItem(storageKey, serializedSize);
            accountStorage?.setItem(storageKey, serializedSize);
        }
    } else {
        for (const storageKey of storageKeys) {
            safeRemoveItem(storageKey);
            accountStorage?.removeItem(storageKey);
        }
    }

    return nextSize;
}

function applyDesktopShellSize(root, size) {
    root.style.setProperty('width', `${size.width}px`, 'important');
    root.style.setProperty('max-width', `${size.width}px`, 'important');
    root.style.setProperty('height', `${size.height}px`, 'important');
    root.style.setProperty('max-height', `${size.height}px`, 'important');
    root.dataset.sbShellInlineSize = 'true';
}

function clearDesktopShellSize(root) {
    root.style.removeProperty('width');
    root.style.removeProperty('max-width');
    root.style.removeProperty('height');
    root.style.removeProperty('max-height');
    delete root.dataset.sbShellInlineSize;
}

function syncDesktopShellSizing() {
    if (sbIsSyncingRailActions) {
        return;
    }

    hydratePersistedShellSizes();

    const resizingEnabled = canResizeDesktopShells();

    for (const shellKey of ['left', 'right', 'characters']) {
        const root = shellKey === 'characters'
            ? getCharacterPanel()
            : document.getElementById(getShellConfig(shellKey).rootPanelId);
        if (!(root instanceof HTMLElement)) {
            continue;
        }

        const dimensions = getDesktopShellDimensions(shellKey);
        const bounds = getDesktopShellResizeBounds(shellKey);

        if (isMobileViewport()) {
            clearDesktopShellSize(root);
            root.classList.remove('sb-shell-can-resize');
            syncShellResizeHandleValue(shellKey, null);
            continue;
        }

        if (shellKey === 'characters' && isMovingUIActive()) {
            if (root.dataset.sbShellInlineSize === 'true') {
                clearDesktopShellSize(root);
            }

            root.classList.remove('sb-shell-can-resize');
            syncShellResizeHandleValue(shellKey, null);
            continue;
        }

        const { width } = dimensions;
        let sizeToApply = {
            width,
            height: bounds.defaultHeight,
        };

        const storedOverride = getShellSizeOverride(shellKey);
        if (resizingEnabled && storedOverride) {
            const clampedOverride = clampShellSize(storedOverride, bounds);
            if (clampedOverride) {
                sizeToApply = clampedOverride;

                if (!areShellSizesEqual(storedOverride, clampedOverride)) {
                    setShellSizeOverride(shellKey, clampedOverride);
                } else {
                    sbState.shellSizing.overrides[getShellSizingKey(shellKey)] = clampedOverride;
                }
            }
        }

        applyDesktopShellSize(root, sizeToApply);
        root.classList.toggle('sb-shell-can-resize', resizingEnabled);
        syncShellResizeHandleValue(shellKey, sizeToApply);
    }

    syncCharacterDrawerLockPosition();
}

function getResizableShellRoot(shellKey) {
    if (shellKey === 'characters') {
        return getCharacterPanel();
    }

    return document.getElementById(getShellConfig(shellKey).rootPanelId);
}

function isPrimaryShellResizeStart(event) {
    if (event && 'isPrimary' in event && event.isPrimary === false) {
        return false;
    }

    return event?.button === undefined || event.button === 0 || event.pointerType === 'touch';
}

function bindShellResizeHandle(handle, shellKey) {
    stopProxyPointerPropagation(handle);
    configureShellResizeHandle(handle, shellKey);
    handle.addEventListener('pointerdown', event => beginShellResize(shellKey, event));
    handle.addEventListener('mousedown', event => {
        if (event.defaultPrevented || sbState.shellSizing.activeResize) {
            return;
        }

        beginShellResize(shellKey, event);
    });
    handle.addEventListener('keydown', event => handleShellResizeKeydown(shellKey, event));
}

function configureShellResizeHandle(handle, shellKey) {
    const bounds = getDesktopShellResizeBounds(shellKey);
    const currentSize = getShellSizeOverride(shellKey) ?? {
        width: bounds.defaultWidth,
        height: bounds.defaultHeight,
    };
    const label = shellKey === 'characters' ? 'Characters' : getShellConfig(shellKey)?.title || 'panel';

    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-orientation', 'horizontal');
    handle.setAttribute('aria-label', `Resize ${label} panel`);
    handle.setAttribute('aria-valuemin', String(bounds.minWidth));
    handle.setAttribute('aria-valuemax', String(bounds.maxWidth));
    handle.setAttribute('aria-valuenow', String(Math.round(currentSize.width)));
    handle.setAttribute('aria-valuetext', `${Math.round(currentSize.width)} pixels wide, ${Math.round(currentSize.height)} pixels tall`);
    handle.tabIndex = canResizeDesktopShells() ? 0 : -1;
}

function syncShellResizeHandleValue(shellKey, size) {
    const root = getResizableShellRoot(shellKey);
    const shellState = getShellState(shellKey);
    const handle = shellState?.resizeHandle ?? root?.querySelector(':scope > .sb-shell-resize-handle, .sb-shell-resize-handle');
    if (!(handle instanceof HTMLElement)) {
        return;
    }

    if (!size) {
        configureShellResizeHandle(handle, shellKey);
        return;
    }

    configureShellResizeHandle(handle, shellKey);
    handle.setAttribute('aria-valuenow', String(Math.round(size.width)));
    handle.setAttribute('aria-valuetext', `${Math.round(size.width)} pixels wide, ${Math.round(size.height)} pixels tall`);
}

function handleShellResizeKeydown(shellKey, event) {
    if (!canResizeDesktopShells() || !isDesktopResizableShell(shellKey)) {
        return;
    }

    const root = getResizableShellRoot(shellKey);
    if (!(root instanceof HTMLElement) || !root.classList.contains('openDrawer')) {
        return;
    }

    const bounds = getDesktopShellResizeBounds(shellKey);
    const currentRect = root.getBoundingClientRect();
    const currentSize = clampShellSize({
        width: currentRect.width || bounds.defaultWidth,
        height: currentRect.height || bounds.defaultHeight,
    }, bounds);

    if (!currentSize) {
        return;
    }

    const step = event.shiftKey ? 72 : 24;
    let nextSize = currentSize;

    if (event.key === 'ArrowLeft') {
        nextSize = { ...currentSize, width: currentSize.width - step };
    } else if (event.key === 'ArrowRight') {
        nextSize = { ...currentSize, width: currentSize.width + step };
    } else if (event.key === 'ArrowUp') {
        nextSize = { ...currentSize, height: currentSize.height - step };
    } else if (event.key === 'ArrowDown') {
        nextSize = { ...currentSize, height: currentSize.height + step };
    } else if (event.key === 'Home') {
        nextSize = { ...currentSize, width: bounds.minWidth };
    } else if (event.key === 'End') {
        nextSize = { ...currentSize, width: bounds.maxWidth };
    } else {
        return;
    }

    const clampedSize = clampShellSize(nextSize, bounds);
    if (!clampedSize) {
        return;
    }

    event.preventDefault();
    setShellSizeOverride(shellKey, clampedSize);
    applyDesktopShellSize(root, clampedSize);
    syncShellResizeHandleValue(shellKey, clampedSize);
}

function beginShellResize(shellKey, event) {
    if (!canResizeDesktopShells() || !isDesktopResizableShell(shellKey) || !isPrimaryShellResizeStart(event)) {
        return;
    }

    if (shellKey === 'characters' && isMovingUIActive()) {
        return;
    }

    const root = getResizableShellRoot(shellKey);
    if (!(root instanceof HTMLElement) || !root.classList.contains('openDrawer')) {
        return;
    }

    if (typeof sbState.shellSizing.activeResize?.cleanup === 'function') {
        sbState.shellSizing.activeResize.cleanup();
    }

    const handle = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    const bounds = getDesktopShellResizeBounds(shellKey);
    const startRect = root.getBoundingClientRect();
    const startSize = clampShellSize({
        width: startRect.width || bounds.defaultWidth,
        height: startRect.height || bounds.defaultHeight,
    }, bounds);

    if (!startSize) {
        return;
    }

    event.preventDefault();
    event.stopPropagation();
    document.body.classList.add('sb-shell-resizing');
    root.classList.add('sb-shell-resize-active');
    setShellSizeOverride(shellKey, startSize, { persist: false });

    const pointerId = typeof event.pointerId === 'number' ? event.pointerId : null;
    const moveEventName = pointerId === null ? 'mousemove' : 'pointermove';
    const upEventName = pointerId === null ? 'mouseup' : 'pointerup';
    const cancelEventName = pointerId === null ? 'mouseleave' : 'pointercancel';

    const cleanup = () => {
        if (pointerId !== null && handle && typeof handle.releasePointerCapture === 'function') {
            try {
                handle.releasePointerCapture(pointerId);
            } catch {
                // Ignore pointer capture cleanup failures.
            }
        }

        window.removeEventListener(moveEventName, onPointerMove);
        window.removeEventListener(upEventName, onPointerUp);
        window.removeEventListener(cancelEventName, onPointerUp);
        document.body.classList.remove('sb-shell-resizing');
        root.classList.remove('sb-shell-resize-active');

        if (sbState.shellSizing.activeResize?.pointerId === pointerId) {
            sbState.shellSizing.activeResize = null;
        }
    };

    const onPointerMove = moveEvent => {
        if (pointerId !== null && moveEvent.pointerId !== pointerId) {
            return;
        }

        moveEvent.preventDefault();
        const widthDelta = shellKey === 'characters' && sbState.characterDrawer.rightLocked
            ? event.clientX - moveEvent.clientX
            : moveEvent.clientX - event.clientX;
        const nextSize = clampShellSize({
            width: startSize.width + widthDelta,
            height: startSize.height + (moveEvent.clientY - event.clientY),
        }, bounds);

        if (!nextSize) {
            return;
        }

        sbState.shellSizing.overrides[getShellSizingKey(shellKey)] = nextSize;
        applyDesktopShellSize(root, nextSize);
        syncShellResizeHandleValue(shellKey, nextSize);
    };

    const onPointerUp = endEvent => {
        if (pointerId !== null && endEvent.pointerId !== pointerId) {
            return;
        }

        const activeSize = getShellSizeOverride(shellKey) ?? startSize;
        cleanup();
        setShellSizeOverride(shellKey, activeSize);
        syncShellResizeHandleValue(shellKey, activeSize);
        syncDesktopShellSizing();
    };

    sbState.shellSizing.activeResize = {
        shellKey,
        pointerId,
        cleanup,
    };

    if (pointerId !== null && handle && typeof handle.setPointerCapture === 'function') {
        try {
            handle.setPointerCapture(pointerId);
        } catch {
            // Ignore pointer capture failures.
        }
    }

    window.addEventListener(moveEventName, onPointerMove);
    window.addEventListener(upEventName, onPointerUp);
    window.addEventListener(cancelEventName, onPointerUp);
}

function ensureShellReady(shellKey) {
    if (!getShellConfig(shellKey)) {
        return false;
    }

    if (getShellState(shellKey)) {
        return true;
    }

    buildShell(shellKey);
    return Boolean(getShellState(shellKey));
}

function syncExistingMobileNavQuickActions(overlay) {
    if (!(overlay instanceof HTMLElement)) {
        return;
    }

    const list = overlay.querySelector('.sb-mobile-quick-action-list')
        ?? overlay.querySelector('.sb-mobile-section-list');
    if (list instanceof HTMLElement) {
        sbState.mobileNav.quickActionContainer = list;
        const quickActionSection = list.closest('.sb-mobile-quick-action-section');
        if (quickActionSection instanceof HTMLElement) {
            sbState.mobileNav.quickActionSection = quickActionSection;
        }
        refreshMobileNavQuickActions();
    }
}

function ensureMobileNavReady() {
    const existingOverlay = document.getElementById('sb-mobile-nav');
    if (existingOverlay instanceof HTMLElement) {
        syncExistingMobileNavQuickActions(existingOverlay);
        return existingOverlay;
    }

    buildMobileNav();
    const overlay = document.getElementById('sb-mobile-nav');
    syncExistingMobileNavQuickActions(overlay);
    return overlay;
}

function getThemeOption(themeId) {
    return SB_THEMES.find(theme => theme.id === themeId) ?? SB_THEMES[0];
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

function safeDecodeUriComponent(value) {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

function parseChatAvatarSource(rawSrc) {
    const normalizedSrc = stripAvatarOrigin(rawSrc);
    if (!normalizedSrc) {
        return null;
    }

    const trimmedSrc = normalizedSrc.startsWith('/') ? normalizedSrc.slice(1) : normalizedSrc;

    try {
        const parsedUrl = new URL(normalizedSrc, window.location.origin);
        if (parsedUrl.pathname.endsWith('thumbnail')) {
            const type = parsedUrl.searchParams.get('type');
            const file = parsedUrl.searchParams.get('file');

            if (type && file) {
                return { type, file: safeDecodeUriComponent(file) };
            }
        }
    } catch {
        // Fall back to direct path inspection below.
    }

    if (trimmedSrc.startsWith('characters/')) {
        return { type: 'avatar', file: trimmedSrc.replace(/^characters\//, '') };
    }

    if (trimmedSrc.startsWith('User Avatars/')) {
        return { type: 'persona', file: trimmedSrc.replace(/^User Avatars\//, '') };
    }

    return { type: null, file: normalizedSrc };
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
    const avatarInfo = parseChatAvatarSource(rawSrc);
    if (!avatarInfo) {
        return { thumb: '', original: '' };
    }

    const { type, file } = avatarInfo;
    const thumb = type === 'avatar' || type === 'persona'
        ? `/thumbnail?type=${type}&file=${encodeURIComponent(file)}`
        : ensureAvatarPath(file);
    const original = type === 'avatar'
        ? ensureAvatarPath(`characters/${file}`)
        : type === 'persona'
            ? ensureAvatarPath(`User Avatars/${file}`)
            : ensureAvatarPath(file);

    return {
        thumb: stripAvatarOrigin(thumb),
        original: stripAvatarOrigin(original),
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

        const srcCandidate = avatarImg.getAttribute('src') || avatarImg.getAttribute('data-src') || avatarImg.currentSrc;
        const { thumb, original } = getChatAvatarSources(srcCandidate);

        if (!thumb && !original) {
            continue;
        }

        const thumbUrl = thumb || original;
        const originalUrl = original || thumbUrl;
        const displayUrl = originalUrl || thumbUrl;

        message.dataset.avatarThumb = thumbUrl;
        message.dataset.avatarOriginal = originalUrl;
        message.dataset.avatar = displayUrl;
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
        attributeFilter: ['src', 'data-src'],
    });

    sbState.chatAvatars.observer = observer;
    document.addEventListener('sb:chat-style-updated', () => scheduleChatAvatarVariableUpdate(0));
}

function setShellTheme(themeId, { persist = true } = {}) {
    const nextTheme = normalizeTheme(themeId);

    sbState.theme = nextTheme;
    document.documentElement.dataset.sbTheme = nextTheme;

    if (persist) {
        safeSetItem(SB_STORAGE_KEYS.theme, nextTheme);
    }

    updateThemePickerUi();
    updateThemeBadge();
}

function applyFrontendIcon(iconId = sbState.frontendIcon) {
    const normalizedIconId = normalizeFrontendIcon(iconId);
    const iconController = window.SillyBunnyFrontendIcon;

    if (iconController?.apply) {
        iconController.apply(normalizedIconId);
        return;
    }

    const iconSrc = getFrontendIconSrc(normalizedIconId);

    document.documentElement.dataset.sbFrontendIcon = normalizedIconId;

    for (const image of document.querySelectorAll('img[data-sb-frontend-icon]')) {
        image.setAttribute('src', iconSrc);
    }

    for (const link of document.querySelectorAll('link[rel~="icon"]')) {
        link.setAttribute('href', iconSrc);
        link.setAttribute('type', 'image/png');
    }
}

function setFrontendIconPreference(iconId, { persist = true } = {}) {
    const nextIconId = normalizeFrontendIcon(iconId);

    sbState.frontendIcon = nextIconId;

    if (persist) {
        safeSetItem(SB_STORAGE_KEYS.frontendIcon, nextIconId);
    }

    applyFrontendIcon(nextIconId);
    updateThemePickerUi();
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

function setDesktopTopbarLabelPart(partId, enabled) {
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
    updateThemePickerUi();
    updateTopBarBrand();
    scheduleTopbarContextRefresh(0);
}

function setMobileTopbarLabelPart(partId, enabled) {
    const normalizedPart = normalizeTopbarLabelPart(partId);
    const nextPart = enabled ? normalizedPart : '';

    if (sbState.topbarLabel.mobilePart === nextPart) {
        return;
    }

    sbState.topbarLabel.mobilePart = nextPart;
    safeSetItem(SB_STORAGE_KEYS.topbarLabelMobilePart, nextPart);
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
    updateThemePickerUi();
    updateTopBarBrand();
}

function updateThemeBadge() {
    const badge = document.getElementById('sb-theme-current-label');
    if (!badge) {
        return;
    }

    badge.textContent = getThemeOption(sbState.theme).label;
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

function getMainScriptModule() {
    if (!sbMainScriptModulePromise) {
        sbMainScriptModulePromise = import('../script.js');
    }

    return sbMainScriptModulePromise;
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
    const context = getSillyTavernContext();
    if (!context?.Popup?.show?.confirm) {
        return window.confirm('Clear cookies & cache? This removes browser-accessible SillyBunny cookies and cached UI data, then reloads the page.');
    }

    const result = await context?.Popup?.show?.confirm?.(
        'Clear cookies & cache?',
        'This removes browser-accessible SillyBunny cookies, browser cache, temporary session data, and IndexedDB cache stores, then reloads the page. Saved settings and account data stay intact, but you may need to sign in again if your setup uses browser cookies.',
        {
            okButton: 'Clear cookies & cache',
            cancelButton: 'Cancel',
        },
    );

    if (context?.POPUP_RESULT) {
        return result === context.POPUP_RESULT.AFFIRMATIVE;
    }

    return result === true || result === 1;
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
        globalThis.toastr?.success?.('Cookies and cache cleared. Reloading SillyBunny...', 'Cookies cleared');
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

function bindClearCookiesAndCacheButton() {
    const button = document.getElementById('clear_cookies_cache_button');
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
    return sbState.topbarLabel.desktopParts.includes('ctx') || sbState.topbarLabel.mobilePart === 'ctx';
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
    if (isMobileViewport()) {
        return sbState.topbarLabel.mobilePart ? [sbState.topbarLabel.mobilePart] : [];
    }

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

    title.textContent = label;
    title.title = label;
    title.classList.toggle('is-chat', isActiveChat);
    brand.dataset.brandState = isActiveChat ? 'chat' : 'idle';
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
    element.addEventListener('touchstart', stop);
}

function createProxyButton({ id, icon, label, title, className = '' }, onClick) {
    const button = createElement('button', {
        id,
        className: `sb-proxy-button ${className}`.trim(),
        attrs: {
            type: 'button',
            title,
            'aria-label': title,
            'aria-expanded': 'false',
            'data-sb-proxy-button': 'true',
        },
    });

    button.innerHTML = `<i class="fa-solid ${icon}" aria-hidden="true"></i><span>${label}</span>`;
    stopProxyPointerPropagation(button);
    button.addEventListener('click', debounceAction(onClick));

    return button;
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

function createTopBarIconButton({ id = '', icon, title, className = '', label = '' }, onClick) {
    const button = createElement('button', {
        id,
        className: `sb-chatbar-button ${className}`.trim(),
        attrs: {
            type: 'button',
            title,
            'aria-label': title,
        },
    });

    button.innerHTML = `
        <i class="fa-solid ${icon}" aria-hidden="true"></i>
        ${label ? `<span>${label}</span>` : ''}
    `;

    // Only stop mousedown/pointerdown propagation — stopping touchstart
    // interferes with mobile click synthesis and causes double-tap issues.
    const stop = event => event.stopPropagation();
    button.addEventListener('mousedown', stop);
    button.addEventListener('pointerdown', stop);
    button.addEventListener('click', onClick);

    return button;
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
    const stack = document.getElementById('sb-topbar-stack');
    const hasVisibleChatbar = stack?.querySelector('#sb-chatbar-layer') instanceof HTMLElement
        && getChatbarState().visible;

    document.body.classList.toggle('sb-topbar-compact', !hasVisibleChatbar);
}

function setChatbarVisible(shouldShow, { persist = true } = {}) {
    const nextVisible = Boolean(shouldShow);
    const state = getChatbarState();
    state.visible = nextVisible;

    document.body.classList.toggle('sb-chatbar-hidden', !nextVisible);

    if (!nextVisible) {
        setConnectionStripOpenState(false);
    }

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

    document.getElementById('sb-chatbar-layer')?.classList.remove('is-dragging');
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

function getChatDesktopRefs() {
    return getChatbarState().desktop;
}

function getChatMobileRefs() {
    return getChatbarState().mobileTools;
}

function getChatSidebarRefs() {
    return getChatbarState().sidebar;
}

function escapeSelectorValue(value) {
    if (globalThis.CSS?.escape) {
        return globalThis.CSS.escape(String(value ?? ''));
    }

    return String(value ?? '').replace(/["\\]/g, '\\$&');
}

function escapeRegExp(value) {
    return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripDecoratedOptionText(value) {
    return String(value ?? '').replace(/[[(].*?[\])]/g, '').trim();
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

function formatChatSelectorLabel(fileName, tokenEstimate = 0) {
    const tokenLabel = formatChatTokenEstimate(tokenEstimate);
    return tokenLabel ? `${fileName} (${tokenLabel})` : fileName;
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

async function openChatById(chatId, { closeMobileTools = false } = {}) {
    const nextChatId = normalizeChatFileName(chatId);
    const chatContext = getChatUiContext();

    if (!nextChatId || !chatContext.context) {
        return;
    }

    if (nextChatId === chatContext.chatId) {
        if (closeMobileTools) {
            closeMobileChatTools();
        }
        return;
    }

    try {
        if (chatContext.group?.id) {
            await chatContext.context.openGroupChat?.(chatContext.group.id, nextChatId);
        } else {
            await chatContext.context.openCharacterChat?.(nextChatId);
        }
    } finally {
        if (closeMobileTools) {
            closeMobileChatTools();
        }

        scheduleChatbarRefresh(80);
    }
}

async function handleRenameChat() {
    const chatContext = getChatUiContext();
    const currentChatId = chatContext.chatId;

    if (!currentChatId || typeof chatContext.context?.renameChat !== 'function') {
        return;
    }

    const newChatName = await chatContext.context.Popup?.show?.input?.('Rename chat', 'Enter a new chat name:', currentChatId);

    if (!newChatName || String(newChatName).trim() === currentChatId) {
        return;
    }

    await chatContext.context.renameChat(currentChatId, String(newChatName).trim());
    scheduleChatbarRefresh(120);
}

async function handleDeleteChat() {
    const chatContext = getChatUiContext();

    if (!chatContext.chatId) {
        return;
    }

    const confirmed = await chatContext.context?.Popup?.show?.confirm?.('Delete chat?', 'This action cannot be undone.');
    if (!confirmed) {
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
        globalThis.toastr?.error?.(String(error?.message || error), 'Auto-name Chat');
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

function bindChatDeleteVisualViewport(overlay) {
    const visualViewport = window.visualViewport;
    if (!(overlay instanceof HTMLElement) || !isMobileViewport() || !visualViewport) {
        return () => {};
    }

    let animationFrame = 0;

    function readViewportNumber(value, fallback = 0) {
        const number = Number(value);
        return Number.isFinite(number) && number > 0 ? number : fallback;
    }

    function update() {
        animationFrame = 0;
        const fallbackWidth = window.innerWidth || document.documentElement.clientWidth || 0;
        const fallbackHeight = window.innerHeight || document.documentElement.clientHeight || 0;
        const isKeyboardClosed = Math.abs(readViewportNumber(visualViewport.height, fallbackHeight) - fallbackHeight) <= 2
            && Math.abs(readViewportNumber(visualViewport.offsetTop) || 0) <= 2
            && Math.abs(readViewportNumber(visualViewport.offsetLeft) || 0) <= 2;

        if (isKeyboardClosed) {
            overlay.style.removeProperty('--sb-chat-delete-vv-left');
            overlay.style.removeProperty('--sb-chat-delete-vv-top');
            overlay.style.removeProperty('--sb-chat-delete-vv-width');
            overlay.style.removeProperty('--sb-chat-delete-vv-height');
            overlay.classList.remove('sb-chat-delete-overlay--keyboard-open');
            return;
        }

        const viewportLeft = Math.max(0, readViewportNumber(visualViewport.offsetLeft));
        const viewportTop = Math.max(0, readViewportNumber(visualViewport.offsetTop));
        const viewportWidth = Math.max(1, readViewportNumber(visualViewport.width, fallbackWidth));
        const viewportHeight = Math.max(1, readViewportNumber(visualViewport.height, fallbackHeight));

        overlay.classList.add('sb-chat-delete-overlay--keyboard-open');
        overlay.style.setProperty('--sb-chat-delete-vv-left', `${viewportLeft}px`);
        overlay.style.setProperty('--sb-chat-delete-vv-top', `${viewportTop}px`);
        overlay.style.setProperty('--sb-chat-delete-vv-width', `${viewportWidth}px`);
        overlay.style.setProperty('--sb-chat-delete-vv-height', `${viewportHeight}px`);
    }

    function scheduleUpdate() {
        if (animationFrame) {
            return;
        }

        animationFrame = window.requestAnimationFrame(update);
    }

    overlay.classList.add('sb-chat-delete-overlay--visual-viewport');
    update();
    visualViewport.addEventListener('resize', scheduleUpdate);
    visualViewport.addEventListener('scroll', scheduleUpdate);
    window.addEventListener('resize', scheduleUpdate, { passive: true });
    window.addEventListener('orientationchange', scheduleUpdate);

    return () => {
        if (animationFrame) {
            window.cancelAnimationFrame(animationFrame);
        }

        visualViewport.removeEventListener('resize', scheduleUpdate);
        visualViewport.removeEventListener('scroll', scheduleUpdate);
        window.removeEventListener('resize', scheduleUpdate);
        window.removeEventListener('orientationchange', scheduleUpdate);
        overlay.classList.remove('sb-chat-delete-overlay--visual-viewport');
        overlay.style.removeProperty('--sb-chat-delete-vv-left');
        overlay.style.removeProperty('--sb-chat-delete-vv-top');
        overlay.style.removeProperty('--sb-chat-delete-vv-width');
        overlay.style.removeProperty('--sb-chat-delete-vv-height');
    };
}

function showBottomChatMassDeleteDialog(files, currentChatId) {
    return new Promise(resolve => {
        const overlay = createElement('div', { className: 'sb-chat-delete-overlay' });
        const dialog = createElement('div', {
            className: 'sb-chat-delete-dialog',
            attrs: {
                role: 'dialog',
                'aria-modal': 'true',
                'aria-labelledby': 'sb-chat-delete-title',
            },
        });
        const title = createElement('h3', { id: 'sb-chat-delete-title', text: 'Mass delete chats' });
        const note = createElement('p', {
            className: 'sb-chat-delete-note',
            text: 'Delete saved chats for the current character or group. The open chat is protected.',
        });
        const list = createElement('div', { className: 'sb-chat-delete-list' });
        const ageRow = createElement('div', { className: 'sb-chat-delete-age' });
        const ageLabel = createElement('label', { text: 'Older than' });
        const ageInput = createElement('input', {
            className: 'text_pole',
            attrs: { type: 'number', min: '1', step: '1', value: '30', inputmode: 'numeric' },
        });
        const dayText = createElement('span', { text: 'days' });
        const presets = createElement('div', { className: 'sb-chat-delete-presets' });
        const status = createElement('small', { className: 'sb-chat-delete-status' });
        const actions = createElement('div', { className: 'sb-chat-delete-actions' });
        const deleteSelectedButton = createElement('button', { className: 'menu_button', text: 'Delete selected', attrs: { type: 'button' } });
        const deleteOlderButton = createElement('button', { className: 'menu_button', text: 'Delete older', attrs: { type: 'button' } });
        const cancelButton = createElement('button', { className: 'menu_button', text: 'Cancel', attrs: { type: 'button' } });
        const checkboxes = [];
        let cleanupVisualViewport = () => {};
        let isFinished = false;

        function finish(result) {
            if (isFinished) {
                return;
            }

            isFinished = true;
            document.removeEventListener('keydown', handleKeydown);
            cleanupVisualViewport();
            overlay.remove();
            resolve(result);
        }

        function getSelectedNames() {
            return checkboxes.filter(checkbox => checkbox.checked).map(checkbox => checkbox.value);
        }

        function updateStatus() {
            const selectedCount = getSelectedNames().length;
            const olderCount = getMassDeleteOlderThanDays(files, ageInput.value, currentChatId).length;
            status.textContent = `${selectedCount} selected. ${olderCount} older than ${ageInput.value || 0} day(s).`;
            deleteSelectedButton.disabled = selectedCount === 0;
            deleteOlderButton.disabled = olderCount === 0;
        }

        function handleKeydown(event) {
            if (event.key === 'Escape') {
                finish(null);
            }
        }

        for (const days of [7, 30, 90, 180]) {
            const button = createElement('button', { className: 'menu_button', text: String(days), attrs: { type: 'button' } });
            button.addEventListener('click', () => {
                ageInput.value = String(days);
                updateStatus();
            });
            presets.appendChild(button);
        }

        for (const chatFile of files) {
            const row = createElement('label', { className: 'sb-chat-delete-row' });
            const checkbox = createElement('input', {
                attrs: {
                    type: 'checkbox',
                    value: chatFile.fileName,
                },
            });
            checkbox.disabled = chatFile.fileName === currentChatId;
            const text = createElement('span', { className: 'sb-chat-delete-row-text' });
            const name = createElement('strong', { text: chatFile.fileName });
            const meta = createElement('small', { text: [formatChatTimestamp(chatFile.lastMessage), chatFile.chatItems ? `${chatFile.chatItems} msg` : ''].filter(Boolean).join(' - ') });

            text.append(name, meta);
            row.append(checkbox, text);
            list.appendChild(row);
            if (checkbox instanceof HTMLInputElement && !checkbox.disabled) {
                checkbox.addEventListener('change', updateStatus);
                checkboxes.push(checkbox);
            }
        }

        ageInput.addEventListener('input', updateStatus);
        deleteSelectedButton.addEventListener('click', () => finish({ mode: 'selected', names: getSelectedNames() }));
        deleteOlderButton.addEventListener('click', () => finish({ mode: 'older', days: Number(ageInput.value) }));
        cancelButton.addEventListener('click', () => finish(null));
        overlay.addEventListener('click', event => {
            if (event.target === overlay) {
                finish(null);
            }
        });

        ageLabel.append(ageInput, dayText);
        ageRow.append(ageLabel, presets);
        actions.append(deleteSelectedButton, deleteOlderButton, cancelButton);
        dialog.append(title, note, ageRow, status, list, actions);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
        cleanupVisualViewport = bindChatDeleteVisualViewport(overlay);
        document.addEventListener('keydown', handleKeydown);
        updateStatus();
        if (!isMobileViewport()) {
            ageInput.focus();
        }
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
            globalThis.toastr?.info?.('No saved chats can be deleted for this character or group.', 'Mass Delete Chats');
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

        const confirmed = await chatContext.context?.Popup?.show?.confirm?.('Delete chats?', `Delete ${names.length} chat(s)? This cannot be undone.`)
            ?? window.confirm(`Delete ${names.length} chat(s)? This cannot be undone.`);
        if (!confirmed) {
            return;
        }

        const chatModule = await getChatScriptModule();
        for (const fileName of names) {
            await deleteChatFileForContext(chatContext, fileName, chatModule);
        }

        globalThis.toastr?.success?.(`Deleted ${names.length} chat(s).`, 'Mass Delete Chats');
        scheduleBottomChatBarRefresh(160);
        scheduleChatbarRefresh(160);
        await chatModule.displayPastChats?.();
    } catch (error) {
        console.error('[SillyBunny] Failed to mass delete chats.', error);
        globalThis.toastr?.error?.(String(error?.message || error), 'Mass Delete Chats');
    } finally {
        setBottomChatActionBusy(button, false);
    }
}

async function handleCloseChat() {
    const chatContext = getChatUiContext();

    if (typeof chatContext.context?.closeCurrentChat === 'function') {
        await chatContext.context.closeCurrentChat();
    } else {
        document.getElementById('option_close_chat')?.click();
    }

    scheduleChatbarRefresh(80);
}

function handleNewChat() {
    document.getElementById('option_start_new_chat')?.click();
    scheduleChatbarRefresh(100);
}

function handleChatManagerClick() {
    document.getElementById('option_select_chat')?.click();
}

function createChatField({ id = '', icon, title, tagName = 'label', className = '' }) {
    const field = createElement(tagName, {
        id,
        className: `sb-chatbar-field ${className}`.trim(),
        attrs: {
            title,
        },
    });
    const fieldIcon = createElement('i', { className: `fa-solid ${icon}` });

    field.appendChild(fieldIcon);
    return field;
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

    for (const refs of [getChatDesktopRefs(), getChatMobileRefs(), getBottomChatBarState()]) {
        const status = refs?.searchStatus;
        if (!(status instanceof HTMLElement)) {
            continue;
        }

        status.textContent = normalizedText;
        status.title = normalizedText;
        status.hidden = !normalizedText;
    }
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

function populateChatSelector(select, chatFiles, chatContext, placeholder) {
    if (!(select instanceof HTMLSelectElement)) {
        return;
    }

    const currentValue = String(chatContext.chatId ?? '').trim();
    const uniqueChats = Array.from(chatFiles.reduce((map, chatFile) => {
        const fileName = String(chatFile?.fileName ?? chatFile ?? '').trim();
        if (fileName && !map.has(fileName)) {
            map.set(fileName, {
                fileName,
                tokenEstimate: Number(chatFile?.tokenEstimate ?? 0) || 0,
            });
        }

        return map;
    }, new Map()).values()).sort((left, right) => left.fileName.localeCompare(right.fileName));

    select.replaceChildren();

    if (!uniqueChats.length) {
        const option = createElement('option', { text: placeholder });
        option.value = '';
        option.selected = true;
        select.appendChild(option);
        select.disabled = true;
        return;
    }

    for (const chat of uniqueChats) {
        const chatName = chat.fileName;
        const option = createElement('option', { text: formatChatSelectorLabel(chatName, chat.tokenEstimate) });
        option.value = chatName;
        option.selected = chatName === currentValue;
        select.appendChild(option);
    }

    if (currentValue && !uniqueChats.some(chat => chat.fileName === currentValue)) {
        const option = createElement('option', { text: currentValue });
        option.value = currentValue;
        option.selected = true;
        select.appendChild(option);
    }

    select.disabled = false;
    select.value = currentValue || uniqueChats[0].fileName;
}

function createChatFileButton(chatFile, currentChatId, onSelect, { compact = false } = {}) {
    const button = createElement('button', {
        className: `sb-chat-file ${compact ? 'is-compact' : ''}`.trim(),
        attrs: {
            type: 'button',
        },
    });

    const dateLabel = formatChatTimestamp(chatFile.lastMessage);
    button.classList.toggle('is-current', chatFile.fileName === currentChatId);
    button.innerHTML = `
        <div class="sb-chat-file-head">
            <strong>${chatFile.fileName}</strong>
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

function renderChatFiles(listRoot, files, currentChatId, { compact = false, emptyTitle = 'No chats yet.', emptyBody = 'Start a chat to see it here.', onSelect } = {}) {
    if (!(listRoot instanceof HTMLElement)) {
        return;
    }

    listRoot.replaceChildren();

    if (!files.length) {
        const empty = createElement('div', { className: `sb-chat-files-empty ${compact ? 'is-compact' : ''}`.trim() });
        empty.innerHTML = `<strong>${emptyTitle}</strong><p>${emptyBody}</p>`;
        listRoot.appendChild(empty);
        return;
    }

    for (const chatFile of files) {
        listRoot.appendChild(createChatFileButton(chatFile, currentChatId, onSelect, { compact }));
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
    root.classList.add('sb-chat-sidebar');
    root.style.top = 'calc(var(--sb-topbar-layout-offset) + 18px)';
    root.style.right = '16px';
    root.style.left = 'auto';
    root.style.bottom = 'auto';

    title.textContent = 'Recent Chats';

    const body = createElement('div', { className: 'sb-chat-sidebar-body' });
    const list = createElement('div', { className: 'sb-chat-sidebar-list' });
    body.appendChild(list);
    root.appendChild(body);

    closeButton.addEventListener('click', () => setChatSidebarOpenState(false));

    movingDivs.appendChild(root);

    getChatbarState().sidebar = { root, title, list };
    return getChatbarState().sidebar;
}

function isChatSidebarOpen() {
    return Boolean(getChatbarState().sidebarOpen);
}

function setChatSidebarOpenState(shouldOpen) {
    const refs = buildChatSidebar();

    if (!refs?.root) {
        return;
    }

    const isOpen = Boolean(shouldOpen);
    getChatbarState().sidebarOpen = isOpen;
    refs.root.style.display = isOpen ? 'flex' : 'none';
    refs.root.classList.toggle('sb-chat-sidebar-visible', isOpen);
    setButtonPressed(getChatDesktopRefs()?.toggleSidebarButton, isOpen);

    if (isOpen) {
        scheduleChatbarRefresh(0);
    }
}

function toggleChatSidebar() {
    const chatContext = getChatUiContext();
    if (!chatContext.canBrowseChats) {
        return;
    }

    setConnectionStripOpenState(false);
    setChatSidebarOpenState(!isChatSidebarOpen());
}

function buildMobileChatTools() {
    const existingMobileTools = getChatMobileRefs();
    if (existingMobileTools) {
        return existingMobileTools;
    }

    const overlay = createElement('div', { id: 'sb-mobile-chat-tools' });
    const panel = createElement('div', { id: 'sb-mobile-chat-tools-panel' });
    const header = createElement('div', { className: 'sb-mobile-chat-header' });
    const dismissButton = createTopBarIconButton(
        {
            id: 'sb-mobile-chat-close',
            icon: 'fa-xmark',
            title: 'Close chat tools',
            className: 'sb-mobile-chat-close',
        },
        () => closeMobileChatTools(),
    );
    const chatSelectField = createChatField({
        id: 'sb-mobile-chat-select-field',
        icon: 'fa-comments',
        title: 'Switch chat',
        className: 'is-mobile',
    });
    const chatSelect = createElement('select', {
        id: 'sb-mobile-chat-select',
        className: 'text_pole',
        attrs: {
            'aria-label': 'Switch chat',
        },
    });
    const searchField = createChatField({
        id: 'sb-mobile-chat-search-field',
        icon: 'fa-magnifying-glass',
        title: 'Search all messages in this chat, including hidden messages',
        className: 'is-mobile',
    });
    const searchInput = createElement('input', {
        id: 'sb-mobile-chat-search',
        className: 'text_pole',
        attrs: {
            type: 'search',
            placeholder: 'Search this chat...',
            'aria-label': 'Search all messages in this chat',
        },
    });
    const searchStatus = createElement('small', { className: 'sb-chatbar-search-status' });
    const actions = createElement('div', { className: 'sb-mobile-chat-actions' });
    const recentSection = createElement('section', { className: 'sb-mobile-chat-section' });
    const recentTitle = createElement('strong', { className: 'sb-mobile-chat-section-title', text: 'Recent Chats' });
    const recentList = createElement('div', { className: 'sb-mobile-chat-files' });
    const connectionSection = createElement('section', { className: 'sb-mobile-chat-section sb-mobile-chat-connection' });
    const connectionTitle = createElement('strong', { className: 'sb-mobile-chat-section-title', text: 'Connection Profile' });
    const connectionField = createChatField({
        id: 'sb-mobile-chat-connection-field',
        icon: 'fa-plug',
        title: 'Switch connection profile',
        className: 'is-mobile',
    });
    const connectionSelect = createElement('select', {
        id: 'sb-mobile-chat-connection-select',
        className: 'text_pole',
        attrs: {
            'aria-label': 'Switch connection profile',
        },
    });
    const connectionStatus = createElement('small', { className: 'sb-mobile-chat-connection-status' });

    searchStatus.hidden = true;
    connectionSection.hidden = true;

    overlay.hidden = true;
    overlay.setAttribute('aria-hidden', 'true');

    if ('inert' in overlay) {
        overlay.inert = true;
    }

    chatSelectField.appendChild(chatSelect);
    searchField.append(searchInput, searchStatus);
    connectionField.appendChild(connectionSelect);
    connectionSection.append(connectionTitle, connectionField, connectionStatus);
    header.append(searchField, dismissButton);

    const buttons = {
        managerButton: createTopBarIconButton({ icon: 'fa-address-book', title: 'View chat files', className: 'is-mobile-compact' }, handleChatManagerClick),
        newButton: createTopBarIconButton({ icon: 'fa-comments', title: 'Start a new chat', className: 'is-mobile-compact' }, handleNewChat),
        renameButton: createTopBarIconButton({ icon: 'fa-pen', title: 'Rename this chat', className: 'is-mobile-compact' }, () => { void handleRenameChat(); }),
        deleteButton: createTopBarIconButton({ icon: 'fa-trash', title: 'Delete this chat', className: 'is-mobile-compact' }, () => { void handleDeleteChat(); }),
        closeButton: createTopBarIconButton({ icon: 'fa-xmark', title: 'Close this chat', className: 'is-mobile-compact' }, () => { void handleCloseChat(); }),
    };

    actions.append(
        buttons.managerButton,
        buttons.newButton,
        buttons.renameButton,
        buttons.deleteButton,
        buttons.closeButton,
    );

    recentSection.append(recentTitle, recentList);
    panel.append(header, chatSelectField, actions, connectionSection, recentSection);
    overlay.appendChild(panel);

    overlay.addEventListener('click', event => {
        if (event.target === overlay) {
            closeMobileChatTools();
        }
    });

    chatSelect.addEventListener('change', () => {
        void openChatById(chatSelect.value, { closeMobileTools: true });
    });
    searchInput.addEventListener('input', () => setChatSearchQuery(searchInput.value, { source: searchInput }));
    connectionSelect.addEventListener('change', () => {
        syncConnectionProfileSelection(connectionSelect.value);
    });

    document.body.appendChild(overlay);

    getChatbarState().mobileTools = {
        overlay,
        panel,
        chatSelect,
        searchInput,
        searchStatus,
        recentList,
        connectionSection,
        connectionSelect,
        connectionStatus,
        ...buttons,
    };

    return getChatbarState().mobileTools;
}

function setMobileChatToolsOpenState(shouldOpen) {
    const refs = buildMobileChatTools();
    const isOpen = Boolean(shouldOpen) && isMobileViewport();

    if (!refs?.overlay) {
        return;
    }

    getChatbarState().mobileToolsOpen = isOpen;
    refs.overlay.hidden = !isOpen;
    refs.overlay.classList.toggle('sb-chat-tools-open', isOpen);
    refs.overlay.setAttribute('aria-hidden', String(!isOpen));

    if ('inert' in refs.overlay) {
        refs.overlay.inert = !isOpen;
    }

    queueMobileModalStateSync();

    if (isOpen) {
        scheduleChatbarRefresh(0);
    }
}

function openMobileChatTools() {
    if (!isMobileViewport()) {
        return;
    }

    applyMobileSurfaceExclusivity(sbMobileShellLifecycle.overlays.resolveExclusiveOpen({
        surface: sbMobileShellLifecycle.overlays.surface.CHAT_TOOLS,
        isMobileViewport: isMobileViewport(),
    }));
    setMobileChatToolsOpenState(true);
}

function closeMobileChatTools() {
    setMobileChatToolsOpenState(false);
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
        [surface.NAV]: () => closeMobileNav(),
        [surface.LEFT_SHELL]: () => closeShell('left'),
        [surface.RIGHT_SHELL]: () => closeShell('right'),
        [surface.CHARACTER_PANEL]: () => closeCharacterPanel(),
        [surface.CHAT_TOOLS]: () => closeMobileChatTools(),
        [surface.CONNECTION_STRIP]: () => setConnectionStripOpenState(false),
    };

    for (const closeSurfaceKey of decision.closeSurfaces) {
        const close = closeSurface[closeSurfaceKey];
        if (typeof close !== 'function') {
            throw new Error(`Unknown mobile shell surface: ${closeSurfaceKey}`);
        }

        close();
    }
}

function toggleMobileChatTools() {
    const shouldOpen = !getChatbarState().mobileToolsOpen;

    if (shouldOpen) {
        applyMobileSurfaceExclusivity(sbMobileShellLifecycle.overlays.resolveExclusiveOpen({
            surface: sbMobileShellLifecycle.overlays.surface.CHAT_TOOLS,
            isMobileViewport: isMobileViewport(),
        }));
    }

    setMobileChatToolsOpenState(shouldOpen);
}

function syncConnectionProfileSelection(value) {
    const sourceSelect = document.getElementById('connection_profiles');

    if (!(sourceSelect instanceof HTMLSelectElement)) {
        return;
    }

    const syncState = sbPresetApiSyncLifecycle.connectionProfiles.resolveSelectionSync({
        requestedValue: value,
        currentValue: sourceSelect.value,
    });
    if (!syncState.shouldSync) {
        return;
    }

    sourceSelect.value = syncState.nextValue;
    sourceSelect.dispatchEvent(new Event('change', { bubbles: true }));
}

function isConnectionStripOpen() {
    return Boolean(getChatbarState().connectionStripOpen);
}

function setConnectionStripOpenState(shouldOpen) {
    const desktopRefs = getChatDesktopRefs();
    const nextState = Boolean(shouldOpen);

    if (!desktopRefs?.connectionStrip) {
        return;
    }

    if (nextState) {
        applyMobileSurfaceExclusivity(sbMobileShellLifecycle.overlays.resolveExclusiveOpen({
            surface: sbMobileShellLifecycle.overlays.surface.CONNECTION_STRIP,
            isMobileViewport: isMobileViewport(),
        }));
    }

    getChatbarState().connectionStripOpen = nextState;
    desktopRefs.connectionStrip.classList.toggle('is-open', nextState);
    desktopRefs.connectionStrip.hidden = !nextState;
    setButtonPressed(desktopRefs.toggleConnectionButton, nextState);
}

function getCurrentMainApiValue() {
    const mainApiSelect = document.getElementById('main_api');
    const context = getSillyTavernContext();

    return sbPresetApiSyncLifecycle.api.resolveMainValue({
        selectValue: mainApiSelect instanceof HTMLSelectElement ? mainApiSelect.value : '',
        contextMainApi: context?.mainApi,
    });
}

function resolveActiveApiConnectButton() {
    const selector = sbPresetApiSyncLifecycle.api.resolveConnectButtonSelector(getCurrentMainApiValue());

    if (!selector) {
        return null;
    }

    const button = document.querySelector(selector);
    return button instanceof HTMLElement ? button : null;
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

    return new RegExp(`(${terms.map(escapeRegExp).join('|')})`, 'gi');
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
        setSearchStatusText('Loading match...');

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
        firstMatch.scrollIntoView({
            block: 'center',
            behavior: getReducedMotionScrollBehavior(),
        });
    } else if (scrollToFirst && Number.isInteger(firstMatchId)) {
        const messageElement = getChatMessageElement(firstMatchId);
        if (messageElement instanceof HTMLElement) {
            messageElement.classList.add('sb-search-hit');
            window.setTimeout(() => messageElement.classList.remove('sb-search-hit'), 2400);
            messageElement.scrollIntoView({
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

    for (const input of [getChatDesktopRefs()?.searchInput, getChatMobileRefs()?.searchInput, getBottomChatBarState()?.searchInput]) {
        if (!(input instanceof HTMLInputElement) || input === source) {
            continue;
        }

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
            placeholder: 'Search chat...',
            'aria-label': 'Search all messages in this chat',
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
        const title = isOpen ? 'Hide chat actions' : 'Show chat actions';

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
        const title = isOpen ? 'Hide chat search' : 'Search chat';

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

async function getConnectionStatusText() {
    const context = getSillyTavernContext();

    if (!context) {
        return '';
    }

    if (context.onlineStatus === 'no_connection') {
        return 'No connection...';
    }

    let apiValue = String(context.mainApi ?? 'Connected').trim();
    let modelValue = String(context.onlineStatus ?? '').trim();

    try {
        const nextApiValue = await context.SlashCommandParser?.commands?.api?.callback?.({ quiet: 'true' }, '');
        if (nextApiValue) {
            apiValue = String(nextApiValue).trim();
        }
    } catch {
        // Ignore slash command lookup failures and use the current context values.
    }

    try {
        const nextModelValue = await context.SlashCommandParser?.commands?.model?.callback?.({ quiet: 'true' }, '');
        if (typeof nextModelValue === 'string' && nextModelValue.trim()) {
            modelValue = nextModelValue.trim();
        }
    } catch {
        // Ignore slash command lookup failures and use the current context values.
    }

    const apiBlock = document.getElementById('rm_api_block');

    if (apiBlock instanceof HTMLElement) {
        const apiOption = apiBlock.querySelector(`select:not(#main_api) option[value="${escapeSelectorValue(apiValue)}"]`)
            ?? apiBlock.querySelector(`select#main_api option[value="${escapeSelectorValue(apiValue)}"]`);
        const modelOption = apiBlock.querySelector(`option[value="${escapeSelectorValue(modelValue)}"]`);

        apiValue = stripDecoratedOptionText(apiOption?.textContent ?? apiValue);
        modelValue = stripDecoratedOptionText(modelOption?.textContent ?? modelValue);
    }

    return modelValue ? `${apiValue} - ${modelValue}` : apiValue;
}

function nodeTouchesConnectionProfilesSource(node) {
    if (!(node instanceof Element)) {
        return false;
    }

    return node.id === 'connection_profiles' || Boolean(node.querySelector('#connection_profiles'));
}

function mutationTouchesConnectionProfilesSource(mutation) {
    if (nodeTouchesConnectionProfilesSource(mutation.target)) {
        return true;
    }

    for (const node of mutation.addedNodes) {
        if (nodeTouchesConnectionProfilesSource(node)) {
            return true;
        }
    }

    for (const node of mutation.removedNodes) {
        if (nodeTouchesConnectionProfilesSource(node)) {
            return true;
        }
    }

    return false;
}

function bindConnectionProfileSourceElement(sourceElement) {
    const chatbarState = getChatbarState();
    const normalizedSource = sourceElement instanceof HTMLSelectElement ? sourceElement : null;

    if (chatbarState.sourceObservedElement === normalizedSource) {
        return;
    }

    if (chatbarState.sourceObservedElement instanceof HTMLSelectElement && typeof chatbarState.sourceChangeHandler === 'function') {
        chatbarState.sourceObservedElement.removeEventListener('change', chatbarState.sourceChangeHandler);
    }

    chatbarState.sourceSelectObserver?.disconnect();
    chatbarState.sourceObservedElement = normalizedSource;
    chatbarState.sourceChangeHandler = null;

    if (!(normalizedSource instanceof HTMLSelectElement)) {
        return;
    }

    if (!chatbarState.sourceSelectObserver) {
        chatbarState.sourceSelectObserver = new MutationObserver(() => {
            scheduleChatbarRefresh(60);
        });
    }

    const handleSourceChange = () => {
        scheduleChatbarRefresh(0);
    };

    chatbarState.sourceChangeHandler = handleSourceChange;
    normalizedSource.addEventListener('change', handleSourceChange);
    chatbarState.sourceSelectObserver.observe(normalizedSource, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['disabled'],
    });
}

function bindConnectionProfileSourceObserver() {
    const chatbarState = getChatbarState();
    if (chatbarState.sourceObserver) {
        bindConnectionProfileSourceElement(document.getElementById('connection_profiles'));
        return;
    }

    const observer = new MutationObserver(mutations => {
        if (!mutations.some(mutationTouchesConnectionProfilesSource)) {
            return;
        }

        bindConnectionProfileSourceElement(document.getElementById('connection_profiles'));
        scheduleChatbarRefresh(60);
    });

    observer.observe(document.body, { childList: true, subtree: true });
    chatbarState.sourceObserver = observer;
    bindConnectionProfileSourceElement(document.getElementById('connection_profiles'));
}

async function refreshChatbarState() {
    const chatbarState = getChatbarState();
    const refreshToken = ++chatbarState.refreshToken;
    const desktopRefs = getChatDesktopRefs();
    const mobileRefs = getChatMobileRefs();

    if (!desktopRefs && !mobileRefs) {
        return;
    }

    const chatContext = getChatUiContext();
    const files = await getChatFilesForContext(chatContext);
    const connectionStatusText = await getConnectionStatusText();

    if (refreshToken !== chatbarState.refreshToken) {
        return;
    }

    const chatNames = files.map(chat => chat.fileName);

    if (chatContext.chatId && !chatNames.includes(chatContext.chatId)) {
        files.unshift({ fileName: chatContext.chatId, tokenEstimate: 0 });
    }

    populateChatSelector(desktopRefs?.chatSelect, files, chatContext, chatContext.canBrowseChats ? 'No saved chats yet' : 'No chat selected');
    populateChatSelector(mobileRefs?.chatSelect, files, chatContext, chatContext.canBrowseChats ? 'No saved chats yet' : 'No chat selected');

    if (desktopRefs) {
        setButtonDisabled(desktopRefs.managerButton, !chatContext.canBrowseChats);
        setButtonDisabled(desktopRefs.toggleSidebarButton, !chatContext.canBrowseChats);
        setButtonDisabled(desktopRefs.newButton, !chatContext.canStartNewChat);
        setButtonDisabled(desktopRefs.renameButton, !chatContext.hasChat);
        setButtonDisabled(desktopRefs.deleteButton, !chatContext.hasChat);
        setButtonDisabled(desktopRefs.closeButton, !chatContext.hasChat);
        setButtonDisabled(desktopRefs.chatSelect, !chatContext.canBrowseChats);
        setButtonDisabled(desktopRefs.searchInput, !chatContext.hasChat);
    }

    if (mobileRefs) {
        setButtonDisabled(mobileRefs.managerButton, !chatContext.canBrowseChats);
        setButtonDisabled(mobileRefs.newButton, !chatContext.canStartNewChat);
        setButtonDisabled(mobileRefs.renameButton, !chatContext.hasChat);
        setButtonDisabled(mobileRefs.deleteButton, !chatContext.hasChat);
        setButtonDisabled(mobileRefs.closeButton, !chatContext.hasChat);
        setButtonDisabled(mobileRefs.chatSelect, !chatContext.canBrowseChats);
        setButtonDisabled(mobileRefs.searchInput, !chatContext.hasChat);
    }

    const connectionProfilesSource = document.getElementById('connection_profiles');
    const hasConnectionProfiles = connectionProfilesSource instanceof HTMLSelectElement;
    const connectionMirrorState = sbPresetApiSyncLifecycle.connectionProfiles.resolveMirrorState({
        hasConnectionProfiles,
        isConnectionStripOpen: isConnectionStripOpen(),
        hasActiveConnectButton: hasConnectionProfiles && Boolean(resolveActiveApiConnectButton()),
    });

    if (desktopRefs) {
        desktopRefs.toggleConnectionButton.hidden = !connectionMirrorState.shouldShowToggle;
        desktopRefs.connectionStrip.hidden = !connectionMirrorState.shouldShowDesktopStrip;
    }

    if (connectionMirrorState.shouldCloseDesktopStrip) {
        setConnectionStripOpenState(false);
    }

    if (connectionMirrorState.shouldClearMirrors) {
        if (desktopRefs) {
            desktopRefs.connectionSelect.replaceChildren();
            desktopRefs.connectionStatus.textContent = '';
            setButtonDisabled(desktopRefs.connectionConnectButton, connectionMirrorState.shouldDisableConnectButton);
        }

        if (mobileRefs?.connectionSection instanceof HTMLElement) {
            mobileRefs.connectionSection.hidden = !connectionMirrorState.shouldShowMobileSection;
            mobileRefs.connectionSelect.replaceChildren();
            mobileRefs.connectionStatus.textContent = '';
        }
    } else {
        const optionsMarkup = connectionProfilesSource.innerHTML;
        if (desktopRefs) {
            desktopRefs.connectionSelect.innerHTML = optionsMarkup;
            desktopRefs.connectionSelect.value = connectionProfilesSource.value;
            desktopRefs.connectionStatus.textContent = connectionStatusText;
            setButtonDisabled(desktopRefs.connectionConnectButton, connectionMirrorState.shouldDisableConnectButton);
        }

        if (mobileRefs?.connectionSection instanceof HTMLElement) {
            mobileRefs.connectionSection.hidden = !connectionMirrorState.shouldShowMobileSection;
            mobileRefs.connectionSelect.innerHTML = optionsMarkup;
            mobileRefs.connectionSelect.value = connectionProfilesSource.value;
            mobileRefs.connectionStatus.textContent = connectionStatusText;
        }
    }

    renderChatFiles(getChatSidebarRefs()?.list, files, chatContext.chatId, {
        onSelect: chatId => openChatById(chatId),
    });
    renderChatFiles(mobileRefs?.recentList, files, chatContext.chatId, {
        compact: true,
        onSelect: chatId => openChatById(chatId, { closeMobileTools: true }),
    });

    if (desktopRefs) {
        setButtonPressed(desktopRefs.toggleSidebarButton, isChatSidebarOpen());
        setButtonPressed(desktopRefs.toggleConnectionButton, isConnectionStripOpen());
    }

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
    bindConnectionProfileSourceObserver();

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

function isMobileOverlayActuallyOpen(overlayRootOrId, openClass) {
    const el = getDrawerRoot(overlayRootOrId);

    if (!(el instanceof HTMLElement) || !el.classList.contains(openClass)) {
        return false;
    }

    const isExplicitlyHidden = el.hidden || el.getAttribute('aria-hidden') === 'true';
    if (isExplicitlyHidden) {
        return false;
    }

    const styles = getComputedStyle(el);
    return styles.display !== 'none'
        && styles.visibility !== 'hidden'
        && styles.pointerEvents !== 'none'
        && el.getClientRects().length > 0;
}

function getMobileModalRootCandidates() {
    const chatTools = getChatbarState().mobileTools?.overlay ?? document.getElementById('sb-mobile-chat-tools');
    return [
        document.getElementById(getShellConfig('left').rootPanelId),
        document.getElementById(getShellConfig('right').rootPanelId),
        getCharacterPanel(),
        document.getElementById('sb-mobile-nav'),
        chatTools,
    ].filter(element => element instanceof HTMLElement);
}

function isMobileModalRootOpen(root) {
    if (!(root instanceof HTMLElement)) {
        return false;
    }

    if (root.id === 'sb-mobile-nav') {
        return isMobileOverlayActuallyOpen(root, 'sb-nav-open');
    }

    if (root.id === 'sb-mobile-chat-tools') {
        return isMobileOverlayActuallyOpen(root, 'sb-chat-tools-open');
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

    const hasManagedAriaState = root.id === 'sb-mobile-nav' || root.id === 'sb-mobile-chat-tools';

    if (isActiveRoot) {
        if (hasManagedAriaState) {
            root.setAttribute('aria-hidden', 'false');
            if ('inert' in root) {
                root.inert = false;
            }
            return;
        }

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

    if (hasManagedAriaState) {
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

    setElementInertForMobileModal(document.getElementById('sheld'), modalState.shouldInertShell);
    setElementInertForMobileModal(document.getElementById('top-bar'), modalState.shouldInertTopBar);
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

function forceDrawerState(drawerRootOrId, shouldOpen, drawerIconOrSelector = null) {
    const el = typeof drawerRootOrId === 'string'
        ? document.getElementById(drawerRootOrId)
        : drawerRootOrId;
    if (!(el instanceof HTMLElement)) return;
    el.classList.toggle('openDrawer', Boolean(shouldOpen));
    el.classList.toggle('closedDrawer', !shouldOpen);
    syncDrawerIconState(drawerIconOrSelector, shouldOpen);
    queueMobileModalStateSync();
}

function isShellOpen(shellKey) {
    return isDrawerActuallyOpen(getShellConfig(shellKey).rootPanelId);
}

function isShellTabOpen(shellKey, tabId) {
    const shellState = getShellState(shellKey);
    return Boolean(shellState && isShellOpen(shellKey) && shellState.activeTabId === tabId);
}

function isCharacterPanelOpen() {
    return isDrawerActuallyOpen('right-nav-panel');
}

function getActiveCharacterPanelTab() {
    const menuType = getCharacterPanel()?.dataset.menuType;

    if (['persona', 'import', 'world-info', 'groups'].includes(menuType)) {
        return menuType;
    }

    if (['character_edit', 'group_edit', 'create', 'group_create', 'editor_empty'].includes(menuType)) {
        return 'editor';
    }

    return 'characters';
}

function isCharacterPanelTabOpen(tabId) {
    return isCharacterPanelOpen() && getActiveCharacterPanelTab() === normalizeCharacterPanelTab(tabId);
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
    try {
        const module = await getMainScriptModule();
        module.setCharacterMenuEntityView?.(view);
    } catch (error) {
        console.warn('[SillyBunny] Could not set character list entity view.', error);
    }
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

    if (bulkEditButton instanceof HTMLElement) {
        bulkEditButton.classList.toggle('disabled', normalizedView === 'groups');
        bulkEditButton.setAttribute('aria-disabled', String(normalizedView === 'groups'));
        bulkEditButton.title = normalizedView === 'groups'
            ? 'Bulk edit for groups is not available yet'
            : 'Bulk edit characters\n\nClick to toggle characters\nShift + Click to select/deselect a range of characters\nRight-click for actions';
    }
}

function ensureCharacterListToolbarLayout() {
    const fixedTop = document.getElementById('charListFixedTop');
    const buttonBar = document.getElementById('rm_button_bar');
    const createButton = document.getElementById('rm_button_create');
    const createGroupButton = document.getElementById('rm_button_group_chats');
    const searchButton = document.getElementById('rm_button_search');
    const pagination = document.getElementById('rm_print_characters_pagination');

    if (!(fixedTop instanceof HTMLElement) || !(buttonBar instanceof HTMLElement)) {
        return;
    }

    let actionBar = fixedTop.querySelector('.sb-character-create-bar');
    if (!(actionBar instanceof HTMLElement)) {
        actionBar = createElement('div', { className: 'sb-character-create-bar' });
        fixedTop.prepend(actionBar);
    }

    if (createButton instanceof HTMLElement && createButton.parentElement !== actionBar) {
        actionBar.prepend(createButton);
    }

    if (createGroupButton instanceof HTMLElement && createGroupButton.parentElement !== actionBar) {
        const afterCreate = createButton instanceof HTMLElement && createButton.parentElement === actionBar
            ? createButton.nextSibling
            : actionBar.firstChild;
        actionBar.insertBefore(createGroupButton, afterCreate);
    }

    if (buttonBar.parentElement !== actionBar) {
        const actionButton = createGroupButton instanceof HTMLElement && createGroupButton.parentElement === actionBar
            ? createGroupButton
            : createButton;
        const afterAction = actionButton instanceof HTMLElement && actionButton.parentElement === actionBar
            ? actionButton.nextSibling
            : actionBar.firstChild;
        actionBar.insertBefore(buttonBar, afterAction);
    }

    if (pagination instanceof HTMLElement && pagination.parentElement !== actionBar) {
        actionBar.insertBefore(pagination, buttonBar.nextSibling);
    }

    if (searchButton instanceof HTMLElement && searchButton.parentElement !== buttonBar) {
        buttonBar.appendChild(searchButton);
    }

    const bulkEditButton = document.getElementById('bulkEditButton');
    if (bulkEditButton instanceof HTMLElement && bulkEditButton.dataset.sbGroupsGuardBound !== 'true') {
        bulkEditButton.dataset.sbGroupsGuardBound = 'true';
        bulkEditButton.addEventListener('click', (event) => {
            const panel = getCharacterPanel();
            if (panel instanceof HTMLElement && panel.dataset.menuType === 'groups') {
                event.preventDefault();
                event.stopImmediatePropagation();
                globalThis.toastr?.info?.('Bulk edit for groups is not available yet.');
            }
        }, { capture: true });
    }
}

async function showCharacterListView(view = 'characters') {
    setCharacterEditorEmptyState(false);
    setCharacterPersonaPanelVisible(false);
    setCharacterImportPanelVisible(false);
    setCharacterWorldInfoPanelVisible(false);
    const panel = getCharacterPanel();
    const normalizedView = view === 'groups' ? 'groups' : 'characters';
    sbState.characterDrawer.lastTab = normalizedView;

    setCharacterPanelMenuType(panel, normalizedView);

    syncCharacterListControls(normalizedView);
    await setCharacterListEntityView(normalizedView);

    const backButton = document.getElementById('rm_button_back');

    if (backButton instanceof HTMLElement) {
        backButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        setCharacterPanelMenuType(panel, normalizedView);
        syncCharacterListControls(normalizedView);
        syncCharacterShellTabs(normalizedView);
        return true;
    }

    resetCharacterPanelView();
    setCharacterPanelMenuType(panel, normalizedView);
    syncCharacterListControls(normalizedView);
    syncCharacterShellTabs(normalizedView);
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
    const emptyState = document.getElementById('sb_character_editor_empty');

    if (emptyState instanceof HTMLElement) {
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

    const shouldHide = ['characters', 'groups', 'editor_empty', 'world-info', 'persona', 'import'].includes(panel.dataset.menuType ?? '');
    pinAndTabs.style.display = shouldHide ? 'none' : '';
    syncCharacterEditorFullscreenAvailability();
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
    preloadPanelStylesheets('characters', 'world-info');
    return host;
}

function setCharacterPersonaPanelVisible(visible) {
    const host = ensureCharacterPersonaPanel() ?? document.getElementById('sb_character_persona_panel');

    if (host instanceof HTMLElement) {
        host.hidden = !visible;
        host.setAttribute('aria-hidden', String(!visible));
    }
}

function setCharacterImportPanelVisible(visible) {
    const host = document.getElementById('sb_character_import_panel');

    if (host instanceof HTMLElement) {
        host.hidden = !visible;
        host.setAttribute('aria-hidden', String(!visible));
    }
}

function setCharacterWorldInfoPanelVisible(visible) {
    const host = ensureCharacterWorldInfoPanel() ?? document.getElementById('sb_character_world_info_panel');
    const content = document.getElementById('WorldInfo');

    if (host instanceof HTMLElement) {
        host.hidden = !visible;
        host.setAttribute('aria-hidden', String(!visible));
    }

    if (content instanceof HTMLElement) {
        content.setAttribute('aria-hidden', String(!visible));
    }
}

function getCharacterEditorSubTabState() {
    const storedTab = safeGetItem(SB_STORAGE_KEYS.characterEditorSubTab);
    return normalizeCharacterEditorSubTab(storedTab);
}

function saveCharacterEditorSubTab(tabId) {
    safeSetItem(SB_STORAGE_KEYS.characterEditorSubTab, normalizeCharacterEditorSubTab(tabId));
}

function updateCharacterEditorSubTabButtons(activeTabId) {
    const activeSubTab = resolveCharacterEditorSubTab(activeTabId);

    for (const tabButton of document.querySelectorAll('#sb_character_editor_subtabs [data-sb-character-editor-tab]')) {
        if (!(tabButton instanceof HTMLElement)) {
            continue;
        }

        const isActive = tabButton.dataset.sbCharacterEditorTab === activeSubTab;
        tabButton.classList.toggle('is-active', isActive);
        tabButton.setAttribute('aria-selected', String(isActive));
        tabButton.setAttribute('tabindex', isActive ? '0' : '-1');
    }
}

function updateCharacterEditorSubTabPanels(activeTabId) {
    const activeSubTab = resolveCharacterEditorSubTab(activeTabId);

    for (const panel of document.querySelectorAll('#form_create [data-sb-character-editor-panel]')) {
        if (!(panel instanceof HTMLElement)) {
            continue;
        }

        const isActive = panel.dataset.sbCharacterEditorPanel === activeSubTab;
        panel.hidden = !isActive;
        panel.setAttribute('aria-hidden', String(!isActive));
    }
}

function syncCharacterEditorSubTabs(activeTabId = getCharacterEditorSubTabState()) {
    const normalizedTab = resolveCharacterEditorSubTab(activeTabId);
    saveCharacterEditorSubTab(normalizedTab);
    updateCharacterEditorSubTabButtons(normalizedTab);
    updateCharacterEditorSubTabPanels(normalizedTab);
}

function focusCharacterEditorSubTab(tabId) {
    const button = document.querySelector(`#sb_character_editor_subtabs [data-sb-character-editor-tab="${tabId}"]`);
    if (button instanceof HTMLElement) {
        button.focus({ preventScroll: true });
    }
}

function setCharacterEditorSubTab(tabId, { focusButton = false } = {}) {
    const normalizedTab = normalizeCharacterEditorSubTab(tabId);
    syncCharacterEditorSubTabs(normalizedTab);

    if (focusButton) {
        focusCharacterEditorSubTab(normalizedTab);
    }
}

function setCharacterEditorFullscreenState(expanded, { focusButton = false } = {}) {
    const panel = getCharacterPanel();
    const toggleButton = document.getElementById('sb_character_editor_fullscreen_toggle');
    const wasExpanded = panel instanceof HTMLElement && panel.classList.contains('sb-character-editor-fullscreen');
    const canExpand = panel instanceof HTMLElement
        && panel.classList.contains('openDrawer')
        && isCharacterEditorMenuType(panel.dataset.menuType);
    const isExpanded = Boolean(expanded) && canExpand;

    if (panel instanceof HTMLElement) {
        panel.classList.toggle('sb-character-editor-fullscreen', isExpanded);
        panel.dataset.sbCharacterEditorFullscreen = String(isExpanded);
    }

    if (toggleButton instanceof HTMLButtonElement) {
        setButtonPressed(toggleButton, isExpanded);
        toggleButton.title = isExpanded ? 'Exit editor fullscreen' : 'Enter editor fullscreen';
        toggleButton.setAttribute('aria-label', toggleButton.title);
        toggleButton.setAttribute('aria-expanded', String(isExpanded));
        toggleButton.dataset.i18n = isExpanded
            ? '[title]Exit editor fullscreen;[aria-label]Exit editor fullscreen'
            : '[title]Enter editor fullscreen;[aria-label]Enter editor fullscreen';

        if (focusButton) {
            toggleButton.focus({ preventScroll: true });
        }
    }

    if (isExpanded && !wasExpanded) {
        document.getElementById('sb_character_editor_subtabs')?.scrollIntoView({ block: 'nearest' });
    }
}

function setCharacterPanelMenuType(panel, menuType) {
    if (!(panel instanceof HTMLElement)) {
        return;
    }

    if (!isCharacterEditorMenuType(menuType)) {
        setCharacterEditorFullscreenState(false);
    }

    panel.dataset.menuType = menuType;
    if (panel.dataset.menuType !== menuType) {
        panel.setAttribute('data-menu-type', menuType);
    }
}

function toggleCharacterEditorFullscreen() {
    const panel = getCharacterPanel();
    if (!(panel instanceof HTMLElement) || !panel.classList.contains('openDrawer') || !isCharacterEditorMenuType(panel.dataset.menuType)) {
        return;
    }

    setCharacterEditorFullscreenState(!panel.classList.contains('sb-character-editor-fullscreen'), { focusButton: true });
}

function syncCharacterEditorFullscreenAvailability() {
    const panel = getCharacterPanel();
    const toggleButton = document.getElementById('sb_character_editor_fullscreen_toggle');
    const canUseFullscreen = panel instanceof HTMLElement
        && isCharacterEditorMenuType(panel.dataset.menuType)
        && panel.classList.contains('openDrawer');

    if (toggleButton instanceof HTMLButtonElement) {
        toggleButton.hidden = !canUseFullscreen;
    }

    if (!canUseFullscreen) {
        setCharacterEditorFullscreenState(false);
    }
}

function bindCharacterEditorFullscreenToggle() {
    const toggleButton = document.getElementById('sb_character_editor_fullscreen_toggle');
    if (!(toggleButton instanceof HTMLButtonElement) || toggleButton.dataset.sbBound === 'true') {
        return;
    }

    toggleButton.dataset.sbBound = 'true';
    toggleButton.addEventListener('click', () => toggleCharacterEditorFullscreen());

    const panel = getCharacterPanel();
    if (panel instanceof HTMLElement && panel.dataset.sbEditorFullscreenKeyBound !== 'true') {
        panel.dataset.sbEditorFullscreenKeyBound = 'true';
        panel.addEventListener('keydown', (event) => {
            if (event.key !== 'Escape' || !panel.classList.contains('sb-character-editor-fullscreen')) {
                return;
            }

            setCharacterEditorFullscreenState(false, { focusButton: true });
            event.preventDefault();
            event.stopPropagation();
        });
    }

    syncCharacterEditorFullscreenAvailability();
}

function focusCharacterPanelTab(tabId) {
    const normalizedTabId = normalizeCharacterPanelTab(tabId);
    const button = getCharacterPanel()?.querySelector(`[data-sb-character-tab="${CSS.escape(normalizedTabId)}"]`);

    if (button instanceof HTMLElement) {
        button.focus({ preventScroll: true });
    }
}

function bindCharacterEditorSubTabs() {
    const tablist = document.getElementById('sb_character_editor_subtabs');
    if (!(tablist instanceof HTMLElement) || tablist.dataset.sbBound === 'true') {
        return;
    }

    tablist.dataset.sbBound = 'true';

    tablist.addEventListener('click', (event) => {
        const target = event.target instanceof HTMLElement ? event.target.closest('[data-sb-character-editor-tab]') : null;
        if (!(target instanceof HTMLButtonElement)) {
            return;
        }

        setCharacterEditorSubTab(target.dataset.sbCharacterEditorTab, { focusButton: false });
    });

    tablist.addEventListener('keydown', (event) => {
        if (!(event.target instanceof HTMLElement)) {
            return;
        }

        const targetButton = event.target.closest('[data-sb-character-editor-tab]');
        if (!(targetButton instanceof HTMLButtonElement)) {
            return;
        }

        const buttons = Array.from(tablist.querySelectorAll('[data-sb-character-editor-tab]'));
        const currentIndex = buttons.indexOf(targetButton);
        if (currentIndex === -1) {
            return;
        }

        const lastIndex = buttons.length - 1;
        let nextIndex = currentIndex;

        if (event.key === 'ArrowRight') {
            nextIndex = currentIndex === lastIndex ? 0 : currentIndex + 1;
        } else if (event.key === 'ArrowLeft') {
            nextIndex = currentIndex === 0 ? lastIndex : currentIndex - 1;
        } else if (event.key === 'Home') {
            nextIndex = 0;
        } else if (event.key === 'End') {
            nextIndex = lastIndex;
        } else {
            return;
        }

        event.preventDefault();
        const nextButton = buttons[nextIndex];
        if (nextButton instanceof HTMLButtonElement) {
            setCharacterEditorSubTab(nextButton.dataset.sbCharacterEditorTab, { focusButton: true });
        }
    });

    syncCharacterEditorSubTabs();
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

function openCharacterPanelTab(tabId) {
    const normalizedTabId = normalizeCharacterPanelTab(tabId);
    sbState.characterDrawer.lastTab = normalizedTabId;

    if (normalizedTabId !== 'editor') {
        setCharacterEditorFullscreenState(false);
    }

    if (normalizedTabId === 'world-info' || normalizedTabId === 'persona') {
        preloadPanelStylesheets('characters', normalizedTabId);
    }

    if (!isCharacterPanelOpen()) {
        toggleCharacterPanel({ preferredTab: normalizedTabId });
    } else {
        applyMobileSurfaceExclusivity(sbMobileShellLifecycle.overlays.resolveExclusiveOpen({
            surface: sbMobileShellLifecycle.overlays.surface.CHARACTER_PANEL,
            isMobileViewport: isMobileViewport(),
        }));
    }

    const activateRequestedTab = () => {
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
    };

    window.requestAnimationFrame(() => {
        window.requestAnimationFrame(activateRequestedTab);
    });
}

function restoreLastCharacterPanelView() {
    const lastTab = sbState.characterDrawer.lastTab || 'characters';

    if (lastTab === 'persona') {
        openCharacterPersonaTab();
    } else if (lastTab === 'import') {
        openCharacterImportTab();
    } else if (lastTab === 'world-info') {
        openCharacterWorldInfoTab();
    } else if (lastTab === 'groups') {
        void showCharacterListView('groups');
    } else if (lastTab === 'editor') {
        void openCharacterEditorTab();
    } else {
        void showCharacterListView('characters');
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

function syncCharacterShellTabs(activeTab = null) {
    const panel = getCharacterPanel();
    const menuType = panel?.dataset.menuType;
    const normalizedTab = activeTab
        ?? (menuType === 'persona'
            ? 'persona'
            : menuType === 'import'
                ? 'import'
                : menuType === 'world-info'
                    ? 'world-info'
                    : menuType === 'groups'
                        ? 'groups'
                        : ['character_edit', 'group_edit', 'create', 'group_create', 'editor_empty'].includes(menuType) ? 'editor' : 'characters');

    sbState.characterDrawer.lastTab = normalizedTab;

    if (menuType === 'characters' || menuType === 'groups') {
        syncCharacterListControls(menuType);
    }

    syncCharacterHeaderCopy(normalizedTab);

    panel?.querySelectorAll('[data-sb-character-tab]').forEach(tab => {
        if (!(tab instanceof HTMLElement)) {
            return;
        }

        const isActive = tab.dataset.sbCharacterTab === normalizedTab;
        tab.classList.toggle('is-active', isActive);
        tab.setAttribute('aria-selected', String(isActive));
        tab.setAttribute('tabindex', isActive ? '0' : '-1');
    });

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

function syncCharacterHeaderCopy(activeTab = 'characters') {
    const copy = SB_CHARACTER_TAB_COPY[activeTab] ?? SB_CHARACTER_TAB_COPY.characters;
    const panel = getCharacterPanel();
    const title = panel?.querySelector('.sb-character-shell-header .sb-shell-title');
    const subtitle = panel?.querySelector('.sb-character-shell-header .sb-shell-subtitle');
    const description = panel?.querySelector('.sb-character-shell-header .sb-shell-description');

    if (title instanceof HTMLElement) {
        title.textContent = '';
        title.append(document.createTextNode(copy.title));
        if (activeTab === 'persona') {
            title.insertAdjacentHTML('beforeend', SB_PERSONA_HELP_LINK_HTML);
        }
    }

    if (subtitle instanceof HTMLElement) {
        subtitle.textContent = copy.subtitle;
    }

    if (description instanceof HTMLElement) {
        description.textContent = copy.description;
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

function resetCharacterPanelView() {
    const panel = getCharacterPanel();
    const listButton = document.getElementById('rm_button_characters');
    const selectedTitle = document.querySelector('#rm_button_selected_ch h2');

    if (selectedTitle instanceof HTMLElement) {
        selectedTitle.textContent = '';
    }

    setCharacterEditorEmptyState(false);
    setCharacterPersonaPanelVisible(false);
    setCharacterImportPanelVisible(false);
    setCharacterWorldInfoPanelVisible(false);

    if (listButton instanceof HTMLElement) {
        listButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        setCharacterPanelMenuType(panel, 'characters');
        syncCharacterListControls('characters');
        syncCharacterShellTabs('characters');
        return;
    }

    setCharacterPanelMenuType(panel, 'characters');

    const infoPanel = document.getElementById('result_info');
    const characterEditor = document.getElementById('rm_ch_create_block');
    const characterList = document.getElementById('rm_characters_block');

    if (infoPanel instanceof HTMLElement) {
        infoPanel.style.display = 'none';
    }

    if (characterEditor instanceof HTMLElement) {
        characterEditor.style.display = 'none';
        characterEditor.style.visibility = 'hidden';
        characterEditor.style.pointerEvents = 'none';
    }

    if (characterList instanceof HTMLElement) {
        characterList.style.display = 'flex';
        characterList.style.visibility = 'visible';
        characterList.style.pointerEvents = 'auto';
    }

    syncCharacterShellTabs('characters');
}

function setCharacterDrawerHostOverflow(shouldOpen) {
    const host = getCharacterDrawerHost();

    if (host instanceof HTMLElement) {
        host.style.overflow = shouldOpen ? 'visible' : '';
    }
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
    setCharacterDrawerHostOverflow(isOpen);
    syncDrawerIconState('#rightNavDrawerIcon', isOpen);
    syncDrawerIconState('#WIDrawerIcon', isOpen && panel.dataset.menuType === 'world-info');
    syncCharacterEditorFullscreenAvailability();

    if (!isOpen && document.activeElement instanceof HTMLElement && panel.contains(document.activeElement)) {
        document.activeElement.blur();
    }

    syncChatbarVisibilityState();
    queueMobileModalStateSync();
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
            syncCharacterEditorFullscreenAvailability();
            syncCharacterTitlebarVisibility();
            syncCharacterShellTabs();
        }
    });
    sbState.characterDrawer.stateObserver.observe(panel, {
        attributes: true,
        attributeFilter: ['class', 'data-menu-type'],
    });
    syncCharacterDrawerStateFromDom({ force: true });
}

function closeCharacterPanel() {
    const panel = getCharacterPanel();
    const shouldResetViewport = panel instanceof HTMLElement
        && (panel.classList.contains('openDrawer') || (document.activeElement instanceof HTMLElement && panel.contains(document.activeElement)));

    setCharacterEditorFullscreenState(false);

    if (panel instanceof HTMLElement && panel.classList.contains('openDrawer')) {
        forceDrawerState(panel, false, '#rightNavDrawerIcon');
    } else if (panel instanceof HTMLElement && document.activeElement instanceof HTMLElement && panel.contains(document.activeElement)) {
        document.activeElement.blur();
    }

    syncDrawerIconState('#WIDrawerIcon', false);
    setCharacterDrawerHostOverflow(false);
    syncChatbarVisibilityState();
    syncMobileShellDrawerBounds();
    queueMobileShellDrawerBoundsSync();
    queueMobileModalStateSync();

    if (shouldResetViewport) {
        requestMobileViewportReset();
    }
}

function ensureCharacterResizeHandle() {
    const panel = getCharacterPanel();
    if (!(panel instanceof HTMLElement)) {
        return null;
    }

    let handle = panel.querySelector(':scope > .sb-shell-resize-handle');
    if (handle instanceof HTMLElement) {
        return handle;
    }

    handle = createElement('div', {
        className: 'sb-shell-resize-handle',
        attrs: {
            title: 'Resize Characters panel',
        },
    });

    bindShellResizeHandle(handle, 'characters');
    panel.appendChild(handle);
    return handle;
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
    injectCharacterDrawerControls();
    ensureCharacterResizeHandle();

    if (isCharacterPanelOpen()) {
        closeCharacterPanel();
        return;
    }

    const normalizedPreferredTab = preferredTab ? normalizeCharacterPanelTab(preferredTab) : '';
    if (normalizedPreferredTab) {
        sbState.characterDrawer.lastTab = normalizedPreferredTab;
    }

    applyMobileSurfaceExclusivity(sbMobileShellLifecycle.overlays.resolveExclusiveOpen({
        surface: sbMobileShellLifecycle.overlays.surface.CHARACTER_PANEL,
        isMobileViewport: isMobileViewport(),
    }));
    closeAllDropdowns({ except: 'characters', closeSurfaces: false });
    restoreLastCharacterPanelView();

    // iOS Safari clips position:fixed inside overflow:hidden ancestors.
    // Temporarily allow overflow on the parent so the panel renders.
    setCharacterDrawerHostOverflow(true);

    // SillyBunny: dispatch a cancelable click on the native Characters toggle to give
    // extensions like CharacterLibrary a chance to intercept. If they preventDefault(),
    // they handle the UI themselves and we yield. Otherwise, we proceed with shell's
    // normal open flow (Sillyanonymous/SillyTavern-CharacterLibrary#28).
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
                setCharacterDrawerHostOverflow(false);
                return;
            }
        }
    }

    // No extension intercepted — proceed with shell's normal open flow.
    // SillyBunny: open the character drawer directly via forceDrawerState instead of
    // synthetic-clicking the hidden native toggle. The old approach triggered handlers
    // anchored to the hidden toggle's zero-size bounding rect, breaking extensions that
    // anchor dropdowns/popups to native toggle positions (e.g. CharacterLibrary).
    forceDrawerState('right-nav-panel', true, '#rightNavDrawerIcon');
    syncMobileShellDrawerBounds();
    queueMobileShellDrawerBoundsSync();

    window.requestAnimationFrame(() => {
        if (!isCharacterPanelOpen()) {
            forceDrawerState('right-nav-panel', true, '#rightNavDrawerIcon');
        }

        restoreLastCharacterPanelView();

        syncChatbarVisibilityState();
        syncMobileShellDrawerBounds();
        queueMobileShellDrawerBoundsSync();
        syncDesktopShellSizing();
        queueMobileModalStateSync();
    });
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
    if (shellKey === 'characters') {
        if (isCharacterPanelTabOpen(tabId)) {
            closeCharacterPanel();
            return;
        }

        openCharacterPanelTab(tabId);
        return;
    }

    if (shellKey === 'left' && tabId === 'world-info') {
        // SillyBunny: final guard for old code paths that still ask for the
        // removed left-shell World Info route.
        openCharacterPanelTab('world-info');
        return;
    }

    if (!ensureShellReady(shellKey)) {
        return;
    }

    preloadPanelStylesheets(shellKey, tabId);

    if (tabId ? isShellTabOpen(shellKey, tabId) : isShellOpen(shellKey)) {
        if (wasShellJustOpened(shellKey)) {
            return;
        }

        closeShell(shellKey);
        return;
    }

    rememberShellFocusOrigin(shellKey);
    const shellSurface = getMobileShellSurfaceForShell(shellKey);
    if (shellSurface) {
        applyMobileSurfaceExclusivity(sbMobileShellLifecycle.overlays.resolveExclusiveOpen({
            surface: shellSurface,
            isMobileViewport: isMobileViewport(),
        }));
        closeAllDropdowns({ except: shellKey, closeSurfaces: false });
    } else {
        closeAllDropdowns({ except: shellKey });
    }
    window.requestAnimationFrame(() => openShell(shellKey, tabId));
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

    for (const stylesheet of stylesheets) {
        window.SillyBunnyAssets.loadStylesheetAsync(stylesheet.href, { id: stylesheet.id }).catch(error => {
            console.warn('Failed to load panel stylesheet:', stylesheet.href, error);
        });
    }
}

function isLandingPageVisible() {
    return isActuallyVisible(document.querySelector('.welcomePanel'));
}

function syncHomeButtonState() {
    const homeButton = document.getElementById('sb-home-toggle');
    if (!(homeButton instanceof HTMLButtonElement)) {
        return;
    }

    const isHomeVisible = isLandingPageVisible();
    setButtonPressed(homeButton, isHomeVisible);
    homeButton.classList.toggle('is-current', isHomeVisible);

    if (isHomeVisible) {
        homeButton.setAttribute('aria-current', 'page');
    } else {
        homeButton.removeAttribute('aria-current');
    }
}

function queueLandingPageStateSync() {
    if (sbState.landingPageSyncFrame) {
        return;
    }

    sbState.landingPageSyncFrame = window.requestAnimationFrame(() => {
        sbState.landingPageSyncFrame = 0;
        syncHomeButtonState();
    });
}

function bindLandingPageObserver() {
    const chatRoot = document.getElementById('chat');
    if (!(chatRoot instanceof HTMLElement)) {
        return;
    }

    sbState.landingPageObserver?.disconnect();

    const observer = new MutationObserver(() => {
        queueLandingPageStateSync();
    });

    observer.observe(chatRoot, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style', 'hidden'],
    });

    sbState.landingPageObserver = observer;
    queueLandingPageStateSync();
}

async function returnToLandingPage() {
    closeShell('left');
    closeShell('right');
    closeCharacterPanel();
    closeMobileNav();
    closeMobileChatTools();
    setConnectionStripOpenState(false);

    if (isLandingPageVisible()) {
        queueLandingPageStateSync();
        document.getElementById('chat')?.scrollTo({
            top: 0,
            behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
        });
        return;
    }

    const context = getSillyTavernContext();

    if (typeof context?.closeCurrentChat === 'function') {
        await context.closeCurrentChat();
        queueLandingPageStateSync();
        return;
    }

    document.getElementById('option_close_chat')?.click();
    queueLandingPageStateSync();
}

function syncProxyButtonState(proxyButton, sourceIcon) {
    if (!(proxyButton instanceof HTMLElement) || !(sourceIcon instanceof HTMLElement)) {
        return;
    }

    const isOpen = sourceIcon.classList.contains('openIcon');
    const isPinned = sourceIcon.classList.contains('drawerPinnedOpen');

    proxyButton.classList.toggle('is-open', isOpen);
    proxyButton.classList.toggle('is-pinned', isPinned);
    proxyButton.setAttribute('aria-expanded', String(isOpen));
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

function wasShellJustOpened(shellKey) {
    const shellState = getShellState(shellKey);
    if (!shellState) {
        return false;
    }

    return (performance.now() - Number(shellState.lastOpenedAt || 0)) < SB_SHELL_TOGGLE_GUARD_MS;
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
            'aria-label': SB_UNIVERSAL_SEARCH_PLACEHOLDER,
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
            'aria-label': 'Universal search results',
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

    searchInput.addEventListener('input', () => {
        setUniversalSearchOpenState(true);
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
            const firstMatch = resultButtons[sbState.universalSearch.activeIndex] ?? resultButtons[0];
            if (firstMatch instanceof HTMLButtonElement) {
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
    // the bar. Re-append them after the shell layout is built so extensions targeting
    // #top-bar (e.g. CharacterLibrary in standalone mode) aren't orphaned.
    const preservedExtensionChildren = Array.from(topBar.children)
        .filter(child => !(child instanceof HTMLElement) || !child.id.startsWith('sb-'));

    topBar.replaceChildren();

    const stack = createElement('div', { id: 'sb-topbar-stack' });
    const primaryRow = createElement('div', { id: 'sb-topbar-primary' });
    const searchRow = buildUniversalSearchRow();
    const topBarInner = createElement('div', { id: 'sb-topbar-inner' });
    const leftGroup = createElement('div', { className: 'sb-topbar-group sb-topbar-group-left' });
    const centerGroup = createElement('div', { className: 'sb-topbar-brand' });
    const rightGroup = createElement('div', { className: 'sb-topbar-group sb-topbar-group-right' });

    const mobileButton = createElement('button', {
        id: 'sb-hamburger',
        className: 'sb-proxy-button sb-mobile-toggle',
        attrs: {
            type: 'button',
            title: 'Open navigation',
            'aria-label': 'Open navigation',
            'aria-expanded': 'false',
        },
    });
    mobileButton.innerHTML = `<i class="fa-solid ${SB_MOBILE_NAV_CLOSED_ICON}" aria-hidden="true"></i>`;
    stopProxyPointerPropagation(mobileButton);
    mobileButton.addEventListener('click', toggleMobileNav);

    const leftButton = createProxyButton(
        {
            id: 'sb-left-shell-toggle',
            icon: getShellConfig('left').proxyIcon,
            label: getShellConfig('left').proxyLabel,
            title: 'Open workspace tools',
        },
        () => toggleShellPanel('left'),
    );

    const homeButton = createProxyButton(
        {
            id: 'sb-home-toggle',
            icon: 'fa-house',
            label: 'Home',
            title: 'Return to the landing page',
        },
        () => {
            closeMobileNav();
            void returnToLandingPage();
        },
    );

    const rightButton = createProxyButton(
        {
            id: 'sb-right-shell-toggle',
            icon: getShellConfig('right').proxyIcon,
            label: getShellConfig('right').proxyLabel,
            title: 'Open customization tools',
        },
        () => toggleShellPanel('right'),
    );

    const charactersButton = createProxyButton(
        {
            id: 'sb-character-toggle',
            icon: 'fa-address-card',
            label: 'Characters',
            title: 'Open character management',
        },
        () => toggleCharacterPanel(),
    );

    const leftShortcutConfig = getShortcutConfig(getShortcutTarget('left'));
    const leftShortcut = createProxyButton(
        {
            id: 'sb-shortcut-left',
            icon: leftShortcutConfig.icon,
            label: leftShortcutConfig.label,
            title: `Quick access: ${leftShortcutConfig.label}`,
            className: 'sb-proxy-button-icon-only',
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
            title: `Quick access: ${rightShortcutConfig.label}`,
            className: 'sb-proxy-button-icon-only',
        },
        () => activateShortcutTarget(getShortcutTarget('right')),
    );
    bindSearchShortcutPreFocus(rightShortcut, () => getShortcutTarget('right'));

    centerGroup.innerHTML = `
        <div id="sb-topbar-title" class="sb-brand-title">${SB_IDLE_BRAND_LABEL}</div>
    `;

    leftGroup.append(mobileButton, leftButton, rightButton, leftShortcut);
    rightGroup.append(rightShortcut, homeButton, charactersButton);
    topBarInner.append(leftGroup, centerGroup, rightGroup);
    primaryRow.appendChild(topBarInner);

    stack.append(primaryRow, searchRow);
    topBar.append(stack, ...preservedExtensionChildren);

    observeProxyButton('sb-left-shell-toggle', getShellConfig('left').hostIconSelector);
    observeProxyButton('sb-right-shell-toggle', getShellConfig('right').hostIconSelector);
    observeProxyButton('sb-character-toggle', '#rightNavDrawerIcon');
    bindTopBarBrand();
    updateTopBarBrand();
    updateTopbarUtilityButtons();
    updateShortcutButton('left');
    updateShortcutButton('right');
    syncTopbarLayoutState();
    queueLandingPageStateSync();
    scheduleCharacterToggleGhostSync();
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

    // SillyBunny: World Info is no longer a left/top-level drawer, but keeping
    // the upstream drawer ID preserves legacy selectors until runtime reparents it.
    const worldInfoDrawer = document.getElementById('WI-SP-button');
    worldInfoDrawer?.classList.add('sb-drawer-host');
    worldInfoDrawer?.querySelector(':scope > .drawer-toggle')?.classList.add('sb-hidden-toggle');
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

function closeFocusedShell() {
    const activeElement = document.activeElement;

    if (!(activeElement instanceof HTMLElement)) {
        return false;
    }

    const shellRoot = activeElement.closest('.sb-shell-root.openDrawer');
    if (!(shellRoot instanceof HTMLElement)) {
        return false;
    }

    const shellKey = shellRoot.dataset.sbShellKey;
    if (!shellKey || !getShellState(shellKey)) {
        return false;
    }

    closeShell(shellKey);
    return true;
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

    // Clean up any persistent inline styles or state
    drawerContent.removeAttribute('style');
    drawer.style.display = '';
    drawer.style.visibility = '';
    drawer.style.opacity = '';

    if (drawerId === 'WI-SP-button') {
        drawer.querySelector('#WI_panel_pin_div')?.classList.add('sb-shell-hidden-control');
    }

    return { drawer, drawerContent };
}

const SB_SAMPLING_BACKENDS = Object.freeze([
    {
        id: 'openai',
        apiIds: ['openai'],
        title: 'Chat Completions',
        description: 'Uses the active Chat Completions provider and its provider-specific sampler support.',
        controls: [
            '#seed_openai',
            '#openai_logit_bias_preset',
            '#temp_openai',
            '#claude_disable_temperature',
            '#top_p_openai',
            '#claude_disable_top_p',
            '#repetition_penalty_openai',
            '#freq_pen_openai',
            '#pres_pen_openai',
            '#top_k_openai',
            '#min_p_openai',
            '#top_a_openai',
        ],
    },
    {
        id: 'textgenerationwebui',
        apiIds: ['textgenerationwebui'],
        title: 'Text Completions',
        description: 'Uses the selected Text Completions backend and sampler visibility rules.',
        controls: [
            '#seed_textgenerationwebui',
            '#n_textgenerationwebui',
            '#samplerResetButton',
            '#sampler_order_block_kcpp',
            '#sampler_order_block_lcpp',
            '#sampler_priority_block_ooba',
            '#sampler_priority_block_aphrodite',
            '#json_schema_block',
            '#banned_tokens_block_ooba',
            '#logit_bias_block_ooba',
            '#temp_textgenerationwebui',
            '#top_k_textgenerationwebui',
            '#top_p_textgenerationwebui',
            '#typical_p_textgenerationwebui',
            '#min_p_textgenerationwebui',
            '#top_a_textgenerationwebui',
            '#tfs_textgenerationwebui',
            '#epsilon_cutoff_textgenerationwebui',
            '#nsigma_textgenerationwebui',
            '#min_keep_textgenerationwebui',
            '#eta_cutoff_textgenerationwebui',
            '#rep_pen_textgenerationwebui',
            '#rep_pen_range_textgenerationwebui',
            '#rep_pen_slope_textgenerationwebui',
            '#rep_pen_decay_textgenerationwebui',
            '#encoder_rep_pen_textgenerationwebui',
            '#freq_pen_textgenerationwebui',
            '#presence_pen_textgenerationwebui',
            '#no_repeat_ngram_size_textgenerationwebui',
            '#skew_textgenerationwebui',
            '#min_length_textgenerationwebui',
            '#max_tokens_second_textgenerationwebui',
            '#adaptive_p_block',
            '#smoothingBlock',
            '#xtc_block',
            '#dryBlock',
            '#dynatemp_block_ooba',
            '#mirostat_block_ooba',
            '#beamSearchBlock',
            '#contrastiveSearchBlock',
            '#do_sample_textgenerationwebui',
            '#add_bos_token_textgenerationwebui',
            '#ignore_eos_token_textgenerationwebui',
            '#include_reasoning_textgenerationwebui',
            '#temperature_last_textgenerationwebui',
            '#speculative_ngram_textgenerationwebui',
            '#spaces_between_special_tokens_textgenerationwebui',
            '#cfg_block_ooba',
            '#grammar_block_ooba',
        ],
    },
    {
        id: 'kobold',
        apiIds: ['kobold', 'koboldhorde'],
        title: 'Kobold / Horde',
        description: 'Kobold Horde reuses Kobold sampler settings; Horde still requires a non-GUI preset.',
        controls: ['#temp', '#top_p', '#rep_pen'],
    },
    {
        id: 'novel',
        apiIds: ['novel'],
        title: 'NovelAI',
        description: 'Uses NovelAI preset sampling fields without changing the backend request format.',
        controls: [
            '#temp_novel',
            '#rep_pen_novel',
            '#rep_pen_size_novel',
            '#rep_pen_slope_novel',
            '#rep_pen_freq_novel',
            '#rep_pen_presence_novel',
            '#min_p_novel',
            '#tail_free_sampling_novel',
            '#top_p_novel',
            '#top_a_novel',
            '#top_k_novel',
            '#mirostat_tau_novel',
            '#mirostat_lr_novel',
            '#typical_p_novel',
            '#math1_temp_novel',
            '#math1_quad_novel',
            '#math1_quad_entropy_scale_novel',
            '#min_length_novel',
        ],
    },
]);

const SB_LARGE_SAMPLING_CONTROLS = Object.freeze(new Set([
    '#seed_openai',
    '#openai_logit_bias_preset',
    '#samplerResetButton',
    '#n_textgenerationwebui',
    '#seed_textgenerationwebui',
    '#banned_tokens_block_ooba',
    '#logit_bias_block_ooba',
    '#json_schema_block',
    '#sampler_order_block_kcpp',
    '#sampler_order_block_lcpp',
    '#sampler_priority_block_ooba',
    '#sampler_priority_block_aphrodite',
]));

const SB_COMPACT_PRIORITY_SAMPLING_CONTROLS = Object.freeze(new Set([
    '#samplerResetButton',
    '#n_textgenerationwebui',
    '#seed_textgenerationwebui',
    '#json_schema_block',
]));

const SB_WIDE_PRIORITY_SAMPLING_CONTROLS = Object.freeze(new Set([
    '#sampler_order_block_kcpp',
    '#sampler_order_block_lcpp',
    '#sampler_priority_block_ooba',
    '#sampler_priority_block_aphrodite',
]));

const SB_AFTER_SAMPLER_CONTROLS = Object.freeze(new Set([
    '#sampler_order_block_kcpp',
    '#sampler_order_block_lcpp',
    '#sampler_priority_block_ooba',
    '#sampler_priority_block_aphrodite',
    '#json_schema_block',
]));

const SB_BOTTOM_PRIORITY_SAMPLING_CONTROLS = Object.freeze(new Set([
    '#banned_tokens_block_ooba',
    '#logit_bias_block_ooba',
]));

const SB_MULTI_SAMPLING_CONTROLS = Object.freeze(new Set([
    '#adaptive_p_block',
    '#smoothingBlock',
    '#xtc_block',
    '#dryBlock',
    '#dynatemp_block_ooba',
    '#mirostat_block_ooba',
    '#beamSearchBlock',
    '#contrastiveSearchBlock',
]));

function getSamplingPriorityTier(selector) {
    if (SB_AFTER_SAMPLER_CONTROLS.has(selector)) {
        return 'after';
    }

    if (SB_BOTTOM_PRIORITY_SAMPLING_CONTROLS.has(selector)) {
        return 'bottom';
    }

    if (SB_LARGE_SAMPLING_CONTROLS.has(selector)) {
        return 'top';
    }

    return '';
}

function getSpecialTokenControlBlock() {
    const controls = [
        document.getElementById('ban_eos_token_textgenerationwebui')?.closest('.checkbox_label'),
        document.getElementById('skip_special_tokens_textgenerationwebui')?.closest('.checkbox_label'),
    ].filter(control => control instanceof HTMLElement);

    if (!controls.length) {
        return null;
    }

    const block = createElement('div', { className: 'sb-sampling-special-token-controls' });
    controls.forEach(control => block.appendChild(control));
    return block;
}

function getSamplerToolbarControlBlock() {
    const toolbar = getSamplingControlBlock('#samplerResetButton');
    if (!(toolbar instanceof HTMLElement)) {
        return null;
    }

    const block = createElement('div', { className: 'sb-sampling-sampler-tools-card' });
    block.appendChild(toolbar);

    const specialTokenControls = getSpecialTokenControlBlock();
    if (specialTokenControls) {
        block.appendChild(specialTokenControls);
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

function decorateSamplingControlCard(card, selector) {
    if (!(card instanceof HTMLElement)) {
        return;
    }

    if (selector === '#seed_textgenerationwebui') {
        const seedLabel = card.querySelector('label');
        seedLabel?.classList.add('range-block-title', 'justifyLeft', 'sb-sampling-seed-title');
        seedLabel?.insertAdjacentElement('afterend', createElement('small', {
            className: 'sb-sampling-card-help',
            text: 'Set to get deterministic results. Use -1 for a random seed.',
        }));
    }

    if (selector === '#seed_openai') {
        const row = createElement('small', { className: 'sb-chat-neutralize-row flex-container alignitemscenter' });
        const button = createElement('button', {
            className: 'menu_button menu_button_icon sb-neutralize-chat-samplers',
            text: 'Neutralize Samplers',
            attrs: { type: 'button' },
        });
        const info = createElement('div', {
            className: 'fa-solid fa-circle-info opacity50p',
            attrs: {
                title: 'Set all samplers to their neutral/disabled state.',
                'data-i18n': '[title]Set all samplers to their neutral/disabled state.',
            },
        });
        button.addEventListener('click', neutralizeChatCompletionSamplers);
        row.append(button, info);
        card.appendChild(row);
    }
}

function getSamplingControlBlock(selector) {
    const input = document.querySelector(selector);
    if (!(input instanceof HTMLElement)) {
        return null;
    }

    if (input.id === 'samplerResetButton' || input.id === 'samplerSelectButton') {
        return input.closest('.flex-container.justifyCenter') ?? input.parentElement;
    }

    return input.closest('.range-block')
        ?? input.closest('[data-tg-samplers]')
        ?? input.parentElement;
}

function buildSamplingControlCard(selector) {
    const controlBlock = selector === '#samplerResetButton'
        ? getSamplerToolbarControlBlock()
        : getSamplingControlBlock(selector);
    if (!(controlBlock instanceof HTMLElement)) {
        return null;
    }

    const isTextGenSampler = controlBlock.hasAttribute('data-tg-samplers') || controlBlock.querySelector('[data-tg-samplers]');
    const card = createElement('div', {
        className: [
            'sb-sampling-control-card',
            isTextGenSampler ? 'sb-sampling-textgen-card' : '',
            SB_LARGE_SAMPLING_CONTROLS.has(selector) ? 'sb-sampling-large-card' : '',
            SB_COMPACT_PRIORITY_SAMPLING_CONTROLS.has(selector) ? 'sb-sampling-compact-priority-card' : '',
            SB_WIDE_PRIORITY_SAMPLING_CONTROLS.has(selector) ? 'sb-sampling-wide-priority-card' : '',
            SB_MULTI_SAMPLING_CONTROLS.has(selector) ? 'sb-sampling-multi-card' : '',
            getSamplingPriorityTier(selector) ? `sb-sampling-priority-${getSamplingPriorityTier(selector)}` : '',
        ].filter(Boolean).join(' '),
    });
    card.dataset.sbSamplingControl = selector;
    for (const attributeName of ['data-source', 'data-source-mode']) {
        if (controlBlock.hasAttribute(attributeName)) {
            card.setAttribute(attributeName, controlBlock.getAttribute(attributeName));
        }
    }

    card.appendChild(controlBlock);
    decorateSamplingControlCard(card, selector);
    return card;
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
    document.querySelectorAll('#range_block_openai .sb-openai-settings-drawer, #textgenerationwebui_api-settings .sb-textgen-drawers > .inline-drawer').forEach(drawer => {
        if (!(drawer instanceof HTMLElement)) {
            return;
        }

        drawer.style.display = drawerHasControls(drawer) ? '' : 'none';
    });
}

function updateSamplingCardVisibility(section) {
    if (!(section instanceof HTMLElement)) {
        return;
    }

    section.querySelectorAll('[data-sb-sampling-control]').forEach(card => {
        if (!(card instanceof HTMLElement)) {
            return;
        }

        const hasVisibleContent = Array.from(card.children).some(child => child instanceof HTMLElement && getComputedStyle(child).display !== 'none');
        card.hidden = !hasVisibleContent;
    });

    section.querySelectorAll('.sb-sampling-priority-row').forEach(row => {
        if (!(row instanceof HTMLElement)) {
            return;
        }

        row.hidden = !Array.from(row.children).some(child => child instanceof HTMLElement && !child.hidden);
    });

    section.querySelectorAll('.sb-sampling-multi-grid').forEach(row => {
        if (!(row instanceof HTMLElement)) {
            return;
        }

        row.hidden = !Array.from(row.children).some(child => child instanceof HTMLElement && !child.hidden);
    });
}

function syncSamplingPanelControls(root) {
    if (!(root instanceof HTMLElement)) {
        return;
    }

    for (const backend of SB_SAMPLING_BACKENDS) {
        const section = root.querySelector(`#sb-sampling-${backend.id}`);
        const priorityRows = {
            top: section?.querySelector('.sb-sampling-priority-row[data-sb-priority-tier="top"]'),
            bottom: section?.querySelector('.sb-sampling-priority-row[data-sb-priority-tier="bottom"]'),
            after: section?.querySelector('.sb-sampling-after-row[data-sb-priority-tier="after"]'),
        };
        const grid = section?.querySelector('.sb-sampling-grid');
        const multiGrid = section?.querySelector('.sb-sampling-multi-grid');
        if (!Object.values(priorityRows).every(row => row instanceof HTMLElement) || !(grid instanceof HTMLElement) || !(multiGrid instanceof HTMLElement)) {
            continue;
        }

        section.querySelector('.sb-sampling-note')?.remove();

        for (const selector of backend.controls) {
            const tier = getSamplingPriorityTier(selector);
            const target = tier ? priorityRows[tier] : (SB_MULTI_SAMPLING_CONTROLS.has(selector) ? multiGrid : grid);
            const existingCard = Array.from(section.querySelectorAll('[data-sb-sampling-control]'))
                .find(card => card instanceof HTMLElement && card.dataset.sbSamplingControl === selector);
            if (existingCard instanceof HTMLElement && existingCard.children.length > 0) {
                if (existingCard.parentElement !== target) {
                    target.appendChild(existingCard);
                }
                continue;
            }

            existingCard?.remove();

            const card = buildSamplingControlCard(selector);
            if (card) {
                target.appendChild(card);
            }
        }

        if (!Object.values(priorityRows).some(row => row.children.length) && !grid.children.length && !multiGrid.children.length) {
            grid.appendChild(createElement('p', {
                className: 'sb-sampling-note',
                text: 'Sampler controls are not ready yet. Reopen the Workspace menu after settings finish loading.',
            }));
        }

        updateSamplingCardVisibility(section);
    }

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

function buildSamplingPanel() {
    const { panel, scroller } = createShellPanel({ id: 'sampling' });
    const column = createElement('div', { className: 'sb-shell-column sb-sampling-panel' });

    const sections = createElement('div', { className: 'sb-sampling-sections' });

    for (const backend of SB_SAMPLING_BACKENDS) {
        const section = createElement('section', {
            id: `sb-sampling-${backend.id}`,
            className: 'sb-sampling-section',
            attrs: {
                'data-sb-sampling-apis': backend.apiIds.join(','),
            },
        });
        const header = createElement('div', { className: 'sb-sampling-section-header' });
        const titleRow = createElement('div', { className: 'sb-sampling-title-row' });
        const title = createElement('strong', { text: 'Sampling Backend' });
        const mode = createElement('span', { className: 'sb-sampling-mode-pill', text: backend.title });
        const description = createElement('p', { text: `Active backend samplers are shown here. ${backend.description}` });
        const priorityStack = createElement('div', { className: 'sb-sampling-priority-stack' });
        const priorityTop = createElement('div', { className: 'sb-sampling-priority-row sb-sampling-priority-row-top', attrs: { 'data-sb-priority-tier': 'top' } });
        const priorityBottom = createElement('div', { className: 'sb-sampling-priority-row sb-sampling-priority-row-bottom', attrs: { 'data-sb-priority-tier': 'bottom' } });
        const grid = createElement('div', { className: 'sb-sampling-grid' });
        const multiGrid = createElement('div', { className: 'sb-sampling-multi-grid' });
        const afterRow = createElement('div', { className: 'sb-sampling-priority-row sb-sampling-after-row', attrs: { 'data-sb-priority-tier': 'after' } });

        titleRow.append(title, mode);
        header.append(titleRow, description);

        priorityStack.append(priorityTop, priorityBottom);
        section.append(header, priorityStack, grid, multiGrid, afterRow);
        sections.appendChild(section);
    }

    const empty = createElement('div', {
        id: 'sb-sampling-empty',
        className: 'sb-sampling-empty sb-shell-callout',
        html: '<strong>No unified samplers for this backend yet</strong><p>This POC currently supports Chat Completions, Text Completions, Kobold/Kobold Horde, and NovelAI.</p>',
    });

    column.append(sections, empty);
    scroller.appendChild(column);

    $('#main_api').on('change.sbSamplingPanel', () => updateSamplingPanelVisibility(column));
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

    const column = createElement('div', { className: 'sb-shell-column' });
    const callout = createElement('div', { className: 'sb-shell-callout' });
    callout.innerHTML = `
        <strong>In-Chat Agents</strong>
        <p>Lightweight helpers that run alongside your conversation. Configure them per-chat for modular functionality.</p>
    `;

    const inChatAgentsContainer = createElement('div', { id: 'in_chat_agents_container' });

    column.append(callout, inChatAgentsContainer);
    scroller.appendChild(column);

    return {
        id: 'agents',
        panel,
        button: null,
        searchRoot: column,
    };
}

function getServerAdminState() {
    return sbState.serverAdmin;
}

function getServerAdminRefs() {
    return getServerAdminState().refs;
}

function getConsoleLogsState() {
    return sbState.consoleLogs;
}

function getConsoleLogsRefs() {
    return getConsoleLogsState().refs;
}

function isConsoleLogsTabActive() {
    return isShellTabOpen('right', 'console-logs');
}

function formatConsoleLogTime(timestamp) {
    const date = new Date(Number(timestamp));
    if (Number.isNaN(date.getTime())) {
        return '00:00:00';
    }

    return date.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    });
}

function formatConsoleLogDateTime(timestamp) {
    const date = new Date(Number(timestamp));
    if (Number.isNaN(date.getTime())) {
        return 'Unknown';
    }

    return date.toLocaleString([], {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    });
}

function formatConsoleLogEntry(entry) {
    const stream = String(entry?.stream ?? 'stdout').toUpperCase().padEnd(6);
    const message = String(entry?.message ?? '');
    return `[${formatConsoleLogTime(entry?.timestamp)}] ${stream} ${message}`;
}

function isScrolledNearBottom(element, threshold = SB_CONSOLE_LOG_STICKY_THRESHOLD) {
    if (!(element instanceof HTMLElement)) {
        return true;
    }

    return (element.scrollHeight - element.scrollTop - element.clientHeight) <= threshold;
}

function updateConsoleLogsInteractivity() {
    const state = getConsoleLogsState();
    const refs = getConsoleLogsRefs();

    if (!refs) {
        return;
    }

    refs.pauseButton.textContent = state.paused ? 'Resume Live' : 'Pause Live';
    setButtonDisabled(refs.refreshButton, state.busy);
}

function renderConsoleLogsStatus() {
    const state = getConsoleLogsState();
    const refs = getConsoleLogsRefs();

    if (!refs) {
        return;
    }

    if (state.lastError) {
        setServerAdminPill(refs.statusPill, 'Unavailable', 'danger');
        setServerAdminMessage(refs.statusNote, state.lastError, 'danger');
        return;
    }

    const linesShown = state.entries.length;
    const totalBuffered = state.totalBuffered || linesShown;
    const noteParts = [`Showing ${linesShown} of ${totalBuffered} recent console line${totalBuffered === 1 ? '' : 's'}.`];

    if (state.captureStartedAt) {
        noteParts.push(`Capture started ${formatConsoleLogDateTime(state.captureStartedAt)}.`);
    }

    if (state.lastUpdatedAt) {
        noteParts.push(`Last updated ${formatConsoleLogTime(state.lastUpdatedAt)}.`);
    }

    noteParts.push(state.paused
        ? 'Live polling is paused.'
        : `Refreshes every ${(SB_CONSOLE_LOG_REFRESH_MS / 1000).toFixed(1).replace(/\.0$/, '')} seconds while this tab is open.`);

    setServerAdminPill(refs.statusPill, state.busy ? 'Loading…' : state.paused ? 'Paused' : 'Live', state.paused ? 'warn' : 'good');
    setServerAdminMessage(refs.statusNote, noteParts.join(' '), state.paused ? 'warn' : 'neutral');
}

function renderConsoleLogsOutput({ preserveScroll = true } = {}) {
    const state = getConsoleLogsState();
    const refs = getConsoleLogsRefs();
    const output = refs?.output;

    if (!(output instanceof HTMLElement)) {
        return;
    }

    const shouldStickToBottom = !preserveScroll || isScrolledNearBottom(output);
    output.textContent = state.entries.length
        ? state.entries.map(formatConsoleLogEntry).join('\n')
        : 'No console output has been captured yet for this server process.';
    output.classList.toggle('is-empty', state.entries.length === 0);

    if (shouldStickToBottom) {
        output.scrollTop = output.scrollHeight;
    }

    renderConsoleLogsStatus();
}

function scheduleConsoleLogsRefresh(delay = SB_CONSOLE_LOG_REFRESH_MS) {
    const state = getConsoleLogsState();
    window.clearTimeout(state.refreshTimer);
    state.refreshTimer = 0;

    if (state.paused || !isConsoleLogsTabActive()) {
        return;
    }

    state.refreshTimer = window.setTimeout(() => {
        void refreshConsoleLogs();
    }, delay);
}

async function refreshConsoleLogs({ forceFull = false } = {}) {
    const state = getConsoleLogsState();
    const refs = getConsoleLogsRefs();

    if (!refs) {
        return;
    }

    window.clearTimeout(state.refreshTimer);
    state.refreshTimer = 0;

    if (state.busy) {
        scheduleConsoleLogsRefresh();
        return;
    }

    state.busy = true;
    updateConsoleLogsInteractivity();
    renderConsoleLogsStatus();

    const requestBody = {
        limit: SB_CONSOLE_LOG_LIMIT,
    };

    if (!forceFull && state.latestId > 0) {
        requestBody.afterId = state.latestId;
    }

    try {
        const data = await requestServerAdmin('/api/server-admin/logs', requestBody);
        const nextEntries = Array.isArray(data?.entries)
            ? data.entries.map(entry => ({
                id: Number(entry?.id ?? 0) || 0,
                timestamp: Number(entry?.timestamp ?? 0) || 0,
                stream: String(entry?.stream ?? 'stdout'),
                message: String(entry?.message ?? ''),
            })).filter(entry => entry.id > 0)
            : [];

        if (forceFull || !requestBody.afterId || data?.truncated) {
            state.entries = nextEntries.slice(-SB_CONSOLE_LOG_LIMIT);
        } else if (nextEntries.length > 0) {
            const mergedEntries = new Map(state.entries.map(entry => [entry.id, entry]));

            for (const entry of nextEntries) {
                mergedEntries.set(entry.id, entry);
            }

            state.entries = Array.from(mergedEntries.values())
                .sort((left, right) => left.id - right.id)
                .slice(-SB_CONSOLE_LOG_LIMIT);
        }

        state.latestId = Number(data?.latestId ?? state.latestId) || state.latestId;
        state.captureStartedAt = Number(data?.captureStartedAt ?? state.captureStartedAt) || state.captureStartedAt;
        state.totalBuffered = Number(data?.totalBuffered ?? state.totalBuffered) || state.totalBuffered;
        state.lastUpdatedAt = Date.now();
        state.lastError = '';
        renderConsoleLogsOutput();
    } catch (error) {
        console.error('Failed to refresh console logs panel.', error);
        state.lastError = error.message || 'Failed to read console logs.';
        renderConsoleLogsStatus();
    } finally {
        state.busy = false;
        updateConsoleLogsInteractivity();
        renderConsoleLogsStatus();
        scheduleConsoleLogsRefresh();
    }
}

function toggleConsoleLogsPolling() {
    const state = getConsoleLogsState();
    state.paused = !state.paused;

    if (state.paused) {
        window.clearTimeout(state.refreshTimer);
        state.refreshTimer = 0;
    }

    updateConsoleLogsInteractivity();
    renderConsoleLogsStatus();

    if (!state.paused) {
        void refreshConsoleLogs({ forceFull: state.latestId === 0 });
    }
}

function getImporterState() {
    return sbState.importer;
}

function getImporterRefs() {
    return getImporterState().refs;
}

async function requestServerAdmin(endpoint, body = {}) {
    const headers = await waitForAuthorizedRequestHeaders();
    const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    });

    const text = await response.text();
    let data = null;

    try {
        data = text ? JSON.parse(text) : {};
    } catch {
        data = { message: text };
    }

    if (!response.ok) {
        const message = response.status === 403
            ? 'Server tools are only available after an admin session is ready.'
            : data?.error || data?.message || text || `Request failed with status ${response.status}.`;
        const error = new Error(message);
        error.status = response.status;
        error.data = data;
        throw error;
    }

    return data;
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

function setServerAdminButtonLabel(button, isBusy, busyLabel) {
    if (!(button instanceof HTMLButtonElement)) {
        return;
    }

    if (!button.dataset.idleLabel) {
        button.dataset.idleLabel = button.textContent || '';
    }

    button.textContent = isBusy ? busyLabel : button.dataset.idleLabel;
}

function describeAutoStashState(result) {
    if (!result?.stashed) {
        return '';
    }

    if (result?.stashPopWarning) {
        return result.stashPopWarning;
    }

    return 'Local tracked and untracked changes were auto-stashed and restored.';
}

function getThumbnailSettingsFromRefs(refs = getServerAdminRefs()) {
    const parseSize = (input, fallback) => {
        const value = Number.parseInt(input?.value, 10);
        return Number.isFinite(value) ? Math.min(4096, Math.max(1, value)) : fallback;
    };

    return {
        enabled: Boolean(refs?.thumbnailEnabled?.checked),
        format: refs?.thumbnailFormat?.value === 'jpg' ? 'jpg' : 'png',
        quality: parseSize(refs?.thumbnailQuality, 100),
        dimensions: {
            bg: [
                parseSize(refs?.thumbnailBgWidth, 240),
                parseSize(refs?.thumbnailBgHeight, 135),
            ],
            avatar: [
                parseSize(refs?.thumbnailAvatarWidth, 864),
                parseSize(refs?.thumbnailAvatarHeight, 1280),
            ],
            persona: [
                parseSize(refs?.thumbnailPersonaWidth, 864),
                parseSize(refs?.thumbnailPersonaHeight, 1280),
            ],
        },
    };
}

function setThumbnailInputValues(settings = {}, refs = getServerAdminRefs()) {
    if (!refs) {
        return;
    }

    refs.thumbnailEnabled.checked = Boolean(settings.enabled);
    refs.thumbnailFormat.value = settings.format === 'jpg' ? 'jpg' : 'png';
    refs.thumbnailQuality.value = String(settings.quality ?? 100);
    refs.thumbnailBgWidth.value = String(settings.dimensions?.bg?.[0] ?? 240);
    refs.thumbnailBgHeight.value = String(settings.dimensions?.bg?.[1] ?? 135);
    refs.thumbnailAvatarWidth.value = String(settings.dimensions?.avatar?.[0] ?? 864);
    refs.thumbnailAvatarHeight.value = String(settings.dimensions?.avatar?.[1] ?? 1280);
    refs.thumbnailPersonaWidth.value = String(settings.dimensions?.persona?.[0] ?? 864);
    refs.thumbnailPersonaHeight.value = String(settings.dimensions?.persona?.[1] ?? 1280);
}

function setThumbnailInputsDisabled(disabled, refs = getServerAdminRefs()) {
    const controls = [
        refs?.thumbnailEnabled,
        refs?.thumbnailFormat,
        refs?.thumbnailQuality,
        refs?.thumbnailBgWidth,
        refs?.thumbnailBgHeight,
        refs?.thumbnailAvatarWidth,
        refs?.thumbnailAvatarHeight,
        refs?.thumbnailPersonaWidth,
        refs?.thumbnailPersonaHeight,
        refs?.thumbnailUseRecommendedButton,
        refs?.thumbnailSaveButton,
        refs?.thumbnailSaveClearButton,
        refs?.thumbnailClearButton,
    ];

    for (const control of controls) {
        if (control instanceof HTMLElement) {
            control.disabled = disabled;
        }
    }
}

function appendServerAdminStat(target, label, value) {
    if (!(target instanceof HTMLElement)) {
        return;
    }

    const item = createElement('div', { className: 'sb-server-stat' });
    const title = createElement('small', { className: 'sb-server-stat-label', text: label });
    const content = createElement('strong', { className: 'sb-server-stat-value', text: value || '—' });
    item.append(title, content);
    target.appendChild(item);
}

function updateServerConfigDirtyState() {
    const state = getServerAdminState();
    const refs = getServerAdminRefs();

    if (!refs?.configEditor || !refs.configState) {
        return false;
    }

    const isDirty = refs.configEditor.value !== state.originalConfig;
    refs.configState.textContent = isDirty ? 'Unsaved changes' : 'Saved';
    refs.configState.dataset.state = isDirty ? 'dirty' : 'saved';
    return isDirty;
}

function updateServerAdminInteractivity() {
    const state = getServerAdminState();
    const refs = getServerAdminRefs();

    if (!refs) {
        return;
    }

    const locked = state.busy || state.restarting;
    const thumbnailLocked = locked || !state.thumbnailSettingsLoaded;
    const canUpdate = refs.updateButton?.dataset.sbCanUpdate === 'true';
    const hasConfigContent = Boolean(refs.configEditor?.value.trim());

    setButtonDisabled(refs.refreshButton, locked);
    setButtonDisabled(refs.reloadConfigButton, locked);
    setButtonDisabled(refs.updateButton, locked || !canUpdate);
    setButtonDisabled(refs.restartButton, locked);
    setButtonDisabled(refs.saveConfigButton, locked || !hasConfigContent);
    setButtonDisabled(refs.saveConfigRestartButton, locked || !hasConfigContent);
    setThumbnailInputsDisabled(thumbnailLocked);

    if (refs.configEditor instanceof HTMLTextAreaElement) {
        refs.configEditor.disabled = locked;
    }
}

function renderServerAdminStatus(data) {
    const state = getServerAdminState();
    const refs = getServerAdminRefs();

    if (!refs) {
        return;
    }

    const repository = data?.repository ?? {};
    const release = data?.release ?? null;
    const version = data?.version ?? {};
    const isGitInstall = Boolean(repository?.supported && repository?.isRepo);
    const statusGrid = refs.statusGrid;
    statusGrid.replaceChildren();

    appendServerAdminStat(statusGrid, 'Runtime', data?.runtime || 'Unknown');
    appendServerAdminStat(statusGrid, 'Version', version?.pkgVersion ? `v${version.pkgVersion}` : 'Unknown');

    // Branch selector instead of static text
    const branchContainer = createElement('div', { className: 'sb-server-stat' });
    const branchLabel = createElement('div', { className: 'sb-server-stat-label' });
    branchLabel.textContent = isGitInstall ? 'Branch' : 'Install';
    const branchValue = createElement('div', { className: 'sb-server-stat-value' });
    const branchSelect = createElement('select', {
        id: 'sb-branch-select',
        className: 'text_pole',
        attrs: { style: 'width: 100%; max-width: 200px;' },
    });
    branchSelect.disabled = !isGitInstall;
    const currentBranch = isGitInstall ? (repository?.displayBranch || repository?.branch || version?.gitBranch || '') : 'Release ZIP';
    const currentOptionAttributes = { value: currentBranch, selected: 'selected' };
    if (!currentBranch || !isGitInstall) {
        currentOptionAttributes.disabled = 'disabled';
    }
    const currentOption = createElement('option', { attrs: currentOptionAttributes });
    currentOption.textContent = currentBranch || 'Unknown';
    branchSelect.appendChild(currentOption);
    branchValue.appendChild(branchSelect);
    branchContainer.append(branchLabel, branchValue);
    statusGrid.appendChild(branchContainer);

    // Load available branches
    if (isGitInstall) {
        loadServerAdminBranches(branchSelect, currentBranch);
    }

    appendServerAdminStat(statusGrid, 'Commit', repository?.currentCommit || version?.gitRevision || 'Unknown');
    appendServerAdminStat(statusGrid, 'Tracking', repository?.trackingBranch || 'Not set');
    appendServerAdminStat(statusGrid, 'Ahead', String(repository?.ahead ?? 0));
    appendServerAdminStat(statusGrid, 'Behind', String(repository?.behind ?? 0));
    if (release) {
        appendServerAdminStat(statusGrid, 'Latest ZIP', release?.latestVersion ? `v${release.latestVersion}` : 'Unknown');
    }
    appendServerAdminStat(statusGrid, 'Config', data?.configPath || 'Unknown');

    state.lastStatusData = {
        runtime: data?.runtime || '',
        configPath: data?.configPath || '',
        version,
        repository,
        release,
    };

    let pillLabel = 'Unavailable';
    let pillTone = 'neutral';

    if (isGitInstall) {
        if (repository?.hasLocalChanges && !repository?.autoStash) {
            pillLabel = 'Update Blocked';
            pillTone = 'danger';
        } else if (repository?.hasLocalChanges && repository?.autoStash) {
            pillLabel = (repository?.behind ?? 0) > 0 ? 'Update Ready (Auto-stash)' : 'Auto-stash Enabled';
            pillTone = 'warn';
        } else if ((repository?.behind ?? 0) > 0) {
            pillLabel = 'Update Ready';
            pillTone = 'warn';
        } else if ((repository?.ahead ?? 0) > 0) {
            pillLabel = 'Patched Local';
            pillTone = 'neutral';
        } else {
            pillLabel = 'Up To Date';
            pillTone = 'good';
        }
    } else if (release?.canUpdate) {
        pillLabel = release?.latestVersion ? `Update Available (v${release.latestVersion})` : 'Update Available';
        pillTone = 'warn';
    } else if (release?.checked && release?.assetAvailable && release?.latestVersion === release?.currentVersion) {
        pillLabel = 'Up To Date';
        pillTone = 'good';
    } else if (release?.checked && release?.assetAvailable) {
        pillLabel = 'ZIP Install';
        pillTone = 'neutral';
    } else if (release?.checked && !release?.assetAvailable) {
        pillLabel = 'ZIP Unavailable';
        pillTone = 'warn';
    } else if (release?.supported && !release?.checked) {
        pillLabel = 'Check Failed';
        pillTone = 'warn';
    }

    setServerAdminPill(refs.statusPill, pillLabel, pillTone);
    const updateMode = repository?.canUpdate ? 'git' : release?.canUpdate ? 'zip' : '';
    refs.updateButton.dataset.sbCanUpdate = String(Boolean(updateMode));
    refs.updateButton.dataset.sbUpdateMode = updateMode;

    const noteParts = [String((isGitInstall ? repository?.message : release?.message || repository?.message) ?? '').trim()].filter(Boolean);

    if ((repository?.changedFilesCount ?? 0) > 0) {
        const changedPreview = Array.isArray(repository?.changedFiles)
            ? repository.changedFiles.map(file => file?.path).filter(Boolean).join(', ')
            : '';
        noteParts.push(`Changed files: ${repository.changedFilesCount}${changedPreview ? ` (${changedPreview})` : ''}`);
    }

    setServerAdminMessage(refs.statusNote, noteParts.join('\n'), pillTone);

    if (refs.autoStashCheckbox) {
        refs.autoStashCheckbox.checked = Boolean(repository?.autoStash);
        refs.autoStashCheckbox.disabled = !isGitInstall;
    }
    updateServerAdminInteractivity();
}

function renderServerAdminConfig(data, { overwrite = true } = {}) {
    const state = getServerAdminState();
    const refs = getServerAdminRefs();

    if (!refs) {
        return;
    }

    refs.configPath.textContent = data?.path || 'config.yaml';
    state.configLoaded = true;

    if (overwrite && refs.configEditor instanceof HTMLTextAreaElement) {
        refs.configEditor.value = String(data?.content ?? '');
        state.originalConfig = refs.configEditor.value;
        state.lastModifiedMs = Number(data?.lastModifiedMs ?? 0) || 0;
        updateServerConfigDirtyState();
    }
}

function renderServerThumbnailSettings(data) {
    const state = getServerAdminState();
    const refs = getServerAdminRefs();

    if (!refs) {
        return;
    }

    setThumbnailInputValues(data?.settings ?? {});
    state.thumbnailLastModifiedMs = Number(data?.lastModifiedMs ?? 0) || state.thumbnailLastModifiedMs;
    state.thumbnailRecommended = data?.recommended ?? state.thumbnailRecommended;
    state.thumbnailSettingsLoaded = true;
    setServerAdminMessage(refs.thumbnailNote, 'Thumbnail settings loaded. Saving applies to new thumbnails immediately.', 'neutral');
}

async function waitForServerReturn(expectedRevision = '', { clearCacheBeforeReload = false, expectedVersion = '', previousServerBootId = '' } = {}) {
    let sawOffline = false;

    async function reloadAfterOptionalCacheClear() {
        if (clearCacheBeforeReload && typeof window.SillyBunnyClearFrontendCache === 'function') {
            await window.SillyBunnyClearFrontendCache({ skipConfirmation: true, saveBeforeClear: false });
        }
        location.reload();
    }
    const timeoutAt = Date.now() + 180000;

    while (Date.now() < timeoutAt) {
        try {
            const response = await fetch('/version', { cache: 'no-store' });

            if (!response.ok) {
                throw new Error('Server is not ready yet.');
            }

            const version = await response.json().catch(() => ({}));
            if (hasServerReturnedAfterRestart(version, { expectedRevision, expectedVersion, previousServerBootId, sawOffline })) {
                await reloadAfterOptionalCacheClear();
                return true;
            }
        } catch {
            sawOffline = true;
        }

        await wait(1500);
    }

    return false;
}

async function refreshServerAdminPanel({ includeConfig = false, forceConfig = false } = {}) {
    const state = getServerAdminState();
    const refs = getServerAdminRefs();
    const shouldLoadConfig = includeConfig || forceConfig || !state.configLoaded;
    const shouldLoadThumbnails = forceConfig || !state.thumbnailSettingsLoaded;

    if (!refs || state.busy || state.restarting) {
        return;
    }

    state.busy = true;
    updateServerAdminInteractivity();
    setServerAdminMessage(refs.statusNote, 'Loading server status…');
    if (shouldLoadConfig) {
        refs.configState.textContent = state.configLoaded ? 'Refreshing…' : 'Loading…';
        refs.configState.dataset.state = 'loading';
    }

    const statusPromise = requestServerAdmin('/api/server-admin/status');
    const configPromise = shouldLoadConfig ? requestServerAdmin('/api/server-admin/config/get') : null;
    const thumbnailPromise = shouldLoadThumbnails
        ? requestServerAdmin('/api/server-admin/config/thumbnail-settings/get')
        : null;

    if (configPromise) {
        try {
            const configData = await configPromise;
            const configIsDirty = refs.configEditor.value !== state.originalConfig;

            if (forceConfig || !configIsDirty) {
                renderServerAdminConfig(configData, { overwrite: true });
            } else {
                renderServerAdminConfig(configData, { overwrite: false });
                state.lastModifiedMs = Number(configData?.lastModifiedMs ?? 0) || state.lastModifiedMs;
                refs.configPath.textContent = configData?.path || refs.configPath.textContent;
                setServerAdminMessage(refs.configNote, 'The file was refreshed on disk, but your unsaved draft was kept locally.', 'warn');
            }
        } catch (error) {
            state.configLoaded = false;
            const tone = error?.status === 403 ? 'warn' : 'danger';
            refs.configState.textContent = error?.status === 403 ? 'Admin Only' : 'Unavailable';
            refs.configState.dataset.state = tone;
            setServerAdminMessage(refs.configNote, error.message || 'Failed to load config.yaml.', tone);
            if (error?.status !== 403) {
                console.error('Failed to load config.yaml.', error);
            }
        }
    }

    if (thumbnailPromise) {
        try {
            renderServerThumbnailSettings(await thumbnailPromise);
        } catch (error) {
            state.thumbnailSettingsLoaded = false;
            const tone = error?.status === 403 ? 'warn' : 'danger';
            setServerAdminMessage(refs.thumbnailNote, error.message || 'Failed to load thumbnail settings.', tone);
            if (error?.status !== 403) {
                console.error('Failed to load thumbnail settings.', error);
            }
        }
    }

    try {
        const statusData = await statusPromise;
        renderServerAdminStatus(statusData);
    } catch (error) {
        const tone = error?.status === 403 ? 'warn' : 'danger';
        if (error?.status !== 403) {
            console.error('Failed to refresh server admin panel.', error);
        }
        getServerAdminRefs()?.statusGrid.replaceChildren();
        setServerAdminPill(getServerAdminRefs()?.statusPill, error?.status === 403 ? 'Admin Only' : 'Unavailable', tone);
        setServerAdminMessage(getServerAdminRefs()?.statusNote, error.message || 'Failed to load server tools.', tone);
    } finally {
        state.busy = false;
        updateServerAdminInteractivity();
    }
}

async function handleServerAdminReloadConfig() {
    const refs = getServerAdminRefs();

    if (!refs) {
        return;
    }

    if (updateServerConfigDirtyState() && !window.confirm('Discard your unsaved config edits and reload config.yaml from disk?')) {
        return;
    }

    await refreshServerAdminPanel({ includeConfig: true, forceConfig: true });
}

async function handleServerAdminSaveConfig({ restart = false } = {}) {
    const state = getServerAdminState();
    const refs = getServerAdminRefs();

    if (!refs || state.busy || state.restarting) {
        return;
    }

    state.busy = true;
    updateServerAdminInteractivity();
    setServerAdminMessage(refs.configNote, restart ? 'Saving config and preparing restart…' : 'Saving config…');

    try {
        const normalizedContent = refs.configEditor.value.endsWith('\n')
            ? refs.configEditor.value
            : `${refs.configEditor.value}\n`;
        const result = await requestServerAdmin('/api/server-admin/config/save', {
            content: normalizedContent,
            expectedLastModifiedMs: state.lastModifiedMs,
            restart,
        });

        refs.configEditor.value = normalizedContent;
        state.originalConfig = normalizedContent;
        state.lastModifiedMs = Number(result?.lastModifiedMs ?? 0) || state.lastModifiedMs;
        updateServerConfigDirtyState();
        setServerAdminMessage(refs.configNote, result?.message || 'Config saved.', restart ? 'warn' : 'good');
        toastr.success(result?.message || 'Config saved.', 'Server config');

        if (restart) {
            state.busy = false;
            state.restarting = true;
            updateServerAdminInteractivity();
            const restarted = await waitForServerReturn();

            if (!restarted) {
                state.restarting = false;
                setServerAdminMessage(refs.configNote, 'Restart is taking longer than expected. Refresh the page once the server is back.', 'warn');
                toastr.warning('Restart is taking longer than expected. Refresh manually once the server is back.', 'Restart pending');
            }
        }
    } catch (error) {
        console.error('Failed to save config.yaml.', error);
        setServerAdminMessage(refs.configNote, error.message || 'Failed to save config.yaml.', 'danger');
        toastr.error(error.message || 'Failed to save config.yaml.', 'Server config');
    } finally {
        if (!state.restarting) {
            state.busy = false;
            updateServerAdminInteractivity();
        }
    }
}

async function handleServerThumbnailSave({ clearCache = false } = {}) {
    const state = getServerAdminState();
    const refs = getServerAdminRefs();

    if (!refs || state.busy || state.restarting) {
        return;
    }

    if (updateServerConfigDirtyState()) {
        setServerAdminMessage(refs.thumbnailNote, 'Save or reload the config.yaml editor before changing thumbnail settings.', 'warn');
        toastr.warning('Save or reload the config.yaml editor before changing thumbnail settings.', 'Thumbnails');
        return;
    }

    state.busy = true;
    updateServerAdminInteractivity();
    setServerAdminMessage(refs.thumbnailNote, clearCache ? 'Saving settings and clearing thumbnail cache…' : 'Saving thumbnail settings…');

    try {
        const result = await requestServerAdmin('/api/server-admin/config/thumbnail-settings/save', {
            settings: getThumbnailSettingsFromRefs(refs),
            expectedLastModifiedMs: state.thumbnailLastModifiedMs || state.lastModifiedMs,
            clearCache,
        });

        renderServerThumbnailSettings(result);
        state.lastModifiedMs = Number(result?.lastModifiedMs ?? 0) || state.lastModifiedMs;
        setServerAdminMessage(refs.thumbnailNote, result?.message || 'Thumbnail settings saved.', 'good');
        toastr.success(result?.message || 'Thumbnail settings saved.', 'Thumbnails');
        renderServerAdminConfig(await requestServerAdmin('/api/server-admin/config/get'), { overwrite: true });
    } catch (error) {
        console.error('Failed to save thumbnail settings.', error);
        setServerAdminMessage(refs.thumbnailNote, error.message || 'Failed to save thumbnail settings.', 'danger');
        toastr.error(error.message || 'Failed to save thumbnail settings.', 'Thumbnails');
    } finally {
        state.busy = false;
        updateServerAdminInteractivity();
    }
}

async function handleServerThumbnailClearCache() {
    const state = getServerAdminState();
    const refs = getServerAdminRefs();

    if (!refs || state.busy || state.restarting) {
        return;
    }

    if (!window.confirm('Clear cached thumbnails for this user? They will be rebuilt as images are loaded.')) {
        return;
    }

    state.busy = true;
    updateServerAdminInteractivity();
    setServerAdminMessage(refs.thumbnailNote, 'Clearing thumbnail cache…');

    try {
        const result = await requestServerAdmin('/api/server-admin/thumbnails/clear-cache');
        setServerAdminMessage(refs.thumbnailNote, result?.message || 'Thumbnail cache cleared.', 'good');
        toastr.success(result?.message || 'Thumbnail cache cleared.', 'Thumbnails');
    } catch (error) {
        console.error('Failed to clear thumbnail cache.', error);
        setServerAdminMessage(refs.thumbnailNote, error.message || 'Failed to clear thumbnail cache.', 'danger');
        toastr.error(error.message || 'Failed to clear thumbnail cache.', 'Thumbnails');
    } finally {
        state.busy = false;
        updateServerAdminInteractivity();
    }
}

function handleUseRecommendedThumbnailSettings() {
    const state = getServerAdminState();
    const refs = getServerAdminRefs();
    const recommended = state.thumbnailRecommended ?? {
        enabled: true,
        format: 'png',
        quality: 100,
        dimensions: {
            bg: [240, 135],
            avatar: [864, 1280],
            persona: [864, 1280],
        },
    };

    setThumbnailInputValues(recommended, refs);
    setServerAdminMessage(refs.thumbnailNote, 'Recommended high-quality thumbnail settings are staged. Save them when ready.', 'warn');
}

function createThumbnailSizeRow(label, key) {
    const row = createElement('div', { className: 'sb-thumbnail-size-row' });
    const rowLabel = createElement('span', { className: 'sb-thumbnail-size-label', text: label });
    const widthInput = createElement('input', {
        className: 'text_pole sb-thumbnail-number',
        attrs: {
            type: 'number',
            inputmode: 'numeric',
            min: '1',
            max: '4096',
            step: '1',
            'aria-label': `${label} thumbnail width`,
        },
    });
    const separator = createElement('span', { className: 'sb-thumbnail-size-separator', text: 'x' });
    const heightInput = createElement('input', {
        className: 'text_pole sb-thumbnail-number',
        attrs: {
            type: 'number',
            inputmode: 'numeric',
            min: '1',
            max: '4096',
            step: '1',
            'aria-label': `${label} thumbnail height`,
        },
    });

    row.dataset.thumbnailSize = key;
    row.append(rowLabel, widthInput, separator, heightInput);
    return { row, widthInput, heightInput };
}

async function handleServerAdminRestart() {
    const state = getServerAdminState();
    const refs = getServerAdminRefs();

    if (!refs || state.busy || state.restarting) {
        return;
    }

    state.busy = true;
    updateServerAdminInteractivity();
    setServerAdminMessage(refs.updateNote, 'Restarting SillyBunny…');

    try {
        const result = await requestServerAdmin('/api/server-admin/restart');
        state.busy = false;
        state.restarting = true;
        updateServerAdminInteractivity();
        setServerAdminMessage(refs.updateNote, result?.message || 'Restarting SillyBunny…', 'warn');
        toastr.info(result?.message || 'Restarting SillyBunny…', 'Server');

        const restarted = await waitForServerReturn('', { previousServerBootId: result?.serverBootId });
        if (!restarted) {
            state.restarting = false;
            setServerAdminMessage(refs.updateNote, 'Restart is taking longer than expected. Refresh the page once the server is back.', 'warn');
            toastr.warning('Restart is taking longer than expected. Refresh manually once the server is back.', 'Restart pending');
        }
    } catch (error) {
        console.error('Failed to restart SillyBunny.', error);
        state.busy = false;
        updateServerAdminInteractivity();
        setServerAdminMessage(refs.updateNote, error.message || 'Failed to restart SillyBunny.', 'danger');
        toastr.error(error.message || 'Failed to restart SillyBunny.', 'Server');
    }
}

async function handleServerAdminUpdate() {
    const state = getServerAdminState();
    const refs = getServerAdminRefs();

    if (!refs || state.busy || state.restarting) {
        return;
    }

    if (refs.updateButton?.dataset.sbUpdateMode === 'zip') {
        await handleServerAdminZipUpdate();
        return;
    }

    state.busy = true;
    updateServerAdminInteractivity();
    setServerAdminButtonLabel(refs.updateButton, true, 'Updating…');
    setServerAdminMessage(refs.updateNote, 'Checking Git status and applying the latest update…');
    refs.updateOutput.hidden = true;
    refs.updateOutput.textContent = '';

    try {
        const result = await requestServerAdmin('/api/server-admin/update');
        const nextStatus = {
            ...(state.lastStatusData ?? {}),
            configPath: refs.configPath?.textContent || state.lastStatusData?.configPath || '',
            version: result?.version ?? state.lastStatusData?.version ?? {},
            repository: result?.repository ?? state.lastStatusData?.repository ?? {},
        };

        if (!result?.updated) {
            renderServerAdminStatus(nextStatus);
            const stashMessage = describeAutoStashState(result);
            setServerAdminMessage(refs.updateNote, [result?.message || 'Already up to date.', stashMessage].filter(Boolean).join('\n'), stashMessage ? 'warn' : 'good');
            if (stashMessage) {
                toastr.info(stashMessage, 'Auto-stash');
            }
            toastr.success(result?.message || 'Already up to date.', 'Server update');
            return;
        }

        renderServerAdminStatus(nextStatus);

        const stashMessage = describeAutoStashState(result);
        if (result?.stashPopWarning) {
            toastr.warning(stashMessage, 'Auto-stash warning', { timeOut: 10000 });
        } else if (stashMessage) {
            toastr.info(stashMessage, 'Auto-stash');
        }

        if (result?.install?.stdout || result?.install?.stderr) {
            refs.updateOutput.hidden = false;
            refs.updateOutput.textContent = [result.install.command, result.install.stdout, result.install.stderr]
                .filter(Boolean)
                .join('\n\n');
        }

        state.busy = false;
        state.restarting = true;
        updateServerAdminInteractivity();
        setServerAdminMessage(refs.updateNote, result?.message || 'Update applied. Restarting SillyBunny…', 'warn');
        toastr.info(result?.message || 'Update applied. Restarting SillyBunny…', 'Server update');

        const expectedRevision = String(result?.version?.gitRevision ?? result?.repository?.currentCommit ?? '').trim();
        const autoClearCacheEnabled = Boolean(document.getElementById('auto_clear_cache_on_update')?.checked);
        const restarted = await waitForServerReturn(expectedRevision, { clearCacheBeforeReload: autoClearCacheEnabled });

        if (!restarted) {
            state.restarting = false;
            setServerAdminMessage(refs.updateNote, 'Update completed, but restart is taking longer than expected. Refresh manually once the server is back.', 'warn');
            toastr.warning('Update finished, but restart is taking longer than expected. Refresh manually once the server is back.', 'Restart pending');
        }
    } catch (error) {
        console.error('Failed to update SillyBunny.', error);
        state.busy = false;
        const stashMessage = describeAutoStashState(error?.data);
        if (stashMessage) {
            toastr.warning(stashMessage, 'Auto-stash warning', { timeOut: 10000 });
        }
        setServerAdminMessage(refs.updateNote, [error.message || 'Failed to update SillyBunny.', stashMessage].filter(Boolean).join('\n'), 'danger');
        toastr.error(error.message || 'Failed to update SillyBunny.', 'Server update');
    } finally {
        setServerAdminButtonLabel(refs.updateButton, false, 'Updating…');

        if (!state.restarting) {
            state.busy = false;
            updateServerAdminInteractivity();
        }
    }
}

async function handleServerAdminZipUpdate() {
    const state = getServerAdminState();
    const refs = getServerAdminRefs();

    if (!refs || state.busy || state.restarting) {
        return;
    }

    state.busy = true;
    updateServerAdminInteractivity();
    setServerAdminButtonLabel(refs.updateButton, true, 'Updating…');
    setServerAdminMessage(refs.updateNote, 'Downloading the latest GitHub release ZIP and preparing a safe restart…');
    refs.updateOutput.hidden = true;
    refs.updateOutput.textContent = '';

    try {
        const result = await requestServerAdmin('/api/server-admin/zip-update');
        const nextStatus = {
            ...(state.lastStatusData ?? {}),
            configPath: refs.configPath?.textContent || state.lastStatusData?.configPath || '',
            version: result?.version ?? state.lastStatusData?.version ?? {},
            repository: result?.repository ?? state.lastStatusData?.repository ?? {},
            release: result?.release ?? state.lastStatusData?.release ?? null,
        };

        if (!result?.updated) {
            renderServerAdminStatus(nextStatus);
            setServerAdminMessage(refs.updateNote, result?.message || 'Already up to date.', 'good');
            toastr.success(result?.message || 'Already up to date.', 'Server update');
            return;
        }

        renderServerAdminStatus(nextStatus);
        state.busy = false;
        state.restarting = true;
        updateServerAdminInteractivity();
        setServerAdminMessage(refs.updateNote, result?.message || 'ZIP update downloaded. Restarting SillyBunny…', 'warn');
        toastr.info(result?.message || 'ZIP update downloaded. Restarting SillyBunny…', 'Server update');

        const expectedVersion = String(result?.release?.latestVersion ?? '').trim();
        const autoClearCacheEnabled = Boolean(document.getElementById('auto_clear_cache_on_update')?.checked);
        const restarted = await waitForServerReturn('', { clearCacheBeforeReload: autoClearCacheEnabled, expectedVersion });

        if (!restarted) {
            state.restarting = false;
            setServerAdminMessage(refs.updateNote, 'ZIP update started, but restart is taking longer than expected. Refresh manually once the server is back.', 'warn');
            toastr.warning('ZIP update started, but restart is taking longer than expected. Refresh manually once the server is back.', 'Restart pending');
        }
    } catch (error) {
        console.error('Failed to update SillyBunny from release ZIP.', error);
        state.busy = false;
        setServerAdminMessage(refs.updateNote, error.message || 'Failed to update SillyBunny from release ZIP.', 'danger');
        toastr.error(error.message || 'Failed to update SillyBunny from release ZIP.', 'Server update');
    } finally {
        setServerAdminButtonLabel(refs.updateButton, false, 'Updating…');

        if (!state.restarting) {
            state.busy = false;
            updateServerAdminInteractivity();
        }
    }
}

async function loadServerAdminBranches(selectElement, currentBranch) {
    try {
        const result = await requestServerAdmin('/api/server-admin/branches');
        const branches = result?.branches || [];

        selectElement.replaceChildren();

        for (const branch of branches) {
            const option = createElement('option', { attrs: { value: branch } });
            option.textContent = branch;
            if (branch === currentBranch) {
                option.selected = true;
            }
            selectElement.appendChild(option);
        }

        // Add change handler
        selectElement.addEventListener('change', () => handleServerAdminBranchSwitch(selectElement));
    } catch (error) {
        console.error('Failed to load branches.', error);
        // Keep the current branch option if loading fails
    }
}

async function handleServerAdminBranchSwitch(selectElement) {
    const state = getServerAdminState();
    const refs = getServerAdminRefs();

    if (!refs || state.busy || state.restarting) {
        return;
    }

    const targetBranch = selectElement.value;
    const currentBranch = state.lastStatusData?.repository?.displayBranch || state.lastStatusData?.repository?.branch || '';

    if (targetBranch === currentBranch) {
        return;
    }

    // Show confirmation dialog
    const hasLocalChanges = state.lastStatusData?.repository?.hasLocalChanges || false;
    const changedFiles = state.lastStatusData?.repository?.changedFiles || [];
    const changedFilesText = changedFiles.length > 0
        ? `\n\nChanged files: ${changedFiles.map(f => f.path).join(', ')}`
        : '';

    const confirmMessage = hasLocalChanges
        ? `You have local changes.${changedFilesText}\n\nDo you want to auto-stash your changes and switch to "${targetBranch}"?\n\nThe server will restart after switching.`
        : `Switch to branch "${targetBranch}"?\n\nThe server will restart after switching.`;

    const confirmed = confirm(confirmMessage);

    if (!confirmed) {
        // Reset select to current branch
        selectElement.value = currentBranch;
        return;
    }

    state.busy = true;
    updateServerAdminInteractivity();
    setServerAdminMessage(refs.updateNote, `Switching to branch "${targetBranch}"…`);

    try {
        const result = await requestServerAdmin('/api/server-admin/switch-branch', {
            branch: targetBranch,
            autoStash: hasLocalChanges,
        });

        state.busy = false;
        state.restarting = true;
        updateServerAdminInteractivity();

        const message = result?.message || `Switched to branch "${targetBranch}". Restarting…`;
        setServerAdminMessage(refs.updateNote, message, 'warn');
        toastr.info(message, 'Branch Switch');

        if (result?.stashed && !result?.stashRestored) {
            toastr.warning('Your changes were stashed but could not be automatically restored. Use "git stash pop" after restart.', 'Stash Warning', { timeOut: 10000 });
        }

        const restarted = await waitForServerReturn();
        if (!restarted) {
            state.restarting = false;
            setServerAdminMessage(refs.updateNote, 'Branch switched, but restart is taking longer than expected. Refresh manually once the server is back.', 'warn');
            toastr.warning('Branch switched, but restart is taking longer than expected. Refresh manually once the server is back.', 'Restart pending');
        }
    } catch (error) {
        console.error('Failed to switch branch.', error);
        state.busy = false;
        updateServerAdminInteractivity();

        // Reset select to current branch
        selectElement.value = currentBranch;

        const errorMessage = error.message || 'Failed to switch branch.';
        setServerAdminMessage(refs.updateNote, errorMessage, 'danger');
        toastr.error(errorMessage, 'Branch Switch');
    }
}

function buildServerAdminPanel() {
    const { panel, scroller } = createShellPanel({
        id: 'server',
    });

    const column = createElement('div', { className: 'sb-shell-column sb-server-column' });
    const callout = createElement('div', { className: 'sb-shell-callout' });
    callout.innerHTML = `
        <strong>Server Tools</strong>
        <p>Edit <code>config.yaml</code>, check for Git or release ZIP updates, and restart the app from inside Customize. Git auto-update only runs when the repository can fast-forward cleanly.</p>
    `;

    const statusCard = createElement('section', { className: 'sb-admin-card sb-server-card' });
    const statusHeader = createElement('div', { className: 'sb-admin-card-header' });
    const statusCopy = createElement('div', { className: 'sb-admin-card-copy' });
    const statusTitle = createElement('strong', { text: 'App Status' });
    const statusDescription = createElement('p', { text: 'Review the current runtime, branch, commit, and whether this workspace can update safely.' });
    const statusPill = createElement('span', { className: 'sb-server-pill', text: 'Checking…' });
    const statusGrid = createElement('div', { className: 'sb-server-grid' });
    const statusNote = createElement('div', { className: 'sb-server-note' });
    statusCopy.append(statusTitle, statusDescription);
    statusHeader.append(statusCopy, statusPill);
    statusCard.append(statusHeader, statusGrid, statusNote);

    const updateCard = createElement('section', { className: 'sb-admin-card sb-server-card' });
    const updateHeader = createElement('div', { className: 'sb-admin-card-header' });
    const updateCopy = createElement('div', { className: 'sb-admin-card-copy' });
    const updateTitle = createElement('strong', { text: 'Updates & Restart' });
    const updateDescription = createElement('p', { text: 'Check upstream status, update the app, and relaunch automatically when it is safe to do so.' });
    const updateActions = createElement('div', { className: 'sb-server-actions' });
    const refreshButton = createElement('button', { className: 'menu_button menu_button_icon sb-server-action', text: 'Check for updates', attrs: { type: 'button' } });
    const updateButton = createElement('button', { className: 'menu_button menu_button_icon sb-server-action menu_button_primary', text: 'Update & Restart', attrs: { type: 'button' } });
    const restartButton = createElement('button', { className: 'menu_button menu_button_icon sb-server-action', text: 'Restart server', attrs: { type: 'button' } });
    const updateNote = createElement('div', { className: 'sb-server-note', text: 'Git fast-forward updates and release ZIP updates restart automatically after preparation finishes.' });
    const autoStashLabel = createElement('label', { className: 'checkbox_label' });
    const autoStashCheckbox = createElement('input', { attrs: { type: 'checkbox', id: 'auto_stash_before_pull' } });
    const autoStashText = createElement('small', { text: 'Auto-stash local changes before pulling' });
    autoStashLabel.append(autoStashCheckbox, autoStashText);
    const updateOutput = createElement('pre', { className: 'sb-server-output' });
    updateOutput.hidden = true;
    updateCopy.append(updateTitle, updateDescription);
    updateActions.append(refreshButton, updateButton, restartButton);
    updateHeader.append(updateCopy);
    updateCard.append(updateHeader, updateActions, autoStashLabel, updateNote, updateOutput);

    const thumbnailCard = createElement('section', { className: 'sb-admin-card sb-server-card sb-thumbnail-card' });
    const thumbnailHeader = createElement('div', { className: 'sb-admin-card-header' });
    const thumbnailCopy = createElement('div', { className: 'sb-admin-card-copy' });
    const thumbnailTitle = createElement('strong', { text: 'Thumbnail Quality' });
    const thumbnailDescription = createElement('p', { text: 'Set thumbnail format, quality, and generated sizes without hand-editing config.yaml.' });
    thumbnailCopy.append(thumbnailTitle, thumbnailDescription);
    thumbnailHeader.append(thumbnailCopy);

    const thumbnailControls = createElement('div', { className: 'sb-thumbnail-controls' });
    const thumbnailEnabledLabel = createElement('label', { className: 'checkbox_label sb-thumbnail-enabled' });
    const thumbnailEnabled = createElement('input', { attrs: { type: 'checkbox' } });
    const thumbnailEnabledText = createElement('small', { text: 'Generate thumbnails' });
    thumbnailEnabledLabel.append(thumbnailEnabled, thumbnailEnabledText);

    const thumbnailFormatGroup = createElement('label', { className: 'sb-thumbnail-field' });
    const thumbnailFormatText = createElement('span', { text: 'Format' });
    const thumbnailFormat = createElement('select', { className: 'text_pole' });
    thumbnailFormat.append(
        createElement('option', { text: 'JPG', attrs: { value: 'jpg' } }),
        createElement('option', { text: 'PNG', attrs: { value: 'png' } }),
    );
    thumbnailFormatGroup.append(thumbnailFormatText, thumbnailFormat);

    const thumbnailQualityGroup = createElement('label', { className: 'sb-thumbnail-field' });
    const thumbnailQualityText = createElement('span', { text: 'Quality' });
    const thumbnailQuality = createElement('input', {
        className: 'text_pole sb-thumbnail-number',
        attrs: {
            type: 'number',
            inputmode: 'numeric',
            min: '1',
            max: '100',
            step: '1',
        },
    });
    thumbnailQualityGroup.append(thumbnailQualityText, thumbnailQuality);
    thumbnailControls.append(thumbnailEnabledLabel, thumbnailFormatGroup, thumbnailQualityGroup);

    const thumbnailSizes = createElement('div', { className: 'sb-thumbnail-sizes' });
    const bgSize = createThumbnailSizeRow('Background', 'bg');
    const avatarSize = createThumbnailSizeRow('Character', 'avatar');
    const personaSize = createThumbnailSizeRow('Persona', 'persona');
    thumbnailSizes.append(bgSize.row, avatarSize.row, personaSize.row);

    const thumbnailActions = createElement('div', { className: 'sb-server-actions' });
    const thumbnailUseRecommendedButton = createElement('button', { className: 'menu_button menu_button_icon sb-server-action', text: 'Use recommended', attrs: { type: 'button' } });
    const thumbnailSaveButton = createElement('button', { className: 'menu_button menu_button_icon sb-server-action', text: 'Save thumbnails', attrs: { type: 'button' } });
    const thumbnailSaveClearButton = createElement('button', { className: 'menu_button menu_button_icon sb-server-action menu_button_primary', text: 'Save & Clear Cache', attrs: { type: 'button' } });
    const thumbnailClearButton = createElement('button', { className: 'menu_button menu_button_icon sb-server-action', text: 'Clear cache only', attrs: { type: 'button' } });
    const thumbnailNote = createElement('div', { className: 'sb-server-note', text: 'Use PNG at 100 quality with larger avatar/persona dimensions for sharper character thumbnails, then clear the cache to rebuild them.' });
    thumbnailActions.append(thumbnailUseRecommendedButton, thumbnailSaveButton, thumbnailSaveClearButton, thumbnailClearButton);
    thumbnailCard.append(thumbnailHeader, thumbnailControls, thumbnailSizes, thumbnailActions, thumbnailNote);

    const configCard = createElement('section', { className: 'sb-admin-card sb-server-card' });
    const configHeader = createElement('div', { className: 'sb-admin-card-header' });
    const configCopy = createElement('div', { className: 'sb-admin-card-copy' });
    const configTitle = createElement('strong', { text: 'config.yaml Editor' });
    const configDescription = createElement('p', { text: 'Edit the live config file directly here. Saves validate YAML before writing anything to disk.' });
    const configState = createElement('span', { className: 'sb-server-inline-state', text: 'Loading…' });
    const configPath = createElement('code', { className: 'sb-server-config-path', text: 'config.yaml' });
    const configMeta = createElement('div', { className: 'sb-server-config-meta' });
    const configEditor = createElement('textarea', {
        className: 'text_pole sb-server-config-editor',
        attrs: {
            spellcheck: 'false',
            rows: '22',
            'aria-label': 'config.yaml editor',
        },
    });
    const configActions = createElement('div', { className: 'sb-server-actions' });
    const reloadConfigButton = createElement('button', { className: 'menu_button menu_button_icon sb-server-action', text: 'Reload file', attrs: { type: 'button' } });
    const saveConfigButton = createElement('button', { className: 'menu_button menu_button_icon sb-server-action', text: 'Save config', attrs: { type: 'button' } });
    const saveConfigRestartButton = createElement('button', { className: 'menu_button menu_button_icon sb-server-action menu_button_primary', text: 'Save & Restart', attrs: { type: 'button' } });
    const configNote = createElement('div', { className: 'sb-server-note', text: 'Most config changes only take effect after a restart.' });
    configCopy.append(configTitle, configDescription);
    configHeader.append(configCopy, configState);
    configMeta.append(configPath);
    configActions.append(reloadConfigButton, saveConfigButton, saveConfigRestartButton);
    configCard.append(configHeader, configMeta, configEditor, configActions, configNote);

    column.append(callout, statusCard, updateCard, thumbnailCard, configCard);
    scroller.appendChild(column);

    const state = getServerAdminState();
    state.refs = {
        statusPill,
        statusGrid,
        statusNote,
        refreshButton,
        updateButton,
        restartButton,
        updateNote,
        updateOutput,
        autoStashCheckbox,
        thumbnailEnabled,
        thumbnailFormat,
        thumbnailQuality,
        thumbnailBgWidth: bgSize.widthInput,
        thumbnailBgHeight: bgSize.heightInput,
        thumbnailAvatarWidth: avatarSize.widthInput,
        thumbnailAvatarHeight: avatarSize.heightInput,
        thumbnailPersonaWidth: personaSize.widthInput,
        thumbnailPersonaHeight: personaSize.heightInput,
        thumbnailUseRecommendedButton,
        thumbnailSaveButton,
        thumbnailSaveClearButton,
        thumbnailClearButton,
        thumbnailNote,
        configPath,
        configState,
        configEditor,
        reloadConfigButton,
        saveConfigButton,
        saveConfigRestartButton,
        configNote,
    };
    setServerAdminPill(statusPill, 'Idle', 'neutral');
    setServerAdminMessage(statusNote, 'Open this tab to load server status and update controls.', 'neutral');
    configState.textContent = 'Not loaded';
    configState.dataset.state = 'neutral';

    refreshButton.addEventListener('click', () => refreshServerAdminPanel({ includeConfig: false }));
    updateButton.addEventListener('click', handleServerAdminUpdate);
    restartButton.addEventListener('click', handleServerAdminRestart);
    thumbnailUseRecommendedButton.addEventListener('click', handleUseRecommendedThumbnailSettings);
    thumbnailSaveButton.addEventListener('click', () => handleServerThumbnailSave({ clearCache: false }));
    thumbnailSaveClearButton.addEventListener('click', () => handleServerThumbnailSave({ clearCache: true }));
    thumbnailClearButton.addEventListener('click', handleServerThumbnailClearCache);
    reloadConfigButton.addEventListener('click', handleServerAdminReloadConfig);
    saveConfigButton.addEventListener('click', () => handleServerAdminSaveConfig({ restart: false }));
    saveConfigRestartButton.addEventListener('click', () => handleServerAdminSaveConfig({ restart: true }));
    configEditor.addEventListener('input', () => {
        updateServerConfigDirtyState();
        updateServerAdminInteractivity();
    });
    autoStashCheckbox.addEventListener('change', function () {
        const refs = getServerAdminRefs();
        if (!refs?.configEditor) return;
        const yaml = refs.configEditor.value;
        const newValue = this.checked ? 'true' : 'false';
        if (/^autoStashBeforePull:\s*(true|false)/m.test(yaml)) {
            refs.configEditor.value = yaml.replace(/^(autoStashBeforePull:\s*)(true|false)/m, `$1${newValue}`);
        } else {
            refs.configEditor.value = yaml + `\nautoStashBeforePull: ${newValue}\n`;
        }
        refs.configEditor.dispatchEvent(new Event('input'));
    });
    updateServerAdminInteractivity();

    return {
        id: 'server',
        panel,
        button: null,
        searchRoot: column,
        onActivate: () => {
            if (!isShellOpen('right')) {
                return;
            }

            void refreshServerAdminPanel({ includeConfig: !getServerAdminState().configLoaded });
        },
    };
}

/**
 * Creates a collapsible inline-drawer for Advanced Formatting sections.
 * @param {string} id Drawer element ID
 * @param {string} title Drawer title
 * @param {string} description Short description
 * @returns {HTMLElement} The drawer element
 */
function createAdvFormattingDrawer(id, title, description) {
    const drawer = createElement('div', {
        id,
        className: 'inline-drawer wide100p flexFlowColumn sb-af-settings-drawer',
    });
    const header = createElement('div', { className: 'inline-drawer-toggle inline-drawer-header' });
    const label = createElement('div', { className: 'flex-container flexFlowColumn' });
    const titleEl = createElement('b');
    titleEl.textContent = title;
    label.appendChild(titleEl);
    if (description) {
        const desc = createElement('small', { className: 'sb-group-meta' });
        desc.textContent = description;
        label.appendChild(desc);
    }
    header.appendChild(label);
    const icon = createElement('div', { className: 'fa-solid fa-circle-chevron-down inline-drawer-icon down' });
    header.appendChild(icon);
    drawer.appendChild(header);
    const content = createElement('div', { className: 'inline-drawer-content' });
    content.style.display = 'none';
    drawer.appendChild(content);
    return drawer;
}

/**
 * Wraps Advanced Formatting columns (Context Template, Instruct Template,
 * System Prompt, Reasoning) into collapsible drawers for better UX.
 */
function groupAdvancedFormattingIntoDrawers() {
    const $af = $('#AdvancedFormatting');
    if ($af.length === 0 || $af.data('sb-grouped')) {
        return;
    }

    // The three-column container
    const $columnsContainer = $af.find('.flex-container.spaceEvenly').first();
    if ($columnsContainer.length === 0) {
        return;
    }

    const sections = [
        {
            id: 'sb-af-context',
            title: 'Context Template',
            description: 'Story string, separators, and context formatting options',
            selector: '#ContextSettings',
        },
        {
            id: 'sb-af-instruct',
            title: 'Instruct Template',
            description: 'Instruct mode sequences, wrapping, and activation',
            selector: '#InstructSettingsColumn',
        },
        {
            id: 'sb-af-sysprompt',
            title: 'System Prompt',
            description: 'System prompt, post-history instructions, stopping strings, tokenizer',
            selector: '#SystemPromptColumn',
        },
    ];

    const $drawersContainer = $('<div>', { class: 'sb-af-drawers flex-container flexFlowColumn gap10' });

    sections.forEach(section => {
        const $col = $(section.selector).first();
        if ($col.length === 0) return;

        $col.detach();

        const drawer = createAdvFormattingDrawer(section.id, section.title, section.description);
        const content = drawer.querySelector('.inline-drawer-content');

        // Remove the flex1 class so it fills the full width in stacked layout
        $col.removeClass('flex1');
        $col.addClass('wide100p');

        content.appendChild($col[0]);
        $drawersContainer.append(drawer);
    });

    // Also check if Reasoning section exists after the columns container
    const $reasoning = $columnsContainer.nextAll().filter(function () {
        return $(this).find('#reasoning_auto_parse').length > 0 || $(this).find('.sb-reasoning-toggle-grid').length > 0;
    }).first();

    if ($reasoning.length > 0) {
        $reasoning.detach();
        const drawer = createAdvFormattingDrawer('sb-af-reasoning', 'Reasoning', 'Auto-parse, formatting, and reasoning block settings');
        const content = drawer.querySelector('.inline-drawer-content');
        content.appendChild($reasoning[0]);
        $drawersContainer.append(drawer);
    }

    // Replace the columns container with the stacked drawers
    $columnsContainer.replaceWith($drawersContainer);

    $af.data('sb-grouped', true);
}

function buildConsoleLogsPanel() {
    const { panel, scroller } = createShellPanel({
        id: 'console-logs',
    });

    const column = createElement('div', { className: 'sb-shell-column sb-console-log-column' });
    const callout = createElement('div', { className: 'sb-shell-callout' });
    callout.innerHTML = `
        <strong>Console Logs</strong>
        <p>Watch the recent terminal output from the running SillyBunny process here, without keeping a terminal window open on the side.</p>
    `;

    const card = createElement('section', { className: 'sb-admin-card sb-server-card sb-console-log-card' });
    const header = createElement('div', { className: 'sb-admin-card-header' });
    const copy = createElement('div', { className: 'sb-admin-card-copy' });
    const title = createElement('strong', { text: 'Live Server Console' });
    const description = createElement('p', { text: 'This mirrors the current process output captured from stdout and stderr. Only logs from the current SillyBunny session are available here.' });
    const statusPill = createElement('span', { className: 'sb-server-pill', text: 'Loading…' });
    const actions = createElement('div', { className: 'sb-server-actions sb-console-log-actions' });
    const refreshButton = createElement('button', { className: 'menu_button menu_button_icon sb-server-action', text: 'Refresh Now', attrs: { type: 'button' } });
    const pauseButton = createElement('button', { className: 'menu_button menu_button_icon sb-server-action', text: 'Pause Live', attrs: { type: 'button' } });
    const statusNote = createElement('div', { className: 'sb-server-note' });
    const output = createElement('pre', { className: 'sb-server-output sb-console-log-output' });

    copy.append(title, description);
    header.append(copy, statusPill);
    actions.append(refreshButton, pauseButton);
    card.append(header, actions, statusNote, output);
    column.append(callout, card);
    scroller.appendChild(column);

    const state = getConsoleLogsState();
    state.refs = {
        statusPill,
        refreshButton,
        pauseButton,
        statusNote,
        output,
    };

    refreshButton.addEventListener('click', () => {
        void refreshConsoleLogs({ forceFull: state.latestId === 0 });
    });
    pauseButton.addEventListener('click', toggleConsoleLogsPolling);

    renderConsoleLogsOutput({ preserveScroll: false });
    updateConsoleLogsInteractivity();

    return {
        id: 'console-logs',
        panel,
        button: null,
        searchRoot: column,
        onActivate: () => {
            void refreshConsoleLogs({ forceFull: getConsoleLogsState().latestId === 0 });
            scheduleConsoleLogsRefresh(0);
        },
        onDeactivate: () => {
            const state = getConsoleLogsState();
            window.clearTimeout(state.refreshTimer);
            state.refreshTimer = 0;
        },
    };
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
        const title = createElement('strong', { text: result?.displayName || result?.name || 'Unknown extension' });
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
    console.log(reportData);
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
        toastr.warning('Paste a SillyTavern folder path first.', 'Import SillyTavern');
        refs.pathInput.focus();
        return;
    }

    const confirmed = window.confirm(`Import data from this folder into the current SillyBunny account?\n\n${sourcePath}\n\nFiles with the same name will be replaced, and the page will reload when the import finishes.`);
    if (!confirmed) {
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
        toastr.error(error.message || 'Failed to import from that folder path.', 'Import SillyTavern');
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
        toastr.warning('Paste a SillyTavern folder path first.', 'Sync Extensions');
        refs.pathInput.focus();
        return;
    }

    const confirmed = window.confirm(`Sync third-party extensions from this SillyTavern folder into the current SillyBunny account?\n\n${sourcePath}\n\nMatching extension folders will be replaced. SillyBunny will show a detailed report instead of reloading immediately.`);
    if (!confirmed) {
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
            toastr.error(result?.message || 'Some extensions could not be synced.', 'Sync Extensions');
        } else if (warningCount > 0) {
            toastr.warning(result?.message || 'Extension sync finished with warnings.', 'Sync Extensions');
        } else {
            toastr.success(result?.message || 'Extension sync finished.', 'Sync Extensions');
        }
    } catch (error) {
        console.error('Failed to sync SillyTavern third-party extensions.', error);
        setServerAdminMessage(refs.note, error.message || 'Failed to sync third-party extensions from that folder.', 'danger');
        toastr.error(error.message || 'Failed to sync third-party extensions from that folder.', 'Sync Extensions');
    } finally {
        setSillyTavernImportBusy(false);
    }
}

async function handleSillyTavernZipImport(file) {
    const refs = getImporterRefs();

    if (!(file instanceof File) || getImporterState().busy || !refs) {
        return;
    }

    const confirmed = window.confirm(`Import this SillyTavern backup ZIP into the current SillyBunny account?\n\n${file.name}\n\nFiles with the same name will be replaced, and the page will reload when the import finishes.`);
    if (!confirmed) {
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
        toastr.error(error.message || 'Failed to import that backup ZIP.', 'Import SillyTavern');
    } finally {
        if (refs.zipFileInput instanceof HTMLInputElement) {
            refs.zipFileInput.value = '';
        }

        setSillyTavernImportBusy(false);
    }
}

function injectSillyTavernImportCard() {
    const importOutlet = document.getElementById('sb-import-tools-outlet');
    const themeBlock = document.getElementById('UI-presets-block');
    const cardHost = importOutlet instanceof HTMLElement
        ? importOutlet
        : themeBlock;
    if (!(cardHost instanceof HTMLElement)) {
        return;
    }

    const existingCard = document.getElementById('sb-import-card');
    if (existingCard instanceof HTMLElement) {
        if (cardHost.firstElementChild !== existingCard) {
            cardHost.prepend(existingCard);
        }

        return;
    }

    const card = createElement('section', { id: 'sb-import-card', className: 'sb-admin-card sb-import-card' });
    const header = createElement('div', { className: 'sb-admin-card-header' });
    const copy = createElement('div', { className: 'sb-admin-card-copy' });
    const title = createElement('strong', { text: 'Import Your SillyTavern Setup' });
    const description = createElement('p', { text: 'Bring over characters, chats, presets, themes, extensions, and account settings from an existing SillyTavern folder or backup ZIP without touching the filesystem manually.' });
    const badge = createElement('span', { className: 'sb-server-pill', text: 'Easy Import' });
    copy.append(title, description);
    header.append(copy, badge);

    const hintRow = createElement('div', { className: 'sb-import-hints' });
    for (const label of ['Characters', 'Chats', 'Presets', 'Themes', 'Extensions']) {
        hintRow.appendChild(createElement('span', { className: 'sb-import-chip', text: label }));
    }

    const grid = createElement('div', { className: 'sb-import-grid' });
    const folderPane = createElement('div', { className: 'sb-import-pane' });
    const folderTitle = createElement('strong', { text: 'Import From Folder Path' });
    const folderBody = createElement('p', { text: 'Paste the path to your SillyTavern install, its `data` folder, or the specific user folder you want to import. Use the full import for everything, or sync just your third-party extensions with a detailed report.' });
    const pathRow = createElement('div', { className: 'sb-import-path-row' });
    const actionRow = createElement('div', { className: 'sb-import-action-row' });
    const pathInput = createElement('input', {
        id: 'sb-import-path-input',
        className: 'text_pole sb-import-path-input',
        attrs: {
            type: 'text',
            placeholder: '/path/to/SillyTavern',
            'aria-label': 'SillyTavern folder path',
            autocomplete: 'off',
            spellcheck: 'false',
            title: 'You can paste a full SillyTavern install path, its data folder, or a specific user folder.',
        },
    });
    const folderButton = createElement('button', {
        className: 'menu_button menu_button_icon sb-server-action menu_button_primary',
        attrs: { type: 'button' },
        html: '<i class="fa-solid fa-folder-open" aria-hidden="true"></i><span>Import Folder</span>',
    });
    const syncButton = createElement('button', {
        className: 'menu_button menu_button_icon sb-server-action',
        attrs: { type: 'button' },
        html: '<i class="fa-solid fa-puzzle-piece" aria-hidden="true"></i><span>Sync Extensions</span>',
    });
    pathRow.append(pathInput);
    actionRow.append(folderButton, syncButton);
    folderPane.append(folderTitle, folderBody, pathRow, actionRow);

    const zipPane = createElement('div', { className: 'sb-import-pane' });
    const zipTitle = createElement('strong', { text: 'Import From Backup ZIP' });
    const zipBody = createElement('p', { text: 'Use the backup ZIP that SillyTavern exports. Pick the file here and SillyBunny will import it into this account.' });
    const zipButton = createElement('button', {
        className: 'menu_button menu_button_icon sb-server-action menu_button_primary',
        attrs: { type: 'button' },
        html: '<i class="fa-solid fa-file-zipper" aria-hidden="true"></i><span>Import Backup ZIP</span>',
    });
    const zipFileInput = createElement('input', {
        id: 'sb-import-zip-input',
        className: 'sb-import-file-input',
        attrs: {
            type: 'file',
            accept: '.zip,application/zip,application/x-zip-compressed',
            'aria-label': 'Choose a SillyTavern backup ZIP',
        },
    });
    const zipFileName = createElement('small', { className: 'sb-import-file-name', text: 'No ZIP selected yet.' });
    zipPane.append(zipTitle, zipBody, zipButton, zipFileInput, zipFileName);

    const note = createElement('div', {
        className: 'sb-server-note sb-import-note',
        text: 'Full imports replace matching files and reload automatically. Extension sync replaces matching third-party extension folders, then shows a report so you can review it before reloading.',
    });
    const report = createElement('section', {
        className: 'sb-import-report',
        attrs: { 'aria-live': 'polite' },
    });
    const reportHeader = createElement('div', { className: 'sb-import-report-header' });
    const reportTitle = createElement('strong', { text: 'Third-Party Extension Sync Report' });
    const reportSummary = createElement('p', { className: 'sb-import-report-summary' });
    const reportHelp = createElement('p', { className: 'sb-import-report-help' });
    const reportList = createElement('div', { className: 'sb-import-report-list' });

    reportHeader.append(reportTitle);
    report.append(reportHeader, reportSummary, reportHelp, reportList);
    report.hidden = true;

    grid.append(folderPane, zipPane);
    card.append(header, hintRow, grid, note, report);
    cardHost.prepend(card);

    getImporterState().refs = {
        card,
        pathInput,
        folderButton,
        syncButton,
        zipButton,
        zipFileInput,
        zipFileName,
        note,
        report,
        reportSummary,
        reportHelp,
        reportList,
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
        zipFileName.textContent = file?.name || 'No ZIP selected yet.';

        if (file) {
            void handleSillyTavernZipImport(file);
        }
    });

    updateSillyTavernImportInteractivity();
}

function createThemeSliderGroup({ title, valueId, inputId, value, min, max, step, ariaLabel, caption, onInput, className = '' }) {
    const sliderGroup = createElement('div', { className: `sb-theme-slider-group ${className}`.trim() });
    const sliderHeader = createElement('div', { className: 'sb-theme-slider-header' });
    const sliderTitle = createElement('strong', { text: title });
    const sliderValue = createElement('span', { id: valueId, className: 'sb-theme-slider-value' });
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
        className: 'sb-theme-slider-caption',
        text: caption,
    });

    sliderHeader.append(sliderTitle, sliderValue);
    sliderGroup.append(sliderHeader, sliderInput, sliderCaption);
    sliderInput.addEventListener('input', event => onInput(event.currentTarget?.value));

    return sliderGroup;
}

function createTopbarLabelOption(mode, part) {
    const inputId = `sb-topbar-label-${mode}-${part.id}`;
    const option = createElement('label', {
        className: 'sb-topbar-label-option',
        attrs: {
            for: inputId,
        },
    });
    const checkbox = createElement('input', {
        id: inputId,
        className: 'sb-topbar-label-checkbox',
        attrs: {
            type: 'checkbox',
            'data-sb-topbar-label-mode': mode,
            'data-sb-topbar-label-part': part.id,
        },
    });
    const copy = createElement('span', { className: 'sb-topbar-label-option-copy' });
    const title = createElement('strong', { text: part.label });
    const description = createElement('small', { text: part.description });

    checkbox.addEventListener('change', event => {
        const input = event.currentTarget;
        const isChecked = input instanceof HTMLInputElement ? input.checked : false;

        if (mode === 'mobile') {
            setMobileTopbarLabelPart(part.id, isChecked);
        } else {
            setDesktopTopbarLabelPart(part.id, isChecked);
        }
    });

    copy.append(title, description);
    option.append(checkbox, copy);
    return option;
}

function createShortcutSettingsGroup() {
    const group = createElement('section', {
        className: 'sb-theme-slider-group',
    });

    const heading = createElement('div', { className: 'sb-theme-slider-label' });
    heading.innerHTML = '<strong>Quick Access Shortcuts</strong><br><small>Assign a shell tab or universal search to each shortcut button in the top bar.</small>';
    group.appendChild(heading);

    const rows = createElement('div', {
        className: 'sb-shortcut-rows',
    });

    for (const side of ['left', 'right']) {
        const selectId = `sb-shortcut-${side}-select`;
        const row = createElement('div', { className: 'sb-shortcut-row' });

        const label = createElement('label', {
            className: 'sb-shortcut-label',
            attrs: {
                for: selectId,
            },
        });
        label.textContent = side === 'left' ? 'Left' : 'Right';

        const select = createElement('select', {
            id: selectId,
            className: 'sb-shortcut-select',
        });

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
            const key = side === 'left' ? SB_STORAGE_KEYS.shortcutLeft : SB_STORAGE_KEYS.shortcutRight;
            safeSetItem(key, select.value);
            updateShortcutButton(side);
        });

        row.append(label, select);
        rows.appendChild(row);
    }

    group.appendChild(rows);
    return group;
}

function getMobileQuickActionContextLabel(action) {
    const normalizedAction = normalizeMobileQuickAction(action);
    if (!normalizedAction) {
        return '';
    }

    const shellLabel = normalizedAction.shellKey === 'characters'
        ? 'Characters'
        : getShellConfig(normalizedAction.shellKey)?.title || normalizedAction.shellKey;
    const tabLabel = normalizedAction.shellKey === 'characters'
        ? getCharacterPanelTabConfig(normalizedAction.tabId)?.label || normalizedAction.tabId
        : getShellState(normalizedAction.shellKey)?.tabs?.get(normalizedAction.tabId)?.label
        || getMobileQuickActionTabConfig(normalizedAction.shellKey, normalizedAction.tabId)?.label
        || normalizedAction.tabId;
    const labels = [shellLabel, tabLabel];

    if (normalizedAction.type === 'custom'
        && normalizedAction.sectionLabel
        && normalizeText(normalizedAction.sectionLabel) !== normalizeText(tabLabel)) {
        labels.push(normalizedAction.sectionLabel);
    }

    return labels.join(' · ');
}

function createMobileQuickActionIconElement(iconClass) {
    return createElement('i', {
        className: `fa-solid ${normalizeFontAwesomeIcon(iconClass)}`,
        attrs: {
            'aria-hidden': 'true',
        },
    });
}

function createMobileQuickActionIconControl(action, actionKey, mode = 'mobile') {
    const normalizedAction = normalizeMobileQuickAction(action);
    const iconClass = normalizedAction?.icon || SB_MOBILE_QUICK_ACTION_ICON_FALLBACK;

    if (normalizedAction?.type === 'custom') {
        const button = createElement('button', {
            className: 'menu_button menu_button_icon sb-mobile-quick-action-icon-picker',
            attrs: {
                type: 'button',
                title: `Choose icon for ${normalizedAction.label}`,
                'aria-label': `Choose icon for ${normalizedAction.label}`,
            },
        });
        button.appendChild(createMobileQuickActionIconElement(iconClass));
        button.addEventListener('click', () => {
            void chooseQuickActionIcon(mode, actionKey);
        });
        return button;
    }

    const preview = createElement('span', {
        className: 'sb-mobile-quick-action-icon-preview',
        attrs: {
            title: normalizedAction ? `${normalizedAction.label} icon` : 'Quick Action icon',
            'aria-hidden': 'true',
        },
    });
    preview.appendChild(createMobileQuickActionIconElement(iconClass));
    return preview;
}

function updateMobileQuickActionSettingsStatus(mode = 'mobile') {
    const currentActions = getQuickActionState(mode);
    const status = document.getElementById(`sb-${mode}-quick-action-status`);
    if (status instanceof HTMLElement) {
        status.textContent = mode === 'desktop'
            ? `${currentActions.length}/${SB_MOBILE_QUICK_ACTION_LIMIT} selected. This list controls the desktop side rail shortcuts.`
            : `${currentActions.length}/${SB_MOBILE_QUICK_ACTION_LIMIT} selected. This list replaces the mobile quick shortcuts.`;
    }

    const resetButton = document.getElementById(`sb-${mode}-quick-action-reset`);
    if (resetButton instanceof HTMLButtonElement) {
        const currentKeys = currentActions.map(getMobileQuickActionKey);
        const defaultKeys = (mode === 'desktop' ? getDefaultDesktopQuickActions() : getDefaultMobileQuickActions()).map(getMobileQuickActionKey);
        resetButton.disabled = currentKeys.length === defaultKeys.length
            && currentKeys.every((key, index) => key === defaultKeys[index]);
    }
}

function refreshMobileQuickActionSearchResults(mode = 'mobile') {
    const searchInput = document.getElementById(`sb-${mode}-quick-action-search`);
    const results = document.getElementById(`sb-${mode}-quick-action-results`);

    if (searchInput instanceof HTMLInputElement && results instanceof HTMLElement) {
        renderMobileQuickActionResults(searchInput.value, results, mode);
    }
}

function renderMobileQuickActionResults(query, resultsElement, mode = 'mobile') {
    if (!(resultsElement instanceof HTMLElement)) {
        return;
    }

    const modeLabel = mode === 'desktop' ? 'desktop' : 'mobile';

    resultsElement.replaceChildren();

    const trimmedQuery = String(query ?? '').trim();
    if (trimmedQuery.length < 2) {
        resultsElement.appendChild(createElement('div', {
            className: 'sb-mobile-quick-action-empty',
            text: 'Type at least 2 characters to find settings and extensions.',
        }));
        return;
    }

    const matches = getMobileQuickActionSearchMatches(trimmedQuery);
    if (!matches.length) {
        resultsElement.appendChild(createElement('div', {
            className: 'sb-mobile-quick-action-empty',
            text: `No matches for "${trimmedQuery}" yet.`,
        }));
        return;
    }

    const currentActions = getQuickActionState(mode);
    const currentKeys = new Set(currentActions.map(getMobileQuickActionKey));
    for (const match of matches) {
        const action = createMobileQuickActionFromMatch(match);
        if (!action) {
            continue;
        }

        const actionKey = getMobileQuickActionKey(action);
        const isAdded = currentKeys.has(actionKey);
        const isFull = currentActions.length >= SB_MOBILE_QUICK_ACTION_LIMIT;
        const buttonText = isAdded ? 'Added' : isFull ? 'Full' : 'Add';
        const row = createElement('div', { className: 'sb-mobile-quick-action-result' });
        const copy = createElement('span', { className: 'sb-mobile-quick-action-copy' });
        const title = createElement('strong', { text: action.label });
        const detail = createElement('small', {
            text: `${match.shellLabel} · ${match.tabLabel}${action.sectionLabel ? ` · ${action.sectionLabel}` : ''}`,
        });
        const button = createElement('button', {
            className: 'menu_button sb-mobile-quick-action-add',
            text: buttonText,
            attrs: {
                type: 'button',
                'aria-label': isAdded
                    ? `${action.label} is already in ${modeLabel} Quick Actions`
                    : `Add ${action.label} to ${modeLabel} Quick Actions`,
            },
        });

        button.disabled = isAdded || isFull;
        button.addEventListener('click', () => addQuickActionFromMatch(mode, match));

        copy.append(title, detail);
        row.append(copy, button);
        resultsElement.appendChild(row);
    }
}

function renderMobileQuickActionSettingsList(mode = 'mobile') {
    updateMobileQuickActionSettingsStatus(mode);

    const list = document.getElementById(`sb-${mode}-quick-action-list`);
    if (!(list instanceof HTMLElement)) {
        return;
    }

    const modeLabel = mode === 'desktop' ? 'desktop' : 'mobile';
    const currentActions = getQuickActionState(mode);

    list.replaceChildren();

    if (!currentActions.length) {
        list.appendChild(createElement('div', {
            className: 'sb-mobile-quick-action-empty',
            text: `No ${modeLabel} Quick Actions selected. Add one from search or reset to defaults.`,
        }));
        return;
    }

    for (const action of currentActions) {
        const actionKey = getMobileQuickActionKey(action);
        const row = createElement('div', { className: 'sb-mobile-quick-action-current' });
        const copy = createElement('span', { className: 'sb-mobile-quick-action-copy' });
        const title = createElement('strong', { text: action.label });
        const detail = createElement('small', { text: getMobileQuickActionContextLabel(action) });
        const controls = createElement('span', { className: 'sb-mobile-quick-action-controls' });
        const iconControl = createMobileQuickActionIconControl(action, actionKey, mode);
        const removeButton = createElement('button', {
            className: 'menu_button sb-mobile-quick-action-remove',
            text: 'Remove',
            attrs: {
                type: 'button',
                'aria-label': `Remove ${action.label} from ${modeLabel} Quick Actions`,
            },
        });

        removeButton.addEventListener('click', () => removeQuickAction(mode, actionKey));

        copy.append(title, detail);
        controls.append(iconControl, removeButton);
        row.append(copy, controls);
        list.appendChild(row);
    }
}

function createMobileQuickActionSettingsGroup(mode = 'mobile') {
    const isDesktop = mode === 'desktop';
    const modeTitle = isDesktop ? 'Desktop' : 'Mobile';
    const modeLabel = isDesktop ? 'desktop' : 'mobile';
    const group = createElement('section', {
        className: `sb-theme-slider-group sb-mobile-quick-actions-group sb-${mode}-quick-actions-group`,
    });
    const header = createElement('div', { className: 'sb-mobile-quick-action-header' });
    const heading = createElement('div', { className: 'sb-mobile-quick-action-heading' });
    const title = createElement('strong', { text: `${modeTitle} Quick Actions` });
    const description = createElement('p', {
        className: 'sb-theme-slider-caption',
        text: isDesktop
            ? 'Choose the shortcuts shown below Customize in the desktop side rail. Defaults can be removed or restored.'
            : 'Choose the shortcuts shown in the mobile quick drawer. Defaults can be removed or restored.',
    });
    const resetButton = createElement('button', {
        id: `sb-${mode}-quick-action-reset`,
        className: 'menu_button sb-mobile-quick-action-reset',
        text: 'Reset to defaults',
        attrs: {
            type: 'button',
        },
    });

    const searchInput = createElement('input', {
        id: `sb-${mode}-quick-action-search`,
        className: 'text_pole sb-mobile-quick-action-search',
        attrs: {
            type: 'search',
            placeholder: 'Search settings or extensions...',
            autocomplete: 'off',
            'aria-label': `Search settings and extensions to add as ${modeLabel} Quick Actions`,
        },
    });
    const results = createElement('div', {
        id: `sb-${mode}-quick-action-results`,
        className: 'sb-mobile-quick-action-results',
    });
    const list = createElement('div', {
        id: `sb-${mode}-quick-action-list`,
        className: 'sb-mobile-quick-action-list',
    });
    const status = createElement('p', {
        id: `sb-${mode}-quick-action-status`,
        className: 'sb-theme-slider-caption',
    });

    heading.append(title, description);
    header.append(heading, resetButton);

    resetButton.addEventListener('click', isDesktop ? resetDesktopQuickActions : resetMobileQuickActions);

    searchInput.addEventListener('input', event => {
        const input = event.currentTarget;
        renderMobileQuickActionResults(input instanceof HTMLInputElement ? input.value : '', results, mode);
    });

    group.append(header, searchInput, results, list, status);
    renderMobileQuickActionResults('', results, mode);

    window.requestAnimationFrame(() => renderMobileQuickActionSettingsList(mode));
    return group;
}

function createCompactModeSettingsGroup(mode = 'mobile') {
    const inputId = mode === 'desktop' ? 'sb-desktop-compact-mode-input' : 'sb-mobile-compact-mode-input';
    const group = createElement('section', {
        className: 'sb-theme-slider-group sb-compact-mode-group',
    });
    const label = createElement('label', {
        className: 'sb-compact-mode-option',
        attrs: {
            for: inputId,
        },
    });
    const checkbox = createElement('input', {
        id: inputId,
        className: 'sb-compact-mode-checkbox',
        attrs: {
            type: 'checkbox',
            'data-sb-compact-mode-input': mode,
        },
    });
    const copy = createElement('span', { className: 'sb-compact-mode-copy' });
    const title = createElement('strong', { text: 'Compact Mode' });
    const description = createElement('small', {
        text: 'Reduce spacing, controls, and mobile composer height for denser screens.',
    });

    checkbox.addEventListener('change', event => {
        const input = event.currentTarget;
        setCompactMode(input instanceof HTMLInputElement && input.checked);
    });

    copy.append(title, description);
    label.append(checkbox, copy);
    group.appendChild(label);
    return group;
}

function createMobileNavChoice({ id, type = 'radio', name = '', value = '', label, icon, onChange }) {
    const choice = createElement('label', {
        className: 'sb-mobile-nav-choice',
        attrs: {
            for: id,
        },
    });
    const inputAttrs = {
        type,
        value,
    };

    if (name) {
        inputAttrs.name = name;
    }

    const input = createElement('input', {
        id,
        className: 'sb-mobile-nav-choice-input',
        attrs: inputAttrs,
    });
    const iconElement = createElement('i', {
        className: `fa-solid ${icon} sb-mobile-nav-choice-icon`,
        attrs: {
            'aria-hidden': 'true',
        },
    });
    const copy = createElement('span', { className: 'sb-mobile-nav-choice-copy' });
    const title = createElement('strong', { text: label });

    input.addEventListener('change', event => {
        const target = event.currentTarget;
        if (!(target instanceof HTMLInputElement)) {
            return;
        }

        if (target.type === 'radio' && !target.checked) {
            return;
        }

        onChange?.(target);
    });

    copy.appendChild(title);
    choice.append(input, iconElement, copy);
    return choice;
}

function createMobileNavDivider(label = '') {
    const divider = createElement('div', {
        className: 'sb-mobile-nav-settings-divider',
        attrs: label ? { role: 'separator', 'aria-label': label } : { role: 'separator' },
    });
    if (label) {
        divider.appendChild(createElement('span', { text: label }));
    }
    return divider;
}

function createNavigationSettingsGroup(mode = 'mobile') {
    const isDesktop = mode === 'desktop';
    const modeTitle = isDesktop ? 'Desktop' : 'Mobile';
    const modePrefix = isDesktop ? 'desktop' : 'mobile';
    const group = createElement('section', {
        className: `sb-theme-slider-group sb-mobile-nav-layout-group sb-${modePrefix}-nav-layout-group`,
    });
    const header = createElement('div', { className: 'sb-mobile-nav-settings-header' });
    const title = createElement('strong', { text: `${modeTitle} Navigation` });
    const layoutGrid = createElement('div', {
        className: 'sb-mobile-nav-choice-grid',
        attrs: {
            role: 'radiogroup',
            'aria-label': `${modeTitle} navigation layout`,
        },
    });
    const iconOnlyChoice = createMobileNavChoice({
        id: `sb-${modePrefix}-nav-icon-only-input`,
        type: 'checkbox',
        value: 'icon-only',
        label: 'Icons only in shell tabs',
        icon: 'fa-icons',
        onChange: input => isDesktop ? setDesktopNavIconOnly(input.checked) : setMobileNavIconOnly(input.checked),
    });
    const showCustomizeChoice = createMobileNavChoice({
        id: `sb-${modePrefix}-nav-show-customize-input`,
        type: 'checkbox',
        value: 'show-customize',
        label: getMobileNavCustomizeLocationLabel(mode),
        icon: 'fa-screwdriver-wrench',
        onChange: input => isDesktop ? setDesktopNavShowCustomize(input.checked) : setMobileNavShowCustomize(input.checked),
    });
    const showQuickActionsChoice = createMobileNavChoice({
        id: `sb-${modePrefix}-nav-show-quick-actions-input`,
        type: 'checkbox',
        value: 'show-quick-actions',
        label: 'Show Custom Quick Actions in the side rail',
        icon: 'fa-bolt',
        onChange: input => isDesktop ? setDesktopNavShowQuickActions(input.checked) : setMobileNavShowQuickActions(input.checked),
    });
    const replaceQuickActionsChoice = createMobileNavChoice({
        id: `sb-${modePrefix}-nav-replace-quick-actions-input`,
        type: 'checkbox',
        value: 'replace-quick-actions',
        label: 'Use a chosen page instead of Quick Actions',
        icon: 'fa-map-location-dot',
        onChange: input => isDesktop ? setDesktopNavReplaceQuickActions(input.checked) : setMobileNavReplaceQuickActions(input.checked),
    });
    const replacementField = createElement('label', {
        className: 'sb-mobile-nav-replacement-field',
        attrs: {
            for: `sb-${modePrefix}-nav-replacement-select`,
        },
    });
    const replacementLabel = createElement('span', { text: 'Replacement page' });
    const replacementSelect = createElement('select', {
        id: `sb-${modePrefix}-nav-replacement-select`,
        className: 'text_pole sb-mobile-nav-replacement-select',
    });

    for (const target of SB_MOBILE_NAV_PAGE_TARGETS) {
        const option = createElement('option', {
            attrs: {
                value: target.value,
            },
        });
        option.textContent = target.label;
        replacementSelect.appendChild(option);
    }

    replacementSelect.addEventListener('change', event => {
        const select = event.currentTarget;
        const nextValue = select instanceof HTMLSelectElement ? select.value : '';
        if (isDesktop) {
            setDesktopNavReplacementTarget(nextValue);
        } else {
            setMobileNavReplacementTarget(nextValue);
        }
    });

    layoutGrid.append(
        createMobileNavChoice({
            id: `sb-${modePrefix}-nav-layout-horizontal`,
            name: `sb-${modePrefix}-nav-layout`,
            value: 'horizontal',
            label: 'Horizontal top bar',
            icon: 'fa-grip-lines',
            onChange: input => isDesktop ? setDesktopNavLayout(input.value) : setMobileNavLayout(input.value),
        }),
        createMobileNavChoice({
            id: `sb-${modePrefix}-nav-layout-vertical`,
            name: `sb-${modePrefix}-nav-layout`,
            value: 'vertical',
            label: 'Vertical side rail',
            icon: 'fa-table-columns',
            onChange: input => isDesktop ? setDesktopNavLayout(input.value) : setMobileNavLayout(input.value),
        }),
    );

    header.appendChild(title);
    replacementField.append(replacementLabel, replacementSelect);
    group.append(
        header,
        layoutGrid,
        iconOnlyChoice,
        createMobileNavDivider(),
        showCustomizeChoice,
        showQuickActionsChoice,
        replaceQuickActionsChoice,
        replacementField,
    );
    return group;
}

function createMobileNavLayoutSettingsGroup() {
    return createNavigationSettingsGroup('mobile');
}

function createDesktopNavLayoutSettingsGroup() {
    return createNavigationSettingsGroup('desktop');
}

function createDesktopShellSizingSettingsGroup() {
    const group = createElement('section', {
        className: 'sb-theme-slider-group sb-desktop-shell-sizing-group sb-desktop-setting',
    });
    const header = createElement('div', { className: 'sb-mobile-nav-settings-header' });
    const title = createElement('strong', { text: 'Panel Sizing' });
    const description = createElement('p', {
        className: 'sb-theme-slider-caption',
        text: 'Keep Workspace, Customize, and Characters aligned with the active chat width.',
    });
    const snapChoice = createMobileNavChoice({
        id: 'sb-desktop-shell-snap-to-chat-input',
        type: 'checkbox',
        value: 'snap-to-chat-width',
        label: 'Snap to chat width',
        icon: 'fa-arrows-left-right-to-line',
        onChange: input => setDesktopShellSnapToChatWidth(input.checked),
    });

    header.append(title, description);
    group.append(header, snapChoice);
    return group;
}

function createFrontendIconSettingsGroup() {
    const group = createElement('section', {
        className: 'sb-theme-slider-group sb-frontend-icon-group',
    });
    const header = createElement('div', { className: 'sb-frontend-icon-header' });
    const title = createElement('strong', { text: 'Frontend Icon' });
    const description = createElement('p', {
        className: 'sb-theme-slider-caption',
        text: 'Choose which SillyBunny icon appears in the app chrome, splash screen, and Home panel.',
    });
    const options = createElement('div', { className: 'sb-frontend-icon-options' });

    header.append(title, description);

    for (const icon of SB_FRONTEND_ICONS) {
        const button = createElement('button', {
            className: 'sb-theme-option sb-frontend-icon-option',
            attrs: {
                type: 'button',
                'data-sb-frontend-icon-option': icon.id,
            },
        });
        const preview = createElement('img', {
            className: 'sb-frontend-icon-preview',
            attrs: {
                src: icon.src,
                alt: '',
                loading: 'lazy',
            },
        });
        const copy = createElement('span', { className: 'sb-frontend-icon-copy' });
        const label = createElement('span', { className: 'sb-theme-option-label', text: icon.label });
        const meta = createElement('span', { className: 'sb-theme-option-meta', text: icon.description });

        copy.append(label, meta);
        button.append(preview, copy);
        button.addEventListener('click', () => setFrontendIconPreference(icon.id));
        options.appendChild(button);
    }

    group.append(header, options);
    return group;
}

function updateShortcutButton(side) {
    const buttonId = side === 'left' ? 'sb-shortcut-left' : 'sb-shortcut-right';
    const button = document.getElementById(buttonId);
    if (!(button instanceof HTMLElement)) return;

    const target = getShortcutTarget(side);
    const config = getShortcutConfig(target);
    const icon = button.querySelector('i');
    const span = button.querySelector('span');

    if (icon) {
        icon.className = `fa-solid ${config.icon}`;
    }
    if (span) {
        span.textContent = config.label;
    }
    button.title = `Quick access: ${config.label}`;
    button.setAttribute('aria-label', `Quick access: ${config.label}`);
    button.dataset.sbUniversalSearchTrigger = String(isSearchShortcutTarget(target));
    syncShortcutButtonActiveStates();
}

function syncShortcutButtonActiveStates() {
    const searchExpanded = getUniversalSearchState().expanded;

    for (const side of ['left', 'right']) {
        const buttonId = side === 'left' ? 'sb-shortcut-left' : 'sb-shortcut-right';
        const button = document.getElementById(buttonId);

        if (!(button instanceof HTMLButtonElement)) {
            continue;
        }

        const target = getShortcutTarget(side);
        setButtonPressed(button, isSearchShortcutTarget(target) && searchExpanded);
    }
}

function createTopbarLabelSettingsGroup() {
    const group = createElement('section', {
        className: 'sb-theme-slider-group sb-topbar-label-group',
    });
    const header = createElement('div', { className: 'sb-topbar-label-header' });
    const title = createElement('strong', { text: 'Top Bar Label' });
    const description = createElement('p', {
        className: 'sb-theme-slider-caption',
        text: 'Choose what the center label shows. Desktop can mix multiple parts with a middle dot, while mobile keeps one selection at a time.',
    });
    const desktopSection = createElement('div', { className: 'sb-topbar-label-section sb-desktop-setting' });
    const desktopHeading = createElement('div', { className: 'sb-topbar-label-section-heading' });
    const desktopTitle = createElement('strong', { text: 'Desktop' });
    const desktopDescription = createElement('small', { text: 'Pick any combination you want.' });
    const desktopGrid = createElement('div', { className: 'sb-topbar-label-option-grid' });
    const mobileSection = createElement('div', { className: 'sb-topbar-label-section sb-mobile-setting' });
    const mobileHeading = createElement('div', { className: 'sb-topbar-label-section-heading' });
    const mobileTitle = createElement('strong', { text: 'Mobile' });
    const mobileDescription = createElement('small', { text: 'Pick one option at a time.' });
    const mobileGrid = createElement('div', { className: 'sb-topbar-label-option-grid' });
    const customTextField = createElement('label', {
        className: 'sb-topbar-custom-text-field',
        attrs: {
            for: 'sb-topbar-custom-text-input',
        },
    });
    const customTextHeading = createElement('div', { className: 'sb-topbar-label-section-heading' });
    const customTextTitle = createElement('strong', { text: 'Custom Text Value' });
    const customTextDescription = createElement('small', { text: 'This only appears in the top bar when the Custom Text checkbox is enabled above.' });
    const customTextInput = createElement('input', {
        id: 'sb-topbar-custom-text-input',
        className: 'text_pole sb-topbar-custom-text-input',
        attrs: {
            type: 'text',
            maxlength: String(SB_TOPBAR_LABEL_CUSTOM_TEXT_MAX_LENGTH),
            placeholder: 'SillyBunny',
            'aria-label': 'Top bar custom text',
        },
    });

    customTextInput.addEventListener('input', event => {
        const input = event.currentTarget;
        setTopbarCustomText(input instanceof HTMLInputElement ? input.value : '');
    });

    header.append(title, description);
    desktopHeading.append(desktopTitle, desktopDescription);
    mobileHeading.append(mobileTitle, mobileDescription);
    customTextHeading.append(customTextTitle, customTextDescription);

    for (const part of SB_TOPBAR_LABEL_PARTS) {
        desktopGrid.appendChild(createTopbarLabelOption('desktop', part));
        mobileGrid.appendChild(createTopbarLabelOption('mobile', part));
    }

    desktopSection.append(desktopHeading, desktopGrid);
    mobileSection.append(mobileHeading, mobileGrid);
    customTextField.append(customTextHeading, customTextInput);
    group.append(header, desktopSection, mobileSection, customTextField);

    return group;
}

function injectThemePicker() {
    if (document.getElementById('sb-theme-card')) {
        updateThemePickerUi();
        return;
    }

    const themeBlock = document.getElementById('UI-presets-block');
    if (!(themeBlock instanceof HTMLElement)) {
        return;
    }

    const card = createElement('div', { id: 'sb-theme-card', className: 'sb-theme-card' });
    const header = createElement('div', { className: 'sb-theme-card-header' });
    const title = createElement('strong', { text: 'Shell Style' });
    const description = createElement('p', { text: 'Switch the navigation shell between built-in visual directions.' });
    const optionRow = createElement('div', { className: 'sb-theme-option-row' });
    const surfaceSliderGroup = createThemeSliderGroup({
        title: 'Background Visibility',
        valueId: 'sb-surface-transparency-value',
        inputId: 'sb-surface-transparency-input',
        value: sbState.surfaceTransparency,
        min: SB_SURFACE_TRANSPARENCY.min,
        max: SB_SURFACE_TRANSPARENCY.max,
        step: SB_SURFACE_TRANSPARENCY.step,
        ariaLabel: 'Background visibility',
        caption: 'Higher values make the home and chat surfaces more transparent so your selected background picture shows through.',
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
        ariaLabel: 'Bottom bar size',
        caption: 'Resize the bottom chat bar, send form, and action buttons without editing CSS.',
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
        ariaLabel: 'Desktop button size',
        caption: 'Increase or decrease the desktop top bar and shell navigation buttons without changing mobile controls.',
        onInput: nextValue => setDesktopButtonScale(nextValue),
        className: 'sb-desktop-setting',
    });
    const mobileButtonSliderGroup = createThemeSliderGroup({
        title: 'Mobile Button Size',
        valueId: 'sb-mobile-button-scale-value',
        inputId: 'sb-mobile-button-scale-input',
        value: sbState.mobileButtonScale,
        min: SB_TOPBAR_SCALE.min,
        max: SB_TOPBAR_SCALE.max,
        step: SB_TOPBAR_SCALE.step,
        ariaLabel: 'Mobile button size',
        caption: 'Increase or decrease the mobile nav and mobile chat tool buttons without changing desktop controls.',
        onInput: nextValue => setMobileButtonScale(nextValue),
        className: 'sb-mobile-only-setting',
    });
    const topbarLabelSettingsGroup = createTopbarLabelSettingsGroup();
    const desktopNavLayoutSettingsGroup = createDesktopNavLayoutSettingsGroup();
    const desktopShellSizingSettingsGroup = createDesktopShellSizingSettingsGroup();
    const mobileNavLayoutSettingsGroup = createMobileNavLayoutSettingsGroup();
    const desktopSettingsDivider = createMobileNavDivider();
    const mobileSettingsDivider = createMobileNavDivider();
    const desktopCompactModeSettingsGroup = createCompactModeSettingsGroup('desktop');
    const mobileCompactModeSettingsGroup = createCompactModeSettingsGroup('mobile');
    const frontendIconSettingsGroup = createFrontendIconSettingsGroup();
    const shortcutSettingsGroup = createShortcutSettingsGroup();
    const desktopQuickActionSettingsGroup = createMobileQuickActionSettingsGroup('desktop');
    const mobileQuickActionSettingsGroup = createMobileQuickActionSettingsGroup();
    const desktopSettingsOutlet = document.getElementById('sb-desktop-settings-outlet');
    const mobileSettingsOutlet = document.getElementById('sb-mobile-settings-outlet');
    header.append(title, description);

    for (const theme of SB_THEMES) {
        const button = createElement('button', {
            className: 'sb-theme-option',
            attrs: {
                type: 'button',
                'data-sb-theme-option': theme.id,
            },
        });

        button.innerHTML = `
            <span class="sb-theme-option-label">${theme.label}</span>
        `;

        button.addEventListener('click', () => setShellTheme(theme.id));
        optionRow.appendChild(button);
    }

    getMessageStyleSelect()?.addEventListener('change', updateThemePickerUi);
    document.addEventListener('sb:chat-style-updated', updateThemePickerUi);

    if (desktopSettingsOutlet instanceof HTMLElement) {
        desktopSettingsOutlet.replaceChildren(
            desktopNavLayoutSettingsGroup,
            desktopSettingsDivider,
            desktopShellSizingSettingsGroup,
            desktopButtonSliderGroup,
            desktopCompactModeSettingsGroup,
            desktopQuickActionSettingsGroup,
        );
    }

    if (mobileSettingsOutlet instanceof HTMLElement) {
        mobileSettingsOutlet.replaceChildren(
            mobileNavLayoutSettingsGroup,
            mobileSettingsDivider,
            mobileButtonSliderGroup,
            mobileCompactModeSettingsGroup,
            mobileQuickActionSettingsGroup,
        );
    }

    card.append(header, optionRow, frontendIconSettingsGroup, surfaceSliderGroup, bottomBarSliderGroup, topbarLabelSettingsGroup, shortcutSettingsGroup);
    if (!(desktopSettingsOutlet instanceof HTMLElement)) {
        card.append(
            desktopNavLayoutSettingsGroup,
            desktopSettingsDivider,
            desktopShellSizingSettingsGroup,
            desktopButtonSliderGroup,
            desktopCompactModeSettingsGroup,
            desktopQuickActionSettingsGroup,
        );
    }

    if (!(mobileSettingsOutlet instanceof HTMLElement)) {
        card.append(
            mobileNavLayoutSettingsGroup,
            mobileSettingsDivider,
            mobileButtonSliderGroup,
            mobileCompactModeSettingsGroup,
            mobileQuickActionSettingsGroup,
        );
    }
    themeBlock.prepend(card);
    updateThemePickerUi();
}

function updateThemePickerUi() {
    const sliderInput = document.getElementById('sb-surface-transparency-input');
    const sliderValue = document.getElementById('sb-surface-transparency-value');
    const desktopTopbarScaleInput = document.getElementById('sb-topbar-scale-desktop-input');
    const desktopTopbarScaleValue = document.getElementById('sb-topbar-scale-desktop-value');
    const bottomBarScaleInput = document.getElementById('sb-bottom-bar-scale-input');
    const bottomBarScaleValue = document.getElementById('sb-bottom-bar-scale-value');
    const desktopButtonScaleInput = document.getElementById('sb-desktop-button-scale-input');
    const desktopButtonScaleValue = document.getElementById('sb-desktop-button-scale-value');
    const mobileButtonScaleInput = document.getElementById('sb-mobile-button-scale-input');
    const mobileButtonScaleValue = document.getElementById('sb-mobile-button-scale-value');
    const customTextInput = document.getElementById('sb-topbar-custom-text-input');
    const desktopNavIconOnlyInput = document.getElementById('sb-desktop-nav-icon-only-input');
    const desktopNavShowCustomizeInput = document.getElementById('sb-desktop-nav-show-customize-input');
    const desktopNavShowQuickActionsInput = document.getElementById('sb-desktop-nav-show-quick-actions-input');
    const desktopNavReplaceQuickActionsInput = document.getElementById('sb-desktop-nav-replace-quick-actions-input');
    const desktopNavReplacementSelect = document.getElementById('sb-desktop-nav-replacement-select');
    const desktopShellSnapToChatInput = document.getElementById('sb-desktop-shell-snap-to-chat-input');
    const mobileNavIconOnlyInput = document.getElementById('sb-mobile-nav-icon-only-input');
    const mobileNavShowCustomizeInput = document.getElementById('sb-mobile-nav-show-customize-input');
    const mobileNavShowQuickActionsInput = document.getElementById('sb-mobile-nav-show-quick-actions-input');
    const mobileNavReplaceQuickActionsInput = document.getElementById('sb-mobile-nav-replace-quick-actions-input');
    const mobileNavReplacementSelect = document.getElementById('sb-mobile-nav-replacement-select');

    for (const button of document.querySelectorAll('[data-sb-theme-option]')) {
        const themeId = button.getAttribute('data-sb-theme-option');
        const isActive = themeId === sbState.theme;
        button.classList.toggle('is-selected', isActive);
        button.setAttribute('aria-pressed', String(isActive));
    }

    for (const button of document.querySelectorAll('[data-sb-frontend-icon-option]')) {
        const iconId = button.getAttribute('data-sb-frontend-icon-option');
        const isActive = iconId === sbState.frontendIcon;
        button.classList.toggle('is-selected', isActive);
        button.setAttribute('aria-pressed', String(isActive));
    }

    if (sliderInput instanceof HTMLInputElement) {
        sliderInput.min = String(SB_SURFACE_TRANSPARENCY.min);
        sliderInput.max = String(SB_SURFACE_TRANSPARENCY.max);
        sliderInput.step = String(SB_SURFACE_TRANSPARENCY.step);
        sliderInput.value = String(sbState.surfaceTransparency);
    }

    if (sliderValue instanceof HTMLElement) {
        sliderValue.textContent = formatSurfaceTransparency(sbState.surfaceTransparency);
    }

    if (desktopTopbarScaleInput instanceof HTMLInputElement) {
        desktopTopbarScaleInput.value = String(sbState.topbarScale.desktop);
    }

    if (desktopTopbarScaleValue instanceof HTMLElement) {
        desktopTopbarScaleValue.textContent = formatTopbarScale(sbState.topbarScale.desktop);
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

    for (const input of document.querySelectorAll('[data-sb-topbar-label-mode][data-sb-topbar-label-part]')) {
        if (!(input instanceof HTMLInputElement)) {
            continue;
        }

        const mode = input.getAttribute('data-sb-topbar-label-mode');
        const partId = normalizeTopbarLabelPart(input.getAttribute('data-sb-topbar-label-part'));
        const isChecked = mode === 'mobile'
            ? sbState.topbarLabel.mobilePart === partId
            : sbState.topbarLabel.desktopParts.includes(partId);

        input.checked = isChecked;
        input.closest('.sb-topbar-label-option')?.classList.toggle('is-selected', isChecked);
    }

    if (customTextInput instanceof HTMLInputElement && customTextInput.value !== sbState.topbarLabel.customText) {
        customTextInput.value = sbState.topbarLabel.customText;
    }

    for (const input of document.querySelectorAll('[data-sb-compact-mode-input]')) {
        if (!(input instanceof HTMLInputElement)) {
            continue;
        }

        input.checked = sbState.compactMode;
        input.closest('.sb-compact-mode-option')?.classList.toggle('is-selected', sbState.compactMode);
    }

    for (const input of document.querySelectorAll('input[name="sb-desktop-nav-layout"]')) {
        if (!(input instanceof HTMLInputElement)) {
            continue;
        }

        const isChecked = input.value === sbState.desktopNav.layout;
        input.checked = isChecked;
        input.closest('.sb-mobile-nav-choice')?.classList.toggle('is-selected', isChecked);
    }

    for (const input of document.querySelectorAll('input[name="sb-mobile-nav-layout"]')) {
        if (!(input instanceof HTMLInputElement)) {
            continue;
        }

        const isChecked = input.value === sbState.mobileNav.layout;
        input.checked = isChecked;
        input.closest('.sb-mobile-nav-choice')?.classList.toggle('is-selected', isChecked);
    }

    if (desktopNavIconOnlyInput instanceof HTMLInputElement) {
        desktopNavIconOnlyInput.checked = sbState.desktopNav.iconOnly;
        const choice = desktopNavIconOnlyInput.closest('.sb-mobile-nav-choice');
        choice?.classList.toggle('is-selected', sbState.desktopNav.iconOnly);
        choice?.classList.toggle('is-disabled', false);
    }

    if (desktopNavShowCustomizeInput instanceof HTMLInputElement) {
        desktopNavShowCustomizeInput.checked = sbState.desktopNav.showCustomize;
        desktopNavShowCustomizeInput.disabled = false;
        const choice = desktopNavShowCustomizeInput.closest('.sb-mobile-nav-choice');
        const label = choice?.querySelector('.sb-mobile-nav-choice-copy > strong');
        if (label instanceof HTMLElement) {
            label.textContent = getMobileNavCustomizeLocationLabel('desktop');
        }
        choice?.classList.toggle('is-selected', sbState.desktopNav.showCustomize);
        choice?.classList.toggle('is-disabled', false);
    }

    if (desktopNavShowQuickActionsInput instanceof HTMLInputElement) {
        desktopNavShowQuickActionsInput.checked = sbState.desktopNav.showQuickActions;
        desktopNavShowQuickActionsInput.disabled = false;
        const choice = desktopNavShowQuickActionsInput.closest('.sb-mobile-nav-choice');
        choice?.classList.toggle('is-selected', sbState.desktopNav.showQuickActions);
        choice?.classList.toggle('is-disabled', false);
    }

    if (desktopNavReplaceQuickActionsInput instanceof HTMLInputElement) {
        desktopNavReplaceQuickActionsInput.checked = sbState.desktopNav.replaceQuickActions;
        const choice = desktopNavReplaceQuickActionsInput.closest('.sb-mobile-nav-choice');
        choice?.classList.toggle('is-selected', sbState.desktopNav.replaceQuickActions);
    }

    if (desktopNavReplacementSelect instanceof HTMLSelectElement) {
        desktopNavReplacementSelect.value = normalizeMobileNavReplacementTarget(sbState.desktopNav.replacementTarget);
        desktopNavReplacementSelect.disabled = !sbState.desktopNav.replaceQuickActions;
        desktopNavReplacementSelect.closest('.sb-mobile-nav-replacement-field')?.classList.toggle('is-disabled', !sbState.desktopNav.replaceQuickActions);
    }

    if (desktopShellSnapToChatInput instanceof HTMLInputElement) {
        desktopShellSnapToChatInput.checked = sbState.shellSizing.snapToChatWidth;
        const choice = desktopShellSnapToChatInput.closest('.sb-mobile-nav-choice');
        choice?.classList.toggle('is-selected', sbState.shellSizing.snapToChatWidth);
    }

    if (mobileNavIconOnlyInput instanceof HTMLInputElement) {
        mobileNavIconOnlyInput.checked = sbState.mobileNav.iconOnly;
        const choice = mobileNavIconOnlyInput.closest('.sb-mobile-nav-choice');
        choice?.classList.toggle('is-selected', sbState.mobileNav.iconOnly);
        choice?.classList.toggle('is-disabled', false);
    }

    if (mobileNavShowCustomizeInput instanceof HTMLInputElement) {
        mobileNavShowCustomizeInput.checked = sbState.mobileNav.showCustomize;
        mobileNavShowCustomizeInput.disabled = false;
        const choice = mobileNavShowCustomizeInput.closest('.sb-mobile-nav-choice');
        const label = choice?.querySelector('.sb-mobile-nav-choice-copy > strong');
        if (label instanceof HTMLElement) {
            label.textContent = getMobileNavCustomizeLocationLabel();
        }
        choice?.classList.toggle('is-selected', sbState.mobileNav.showCustomize);
        choice?.classList.toggle('is-disabled', false);
    }

    if (mobileNavShowQuickActionsInput instanceof HTMLInputElement) {
        mobileNavShowQuickActionsInput.checked = sbState.mobileNav.showQuickActions;
        mobileNavShowQuickActionsInput.disabled = false;
        const choice = mobileNavShowQuickActionsInput.closest('.sb-mobile-nav-choice');
        choice?.classList.toggle('is-selected', sbState.mobileNav.showQuickActions);
        choice?.classList.toggle('is-disabled', false);
    }

    if (mobileNavReplaceQuickActionsInput instanceof HTMLInputElement) {
        mobileNavReplaceQuickActionsInput.checked = sbState.mobileNav.replaceQuickActions;
        const choice = mobileNavReplaceQuickActionsInput.closest('.sb-mobile-nav-choice');
        choice?.classList.toggle('is-selected', sbState.mobileNav.replaceQuickActions);
    }

    if (mobileNavReplacementSelect instanceof HTMLSelectElement) {
        mobileNavReplacementSelect.value = normalizeMobileNavReplacementTarget(sbState.mobileNav.replacementTarget);
        mobileNavReplacementSelect.disabled = !sbState.mobileNav.replaceQuickActions;
        mobileNavReplacementSelect.closest('.sb-mobile-nav-replacement-field')?.classList.toggle('is-disabled', !sbState.mobileNav.replaceQuickActions);
    }

    for (const button of document.querySelectorAll('[data-sb-message-style]')) {
        const isActive = button.getAttribute('data-sb-message-style') === getCurrentMessageStyle();
        button.classList.toggle('is-selected', isActive);
        button.setAttribute('aria-pressed', String(isActive));
    }
}

function createSearchIndex(tabState, { includeThemeCard = false } = {}) {
    const searchRoot = tabState.searchRoot;
    if (!(searchRoot instanceof HTMLElement)) {
        return [];
    }

    const entries = [];
    const seen = new Set();
    const excludedSelector = includeThemeCard
        ? '.sb-search-result, .sb-legacy-search-hidden, .sb-mobile-quick-actions-group, .sb-desktop-quick-actions-group'
        : '.sb-search-result, .sb-theme-card, .sb-legacy-search-hidden';

    for (const element of searchRoot.querySelectorAll(SB_SEARCH_TARGET_SELECTOR)) {
        if (!(element instanceof HTMLElement)) {
            continue;
        }

        if (element.closest(excludedSelector)) {
            continue;
        }

        const sectionLabel = getSearchSectionLabel(element, tabState.label);
        const searchText = getSearchText(element, sectionLabel);
        const displayText = getSearchDisplayText(element, sectionLabel);
        const dedupeKey = getSearchEntryDedupeKey(tabState, sectionLabel, displayText, { element });

        if (searchText.length < 3 || seen.has(dedupeKey)) {
            continue;
        }

        seen.add(dedupeKey);
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
            action: () => {
                // Activate the persona tab and trigger ST's own persona search
                openCharacterPanelTab('persona');
                window.setTimeout(() => {
                    const searchInput = document.getElementById('persona_search_bar');
                    if (searchInput instanceof HTMLInputElement) {
                        searchInput.value = name;
                        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                }, 80);
            },
        });
    }

    return entries;
}

function getSearchSectionLabel(element, fallback) {
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
            const text = String(toggle.textContent ?? '').replace(/\s+/g, ' ').trim();
            if (text && text !== fallback) return text;
        }
    }

    const preferred = element.closest('.persona_management_global_settings')
        ?? element.closest('.bg-header-row-1')
        ?? element.closest('.bg-header-row-2')
        ?? element.closest('label, h3, h4, h5, strong');

    const text = String(preferred?.textContent ?? fallback).replace(/\s+/g, ' ').trim();
    return text || fallback;
}

function collectGlobalSearchMatches(query) {
    const normalizedQuery = normalizeText(query);

    if (!normalizedQuery) {
        return [];
    }

    const searchTerms = normalizedQuery.split(' ').filter(Boolean);
    const matches = new Map();

    for (const [shellKey, shellState] of Object.entries(sbState.shells)) {
        const shellLabel = getShellConfig(shellKey)?.title || shellKey;

        for (const tabState of shellState.tabs.values()) {
            if (!tabState.searchIndex) {
                tabState.searchIndex = createSearchIndex(tabState);
            }

            const extraEntries = tabState.id === 'persona'
                ? getPersonaSearchEntries(tabState)
                : tabState.id === 'characters'
                    ? getCharacterPanelSearchEntries()
                    : [];

            for (const entry of [...tabState.searchIndex, ...extraEntries]) {
                if (!searchTerms.every(term => entry.searchText.includes(term))) {
                    continue;
                }

                const startsWithQuery = entry.searchText.startsWith(normalizedQuery);
                const exactMatch = entry.searchText === normalizedQuery;
                const match = {
                    ...entry,
                    shellKey,
                    shellLabel,
                    score: Number(exactMatch) * 100 + Number(startsWithQuery) * 10 - entry.displayText.length / 1000,
                };
                const matchKey = [
                    shellKey,
                    entry.dedupeKey || [
                        entry.tabId,
                        normalizeText(entry.sectionLabel),
                        normalizeText(entry.displayText),
                    ].filter(Boolean).join('::'),
                ].filter(Boolean).join('::');
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

    return Array.from(matches.values())
        .sort((left, right) => right.score - left.score)
        .slice(0, SB_UNIVERSAL_SEARCH_RESULT_LIMIT);
}

function getTabSearchEntries(tabState, { includeThemeCard = false } = {}) {
    const searchIndex = includeThemeCard ? createSearchIndex(tabState, { includeThemeCard }) : tabState.searchIndex;

    if (!searchIndex) {
        tabState.searchIndex = createSearchIndex(tabState);
    }

    return [
        ...(searchIndex || tabState.searchIndex),
        ...(tabState.id === 'persona'
            ? getPersonaSearchEntries(tabState)
            : tabState.id === 'characters'
                ? getCharacterPanelSearchEntries()
                : []),
    ];
}

function getMobileQuickActionSearchMatches(query) {
    const normalizedQuery = normalizeText(query);

    if (normalizedQuery.length < 2) {
        return [];
    }

    const searchTerms = normalizedQuery.split(' ').filter(Boolean);
    const matches = new Map();

    for (const [shellKey, shellState] of Object.entries(sbState.shells)) {
        const shellLabel = getShellConfig(shellKey)?.title || shellKey;

        for (const tabState of shellState.tabs.values()) {
            for (const entry of getTabSearchEntries(tabState, { includeThemeCard: true })) {
                if (!searchTerms.every(term => entry.searchText.includes(term))) {
                    continue;
                }

                const match = {
                    ...entry,
                    shellKey,
                    shellLabel,
                    score: Number(entry.searchText.startsWith(normalizedQuery)) * 10 - entry.displayText.length / 1000,
                };
                const matchKey = [
                    shellKey,
                    entry.dedupeKey,
                ].filter(Boolean).join('::');
                const existingMatch = matches.get(matchKey);

                if (!existingMatch || match.score > existingMatch.score) {
                    matches.set(matchKey, match);
                }
            }
        }
    }

    return Array.from(matches.values())
        .sort((left, right) => right.score - left.score)
        .slice(0, SB_UNIVERSAL_SEARCH_RESULT_LIMIT);
}

function findMobileQuickActionMatch(action) {
    const normalizedAction = normalizeMobileQuickAction(action);
    if (!normalizedAction) {
        return null;
    }

    const shellState = getShellState(normalizedAction.shellKey);
    const tabState = shellState?.tabs.get(normalizedAction.tabId);
    if (!tabState) {
        return null;
    }

    const entries = getTabSearchEntries(tabState, { includeThemeCard: true });
    const exactMatch = entries.find(entry => entry.dedupeKey === normalizedAction.dedupeKey);
    const fallbackMatch = exactMatch || entries.find(entry => (
        normalizeText(entry.sectionLabel) === normalizeText(normalizedAction.sectionLabel)
        && normalizeText(entry.displayText) === normalizeText(normalizedAction.displayText)
    ));

    if (!fallbackMatch) {
        return null;
    }

    return {
        ...fallbackMatch,
        shellKey: normalizedAction.shellKey,
        shellLabel: normalizedAction.shellKey === 'characters'
            ? 'Characters'
            : getShellConfig(normalizedAction.shellKey)?.title || normalizedAction.shellKey,
    };
}

function activateMobileQuickAction(action) {
    const match = findMobileQuickActionMatch(action);
    if (!match) {
        if (action.shellKey === 'characters') {
            openCharacterPanelTab(action.tabId);
            return;
        }

        openShell(action.shellKey, action.tabId);
        return;
    }

    if (action.shellKey === 'characters') {
        revealSearchMatch(action.shellKey, match);
        return;
    }

    revealSearchMatch(action.shellKey, match);
}

function activateMobileNavAction(action) {
    const normalizedAction = normalizeMobileQuickAction(action);
    if (!normalizedAction) {
        return;
    }

    if (isMobileViewport()) {
        closeMobileNav();
    }

    if (normalizedAction.type === 'custom') {
        activateMobileQuickAction(normalizedAction);
        return;
    }

    if (normalizedAction.type === 'shell') {
        closeAllDropdowns({ except: normalizedAction.shellKey });
        openShell(normalizedAction.shellKey);
        return;
    }

    if (normalizedAction.shellKey === 'characters') {
        openCharacterPanelTab(normalizedAction.tabId);
        return;
    }

    closeAllDropdowns({ except: normalizedAction.shellKey });
    openShell(normalizedAction.shellKey, normalizedAction.tabId);
}

function renderUniversalSearchResults(query) {
    const searchState = getUniversalSearchState();
    const results = searchState.results;

    if (!(results instanceof HTMLElement)) {
        return;
    }

    results.replaceChildren();
    searchState.activeIndex = -1;
    searchState.input?.removeAttribute('aria-activedescendant');

    if (!searchState.expanded) {
        results.classList.remove('is-visible');
        return;
    }

    const trimmedQuery = String(query ?? '').trim();

    if (!trimmedQuery) {
        renderSearchEmptyState(results, SB_UNIVERSAL_SEARCH_IDLE_TITLE, SB_UNIVERSAL_SEARCH_IDLE_HINT);
        results.classList.add('is-visible');
        return;
    }

    const matches = collectGlobalSearchMatches(trimmedQuery);
    const groupedMatches = new Map();
    for (const match of matches) {
        const groupLabel = `${match.shellLabel} · ${match.tabLabel}`;
        if (!groupedMatches.has(groupLabel)) {
            groupedMatches.set(groupLabel, []);
        }
        groupedMatches.get(groupLabel).push(match);
    }

    for (const [groupLabel, groupMatches] of groupedMatches.entries()) {
        const group = createElement('div', {
            className: 'sb-search-result-group',
            attrs: {
                role: 'group',
                'aria-label': groupLabel,
            },
        });
        group.appendChild(createElement('div', { className: 'sb-search-result-group-label', text: groupLabel }));

        for (const match of groupMatches) {
            const button = createElement('button', {
                className: 'sb-search-result',
                attrs: {
                    type: 'button',
                    role: 'option',
                    id: `sb-search-result-${results.querySelectorAll('.sb-search-result').length}`,
                    'aria-selected': 'false',
                },
            });
            const detailText = normalizeText(match.displayText) === normalizeText(match.sectionLabel)
                ? `Jump straight to this item in ${match.tabLabel}.`
                : match.displayText;
            const sectionDisplay = match.sectionLabel === match.tabLabel
                ? match.displayText || match.tabLabel
                : match.sectionLabel;

            button.appendChild(createElement('strong', { text: sectionDisplay }));

            if (sectionDisplay !== match.displayText) {
                button.appendChild(createElement('span', { text: detailText }));
            }

            button.appendChild(createElement('small', {
                text: typeof match.action === 'function' ? 'Quick action' : 'Jump to setting',
            }));

            button.addEventListener('click', () => {
                clearUniversalSearch({ blur: true });
                revealSearchMatch(match.shellKey, match);
            });

            group.appendChild(button);
        }

        results.appendChild(group);
    }

    if (!results.childElementCount) {
        renderSearchEmptyState(
            results,
            `No matches for "${trimmedQuery}" yet.`,
            SB_UNIVERSAL_SEARCH_EMPTY_HINT,
        );
    }

    results.classList.add('is-visible');
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
            button.scrollIntoView({ block: 'nearest' });
        }
    }

    if (searchState.activeIndex === -1) {
        input?.removeAttribute('aria-activedescendant');
    }
}

function expandHiddenAccordions(target) {
    const hiddenContents = [];
    let current = target.parentElement;

    while (current) {
        if (current.classList.contains('inline-drawer-content') && getComputedStyle(current).display === 'none') {
            hiddenContents.push(current);
        }

        current = current.parentElement;
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

function pulseSearchTarget(target) {
    if (!(target instanceof HTMLElement)) {
        return;
    }
}

function revealSearchMatch(shellKey, match) {
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
                match.element.scrollIntoView({
                    block: 'center',
                    behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
                });
                pulseSearchTarget(match.element);
            }, 40);
        }

        return;
    }

    openShell(shellKey, match.tabId);

    window.setTimeout(() => {
        expandHiddenAccordions(match.element);
        match.element.scrollIntoView({
            block: 'center',
            behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
        });
        pulseSearchTarget(match.element);
    }, 40);
}

function setActiveTab(shellKey, tabId, { focusButton = false } = {}) {
    const shellState = getShellState(shellKey);
    const shellConfig = getShellConfig(shellKey);

    if (shellKey === 'left' && tabId === 'world-info') {
        // SillyBunny: final guard for old code paths that still ask for the
        // removed left-shell World Info route.
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
        const isHiddenRailDuplicate = tabState.button?.classList.contains('sb-shell-tab-mobile-rail-hidden') ?? false;
        tabState.button?.classList.toggle('is-active', isActive);
        tabState.button?.setAttribute('aria-selected', String(isActive));
        tabState.button?.setAttribute('tabindex', isActive && !isHiddenRailDuplicate ? '0' : '-1');
        tabState.panel.classList.toggle('sb-shell-panel-active', isActive);
        tabState.panel.setAttribute('aria-hidden', String(!isActive));
        // Invalidate search index when switching to a tab so stale DOM isn't searched
        if (isActive) tabState.searchIndex = null;
    }

    syncMobileShellRailActionState(shellKey, tabId);

    const activeTab = shellState.tabs.get(tabId);
    shellState.headerTitle.textContent = activeTab.label;
    shellState.headerSubtitle.textContent = activeTab.description ?? '';
    scrollShellTabButtonIntoView(shellState.nav, activeTab.button, { smooth: focusButton });
    shellState.updateNavScrollIndicators?.();

    if (focusButton && isActuallyVisible(activeTab.button)) {
        activeTab.button?.focus();
    } else if (isShellOpen(shellKey)) {
        window.requestAnimationFrame(() => focusShellPanel(shellKey, { force: true }));
    }

    if (previousTab && previousTab.id !== activeTab.id) {
        previousTab.onDeactivate?.();
    }

    activeTab.onActivate?.();
    const shellRoot = document.getElementById(shellConfig.rootPanelId);
    if (shellRoot instanceof HTMLElement && shellRoot.classList.contains('openDrawer')) {
        dispatchShellTabActivated(shellKey, activeTab);
    }
}

function openShell(shellKey, tabId = null) {
    if (shellKey === 'left' && tabId === 'world-info') {
        // SillyBunny: final guard for old code paths that still ask for the
        // removed left-shell World Info route.
        openCharacterPanelTab('world-info');
        return;
    }

    const shellConfig = getShellConfig(shellKey);
    const shellState = getShellState(shellKey);
    const shellRoot = document.getElementById(shellConfig.rootPanelId);

    if (!shellState || !(shellRoot instanceof HTMLElement)) {
        return;
    }

    const shellSurface = getMobileShellSurfaceForShell(shellKey);
    if (shellSurface) {
        applyMobileSurfaceExclusivity(sbMobileShellLifecycle.overlays.resolveExclusiveOpen({
            surface: shellSurface,
            isMobileViewport: isMobileViewport(),
        }));
    } else {
        closeMobileNav();
    }
    rememberShellFocusOrigin(shellKey);

    if (tabId) {
        setActiveTab(shellKey, tabId);
    }

    shellState.lastOpenedAt = performance.now();

    if (isDrawerActuallyOpen(shellRoot)) {
        syncMobileShellDrawerBounds();
        queueMobileShellDrawerBoundsSync();
        syncDesktopShellSizing();
        window.requestAnimationFrame(() => focusShellPanel(shellKey));
        return;
    }

    if (shellRoot.classList.contains('openDrawer')) {
        forceDrawerState(shellRoot, true, shellConfig.hostIconSelector);
        syncMobileShellDrawerBounds();
        queueMobileShellDrawerBoundsSync();
        syncDesktopShellSizing();
        window.requestAnimationFrame(() => focusShellPanel(shellKey));
        return;
    }

    if (!shellRoot.classList.contains('openDrawer')) {
        forceDrawerState(shellRoot, true, shellConfig.hostIconSelector);
        syncMobileShellDrawerBounds();
        queueMobileShellDrawerBoundsSync();
        window.requestAnimationFrame(() => {
            if (!isDrawerActuallyOpen(shellRoot)) {
                forceDrawerState(shellRoot, true, shellConfig.hostIconSelector);
            }
            syncMobileShellDrawerBounds();
            queueMobileShellDrawerBoundsSync();
            syncDesktopShellSizing();
            focusShellPanel(shellKey);
        });
    }
}

function closeShell(shellKey) {
    const shellConfig = getShellConfig(shellKey);
    const shellState = getShellState(shellKey);
    const shellRoot = document.getElementById(shellConfig.rootPanelId);

    if (!(shellRoot instanceof HTMLElement) || !shellRoot.classList.contains('openDrawer')) {
        return;
    }

    shellState?.tabs.get(shellState.activeTabId)?.onDeactivate?.();

    if (!isDrawerActuallyOpen(shellRoot)) {
        forceDrawerState(shellRoot, false, shellConfig.hostIconSelector);
        syncMobileShellDrawerBounds();
        queueMobileShellDrawerBoundsSync();
        requestMobileViewportReset();
        return;
    }

    const shouldRestoreFocus = document.activeElement instanceof HTMLElement && shellRoot.contains(document.activeElement);
    if (shouldRestoreFocus) {
        document.activeElement.blur();
    }

    // Managed shells do not need the legacy drawer toggle close animation.
    forceDrawerState(shellRoot, false, shellConfig.hostIconSelector);
    syncMobileShellDrawerBounds();
    queueMobileShellDrawerBoundsSync();
    requestMobileViewportReset();
    if (shouldRestoreFocus) {
        window.requestAnimationFrame(() => restoreShellFocus(shellKey));
    } else {
        delete shellState?.restoreFocusTarget;
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

    const frame = createElement('div', { className: 'sb-shell-frame' });
    const navWrapper = createElement('div', { className: 'sb-shell-nav-wrapper' });
    const navScrollLeft = createElement('button', {
        className: 'sb-shell-nav-scroll sb-shell-nav-scroll-left',
        attrs: {
            type: 'button',
            'aria-label': `Scroll ${shellConfig.title} sections left`,
        },
    });
    const nav = createElement('nav', {
        className: 'sb-shell-nav',
        attrs: {
            role: 'tablist',
            'aria-label': `${shellConfig.title} sections`,
            'aria-orientation': 'horizontal',
        },
    });
    const navScrollRight = createElement('button', {
        className: 'sb-shell-nav-scroll sb-shell-nav-scroll-right',
        attrs: {
            type: 'button',
            'aria-label': `Scroll ${shellConfig.title} sections right`,
        },
    });
    navScrollLeft.innerHTML = '<i class="fa-solid fa-chevron-left" aria-hidden="true"></i>';
    navScrollRight.innerHTML = '<i class="fa-solid fa-chevron-right" aria-hidden="true"></i>';
    navWrapper.append(navScrollLeft, nav, navScrollRight);

    const scrollNavByPage = direction => {
        const scrollRequest = sbMobileShellLifecycle.nav.resolvePageScroll({
            direction,
            clientWidth: nav.clientWidth,
            prefersReducedMotion: prefersReducedMotion(),
        });

        nav.scrollBy(scrollRequest);
    };

    let navTouchDrag = null;
    let suppressNavClickUntil = 0;

    const clearNavTouchDrag = () => {
        navTouchDrag = null;
    };

    const finishNavTouchDrag = event => {
        const dragEnd = sbMobileShellLifecycle.nav.resolveDragEnd({
            dragState: navTouchDrag,
            nowMs: Date.now(),
        });

        if (dragEnd.suppressClickUntil) {
            suppressNavClickUntil = dragEnd.suppressClickUntil;
        }

        if (dragEnd.shouldStopPropagation) {
            event.stopPropagation();
        }

        navTouchDrag = dragEnd.dragState;
    };

    const beginNavTouchDrag = event => {
        const touch = event.touches?.[0];

        navTouchDrag = sbMobileShellLifecycle.nav.createDragState({
            isMobileViewport: isMobileViewport(),
            touch,
            scrollLeft: nav.scrollLeft,
        });
    };

    const updateNavTouchDrag = event => {
        if (!navTouchDrag) {
            return;
        }

        const dragMove = sbMobileShellLifecycle.nav.resolveDragMove({
            dragState: navTouchDrag,
            touch: event.touches?.[0],
        });
        navTouchDrag = dragMove.dragState;

        if (!navTouchDrag) {
            return;
        }

        if (dragMove.shouldPreventDefault && event.cancelable) {
            event.preventDefault();
        }

        if (dragMove.shouldStopPropagation) {
            event.stopPropagation();
        }

        if (dragMove.nextScrollLeft !== null) {
            nav.scrollLeft = dragMove.nextScrollLeft;
            updateNavScrollIndicators();
        }
    };

    const suppressClickAfterNavDrag = event => {
        if (!sbMobileShellLifecycle.nav.shouldSuppressClick({
            nowMs: Date.now(),
            suppressClickUntil: suppressNavClickUntil,
        })) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
    };

    const updateNavScrollIndicators = () => {
        const { canScrollLeft, canScrollRight } = sbMobileShellLifecycle.nav.resolveScrollIndicators({
            scrollLeft: nav.scrollLeft,
            clientWidth: nav.clientWidth,
            scrollWidth: nav.scrollWidth,
        });

        navWrapper.classList.toggle('sb-can-scroll-left', canScrollLeft);
        navWrapper.classList.toggle('sb-can-scroll-right', canScrollRight);
        navScrollLeft.disabled = !canScrollLeft;
        navScrollRight.disabled = !canScrollRight;
    };

    nav.addEventListener('scroll', updateNavScrollIndicators, { passive: true });
    nav.addEventListener('click', suppressClickAfterNavDrag, true);
    nav.addEventListener('touchstart', beginNavTouchDrag, { passive: true });
    nav.addEventListener('touchmove', updateNavTouchDrag, { passive: false });
    nav.addEventListener('touchend', finishNavTouchDrag, { passive: true });
    nav.addEventListener('touchcancel', clearNavTouchDrag, { passive: true });
    window.addEventListener('resize', updateNavScrollIndicators, { passive: true });
    navScrollLeft.addEventListener('click', () => scrollNavByPage(-1));
    navScrollRight.addEventListener('click', () => scrollNavByPage(1));

    setTimeout(updateNavScrollIndicators, 100);

    const main = createElement('div', { className: 'sb-shell-main' });
    const header = createElement('div', { className: 'sb-shell-header' });
    const closeButton = createElement('button', {
        className: 'sb-shell-close',
        attrs: {
            type: 'button',
            title: `Close ${shellConfig.title}`,
            'aria-label': `Close ${shellConfig.title}`,
        },
    });
    const eyebrow = createElement('div', { className: 'sb-shell-kicker', text: shellConfig.title });
    const title = createElement('h2', { className: 'sb-shell-title', text: shellConfig.baseTab.label, attrs: { tabindex: '-1' } });
    const subtitle = createElement('p', { className: 'sb-shell-subtitle', text: shellConfig.baseTab.description ?? '' });
    const shellDescription = createElement('p', { className: 'sb-shell-description', text: shellConfig.subtitle });
    const panelBody = createElement('div', { className: 'sb-shell-body' });
    const resizeHandle = createElement('div', {
        className: 'sb-shell-resize-handle',
        attrs: {
            title: `Resize ${shellConfig.title}`,
        },
    });

    closeButton.innerHTML = '<i class="fa-solid fa-xmark" aria-hidden="true"></i>';
    closeButton.addEventListener('click', () => closeShell(shellKey));
    shellRoot.addEventListener('keydown', event => {
        if (event.key !== 'Escape') {
            return;
        }

        if (closeFocusedShell()) {
            event.preventDefault();
            event.stopPropagation();
        }
    });
    bindShellResizeHandle(resizeHandle, shellKey);

    header.append(closeButton, eyebrow, title, subtitle, shellDescription);
    main.append(header, panelBody);
    frame.append(navWrapper, main, resizeHandle);
    shellRoot.appendChild(frame);

    const shellState = {
        activeTabId: shellConfig.defaultTabId,
        lastOpenedAt: 0,
        tabs: new Map(),
        nav,
        headerTitle: title,
        headerSubtitle: subtitle,
        root: shellRoot,
        resizeHandle,
        updateNavScrollIndicators,
    };

    sbState.shells[shellKey] = shellState;

    let wasOpen = shellRoot.classList.contains('openDrawer');
    new MutationObserver(() => {
        const isOpen = shellRoot.classList.contains('openDrawer');

        if (isOpen === wasOpen) {
            return;
        }

        wasOpen = isOpen;

        if (isOpen) {
            shellState.lastOpenedAt = performance.now();
            if (isMobileViewport()) {
                closeMobileNav();
            }
            syncDesktopShellSizing();
            const activeTab = shellState.tabs.get(shellState.activeTabId);
            activeTab?.onActivate?.();
            dispatchShellTabActivated(shellKey, activeTab);
            updateNavScrollIndicators();
            window.requestAnimationFrame(() => focusShellPanel(shellKey));
            queueMobileModalStateSync();
            return;
        }

        shellState.tabs.get(shellState.activeTabId)?.onDeactivate?.();
        queueMobileModalStateSync();
    }).observe(shellRoot, { attributes: true, attributeFilter: ['class'] });

    const basePanel = createShellPanel(shellConfig.baseTab);
    basePanel.scroller.appendChild(originalContent);
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

    const leadingEmbeddedTabId = shellKey === 'left' ? 'api' : null;
    const leadingEmbeddedTab = shellConfig.embeddedTabs.find(tab => tab.id === leadingEmbeddedTabId);
    if (leadingEmbeddedTab) {
        registerEmbeddedTab(leadingEmbeddedTab);
    }

    const samplingTab = shellConfig.customTabs.find(tab => tab.id === 'sampling');
    if (samplingTab) {
        const samplingPanel = buildSamplingPanel();
        registerShellTab(shellKey, samplingTab, samplingPanel, samplingPanel.searchRoot);
    }

    for (const embeddedTab of shellConfig.embeddedTabs) {
        if (embeddedTab.id === leadingEmbeddedTabId) {
            continue;
        }

        registerEmbeddedTab(embeddedTab);
    }

    for (const customTab of shellConfig.customTabs) {
        if (customTab.id === 'sampling') {
            continue;
        }

        if (customTab.id === 'agents') {
            const agentPanel = buildInChatAgentsPanel();
            registerShellTab(shellKey, customTab, agentPanel, agentPanel.searchRoot);
            continue;
        }

        if (customTab.id === 'server') {
            const serverPanel = buildServerAdminPanel();
            registerShellTab(shellKey, customTab, serverPanel, serverPanel.searchRoot);
            continue;
        }

        if (customTab.id === 'console-logs') {
            const consoleLogsPanel = buildConsoleLogsPanel();
            registerShellTab(shellKey, customTab, consoleLogsPanel, consoleLogsPanel.searchRoot);
        }
    }

    panelBody.append(...Array.from(shellState.tabs.values()).map(tabState => tabState.panel));

    const storedTabId = migrateLegacyWorldInfoRoute(safeGetItem(shellConfig.storageKey));
    const nextActiveTab = shellState.tabs.has(storedTabId) ? storedTabId : shellConfig.defaultTabId;
    setActiveTab(shellKey, nextActiveTab);

    if (shellKey === 'right') {
        injectThemePicker();
        injectSillyTavernImportCard();
    }
}

function registerShellTab(shellKey, tabConfig, panelBundle, explicitSearchRoot = null) {
    const shellState = getShellState(shellKey);

    if (!shellState) {
        return;
    }

    const button = createElement('button', {
        className: 'sb-shell-tab',
        attrs: {
            type: 'button',
            role: 'tab',
            tabindex: '-1',
            'aria-selected': 'false',
            'aria-label': tabConfig.label,
            title: tabConfig.label,
            'data-sb-tab': tabConfig.id,
        },
    });

    button.innerHTML = `
        <i class="fa-solid ${tabConfig.icon}" aria-hidden="true"></i>
        <span class="sb-shell-tab-copy">
            <strong>${tabConfig.label}</strong>
        </span>
    `;

    button.addEventListener('click', () => {
        setActiveTab(shellKey, tabConfig.id, { focusButton: false });
        openShell(shellKey);
    });

    button.addEventListener('keydown', event => {
        const buttons = Array.from(shellState.nav.querySelectorAll('.sb-shell-tab[data-sb-tab]')).filter(
            item => item instanceof HTMLElement && !item.classList.contains('sb-shell-tab-mobile-rail-hidden'),
        );
        const currentIndex = buttons.indexOf(button);

        if (currentIndex === -1) {
            return;
        }

        const lastIndex = buttons.length - 1;
        let nextIndex = currentIndex;

        if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
            nextIndex = currentIndex === lastIndex ? 0 : currentIndex + 1;
        } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
            nextIndex = currentIndex === 0 ? lastIndex : currentIndex - 1;
        } else if (event.key === 'Home') {
            nextIndex = 0;
        } else if (event.key === 'End') {
            nextIndex = lastIndex;
        } else {
            return;
        }

        event.preventDefault();
        const nextButton = buttons[nextIndex];
        const nextTabId = nextButton?.getAttribute('data-sb-tab');

        if (nextTabId) {
            setActiveTab(shellKey, nextTabId, { focusButton: true });
        }
    });

    shellState.tabs.set(tabConfig.id, {
        ...tabConfig,
        button,
        panel: panelBundle.panel,
        searchRoot: explicitSearchRoot ?? panelBundle.searchRoot ?? panelBundle.scroller,
        searchIndex: null,
        onActivate: panelBundle.onActivate ?? tabConfig.onActivate ?? null,
        onDeactivate: panelBundle.onDeactivate ?? tabConfig.onDeactivate ?? null,
    });
    shellState.nav.appendChild(button);
    shellState.updateNavScrollIndicators?.();
    syncMobileShellRailActions(shellKey);
}

function createMobileShellRailDivider(label) {
    return createElement('div', {
        className: 'sb-shell-rail-divider',
        attrs: {
            role: 'separator',
            'aria-label': label,
        },
    });
}

function createMobileShellRailButton(item, actionHandler, className = '') {
    const action = normalizeMobileQuickAction({
        type: item.type || 'tab',
        shellKey: item.shellKey,
        tabId: item.tabId,
        icon: item.icon,
        label: item.label,
        sectionLabel: item.sectionLabel,
        displayText: item.displayText,
        dedupeKey: item.dedupeKey,
    });

    if (!action) {
        return null;
    }

    const buttonAttrs = {
        type: 'button',
        title: action.label,
        'aria-label': action.label,
        'data-sb-rail-action': getMobileQuickActionKey(action),
        'data-sb-rail-type': action.type,
        'data-sb-rail-shell-key': action.shellKey,
    };

    if (action.tabId) {
        buttonAttrs['data-sb-rail-tab-id'] = action.tabId;
    }

    const button = createElement('button', {
        className: ['sb-shell-tab', 'sb-shell-rail-action', className].filter(Boolean).join(' '),
        attrs: buttonAttrs,
    });
    const icon = createElement('i', {
        className: `fa-solid ${action.icon || SB_MOBILE_QUICK_ACTION_ICON_FALLBACK}`,
        attrs: {
            'aria-hidden': 'true',
        },
    });
    const copy = createElement('span', { className: 'sb-shell-tab-copy' });
    const label = createElement('strong', { text: action.label });

    copy.appendChild(label);
    button.append(icon, copy);
    button.addEventListener('click', () => actionHandler(action));
    return button;
}

function createRailActionGroup(actions, groupLabel, className = '') {
    const railGroup = createElement('div', {
        className: ['sb-shell-rail-group', className].filter(Boolean).join(' '),
        attrs: {
            'aria-label': groupLabel,
        },
    });

    for (const action of actions) {
        const button = createMobileShellRailButton(action, activateMobileNavAction, 'sb-shell-rail-customize-action');
        if (button) {
            railGroup.appendChild(button);
        }
    }

    return railGroup;
}

function getBuiltInRailActionsForShell(shellKey) {
    const shellState = getShellState(shellKey);
    if (!shellState?.tabs) {
        return [];
    }

    const actions = [];
    for (const tabState of shellState.tabs.values()) {
        actions.push({
            type: 'tab',
            shellKey,
            tabId: tabState.id,
            icon: tabState.icon,
            label: tabState.label,
        });
    }
    return actions;
}

function getAllBuiltInRailActionKeys() {
    const actionKeys = new Set();

    for (const [shellKey, shellConfig] of Object.entries(SB_SHELLS)) {
        const tabConfigs = [
            shellConfig.baseTab,
            ...(Array.isArray(shellConfig.embeddedTabs) ? shellConfig.embeddedTabs : []),
            ...(Array.isArray(shellConfig.customTabs) ? shellConfig.customTabs : []),
        ];

        for (const tabConfig of tabConfigs) {
            if (!tabConfig?.id) {
                continue;
            }

            actionKeys.add(getMobileQuickActionKey({
                type: 'tab',
                shellKey,
                tabId: tabConfig.id,
                icon: tabConfig.icon,
                label: tabConfig.label,
            }));
        }
    }

    return actionKeys;
}

function getBuiltInRailLabelForShell(shellKey) {
    return shellKey === 'right' ? 'Customize' : 'Workspace';
}

function syncMobileShellRailActionState(activeShellKey = '', activeTabId = '') {
    document.querySelectorAll('.sb-shell-rail-action[data-sb-rail-shell-key]').forEach(button => {
        if (!(button instanceof HTMLElement)) {
            return;
        }

        const isActive = button.dataset.sbRailShellKey === activeShellKey && button.dataset.sbRailTabId === activeTabId;
        button.classList.toggle('is-active', isActive);
        button.setAttribute('aria-selected', String(isActive));
        if (isActive) {
            button.setAttribute('aria-current', 'page');
        } else {
            button.removeAttribute('aria-current');
        }
    });
}

function syncMobileShellRailTabVisibility(shellState, currentShellKey, hideCustomizeTabs) {
    for (const tabState of shellState.tabs.values()) {
        if (!(tabState.button instanceof HTMLElement)) {
            continue;
        }

        const shouldHide = hideCustomizeTabs;
        const isActive = tabState.id === shellState.activeTabId;
        tabState.button.classList.toggle('sb-shell-tab-mobile-rail-hidden', shouldHide);
        tabState.button.setAttribute('aria-hidden', String(shouldHide));
        tabState.button.setAttribute('tabindex', isActive && !shouldHide ? '0' : '-1');
        tabState.button.toggleAttribute('inert', shouldHide);
    }
}

function syncMobileShellRailActions(shellKey = null) {
    const shellKeys = shellKey ? [shellKey] : ['left', 'right'];
    const railMode = getActiveShellRailMode();
    const navState = getNavState(railMode);
    const hasVerticalRail = navState.layout === 'vertical';
    const railQuickActionState = getQuickActionState(railMode);

    const prevSyncingRail = sbIsSyncingRailActions;
    sbIsSyncingRailActions = true;

    try {
        for (const currentShellKey of shellKeys) {
            const shellState = getShellState(currentShellKey);
            if (!(shellState?.nav instanceof HTMLElement)) {
                continue;
            }

            let shouldHideCustomizeTabs = false;

            const createRailBlock = (position) => createElement('div', {
                className: `sb-shell-rail-shortcuts sb-shell-rail-shortcuts-${position}`,
                attrs: {
                    'aria-hidden': 'false',
                },
            });

            let beforeBlock = null;
            let afterBlock = null;

            if (hasVerticalRail) {
                const builtInRailLabel = getBuiltInRailLabelForShell(currentShellKey);
                const replacementAction = railMode === 'desktop' && navState.replaceQuickActions
                    ? createNavReplacementQuickAction(navState.replacementTarget)
                    : null;
                const railActionPlan = sbMobileShellLifecycle.railModel.resolveActionVisibility({
                    hasVerticalRail,
                    showCustomize: navState.showCustomize,
                    showQuickActions: navState.showQuickActions,
                    builtInActions: getBuiltInRailActionsForShell(currentShellKey),
                    builtInActionKeys: Array.from(getAllBuiltInRailActionKeys()),
                    quickActions: railQuickActionState,
                    replacementAction,
                    builtInGroupLabel: builtInRailLabel,
                });
                shouldHideCustomizeTabs = railActionPlan.shouldHideCustomizeTabs;

                const createQuickActionsGroup = (actions) => {
                    const quickActionsGroup = createElement('div', {
                        className: 'sb-shell-rail-group sb-shell-rail-group-quick-actions',
                        attrs: {
                            'aria-label': 'Quick Actions',
                        },
                    });

                    if (actions.length) {
                        for (const action of actions) {
                            const button = createMobileShellRailButton(action, activateMobileNavAction, 'sb-shell-rail-quick-action');
                            if (button) {
                                quickActionsGroup.appendChild(button);
                            }
                        }
                    } else {
                        quickActionsGroup.appendChild(createElement('div', {
                            className: 'sb-shell-rail-empty',
                            text: 'No Quick Actions',
                        }));
                    }

                    return quickActionsGroup;
                };

                const pendingBefore = createRailBlock('before');

                for (const group of railActionPlan.beforeGroups) {
                    pendingBefore.appendChild(createMobileShellRailDivider(group.label));
                    pendingBefore.appendChild(createRailActionGroup(
                        group.actions,
                        group.label,
                        `sb-shell-rail-group-${group.label.toLowerCase()}`,
                    ));
                }

                if (pendingBefore.children.length > 0) {
                    beforeBlock = pendingBefore;
                }

                if (railActionPlan.afterGroups.length > 0) {
                    const pendingAfter = createRailBlock('after');
                    for (const group of railActionPlan.afterGroups) {
                        pendingAfter.append(
                            createMobileShellRailDivider(group.label),
                            createQuickActionsGroup(group.actions),
                        );
                    }
                    afterBlock = pendingAfter;
                }
            }

            shellState.nav.querySelectorAll('.sb-shell-rail-shortcuts').forEach(element => element.remove());
            syncMobileShellRailTabVisibility(shellState, currentShellKey, shouldHideCustomizeTabs);

            if (beforeBlock) {
                shellState.nav.prepend(beforeBlock);
            }
            if (afterBlock) {
                shellState.nav.appendChild(afterBlock);
            }

            shellState.updateNavScrollIndicators?.();
        }

        const activeShellKey = ['left', 'right'].find(currentShellKey => isShellOpen(currentShellKey)) ?? (shellKeys.length === 1 ? shellKeys[0] : '');
        const activeShellState = activeShellKey ? getShellState(activeShellKey) : null;
        syncMobileShellRailActionState(activeShellKey, activeShellState?.activeTabId ?? '');
    } finally {
        if (!prevSyncingRail) {
            requestAnimationFrame(() => {
                sbIsSyncingRailActions = false;
            });
        } else {
            sbIsSyncingRailActions = prevSyncingRail;
        }
    }
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

    // Collapse sibling inline-drawers when one is opened — prevents nested
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

            // Close it — mirror what ST's handler does
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

function activateMobileNavPageTarget(target) {
    const config = getMobileNavReplacementTargetConfig(target);

    closeMobileNav();

    if (config.shellKey === 'characters') {
        openCharacterPanelTab(config.tabId);
        return;
    }

    if (config.shellKey && config.tabId) {
        openShell(config.shellKey, config.tabId);
    }
}

function updateMobileNavButtonLabel() {
    const button = document.getElementById('sb-hamburger');
    if (!(button instanceof HTMLElement)) {
        return;
    }

    const overlay = document.getElementById('sb-mobile-nav');
    const isOpen = overlay instanceof HTMLElement
        && !overlay.hidden
        && overlay.getAttribute('aria-hidden') === 'false';
    const replacement = getMobileNavReplacementTargetConfig();
    let title = 'Open navigation';

    if (isOpen) {
        title = 'Close navigation';
    } else if (sbState.mobileNav.replaceQuickActions) {
        title = `Open ${replacement.label}`;
    }

    button.title = title;
    button.setAttribute('aria-label', title);
}

function createMobileQuickActionButton(item) {
    const action = normalizeMobileQuickAction(item);
    if (!action) {
        return null;
    }

    const button = createElement('button', {
        className: 'sb-nav-item',
        attrs: {
            type: 'button',
            title: `Open ${action.label}`,
            'aria-label': `Open ${action.label}`,
        },
    });
    const icon = createElement('i', {
        className: `fa-solid ${action.icon || SB_MOBILE_QUICK_ACTION_ICON_FALLBACK}`,
        attrs: {
            'aria-hidden': 'true',
        },
    });
    const label = createElement('span', { text: action.label });

    button.append(icon, label);
    button.addEventListener('click', () => {
        closeMobileNav();

        if (action.type === 'custom') {
            activateMobileQuickAction(action);
        } else if (action.type === 'shell') {
            openShell(action.shellKey);
        } else if (action.shellKey === 'characters') {
            openCharacterPanelTab(action.tabId);
        } else {
            toggleShellPanel(action.shellKey, action.tabId);
        }
    });

    return button;
}

function refreshMobileNavQuickActions() {
    const list = sbState.mobileNav.quickActionContainer
        ?? document.querySelector('#sb-mobile-nav .sb-mobile-quick-action-list');
    if (!(list instanceof HTMLElement)) {
        return;
    }

    sbState.mobileNav.quickActionContainer = list;
    list.replaceChildren();

    if (!sbState.mobileQuickActions.length) {
        list.appendChild(createElement('div', {
            className: 'sb-mobile-quick-action-empty',
            text: 'No mobile Quick Actions selected yet.',
        }));
        return;
    }

    for (const action of sbState.mobileQuickActions) {
        const button = createMobileQuickActionButton(action);
        if (button) {
            list.appendChild(button);
        }
    }
}

function buildMobileNav() {
    if (document.getElementById('sb-mobile-nav')) {
        return;
    }

    const overlay = createElement('div', {
        id: 'sb-mobile-nav',
        attrs: {
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': 'sb-mobile-nav-title',
        },
    });
    const content = createElement('div', { id: 'sb-mobile-nav-content' });
    overlay.hidden = true;
    overlay.setAttribute('aria-hidden', 'true');

    if ('inert' in overlay) {
        overlay.inert = true;
    }

    const sectionBlock = createElement('section', { className: 'sb-mobile-section' });
    const quickActionTitle = createElement('span', { className: 'sb-mobile-section-title', text: 'Quick Actions' });
    const list = createElement('div', { className: 'sb-mobile-section-list sb-mobile-quick-action-list' });

    sectionBlock.classList.add('sb-mobile-quick-action-section');
    sectionBlock.append(quickActionTitle, list);
    content.append(sectionBlock);
    sbState.mobileNav.quickActionContainer = list;
    sbState.mobileNav.quickActionSection = sectionBlock;
    sbState.mobileNav.quickActionDivider = null;
    refreshMobileNavQuickActions();

    const header = createElement('div', { className: 'sb-mobile-panel-header' });
    const closeButton = createElement('button', {
        className: 'sb-mobile-panel-close',
        attrs: {
            type: 'button',
            title: 'Close navigation',
            'aria-label': 'Close navigation',
        },
    });
    const headerCopy = createElement('div', { className: 'sb-mobile-panel-copy' });
    const eyebrow = createElement('div', { className: 'sb-shell-kicker', text: 'Menu' });
    const title = createElement('h2', {
        id: 'sb-mobile-nav-title',
        className: 'sb-shell-title',
        text: 'Navigation',
        attrs: {
            tabindex: '-1',
        },
    });
    closeButton.innerHTML = '<i class="fa-solid fa-xmark" aria-hidden="true"></i>';
    closeButton.addEventListener('click', closeMobileNav);
    headerCopy.append(eyebrow, title);
    header.append(headerCopy, closeButton);
    content.prepend(header);

    overlay.appendChild(content);
    overlay.addEventListener('click', event => {
        if (event.target === overlay) {
            closeMobileNav();
        }
    });
    overlay.addEventListener('keydown', event => {
        if (event.key !== 'Escape') {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        closeMobileNav();
    });

    document.body.appendChild(overlay);
    updateMobileNavButtonLabel();

    // Auto-close mobile nav when clicking on main content areas
    const autoCloseSelectors = [
        '#send_textarea',
        '#send_but',
        '.mes',
        '#chat',
        '.drawer-content',
    ];

    document.addEventListener('click', event => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) {
            return;
        }

        const shouldClose = sbMobileShellLifecycle.nav.shouldAutoClose({
            isNavOpen: overlay.classList.contains('sb-nav-open'),
            isTrusted: event.isTrusted,
            elapsedSinceOpenedMs: performance.now() - sbState.mobileNav.lastOpenedAt,
            isHamburgerTarget: Boolean(target.closest('#sb-hamburger')),
            isInsideNav: Boolean(target.closest('#sb-mobile-nav')),
            isAutoCloseArea: autoCloseSelectors.some(selector => target.matches(selector) || target.closest(selector)),
        });

        if (shouldClose) {
            closeMobileNav();
        }
    }, { passive: false });
}

function setMobileNavOpenState(isOpen) {
    const overlay = ensureMobileNavReady();
    const button = document.getElementById('sb-hamburger');

    if (!(overlay instanceof HTMLElement) || !(button instanceof HTMLElement)) {
        return;
    }

    const wasOpen = !overlay.hidden && overlay.getAttribute('aria-hidden') === 'false';
    const navState = sbMobileShellLifecycle.nav.resolveOpenState({
        requestedOpen: isOpen,
        isMobileViewport: isMobileViewport(),
        wasOpen,
        focusedInside: Boolean(document.activeElement && overlay.contains(document.activeElement)),
    });

    if (navState.shouldRecordOpenedAt) {
        sbState.mobileNav.lastOpenedAt = performance.now();
    }

    overlay.hidden = navState.overlayHidden;
    overlay.classList.toggle('sb-nav-open', navState.shouldOpen);
    overlay.setAttribute('aria-hidden', navState.overlayAriaHidden);

    if ('inert' in overlay) {
        overlay.inert = navState.overlayInert;
    }

    button.classList.toggle('is-open', navState.shouldOpen);
    button.setAttribute('aria-expanded', navState.buttonExpanded);
    button.innerHTML = navState.buttonIcon === 'close'
        ? '<i class="fa-solid fa-xmark" aria-hidden="true"></i>'
        : `<i class="fa-solid ${SB_MOBILE_NAV_CLOSED_ICON}" aria-hidden="true"></i>`;
    updateMobileNavButtonLabel();

    queueMobileModalStateSync();

    if (wasOpen && !navState.shouldOpen) {
        requestMobileViewportReset();
    }

    if (navState.shouldRefreshQuickActions) {
        refreshMobileNavQuickActions();
    }

    if (navState.shouldFocusTitle) {
        window.requestAnimationFrame(() => {
            overlay.querySelector('#sb-mobile-nav-title')?.focus?.({ preventScroll: true });
        });
    } else if (navState.shouldRestoreButtonFocus) {
        button.focus({ preventScroll: true });
    }
}

function toggleMobileNav() {
    const overlay = ensureMobileNavReady();

    if (!(overlay instanceof HTMLElement)) {
        return;
    }

    const isOpen = !overlay.hidden && overlay.getAttribute('aria-hidden') === 'false';
    const toggleIntent = sbMobileShellLifecycle.nav.resolveToggleIntent({
        isMobileViewport: isMobileViewport(),
        isReplacementEnabled: sbState.mobileNav.replaceQuickActions,
        isOpen,
    });

    if (toggleIntent.action === MOBILE_SHELL_NAV_TOGGLE_ACTION.ACTIVATE_PAGE_TARGET) {
        activateMobileNavPageTarget(sbState.mobileNav.replacementTarget);
        return;
    }

    if (toggleIntent.shouldCloseCompetingPanels) {
        applyMobileSurfaceExclusivity(sbMobileShellLifecycle.overlays.resolveExclusiveOpen({
            surface: sbMobileShellLifecycle.overlays.surface.NAV,
            isMobileViewport: isMobileViewport(),
        }));
    }

    setMobileNavOpenState(toggleIntent.action === MOBILE_SHELL_NAV_TOGGLE_ACTION.OPEN_NAV);
}

function closeMobileNav() {
    setMobileNavOpenState(false);
}

function injectCharacterDrawerControls() {
    getCharacterPanel()?.classList.add('sb-character-drawer-root');
    ensureCharacterListToolbarLayout();
    bindCharacterEditorFullscreenToggle();

    const shellCloseButton = document.getElementById('sb_character_shell_close');
    if (shellCloseButton instanceof HTMLButtonElement && shellCloseButton.dataset.sbBound !== 'true') {
        shellCloseButton.dataset.sbBound = 'true';
        shellCloseButton.addEventListener('click', () => closeCharacterPanel());
    }

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

    const importFileAction = document.getElementById('sb_character_import_file_action');
    if (importFileAction instanceof HTMLButtonElement && importFileAction.dataset.sbBound !== 'true') {
        importFileAction.dataset.sbBound = 'true';
        importFileAction.addEventListener('click', () => {
            document.getElementById('character_import_button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
    }

    const importUrlAction = document.getElementById('sb_character_import_url_action');
    if (importUrlAction instanceof HTMLButtonElement && importUrlAction.dataset.sbBound !== 'true') {
        importUrlAction.dataset.sbBound = 'true';
        importUrlAction.addEventListener('click', () => {
            document.getElementById('external_import_button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
    }

    if (document.documentElement.dataset.sbCharacterImportPreserveBound !== 'true') {
        document.documentElement.dataset.sbCharacterImportPreserveBound = 'true';
        document.addEventListener('sillybunny:character-import-tab-preserve', () => {
            window.requestAnimationFrame(preserveCharacterImportTab);
        });
    }

    const emptyBrowseButton = document.getElementById('sb_character_empty_browse');
    if (emptyBrowseButton instanceof HTMLButtonElement && emptyBrowseButton.dataset.sbBound !== 'true') {
        emptyBrowseButton.dataset.sbBound = 'true';
        emptyBrowseButton.addEventListener('click', () => { void showCharacterListView(); });
    }

    const emptyCreateButton = document.getElementById('sb_character_empty_create');
    if (emptyCreateButton instanceof HTMLButtonElement && emptyCreateButton.dataset.sbBound !== 'true') {
        emptyCreateButton.dataset.sbBound = 'true';
        emptyCreateButton.addEventListener('click', () => {
            setCharacterEditorEmptyState(false);
            setCharacterPersonaPanelVisible(false);
            setCharacterImportPanelVisible(false);
            setCharacterWorldInfoPanelVisible(false);
            document.getElementById('rm_button_create')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            syncCharacterShellTabs('editor');
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
        setCharacterEditorFullscreenState(false);
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
    content.style.display = expand ? 'block' : 'none';
}

function getLegacySettingsDrawerStorageKey(drawer) {
    const root = document.getElementById('user-settings-block-content');
    if (!(root instanceof HTMLElement) || !(drawer instanceof HTMLElement) || !root.contains(drawer)) {
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

function queueInlineDrawerPersistenceBind() {
    if (sbInlineDrawerPersistenceQueued) {
        return;
    }

    sbInlineDrawerPersistenceQueued = true;
    window.requestAnimationFrame(() => {
        sbInlineDrawerPersistenceQueued = false;
        bindInlineDrawerPersistence(document.body);
    });
}

function getInlineDrawerPersistenceRoots() {
    return [
        document.getElementById('left-nav-panel'),
        document.getElementById('user-settings-block-content'),
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

    sbInlineDrawerPersistenceObserver = new MutationObserver(() => queueInlineDrawerPersistenceBind());
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
    const syncPlan = sbMobileShellLifecycle.viewportSync.resolveSyncPlan({
        isMobileViewport: isMobileViewport(),
    });
    const stepHandlers = {
        [viewportSyncStep.SYNC_SHELL_VIEWPORT_BOUNDS]: () => syncShellViewportBounds(),
        [viewportSyncStep.SYNC_MOBILE_SHELL_DRAWER_BOUNDS]: () => {
            syncMobileShellDrawerBounds();
        },
        [viewportSyncStep.CLOSE_MOBILE_NAV]: () => closeMobileNav(),
        [viewportSyncStep.CLOSE_MOBILE_CHAT_TOOLS]: () => closeMobileChatTools(),
        [viewportSyncStep.SYNC_MOBILE_SHELL_RAIL_ACTIONS]: () => syncMobileShellRailActions(),
        [viewportSyncStep.SYNC_DESKTOP_SHELL_SIZING]: () => syncDesktopShellSizing(),
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
        const apiDropdownParent = $('#rm_api_block');
        const select2Defaults = {
            dropdownParent: apiDropdownParent.length ? apiDropdownParent : $(document.body),
            minimumResultsForSearch: 0,
        };
        const allSelectors = [...modelSelectors, '.openrouter_quantizations', '.openrouter_providers'];
        for (const selector of allSelectors) {
            const $el = $(selector);
            if ($el.length && $el.data('select2')) {
                try {
                    const config = $el.data('select2').options.options;
                    $el.select2('destroy');
                    $el.select2({ ...select2Defaults, ...config });
                } catch {
                    // Element may not have been initialized yet
                }
            }
        }
    }
}

function injectModelFilterInput($select) {
    if (!$select.length || $select.prev('.sb-model-filter').length) {
        return;
    }

    const input = document.createElement('input');
    input.type = 'search';
    input.className = 'sb-model-filter text_pole';
    input.placeholder = 'Filter models...';

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
        attrs: { type: 'button', title: 'Switch persona' },
    });
    personaBubble.addEventListener('click', (e) => {
        e.stopPropagation();
        togglePersonaPicker();
    });
    updatePersonaBubble(personaBubble);

    const chatSelect = createElement('select', {
        id: 'sb-bottom-chat-select',
        attrs: { title: 'Switch chat' },
    });
    chatSelect.addEventListener('change', () => {
        void openChatById(chatSelect.value);
    });

    const collapseToggleBtn = createBottomChatButton({ icon: 'fa-chevron-up', title: 'Hide chat actions', className: 'sb-bottom-chat-collapse-toggle' }, () => {
        setBottomChatSecondaryOpen(!getBottomChatBarState().secondaryOpen);
    });
    collapseToggleBtn.setAttribute('aria-controls', 'sb-bottom-chat-secondary-row');
    collapseToggleBtn.setAttribute('aria-expanded', 'true');

    const search = createBottomChatSearchField();
    const searchToggleBtn = createBottomChatButton({ icon: 'fa-magnifying-glass', title: 'Search chat', className: 'sb-bottom-chat-search-toggle' }, () => {
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
            'aria-label': 'Chat actions',
        },
    });

    const topBtn = createBottomChatButton({ icon: 'fa-arrow-up', title: 'Go to top of chat' }, scrollCurrentChatToTop);
    const bottomBtn = createBottomChatButton({ icon: 'fa-arrow-down', title: 'Go to bottom of chat' }, scrollCurrentChatToBottom);
    const chatManagerBtn = createBottomChatButton({ icon: 'fa-address-book', title: 'View chat files' }, handleChatManagerClick);
    const newBtn = createBottomChatButton({ icon: 'fa-plus', title: 'New chat' }, handleNewChat);
    const massDeleteBtn = createBottomChatButton({ icon: 'fa-list-check', title: 'Mass delete chats' }, () => { void handleMassDeleteChats(); });
    const autoNameBtn = createBottomChatButton({ icon: 'fa-wand-magic-sparkles', title: 'Ask the LLM to name this chat' }, () => { void handleAutoNameChat(); });
    const renameBtn = createBottomChatButton({ icon: 'fa-pencil', title: 'Rename chat' }, () => { void handleRenameChat(); });
    const deleteBtn = createBottomChatButton({ icon: 'fa-trash', title: 'Delete chat' }, () => { void handleDeleteChat(); });

    navCluster.append(topBtn, bottomBtn);
    managementCluster.append(chatManagerBtn, newBtn, massDeleteBtn, autoNameBtn, renameBtn, searchToggleBtn, deleteBtn);
    secondaryRow.append(managementCluster);
    container.append(personaBubble, chatSelect, search.field, navCluster, collapseToggleBtn, secondaryRow);

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
    });
    syncBottomChatBarSecondaryState();
    syncBottomChatBarSearchState();

    // Defer initial persona bubble update in case user_avatar isn't ready yet
    setTimeout(() => updatePersonaBubble(personaBubble), 100);

    // Close persona picker when clicking outside
    const bottomChatBarState = getBottomChatBarState();
    if (!bottomChatBarState.outsideClickBound) {
        document.addEventListener('click', (e) => {
            const picker = document.getElementById('sb-persona-picker');
            if (picker && !picker.contains(e.target) && e.target !== bottomChatBarState.personaBubble) {
                picker.remove();
            }
        });
        bottomChatBarState.outsideClickBound = true;
    }

    bindBottomChatBarEvents();
    scheduleBottomChatBarRefresh(0);
}

function scheduleBottomChatBarRefresh(delay = 0) {
    window.clearTimeout(sbState.bottomChatBarRefreshTimer || 0);
    sbState.bottomChatBarRefreshTimer = window.setTimeout(() => {
        sbState.bottomChatBarRefreshTimer = 0;
        void refreshBottomChatSelect();
    }, delay);
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
    chatSelect.replaceChildren();

    // Add placeholder option showing the current chat
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = currentChatName || 'No chat selected';
    placeholder.selected = true;
    chatSelect.appendChild(placeholder);

    if (!chatContext.canBrowseChats) {
        return;
    }

    try {
        const chats = await getChatFilesForContext(chatContext);
        const chatNames = chats.map(chat => chat.fileName);

        chatSelect.replaceChildren();

        for (const chat of chats) {
            const chatName = chat.fileName;
            if (!chatName) continue;
            const option = document.createElement('option');
            option.value = chatName;
            option.textContent = formatChatSelectorLabel(chatName, chat.tokenEstimate);
            option.selected = chatName === currentChatName;
            chatSelect.appendChild(option);
        }

        if (!chatNames.includes(currentChatName)) {
            const fallback = document.createElement('option');
            fallback.value = '';
            fallback.textContent = currentChatName || 'No chat selected';
            fallback.selected = true;
            chatSelect.prepend(fallback);
        }

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
const PERSONA_APPENDICES_SELECTIONS_KEY = 'activeAppendices';
const PERSONA_APPENDICES_DEFAULT_SCOPE_KEY = '__default__';

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
            chunks.push(`[${appendix.name}]\n${description}`);
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
    const selectedAvatarId = document.querySelector('#user_avatar_block .avatar-container.selected[data-avatar-id]')?.getAttribute('data-avatar-id')
        ?? '';
    const currentAvatarId = String(context?.userAvatar ?? '').trim()
        || String(selectedAvatarId).trim()
        || '';
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

    const refreshWithContext = () => {
        syncBottomChatBarSecondaryState();
        syncBottomChatBarSearchState();
        scheduleBottomChatBarRefresh(0);
        window.requestAnimationFrame(() => updatePersonaBubble(bottomChatBarState.personaBubble));
        bindBottomChatBarEvents();
    };

    window.addEventListener('pageshow', refreshWithContext, { passive: true });
    window.addEventListener('focus', refreshWithContext, { passive: true });
    window.addEventListener('resize', refreshWithContext, { passive: true });
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

function openPersonaPicker({ focus = true } = {}) {
    const context = getSillyTavernContext();
    if (!context) return;

    const { personas, currentAvatarId } = getCurrentPersonaSelection(context);
    const personaDescriptions = context?.powerUserSettings?.persona_descriptions ?? {};
    const picker = createElement('div', {
        id: 'sb-persona-picker',
        attrs: {
            role: 'dialog',
            'aria-label': 'Switch persona',
        },
    });
    const optionsList = createElement('div', {
        className: 'sb-persona-options',
        attrs: {
            role: 'listbox',
            'aria-label': 'Choose persona',
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
        empty.textContent = 'No personas defined';
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
        positionPersonaPicker(picker, bubble);
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

    existing.remove();
    openPersonaPicker({ focus: false });
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
    const title = createElement('strong', { text: 'Use with Scenario Notes' });
    const manageButton = createElement('button', {
        className: 'sb-persona-picker-manage menu_button menu_button_icon',
        attrs: { type: 'button', title: 'Manage Scenario Notes' },
    });
    manageButton.innerHTML = '<i class="fa-solid fa-pen-to-square fa-fw" aria-hidden="true"></i><span>Manage</span>';
    manageButton.addEventListener('click', openPersonaAppendicesManager);
    header.append(title, manageButton);
    section.appendChild(header);

    if (!appendices.length) {
        const empty = createElement('p', { className: 'sb-persona-picker-appendices-empty', text: 'No Scenario Notes on this persona yet.' });
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

function openPersonaAppendicesManager() {
    closePersonaPicker();
    openCharacterPanelTab('persona');

    window.setTimeout(() => {
        document.getElementById('persona_workspace_tab_edit')?.click();
        document.getElementById('persona_editor_tab_prompt')?.click();
        const appendicesHeading = document.getElementById('persona_appendices_heading');
        const addButton = document.getElementById('persona_appendix_add');
        (appendicesHeading ?? addButton)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        addButton?.focus({ preventScroll: true });
    }, 160);
}

function positionPersonaPicker(picker, bubble) {
    const bubbleRect = bubble.getBoundingClientRect();
    picker.style.visibility = 'hidden';
    picker.style.left = '0px';
    picker.style.top = '0px';
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
            console.warn('[SillyBunny] Persona switch via slash command failed, falling back to DOM selection.', error);
        }
    }

    if (!switched) {
        // Fallback: try clicking the DOM avatar
        const avatarBlock = document.getElementById('user_avatar_block');
        const domAvatar = avatarBlock?.querySelector(`.avatar-container[title="${CSS.escape(avatarId)}"]`);
        if (domAvatar instanceof HTMLElement) {
            domAvatar.click();
        } else {
            openCharacterPanelTab('persona');
        }
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

    restorePersistedTopbarState();
    seedTopbarScaleDefaults();
    hideHostToggles();
    forceDrawerState(leftShellRoot, false, getShellConfig('left').hostIconSelector);
    forceDrawerState(rightShellRoot, false, getShellConfig('right').hostIconSelector);
    buildShell('left');
    buildShell('right');
    buildMobileNav();
    buildMobileChatTools();
    injectCharacterDrawerControls();
    bindCharacterEditorExitButton();
    bindCharacterDrawerStateObserver();
    setShellTheme(sbState.theme, { persist: false });
    setFrontendIconPreference(sbState.frontendIcon, { persist: false });
    setSurfaceTransparency(sbState.surfaceTransparency, { persist: false });
    setCompactMode(sbState.compactMode, { persist: false });
    setDesktopShellSnapToChatWidth(sbState.shellSizing.snapToChatWidth, { persist: false });
    setCharacterDrawerRightLock(sbState.characterDrawer.rightLocked, { persist: false });
    setTopbarScale('desktop', sbState.topbarScale.desktop, { persist: false });
    setTopbarScale('mobile', sbState.topbarScale.mobile, { persist: false });
    setBottomBarScale(sbState.bottomBarScale, { persist: false });
    setDesktopButtonScale(sbState.desktopButtonScale, { persist: false });
    setMobileButtonScale(sbState.mobileButtonScale, { persist: false });
    applyDesktopNavPreferences();
    applyMobileNavPreferences();
    bindComposerControlPlacement();
    initChatAvatarVariables();
    syncDesktopShellSizing();
    buildTopBar();
    bindLandingPageObserver();
    buildBottomChatBar();
    // Refresh again after the current JS task — APP_READY may have already
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
    bindCharacterEditorSubTabs();
    applyDefaultDrawerStates();
    bindInlineDrawerAutoCloseToggle();
    syncMobileViewportState();

    window.addEventListener('resize', syncMobileViewportState, { passive: true });
    window.addEventListener('orientationchange', syncMobileViewportState);
    window.visualViewport?.addEventListener('resize', syncMobileViewportState, { passive: true });
    window.visualViewport?.addEventListener('scroll', syncMobileViewportState, { passive: true });
    window.visualViewport?.addEventListener('resize', syncDesktopShellSizing, { passive: true });
    window.visualViewport?.addEventListener('scroll', syncDesktopShellSizing, { passive: true });

    // SillyBunny: re-sync shell width when the chat width slider changes so settings
    // panels narrow alongside the chat container (matches standard ST behaviour).
    $(document).on('input change mouseup touchend', '#chat_width_slider', () => {
        syncDesktopShellSizing();
    });

    // Reinitialize Select2 widgets after shell reparents DOM elements.
    // Select2 bindings break when elements are moved in the DOM.
    reinitSelect2AfterShell();

    // Group Advanced Formatting sections into collapsible drawers
    groupAdvancedFormattingIntoDrawers();

    const sillyBunnyShell = /** @type {any} */ (globalThis.SillyBunnyShell || {});
    globalThis.SillyBunnyShell = Object.assign(sillyBunnyShell, {
        openTab(shellKey, tabId) {
            if (shellKey === 'characters') {
                openCharacterPanelTab(tabId);
                return;
            }

            if (SB_SHELLS[shellKey]) {
                openShell(shellKey, tabId);
            }
        },
        openCharacters() {
            toggleCharacterPanel();
        },
        closeCharacters() {
            closeCharacterPanel();
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
        applyTheme(themeId) {
            setShellTheme(themeId);
        },
        setFrontendIcon(iconId) {
            setFrontendIconPreference(iconId);
        },
        setSurfaceTransparency(value) {
            setSurfaceTransparency(value);
        },
        setTopbarScale(mode, value) {
            setTopbarScale(mode, value);
        },
        setMobileButtonScale(value) {
            setMobileButtonScale(value);
        },
        setDesktopButtonScale(value) {
            setDesktopButtonScale(value);
        },
        setCompactMode(value) {
            setCompactMode(value);
        },
        setDesktopShellSnapToChatWidth(value) {
            setDesktopShellSnapToChatWidth(value);
        },
        setMessageStyle,
        openChatTools() {
            if (isMobileViewport()) {
                openMobileChatTools();
                return;
            }

            setChatSidebarOpenState(true);
        },
        toggleChatSidebar() {
            toggleChatSidebar();
        },
        toggleMobileChatTools,
        toggleChatbarVisibility() {
            toggleChatbarVisibility();
        },
        resetTopbarPosition() {
            setTopbarOffset({ x: 0, y: 0 });
        },
        getTheme() {
            return sbState.theme;
        },
        getFrontendIcon() {
            return sbState.frontendIcon;
        },
        getSurfaceTransparency() {
            return sbState.surfaceTransparency;
        },
        getTopbarScale(mode) {
            return mode === 'mobile'
                ? sbState.topbarScale.mobile
                : sbState.topbarScale.desktop;
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
