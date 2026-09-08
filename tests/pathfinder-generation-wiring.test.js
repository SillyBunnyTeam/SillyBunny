/* eslint-disable playwright/no-standalone-expect */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { EventEmitter } from '../public/lib/eventemitter.js';
import { event_types } from '../public/scripts/events.js';
import { resolveGenerationUiLockState, resolveGenerationUnblockState, resolveStopGenerationState } from '../public/scripts/generation-lifecycle/index.js';
import { limitGenerationProse, isGenerationLengthFinish } from '../public/scripts/generation-request-controls.js';

await jest.unstable_mockModule('../public/script.js', () => ({ chat: [], getCurrentChatId: () => 'chat-a' }));
await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/agent-store.js', () => ({ isPathfinderSubmoduleEnabled: () => true }));
await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/profile-utils.js', () => ({ listConnectionProfiles: () => [] }));
await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/pathfinder/pathfinder-tool-bridge.js', () => ({ getReadableBooks: () => ['Lore'] }));
await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/pathfinder/llm-sidecar.js', () => ({ sidecarGenerate: jest.fn(), sidecarGenerateWithProfile: jest.fn() }));
await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/pathfinder/summary-memory-store.js', () => ({ isSummaryMemoryEntry: () => false, markSummaryMemoryInjected: jest.fn() }));
const { injectPathfinderRetrieval } = await import('../public/scripts/extensions/in-chat-agents/pathfinder/sidecar-retrieval.js');

const scriptSource = readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
const worldSource = readFileSync(new URL('../public/scripts/world-info.js', import.meta.url), 'utf8');
const runnerSource = readFileSync(new URL('../public/scripts/extensions/in-chat-agents/agent-runner.js', import.meta.url), 'utf8');

function functionSource(source, name) {
    const match = source.match(new RegExp(`^(?:export )?((?:async )?function ${name}\\([\\s\\S]*?^})`, 'm'));
    if (!match) throw new Error(`Missing function ${name}`);
    return match[1];
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function createHost() {
    const events = new EventEmitter();
    const context = vm.createContext({
        AbortController, AbortSignal, structuredClone, console,
        eventSource: events, event_types,
        resolveGenerationUiLockState, resolveGenerationUnblockState, resolveStopGenerationState,
        limitGenerationProse, isGenerationLengthFinish,
        activeGenerationRun: null, agentGenerationContextProvider: null, abortController: null,
        generationChatFilter: null,
        chatId: 'chat-a', chatGeneration: 0, agentRunId: 0, cancelRevision: 0,
        chat: [], chat_metadata: {}, characters: [{ name: 'Assistant', data: { extensions: {} } }],
        this_chid: 0, selected_group: null, is_group_generating: false, is_send_press: false, streamingProcessor: null,
        name1: 'User', name2: 'Assistant', main_api: 'openai', online_status: 'connected', generation_started: null,
        power_user: { instruct: { enabled: false }, sysprompt: {}, context: {} },
        oai_settings: { send_if_empty: '' }, kai_settings: {}, kai_flags: {}, nai_settings: {},
        amount_gen: 100, max_context: 4096, world_info_include_names: false,
        depth_prompt_depth_default: 4, depth_prompt_role_default: 0,
        extension_settings: { note: { allowWIScan: false } },
        extension_prompts: {}, extension_prompt_types: { IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 }, extension_prompt_roles: { SYSTEM: 0 },
        inject_ids: { DEPTH_PROMPT: 'depth', QUIET_PROMPT: 'quiet', STORY_STRING: 'story' },
        GENERATION_TYPE_TRIGGERS: ['normal', 'swipe', 'continue'], IGNORE_SYMBOL: Symbol('ignore'),
        wi_anchor_position: { before: 0, after: 1 }, persona_description_positions: { IN_PROMPT: 0 },
        itemizedPrompts: [], openai_messages_count: 0, kobold_horde_model: '',
        internalPromptTransformDepth: 0, isGenerationInProgress: false, pathfinderRetrievalRun: null,
        injectPathfinderRetrieval,
        document: { body: { dataset: {} } },
        Event: class {},
        unshallowCharacter: jest.fn(async () => {}), processCommands: jest.fn(async () => false),
        getBiasStrings: () => ({ messageBias: '', promptBias: '', isUserPromptBias: false }),
        hasPendingFileAttachment: () => false, shouldBatchMobileChatRendering: () => false,
        isHordeGenerationNotAllowed: jest.fn(() => false), pingServer: jest.fn(async () => true),
        getCharacterCardFields: () => ({ description: '', personality: '', persona: '', scenario: '', mesExamples: '', system: '', jailbreak: '' }),
        getGroupDepthPrompts: () => [],
        getExtensionPromptRoleByName: role => role,
        ToolManager: { isToolCallingSupported: () => false, canPerformToolCalls: () => false, RECURSE_LIMIT: 5 },
        selectCompanionChatHistory: () => [], consolidateCompanionChatHistory: () => ({ host: null, entries: [] }),
        PromptReasoning: class { removePrefix(text) { return text; } },
        getMaxPromptTokens: () => 4096, runGenerationInterceptors: jest.fn(async () => false),
        getGuidanceScale: () => null, parseMesExamples: () => [], buildWorldInfoScanChat: () => [],
        checkWorldInfo: jest.fn(async () => ({ worldInfoBefore: 'Native town lore.', worldInfoAfter: '', allActivatedEntries: new Set([{ world: 'Lore', uid: 1 }]) })),
        setOpenAIMessages: messages => messages, setOpenAIMessageExamples: messages => messages,
        addChatsPreamble: text => text, addChatsSeparator: text => text, getTokenCountAsync: async () => 0,
        renderStoryString: () => '', substituteParams: text => text, baseChatReplace: text => text,
        getAllExtensionPrompts: async () => '', getFriendlyTokenizerName: () => ({}), getPresetManager: () => null,
        getChatCompletionModel: () => 'model', isStreamingEnabled: () => false,
        sendGenerationRequest: jest.fn(async () => ({ message: 'reply' })),
        extractMessageFromData: data => data.message, extractTitleFromData: () => '', extractReasoningFromData: () => '',
        extractImagesFromData: () => [], extractReasoningSignatureFromData: () => '', extractMultiSwipes: () => [],
        cleanUpMessage: ({ getMessage }) => getMessage, getRegexedString: text => text, regex_placement: { REASONING: 0 },
        applyMainGenerationOutputInterceptors: jest.fn(async ({ text }) => ({ text, cancelled: false })),
        saveReply: jest.fn(async data => data), saveChatConditional: jest.fn(async () => {}),
        TempResponseLength: { isCustomized: () => false }, removeReasoningFromString: text => text,
        t: (strings, ...values) => String.raw({ raw: strings }, ...values),
        toastr: { error: jest.fn(), warning: jest.fn() },
    });
    const buttons = { visible: false, generatingClass: false };
    const input = { val(value) { return arguments.length ? input : ''; }, 0: { dispatchEvent() {} } };
    context.$ = selector => ({
        '#send_textarea': input,
        '#send_form': { addClass() { buttons.generatingClass = true; }, removeClass() { buttons.generatingClass = false; } },
        '#mes_stop': { css(value) {
            if (typeof value === 'string') return buttons.generatingClass && buttons.visible ? 'flex' : 'none';
            buttons.visible = value.display !== 'none';
        } },
    }[selector]);
    for (const name of ['setGenerationProgress', 'showSwipeButtons', 'hideSwipeButtons', 'removeDepthPrompts', 'setFloatingPrompt', 'flushWIInjections', 'flushEphemeralStoppingStrings', 'addPersonaDescriptionExtensionPrompt', 'setInContextMessages', 'parseAndSaveLogprobs', 'playMessageSound', 'triggerAutoContinue']) {
        context[name] = jest.fn();
    }
    context.getCurrentChatId = () => context.chatId;
    context.clearStreamingProcessorIfCurrent = processor => { if (context.streamingProcessor === processor) context.streamingProcessor = null; };
    context.setExtensionPrompt = jest.fn((key, value) => { context.extension_prompts[key] = { value }; });
    context.getExtensionPrompt = async () => context.extension_prompts.pathfinder_pipeline_retrieval?.value ?? '';
    context.prepareOpenAIMessages = jest.fn(async data => [[{ role: 'system', content: data.extensionPrompts.pathfinder_pipeline_retrieval?.value ?? '' }], false]);
    const scriptFunctions = ['setAgentGenerationContextProvider', 'Generate', 'generateQuietPrompt', 'showStopButton', 'hideStopButton', 'activateSendButtons', 'deactivateSendButtons', 'stopGeneration', 'unblockGeneration', 'getNextMessageId'];
    vm.runInContext(scriptFunctions.map(name => functionSource(scriptSource, name)).join('\n'), context);
    vm.runInContext(functionSource(worldSource, 'getWorldInfoPrompt'), context);
    vm.runInContext(functionSource(runnerSource, 'onWorldInfoActivated'), context);
    context.setAgentGenerationContextProvider(() => ({ chatId: context.chatId, runId: context.agentRunId, cancelRevision: context.cancelRevision }));
    events.on(event_types.GENERATION_STARTED, (_type, options, dryRun) => {
        if (!dryRun && !options.isAuxiliaryGeneration && !(context.selected_group && !context.is_group_generating)) {
            context.agentRunId++;
            context.isGenerationInProgress = true;
        }
    });
    events.on(event_types.GENERATION_AFTER_COMMANDS, (type, options, dryRun) => {
        if (dryRun || type === 'quiet' || options.isAuxiliaryGeneration || (context.selected_group && !context.is_group_generating)) return;
        const result = {
            success: true, promptKey: 'pathfinder_pipeline_retrieval', mode: 'pipeline', books: ['Lore'],
            selectedEntries: [{ bookName: 'Lore', uid: 1, name: 'Town', content: 'Town lore.' }, { bookName: 'Lore', uid: 2, name: 'Forest', content: 'Forest lore.' }],
        };
        context.pathfinderRetrievalRun = {
            ...context.agentGenerationContextProvider(), result, isCurrent: () => true,
            writePrompt: context.setExtensionPrompt, nativeApplied: false,
        };
        injectPathfinderRetrieval(result, context.setExtensionPrompt, context.extension_prompt_types, context.extension_prompt_roles);
    });
    events.on(event_types.WORLD_INFO_ACTIVATED, context.onWorldInfoActivated);
    events.on(event_types.GENERATION_STOPPED, () => { context.cancelRevision++; context.isGenerationInProgress = false; });
    events.on(event_types.GENERATION_ENDED, () => { context.isGenerationInProgress = false; });
    const emitted = jest.spyOn(events, 'emit');
    return { context, events, emitted, buttons, generate: (type = 'normal', options = {}, dryRun = false) => context.Generate(type, { suppressUserMessage: true, ...options }, dryRun) };
}

afterEach(() => jest.restoreAllMocks());

describe('Pathfinder integration with the real extracted host generation flow', () => {
    test('tags the actual native scan and removes only its activated entries before prompt assembly', async () => {
        const host = createHost();
        await host.generate();
        expect(host.context.checkWorldInfo).toHaveBeenCalledTimes(1);
        const native = host.emitted.mock.calls.find(([event]) => event === event_types.WORLD_INFO_ACTIVATED);
        expect(native[2]).toEqual({ chatId: 'chat-a', runId: 1, cancelRevision: 0 });
        expect(host.context.prepareOpenAIMessages.mock.calls[0][0].worldInfoBefore).toBe('Native town lore.');
        const prompt = host.context.sendGenerationRequest.mock.calls[0][1].prompt[0].content;
        expect(prompt).not.toContain('Town lore.');
        expect(prompt).toContain('Forest lore.');
        expect(host.emitted.mock.calls.filter(([event]) => event === event_types.GENERATION_ENDED)).toHaveLength(1);
        expect(host.context.activeGenerationRun).toBeNull();
    });

    test.each([
        ['commands', host => host.context.processCommands.mockResolvedValue(true)],
        ['blocked provider', host => host.context.isHordeGenerationNotAllowed.mockReturnValue(true)],
        ['no connection', host => { host.context.online_status = 'no_connection'; }],
    ])('emits one terminal event for %s, including before the Stop button becomes visible', async (_name, setup) => {
        const host = createHost();
        setup(host);
        await host.generate('normal', { suppressUserMessage: false });
        expect(host.emitted.mock.calls.filter(([event]) => event === event_types.GENERATION_ENDED)).toHaveLength(1);
        expect(host.context.is_send_press).toBe(false);
        expect(host.context.sendGenerationRequest).not.toHaveBeenCalled();
        expect(host.context.activeGenerationRun).toBeNull();
    });

    test('cleans up a prompt preparation exception that occurs before the API error handler', async () => {
        const host = createHost();
        host.context.checkWorldInfo.mockRejectedValueOnce(new Error('scan failed'));
        await expect(host.generate()).rejects.toThrow('scan failed');
        expect(host.emitted.mock.calls.filter(([event]) => event === event_types.GENERATION_ENDED)).toHaveLength(1);
        expect(host.buttons.visible).toBe(false);
        expect(host.context.activeGenerationRun).toBeNull();
    });

    test('creates the abort controller before start listeners and honours Stop while the busy UI is still unset', async () => {
        const host = createHost();
        const started = deferred();
        const release = deferred();
        host.events.on(event_types.GENERATION_STARTED, async () => { started.resolve(); await release.promise; });
        const pending = host.generate();
        await started.promise;
        expect(host.context.is_send_press).toBe(false);
        expect(host.context.stopGeneration()).toBe(true);
        expect(host.context.abortController.signal.aborted).toBe(true);
        release.resolve();
        await pending;
        expect(host.context.processCommands).not.toHaveBeenCalled();
        expect(host.emitted.mock.calls.filter(([event]) => event === event_types.GENERATION_ENDED)).toHaveLength(0);
        expect(host.context.activeGenerationRun).toBeNull();
    });

    test('uses the current cancellation revision when explicit Stop follows agent cancellation', async () => {
        const host = createHost();
        const started = deferred();
        const release = deferred();
        const stopped = jest.fn();
        host.events.on(event_types.GENERATION_STOPPED, stopped);
        host.events.on(event_types.GENERATION_AFTER_COMMANDS, async () => { started.resolve(); await release.promise; });
        const pending = host.generate();
        await started.promise;
        host.context.cancelRevision++;
        host.context.stopGeneration();
        expect(stopped).toHaveBeenCalledWith({ chatId: 'chat-a', runId: 1, cancelRevision: 1 });
        release.resolve();
        await pending;
    });

    test.each(['Stop', 'chat change', 'new generation'])('does not continue past pending retrieval after %s', async reason => {
        const host = createHost();
        const started = deferred();
        const release = deferred();
        host.events.on(event_types.GENERATION_AFTER_COMMANDS, async () => { started.resolve(); await release.promise; });
        const pending = host.generate();
        await started.promise;
        const cancel = {
            Stop: () => host.context.stopGeneration(),
            'chat change': async () => { host.context.chatId = 'chat-b'; host.context.chatGeneration++; await host.events.emit(event_types.CHAT_CHANGED); },
            'new generation': () => { host.context.activeGenerationRun = { controller: new AbortController(), type: 'normal' }; },
        };
        await cancel[reason]();
        host.context.chat_metadata = {};
        host.context.extension_prompts = { sentinel: { value: 'new chat' } };
        release.resolve();
        await pending;
        expect(host.context.chat_metadata).toEqual({});
        expect(host.context.extension_prompts).toEqual({ sentinel: { value: 'new chat' } });
        expect(host.context.checkWorldInfo).not.toHaveBeenCalled();
        expect(host.context.sendGenerationRequest).not.toHaveBeenCalled();
    });

    test('rejects a late native activation from a replaced run and leaves the new prompt untouched', async () => {
        const host = createHost();
        const started = deferred();
        const release = deferred();
        host.context.checkWorldInfo.mockImplementationOnce(async () => { started.resolve(); return release.promise; });
        const pending = host.generate();
        await started.promise;
        host.context.agentRunId++;
        host.context.pathfinderRetrievalRun.runId = host.context.agentRunId;
        host.context.pathfinderRetrievalRun.nativeApplied = false;
        host.context.extension_prompts = { sentinel: { value: 'new run' } };
        release.resolve({ worldInfoBefore: '', worldInfoAfter: '', allActivatedEntries: new Set([{ world: 'Lore', uid: 1 }]) });
        await pending;
        expect(host.context.pathfinderRetrievalRun.nativeApplied).toBe(false);
        expect(host.context.extension_prompts).toEqual({ sentinel: { value: 'new run' } });
        expect(host.context.sendGenerationRequest).not.toHaveBeenCalled();
    });

    test('awaits a group child without its outer wrapper ending or cancelling that child', async () => {
        const host = createHost();
        host.context.selected_group = 'group';
        const childStarted = deferred();
        const releaseChild = deferred();
        host.context.sendGenerationRequest.mockImplementationOnce(async () => { childStarted.resolve(); await releaseChild.promise; return { message: 'group reply' }; });
        host.context.generateGroupWrapper = jest.fn(async (_auto, type, options) => {
            host.context.is_group_generating = true;
            try { return await host.generate(type, options); }
            finally { host.context.is_group_generating = false; }
        });
        const pending = host.generate();
        await childStarted.promise;
        expect(host.emitted.mock.calls.filter(([event]) => event === event_types.GENERATION_ENDED)).toHaveLength(0);
        expect(host.context.abortController.signal.aborted).toBe(false);
        releaseChild.resolve();
        const result = await pending;
        expect(String(result)).toBe('group reply');
        expect(host.context.checkWorldInfo).toHaveBeenCalledTimes(1);
        expect(host.emitted.mock.calls.filter(([event]) => event === event_types.GENERATION_ENDED)).toHaveLength(1);
    });

    test('does not tag a dry preview or let it end the active generation', async () => {
        const host = createHost();
        const parent = { controller: new AbortController(), type: 'normal' };
        host.context.activeGenerationRun = parent;
        host.context.is_send_press = true;
        await host.generate('normal', {}, true);
        expect(host.context.activeGenerationRun).toBe(parent);
        expect(host.context.is_send_press).toBe(true);
        expect(host.emitted.mock.calls.filter(([event]) => event === event_types.WORLD_INFO_ACTIVATED || event === event_types.GENERATION_ENDED)).toHaveLength(0);
        expect(host.context.sendGenerationRequest).not.toHaveBeenCalled();
    });

    test('keeps nested quiet scans untagged and preserves the main controller and terminal lifecycle', async () => {
        const host = createHost();
        const started = deferred();
        const release = deferred();
        host.events.on(event_types.GENERATION_AFTER_COMMANDS, async type => {
            if (type !== 'quiet') { started.resolve(); await release.promise; }
        });
        const pending = host.generate();
        await started.promise;
        const mainController = host.context.abortController;
        await host.context.generateQuietPrompt({ quietPrompt: 'helper', skipWIAN: true });
        const native = host.emitted.mock.calls.find(([event]) => event === event_types.WORLD_INFO_ACTIVATED);
        expect(native).toHaveLength(2);
        expect(host.context.pathfinderRetrievalRun.nativeApplied).toBe(false);
        expect(host.context.abortController).toBe(mainController);
        expect(host.emitted.mock.calls.filter(([event]) => event === event_types.GENERATION_ENDED)).toHaveLength(0);
        release.resolve();
        await pending;
        expect(host.emitted.mock.calls.filter(([event]) => event === event_types.GENERATION_ENDED)).toHaveLength(1);
    });

    test.each([
        ['failure', request => request.mockRejectedValueOnce(new Error('quiet failed'))],
        ['empty response', request => request.mockResolvedValueOnce(null)],
    ])('does not stop the main generation on a nested quiet %s', async (_name, setup) => {
        const host = createHost();
        const started = deferred();
        const release = deferred();
        host.events.on(event_types.GENERATION_AFTER_COMMANDS, async type => {
            if (type !== 'quiet') { started.resolve(); await release.promise; }
        });
        const main = host.generate();
        await started.promise;
        const mainController = host.context.abortController;
        setup(host.context.sendGenerationRequest);
        await host.context.generateQuietPrompt({ quietPrompt: 'helper' }).catch(() => undefined);
        expect(mainController.signal.aborted).toBe(false);
        expect(host.context.abortController).toBe(mainController);
        expect(host.context.is_send_press).toBe(false);
        expect(host.emitted.mock.calls.filter(([event]) => event === event_types.GENERATION_ENDED || event === event_types.GENERATION_STOPPED)).toHaveLength(0);
        release.resolve();
        await main;
    });

    test('does not let a late quiet failure stop a newer main request', async () => {
        const host = createHost();
        const oldStarted = deferred();
        const oldRelease = deferred();
        host.events.on(event_types.GENERATION_AFTER_COMMANDS, async type => {
            if (type !== 'quiet' && host.context.agentRunId === 1) { oldStarted.resolve(); await oldRelease.promise; }
        });
        const old = host.generate();
        await oldStarted.promise;
        const quietStarted = deferred();
        const quietResponse = deferred();
        const nextStarted = deferred();
        const nextResponse = deferred();
        host.context.sendGenerationRequest.mockImplementationOnce(() => { quietStarted.resolve(); return quietResponse.promise; })
            .mockImplementationOnce(() => { nextStarted.resolve(); return nextResponse.promise; });
        const quiet = host.context.generateQuietPrompt({ quietPrompt: 'helper' }).catch(error => error);
        await quietStarted.promise;
        const next = host.generate();
        await nextStarted.promise;
        const nextController = host.context.abortController;
        quietResponse.reject(new Error('quiet failed'));
        await expect(quiet).resolves.toMatchObject({ message: 'quiet failed' });
        oldRelease.resolve();
        await old;
        expect(nextController.signal.aborted).toBe(false);
        expect(host.context.abortController).toBe(nextController);
        expect(host.context.is_send_press).toBe(true);
        expect(host.emitted.mock.calls.filter(([event]) => event === event_types.GENERATION_ENDED || event === event_types.GENERATION_STOPPED)).toHaveLength(0);
        nextResponse.resolve({ message: 'new reply' });
        await next;
    });

    test('preserves a recursive tool pass result without duplicate terminal events', async () => {
        const host = createHost();
        Object.assign(host.context.ToolManager, {
            canPerformToolCalls: () => true,
            hasToolCalls: data => Boolean(data.tool),
            invokeFunctionTools: jest.fn(async data => ({ invocations: data.tool ? [{}] : [], stealthCalls: [] })),
            saveFunctionToolInvocations: jest.fn(async () => {}),
        });
        host.context.sendGenerationRequest.mockResolvedValueOnce({ message: 'tool plan', tool: true }).mockResolvedValueOnce({ message: 'final reply' });
        const result = await host.generate();
        expect(String(result)).toBe('final reply');
        expect(host.context.sendGenerationRequest).toHaveBeenCalledTimes(2);
        expect(host.context.ToolManager.invokeFunctionTools.mock.calls[0][1]).toEqual(expect.objectContaining({ isCurrent: expect.any(Function), signal: expect.any(AbortSignal) }));
        expect(host.context.ToolManager.invokeFunctionTools.mock.calls[0][1].isCurrent()).toBe(false);
        expect(host.context.sendGenerationRequest.mock.calls[1][2].signal).toBe(host.context.sendGenerationRequest.mock.calls[0][2].signal);
        expect(host.emitted.mock.calls.filter(([event]) => event === event_types.GENERATION_ENDED)).toHaveLength(1);
    });

    test('preserves a recursive streaming tool result while the successor owns completion', async () => {
        const host = createHost();
        let streamIndex = 0;
        host.context.StreamingProcessor = class {
            constructor() {
                this.abortController = new AbortController();
                [this.result, this.toolCalls] = [['tool plan', [{}]], ['final stream', []]][streamIndex++];
                this.reasoningHandler = { reasoning: '' };
                this.isFinished = true;
            }
            async generate() { return this.result; }
            async finalizeIntermediaryMessage() {}
            async onFinishStreaming() { host.context.unblockGeneration('normal'); }
            onStopStreaming() { this.abortController.abort(); this.isStopped = true; }
        };
        host.context.isStreamingEnabled = () => true;
        host.context.shouldBufferMainGenerationOutput = async () => false;
        host.context.sendStreamingRequest = jest.fn(async () => () => {});
        Object.assign(host.context.ToolManager, {
            canPerformToolCalls: () => true,
            hasToolCalls: data => data.length > 0,
            invokeFunctionTools: jest.fn(async () => ({ invocations: [{}], stealthCalls: [] })),
            saveFunctionToolInvocations: jest.fn(async () => {}),
        });
        const result = await host.generate();
        expect(String(result)).toBe('final stream');
        expect(result.fromStream).toBe(true);
        expect(host.context.sendStreamingRequest).toHaveBeenCalledTimes(2);
        expect(host.context.ToolManager.invokeFunctionTools.mock.calls[0][1]).toEqual(expect.objectContaining({ isCurrent: expect.any(Function), signal: expect.any(AbortSignal) }));
        expect(host.context.ToolManager.invokeFunctionTools.mock.calls[0][1].isCurrent()).toBe(false);
        expect(host.emitted.mock.calls.filter(([event]) => event === event_types.GENERATION_ENDED)).toHaveLength(1);
    });
});
