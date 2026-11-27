/** @jest-environment jsdom */
import { jest, describe, test, expect } from '@jest/globals';

await import('../../public/lib/jquery-3.5.1.min.js');

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
