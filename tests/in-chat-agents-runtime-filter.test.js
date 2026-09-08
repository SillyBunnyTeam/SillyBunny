/* eslint-disable playwright/no-standalone-expect -- Jest test.each is not recognised by this rule. */
/* global globalThis */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const OWNER = 'SillyBunny-Story-Mode';
const originalFetch = globalThis.fetch;
let store;
let runner;
let context;
let chat;
let chatMetadata;
let extensionSettings;
let extensionPrompts;
let eventSource;
let saveSettingsDebounced;
let runSidecarRetrieval;
let getWorldInfoPrompt;
let callGenericPopup;
let confirmToolCall;
let toolAction;
let tools;

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

function loadAgents(...entries) {
    store.loadAgents(entries.map((entry, order) => ({
        name: entry.id,
        prompt: entry.id,
        enabled: true,
        phase: 'post',
        injection: { order },
        postProcess: { promptTransformEnabled: true },
        ...entry,
    })));
    return store.getAgents();
}

function addMessage() {
    const message = { mes: 'original', name: 'Assistant', is_user: false, is_system: false, extra: {} };
    chat.push(message);
    return message;
}

beforeEach(async () => {
    jest.resetModules();
    jest.useFakeTimers();
    chat = [];
    chatMetadata = {};
    extensionSettings = {};
    extensionPrompts = {};
    saveSettingsDebounced = jest.fn();
    runSidecarRetrieval = jest.fn();
    getWorldInfoPrompt = jest.fn(async () => ({ worldInfoString: '' }));
    callGenericPopup = jest.fn(async () => 2);
    confirmToolCall = jest.fn(async () => true);
    toolAction = jest.fn(async () => 'tool result');
    tools = new Map();
    const handlers = new Map();
    eventSource = {
        on(event, handler) {
            const list = handlers.get(event) ?? [];
            list.push(handler);
            handlers.set(event, list);
        },
        async emit(event, ...args) {
            for (const handler of handlers.get(event) ?? []) {
                await handler(...args);
            }
        },
    };
    const eventTypes = Object.fromEntries([
        'GENERATION_STARTED', 'GENERATION_AFTER_COMMANDS', 'GENERATION_ENDED', 'GENERATION_STOPPED',
        'MESSAGE_RECEIVED', 'MESSAGE_EDITED', 'CHARACTER_MESSAGE_RENDERED', 'IMPERSONATE_READY',
        'GENERATE_AFTER_COMBINE_PROMPTS', 'CHAT_COMPLETION_PROMPT_READY', 'MAIN_GENERATION_OUTPUT_READY',
        'GENERATION_OUTPUT_BUFFERING_DECISION', 'CHAT_COMPLETION_SETTINGS_READY', 'CHAT_CHANGED',
    ].map(name => [name, name]));
    context = {
        groupId: null,
        chatId: 'chat-a',
        chatMetadata,
        mainApi: 'openai',
        generateRaw: jest.fn(async () => 'last-output'),
        saveChat: jest.fn(),
    };
    globalThis.fetch = jest.fn(async () => ({ ok: true }));
    globalThis.document = {
        body: { dataset: {} },
        querySelector: jest.fn(() => null),
        getElementById: jest.fn(() => null),
        addEventListener: jest.fn(),
    };
    globalThis.HTMLSelectElement = class {};
    globalThis.requestAnimationFrame = callback => setTimeout(callback, 0);
    globalThis.toastr = Object.fromEntries(['clear', 'error', 'info', 'success', 'warning'].map(name => [name, jest.fn()]));
    const jquery = { length: 0, each: jest.fn(), trigger: jest.fn() };
    jquery.filter = jquery.first = () => jquery;
    globalThis.$ = () => jquery;

    jest.unstable_mockModule('../public/script.js', () => ({
        chat,
        chat_metadata: chatMetadata,
        extension_prompts: extensionPrompts,
        extension_prompt_roles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
        extension_prompt_types: { IN_PROMPT: 0, IN_CHAT: 1 },
        ensureSwipes: jest.fn(),
        setExtensionPrompt: (key, value) => { extensionPrompts[key] = { value }; },
        substituteParams: value => String(value ?? ''),
        substituteParamsExtended: value => String(value ?? ''),
        generateQuietPrompt: (...args) => context.generateRaw(...args),
        getCurrentChatId: () => context.chatId,
        getRequestHeaders: () => ({}),
        itemizedPrompts: [],
        normalizeContentText: value => String(value ?? ''),
        saveChatDebounced: jest.fn(),
        saveSettingsDebounced,
        stopGeneration: jest.fn(),
        streamingProcessor: null,
        syncMesToSwipe: jest.fn(),
        updateMessageTokenAccounting: jest.fn(),
    }));
    jest.unstable_mockModule('../public/scripts/extensions.js', () => ({
        extension_settings: extensionSettings,
        getContext: () => context,
    }));
    jest.unstable_mockModule('../public/scripts/events.js', () => ({ eventSource, event_types: eventTypes }));
    jest.unstable_mockModule('../public/scripts/utils.js', () => ({
        uuidv4: () => 'test-uuid',
        regexFromString: value => {
            const match = value.match(/^\/(.*)\/([a-z]*)$/);
            return match ? new RegExp(match[1], match[2]) : new RegExp(value);
        },
    }));
    jest.unstable_mockModule('../public/scripts/popup.js', () => ({
        POPUP_RESULT: { CUSTOM2: 2 },
        POPUP_TYPE: { TEXT: 1 },
        callGenericPopup,
    }));
    jest.unstable_mockModule('../public/scripts/tool-calling.js', () => ({
        ToolManager: {
            RECURSE_LIMIT: 5,
            registerFunctionTool: tool => tools.set(tool.name, tool),
            unregisterFunctionTool: name => tools.delete(name),
        },
    }));
    jest.unstable_mockModule('../public/scripts/world-info.js', () => ({ getWorldInfoPrompt }));
    jest.unstable_mockModule('../public/scripts/reasoning.js', () => ({ removeReasoningFromString: value => value }));
    jest.unstable_mockModule('../public/scripts/power-user.js', () => ({ power_user: {} }));
    jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/profile-utils.js', () => ({
        getConnectionProfileDisplayName: id => id,
        getConnectionProfileModelName: () => '',
    }));
    jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/tool-action-registry.js', () => ({
        getToolAction: () => toolAction,
        getToolFormatter: () => null,
    }));
    jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/pathfinder/tree-store.js', () => ({
        getSettings: () => ({ pipelinePrompts: {}, pipelines: {} }),
        replaceSettings: jest.fn(),
        setSettings: jest.fn(),
        deleteTree: jest.fn(),
        syncTrackerUidsForLorebook: jest.fn(),
        isPathfinderSelfWrite: () => false,
    }));
    jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/pathfinder/prompts/prompt-store.js', () => ({
        initializePromptStore: jest.fn(),
        setPromptStorePersistHook: jest.fn(),
    }));
    jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/pathfinder/prompts/default-prompts.js', () => ({
        getDefaultPrompts: () => ({}),
        getDefaultPipelines: () => ({}),
    }));
    jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/pathfinder/tool-definitions.js', () => ({
        getPathfinderToolDefinitions: jest.fn(() => []),
    }));
    jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/pathfinder/pathfinder-tool-bridge.js', () => ({
        getContextualLorebooks: () => [],
        getForcedToolChoice: jest.fn(() => null),
    }));
    jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/pathfinder/tool-confirmation.js', () => ({
        shouldConfirmToolCall: () => true,
        confirmToolCall,
    }));
    jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/pathfinder/sidecar-retrieval.js', () => ({
        PATHFINDER_RETRIEVAL_PROMPT_KEYS: ['pathfinder_sidecar_retrieval'],
        runSidecarRetrieval,
    }));
    jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/pathfinder/auto-summary.js', () => ({
        resetAutoSummaryCount: jest.fn(),
        shouldAutoSummarize: () => false,
    }));
    store = await import('../public/scripts/extensions/in-chat-agents/agent-store.js');
    runner = await import('../public/scripts/extensions/in-chat-agents/agent-runner.js');
    runner.initAgentRunner();
    store.setGlobalSettings({ promptTransformShowNotifications: false, postMainInterceptShowMessageFirst: false });
});

afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    globalThis.fetch = originalFetch;
    delete globalThis.document;
    delete globalThis.HTMLSelectElement;
    delete globalThis.requestAnimationFrame;
    delete globalThis.toastr;
    delete globalThis.$;
});

describe('runtime agent filters', () => {
    test('keeps stored enablement and exports intact across favourite saves and stale-object toggles', async () => {
        const [, cached] = loadAgents({ id: 'keep' }, { id: 'blocked', category: 'tool' }, { id: 'off', enabled: false });
        const settingsBefore = structuredClone(store.getGlobalSettings());
        const agentsBefore = structuredClone(store.exportAllAgents());
        const predicate = jest.fn(agent => agent.id === 'keep');
        store.setRuntimeAgentFilter(OWNER, predicate);

        expect(store.getEnabledAgents().map(agent => agent.id)).toEqual(['keep']);
        expect(store.getEnabledToolAgents()).toEqual([]);
        expect(store.getToolAgents()).toEqual([cached]);
        expect(store.isAgentEnabledForCurrentScope(cached)).toBe(true);
        expect(store.exportAllAgents()).toEqual(agentsBefore);
        expect(globalThis.fetch).not.toHaveBeenCalled();

        cached.favorite = true;
        await store.saveAgent(cached);
        const current = store.getAgentById('blocked');
        expect(current).not.toBe(cached);
        expect(JSON.parse(globalThis.fetch.mock.calls[0][1].body)).toEqual({ ...agentsBefore.agents[1], favorite: true });
        store.setAgentEnabledForScope(cached, true);
        expect(store.isAgentRuntimeAllowed(cached)).toBe(false);
        expect(predicate.mock.calls.at(-1)[0]).toBe(current);
        expect(store.getEnabledAgents().map(agent => agent.id)).toEqual(['keep']);

        store.setRuntimeAgentFilter(OWNER, null);
        expect(store.getEnabledAgents().map(agent => agent.id)).toEqual(['keep', 'blocked']);
        expect(store.getEnabledToolAgents()).toEqual([current]);
        expect(store.getAgentById('off').enabled).toBe(false);
        expect(store.getGlobalSettings()).toEqual(settingsBefore);
        expect(extensionSettings).toEqual({});
        expect(saveSettingsDebounced).not.toHaveBeenCalled();
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    test('uses the current chat and settings without writing scoped IDs or legacy flags', () => {
        loadAgents({ id: 'individual' }, { id: 'group' }, { id: 'both' }, { id: 'off', enabled: false });
        store.setGlobalSettings({
            separateRecentChats: true,
            scopedEnabledAgentIdsInitialized: true,
            enabledAgentIdsByChatType: { individual: ['individual', 'both'], group: ['group', 'both'] },
        });
        const settingsBefore = structuredClone(store.getGlobalSettings());
        const agentsBefore = structuredClone(store.getAgents());
        let settings = { agentGate: true, allowedAgents: ['both'] };
        context.chatMetadata = { story_mode: { enabled: true } };
        store.setRuntimeAgentFilter(OWNER, agent => !context.chatMetadata.story_mode.enabled
            || !settings.agentGate || settings.allowedAgents.includes(agent.id));

        expect(store.getEnabledAgents().map(agent => agent.id)).toEqual(['both']);
        expect(store.isAgentEnabledForCurrentScope(store.getAgentById('individual'))).toBe(true);
        context.groupId = 'group-chat';
        context.chatMetadata = { story_mode: { enabled: false } };
        expect(store.getEnabledAgents().map(agent => agent.id)).toEqual(['group', 'both']);
        context.chatMetadata.story_mode.enabled = true;
        settings = { agentGate: true, allowedAgents: ['group'] };
        expect(store.getEnabledAgents().map(agent => agent.id)).toEqual(['group']);
        settings.agentGate = false;
        expect(store.getEnabledAgents().map(agent => agent.id)).toEqual(['group', 'both']);
        settings.agentGate = true;
        store.setRuntimeAgentFilter(OWNER, null);
        expect(store.getEnabledAgents().map(agent => agent.id)).toEqual(['group', 'both']);
        context.groupId = null;
        expect(store.getEnabledAgents().map(agent => agent.id)).toEqual(['individual', 'both']);
        expect(store.getGlobalSettings()).toEqual(settingsBefore);
        expect(store.getAgents()).toEqual(agentsBefore);
        expect(globalThis.fetch).not.toHaveBeenCalled();
        expect(saveSettingsDebounced).not.toHaveBeenCalled();
    });

    test('validates registrations, combines owners, replaces filters, and fails closed quietly', () => {
        loadAgents({ id: 'a' }, { id: 'b' });
        store.setRuntimeAgentFilter(OWNER, agent => agent.id === 'a');
        for (const owner of ['', ' ', null, 1, {}]) {
            expect(() => store.setRuntimeAgentFilter(owner, null)).toThrow(TypeError);
        }
        for (const predicate of [undefined, false, 1, {}]) {
            expect(() => store.setRuntimeAgentFilter(OWNER, predicate)).toThrow(TypeError);
        }
        expect(store.getEnabledAgents().map(agent => agent.id)).toEqual(['a']);
        store.setRuntimeAgentFilter('other', agent => agent.id === 'b');
        expect(store.getEnabledAgents()).toEqual([]);
        store.setRuntimeAgentFilter(OWNER, () => true);
        expect(store.getEnabledAgents().map(agent => agent.id)).toEqual(['b']);
        store.setRuntimeAgentFilter('other', null);
        store.setRuntimeAgentFilter('other', null);
        expect(store.getEnabledAgents()).toHaveLength(2);

        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const error = jest.spyOn(console, 'error').mockImplementation(() => {});
        store.setRuntimeAgentFilter(OWNER, () => { throw new Error('predicate failed'); });
        expect(store.getEnabledAgents()).toEqual([]);
        expect(store.getEnabledAgents()).toEqual([]);
        store.setRuntimeAgentFilter(OWNER, () => 'truthy is not a boolean');
        expect(store.getEnabledAgents()).toEqual([]);
        expect(warn).not.toHaveBeenCalled();
        expect(error).not.toHaveBeenCalled();
        expect(saveSettingsDebounced).not.toHaveBeenCalled();
        store.setRuntimeAgentFilter(OWNER, null);
        store.setGlobalSettings({ enabled: false });
        expect(store.getEnabledAgents()).toEqual([]);
        expect(store.isAgentRuntimeAllowed(store.getAgentById('a'))).toBe(true);
    });

    test('keeps filters out of explicit settings saves and rejects stale records removed from the store', () => {
        const [cached] = loadAgents({ id: 'agent' });
        const settingsBefore = structuredClone(store.getGlobalSettings());
        store.setRuntimeAgentFilter(OWNER, () => true);
        store.persistAgentGlobalSettings();
        expect(extensionSettings.inChatAgents.globalSettings).toEqual(settingsBefore);
        expect(saveSettingsDebounced).toHaveBeenCalledTimes(1);
        store.loadAgents([]);
        expect(store.isAgentRuntimeAllowed(cached)).toBe(false);
        store.setRuntimeAgentFilter(OWNER, null);
        expect(store.isAgentRuntimeAllowed(cached)).toBe(true);
    });
});

describe('runtime checks at agent dispatch', () => {
    test.each(['rewrite', 'append'])('skips a cached %s agent after an earlier request without stopping permitted siblings', async mode => {
        const agents = loadAgents(...['first', 'blocked', 'last'].map(id => ({
            id, postProcess: { promptTransformEnabled: true, promptTransformMode: mode },
        })));
        store.setGlobalSettings({ appendAgentsExecutionMode: 'sequential' });
        const allowed = new Set(agents.map(agent => agent.id));
        store.setRuntimeAgentFilter(OWNER, agent => allowed.has(agent.id));
        const message = addMessage();
        const started = deferred();
        const response = deferred();
        context.generateRaw.mockImplementationOnce(() => { started.resolve(); return response.promise; });
        const running = eventSource.emit('MESSAGE_RECEIVED', 0, 'normal');
        await started.promise;
        allowed.delete('blocked');
        await store.saveAgent({ ...agents[1], favorite: true });
        response.resolve('first-output');
        await running;

        expect(context.generateRaw.mock.calls.map(([request]) => request.prompt[0].content.split('\n')[0])).toEqual(['first', 'last']);
        expect(message.mes).toContain('last-output');
        expect(store.getAgentById('blocked').enabled).toBe(true);
    });

    test('rechecks cached utilities, regex scripts and the companion stage after prompt transforms', async () => {
        loadAgents(
            { id: 'first' },
            { id: 'append', prompt: '', postProcess: { enabled: true, type: 'append', appendText: 'FORBIDDEN' } },
            { id: 'extract', prompt: '', postProcess: { enabled: true, type: 'extract', extractPattern: '.+', extractVariable: 'forbidden' } },
            { id: 'regex', prompt: '', regexScripts: [{ id: 'regex-script', findRegex: '/output/g', replaceString: 'FORBIDDEN' }] },
            { id: 'companion', execution: 'companion' },
        );
        const message = addMessage();
        const runCompanionStage = jest.fn(async () => []);
        runner.registerCompanionRuntime({ runCompanionStage });
        context.generateRaw.mockImplementationOnce(async () => {
            store.setRuntimeAgentFilter(OWNER, agent => agent.id === 'first');
            return 'first-output';
        });
        await eventSource.emit('MESSAGE_RECEIVED', 0, 'normal');

        expect(message.mes).toBe('first-output');
        expect(chatMetadata.agent_forbidden).toBeUndefined();
        expect(message.extra.inChatAgents).toBeUndefined();
        expect(runCompanionStage.mock.calls[0][0].activeAgents.map(agent => agent.id)).toEqual(['first']);
    });

    test.each(['GENERATE_AFTER_COMBINE_PROMPTS', 'CHAT_COMPLETION_PROMPT_READY', 'MAIN_GENERATION_OUTPUT_READY'])(
        'rechecks cached interceptors in %s after each request', async event => {
            loadAgents(...['first', 'blocked', 'last'].map(id => ({
                id,
                phase: 'pre',
                preProcess: {
                    mode: 'intercept',
                    interceptTiming: event === 'MAIN_GENERATION_OUTPUT_READY' ? 'post-main-generation' : 'pre-generation',
                    applyMode: 'wrap',
                },
            })));
            await eventSource.emit('GENERATION_STARTED', 'normal', {}, false);
            const started = deferred();
            const response = deferred();
            context.generateRaw.mockImplementationOnce(() => { started.resolve(); return response.promise; });
            const data = { prompt: 'original', text: 'original', chat: [{ role: 'user', content: 'original' }] };
            const running = eventSource.emit(event, data);
            await started.promise;
            store.setRuntimeAgentFilter(OWNER, agent => agent.id !== 'blocked');
            response.resolve('first-output');
            await running;
            expect(context.generateRaw.mock.calls.map(([request]) => request.prompt[0].content.split('\n')[0])).toEqual(['first', 'last']);
        },
    );

    test('rechecks post-main interceptors after the review popup', async () => {
        loadAgents({ id: 'blocked', phase: 'pre', preProcess: { mode: 'intercept', interceptTiming: 'post-main-generation' } });
        store.setGlobalSettings({ postMainInterceptShowMessageFirst: true });
        await eventSource.emit('GENERATION_STARTED', 'normal', {}, false);
        const review = deferred();
        callGenericPopup.mockReturnValueOnce(review.promise);
        const data = { text: 'original' };
        const running = eventSource.emit('MAIN_GENERATION_OUTPUT_READY', data);
        store.setRuntimeAgentFilter(OWNER, () => false);
        review.resolve(2);
        await running;
        expect(context.generateRaw).not.toHaveBeenCalled();
        expect(data.text).toBe('original');
    });

    test('rechecks prompt and feedback injection after Pathfinder retrieval', async () => {
        loadAgents(
            { id: 'pathfinder', category: 'tool', sourceTemplateId: 'tpl-pathfinder' },
            { id: 'blocked', phase: 'pre' },
            { id: 'keep', phase: 'pre' },
        );
        const injectCompanionFeedbackPrompts = jest.fn();
        runner.registerCompanionRuntime({ injectCompanionFeedbackPrompts });
        await eventSource.emit('GENERATION_STARTED', 'normal', {}, false);
        const retrieval = deferred();
        runSidecarRetrieval.mockReturnValueOnce(retrieval.promise);
        const running = eventSource.emit('GENERATION_AFTER_COMMANDS', 'normal', {}, false);
        store.setRuntimeAgentFilter(OWNER, agent => agent.id === 'keep');
        retrieval.resolve();
        await running;
        expect(extensionPrompts.inchat_agent_blocked).toBeUndefined();
        expect(extensionPrompts.inchat_agent_keep.value).toBe('keep');
        expect(injectCompanionFeedbackPrompts.mock.calls[0][0].map(agent => agent.id)).toEqual(['keep']);
    });

    test('rechecks generation snapshots when a deferred post-generation timer runs', async () => {
        loadAgents({ id: 'blocked' });
        await eventSource.emit('GENERATION_STARTED', 'normal', {}, false);
        addMessage();
        await eventSource.emit('MESSAGE_RECEIVED', 0, 'normal');
        store.setRuntimeAgentFilter(OWNER, () => false);
        await eventSource.emit('GENERATION_ENDED');
        await jest.advanceTimersByTimeAsync(250);
        expect(context.generateRaw).not.toHaveBeenCalled();
        expect(chat[0].mes).toBe('original');
        expect(store.getAgentById('blocked').enabled).toBe(true);
    });

    test('keeps manual runs of stored-disabled agents available but applies runtime exclusion after the editor wait', async () => {
        loadAgents({ id: 'manual', enabled: false });
        addMessage();
        await runner.runAgentOnMessage('manual', 0);
        expect(context.generateRaw).toHaveBeenCalledTimes(1);
        const running = runner.runAgentOnMessage('manual', 0);
        store.setRuntimeAgentFilter(OWNER, () => false);
        await expect(running).resolves.toBeNull();
        expect(context.generateRaw).toHaveBeenCalledTimes(1);
        store.setRuntimeAgentFilter(OWNER, null);
        await runner.runAgentOnMessage('manual', 0);
        expect(context.generateRaw).toHaveBeenCalledTimes(2);
        expect(store.getAgentById('manual').enabled).toBe(false);
    });

    test('rechecks sequential manual runs after waiting for another agent', async () => {
        loadAgents({ id: 'first', enabled: false }, { id: 'blocked', enabled: false });
        store.setGlobalSettings({ appendAgentsExecutionMode: 'sequential' });
        addMessage();
        const started = deferred();
        const response = deferred();
        context.generateRaw.mockImplementationOnce(() => { started.resolve(); return response.promise; });
        const first = runner.runAgentOnMessage('first', 0);
        await started.promise;
        const queued = runner.runAgentOnMessage('blocked', 0);
        store.setRuntimeAgentFilter(OWNER, agent => agent.id === 'first');
        response.resolve('first-output');
        await first;
        await expect(queued).resolves.toBeNull();
        expect(context.generateRaw).toHaveBeenCalledTimes(1);
        expect(store.getAgents().map(agent => agent.enabled)).toEqual([false, false]);
    });

    test('rechecks tracker repair, metadata extraction and utility appends after the prompt pass', async () => {
        loadAgents(
            { id: 'first', category: 'tracker' },
            { id: 'extract', category: 'tracker', postProcess: { enabled: true, type: 'extract', extractPattern: '.+', extractVariable: 'forbidden' } },
            { id: 'append', category: 'tracker', prompt: '', postProcess: { enabled: true, type: 'append', appendText: 'FORBIDDEN' } },
        );
        const message = addMessage();
        chatMetadata.agent_forbidden = 'previous';
        context.generateRaw.mockImplementationOnce(async () => {
            store.setRuntimeAgentFilter(OWNER, agent => agent.id === 'first');
            return 'first-output';
        });
        await runner.runTrackerFixOnMessage(0);
        expect(context.generateRaw).toHaveBeenCalledTimes(1);
        expect(message.mes).toBe('first-output');
        expect(chatMetadata.agent_forbidden).toBe('previous');
    });

    test.each(['normal', 'impersonate', 'companion_output'])('discards excluded prompt and regex results after an awaited %s pass', async generationType => {
        const [agent] = loadAgents({ id: 'blocked', regexScripts: [{ findRegex: '/output/g', replaceString: 'FORBIDDEN' }] });
        context.generateRaw.mockImplementationOnce(async () => {
            store.setRuntimeAgentFilter(OWNER, () => false);
            return 'first-output';
        });
        const result = await runner.runSingleAgentPostPassesOnText(agent, 'original', generationType);
        expect(result.text).toBe('original');
    });

    test('rechecks a companion request after its awaited context preparation', async () => {
        const [agent] = loadAgents({ id: 'companion', execution: 'companion' });
        const message = addMessage();
        const companions = await import('../public/scripts/extensions/in-chat-agents/companion/companion-runner.js');
        const started = deferred();
        const worldInfo = deferred();
        getWorldInfoPrompt.mockImplementationOnce(() => { started.resolve(); return worldInfo.promise; });
        const running = companions.runCompanionStage({ messageIndex: 0, message, activeAgents: [agent] });
        await started.promise;
        store.setRuntimeAgentFilter(OWNER, () => false);
        worldInfo.resolve({ worldInfoString: '' });
        await running;
        expect(context.generateRaw).not.toHaveBeenCalled();
        expect(companions.getCompanionResults(message)).toEqual({});
        expect(store.getAgentById(agent.id).enabled).toBe(true);
    });

    test('rechecks delayed companion dependencies instead of trusting cached active agents', async () => {
        const agents = loadAgents(
            { id: 'first', execution: 'companion' },
            { id: 'blocked', execution: 'companion', companion: { dependencies: ['first'], waitForDependencies: true } },
        );
        const message = addMessage();
        const companions = await import('../public/scripts/extensions/in-chat-agents/companion/companion-runner.js');
        context.generateRaw.mockImplementationOnce(async () => {
            store.setRuntimeAgentFilter(OWNER, agent => agent.id === 'first');
            return 'first-output';
        });
        await companions.runCompanionStage({ messageIndex: 0, message, activeAgents: agents });
        expect(context.generateRaw).toHaveBeenCalledTimes(1);
    });

    test('rechecks companion-output post passes after a prompt wait', async () => {
        loadAgents({ id: 'companion', execution: 'companion' }, ...['first', 'blocked', 'last'].map(id => ({ id, conditions: { runOnCompanionOutputs: true } })));
        addMessage();
        context.generateRaw.mockImplementationOnce(async () => {
            store.setRuntimeAgentFilter(OWNER, agent => agent.id !== 'blocked');
            return 'first-output';
        });
        const result = await runner.runCompanionOutputPostPasses({ id: 'companion' }, 'original', { messageIndex: 0 });
        expect(context.generateRaw.mock.calls.map(([request]) => request.prompt[0].content.split('\n')[0])).toEqual(['first', 'last']);
        expect(result.text).toBe('last-output');
    });

    test('does not activate runtime-excluded keyword companions or change their saved toggle', async () => {
        loadAgents({ id: 'blocked', execution: 'companion', conditions: { triggerKeywords: ['trigger'] } });
        chat.push({ is_user: true, mes: 'trigger' });
        store.setRuntimeAgentFilter(OWNER, () => false);
        const runCompanionStage = jest.fn(async () => []);
        runner.registerCompanionRuntime({ runCompanionStage });
        await eventSource.emit('GENERATION_STARTED', 'continue', {}, false);
        addMessage();
        await eventSource.emit('GENERATION_ENDED');
        await eventSource.emit('MESSAGE_RECEIVED', 1, 'continue');
        expect(runCompanionStage.mock.calls[0][0].activeAgents).toEqual([]);
        expect(store.isAgentEnabledForCurrentScope(store.getAgentById('blocked'))).toBe(true);
    });

    test.each(['main', 'quiet', 'profile'])('blocks direct %s requests when the runtime predicate throws', async adapter => {
        const [agent] = loadAgents({ id: 'blocked', connectionProfile: adapter === 'profile' ? 'profile' : '' });
        context.mainApi = adapter === 'quiet' ? 'kobold' : 'openai';
        const sendRequest = jest.fn();
        context.ConnectionManagerRequestService = { sendRequest };
        store.setRuntimeAgentFilter(OWNER, () => { throw new Error('predicate failed'); });
        await expect(runner.requestPromptTransform(agent, [{ role: 'user', content: 'test' }], 100))
            .rejects.toMatchObject({ name: 'AbortError' });
        expect(context.generateRaw).not.toHaveBeenCalled();
        expect(sendRequest).not.toHaveBeenCalled();
        expect(runner.isAgentGenerationActive()).toBe(false);
    });

    test('rechecks cached tool registration and dispatch after confirmation without changing stored enablement', async () => {
        const [agent] = loadAgents({ id: 'tool', category: 'tool', tools: [{ name: 'test-tool', actionKey: 'test' }] });
        runner.syncToolAgentRegistrations();
        const tool = tools.get('test-tool');
        store.setRuntimeAgentFilter(OWNER, () => false);
        await expect(tool.shouldRegister()).resolves.toBe(false);
        await expect(tool.action({})).resolves.toBe('');
        expect(confirmToolCall).not.toHaveBeenCalled();

        store.setRuntimeAgentFilter(OWNER, candidate => !candidate.favorite);
        const confirmation = deferred();
        confirmToolCall.mockReturnValueOnce(confirmation.promise);
        const running = tool.action({ value: 1 });
        await store.saveAgent({ ...agent, favorite: true });
        confirmation.resolve(true);
        await expect(running).resolves.toBe('');
        expect(toolAction).not.toHaveBeenCalled();
        store.setRuntimeAgentFilter(OWNER, null);
        await expect(tool.action({ value: 2 })).resolves.toBe('tool result');
        expect(toolAction).toHaveBeenCalledTimes(1);
        expect(store.getAgentById('tool').enabled).toBe(true);
    });

    test('does not start a profile fallback request after exclusion during the primary request', async () => {
        const [agent] = loadAgents({ id: 'profile', connectionProfile: 'test-profile' });
        const response = deferred();
        const sendRequest = jest.fn(() => response.promise);
        context.ConnectionManagerRequestService = { sendRequest };
        const running = runner.requestPromptTransform(agent, [{ role: 'user', content: 'test' }], 100);
        store.setRuntimeAgentFilter(OWNER, () => false);
        response.resolve({ content: '' });
        await expect(running).rejects.toMatchObject({ name: 'AbortError' });
        expect(sendRequest).toHaveBeenCalledTimes(1);
        expect(runner.isAgentGenerationActive()).toBe(false);
    });

    test('does not force tool use for a runtime-excluded Pathfinder with cached registrations', async () => {
        const { getPathfinderToolDefinitions } = await import('../public/scripts/extensions/in-chat-agents/pathfinder/tool-definitions.js');
        const { getForcedToolChoice } = await import('../public/scripts/extensions/in-chat-agents/pathfinder/pathfinder-tool-bridge.js');
        getPathfinderToolDefinitions.mockReturnValue([{ name: 'Pathfinder_Summarize', actionKey: 'test' }]);
        getForcedToolChoice.mockReturnValue('required');
        loadAgents({ id: 'pathfinder', category: 'tool', sourceTemplateId: 'tpl-pathfinder' });
        runner.syncToolAgentRegistrations();
        const permitted = { tools: [{}], tool_choice: 'auto' };
        await eventSource.emit('CHAT_COMPLETION_SETTINGS_READY', permitted);
        expect(permitted.tool_choice).toBe('required');

        store.setRuntimeAgentFilter(OWNER, () => false);
        const excluded = { tool_choice: 'auto' };
        await eventSource.emit('CHAT_COMPLETION_SETTINGS_READY', excluded);
        expect(excluded.tool_choice).toBe('auto');
        expect(getForcedToolChoice).toHaveBeenCalledTimes(1);
    });
});

describe('companion runtime filtering across waits', () => {
    async function setupBatch() {
        const agents = loadAgents(
            { id: 'first', execution: 'companion', companion: { batch: true, batchAgentIds: ['second'] } },
            { id: 'second', execution: 'companion' },
        );
        const message = addMessage();
        const companions = await import('../public/scripts/extensions/in-chat-agents/companion/companion-runner.js');
        for (const agent of agents) {
            companions.setCompanionResult(message, agent, { status: 'done', content: `${agent.id}-old`, tokenUsage: { inputTokens: 3, outputTokens: 2 } });
        }
        return { agents, message, companions, previous: structuredClone(companions.getCompanionResults(message)) };
    }

    const batchOutput = '<<<companion:first>>>first-new<<<end:first>>>\n<<<companion:second>>>second-new<<<end:second>>>';

    test.each(['first', 'second'])('drops %s from a prepared batch after context loading and saving replaces its record', async blockedId => {
        const { agents, message, companions, previous } = await setupBatch();
        const started = deferred();
        const worldInfo = deferred();
        getWorldInfoPrompt.mockImplementationOnce(() => { started.resolve(); return worldInfo.promise; });
        store.setRuntimeAgentFilter(OWNER, agent => !agent.favorite);
        const running = companions.runCompanionStage({ messageIndex: 0, message, activeAgents: agents });
        await started.promise;
        await store.saveAgent({ ...store.getAgentById(blockedId), favorite: true });
        worldInfo.resolve({ worldInfoString: '' });
        await running;

        expect(context.generateRaw).toHaveBeenCalledTimes(1);
        expect(context.generateRaw.mock.calls[0][0].prompt[1].content).not.toContain('<<<companion:');
        expect(companions.getCompanionResults(message)[blockedId]).toEqual(previous[blockedId]);
        expect(companions.getCompanionResults(message)[blockedId === 'first' ? 'second' : 'first'].content).toBe('last-output');
        expect(store.getAgentById(blockedId).enabled).toBe(true);
        expect(saveSettingsDebounced).not.toHaveBeenCalled();
    });

    test.each(['first', 'second'])('does not apply %s when excluded during the combined network request', async blockedId => {
        const { message, companions, previous } = await setupBatch();
        let signal;
        context.generateRaw.mockImplementationOnce(async request => {
            signal = request.signal;
            store.setRuntimeAgentFilter(OWNER, agent => agent.id !== blockedId);
            return batchOutput;
        });
        await companions.runCompanionsOnMessage(0);
        expect(context.generateRaw).toHaveBeenCalledTimes(1);
        expect(signal.aborted).toBe(false);
        expect(companions.getCompanionResults(message)[blockedId]).toEqual(previous[blockedId]);
        const permittedId = blockedId === 'first' ? 'second' : 'first';
        expect(companions.getCompanionResults(message)[permittedId].content).toBe(`${permittedId}-new`);
    });

    test('checks every batch member again before a profile retry', async () => {
        const { message, companions, previous } = await setupBatch();
        store.setGlobalSettings({ companionConnectionProfile: 'profile' });
        const sendRequest = jest.fn()
            .mockImplementationOnce(async () => {
                store.setRuntimeAgentFilter(OWNER, agent => agent.id !== 'second');
                return { content: '' };
            })
            .mockResolvedValue({ content: 'first-new' });
        context.ConnectionManagerRequestService = { sendRequest };
        await companions.runCompanionsOnMessage(0);
        expect(sendRequest).toHaveBeenCalledTimes(2);
        expect(sendRequest.mock.calls[0][1][1].content).toContain('<<<companion:second>>>');
        expect(sendRequest.mock.calls[1][1][1].content).not.toContain('<<<companion:');
        expect(companions.getCompanionResults(message).second).toEqual(previous.second);
        expect(companions.getCompanionResults(message).first.content).toBe('first-new');
    });

    test.each(['missing', 'error'])('checks individual fallback runs after a %s batch response', async failure => {
        const { message, companions, previous } = await setupBatch();
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        context.generateRaw.mockImplementationOnce(async () => {
            if (failure === 'error') throw new Error('request failed');
            return 'unmarked response';
        }).mockImplementationOnce(async () => {
            store.setRuntimeAgentFilter(OWNER, agent => agent.id !== 'second');
            return 'first-new';
        });
        await companions.runCompanionsOnMessage(0);
        expect(context.generateRaw).toHaveBeenCalledTimes(2);
        expect(companions.getCompanionResults(message).first.content).toBe('first-new');
        expect(companions.getCompanionResults(message).second).toEqual(previous.second);
    });

    test('rechecks a batch member after token counting and after an earlier result event', async () => {
        const { message, companions, previous } = await setupBatch();
        context.generateRaw.mockResolvedValueOnce(batchOutput);
        context.promptManager = { tokenHandler: { countUntrackedAsync: jest.fn(async value => {
            if (value?.content === 'first-new') {
                store.setRuntimeAgentFilter(OWNER, agent => agent.id !== 'first');
            }
            return 10;
        }) } };
        await companions.runCompanionsOnMessage(0);
        expect(companions.getCompanionResults(message).first).toEqual(previous.first);
        expect(companions.getCompanionResults(message).second.content).toBe('second-new');

        store.setRuntimeAgentFilter(OWNER, null);
        eventSource.on(companions.COMPANION_RESULTS_UPDATED_EVENT, ({ agentId }) => {
            if (agentId === 'first' && companions.getCompanionResults(message).first?.status === 'done') {
                store.setRuntimeAgentFilter(OWNER, agent => agent.id !== 'second');
            }
        });
        context.promptManager = null;
        context.generateRaw.mockResolvedValueOnce(batchOutput.replaceAll('-new', '-next'));
        await companions.runCompanionsOnMessage(0);
        expect(companions.getCompanionResults(message).first.content).toBe('first-next');
        expect(companions.getCompanionResults(message).second.content).toBe('second-new');
    });

    test('rechecks a batch member after its output post-processing request', async () => {
        const { message, companions, previous } = await setupBatch();
        await store.saveAgent(store.normalizeAgent({ id: 'transformer', enabled: true, prompt: 'transform', phase: 'post', postProcess: { promptTransformEnabled: true }, conditions: { runOnCompanionOutputs: true, companionOutputTargetAgentIds: ['second'] } }));
        context.generateRaw.mockResolvedValueOnce(batchOutput).mockImplementationOnce(async () => {
            store.setRuntimeAgentFilter(OWNER, agent => agent.id !== 'second');
            return 'excluded transformed note';
        });
        await companions.runCompanionsOnMessage(0);
        expect(context.generateRaw).toHaveBeenCalledTimes(2);
        expect(companions.getCompanionResults(message).second).toEqual(previous.second);
        expect(companions.getCompanionResults(message).first.content).toBe('first-new');
    });

    test.each(['response', 'token-count', 'post-pass'])('restores a single companion excluded during %s without applying its result', async phase => {
        const [agent] = loadAgents(
            { id: 'companion', execution: 'companion' },
            { id: 'transformer', conditions: { runOnCompanionOutputs: phase === 'post-pass' } },
        );
        const message = addMessage();
        const companions = await import('../public/scripts/extensions/in-chat-agents/companion/companion-runner.js');
        companions.setCompanionResult(message, agent, { status: 'done', content: 'previous', tokenUsage: { inputTokens: 9, outputTokens: 3 } });
        const previous = structuredClone(companions.getCompanionResults(message).companion);
        const exclude = () => store.setRuntimeAgentFilter(OWNER, candidate => candidate.id !== agent.id);
        context.generateRaw.mockImplementationOnce(async () => {
            if (phase === 'response') exclude();
            return 'new-note';
        }).mockImplementationOnce(async () => { exclude(); return 'transformed-note'; });
        context.promptManager = { tokenHandler: { countUntrackedAsync: async value => {
            if (phase === 'token-count' && value?.content === 'new-note') exclude();
            return 10;
        } } };
        await companions.runCompanionAgentOnMessage(agent.id, 0);
        expect(companions.getCompanionResults(message).companion).toEqual(previous);
    });

    test('blocks direct no-request repairs while preserving stored-disabled manual behaviour without filters', async () => {
        const [agent] = loadAgents({ id: 'tracker', enabled: false, execution: 'companion', category: 'tracker', postProcess: { enabled: true, type: 'extract', extractPattern: '\\[WORLD\\|[^\\]]*\\][\\s\\S]*?\\[\\/WORLD\\]', extractVariable: 'world_data' } });
        const message = addMessage();
        const companions = await import('../public/scripts/extensions/in-chat-agents/companion/companion-runner.js');
        companions.setCompanionResult(message, agent, { status: 'error', content: '[WORLD|Culture|Market]\ndetail: old\n/WORLD]', error: 'old error' });
        const previous = structuredClone(companions.getCompanionResults(message).tracker);
        store.setRuntimeAgentFilter(OWNER, () => false);
        await expect(companions.runCompanionAgentOnMessage(agent.id, 0, { repair: true })).resolves.toBeNull();
        expect(companions.getCompanionResults(message).tracker).toEqual(previous);
        store.setRuntimeAgentFilter(OWNER, null);
        await companions.runCompanionAgentOnMessage(agent.id, 0, { repair: true });
        expect(companions.getCompanionResults(message).tracker.content).toBe('[WORLD|Culture|Market]\ndetail: old\n[/WORLD]');
        expect(context.generateRaw).not.toHaveBeenCalled();
        expect(store.getAgentById(agent.id).enabled).toBe(false);
    });

    test('rechecks cached no-request repairs after an earlier tracker finishes', async () => {
        const agents = loadAgents(...['first', 'second'].map(id => ({ id, execution: 'companion', category: 'tracker', postProcess: { enabled: true, type: 'extract', extractPattern: '\\[WORLD\\|[^\\]]*\\][\\s\\S]*?\\[\\/WORLD\\]', extractVariable: 'world_data' } })));
        const message = addMessage();
        const companions = await import('../public/scripts/extensions/in-chat-agents/companion/companion-runner.js');
        companions.setCompanionResult(message, agents[1], { status: 'error', content: '[WORLD|Culture|Market]\ndetail: old\n/WORLD]', error: 'old error' });
        const previous = structuredClone(companions.getCompanionResults(message).second);
        context.generateRaw.mockImplementationOnce(async () => {
            store.setRuntimeAgentFilter(OWNER, agent => agent.id !== 'second');
            return '[WORLD|Culture|Market]\ndetail: new\n[/WORLD]';
        });
        await companions.runTrackerCompanionsOnMessage(0);
        expect(context.generateRaw).toHaveBeenCalledTimes(1);
        expect(companions.getCompanionResults(message).second).toEqual(previous);
    });

    test.each(['transformer', 'target'])('does not apply manual note post-processing when %s becomes excluded', async blockedId => {
        const [target] = loadAgents({ id: 'target', execution: 'companion' }, { id: 'transformer' });
        const message = addMessage();
        const companions = await import('../public/scripts/extensions/in-chat-agents/companion/companion-runner.js');
        companions.setCompanionResult(message, target, { status: 'done', content: 'previous' });
        const previous = structuredClone(companions.getCompanionResults(message).target);
        context.generateRaw.mockImplementationOnce(async () => {
            store.setRuntimeAgentFilter(OWNER, agent => agent.id !== blockedId);
            return 'excluded edit';
        });
        await expect(companions.applyAgentPostPassesToCompanionResult('transformer', 0, 'target')).resolves.toBeNull();
        expect(companions.getCompanionResults(message).target).toEqual(previous);
    });

    test('stops later output transforms when their companion becomes excluded', async () => {
        const [agent] = loadAgents(
            { id: 'companion', execution: 'companion' },
            { id: 'first-transformer', conditions: { runOnCompanionOutputs: true } },
            { id: 'later-transformer', conditions: { runOnCompanionOutputs: true } },
        );
        const message = addMessage();
        const companions = await import('../public/scripts/extensions/in-chat-agents/companion/companion-runner.js');
        companions.setCompanionResult(message, agent, { status: 'done', content: 'previous' });
        const previous = structuredClone(companions.getCompanionResults(message).companion);
        context.generateRaw.mockResolvedValueOnce('new-note').mockImplementationOnce(async () => {
            store.setRuntimeAgentFilter(OWNER, candidate => candidate.id !== agent.id);
            return 'excluded-note';
        });
        await companions.runCompanionAgentOnMessage(agent.id, 0);
        expect(context.generateRaw).toHaveBeenCalledTimes(2);
        expect(companions.getCompanionResults(message).companion).toEqual(previous);
    });

    test('checks the note owner again when generation-state listeners change the gate before dispatch', async () => {
        const [agent] = loadAgents({ id: 'companion', execution: 'companion' }, { id: 'transformer' });
        const message = addMessage();
        const companions = await import('../public/scripts/extensions/in-chat-agents/companion/companion-runner.js');
        companions.setCompanionResult(message, agent, { status: 'done', content: 'previous' });
        const previous = structuredClone(companions.getCompanionResults(message).companion);
        runner.onAgentGenerationStateChanged(active => {
            if (active) store.setRuntimeAgentFilter(OWNER, candidate => candidate.id !== agent.id);
        });
        await companions.applyAgentPostPassesToCompanionResult('transformer', 0, agent.id);
        expect(context.generateRaw).not.toHaveBeenCalled();
        expect(companions.getCompanionResults(message).companion).toEqual(previous);
    });

    test('discards an excluded parallel append result before consolidating the companion note', async () => {
        const [agent] = loadAgents(
            { id: 'companion', execution: 'companion' },
            ...['first', 'second'].map(id => ({ id, conditions: { runOnCompanionOutputs: true }, postProcess: { promptTransformEnabled: true, promptTransformMode: 'append' } })),
        );
        const message = addMessage();
        const companions = await import('../public/scripts/extensions/in-chat-agents/companion/companion-runner.js');
        const started = deferred();
        const response = deferred();
        context.generateRaw.mockResolvedValueOnce('raw-note').mockResolvedValueOnce('first-addition')
            .mockImplementationOnce(() => { started.resolve(); return response.promise; });
        const running = companions.runCompanionAgentOnMessage(agent.id, 0);
        await started.promise;
        await jest.advanceTimersByTimeAsync(0);
        store.setRuntimeAgentFilter(OWNER, candidate => candidate.id !== 'first');
        response.resolve('second-addition');
        await running;
        expect(context.generateRaw).toHaveBeenCalledTimes(3);
        expect(companions.getCompanionResults(message).companion.content).toBe('raw-note\n\nsecond-addition');
    });

    test.each([false, true])('discards generated repairs after exclusion (previous note: %s)', async hasPrevious => {
        const [agent] = loadAgents({ id: 'tracker', execution: 'companion', category: 'tracker', postProcess: { enabled: true, type: 'extract', extractPattern: '\\[WORLD\\|[^\\]]*\\][\\s\\S]*?\\[\\/WORLD\\]', extractVariable: 'world_data' } });
        const message = addMessage();
        const companions = await import('../public/scripts/extensions/in-chat-agents/companion/companion-runner.js');
        if (hasPrevious) {
            companions.setCompanionResult(message, agent, { status: 'done', content: 'broken previous note', tokenUsage: { inputTokens: 4, outputTokens: 2 } });
        }
        const previous = structuredClone(companions.getCompanionResults(message));
        context.generateRaw.mockImplementationOnce(async request => {
            store.setRuntimeAgentFilter(OWNER, () => false);
            expect(request.signal.aborted).toBe(false);
            return '[WORLD|Culture|Market]\ndetail: new\n[/WORLD]';
        });
        await companions.runCompanionAgentOnMessage(agent.id, 0, { repair: true });
        expect(context.generateRaw).toHaveBeenCalledTimes(1);
        expect(companions.getCompanionResults(message)).toEqual(previous);
    });

    test('restores a direct repair if the gate changes during its result notification', async () => {
        const [agent] = loadAgents({ id: 'tracker', execution: 'companion', category: 'tracker', postProcess: { enabled: true, type: 'extract', extractPattern: '\\[WORLD\\|[^\\]]*\\][\\s\\S]*?\\[\\/WORLD\\]', extractVariable: 'world_data' } });
        const message = addMessage();
        const companions = await import('../public/scripts/extensions/in-chat-agents/companion/companion-runner.js');
        const { saveChatDebounced } = await import('../public/script.js');
        companions.setCompanionResult(message, agent, { status: 'error', content: '[WORLD|Culture|Market]\ndetail: old\n/WORLD]', error: 'previous error' });
        const previous = structuredClone(companions.getCompanionResults(message).tracker);
        eventSource.on(companions.COMPANION_RESULTS_UPDATED_EVENT, () => {
            store.setRuntimeAgentFilter(OWNER, () => false);
        });
        await companions.runCompanionAgentOnMessage(agent.id, 0, { repair: true });
        expect(companions.getCompanionResults(message).tracker).toEqual(previous);
        expect(context.generateRaw).not.toHaveBeenCalled();
        expect(saveChatDebounced).not.toHaveBeenCalled();
    });
});
