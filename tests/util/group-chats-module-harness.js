/* global globalThis */
import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import v8 from 'node:v8';

import { EventEmitter } from '../../public/lib/eventemitter.js';
import { event_types } from '../../public/scripts/events.js';

const pub = relative => fileURLToPath(new URL(`../../public/${relative}`, import.meta.url));
let cachedJQuerySource = null;
let cachedRealListPagination = null;
let cachedRealListSearch = null;

const defaultTag = (strings, ...values) => (
    Array.isArray(strings)
        ? strings.reduce((out, part, index) => out + part + (values[index] ?? ''), '')
        : String(strings ?? '')
);

function ensureJsdomBrowserGlobals() {
    if (typeof globalThis.structuredClone !== 'function') {
        globalThis.structuredClone = value => v8.deserialize(v8.serialize(value));
    }
    if (typeof globalThis.CSS === 'undefined') {
        globalThis.CSS = {
            supports: () => true,
            escape: value => String(value).replace(/([^\w-])/g, '\\$1'),
        };
    }
    if (typeof globalThis.requestAnimationFrame !== 'function') {
        globalThis.requestAnimationFrame = callback => {
            callback(0);
            return 0;
        };
    }
    if (typeof globalThis.window !== 'undefined') {
        if (typeof globalThis.window.matchMedia !== 'function') {
            globalThis.window.matchMedia = () => ({
                matches: false,
                addEventListener: () => {},
                removeEventListener: () => {},
            });
        }
        if (typeof globalThis.window.requestAnimationFrame !== 'function') {
            globalThis.window.requestAnimationFrame = globalThis.requestAnimationFrame;
        }
    }
}

ensureJsdomBrowserGlobals();

function loadWrappedJQuery() {
    ensureJsdomBrowserGlobals();
    let real$ = globalThis.window?.jQuery || globalThis.$;
    if (typeof real$ !== 'function' || !real$.fn) {
        cachedJQuerySource ??= readFileSync(pub('lib/jquery-3.5.1.min.js'), 'utf8');
        (0, eval)(cachedJQuerySource);
        real$ = globalThis.window?.jQuery || globalThis.$;
    }
    if (real$.fx) {
        real$.fx.off = true;
    }
    if (!real$.fn.sortable) {
        real$.fn.sortable = jest.fn(() => undefined);
    }

    const readyCallbacks = [];
    const wrapped$ = new Proxy(real$, {
        apply(target, thisArg, argArray) {
            if (argArray.length === 1 && typeof argArray[0] === 'function') {
                readyCallbacks.push(argArray[0]);
                return target(globalThis.document);
            }
            return Reflect.apply(target, thisArg, argArray);
        },
    });
    globalThis.$ = wrapped$;
    globalThis.jQuery = wrapped$;
    if (typeof globalThis.window !== 'undefined') {
        globalThis.window.$ = wrapped$;
        globalThis.window.jQuery = wrapped$;
    }

    return {
        $: real$,
        wrapped$,
        async runReady() {
            while (readyCallbacks.length) {
                const fn = readyCallbacks.shift();
                await fn(real$);
            }
        },
    };
}

class FakeFuse {
    constructor(list = [], options = {}) {
        this.list = list;
        this.options = options;
    }
    search(pattern) {
        const needle = String(pattern ?? '').toLowerCase();
        return this.list
            .map((item, refIndex) => ({ item, refIndex, score: 0 }))
            .filter(({ item }) => JSON.stringify(item).toLowerCase().includes(needle));
    }
}

/**
 * Imports the real `public/scripts/group-chats.js` ESM module in jsdom with mocked peer
 * browser dependencies, capturing `jQuery(readyFn)` into `runReady()` so tests can mount
 * DOM before attaching event listeners.
 *
 * @param {object} [options]
 */
export async function importGroupChatsModule(options = {}) {
    jest.resetModules();

    const { $, runReady } = loadWrappedJQuery();
    const toastr = {
        info: jest.fn(),
        success: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        ...(options.toastr ?? {}),
    };
    globalThis.toastr = toastr;
    if (typeof globalThis.window !== 'undefined') {
        globalThis.window.toastr = toastr;
    }

    const eventSource = options.eventSource ?? new EventEmitter();
    const state = {
        characters: options.characters ?? [
            { name: 'Alice', avatar: 'alice.png', first_mes: 'Hello from Alice.' },
            { name: 'Bob', avatar: 'bob.png', first_mes: 'Hello from Bob.' },
            { name: 'Carol', avatar: 'carol.png', first_mes: 'Hello from Carol.' },
            { name: 'Dave', avatar: 'dave.png', first_mes: 'Hello from Dave.' },
        ],
        chat: options.chat ?? [],
        chat_metadata: options.chat_metadata ?? {},
        this_chid: options.this_chid,
        menu_type: options.menu_type ?? 'group_edit',
        online_status: options.online_status ?? 'connected',
        is_send_press: options.is_send_press ?? false,
        power_user: options.power_user ?? {},
        tag_map: options.tag_map ?? {},
        oai_settings: options.oai_settings ?? {
            chat_completion_source: 'openai',
            openai_model: 'gpt-4o',
        },
        chatGeneration: 0,
        storage: new Map(Object.entries(options.accountStorage ?? {})),
    };

    let uuidCounter = 0;
    const accountStorage = {
        getItem: jest.fn(key => (state.storage.has(key) ? state.storage.get(key) : null)),
        setItem: jest.fn((key, value) => state.storage.set(key, String(value))),
        removeItem: jest.fn(key => state.storage.delete(key)),
        ...(options.accountStorageApi ?? {}),
    };

    const chatElement = $('#chat');
    const scriptMock = {
        chat: state.chat,
        sendSystemMessage: jest.fn(async () => {}),
        printMessages: jest.fn(async () => {}),
        printCharactersDebounced: jest.fn(),
        characters: state.characters,
        this_chid: state.this_chid,
        default_avatar: 'img/ai4.png',
        clearChat: jest.fn(),
        Generate: jest.fn(async () => {}),
        select_rm_info: jest.fn(),
        setCharacterId: jest.fn(chid => { state.this_chid = chid; }),
        setCharacterName: jest.fn(),
        setEditedMessageId: jest.fn(),
        is_send_press: state.is_send_press,
        resetChatState: jest.fn(),
        setSendButtonState: jest.fn(),
        getCharacters: jest.fn(async () => {}),
        system_message_types: { NARRATOR: 'narrator', GENERIC: 'generic', WELCOME: 'welcome' },
        online_status: state.online_status,
        talkativeness_default: 0.5,
        selectRightMenuWithAnimation: jest.fn(),
        deleteLastMessage: jest.fn(async () => { state.chat.pop(); }),
        showSwipeButtons: jest.fn(),
        hideSwipeButtons: jest.fn(),
        chat_metadata: state.chat_metadata,
        updateChatMetadata: jest.fn((newMetadata = {}, reset = false) => {
            if (reset) {
                for (const key of Object.keys(state.chat_metadata)) delete state.chat_metadata[key];
            }
            Object.assign(state.chat_metadata, newMetadata);
        }),
        getThumbnailUrl: jest.fn((_type, file) => `/thumbnail?type=avatar&file=${encodeURIComponent(file)}`),
        getThumbnailUrlForViewport: jest.fn((_type, file) => `/thumbnail?type=avatar&file=${encodeURIComponent(file)}`),
        setMenuType: jest.fn(next => { state.menu_type = next; }),
        menu_type: state.menu_type,
        select_selected_character: jest.fn(),
        cancelTtsPlay: jest.fn(),
        displayPastChats: jest.fn(async () => {}),
        sendMessageAsUser: jest.fn(async text => {
            state.chat.push({ name: 'User', mes: text, is_user: true });
        }),
        saveChatConditional: jest.fn(async () => true),
        getBiasStrings: jest.fn(() => ({ messageBias: '' })),
        flushPendingChatSavesForNavigation: jest.fn(async () => true),
        deactivateSendButtons: jest.fn(),
        activateSendButtons: jest.fn(),
        eventSource,
        event_types,
        getCurrentChatId: jest.fn(() => 'chat-1'),
        setCharacterSettingsOverrides: jest.fn(),
        system_avatar: 'img/five.png',
        getRequestHeaders: jest.fn(() => ({ 'Content-Type': 'application/json' })),
        refreshCsrfToken: jest.fn(async () => {}),
        setExternalAbortController: jest.fn(),
        baseChatReplace: jest.fn(text => String(text ?? '')),
        createLazyFields: jest.fn(() => ({})),
        depth_prompt_depth_default: 4,
        loadItemizedPrompts: jest.fn(async () => {}),
        animation_duration: 0,
        depth_prompt_role_default: 0,
        shouldAutoContinue: jest.fn(() => false),
        unshallowCharacter: jest.fn(async () => {}),
        chatElement,
        ensureMessageMediaIsArray: jest.fn(),
        syncCharacterMenuActiveEntity: jest.fn(),
        incrementChatGeneration: jest.fn(() => ++state.chatGeneration),
        getChatGeneration: jest.fn(() => state.chatGeneration),
        ...(options.script ?? {}),
    };

    const utilsMock = {
        shuffle: jest.fn(array => array),
        onlyUnique: (value, index, array) => array.indexOf(value) === index,
        debounce: jest.fn((fn, timeout = 0) => {
            let timer;
            const wrapped = (...args) => {
                clearTimeout(timer);
                timer = setTimeout(() => fn(...args), timeout);
                timer.unref?.();
            };
            wrapped.cancel = () => clearTimeout(timer);
            return wrapped;
        }),
        delay: jest.fn(async () => {}),
        isDataURL: value => typeof value === 'string' && value.startsWith('data:'),
        createThumbnail: jest.fn(async dataUrl => dataUrl),
        extractAllWords: value => [...String(value ?? '').matchAll(/\b\w+\b/gim)].map(match => match[0].toLowerCase()),
        saveBase64AsFile: jest.fn(async () => ({ path: '' })),
        getBase64Async: jest.fn(async () => ''),
        resetScrollHeight: jest.fn(async () => {}),
        initScrollHeight: jest.fn(),
        uuidv4: jest.fn(() => `uuid-${++uuidCounter}`),
        includesIgnoreCaseAndAccents: (a, b) => String(a ?? '').toLowerCase().includes(String(b ?? '').toLowerCase()),
        ...(options.utils ?? {}),
    };

    const rossAscendsMock = {
        RA_CountCharTokens: jest.fn(),
        humanizedDateTime: jest.fn(() => '2026-01-01@00h00m00s'),
        dragElement: jest.fn(),
        favsToHotswap: jest.fn(),
        getMessageTimeStamp: jest.fn(() => '2026-01-01 00:00:00'),
        ...(options.rossAscends ?? {}),
    };

    const powerUserMock = {
        power_user: state.power_user,
        loadMovingUIState: jest.fn(),
        sortEntitiesList: jest.fn(list => list),
        fuzzySearchCharacters: jest.fn(() => []),
        fuzzySearchGroups: jest.fn(() => []),
        fuzzySearchPersonas: jest.fn(() => []),
        fuzzySearchTags: jest.fn(() => []),
        fuzzySearchWorldInfo: jest.fn(() => []),
        ...(options.powerUser ?? {}),
    };

    const tagsMock = {
        printTagList: jest.fn((container, { tags } = {}) => {
            if (container?.empty && Array.isArray(tags)) {
                container.empty();
                for (const tag of tags.slice(0, 50)) {
                    container.append($('<span class="tag"></span>').text(tag.name));
                }
            }
        }),
        getTagsList: jest.fn(() => []),
        createTagMapFromList: jest.fn(),
        applyTagsOnCharacterSelect: jest.fn(),
        tag_map: state.tag_map,
        applyTagsOnGroupSelect: jest.fn(),
        printTagFilters: jest.fn(),
        tag_filter_type: { GROUP_CANDIDATES: 'group_candidates', GROUP_MEMBERS: 'group_members' },
        ...(options.tags ?? {}),
    };

    const popupMock = {
        POPUP_TYPE: { TEXT: 1, CONFIRM: 2, INPUT: 3, DISPLAY: 4 },
        POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null },
        Popup: Object.assign(jest.fn(() => ({ show: jest.fn(async () => 1) })), {
            show: {
                confirm: jest.fn(async () => 1),
                input: jest.fn(async () => ''),
            },
        }),
        callGenericPopup: jest.fn(async () => 1),
        ...(options.popup ?? {}),
    };

    const toolManagerMock = {
        canPerformToolCalls: jest.fn(() => false),
        ...(options.toolManager ?? {}),
    };

    const regexMock = {
        getRegexedString: jest.fn(text => text),
        regex_placement: { AI_OUTPUT: 2, USER_INPUT: 1, WORLD_INFO: 5 },
        ...(options.regex ?? {}),
    };

    const actionMenuMock = {
        openActionMenu: jest.fn(),
        ...(options.actionMenu ?? {}),
    };

    const objectNavigationMock = {
        objectNavigation: {
            navigate: jest.fn(async () => ({ ok: true })),
            ...(options.objectNavigation ?? {}),
        },
    };

    const foldersMock = {
        getFolderId: jest.fn(() => null),
        removeEntityKey: jest.fn(),
        setFolder: jest.fn(async () => {}),
        ...(options.folders ?? {}),
    };

    const groupEditorMock = {
        beginGroupEditorLoad: jest.fn(() => 'loaded'),
        openGroupEditorSession: jest.fn(),
        openGroupEditorCreateSession: jest.fn(),
        captureGroupEditorSave: jest.fn(() => null),
        readGroupEditorBaseline: jest.fn(() => null),
        isGroupEditorOwner: jest.fn(() => false),
        notifyGroupEditorChanged: jest.fn(),
        rebaseGroupEditor: jest.fn(),
        initGroupEditor: jest.fn(),
        discardGroupEditorForEntity: jest.fn(),
        attachGroupTagFilterMenus: jest.fn(),
        prepareGroupEditorReveal: jest.fn(async () => true),
        setGroupEditorFolderValue: jest.fn(),
        ...(options.groupEditor ?? {}),
    };

    await jest.unstable_mockModule(pub('lib.js'), () => ({ Fuse: FakeFuse }));
    await jest.unstable_mockModule(pub('script.js'), () => scriptMock);
    await jest.unstable_mockModule(pub('scripts/utils.js'), () => utilsMock);
    await jest.unstable_mockModule(pub('scripts/RossAscends-mods.js'), () => rossAscendsMock);
    await jest.unstable_mockModule(pub('scripts/power-user.js'), () => powerUserMock);
    await jest.unstable_mockModule(pub('scripts/sillybunny-folders.js'), () => foldersMock);
    await jest.unstable_mockModule(pub('scripts/tags.js'), () => tagsMock);
    await jest.unstable_mockModule(pub('scripts/chats.js'), () => ({
        isExternalMediaAllowed: jest.fn(() => true),
    }));
    await jest.unstable_mockModule(pub('scripts/popup.js'), () => popupMock);
    await jest.unstable_mockModule(pub('scripts/i18n.js'), () => ({
        t: defaultTag,
        translate: text => String(text ?? ''),
    }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-action-menu.js'), () => actionMenuMock);
    await jest.unstable_mockModule(pub('scripts/sillybunny-editor/object-navigation.js'), () => objectNavigationMock);
    await jest.unstable_mockModule(pub('scripts/util/AccountStorage.js'), () => ({ accountStorage }));
    await jest.unstable_mockModule(pub('scripts/request-compression.js'), () => ({
        compressRequest: jest.fn(async request => request),
    }));
    await jest.unstable_mockModule(pub('scripts/csrf-token-refresh.js'), () => ({
        fetchWithCsrfRetry: jest.fn(async (url, initOrFn) => globalThis.fetch(url, typeof initOrFn === 'function' ? await initOrFn() : initOrFn)),
    }));
    await jest.unstable_mockModule(pub('scripts/openai.js'), () => ({
        chat_completion_sources: {
            OPENAI: 'openai',
            OPENAI_RESPONSES: 'openai_responses',
            CLAUDE: 'claude',
            MAKERSUITE: 'makersuite',
            GEMINI_INTERACTIONS: 'gemini_interactions',
            VERTEXAI: 'vertexai',
            OPENROUTER: 'openrouter',
            AI21: 'ai21',
            MISTRALAI: 'mistralai',
            CUSTOM: 'custom',
            COHERE: 'cohere',
            PERPLEXITY: 'perplexity',
            GROQ: 'groq',
            SILICONFLOW: 'siliconflow',
            ELECTRONHUB: 'electronhub',
            CHUTES: 'chutes',
            NANOGPT: 'nanogpt',
            DEEPSEEK: 'deepseek',
            AIMLAPI: 'aimlapi',
            XAI: 'xai',
            POLLINATIONS: 'pollinations',
            COMETAPI: 'cometapi',
            MOONSHOT: 'moonshot',
            FIREWORKS: 'fireworks',
            AZURE_OPENAI: 'azure_openai',
            ZAI: 'zai',
        },
        oai_settings: state.oai_settings,
    }));
    await jest.unstable_mockModule(pub('scripts/extensions/regex/engine.js'), () => regexMock);
    await jest.unstable_mockModule(pub('scripts/tool-calling.js'), () => ({ ToolManager: toolManagerMock }));

    if (!cachedRealListPagination && !options.mockListPagination) {
        ({ createListPagination: cachedRealListPagination } = await import('../../public/scripts/sillybunny-editor/list-pagination.js'));
    }
    if (!cachedRealListSearch && !options.mockListSearch) {
        ({ createListSearch: cachedRealListSearch } = await import('../../public/scripts/sillybunny-editor/list-search.js'));
    }
    if (options.mockListPagination || cachedRealListPagination) {
        await jest.unstable_mockModule(pub('scripts/sillybunny-editor/list-pagination.js'), () => (
            options.mockListPagination ?? { createListPagination: cachedRealListPagination }
        ));
    }
    if (options.mockListSearch || cachedRealListSearch) {
        await jest.unstable_mockModule(pub('scripts/sillybunny-editor/list-search.js'), () => (
            options.mockListSearch ?? { createListSearch: cachedRealListSearch }
        ));
    }
    if (options.mockStatusPage) {
        await jest.unstable_mockModule(pub('scripts/sillybunny-editor/status-page.js'), () => options.mockStatusPage);
    }
    if (!options.useRealGroupEditor) {
        await jest.unstable_mockModule(pub('scripts/sillybunny-group-editor.js'), () => groupEditorMock);
    }

    if (options.fetch) {
        globalThis.fetch = options.fetch;
    }

    const groupChats = await import('../../public/scripts/group-chats.js');

    return {
        groupChats,
        runReady,
        $,
        state,
        eventSource,
        mocks: {
            script: scriptMock,
            utils: utilsMock,
            rossAscends: rossAscendsMock,
            powerUser: powerUserMock,
            tags: tagsMock,
            popup: popupMock,
            toolManager: toolManagerMock,
            regex: regexMock,
            actionMenu: actionMenuMock,
            objectNavigation: objectNavigationMock.objectNavigation,
            accountStorage,
            groupEditor: groupEditorMock,
            toastr,
        },
    };
}
