/* global globalThis */
import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import v8 from 'node:v8';

import { EventEmitter } from '../../public/lib/eventemitter.js';
import { event_types } from '../../public/scripts/events.js';

const pub = relative => fileURLToPath(new URL(`../../public/${relative}`, import.meta.url));
let cachedJQuerySource = null;

const defaultTag = (strings, ...values) => (
    Array.isArray(strings)
        ? strings.reduce((out, part, index) => out + part + (values[index] ?? ''), '')
        : String(strings ?? '')
);

export const DEFAULT_TABS_DOM = `
    <div id="top-bar"></div>
    <div id="sb-settings-page" hidden aria-modal="true" role="dialog" aria-label="Settings">
        <div id="sb-settings-inner">
            <aside id="sb-settings-sidebar" aria-label="Settings Navigation">
                <div id="sb-settings-sidebar-header">
                    <span id="sb-settings-sidebar-title"></span>
                    <button id="sb-settings-search-toggle" type="button" class="sb-settings-search-toggle-btn" aria-label="Search Settings" aria-expanded="false">
                        <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
                    </button>
                    <button id="sb-settings-sidebar-close" type="button" class="sb-settings-close-button sb-settings-sidebar-close" aria-label="Close Settings">
                        <i class="fa-solid fa-xmark" aria-hidden="true"></i>
                    </button>
                </div>
                <div id="sb-settings-search-row" aria-hidden="true">
                    <input id="sb-settings-search-input" type="search" placeholder="Search…" aria-label="Search Settings" autocomplete="off" spellcheck="false">
                </div>
                <nav id="sb-settings-tab-list" role="tablist" aria-orientation="vertical"></nav>
            </aside>
            <div id="sb-settings-content">
                <header id="sb-settings-content-header">
                    <button id="sb-settings-back" type="button" class="sb-settings-back-button" aria-label="Back to Settings Navigation">
                        <i class="fa-solid fa-chevron-left" aria-hidden="true"></i>
                    </button>
                    <div class="sb-settings-header-spacer" aria-hidden="true"></div>
                    <div class="sb-settings-heading">
                        <h2 id="sb-settings-content-title" class="sb-settings-title"></h2>
                        <p id="sb-settings-content-subtitle" class="sb-settings-subtitle"></p>
                    </div>
                    <button id="sb-settings-close" type="button" class="sb-settings-close-button" aria-label="Close Settings">
                        <i class="fa-solid fa-xmark" aria-hidden="true"></i>
                    </button>
                </header>
                <div id="sb-settings-body" class="sb-settings-body">
                    <div id="sb-settings-shell-host"></div>
                </div>
            </div>
        </div>
    </div>
    <div id="top-settings-holder">
        <div id="ai-config-button" class="drawer">
            <div class="drawer-toggle drawer-header">
                <div id="leftNavDrawerIcon" class="drawer-icon closedIcon"></div>
            </div>
            <div id="left-nav-panel" class="drawer-content fillLeft closedDrawer">
                <div class="scrollableInner">
                    <div id="ai_response_configuration">
                        <select id="main_api">
                            <option value="openai">Chat Completion</option>
                            <option value="textgenerationwebui">Text Completion</option>
                            <option value="kobold">KoboldAI Classic</option>
                            <option value="koboldhorde">KoboldAI Horde</option>
                            <option value="novel">NovelAI</option>
                        </select>
                        <div id="respective-presets-block"></div>
                    </div>
                </div>
            </div>
        </div>
        <div id="user-settings-button" class="drawer">
            <div class="drawer-toggle">
                <div class="drawer-icon closedIcon"></div>
            </div>
            <div id="user-settings-block" class="drawer-content closedDrawer">
                <div id="user-settings-block-content">
                    <div id="UI-language-block"></div>
                    <div id="account_controls"></div>
                    <div id="user_stats_controls"></div>
                    <small id="version_display"></small>
                    <div id="user-settings-utility-actions"></div>
                    <div id="user_backup_controls"></div>
                    <div id="settings_snapshots_controls"></div>
                    <div id="UI-Theme-Block">
                        <div id="SillyTavernImportSection" class="inline-drawer"></div>
                        <div id="AppearanceSection" class="inline-drawer">
                            <div class="inline-drawer-toggle inline-drawer-header"><b>Appearance</b></div>
                            <div class="inline-drawer-content">
                                <div id="UI-presets-block">
                                    <select id="themes"><option value="Default">Default</option></select>
                                    <div class="sb-theme-presets"></div>
                                </div>
                            </div>
                        </div>
                        <div id="CustomCSS-block"></div>
                        <div id="GoogleFont-block"></div>
                    </div>
                    <div id="UI-Customization-Block">
                        <div id="CharacterHandlingToggles"></div>
                        <div id="ChatMessageHandlingSection"></div>
                        <div id="smooth_streaming_control"></div>
                        <div id="smooth_streaming_speed_control"></div>
                        <div id="smooth_streaming_no_think_control"></div>
                        <div id="IOSWebKitStreamingToggles"></div>
                        <div id="AndroidStreamingToggles"></div>
                        <div id="AggressiveDomUnloadToggles"></div>
                        <input id="play_message_sound" type="checkbox">
                        <input id="play_sound_unfocused" type="checkbox">
                        <div id="MiscellaneousToggles"></div>
                        <div id="power-user-options-block"></div>
                    </div>
                </div>
            </div>
        </div>
        <div id="extensions-settings-button" class="drawer">
            <div class="drawer-toggle">
                <div class="drawer-icon closedIcon"></div>
            </div>
            <div id="rm_extensions_block" class="drawer-content closedDrawer">
                <div class="extensions_block">
                    <div id="extensions_settings"></div>
                    <div id="extensions_settings2"></div>
                </div>
            </div>
        </div>
        <div id="WI-SP-button" class="drawer">
            <div class="drawer-toggle"><div class="drawer-icon closedIcon"></div></div>
            <div id="WorldInfo" class="drawer-content closedDrawer"></div>
        </div>
        <div id="persona-management-button" class="drawer">
            <div class="drawer-toggle"><div class="drawer-icon closedIcon"></div></div>
            <div id="PersonaManagement" class="drawer-content closedDrawer"></div>
        </div>
        <div id="rightNavHolder" class="drawer">
            <div id="unimportantYes" class="drawer-toggle drawer-header">
                <div id="rightNavDrawerIcon" class="drawer-icon closedIcon"></div>
            </div>
            <nav id="right-nav-panel" class="drawer-content closedDrawer fillRight sb-shell-root" tabindex="-1">
                <div class="sb-character-shell-nav-markers" hidden aria-hidden="true">
                    <div class="sb-shell-nav sb-character-shell-nav" role="tablist">
                        <button id="sb_character_tab_characters" class="sb-shell-tab is-active" type="button" role="tab" aria-selected="true" data-sb-character-tab="characters"></button>
                        <button id="sb_character_tab_groups" class="sb-shell-tab" type="button" role="tab" aria-selected="false" data-sb-character-tab="groups"></button>
                        <button id="sb_character_tab_editor" class="sb-shell-tab" type="button" role="tab" aria-selected="false" data-sb-character-tab="editor"></button>
                        <button id="sb_character_tab_world_info" class="sb-shell-tab" type="button" role="tab" aria-selected="false" data-sb-character-tab="world-info"></button>
                        <button id="sb_character_tab_persona" class="sb-shell-tab" type="button" role="tab" aria-selected="false" data-sb-character-tab="persona"></button>
                        <button id="sb_character_tab_import" class="sb-shell-tab" type="button" role="tab" aria-selected="false" data-sb-character-tab="import"></button>
                    </div>
                </div>
                <div id="rm_PinAndTabs"><div id="right-nav-panel-tabs"></div></div>
                <div id="rm_characters_block" class="right_menu"></div>
                <div id="rm_ch_create_block" class="right_menu"></div>
                <section id="sb_character_persona_panel" hidden></section>
                <section id="sb_character_world_info_panel" hidden></section>
                <section id="sb_character_import_panel" hidden></section>
            </nav>
        </div>
    </div>
    <div id="sheld">
        <div id="chat"></div>
        <form id="send_form">
            <div id="nonQRFormItems">
                <div id="leftSendForm">
                    <div id="options_button"></div>
                </div>
                <textarea id="send_textarea"></textarea>
                <div id="rightSendForm">
                    <div id="send_but"></div>
                    <div id="mes_stop" style="display:none"></div>
                </div>
            </div>
            <div id="sb-bottom-chat-bar"></div>
        </form>
    </div>
    <div id="options" style="display:none"></div>
`;

function ensureJQuery() {
    let $ = globalThis.window?.jQuery || globalThis.$;
    if (typeof $ !== 'function' || !$.fn) {
        cachedJQuerySource ??= readFileSync(pub('lib/jquery-3.5.1.min.js'), 'utf8');
        (0, eval)(cachedJQuerySource);
        $ = globalThis.window?.jQuery || globalThis.$;
    }
    if ($.fx) {
        $.fx.off = true;
    }
    for (const plugin of ['sortable', 'select2', 'transition', 'pagination', 'draggable', 'resizable']) {
        if (!$.fn[plugin]) {
            $.fn[plugin] = jest.fn(function () { return this; });
        }
    }
    $.fn.slideUp = function slideUpSync() { return this.hide(); };
    $.fn.slideDown = function slideDownSync() { return this.show(); };
    globalThis.$ = $;
    globalThis.jQuery = $;
    if (typeof globalThis.window !== 'undefined') {
        globalThis.window.$ = $;
        globalThis.window.jQuery = $;
    }
    return $;
}

function createVisualViewportStub({ width = 1440, height = 900, offsetTop = 0, offsetLeft = 0, scale = 1 } = {}) {
    const listeners = new Map();
    const vv = {
        width,
        height,
        offsetTop,
        offsetLeft,
        pageTop: offsetTop,
        pageLeft: offsetLeft,
        scale,
        addEventListener(type, listener) {
            if (!listeners.has(type)) listeners.set(type, new Set());
            listeners.get(type).add(listener);
        },
        removeEventListener(type, listener) {
            listeners.get(type)?.delete(listener);
        },
        dispatchEvent(event) {
            for (const fn of [...(listeners.get(event.type) ?? [])]) {
                fn.call(vv, event);
            }
            return true;
        },
        _clearListeners() {
            listeners.clear();
        },
    };
    return vv;
}

function evaluateMediaQuery(query, viewportWidth) {
    const maxMatch = /max-width:\s*(\d+)px/i.exec(query);
    if (maxMatch) {
        return viewportWidth <= Number(maxMatch[1]);
    }
    const minMatch = /min-width:\s*(\d+)px/i.exec(query);
    if (minMatch) {
        return viewportWidth >= Number(minMatch[1]);
    }
    if (/prefers-reduced-motion:\s*reduce/i.test(query)) {
        return true;
    }
    return false;
}

/**
 * Imports the real `public/scripts/sillybunny-tabs.js` ESM module in jsdom with
 * mocked heavy peer modules, controlled viewport/visualViewport/storage, and full
 * listener/timer/observer teardown on `cleanup()`.
 *
 * @param {object} [options]
 * @param {string|null} [options.dom] - Full HTML for `document.body`. Pass `null` to keep existing DOM.
 * @param {string} [options.extraDom] - Additional HTML appended to `DEFAULT_TABS_DOM`.
 * @param {boolean} [options.mobile=false] - Start in a mobile viewport (390x844) instead of desktop (1440x900).
 * @param {number} [options.width] - Initial `window.innerWidth`.
 * @param {number} [options.height] - Initial `window.innerHeight`.
 * @param {Record<string, string>|Iterable<[string, string]>|null} [options.storage] - Initial localStorage entries. Pass `null` to leave `localStorage` as-is.
 * @param {object} [options.context] - Extra properties merged onto `SillyTavern.getContext()`.
 * @param {object} [options.assets] - Custom `window.SillyBunnyAssets` object.
 * @param {Iterable<string>} [options.keepReal] - Relative paths under `public/` to keep unmocked.
 * @param {Record<string, object|Function>} [options.mocks] - Per-module mock overrides keyed by path under `public/`.
 * @param {boolean} [options.autoInit=true] - Immediately trigger `initAll()` via `APP_READY`.
 */
export async function importTabsModule(options = {}) {
    jest.resetModules();

    if (typeof globalThis.structuredClone !== 'function') {
        globalThis.structuredClone = value => v8.deserialize(v8.serialize(value));
    }
    if (typeof globalThis.CSS === 'undefined') {
        globalThis.CSS = {
            supports: () => true,
            escape: value => String(value).replace(/([^\w-])/g, '\\$1'),
        };
    }
    if (typeof globalThis.Element !== 'undefined' && typeof globalThis.Element.prototype.getAnimations !== 'function') {
        globalThis.Element.prototype.getAnimations = () => [];
    }
    if (typeof globalThis.Element !== 'undefined' && typeof globalThis.Element.prototype.scrollIntoView !== 'function') {
        globalThis.Element.prototype.scrollIntoView = () => {};
    }

    // Reset root element attributes, classes, and inline styles from any prior test.
    const root = document.documentElement;
    for (const attr of [...root.attributes]) {
        if (attr.name !== 'lang') root.removeAttribute(attr.name);
    }
    root.className = '';
    root.removeAttribute('style');
    document.body.className = '';
    document.body.removeAttribute('style');

    if (options.storage !== null) {
        window.localStorage.clear();
        if (options.storage) {
            const entries = Array.isArray(options.storage) || options.storage instanceof Map
                ? [...options.storage]
                : Object.entries(options.storage);
            for (const [key, value] of entries) {
                window.localStorage.setItem(key, String(value));
            }
        }
    }

    if (options.dom !== null) {
        document.body.innerHTML = options.dom ?? (DEFAULT_TABS_DOM + (options.extraDom ?? ''));
    }

    let viewportWidth = options.width ?? (options.mobile ? 390 : 1440);
    let viewportHeight = options.height ?? (options.mobile ? 844 : 900);
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: viewportWidth });
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: viewportHeight });
    Object.defineProperty(root, 'clientWidth', { configurable: true, get: () => viewportWidth });
    Object.defineProperty(root, 'clientHeight', { configurable: true, get: () => viewportHeight });

    const mediaQueryLists = [];
    const origMatchMedia = window.matchMedia;
    window.matchMedia = query => {
        const listeners = new Set();
        const mql = {
            media: String(query),
            matches: evaluateMediaQuery(String(query), viewportWidth),
            addEventListener(type, fn) { if (type === 'change') listeners.add(fn); },
            removeEventListener(type, fn) { if (type === 'change') listeners.delete(fn); },
            addListener(fn) { listeners.add(fn); },
            removeListener(fn) { listeners.delete(fn); },
            _notify() {
                const next = evaluateMediaQuery(mql.media, viewportWidth);
                if (next !== mql.matches) {
                    mql.matches = next;
                    const evt = { matches: next, media: mql.media };
                    for (const fn of [...listeners]) fn(evt);
                }
            },
        };
        mediaQueryLists.push(mql);
        return mql;
    };

    const visualViewport = createVisualViewportStub({ width: viewportWidth, height: viewportHeight });
    const origVisualViewportDesc = Object.getOwnPropertyDescriptor(window, 'visualViewport');
    Object.defineProperty(window, 'visualViewport', { configurable: true, writable: true, value: visualViewport });

    // Track native listeners, timers, rAFs, MutationObservers, and ResizeObservers for clean teardown.
    const trackedListeners = [];
    const origDocAdd = document.addEventListener.bind(document);
    const origWinAdd = window.addEventListener.bind(window);
    document.addEventListener = function trackedDocAdd(type, listener, listenerOptions) {
        trackedListeners.push([document, type, listener, listenerOptions]);
        return origDocAdd(type, listener, listenerOptions);
    };
    window.addEventListener = function trackedWinAdd(type, listener, listenerOptions) {
        trackedListeners.push([window, type, listener, listenerOptions]);
        return origWinAdd(type, listener, listenerOptions);
    };

    const origSetTimeout = window.setTimeout.bind(window);
    const origClearTimeout = window.clearTimeout.bind(window);
    const origSetInterval = window.setInterval.bind(window);
    const origClearInterval = window.clearInterval.bind(window);
    const origRaf = globalThis.requestAnimationFrame;
    const origCancelRaf = globalThis.cancelAnimationFrame;
    const trackedTimeouts = new Set();
    const trackedIntervals = new Set();

    window.setTimeout = function trackedSetTimeout(fn, delay, ...args) {
        const id = origSetTimeout(() => {
            trackedTimeouts.delete(id);
            if (typeof fn === 'function') fn(...args);
        }, delay);
        trackedTimeouts.add(id);
        return id;
    };
    window.clearTimeout = function trackedClearTimeout(id) {
        trackedTimeouts.delete(id);
        return origClearTimeout(id);
    };
    window.setInterval = function trackedSetInterval(fn, delay, ...args) {
        const id = origSetInterval(fn, delay, ...args);
        trackedIntervals.add(id);
        return id;
    };
    window.clearInterval = function trackedClearInterval(id) {
        trackedIntervals.delete(id);
        return origClearInterval(id);
    };
    globalThis.requestAnimationFrame = callback => {
        callback(0);
        return 0;
    };
    globalThis.cancelAnimationFrame = () => {};
    window.requestAnimationFrame = globalThis.requestAnimationFrame;
    window.cancelAnimationFrame = globalThis.cancelAnimationFrame;

    const trackedMutationObservers = [];
    const OrigMutationObserver = globalThis.MutationObserver;
    globalThis.MutationObserver = class TrackedMutationObserver extends OrigMutationObserver {
        constructor(callback) {
            super(callback);
            trackedMutationObservers.push(this);
        }
    };
    window.MutationObserver = globalThis.MutationObserver;

    const trackedResizeObservers = [];
    const OrigResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class TrackedResizeObserver {
        constructor(callback) {
            this.callback = callback;
            this.observed = new Set();
            trackedResizeObservers.push(this);
        }
        observe(target) { this.observed.add(target); }
        unobserve(target) { this.observed.delete(target); }
        disconnect() { this.observed.clear(); }
    };
    window.ResizeObserver = globalThis.ResizeObserver;

    const $ = ensureJQuery();
    const eventSource = new EventEmitter();
    const storageMap = new Map();
    const accountStorage = {
        init: jest.fn(),
        getState: jest.fn(() => Object.fromEntries(storageMap.entries())),
        getItem: jest.fn(key => (storageMap.has(key) ? storageMap.get(key) : null)),
        setItem: jest.fn((key, value) => storageMap.set(key, String(value))),
        removeItem: jest.fn(key => storageMap.delete(key)),
    };

    const power_user = {
        personas: {},
        persona_descriptions: {},
        default_persona: null,
        markdown_engine: 'showdown',
        fast_ui_mode: false,
        reduced_motion: false,
        compact_input_area: false,
        ...(options.power_user ?? {}),
    };
    const extension_settings = { ...(options.extension_settings ?? {}) };
    const characters = options.characters ? [...options.characters] : [];
    const state = {
        this_chid: options.this_chid,
        mainApi: options.context?.mainApi ?? 'openai',
        power_user,
        extension_settings,
        characters,
        accountStorage,
        storageMap,
    };

    const stContext = {
        eventSource,
        event_types,
        accountStorage,
        powerUserSettings: power_user,
        extensionSettings: extension_settings,
        characters,
        chat: [],
        chatId: null,
        groupId: null,
        groups: [],
        characterId: state.this_chid,
        name1: 'User',
        name2: '',
        mainApi: state.mainApi,
        getRequestHeaders: jest.fn(() => ({ 'Content-Type': 'application/json' })),
        getWorldInfoNames: jest.fn(() => []),
        saveSettingsDebounced: jest.fn(),
        ...(options.context ?? {}),
    };
    globalThis.SillyTavern = { getContext: () => stContext };
    window.SillyTavern = globalThis.SillyTavern;

    const assets = {
        loadStylesheetAsync: jest.fn(async () => {}),
        ...(options.assets ?? {}),
    };
    globalThis.SillyBunnyAssets = assets;
    window.SillyBunnyAssets = assets;

    const toastr = {
        info: jest.fn(),
        success: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        clear: jest.fn(),
        remove: jest.fn(),
    };
    globalThis.toastr = toastr;
    window.toastr = toastr;

    const keepReal = new Set(options.keepReal ?? []);
    const customMocks = options.mocks ?? {};

    const defaultMocks = {
        'script.js': {
            changePanelApiVisibility: jest.fn(),
            characters,
            displayVersion: jest.fn(),
            flushCharacterSaveDebounced: jest.fn(),
            getCurrentChatId: jest.fn(() => stContext.chatId ?? null),
            getOneCharacter: jest.fn(async () => {}),
            getThumbnailUrl: jest.fn((type, file) => `/thumbnail?type=${type}&file=${encodeURIComponent(String(file ?? ''))}`),
            parseAvatarSource: jest.fn(src => {
                if (typeof src !== 'string') return null;
                const match = src.match(/[?&]file=([^&]+)/);
                return match ? { type: 'avatar', file: decodeURIComponent(match[1]) } : null;
            }),
            refreshCsrfToken: jest.fn(async () => ''),
            saveSettingsDebounced: jest.fn(),
            setMenuType: jest.fn(),
            get this_chid() { return state.this_chid; },
        },
        'scripts/events.js': { eventSource, event_types },
        'scripts/power-user.js': { power_user },
        'scripts/extensions.js': { extension_settings, getContext: () => stContext },
        'scripts/util/AccountStorage.js': { accountStorage },
        'scripts/i18n.js': {
            t: defaultTag,
            translate: v => String(v ?? ''),
            addLanguagesToDropdown: jest.fn(),
        },
        'scripts/user.js': {
            isAdmin: jest.fn(() => false),
            syncUserControls: jest.fn(),
        },
        'lib.js': {
            DOMPurify: { sanitize: v => String(v ?? '') },
            Fuse: class { search() { return []; } },
        },
        'scripts/utils.js': {
            flashHighlight: jest.fn(),
            escapeHtml: s => String(s ?? ''),
            clamp: (v, min, max) => Math.min(Math.max(v, min), max),
            debounce: fn => {
                const wrapped = (...args) => fn(...args);
                wrapped.cancel = () => {};
                return wrapped;
            },
            isTrueBoolean: v => v === true || String(v).toLowerCase() === 'true',
            isFalseBoolean: v => v === false || String(v).toLowerCase() === 'false',
        },
        'scripts/openai.js': {
            setSamplingParameterTransmissionState: jest.fn(),
            getSamplingParameterViewModel: jest.fn(() => null),
        },
        'scripts/textgen-settings.js': {
            setTextSamplingParameterTransmissionState: jest.fn(),
            getTextSamplingParameterViewModel: jest.fn(() => null),
            showTGSamplerControls: jest.fn(),
        },
        'scripts/csrf-token-refresh.js': { fetchWithCsrfRetry: jest.fn(async () => ({ ok: true, json: async () => ({}) })) },
        'scripts/sillybunny-install-notice.js': { initInstallNotice: jest.fn() },
        'scripts/mobile-send-button.js': {
            bindIOSFastTapSendButton: jest.fn(),
            isIOSWebKitPlatform: jest.fn(() => false),
            isLegacyIOSWebKitPlatform: jest.fn(() => false),
        },
        'scripts/sillybunny-mobile-bottom-bar.js': {
            initializeMobileBottomBar: jest.fn(),
            syncMobileBottomBar: jest.fn(),
        },
        'scripts/sillybunny-splash-setting.js': {
            createSplashCharacterRow: jest.fn(() => {
                const row = document.createElement('div');
                row.id = 'sb-splash-character-row';
                return { row, sync: jest.fn() };
            }),
        },
        'scripts/sillybunny-message-actions.js': { initializeMessageActions: jest.fn() },
        'scripts/sillybunny-toast-motion.js': {
            TOAST_SHOW_METHOD: 'sbToastIn',
            TOAST_HIDE_METHOD: 'sbToastOut',
            TOAST_LEAVING_CLASS: 'sb-toast-leaving',
            TOAST_HOLD_METHOD: 'sbToastHold',
            TOAST_REPLACE_DURATION: 500,
            TOAST_MAX_WAITING: 6,
            getToastQueue: jest.fn(() => []),
            getNotificationQueue: jest.fn(() => []),
            resetToastQueue: jest.fn(),
            setToastPosition: jest.fn(),
            setNotificationPosition: jest.fn(),
            getNotificationPosition: jest.fn(() => 'toast-top-center'),
            placeToastContainers: jest.fn(),
            initializeToastMotion: jest.fn(),
        },
        'scripts/sillybunny-character-list-state.js': {
            registerCharacterListSortAccessors: jest.fn(),
            registerCharacterListStateRenderer: jest.fn(),
            switchCharacterListView: jest.fn(async () => {}),
            getCharacterListView: jest.fn(() => 'characters'),
            getListSort: jest.fn(() => 'name'),
            setListSort: jest.fn(),
            getListSortOptions: jest.fn(() => []),
            getListPageSize: jest.fn(() => 25),
            setListPageSize: jest.fn(),
            getListPage: jest.fn(() => 1),
            setListPage: jest.fn(),
            recordListPage: jest.fn(),
            resetListPage: jest.fn(),
        },
        'scripts/sillybunny-extension-actions.js': {},
        'scripts/sillybunny-home/greeting-art-boot.js': {},
        'scripts/sillybunny-color-picker.js': { initializeColorPickers: jest.fn() },
        'scripts/sillybunny-action-menu.js': {
            MOBILE_QUERY: '(max-width: 767px)',
            openActionMenu: jest.fn(),
            openPopover: jest.fn(),
            closeActionMenu: jest.fn(),
            isActionMenuOpen: jest.fn(() => false),
            getActionMenuTrigger: jest.fn(() => null),
            positionPopover: jest.fn(() => '0px 0'),
            getRevealScrollTop: jest.fn(() => 0),
        },
        'scripts/sillybunny-preset-autosave.js': {
            createPresetAutosaveToggle: jest.fn(() => document.createElement('div')),
            initializePresetAutosave: jest.fn(),
            refreshPresetProtectionUi: jest.fn(),
        },
        'scripts/sillybunny-editor/side-panel.js': {
            SIDE_PANEL_STYLESHEET: { href: '', id: '' },
            bindActivationHistory: jest.fn(),
            getMenuTriggerFor: jest.fn(() => null),
            computeSidePanelLayout: jest.fn(() => ({})),
            getSheetAnchorTop: jest.fn(() => 0),
            computeSheetGeometry: jest.fn(() => ({})),
            closeTopmostSidePanelOnEscape: jest.fn(() => false),
            configureMovingUIState: jest.fn(),
            registerSidePanel: jest.fn(),
            openSidePanel: jest.fn(async () => {}),
            closeSidePanel: jest.fn(),
            unregisterSidePanel: jest.fn(),
            applyMovingUIState: jest.fn(),
            resetSidePanelSides: jest.fn(),
            isSidePanelElement: jest.fn(() => false),
            refreshSidePanelLayout: jest.fn(),
        },
        'scripts/sillybunny-editor/sheet-gestures.js': {
            bindSheetGestures: jest.fn(() => ({ destroy: jest.fn() })),
            createSheetHandle: jest.fn(() => document.createElement('div')),
            bindSheetSwipeClose: jest.fn(() => ({ destroy: jest.fn() })),
            presentMenuAsSheet: jest.fn(() => ({ destroy: jest.fn() })),
            adoptComposerMenus: jest.fn(),
            adoptLegacyPopup: jest.fn(),
        },
        'scripts/sillybunny-editor/dialog.js': {
            getTopmostDialog: jest.fn(() => null),
            hostOverlayLayer: jest.fn(el => el),
            bindSheetGestures: jest.fn(() => ({ destroy: jest.fn() })),
            createIconButton: jest.fn(() => document.createElement('button')),
            bindHeaderLayout: jest.fn(() => ({ destroy: jest.fn() })),
            bindKeyboardInset: jest.fn(() => ({ destroy: jest.fn() })),
            layoutWithoutTransitions: jest.fn(),
            arrangeResponses: jest.fn(),
            bindWindowHeightLock: jest.fn(() => ({ destroy: jest.fn() })),
            createDialogFrame: jest.fn(() => ({ dialog: document.createElement('dialog') })),
            openDialog: jest.fn(async () => 'cancel'),
            openAlert: jest.fn(async () => 'cancel'),
        },
        'scripts/sillybunny-editor/list-shell.js': {
            LIST_EDITOR_STYLESHEET: { href: '', id: '' },
            EDITOR_CHROME_STYLESHEET: { href: '', id: '' },
            loadEditorChromeStyles: jest.fn(async () => {}),
            loadListEditorStyles: jest.fn(async () => {}),
            holdEditorsUntilStyled: jest.fn(async () => {}),
            isListEditorCollapsed: jest.fn(() => false),
            createListEditor: jest.fn(() => ({ destroy: jest.fn() })),
        },
        'scripts/sillybunny-markdown-engine-row.js': { presentMarkdownEngineRow: jest.fn() },
        'scripts/sillybunny-chat-dialogs.js': { openMassDeleteChatDialog: jest.fn() },
        'scripts/sillybunny-connections-panel.js': {
            createConnectionsPanel: jest.fn(() => ({
                column: document.createElement('div'),
                sync: jest.fn(),
                onActivate: jest.fn(),
            })),
        },
        'scripts/sillybunny-character-list.js': {
            loadCharacterListStyles: jest.fn(async () => {}),
            mountCharacterList: jest.fn(() => ({
                ready: Promise.resolve(),
                setEntityView: jest.fn(),
                onReveal: jest.fn(),
                refresh: jest.fn(),
                revealActiveEntity: jest.fn(async () => {}),
            })),
        },
        'scripts/sillybunny-prompt-editor.js': { initializePromptEditor: jest.fn() },
        'scripts/extensions/in-chat-agents/ui/agent-list.js': {
            mountAgentsPanel: jest.fn(() => ({
                prepareReveal: jest.fn(),
                onReveal: jest.fn(),
                destroy: jest.fn(),
            })),
            getAgentsPanelSearchEntries: jest.fn(() => []),
        },
        'scripts/sillybunny-character-editor.js': { initCharacterEditor: jest.fn() },
        'scripts/sillybunny-temporary-chat.js': { leaveTemporaryChat: jest.fn(async () => {}) },
        'scripts/sillybunny-search-entities.js': {
            collectEntitySearchEntries: jest.fn(() => []),
            primeWorldInfoSearchCache: jest.fn(async () => {}),
        },
        'scripts/sillybunny-help/help-keys.js': { registerHelpKeys: jest.fn() },
        'scripts/sillybunny-home/windows.js': {
            openHelp: jest.fn(),
            openKeyboardShortcuts: jest.fn(),
        },
        'scripts/sillybunny-background-gallery.js': { initBackgroundGallery: jest.fn(async () => {}) },
        'scripts/sillybunny-server-tools.js': {
            createServerTools: jest.fn(() => ({
                buildServerAdminPanel: jest.fn(async () => true),
                buildServerLogsPanel: jest.fn(async () => true),
                refreshServerLogs: jest.fn(async () => {}),
            })),
        },
        'scripts/dynamic-styles.js': {
            loadStylesheetAsync: assets.loadStylesheetAsync,
            initDynamicStyles: jest.fn(),
        },
    };

    const resolvedMocks = {};
    for (const [relativePath, defaultExports] of Object.entries(defaultMocks)) {
        if (keepReal.has(relativePath)) continue;
        const override = customMocks[relativePath];
        const exportsObj = typeof override === 'function'
            ? override(defaultExports)
            : override ? { ...defaultExports, ...override } : defaultExports;
        resolvedMocks[relativePath] = exportsObj;
        await jest.unstable_mockModule(pub(relativePath), () => exportsObj);
    }
    for (const [relativePath, override] of Object.entries(customMocks)) {
        if (relativePath in defaultMocks || keepReal.has(relativePath)) continue;
        const exportsObj = typeof override === 'function' ? override({}) : override;
        resolvedMocks[relativePath] = exportsObj;
        await jest.unstable_mockModule(pub(relativePath), () => exportsObj);
    }

    await import('../../public/scripts/sillybunny-tabs.js');

    if (options.autoInit !== false) {
        await eventSource.emit(event_types.APP_READY);
    }

    function setViewport({ width = viewportWidth, height = viewportHeight, vvWidth = width, vvHeight = height, vvTop = 0, vvLeft = 0 } = {}) {
        viewportWidth = width;
        viewportHeight = height;
        window.innerWidth = width;
        window.innerHeight = height;
        visualViewport.width = vvWidth;
        visualViewport.height = vvHeight;
        visualViewport.offsetTop = vvTop;
        visualViewport.pageTop = vvTop;
        visualViewport.offsetLeft = vvLeft;
        visualViewport.pageLeft = vvLeft;
        for (const mql of mediaQueryLists) {
            mql._notify();
        }
    }

    function triggerResizeObservers(targetFilter = null) {
        for (const ro of trackedResizeObservers) {
            const entries = [...ro.observed]
                .filter(el => !targetFilter || targetFilter(el))
                .map(target => ({ target, contentRect: target.getBoundingClientRect() }));
            if (entries.length) {
                ro.callback(entries, ro);
            }
        }
    }

    async function flush(ticks = 4) {
        for (let i = 0; i < ticks; i++) {
            await new Promise(resolve => origSetTimeout(resolve, 0));
        }
    }

    function cleanup() {
        for (const id of trackedTimeouts) origClearTimeout(id);
        trackedTimeouts.clear();
        for (const id of trackedIntervals) origClearInterval(id);
        trackedIntervals.clear();
        for (const observer of trackedMutationObservers) observer.disconnect();
        trackedMutationObservers.length = 0;
        for (const observer of trackedResizeObservers) observer.disconnect();
        trackedResizeObservers.length = 0;
        for (const [target, type, listener, listenerOptions] of trackedListeners) {
            target.removeEventListener(type, listener, listenerOptions);
        }
        trackedListeners.length = 0;
        visualViewport._clearListeners();

        document.addEventListener = origDocAdd;
        window.addEventListener = origWinAdd;
        window.setTimeout = origSetTimeout;
        window.clearTimeout = origClearTimeout;
        window.setInterval = origSetInterval;
        window.clearInterval = origClearInterval;
        globalThis.requestAnimationFrame = origRaf;
        globalThis.cancelAnimationFrame = origCancelRaf;
        window.requestAnimationFrame = origRaf;
        window.cancelAnimationFrame = origCancelRaf;
        globalThis.MutationObserver = OrigMutationObserver;
        window.MutationObserver = OrigMutationObserver;
        globalThis.ResizeObserver = OrigResizeObserver;
        window.ResizeObserver = OrigResizeObserver;
        window.matchMedia = origMatchMedia;
        if (origVisualViewportDesc) {
            Object.defineProperty(window, 'visualViewport', origVisualViewportDesc);
        } else {
            delete window.visualViewport;
        }

        $(document).off();
        $(window).off();
        delete globalThis.SillyBunnyShell;
        delete window.SillyBunnyShell;
        delete globalThis.SillyTavern;
        delete window.SillyTavern;
        delete globalThis.SillyBunnyAssets;
        delete window.SillyBunnyAssets;

        for (const attr of [...root.attributes]) {
            if (attr.name !== 'lang') root.removeAttribute(attr.name);
        }
        root.className = '';
        root.removeAttribute('style');
        document.body.innerHTML = '';
    }

    return {
        get shell() { return globalThis.SillyBunnyShell; },
        $,
        eventSource,
        event_types,
        stContext,
        assets,
        toastr,
        mocks: resolvedMocks,
        state,
        visualViewport,
        trackedResizeObservers,
        setViewport,
        triggerResizeObservers,
        flush,
        cleanup,
    };
}
