/* eslint-disable playwright/no-duplicate-hooks */
/* global globalThis */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from '../public/lib/eventemitter.js';
import { event_types } from '../public/scripts/events.js';

const pub = rel => fileURLToPath(new URL(`../public/${rel}`, import.meta.url));

let enabled = true;
const events = new EventEmitter();

await jest.unstable_mockModule(pub('lib.js'), () => ({
    DOMPurify: { sanitize: v => v },
    Fuse: class {},
    hljs: { highlightElement: jest.fn(), highlightAuto: jest.fn(v => ({ value: v })) },
    showdown: { Converter: class { makeHtml(v) { return v; } } },
    Handlebars: { compile: () => () => '', registerHelper: jest.fn() },
    moment: () => ({ format: () => '' }),
    lodash: {},
}));
await jest.unstable_mockModule(pub('scripts/templates.js'), () => ({
    renderTemplate: jest.fn(() => ''),
    renderTemplateAsync: jest.fn(async () => ''),
}));
await jest.unstable_mockModule(pub('scripts/reasoning.js'), () => ({ removeReasoningFromString: v => v }));
await jest.unstable_mockModule(pub('scripts/events.js'), () => ({ eventSource: events, event_types }));
await jest.unstable_mockModule(pub('script.js'), () => ({
    chat: [],
    chat_metadata: {},
    ensureSwipes: jest.fn(),
    extension_prompt_roles: { SYSTEM: 0 },
    extension_prompt_types: { IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 },
    extension_prompts: {},
    setExtensionPrompt: jest.fn(),
    setAgentGenerationContextProvider: jest.fn(),
    substituteParams: v => v,
    substituteParamsExtended: v => v,
    generateQuietPrompt: jest.fn(),
    getRequestHeaders: () => ({}),
    getCurrentChatId: () => 'chat-a',
    itemizedPrompts: [],
    normalizeContentText: v => String(v ?? ''),
    saveChatDebounced: jest.fn(),
    stopGeneration: jest.fn(),
    streamingProcessor: null,
    syncMesToSwipe: jest.fn(),
    updateMessageTokenAccounting: jest.fn(),
}));
await jest.unstable_mockModule(pub('scripts/extensions.js'), () => ({
    getContext: () => globalThis.window?.SillyTavern?.getContext?.() ?? {},
    extension_settings: {},
    renderExtensionTemplateAsync: jest.fn(async () => ''),
}));
await jest.unstable_mockModule(pub('scripts/i18n.js'), () => ({ t: (s, ...v) => s.reduce((a, p, i) => a + p + (v[i] ?? ''), ''), translate: v => String(v ?? '') }));
await jest.unstable_mockModule(pub('scripts/group-chats.js'), () => ({ is_group_generating: false }));
await jest.unstable_mockModule(pub('scripts/popup.js'), () => ({ Popup: class {}, POPUP_RESULT: {}, POPUP_TYPE: {}, callGenericPopup: jest.fn() }));
await jest.unstable_mockModule(pub('scripts/tool-calling.js'), () => ({
    ToolManager: {
        registerFunctionTool: jest.fn(),
        unregisterFunctionTool: jest.fn(),
        isToolCallingSupported: () => false,
    },
}));
await jest.unstable_mockModule(pub('scripts/utils.js'), () => ({
    regexFromString: v => new RegExp(v),
    uuidv4: () => 'uuid-1',
    escapeHtml: v => String(v ?? ''),
    escapeRegex: s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    includesIgnoreCaseAndAccents: (a, b) => String(a ?? '').toLowerCase().includes(String(b ?? '').toLowerCase()),
    delay: async () => {},
    debounce: fn => fn,
    onlyUnique: (v, i, a) => a.indexOf(v) === i,
    isValidUrl: () => true,
}));
await jest.unstable_mockModule(pub('scripts/chat-backup-sequence.js'), () => ({ resetChatBackupSequence: jest.fn() }));
await jest.unstable_mockModule(pub('scripts/openai-model-capabilities.js'), () => ({ isKimiK3Model: () => false }));
await jest.unstable_mockModule(pub('scripts/extensions/in-chat-agents/agent-store.js'), () => ({
    areAgentsGloballyEnabled: () => enabled,
    getAgentById: () => null,
    getAgents: () => [],
    getAgentRegexScripts: () => [],
    getEnabledAgents: () => [],
    getEnabledToolAgents: () => [],
    getGlobalSettings: () => ({ enabled }),
    getPromptTransformMode: () => 'off',
    isAgentRuntimeAllowed: () => enabled,
    isCompanionAgent: () => false,
    isTrackerFixAgent: () => false,
    isPathfinderSubmoduleEnabled: () => enabled,
    saveAgent: jest.fn(async a => a),
    isToolAgent: () => false,
    normalizePreProcessMaxTokens: v => v,
    normalizePromptTransformMaxTokens: v => v,
    resolveCompanionConnectionProfile: () => null,
    resolveConnectionProfile: () => null,
}));
await jest.unstable_mockModule(pub('scripts/extensions/in-chat-agents/profile-utils.js'), () => ({
    listConnectionProfiles: () => [],
    getConnectionProfileDisplayName: () => '',
    getConnectionProfileModelName: () => '',
}));
await jest.unstable_mockModule(pub('scripts/util/AccountStorage.js'), () => ({ accountStorage: { getItem: () => null, setItem: jest.fn() } }));
await jest.unstable_mockModule(pub('scripts/world-info.js'), () => ({
    createWorldInfoEntry: jest.fn(), syncWIOriginalDataEntry: jest.fn(), deleteWIOriginalDataValue: jest.fn(), reloadEditor: jest.fn(),
}));
await jest.unstable_mockModule(pub('scripts/extensions/in-chat-agents/tool-action-registry.js'), () => ({
    getToolAction: jest.fn(), getToolFormatter: jest.fn(), unregisterToolAction: jest.fn(), unregisterToolFormatter: jest.fn(),
}));
for (const tool of ['search', 'remember', 'update', 'forget', 'summarize', 'reorganize', 'merge-split', 'notebook']) {
    await jest.unstable_mockModule(pub(`scripts/extensions/in-chat-agents/pathfinder/tools/${tool}.js`), () => ({
        registerActions: jest.fn(), getDefinition: () => ({ actionKey: tool, formatMessageKey: tool }),
    }));
}
await jest.unstable_mockModule(pub('scripts/extensions/in-chat-agents/pathfinder/commands.js'), () => ({ initCommands: jest.fn(), removeCommands: jest.fn() }));
await jest.unstable_mockModule(pub('scripts/extensions/in-chat-agents/pathfinder/diagnostics.js'), () => ({ runDiagnostics: jest.fn() }));
await jest.unstable_mockModule(pub('scripts/extensions/in-chat-agents/pathfinder/llm-sidecar.js'), () => ({ sidecarGenerate: jest.fn(), sidecarGenerateWithProfile: jest.fn() }));
await jest.unstable_mockModule(pub('scripts/extensions/in-chat-agents/pathfinder/prompts/prompt-editor-ui.js'), () => ({ initPromptEditorUI: jest.fn(), refreshPromptEditorUI: jest.fn() }));

const storage = await import(pub('scripts/extensions/in-chat-agents/pathfinder/entry-manager.js'));
const { initPathfinder, teardownPathfinder } = await import(pub('scripts/extensions/in-chat-agents/pathfinder-init.js'));
const { setSummaryMemoryCreated, getSummaryMemoryState, saveSummaryMemoryContent } = await import(pub('scripts/extensions/in-chat-agents/pathfinder/summary-memory-store.js'));
const { replaceSettings, clearAllTrees, getTree, findNodeById } = await import(pub('scripts/extensions/in-chat-agents/pathfinder/tree-store.js'));
const { buildTreeFromMetadata } = await import(pub('scripts/extensions/in-chat-agents/pathfinder/tree-builder.js'));
const { initAgentRunner } = await import(pub('scripts/extensions/in-chat-agents/agent-runner.js'));

describe('Pathfinder storage and runtime lifecycle wiring', () => {
    let books;
    let context;

    beforeEach(() => {
        teardownPathfinder();
        clearAllTrees();
        enabled = true;
        replaceSettings({ enabledLorebooks: ['Book'], includeContextualLorebooks: false });
        setSummaryMemoryCreated({ title: '[Summary] Scene', content: 'original', bookName: 'Book', uid: 0 });
        books = { Book: { entries: { 0: { uid: 0, comment: '[Summary] Scene', content: 'original' } } } };
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
        globalThis.document = { addEventListener: jest.fn(), removeEventListener: jest.fn() };
        initAgentRunner();
    });

    afterEach(() => {
        teardownPathfinder();
        delete globalThis.window;
        delete globalThis.document;
        jest.restoreAllMocks();
    });

    test('wires each storage event once and keeps own-write summary updates linked', async () => {
        initPathfinder(context);
        initPathfinder(context);
        initAgentRunner();
        await new Promise(resolve => setImmediate(resolve));
        expect(events.events[event_types.WORLDINFO_UPDATED]).toHaveLength(1);
        expect(events.events[event_types.WORLDINFO_RENAMED]).toHaveLength(1);
        expect(events.events[event_types.WORLDINFO_DELETED]).toHaveLength(1);
        await storage.updateEntry('Book', 0, 'updated by Pathfinder', '[Summary] Updated');
        expect(getSummaryMemoryState()).toMatchObject({ uid: 0, bookName: 'Book', title: '[Summary] Updated', content: 'updated by Pathfinder' });
    });

    test('forwards replacement metadata and retires the linked summary and cached node IDs', async () => {
        initPathfinder(context);
        await new Promise(resolve => setImmediate(resolve));
        const tree = await buildTreeFromMetadata('Book', books.Book);
        await events.emit(event_types.WORLDINFO_UPDATED, 'Book', structuredClone(books.Book), { replaced: true });
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
        expect(getTree('Book')).toBeNull();
        expect(findNodeById(getTree('Renamed'), tree.id)).not.toBeNull();
        expect(getSummaryMemoryState()).toMatchObject({ bookName: 'Renamed', uid: 0 });
        delete books.Renamed;
        await events.emit(event_types.WORLDINFO_DELETED, 'Renamed');
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
