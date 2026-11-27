/* global globalThis */
import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import v8 from 'node:v8';
import { createNoopJQuery } from './openai-harness.js';

const pub = relative => fileURLToPath(new URL(`../../public/${relative}`, import.meta.url));
let cachedJQuerySource = null;

/**
 * Registers `jest.unstable_mockModule` stubs for browser peers of `public/scripts/power-user.js`
 * and imports the real module. Keeps pure domain helpers (`auto-fix-markdown.js`, `markdown-engine.js`,
 * `mobile-streaming.js`, `sillybunny-theme-css.js`, `sillybunny-toast-position.js`,
 * `sillybunny-toast-motion.js`, `sillybunny-theme-revisions.js`) real by default.
 *
 * When real jQuery is already loaded in jsdom, `jQuery(readyCallback)` calls are captured in
 * `readyCallbacks` instead of firing immediately at import time so tests can mount DOM first
 * and call `await runReady()`.
 *
 * @param {object} [options]
 * @param {object} [options.script] Extra overrides merged into `public/script.js`.
 * @param {object} [options.popup] Extra overrides merged into `public/scripts/popup.js`.
 * @param {object} [options.customCssAi] Extra overrides merged into `public/scripts/sillybunny-custom-css-ai.js`.
 * @param {object} [options.utils] Extra overrides merged into `public/scripts/utils.js`.
 * @param {Function} [options.openAlert] Custom mock for `sillybunny-editor/dialog.js#openAlert`.
 * @param {boolean} [options.mockToastPosition] Mock `sillybunny-toast-position.js` to spy on its calls.
 * @returns {Promise<{ powerUser: typeof import('../../public/scripts/power-user.js'), mocks: Record<string, any>, runReady: () => Promise<void> }>}
 */
export async function importPowerUserModule({
    script: scriptOverrides = {},
    popup: popupOverrides = {},
    customCssAi: customCssAiOverrides = {},
    utils: utilsOverrides = {},
    openAlert: openAlertOverride = null,
    mockToastPosition = false,
} = {}) {
    if (typeof globalThis.structuredClone !== 'function') {
        globalThis.structuredClone = value => v8.deserialize(v8.serialize(value));
    }
    if (typeof globalThis.CSS === 'undefined') {
        globalThis.CSS = {
            supports: () => false,
            escape: value => String(value).replace(/([^\w-])/g, '\\$1'),
        };
    }
    if (typeof globalThis.window !== 'undefined' && typeof globalThis.window.matchMedia !== 'function') {
        globalThis.window.matchMedia = () => ({
            matches: false,
            addEventListener: () => {},
            removeEventListener: () => {},
        });
    }
    if (typeof globalThis.getComputedStyle !== 'function') {
        globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
    }
    if (typeof globalThis.window !== 'undefined' && typeof globalThis.document?.head?.querySelector === 'function') {
        if (!globalThis.document.head.querySelector('meta[name=theme-color]')) {
            const meta = globalThis.document.createElement('meta');
            meta.setAttribute('name', 'theme-color');
            meta.setAttribute('content', '');
            globalThis.document.head.appendChild(meta);
        }
        if (typeof globalThis.$ !== 'function') {
            cachedJQuerySource ??= readFileSync(pub('lib/jquery-3.5.1.min.js'), 'utf8');
            (0, eval)(cachedJQuerySource);
        }
    }
    if (typeof globalThis.HTMLElement === 'undefined') {
        globalThis.HTMLElement = class HTMLElement {};
        globalThis.HTMLInputElement = class HTMLInputElement {};
        globalThis.HTMLSelectElement = class HTMLSelectElement {};
    }
    if (typeof globalThis.document === 'undefined') {
        const fakeStyle = { setProperty: jest.fn(), removeProperty: jest.fn() };
        const fakeClassList = {
            add: jest.fn(),
            remove: jest.fn(),
            toggle: jest.fn(),
            contains: jest.fn(() => false),
        };
        const fakeMeta = { setAttribute: jest.fn(), getAttribute: () => '' };
        globalThis.document = {
            documentElement: { style: fakeStyle, classList: fakeClassList, dataset: {} },
            body: { style: fakeStyle, classList: fakeClassList, dataset: {}, setAttribute: jest.fn(), removeAttribute: jest.fn(), appendChild: jest.fn(), append: jest.fn() },
            head: { appendChild: jest.fn(), querySelector: () => null },
            getElementById: () => null,
            querySelector: selector => (selector === 'meta[name=theme-color]' ? fakeMeta : null),
            querySelectorAll: () => [],
            createElement: () => ({ style: fakeStyle, classList: fakeClassList, dataset: {}, setAttribute: jest.fn(), addEventListener: jest.fn() }),
            addEventListener: jest.fn(),
            dispatchEvent: jest.fn(),
        };
    }
    if (typeof globalThis.window === 'undefined') {
        globalThis.window = {
            matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
            addEventListener: jest.fn(),
            dispatchEvent: jest.fn(),
            requestAnimationFrame: cb => cb(),
            localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
        };
    }
    if (!globalThis.toastr) {
        globalThis.toastr = {
            options: {},
            info: jest.fn(),
            success: jest.fn(),
            warning: jest.fn(),
            error: jest.fn(),
            clear: jest.fn(),
        };
    }

    const readyCallbacks = [];
    if (typeof globalThis.$ !== 'function') {
        const base = createNoopJQuery();
        const jq = (arg, ...rest) => {
            if (typeof arg === 'function') {
                readyCallbacks.push(arg);
                return jq;
            }
            return base(arg, ...rest);
        };
        jq.fn = base.fn;
        jq.fx = { off: false };
        globalThis.$ = jq;
        globalThis.jQuery = jq;
    } else {
        const realJq = globalThis.jQuery ?? globalThis.$;
        const wrappedJq = function (arg, ...rest) {
            if (typeof arg === 'function') {
                readyCallbacks.push(arg);
                return wrappedJq;
            }
            return realJq(arg, ...rest);
        };
        Object.assign(wrappedJq, realJq);
        wrappedJq.fn = realJq.fn;
        if (typeof wrappedJq.fn.select2 !== 'function') {
            wrappedJq.fn.select2 = function () { return this; };
        }
        if (typeof wrappedJq.fn.sortable !== 'function') {
            wrappedJq.fn.sortable = function () { return this; };
        }
        if (typeof wrappedJq.fn.colorpicker !== 'function') {
            wrappedJq.fn.colorpicker = function () { return this; };
        }
        globalThis.$ = wrappedJq;
        globalThis.jQuery = wrappedJq;
        if (globalThis.window) {
            globalThis.window.$ = wrappedJq;
            globalThis.window.jQuery = wrappedJq;
        }
    }

    const eventListeners = new Map();
    const eventSource = {
        on: jest.fn((event, listener) => {
            if (!eventListeners.has(event)) eventListeners.set(event, []);
            eventListeners.get(event).push(listener);
        }),
        once: jest.fn(),
        off: jest.fn(),
        removeListener: jest.fn(),
        emit: jest.fn(async (event, ...args) => {
            for (const listener of eventListeners.get(event) ?? []) {
                await listener(...args);
            }
        }),
        makeLast: jest.fn(),
        makeFirst: jest.fn(),
    };

    const scriptMock = {
        ANIMATION_DURATION_DEFAULT: 200,
        activateSendButtons: jest.fn(),
        amount_gen: 200,
        characters: [],
        chat: [],
        deactivateSendButtons: jest.fn(),
        deleteMessage: jest.fn(),
        doNewChat: jest.fn(async () => {}),
        entitiesFilter: { setFilterData: jest.fn() },
        eventSource,
        event_types: {
            SETTINGS_UPDATED: 'settings_updated',
            APP_READY: 'app_ready',
            CHAT_CHANGED: 'chat_changed',
            CHARACTER_EDITED: 'character_edited',
        },
        extension_prompt_roles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
        extension_prompt_types: { NONE: -1, IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 },
        flushPendingChatSavesForNavigation: jest.fn(async () => {}),
        getCurrentChatId: jest.fn(() => 'test-chat'),
        getFirstDisplayedMessageId: jest.fn(() => 0),
        getRequestHeaders: jest.fn(() => ({ 'Content-Type': 'application/json' })),
        koboldai_setting_names: [],
        koboldai_settings: [],
        main_api: 'openai',
        max_context: 4096,
        messageFormatting: jest.fn(value => value),
        nai_settings: {},
        novelai_setting_names: [],
        novelai_settings: [],
        online_status: 'no_connection',
        printCharactersDebounced: jest.fn(),
        refreshMessageModelIcons: jest.fn(),
        reloadCurrentChat: jest.fn(async () => {}),
        reloadMarkdownProcessor: jest.fn(),
        saveChatConditional: jest.fn(async () => {}),
        saveSettings: jest.fn(async () => true),
        saveSettingsDebounced: jest.fn(),
        scrollChatToBottom: jest.fn(),
        setActiveCharacter: jest.fn(),
        setActiveGroup: jest.fn(),
        setAnimationDuration: jest.fn(),
        setCharacterId: jest.fn(),
        setEditedMessageId: jest.fn(),
        settingsReady: true,
        showMoreMessages: jest.fn(),
        substituteParams: jest.fn(value => String(value ?? '')),
        this_chid: undefined,
        updateMessageMetaBadges: jest.fn(),
        updateMessageTokenAccounting: jest.fn(),
        ...scriptOverrides,
    };

    const popupMock = {
        POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null, CUSTOM1: 2, CUSTOM2: 3 },
        POPUP_TYPE: { TEXT: 1, CONFIRM: 2, INPUT: 3, DISPLAY: 4 },
        Popup: class Popup {},
        callGenericPopup: jest.fn(async () => null),
        fixToastrForDialogs: jest.fn(),
        ...popupOverrides,
    };

    const openAlertMock = openAlertOverride ?? jest.fn(async () => 'cancel');
    const customCssAiMock = {
        generateCustomCssWithAI: jest.fn(async () => ''),
        resolveCustomCssAIProfile: jest.fn(() => ({ id: 'p1', name: 'Test Profile' })),
        ...customCssAiOverrides,
    };
    const utilsMock = {
        debounce: fn => fn,
        delay: jest.fn(async () => {}),
        download: jest.fn(),
        ensurePlainObject: value => value ?? {},
        equalsIgnoreCaseAndAccents: (a, b) => String(a).toLowerCase() === String(b).toLowerCase(),
        getFileText: jest.fn(async () => '{}'),
        getSanitizedFilename: jest.fn(name => String(name ?? '')),
        getStringHash: jest.fn(value => String(value ?? '')),
        isTrueBoolean: value => value === true || String(value).toLowerCase() === 'true',
        onlyUnique: (value, index, self) => self.indexOf(value) === index,
        parseJsonFile: jest.fn(async () => ({})),
        resetScrollHeight: jest.fn(),
        shuffle: arr => arr,
        sortMoments: () => 0,
        stringToRange: jest.fn(() => []),
        timestampToMoment: jest.fn(() => ({ valueOf: () => 0 })),
        uuidv4: jest.fn(() => '00000000-0000-4000-8000-000000000000'),
        waitUntilCondition: jest.fn(async () => true),
        ...utilsOverrides,
    };

    const registeredCommands = new Map();
    const storageMap = new Map();
    const accountStorageMock = {
        getItem: jest.fn(key => storageMap.get(key) ?? null),
        setItem: jest.fn((key, value) => storageMap.set(key, String(value))),
        removeItem: jest.fn(key => storageMap.delete(key)),
    };

    await jest.unstable_mockModule(pub('lib.js'), () => ({
        Fuse: class Fuse {
            constructor(list = [], options = {}) {
                this.list = Array.isArray(list) ? list : [];
                this.keys = options?.keys ?? [];
            }
            search(query) {
                const needle = String(query ?? '').toLowerCase();
                return this.list
                    .filter(item => {
                        if (typeof item === 'string') return item.toLowerCase().includes(needle);
                        return this.keys.some(key => String(item?.[typeof key === 'string' ? key : key?.name] ?? '').toLowerCase().includes(needle));
                    })
                    .map(item => ({ item }));
            }
        },
        Handlebars: { compile: jest.fn(() => () => ''), registerHelper: jest.fn() },
        lodash: {},
    }));
    await jest.unstable_mockModule(pub('script.js'), () => scriptMock);
    await jest.unstable_mockModule(pub('scripts/RossAscends-mods.js'), () => ({
        isMobile: jest.fn(() => false),
        initMovingUI: jest.fn(),
        favsToHotswap: jest.fn(),
    }));
    await jest.unstable_mockModule(pub('scripts/group-chats.js'), () => ({
        groups: [],
        resetSelectedGroup: jest.fn(),
        selected_group: null,
    }));
    await jest.unstable_mockModule(pub('scripts/instruct-mode.js'), () => ({
        instruct_presets: [],
        loadInstructMode: jest.fn(),
        names_behavior_types: { NONE: -1, DEFAULT: 0, COMPLETION: 1, CONTENT: 2 },
        selectInstructPreset: jest.fn(),
        updateBindModelTemplatesState: jest.fn(),
    }));
    await jest.unstable_mockModule(pub('scripts/tags.js'), () => ({
        getTagsList: jest.fn(() => []),
        tag_import_setting: { ASK: 1, ALL: 2, NONE: 3, ONLY_EXISTING: 4 },
        tag_map: {},
        tag_sort_mode: { DEFAULT: 0 },
        tags: [],
    }));
    await jest.unstable_mockModule(pub('scripts/tokenizers.js'), () => ({
        resetTokenCache: jest.fn(),
        tokenizers: { BEST_MATCH: 0, NONE: 1 },
    }));
    await jest.unstable_mockModule(pub('scripts/logit-bias.js'), () => ({
        BIAS_CACHE: { clear: jest.fn() },
    }));
    await jest.unstable_mockModule(pub('scripts/templates.js'), () => ({
        renderTemplateAsync: jest.fn(async () => ''),
    }));
    await jest.unstable_mockModule(pub('scripts/utils.js'), () => utilsMock);
    await jest.unstable_mockModule(pub('scripts/filters.js'), () => ({
        FILTER_TYPES: {},
        fuzzySearchCategories: {},
    }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-character-list-state.js'), () => ({
        getCharacterListView: jest.fn(() => 'characters'),
        setListSort: jest.fn(),
    }));
    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommand.js'), () => ({
        SlashCommand: { fromProps: jest.fn(props => props) },
    }));
    class MockSlashCommandArgument {
        static fromProps = jest.fn(props => props);
        constructor(...args) { this.args = args; }
    }
    class MockSlashCommandNamedArgument {
        static fromProps = jest.fn(props => props);
        constructor(...args) { this.args = args; }
    }
    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandArgument.js'), () => ({
        ARGUMENT_TYPE: { STRING: 'string', NUMBER: 'number', BOOLEAN: 'boolean', LIST: 'list', DICTIONARY: 'dictionary' },
        SlashCommandArgument: MockSlashCommandArgument,
        SlashCommandNamedArgument: MockSlashCommandNamedArgument,
    }));
    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandParser.js'), () => ({
        PARSER_FLAG: { STRICT_ESCAPING: 1, REPLACE_GETVAR: 2 },
        SlashCommandParser: {
            addCommandObject: jest.fn(command => {
                if (command?.name) registeredCommands.set(command.name, command);
            }),
        },
    }));
    await jest.unstable_mockModule(pub('scripts/autocomplete/AutoComplete.js'), () => ({
        AUTOCOMPLETE_SELECT_KEY: { TAB: 0, ENTER: 1 },
        AUTOCOMPLETE_STATE: { NONE: 0 },
        AUTOCOMPLETE_WIDTH: { SAME_AS_INPUT: 0 },
    }));
    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandEnumValue.js'), () => ({
        SlashCommandEnumValue: class SlashCommandEnumValue {},
        enumTypes: {},
    }));
    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandCommonEnumsProvider.js'), () => ({
        commonEnumProviders: new Proxy({}, { get: () => () => () => [] }),
        enumIcons: {},
    }));
    await jest.unstable_mockModule(pub('scripts/popup.js'), () => popupMock);
    await jest.unstable_mockModule(pub('scripts/sillybunny-delete-confirm.js'), () => ({
        confirmVerb: jest.fn(() => ({})),
    }));
    await jest.unstable_mockModule(pub('scripts/sysprompt.js'), () => ({
        checkForSystemPromptInInstructTemplate: jest.fn(),
        loadSystemPrompts: jest.fn(),
        system_prompts: [],
    }));
    await jest.unstable_mockModule(pub('scripts/util/AccountStorage.js'), () => ({
        accountStorage: accountStorageMock,
    }));
    await jest.unstable_mockModule(pub('scripts/util/ThemeGenerator.js'), () => ({
        extractDominantColor: jest.fn(),
        generateThemePalette: jest.fn(),
        deriveBackgroundName: jest.fn(() => ''),
    }));
    await jest.unstable_mockModule(pub('scripts/reasoning.js'), () => ({
        DEFAULT_REASONING_TEMPLATE: {},
        loadReasoningTemplates: jest.fn(),
        reasoning_templates: [],
    }));
    await jest.unstable_mockModule(pub('scripts/chat-templates.js'), () => ({
        bindModelTemplates: jest.fn(),
    }));
    await jest.unstable_mockModule(pub('scripts/constants.js'), () => ({
        IMAGE_OVERSWIPE: { DISABLED: 0 },
        MEDIA_DISPLAY: { LIST: 0 },
    }));
    await jest.unstable_mockModule(pub('scripts/i18n.js'), () => ({
        t: (strings, ...values) => strings.reduce((out, part, idx) => out + part + (values[idx] ?? ''), ''),
    }));
    await jest.unstable_mockModule(pub('scripts/backgrounds.js'), () => ({
        getBackgroundPath: jest.fn(() => ''),
        isCustomBackgroundUrl: jest.fn(() => false),
    }));
    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandParserConfig.js'), () => ({
        setSlashCommandParserSettingsGetter: jest.fn(),
    }));
    await jest.unstable_mockModule(pub('scripts/personas.js'), () => ({
        persona_description_positions: { IN_PROMPT: 0, TOP_AN: 2, BOTTOM_AN: 3, AT_DEPTH: 4, NONE: 9 },
    }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-custom-css-ai.js'), () => customCssAiMock);
    await jest.unstable_mockModule(pub('scripts/extensions/in-chat-agents/profile-utils.js'), () => ({
        populateConnectionProfileSelect: jest.fn(),
    }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-editor/side-panel.js'), () => ({
        applyMovingUIState: jest.fn(),
        configureMovingUIState: jest.fn(),
        resetSidePanelSides: jest.fn(),
    }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-folders.js'), () => ({
        configureFolderStore: jest.fn(),
        normalizeFoldersData: jest.fn(data => data ?? {}),
    }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-editor/adapters/misc-dialogs.js'), () => ({
        customCssAiOptions: jest.fn(() => ({})),
    }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-editor/status-page.js'), () => ({
        setIconBusy: jest.fn(),
    }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-editor/banner.js'), () => ({
        createBanner: jest.fn(() => ({ element: globalThis.document.createElement('div') })),
    }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-editor/adapters/window-tools-dialogs.js'), () => ({
        adaptDebugMenu: jest.fn(),
    }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-editor/dialog.js'), () => ({
        openAlert: openAlertMock,
    }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-fonts.js'), () => ({
        applyGoogleFont: jest.fn(),
        populateFontSelect: jest.fn(),
        initFonts: jest.fn(),
    }));

    let toastPositionMock = null;
    if (mockToastPosition) {
        const realToastPosition = await import('../../public/scripts/sillybunny-toast-position.js');
        toastPositionMock = {
            DEFAULT_TOAST_POSITION: realToastPosition.DEFAULT_TOAST_POSITION,
            applyPositionsEarly: jest.fn(realToastPosition.applyPositionsEarly),
            applyToastPosition: jest.fn(realToastPosition.applyToastPosition),
            bindToastPositionSelect: jest.fn(realToastPosition.bindToastPositionSelect),
        };
        await jest.unstable_mockModule(pub('scripts/sillybunny-toast-position.js'), () => toastPositionMock);
    }

    const powerUser = await import('../../public/scripts/power-user.js');
    return {
        powerUser,
        mocks: {
            script: scriptMock,
            popup: popupMock,
            openAlert: openAlertMock,
            customCssAi: customCssAiMock,
            utils: utilsMock,
            accountStorage: accountStorageMock,
            registeredCommands,
            eventSource,
            toastPosition: toastPositionMock,
        },
        runReady: async () => {
            for (const callback of readyCallbacks) {
                await callback();
            }
        },
    };
}
