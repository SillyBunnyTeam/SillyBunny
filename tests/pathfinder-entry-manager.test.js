import { beforeEach, describe, expect, jest, test } from '@jest/globals';

await jest.unstable_mockModule('../public/scripts/extensions.js', () => ({
    getContext: jest.fn(() => null),
}));

await jest.unstable_mockModule('../public/scripts/world-info.js', () => ({
    createWorldInfoEntry: jest.fn(),
}));

const {
    clearAllTrees,
    createTreeNode,
    getTree,
    saveTree,
} = await import('../public/scripts/extensions/in-chat-agents/pathfinder/tree-store.js');

const {
    createEntry,
    forgetEntry,
    initEntryManagerAPIs,
    mergeEntries,
    moveEntry,
} = await import('../public/scripts/extensions/in-chat-agents/pathfinder/entry-manager.js');

describe('Pathfinder entry manager', () => {
    let store;
    let nextUid;

    beforeEach(() => {
        clearAllTrees();
        store = {
            'Memory Book': {
                entries: {
                    '1': { uid: 1, comment: 'First', content: 'first content', key: ['first'] },
                    '2': { uid: 2, comment: 'Second', content: 'second content', key: ['second'] },
                },
            },
        };
        nextUid = 10;

        initEntryManagerAPIs(
            jest.fn(async name => (store[name] ? structuredClone(store[name]) : null)),
            jest.fn(async (name, data) => {
                const entry = { uid: nextUid++ };
                data.entries[String(entry.uid)] = entry;
                return entry;
            }),
            jest.fn(async (name, data) => {
                store[name] = structuredClone(data);
            }),
        );
    });

    test('refuses to merge an entry with itself and leaves the entry intact', async () => {
        await expect(mergeEntries('Memory Book', 1, 1)).rejects.toThrow('merge an entry with itself');

        expect(store['Memory Book'].entries['1']).toMatchObject({ uid: 1, content: 'first content' });
    });

    test('merges two entries and removes the second from book and tree', async () => {
        const tree = createTreeNode('Root', '', [], [createTreeNode('Characters', '', [1, 2])]);
        saveTree('Memory Book', tree);

        const result = await mergeEntries('Memory Book', 1, 2);

        expect(result).toEqual({ mergedUid: 1, removedUid: 2, bookName: 'Memory Book' });
        expect(store['Memory Book'].entries['1'].content).toContain('second content');
        expect(store['Memory Book'].entries['2']).toBeUndefined();
        expect(getTree('Memory Book').children[0].entries).toEqual([1]);
    });

    test('rejects moving an entry to a nonexistent waypoint without unfiling it', async () => {
        const tree = createTreeNode('Root', '', [], [createTreeNode('Characters', '', [1])]);
        saveTree('Memory Book', tree);

        await expect(moveEntry('Memory Book', 1, 'node_missing')).rejects.toThrow('not found');

        expect(getTree('Memory Book').children[0].entries).toEqual([1]);
    });

    test('moves an entry between waypoints', async () => {
        const source = createTreeNode('Characters', '', [1]);
        const target = createTreeNode('Locations', '', []);
        saveTree('Memory Book', createTreeNode('Root', '', [], [source, target]));

        await moveEntry('Memory Book', 1, target.id);

        expect(source.entries).toEqual([]);
        expect(target.entries).toEqual([1]);
    });

    test('serializes concurrent writes so neither snapshot clobbers the other', async () => {
        await Promise.all([
            createEntry('Memory Book', 'Alpha', 'alpha content'),
            createEntry('Memory Book', 'Beta', 'beta content'),
        ]);

        const comments = Object.values(store['Memory Book'].entries).map(entry => entry.comment);
        expect(comments).toEqual(expect.arrayContaining(['Alpha', 'Beta']));
        expect(Object.keys(store['Memory Book'].entries)).toHaveLength(4);
    });

    test('soft forget disables the entry and drops it from the tree', async () => {
        const tree = createTreeNode('Root', '', [], [createTreeNode('Characters', '', [2])]);
        saveTree('Memory Book', tree);

        const result = await forgetEntry('Memory Book', 2, false);

        expect(result).toMatchObject({ disabled: true, deleted: false });
        expect(store['Memory Book'].entries['2'].disable).toBe(true);
        expect(getTree('Memory Book').children[0].entries).toEqual([]);
    });
});
