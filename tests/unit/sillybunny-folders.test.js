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

    describe('persona scope', () => {
        function personaEvents() {
            const eventSource = {
                listeners: new Map(),
                on(event, listener) { this.listeners.set(event, listener); },
                removeListener(event) { this.listeners.delete(event); },
            };
            const eventTypes = { PERSONA_CREATED: 'persona_created', PERSONA_DELETED: 'persona_deleted' };
            folders.configureFolderStore({ powerUser: settings, saveSettingsDebounced: save, idFactory: nextId, eventSource, eventTypes });
            return eventSource;
        }

        test('loads settings saved without the scope unchanged and reads it as empty', () => {
            const saved = { version: 1, migratedFromTags: true, characters: { folders: [], members: {} }, groups: { folders: [], members: {} } };
            const normalized = folders.normalizeFoldersData(structuredClone(saved));
            expect(normalized).toEqual(saved);
            expect(Object.hasOwn(normalized, 'personas')).toBe(false);
            expect(JSON.stringify(normalized)).toBe(JSON.stringify(saved));
            setup(normalized);
            expect(folders.getFolders('personas')).toEqual([]);
            expect(folders.getFolderId('personas', 'a.png')).toBeNull();
            expect(folders.getFolderMembers('personas', 'missing')).toEqual([]);
            expect(folders.setFolder('personas', ['a.png'], null)).toBe(false);
            expect(folders.deleteFolder('personas', 'missing')).toBe(false);
            expect(folders.removeEntityKey('personas', 'a.png')).toBe(false);
            expect(Object.hasOwn(settings.sb_folders, 'personas')).toBe(false);
            expect(save).not.toHaveBeenCalled();
        });

        test('normalizes a saved persona scope and drops dangling members', () => {
            const normalized = folders.normalizeFoldersData({
                personas: {
                    folders: [{ id: 'p1', name: ' Cast ', color: 'teal', expanded: false }, { name: '' }],
                    members: { 'one.png': 'p1', 'two.png': 'gone' },
                },
            });
            expect(normalized.personas).toEqual({
                folders: [{ id: 'p1', name: 'Cast', color: 'teal', expanded: false }],
                members: { 'one.png': 'p1' },
            });
            expect(folders.normalizeFoldersData(normalized)).toEqual(normalized);
        });

        test('creates the scope on the first write and keeps the stored shape', () => {
            const folder = folders.createFolder('personas', 'Cast');
            folders.setFolder('personas', ['one.png', 'two.png'], folder.id);
            expect(settings.sb_folders.personas).toEqual({
                folders: [{ id: folder.id, name: 'Cast', color: '', expanded: true }],
                members: { 'one.png': folder.id, 'two.png': folder.id },
            });
            expect(Object.keys(settings.sb_folders)).toEqual(['version', 'migratedFromTags', 'characters', 'groups', 'personas']);
            expect(folders.normalizeFoldersData(settings.sb_folders)).toEqual(settings.sb_folders);
            expect(settings.sb_folders.characters.members).toEqual({});
            expect(save).toHaveBeenCalledTimes(2);
            expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ scope: 'personas', reason: 'set-members' }));
        });

        test('moves a persona between folders and unfiles it', () => {
            const first = folders.createFolder('personas', 'First');
            const second = folders.createFolder('personas', 'Second');
            folders.setFolder('personas', 'one.png', first.id);
            folders.setFolder('personas', 'one.png', second.id);
            expect(folders.getFolderId('personas', 'one.png')).toBe(second.id);
            expect(folders.getFolderMembers('personas', first.id)).toEqual([]);
            expect(folders.setFolder('personas', 'one.png', null)).toBe(true);
            expect(folders.getFolderId('personas', 'one.png')).toBeNull();
        });

        test('a duplicated persona keeps its folder and a deleted persona loses its membership', () => {
            const eventSource = personaEvents();
            const folder = folders.createFolder('personas', 'Cast');
            folders.setFolder('personas', ['one.png'], folder.id);
            eventSource.listeners.get('persona_created')({ avatarId: 'copy.png', name: 'One', duplicatedFromAvatarId: 'one.png' });
            expect(folders.getFolderId('personas', 'copy.png')).toBe(folder.id);
            eventSource.listeners.get('persona_created')({ avatarId: 'fresh.png', name: 'Fresh' });
            expect(folders.getFolderId('personas', 'fresh.png')).toBeNull();
            eventSource.listeners.get('persona_created')({ avatarId: 'plain-copy.png', duplicatedFromAvatarId: 'unfiled.png' });
            expect(folders.getFolderId('personas', 'plain-copy.png')).toBeNull();
            eventSource.listeners.get('persona_deleted')({ avatarId: 'one.png', name: 'One' });
            expect(folders.getFolderId('personas', 'one.png')).toBeNull();
            expect(folders.getFolderId('personas', 'copy.png')).toBe(folder.id);
            expect(folders.getFolders('personas')).toHaveLength(1);
            eventSource.listeners.get('persona_deleted')({ avatarId: 'never-filed.png' });
        });

        test('renaming a persona keeps its folder, because the key is the avatar id and no event moves it', () => {
            const eventSource = personaEvents();
            const folder = folders.createFolder('personas', 'Cast');
            folders.setFolder('personas', ['one.png'], folder.id);
            const key = 'one.png';
            settings.personas = { [key]: 'One' };
            settings.personas[key] = 'Renamed';
            expect([...eventSource.listeners.keys()].sort()).toEqual(['persona_created', 'persona_deleted']);
            expect(folders.getFolderId('personas', key)).toBe(folder.id);
            expect(folders.getFolderMembers('personas', folder.id)).toEqual([key]);
        });

        test('loading keeps a membership whose persona no longer exists, so readers count only what exists', () => {
            const saved = { personas: { folders: [{ id: 'f', name: 'Cast', color: '', expanded: true }], members: { 'gone.png': 'f' } } };
            const normalized = folders.normalizeFoldersData(structuredClone(saved));
            expect(normalized.personas.members).toEqual({ 'gone.png': 'f' });
        });

        test('deleting a folder leaves its personas unfiled and other scopes alone', () => {
            const persona = folders.createFolder('personas', 'Cast');
            const character = folders.createFolder('characters', 'Cast');
            folders.setFolder('personas', ['one.png'], persona.id);
            folders.setFolder('characters', ['one.png'], character.id);
            expect(folders.deleteFolder('personas', persona.id)).toBe(true);
            expect(folders.getFolderId('personas', 'one.png')).toBeNull();
            expect(folders.getFolderId('characters', 'one.png')).toBe(character.id);
        });

        test('keeps the persona listeners tolerant of stores without persona events', () => {
            const eventSource = { listeners: new Map(), on(event, listener) { this.listeners.set(event, listener); }, removeListener() {} };
            folders.configureFolderStore({
                powerUser: settings,
                saveSettingsDebounced: save,
                idFactory: nextId,
                eventSource,
                eventTypes: { CHARACTER_RENAMED: 'renamed', CHARACTER_DUPLICATED: 'duplicated', CHARACTER_DELETED: 'deleted' },
            });
            expect([...eventSource.listeners.keys()].sort()).toEqual(['deleted', 'duplicated', 'renamed']);
        });
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

describe('Backgrounds scope', () => {
    const index = (map = {}, list = [{ id: 'u1', name: 'One' }, { id: 'u2', name: 'Two' }]) => folders.hydrateBackgroundIndex({ folders: list, imageFolderMap: map });
    let bridge;

    beforeEach(() => {
        bridge = { move: jest.fn(), unassign: jest.fn(), rename: jest.fn(), remove: jest.fn() };
        folders.attachBackgroundBridge(bridge);
        index();
    });

    test('settings saved before the scope existed load unchanged and gain nothing from loading the index', () => {
        expect(Object.keys(settings.sb_folders)).not.toContain('backgrounds');
        expect(folders.normalizeFolders()).toBe(false);
        expect(folders.getFolders('backgrounds').map(folder => [folder.id, folder.name, folder.expanded, folder.color])).toEqual([
            ['u1', 'One', true, ''], ['u2', 'Two', true, ''],
        ]);
        expect(Object.keys(settings.sb_folders)).not.toContain('backgrounds');
        expect(save).not.toHaveBeenCalled();
    });

    test('a file is in one folder: moving unassigns every folder it was in and assigns the one chosen', () => {
        index({ 'a.png': ['u1', 'u2'], 'b.png': ['u1'] });
        expect(folders.setFolder('backgrounds', ['a.png', 'b.png'], 'u2')).toBe(true);
        expect(folders.getFolderId('backgrounds', 'a.png')).toBe('u2');
        expect(folders.getFolderMembers('backgrounds', 'u1')).toEqual([]);
        expect(bridge.move).toHaveBeenCalledWith({ 'a.png': ['u1', 'u2'], 'b.png': ['u1'] }, 'u2');
        expect(save).not.toHaveBeenCalled();
    });

    test('a file that upstream data placed in two folders is a member of each until it is moved, and getFolderId names the first', () => {
        index({ 'a.png': ['u1', 'u2'] });
        expect(folders.getFolderMembers('backgrounds', 'u1')).toEqual(['a.png']);
        expect(folders.getFolderMembers('backgrounds', 'u2')).toEqual(['a.png']);
        expect(folders.getFolderId('backgrounds', 'a.png')).toBe('u1');
        expect(folders.setFolder('backgrounds', ['a.png'], 'u1')).toBe(true);
        expect(folders.getFolderMembers('backgrounds', 'u2')).toEqual([]);
        expect(bridge.move).toHaveBeenCalledWith({ 'a.png': ['u1', 'u2'] }, 'u1');
    });

    test('moving a file where it already is changes nothing, and No folder unfiles it', () => {
        index({ 'a.png': ['u1'] });
        expect(folders.setFolder('backgrounds', ['a.png'], 'u1')).toBe(false);
        expect(bridge.move).not.toHaveBeenCalled();
        expect(folders.setFolder('backgrounds', ['a.png'], null)).toBe(true);
        expect(folders.getFolderId('backgrounds', 'a.png')).toBeNull();
        expect(bridge.move).toHaveBeenCalledWith({ 'a.png': ['u1'] }, null);
        expect(() => folders.setFolder('backgrounds', ['a.png'], 'unknown')).toThrow(RangeError);
    });

    test('removing from one folder leaves the others', () => {
        index({ 'a.png': ['u1', 'u2'] });
        expect(folders.removeFromFolder('backgrounds', ['a.png'], 'u1')).toBe(true);
        expect(folders.getFolderMembers('backgrounds', 'u1')).toEqual([]);
        expect(folders.getFolderMembers('backgrounds', 'u2')).toEqual(['a.png']);
        expect(bridge.unassign).toHaveBeenCalledWith({ 'a.png': ['u1', 'u2'] }, 'u1');
        expect(folders.removeFromFolder('backgrounds', ['a.png'], 'u1')).toBe(false);
    });

    test('a stale folder id in the scope is ignored at render and not rewritten at load, and a folder the scope lacks shows with defaults', () => {
        settings.sb_folders.backgrounds = { folders: [{ id: 'gone', name: 'Gone', color: 'red', expanded: false }, { id: 'u2', name: 'Two', color: 'blue', expanded: false }], members: {} };
        index();
        expect(folders.getFolders('backgrounds').map(folder => [folder.id, folder.color, folder.expanded])).toEqual([['u2', 'blue', false], ['u1', '', true]]);
        expect(folders.normalizeFolders()).toBe(false);
        expect(settings.sb_folders.backgrounds.folders.map(folder => folder.id)).toEqual(['gone', 'u2']);
    });

    test('a membership with a folder id the index lacks is not a member of anything', () => {
        index({ 'a.png': ['gone'], 'b.png': ['gone', 'u1'] });
        expect(folders.getFolderId('backgrounds', 'a.png')).toBeNull();
        expect(folders.getFolderMembers('backgrounds', 'u1')).toEqual(['b.png']);
    });

    test('expanded state, colour and order persist in the scope, keep the order the user sees, and send nothing to the routes', () => {
        expect(folders.setFolderExpanded('backgrounds', 'u2', false)).toBe(true);
        expect(settings.sb_folders.backgrounds.folders.map(folder => [folder.id, folder.expanded])).toEqual([['u1', true], ['u2', false]]);
        expect(folders.setFolderColor('backgrounds', 'u1', 'red')).toBe(true);
        expect(folders.moveFolder('backgrounds', 'u2', -1)).toBe(true);
        expect(folders.getFolders('backgrounds').map(folder => folder.id)).toEqual(['u2', 'u1']);
        expect(save).toHaveBeenCalledTimes(3);
        expect(bridge.rename).not.toHaveBeenCalled();
        expect(bridge.move).not.toHaveBeenCalled();
    });

    test('a folder is created with the id the server issued, never with a made-up one', () => {
        expect(() => folders.createFolder('backgrounds', 'New')).toThrow(TypeError);
        const created = folders.createFolder('backgrounds', ' New ', { id: 'server-1' });
        expect(created).toMatchObject({ id: 'server-1', name: 'New' });
        expect(folders.getFolders('backgrounds').map(folder => folder.id)).toEqual(['u1', 'u2', 'server-1']);
        expect(() => folders.createFolder('backgrounds', 'Again', { id: 'server-1' })).toThrow(RangeError);
    });

    test('renaming goes to the route and the index name wins; deleting a folder leaves its files unfiled and drops its record', () => {
        index({ 'a.png': ['u1'], 'b.png': ['u1', 'u2'] });
        folders.setFolderColor('backgrounds', 'u1', 'red');
        expect(folders.renameFolder('backgrounds', 'u1', ' Uno ')).toBe(true);
        expect(bridge.rename).toHaveBeenCalledWith('u1', 'Uno');
        expect(folders.getFolders('backgrounds')[0].name).toBe('Uno');
        expect(folders.deleteFolder('backgrounds', 'u1')).toBe(true);
        expect(bridge.remove).toHaveBeenCalledWith('u1');
        expect(folders.getFolderId('backgrounds', 'a.png')).toBeNull();
        expect(folders.getFolderMembers('backgrounds', 'u2')).toEqual(['b.png']);
        expect(settings.sb_folders.backgrounds.folders.map(folder => folder.id)).toEqual(['u2']);
    });

    test('loading the index notifies once and a deleted file leaves its folders', () => {
        notify.mockClear();
        index({ 'a.png': ['u1'] });
        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify.mock.calls[0][0]).toMatchObject({ scope: 'backgrounds', reason: 'hydrate' });
        expect(folders.removeEntityKey('backgrounds', 'a.png')).toBe(true);
        expect(folders.getFolderId('backgrounds', 'a.png')).toBeNull();
    });
});
