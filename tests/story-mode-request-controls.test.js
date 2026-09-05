/* eslint-disable playwright/no-standalone-expect -- Jest test.each tables are not Playwright tests. */
import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { parse } from 'acorn';
import { applyGenerationRequestControls, isGenerationLengthFinish, limitGenerationProse, requestUsesReasoning } from '../public/scripts/generation-request-controls.js';
import { applyClaudeModelParameterConstraints, applyKimiK3ModelParameterConstraints, isKimiK3Model } from '../public/scripts/openai-model-capabilities.js';
import { resolveGenerationOutputBufferState, resolveGenerationUnblockState, resolveStopGenerationState } from '../public/scripts/generation-lifecycle/index.js';
import { event_types } from '../public/scripts/events.js';
import { OVERSWIPE_BEHAVIOR, SWIPE_DIRECTION, SWIPE_SOURCE, SWIPE_STATE } from '../public/scripts/constants.js';

const sources = Object.fromEntries(['script.js', 'scripts/openai.js', 'scripts/reasoning.js', 'scripts/group-chats.js', 'scripts/utils.js', 'scripts/st-context.js', 'scripts/sse-stream.js', 'scripts/textgen-settings.js'].map(file => {
    const source = readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');
    return [file, { source, ast: parse(source, { ecmaVersion: 'latest', sourceType: 'module' }) }];
}));

// Like the host lifecycle tests, run real declarations without booting the browser application.
function load(context, file, names) {
    const { source, ast } = sources[file];
    for (const name of names) {
        const node = ast.body.map(node => node.declaration ?? node)
            .find(node => node.id?.name === name || node.declarations?.some(item => item.id.name === name));
        if (!node) throw new Error(`Missing declaration: ${name}`);
        vm.runInContext(source.slice(node.start, node.end), context);
    }
}

function makeRuntime({ api = 'openai', model = 'gpt-4o', stream = false, buffer = false, composer = '' } = {}) {
    const eventSource = new EventEmitter();
    eventSource.emit = jest.fn(async (name, ...args) => {
        for (const listener of eventSource.rawListeners(name)) await listener(...args);
    });
    eventSource.emitAndWait = eventSource.emit;
    const textarea = { value: composer, dispatchEvent: jest.fn() };
    const element = { isConnected: true, getAttribute: () => '0', querySelector: () => ({ isConnected: true }) };
    const dom = {
        0: textarea,
        val: jest.fn(value => {
            if (value === undefined) return textarea.value;
            textarea.value = value;
            return dom;
        }),
        trigger: jest.fn(),
    };
    const context = vm.createContext({
        AbortController, AbortSignal, Event, MessageEvent, TextDecoderStream, TransformStream, structuredClone,
        console: { log: jest.fn(), info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn(), trace: jest.fn() },
        main_api: api,
        name1: 'User', name2: 'Story', this_chid: 0,
        selected_group: null, is_group_generating: false, is_send_press: false,
        menu_type: 'character_edit', online_status: model,
        characters: [{ name: 'Story', avatar: 'story.png', chat: 'story', data: { extensions: {} } }],
        chat: [{ name: 'Story', mes: 'Existing prose. ', extra: {}, is_user: false }],
        chat_metadata: {}, generationChatFilter: null, pendingGeneratedMessageExtra: null,
        generation_started: null, abortController: null, streamingProcessor: null,
        amount_gen: 8192, max_context: 32768, kobold_horde_model: '',
        openai_messages_count: 1, itemizedPrompts: [], extension_prompts: {},
        power_user: {
            instruct: { enabled: false }, sysprompt: { enabled: false }, context: {},
            reasoning: { prefix: '<think>', suffix: '</think>', separator: '\n', auto_parse: true, add_to_prompts: false },
            auto_continue: { enabled: true, target_length: 1, allow_chat_completions: true },
            streaming_fps: 30, trim_spaces: false, message_token_count_enabled: false,
        },
        oai_settings: {
            chat_completion_source: 'openai', openai_model: model, custom_model: model, openai_max_tokens: 8192,
            stream_openai: stream, show_thoughts: true, reasoning_effort: 'none', continue_postfix: '',
            send_if_empty: '', custom_reasoning_param_format: 'openai', custom_reasoning_param_name: 'reasoning_effort',
        },
        textgen_settings: { type: 'llamacpp' },
        textgen_types: { LLAMACPP: 'llamacpp', OLLAMA: 'ollama', OPENROUTER: 'openrouter' },
        kai_settings: { preset_settings: 'gui' }, kai_flags: {}, horde_settings: {},
        nai_settings: { preset_settings_novel: 'preset', model_novel: 'erato' },
        novelai_settings: [{}], novelai_setting_names: { preset: 0 },
        extension_settings: { note: {} }, extension_prompt_types: { IN_CHAT: 1, IN_PROMPT: 0, BEFORE_PROMPT: 2, NONE: -1 },
        extension_prompt_roles: { SYSTEM: 0 }, depth_prompt_depth_default: 4, depth_prompt_role_default: 'system',
        persona_description_positions: { IN_PROMPT: 0 },
        inject_ids: { DEPTH_PROMPT: 'depth', STORY_STRING: 'story', QUIET_PROMPT: 'quiet' },
        world_info_include_names: true, wi_anchor_position: { before: 0 },
        GENERATION_TYPE_TRIGGERS: ['continue', 'quiet', 'normal'], IGNORE_SYMBOL: 'ignore',
        system_message_types: { NARRATOR: 'narrator', GENERIC: 'generic', EMPTY: 'empty' },
        IN_CHAT_AGENT_TRANSFORM_HISTORY_KEY: 'transforms', IN_CHAT_AGENT_PRE_GENERATION_INTERCEPT_HISTORY_KEY: 'intercepts',
        NOTE_MODULE_NAME: 'note', MIN_LENGTH: 16, selected_custom_endpoint_preset: null,
        regex_placement: { REASONING: 1, USER_INPUT: 2, AI_OUTPUT: 3 },
        CHAT_RENDER_LIFECYCLE_ROUTE: { STREAM_PROGRESS: 'stream' },
        scrollLock: false, scrollLockImmunityUntil: 0,
        document: { querySelector: selector => selector === '#send_textarea' ? textarea : element },
        HTMLElement: class {},
        $: () => dom, chatElement: { find: () => ({}) },
        eventSource, event_types,
        resolveGenerationOutputBufferState, resolveGenerationUnblockState, resolveStopGenerationState,
        applyGenerationRequestControls, isGenerationLengthFinish, limitGenerationProse,
        applyClaudeModelParameterConstraints, applyKimiK3ModelParameterConstraints, isKimiK3Model,
        getLinkApiRequestFormat: () => 'openai',
        getRequestHeaders: () => ({}),
        getCharacterCardFields: () => Object.fromEntries(['description', 'personality', 'persona', 'scenario', 'mesExamples', 'system', 'jailbreak', 'charDepthPrompt', 'creatorNotes'].map(key => [key, ''])),
        getGroupDepthPrompts: () => [], getExtensionPromptRoleByName: () => 0,
        hasCompanionChatHistoryForHiddenHost: () => false,
        selectCompanionChatHistory: () => [], consolidateCompanionChatHistory: () => ({ host: null, entries: [] }),
        resolveRegexScriptsForSnapshot: () => [], shouldRetainContextAtDepth: () => true,
        stripHtmlTagsFromContext: value => value, stripOocBlocksFromContext: value => value,
        getRegexedString: value => value, appendFileContent: async () => '',
        hasPromptPayload: message => Boolean(message.mes || message.extra?.reasoning),
        getMaxPromptTokens: () => 24576, getMaxResponseTokens: () => 8192,
        runGenerationInterceptors: jest.fn(async () => false),
        getGuidanceScale: () => null, parseMesExamples: () => [],
        getWorldInfoPrompt: async () => ({ worldInfoString: '', worldInfoBefore: '', worldInfoAfter: '', worldInfoExamples: [], worldInfoDepth: [] }),
        buildWorldInfoScanChat: messages => messages,
        getExtensionPrompt: async () => '', renderStoryString: () => '', doChatInject: async () => [],
        formatMessageHistoryItem: message => message.mes + '\n',
        getTokenCountAsync: jest.fn(async () => 0),
        getTokenCount: jest.fn(() => { throw new Error('Synchronous token counting is forbidden in controlled streams'); }),
        getCustomStoppingStrings: () => [], getStoppingStrings: () => [], getGroupNames: () => [],
        substituteParams: value => value, baseChatReplace: value => value,
        extractMessageBias: () => '', getEffectivePromptBias: () => '',
        shiftDownByOne: value => value - 1, shiftUpByOne: value => value + 1,
        adjustNovelInstructionPrompt: value => value,
        getAllExtensionPrompts: async () => '', getFriendlyTokenizerName: () => ({ tokenizerName: 'test' }),
        getPresetManager: () => ({ getSelectedPresetName: () => 'preset' }),
        isStreamingEnabled: () => stream, isHordeGenerationNotAllowed: () => false, pingServer: async () => true,
        hasPendingFileAttachment: () => false, shouldBatchMobileChatRendering: () => false,
        prepareOpenAIMessages: async ({ messages }) => [messages, false],
        setOpenAIMessages: messages => messages.map(message => ({ role: message.is_user ? 'user' : 'assistant', content: message.mes })),
        setOpenAIMessageExamples: () => [],
        createRawPrompt: (prompt, rawApi) => rawApi === 'openai' ? [{ role: 'user', content: prompt }] : prompt,
        getTextGenGenerationData: jest.fn(async (prompt, maxTokens) => {
            const data = { prompt, model, max_new_tokens: maxTokens, max_tokens: maxTokens, n_predict: maxTokens, num_predict: maxTokens, include_reasoning: true };
            await eventSource.emit(event_types.TEXT_COMPLETION_SETTINGS_READY, data);
            return data;
        }),
        getNovelGenerationData: (prompt, settings, maxLength) => ({ input: prompt, model: 'erato', max_length: maxLength }),
        cleanUpMessage: ({ getMessage }) => getMessage,
        extractMultiSwipes: () => [], extractTitleFromData: () => '', extractImagesFromData: () => [], extractReasoningSignatureFromData: () => null,
        getGeneratingApi: () => api, getGeneratingModel: () => model, getCurrentReasoningEffort: () => '',
        getMessageTimeStamp: () => '2026-09-05',
        updateMessageTokenAccounting: async message => ({ outputTokens: 0, reasoningTokens: message.extra?.reasoning_tokens ?? 0 }),
        saveChatConditional: jest.fn(async () => true),
        getPositiveTokenCount: value => Number(value) || 0,
        formatGenerationTimer: () => ({}), messageFormatting: value => value,
        balanceStreamingMarkdown: value => value,
        Stopwatch: class { async tick(callback) { await callback(); } },
        getStreamingUpdateInterval: value => value,
        delay: async () => {},
        toastr: { error: jest.fn(), warning: jest.fn() }, t: strings => strings.join(''),
        REVERSE_PROXY_SUPPORTED_SOURCES: [], openai_max_stop_strings: 4,
        ToolManager: {
            RECURSE_LIMIT: 5, isToolCallingSupported: () => false, canPerformToolCalls: () => false,
            hasToolCalls: () => false, registerFunctionToolsOpenAI: async () => {},
            invokeFunctionTools: async () => ({ invocations: [], stealthCalls: [] }),
            parseToolCalls: () => {}, saveFunctionToolInvocations: jest.fn(async () => {}),
        },
    });
    for (const name of ['unshallowCharacter', 'removeDepthPrompts', 'setExtensionPrompt', 'deleteItemizedPromptForMessage', 'removeLastMessage', 'requestMobileChatBottomPin', 'hideSwipeButtons', 'showSwipeButtons', 'setFloatingPrompt', 'flushWIInjections', 'flushEphemeralStoppingStrings', 'addPersonaDescriptionExtensionPrompt', 'setInContextMessages', 'setGenerationProgress', 'showStopButton', 'parseAndSaveLogprobs', 'playMessageSound', 'processImageAttachment', 'addOneMessage', 'statMesProcess', 'saveLogprobsForActiveMessage', 'appendMediaToMessage', 'addCopyToCodeBlocks', 'updateSwipeCounter', 'applyStreamingVisibleWrite', 'scrollStartedStreamingMessageThroughLifecycle', 'scrollChatToBottom', 'checkQuotaError', 'checkModerationError', 'tryParseStreamingError']) {
        context[name] = jest.fn();
    }
    for (const name of ['shouldReduceStreamingDomWork', 'shouldGuardMobileChatScroll', 'shouldPinMobileChatToBottom', 'isAndroidStreamingPlatform', 'shouldUsePlainTextStreamingPreview', 'isChatRenderLifecycleRolloutEnabled', 'isHiddenReasoningModel']) {
        context[name] = () => false;
    }
    context.activateSendButtons = jest.fn(() => { context.is_send_press = false; });
    context.textgenerationwebui_settings = context.textgen_settings;
    context.deactivateSendButtons = jest.fn(() => { context.is_send_press = true; });
    context.executeSlashCommandsOnChatInput = jest.fn();
    context.sendMessageAsUser = jest.fn(async text => { context.chat.push({ mes: text, is_user: true, extra: {} }); });
    context.sendSystemMessage = jest.fn();
    context.parseChatCompletionLogprobs = () => null;

    load(context, 'scripts/utils.js', ['escapeRegex', 'trimSpaces']);
    load(context, 'scripts/openai.js', ['chat_completion_sources', 'reasoning_effort_types', 'verbosity_levels', 'getReasoningEffort', 'getVerbosity', 'shouldRequestReasoning', 'getChatCompletionModel', 'createGenerationParameters', 'sendOpenAIRequest', 'getStreamingReply']);
    load(context, 'scripts/sse-stream.js', ['EventSourceStream']);
    context.getEventSourceStream = vm.runInContext('() => new EventSourceStream()', context);
    context.appendAutoAppendReasoningInstruction = messages => messages;
    load(context, 'scripts/reasoning.js', ['ReasoningType', 'ReasoningState', 'PromptReasoning', 'ReasoningHandler', 'parseReasoningFromString', 'extractReasoningFromData']);
    context.getReasoningParseTemplates = () => [context.power_user.reasoning];
    vm.runInContext('ReasoningHandler.prototype.updateDom = () => {};', context);
    load(context, 'script.js', ['Generate', 'StreamingProcessor', 'sendGenerationRequest', 'sendStreamingRequest', 'getGenerateUrl', 'saveReply', 'getNextMessageId', 'getBiasStrings', 'processCommands', 'extractMessageFromData', 'normalizeContentText', 'stringifyUnknown', 'shouldBufferMainGenerationOutput', 'applyMainGenerationOutputInterceptors', 'unblockGeneration', 'clearStreamingProcessorIfCurrent', 'shouldAutoContinue', 'triggerAutoContinue', 'syncMesToSwipe', 'stopGeneration', 'generateRaw', 'generateRawData', 'generateQuietPrompt', 'TempResponseLength', 'addChatsPreamble', 'addChatsSeparator', 'consumePendingGeneratedMessageExtra']);
    context.removeReasoningFromString = text => context.parseReasoningFromString(text)?.content ?? text;

    const requests = [];
    context.reply = 'New prose. ';
    context.reasoning = '';
    context.chunks = [];
    context.fetchResumable = jest.fn(async (url, init) => {
        const body = JSON.parse(init.body);
        requests.push({ url, body, signal: init.signal });
        return { ok: true, json: async () => {
            if (api === 'openai') return { choices: [{ message: { content: context.reply, reasoning_content: context.reasoning } }] };
            if (api === 'kobold') return { results: [{ text: context.reply }] };
            if (api === 'novel') return { output: context.reply };
            return { choices: [{ text: context.reply }], thinking: context.reasoning };
        } };
    });
    context.generateHorde = jest.fn(async (prompt, data, signal) => {
        requests.push({ body: data, signal });
        return { text: context.reply };
    });
    if (stream) {
        // Mock only the provider transport; execute the actual stream processor and finalisation.
        const transport = jest.fn(async (data, signal) => {
            requests.push({ body: data, signal });
            return async function* () {
                for (const chunk of context.chunks) {
                    if (signal.aborted) throw signal.reason;
                    yield { swipes: [], toolCalls: [], state: {}, ...chunk };
                }
            };
        });
        context.generateTextGenWithStreaming = transport;
        context.generateKoboldWithStreaming = transport;
        context.generateNovelWithStreaming = transport;
    }
    if (buffer) eventSource.on(event_types.GENERATION_OUTPUT_BUFFERING_DECISION, data => { data.hasPostMainInterceptors = true; });
    return { context, requests, textarea, dom, eventSource, StreamingProcessor: vm.runInContext('StreamingProcessor', context) };
}

describe('request-local output controls', () => {
    test.each([undefined, 0, -1, NaN, Infinity, '160'])('leaves presets alone for an inactive limit: %s', maxOutputTokens => {
        const preset = { max_tokens: 8192, max_new_tokens: 8192 };
        expect(applyGenerationRequestControls(preset, { maxOutputTokens })).toBe(preset);
    });

    test('caps all consumed response fields, not context or thinking fields, without mutating the input', () => {
        const preset = { max_tokens: 8192, max_completion_tokens: 8192, max_new_tokens: 8192, max_length: 8192, n_predict: 8192, num_predict: -1, options: { num_predict: 8192 }, min_tokens: 300, max_context_length: 32768, include_reasoning: true, thinking: { type: 'disabled' } };
        const limited = applyGenerationRequestControls(preset, { maxOutputTokens: 160 });
        for (const field of ['max_tokens', 'max_completion_tokens', 'max_new_tokens', 'max_length', 'n_predict', 'num_predict', 'min_tokens']) expect(limited[field]).toBe(160);
        expect(limited.options.num_predict).toBe(160);
        expect(limited.max_context_length).toBe(32768);
        expect(limited.thinking).toEqual({ type: 'disabled' });
        expect(preset.max_tokens).toBe(8192);
        expect(preset.options.num_predict).toBe(8192);
    });

    test.each([
        { model: 'gpt-4o', include_reasoning: true },
        { model: 'gpt-4o', include_reasoning: true, reasoning_effort: 'high' },
        { model: 'gpt-5.1', max_completion_tokens: 8192, reasoning_effort: 'none' },
        { model: 'qwen3', thinking: { type: 'disabled', budget_tokens: 4096 } },
        { model: 'qwen3', think: false },
        { model: 'grok-4-fast-non-reasoning' },
        { model: 'ordinary', max_completion_tokens: 8192 },
    ])('does not invent a reasoning allowance for %j', data => {
        expect(requestUsesReasoning(data)).toBe(false);
        expect(applyGenerationRequestControls({ max_tokens: 8192, ...data }, { maxOutputTokens: 160 }).max_tokens).toBe(160);
    });

    test.each([
        { model: 'openai/o3', max_completion_tokens: 8192 },
        { model: 'gpt-5.1', reasoning_effort: 'high' },
        { model: 'gpt-6-astra' },
        { model: 'deepseek-reasoner', reasoning_effort: 'none' },
        { model: 'deepseek-ai/DeepSeek-R1' },
        { model: 'moonshot/kimi-k3' },
        { model: 'moonshot/kimi-k2-thinking', reasoning_effort: 'none' },
        { model: 'gemini-2.0-flash-thinking-exp', reasoning_effort: 'none' },
        { model: 'qwen3-32b' },
        { model: 'ordinary', thinking: { type: 'enabled', budget_tokens: 4096 } },
        { model: 'ordinary', thinking: { type: 'adaptive' } },
        { model: 'ordinary', reasoning: { max_tokens: 4096 } },
    ])('keeps the total reasoning allowance for %j', data => {
        const preset = { max_tokens: 8192, ...data };
        expect(requestUsesReasoning(preset)).toBe(true);
        expect(applyGenerationRequestControls(preset, { maxOutputTokens: 160 })).toBe(preset);
        expect(applyGenerationRequestControls(preset, { responseLength: 64, preserveReasoningBudget: true })).toBe(preset);
    });

    test('ordinary helper responseLength can exceed the preset while a prose cap never raises it', () => {
        const preset = { model: 'gpt-4o', max_tokens: 128, include_reasoning: true };
        expect(applyGenerationRequestControls(preset, { responseLength: 1024, preserveReasoningBudget: true }).max_tokens).toBe(1024);
        expect(applyGenerationRequestControls(preset, { maxOutputTokens: 160 }).max_tokens).toBe(128);
    });

    test('uses known local or Horde models when the request has no model field', () => {
        const preset = { max_length: 8192 };
        expect(applyGenerationRequestControls(preset, { maxOutputTokens: 160, model: 'deepseek-r1' })).toBe(preset);
        expect(applyGenerationRequestControls(preset, { maxOutputTokens: 160, model: ['ordinary', 'deepseek-r1'] })).toBe(preset);
        expect(applyGenerationRequestControls({ ...preset, model: 'ordinary' }, { maxOutputTokens: 160, model: 'deepseek-r1' }).max_length).toBe(160);
    });

    test('separates completed, partial and multiple inline thinking blocks', () => {
        const { context } = makeRuntime();
        const limit = text => limitGenerationProse(text, 2, context.power_user.reasoning, '', true);
        expect(limit('<think>' + 'reasoning '.repeat(100))).toMatchObject({ text: '', limited: false });
        expect(limit('<thi')).toMatchObject({ text: '', limited: false });
        expect(limit('<thinking>one</thinking>abcd<think>two</think>efgh-more')).toEqual({ text: 'abcdefgh', reasoning: 'one\n\ntwo', limited: true });
        expect(limit('abc\uD83D\uDE00xxxx')).toMatchObject({ text: 'abc\uD83D\uDE00xxx', limited: true });
        expect(limitGenerationProse('abc\uD83D\uDE00', 1, context.power_user.reasoning).text).toBe('abc');
    });

    test('advertises the exact integration capability on the context object', () => {
        expect(sources['scripts/st-context.js'].source).toContain('generationSupportsRequestControls: true');
    });

    test('length metadata ignores absent or malformed choices and secondary swipes', () => {
        for (const data of [null, {}, { choices: {} }, { choices: [null] }, { choices: [{ index: 1, finish_reason: 'length' }] }]) {
            expect(isGenerationLengthFinish(data)).toBe(false);
        }
        expect(isGenerationLengthFinish({ delta: { stop_reason: 'max_tokens' } })).toBe(true);
        expect(isGenerationLengthFinish({ candidates: [{ finishReason: 'MAX_TOKENS' }] })).toBe(true);
    });
});

describe('owned host generation flow', () => {
    test('suppressed continuation ignores draft commands and extends the same assistant block', async () => {
        const { context, textarea, requests } = makeRuntime({ composer: '/delete everything' });
        const original = context.chat[0];
        await context.Generate('continue', { suppressUserMessage: true, suppressAutoContinue: true, maxOutputTokens: 160 });
        expect(context.executeSlashCommandsOnChatInput).not.toHaveBeenCalled();
        expect(context.sendMessageAsUser).not.toHaveBeenCalled();
        expect(context.removeLastMessage).not.toHaveBeenCalled();
        expect(context.chat).toHaveLength(1);
        expect(context.chat[0]).toBe(original);
        expect(original.mes).toBe('Existing prose. New prose. ');
        expect(textarea.value).toBe('/delete everything');
        expect(requests[0].body.max_tokens).toBe(160);
        expect(context.power_user.auto_continue.enabled).toBe(true);
        expect(context.oai_settings.openai_max_tokens).toBe(8192);
        expect(context.getTokenCount).not.toHaveBeenCalled();
    });

    test('preserves composer consumption and slash-command execution for default callers', async () => {
        const command = makeRuntime({ composer: '/echo hello' });
        await command.context.Generate('continue');
        expect(command.context.executeSlashCommandsOnChatInput).toHaveBeenCalledTimes(1);
        expect(command.requests).toHaveLength(0);
        const draft = makeRuntime({ composer: 'A draft.' });
        await draft.context.Generate('continue', { suppressAutoContinue: true });
        expect(draft.context.sendMessageAsUser).toHaveBeenCalledWith('A draft.', '');
        expect(draft.textarea.value).toBe('');
    });

    test('suppression does not delete the preceding assistant message or consume attachments on a normal request', async () => {
        const { context, textarea } = makeRuntime({ composer: '/echo untouched' });
        context.hasPendingFileAttachment = () => true;
        const original = context.chat[0];
        await context.Generate('normal', { suppressUserMessage: true, suppressAutoContinue: true, maxOutputTokens: 160 });
        expect(context.chat).toHaveLength(2);
        expect(context.chat[0]).toBe(original);
        expect(context.removeLastMessage).not.toHaveBeenCalled();
        expect(context.sendMessageAsUser).not.toHaveBeenCalled();
        expect(context.executeSlashCommandsOnChatInput).not.toHaveBeenCalled();
        expect(textarea.value).toBe('/echo untouched');
    });

    test.each(['openai', 'textgenerationwebui', 'kobold', 'koboldhorde', 'novel'])('caps the owned %s request after a nested quiet call', async api => {
        const { context, requests, eventSource } = makeRuntime({ api });
        let nested = false;
        eventSource.on(event_types.GENERATE_AFTER_DATA, async () => {
            if (nested) return;
            nested = true;
            await context.generateQuietPrompt({ quietPrompt: 'helper', responseLength: 64, preserveReasoningBudget: true });
        });
        await context.Generate('continue', { suppressUserMessage: true, suppressAutoContinue: true, maxOutputTokens: 160 });
        const field = ['kobold', 'koboldhorde', 'novel'].includes(api) ? 'max_length' : 'max_tokens';
        expect(requests.map(request => request.body[field])).toEqual([64, 160]);
        expect(context.amount_gen).toBe(8192);
        expect(context.oai_settings.openai_max_tokens).toBe(8192);
    });

    test('a nested SETTINGS_READY helper cannot take the owning OpenAI cap', async () => {
        const { context, requests, eventSource } = makeRuntime();
        let nested = false;
        eventSource.on(event_types.CHAT_COMPLETION_SETTINGS_READY, async () => {
            if (nested) return;
            nested = true;
            await context.generateRaw({ prompt: 'helper', responseLength: 64, preserveReasoningBudget: true });
        });
        await context.Generate('continue', { suppressUserMessage: true, suppressAutoContinue: true, maxOutputTokens: 160 });
        expect(requests.map(request => request.body.max_tokens)).toEqual([64, 160]);
    });

    test('hands Custom controls to the final server payload without changing the preset allowance', async () => {
        const { context, requests } = makeRuntime();
        context.oai_settings.chat_completion_source = 'custom';
        await context.Generate('continue', { suppressUserMessage: true, suppressAutoContinue: true, maxOutputTokens: 160 });
        await context.generateRaw({ prompt: 'helper', responseLength: 64, preserveReasoningBudget: true });
        await context.generateRaw({ prompt: 'ordinary helper' });
        expect(requests[0].body.request_controls).toEqual({ maxOutputTokens: 160, responseLength: null, preserveReasoningBudget: false });
        expect(requests[1].body.request_controls).toEqual({ maxOutputTokens: 0, responseLength: 64, preserveReasoningBudget: true });
        expect(requests[2].body.request_controls).toBeUndefined();
        expect(requests.map(request => request.body.max_tokens)).toEqual([8192, 8192, 8192]);
    });

    test('caps max_completion_tokens on a real disabled-reasoning OpenAI payload', async () => {
        const { context, requests } = makeRuntime({ model: 'gpt-5.1' });
        await context.Generate('continue', { suppressUserMessage: true, suppressAutoContinue: true, maxOutputTokens: 160 });
        expect(requests[0].body.max_completion_tokens).toBe(160);
        expect(requests[0].body.max_tokens).toBeUndefined();
        expect(requests[0].body.reasoning_effort).toBe('none');
    });

    test('forwards controls through the group wrapper without consuming a suppressed draft or auto-continuing', async () => {
        const { context, requests, textarea, eventSource } = makeRuntime({ composer: '/echo draft' });
        Object.assign(context, {
            selected_group: 'group', menu_type: 'group_edit',
            groups: [{ id: 'group', members: ['story.png'], disabled_members: [] }],
            group_generation_id: null, groupChatQueueOrder: new Map(),
            group_activation_strategy: { NATURAL: 0, LIST: 1, MANUAL: 2, POOLED: 3 },
            getGroupEnabledMembers: group => group.members,
            getSelectedGroupSpeakerChid: () => -1,
            findDirectlyAddressedMember: jest.fn(() => -1),
            isAddressedToEntireGroup: () => false,
            limitGroupSpeakersForControl: members => members,
            buildContextAwareGroupPrompt: () => '',
            runWithGroupMemberModelOverride: (group, avatar, task) => task(),
            setCharacterId: id => { context.this_chid = id; },
            setCharacterName: name => { context.name2 = name; },
            setSendButtonState: jest.fn(), setGroupTypingIndicator: jest.fn(),
            unshallowGroupMembers: jest.fn(),
        });
        context.chat[0].original_avatar = 'story.png';
        load(context, 'scripts/group-chats.js', ['generateGroupWrapper', 'activateSwipe']);
        const starts = [];
        eventSource.on(event_types.GENERATION_STARTED, (type, options) => starts.push({ type, options }));
        await context.Generate('continue', { suppressUserMessage: true, suppressAutoContinue: true, maxOutputTokens: 160 });
        expect(requests).toHaveLength(1);
        expect(requests[0].body.max_tokens).toBe(160);
        expect(starts).toHaveLength(2);
        expect(starts[1].options).toMatchObject({ suppressUserMessage: true, suppressAutoContinue: true, maxOutputTokens: 160 });
        expect(context.findDirectlyAddressedMember).toHaveBeenCalledWith(context.groups[0], 'Existing prose. ');
        expect(context.sendMessageAsUser).not.toHaveBeenCalled();
        expect(context.executeSlashCommandsOnChatInput).not.toHaveBeenCalled();
        expect(textarea.value).toBe('/echo draft');
        expect(context.getTokenCount).not.toHaveBeenCalled();
    });

    test.each([false, true])('tool successors retain controls but tool helpers do not (stream: %s)', async stream => {
        const { context, requests } = makeRuntime({ api: stream ? 'textgenerationwebui' : 'openai', stream });
        context.ToolManager.canPerformToolCalls = () => true;
        context.ToolManager.hasToolCalls = jest.fn().mockReturnValueOnce(true).mockReturnValue(false);
        context.chunks = [{ text: 'tool reply', toolCalls: [{ id: 'tool' }] }];
        context.ToolManager.invokeFunctionTools = jest.fn(async () => ({ invocations: [], stealthCalls: [] })).mockImplementationOnce(async () => {
            await context.generateRaw({ prompt: 'tool helper', responseLength: 64, preserveReasoningBudget: true });
            context.chunks = [{ text: 'successor' }];
            return { invocations: [{ id: 'tool' }], stealthCalls: [] };
        });
        await context.Generate('continue', { suppressUserMessage: true, suppressAutoContinue: true, maxOutputTokens: 160 });
        expect(requests.map(request => request.body.max_tokens)).toEqual([160, 64, 160]);
        expect(context.ToolManager.saveFunctionToolInvocations).toHaveBeenCalledTimes(1);
        expect(context.getTokenCount).not.toHaveBeenCalled();
        expect(context.power_user.auto_continue.enabled).toBe(true);
    });

    test.each(['generateRaw', 'generateQuietPrompt'])('%s preserves the original reasoning budget before any preset override', async method => {
        for (const model of ['gpt-4o', 'o3']) {
            const { context, requests } = makeRuntime({ model });
            await context[method]({ prompt: 'selection', quietPrompt: 'selection', responseLength: 64, preserveReasoningBudget: true });
            expect(requests[0].body.max_tokens ?? requests[0].body.max_completion_tokens).toBe(model === 'o3' ? 8192 : 64);
            expect(context.oai_settings.openai_max_tokens).toBe(8192);
        }
    });

    test.each(['generateRaw', 'generateQuietPrompt'])('%s keeps the legacy responseLength override unless preservation is requested', async method => {
        const { context, requests } = makeRuntime({ model: 'o3' });
        await context[method]({ prompt: 'selection', quietPrompt: 'selection', responseLength: 64 });
        expect(requests[0].body.max_completion_tokens).toBe(64);
        expect(context.oai_settings.openai_max_tokens).toBe(8192);
    });

    test.each(['generateRaw', 'generateQuietPrompt'])('%s preserves the exact real text-completion reasoning payload, not a backend default', async method => {
        const { context, requests } = makeRuntime({ api: 'textgenerationwebui', model: 'deepseek-r1' });
        load(context, 'scripts/textgen-settings.js', ['textgen_types', 'getTextGenModel', 'createTextGenGenerationData', 'getTextGenGenerationData', 'replaceMacrosInList']);
        Object.assign(context, vm.runInContext('textgen_types', context), {
            isDynamicTemperatureSupported: () => false,
            getCustomTokenBans: () => ({ banned_tokens: [], banned_strings: [] }),
            isObject: value => value !== null && typeof value === 'object',
            toIntArray: () => [], shouldUseLocalPromptCache: () => false,
            getTextGenServer: () => 'http://example.invalid',
        });
        Object.assign(context.textgenerationwebui_settings, { llamacpp_model: 'deepseek-r1', temp: 0.6, min_length: 128, top_p: 0.9, include_reasoning: true });
        const settings = structuredClone(context.textgenerationwebui_settings);
        await context[method]({ prompt: 'helper', quietPrompt: 'helper' });
        await context[method]({ prompt: 'helper', quietPrompt: 'helper', responseLength: 64, preserveReasoningBudget: true });
        expect(requests[1].body).toEqual(requests[0].body);
        expect(requests[1].body).toMatchObject({ max_tokens: 8192, max_new_tokens: 8192, n_predict: 8192, num_predict: 8192 });
        expect(context.textgenerationwebui_settings).toEqual(settings);
        expect(context.amount_gen).toBe(8192);
    });

    test('reserves a local prompt budget without mutating the OpenAI preset', async () => {
        const { context } = makeRuntime();
        const setTokenBudget = jest.fn();
        context.ChatCompletion = class {
            setTokenBudget = setTokenBudget;
            buildRuntimeAgentMessages() {}
            getChat() { return []; }
        };
        context.promptManager = {
            serviceSettings: { openai_max_context: 32768, openai_max_tokens: 8192 },
            setChatCompletion: jest.fn(), render: jest.fn(), tokenHandler: { counts: false },
        };
        context.preparePromptsForChatCompletion = async () => [];
        context.populateChatCompletion = async () => {};
        context.shouldCheckPostInterceptChatBudget = () => false;
        load(context, 'scripts/openai.js', ['prepareOpenAIMessages']);
        await context.prepareOpenAIMessages({ messages: [], responseLength: 1024 }, false);
        expect(setTokenBudget).toHaveBeenCalledWith(32768, 1024);
        expect(context.promptManager.serviceSettings.openai_max_tokens).toBe(8192);
    });

    test('auto-continue forwards owned options through its existing click handler', () => {
        const { context, dom } = makeRuntime();
        const controls = { maxOutputTokens: 160, suppressUserMessage: true };
        context.power_user.auto_continue.target_length = 100;
        context.getTokenCount = () => 1;
        context.triggerAutoContinue('enough prose', false, controls);
        expect(dom.trigger).toHaveBeenCalledWith('click', { generationOptions: controls });
        expect(sources['script.js'].source).toContain('...customData?.generationOptions,');
        expect(context.power_user.auto_continue.enabled).toBe(true);
    });

    test('the context swipe entry point forwards retry controls into the real successor request', async () => {
        const { context, requests, textarea, eventSource } = makeRuntime({ composer: '/echo untouched' });
        const messageDom = { 0: { scrollHeight: 100 }, length: 1 };
        for (const method of ['children', 'filter', 'find', 'css', 'animate', 'html', 'text']) messageDom[method] = () => messageDom;
        messageDom.width = () => 100;
        messageDom.scrollTop = () => 0;
        messageDom.prop = () => 1000;
        messageDom.outerHeight = () => 100;
        Object.assign(context, {
            OVERSWIPE_BEHAVIOR, SWIPE_DIRECTION, SWIPE_SOURCE, SWIPE_STATE,
            chatElement: messageDom, swipeState: SWIPE_STATE.NONE, this_edit_mes_id: -1,
            animation_duration: 0, cancelDebouncedChatSave: jest.fn(), saveChatDebounced: jest.fn(),
            getOverswipeBehavior: () => OVERSWIPE_BEHAVIOR.REGENERATE,
            updateReasoningUI: jest.fn(), settleSwipeReplacementAnchor: jest.fn(),
            clamp: (value, min, max) => Math.min(max, Math.max(min, value)),
        });
        context.document.body = { dataset: {} };
        load(context, 'script.js', ['swipe']);
        // getContext exposes this same function as swipe.to, not the legacy right wrapper.
        const contextSwipe = { to: context.swipe };
        const controls = { suppressUserMessage: true, suppressAutoContinue: true, maxOutputTokens: 2 };
        const starts = [];
        eventSource.on(event_types.GENERATION_STARTED, (type, options) => starts.push({ type, options }));
        context.reply = 'abcdefgh-overrun';
        await contextSwipe.to(null, 'right', { source: SWIPE_SOURCE.SLASH_COMMAND, forceDuration: 0, generationOptions: controls });
        expect(requests).toHaveLength(1);
        expect(requests[0].body.max_tokens).toBe(2);
        expect(starts).toEqual([{ type: 'swipe', options: expect.objectContaining(controls) }]);
        expect(context.chat[0].mes).toBe('abcdefgh');
        expect(context.chat[0].swipes).toEqual(['Existing prose. ', 'abcdefgh']);
        expect(textarea.value).toBe('/echo untouched');
        expect(context.swipeState).toBe(SWIPE_STATE.NONE);
    });

    test('separates and locally caps non-streamed reasoning without cancelling or losing the existing block', async () => {
        const { context, requests, eventSource } = makeRuntime({ model: 'o3' });
        context.reply = '<think>' + 'reasoning '.repeat(200) + '</think>' + 'p'.repeat(900);
        const received = jest.fn();
        eventSource.on(event_types.MESSAGE_RECEIVED, received);
        const result = await context.Generate('continue', { suppressUserMessage: true, suppressAutoContinue: true, maxOutputTokens: 160 });
        expect(requests[0].body.max_completion_tokens).toBe(8192);
        expect(context.chat[0].mes).toBe('Existing prose. ' + 'p'.repeat(640));
        expect(context.chat[0].extra.reasoning).toBe('reasoning '.repeat(200));
        expect(result.finishReason).toBe('length');
        expect(context.abortController.signal.aborted).toBe(false);
        expect(received).toHaveBeenCalledTimes(1);
    });

    test('never treats a Gemini thinking-only response as prose through the extraction fallback', async () => {
        const { context } = makeRuntime();
        context.oai_settings.chat_completion_source = 'makersuite';
        context.oai_settings.google_model = 'gemini-2.5-flash';
        context.fetchResumable.mockResolvedValue({ ok: true, json: async () => ({
            choices: [{ message: { content: '' } }],
            responseContent: { parts: [{ thought: true, text: 'thinking '.repeat(1000) }] },
        }) });
        const result = await context.Generate('continue', { suppressUserMessage: true, suppressAutoContinue: true, maxOutputTokens: 2 });
        expect(context.chat[0].mes).toBe('Existing prose. ');
        expect(context.chat[0].extra.reasoning).toBe('thinking '.repeat(1000));
        expect(context.toastr.warning).toHaveBeenCalledTimes(1);
        expect(result.finishReason).toBeNull();
        expect(context.extractMessageFromData({ responseContent: { parts: [null, { thought: true, text: 'hidden' }, { text: 'prose' }] } })).toBe('prose');
        expect(context.extractMessageFromData({ responseContent: { parts: 'plain fallback' } })).toBe('plain fallback');
    });

    test.each(['nonstream', 'stream', 'buffer'])('retains the accepted partial sentence on length completion: %s', async mode => {
        const { context } = makeRuntime({ api: 'textgenerationwebui', model: 'deepseek-r1', stream: mode !== 'nonstream', buffer: mode === 'buffer' });
        context.power_user.trim_sentences = true;
        context.reply = 'abcdefgh-overrun';
        context.chunks = [{ text: context.reply }];
        load(context, 'scripts/utils.js', ['trimToEndSentence']);
        load(context, 'script.js', ['cleanUpMessage']);
        const result = await context.Generate('continue', { suppressUserMessage: true, suppressAutoContinue: true, maxOutputTokens: 2 });
        expect(context.chat[0].mes).toBe('Existing prose. abcdefgh');
        expect(result.finishReason).toBe('length');
    });

    test.each(['nonstream', 'stream', 'buffer'])('continues an incomplete thinking prefix without consuming the new prose: %s', async mode => {
        const { context } = makeRuntime({ api: 'textgenerationwebui', model: 'deepseek-r1', stream: mode !== 'nonstream', buffer: mode === 'buffer' });
        context.chat[0].mes = '';
        context.chat[0].extra.reasoning = 'prior ';
        context.reply = 'more</think>abcdefgh-overrun';
        context.chunks = [{ text: context.reply }];
        const result = await context.Generate('continue', { suppressUserMessage: true, suppressAutoContinue: true, maxOutputTokens: 2 });
        expect(context.chat[0].mes).toBe('abcdefgh');
        expect(context.chat[0].extra.reasoning).toBe('prior more');
        expect(result.finishReason).toBe('length');
    });

    test.each(['nonstream', 'stream', 'buffer'])('keeps all reasoning continuation text when whitespace trimming is enabled: %s', async mode => {
        const { context } = makeRuntime({ api: 'textgenerationwebui', model: 'deepseek-r1', stream: mode !== 'nonstream', buffer: mode === 'buffer' });
        context.power_user.trim_spaces = true;
        context.chat[0].mes = '';
        context.chat[0].extra.reasoning = ' prior ';
        context.reply = 'more</think>abcdefgh-overrun';
        context.chunks = [{ text: context.reply }];
        await context.Generate('continue', { suppressUserMessage: true, suppressAutoContinue: true, maxOutputTokens: 2 });
        expect(context.chat[0].mes).toBe('abcdefgh');
        expect(context.chat[0].extra.reasoning.trim()).toBe('prior more');
    });

    test.each(['nonstream', 'stream', 'buffer'])('retains a final literal less-than sign rather than dropping a suspected thinking tag: %s', async mode => {
        const { context } = makeRuntime({ api: 'textgenerationwebui', stream: mode !== 'nonstream', buffer: mode === 'buffer' });
        context.reply = 'a <';
        context.chunks = [{ text: context.reply }];
        const result = await context.Generate('continue', { suppressUserMessage: true, suppressAutoContinue: true, maxOutputTokens: 2 });
        expect(context.chat[0].mes).toBe('Existing prose. a <');
        expect(result.finishReason).toBeNull();
    });

    test.each(['nonstream', 'stream', 'buffer'])('honours the provider length ending before the character estimate: %s', async mode => {
        const { context, eventSource } = makeRuntime({ stream: mode !== 'nonstream', buffer: mode === 'buffer' });
        context.power_user.trim_sentences = true;
        load(context, 'scripts/utils.js', ['trimToEndSentence']);
        load(context, 'script.js', ['cleanUpMessage']);
        context.fetchResumable.mockImplementation(async () => mode === 'nonstream'
            ? new Response(JSON.stringify({ choices: [{ message: { content: 'partial' }, finish_reason: 'length' }] }))
            : new Response('data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n'));
        const received = [];
        eventSource.on(event_types.MESSAGE_RECEIVED, () => received.push(context.chat[0].mes));
        const result = await context.Generate('continue', { suppressUserMessage: true, suppressAutoContinue: true, maxOutputTokens: 160 });
        expect(result.finishReason).toBe('length');
        expect(context.chat[0].mes).toBe('Existing prose. partial');
        expect(received).toEqual(['Existing prose. partial']);
        expect(eventSource.emit.mock.calls.some(([name]) => name === event_types.GENERATION_STOPPED)).toBe(false);
    });

    test.each([false, true])('streamed cap completes once, including buffering: %s', async buffer => {
        const { context, requests, eventSource, StreamingProcessor } = makeRuntime({ api: 'textgenerationwebui', model: 'deepseek-r1', stream: true, buffer });
        context.chunks = [
            { text: '', state: { reasoning: 'hidden '.repeat(400) } },
            { text: 'abcd', state: { reasoning: 'hidden '.repeat(400) } },
            { text: 'abcd', state: { reasoning: 'hidden '.repeat(500) } },
            { text: 'abcdefgh-overrun', state: { reasoning: 'hidden '.repeat(500) } },
            { text: 'must not be accepted' },
        ];
        const finalise = jest.spyOn(StreamingProcessor.prototype, 'onFinishStreaming');
        let processor;
        const postAgent = jest.fn();
        eventSource.on(event_types.MESSAGE_RECEIVED, () => {
            processor ??= context.streamingProcessor;
            if (!processor.isStopped && !processor.abortController.signal.aborted) postAgent(context.chat[0].mes);
        });
        const intercepted = [];
        eventSource.on(event_types.MAIN_GENERATION_OUTPUT_READY, data => { intercepted.push(data.text); });
        const result = await context.Generate('continue', { suppressUserMessage: true, suppressAutoContinue: true, maxOutputTokens: 2 });
        expect(requests[0].body.max_tokens).toBe(8192);
        expect(requests[0].signal.aborted).toBe(true);
        expect(processor.abortController.signal.aborted).toBe(false);
        expect(processor.isCancelled).toBe(false);
        expect(processor.isStopped).toBe(false);
        expect(processor.isFinished).toBe(true);
        expect(result.finishReason).toBe('length');
        expect(context.chat[0].mes).toBe('Existing prose. abcdefgh');
        expect(postAgent).toHaveBeenCalledTimes(1);
        expect(finalise).toHaveBeenCalledTimes(buffer ? 0 : 1);
        expect(intercepted).toEqual(buffer ? ['Existing prose. abcdefgh'] : []);
        expect(context.saveChatConditional).toHaveBeenCalledTimes(1);
        expect(context.getTokenCount).not.toHaveBeenCalled();
        expect(eventSource.emit.mock.calls.some(([name]) => name === event_types.GENERATION_STOPPED)).toBe(false);
        expect(context.streamingProcessor).toBeNull();
    });

    test.each([false, true])('inline thinking and repeated text do not consume the stream budget (buffer: %s)', async buffer => {
        const { context, StreamingProcessor } = makeRuntime({ api: 'textgenerationwebui', stream: true, buffer });
        const processor = new StreamingProcessor('continue', false, new Date(), '', {}, { maxOutputTokens: 2 });
        processor.messageId = 0;
        context.streamingProcessor = processor;
        processor.generator = async function* () {
            yield { text: '<think>' + 'x'.repeat(1000), state: {}, swipes: [] };
            yield { text: '<think>' + 'x'.repeat(1000), state: {}, swipes: [] };
            yield { text: '<think>' + 'x'.repeat(1000) + '</think>abcd', state: {}, swipes: [] };
            yield { text: '<think>' + 'x'.repeat(1000) + '</think>abcd', state: {}, swipes: [] };
        };
        await (buffer ? processor.generateBuffered() : processor.generate());
        expect(processor.result).toBe('abcd');
        expect(processor.finishReason).toBeNull();
        expect(processor.requestAbortController.signal.aborted).toBe(false);
        expect(processor.pendingReasoning).toBe('x'.repeat(1000));
        expect(context.getTokenCount).not.toHaveBeenCalled();
    });

    test.each([false, true])('explicit cancellation stays cancelled, not a length completion (buffer: %s)', async buffer => {
        const { context, eventSource } = makeRuntime({ api: 'textgenerationwebui', stream: true, buffer });
        let processor;
        context.generateTextGenWithStreaming = async (data, signal) => {
            processor = context.streamingProcessor;
            return async function* () {
                yield { text: 'abcd', state: {}, swipes: [] };
                context.stopGeneration();
                throw signal.reason;
            };
        };
        const received = jest.fn();
        eventSource.on(event_types.MESSAGE_RECEIVED, received);
        const result = await context.Generate('continue', { suppressUserMessage: true, suppressAutoContinue: true, maxOutputTokens: 2 });
        expect(result).toBeUndefined();
        expect(processor.result).toBe('abcd');
        expect(processor.finishReason).toBeNull();
        expect(processor.isCancelled).toBe(true);
        expect(processor.isStopped).toBe(true);
        expect(processor.abortController.signal.aborted).toBe(true);
        expect(processor.requestAbortController.signal.aborted).toBe(true);
        expect(context.saveChatConditional).not.toHaveBeenCalled();
        expect(received).not.toHaveBeenCalled();
        expect(context.chat[0].mes).toBe(buffer ? 'Existing prose. ' : 'Existing prose. abcd');
    });
});
