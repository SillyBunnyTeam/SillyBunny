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
    if (typeof globalThis.window !== 'undefined' && typeof globalThis.window.matchMedia !== 'function') {
        globalThis.window.matchMedia = () => ({
            matches: false,
            media: '',
            addEventListener() {},
            removeEventListener() {},
        });
    }
}

ensureJsdomGlobals();

function loadJQuery() {
    if (typeof globalThis.window === 'undefined') {
        throw new Error('importTagsModule requires a jsdom test environment.');
    }
    if (!globalThis.window.jQuery) {
        (0, eval)(cachedJQuerySource);
    }
    const $ = globalThis.window.jQuery;
    if ($.fx) $.fx.off = true;
    // Provide minimal jQuery UI / select2 stubs for tag input and merge-select setup.
    if (!$.fn.select2) {
        $.fn.select2 = function select2() { return this; };
    }
    if (!$.fn.autocomplete) {
        $.fn.autocomplete = function autocomplete() { return this; };
    }
    if (!$.fn.sortable) {
        $.fn.sortable = function sortable() { return this; };
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
 * Imports the real `public/scripts/tags.js` inside jsdom.
 * Mount any `#tag_template` markup before calling this helper because `tags.js` captures template nodes at load time.
 * @param {object} [options]
 */
export async function importTagsModule(options = {}) {
    jest.resetModules();
    ensureJsdomGlobals();
    const $ = loadJQuery();

    if (!document.getElementById('tag_template')) {
        document.body.insertAdjacentHTML('beforeend', `
            <div id="tag_template" hidden><span class="tag"><span class="tag_name"></span><span class="tag_remove"></span></span></div>
            <div id="bogus_folder_template" hidden><div class="bogus_folder_select"><span class="avatar"></span></div></div>
            <div id="tag_view_template" hidden><div class="tag_view_item"><span class="tag_view_name"></span></div></div>
        `);
    }

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
    const event_types = {
        CHARACTER_DELETED: 'character_deleted',
        CHARACTER_DUPLICATED: 'character_duplicated',
        CHARACTER_RENAMED: 'character_renamed',
        CHARACTER_EDITED: 'character_edited',
        CHAT_CHANGED: 'chat_id_changed',
        ...(options.event_types ?? {}),
    };

    const state = {
        characters: options.characters ?? [],
        groups: options.groups ?? [],
        selected_group: options.selected_group ?? null,
        this_chid: options.this_chid,
        menu_type: options.menu_type ?? '',
        power_user: options.power_user ?? {
            tag_sort_mode: 'manual',
            bogus_folders: false,
            main_text_color: 'white',
            tag_filter_mode: 0,
        },
        storage: new Map(Object.entries(options.accountStorage ?? {})),
    };

    const utilsMock = {
        download: jest.fn(),
        onlyUnique: (value, index, array) => array.indexOf(value) === index,
        parseJsonFile: jest.fn(async () => ({})),
        uuidv4: jest.fn(() => `uuid-${++uuidCounter}`),
        flashHighlight: jest.fn(),
        equalsIgnoreCaseAndAccents: (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase(),
        includesIgnoreCaseAndAccents: (a, b) => String(a ?? '').toLowerCase().includes(String(b ?? '').toLowerCase()),
        removeFromArray: (array, item) => {
            const index = array.indexOf(item);
            if (index >= 0) array.splice(index, 1);
        },
        getFreeName: jest.fn(name => name),
        findChar: jest.fn(),
        escapeHtml: value => String(value ?? ''),
        ...(options.utils ?? {}),
    };

    let uuidCounter = 0;

    await jest.unstable_mockModule(pub('lib.js'), () => ({
        DOMPurify: { sanitize: value => String(value ?? '') },
    }));
    await jest.unstable_mockModule(pub('scripts/utils.js'), () => utilsMock);
    await jest.unstable_mockModule(pub('scripts/power-user.js'), () => ({
        power_user: state.power_user,
        fuzzySearchCharacters: jest.fn(() => []),
        fuzzySearchGroups: jest.fn(() => []),
        fuzzySearchPersonas: jest.fn(() => []),
        fuzzySearchTags: jest.fn(() => []),
        fuzzySearchWorldInfo: jest.fn(() => []),
    }));

    const makeDefaultFilterHelper = () => ({
        getFilterData: jest.fn(() => ({ selected: [], excluded: [] })),
        setFilterData: jest.fn(),
        applyFilters: jest.fn(list => list),
        getScore: jest.fn(() => 0),
    });
    const entitiesFilter = options.entitiesFilter ?? makeDefaultFilterHelper();
    const groupCandidatesFilter = options.groupCandidatesFilter ?? makeDefaultFilterHelper();
    const groupMembersFilter = options.groupMembersFilter ?? makeDefaultFilterHelper();

    const accountStorage = {
        getItem: jest.fn(key => (state.storage.has(key) ? state.storage.get(key) : null)),
        setItem: jest.fn((key, value) => state.storage.set(key, String(value))),
        removeItem: jest.fn(key => state.storage.delete(key)),
    };

    const scriptMock = {
        characters: state.characters,
        saveSettingsDebounced: jest.fn(),
        this_chid: state.this_chid,
        menu_type: state.menu_type,
        entitiesFilter,
        printCharactersDebounced: jest.fn(),
        buildAvatarList: jest.fn(),
        eventSource,
        event_types,
        DEFAULT_PRINT_TIMEOUT: 0,
        printCharacters: jest.fn(async () => {}),
        getThumbnailUrlForViewport: jest.fn((type, file) => `/thumbnail?type=${type}&file=${encodeURIComponent(file)}`),
        default_avatar: 'img/ai4.png',
        ...(options.script ?? {}),
    };

    const popupResult = { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null };
    const popupType = { TEXT: 1, CONFIRM: 2, INPUT: 3, DISPLAY: 4 };
    const callGenericPopup = jest.fn(async () => popupResult.AFFIRMATIVE);
    const PopupMock = jest.fn().mockImplementation(function (content, type, inputValue, popupOptions) {
        this.content = content;
        this.type = type;
        this.inputValue = inputValue;
        this.options = popupOptions;
        this.show = jest.fn(async () => popupResult.AFFIRMATIVE);
    });
    PopupMock.show = { confirm: jest.fn(async () => popupResult.AFFIRMATIVE) };

    const openTagManager = jest.fn(async () => {});
    const refreshTagManager = jest.fn();
    const updateTagColors = jest.fn();
    const openAlert = jest.fn(async () => 'delete');
    const renderTemplateAsync = jest.fn(async (name, data = {}) => {
        if (name === 'deleteTag') {
            const optionsHtml = (data.otherTags ?? [])
                .map(tag => `<option value="${tag.id}">${tag.name}</option>`)
                .join('');
            return `<div><h3>Delete Tag</h3><div id="tag_to_delete"></div><select id="merge_tag_select"><option value="">None</option>${optionsHtml}</select></div>`;
        }
        return '<div></div>';
    });

    const mocks = {
        script: scriptMock,
        utils: utilsMock,
        toastr,
        accountStorage,
        callGenericPopup,
        Popup: PopupMock,
        openTagManager,
        refreshTagManager,
        updateTagColors,
        openAlert,
        renderTemplateAsync,
        entitiesFilter,
        groupCandidatesFilter,
        groupMembersFilter,
        isMobile: jest.fn(() => Boolean(options.isMobile)),
    };

    await jest.unstable_mockModule(pub('script.js'), () => scriptMock);
    await jest.unstable_mockModule(pub('scripts/group-chats.js'), () => ({
        groupCandidatesFilter,
        groupMembersFilter,
        groups: state.groups,
        selected_group: state.selected_group,
        getGroupAvatarElement: jest.fn(() => $('<div></div>')),
    }));
    await jest.unstable_mockModule(pub('scripts/RossAscends-mods.js'), () => ({ isMobile: mocks.isMobile }));
    await jest.unstable_mockModule(pub('scripts/popup.js'), () => ({
        POPUP_RESULT: popupResult,
        POPUP_TYPE: popupType,
        Popup: PopupMock,
        callGenericPopup,
        ...(options.popup ?? {}),
    }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-delete-confirm.js'), () => ({
        confirmVerb: jest.fn(async () => true),
    }));
    await jest.unstable_mockModule(pub('scripts/keyboard.js'), () => ({
        INTERACTABLE_CONTROL_CLASS: 'interactable',
    }));
    await jest.unstable_mockModule(pub('scripts/templates.js'), () => ({
        renderTemplateAsync,
        ...(options.templates ?? {}),
    }));
    await jest.unstable_mockModule(pub('scripts/i18n.js'), () => ({
        t: (strings, ...values) => strings.reduce((out, part, index) => out + part + (values[index] ?? ''), ''),
        translate: text => text,
    }));
    await jest.unstable_mockModule(pub('scripts/util/AccountStorage.js'), () => ({ accountStorage }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-motion.js'), () => ({
        animateHeightFrom: jest.fn(),
        animateIn: jest.fn(),
        fadeOutAndRemove: jest.fn(el => el?.remove?.()),
    }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-tag-manager.js'), () => ({
        openTagManager,
        refreshTagManager,
        updateTagColors,
        ...(options.tagManager ?? {}),
    }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-editor/dialog.js'), () => ({
        openAlert,
        ...(options.dialog ?? {}),
    }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-editor/rows.js'), () => ({
        createPrefGroup: jest.fn(({ rows = [] }) => {
            const section = document.createElement('section');
            for (const row of rows) section.append(row);
            return { section };
        }),
    }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-editor/select-row.js'), () => ({
        createSelectRow: jest.fn(({ select }) => {
            const wrapper = document.createElement('div');
            if (select) wrapper.append(select);
            return wrapper;
        }),
    }));

    const enumProxy = new Proxy({}, { get: () => jest.fn(() => []) });
    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommand.js'), () => ({
        SlashCommand: { fromProps: jest.fn(props => props) },
    }));
    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandArgument.js'), () => ({
        ARGUMENT_TYPE: { STRING: 'string', NUMBER: 'number', BOOLEAN: 'boolean', LIST: 'list' },
        SlashCommandArgument: { fromProps: jest.fn(props => props) },
        SlashCommandNamedArgument: { fromProps: jest.fn(props => props) },
    }));
    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandCommonEnumsProvider.js'), () => ({
        commonEnumProviders: enumProxy,
    }));
    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandEnumValue.js'), () => ({
        SlashCommandEnumValue: class { constructor(value) { this.value = value; } },
        enumTypes: { enum: 'enum', name: 'name', command: 'command' },
    }));
    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandParser.js'), () => ({
        SlashCommandParser: { addCommandObject: jest.fn(), commands: {} },
    }));

    const tagsModule = await import('../../public/scripts/tags.js');
    const filters = await import('../../public/scripts/filters.js');
    return {
        tagsModule,
        filters,
        $,
        state,
        eventSource,
        event_types,
        mocks,
    };
}
