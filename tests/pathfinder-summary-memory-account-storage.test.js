/* eslint-disable playwright/no-standalone-expect */
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const storedState = {
    title: 'Existing summary', content: 'Stored content', significance: 'Stored significance', arc: 'Stored arc',
    bookName: 'Stored book', uid: 42, updatedAt: 100, injectedAt: 90, injectedMode: 'auto',
};
const accountStorageValues = new Map([['pathfinder-summary-memory-state', JSON.stringify(storedState)]]);
const accountStorage = {
    getItem: jest.fn(key => accountStorageValues.get(key) ?? null),
    setItem: jest.fn((key, value) => accountStorageValues.set(key, String(value))),
};
await jest.unstable_mockModule('../public/scripts/util/AccountStorage.js', () => ({ accountStorage }));
await jest.unstable_mockModule('../public/scripts/extensions.js', () => ({ getContext: () => null }));
await jest.unstable_mockModule('../public/scripts/world-info.js', () => ({
    createWorldInfoEntry: jest.fn(), syncWIOriginalDataEntry: jest.fn(), deleteWIOriginalDataValue: jest.fn(), reloadEditor: jest.fn(),
}));

const {
    getSummaryMemoryState, setSummaryMemoryCreated, saveSummaryMemoryContent, isSummaryMemoryEntry, markSummaryMemoryInjected,
} = await import('../public/scripts/extensions/in-chat-agents/pathfinder/summary-memory-store.js');
const {
    initEntryManagerAPIs, createEntry, updateEntry, forgetEntry, mergeEntries, splitEntry,
    onPathfinderWorldInfoUpdated, onPathfinderWorldInfoRenamed, onPathfinderWorldInfoDeleted,
} = await import('../public/scripts/extensions/in-chat-agents/pathfinder/entry-manager.js');
const { clearAllTrees } = await import('../public/scripts/extensions/in-chat-agents/pathfinder/tree-store.js');
const loadedState = getSummaryMemoryState();

describe('Pathfinder summary memory account storage', () => {
    let store;
    let save;

    beforeEach(() => {
        clearAllTrees();
        setSummaryMemoryCreated({ title: '[Summary] Current', content: 'current', significance: 'high', bookName: 'Memory Book', uid: 0 });
        store = { 'Memory Book': { entries: {
            0: { uid: 0, comment: '[Summary] Current', content: 'Significance: high\n\ncurrent' },
            1: { uid: 1, comment: 'Other', content: 'other' },
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
    });

    test('loads and persists the existing account-wide key with the same state shape', () => {
        expect(loadedState).toEqual(storedState);
        const now = jest.spyOn(Date, 'now').mockReturnValue(500);
        try {
            setSummaryMemoryCreated({
                title: 'New summary', content: 'Significance: Important\n\nNew content', significance: 'Important',
                arc: 'New arc', bookName: 'New book', uid: 7,
            });
        } finally {
            now.mockRestore();
        }
        expect(accountStorage.setItem).toHaveBeenLastCalledWith('pathfinder-summary-memory-state', JSON.stringify({
            title: 'New summary', content: 'New content', significance: 'Important', arc: 'New arc',
            bookName: 'New book', uid: 7, updatedAt: 500, injectedAt: 0, injectedMode: '',
        }));
    });

    test('does not coerce missing or malformed persisted UIDs into entry zero on reload', async () => {
        for (const uid of [null, false, '', [], {}, 0.5]) {
            accountStorageValues.set('pathfinder-summary-memory-state', JSON.stringify({ ...storedState, uid }));
            jest.resetModules();
            const reloaded = await import('../public/scripts/extensions/in-chat-agents/pathfinder/summary-memory-store.js');
            expect(reloaded.getSummaryMemoryState().uid).toBeNull();
        }
    });

    test('commits the edited summary state only after a successful lorebook write', async () => {
        markSummaryMemoryInjected({ mode: 'pipeline' });
        const before = getSummaryMemoryState();
        save.mockRejectedValueOnce(new Error('offline'));
        await expect(saveSummaryMemoryContent('unsaved')).rejects.toThrow('offline');
        expect(getSummaryMemoryState()).toEqual(before);
        expect(store['Memory Book'].entries[0].content).toBe('Significance: high\n\ncurrent');
        await saveSummaryMemoryContent('saved');
        expect(getSummaryMemoryState()).toMatchObject({ content: 'saved', uid: 0, injectedAt: 0, injectedMode: '' });
        expect(store['Memory Book'].entries[0].content).toBe('Significance: high\n\nsaved');
    });

    test('synchronises title, content and significance after a direct entry update', async () => {
        await updateEntry('Memory Book', 0, 'Significance: low\n\nupdated', '[Summary] Updated');
        expect(getSummaryMemoryState()).toMatchObject({ title: '[Summary] Updated', content: 'updated', significance: 'low', uid: 0 });
    });

    test('keeps the tracked original when splitting and follows its new content', async () => {
        const result = await splitEntry('Memory Book', 0, '[Summary] First', 'first', '[Summary] Second', 'second');
        expect(getSummaryMemoryState()).toMatchObject({ title: '[Summary] First', content: 'first', significance: '', uid: result.originalUid });
        expect(getSummaryMemoryState().uid).not.toBe(result.newUid);
    });

    test.each([
        ['disable', () => forgetEntry('Memory Book', 0)],
        ['delete', () => forgetEntry('Memory Book', 0, true)],
        ['merge into another entry', () => mergeEntries('Memory Book', 1, 0)],
    ])('detaches rather than pointing at removed or hidden content after %s', async (name, mutate) => {
        await mutate();
        expect(getSummaryMemoryState()).toMatchObject({ bookName: '', uid: null, content: 'current', injectedAt: 0 });
    });

    test('UID reuse after deletion does not inherit the old summary link', async () => {
        await forgetEntry('Memory Book', 0, true);
        const created = await createEntry('Memory Book', 'Replacement', 'unrelated');
        expect(created.uid).toBe(0);
        expect(getSummaryMemoryState().uid).toBeNull();
        expect(isSummaryMemoryEntry({ ...store['Memory Book'].entries[0], bookName: 'Memory Book' })).toBe(false);
    });

    test('verifies the expected entry before an editor save even if no external event arrived', async () => {
        store['Memory Book'].entries[0] = { uid: 0, comment: 'Replacement', content: 'unrelated' };
        await expect(saveSummaryMemoryContent('do not overwrite')).rejects.toThrow('The summary or its linked entry changed while the user was editing. Saves are blocked to prevent overwriting.');
        expect(store['Memory Book'].entries[0].content).toBe('unrelated');
        expect(save).not.toHaveBeenCalled();
        expect(getSummaryMemoryState()).toMatchObject({ uid: null, content: 'current' });
    });

    test('native edits detach stale snapshots, and replacements detach even identical entries', () => {
        store['Memory Book'].entries[0].content = 'native edit';
        onPathfinderWorldInfoUpdated('Memory Book', store['Memory Book']);
        expect(getSummaryMemoryState().uid).toBeNull();
        setSummaryMemoryCreated({ title: '[Summary] Current', content: 'native edit', bookName: 'Memory Book', uid: 0 });
        onPathfinderWorldInfoUpdated('Memory Book', store['Memory Book'], { replaced: true });
        expect(getSummaryMemoryState().uid).toBeNull();
    });

    test('book rename preserves the link and book deletion detaches it', () => {
        onPathfinderWorldInfoRenamed('Memory Book', 'Renamed');
        expect(getSummaryMemoryState()).toMatchObject({ bookName: 'Renamed', uid: 0 });
        onPathfinderWorldInfoDeleted('Renamed');
        expect(getSummaryMemoryState()).toMatchObject({ bookName: '', uid: null });
    });

    test('injection matching requires the current title, content, book and eligible entry', () => {
        const entry = { ...store['Memory Book'].entries[0], bookName: 'Memory Book' };
        expect(isSummaryMemoryEntry(entry)).toBe(true);
        expect(isSummaryMemoryEntry({ ...entry, bookName: 'Other Book' })).toBe(false);
        expect(isSummaryMemoryEntry({ ...entry, content: 'changed' })).toBe(false);
        expect(isSummaryMemoryEntry({ ...entry, comment: 'changed' })).toBe(false);
        expect(isSummaryMemoryEntry({ ...entry, disable: true })).toBe(false);
        expect(isSummaryMemoryEntry({ ...entry, agentBlacklisted: true })).toBe(false);
    });

    test('an older pending edit cannot replace or detach a newly tracked summary', async () => {
        save.mockImplementationOnce(async (name, data) => {
            setSummaryMemoryCreated({ title: 'Other', content: 'other', bookName: name, uid: 1 });
            store[name] = structuredClone(data);
            return name;
        });
        await saveSummaryMemoryContent('saved to the old entry');
        expect(store['Memory Book'].entries[0].content).toContain('saved to the old entry');
        expect(getSummaryMemoryState()).toMatchObject({ uid: 1, title: 'Other', content: 'other' });
    });
});
