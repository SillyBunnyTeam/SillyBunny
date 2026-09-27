/* eslint-disable playwright/no-standalone-expect */
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

await jest.unstable_mockModule('../public/scripts/extensions.js', () => ({ getContext: () => null }));
await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/agent-store.js', () => ({ isPathfinderSubmoduleEnabled: () => true }));
await jest.unstable_mockModule('../public/scripts/util/AccountStorage.js', () => ({
    accountStorage: { getItem: () => null, setItem: jest.fn() },
}));
await jest.unstable_mockModule('../public/scripts/world-info.js', () => ({
    createWorldInfoEntry: jest.fn(), syncWIOriginalDataEntry: jest.fn(), deleteWIOriginalDataValue: jest.fn(), reloadEditor: jest.fn(),
}));

const { clearAllTrees, getTree, getAllEntryUids, replaceSettings } = await import('../public/scripts/extensions/in-chat-agents/pathfinder/tree-store.js');
const { buildTreeFromMetadata } = await import('../public/scripts/extensions/in-chat-agents/pathfinder/tree-builder.js');
const { createEntry, initEntryManagerAPIs, onPathfinderWorldInfoUpdated } = await import('../public/scripts/extensions/in-chat-agents/pathfinder/entry-manager.js');
const { getSummaryMemoryState, setSummaryMemoryCreated } = await import('../public/scripts/extensions/in-chat-agents/pathfinder/summary-memory-store.js');
const { LAYOUT_KEY } = await import('../public/scripts/extensions/in-chat-agents/pathfinder/tree-layout.js');
const { createSeparateSummaryMemoryEntry, createSummaryMemoryEntry, deriveSummaryLorebookTitle } = await import('../public/scripts/extensions/in-chat-agents/pathfinder/tools/summarize.js');

describe('Pathfinder summary lorebook entries', () => {
    let store;
    let save;
    let load;
    let create;

    beforeEach(() => {
        clearAllTrees();
        replaceSettings({ enabledLorebooks: ['Memory Book'], includeContextualLorebooks: false });
        setSummaryMemoryCreated({});
        store = { 'Memory Book': { entries: {} } };
        save = jest.fn(async (name, data) => {
            store[name] = structuredClone(data);
            onPathfinderWorldInfoUpdated(name, structuredClone(data));
            return name;
        });
        load = jest.fn(async name => store[name] ? structuredClone(store[name]) : null);
        create = jest.fn((name, data) => {
            const uid = Math.max(-1, ...Object.keys(data.entries).map(Number)) + 1;
            return (data.entries[uid] = { uid });
        });
        initEntryManagerAPIs(load, create, save);
    });

    test('derives a specific title when the tracked title is generic', () => {
        expect(deriveSummaryLorebookTitle({
            title: '[Summary] Recent scene summary',
            content: 'Significance: high\n\nMira discovered the hidden observatory beneath the old chapel. The party still needs the moon key.',
        })).toBe('Mira discovered the hidden observatory beneath the old chapel');
    });

    test.each([
        ['\u00c9lodie retrouve la cl\u00e9 perdue.', '\u00c9lodie retrouve la cl\u00e9 perdue'],
        ['\u5c0f\u660e\u627e\u5230\u4e86\u5730\u56fe\u3002\u4ed6\u56de\u5bb6\u4e86\u3002', '\u5c0f\u660e\u627e\u5230\u4e86\u5730\u56fe'],
        ['\u041c\u0438\u0440\u0430 \u043d\u0430\u0448\u043b\u0430 \u043a\u0430\u0440\u0442\u0443.', '\u041c\u0438\u0440\u0430 \u043d\u0430\u0448\u043b\u0430 \u043a\u0430\u0440\u0442\u0443'],
    ])('derives a Unicode title from %s', (content, title) => {
        expect(deriveSummaryLorebookTitle({ title: 'Summary', content })).toBe(title);
    });

    test('creates a separate entry without replacing the tracked latest summary', async () => {
        const tracked = await createSummaryMemoryEntry({ title: 'First tracked summary', content: 'The original tracked summary remains selected.' });
        const before = getSummaryMemoryState();
        const archived = await createSeparateSummaryMemoryEntry({
            title: '[Summary] Recent scene summary',
            content: 'Rin promised to return the stolen map before dawn. The guard captain suspects her.',
            significance: 'high',
        });
        expect(archived.uid).not.toBe(tracked.uid);
        expect(Object.keys(store['Memory Book'].entries)).toHaveLength(2);
        expect(store['Memory Book'].entries[archived.uid].comment).toBe('[Summary] Rin promised to return the stolen map before dawn');
        expect(getSummaryMemoryState()).toEqual(before);
    });

    test('reuses an arc for concurrent summaries and counts each entry once after invalidation', async () => {
        const summaries = await Promise.all([
            createSummaryMemoryEntry({ title: 'One', content: 'one', arc: 'Return' }),
            createSummaryMemoryEntry({ title: 'Two', content: 'two', arc: 'return' }),
        ]);
        const data = store['Memory Book'];
        const persisted = data.extensions[LAYOUT_KEY];
        expect(save).toHaveBeenCalledTimes(2);
        expect(persisted.tree.children[0].children).toHaveLength(1);
        expect(JSON.stringify(persisted)).not.toContain('"entries"');
        clearAllTrees();
        const tree = await buildTreeFromMetadata('Memory Book', structuredClone(data));
        const summaryNode = tree.children.find(node => node.name === 'Summaries');
        expect(summaryNode.entries).toEqual([]);
        expect(summaryNode.children[0].entries).toEqual(summaries.map(summary => summary.uid));
        expect(getAllEntryUids(tree)).toHaveLength(2);
        expect(getSummaryMemoryState().uid).toBe(summaries[1].uid);
    });

    test('rejects an explicit bad target rather than silently choosing the first book', async () => {
        await expect(createSummaryMemoryEntry({ title: 'Summary', content: 'content', book: 'Wrong Book' })).rejects.toThrow('"Wrong Book" is not available');
        expect(save).not.toHaveBeenCalled();
        expect(getSummaryMemoryState().uid).toBeNull();
    });

    test.each(['queued', 'loading', 'creating'].flatMap(phase => ['signal', 'context'].map(reason => [phase, reason])))('cancels a summary while %s via %s without saving or publishing it', async (phase, reason) => {
        const controller = new AbortController();
        let current = true;
        let release;
        let started;
        const waiting = new Promise(resolve => { started = resolve; });
        const gate = new Promise(resolve => { release = resolve; });
        const api = phase === 'queued' ? save : phase === 'loading' ? load : create;
        const implementation = api.getMockImplementation();
        api.mockImplementationOnce(async (...args) => {
            started();
            await gate;
            return implementation(...args);
        });
        const blocker = phase === 'queued' ? createEntry('Memory Book', 'Earlier write', 'keep') : null;
        if (blocker) await waiting;
        const pending = createSummaryMemoryEntry({ title: 'Cancelled', content: 'discard', arc: 'Unsaved' }, {
            signal: controller.signal, isCurrent: () => current,
        });
        const rejected = pending.catch(error => error);
        await waiting;
        // Both contracts are independent: Stop uses the signal, chat switching can invalidate the predicate.
        if (reason === 'context') current = false;
        else controller.abort();
        release();
        await blocker;
        await expect(rejected).resolves.toMatchObject({ name: 'AbortError' });
        expect(save).toHaveBeenCalledTimes(blocker ? 1 : 0);
        expect(Object.values(store['Memory Book'].entries).map(entry => entry.comment)).toEqual(blocker ? ['Earlier write'] : []);
        expect(getSummaryMemoryState().uid).toBeNull();
        expect(JSON.stringify(store)).not.toContain('Unsaved');
        await expect(createSummaryMemoryEntry({ title: 'Next', content: 'works' })).resolves.toMatchObject({ title: 'Next' });
    });

    test('keeps a successful summary and its tracked state when cancellation arrives after save was sent', async () => {
        const controller = new AbortController();
        let release;
        let started;
        const waiting = new Promise(resolve => { started = resolve; });
        const gate = new Promise(resolve => { release = resolve; });
        const commit = save.getMockImplementation();
        save.mockImplementationOnce(async (...args) => {
            started();
            await gate;
            return commit(...args);
        });
        const pending = createSummaryMemoryEntry({ title: 'Committed', content: 'keep' }, {
            signal: controller.signal, isCurrent: () => !controller.signal.aborted,
        });
        await waiting;
        controller.abort();
        release();
        const result = await pending;
        expect(store['Memory Book'].entries[result.uid].comment).toBe('[Summary] Committed');
        expect(getSummaryMemoryState()).toMatchObject({ uid: result.uid, content: 'keep', bookName: 'Memory Book' });
        expect(getAllEntryUids(getTree('Memory Book'))).toEqual([result.uid]);
        expect(save).toHaveBeenCalledTimes(1);
    });

    test.each(['offline', 'discarded'])('does not publish an entry, arc or latest state after a %s save', async failure => {
        await createSummaryMemoryEntry({ title: 'Old', content: 'old' });
        const previousState = getSummaryMemoryState();
        const previousStore = structuredClone(store);
        const previousTree = structuredClone(getTree('Memory Book'));
        if (failure === 'offline') save.mockRejectedValueOnce(new Error('offline'));
        else save.mockResolvedValueOnce(null);
        await expect(createSummaryMemoryEntry({ title: 'New', content: 'new', arc: 'Unsaved' })).rejects.toThrow();
        expect(store).toEqual(previousStore);
        expect(getTree('Memory Book')).toEqual(previousTree);
        expect(getSummaryMemoryState()).toEqual(previousState);
    });

    test('tracks the committed book name returned by the host', async () => {
        save.mockImplementationOnce(async (name, data) => {
            store['Renamed Book'] = structuredClone(data);
            delete store[name];
            return 'Renamed Book';
        });
        const summary = await createSummaryMemoryEntry({ title: 'Renamed', content: 'saved', arc: 'Return' });
        expect(summary.targetBook).toBe('Renamed Book');
        expect(getSummaryMemoryState().bookName).toBe('Renamed Book');
        expect(getAllEntryUids(getTree('Renamed Book'))).toEqual([summary.uid]);
    });
});
