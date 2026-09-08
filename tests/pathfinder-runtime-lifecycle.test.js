/* eslint-disable playwright/no-duplicate-hooks */
/* global globalThis */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { EventEmitter } from '../public/lib/eventemitter.js';
import { event_types } from '../public/scripts/events.js';

let enabled = true;
await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/agent-store.js', () => ({ isPathfinderSubmoduleEnabled: () => enabled }));
await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/profile-utils.js', () => ({ listConnectionProfiles: () => [] }));
await jest.unstable_mockModule('../public/scripts/util/AccountStorage.js', () => ({ accountStorage: { getItem: () => null, setItem: jest.fn() } }));
await jest.unstable_mockModule('../public/scripts/world-info.js', () => ({
    createWorldInfoEntry: jest.fn(), syncWIOriginalDataEntry: jest.fn(), deleteWIOriginalDataValue: jest.fn(), reloadEditor: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/tool-action-registry.js', () => ({ unregisterToolAction: jest.fn(), unregisterToolFormatter: jest.fn() }));
for (const tool of ['search', 'remember', 'update', 'forget', 'summarize', 'reorganize', 'merge-split', 'notebook']) {
    await jest.unstable_mockModule(`../public/scripts/extensions/in-chat-agents/pathfinder/tools/${tool}.js`, () => ({
        registerActions: jest.fn(), getDefinition: () => ({ actionKey: tool, formatMessageKey: tool }),
    }));
}
await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/pathfinder/commands.js', () => ({ initCommands: jest.fn(), removeCommands: jest.fn() }));
await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/pathfinder/diagnostics.js', () => ({ runDiagnostics: jest.fn() }));
await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/pathfinder/llm-sidecar.js', () => ({ sidecarGenerateWithProfile: jest.fn() }));
await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/pathfinder/prompts/prompt-editor-ui.js', () => ({ initPromptEditorUI: jest.fn(), refreshPromptEditorUI: jest.fn() }));

const { initPathfinder, teardownPathfinder } = await import('../public/scripts/extensions/in-chat-agents/pathfinder-init.js');
const storage = await import('../public/scripts/extensions/in-chat-agents/pathfinder/entry-manager.js');
const { setSummaryMemoryCreated, getSummaryMemoryState, saveSummaryMemoryContent } = await import('../public/scripts/extensions/in-chat-agents/pathfinder/summary-memory-store.js');
const { replaceSettings, getSettings, clearAllTrees, getTree, findNodeById, isPathfinderSelfWrite } = await import('../public/scripts/extensions/in-chat-agents/pathfinder/tree-store.js');
const { buildTreeFromMetadata } = await import('../public/scripts/extensions/in-chat-agents/pathfinder/tree-builder.js');
const runnerSource = readFileSync(new URL('../public/scripts/extensions/in-chat-agents/agent-runner.js', import.meta.url), 'utf8');

function functionSource(name) {
    const match = runnerSource.match(new RegExp(`^(?:export )?((?:async )?function ${name}\\([\\s\\S]*?^})`, 'm'));
    if (!match) throw new Error(`Missing function ${name}`);
    return match[1];
}

function installRunner(events) {
    const context = vm.createContext({
        console,
        eventSource: events, event_types,
        agentRunnerInitialized: false, pathfinderRetrievalCacheRevision: 0, pathfinderToolRevision: 0, isPathfinderSelfWrite,
        initPostGenerationRecoveryHooks() {}, setAgentGenerationContextProvider() {}, getAgentGenerationContext() {},
        setPromptStorePersistHook() {}, abortActivePathfinderRetrieval() {}, clearPathfinderRetrievalToast() {}, clearPathfinderExtensionPrompts() {},
        syncToolAgentRegistrations: jest.fn(), getAgents: () => [], isPathfinderToolAgent: () => false,
        getPathfinderRuntimeSettings: getSettings, replacePathfinderRuntimeSettings: replaceSettings,
        onPathfinderWorldInfoUpdated: jest.fn(storage.onPathfinderWorldInfoUpdated),
        onPathfinderWorldInfoRenamed: jest.fn(storage.onPathfinderWorldInfoRenamed),
        onPathfinderWorldInfoDeleted: jest.fn(storage.onPathfinderWorldInfoDeleted),
    });
    const init = functionSource('initAgentRunner');
    for (const [, handler] of init.matchAll(/eventSource\.on\([^,\n]+,\s*(\w+)\)/g)) {
        context[handler] ??= () => {};
    }
    vm.runInContext(['invalidatePathfinderRetrieval', 'onWorldInfoUpdatedToolSync', 'onWorldInfoRenamedOrDeleted', 'initAgentRunner'].map(functionSource).join('\n'), context);
    context.initAgentRunner();
    return context;
}

describe('Pathfinder storage and runtime lifecycle wiring', () => {
    let books;
    let events;
    let context;
    let runner;

    beforeEach(() => {
        teardownPathfinder();
        clearAllTrees();
        enabled = true;
        replaceSettings({ enabledLorebooks: ['Book'], includeContextualLorebooks: false });
        setSummaryMemoryCreated({ title: '[Summary] Scene', content: 'original', bookName: 'Book', uid: 0 });
        books = { Book: { entries: { 0: { uid: 0, comment: '[Summary] Scene', content: 'original' } } } };
        events = new EventEmitter();
        context = {
            eventSource: events, eventTypes: event_types,
            loadWorldInfo: jest.fn(async name => books[name] ? structuredClone(books[name]) : null),
            createWorldInfoEntry: (_name, data) => {
                let uid = 0;
                while (data.entries[uid]) uid++;
                return (data.entries[uid] = { uid });
            },
            saveWorldInfo: jest.fn(async (name, data) => {
                books[name] = structuredClone(data);
                await events.emit(event_types.WORLDINFO_UPDATED, name, structuredClone(data));
                return name;
            }),
        };
        globalThis.window = { SillyTavern: { getContext: () => context } };
        runner = installRunner(events);
    });

    afterEach(() => {
        teardownPathfinder();
        delete globalThis.window;
        jest.restoreAllMocks();
    });

    test('wires each storage event once and keeps own-write summary updates linked', async () => {
        initPathfinder(context);
        initPathfinder(context);
        runner.initAgentRunner();
        await new Promise(resolve => setImmediate(resolve));
        expect(events.events[event_types.WORLDINFO_UPDATED]).toHaveLength(1);
        expect(events.events[event_types.WORLDINFO_RENAMED]).toHaveLength(1);
        expect(events.events[event_types.WORLDINFO_DELETED]).toHaveLength(1);
        await storage.updateEntry('Book', 0, 'updated by Pathfinder', '[Summary] Updated');
        expect(runner.onPathfinderWorldInfoUpdated).toHaveBeenCalledTimes(1);
        expect(runner.onPathfinderWorldInfoUpdated).toHaveBeenCalledWith('Book', expect.any(Object), undefined);
        expect(getSummaryMemoryState()).toMatchObject({ uid: 0, bookName: 'Book', title: '[Summary] Updated', content: 'updated by Pathfinder' });
        expect(runner.pathfinderRetrievalCacheRevision).toBe(1);
    });

    test('forwards replacement metadata and retires the linked summary and cached node IDs', async () => {
        initPathfinder(context);
        await new Promise(resolve => setImmediate(resolve));
        const tree = await buildTreeFromMetadata('Book', books.Book);
        await events.emit(event_types.WORLDINFO_UPDATED, 'Book', structuredClone(books.Book), { replaced: true });
        expect(runner.onPathfinderWorldInfoUpdated).toHaveBeenCalledWith('Book', books.Book, { replaced: true });
        expect(getSummaryMemoryState()).toMatchObject({ bookName: '', uid: null, content: 'original' });
        const rebuilt = await buildTreeFromMetadata('Book', books.Book);
        expect(rebuilt.id).not.toBe(tree.id);
    });

    test('preserves runtime IDs and the tracked summary on rename, then detaches on deletion', async () => {
        initPathfinder(context);
        await new Promise(resolve => setImmediate(resolve));
        const tree = await buildTreeFromMetadata('Book', books.Book);
        books.Renamed = books.Book;
        delete books.Book;
        await events.emit(event_types.WORLDINFO_RENAMED, 'Book', 'Renamed');
        expect(runner.onPathfinderWorldInfoRenamed).toHaveBeenCalledTimes(1);
        expect(getTree('Book')).toBeNull();
        expect(findNodeById(getTree('Renamed'), tree.id)).not.toBeNull();
        expect(getSummaryMemoryState()).toMatchObject({ bookName: 'Renamed', uid: 0 });
        delete books.Renamed;
        await events.emit(event_types.WORLDINFO_DELETED, 'Renamed');
        expect(runner.onPathfinderWorldInfoDeleted).toHaveBeenCalledTimes(1);
        expect(getSummaryMemoryState()).toMatchObject({ bookName: '', uid: null });
    });

    test('continues tracking file lifecycle while disabled without registering duplicate listeners on re-enable', async () => {
        initPathfinder(context);
        await new Promise(resolve => setImmediate(resolve));
        teardownPathfinder();
        enabled = false;
        await events.emit(event_types.WORLDINFO_RENAMED, 'Book', 'Renamed');
        expect(getSummaryMemoryState().bookName).toBe('Renamed');
        await events.emit(event_types.WORLDINFO_DELETED, 'Renamed');
        expect(getSummaryMemoryState().uid).toBeNull();
        enabled = true;
        initPathfinder(context);
        expect(events.events[event_types.WORLDINFO_UPDATED]).toHaveLength(1);
    });

    test('revalidates stale links when no change event arrived while disabled', async () => {
        initPathfinder(context);
        await new Promise(resolve => setImmediate(resolve));
        teardownPathfinder();
        books.Book.entries[0] = { uid: 0, comment: 'Replacement', content: 'unrelated' };
        initPathfinder(context);
        await new Promise(resolve => setImmediate(resolve));
        expect(getSummaryMemoryState()).toMatchObject({ bookName: '', uid: null, content: 'original' });
        expect(books.Book.entries[0].content).toBe('unrelated');
        expect(context.saveWorldInfo).not.toHaveBeenCalled();
    });

    test('guards an editor save before re-enable validation has finished', async () => {
        initPathfinder(context);
        await new Promise(resolve => setImmediate(resolve));
        teardownPathfinder();
        books.Book.entries[0] = { uid: 0, comment: 'Replacement', content: 'unrelated' };
        await expect(saveSummaryMemoryContent('must not overwrite replacement')).rejects.toThrow('The summary or its linked entry changed while the user was editing. Saves are blocked to prevent overwriting.');
        expect(books.Book.entries[0].content).toBe('unrelated');
        expect(context.saveWorldInfo).not.toHaveBeenCalled();
        expect(getSummaryMemoryState().uid).toBeNull();
    });

    test('does not let a stale enable-time read detach a newer summary', async () => {
        let release;
        context.loadWorldInfo.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
        initPathfinder(context);
        await Promise.resolve();
        teardownPathfinder();
        books.Book.entries[1] = { uid: 1, comment: '[Summary] New', content: 'new' };
        setSummaryMemoryCreated({ title: '[Summary] New', content: 'new', bookName: 'Book', uid: 1 });
        initPathfinder(context);
        release({ entries: {} });
        await new Promise(resolve => setImmediate(resolve));
        expect(getSummaryMemoryState()).toMatchObject({ uid: 1, bookName: 'Book', content: 'new' });
    });
});
