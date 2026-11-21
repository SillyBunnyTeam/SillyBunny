/* global globalThis */
/* eslint-disable playwright/no-standalone-expect -- Jest contracts for a pure check. */
import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';

const noop = () => {};

/** The popups the code under test made, and the button the user presses in them. */
const popups = [];
let popupAnswer = 1;

/** Replaces every module that `extensions.js` imports, so loading it needs no page. */
function mockExtensionsDependencies() {
    jest.unstable_mockModule('../../public/lib.js', () => ({
        DOMPurify: { sanitize: value => String(value ?? '') },
        Popper: { createPopper: () => ({ update: noop }) },
    }));
    jest.unstable_mockModule('../../public/script.js', () => ({
        CLIENT_VERSION: 'SillyBunny:v0.0.0',
        animation_duration: 0,
        eventSource: { emit: async () => {} },
        event_types: {},
        getChatGeneration: () => 0,
        getRequestHeaders: () => ({}),
        saveSettings: async () => {},
        saveSettingsDebounced: noop,
    }));
    jest.unstable_mockModule('../../public/scripts/popup.js', () => ({
        POPUP_RESULT: { AFFIRMATIVE: 1 },
        POPUP_TYPE: { CONFIRM: 2 },
        Popup: class Popup {
            constructor(content, type, inputValue, options) {
                this.shown = { content, type, inputValue, options };
                popups.push(this);
            }

            async show() {
                return popupAnswer;
            }
        },
        callGenericPopup: async () => 1,
    }));
    jest.unstable_mockModule('../../public/scripts/templates.js', () => ({
        renderTemplate: () => '',
        renderTemplateAsync: async () => '',
    }));
    jest.unstable_mockModule('../../public/scripts/sillybunny-editor/adapters/misc-dialogs.js', () => ({
        installExtensionOptions: () => ({}),
        switchBranchOptions: () => ({}),
    }));
    jest.unstable_mockModule('../../public/scripts/utils.js', () => ({
        delay: async () => {},
        deleteValueByPath: noop,
        equalsIgnoreCaseAndAccents: (a, b) => String(a).toLowerCase() === String(b).toLowerCase(),
        // The same escaping as `escapeHtml` of utils.js, which the page loads for real.
        escapeHtml: value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
        sanitizeSelector: value => String(value ?? ''),
        setValueByPath: noop,
        versionCompare: () => true,
    }));
    jest.unstable_mockModule('../../public/scripts/user.js', () => ({ isAdmin: () => false }));
    jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
        addLocaleData: noop,
        getCurrentLocale: () => 'en',
        t: (strings, ...values) => (Array.isArray(strings) ? String.raw({ raw: strings }, ...values) : String(strings ?? '')),
    }));
    jest.unstable_mockModule('../../public/scripts/constants.js', () => ({ debounce_timeout: { relaxed: 1 } }));
    jest.unstable_mockModule('../../public/scripts/util/AccountStorage.js', () => ({ accountStorage: { getItem: () => null, setItem: noop } }));
    jest.unstable_mockModule('../../public/scripts/util/SimpleMutex.js', () => ({ SimpleMutex: class SimpleMutex {} }));
    jest.unstable_mockModule('../../public/scripts/dynamic-styles.js', () => ({ loadStylesheetAsync: async () => {}, prefetchAsset: noop }));
}

let isOfficialExtension;
let confirmAndDeleteExtension;

beforeAll(async () => {
    globalThis.toastr = { error: noop, success: noop };
    globalThis.location = { reload: noop };
    // extensions.js starts a polling interval when it loads, which would keep the test process alive.
    globalThis.setInterval = () => 0;
    globalThis.clearInterval = noop;
    globalThis.document = { getElementById: () => null, querySelector: () => null, body: {} };
    // Any jQuery call on the page's start-up path answers with the same inert chain.
    const inert = new Proxy(function inertChain() { return inert; }, { get: (_, key) => (key === 'length' ? 0 : inert) });
    globalThis.$ = inert;
    mockExtensionsDependencies();
    ({ isOfficialExtension, confirmAndDeleteExtension } = await import('../../public/scripts/extensions.js'));
});

describe('the official extension check', () => {
    test.each([
        'https://github.com/SillyTavern/Extension-Example',
        'https://github.com/SillyBunnyTeam/SillyBunny-Deep-Swipe',
        'https://github.com/sillybunnyteam/SillyBunny-Deep-Swipe',
    ])('treats %s as first party', (url) => {
        expect(isOfficialExtension(url)).toBe(true);
    });

    test.each([
        'https://github.com/platberlitz/sillytavern-character-colors',
        'https://github.com/SillyBunnyTeamImposter/SillyBunny-Deep-Swipe',
        'https://github.com/SillyBunnyTeam',
        'https://github.com.evil.example/SillyBunnyTeam/SillyBunny-Deep-Swipe',
        'https://evil.example/github.com/SillyBunnyTeam/SillyBunny-Deep-Swipe',
        'http://github.com/SillyBunnyTeam/SillyBunny-Deep-Swipe',
        'https://gitlab.com/SillyBunnyTeam/SillyBunny-Deep-Swipe',
        'not a url',
    ])('does not treat %s as first party', (url) => {
        expect(isOfficialExtension(url)).toBe(false);
    });
});

describe('the delete confirm that the Extensions panel and Bundled Extras share', () => {
    const fetchCalls = [];

    beforeEach(() => {
        popups.length = 0;
        popupAnswer = 1;
        fetchCalls.length = 0;
        globalThis.fetch = async (url, init) => {
            fetchCalls.push([url, JSON.parse(init.body)]);
            return { ok: true };
        };
    });

    test('asks once, as a confirm, and deletes the extension when the user agrees', async () => {
        await confirmAndDeleteExtension('SillyBunny-Deep-Swipe');

        expect(popups).toHaveLength(1);
        expect(popups[0].shown.type).toBe(2);
        expect(popups[0].shown.content).toBe('Are you sure you want to delete SillyBunny-Deep-Swipe?');
        expect(fetchCalls).toEqual([['/api/extensions/delete', { extensionName: 'SillyBunny-Deep-Swipe', global: false }]]);
    });

    test('deletes nothing when the user declines', async () => {
        popupAnswer = 0;

        await confirmAndDeleteExtension('SillyBunny-Deep-Swipe');

        expect(popups).toHaveLength(1);
        expect(fetchCalls).toEqual([]);
    });

    test('offers no clean-up checkbox for an extension without a clean hook', async () => {
        await confirmAndDeleteExtension('SillyBunny-Deep-Swipe');

        expect(popups[0].shown.options.customInputs).toEqual([]);
    });

    test('escapes the name, so a name with HTML reaches the popup as text', async () => {
        await confirmAndDeleteExtension('<img src=x onerror=alert(1)>');

        expect(popups[0].shown.content).not.toContain('<');
        expect(popups[0].shown.content).toContain('&lt;img src=x onerror=alert(1)&gt;');
    });
});
