/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect -- Jest's test.each assertions run inside test callbacks. */
import { jest, describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';

await import('../../public/lib/jquery-3.5.1.min.js');
const $ = window.jQuery;

const FILTER_TYPES = Object.freeze({
    SEARCH: 'search',
    TAG: 'tag',
    FOLDER: 'folder',
    FAV: 'fav',
    GROUP: 'group',
    WORLD_INFO_SEARCH: 'world_info_search',
    PERSONA_SEARCH: 'persona_search',
});
const filterData = {
    search: '',
    tag: { excluded: [], selected: [] },
    folder: false,
    fav: false,
    group: false,
    world_info_search: '',
    persona_search: '',
};
const accountItems = new Map();
const accountStorage = {
    getItem: key => accountItems.get(key) ?? null,
    setItem: (key, value) => accountItems.set(key, String(value)),
};
const entitiesFilter = {
    getFilterData: type => filterData[type],
    setFilterData: (type, value) => { filterData[type] = value; },
    clearFuzzySearchCaches: jest.fn(),
};
const setCharacterMenuEntityView = jest.fn();
const printCharacters = jest.fn(async () => {});
const setMainListFilterStoragePrefix = jest.fn();
const loadMainListFilterStates = jest.fn(view => {
    if (view === 'groups') {
        filterData.search = '';
        filterData.fav = 'SELECTED';
        filterData.group = 'EXCLUDED';
        filterData.tag = { excluded: ['group-excluded'], selected: ['group-tag'] };
    }
});

await jest.unstable_mockModule('../../public/scripts/util/AccountStorage.js', () => ({ accountStorage }));
await jest.unstable_mockModule('../../public/scripts/filters.js', () => ({ FILTER_TYPES }));
await jest.unstable_mockModule('../../public/script.js', () => ({
    entitiesFilter,
    setCharacterMenuEntityView,
    printCharacters,
}));
await jest.unstable_mockModule('../../public/scripts/tags.js', () => ({
    setMainListFilterStoragePrefix,
    loadMainListFilterStates,
}));

const {
    getCharacterListView,
    getListPage,
    getListPageSize,
    getListSort,
    getListSortOptions,
    recordListPage,
    resetListPage,
    registerCharacterListSortAccessors,
    registerCharacterListStateRenderer,
    setListPage,
    setListPageSize,
    setListSort,
    switchCharacterListView,
} = await import('../../public/scripts/sillybunny-character-list-state.js');

describe('character list state', () => {
    test('keeps independent filter snapshots, search, sort, and paging per view', async () => {
        document.body.innerHTML = `
            <input id="character_search_bar" value="copper">
            <select id="character_sort_order">
                <option data-field="search" data-order="desc" hidden>Search</option>
                <option data-field="name" data-order="asc" data-i18n="A-Z">A-Z</option>
                <option data-field="name" data-order="desc" data-i18n="Z-A">Z-A</option>
                <option data-field="create_date" data-order="desc" data-i18n="Newest">Newest</option>
                <option data-field="date_added" data-order="desc" data-i18n="Date added">Date added</option>
                <option data-field="fav" data-order="desc" data-rule="boolean" data-i18n="Favorites">Favorites</option>
                <option data-field="date_last_chat" data-order="desc" data-i18n="Recent">Recent</option>
                <option data-field="chat_size" data-order="desc" data-i18n="Most chats">Most chats</option>
                <option data-field="data_size" data-order="desc" data-i18n="Most tokens">Most tokens</option>
                <option data-field="name" data-order="random" data-i18n="Random">Random</option>
            </select>
        `;
        accountItems.clear();
        accountItems.set('Characters_PerPage', '25');
        filterData.search = 'debounce pending';
        filterData.fav = 'UNDEFINED';
        filterData.group = 'UNDEFINED';
        filterData.tag = { excluded: [], selected: ['character-tag'] };
        const originalCharacterTagFilter = filterData.tag;
        let characterSort = { field: 'name', order: 'desc', rule: null };
        const render = jest.fn(async () => {});
        registerCharacterListSortAccessors({
            read: () => characterSort,
            write: sort => { characterSort = sort; },
        });
        registerCharacterListStateRenderer(render);

        expect(getCharacterListView()).toBe('characters');
        expect(getListPageSize('characters')).toBe(25);
        expect(getListPageSize('groups')).toBe(50);
        expect(getListSort('characters')).toEqual(characterSort);
        expect(getListSort('groups')).toEqual({ field: 'name', order: 'asc' });

        const groupOptions = getListSortOptions('groups');
        expect(groupOptions.map(option => option.field)).not.toContain('search');
        expect(groupOptions.map(option => option.field)).not.toContain('data_size');
        expect(groupOptions.find(option => option.field === 'fav').i18nKey).toBe('Favorites');

        await switchCharacterListView('groups');
        expect(getCharacterListView()).toBe('groups');
        expect(setCharacterMenuEntityView).toHaveBeenLastCalledWith('groups');
        expect(setMainListFilterStoragePrefix).toHaveBeenLastCalledWith('GroupList');
        expect(loadMainListFilterStates).toHaveBeenLastCalledWith('groups');
        expect(document.getElementById('character_search_bar').value).toBe('');
        expect(filterData.tag).toEqual({ excluded: ['group-excluded'], selected: ['group-tag'] });
        expect(filterData.group).toBe('EXCLUDED');

        document.getElementById('character_search_bar').value = 'violet';
        filterData.tag = { excluded: ['group-only'], selected: ['another-group-tag'] };
        await setListSort('groups', { field: 'chat_size', order: 'desc' });
        expect(getListSort('groups')).toEqual({ field: 'chat_size', order: 'desc' });
        expect(JSON.parse(accountItems.get('GroupList_SortOrder'))).toEqual({ field: 'chat_size', order: 'desc' });
        expect(render).toHaveBeenCalledTimes(1);
        setListPageSize('groups', 100);
        setListPage('groups', 3);
        expect(getListPageSize('groups')).toBe(100);
        expect(getListPage('groups')).toBe(3);

        await switchCharacterListView('characters');
        expect(document.getElementById('character_search_bar').value).toBe('copper');
        expect(filterData.search).toBe('copper');
        expect(filterData.tag).toEqual({ excluded: [], selected: ['character-tag'] });
        expect(filterData.tag).not.toBe(originalCharacterTagFilter);
        expect(characterSort).toEqual({ field: 'name', order: 'desc', rule: null });
        expect(getListPage('groups')).toBe(3);

        await switchCharacterListView('groups');
        expect(document.getElementById('character_search_bar').value).toBe('violet');
        expect(filterData.tag).toEqual({ excluded: ['group-only'], selected: ['another-group-tag'] });
        expect(getListSort('groups')).toEqual({ field: 'chat_size', order: 'desc' });
        expect(entitiesFilter.clearFuzzySearchCaches).toHaveBeenCalledTimes(3);
        expect(printCharacters).toHaveBeenCalledTimes(3);

        recordListPage('groups', 4);
        expect(getListPage('groups')).toBe(4);
        resetListPage('groups');
        expect(getListPage('groups')).toBe(1);
    });

    test('persists size without re-entering a paginator before its state changes', async () => {
        const render = jest.fn();
        registerCharacterListStateRenderer(render);
        setListPageSize('groups', 250);
        expect(render).not.toHaveBeenCalled();
        await setListPage('groups', 1);
        expect(render).toHaveBeenCalledTimes(1);
        expect(accountItems.get('Groups_PerPage')).toBe('250');
        await setListPage('characters', 2);
        expect(render).toHaveBeenCalledTimes(1);
    });

    test('rejects invalid state at the API boundary and ignores corrupt persisted settings', () => {
        expect(() => getListPage('unknown')).toThrow('Invalid character list view');
        expect(() => setListPage('groups', 0)).toThrow('Invalid character list page');
        expect(() => setListPageSize('groups', 1.5)).toThrow('Invalid character list page size');
        expect(() => setListSort('groups', { field: 'data_size', order: 'desc' })).toThrow('Invalid group list sort');
        expect(() => setListSort('groups', { field: 'name', order: 'sideways' })).toThrow('Invalid group list sort');
        for (const stored of ['not-json', 'null', '{"field":"data_size","order":"desc"}']) {
            accountItems.set('GroupList_SortOrder', stored);
            expect(getListSort('groups')).toEqual({ field: 'name', order: 'asc' });
        }
        accountItems.set('Groups_PerPage', '-1');
        expect(getListPageSize('groups')).toBe(50);
    });

    test('a superseded view switch cannot restore its filters or render', async () => {
        const before = printCharacters.mock.calls.length;
        const older = switchCharacterListView('characters');
        const current = switchCharacterListView('groups');
        await Promise.all([older, current]);
        expect(getCharacterListView()).toBe('groups');
        expect(printCharacters.mock.calls.length).toBe(before + 1);
    });
});

const FILTER_STATES = {
    SELECTED: { key: 'SELECTED', class: 'selected' },
    EXCLUDED: { key: 'EXCLUDED', class: 'excluded' },
    UNDEFINED: { key: 'UNDEFINED', class: 'undefined' },
};
const sources = new Map();

function loadSourceFunctions(path, names, overrides = {}) {
    if (!sources.has(path)) {
        const source = readFileSync(new URL(`../../public/${path}`, import.meta.url), 'utf8');
        const declarations = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }).body.map(node => node.declaration ?? node);
        sources.set(path, { source, declarations });
    }
    const { source, declarations } = sources.get(path);
    const context = vm.createContext({ document, $, FILTER_TYPES, FILTER_STATES, ...overrides });
    const bodies = names.map(name => {
        const declaration = declarations.find(node => node.id?.name === name || node.declarations?.some(item => item.id.name === name));
        if (!declaration) throw new Error(`Missing ${path} declaration: ${name}`);
        return source.slice(declaration.start, declaration.end);
    });
    vm.runInContext(`${bodies.join('\n')}\nthis.api = { ${names.join(', ')} };`, context);
    return context;
}

function createStoredSession({ captureSnapshot, restoreSnapshot, persist, prefix }) {
    const clone = value => JSON.parse(JSON.stringify(value));
    const { createEditorSession } = loadSourceFunctions('scripts/sillybunny-editor/session.js', [
        'DIRTY_DEBOUNCE_MS', 'DRAFT_INTERVAL_MS', 'createEditorSession',
    ], { structuredClone: clone }).api;
    const { createEditorDraftStore } = loadSourceFunctions('scripts/sillybunny-editor/drafts.js', ['createEditorDraftStore'], { localStorage }).api;
    const drafts = createEditorDraftStore({ keyFor: id => `${prefix}default-${id}` });
    const session = createEditorSession({
        captureSnapshot,
        restoreSnapshot,
        persist,
        drafts,
        timers: { setTimeout, clearTimeout, setInterval: () => 1, clearInterval: () => {} },
    });
    return { session, drafts, clone };
}

const filterApi = loadSourceFunctions('scripts/filters.js', ['isFilterState', 'fuzzySearchCategories', 'FilterHelper'], {
    power_user: { fuzzy_search: false },
    tag_map: {},
}).api;
const t = (strings, ...values) => strings.reduce((text, part, index) => text + part + (values[index] ?? ''), '');

describe('upstream main-list renderer boundary', () => {
    function setup() {
        document.body.innerHTML = '<div id="rm_print_characters_block"></div><div id="rm_print_characters_pagination"></div>';
        const pagination = jest.fn();
        $.fn.pagination = pagination;
        const helper = new filterApi.FilterHelper(jest.fn());
        const context = loadSourceFunctions('script.js', [
            'setCharacterListRenderer', 'printCharacters', 'getEntitiesList',
            'characterToEntity', 'groupToEntity', 'tagToEntity', 'entityMatchesCharacterMenuView',
        ], {
            structuredClone: data => JSON.parse(JSON.stringify(data)),
            characters: [{ name: 'Zebra', avatar: 'z.png' }, { name: 'Alice', avatar: 'a.png' }],
            groups: [{ id: 'g1', name: 'Group', members: [] }],
            tags: [{ id: 'folder', name: 'Folder' }],
            characterMenuEntityView: 'characters',
            characterListRenderer: null,
            saveCharactersPage: 3,
            power_user: { bogus_folders: true },
            entitiesFilter: helper,
            isFilterState: filterApi.isFilterState,
            filterByTagState: (entities, options) => options?.subForEntity ? entities.filter(entity => entity.type !== 'tag') : entities,
            isBogusFolder: () => true,
            compareTagsForSort: () => 0,
            sortEntitiesList: jest.fn(entities => entities.sort((a, b) => a.item.name.localeCompare(b.item.name))),
            getListSort: () => ({ field: 'name', order: 'asc' }),
            verifyCharactersSearchSortRule: jest.fn(),
            printTagFilters: jest.fn(),
            tag_filter_type: { character: 0, group_members_list: 2, group_candidates_list: 1 },
            applyTagsOnCharacterSelect: jest.fn(),
            applyTagsOnGroupSelect: jest.fn(),
            isBogusFolderOpen: () => true,
            favsToHotswap: jest.fn(),
            updatePersonaConnectionsAvatarList: jest.fn(),
            accountStorage: { getItem: () => '25', setItem: jest.fn() },
            per_page_default: 50,
            PAGINATION_TEMPLATE: 'pagination',
            renderPaginationDropdown: () => 'dropdown',
            paginationDropdownChangeHandler: jest.fn(),
            recordListPage: jest.fn(),
            resetListPage: jest.fn(),
            delay: jest.fn(async () => {}),
            eventSource: { emit: jest.fn() },
            event_types: { CHARACTER_PAGE_LOADED: 'page-loaded' },
            getBackBlock: () => $('<div class="back"></div>'),
            getCharacterBlock: (item, id) => $(`<div class="character_select" data-chid="${id}"></div>`),
            getGroupBlock: () => $('<div class="group_select"></div>'),
            getTagBlock: () => $('<div class="bogus_folder_select"></div>'),
            getHiddenBlock: async () => $('<div class="hidden-count"></div>'),
            getEmptyBlock: async () => $('<div class="empty"></div>'),
            localizePagination: jest.fn(),
        });
        return { context, pagination, helper };
    }

    test('renderer receives the same sorted, folder-adjusted entities as legacy pagination', async () => {
        const { context, pagination } = setup();
        await context.api.printCharacters();
        const legacy = pagination.mock.calls[0][0];
        expect(legacy.pageSize).toBe(25);
        expect(legacy.pageNumber).toBe(3);
        const render = jest.fn();
        context.api.setCharacterListRenderer({ render });
        await context.api.printCharacters(true);
        const model = render.mock.calls[0][0];
        expect(model.entities).toEqual(legacy.dataSource);
        expect(model.entities.map(entity => entity.type)).toEqual(['character', 'tag', 'character']);
        expect(model.entities.find(entity => entity.type === 'tag').entities).toHaveLength(2);
        expect(model).toMatchObject({ view: 'characters', sourceCount: 2, hasAnyFilter: false, folderOpen: true, fullRefresh: true });
        expect(context.resetListPage).toHaveBeenCalledWith('characters');
        expect(context.printTagFilters).toHaveBeenCalledTimes(2);
        expect(context.applyTagsOnCharacterSelect).toHaveBeenCalledTimes(2);
        expect(context.applyTagsOnGroupSelect).toHaveBeenCalledTimes(2);
        expect(context.favsToHotswap).toHaveBeenCalledTimes(2);
        expect(context.updatePersonaConnectionsAvatarList).toHaveBeenCalledTimes(2);
        model.pageLoaded();
        model.pageLoaded();
        expect(context.eventSource.emit).toHaveBeenCalledTimes(2);
        context.api.setCharacterListRenderer(null);
        await context.api.printCharacters();
        expect(pagination).toHaveBeenCalledTimes(2);
        expect(render).toHaveBeenCalledTimes(1);
        await legacy.callback(legacy.dataSource);
        expect(document.querySelectorAll('.character_select')).toHaveLength(2);
        expect(document.querySelector('.back')).not.toBeNull();
        expect(context.eventSource.emit).toHaveBeenLastCalledWith('page-loaded');
        legacy.afterSizeSelectorChange({ target: { value: '100' } }, 100);
        expect(context.accountStorage.setItem).toHaveBeenCalledWith('Characters_PerPage', '100');
    });

    test.each(['SELECTED', 'EXCLUDED'])('GROUP %s is neutral in folders and main entities without mutating saved state', state => {
        const { context, helper } = setup();
        helper.setFilterData('group', state, true);
        const result = context.api.getEntitiesList({ doFilter: true, mainList: true });
        expect(result.filter(entity => entity.type !== 'tag')).toHaveLength(3);
        expect(result.find(entity => entity.type === 'tag').entities).toHaveLength(3);
        expect(helper.getFilterData('group')).toBe(state);
        const fallback = context.api.getEntitiesList({ doFilter: true });
        expect(fallback.filter(entity => entity.type !== 'tag').map(entity => entity.type)).toEqual(
            state === 'SELECTED' ? ['group'] : ['character', 'character'],
        );
    });

    test('search debounce cannot overwrite another view or a restored query after a round trip', () => {
        document.body.innerHTML = '<input id="character_search_bar"><button id="character_search_bar_search"></button>';
        let callback;
        const context = loadSourceFunctions('script.js', ['initCharacterSearch'], {
            debounce: fn => { callback = fn; return fn; },
            getCharacterListView: () => 'characters',
            entitiesFilter: { setFilterData: jest.fn() },
            eventSource: { on: jest.fn() },
            event_types: { APP_READY: 'app-ready' },
        });
        context.api.initCharacterSearch();
        const input = document.getElementById('character_search_bar');
        input.value = 'restored';
        callback('old', 'groups');
        callback('old', 'characters');
        expect(context.entitiesFilter.setFilterData).not.toHaveBeenCalled();
        callback('restored', 'characters');
        expect(context.entitiesFilter.setFilterData).toHaveBeenCalledWith('search', 'restored');
    });
});

describe('view-scoped upstream tag persistence', () => {
    function setup() {
        const helper = new filterApi.FilterHelper(jest.fn());
        const storage = new Map([
            ['CharacterList_TagFilterState_FAV', 'EXCLUDED'],
            ['CharacterList_tag_character', 'SELECTED'],
            ['GroupList_TagFilterState_FAV', 'SELECTED'],
            ['GroupList_tag_group', 'EXCLUDED'],
        ]);
        const context = loadSourceFunctions('scripts/tags.js', [
            'getFilterStorageKey', 'setMainListFilterStoragePrefix', 'loadMainListFilterStates',
            'loadFilterStatesForContext', 'isMainCharacterList', 'applyActionableTagFilter', 'onTagFilterClick',
        ], {
            entitiesFilter: helper,
            groupCandidatesFilter: {},
            groupMembersFilter: {},
            mainListFilterStoragePrefix: 'CharacterList',
            tags: [{ id: 'character', filter_state: 'SELECTED' }, { id: 'group', filter_state: 'UNDEFINED' }],
            accountStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
            ACTIONABLE_FILTER_STORAGE_KEYS: { FAV: 'TagFilterState_FAV', GROUP: 'TagFilterState_GROUP', FOLDER: 'TagFilterState_FOLDER' },
            toggleTagThreeState: () => 'EXCLUDED',
            getFilterHelper: () => helper,
            runTagFilters: jest.fn(),
            updateTagFilterIndicator: jest.fn(),
            saveSettingsDebounced: jest.fn(),
            setTimeout: jest.fn(),
            DEFAULT_PRINT_TIMEOUT: 0,
        });
        return { context, helper, storage };
    }

    test('real replacing loader clears absent states and never appends outgoing tag arrays', () => {
        const { context, helper } = setup();
        helper.setFilterData('tag', { selected: ['outgoing'], excluded: ['old'] }, true);
        helper.setFilterData('group', 'SELECTED', true);
        context.api.loadMainListFilterStates('groups');
        expect(helper.getFilterData('tag')).toEqual({ selected: [], excluded: ['group'] });
        expect(helper.getFilterData('fav')).toBe('SELECTED');
        expect(helper.getFilterData('group')).toBe(false);
        expect(context.api.getFilterStorageKey(helper)).toBe('GroupList');
        context.api.loadMainListFilterStates('characters');
        expect(helper.getFilterData('tag')).toEqual({ selected: ['character'], excluded: [] });
        expect(helper.getFilterData('fav')).toBe('EXCLUDED');
        expect(context.api.getFilterStorageKey(helper)).toBe('CharacterList');
    });

    test('Groups persist clicks independently and leave Characters compatibility metadata untouched', () => {
        const { context, helper, storage } = setup();
        const actionable = { filter_state: 'SELECTED' };
        context.api.setMainListFilterStoragePrefix('GroupList');
        context.api.applyActionableTagFilter.call($('<span>'), helper, actionable, 'fav', 'TagFilterState_FAV');
        expect(storage.get('GroupList_TagFilterState_FAV')).toBe('EXCLUDED');
        expect(actionable.filter_state).toBe('SELECTED');
        context.api.onTagFilterClick.call($('<span id="character">'), $('<div>'));
        expect(storage.get('GroupList_tag_character')).toBe('EXCLUDED');
        expect(context.tags[0].filter_state).toBe('SELECTED');
        expect(context.saveSettingsDebounced).not.toHaveBeenCalled();
        context.api.setMainListFilterStoragePrefix('CharacterList');
        context.api.onTagFilterClick.call($('<span id="character">'), $('<div>'));
        expect(storage.get('CharacterList_tag_character')).toBe('EXCLUDED');
        expect(context.tags[0].filter_state).toBe('EXCLUDED');
        expect(context.saveSettingsDebounced).toHaveBeenCalledTimes(1);
    });

    test('a group-only active tag remains visible beyond the 50-tag cutoff without legacy state', () => {
        document.body.innerHTML = '<div class="tags"></div>';
        const helper = new filterApi.FilterHelper(jest.fn());
        helper.setFilterData('tag', { selected: ['tag-59'], excluded: [] }, true);
        const tags = Array.from({ length: 60 }, (_, index) => ({ id: `tag-${index}`, filter_state: 'UNDEFINED' }));
        const appendTagToList = jest.fn();
        const context = loadSourceFunctions('scripts/tags.js', ['printTagList', 'determineTagFilterState'], {
            refreshTagManager: jest.fn(),
            getTagKey: () => null,
            expanded_tags_cache: [],
            getFilterHelper: () => helper,
            isFilterState: filterApi.isFilterState,
            DEFAULT_FILTER_STATE: 'UNDEFINED',
            isBogusFolder: () => false,
            appendTagToList,
            uuidv4: () => 'expander',
        });
        context.api.printTagList($('.tags'), { tags, empty: false, sort: false, tagOptions: { isGeneralList: true, isFilter: true } });
        const printedIds = appendTagToList.mock.calls.map(([, tag]) => tag.id);
        expect(printedIds).toContain('tag-59');
        expect(printedIds).not.toContain('tag-58');
        expect(tags[59].filter_state).toBe('UNDEFINED');
    });
});

describe('id-based list actions', () => {
    function groupPersistenceSetup(overrides = {}, extraFunctions = []) {
        const { debounce } = loadSourceFunctions('scripts/utils.js', ['debounceMap', 'debounce'], { setTimeout, clearTimeout }).api;
        return loadSourceFunctions('scripts/group-chats.js', ['_save', 'saveGroupDebounced', 'editGroup', 'toggleGroupFavoriteById', ...extraFunctions], {
            debounce,
            debounce_timeout: { relaxed: 1000 },
            groups: [{ id: 'g1', fav: false }, { id: 'g2', fav: false }],
            editorDraft: null,
            fetch: jest.fn(async () => ({ ok: true })),
            getRequestHeaders: () => ({}),
            getCharacters: jest.fn(),
            printCharactersDebounced: jest.fn(),
            favsToHotswap: jest.fn(),
            toastr: { error: jest.fn() },
            t,
            ...overrides,
        });
    }

    test('rapid group favorite toggles both persist through the real immediate/debounced save path', async () => {
        jest.useFakeTimers();
        try {
            const context = groupPersistenceSetup();
            await Promise.all([context.api.toggleGroupFavoriteById('g1'), context.api.toggleGroupFavoriteById('g2')]);
            await jest.runAllTimersAsync();
            expect(context.fetch.mock.calls.map(([url, request]) => [url, JSON.parse(request.body).id])).toEqual([
                ['/api/groups/edit', 'g1'], ['/api/groups/edit', 'g2'],
            ]);
        } finally {
            jest.useRealTimers();
        }
    });

    test.each(['http', 'network'])('a rejected %s group favorite save restores the live value, refreshes and reports the existing error', async failure => {
        jest.useFakeTimers();
        try {
            const fetch = failure === 'http'
                ? jest.fn(async () => ({ ok: false }))
                : jest.fn(async () => { throw new Error('Network failure'); });
            const context = groupPersistenceSetup({ fetch });
            await expect(context.api.toggleGroupFavoriteById('g1')).resolves.toBe(false);
            expect(context.groups[0].fav).toBe(false);
            expect(context.printCharactersDebounced).toHaveBeenCalled();
            expect(context.toastr.error).toHaveBeenCalledWith(
                'Check the server connection and reload the page to prevent data loss.', 'Group chat could not be saved',
            );
        } finally {
            jest.clearAllTimers();
            jest.useRealTimers();
        }
    });

    test('group favorite awaits the server acknowledgement before reporting success', async () => {
        let acknowledge;
        const response = new Promise(resolve => { acknowledge = resolve; });
        const context = groupPersistenceSetup({ fetch: jest.fn(() => response) });
        let completed = false;
        const toggling = context.api.toggleGroupFavoriteById('g1').then(result => { completed = true; return result; });
        await Promise.resolve();
        expect(completed).toBe(false);
        expect(context.printCharactersDebounced).not.toHaveBeenCalled();
        acknowledge({ ok: true });
        await expect(toggling).resolves.toBe(true);
        expect(context.printCharactersDebounced).toHaveBeenCalledTimes(1);
    });

    test('a delayed group favorite acknowledgement cannot modify a successor editor draft', async () => {
        let acknowledge;
        const response = new Promise(resolve => { acknowledge = resolve; });
        const context = groupPersistenceSetup({ fetch: jest.fn(() => response), editorDraft: { id: 'g1', fav: false } });
        const toggling = context.api.toggleGroupFavoriteById('g1');
        const successor = { id: 'g2', fav: false, name: 'Pending' };
        context.editorDraft = successor;
        acknowledge({ ok: true });
        await expect(toggling).resolves.toBe(true);
        expect(context.editorDraft).toBe(successor);
        expect(successor).toEqual({ id: 'g2', fav: false, name: 'Pending' });
        expect(context.groups[0].fav).toBe(true);
    });

    function groupEditorSetup() {
        localStorage.clear();
        const group = { id: 'g1', name: 'Saved', fav: false };
        const context = groupPersistenceSetup({
            groups: [group],
            editorDraft: { ...group },
            structuredClone: value => JSON.parse(JSON.stringify(value)),
            EDITABLE_KEYS: ['name', 'fav'],
            cloneDraftValue: value => value,
            updateFavButtonState: jest.fn(),
            groupTurnRouting: { refresh: jest.fn() },
            updateGroupAvatar: jest.fn(),
            updateGroupHeaderTitle: jest.fn(),
            hideMutedSprites: false,
            eventSource: { emit: jest.fn() },
            event_types: { GROUP_UPDATED: 'updated' },
            selected_group: 'g1',
            openGroupId: 'g1',
            is_group_generating: false,
            Popup: { show: { confirm: jest.fn(async () => true) } },
            clearChat: jest.fn(),
            tag_map: { g1: [] },
            resetChatState: jest.fn(),
            printMessages: jest.fn(),
            select_rm_info: jest.fn(),
        }, ['captureEditorSnapshot', 'saveDraft', 'applyDraftToGroup', 'deleteGroupById', 'deleteGroup']);
        const { session, drafts } = createStoredSession({
            captureSnapshot: context.api.captureEditorSnapshot,
            restoreSnapshot: snapshot => { context.editorDraft = { ...snapshot }; },
            persist: async receipt => {
                if (await context.api.saveDraft(receipt.context.entityId, receipt.snapshot)) receipt.markSaved();
            },
            prefix: 'sb-group-editor-draft-',
        });
        const editor = loadSourceFunctions('scripts/sillybunny-group-editor.js', [
            'openGroupEditorSession', '_openSession', '_handleBack', '_navigateBack', 'isGroupEditorOwner',
            'readGroupEditorBaseline', 'captureGroupEditorSave', 'discardGroupEditorForEntity',
        ], {
            session,
            callbacks: { getGroupName: () => group.name },
            editorTitle: '',
            chrome: null,
            _refreshChrome: jest.fn(),
            navigation: { session },
            confirmEditorLeave: async () => !session.isDirty(),
            objectNavigation: { back: jest.fn(async () => {}) },
            _closeSafely: jest.fn(),
            drafts,
            dismissDraftRecoveryToast: jest.fn(),
        });
        context.isGroupEditorOwner = editor.api.isGroupEditorOwner;
        context.readGroupEditorBaseline = editor.api.readGroupEditorBaseline;
        context.captureGroupEditorSave = editor.api.captureGroupEditorSave;
        context.discardGroupEditorForEntity = editor.api.discardGroupEditorForEntity;
        editor.api.openGroupEditorSession('g1');
        return { context, editor, session, drafts, group };
    }

    test('group pencil-open, Back, list favorite and reopen stay clean and a later Save preserves the favorite', async () => {
        const { context, editor, session, group } = groupEditorSetup();
        await editor.api._handleBack(new Event('click'));
        expect(editor.objectNavigation.back).toHaveBeenCalled();
        expect(session.isOpen()).toBe(true);
        await context.api.toggleGroupFavoriteById('g1');
        editor.api.openGroupEditorSession('g1');
        expect(group.fav).toBe(true);
        expect(context.editorDraft.fav).toBe(true);
        expect(session.readBaseline().fav).toBe(true);
        expect(session.isDirty()).toBe(false);
        context.editorDraft.name = 'Later edit';
        await session.save();
        expect(context.fetch.mock.calls.map(([, request]) => JSON.parse(request.body).fav)).toEqual([true, true]);
        expect(group).toMatchObject({ name: 'Later edit', fav: true });
        expect(session.isDirty()).toBe(false);
        session.close();
    });

    test('group favorite rebases only fav and patches a stored backup without cleaning unrelated pending edits', async () => {
        const { context, session, drafts } = groupEditorSetup();
        context.editorDraft.name = 'Pending';
        session.flushDraft();
        await context.api.toggleGroupFavoriteById('g1');
        expect(session.isDirty()).toBe(true);
        expect(session.readBaseline()).toMatchObject({ name: 'Saved', fav: true });
        expect(drafts.read('g1').snapshot).toMatchObject({ name: 'Pending', fav: true });
        expect(JSON.parse(context.fetch.mock.calls[0][1].body).name).toBe('Saved');
        session.discard();
        expect(context.editorDraft).toMatchObject({ name: 'Saved', fav: true });
        session.close();
    });

    test('a failed group favorite leaves an owned draft, baseline and backup unchanged', async () => {
        const { context, session, drafts, group } = groupEditorSetup();
        context.editorDraft.name = 'Pending';
        session.flushDraft();
        context.fetch.mockResolvedValueOnce({ ok: false });
        await expect(context.api.toggleGroupFavoriteById('g1')).resolves.toBe(false);
        expect(group.fav).toBe(false);
        expect(context.editorDraft).toMatchObject({ name: 'Pending', fav: false });
        expect(session.readBaseline()).toMatchObject({ name: 'Saved', fav: false });
        expect(drafts.read('g1').snapshot).toMatchObject({ name: 'Pending', fav: false });
        session.close();
    });

    test('confirmed group deletion closes its hidden editor and removes the persisted draft key', async () => {
        const { context, session, drafts } = groupEditorSetup();
        context.editorDraft.name = 'Pending';
        session.flushDraft();
        expect(drafts.read('g1')).not.toBeNull();
        await expect(context.api.deleteGroupById('g1')).resolves.toBe(true);
        expect(session.isOpen()).toBe(false);
        expect(context.editorDraft).toBeNull();
        expect(context.openGroupId).toBeNull();
        expect(localStorage.getItem('sb-group-editor-draft-default-g1')).toBeNull();
        session.flushDraft();
        expect(drafts.read('g1')).toBeNull();
    });

    test('failed group deletion keeps the editor session and its recoverable draft', async () => {
        const { context, session, drafts } = groupEditorSetup();
        context.editorDraft.name = 'Pending';
        session.flushDraft();
        context.fetch.mockResolvedValueOnce({ ok: false });
        await expect(context.api.deleteGroupById('g1')).resolves.toBe(false);
        expect(session.isOpen()).toBe(true);
        expect(drafts.read('g1').snapshot.name).toBe('Pending');
        session.close();
    });

    test('deleting another group removes its dormant backup without closing the current editor', async () => {
        const { context, session, drafts } = groupEditorSetup();
        context.editorDraft.name = 'Pending';
        session.flushDraft();
        context.groups.push({ id: 'g2', fav: false });
        drafts.write('g2', { id: 'g2', name: 'Dormant' });
        await expect(context.api.deleteGroupById('g2')).resolves.toBe(true);
        expect(session.context.entityId).toBe('g1');
        expect(context.editorDraft.name).toBe('Pending');
        expect(drafts.read('g1')).not.toBeNull();
        expect(drafts.read('g2')).toBeNull();
        session.close();
    });

    function groupSetup(overrides = {}) {
        return loadSourceFunctions('scripts/group-chats.js', ['toggleGroupFavoriteById', 'deleteGroupById'], {
            groups: [{ id: 'g1', fav: false }],
            editorDraft: null,
            is_group_generating: false,
            editGroup: jest.fn(async () => {}),
            printCharactersDebounced: jest.fn(),
            favsToHotswap: jest.fn(),
            updateFavButtonState: jest.fn(),
            isGroupEditorOwner: () => false,
            Popup: { show: { confirm: jest.fn(async () => true) } },
            deleteGroup: jest.fn(async () => true),
            toastr: { warning: jest.fn() },
            t,
            ...overrides,
        });
    }

    test('group favorite saves the live group without reloading or replacing another draft', async () => {
        const draft = { id: 'other', fav: false };
        const context = groupSetup({ editorDraft: draft });
        await expect(context.api.toggleGroupFavoriteById('g1')).resolves.toBe(true);
        expect(context.groups[0].fav).toBe(true);
        expect(context.editGroup).toHaveBeenCalledWith('g1', true, false);
        expect(context.printCharactersDebounced).toHaveBeenCalledTimes(1);
        expect(draft.fav).toBe(false);
        await expect(context.api.toggleGroupFavoriteById('missing')).resolves.toBe(false);
    });

    test('group favorite updates the live group even when a hidden draft owns it', async () => {
        const draft = { id: 'g1', fav: false };
        const context = groupSetup({ editorDraft: draft });
        await context.api.toggleGroupFavoriteById('g1');
        expect(draft.fav).toBe(true);
        expect(context.groups[0].fav).toBe(true);
        expect(context.updateFavButtonState).toHaveBeenCalledWith(true);
        expect(context.editGroup).toHaveBeenCalledWith('g1', true, false);
        expect(context.favsToHotswap).toHaveBeenCalledTimes(1);
    });

    test('group deletion confirms, returns deletion success, and guards missing/generating/cancelled targets', async () => {
        const context = groupSetup();
        await expect(context.api.deleteGroupById('missing')).resolves.toBe(false);
        context.is_group_generating = true;
        await expect(context.api.deleteGroupById('g1')).resolves.toBe(false);
        expect(context.Popup.show.confirm).not.toHaveBeenCalled();
        context.is_group_generating = false;
        context.Popup.show.confirm.mockResolvedValueOnce(false);
        await expect(context.api.deleteGroupById('g1')).resolves.toBe(false);
        expect(context.deleteGroup).not.toHaveBeenCalled();
        await expect(context.api.deleteGroupById('g1')).resolves.toBe(true);
        expect(context.Popup.show.confirm).toHaveBeenLastCalledWith('Delete the group?', expect.stringContaining('delete all your chats'));
        expect(context.deleteGroup).toHaveBeenCalledWith('g1');
        context.Popup.show.confirm.mockImplementationOnce(async () => { context.is_group_generating = true; return true; });
        await expect(context.api.deleteGroupById('g1')).resolves.toBe(false);
        expect(context.deleteGroup).toHaveBeenCalledTimes(1);
    });

    function characterSetup() {
        return loadSourceFunctions('script.js', ['getCharacterForListAction', 'toggleCharacterFavoriteById', 'deleteCharacterById'], {
            characters: [{ name: 'Alice', avatar: 'alice.png', fav: false, data: { extensions: { fav: false } } }],
            fetch: jest.fn(async () => ({ ok: true })),
            getRequestHeaders: () => ({ header: 'test' }),
            printCharactersDebounced: jest.fn(),
            renderTemplateAsync: jest.fn(async () => 'delete-template'),
            Popup: { show: { confirm: jest.fn(async () => true) } },
            deleteCharacter: jest.fn(async () => true),
            syncCharacterEditorFavorite: jest.fn(() => false),
            t,
        });
    }

    test('character favorite uses merge-attributes and updates both compatible favorite fields', async () => {
        const context = characterSetup();
        await expect(context.api.toggleCharacterFavoriteById('alice.png')).resolves.toBe(true);
        const [url, request] = context.fetch.mock.calls[0];
        expect(url).toBe('/api/characters/merge-attributes');
        expect(JSON.parse(request.body)).toMatchObject({ avatar: 'alice.png', fav: true, data: { extensions: { fav: true } } });
        expect(context.characters[0]).toMatchObject({ fav: true, data: { extensions: { fav: true } } });
        await context.api.toggleCharacterFavoriteById(0);
        expect(context.characters[0].fav).toBe(false);
        await expect(context.api.toggleCharacterFavoriteById('missing')).resolves.toBe(false);
        expect(context.fetch).toHaveBeenCalledTimes(2);
    });

    test('character deletion uses editor copy, respects cancellation and captures its stable avatar before confirmation', async () => {
        document.body.innerHTML = '<input type="checkbox" id="del_char_checkbox" checked>';
        const context = characterSetup();
        context.Popup.show.confirm.mockResolvedValueOnce(false);
        await expect(context.api.deleteCharacterById(0)).resolves.toBe(false);
        expect(context.deleteCharacter).not.toHaveBeenCalled();
        context.Popup.show.confirm.mockImplementationOnce(async (title, template, options) => {
            expect(title).toBe('Delete the character?');
            expect(template).toBe('delete-template');
            options.onClose();
            context.characters.unshift({ avatar: 'different.png' });
            return true;
        });
        await expect(context.api.deleteCharacterById(0)).resolves.toBe(true);
        expect(context.deleteCharacter).toHaveBeenCalledWith('alice.png', { deleteChats: true });
    });

    function characterEditorSetup() {
        localStorage.clear();
        document.body.innerHTML = `
            <form id="form_create" actiontype="editcharacter">
                <input id="character_name_pole" name="ch_name" value="Alice">
                <input name="avatar_url" value="alice.png">
                <input id="selected_chat_pole" name="chat" type="hidden" value="Alice chat">
                <input id="create_date_pole" name="create_date" type="hidden" value="Old creation date">
                <input id="character_json_data" name="json_data" type="hidden" value="Old card data">
                <input id="fav_checkbox" type="checkbox">
                <button id="favorite_button" type="button" class="fav_off"></button>
            </form>
        `;
        const script = loadSourceFunctions('script.js', [
            'getCharacterForListAction', 'toggleCharacterFavoriteById', 'deleteCharacterById',
            'deleteCharacter', 'updateFavButtonState', 'createOrEditCharacter', 'queueCharacterSave',
        ], {
            characters: [{ name: 'Alice', avatar: 'alice.png', fav: false, data: { extensions: { fav: false } } }],
            this_chid: 0,
            fav_ch_checked: false,
            settingsReady: true,
            FormData,
            File,
            CustomEvent,
            crop_data: undefined,
            characterSavePromise: Promise.resolve(),
            create_save: { extensions: {}, extra_books: [] },
            is_group_generating: false,
            is_send_press: false,
            talkativeness_default: 0.5,
            depth_prompt_depth_default: 4,
            depth_prompt_role_default: 'system',
            getCharacters: jest.fn(async () => {
                script.characters.push({ name: 'Created', avatar: 'created.png', chat: 'Created chat', create_date: '2026-10-19T00:00:00.000Z', json_data: '{"name":"Created"}' });
            }),
            createTagMapFromList: jest.fn(),
            getSubmittedAlternateGreetings: () => [],
            getCharacterEditorGroupGreetings: () => [],
            getCharacterDefinitionFormValues: () => ({}),
            getSuspiciousEmptyCharacterDefinitionSave: () => null,
            getOneCharacter: jest.fn(),
            favsToHotswap: jest.fn(),
            getFirstMessage: () => ({}),
            name2: 'Alice',
            neutralCharacterName: 'Temporary',
            closeCurrentChat: async () => true,
            getPastCharacterChats: async () => [],
            fetch: jest.fn(async () => ({ ok: true })),
            getRequestHeaders: () => ({}),
            printCharactersDebounced: jest.fn(),
            renderTemplateAsync: async () => 'delete-template',
            Popup: { show: { confirm: jest.fn(async () => true) } },
            accountStorage: { removeItem: jest.fn() },
            tag_map: {},
            select_rm_info: jest.fn(),
            eventSource: { emit: jest.fn() },
            event_types: { CHARACTER_EDITED: 'edited', CHARACTER_DELETED: 'deleted' },
            removeCharacterFromUI: jest.fn(),
            toastr: { error: jest.fn(), warning: jest.fn() },
            t,
        });
        let editor;
        const { session, drafts } = createStoredSession({
            captureSnapshot: () => editor.api._captureSnapshot(),
            restoreSnapshot: snapshot => {
                document.getElementById('character_name_pole').value = snapshot.character_name_pole;
                script.api.updateFavButtonState(snapshot._fav);
            },
            persist: receipt => editor.api._persist(receipt),
            prefix: 'sb-editor-draft-',
        });
        editor = loadSourceFunctions('scripts/sillybunny-character-editor.js', [
            'openCharacterEditorSession', '_openSession', '_handleBack', '_navigateBack', '_captureSnapshot',
            '_syncFavoritePressed', 'syncCharacterEditorFavorite', 'discardCharacterEditorForEntity',
            'markCharacterEditorSaved', '_handleExternalSave',
            'captureCharacterEditorSave', '_persist', 'openCharacterEditorCreateSession',
        ], {
            session,
            drafts,
            characters: script.characters,
            createOrEditCharacter: (...args) => script.api.createOrEditCharacter(...args),
            NEW_CHAR_DRAFT_KEY: 'new-character',
            t,
            this_chid: 0,
            SNAPSHOT_FIELDS: ['character_name_pole'],
            draftAlt: [],
            draftGrp: [],
            draftOwner: 'alice.png',
            draftAltKeys: [],
            draftGrpKeys: [],
            editorTitle: '',
            chrome: null,
            previews: null,
            _syncRoleSegment: jest.fn(),
            _syncTokenReadout: jest.fn(),
            _renderRelatedLinks: jest.fn(),
            _renderAlternateGreetings: jest.fn(),
            _renderGroupGreetings: jest.fn(),
            dismissDraftRecoveryToast: jest.fn(),
            navigation: { session },
            confirmEditorLeave: async () => !session.isDirty(),
            objectNavigation: { back: jest.fn(async () => {}) },
            _closeSafely: jest.fn(),
        });
        script.syncCharacterEditorFavorite = editor.api.syncCharacterEditorFavorite;
        script.discardCharacterEditorForEntity = editor.api.discardCharacterEditorForEntity;
        script.markCharacterEditorSaved = editor.api.markCharacterEditorSaved;
        script.captureCharacterEditorSave = editor.api.captureCharacterEditorSave;
        script.eventSource.emit.mockImplementation(async (type, ...args) => {
            if (type === 'edited') editor.api._handleExternalSave(...args);
        });
        editor.api.openCharacterEditorSession(0);
        return { script, editor, session, drafts };
    }

    test('character pencil-open, Back, list favorite and reopen stay clean and real Save retains the new value', async () => {
        const { script, editor, session } = characterEditorSetup();
        await editor.api._handleBack(new Event('click'));
        expect(editor.objectNavigation.back).toHaveBeenCalled();
        expect(session.isOpen()).toBe(true);
        await script.api.toggleCharacterFavoriteById('alice.png');
        editor.api.openCharacterEditorSession(0);
        expect(script.characters[0].fav).toBe(true);
        expect(session.readBaseline()._fav).toBe(true);
        expect(session.isDirty()).toBe(false);
        expect(script.fav_ch_checked).toBe(true);
        document.getElementById('character_name_pole').value = 'Later edit';
        await session.save();
        const [url, request] = script.fetch.mock.calls.at(-1);
        expect(url).toBe('/api/characters/edit');
        expect(request.body.get('fav')).toBe('true');
        expect(script.toastr.error).not.toHaveBeenCalled();
        expect(session.isDirty()).toBe(false);
        session.close();
    });

    test('character favorite rebases only _fav while preserving other dirty fields and their backup', async () => {
        const { script, session, drafts } = characterEditorSetup();
        document.getElementById('character_name_pole').value = 'Pending';
        session.flushDraft();
        await script.api.toggleCharacterFavoriteById('alice.png');
        expect(session.isDirty()).toBe(true);
        expect(session.readBaseline()).toMatchObject({ character_name_pole: 'Alice', _fav: true });
        expect(drafts.read('alice.png').snapshot).toMatchObject({ character_name_pole: 'Pending', _fav: true });
        session.discard();
        expect(document.getElementById('character_name_pole').value).toBe('Alice');
        expect(script.fav_ch_checked).toBe(true);
        session.close();
    });

    test('character Save acknowledges V1 without cleaning V2 typed during the request', async () => {
        const { script, session, drafts } = characterEditorSetup();
        let finish;
        script.fetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        document.getElementById('character_name_pole').value = 'V1';
        const saving = session.save();
        await Promise.resolve();
        expect(script.fetch.mock.calls[0][1].body.get('ch_name')).toBe('V1');
        document.getElementById('character_name_pole').value = 'V2';
        session.flushDraft();
        finish({ ok: true });

        expect(await saving).toBe(false);
        expect(session.readBaseline().character_name_pole).toBe('V1');
        expect(drafts.read('alice.png').snapshot.character_name_pole).toBe('V2');
        session.close();
    });

    test('the character persist callback submits its receipt even if typing precedes dispatch', async () => {
        const { script, editor, session, drafts } = characterEditorSetup();
        document.getElementById('character_name_pole').value = 'V1';
        editor.draftAlt = ['Submitted alternate'];
        editor.draftGrp = ['Submitted group greeting'];
        const saving = session.save();
        document.getElementById('character_name_pole').value = 'V2';
        editor.draftAlt.push('Later alternate');
        editor.draftGrp.push('Later group greeting');

        expect(await saving).toBe(false);
        const body = script.fetch.mock.calls[0][1].body;
        expect(body.get('ch_name')).toBe('V1');
        expect(body.getAll('alternate_greetings')).toEqual(['Submitted alternate']);
        expect(JSON.parse(body.get('group_only_greetings'))).toEqual(['Submitted group greeting']);
        expect(session.readBaseline()).toMatchObject({ character_name_pole: 'V1', _alt: ['Submitted alternate'], _grp: ['Submitted group greeting'] });
        expect(drafts.read('alice.png').snapshot).toMatchObject({ character_name_pole: 'V2', _alt: ['Submitted alternate', 'Later alternate'] });
        session.close();
    });

    test('avatar conversion cannot mix later form values or greetings into a submitted snapshot', async () => {
        const { script, editor, session, drafts } = characterEditorSetup();
        const avatar = document.createElement('input');
        avatar.type = 'file';
        avatar.name = 'avatar';
        document.getElementById('form_create').append(avatar);
        let finishConversion;
        script.ensureImageFormatSupported = jest.fn(file => new Promise(resolve => { finishConversion = () => resolve(file); }));
        document.getElementById('character_name_pole').value = 'V1';
        editor.draftAlt = ['V1 greeting'];
        const saving = session.save();
        await Promise.resolve();
        expect(script.ensureImageFormatSupported).toHaveBeenCalled();
        document.getElementById('character_name_pole').value = 'V2';
        editor.draftAlt.push('V2 greeting');
        finishConversion();

        expect(await saving).toBe(false);
        expect(script.fetch.mock.calls[0][1].body.get('ch_name')).toBe('V1');
        expect(script.fetch.mock.calls[0][1].body.getAll('alternate_greetings')).toEqual(['V1 greeting']);
        expect(session.readBaseline()._alt).toEqual(['V1 greeting']);
        expect(drafts.read('alice.png').snapshot._alt).toEqual(['V1 greeting', 'V2 greeting']);
        session.close();
    });

    test('character create re-keys its submitted baseline and later edits to the returned avatar', async () => {
        const { script, editor, session, drafts } = characterEditorSetup();
        session.suspend();
        document.getElementById('form_create').setAttribute('actiontype', 'createcharacter');
        document.getElementById('character_name_pole').value = 'V1';
        editor.draftOwner = 'new-character';
        editor.api.openCharacterEditorCreateSession();
        let finish;
        script.fetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        const saving = session.save();
        await Promise.resolve();
        document.getElementById('character_name_pole').value = 'V2';
        session.flushDraft();
        finish({ ok: true, text: async () => 'created.png' });

        expect(await saving).toBe(false);
        expect(script.toastr.error).not.toHaveBeenCalled();
        expect(script.getCharacters).toHaveBeenCalledWith({ preserveEditor: true });
        expect(script.getOneCharacter).toHaveBeenCalledWith('created.png');
        expect(session.context).toMatchObject({ mode: 'edit', entityId: 'created.png', chid: 1 });
        expect(session.readBaseline().character_name_pole).toBe('V1');
        expect(drafts.read('new-character')).toBeNull();
        expect(drafts.read('created.png').snapshot.character_name_pole).toBe('V2');
        // eslint-disable-next-line playwright/prefer-web-first-assertions -- This is a synchronous jsdom form, not a Playwright locator.
        expect(document.getElementById('form_create').getAttribute('actiontype')).toBe('editcharacter');
        expect(document.querySelector('[name="avatar_url"]').value).toBe('created.png');
        expect(editor.draftOwner).toBe('created.png');
        await session.save();
        expect(script.fetch.mock.calls.at(-1)[0]).toBe('/api/characters/edit');
        expect(script.fetch.mock.calls.at(-1)[1].body.get('avatar_url')).toBe('created.png');
        expect(script.fetch.mock.calls.at(-1)[1].body.get('chat')).toBe('Created chat');
        expect(script.fetch.mock.calls.at(-1)[1].body.get('create_date')).toBe('2026-10-19T00:00:00.000Z');
        expect(script.fetch.mock.calls.at(-1)[1].body.get('json_data')).toBe('{"name":"Created"}');
        expect(session.isDirty()).toBe(false);
        session.close();
    });

    test.each([false, true])('library refresh preserves an editor only when requested (%s)', async preserveEditor => {
        const context = loadSourceFunctions('script.js', ['getCharacters'], {
            characters: [{ name: 'Alice', avatar: 'alice.png' }],
            this_chid: 0,
            fetch: async () => ({ ok: true, json: async () => [{ name: 'Alice', avatar: 'alice.png' }] }),
            getRequestHeaders: () => ({}),
            DOMPurify: { sanitize: value => value },
            setCharacterId: jest.fn(),
            selectCharacterById: jest.fn(),
            getGroups: jest.fn(),
            printCharacters: jest.fn(),
        });
        await context.api.getCharacters(preserveEditor ? { preserveEditor: true } : undefined);
        expect(context.setCharacterId).toHaveBeenCalledWith(0);
        expect(context.selectCharacterById).toHaveBeenCalledTimes(preserveEditor ? 0 : 1);
        expect(context.printCharacters).toHaveBeenCalledWith(true);
    });

    test.each(['createOrEditCharacter', 'queueCharacterSave'])('external %s rebases only its submitted form and preserves later typing', async entry => {
        const { script, session, drafts } = characterEditorSetup();
        let finish;
        script.fetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        document.getElementById('character_name_pole').value = 'External V1';
        const saving = script.api[entry]();
        await Promise.resolve();
        await Promise.resolve();
        document.getElementById('character_name_pole').value = 'Later V2';
        finish({ ok: true });
        await saving;

        expect(session.readBaseline().character_name_pole).toBe('External V1');
        expect(session.isDirty()).toBe(true);
        expect(drafts.read('alice.png').snapshot.character_name_pole).toBe('Later V2');
        await script.api[entry]();
        expect(session.isDirty()).toBe(false);
        expect(drafts.read('alice.png')).toBeNull();
        session.close();
    });

    test('legacy external notifications rebase only the matching character', () => {
        const { editor, session } = characterEditorSetup();
        document.getElementById('character_name_pole').value = 'Externally saved';
        editor.api._handleExternalSave({ detail: { character: { avatar: 'bob.png' } } });
        expect(session.readBaseline().character_name_pole).toBe('Alice');
        editor.api._handleExternalSave({ detail: { character: { avatar: 'alice.png' } } });
        expect(session.readBaseline().character_name_pole).toBe('Externally saved');
        expect(session.isDirty()).toBe(false);
        session.close();
    });

    test.each(['Alice', 'Bob'])('a late character acknowledgement and event leave a replacement %s editor untouched', async name => {
        const { script, editor, session, drafts } = characterEditorSetup();
        let finish;
        script.fetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        document.getElementById('character_name_pole').value = 'V1';
        const saving = session.save();
        await Promise.resolve();
        session.discard();
        session.suspend();
        script.characters.push({ name: 'Bob', avatar: 'bob.png' });
        const chid = name === 'Alice' ? 0 : 1;
        const avatar = script.characters[chid].avatar;
        script.this_chid = editor.this_chid = chid;
        document.getElementById('character_name_pole').value = name;
        document.querySelector('[name="avatar_url"]').value = avatar;
        editor.api.openCharacterEditorSession(chid);
        document.getElementById('character_name_pole').value = `${name} pending`;
        session.flushDraft();
        const backup = localStorage.getItem(`sb-editor-draft-default-${avatar}`);
        finish({ ok: true });

        expect(await saving).toBe(false);
        expect(session.readBaseline().character_name_pole).toBe(name);
        expect(localStorage.getItem(`sb-editor-draft-default-${avatar}`)).toBe(backup);
        expect(drafts.read('alice.png')?.snapshot.character_name_pole ?? null).toBe(name === 'Alice' ? 'Alice pending' : null);
        session.close();
    });

    test.each(['request', 'refresh'])('a create acknowledged after replacement during %s cannot reset the successor', async phase => {
        const { script, editor, session, drafts } = characterEditorSetup();
        session.suspend();
        document.getElementById('form_create').setAttribute('actiontype', 'createcharacter');
        document.getElementById('character_name_pole').value = 'V1';
        editor.api.openCharacterEditorCreateSession();
        let finish;
        let started;
        const pending = new Promise(resolve => { finish = resolve; });
        const dispatched = new Promise(resolve => { started = resolve; });
        script.fetch.mockImplementationOnce(async () => {
            if (phase === 'request') { started(); await pending; }
            return { ok: true, text: async () => 'created.png' };
        });
        script.getOneCharacter.mockImplementationOnce(async () => {
            if (phase === 'refresh') { started(); await pending; }
        });
        const saving = session.save();
        await dispatched;
        session.discard();
        session.suspend();
        script.characters.push({ name: 'Bob', avatar: 'bob.png' });
        const chid = script.characters.findIndex(character => character.avatar === 'bob.png');
        script.this_chid = editor.this_chid = chid;
        document.getElementById('form_create').setAttribute('actiontype', 'editcharacter');
        document.getElementById('character_name_pole').value = 'Bob';
        document.querySelector('[name="avatar_url"]').value = 'bob.png';
        editor.api.openCharacterEditorSession(chid);
        document.getElementById('character_name_pole').value = 'Bob pending';
        session.flushDraft();
        const backup = localStorage.getItem('sb-editor-draft-default-bob.png');
        finish();

        expect(await saving).toBe(false);
        expect(script.toastr.error).not.toHaveBeenCalled();
        expect(session.context.entityId).toBe('bob.png');
        expect(session.readBaseline().character_name_pole).toBe('Bob');
        expect(document.getElementById('character_name_pole').value).toBe('Bob pending');
        expect(localStorage.getItem('sb-editor-draft-default-bob.png')).toBe(backup);
        expect(drafts.read('new-character')).toBeNull();
        expect(script.select_rm_info).not.toHaveBeenCalled();
        session.close();
    });

    test('confirmed character deletion closes its hidden session and removes the persisted draft key', async () => {
        const { script, session, drafts } = characterEditorSetup();
        document.getElementById('character_name_pole').value = 'Pending';
        session.flushDraft();
        expect(drafts.read('alice.png')).not.toBeNull();
        await expect(script.api.deleteCharacterById('alice.png')).resolves.toBe(true);
        expect(session.isOpen()).toBe(false);
        expect(localStorage.getItem('sb-editor-draft-default-alice.png')).toBeNull();
        session.flushDraft();
        expect(drafts.read('alice.png')).toBeNull();
    });

    test('failed character deletion keeps the editor session and its recoverable draft', async () => {
        const { script, session, drafts } = characterEditorSetup();
        document.getElementById('character_name_pole').value = 'Pending';
        session.flushDraft();
        script.fetch.mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Failure' });
        await expect(script.api.deleteCharacterById('alice.png')).resolves.toBe(false);
        expect(session.isOpen()).toBe(true);
        expect(drafts.read('alice.png').snapshot.character_name_pole).toBe('Pending');
        session.close();
    });

    test('deleting another character removes its dormant backup without closing the current editor', async () => {
        const { script, session, drafts } = characterEditorSetup();
        document.getElementById('character_name_pole').value = 'Pending';
        session.flushDraft();
        script.characters.push({ name: 'Bob', avatar: 'bob.png' });
        drafts.write('bob.png', { character_name_pole: 'Dormant' });
        await expect(script.api.deleteCharacterById('bob.png')).resolves.toBe(true);
        expect(session.context.entityId).toBe('alice.png');
        expect(drafts.read('alice.png')).not.toBeNull();
        expect(drafts.read('bob.png')).toBeNull();
        session.close();
    });
});

describe('plain list row data and isolated sorting', () => {
    test('character and group data match the upstream presentation without building DOM', () => {
        const alice = { name: 'Alice', avatar: 'alice.png', fav: true, data: { creator_notes: 'Notes', creator: 'Creator' } };
        const context = loadSourceFunctions('script.js', ['getCharacterRowData', 'getGroupRowData'], {
            power_user: { aux_field: 'creator', show_card_avatar_urls: true },
            characters: [alice, { name: 'Bob', avatar: 'none' }],
            this_chid: 0,
            selected_group: null,
            default_avatar: '/default.png',
            getPermanentAssistantAvatar: () => 'alice.png',
            getThumbnailUrlForViewport: (type, avatar) => `/thumbnail/${type}/${avatar}`,
            isDataURL: value => value.startsWith('data:'),
            t,
        });
        const data = context.api.getCharacterRowData(alice, 0);
        expect(data).toMatchObject({ name: 'Alice', avatarUrl: '/thumbnail/avatar/alice.png', creatorNotes: 'Notes', auxFieldValue: 'Creator', favorite: true, active: true, assistant: true, showCardAvatarUrls: true });
        expect(data.avatarTitle).toContain('File: alice.png');
        expect(context.api.getCharacterRowData({ name: 'Missing', avatar: 'none' }, 1).avatarUrl).toBe('/default.png');
        context.selected_group = 'g1';
        expect(context.api.getCharacterRowData(alice, 0).active).toBe(false);
        const group = context.api.getGroupRowData({ id: 'g1', name: 'Friends', members: ['alice.png', 'Bob', 'deleted.png'], fav: true });
        expect(group).toMatchObject({ active: true, favorite: true, memberNames: ['Alice', 'Bob'], memberNamesText: 'Alice, Bob', memberCount: 2, memberCountText: '2 characters', avatarInfo: { custom: false, memberAvatars: ['alice.png'] } });
        expect(JSON.parse(JSON.stringify(group))).toEqual(group);
        expect(Object.values(group).some(value => value instanceof Element)).toBe(false);
        const avatar = document.createElement('div');
        const avatarContext = loadSourceFunctions('scripts/group-chats.js', ['getGroupAvatarElement'], { getGroupAvatar: jest.fn(() => $(avatar)) });
        expect(avatarContext.api.getGroupAvatarElement(group)).toBe(avatar);
    });

    test('group sorts do not mutate power_user and search relevance still takes priority', () => {
        document.body.innerHTML = '<select id="character_sort_order"><option data-field="search">Search</option><option selected data-field="name">Name</option></select>';
        const settings = { sort_field: 'name', sort_order: 'desc', sort_rule: null };
        const context = loadSourceFunctions('scripts/power-user.js', ['compareFunc', 'sortFunc', 'sortEntitiesList'], {
            power_user: settings,
            entitiesFilter: { getScore: (type, id) => id === 'group.a' ? 0.1 : 0.9 },
            shuffle: jest.fn(),
        });
        const entities = [{ id: 'a', type: 'group', item: { name: 'A', chat_size: 4 } }, { id: 'b', type: 'group', item: { name: 'B', chat_size: 8 } }];
        context.api.sortEntitiesList(entities, false, null, { field: 'chat_size', order: 'desc' });
        expect(entities.map(entity => entity.id)).toEqual(['b', 'a']);
        expect(settings).toEqual({ sort_field: 'name', sort_order: 'desc', sort_rule: null });
        context.api.sortEntitiesList(entities, true, null, { field: 'chat_size', order: 'desc' });
        expect(entities.map(entity => entity.id)).toEqual(['a', 'b']);
        context.api.sortEntitiesList(entities, false);
        expect(entities.map(entity => entity.id)).toEqual(['b', 'a']);
    });
});
