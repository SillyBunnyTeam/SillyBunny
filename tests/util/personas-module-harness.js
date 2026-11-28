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
    if (typeof globalThis.window !== 'undefined') {
        if (typeof globalThis.window.matchMedia !== 'function') {
            globalThis.window.matchMedia = () => ({
                matches: false,
                media: '',
                addEventListener() {},
                removeEventListener() {},
            });
        }
        if (typeof globalThis.requestAnimationFrame !== 'function') {
            globalThis.requestAnimationFrame = callback => setTimeout(() => callback(Date.now()), 0);
            globalThis.window.requestAnimationFrame = globalThis.requestAnimationFrame;
        }
    }
}

ensureJsdomGlobals();

function loadJQuery() {
    if (typeof globalThis.window === 'undefined') {
        throw new Error('importPersonasModule requires a jsdom test environment.');
    }
    if (!globalThis.window.jQuery) {
        (0, eval)(cachedJQuerySource);
    }
    const $ = globalThis.window.jQuery;
    if ($.fx) $.fx.off = true;
    if (!$.fn.pagination) {
        $.fn.pagination = function pagination() { return this; };
    }
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

    makeFirst(event, fn) {
        const next = new Set([fn, ...(this.listeners.get(event) ?? [])]);
        this.listeners.set(event, next);
        return this;
    }

    makeLast(event, fn) {
        return this.on(event, fn);
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

    off(event, fn) {
        return this.removeListener(event, fn);
    }

    async emit(event, ...args) {
        const list = [...(this.listeners.get(event) ?? [])];
        for (const fn of list) {
            await fn(...args);
        }
    }
}

const DEFAULT_EVENT_TYPES = {
    CHAT_CHANGED: 'chat_id_changed',
    CHARACTER_MANAGEMENT_DROPDOWN: 'character_management_dropdown',
    PERSONA_CREATED: 'persona_created',
    PERSONA_DELETED: 'persona_deleted',
    PERSONA_UPDATED: 'persona_updated',
    PERSONA_RENAMED: 'persona_renamed',
    PERSONA_CHANGED: 'persona_changed',
    SETTINGS_UPDATED: 'settings_updated',
};

/**
 * Imports the real `public/scripts/personas.js` inside jsdom with mocked peer dependencies.
 * @param {object} [options]
 */
export async function importPersonasModule(options = {}) {
    jest.resetModules();
    ensureJsdomGlobals();
    const $ = loadJQuery();

    const toastr = {
        info: jest.fn(),
        success: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        ...(options.toastr ?? {}),
    };
    globalThis.toastr = toastr;
    globalThis.window.toastr = toastr;

    const eventSource = options.eventSource ?? new HarnessEventEmitter();
    const event_types = { ...DEFAULT_EVENT_TYPES, ...(options.event_types ?? {}) };

    const state = {
        power_user: options.power_user ?? {
            personas: {},
            persona_descriptions: {},
            persona_description: '',
            persona_description_position: 0,
            persona_description_depth: 2,
            persona_description_role: 0,
            persona_description_lorebook: '',
            persona_sort_order: 'asc',
            persona_show_notifications: false,
            persona_allow_multi_connections: false,
            persona_auto_lock: false,
            default_persona: '',
        },
        characters: options.characters ?? [],
        chat: options.chat ?? [],
        chat_metadata: options.chat_metadata ?? {},
        groups: options.groups ?? [],
        selected_group: options.selected_group ?? null,
        this_chid: options.this_chid,
        name1: options.name1 ?? 'User',
        name2: options.name2 ?? 'Assistant',
        menu_type: options.menu_type ?? '',
        default_user_avatar: options.default_user_avatar ?? 'user-default.png',
        world_names: options.world_names ?? [],
        world_info: options.world_info ?? {},
        storage: new Map(Object.entries(options.accountStorage ?? {})),
    };

    const accountStorage = {
        getItem: jest.fn(key => (state.storage.has(key) ? state.storage.get(key) : null)),
        setItem: jest.fn((key, value) => state.storage.set(key, String(value))),
        removeItem: jest.fn(key => state.storage.delete(key)),
        ...(options.accountStorageApi ?? {}),
    };

    const defaultParseAvatarSource = rawSrc => {
        const source = String(rawSrc || '');
        const thumbMatch = source.match(/^\/thumbnail\?.*?\btype=(persona|avatar)\b.*?\bfile=([^&]+)/);
        if (thumbMatch) {
            return { type: thumbMatch[1], file: decodeURIComponent(thumbMatch[2]) };
        }
        const origMatch = source.match(/^\/User(?:%20| )Avatars\/([^?]+)/);
        if (origMatch) {
            return { type: 'persona', file: decodeURIComponent(origMatch[1]) };
        }
        return null;
    };

    const scriptMock = {
        buildAvatarList: jest.fn(),
        characterToEntity: jest.fn(character => ({ item: character, type: 'character', id: character?.avatar })),
        characters: state.characters,
        chat: state.chat,
        chat_metadata: state.chat_metadata,
        createOrEditCharacter: jest.fn(async () => {}),
        default_user_avatar: state.default_user_avatar,
        getCharacters: jest.fn(async () => {}),
        eventSource,
        event_types,
        getCurrentChatId: jest.fn(() => 'chat-1'),
        getMobileThumbnailUrl: jest.fn((type, file, cacheBust) => `/thumbnail?type=${type}&file=${encodeURIComponent(file)}&preset=mobile${cacheBust ? '&t=mobile' : ''}`),
        getRequestHeaders: jest.fn(() => ({ 'Content-Type': 'application/json' })),
        getThumbnailUrl: jest.fn((type, file, cacheBust) => `/thumbnail?type=${type}&file=${encodeURIComponent(file)}${cacheBust ? '&t=desktop' : ''}`),
        getThumbnailUrlForViewport: jest.fn((type, file, cacheBust) => `/thumbnail?type=${type}&file=${encodeURIComponent(file)}${cacheBust ? '&t=vp' : ''}`),
        groupToEntity: jest.fn(group => ({ item: group, type: 'group', id: group?.id })),
        menu_type: state.menu_type,
        name1: state.name1,
        name2: state.name2,
        parseAvatarSource: jest.fn(defaultParseAvatarSource),
        reloadCurrentChat: jest.fn(async () => {}),
        saveChatConditional: jest.fn(async () => true),
        saveMetadata: jest.fn(async () => {}),
        saveSettings: jest.fn(async () => true),
        saveSettingsDebounced: jest.fn(),
        select_rm_info: jest.fn(),
        setUserName: jest.fn(name => { state.name1 = name; }),
        this_chid: state.this_chid,
        ...(options.script ?? {}),
    };

    const utilsMock = {
        PAGINATION_TEMPLATE: '',
        clearInfoBlock: jest.fn(),
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
        download: jest.fn(),
        ensureImageFormatSupported: jest.fn(async file => file),
        flashHighlight: jest.fn(),
        getBase64Async: jest.fn(async () => 'data:image/png;base64,AA=='),
        getCharIndex: jest.fn(char => state.characters.indexOf(char)),
        getCharaFilename: jest.fn((chid = state.this_chid) => {
            const avatar = state.characters[Number(chid)]?.avatar;
            return avatar ? avatar.replace(/\.[^/.]+$/, '') : null;
        }),
        isFalseBoolean: value => value === false || value === 'false' || value === '0',
        isTrueBoolean: value => value === true || value === 'true' || value === '1',
        onlyUnique: (value, index, array) => array.indexOf(value) === index,
        parseJsonFile: jest.fn(async () => ({})),
        setInfoBlock: jest.fn(),
        localizePagination: jest.fn(),
        renderPaginationDropdown: jest.fn(),
        paginationDropdownChangeHandler: jest.fn(),
        addLongPressEvent: jest.fn(),
        stringToRange: jest.fn(),
        sortIgnoreCaseAndAccents: (a, b) => String(a ?? '').localeCompare(String(b ?? '')),
        equalsIgnoreCaseAndAccents: (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase(),
        includesIgnoreCaseAndAccents: (a, b) => String(a ?? '').toLowerCase().includes(String(b ?? '').toLowerCase()),
        resolveAvatarData: jest.fn(async () => ({})),
        findPersona: jest.fn(),
        escapeHtml: value => String(value ?? ''),
        ...(options.utils ?? {}),
    };

    const popupResult = { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null };
    const popupType = { TEXT: 1, CONFIRM: 2, INPUT: 3, DISPLAY: 4, CROP: 5 };
    const callGenericPopup = jest.fn(async () => popupResult.AFFIRMATIVE);
    const PopupMock = jest.fn().mockImplementation(function (content, type, inputValue, popupOptions) {
        this.content = content;
        this.type = type;
        this.inputValue = inputValue;
        this.options = popupOptions;
        this.result = popupResult.AFFIRMATIVE;
        this.show = jest.fn(async () => this.result);
    });
    PopupMock.show = {
        confirm: jest.fn(async () => popupResult.AFFIRMATIVE),
        input: jest.fn(async () => ''),
    };

    const isMobileMock = jest.fn(typeof options.isMobile === 'function' ? options.isMobile : () => Boolean(options.isMobile));

    const fetchMock = options.fetch ?? jest.fn(async (url) => {
        if (url === '/api/avatars/get') {
            return { ok: true, json: async () => Object.keys(state.power_user.personas ?? {}) };
        }
        if (url === '/api/avatars/upload') {
            return { ok: true, json: async () => ({ path: 'uploaded.png' }) };
        }
        if (url === '/api/avatars/delete') {
            return { ok: true, json: async () => ({ ok: true }) };
        }
        return {
            ok: true,
            blob: async () => new Blob(['img'], { type: 'image/png' }),
            json: async () => ({ ok: true }),
            text: async () => '',
        };
    });
    globalThis.fetch = fetchMock;
    globalThis.window.fetch = fetchMock;

    const mocks = {
        script: scriptMock,
        utils: utilsMock,
        accountStorage,
        toastr,
        fetch: fetchMock,
        isMobile: isMobileMock,
        callGenericPopup,
        Popup: PopupMock,
        saveMetadataDebounced: jest.fn(),
        getTokenCountAsync: jest.fn(async () => 0),
        openWorldInfoEditor: jest.fn(),
        renderTemplateAsync: jest.fn(async () => '<div></div>'),
        lorebookSelectOptions: jest.fn(() => ({})),
        utilityFormOptions: jest.fn(() => ({})),
    };

    await jest.unstable_mockModule(pub('script.js'), () => scriptMock);
    await jest.unstable_mockModule(pub('scripts/power-user.js'), () => ({
        power_user: state.power_user,
        fuzzySearchCharacters: jest.fn(() => []),
        fuzzySearchGroups: jest.fn(() => []),
        fuzzySearchPersonas: jest.fn((list, query) => {
            const needle = String(query ?? '').toLowerCase();
            return list
                .filter(id => String(state.power_user.personas?.[id] || id).toLowerCase().includes(needle))
                .map((item, index) => ({ item, score: index }));
        }),
        fuzzySearchTags: jest.fn(() => []),
        fuzzySearchWorldInfo: jest.fn(() => []),
    }));
    await jest.unstable_mockModule(pub('scripts/tags.js'), () => ({
        tag_map: options.tag_map ?? {},
    }));
    await jest.unstable_mockModule(pub('scripts/utils.js'), () => utilsMock);
    await jest.unstable_mockModule(pub('scripts/group-chats.js'), () => ({
        groups: state.groups,
        selected_group: state.selected_group,
        ...(options.groupChats ?? {}),
    }));
    await jest.unstable_mockModule(pub('scripts/popup.js'), () => ({
        POPUP_RESULT: popupResult,
        POPUP_TYPE: popupType,
        Popup: PopupMock,
        callGenericPopup,
        ...(options.popup ?? {}),
    }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-delete-confirm.js'), () => ({
        confirmVerb: jest.fn(async () => true),
        ...(options.deleteConfirm ?? {}),
    }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-editor/adapters/utility-dialogs.js'), () => ({
        utilityFormOptions: mocks.utilityFormOptions,
    }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-editor/adapters/preset-lorebook-dialogs.js'), () => ({
        lorebookSelectOptions: mocks.lorebookSelectOptions,
    }));
    await jest.unstable_mockModule(pub('scripts/tokenizers.js'), () => ({
        getTokenCountAsync: mocks.getTokenCountAsync,
    }));
    await jest.unstable_mockModule(pub('scripts/i18n.js'), () => ({
        t: (strings, ...values) => strings.reduce((out, part, index) => out + part + (values[index] ?? ''), ''),
        translate: text => text,
    }));
    await jest.unstable_mockModule(pub('scripts/world-info.js'), () => ({
        openWorldInfoEditor: mocks.openWorldInfoEditor,
        world_info: state.world_info,
        world_names: state.world_names,
    }));
    await jest.unstable_mockModule(pub('scripts/templates.js'), () => ({
        renderTemplateAsync: mocks.renderTemplateAsync,
    }));
    await jest.unstable_mockModule(pub('scripts/extensions.js'), () => ({
        saveMetadataDebounced: mocks.saveMetadataDebounced,
    }));
    await jest.unstable_mockModule(pub('scripts/util/AccountStorage.js'), () => ({ accountStorage }));
    await jest.unstable_mockModule(pub('scripts/browser-fixes.js'), () => ({ isFirefox: () => false }));
    await jest.unstable_mockModule(pub('scripts/RossAscends-mods.js'), () => ({ isMobile: isMobileMock }));

    const enumProxy = new Proxy({ boolean: () => () => [] }, { get: (target, prop) => target[prop] ?? jest.fn(() => []) });
    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommand.js'), () => ({
        SlashCommand: { fromProps: jest.fn(props => props) },
    }));
    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandArgument.js'), () => ({
        ARGUMENT_TYPE: { STRING: 'string', NUMBER: 'number', BOOLEAN: 'boolean', LIST: 'list', DICTIONARY: 'dictionary' },
        SlashCommandArgument: { fromProps: jest.fn(props => props) },
        SlashCommandNamedArgument: { fromProps: jest.fn(props => props) },
    }));
    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandCommonEnumsProvider.js'), () => ({
        commonEnumMatchProviders: enumProxy,
        commonEnumProviders: enumProxy,
        enumIcons: new Proxy({ getDataTypeIcon: () => '' }, { get: (target, prop) => target[prop] ?? '' }),
    }));
    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandEnumValue.js'), () => ({
        SlashCommandEnumValue: class { constructor(value) { this.value = value; } },
        enumTypes: { enum: 'enum', name: 'name', command: 'command' },
    }));
    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandParser.js'), () => ({
        SlashCommandParser: { addCommandObject: jest.fn(), commands: {} },
    }));
    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandReturnHelper.js'), () => ({
        slashCommandReturnHelper: {
            doReturn: jest.fn(value => value),
            enumList: jest.fn(() => []),
        },
    }));

    const personas = await import('../../public/scripts/personas.js');
    return {
        personas,
        $,
        state,
        eventSource,
        event_types,
        mocks,
    };
}
