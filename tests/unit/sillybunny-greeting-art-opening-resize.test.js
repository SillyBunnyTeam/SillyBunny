/** @jest-environment jsdom */
/* global globalThis */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { fileURLToPath } from 'node:url';

const pub = relative => fileURLToPath(new URL(`../../public/${relative}`, import.meta.url));
const OriginalResizeObserver = globalThis.ResizeObserver;
const OriginalCSS = globalThis.CSS;

afterEach(() => {
    jest.useRealTimers();
    document.body.innerHTML = '';
    globalThis.ResizeObserver = OriginalResizeObserver;
    globalThis.CSS = OriginalCSS;
    if (typeof window !== 'undefined' && window.jQuery) {
        window.jQuery(document).off();
    }
    jest.restoreAllMocks();
});

describe('RossAscends-mods chat resize compensation with greeting opening hold', () => {
    test('skips scrollTop compensation when greeting-art-opening hold is active, and applies it after release', async () => {
        jest.resetModules();
        document.body.innerHTML = `
            <div id="chat"></div>
            <textarea id="send_textarea"></textarea>
            <div id="form_sheld"></div>
            <div id="sheld"></div>
        `;

        if (!window.jQuery) {
            await import('../../public/lib/jquery-3.5.1.min.js');
        }
        const $ = window.jQuery;
        globalThis.$ = $;
        globalThis.jQuery = $;
        globalThis.CSS = { supports: () => true, escape: value => String(value) };
        if (typeof window.matchMedia !== 'function') {
            window.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
        }

        const chatEl = document.getElementById('chat');
        let height = 500;
        let scrollTop = 0;
        Object.defineProperties(chatEl, {
            offsetHeight: { configurable: true, get: () => height },
            clientHeight: { configurable: true, get: () => height },
            scrollHeight: { configurable: true, get: () => 2000 },
            scrollTop: { configurable: true, get: () => scrollTop, set: value => { scrollTop = value; } },
        });

        const observers = [];
        globalThis.ResizeObserver = class MockResizeObserver {
            constructor(callback) {
                this.callback = callback;
                this.targets = [];
                observers.push(this);
            }
            observe(target) { this.targets.push(target); }
            unobserve() {}
            disconnect() {}
            trigger() {
                this.callback(this.targets.map(target => ({ target })));
            }
        };

        await jest.unstable_mockModule(pub('lib.js'), () => ({
            DOMPurify: { sanitize: v => v },
            Bowser: { getParser: () => ({ getPlatformType: () => 'desktop', getOSName: () => 'Windows', getBrowserName: () => 'Chrome' }) },
        }));
        await jest.unstable_mockModule(pub('script.js'), () => ({
            characters: [],
            online_status: 'connected',
            main_api: 'openai',
            is_send_press: false,
            max_context: 4096,
            saveSettingsDebounced: jest.fn(),
            active_group: null,
            active_character: null,
            setActiveGroup: jest.fn(),
            setActiveCharacter: jest.fn(),
            getEntitiesList: jest.fn(() => []),
            buildAvatarList: jest.fn(),
            selectCharacterById: jest.fn(),
            eventSource: { on: jest.fn(), emit: jest.fn() },
            menu_type: '',
            substituteParams: v => v,
            sendTextareaMessage: jest.fn(),
            doNavbarIconClick: jest.fn(),
            isSwipingAllowed: jest.fn(() => true),
        }));
        await jest.unstable_mockModule(pub('scripts/power-user.js'), () => ({
            power_user: { fast_ui_mode: false, send_on_enter: 0, hotswap_enabled: false },
            send_on_enter_options: { DISABLED: -1, AUTO: 0, ENABLED: 1 },
        }));
        await jest.unstable_mockModule(pub('scripts/group-chats.js'), () => ({
            selected_group: null,
            is_group_generating: false,
            openGroupById: jest.fn(),
        }));
        await jest.unstable_mockModule(pub('scripts/tags.js'), () => ({
            getTagKeyForEntity: jest.fn(),
            applyTagsOnCharacterSelect: jest.fn(),
        }));
        await jest.unstable_mockModule(pub('scripts/secrets.js'), () => ({
            SECRET_KEYS: {},
            secret_state: {},
        }));
        await jest.unstable_mockModule(pub('scripts/utils.js'), () => ({
            debounce: fn => fn,
            getStringHash: v => String(v ?? ''),
            isValidUrl: () => true,
        }));
        await jest.unstable_mockModule(pub('scripts/openai.js'), () => ({
            chat_completion_sources: {},
            oai_settings: {},
            POLLINATIONS_ENDPOINT: {},
        }));
        await jest.unstable_mockModule(pub('scripts/tokenizers.js'), () => ({
            getTokenCountAsync: jest.fn(async () => 0),
        }));
        await jest.unstable_mockModule(pub('scripts/textgen-settings.js'), () => ({
            textgen_types: {},
            textgenerationwebui_settings: {},
            getTextGenServer: jest.fn(() => ''),
        }));
        await jest.unstable_mockModule(pub('scripts/constants.js'), () => ({
            debounce_timeout: { short: 1, relaxed: 1 },
            SWIPE_SOURCE: {},
        }));
        await jest.unstable_mockModule(pub('scripts/popup.js'), () => ({
            Popup: { show: { confirm: jest.fn(async () => 0) } },
        }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-delete-confirm.js'), () => ({
            confirmVerb: jest.fn(() => ({})),
        }));
        await jest.unstable_mockModule(pub('scripts/i18n.js'), () => ({
            t: (strings, ...values) => strings.reduce((out, part, idx) => out + part + (values[idx] ?? ''), ''),
        }));
        await jest.unstable_mockModule(pub('scripts/util/AccountStorage.js'), () => ({
            accountStorage: { getItem: jest.fn(() => null), setItem: jest.fn(), removeItem: jest.fn() },
        }));
        await jest.unstable_mockModule(pub('scripts/user.js'), () => ({
            getCurrentUserHandle: jest.fn(() => 'default'),
        }));
        await jest.unstable_mockModule(pub('scripts/kai-settings.js'), () => ({
            kai_settings: {},
        }));

        const { createOpeningHold } = await import('../../public/scripts/sillybunny-home/greeting-art-opening.js');
        const { initRossMods } = await import('../../public/scripts/RossAscends-mods.js');
        jest.useFakeTimers();
        initRossMods();

        const chatObserver = observers.find(obs => obs.targets.includes(chatEl));
        expect(chatObserver).toBeTruthy();

        const hold = createOpeningHold({
            chatElement: chatEl,
            isGreetingOnly: () => true,
            win: window,
            now: () => 0,
            isPerson: () => true,
        });
        hold.beginOpening();
        hold.offer();

        // While held at top, shrinking #chat must NOT push scrollTop away from 0.
        height = 420;
        chatObserver.trigger();
        expect(scrollTop).toBe(0);

        // Once released, shrinking #chat compensates scrollTop by -deltaHeight.
        hold.release();
        height = 360;
        chatObserver.trigger();
        expect(scrollTop).toBe(60);
    });
});
