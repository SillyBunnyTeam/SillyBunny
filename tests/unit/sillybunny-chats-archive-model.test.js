import { describe, expect, jest, test } from '@jest/globals';

await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((text, part, index) => text + part + (values[index] ?? ''), ''),
    translate: text => text,
}));

await jest.unstable_mockModule('../../public/scripts/popup.js', () => ({ Popup: class {}, POPUP_TYPE: {}, POPUP_RESULT: {} }));

const archive = '../../public/scripts/extensions/sillybunny-chats-archive/src';
const { normalizeOrganization, normalizeRow, ownerFilterKey, physicalChatKey } = await import(`${archive}/core.js`);
const {
    ALL_LOCATION,
    createViewModel,
    currentLocation,
    filterBase,
    filterByLocation,
    filtersActive,
    hasConflictingLocations,
    locationAllowedByTypes,
    locationKey,
    modelToView,
    resetFilters,
    withLocation,
} = await import(`${archive}/ui/view-model.js`);
const { buildLocations } = await import(`${archive}/ui/locations.js`);
const { deriveView } = await import(`${archive}/ui/list.js`);
const { fuzzyMentionChoices, mentionChoices, mentionedRows, mentionSearchState } = await import(`${archive}/ui/mentions.js`);
const { SEARCH_CONTENT_DEBOUNCE_MS, SORT_KEYS } = await import(`${archive}/ui/constants.js`);

const ctx = { translate: text => text };
const characters = [
    { avatar: 'Alice.png', name: 'Alice' },
    { avatar: 'Alice-copy.png', name: 'Alice' },
    { avatar: 'Bob.png', name: 'Bob' },
];
const groups = [{ id: 'g1', name: 'Night Watch' }];

function row(raw) {
    return normalizeRow({ _source: 'archive-inventory', chat_items: 2, last_mes: 1_000, file_size: '1 KB', ...raw }, characters, groups);
}

const aliceFavorite = row({ avatar: 'Alice.png', file_name: 'alice-favorite.jsonl' });
const aliceFiled = row({ avatar: 'Alice.png', file_name: 'alice-filed.jsonl', last_mes: 3_000 });
const bobCollected = row({ avatar: 'Bob.png', file_name: 'bob-collected.jsonl', last_mes: 2_000 });
const watch = row({ group: 'g1', file_name: 'watch-evening.jsonl', last_mes: 4_000 });
const lost = row({ _source: 'archive-orphan', archive_hash: 'e'.repeat(64), avatar: 'Gone.png', file_name: 'lost.jsonl', orphan_type: 'missing-character' });
const allRows = [aliceFavorite, aliceFiled, bobCollected, watch, lost];

const organization = normalizeOrganization({
    version: 1,
    lastView: {},
    views: [],
    folders: [{ id: 'f1', name: 'Roleplay' }],
    collections: [{ id: 'c1', name: 'Slow burn' }],
    chats: {
        [physicalChatKey(aliceFavorite)]: { favorite: true },
        [physicalChatKey(aliceFiled)]: { folder: 'f1', tags: ['slow'] },
        [physicalChatKey(bobCollected)]: { collections: ['c1'] },
    },
});

const aliceOwner = ownerFilterKey(aliceFavorite);
const groupOwner = ownerFilterKey(watch);

function locations(model, { base = allRows, searching = false, catalog = allRows } = {}) {
    return buildLocations(ctx, { base, catalog, model, organization, searching });
}

const entriesOf = result => result.sections.flatMap(section => section.entries);

describe('location and saved view mapping', () => {
    test.each([
        ['owner', { type: 'owner', value: aliceOwner }, { owner: aliceOwner }],
        ['folder', { type: 'folder', value: 'f1' }, { folder: 'f1' }],
        ['Unfiled', { type: 'folder', value: null }, { folder: null }],
        ['collection', { type: 'collection', value: 'c1' }, { collection: 'c1' }],
        ['Favorites', { type: 'favorites', value: '' }, { favorite: true }],
        ['Orphaned', { type: 'orphan', value: '' }, { kinds: ['orphan'] }],
    ])('%s is written to its existing saved view field and read back as the same location', (_name, location, fields) => {
        const view = modelToView(withLocation(createViewModel(), location), '', organization);
        expect(view).toMatchObject(fields);
        const restored = currentLocation(createViewModel(view));
        expect(locationKey(restored)).toBe(locationKey(location));
        expect(hasConflictingLocations(createViewModel(view))).toBe(false);
    });

    test('an unconstrained view is All Chats and writes no location field', () => {
        const view = modelToView(createViewModel(), '', organization);
        expect(currentLocation(createViewModel(view))).toBe(ALL_LOCATION);
        expect(view).not.toHaveProperty('owner', expect.stringContaining('@'));
        expect(view).not.toHaveProperty('folder');
        expect(view).not.toHaveProperty('collection');
        expect(view).not.toHaveProperty('favorite');
        expect(view.kinds).toEqual(['solo', 'group', 'orphan']);
    });

    test('Orphaned is exactly kinds [orphan], keeps its reason, and leaves the type checks all on', () => {
        const model = createViewModel({ kinds: ['orphan'], orphan: 'missing-group' });
        expect(model.orphanOnly).toBe(true);
        expect([...model.types]).toEqual(['solo', 'group', 'orphan']);
        expect(currentLocation(model)).toEqual({ type: 'orphan', value: '' });
        expect(modelToView(model, '', organization)).toMatchObject({ kinds: ['orphan'], orphan: 'missing-group' });
        expect(createViewModel({ kinds: ['orphan', 'group'] }).orphanOnly).toBe(false);
    });

    test.each([
        ['owner and folder', { owner: aliceOwner, folder: 'f1' }],
        ['folder and collection', { folder: 'f1', collection: 'c1' }],
        ['favorites and owner', { favorite: true, owner: aliceOwner }],
        ['orphan and collection', { kinds: ['orphan'], collection: 'c1' }],
    ])('a legacy view with %s selects All Chats and keeps every constraint applied', (_name, view) => {
        const model = createViewModel(view);
        expect(currentLocation(model)).toBe(ALL_LOCATION);
        expect(hasConflictingLocations(model)).toBe(true);
        expect(filtersActive(model)).toBe(true);
        const kept = modelToView(model, '', organization);
        for (const [field, value] of Object.entries(view)) {
            expect(kept[field]).toEqual(value);
        }
        const rows = filterByLocation(filterBase(allRows, model, '', organization), model, organization);
        const expected = { 'owner and folder': [aliceFiled], 'folder and collection': [], 'favorites and owner': [aliceFavorite], 'orphan and collection': [] }[_name];
        expect(rows).toEqual(expected);
    });

    test('Filters reset clears the constraints of a conflicting view and leaves hidden group and density alone', () => {
        const reset = resetFilters(createViewModel({ owner: aliceOwner, folder: 'f1', group: 'owner', density: 'compact', sort: 'size' }));
        expect(currentLocation(reset)).toBe(ALL_LOCATION);
        expect(filtersActive(reset)).toBe(false);
        expect(reset).toMatchObject({ group: 'owner', density: 'compact', sort: 'size' });
    });

    test('group and density have no controls and round-trip through every model change untouched', () => {
        const model = createViewModel({ group: 'folder', density: 'compact' });
        expect(modelToView(model, '', organization)).toMatchObject({ group: 'folder', density: 'compact' });
        const moved = withLocation(model, { type: 'folder', value: 'f1' });
        expect(modelToView(moved, 'q', organization)).toMatchObject({ group: 'folder', density: 'compact', query: 'q', folder: 'f1' });
        expect(modelToView(resetFilters(moved), '', organization)).toMatchObject({ group: 'folder', density: 'compact' });
        expect(modelToView(createViewModel(), '', organization)).not.toHaveProperty('group');
    });

    test('Favorites is a chat type: on writes no field, off writes favorite false and excludes favorites', () => {
        const off = { ...createViewModel(), favorite: false };
        expect(modelToView(createViewModel(), '', organization)).not.toHaveProperty('favorite');
        expect(modelToView(off, '', organization)).toMatchObject({ favorite: false });
        expect(filtersActive(off)).toBe(true);
        expect(filterBase(allRows, off, '', organization)).not.toContain(aliceFavorite);
        expect(filterBase(allRows, createViewModel(), '', organization)).toContain(aliceFavorite);
        expect(locationAllowedByTypes(off, { type: 'favorites', value: '' })).toBe(false);
        expect(currentLocation(withLocation(off, { type: 'favorites', value: '' }))).toEqual({ type: 'favorites', value: '' });
        expect(withLocation(off, { type: 'folder', value: 'f1' }).favorite).toBe(false);
    });

    test('an active Favorites category keeps favourites listed when their own chat type is off', () => {
        const withoutCharacters = { ...createViewModel(), types: new Set(['group', 'orphan']) };
        const listed = filterBase(allRows, withoutCharacters, '', organization);
        expect(listed).toContain(aliceFavorite);
        expect(listed).not.toContain(aliceFiled);
        expect(listed).toContain(watch);
        const excluded = filterBase(allRows, { ...withoutCharacters, favorite: false }, '', organization);
        expect(excluded).not.toContain(aliceFavorite);
    });

    test('a Favorites location lists only favourites, whatever the chat types', () => {
        const model = withLocation({ ...createViewModel(), types: new Set(['group']) }, { type: 'favorites', value: '' });
        const rows = filterByLocation(filterBase(allRows, model, '', organization), model, organization);
        expect(rows).toEqual([aliceFavorite]);
    });

    test('there are nine sort choices and the debounce for content search is 600 ms', () => {
        expect(SORT_KEYS).toHaveLength(9);
        expect(new Set(SORT_KEYS).size).toBe(9);
        expect(SEARCH_CONTENT_DEBOUNCE_MS).toBe(600);
    });
});

describe('sidebar locations', () => {
    test('counts equal the rows each location lists', () => {
        const model = createViewModel();
        const result = locations(model);
        const entries = entriesOf(result);
        expect(entries.map(entry => entry.type)).toEqual(expect.arrayContaining(['all', 'favorites', 'owner', 'folder', 'collection', 'orphan']));
        for (const entry of entries) {
            const scoped = withLocation(model, entry);
            expect(filterByLocation(filterBase(allRows, scoped, '', organization), scoped, organization)).toHaveLength(entry.count);
        }
        expect(entries.find(entry => entry.type === 'all').count).toBe(allRows.length);
    });

    test('counts follow the search and Filters, not the whole catalog', () => {
        const model = { ...createViewModel(), tag: 'slow' };
        const base = filterBase(allRows, model, '', organization);
        const entries = entriesOf(locations(model, { base }));
        expect(entries.find(entry => entry.type === 'all').count).toBe(1);
        expect(entries.find(entry => entry.type === 'owner').count).toBe(1);
        expect(entries.filter(entry => entry.type === 'folder' && entry.value === 'f1')[0].count).toBe(1);
        expect(entries.some(entry => entry.type === 'collection')).toBe(false);
    });

    test('each section holds only its own kind of location', () => {
        const byId = Object.fromEntries(locations(createViewModel()).sections.map(section => [section.id, section.entries]));
        expect(byId.primary.map(entry => entry.type)).toEqual(['all', 'favorites']);
        expect(byId.characters.every(entry => entry.type === 'owner' && entry.icon === 'fa-user')).toBe(true);
        expect(byId.groups.every(entry => entry.type === 'owner' && entry.icon === 'fa-users')).toBe(true);
        expect(byId.folders.every(entry => entry.type === 'folder')).toBe(true);
        expect(byId.collections.every(entry => entry.type === 'collection')).toBe(true);
        expect(byId.orphans.map(entry => entry.type)).toEqual(['orphan']);
        expect(byId.characters.map(entry => entry.label)).toEqual(['Alice', 'Bob']);
        expect(byId.groups.map(entry => entry.label)).toEqual(['Night Watch']);
    });

    test('unchecking a chat type hides its sections and nothing else', () => {
        const noCharacters = { ...createViewModel(), types: new Set(['group', 'orphan']) };
        const ids = result => result.sections.map(section => section.id);
        expect(ids(locations(createViewModel()))).toEqual(expect.arrayContaining(['characters', 'groups', 'orphans']));
        const hidden = locations(noCharacters, { base: filterBase(allRows, noCharacters, '', organization) });
        expect(ids(hidden)).not.toContain('characters');
        expect(ids(hidden)).toEqual(expect.arrayContaining(['groups', 'orphans']));
        const noOrphans = { ...createViewModel(), types: new Set(['solo', 'group']) };
        expect(ids(locations(noOrphans, { base: filterBase(allRows, noOrphans, '', organization) }))).not.toContain('orphans');
        expect(locationAllowedByTypes(noCharacters, { type: 'owner', value: aliceOwner })).toBe(false);
        expect(locationAllowedByTypes(noCharacters, { type: 'owner', value: groupOwner })).toBe(true);
    });

    test('the same name twice gets a hint that tells the characters apart', () => {
        const twin = row({ avatar: 'Alice-copy.png', file_name: 'twin.jsonl' });
        const rows = [aliceFavorite, twin];
        const entries = entriesOf(locations(createViewModel(), { base: rows, catalog: rows })).filter(entry => entry.type === 'owner');
        expect(entries.map(entry => entry.hint).sort()).toEqual(['Character: Alice', 'Character: Alice-copy']);
    });

    test('a selected location that search empties stays visible with a count of 0', () => {
        const bobOnly = withLocation(createViewModel(), { type: 'owner', value: ownerFilterKey(bobCollected) });
        const base = filterBase(allRows, bobOnly, 'alice', organization);
        expect(base.every(item => item.ownerName !== 'Bob')).toBe(true);
        const searching = locations(bobOnly, { base, searching: true });
        const bob = entriesOf(searching).find(entry => entry.type === 'owner' && entry.label === 'Bob');
        expect(bob).toMatchObject({ count: 0, selected: true });
        expect(searching.fallback).toBe(false);
        expect(searching.current.key).toBe(bob.key);
    });

    test('a selected location that the Filters hide falls back to All Chats', () => {
        const folderSelected = withLocation({ ...createViewModel(), tag: 'nonexistent' }, { type: 'folder', value: 'f1' });
        const base = filterBase(allRows, folderSelected, '', organization);
        const result = locations(folderSelected, { base });
        expect(result.fallback).toBe(true);
        expect(result.current.type).toBe('all');

        const solo = withLocation({ ...createViewModel(), types: new Set(['group', 'orphan']) }, { type: 'owner', value: aliceOwner });
        expect(locations(solo, { base: filterBase(allRows, solo, '', organization) }).fallback).toBe(true);
    });

    describe('deriveView', () => {
        const ui = { search: { value: '' }, characterMentions: [] };
        const hiddenLocation = () => withLocation({ ...createViewModel(), tag: 'nonexistent' }, { type: 'folder', value: 'f1' });
        const stateWith = overrides => ({
            rows: allRows.filter(item => item.kind !== 'orphan'),
            orphanRows: [lost],
            deepRows: null,
            organization,
            listState: 'ready',
            scanAbort: null,
            model: hiddenLocation(),
            ...overrides,
        });

        test('returns the All Chats fallback for the caller to commit once the data is complete', () => {
            const state = stateWith({});
            const before = state.model;
            const view = deriveView(ctx, state, ui);
            expect(state.model).toBe(before);
            expect(currentLocation(view.fallbackModel)).toBe(ALL_LOCATION);
            expect(view.fallbackModel.tag).toBe('nonexistent');
            expect(view.rows).toEqual([]);

            state.model = { ...view.fallbackModel, tag: '' };
            const settled = deriveView(ctx, state, ui);
            expect(settled.fallbackModel).toBeNull();
            expect(settled.rows).toHaveLength(allRows.length);
        });

        test.each([
            ['rows are still loading', { listState: 'loading', rows: [], orphanRows: [] }],
            ['a scan is running', { scanAbort: new AbortController() }],
        ])('keeps a saved location with Filters while %s', (_label, overrides) => {
            const state = stateWith(overrides);
            const before = state.model;
            const view = deriveView(ctx, state, ui);
            expect(view.fallbackModel).toBeNull();
            expect(state.model).toBe(before);
            expect(currentLocation(state.model)).toEqual({ type: 'folder', value: 'f1' });
            expect(state.model.tag).toBe('nonexistent');
        });

        test('falls back as soon as the scan has ended, on the same data it kept the location for', () => {
            const state = stateWith({ scanAbort: new AbortController() });
            expect(deriveView(ctx, state, ui).fallbackModel).toBeNull();
            state.scanAbort = null;
            const view = deriveView(ctx, state, ui);
            expect(currentLocation(view.fallbackModel)).toBe(ALL_LOCATION);
        });

        test('keeps a saved orphan reason before any orphan row has arrived', () => {
            const model = createViewModel({ kinds: ['orphan'], orphan: 'missing-group' });
            const state = stateWith({ listState: 'loading', rows: [], orphanRows: [], model });
            expect(deriveView(ctx, state, ui).fallbackModel).toBeNull();
            expect(state.model).toBe(model);
            expect(modelToView(state.model, '', organization)).toMatchObject({ kinds: ['orphan'], orphan: 'missing-group' });
        });
    });

    test('a saved owner with no chats left is kept as an unavailable location instead of being cleared', () => {
        const ghost = '@sbca:["character","Ghost"]';
        const model = createViewModel({ owner: ghost });
        const result = locations(model);
        const unavailable = result.sections.find(section => section.id === 'unavailable');
        expect(unavailable.entries).toHaveLength(1);
        expect(unavailable.entries[0]).toMatchObject({ type: 'owner', value: ghost, label: 'Ghost', count: 0, selected: true, hint: 'Character unavailable' });
        expect(result.fallback).toBe(false);
        expect(modelToView(model, '', organization).owner).toBe(ghost);

        const missingGroup = createViewModel({ owner: '@sbca:["group","gone"]' });
        const group = locations(missingGroup).sections.find(section => section.id === 'unavailable');
        expect(group.entries[0].hint).toBe('Group unavailable');
        const foreign = locations(createViewModel({ owner: 'Somebody' })).sections.find(section => section.id === 'unavailable');
        expect(foreign.entries[0].hint).toBe('Saved filter');
    });

    test('a selected owner whose chats the Filters empty is not reported unavailable, only hidden', () => {
        const model = withLocation({ ...createViewModel(), tag: 'slow' }, { type: 'owner', value: ownerFilterKey(bobCollected) });
        const result = locations(model, { base: filterBase(allRows, model, '', organization) });
        expect(result.sections.some(section => section.id === 'unavailable')).toBe(false);
        expect(result.fallback).toBe(true);
    });
});

describe('search mentions', () => {
    const choices = mentionChoices({ characters });

    test('characters with the same name share one mention that covers every avatar', () => {
        expect(choices.map(choice => choice.name)).toEqual(['Alice', 'Bob']);
        expect(choices[0].avatars).toEqual(['Alice.png', 'Alice-copy.png']);
    });

    test('quoted and escaped mentions are read back, and the text left over is the content search', () => {
        const tricky = [{ name: 'Prime "One"', avatars: ['Prime.png'] }, { name: 'Path\\Finder', avatars: ['Path.png'] }];
        const quoted = mentionSearchState('@"Prime \\"One\\"" needle', tricky);
        expect(quoted.mentions.map(mention => mention.name)).toEqual(['Prime "One"']);
        expect(quoted.text).toBe('needle');
        expect(quoted.active).toBeNull();
        expect(mentionSearchState('@"Path\\\\Finder" needle', tricky).mentions[0].name).toBe('Path\\Finder');
        const typing = mentionSearchState('needle @Ali', choices);
        expect(typing.active).toEqual({ fragment: 'Ali', start: 7 });
        expect(typing.text).toBe('needle');
    });

    test('a mention narrows the rows to its characters, and an unknown one matches nothing', () => {
        const state = mentionSearchState('@Alice', choices);
        expect(mentionedRows(allRows, state.mentions)).toEqual([aliceFavorite, aliceFiled]);
        expect(mentionedRows(allRows, mentionSearchState('@Nobody', choices).mentions)).toEqual([]);
        expect(mentionedRows(allRows, mentionSearchState('plain', choices).mentions)).toBe(allRows);
    });

    test('completion is fuzzy, ranks direct matches first, and offers every name for a bare @', () => {
        const names = [{ name: 'Alice' }, { name: 'Bob' }, { name: 'Malice' }];
        expect(fuzzyMentionChoices(names, 'Alce').map(choice => choice.name)).toEqual(['Alice', 'Malice']);
        expect(fuzzyMentionChoices(names, 'lice').map(choice => choice.name)).toEqual(['Alice', 'Malice']);
        expect(fuzzyMentionChoices(names, '').map(choice => choice.name)).toEqual(['Alice', 'Bob', 'Malice']);
        expect(fuzzyMentionChoices(names, 'zzz')).toEqual([]);
    });
});
