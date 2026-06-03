/* global globalThis */
import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { readFile } from 'node:fs/promises';

function createJqueryMock(value = '') {
    const api = {
        addClass: jest.fn(() => api),
        append: jest.fn(() => api),
        attr: jest.fn(() => api),
        children: jest.fn(() => api),
        css: jest.fn(() => ''),
        each: jest.fn(() => api),
        empty: jest.fn(() => api),
        fadeOut: jest.fn((_, callback) => {
            if (typeof callback === 'function') callback();
            return api;
        }),
        filter: jest.fn(() => api),
        find: jest.fn(() => api),
        first: jest.fn(() => api),
        html: jest.fn(() => api),
        length: 0,
        off: jest.fn(() => api),
        on: jest.fn(() => api),
        parent: jest.fn(() => api),
        prop: jest.fn(() => api),
        remove: jest.fn(() => api),
        slideToggle: jest.fn(() => api),
        text: jest.fn(() => api),
        toggle: jest.fn(() => api),
        toggleClass: jest.fn(() => api),
        transition: jest.fn(() => api),
        trigger: jest.fn(() => api),
        val: jest.fn((nextValue) => nextValue === undefined ? value : api),
    };

    return api;
}

function installExtensionModuleMocks() {
    jest.unstable_mockModule('../public/lib.js', () => ({
        DOMPurify: { sanitize: jest.fn(value => String(value ?? '')) },
        Popper: { createPopper: jest.fn(() => ({ update: jest.fn() })) },
    }));

    jest.unstable_mockModule('../public/script.js', () => ({
        CLIENT_VERSION: 'SillyBunny:v1.6.3',
        animation_duration: 0,
        eventSource: { emit: jest.fn(async () => {}) },
        event_types: { EXTENSIONS_FIRST_LOAD: 'extensions_first_load', EXTRAS_CONNECTED: 'extras_connected', EXTENSION_SETTINGS_LOADED: 'extension_settings_loaded' },
        getRequestHeaders: jest.fn(() => ({})),
        saveSettings: jest.fn(async () => {}),
        saveSettingsDebounced: jest.fn(),
    }));

    jest.unstable_mockModule('../public/scripts/popup.js', () => ({
        POPUP_RESULT: { AFFIRMATIVE: 1 },
        POPUP_TYPE: { CONFIRM: 'confirm', INPUT: 'input', TEXT: 'text' },
        Popup: class Popup {
            static util = { popups: [] };
            static show = { confirm: jest.fn(async () => true) };
            constructor(content) {
                this.content = content?.get?.(0) ?? { querySelector: jest.fn(), scrollTop: 0 };
                this.inputResults = new Map();
            }
            show = jest.fn(async () => null);
            complete = jest.fn(async () => {});
            completeCancelled = jest.fn(async () => {});
        },
        callGenericPopup: jest.fn(async () => 1),
    }));

    jest.unstable_mockModule('../public/scripts/templates.js', () => ({
        renderTemplate: jest.fn(() => ''),
        renderTemplateAsync: jest.fn(async () => ''),
    }));

    jest.unstable_mockModule('../public/scripts/utils.js', () => ({
        delay: jest.fn(async () => {}),
        deleteValueByPath: jest.fn(),
        equalsIgnoreCaseAndAccents: jest.fn((a, b) => String(a).toLowerCase() === String(b).toLowerCase()),
        escapeHtml: jest.fn(value => String(value ?? '')),
        isSubsetOf: jest.fn((values, required) => required.every(value => values.includes(value))),
        sanitizeSelector: jest.fn(value => String(value ?? '').replace(/[^a-z0-9_-]/gi, '_')),
        setValueByPath: jest.fn(),
        versionCompare: jest.fn(() => true),
    }));

    jest.unstable_mockModule('../public/scripts/user.js', () => ({
        isAdmin: jest.fn(() => false),
    }));

    jest.unstable_mockModule('../public/scripts/i18n.js', () => ({
        addLocaleData: jest.fn(),
        getCurrentLocale: jest.fn(() => 'en'),
        t: jest.fn(strings => Array.isArray(strings) ? strings.join('') : String(strings ?? '')),
    }));

    jest.unstable_mockModule('../public/scripts/constants.js', () => ({
        debounce_timeout: { relaxed: 1 },
    }));

    jest.unstable_mockModule('../public/scripts/util/AccountStorage.js', () => ({
        accountStorage: { getItem: jest.fn(() => null), setItem: jest.fn() },
    }));

    jest.unstable_mockModule('../public/scripts/util/SimpleMutex.js', () => ({
        SimpleMutex: class SimpleMutex {},
    }));

    jest.unstable_mockModule('../public/scripts/dynamic-styles.js', () => ({
        loadStylesheetAsync: jest.fn(async () => {}),
        prefetchAsset: jest.fn(),
    }));
}

describe('disabled extensions', () => {
    beforeEach(() => {
        jest.resetModules();
        globalThis.toastr = { clear: jest.fn(), error: jest.fn(), info: jest.fn(), success: jest.fn(), warning: jest.fn() };
        globalThis.$ = jest.fn(() => createJqueryMock());
        globalThis.setInterval = jest.fn(() => 0);
        globalThis.clearInterval = jest.fn();
        globalThis.window = {
            setTimeout: jest.fn((callback) => {
                if (typeof callback === 'function') callback();
                return 0;
            }),
            clearTimeout: jest.fn(),
        };
        globalThis.navigator = { connection: {} };
        globalThis.location = { reload: jest.fn() };
        globalThis.document = {
            body: { appendChild: jest.fn() },
            createElement: jest.fn(() => ({ addEventListener: jest.fn(), append: jest.fn(), classList: { add: jest.fn(), remove: jest.fn() }, style: {}, dataset: {} })),
            getElementById: jest.fn(() => null),
            querySelector: jest.fn(() => null),
        };
    });

    test('does not run generate interceptors for disabled extensions', async () => {
        installExtensionModuleMocks();

        globalThis.fetch = jest.fn(async (url) => {
            const text = String(url);
            if (text.endsWith('/api/extensions/discover')) {
                return { ok: true, json: async () => [{ name: 'vectors', type: 'system' }] };
            }
            if (text.includes('/scripts/extensions/vectors/manifest.json')) {
                return { ok: true, json: async () => ({ display_name: 'Vector Storage', loading_order: 100, generate_interceptor: 'vectors_rearrangeChat' }) };
            }
            return { ok: false, json: async () => ({}) };
        });

        const { loadExtensionSettings, runGenerationInterceptors } = await import('../public/scripts/extensions.js');
        await loadExtensionSettings({ extension_settings: { disabledExtensions: ['vectors'] } }, false, false);

        globalThis.vectors_rearrangeChat = jest.fn();
        await runGenerationInterceptors([], 4096, 'normal');

        expect(globalThis.vectors_rearrangeChat).not.toHaveBeenCalled();
    });

    test('Summarize exposes a disable hook that clears the memory prompt', async () => {
        const manifest = JSON.parse(await readFile(new URL('../public/scripts/extensions/memory/manifest.json', import.meta.url), 'utf8'));
        const source = await readFile(new URL('../public/scripts/extensions/memory/index.js', import.meta.url), 'utf8');

        expect(manifest.hooks.disable).toBe('deactivate');
        expect(source).toContain('export function deactivate()');
        expect(source).toContain('setExtensionPrompt(MODULE_NAME, \'\',');
    });
});
