import { describe, test, expect, jest, beforeEach } from '@jest/globals';

const folders = await import('../../public/scripts/sillybunny-folders.js');

let settings;
let save;
let notify;
let nextId;

function setup(initial = folders.normalizeFoldersData(null)) {
    settings = { sb_folders: structuredClone(initial) };
    save = jest.fn();
    notify = jest.fn();
    let id = 0;
    nextId = () => `folder-${++id}`;
    folders.configureFolderStore({ powerUser: settings, saveSettingsDebounced: save, idFactory: nextId });
    folders.subscribe(notify);
}

beforeEach(() => setup());

describe('SillyBunny folder store', () => {
    test('creates, renames, reorders, colors, expands and deletes folders', () => {
        const alpha = folders.createFolder('characters', ' Alpha ');
        const beta = folders.createFolder('characters', 'Beta', { expanded: false });
        expect(folders.getFolders('characters').map(folder => folder.name)).toEqual(['Alpha', 'Beta']);
        expect(folders.renameFolder('characters', alpha.id, ' Renamed ')).toBe(true);
        expect(folders.setFolderColor('characters', alpha.id, 'red')).toBe(true);
        expect(folders.setFolderExpanded('characters', alpha.id, false)).toBe(true);
        expect(folders.moveFolder('characters', beta.id, -1)).toBe(true);
        expect(folders.getFolders('characters').map(folder => folder.name)).toEqual(['Beta', 'Renamed']);
        folders.setFolder('characters', ['a.png', 'b.png'], alpha.id);
        expect(folders.getFolderMembers('characters', alpha.id)).toEqual(['a.png', 'b.png']);
        expect(folders.deleteFolder('characters', alpha.id)).toBe(true);
        expect(folders.getFolderId('characters', 'a.png')).toBeNull();
        expect(save).toHaveBeenCalledTimes(8);
        expect(notify).toHaveBeenCalledTimes(8);
    });

    test('enforces one folder per member and supports unfiling', () => {
        const first = folders.createFolder('characters', 'First');
        const second = folders.createFolder('characters', 'Second');
        folders.setFolder('characters', ['a.png'], first.id);
        folders.setFolder('characters', ['a.png'], second.id);
        expect(folders.getFolderMembers('characters', first.id)).toEqual([]);
        expect(folders.getFolderId('characters', 'a.png')).toBe(second.id);
        folders.setFolder('characters', ['a.png'], null);
        expect(folders.getFolderId('characters', 'a.png')).toBeNull();
    });

    test('normalizes malformed persisted data and preserves valid unknown members', () => {
        const normalized = folders.normalizeFoldersData({
            version: 99,
            migratedFromTags: 'yes',
            characters: {
                folders: [{ id: 'same', name: ' A ' }, { id: 'same', name: 'B', expanded: false }, { name: '' }],
                members: { missing: 'same', invalid: 'nope' },
            },
        }, (() => {
            let id = 0;
            return () => `generated-${++id}`;
        })());
        expect(normalized).toEqual({
            version: 1,
            migratedFromTags: false,
            characters: {
                folders: [
                    { id: 'same', name: 'A', color: '', expanded: true },
                    { id: 'generated-1', name: 'B', color: '', expanded: false },
                ],
                members: { missing: 'same' },
            },
            groups: { folders: [], members: {} },
        });
    });

    test('maintains identity across rename, duplicate and deletion events', async () => {
        const eventSource = {
            listeners: new Map(),
            on(event, listener) { this.listeners.set(event, listener); },
            removeListener(event) { this.listeners.delete(event); },
        };
        const eventTypes = { CHARACTER_RENAMED: 'renamed', CHARACTER_DUPLICATED: 'duplicated', CHARACTER_DELETED: 'deleted' };
        folders.configureFolderStore({ powerUser: settings, saveSettingsDebounced: save, idFactory: nextId, eventSource, eventTypes });
        const folder = folders.createFolder('characters', 'Characters');
        folders.setFolder('characters', ['old.png'], folder.id);
        eventSource.listeners.get('renamed')('old.png', 'new.png');
        expect(folders.getFolderId('characters', 'new.png')).toBe(folder.id);
        eventSource.listeners.get('duplicated')({ oldAvatar: 'new.png', newAvatar: 'copy.png' });
        expect(folders.getFolderId('characters', 'copy.png')).toBe(folder.id);
        eventSource.listeners.get('deleted')({ character: { avatar: 'new.png' } });
        expect(folders.getFolderId('characters', 'new.png')).toBeNull();
    });

    test('does not convert when bogus folders are disabled or missing', () => {
        for (const enabled of [false, undefined]) {
            setup();
            const tags = [{ id: 'tag', name: 'Legacy', folder_type: 'OPEN' }];
            const tagMap = { 'a.png': ['tag'] };
            const before = structuredClone(tagMap);
            expect(folders.convertLegacyTagFolders({ enabled, tags, tagMap, characters: [{ avatar: 'a.png' }] })).toBe(false);
            expect(settings.sb_folders.migratedFromTags).toBe(true);
            expect(tagMap).toEqual(before);
            expect(folders.getFolders('characters')).toEqual([]);
        }
    });

    test('converts one tag, leaves conflicts unfiled, clears filters and is idempotent', () => {
        const tags = [
            { id: 'open', name: 'Open', color: 'green', folder_type: 'OPEN' },
            { id: 'closed', name: 'Closed', color: 'blue', folder_type: 'CLOSED' },
            { id: 'plain', name: 'Plain', folder_type: 'NONE' },
        ];
        const tagMap = { 'one.png': ['open'], 'two.png': ['open', 'closed'], group: ['closed'] };
        const accountStorage = { removeItem: jest.fn() };
        const filterData = { selected: ['open', 'plain'], excluded: ['closed'] };
        const entitiesFilter = { getFilterData: jest.fn(() => filterData), setFilterData: jest.fn() };
        const originalTags = structuredClone(tags);
        const originalMap = structuredClone(tagMap);
        const converted = folders.convertLegacyTagFolders({
            enabled: true,
            tags,
            tagMap,
            characters: [{ avatar: 'one.png' }, { avatar: 'two.png' }],
            groups: [{ id: 'group' }],
            accountStorage,
            entitiesFilter,
            tagFilterType: 'tag',
        });
        expect(converted).toBe(true);
        expect(folders.getFolders('characters').map(folder => [folder.name, folder.expanded])).toEqual([['Open', true], ['Closed', false]]);
        expect(folders.getFolders('groups').map(folder => [folder.name, folder.expanded])).toEqual([['Closed', false]]);
        expect(folders.getFolderId('characters', 'one.png')).toBe(folders.getFolders('characters')[0].id);
        expect(folders.getFolderId('characters', 'two.png')).toBeNull();
        expect(folders.getFolderId('groups', 'group')).toBe(folders.getFolders('groups')[0].id);
        expect(accountStorage.removeItem).toHaveBeenCalledWith('CharacterList_tag_open');
        expect(accountStorage.removeItem).toHaveBeenCalledWith('GroupList_tag_closed');
        expect(entitiesFilter.setFilterData).toHaveBeenCalledWith('tag', { selected: ['plain'], excluded: [] }, true);
        expect(tags).toEqual(originalTags);
        expect(tagMap).toEqual(originalMap);
        const saveCount = save.mock.calls.length;
        expect(folders.convertLegacyTagFolders({ enabled: true, tags, tagMap, characters: [{ avatar: 'one.png' }], entitiesFilter, tagFilterType: 'tag' })).toBe(false);
        expect(save.mock.calls.length).toBe(saveCount);
    });
});
