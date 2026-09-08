/* global globalThis */
/* eslint-disable playwright/no-duplicate-hooks, playwright/no-standalone-expect -- Jest hooks and parameterised tests. */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Only the DOM is doubled. Saves run through the real agent store and fetch boundary.
class Control {
    constructor() {
        this[0] = this;
        this.length = 1;
        this.value = '';
        this.dataset = {};
        this.attributes = {};
        this.queries = new Map();
        this.handlers = new Map();
        this.classes = new Set();
    }

    find(selector) {
        if (!this.queries.has(selector)) this.queries.set(selector, new Control());
        return this.queries.get(selector);
    }
    on(event, selector, handler) {
        this.handlers.set(`${event}:${typeof selector === 'string' ? selector : ''}`, handler ?? selector);
        return this;
    }
    fire(event, selector = '', target = this) { return this.handlers.get(`${event}:${selector}`)?.call(target); }
    off() { this.handlers.clear(); return this; }
    each() { return this; }
    first() { return this; }
    children(selector) { return this.find(selector); }
    closest() { return this.parent ?? this; }
    empty() { return this; }
    append() { return this; }
    html(value) { this.markup = value; return this; }
    show() { this.visible = true; return this; }
    hide() { this.visible = false; return this; }
    toggle(value) { this.visible = value; return this; }
    stop() { return this; }
    slideUp() { return this.hide(); }
    val(value) { if (value === undefined) return this.value; this.value = value; return this; }
    prop(key, value) { if (value === undefined) return this[key]; this[key] = value; return this; }
    attr(key, value) { if (value === undefined) return this.attributes[key]; this.attributes[key] = value; return this; }
    data(key) { return this.dataset[key]; }
    text(value) { if (value === undefined) return this.textValue ?? ''; this.textValue = String(value); return this; }
    addClass(value) { value.split(' ').forEach(name => this.classes.add(name)); return this; }
    removeClass(value) { value.split(' ').forEach(name => this.classes.delete(name)); return this; }
    toggleClass(value, enabled) { return enabled ? this.addClass(value) : this.removeClass(value); }
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

const events = new EventEmitter();
const eventTypes = { CHAT_CHANGED: 'chat', SETTINGS_UPDATED: 'settings' };
const summaryListeners = new Set();
const generationListeners = new Set();
const template = jest.fn(async () => new Control());
const loadWorldInfo = jest.fn();
const sidecarGenerate = jest.fn();
const createSummaryMemoryEntry = jest.fn();
const createSeparateSummaryMemoryEntry = jest.fn();
const saveSummaryMemoryContent = jest.fn();
const syncTools = jest.fn();
let context;
let generation;
let stopped;
let summary;
let profiles;
let store;
let tree;

await jest.unstable_mockModule('../public/script.js', () => ({
    eventSource: events,
    event_types: eventTypes,
    online_status: 'connected',
    getRequestHeaders: () => ({}),
    saveSettingsDebounced: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/extensions.js', () => ({
    getContext: () => context,
    extension_settings: {},
    renderExtensionTemplateAsync: template,
}));
await jest.unstable_mockModule('../public/scripts/utils.js', () => ({
    uuidv4: () => 'test-id',
    escapeHtml: value => String(value),
    regexFromString: value => new RegExp(value),
}));
await jest.unstable_mockModule('../public/scripts/util/AccountStorage.js', () => ({
    accountStorage: { getItem: () => null, setItem: jest.fn() },
}));
await jest.unstable_mockModule('../public/scripts/world-info.js', () => ({ world_names: ['Book A', 'Book B'], loadWorldInfo }));
await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/textarea-fullscreen.js', () => ({ attachTextareaFullscreen: jest.fn() }));
await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/pathfinder-init.js', () => ({ runDiagnostics: jest.fn(async () => ({})) }));
await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/profile-utils.js', () => ({
    listConnectionProfiles: () => profiles,
    populateConnectionProfileSelect: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/agent-runner.js', () => ({
    getAgentGenerationContext: () => ({ ...generation }),
    getAgentGenerationCancelRevision: () => generation.cancelRevision,
    isAgentGenerationStopped: () => stopped,
    getPathfinderRuntimeAgent: () => store.getEnabledToolAgents()[0] ?? null,
    isPathfinderToolEnabledForAgent: (agent, name) => agent.settings?.toolStates?.[name] !== false,
    syncToolAgentRegistrations: syncTools,
    onAgentGenerationStateChanged: listener => { generationListeners.add(listener); return () => generationListeners.delete(listener); },
}));

const { ALL_TOOL_NAMES: toolNames, getActiveTunnelVisionBooks: activeBooks } = await import('../public/scripts/extensions/in-chat-agents/pathfinder/pathfinder-tool-bridge.js');
await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/pathfinder/activity-feed.js', () => ({ clearFeed: jest.fn(), getFeedItems: () => [] }));
await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/pathfinder/summary-memory-store.js', () => ({
    getSummaryMemoryState: () => ({ ...summary }),
    onSummaryMemoryChanged: listener => { summaryListeners.add(listener); return () => summaryListeners.delete(listener); },
    saveSummaryMemoryContent,
}));
await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/pathfinder/llm-sidecar.js', () => ({ sidecarGenerate }));
await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/pathfinder/tools/summarize.js', () => ({
    createSummaryMemoryEntry,
    createSeparateSummaryMemoryEntry,
    deriveSummaryLorebookTitle: ({ title }) => title,
}));

store = await import('../public/scripts/extensions/in-chat-agents/agent-store.js');
tree = await import('../public/scripts/extensions/in-chat-agents/pathfinder/tree-store.js');
const ui = await import('../public/scripts/extensions/in-chat-agents/pathfinder-settings-ui.js');
const prompts = await import('../public/scripts/extensions/in-chat-agents/pathfinder/prompts/prompt-store.js');

function setting(panel, key, value) {
    const input = new Control();
    input.dataset.pfSetting = key;
    input.type = typeof value === 'boolean' ? 'checkbox' : 'text';
    input.checked = value;
    input.value = value;
    return panel.fire('change', '[data-pf-setting]', input);
}
function editSummary(panel, text) {
    const input = panel.find('#pf--summary-content');
    input.val(text);
    input.fire('input');
}
function click(panel, selector) { return panel.find(selector).fire('click'); }
function notifySummary() { for (const listener of summaryListeners) listener(); }

function backgroundSaves() {
    const source = readFileSync(new URL('../public/scripts/extensions/in-chat-agents/agent-runner.js', import.meta.url), 'utf8');
    const runtime = vm.createContext({
        console, structuredClone, pathfinderChatSyncRevision: 0, pathfinderToolRevision: 0,
        isPathfinderSubmoduleEnabled: store.isPathfinderSubmoduleEnabled,
        getPathfinderRuntimeAgent: () => store.getEnabledToolAgents()[0], isPathfinderToolAgent: () => true,
        getAgentById: store.getAgentById, getAgents: store.getAgents,
        getCurrentSnapshotChatId: () => generation.chatId,
        getPathfinderRuntimeSettings: tree.getSettings,
        getContextualLorebooks: () => [context.chatMetadata.world_info],
        saveAgent: store.saveAgent, syncToolAgentRegistrations: syncTools,
        notifyAgentGenerationStateChanged: () => { for (const listener of generationListeners) listener(); },
        onPathfinderWorldInfoRenamed() {}, onPathfinderWorldInfoDeleted() {}, invalidatePathfinderRetrieval() {},
    });
    for (const name of ['syncPathfinderAgentLorebooksForCurrentChat', 'onWorldInfoRenamedOrDeleted']) {
        const match = source.match(new RegExp(`^(?:export )?((?:async )?function ${name}\\([\\s\\S]*?^})`, 'm'));
        vm.runInContext(match[1], runtime);
    }
    return runtime;
}

beforeEach(() => {
    jest.clearAllMocks();
    globalThis.$ = value => value instanceof Control ? value : new Control();
    globalThis.toastr = { info: jest.fn(), error: jest.fn(), warning: jest.fn(), success: jest.fn() };
    globalThis.window = { SillyTavern: { getContext: () => context }, matchMedia: () => ({ matches: true }) };
    globalThis.fetch = jest.fn(async () => ({ ok: true }));
    profiles = [];
    generation = { chatId: 'chat-a', runId: 1, cancelRevision: 0 };
    stopped = false;
    context = {
        groupId: null,
        chatMetadata: { world_info: 'Book B' },
        chat: [{ name: 'Character', mes: 'A remembered scene.', is_user: false }],
        ToolManager: { isToolCallingSupported: () => true, tools: toolNames.map(name => ({ toFunctionOpenAI: () => ({ function: { name } }) })) },
    };
    store.setGlobalSettings({ enabled: true, pathfinderEnabled: true, separateRecentChats: false });
    store.loadAgents(['agent-a', 'agent-b'].map(id => ({
        id, name: 'Pathfinder', sourceTemplateId: 'tpl-pathfinder', category: 'tool', enabled: true,
        settings: { sidecarEnabled: false, autoSummary: false, enabledLorebooks: ['Book A'], selectedLorebook: 'Book A', toolStates: { Pathfinder_Summarize: false } },
        tools: toolNames.map(name => ({ name, enabled: name !== 'Pathfinder_Summarize' })),
    })));
    tree.replaceSettings(store.getAgentById('agent-a').settings);
    syncTools.mockImplementation(() => tree.replaceSettings(store.getEnabledToolAgents()[0]?.settings ?? {}));
    summary = { title: 'Saved summary', content: 'Saved memory.', bookName: 'Book A', uid: 0, updatedAt: 1, injectedAt: 0 };
    saveSummaryMemoryContent.mockImplementation(async content => { summary = { ...summary, content }; notifySummary(); });
    createSummaryMemoryEntry.mockResolvedValue({ uid: 1 });
    createSeparateSummaryMemoryEntry.mockResolvedValue({ uid: 2, summaryTitle: 'Separate summary' });
    sidecarGenerate.mockResolvedValue('{"title":"Scene","content":"New memory."}');
});

afterEach(() => {
    ui.closePathfinderSettings();
    delete globalThis.$;
    delete globalThis.toastr;
    delete globalThis.window;
    delete globalThis.fetch;
});

describe('Pathfinder settings persistence', () => {
    test('serialises chat auto-sync with panel edits without losing the newer setting', async () => {
        const panel = await ui.openPathfinderSettings(store.getAgentById('agent-a'));
        const runtime = backgroundSaves();
        const request = deferred();
        globalThis.fetch.mockReturnValueOnce(request.promise);
        const syncing = runtime.syncPathfinderAgentLorebooksForCurrentChat(undefined, { persist: true });
        const editing = setting(panel, 'connectionProfile', 'new-profile');
        await Promise.resolve();
        const inFlight = globalThis.fetch.mock.calls.length;
        request.resolve({ ok: true });
        await Promise.all([syncing, editing]);
        expect(inFlight).toBe(1);
        expect(store.getAgentById('agent-a').settings).toMatchObject({ connectionProfile: 'new-profile', enabledLorebooks: ['Book B'] });
    });

    test('merges queued auto-sync and retargeting into the latest panel save', async () => {
        const panel = await ui.openPathfinderSettings(store.getAgentById('agent-a'));
        const runtime = backgroundSaves();
        const request = deferred();
        globalThis.fetch.mockReturnValueOnce(request.promise);
        const editing = setting(panel, 'connectionProfile', 'new-profile');
        await Promise.resolve();
        const syncing = runtime.syncPathfinderAgentLorebooksForCurrentChat(undefined, { persist: true });
        const retargeting = runtime.onWorldInfoRenamedOrDeleted('Book B', 'Renamed');
        request.resolve({ ok: true });
        await Promise.all([editing, syncing, retargeting]);
        expect(store.getAgentById('agent-a').settings).toMatchObject({ connectionProfile: 'new-profile', enabledLorebooks: ['Renamed'], selectedLorebook: 'Renamed' });
    });

    test('drops obsolete queued chat synchronisation on a rapid switch', async () => {
        const panel = await ui.openPathfinderSettings(store.getAgentById('agent-a'));
        const runtime = backgroundSaves();
        const request = deferred();
        globalThis.fetch.mockReturnValueOnce(request.promise);
        const editing = setting(panel, 'connectionProfile', 'new-profile');
        await Promise.resolve();
        const obsolete = runtime.syncPathfinderAgentLorebooksForCurrentChat(undefined, { persist: true });
        generation.chatId = 'chat-b';
        runtime.pathfinderChatSyncRevision++;
        context.chatMetadata.world_info = 'Book C';
        const current = runtime.syncPathfinderAgentLorebooksForCurrentChat(undefined, { persist: true });
        request.resolve({ ok: true });
        await Promise.all([editing, obsolete, current]);
        expect(globalThis.fetch).toHaveBeenCalledTimes(2);
        expect(store.getAgentById('agent-a').settings).toMatchObject({ connectionProfile: 'new-profile', enabledLorebooks: ['Book C'] });
    });

    test('does not skip the current chat sync using state from before an in-flight save', async () => {
        const runtime = backgroundSaves();
        const request = deferred();
        globalThis.fetch.mockReturnValueOnce(request.promise);
        const old = runtime.syncPathfinderAgentLorebooksForCurrentChat(undefined, { persist: true });
        await Promise.resolve();
        generation.chatId = 'chat-b';
        runtime.pathfinderChatSyncRevision++;
        context.chatMetadata.world_info = 'Book A';
        const current = runtime.syncPathfinderAgentLorebooksForCurrentChat(undefined, { persist: true });
        request.resolve({ ok: true });
        await Promise.all([old, current]);
        expect(globalThis.fetch).toHaveBeenCalledTimes(2);
        expect(store.getAgentById('agent-a').settings.enabledLorebooks).toEqual(['Book A']);
    });

    test('drops queued sync even when navigation returns to the original chat ID', async () => {
        const panel = await ui.openPathfinderSettings(store.getAgentById('agent-a'));
        const runtime = backgroundSaves();
        const request = deferred();
        globalThis.fetch.mockReturnValueOnce(request.promise);
        const editing = setting(panel, 'connectionProfile', 'new-profile');
        await Promise.resolve();
        const obsolete = runtime.syncPathfinderAgentLorebooksForCurrentChat(undefined, { persist: true });
        runtime.pathfinderChatSyncRevision += 2;
        context.chatMetadata.world_info = 'Book A';
        const current = runtime.syncPathfinderAgentLorebooksForCurrentChat(undefined, { persist: true });
        request.resolve({ ok: true });
        await editing;
        await expect(obsolete).resolves.toBe(false);
        await current;
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
        expect(store.getAgentById('agent-a').settings.enabledLorebooks).toEqual(['Book A']);
    });

    test('does not publish an agent before a successful server save', async () => {
        const original = structuredClone(store.getAgentById('agent-a'));
        const changed = structuredClone(original);
        changed.settings.sidecarEnabled = true;
        const request = deferred();
        globalThis.fetch.mockReturnValueOnce(request.promise);
        const save = store.saveAgent(changed);
        expect(store.getAgentById('agent-a')).toEqual(original);
        request.resolve({ ok: false });
        await expect(save).rejects.toThrow('Failed to save agent');
        expect(store.getAgentById('agent-a')).toEqual(original);
        await store.saveAgent(changed);
        expect(store.getAgentById('agent-a').settings.sidecarEnabled).toBe(true);
    });

    test('opens without lorebook reads, tree builds, saves or changing live settings', async () => {
        const before = structuredClone(tree.getSettings());
        const panel = await ui.openPathfinderSettings(store.getAgentById('agent-a'));
        expect(panel).toBeInstanceOf(Control);
        expect(loadWorldInfo).not.toHaveBeenCalled();
        expect(globalThis.fetch).not.toHaveBeenCalled();
        expect(tree.getSettings()).toEqual(before);
        expect(panel.find('#pf--permission-matrix').markup).toContain('Book A');
    });

    test('captures each rapid toggle and registers tools only after its save', async () => {
        const panel = await ui.openPathfinderSettings(store.getAgentById('agent-a'));
        const firstRequest = deferred();
        globalThis.fetch.mockReturnValueOnce(firstRequest.promise);
        const first = setting(panel, 'sidecarEnabled', true);
        const second = setting(panel, 'autoSummary', true);
        await Promise.resolve();
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
        expect(syncTools).not.toHaveBeenCalled();
        expect(store.getAgentById('agent-a').settings.sidecarEnabled).toBe(false);
        expect(tree.getSettings().autoSummary).toBe(false);
        firstRequest.resolve({ ok: true });
        await Promise.all([first, second]);
        const payloads = globalThis.fetch.mock.calls.map(([, options]) => JSON.parse(options.body));
        expect(payloads[0].settings).toMatchObject({ sidecarEnabled: true, autoSummary: false, toolStates: { Pathfinder_Summarize: false } });
        expect(payloads[1].settings).toMatchObject({ sidecarEnabled: true, autoSummary: true, toolStates: { Pathfinder_Summarize: true } });
        expect(syncTools).toHaveBeenCalledTimes(2);
        expect(tree.getSettings()).toMatchObject({ sidecarEnabled: true, autoSummary: true });
        expect(store.getAgentById('agent-a').phaseLocked).toBe(false);
    });

    test('keeps failed prompt edits out of runtime and makes them retryable without false success', async () => {
        const panel = await ui.openPathfinderSettings(store.getAgentById('agent-a'));
        panel.find('#pf--prompt-selector').val('candidate-selector');
        panel.find('#pf--prompt-selector').fire('change');
        panel.find('#pf--prompt-system').val('Private edited prompt');
        const cached = prompts.getPrompt('candidate-selector');
        globalThis.fetch.mockResolvedValueOnce({ ok: false });
        await click(panel, '#pf--prompt-save');
        expect(panel.find('#pf--prompt-status').text()).toContain('Save failed:');
        expect(panel.find('#pf--prompt-system').val()).toBe('Private edited prompt');
        expect(store.getAgentById('agent-a').settings.pipelinePrompts).toBeUndefined();
        expect(prompts.getPrompt('candidate-selector')).toBe(cached);
        expect(syncTools).not.toHaveBeenCalled();
        expect(panel.find('#pf--settings-retry').visible).toBe(true);
        await click(panel, '#pf--settings-retry');
        expect(store.getAgentById('agent-a').settings.pipelinePrompts['candidate-selector'].systemPrompt).toBe('Private edited prompt');
        expect(panel.find('#pf--settings-save-status').text()).toBe('Saved!');
    });

    test('preserves a failed prompt draft and retry across a background lorebook save', async () => {
        const panel = await ui.openPathfinderSettings(store.getAgentById('agent-a'));
        const runtime = backgroundSaves();
        panel.find('#pf--prompt-selector').val('candidate-selector');
        panel.find('#pf--prompt-selector').fire('change');
        panel.find('#pf--prompt-system').val('Private edited prompt');
        globalThis.fetch.mockResolvedValueOnce({ ok: false });
        await click(panel, '#pf--prompt-save');
        await runtime.syncPathfinderAgentLorebooksForCurrentChat(undefined, { persist: true });
        expect(panel.find('#pf--prompt-system').val()).toBe('Private edited prompt');
        expect(panel.find('#pf--settings-retry').visible).toBe(true);
        await click(panel, '#pf--settings-retry');
        expect(store.getAgentById('agent-a').settings.enabledLorebooks).toEqual(['Book B']);
        expect(store.getAgentById('agent-a').settings.pipelinePrompts['candidate-selector'].systemPrompt).toBe('Private edited prompt');
    });

    test('Close waits for queued autosaves and leaves failed settings available for retry', async () => {
        const panel = await ui.openPathfinderSettings(store.getAgentById('agent-a'));
        const request = deferred();
        globalThis.fetch.mockReturnValueOnce(request.promise);
        const save = setting(panel, 'sidecarEnabled', true);
        const closing = ui.canClosePathfinderSettings(panel);
        request.resolve({ ok: false });
        await save;
        await expect(closing).resolves.toBe(false);
        await expect(ui.canClosePathfinderSettings(panel)).resolves.toBe(true);
        await click(panel, '#pf--settings-retry');
        await expect(ui.canClosePathfinderSettings(panel)).resolves.toBe(true);
    });

    test('commits the master switch only after saving and preserves the other chat scope', async () => {
        store.setGlobalSettings({
            separateRecentChats: true,
            scopedEnabledAgentIdsInitialized: true,
            enabledAgentIdsByChatType: { individual: ['agent-a'], group: ['agent-a'] },
        });
        const panel = await ui.openPathfinderSettings(store.getAgentById('agent-a'));
        globalThis.fetch.mockResolvedValueOnce({ ok: false });
        const master = panel.find('#pf--master-enable');
        master.checked = false;
        await master.fire('change');
        expect(store.getGlobalSettings().enabledAgentIdsByChatType.individual).toEqual(['agent-a']);
        await click(panel, '#pf--settings-retry');
        expect(store.getGlobalSettings().enabledAgentIdsByChatType).toEqual({ individual: [], group: ['agent-a'] });
        expect(store.getAgentById('agent-a').enabled).toBe(true);
        expect(master.checked).toBe(false);
    });

    test('drops queued saves on remount and never applies the old panel to a different agent', async () => {
        const firstPanel = await ui.openPathfinderSettings(store.getAgentById('agent-a'));
        const request = deferred();
        globalThis.fetch.mockReturnValueOnce(request.promise);
        const first = setting(firstPanel, 'sidecarEnabled', true);
        await Promise.resolve();
        const queued = setting(firstPanel, 'autoSummary', true);
        const secondPanel = await ui.openPathfinderSettings(store.getAgentById('agent-b'));
        request.resolve({ ok: true });
        await Promise.all([first, queued]);
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
        expect(store.getAgentById('agent-a').settings).toMatchObject({ sidecarEnabled: true, autoSummary: false });
        expect(store.getAgentById('agent-b').settings.sidecarEnabled).toBe(false);
        expect(secondPanel.find('#pf--settings-save-status').text()).toBe('');
        expect(summaryListeners.size).toBe(1);
        expect(events.listenerCount('chat')).toBe(1);
    });

    test('does not overwrite a pending saved field when the same agent is remounted', async () => {
        const firstPanel = await ui.openPathfinderSettings(store.getAgentById('agent-a'));
        const request = deferred();
        globalThis.fetch.mockReturnValueOnce(request.promise);
        const first = setting(firstPanel, 'sidecarEnabled', true);
        await Promise.resolve();
        const secondPanel = await ui.openPathfinderSettings(store.getAgentById('agent-a'));
        const second = setting(secondPanel, 'pipelineEnabled', true);
        request.resolve({ ok: true });
        await Promise.all([first, second]);
        expect(store.getAgentById('agent-a').settings).toMatchObject({ sidecarEnabled: true, pipelineEnabled: true });
    });

    test('unticking a contextual book records an exclusion without erasing its permissions', async () => {
        store.getAgentById('agent-a').settings.bookPermissions = { 'Book B': { read: 'readwrite', write: 'none', delete: false } };
        const panel = await ui.openPathfinderSettings(store.getAgentById('agent-a'));
        const input = new Control();
        input.parent = new Control().attr('data-book', 'Book B');
        input.checked = false;
        await panel.fire('change', '#pf--lorebook-list input', input);
        expect(store.getAgentById('agent-a').settings.bookPermissions['Book B']).toEqual({ enabled: false, read: 'readwrite', write: 'none', delete: false });
        expect(activeBooks()).not.toContain('Book B');
    });

    test('refreshes committed auto-sync selections without overwriting a summary draft', async () => {
        const panel = await ui.openPathfinderSettings(store.getAgentById('agent-a'));
        editSummary(panel, 'Keep this draft');
        store.getAgentById('agent-a').settings.enabledLorebooks = ['Book B'];
        for (const listener of generationListeners) listener();
        expect(panel.find('#pf--permission-matrix').markup).not.toContain('Book A');
        expect(panel.find('#pf--permission-matrix').markup).toContain('Book B');
        expect(panel.find('#pf--summary-content').val()).toBe('Keep this draft');
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    test('does not claim readiness for unreadable books, missing profiles or unsupported tools', async () => {
        const agent = store.getAgentById('agent-a');
        Object.assign(agent.settings, { pipelineEnabled: true, connectionProfile: 'missing' });
        const panel = await ui.openPathfinderSettings(agent);
        const banner = panel.find('#pf--status-banner');
        expect(banner.find('.pf--status-text span').text()).toBe('Missing profile (missing)');
        agent.settings.connectionProfile = '';
        agent.settings.bookPermissions = { 'Book A': { read: false }, 'Book B': { read: 'none' } };
        events.emit('settings');
        expect(banner.find('.pf--status-text span').text()).toBe('No readable lorebooks');
        agent.settings.bookPermissions = {};
        agent.settings.sidecarEnabled = true;
        context.ToolManager.isToolCallingSupported = () => false;
        events.emit('settings');
        expect(banner.find('.pf--status-text span').text()).toContain('Tool calling is not supported');
        expect(banner.classes.has('pf--status-ready')).toBe(false);
    });
});

describe('Pathfinder summary drafts and generation', () => {
    test('retains an unfocused dirty draft and failed edit when summary events arrive', async () => {
        const panel = await ui.openPathfinderSettings(store.getAgentById('agent-a'));
        editSummary(panel, 'Unsaved draft');
        summary.injectedAt = 2;
        notifySummary();
        expect(panel.find('#pf--summary-content').val()).toBe('Unsaved draft');
        saveSummaryMemoryContent.mockRejectedValueOnce(new Error('offline'));
        await click(panel, '#pf--summary-save');
        notifySummary();
        expect(panel.find('#pf--summary-content').val()).toBe('Unsaved draft');
        expect(panel.find('#pf--summary-save-status').text()).toBe('Save failed: offline');
        await click(panel, '#pf--summary-save');
        expect(summary.content).toBe('Unsaved draft');
        expect(panel.find('#pf--summary-save-status').text()).toBe('Saved!');
    });

    test('preserves an explicitly empty draft and supports summary UID zero', async () => {
        const panel = await ui.openPathfinderSettings(store.getAgentById('agent-a'));
        editSummary(panel, '');
        notifySummary();
        expect(panel.find('#pf--summary-content').val()).toBe('');
        expect(panel.find('#pf--summary-save-entry').disabled).toBe(true);
        expect(panel.find('#pf--summary-save').disabled).toBe(false);
        await click(panel, '#pf--summary-save');
        expect(saveSummaryMemoryContent).toHaveBeenCalledWith('');
        expect(summary.content).toBe('');
    });

    test('does not apply a dirty draft to a different tracked summary', async () => {
        const panel = await ui.openPathfinderSettings(store.getAgentById('agent-a'));
        editSummary(panel, 'Original summary draft');
        summary = { ...summary, uid: 5, content: 'Another summary' };
        notifySummary();
        await click(panel, '#pf--summary-save');
        expect(saveSummaryMemoryContent).not.toHaveBeenCalled();
        expect(panel.find('#pf--summary-content').val()).toBe('Original summary draft');
        expect(panel.find('#pf--summary-save-status').text()).toContain('Save failed:');
    });

    test('does not relink edits typed during a save to a newly tracked summary', async () => {
        const panel = await ui.openPathfinderSettings(store.getAgentById('agent-a'));
        const request = deferred();
        editSummary(panel, 'First edit');
        saveSummaryMemoryContent.mockReturnValueOnce(request.promise);
        const save = click(panel, '#pf--summary-save');
        editSummary(panel, 'Still typing');
        summary = { ...summary, uid: 5, content: 'Another summary' };
        notifySummary();
        request.resolve();
        await save;
        expect(panel.find('#pf--summary-content').val()).toBe('Still typing');
        expect(panel.find('#pf--summary-save-status').text()).toContain('Save failed:');
        await click(panel, '#pf--summary-save');
        expect(saveSummaryMemoryContent).toHaveBeenCalledTimes(1);
    });

    test('binds the destination before the model responds', async () => {
        summary = { ...summary, uid: null, content: '' };
        const panel = await ui.openPathfinderSettings(store.getAgentById('agent-a'));
        const request = deferred();
        sidecarGenerate.mockReturnValueOnce(request.promise);
        const create = click(panel, '#pf--summary-create');
        tree.setSettings({ selectedLorebook: 'Book B' });
        request.resolve('{"title":"Scene","content":"New memory."}');
        await create;
        expect(createSummaryMemoryEntry).toHaveBeenCalledWith(expect.objectContaining({ book: 'Book A', content: 'New memory.' }), expect.objectContaining({ signal: expect.anything(), isCurrent: expect.any(Function) }));
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    test.each(['stop', 'chat change', 'disable', 'remount'])('cancels summary generation on %s, including a late model response', async reason => {
        summary = { ...summary, uid: null, content: '' };
        const panel = await ui.openPathfinderSettings(store.getAgentById('agent-a'));
        const request = deferred();
        sidecarGenerate.mockReturnValueOnce(request.promise);
        const create = click(panel, '#pf--summary-create');
        const signal = sidecarGenerate.mock.calls[0][2];
        if (reason === 'stop') {
            generation.cancelRevision++;
            stopped = true;
            for (const listener of generationListeners) listener();
        } else if (reason === 'chat change') {
            generation.chatId = 'chat-b';
            events.emit('chat');
        } else if (reason === 'disable') {
            store.setGlobalSettings({ pathfinderEnabled: false });
            ui.closePathfinderSettings();
        } else {
            await ui.openPathfinderSettings(store.getAgentById('agent-b'));
        }
        expect(signal.aborted).toBe(true);
        request.resolve('{"title":"Late scene","content":"Must not be saved."}');
        await create;
        expect(createSummaryMemoryEntry).not.toHaveBeenCalled();
        expect(generationListeners.size).toBe(reason === 'disable' ? 0 : 1);
    });
});
