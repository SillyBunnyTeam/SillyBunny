/* global globalThis */
import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import v8 from 'node:v8';

const pub = relative => fileURLToPath(new URL(`../../public/${relative}`, import.meta.url));
const cachedJQuerySource = readFileSync(pub('lib/jquery-3.5.1.min.js'), 'utf8');

function ensureJsdomGlobals() {
    if (typeof globalThis.structuredClone !== 'function') {
        globalThis.structuredClone = value => v8.deserialize(v8.serialize(value));
    }
}

ensureJsdomGlobals();

function loadJQuery() {
    if (typeof globalThis.window === 'undefined') {
        throw new Error('importExtensionsModule requires a jsdom test environment.');
    }
    if (!globalThis.window.jQuery) {
        (0, eval)(cachedJQuerySource);
    }
    const $ = globalThis.window.jQuery;
    if ($.fx) $.fx.off = true;
    globalThis.$ = $;
    globalThis.jQuery = $;
    globalThis.window.$ = $;
    return $;
}

class HarnessEventEmitter {
    constructor() {
        this.listeners = new Map();
    }

    on(event, fn) {
        if (!this.listeners.has(event)) this.listeners.set(event, new Set());
        this.listeners.get(event).add(fn);
        return this;
    }

    once(event, fn) {
        const wrapped = (...args) => {
            this.removeListener(event, wrapped);
            return fn(...args);
        };
        return this.on(event, wrapped);
    }

    removeListener(event, fn) {
        this.listeners.get(event)?.delete(fn);
        return this;
    }

    async emit(event, ...args) {
        for (const fn of [...(this.listeners.get(event) ?? [])]) {
            await fn(...args);
        }
    }
}

/**
 * Imports the real `public/scripts/extensions.js` inside jsdom with configurable peer mocks.
 * @param {object} [options]
 */
export async function importExtensionsModule(options = {}) {
    jest.resetModules();
    ensureJsdomGlobals();
    const $ = loadJQuery();

    const toastr = {
        clear: jest.fn(),
        error: jest.fn(),
        info: jest.fn(),
        success: jest.fn(),
        warning: jest.fn(),
        ...(options.toastr ?? {}),
    };
    globalThis.toastr = toastr;
    globalThis.window.toastr = toastr;

    const eventSource = options.eventSource ?? new HarnessEventEmitter();
    const event_types = {
        EXTENSIONS_FIRST_LOAD: 'extensions_first_load',
        EXTRAS_CONNECTED: 'extras_connected',
        EXTENSION_SETTINGS_LOADED: 'extension_settings_loaded',
        ...(options.event_types ?? {}),
    };

    const scriptMock = {
        CLIENT_VERSION: options.clientVersion ?? 'SillyBunny:v1.9.0-dev',
        animation_duration: 0,
        eventSource,
        event_types,
        getChatGeneration: jest.fn(() => 0),
        getRequestHeaders: jest.fn(() => ({})),
        saveSettings: jest.fn(async () => {}),
        saveSettingsDebounced: jest.fn(),
        ...(options.script ?? {}),
    };

    const dynamicStylesMock = {
        loadStylesheetAsync: jest.fn(async () => {}),
        prefetchAsset: jest.fn(),
        ...(options.dynamicStyles ?? {}),
    };

    const i18nMock = {
        addLocaleData: jest.fn(),
        getCurrentLocale: jest.fn(() => options.locale ?? 'en'),
        t: jest.fn((strings, ...values) => (
            Array.isArray(strings)
                ? strings.reduce((out, part, index) => out + part + (values[index] ?? ''), '')
                : String(strings ?? '')
        )),
        ...(options.i18n ?? {}),
    };

    const utilsMock = {
        delay: jest.fn(async () => {}),
        deleteValueByPath: jest.fn(),
        equalsIgnoreCaseAndAccents: jest.fn((a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase()),
        escapeHtml: jest.fn(value => String(value ?? '')),
        sanitizeSelector: jest.fn(value => String(value ?? '').replace(/[^a-z0-9_-]/gi, '_')),
        setValueByPath: jest.fn(),
        versionCompare: jest.fn((a, b) => {
            const parseParts = version => String(version ?? '').replace(/^v/i, '').split('.').map(part => Number.parseInt(part, 10) || 0);
            const left = parseParts(a);
            const right = parseParts(b);
            for (let index = 0; index < Math.max(left.length, right.length); index++) {
                const l = left[index] ?? 0;
                const r = right[index] ?? 0;
                if (l !== r) return l >= r;
            }
            return true;
        }),
        ...(options.utils ?? {}),
    };

    const popupResult = { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null };
    const popupType = { CONFIRM: 'confirm', INPUT: 'input', TEXT: 'text' };
    const callGenericPopup = jest.fn(async () => popupResult.AFFIRMATIVE);
    const PopupMock = class Popup {
        static util = { popups: [] };
        static show = { confirm: jest.fn(async () => true) };
        constructor(content) {
            this.content = content?.get?.(0) ?? { querySelector: jest.fn(), scrollTop: 0 };
            this.inputResults = new Map();
        }
        show = jest.fn(async () => null);
        complete = jest.fn(async () => {});
        completeCancelled = jest.fn(async () => {});
    };

    const accountStorage = {
        getItem: jest.fn(() => null),
        setItem: jest.fn(),
    };

    await jest.unstable_mockModule(pub('lib.js'), () => ({
        DOMPurify: { sanitize: jest.fn(value => String(value ?? '')) },
        Popper: { createPopper: jest.fn(() => ({ update: jest.fn() })) },
    }));
    await jest.unstable_mockModule(pub('script.js'), () => scriptMock);
    await jest.unstable_mockModule(pub('scripts/popup.js'), () => ({
        POPUP_RESULT: popupResult,
        POPUP_TYPE: popupType,
        Popup: PopupMock,
        callGenericPopup,
    }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-delete-confirm.js'), () => ({
        confirmVerb: jest.fn(async () => true),
    }));
    await jest.unstable_mockModule(pub('scripts/templates.js'), () => ({
        renderTemplate: jest.fn(() => ''),
        renderTemplateAsync: jest.fn(async () => ''),
    }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-editor/adapters/misc-dialogs.js'), () => ({
        installExtensionOptions: jest.fn(() => ({})),
        switchBranchOptions: jest.fn(() => ({})),
    }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-editor/status-page.js'), () => ({
        setIconBusy: jest.fn(),
        spinnerMarkup: jest.fn(() => ''),
    }));
    if (!options.keepRealUtils) {
        await jest.unstable_mockModule(pub('scripts/utils.js'), () => utilsMock);
    }
    await jest.unstable_mockModule(pub('scripts/user.js'), () => ({
        isAdmin: jest.fn(() => Boolean(options.isAdmin)),
    }));
    await jest.unstable_mockModule(pub('scripts/i18n.js'), () => i18nMock);
    await jest.unstable_mockModule(pub('scripts/constants.js'), () => ({
        debounce_timeout: { relaxed: 1 },
    }));
    await jest.unstable_mockModule(pub('scripts/util/AccountStorage.js'), () => ({ accountStorage }));
    await jest.unstable_mockModule(pub('scripts/util/SimpleMutex.js'), () => ({
        SimpleMutex: class SimpleMutex {},
    }));
    await jest.unstable_mockModule(pub('scripts/dynamic-styles.js'), () => dynamicStylesMock);

    if (options.fetch) {
        globalThis.fetch = options.fetch;
        globalThis.window.fetch = options.fetch;
    }

    const extensions = await import('../../public/scripts/extensions.js');
    return {
        extensions,
        $,
        eventSource,
        event_types,
        mocks: {
            script: scriptMock,
            dynamicStyles: dynamicStylesMock,
            i18n: i18nMock,
            utils: utilsMock,
            toastr,
            accountStorage,
            Popup: PopupMock,
            callGenericPopup,
        },
    };
}
