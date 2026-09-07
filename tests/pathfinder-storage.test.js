/* eslint-disable playwright/no-standalone-expect */
import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { serializeWorldInfoEntry } from '../public/scripts/world-info-character-book.js';

await jest.unstable_mockModule('../public/scripts/extensions.js', () => ({ getContext: () => null }));
await jest.unstable_mockModule('../public/scripts/util/AccountStorage.js', () => ({ accountStorage: { getItem: () => null, setItem: jest.fn() } }));
await jest.unstable_mockModule('../public/scripts/world-info.js', () => ({
    createWorldInfoEntry: jest.fn(),
    syncWIOriginalDataEntry: (data, uid) => {
        const index = data.originalDataUidMap?.[uid];
        if (Number.isInteger(index)) data.originalData.entries[index] = serializeWorldInfoEntry(data.entries[uid], { before: 0, after: 1 }, data.originalData.entries[index]);
    },
    deleteWIOriginalDataValue: jest.fn(), reloadEditor: jest.fn(),
}));

const { clearAllTrees, deleteTree, getTree, saveTree, findNodeById, getAllEntryUids, replaceSettings } = await import('../public/scripts/extensions/in-chat-agents/pathfinder/tree-store.js');
const { buildTreeFromMetadata } = await import('../public/scripts/extensions/in-chat-agents/pathfinder/tree-builder.js');
const { LAYOUT_KEY, readTreeLayout } = await import('../public/scripts/extensions/in-chat-agents/pathfinder/tree-layout.js');
const {
    initEntryManagerAPIs, createEntry, createCategory, moveEntry, updateEntry, forgetEntry,
    onPathfinderWorldInfoUpdated, onPathfinderWorldInfoRenamed, onPathfinderWorldInfoDeleted,
} = await import('../public/scripts/extensions/in-chat-agents/pathfinder/entry-manager.js');

const importedLayout = () => ({ version: 1, tree: {
    id: 'root', name: 'Root', description: 'Book description', children: [
        { id: 'custom', name: 'Custom', description: 'Custom description', children: [] },
    ],
} });

describe('Pathfinder portable layouts', () => {
    let store;
    let save;

    beforeEach(async () => {
        clearAllTrees();
        store = { Book: { entries: {
            0: { uid: 0, comment: 'Character First', content: 'first' },
            1: { uid: 1, comment: 'Location Second', content: 'second' },
        } } };
        save = jest.fn(async (name, data) => {
            store[name] = structuredClone(data);
            onPathfinderWorldInfoUpdated(name, structuredClone(data));
            return name;
        });
        initEntryManagerAPIs(async name => store[name] ? structuredClone(store[name]) : null, (name, data) => {
            let uid = 0;
            while (data.entries[uid]) uid++;
            return (data.entries[uid] = { uid });
        }, save);
        await buildTreeFromMetadata('Book', store.Book);
    });

    test('persists hierarchy, order, descriptions, empty categories and entry placement, not UID arrays', async () => {
        const parent = await createCategory('Book', null, 'Custom', 'Parent description');
        const nested = await createCategory('Book', parent.nodeId, 'Nested', 'Nested description');
        await createCategory('Book', null, 'Empty', 'Keep this category');
        await moveEntry('Book', 0, nested.nodeId);
        const layout = store.Book.extensions[LAYOUT_KEY];
        expect(JSON.stringify(layout)).not.toContain('"entries"');
        expect(JSON.stringify(layout)).not.toContain('"localId"');
        expect(layout.tree.children.map(node => node.name)).toEqual(['Characters', 'Locations', 'Custom', 'Empty']);
        expect(layout.tree.children[0].generatedCategory).toBe('Characters');
        expect(layout.tree.children[2].children[0]).toMatchObject({ name: 'Nested', description: 'Nested description' });
        clearAllTrees();
        const rebuilt = await buildTreeFromMetadata('Book', structuredClone(store.Book));
        expect(findNodeById(rebuilt, nested.nodeId).entries).toEqual([0]);
        expect(rebuilt.children.at(-1)).toMatchObject({ name: 'Empty', entries: [] });
        expect(getAllEntryUids(rebuilt)).toHaveLength(2);
        await moveEntry('Book', 1, nested.nodeId);
        expect(findNodeById(getTree('Book'), nested.nodeId).entries).toEqual([0, 1]);
    });

    test('book export/duplicate copies local IDs but exposes distinct runtime IDs', async () => {
        const category = await createCategory('Book', null, 'Custom');
        await moveEntry('Book', 0, category.nodeId);
        store.Copy = JSON.parse(JSON.stringify(store.Book));
        const copy = await buildTreeFromMetadata('Copy', store.Copy);
        const copyCategory = copy.children.find(node => node.name === 'Custom');
        expect(copyCategory.id).not.toBe(category.nodeId);
        expect(copyCategory.localId).toBe(findNodeById(getTree('Book'), category.nodeId).localId);
        expect(copyCategory.entries).toEqual([0]);
        await expect(moveEntry('Copy', 0, category.nodeId)).rejects.toThrow('not found');
        deleteTree('Book');
        await buildTreeFromMetadata('Book', store.Book);
        expect(findNodeById(getTree('Book'), category.nodeId).entries).toEqual([0]);
    });

    test('uses originalData book metadata only when the native namespace is absent and mirrors it on write', async () => {
        store.Book.originalData = {
            entries: [{ id: 0, keys: [], content: 'first', extensions: {} }, { id: 1, keys: [], content: 'second', extensions: {} }],
            extensions: { foreign: 'keep', [LAYOUT_KEY]: importedLayout() },
        };
        store.Book.originalDataUidMap = { 0: 0, 1: 1 };
        store.Book.entries[0].extensions = { [LAYOUT_KEY]: { version: 1, nodeId: 'custom' } };
        const before = structuredClone(store.Book);
        clearAllTrees();
        const tree = await buildTreeFromMetadata('Book', store.Book);
        expect(tree.children[0]).toMatchObject({ name: 'Custom', entries: [0] });
        expect(store.Book).toEqual(before);
        expect(save).not.toHaveBeenCalled();
        const added = await createCategory('Book', null, 'Added');
        await moveEntry('Book', 0, added.nodeId);
        expect(store.Book.extensions[LAYOUT_KEY]).toEqual(store.Book.originalData.extensions[LAYOUT_KEY]);
        expect(store.Book.originalData.extensions.foreign).toBe('keep');
        expect(store.Book.originalData.entries[0].extensions[LAYOUT_KEY]).toEqual(store.Book.entries[0].extensions[LAYOUT_KEY]);

        store.Book.extensions[LAYOUT_KEY] = { version: 2, opaque: ['keep'] };
        const native = structuredClone(store.Book.extensions[LAYOUT_KEY]);
        expect(readTreeLayout(store.Book)).toBeNull();
        await expect(createCategory('Book', null, 'Do not overwrite')).rejects.toThrow('The saved waypoint layout is damaged or uses an unsupported format and will not be overwritten.');
        await updateEntry('Book', 0, 'ordinary entry edit');
        expect(store.Book.extensions[LAYOUT_KEY]).toEqual(native);
        expect(store.Book.originalData.extensions[LAYOUT_KEY]).toEqual(native);
    });

    test.each(['disable', 'agentBlacklisted'])('hides %s entries while retaining placement for re-enabling', async flag => {
        const custom = await createCategory('Book', null, 'Custom');
        await moveEntry('Book', 0, custom.nodeId);
        const placement = structuredClone(store.Book.entries[0].extensions[LAYOUT_KEY]);
        store.Book.entries[0][flag] = true;
        clearAllTrees();
        await buildTreeFromMetadata('Book', store.Book);
        expect(findNodeById(getTree('Book'), custom.nodeId).entries).toEqual([]);
        expect(store.Book.entries[0].extensions[LAYOUT_KEY]).toEqual(placement);
        store.Book.entries[0][flag] = false;
        await buildTreeFromMetadata('Book', store.Book);
        expect(findNodeById(getTree('Book'), custom.nodeId).entries).toEqual([0]);
        expect(save).toHaveBeenCalledTimes(2);
    });

    test('deleting and reusing a UID cannot inherit cached placement', async () => {
        const custom = await createCategory('Book', null, 'Custom');
        await moveEntry('Book', 0, custom.nodeId);
        await forgetEntry('Book', 0, true);
        const created = await createEntry('Book', 'Location Fresh', 'fresh');
        expect(created.uid).toBe(0);
        expect(store.Book.entries[0].extensions?.[LAYOUT_KEY]).toBeUndefined();
        expect(findNodeById(getTree('Book'), custom.nodeId).entries).toEqual([]);
        expect(getTree('Book').children.find(node => node.name === 'Locations').entries).toContain(0);
    });

    test('same-book entry duplicates copy placement; foreign copies and dangling references auto-categorise', async () => {
        const custom = await createCategory('Book', null, 'Custom');
        await moveEntry('Book', 0, custom.nodeId);
        store.Book.entries[2] = { ...structuredClone(store.Book.entries[0]), uid: 2 };
        await buildTreeFromMetadata('Book', store.Book);
        expect(findNodeById(getTree('Book'), custom.nodeId).entries).toEqual([0, 2]);
        store.Foreign = { entries: { 2: structuredClone(store.Book.entries[2]) } };
        const foreign = await buildTreeFromMetadata('Foreign', store.Foreign);
        expect(foreign.children[0]).toMatchObject({ name: 'Characters', entries: [2] });
        expect(store.Foreign.entries[2].extensions[LAYOUT_KEY]).toEqual(store.Book.entries[2].extensions[LAYOUT_KEY]);
        store.Book.entries[0].extensions[LAYOUT_KEY].nodeId = 'missing';
        const before = structuredClone(store.Book);
        await buildTreeFromMetadata('Book', store.Book);
        expect(getTree('Book').children.find(node => node.name === 'Characters').entries).toContain(0);
        expect(store.Book).toEqual(before);
    });

    test('keeps unsupported entry metadata opaque instead of overwriting it during a move', async () => {
        const placement = { version: 2, nodeId: 'future', opaque: { retained: true } };
        store.Book.entries[0].extensions = { [LAYOUT_KEY]: placement };
        await expect(moveEntry('Book', 0, getTree('Book').id)).rejects.toThrow('Cannot move unsupported or invalid waypoint placement.');
        expect(save).not.toHaveBeenCalled();
        await updateEntry('Book', 0, 'updated content');
        expect(store.Book.entries[0].extensions[LAYOUT_KEY]).toEqual(placement);
    });

    test('category and entry creation share the same queue', async () => {
        await Promise.all([createCategory('Book', null, 'Concurrent category'), createEntry('Book', 'Concurrent entry', 'saved')]);
        expect(getTree('Book').children.some(node => node.name === 'Concurrent category')).toBe(true);
        expect(Object.values(store.Book.entries).some(entry => entry.comment === 'Concurrent entry')).toBe(true);
        expect(save).toHaveBeenCalledTimes(2);
    });

    test('does not publish a category or change the loaded cache until its save commits', async () => {
        const before = structuredClone(store);
        const tree = structuredClone(getTree('Book'));
        let release;
        let started;
        const saving = new Promise(resolve => { started = resolve; });
        save.mockImplementationOnce(async (name, data) => {
            started();
            await new Promise(resolve => { release = resolve; });
            store[name] = structuredClone(data);
            return name;
        });
        const operation = createCategory('Book', null, 'Pending');
        await saving;
        expect(store).toEqual(before);
        expect(getTree('Book')).toEqual(tree);
        release();
        const result = await operation;
        expect(findNodeById(getTree('Book'), result.nodeId).name).toBe('Pending');
    });

    test('failed category and move saves leave the persisted and cached layout intact', async () => {
        const custom = await createCategory('Book', null, 'Custom');
        const before = structuredClone(store);
        const tree = structuredClone(getTree('Book'));
        save.mockRejectedValueOnce(new Error('offline'));
        await expect(createCategory('Book', null, 'Unsaved')).rejects.toThrow('offline');
        save.mockResolvedValueOnce(null);
        await expect(moveEntry('Book', 0, custom.nodeId)).rejects.toThrow('The lorebook save did not complete.');
        expect(store).toEqual(before);
        expect(getTree('Book')).toEqual(tree);
    });

    test('re-reads the host commit so concurrent native metadata is not hidden by the private draft', async () => {
        save.mockImplementationOnce(async (name, data) => {
            store[name] = structuredClone(data);
            store[name].entries[2] = { uid: 2, comment: 'Native note', content: 'saved by editor' };
            return name;
        });
        await createCategory('Book', null, 'Custom');
        expect(getAllEntryUids(getTree('Book'))).toContain(2);
    });

    test('rename keeps returned IDs valid even when both the event and save result report it', async () => {
        save.mockImplementationOnce(async (name, data) => {
            store.Renamed = structuredClone(data);
            delete store[name];
            onPathfinderWorldInfoRenamed(name, 'Renamed');
            return 'Renamed';
        });
        const custom = await createCategory('Book', null, 'Custom');
        expect(custom.bookName).toBe('Renamed');
        expect(getTree('Book')).toBeNull();
        expect(findNodeById(getTree('Renamed'), custom.nodeId).name).toBe('Custom');
        clearAllTrees();
        await buildTreeFromMetadata('Renamed', store.Renamed);
        expect(findNodeById(getTree('Renamed'), custom.nodeId).name).toBe('Custom');
    });

    test('replacement and deletion retire runtime IDs instead of applying stale moves to new books', async () => {
        const custom = await createCategory('Book', null, 'Custom');
        onPathfinderWorldInfoUpdated('Book', store.Book, { replaced: true });
        await buildTreeFromMetadata('Book', store.Book);
        expect(findNodeById(getTree('Book'), custom.nodeId)).toBeNull();
        const current = getTree('Book').id;
        onPathfinderWorldInfoDeleted('Book');
        await buildTreeFromMetadata('Book', store.Book);
        expect(getTree('Book').id).not.toBe(current);
        await expect(moveEntry('Book', 0, custom.nodeId)).rejects.toThrow('not found');
    });

    test('tree and settings cache APIs never write lorebooks', async () => {
        const before = structuredClone(store);
        replaceSettings({ enabledLorebooks: ['Book'] });
        saveTree('Book', structuredClone(getTree('Book')));
        deleteTree('Book');
        await buildTreeFromMetadata('Book', store.Book);
        expect(save).not.toHaveBeenCalled();
        expect(store).toEqual(before);
    });

    const invalidLayouts = [
        ['unknown version', { version: 2, opaque: 'keep' }],
        ['null namespace', null],
        ['invalid root', { version: 1, tree: [] }],
        ['invalid ID', { version: 1, tree: { ...importedLayout().tree, id: 'bad:id' } }],
        ['duplicate ID', { version: 1, tree: { ...importedLayout().tree, id: 'custom' } }],
        ['unknown fields', { ...importedLayout(), future: true }],
        ['entry arrays', { version: 1, tree: { ...importedLayout().tree, entries: [0] } }],
        ['oversized description', { version: 1, tree: { ...importedLayout().tree, description: 'x'.repeat(4097) } }],
        ['too many nodes', { version: 1, tree: { ...importedLayout().tree, children: Array.from({ length: 2048 }, (_, index) => ({ id: `n${index}`, name: '', description: '', children: [] })) } }],
        ['oversized layout', { version: 1, tree: { ...importedLayout().tree, children: Array.from({ length: 100 }, (_, index) => ({ id: `n${index}`, name: '', description: 'x'.repeat(4096), children: [] })) } }],
    ];
    const deep = importedLayout();
    let last = deep.tree;
    for (let depth = 0; depth < 34; depth++) {
        const child = { id: `deep${depth}`, name: '', description: '', children: [] };
        last.children = [child];
        last = child;
    }
    invalidLayouts.push(['too deep', deep]);

    test.each(invalidLayouts)('preserves %s imports and refuses destructive layout rewrites', async (name, layout) => {
        store.Book.extensions = { foreign: 'retained', [LAYOUT_KEY]: layout };
        const before = structuredClone(store);
        const tree = await buildTreeFromMetadata('Book', store.Book);
        expect(getAllEntryUids(tree)).toEqual([0, 1]);
        expect(readTreeLayout(store.Book)).toBeNull();
        await expect(createCategory('Book', null, 'Unsafe rewrite')).rejects.toThrow('The saved waypoint layout is damaged or uses an unsupported format and will not be overwritten.');
        expect(store).toEqual(before);
        expect(save).not.toHaveBeenCalled();
    });
});
