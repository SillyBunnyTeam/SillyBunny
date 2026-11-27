/* global globalThis */
import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import v8 from 'node:v8';
import lodash from 'lodash';

import { event_types } from '../../public/scripts/events.js';

const pub = relative => fileURLToPath(new URL(`../../public/${relative}`, import.meta.url));
let cachedJQuerySource = null;

const defaultTagFunction = (strings, ...values) => (
    Array.isArray(strings)
        ? strings.reduce((out, part, index) => out + part + (values[index] ?? ''), '')
        : String(strings ?? '')
);

export function createNoopJQuery() {
    const elements = new Map();
    const makeCollection = (selector) => {
        const handlers = new Map();
        let value = '';
        let checked = false;
        const dataMap = new Map();
        const collection = {
            length: 0,
            handlers,
            on: jest.fn((event, handler) => {
                handlers.set(event, handler);
                return collection;
            }),
            off: jest.fn((event) => {
                if (event) handlers.delete(event);
                else handlers.clear();
                return collection;
            }),
            one: jest.fn((event, handler) => {
                handlers.set(event, handler);
                return collection;
            }),
            trigger: jest.fn((event, extraArgs) => {
                const handler = handlers.get(event);
                if (typeof handler === 'function') {
                    const args = Array.isArray(extraArgs) ? extraArgs : (extraArgs !== undefined ? [extraArgs] : []);
                    return handler.call(collection, { type: event, target: collection }, ...args);
                }
                return collection;
            }),
            val: jest.fn((next) => {
                if (next !== undefined) {
                    value = String(next);
                    return collection;
                }
                return value;
            }),
            prop: jest.fn((name, next) => {
                if (name === 'checked') {
                    if (next !== undefined) {
                        checked = Boolean(next);
                        return collection;
                    }
                    return checked;
                }
                if (next !== undefined) return collection;
                return undefined;
            }),
            attr: jest.fn((_name, next) => (next !== undefined ? collection : '')),
            data: jest.fn((key, next) => {
                if (next !== undefined) {
                    dataMap.set(key, next);
                    return collection;
                }
                return dataMap.get(key);
            }),
            text: jest.fn((next) => (next !== undefined ? collection : '')),
            html: jest.fn((next) => (next !== undefined ? collection : '')),
            css: jest.fn(() => collection),
            show: jest.fn(() => collection),
            hide: jest.fn(() => collection),
            empty: jest.fn(() => collection),
            remove: jest.fn(() => collection),
            append: jest.fn(() => collection),
            prepend: jest.fn(() => collection),
            find: jest.fn(() => makeCollection(`${String(selector)} find`)),
            filter: jest.fn(() => collection),
            children: jest.fn(() => ({ length: 0 })),
            parent: jest.fn(() => collection),
            parents: jest.fn(() => collection),
            closest: jest.fn(() => collection),
            clone: jest.fn(() => makeCollection(`${String(selector)} clone`)),
            each: jest.fn(() => collection),
            is: jest.fn(() => false),
            toggleClass: jest.fn(() => collection),
            addClass: jest.fn(() => collection),
            removeClass: jest.fn(() => collection),
            stop: jest.fn(() => collection),
            fadeOut: jest.fn(() => collection),
            pagination: jest.fn(() => 1),
            sortable: jest.fn(() => undefined),
            select2: jest.fn(() => collection),
            autocomplete: jest.fn(() => undefined),
            offset: jest.fn(() => ({ top: 0, left: 0 })),
            scrollTop: jest.fn(() => collection),
            get: jest.fn(() => []),
        };
        return collection;
    };

    const $ = jest.fn((selector) => {
        if (typeof selector === 'function') {
            return selector($);
        }
        if (typeof selector === 'string') {
            if (!elements.has(selector)) {
                elements.set(selector, makeCollection(selector));
            }
            return elements.get(selector);
        }
        if (selector && typeof selector === 'object' && typeof selector.on === 'function') {
            return selector;
        }
        return makeCollection(selector);
    });
    $.Event = jest.fn((type, props = {}) => ({ type, ...props }));
    $.cleanData = jest.fn();
    $.elements = elements;
    return $;
}

export function ensureBrowserJQuery() {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
        const $ = createNoopJQuery();
        globalThis.$ = $;
        globalThis.jQuery = $;
        return $;
    }

    if (typeof globalThis.structuredClone !== 'function') {
        globalThis.structuredClone = value => v8.deserialize(v8.serialize(value));
    }

    let $ = window.jQuery || globalThis.$;
    if (typeof $ !== 'function' || !$.fn) {
        cachedJQuerySource ??= readFileSync(pub('lib/jquery-3.5.1.min.js'), 'utf8');
        (0, eval)(cachedJQuerySource);
        $ = window.jQuery || globalThis.$;
    }
    if ($.fx) {
        $.fx.off = true;
    }
    // Stub jQuery UI / pagination / Select2 plugins so real DOM editors run in jsdom.
    if (!$.fn.pagination) {
        $.fn.pagination = jest.fn(() => 1);
    }
    if (!$.fn.sortable) {
        $.fn.sortable = jest.fn(() => undefined);
    }
    if (!$.fn.select2) {
        $.fn.select2 = jest.fn(function () { return this; });
    }
    if (!$.fn.autocomplete) {
        $.fn.autocomplete = jest.fn(() => undefined);
    }
    window.$ = $;
    window.jQuery = $;
    globalThis.$ = $;
    globalThis.jQuery = $;
    return $;
}

function createEventSource() {
    const listeners = new Map();
    const emit = jest.fn(async (eventName, ...args) => {
        const handlers = [...(listeners.get(eventName) ?? [])];
        for (const handler of handlers) {
            await handler(...args);
        }
    });
    return {
        listeners,
        on: jest.fn((eventName, handler) => {
            if (!listeners.has(eventName)) listeners.set(eventName, new Set());
            listeners.get(eventName).add(handler);
        }),
        once: jest.fn((eventName, handler) => {
            const wrapped = async (...args) => {
                listeners.get(eventName)?.delete(wrapped);
                await handler(...args);
            };
            if (!listeners.has(eventName)) listeners.set(eventName, new Set());
            listeners.get(eventName).add(wrapped);
        }),
        off: jest.fn((eventName, handler) => {
            listeners.get(eventName)?.delete(handler);
        }),
        removeListener: jest.fn((eventName, handler) => {
            listeners.get(eventName)?.delete(handler);
        }),
        emit,
    };
}

function createFakeFuse() {
    return class FakeFuse {
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
    };
}

/**
 * Imports the real `public/scripts/world-info.js` (and optionally real `authors-note.js`)
 * with mocked peer browser modules so tests execute genuine SillyBunny ESM logic.
 *
 * @param {object} [options]
 * @returns {Promise<{ worldInfo: any, authorsNote: any, mocks: any, state: any, $: any }>}
 */
export async function importWorldInfoModule(options = {}) {
    jest.resetModules();

    const $ = options.$ ?? ensureBrowserJQuery();
    globalThis.$ = $;
    globalThis.jQuery = $;
    if (typeof window !== 'undefined') {
        window.$ = $;
        window.jQuery = $;
    }

    const toastr = {
        info: jest.fn(),
        success: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        ...(options.toastr ?? {}),
    };
    globalThis.toastr = toastr;
    if (typeof window !== 'undefined') {
        window.toastr = toastr;
    }

    if (typeof globalThis.CSS === 'undefined') {
        globalThis.CSS = {
            supports: () => false,
            escape: value => String(value).replace(/([^\w-])/g, '\\$1'),
        };
    }

    if (typeof globalThis.Option === 'undefined') {
        globalThis.Option = class Option {
            constructor(text = '', value = '', defaultSelected = false, selected = false) {
                this.text = text;
                this.value = value;
                this.defaultSelected = defaultSelected;
                this.selected = selected;
            }
        };
    }

    if (typeof document === 'undefined') {
        globalThis.document = {
            activeElement: null,
            querySelector: jest.fn(() => null),
            querySelectorAll: jest.fn(() => []),
            getElementById: jest.fn(() => null),
            createElement: jest.fn(() => ({ classList: { add: jest.fn() }, appendChild: jest.fn(), addEventListener: jest.fn(), style: {} })),
            dispatchEvent: jest.fn(),
        };
    }

    const state = {
        characters: options.characters ?? [
            { name: 'Aster', avatar: 'aster.png', data: { extensions: { world: 'Aster Book' } } },
            { name: 'Bram', avatar: 'bram.png', data: { extensions: { world: 'Bram Book' } } },
        ],
        this_chid: options.this_chid ?? 0,
        chat_metadata: options.chat_metadata ?? {},
        name1: options.name1 ?? 'Roleplay User',
        name2: options.name2 ?? 'Aster',
        menu_type: options.menu_type ?? 'character_edit',
        selected_group: options.selected_group ?? null,
        online_status: options.online_status ?? 'no_connection',
        power_user: options.power_user ?? {},
        extension_settings: options.extension_settings ?? { note: { allowWIScan: true } },
        extensionPrompts: options.extensionPrompts ?? {
            note: { value: '', scan: true },
        },
        tagMap: options.tagMap ?? {},
        chat: options.chat ?? [],
        user_avatar: options.user_avatar ?? 'default-user.png',
        storage: new Map(Object.entries(options.accountStorage ?? {})),
        books: options.books ?? null,
    };

    const eventSource = createEventSource();
    const setExtensionPrompt = jest.fn((key, value, position, depth, scan, role) => {
        state.extensionPrompts[key] = { value, position, depth, scan, role };
    });
    const getContext = jest.fn(() => ({
        chat: state.chat,
        characters: state.characters,
        characterId: state.this_chid,
        groupId: state.selected_group,
        chatMetadata: state.chat_metadata,
        extensionPrompts: state.extensionPrompts,
        tagMap: state.tagMap,
        tags: state.tags ?? [],
        setExtensionPrompt,
    }));

    const substituteParams = jest.fn((content, opts = {}) => String(content ?? '')
        .replace(/{{char}}/gi, opts?.name2Override ?? state.name2)
        .replace(/{{user}}/gi, opts?.name1Override ?? state.name1));

    const getCharaFilename = jest.fn((chid = null, opts = {}) => {
        const avatar = opts?.manualAvatarKey ?? state.characters[chid ?? state.this_chid]?.avatar;
        return avatar ? String(avatar).replace(/\.[^/.]+$/, '') : null;
    });

    const getTagKeyForEntity = jest.fn(chid => state.characters[chid]?.avatar);
    const getExtensionPromptByName = jest.fn(async key => state.extensionPrompts[key]?.value ?? '');
    const getTokenCountAsync = jest.fn(options.getTokenCountAsync ?? (async text => String(text ?? '').split(/\s+/).filter(Boolean).length));
    const getRegexedString = jest.fn((text) => text);

    const scriptMock = {
        MAX_INJECTION_DEPTH: 1000,
        animation_duration: 0,
        saveSettings: jest.fn(),
        saveSettingsDebounced: jest.fn(),
        substituteParams,
        getRequestHeaders: jest.fn(() => ({ 'Content-Type': 'application/json' })),
        chat_metadata: state.chat_metadata,
        this_chid: state.this_chid,
        characters: state.characters,
        saveCharacterDebounced: jest.fn(),
        menu_type: state.menu_type,
        eventSource,
        event_types,
        getExtensionPromptByName,
        saveMetadata: jest.fn(async () => {}),
        getCurrentChatId: jest.fn(() => 'chat-1'),
        extension_prompt_roles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
        extension_prompt_types: { NONE: -1, IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 },
        create_save: jest.fn(),
        createOrEditCharacter: jest.fn(),
        name1: state.name1,
        name2: state.name2,
        online_status: state.online_status,
        getOneCharacter: jest.fn(async () => {}),
        select_selected_character: jest.fn(),
        getEntitiesList: jest.fn(() => []),
    };

    const popupMock = {
        POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null, CUSTOM1: 2, CUSTOM2: 3 },
        POPUP_TYPE: { TEXT: 1, CONFIRM: 2, INPUT: 3, DISPLAY: 4 },
        callGenericPopup: jest.fn(async () => 1),
        Popup: Object.assign(
            jest.fn(function () {
                this.dlg = typeof document !== 'undefined' ? document.createElement('div') : { querySelector: () => null };
                this.okButton = { style: {} };
                this.inputResults = new Map();
                this.show = jest.fn(async () => 1);
            }),
            {
                show: {
                    confirm: jest.fn(async () => 1),
                    input: jest.fn(async () => 'Renamed'),
                    text: jest.fn(async () => 1),
                },
            },
        ),
    };

    const utilsMock = {
        download: jest.fn(),
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
        cancelDebounce: jest.fn(fn => fn?.cancel?.()),
        initScrollHeight: jest.fn(),
        resetScrollHeight: jest.fn(async () => {}),
        parseJsonFile: jest.fn(async file => JSON.parse(await file.text())),
        extractDataFromPng: jest.fn(),
        getFileBuffer: jest.fn(),
        getCharaFilename,
        getSortableDelay: jest.fn(() => 0),
        escapeRegex: value => String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        PAGINATION_TEMPLATE: '',
        navigation_option: { none: -2000, previous: -1000 },
        waitUntilCondition: jest.fn(async () => {}),
        isTrueBoolean: val => ['true', 'on', '1', 'yes'].includes(String(val).toLowerCase()),
        isFalseBoolean: val => ['false', 'off', '0', 'no'].includes(String(val).toLowerCase()),
        setValueByPath: lodash.set,
        flashHighlight: jest.fn(),
        select2ModifyOptions: jest.fn(),
        getSelect2OptionId: value => String(value ?? ''),
        dynamicSelect2DataViaAjax: jest.fn(() => ({})),
        highlightRegex: value => String(value ?? ''),
        select2ChoiceClickSubscribe: jest.fn(),
        getSanitizedFilename: jest.fn(async name => String(name ?? '').replace(/[/?]/g, '')),
        checkOverwriteExistingData: jest.fn(async () => true),
        getStringHash: value => [...String(value ?? '')].reduce((hash, char) => ((hash << 5) - hash + char.charCodeAt(0)) | 0, 0),
        parseStringArray: value => (Array.isArray(value) ? value : []),
        findChar: jest.fn(),
        onlyUnique: (value, index, self) => self.indexOf(value) === index,
        equalsIgnoreCaseAndAccents: (a, b) => String(a ?? '').localeCompare(String(b ?? ''), undefined, { sensitivity: 'base' }) === 0,
        includesIgnoreCaseAndAccents: (a, b) => String(a ?? '').toLowerCase().includes(String(b ?? '').toLowerCase()),
        uuidv4: jest.fn(() => '00000000-0000-4000-8000-000000000000'),
        normalizeArray: value => (Array.isArray(value) ? value : [value]),
        getUniqueName: jest.fn(name => name),
        logSlashCommandWarn: jest.fn(),
        addLongPressEvent: jest.fn(),
        escapeHtml: value => String(value ?? ''),
        regexFromString: jest.fn(() => null),
    };

    const authorsNoteMock = {
        NOTE_MODULE_NAME: options.noteModuleName ?? 'note',
        shouldWIAddPrompt: options.shouldWIAddPrompt ?? true,
        getAuthorsNotePosition: jest.fn(() => options.authorsNotePosition ?? 1),
        getAuthorsNoteDepth: jest.fn(() => options.authorsNoteDepth ?? 4),
        getAuthorsNoteRole: jest.fn(() => options.authorsNoteRole ?? 0),
    };

    const slashCommands = [];
    const accountStorage = {
        getItem: jest.fn(key => (state.storage.has(key) ? state.storage.get(key) : null)),
        setItem: jest.fn((key, value) => state.storage.set(key, String(value))),
        removeItem: jest.fn(key => state.storage.delete(key)),
    };

    const sidePanelsMock = {
        closeAuthorsNotePanel: jest.fn(),
        refreshAuthorsNotePanel: jest.fn(),
        registerAuthorsNotePanel: jest.fn(),
        toggleAuthorsNotePanel: jest.fn(),
    };

    const groupChatsMock = {
        getGroupMembers: jest.fn(() => []),
        getSelectedGroupSpeakerAvatar: jest.fn(() => null),
        selected_group: state.selected_group,
    };

    const macrosMock = {
        macros: { register: jest.fn() },
        MacroCategory: { MISC: 'misc', PROMPTS: 'prompts' },
    };

    const powerUserMock = {
        power_user: state.power_user,
        context_presets: [],
        fuzzySearchCharacters: jest.fn(() => []),
        fuzzySearchGroups: jest.fn(() => []),
        fuzzySearchPersonas: jest.fn(() => []),
        fuzzySearchTags: jest.fn(() => []),
        fuzzySearchWorldInfo: jest.fn(() => []),
    };

    const renderTemplateAsync = jest.fn(async () => '<div></div>');

    await jest.unstable_mockModule(pub('lib.js'), () => ({
        Fuse: createFakeFuse(),
        lodash,
    }));
    await jest.unstable_mockModule(pub('script.js'), () => scriptMock);
    await jest.unstable_mockModule(pub('scripts/utils.js'), () => utilsMock);
    await jest.unstable_mockModule(pub('scripts/extensions.js'), () => ({
        extension_settings: state.extension_settings,
        getContext,
        saveMetadataDebounced: jest.fn(),
    }));
    await jest.unstable_mockModule(pub('scripts/RossAscends-mods.js'), () => ({
        isMobile: jest.fn(() => false),
    }));
    await jest.unstable_mockModule(pub('scripts/tokenizers.js'), () => ({
        getTokenCountAsync,
    }));
    await jest.unstable_mockModule(pub('scripts/power-user.js'), () => powerUserMock);
    await jest.unstable_mockModule(pub('scripts/tags.js'), () => ({
        getTagKeyForEntity,
        tag_map: state.tagMap,
    }));
    await jest.unstable_mockModule(pub('scripts/extensions/regex/engine.js'), () => ({
        getRegexedString,
        regex_placement: { WORLD_INFO: 5 },
    }));
    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandParser.js'), () => ({
        SlashCommandParser: {
            addCommandObject: jest.fn(cmd => slashCommands.push(cmd)),
        },
    }));
    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommand.js'), () => ({
        SlashCommand: { fromProps: jest.fn(props => props) },
    }));
    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandArgument.js'), () => ({
        ARGUMENT_TYPE: { STRING: 'string', NUMBER: 'number', BOOLEAN: 'boolean', LIST: 'list', CLOSURE: 'closure' },
        SlashCommandArgument: class SlashCommandArgument {
            constructor(...args) { this.args = args; }
            static fromProps(props) { return props; }
        },
        SlashCommandNamedArgument: class SlashCommandNamedArgument {
            constructor(...args) { this.args = args; }
            static fromProps(props) { return props; }
        },
    }));
    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandEnumValue.js'), () => ({
        SlashCommandEnumValue: class SlashCommandEnumValue {
            constructor(...args) { this.args = args; }
        },
        enumTypes: { enum: 'enum', name: 'name', command: 'command' },
    }));
    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandCommonEnumsProvider.js'), () => ({
        commonEnumProviders: new Proxy({}, {
            get(_target, prop) {
                if (prop === 'boolean') {
                    return () => () => [];
                }
                return () => [];
            },
        }),
        enumIcons: new Proxy({}, {
            get(_target, prop) {
                if (prop === 'getDataTypeIcon') {
                    return () => '';
                }
                return '';
            },
        }),
    }));
    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandClosure.js'), () => ({
        SlashCommandClosure: class SlashCommandClosure {},
    }));
    await jest.unstable_mockModule(pub('scripts/popup.js'), () => popupMock);
    await jest.unstable_mockModule(pub('scripts/templates.js'), () => ({
        renderTemplateAsync,
    }));
    await jest.unstable_mockModule(pub('scripts/i18n.js'), () => ({
        t: defaultTagFunction,
    }));
    await jest.unstable_mockModule(pub('scripts/util/AccountStorage.js'), () => ({
        accountStorage,
    }));
    await jest.unstable_mockModule(pub('scripts/personas.js'), () => ({
        getOrCreatePersonaDescriptor: jest.fn(() => ({})),
        setPersonaDescription: jest.fn(),
        user_avatar: state.user_avatar,
    }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-editor/banner.js'), () => ({
        createBanner: jest.fn(() => ({
            element: typeof document !== 'undefined' ? document.createElement('div') : {},
            setTitle: jest.fn(),
            show: jest.fn(),
            hide: jest.fn(),
        })),
    }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-editor/adapters/preset-lorebook-dialogs.js'), () => ({
        embeddedLorebookOptions: jest.fn(() => ({})),
        lorebookSelectOptions: jest.fn(() => ({})),
        lorebookSortingOptions: jest.fn(() => ({})),
    }));

    if (options.worldInfoEditorMock) {
        await jest.unstable_mockModule(pub('scripts/sillybunny-world-info-editor.js'), () => options.worldInfoEditorMock);
    }

    if (options.useRealAuthorsNote) {
        await jest.unstable_mockModule(pub('scripts/sillybunny-editor/adapters/side-panels.js'), () => sidePanelsMock);
        await jest.unstable_mockModule(pub('scripts/group-chats.js'), () => groupChatsMock);
        await jest.unstable_mockModule(pub('scripts/macros/macro-system.js'), () => macrosMock);
        await jest.unstable_mockModule(pub('scripts/macros.js'), () => ({
            MacrosParser: { registerMacro: jest.fn() },
        }));
    } else {
        await jest.unstable_mockModule(pub('scripts/authors-note.js'), () => authorsNoteMock);
    }

    if (options.fetch) {
        globalThis.fetch = options.fetch;
    } else if (state.books) {
        globalThis.fetch = jest.fn(async (url, init) => {
            if (url === '/api/worldinfo/get') {
                const { name } = JSON.parse(init.body);
                const book = state.books[name] ?? null;
                return { ok: Boolean(book), json: async () => structuredClone(book) };
            }
            if (url === '/api/settings/get') {
                return { ok: true, json: async () => ({ world_names: Object.keys(state.books) }) };
            }
            return { ok: false, status: 404, json: async () => ({}) };
        });
    }

    const authorsNote = options.useRealAuthorsNote
        ? await import('../../public/scripts/authors-note.js')
        : authorsNoteMock;
    const worldInfo = options.skipWorldInfo
        ? null
        : await import('../../public/scripts/world-info.js');

    return {
        worldInfo,
        authorsNote,
        $,
        state,
        mocks: {
            script: scriptMock,
            eventSource,
            setExtensionPrompt,
            getContext,
            getTokenCountAsync,
            getRegexedString,
            substituteParams,
            getCharaFilename,
            getTagKeyForEntity,
            getExtensionPromptByName,
            utils: utilsMock,
            popup: popupMock,
            toastr,
            accountStorage,
            renderTemplateAsync,
            slashCommands,
            sidePanels: sidePanelsMock,
            groupChats: groupChatsMock,
            powerUser: powerUserMock,
        },
    };
}
