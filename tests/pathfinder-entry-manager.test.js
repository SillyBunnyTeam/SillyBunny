/* eslint-disable playwright/no-standalone-expect */
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

import { serializeWorldInfoEntry } from '../public/scripts/world-info-character-book.js';
import { importWorldInfoModule } from './util/world-info-module-harness.js';

const { worldInfo, mocks, $ } = await importWorldInfoModule();
const positions = worldInfo.world_info_position;
worldInfo.setWorldInfoSettings({}, { world_names: ['Memory Book'] });
$('#world_editor_select').val('0');

// entry-manager imports world-info.js directly; it binds to the live world-info module loaded above.
const { clearAllTrees, getAllEntryUids, getTree, findNodeById, isPathfinderSelfWrite } = await import('../public/scripts/extensions/in-chat-agents/pathfinder/tree-store.js');
const { buildTreeFromMetadata } = await import('../public/scripts/extensions/in-chat-agents/pathfinder/tree-builder.js');
const { LAYOUT_KEY } = await import('../public/scripts/extensions/in-chat-agents/pathfinder/tree-layout.js');
const {
    createEntry, createCategory, updateEntry, forgetEntry, initEntryManagerAPIs, mergeEntries, moveEntry, splitEntry,
} = await import('../public/scripts/extensions/in-chat-agents/pathfinder/entry-manager.js');

describe('Pathfinder entry manager', () => {
    let store;
    let save;

    beforeEach(async () => {
        jest.clearAllMocks();
        clearAllTrees();
        $('#world_editor_select').val('0');
        $('#world_editor_select').trigger.mockClear();

        const first = {
            uid: 1, comment: 'Character First', content: 'first content', key: ['/first/i'], keysecondary: ['other'],
            selective: true, selectiveLogic: 2, constant: true, position: 4, depth: 8, order: 75,
            probability: 35, useProbability: true, sticky: 3, cooldown: 4, triggers: ['normal'],
            characterFilter: { names: ['Hero'], isExclude: false }, extensions: { custom: { kept: true } },
        };
        const second = { uid: 2, comment: 'Location Second', content: 'second content', key: ['second'] };
        store = {
            'Memory Book': {
                entries: { 1: first, 2: second },
                originalData: {
                    entries: [
                        { ...serializeWorldInfoEntry(first, positions), id: 901, customCardField: 'retained' },
                        { ...serializeWorldInfoEntry(second, positions), id: 902 },
                    ],
                    extensions: { foreign: 'retained' },
                },
                originalDataUidMap: { 1: 0, 2: 1 },
            },
        };
        save = jest.fn(async (name, data) => {
            store[name] = structuredClone(data);
            return name;
        });
        initEntryManagerAPIs(
            jest.fn(async name => (store[name] ? structuredClone(store[name]) : null)),
            jest.fn(async (name, data) => worldInfo.createWorldInfoEntry(name, data)),
            save,
        );
        mocks.getContext.mockReturnValue(null);
        await buildTreeFromMetadata('Memory Book', store['Memory Book']);
    });

    test('refuses a self-merge, including equivalent numeric strings', async () => {
        await expect(mergeEntries('Memory Book', 1, '1')).rejects.toThrow('merge an entry with itself');
        expect(store['Memory Book'].entries[1].content).toBe('first content');
        expect(save).not.toHaveBeenCalled();
    });

    test('merges entries, retains the first placement and resynchronises the imported record', async () => {
        const firstNode = getTree('Memory Book').children.find(node => node.entries.includes(1));
        const result = await mergeEntries('Memory Book', 1, 2, 'Location combined');
        const data = store['Memory Book'];
        expect(result).toEqual({ mergedUid: 1, removedUid: 2, bookName: 'Memory Book' });
        expect(data.entries[1].content).toContain('second content');
        expect(data.entries[2]).toBeUndefined();
        expect(findNodeById(getTree('Memory Book'), firstNode.id).entries).toEqual([1]);
        expect(data.originalData.entries).toHaveLength(1);
        expect(data.originalData.entries[0]).toMatchObject({ content: data.entries[1].content, customCardField: 'retained' });
        expect(data.originalDataUidMap).toEqual({ 1: 0 });
    });

    test('rejects a nonexistent waypoint without unfiling the entry', async () => {
        const before = structuredClone(getTree('Memory Book'));
        await expect(moveEntry('Memory Book', 1, 'node_missing')).rejects.toThrow('not found');
        expect(getTree('Memory Book')).toEqual(before);
        expect(save).not.toHaveBeenCalled();
    });

    test('moves an entry using a private tree and updates both native and imported placement', async () => {
        const target = await createCategory('Memory Book', null, 'Custom');
        const before = getTree('Memory Book');
        await moveEntry('Memory Book', '1', target.nodeId);
        expect(findNodeById(before, target.nodeId).entries).toEqual([]);
        expect(findNodeById(getTree('Memory Book'), target.nodeId).entries).toEqual([1]);
        const data = store['Memory Book'];
        expect(data.originalData.entries[0].extensions[LAYOUT_KEY]).toEqual(data.entries[1].extensions[LAYOUT_KEY]);
    });

    test('serialises concurrent entry writes and populates the imported records after creation', async () => {
        const created = await Promise.all([
            createEntry('Memory Book', 'Alpha', 'alpha content'),
            createEntry('Memory Book', 'Beta', 'beta content'),
        ]);
        const data = store['Memory Book'];
        expect(Object.keys(data.entries)).toHaveLength(4);
        expect(data.originalData.entries).toHaveLength(4);
        expect(data.originalData.entries.slice(2).map(entry => entry.content)).toEqual(['alpha content', 'beta content']);
        expect(data.originalDataUidMap[created[1].uid]).toBe(3);
        expect($('#world_editor_select').trigger).toHaveBeenCalledWith('change');
    });

    test('updates content and title without changing activation or custom metadata', async () => {
        const before = structuredClone(store['Memory Book'].entries[1]);
        await updateEntry('Memory Book', '1', 'edited', 'New title');
        const data = store['Memory Book'];
        expect(data.entries[1]).toEqual({ ...before, content: 'edited', comment: 'New title' });
        expect(data.originalData.entries[0]).toMatchObject({
            id: 901, content: 'edited', comment: 'New title', customCardField: 'retained',
            constant: true, selective: true, extensions: { custom: { kept: true }, depth: 8, probability: 35 },
        });
    });

    test('splits all applicable native and card-only metadata while preserving the new UID and source placement', async () => {
        store['Memory Book'].originalData.entries[1].id = 0;
        const before = structuredClone(store['Memory Book'].entries[1]);
        const firstNode = getTree('Memory Book').children.find(node => node.entries.includes(1));
        const result = await splitEntry('Memory Book', 1, 'First half', 'one', 'Location second half', 'two');
        const data = store['Memory Book'];
        expect(result.newUid).not.toBe(1);
        expect(data.entries[result.newUid]).toEqual({
            ...worldInfo.newWorldInfoEntryTemplate,
            ...before, uid: result.newUid, comment: 'Location second half', content: 'two', disable: false,
            extensions: { ...before.extensions, [LAYOUT_KEY]: data.entries[1].extensions[LAYOUT_KEY] },
        });
        expect(data.entries[result.newUid].extensions.custom).not.toBe(data.entries[1].extensions.custom);
        expect(findNodeById(getTree('Memory Book'), firstNode.id).entries).toEqual([result.newUid, 1]);
        expect(data.originalData.entries[data.originalDataUidMap[result.newUid]]).toMatchObject({
            id: 1, content: 'two', comment: 'Location second half', customCardField: 'retained',
            constant: true, selective: true, extensions: { custom: { kept: true }, sticky: 3, cooldown: 4 },
        });
        expect(data.originalData.entries[0].content).toBe('one');
        expect(data.originalData.entries.map(entry => entry.id)).toEqual([901, 0, 1]);
    });

    test('updates mapped original IDs [74, 0] without replacing them with native UIDs [0, 1]', async () => {
        const data = store['Memory Book'];
        data.entries = { 0: { ...data.entries[1], uid: 0 }, 1: { ...data.entries[2], uid: 1 } };
        data.originalData.entries[0].id = 74;
        data.originalData.entries[1].id = 0;
        data.originalDataUidMap = { 0: 0, 1: 1 };
        await updateEntry('Memory Book', 0, 'updated');
        await forgetEntry('Memory Book', 1);
        const records = store['Memory Book'].originalData.entries;
        expect(records.map(entry => entry.id)).toEqual([74, 0]);
        expect(records[0]).toMatchObject({ content: 'updated', customCardField: 'retained' });
        expect(records[1].enabled).toBe(false);
    });

    test('new entries receive a free original ID even when their native UID is already a card ID', async () => {
        // Real createWorldInfoEntry allocates native UID 0; colliding card ID 0 forces free card ID 1.
        store['Memory Book'].originalData.entries[1].id = 0;
        const created = await createEntry('Memory Book', 'New', 'new');
        expect(created.uid).toBe(0);
        expect(store['Memory Book'].originalData.entries.map(entry => entry.id)).toEqual([901, 0, 1]);
    });

    test('soft forget hides content without losing saved placement and updates the imported enabled flag', async () => {
        const target = await createCategory('Memory Book', null, 'Custom');
        await moveEntry('Memory Book', 2, target.nodeId);
        const placement = structuredClone(store['Memory Book'].entries[2].extensions[LAYOUT_KEY]);
        const result = await forgetEntry('Memory Book', 2, false);
        expect(result).toMatchObject({ disabled: true, deleted: false });
        expect(store['Memory Book'].entries[2].extensions[LAYOUT_KEY]).toEqual(placement);
        expect(store['Memory Book'].originalData.entries[1].enabled).toBe(false);
        expect(getAllEntryUids(getTree('Memory Book'))).not.toContain(2);
    });

    test('hard forget updates the UID map before a later update and reused UID creation', async () => {
        // Seed UID 0 so hard-forgetting UID 1 makes UID 1 the next free UID allocated by createWorldInfoEntry.
        const zeroEntry = { uid: 0, comment: 'Anchor', content: 'anchor', key: ['anchor'] };
        store['Memory Book'].entries[0] = zeroEntry;
        store['Memory Book'].originalData.entries.push({ ...serializeWorldInfoEntry(zeroEntry, positions), id: 900 });
        store['Memory Book'].originalDataUidMap[0] = 2;

        await forgetEntry('Memory Book', 1, true);
        await updateEntry('Memory Book', 2, 'survives');
        const created = await createEntry('Memory Book', 'Fresh', 'new entry');
        const data = store['Memory Book'];
        expect(created.uid).toBe(1);
        expect(data.originalDataUidMap).toEqual({ 2: 0, 0: 1, 1: 2 });
        expect(data.originalData.entries.map(entry => entry.content)).toEqual(['survives', 'anchor', 'new entry']);
        expect(data.entries[1].extensions?.[LAYOUT_KEY]).toBeUndefined();
    });

    test('a previously disabled entry can still be edited without enabling it and permanently deleted', async () => {
        await forgetEntry('Memory Book', 1);
        await updateEntry('Memory Book', 1, 'edited while disabled');
        expect(store['Memory Book'].entries[1]).toMatchObject({ disable: true, content: 'edited while disabled' });
        expect(store['Memory Book'].originalData.entries[0]).toMatchObject({ enabled: false, content: 'edited while disabled' });
        await forgetEntry('Memory Book', 1, true);
        expect(store['Memory Book'].entries[1]).toBeUndefined();
        expect(store['Memory Book'].originalDataUidMap).toEqual({ 2: 0 });
    });

    test.each([false, true])('blacklisted entries reject update and both forget modes, including disabled=%p', async disable => {
        Object.assign(store['Memory Book'].entries[1], { agentBlacklisted: true, disable });
        const before = structuredClone(store);
        await expect(updateEntry('Memory Book', 1, 'blocked')).rejects.toThrow('not found');
        await expect(forgetEntry('Memory Book', 1)).rejects.toThrow('not found');
        await expect(forgetEntry('Memory Book', 1, true)).rejects.toThrow('not found');
        expect(store).toEqual(before);
        expect(save).not.toHaveBeenCalled();
    });

    test('queued creation still checks isCurrent before mutation or saving', async () => {
        const before = structuredClone(store);
        await expect(createEntry('Memory Book', 'Cancelled', 'cancelled', [], { isCurrent: () => false })).rejects.toMatchObject({ name: 'AbortError' });
        expect(store).toEqual(before);
        expect(save).not.toHaveBeenCalled();
    });

    test.each([
        ['create', () => createEntry('Memory Book', 'New', 'new')],
        ['update', () => updateEntry('Memory Book', 1, 'changed')],
        ['forget', () => forgetEntry('Memory Book', 1, true)],
        ['merge', () => mergeEntries('Memory Book', 1, 2)],
        ['split', () => splitEntry('Memory Book', 1, 'One', 'one', 'Two', 'two')],
    ])('keeps committed data and tree unchanged on a failed %s', async (name, operation) => {
        const before = structuredClone(store);
        const tree = structuredClone(getTree('Memory Book'));
        save.mockRejectedValueOnce(new Error('offline'));
        await expect(operation()).rejects.toThrow('offline');
        expect(store).toEqual(before);
        expect(getTree('Memory Book')).toEqual(tree);
        expect(isPathfinderSelfWrite()).toBe(false);
    });

    test.each([null, undefined])('does not report an uncommitted save result %p as success', async result => {
        save.mockResolvedValueOnce(result);
        await expect(createEntry('Memory Book', 'Discarded', 'not saved')).rejects.toThrow('The lorebook save did not complete.');
        expect(Object.keys(store['Memory Book'].entries)).toHaveLength(2);
        expect($('#world_editor_select').trigger).not.toHaveBeenCalled();
    });
});
