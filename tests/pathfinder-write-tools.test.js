/* eslint-disable playwright/no-standalone-expect, playwright/no-duplicate-hooks */
/* global globalThis */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

await jest.unstable_mockModule('../public/scripts/extensions.js', () => ({ getContext: jest.fn(() => null) }));
await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/agent-store.js', () => ({ isPathfinderSubmoduleEnabled: () => true }));
await jest.unstable_mockModule('../public/scripts/util/AccountStorage.js', () => ({
    accountStorage: { getItem: () => null, setItem: jest.fn() },
}));
await jest.unstable_mockModule('../public/scripts/world-info.js', () => ({
    createWorldInfoEntry: jest.fn(), syncWIOriginalDataEntry: jest.fn(), deleteWIOriginalDataValue: jest.fn(), reloadEditor: jest.fn(),
}));

const { clearAllTrees, getTree, getSettings, replaceSettings, setBookPermission } = await import('../public/scripts/extensions/in-chat-agents/pathfinder/tree-store.js');
const { buildTreeFromMetadata } = await import('../public/scripts/extensions/in-chat-agents/pathfinder/tree-builder.js');
const { initEntryManagerAPIs } = await import('../public/scripts/extensions/in-chat-agents/pathfinder/entry-manager.js');
const { getToolAction } = await import('../public/scripts/extensions/in-chat-agents/tool-action-registry.js');
for (const tool of ['remember', 'update', 'forget', 'merge-split', 'reorganize', 'summarize']) {
    (await import(`../public/scripts/extensions/in-chat-agents/pathfinder/tools/${tool}.js`)).registerActions();
}

describe('Pathfinder write tool actions', () => {
    let store;
    let save;
    let load;

    beforeEach(async () => {
        clearAllTrees();
        replaceSettings({ enabledLorebooks: ['Memory Book', 'Second Book'], includeContextualLorebooks: false });
        store = {
            'Memory Book': { entries: {
                0: { uid: 0, comment: 'Zero', content: 'zero' },
                3: { uid: 3, comment: 'Existing', content: 'existing' },
            } },
            'Second Book': { entries: { 3: { uid: 3, comment: 'Unrelated', content: 'untouched' } } },
        };
        load = jest.fn(async name => store[name] ? structuredClone(store[name]) : null);
        save = jest.fn(async (name, data) => {
            store[name] = structuredClone(data);
            return name;
        });
        initEntryManagerAPIs(load, (name, data) => {
            const uid = Math.max(-1, ...Object.keys(data.entries).map(Number)) + 1;
            return (data.entries[uid] = { uid });
        }, save);
        globalThis.window = { SillyTavern: { getContext: () => ({ loadWorldInfo: load }) } };
        await buildTreeFromMetadata('Memory Book', store['Memory Book']);
    });

    afterEach(() => { delete globalThis.window; });

    test.each([
        ['remember', { title: 'New', content: 'new' }],
        ['update', { uid: 3, content: 'changed' }],
        ['forget', { uid: 3 }],
        ['forget', { uid: 3, hard_delete: true }],
        ['merge_split', { action: 'merge', uid1: 0, uid2: 3 }],
        ['merge_split', { action: 'split', uid: 3, content1: 'one', content2: 'two' }],
        ['reorganize', { action: 'create_waypoint', name: 'New' }],
        ['reorganize', { action: 'move', uid: 3 }],
        ['summarize', { title: 'Summary', content: 'new summary' }],
    ])('cancels a pending %s before saving after Stop or a permission change (%j)', async (tool, args) => {
        getSettings().dedupDetection = false;
        const before = structuredClone(store);
        for (const reason of ['stop', 'context', 'permission']) {
            let release;
            let started;
            const loading = new Promise(resolve => { started = resolve; });
            load.mockImplementationOnce(() => new Promise(resolve => { release = resolve; started(); }));
            const controller = new AbortController();
            let current = true;
            const pending = getToolAction(`pathfinder_${tool}`)({
                ...args, book: 'Memory Book', target_node_id: getTree('Memory Book').id,
            }, { signal: controller.signal, isCurrent: () => current });
            await loading;
            const permission = args.hard_delete || args.action === 'merge' ? 'delete' : 'write';
            if (reason === 'stop') controller.abort();
            if (reason === 'context') current = false;
            if (reason === 'permission') setBookPermission('Memory Book', permission, false);
            release(structuredClone(store['Memory Book']));
            await pending;
            expect(store).toEqual(before);
            expect(save).not.toHaveBeenCalled();
            setBookPermission('Memory Book', permission, true);
        }
    });

    test.each([undefined, null, false, true, '', '  ', [], [0], {}, { uid: 0 }, 0.5, '3.5', -1, NaN, Infinity])('rejects raw UID %p before it can address a real entry', async uid => {
        const before = structuredClone(store);
        const calls = [
            ['pathfinder_update', { uid, content: 'new' }],
            ['pathfinder_forget', { uid, hard_delete: true }],
            ['pathfinder_merge_split', { action: 'merge', uid1: uid, uid2: 3 }],
            ['pathfinder_merge_split', { action: 'merge', uid1: 0, uid2: uid }],
            ['pathfinder_merge_split', { action: 'split', uid, content1: 'one', content2: 'two' }],
            ['pathfinder_reorganize', { action: 'move', uid, target_node_id: getTree('Memory Book').id }],
        ];
        for (const [action, args] of calls) {
            expect(await getToolAction(action)(args)).toContain('uid');
        }
        expect(save).not.toHaveBeenCalled();
        expect(store).toEqual(before);
    });

    test.each([0, '0', ' 3 '])('continues accepting numeric zero and numeric strings: %p', async uid => {
        const result = await getToolAction('pathfinder_update')({ uid, content: 'changed' });
        expect(result).toContain('Updated');
        expect(store['Memory Book'].entries[Number(uid)].content).toBe('changed');
        expect(store['Second Book'].entries[3].content).toBe('untouched');
    });

    test.each([false, 'false', '0', 'no'])('uses explicit false deletion flag %p for a soft disable', async hardDelete => {
        const result = await getToolAction('pathfinder_forget')({ uid: 3, hard_delete: hardDelete });
        expect(result).toContain('Disabled');
        expect(store['Memory Book'].entries[3].disable).toBe(true);
    });

    test.each([true, 'true', '1', 'yes'])('uses explicit true deletion flag %p for permanent deletion', async hardDelete => {
        const result = await getToolAction('pathfinder_forget')({ uid: 3, hard_delete: hardDelete });
        expect(result).toContain('Deleted');
        expect(store['Memory Book'].entries[3]).toBeUndefined();
    });

    test.each([null, 0, 1, [], {}, 'maybe', ''])('rejects invalid deletion flag %p without even disabling', async hardDelete => {
        expect(await getToolAction('pathfinder_forget')({ uid: 3, hard_delete: hardDelete })).toBe('Permanent deletion request refused; the tool supplied an invalid permanent deletion choice.');
        expect(save).not.toHaveBeenCalled();
        expect(store['Memory Book'].entries[3].disable).toBeUndefined();
    });

    test('refuses explicit unavailable books instead of retargeting any write', async () => {
        for (const [action, args] of [
            ['pathfinder_update', { uid: 3, content: 'new' }],
            ['pathfinder_forget', { uid: 3 }],
            ['pathfinder_remember', { title: 'New', content: 'new' }],
            ['pathfinder_merge_split', { action: 'merge', uid1: 0, uid2: 3 }],
            ['pathfinder_reorganize', { action: 'create_waypoint', name: 'New' }],
        ]) {
            expect(await getToolAction(action)({ ...args, book: 'Wrong Book' })).toContain('"Wrong Book" is not available');
        }
        expect(save).not.toHaveBeenCalled();
    });

    test.each(['write', 'delete'])('merge requires %s permission as well as the other permission', async permission => {
        setBookPermission('Memory Book', permission, false);
        const result = await getToolAction('pathfinder_merge_split')({ action: 'merge', uid1: 0, uid2: 3, book: 'Memory Book' });
        expect(result).toContain('is not available');
        expect(save).not.toHaveBeenCalled();
    });

    test('split requires write permission, not delete permission', async () => {
        setBookPermission('Memory Book', 'delete', false);
        const result = await getToolAction('pathfinder_merge_split')({ action: 'split', uid: '0', content1: 'one', content2: 'two', book: 'Memory Book' });
        expect(result).toContain('Split UID:0');
        expect(Object.values(store['Memory Book'].entries).map(entry => entry.content)).toEqual(expect.arrayContaining(['one', 'two']));
    });

    test.each(['disable', 'agentBlacklisted'])('rejects a move of an excluded entry: %s', async flag => {
        store['Memory Book'].entries[3][flag] = true;
        const result = await getToolAction('pathfinder_reorganize')({ action: 'move', uid: 3, target_node_id: getTree('Memory Book').id });
        expect(result).toContain('not found');
        expect(save).not.toHaveBeenCalled();
    });

    test('rejects an array masquerading as a destination ID', async () => {
        const result = await getToolAction('pathfinder_reorganize')({ action: 'move', uid: 0, target_node_id: [getTree('Memory Book').id] });
        expect(result).toContain('"target_node_id" required');
        expect(save).not.toHaveBeenCalled();
    });

    test('reports an eligible duplicate without saving', async () => {
        getSettings().dedupDetection = true;
        store['Memory Book'].entries[3].content = 'The dragon guards the northern pass every night.';
        const result = await getToolAction('pathfinder_remember')({ title: 'Dragon', content: store['Memory Book'].entries[3].content });
        expect(result).toContain('Not saved');
        expect(result).toContain('UID: 3');
        expect(save).not.toHaveBeenCalled();
    });

    test.each(['disable', 'agentBlacklisted', 'readDenied'])('duplicate checking never exposes excluded contents: %s', async flag => {
        getSettings().dedupDetection = true;
        store['Memory Book'].entries[3].comment = 'Secret title';
        store['Memory Book'].entries[3].content = 'The dragon guards the northern pass every night.';
        if (flag === 'readDenied') setBookPermission('Memory Book', 'read', false);
        else store['Memory Book'].entries[3][flag] = true;
        const result = await getToolAction('pathfinder_remember')({ title: 'Dragon', content: store['Memory Book'].entries[3].content });
        expect(result).toContain('Remembered');
        expect(result).not.toContain('Secret title');
        expect(result).not.toContain('UID: 3');
        expect(save).toHaveBeenCalledTimes(1);
    });
});
