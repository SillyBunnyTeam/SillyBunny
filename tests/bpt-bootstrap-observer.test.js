import { afterAll, describe, expect, jest, test } from '@jest/globals';
import { JSDOM } from 'jsdom';

await jest.unstable_mockModule('../public/script.js', () => ({
    chat_metadata: {},
    eventSource: { on: jest.fn(), emit: jest.fn() },
    event_types: {
        APP_READY: 'app_ready',
        SETTINGS_LOADED_AFTER: 'settings_loaded_after',
        OAI_PRESET_CHANGED_AFTER: 'oai_preset_changed_after',
        CHAT_CHANGED: 'chat_changed',
    },
    getCurrentChatId: jest.fn(() => 'chat.jsonl'),
    saveSettingsDebounced: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/extensions.js', () => ({
    extension_settings: {},
    saveMetadataDebounced: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/backgrounds.js', () => ({ background_settings: {} }));
await jest.unstable_mockModule('../public/scripts/openai.js', () => ({ promptManager: null }));
await jest.unstable_mockModule('../public/scripts/power-user.js', () => ({ power_user: {} }));

const originalGlobals = {
    window: global.window,
    document: global.document,
    HTMLElement: global.HTMLElement,
    MutationObserver: global.MutationObserver,
    requestAnimationFrame: global.requestAnimationFrame,
    cancelAnimationFrame: global.cancelAnimationFrame,
    getComputedStyle: global.getComputedStyle,
};

/** @type {import('jsdom').DOMWindow|null} */
let testWindow = null;

afterAll(() => {
    // Closing the window cancels the extension's pending timers, which would otherwise fire without a document.
    testWindow?.close();
    for (const [name, value] of Object.entries(originalGlobals)) {
        if (value === undefined) delete global[name];
        else global[name] = value;
    }
});

describe('BunnyPresetTools bootstrap observer', () => {
    test('stops observing the document once every container is attached, even when Prompt Manager never renders', async () => {
        const { window } = new JSDOM(`<!doctype html><html><body>
            <div id="bg1"></div>
            <div id="Backgrounds"><div id="bg_menu_content"></div><div id="bg_custom_content"></div></div>
            <div id="completion_prompt_manager"></div>
            <div id="extensions_settings"></div>
        </body></html>`);

        testWindow = window;

        // Records which observers are still connected, so a leftover one on the document is visible.
        const connected = new Set();
        function TrackedMutationObserver(callback) {
            const real = new window.MutationObserver(callback);
            const tracked = {
                target: null,
                observe(target, options) {
                    tracked.target = target;
                    connected.add(tracked);
                    real.observe(target, options);
                },
                disconnect() {
                    connected.delete(tracked);
                    real.disconnect();
                },
                takeRecords: () => real.takeRecords(),
            };
            return tracked;
        }
        Object.assign(global, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement,
            MutationObserver: TrackedMutationObserver,
            requestAnimationFrame: callback => window.setTimeout(callback, 0),
            cancelAnimationFrame: id => window.clearTimeout(id),
            getComputedStyle: element => window.getComputedStyle(element),
        });
        const flush = () => new Promise(resolve => setTimeout(resolve, 20));

        await import('../public/scripts/extensions/third-party/BunnyPresetTools/content.js');
        await flush();

        // The prompt list does not exist, yet nothing may stay connected to the body or the document.
        const wideObservers = [...connected].filter(observer => observer.target === window.document.body || observer.target === window.document.documentElement);
        expect(wideObservers).toHaveLength(0);
        expect(window.document.getElementById('bpt-settings')).not.toBeNull();

        // The observer on the prompt container still enhances the list when Prompt Manager renders it later.
        const list = window.document.createElement('ul');
        list.id = 'completion_prompt_manager_list';
        window.document.getElementById('completion_prompt_manager').append(list);
        await flush();
        expect(window.document.getElementById('bpt-prompt-toolbar')).not.toBeNull();
    });
});
