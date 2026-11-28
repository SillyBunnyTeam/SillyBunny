/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect -- Jest test.each tables are not Playwright tests. */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { importStoryModeRuntime } from './util/story-mode-harness.js';
import { applyGenerationRequestControls, isGenerationLengthFinish, limitGenerationProse, requestUsesReasoning } from '../public/scripts/generation-request-controls.js';
import { event_types } from '../public/scripts/events.js';
import { OVERSWIPE_BEHAVIOR, SWIPE_DIRECTION, SWIPE_SOURCE, SWIPE_STATE } from '../public/scripts/constants.js';

let loaded = null;

afterEach(() => {
    loaded?.cleanup();
    loaded = null;
    jest.restoreAllMocks();
});

const REQUEST_CONTROLS_DOM = `
    <div id="chat">
        <div class="mes last_mes" mesid="0">
            <div class="mes_block">
                <div class="mes_text">Existing prose. </div>
                <details class="mes_reasoning_details">
                    <summary class="mes_reasoning_header"><span class="mes_reasoning_header_title"></span></summary>
                    <div class="mes_reasoning"></div>
                </details>
                <button class="mes_edit_add_reasoning" type="button"></button>
            </div>
            <div class="swipes-counter">1/1</div>
            <div class="swipe_left"></div>
            <div class="swipe_right"></div>
        </div>
    </div>
    <div id="message_template" hidden>
        <div class="mes">
            <div class="mes_block">
                <div class="mes_text"></div>
                <details class="mes_reasoning_details">
                    <summary class="mes_reasoning_header"><span class="mes_reasoning_header_title"></span></summary>
                    <div class="mes_reasoning"></div>
                </details>
                <button class="mes_edit_add_reasoning" type="button"></button>
            </div>
            <div class="swipes-counter"></div>
            <div class="swipe_left"></div>
            <div class="swipe_right"></div>
        </div>
    </div>
    <textarea id="send_textarea"></textarea>
    <div id="send_but"></div>
    <div id="mes_stop"></div>
    <div id="options_button"></div>
    <div id="options">
        <div class="options-content">
            <a id="option_continue"></a>
        </div>
    </div>
    <select id="main_api">
        <option value="openai">openai</option>
        <option value="textgenerationwebui">textgenerationwebui</option>
        <option value="kobold">kobold</option>
        <option value="koboldhorde">koboldhorde</option>
        <option value="novel">novel</option>
    </select>
`;

async function makeRuntime({
    api = 'openai',
    model = 'gpt-4o',
    stream = false,
    buffer = false,
    composer = '',
    trimSentences = false,
    extraMocks = {},
} = {}) {
    const requests = [];
    const state = {
        reply: 'New prose.',
        reasoning: '',
        chunks: [],
    };

    const fetchResumable = jest.fn(async (url, init = {}) => {
        const body = JSON.parse(init.body);
        requests.push({ url, body, signal: init.signal });
        return {
            ok: true,
            status: 200,
            json: async () => {
                if (api === 'openai' || url.includes('/chat-completions') || url.includes('/openai')) {
                    return { choices: [{ message: { content: state.reply, reasoning_content: state.reasoning } }] };
                }
                if (api === 'kobold' || url.includes('/kobold')) return { results: [{ text: state.reply }] };
                if (api === 'novel' || url.includes('/novelai')) return { output: state.reply };
                return { choices: [{ text: state.reply }], thinking: state.reasoning };
            },
        };
    });

    const generateHorde = jest.fn(async (_prompt, data, signal) => {
        requests.push({ body: data, signal });
        return { text: state.reply };
    });

    const streamTransport = jest.fn(async (data, signal) => {
        requests.push({ body: data, signal });
        return async function* () {
            for (const chunk of state.chunks) {
                if (signal.aborted) throw signal.reason;
                yield { swipes: [], toolCalls: [], state: {}, ...chunk };
            }
        };
    });

    const fetchMock = jest.fn(async (url) => {
        if (url === '/api/settings/get') {
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    settings: JSON.stringify({
                        main_api: api,
                        amount_gen: 8192,
                        max_context: 32768,
                        oai_settings: {
                            chat_completion_source: 'openai',
                            openai_model: model,
                            custom_model: model,
                            openai_max_tokens: 8192,
                            openai_max_context: 32768,
                            stream_openai: stream,
                            show_thoughts: true,
                            reasoning_effort: 'none',
                            continue_postfix: '',
                            send_if_empty: '',
                            custom_reasoning_param_format: 'openai',
                            custom_reasoning_param_name: 'reasoning_effort',
                        },
                        power_user: {
                            instruct: { enabled: false },
                            sysprompt: { enabled: false },
                            context: {},
                            reasoning: { prefix: '<think>', suffix: '</think>', separator: '\n', auto_parse: true, add_to_prompts: false },
                            auto_continue: { enabled: true, target_length: 1, allow_chat_completions: true },
                            streaming_fps: 30,
                            trim_spaces: false,
                            trim_sentences: trimSentences,
                            message_token_count_enabled: false,
                        },
                    }),
                    openai_setting_names: [],
                    openai_settings: [],
                }),
            };
        }
        if (url === '/api/chats/save') {
            return { ok: true, status: 200, json: async () => ({ ok: true }) };
        }
        return { ok: true, status: 200, json: async () => [] };
    });

    const getTokenCount = jest.fn(() => {
        throw new Error('Synchronous token counting is forbidden in controlled streams');
    });
    const executeSlashCommandsOnChatInput = jest.fn(async () => ({ isAborted: true }));
    const settleGenerationCommit = jest.fn(async () => null);
    const reloadServerCommittedReply = jest.fn(async () => false);
    const selectCompanionChatHistory = jest.fn(() => []);

    loaded = await importStoryModeRuntime({
        dom: REQUEST_CONTROLS_DOM,
        keepReal: ['scripts/openai.js', 'scripts/reasoning.js', 'scripts/sse-stream.js', 'scripts/group-chats.js'],
        fetch: fetchMock,
        extraMocks: {
            'scripts/resumable-generation.js': {
                fetchResumable,
                settleGenerationCommit,
            },
            'scripts/server-generations.js': {
                createGenerationCommitPlan: jest.fn(() => null),
                initServerGenerations: jest.fn(),
                reloadServerCommittedReply,
            },
            'scripts/horde.js': {
                generateHorde,
                isHordeGenerationNotAllowed: jest.fn(() => false),
                MIN_LENGTH: 16,
            },
            'scripts/textgen-settings.js': base => ({
                ...base,
                textgenerationwebui_settings: { type: 'llamacpp', streaming: stream },
                getTextGenGenerationData: jest.fn(async (prompt, maxTokens) => {
                    const data = { prompt, model, max_new_tokens: maxTokens, max_tokens: maxTokens, n_predict: maxTokens, num_predict: maxTokens, include_reasoning: true };
                    await loaded.eventSource.emit(event_types.TEXT_COMPLETION_SETTINGS_READY, data);
                    return data;
                }),
                generateTextGenWithStreaming: streamTransport,
            }),
            'scripts/nai-settings.js': base => ({
                ...base,
                nai_settings: { preset_settings_novel: 'preset', model_novel: 'erato', streaming_novel: stream },
                novelai_settings: [{}],
                novelai_setting_names: { preset: 0 },
                getNovelGenerationData: (prompt, _settings, maxLength) => ({ input: prompt, model: 'erato', max_length: maxLength }),
                generateNovelWithStreaming: streamTransport,
            }),
            'scripts/kai-settings.js': base => ({
                ...base,
                kai_settings: { preset_settings: 'gui', streaming_kobold: stream },
                kai_flags: {},
                generateKoboldWithStreaming: streamTransport,
            }),
            'scripts/tokenizers.js': base => ({
                ...base,
                getTokenCount,
                getTokenCountAsync: jest.fn(async () => 0),
            }),
            'scripts/slash-commands.js': {
                executeSlashCommandsOnChatInput,
            },
            'scripts/extensions/in-chat-agents/companion/companion-shared.js': {
                consolidateCompanionChatHistory: jest.fn(() => ({ host: null, entries: [] })),
                hasCompanionChatHistoryForHiddenHost: jest.fn(() => false),
                selectCompanionChatHistory,
            },
            'scripts/utils.js': base => ({
                ...base,
                trimToEndSentence: trimSentences
                    ? (text => {
                        const match = String(text ?? '').match(/^[\s\S]*[.!?](?=\s|$)/);
                        return match ? match[0] : text;
                    })
                    : (v => v),
            }),
            'scripts/sillybunny-group-editor.js': {
                beginGroupEditorLoad: jest.fn(() => 'loaded'),
                openGroupEditorSession: jest.fn(),
                openGroupEditorCreateSession: jest.fn(),
                captureGroupEditorSave: jest.fn(() => null),
                readGroupEditorBaseline: jest.fn(() => null),
                isGroupEditorOwner: jest.fn(() => false),
                notifyGroupEditorChanged: jest.fn(),
                rebaseGroupEditor: jest.fn(),
                initGroupEditor: jest.fn(),
                discardGroupEditorForEntity: jest.fn(),
                attachGroupTagFilterMenus: jest.fn(),
                prepareGroupEditorReveal: jest.fn(async () => true),
                setGroupEditorFolderValue: jest.fn(),
            },
            'scripts/sillybunny-action-menu.js': {
                openActionMenu: jest.fn(),
                openPopover: jest.fn(),
                closeActionMenu: jest.fn(),
                isActionMenuOpen: jest.fn(() => false),
                getActionMenuTrigger: jest.fn(() => null),
                positionPopover: jest.fn(),
                getRevealScrollTop: jest.fn(() => 0),
                MOBILE_QUERY: '(max-width: 767px)',
            },
            'scripts/sillybunny-editor/object-navigation.js': {
                objectNavigation: { navigate: jest.fn(async () => ({ ok: true })), back: jest.fn(async () => {}) },
            },
            'scripts/sillybunny-editor/list-pagination.js': {
                createListPagination: jest.fn(() => ({ setItems: jest.fn(), destroy: jest.fn(), page: 1, goTo: jest.fn() })),
            },
            'scripts/sillybunny-editor/list-search.js': {
                createListSearch: jest.fn(() => ({ clear: jest.fn(), destroy: jest.fn(), setQuery: jest.fn() })),
            },
            ...extraMocks,
        },
    });

    const openai = await import('../public/scripts/openai.js');
    const groupChats = await import('../public/scripts/group-chats.js');
    await loaded.runReady();
    loaded.script.setOnlineStatus(model);

    Object.assign(loaded.state.power_user, {
        personas: {},
        instruct: { enabled: false },
        sysprompt: { enabled: false },
        context: {},
        reasoning: { prefix: '<think>', suffix: '</think>', separator: '\n', auto_parse: true, add_to_prompts: false },
        auto_continue: { enabled: true, target_length: 1, allow_chat_completions: true },
        streaming_fps: 30,
        trim_spaces: false,
        trim_sentences: trimSentences,
        message_token_count_enabled: false,
        auto_swipe: false,
    });

    Object.assign(openai.oai_settings, {
        chat_completion_source: 'openai',
        openai_model: model,
        custom_model: model,
        openai_max_tokens: 8192,
        openai_max_context: 32768,
        stream_openai: stream,
        show_thoughts: true,
        reasoning_effort: 'none',
        continue_postfix: '',
        send_if_empty: '',
        custom_reasoning_param_format: 'openai',
        custom_reasoning_param_name: 'reasoning_effort',
    });

    loaded.script.characters.push({ name: 'Story', avatar: 'story.png', chat: 'story', data: { extensions: {} } });
    loaded.script.setCharacterId(0);
    loaded.script.setCharacterName('Story');
    loaded.script.chat.push({ name: 'Story', mes: 'Existing prose. ', extra: {}, is_user: false });

    const textarea = document.getElementById('send_textarea');
    textarea.value = composer;

    if (buffer) {
        loaded.eventSource.on(event_types.GENERATION_OUTPUT_BUFFERING_DECISION, data => {
            data.hasPostMainInterceptors = true;
        });
    }

    fetchMock.mockClear();

    return {
        ...loaded,
        openai,
        groupChats,
        requests,
        state,
        textarea,
        fetchResumable,
        fetchMock,
        streamTransport,
        getTokenCount,
        executeSlashCommandsOnChatInput,
        settleGenerationCommit,
        reloadServerCommittedReply,
        selectCompanionChatHistory,
    };
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
        { model: 'gpt-6-sol', reasoning_effort: 'none' },
        { model: 'gpt-6-luna', reasoning_effort: 'none' },
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
        { model: 'gpt-6-sol', reasoning_effort: 'high' },
        { model: 'gpt-6-luna', reasoning_effort: 'high' },
        { model: 'deepseek-reasoner', reasoning_effort: 'none' },
        { model: 'deepseek-ai/DeepSeek-R1' },
        { model: 'moonshot/kimi-k3' },
        { model: 'moonshot/kimi-k2-thinking', reasoning_effort: 'none' },
        { model: 'gemini-2.0-flash-thinking-exp', reasoning_effort: 'none' },
        { model: 'gemini-4-argon' },
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
        const reasoningCfg = { prefix: '<think>', suffix: '</think>', separator: '\n', auto_parse: true, add_to_prompts: false };
        const limit = text => limitGenerationProse(text, 2, reasoningCfg, '', true);
        expect(limit('<think>' + 'reasoning '.repeat(100))).toMatchObject({ text: '', limited: false });
        expect(limit('<thi')).toMatchObject({ text: '', limited: false });
        expect(limit('<thinking>one</thinking>abcd<think>two</think>efgh-more')).toEqual({ text: 'abcdefgh', reasoning: 'one\n\ntwo', limited: true });
        expect(limit('abc\uD83D\uDE00xxxx')).toMatchObject({ text: 'abc\uD83D\uDE00xxx', limited: true });
        expect(limitGenerationProse('abc\uD83D\uDE00', 1, reasoningCfg).text).toBe('abc');
    });

    test('length metadata ignores absent or malformed choices and secondary swipes', () => {
        for (const data of [null, {}, { choices: {} }, { choices: [null] }, { choices: [{ index: 1, finish_reason: 'length' }] }]) {
            expect(isGenerationLengthFinish(data)).toBe(false);
        }
        expect(isGenerationLengthFinish({ delta: { stop_reason: 'max_tokens' } })).toBe(true);
        expect(isGenerationLengthFinish({ candidates: [{ finishReason: 'MAX_TOKENS' }] })).toBe(true);
        expect(isGenerationLengthFinish({ candidates: [{ finishReason: 'CONTINUATION', continuationToken: 'token' }] })).toBe(true);
    });

    test('a Gemini checkpoint or normal finish is not a length finish', () => {
        expect(isGenerationLengthFinish({ candidates: [{ continuationToken: 'token' }] })).toBe(false);
        expect(isGenerationLengthFinish({ candidates: [{ finishReason: 'STOP' }] })).toBe(false);
    });
});

describe('Gemini replies that end early', () => {
    const REASONING_ONLY_WARNING = 'The model finished reasoning but returned no reply text';
    const STREAM_MODES = [['stream', false], ['buffered stream', true]];
    const CONTINUE = { suppressUserMessage: true, suppressAutoContinue: true };

    const gemini = (parts, extra = {}) => ({ candidates: [{ content: { role: 'model', parts }, ...extra }] });
    const text = value => [{ text: value }];
    const thought = value => [{ text: value, thought: true }];
    const delta = (content, finish_reason = null) => ({ choices: [{ index: 0, delta: content, finish_reason }] });
    const eventStream = events => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');

    async function makeStream(source, buffer, events) {
        const runtime = await makeRuntime({ stream: true, buffer, model: 'gemini-4-argon' });
        Object.assign(runtime.openai.oai_settings, {
            chat_completion_source: source,
            google_model: 'gemini-4-argon',
            vertexai_model: 'gemini-4-argon',
            reasoning_effort: 'high',
        });
        runtime.fetchResumable.mockImplementation(async () => eventStream(events));
        return runtime;
    }

    async function makeComplete(source, reply) {
        const runtime = await makeRuntime({ model: 'gemini-4-argon' });
        Object.assign(runtime.openai.oai_settings, {
            chat_completion_source: source,
            google_model: 'gemini-4-argon',
            vertexai_model: 'gemini-4-argon',
            reasoning_effort: 'high',
        });
        runtime.fetchResumable.mockResolvedValue({ ok: true, status: 200, json: async () => reply });
        return runtime;
    }

    function expectCutOffWarning(toastr) {
        expect(toastr.warning).toHaveBeenCalledTimes(1);
        expect(toastr.warning).not.toHaveBeenCalledWith(REASONING_ONLY_WARNING);
    }

    describe.each(STREAM_MODES)('%s', (_name, buffer) => {
        test.each([
            ['AI Studio on MAX_TOKENS', 'makersuite', [gemini(text('partial')), gemini(text(''), { finishReason: 'MAX_TOKENS' })]],
            ['AI Studio on CONTINUATION', 'makersuite', [gemini(text('partial')), gemini(text(''), { finishReason: 'CONTINUATION', continuationToken: 'token' })]],
            ['Vertex on MAX_TOKENS', 'vertexai', [gemini(text('partial')), gemini(text(''), { finishReason: 'MAX_TOKENS' })]],
            ['Vertex on CONTINUATION', 'vertexai', [gemini(text('partial')), gemini(text(''), { finishReason: 'CONTINUATION', continuationToken: 'token' })]],
            ['Interactions on a length finish', 'gemini_interactions', [delta({ content: 'partial' }), delta({}, 'length')]],
        ])('warns that partial text was cut off: %s', async (_label, source, events) => {
            const { script, toastr } = await makeStream(source, buffer, events);
            await script.Generate('continue', CONTINUE);
            expect(script.chat[0].mes).toBe('Existing prose. partial');
            expectCutOffWarning(toastr);
        });

        test.each([
            ['thoughts only', [gemini(thought('thinking')), gemini(text(''), { finishReason: 'CONTINUATION', continuationToken: 'token' })]],
            ['no thoughts', [gemini(text(''), { finishReason: 'MAX_TOKENS' })]],
        ])('gives one cut-off warning when the reply is blank: %s', async (_label, events) => {
            const { script, toastr } = await makeStream('makersuite', buffer, events);
            await script.Generate('continue', CONTINUE);
            expect(script.chat[0].mes.trimEnd()).toBe('Existing prose.');
            expectCutOffWarning(toastr);
        });

        test('stays quiet through a checkpoint and a normal finish', async () => {
            const { script, toastr } = await makeStream('makersuite', buffer, [
                gemini(text('before ')),
                gemini(text('at '), { continuationToken: 'token' }),
                gemini(text('after'), { finishReason: 'STOP' }),
            ]);
            await script.Generate('continue', CONTINUE);
            expect(script.chat[0].mes).toBe('Existing prose. before at after');
            expect(toastr.warning).not.toHaveBeenCalled();
        });

        test('keeps the reasoning-only warning when the model finished normally', async () => {
            const { script, toastr } = await makeStream('makersuite', buffer, [gemini(thought('thinking')), gemini(text(''), { finishReason: 'STOP' })]);
            await script.Generate('continue', CONTINUE);
            expect(toastr.warning).toHaveBeenCalledTimes(1);
            expect(toastr.warning).toHaveBeenCalledWith(REASONING_ONLY_WARNING);
        });

        test('does not warn about the local prose cap, which the provider did not report', async () => {
            const { script, toastr } = await makeStream('makersuite', buffer, [gemini(text('abcdefgh-overrun')), gemini(text(''), { finishReason: 'STOP' })]);
            const result = await script.Generate('continue', { ...CONTINUE, maxOutputTokens: 2 });
            expect(result.finishReason).toBe('length');
            expect(toastr.warning).not.toHaveBeenCalled();
        });

        test('leaves a length finish from another provider quiet', async () => {
            const { script, toastr } = await makeStream('openai', buffer, [delta({ content: 'partial' }), delta({}, 'length')]);
            await script.Generate('continue', CONTINUE);
            expect(script.chat[0].mes).toBe('Existing prose. partial');
            expect(toastr.warning).not.toHaveBeenCalled();
        });
    });

    describe('complete response', () => {
        test.each(['makersuite', 'vertexai', 'gemini_interactions'])('warns that partial text was cut off: %s', async (source) => {
            const { script, toastr } = await makeComplete(source, { choices: [{ message: { content: 'partial' }, finish_reason: 'length' }] });
            await script.Generate('continue', CONTINUE);
            expect(script.chat[0].mes).toBe('Existing prose. partial');
            expectCutOffWarning(toastr);
        });

        test('gives one cut-off warning when an interaction returned thoughts only', async () => {
            const { script, toastr } = await makeComplete('gemini_interactions', { choices: [{ message: { content: '', reasoning_content: 'thinking' }, finish_reason: 'length' }] });
            await script.Generate('continue', CONTINUE);
            expect(script.chat[0].extra.reasoning).toBe('thinking');
            expectCutOffWarning(toastr);
        });

        test('leaves a background generation quiet', async () => {
            const { script, toastr } = await makeComplete('makersuite', { choices: [{ message: { content: 'partial' }, finish_reason: 'length' }] });
            await script.Generate('quiet', { quiet_prompt: 'Summarize', suppressUserMessage: true });
            expect(toastr.warning).not.toHaveBeenCalled();
        });

        test('leaves a length finish from another provider quiet', async () => {
            const { script, toastr } = await makeComplete('openai', { choices: [{ message: { content: 'partial' }, finish_reason: 'length' }] });
            await script.Generate('continue', CONTINUE);
            expect(toastr.warning).not.toHaveBeenCalled();
        });
    });
});

describe('owned host generation flow in script.js', () => {
    test('suppressed continuation ignores draft commands and extends the same assistant block', async () => {
        const { script, openai, state: harnessState, textarea, requests, executeSlashCommandsOnChatInput, getTokenCount } = await makeRuntime({ composer: '/delete everything' });
        const original = script.chat[0];
        await script.Generate('continue', { suppressUserMessage: true, suppressAutoContinue: true, maxOutputTokens: 160 });
        expect(executeSlashCommandsOnChatInput).not.toHaveBeenCalled();
        expect(script.chat).toHaveLength(1);
        expect(script.chat[0]).toBe(original);
        expect(original.mes).toBe('Existing prose. New prose.');
        expect(textarea.value).toBe('/delete everything');
        expect(requests[0].body.max_tokens).toBe(160);
        expect(harnessState.reply).toBe('New prose.');
        expect(openai.oai_settings.openai_max_tokens).toBe(8192);
        expect(getTokenCount).not.toHaveBeenCalled();
    });

    test('preserves composer consumption and slash-command execution for default callers', async () => {
        const command = await makeRuntime({ composer: '/echo hello' });
        await command.script.Generate('continue');
        expect(command.executeSlashCommandsOnChatInput).toHaveBeenCalledTimes(1);
        expect(command.requests).toHaveLength(0);
        command.cleanup();
        loaded = null;

        const draft = await makeRuntime({ composer: 'A draft.' });
        const sent = [];
        draft.eventSource.on(event_types.MESSAGE_SENT, id => sent.push(draft.script.chat[id]?.mes));
        await draft.script.Generate('continue', { suppressAutoContinue: true });
        expect(sent).toEqual(['A draft.']);
        expect(draft.script.chat[1].is_user).toBe(true);
        expect(draft.textarea.value).toBe('');
    });

    test('suppression does not delete the preceding assistant message or consume attachments on a normal request', async () => {
        const { script, textarea, executeSlashCommandsOnChatInput } = await makeRuntime({
            composer: '/echo untouched',
            extraMocks: {
                'scripts/chats.js': { hasPendingFileAttachment: () => true },
            },
        });
        const original = script.chat[0];
        await script.Generate('normal', { suppressUserMessage: true, suppressAutoContinue: true, maxOutputTokens: 160 });
        expect(script.chat).toHaveLength(2);
        expect(script.chat[0]).toBe(original);
        expect(executeSlashCommandsOnChatInput).not.toHaveBeenCalled();
        expect(textarea.value).toBe('/echo untouched');
    });

    test.each(['openai', 'textgenerationwebui', 'kobold', 'koboldhorde', 'novel'])('caps the owned %s request after a nested quiet call', async api => {
        const { script, openai, requests, eventSource } = await makeRuntime({ api });
        let nested = false;
        eventSource.on(event_types.GENERATE_AFTER_DATA, async () => {
            if (nested) return;
            nested = true;
            await script.generateQuietPrompt({ quietPrompt: 'helper', responseLength: 64, preserveReasoningBudget: true });
        });
        await script.Generate('continue', { suppressUserMessage: true, suppressAutoContinue: true, maxOutputTokens: 160 });
        const field = ['kobold', 'koboldhorde', 'novel'].includes(api) ? 'max_length' : 'max_tokens';
        expect(requests.map(request => request.body[field])).toEqual([64, 160]);
        expect(script.amount_gen).toBe(8192);
        expect(openai.oai_settings.openai_max_tokens).toBe(8192);
    });

    test('a nested SETTINGS_READY helper cannot take the owning OpenAI cap', async () => {
        const { script, requests, eventSource } = await makeRuntime();
        let nested = false;
        eventSource.on(event_types.CHAT_COMPLETION_SETTINGS_READY, async () => {
            if (nested) return;
            nested = true;
            await script.generateRaw({ prompt: 'helper', responseLength: 64, preserveReasoningBudget: true });
        });
        await script.Generate('continue', { suppressUserMessage: true, suppressAutoContinue: true, maxOutputTokens: 160 });
        expect(requests.map(request => request.body.max_tokens)).toEqual([64, 160]);
    });

    test('hands Custom controls to the final server payload without changing the preset allowance', async () => {
        const { script, openai, requests } = await makeRuntime();
        openai.oai_settings.chat_completion_source = 'custom';
        await script.Generate('continue', { suppressUserMessage: true, suppressAutoContinue: true, maxOutputTokens: 160 });
        await script.generateRaw({ prompt: 'helper', responseLength: 64, preserveReasoningBudget: true });
        await script.generateRaw({ prompt: 'ordinary helper' });
        expect(requests[0].body.request_controls).toEqual({ maxOutputTokens: 160, responseLength: null, preserveReasoningBudget: false });
        expect(requests[1].body.request_controls).toEqual({ maxOutputTokens: 0, responseLength: 64, preserveReasoningBudget: true });
        expect(requests[2].body.request_controls).toBeUndefined();
        expect(requests.map(request => request.body.max_tokens)).toEqual([8192, 8192, 8192]);
    });

    test('caps max_completion_tokens on a real disabled-reasoning OpenAI payload', async () => {
        const { script, requests } = await makeRuntime({ model: 'gpt-5.1' });
        await script.Generate('continue', { suppressUserMessage: true, suppressAutoContinue: true, maxOutputTokens: 160 });
        expect(requests[0].body.max_completion_tokens).toBe(160);
        expect(requests[0].body.max_tokens).toBeUndefined();
        expect(requests[0].body.reasoning_effort).toBe('none');
    });

    test('forwards controls through the real group wrapper without consuming a suppressed draft or auto-continuing', async () => {
        const { script, groupChats, requests, textarea, eventSource, executeSlashCommandsOnChatInput, getTokenCount } = await makeRuntime({ composer: '/echo draft' });
        groupChats.groups.push({ id: 'group', name: 'Story Group', chat_id: 'group-chat', chats: ['group-chat'], members: ['story.png'], disabled_members: [], activation_strategy: 0, generation_mode: 0 });
        await groupChats.openGroupById('group', { switchMenu: false });
        script.chat.length = 0;
        script.chat.push({ name: 'Story', original_avatar: 'story.png', mes: 'Existing prose. ', extra: {}, is_user: false });
        script.addOneMessage(script.chat[0]);
        textarea.value = '/echo draft';

        const starts = [];
        eventSource.on(event_types.GENERATION_STARTED, (type, options) => starts.push({ type, options }));
        await script.Generate('continue', { suppressUserMessage: true, suppressAutoContinue: true, maxOutputTokens: 160 });

        expect(requests).toHaveLength(1);
        expect(requests[0].body.max_tokens).toBe(160);
        expect(starts).toHaveLength(2);
        expect(starts[1].options).toMatchObject({ suppressUserMessage: true, suppressAutoContinue: true, maxOutputTokens: 160 });
        expect(executeSlashCommandsOnChatInput).not.toHaveBeenCalled();
        expect(textarea.value).toBe('/echo draft');
        expect(getTokenCount).not.toHaveBeenCalled();
    });

    test.each([false, true])('tool successors retain controls but tool helpers do not (stream: %s)', async stream => {
        const saveFunctionToolInvocations = jest.fn(async () => {});
        let invokeOnce = false;
        const runtime = await makeRuntime({
            api: stream ? 'textgenerationwebui' : 'openai',
            stream,
            extraMocks: {
                'scripts/tool-calling.js': {
                    ToolManager: {
                        RECURSE_LIMIT: 5,
                        initToolSlashCommands: jest.fn(),
                        isToolCallingSupported: () => false,
                        canPerformToolCalls: () => true,
                        hasToolCalls: jest.fn().mockReturnValueOnce(true).mockReturnValue(false),
                        registerFunctionToolsOpenAI: jest.fn(async () => {}),
                        invokeFunctionTools: jest.fn(async () => {
                            if (!invokeOnce) {
                                invokeOnce = true;
                                await runtime.script.generateRaw({ prompt: 'tool helper', responseLength: 64, preserveReasoningBudget: true });
                                runtime.state.chunks = [{ text: 'successor' }];
                                return { invocations: [{ id: 'tool' }], stealthCalls: [] };
                            }
                            return { invocations: [], stealthCalls: [] };
                        }),
                        parseToolCalls: jest.fn(),
                        saveFunctionToolInvocations,
                    },
                },
            },
        });
        runtime.state.chunks = [{ text: 'tool reply', toolCalls: [{ id: 'tool' }] }];

        await runtime.script.Generate('continue', { suppressUserMessage: true, suppressAutoContinue: true, maxOutputTokens: 160 });

        expect(runtime.requests.map(request => request.body.max_tokens)).toEqual([160, 64, 160]);
        expect(saveFunctionToolInvocations).toHaveBeenCalledTimes(1);
        expect(runtime.getTokenCount).not.toHaveBeenCalled();
        expect(runtime.state.power_user?.auto_continue?.enabled ?? loaded.state.power_user.auto_continue.enabled).toBe(true);
    });

    test.each(['generateRaw', 'generateQuietPrompt'])('%s preserves the original reasoning budget before any preset override', async method => {
        for (const model of ['gpt-4o', 'o3']) {
            const runtime = await makeRuntime({ model });
            await runtime.script[method]({ prompt: 'selection', quietPrompt: 'selection', responseLength: 64, preserveReasoningBudget: true });
            expect(runtime.requests[0].body.max_tokens ?? runtime.requests[0].body.max_completion_tokens).toBe(model === 'o3' ? 8192 : 64);
            expect(runtime.openai.oai_settings.openai_max_tokens).toBe(8192);
            runtime.cleanup();
            loaded = null;
        }
    });

    test.each(['generateRaw', 'generateQuietPrompt'])('%s keeps the legacy responseLength override unless preservation is requested', async method => {
        const { script, openai, requests } = await makeRuntime({ model: 'o3' });
        await script[method]({ prompt: 'selection', quietPrompt: 'selection', responseLength: 64 });
        expect(requests[0].body.max_completion_tokens).toBe(64);
        expect(openai.oai_settings.openai_max_tokens).toBe(8192);
    });

    test('generateRaw sends its responseLength to AI Horde as max_length', async () => {
        const { script, requests } = await makeRuntime({ api: 'koboldhorde' });
        await script.generateRaw({ prompt: 'helper', responseLength: 512 });
        expect(requests[0].body).toMatchObject({ max_length: 512, max_context_length: 32768 });
        expect(script.amount_gen).toBe(8192);
    });

    test.each([
        ['a whole reply', {}],
        ['a streamed reply', { api: 'textgenerationwebui', stream: true }],
        ['a buffered streamed reply', { api: 'textgenerationwebui', stream: true, buffer: true }],
    ])('suppressAutoSwipe keeps %s that auto-swipe would otherwise redo', async (_, options) => {
        for (const suppressAutoSwipe of [false, true]) {
            const generatedTextFiltered = jest.fn().mockReturnValueOnce(true).mockReturnValue(false);
            const runtime = await makeRuntime({
                ...options,
                extraMocks: {
                    'scripts/power-user.js': base => ({ ...base, generatedTextFiltered }),
                },
            });
            loaded.state.power_user.auto_swipe = true;
            runtime.script.chat_metadata.tainted = true;
            runtime.state.chunks = [{ text: 'New prose.' }];
            runtime.state.reply = 'New prose.';
            const starts = [];
            runtime.eventSource.on(event_types.GENERATION_STARTED, (type) => starts.push(type));

            await runtime.script.Generate('normal', { suppressUserMessage: true, suppressAutoContinue: true, suppressAutoSwipe });

            expect(starts).toEqual(suppressAutoSwipe ? ['normal'] : ['normal', 'swipe']);
            expect(runtime.script.chat.at(-1).mes).toBe('New prose.');
            runtime.cleanup();
            loaded = null;
        }
    });

    test('auto-continue forwards owned options through the live #option_continue click handler', async () => {
        const { script, requests, state: harnessState, eventSource, $ } = await makeRuntime();
        const controls = { maxOutputTokens: 160, suppressUserMessage: true };
        loaded.state.power_user.auto_continue.target_length = 100;
        loaded.mocks['scripts/tokenizers.js'].getTokenCount.mockReturnValue(1);

        const receivedCustomData = [];
        $('#option_continue').on('click', (_e, data) => receivedCustomData.push(data));
        let doneResolve;
        const done = new Promise(resolve => { doneResolve = resolve; });
        eventSource.on(event_types.GENERATION_STARTED, () => {
            loaded.state.power_user.auto_continue.enabled = false;
        });
        eventSource.on(event_types.GENERATION_ENDED, () => doneResolve());

        script.triggerAutoContinue('enough prose', false, controls);
        await done;

        expect(receivedCustomData).toEqual([{ generationOptions: controls }]);
        expect(requests).toHaveLength(1);
        expect(requests[0].body.max_tokens).toBe(160);
        expect(harnessState.reply).toBe('New prose.');
    });

    const CONTINUATION_PATHS = [
        ['a whole openai reply', { api: 'openai' }],
        ['a whole textgenerationwebui reply', { api: 'textgenerationwebui' }],
        ['a whole kobold reply', { api: 'kobold' }],
        ['a whole koboldhorde reply', { api: 'koboldhorde' }],
        ['a whole novel reply', { api: 'novel' }],
        ['a buffered streamed reply', { api: 'textgenerationwebui', stream: true, buffer: true }],
        ['an unbuffered streamed reply', { api: 'textgenerationwebui', stream: true }],
    ];

    test.each(CONTINUATION_PATHS)('auto-continue ends after a continuation that adds no text: %s', async (_, options) => {
        const runtime = await makeRuntime(options);
        loaded.state.power_user.auto_continue.target_length = 100;
        loaded.mocks['scripts/tokenizers.js'].getTokenCount.mockReturnValue(1);
        runtime.state.reply = '';
        runtime.state.chunks = [{ text: '' }];
        const continueClicks = [];
        runtime.$('#option_continue').off('click').on('click', (_e, data) => continueClicks.push(data));

        const result = await runtime.script.Generate('continue', { suppressUserMessage: true });
        expect(continueClicks).toEqual([]);
        expect(result.messageChunk).toBe('');
        expect(runtime.script.chat[0].mes.trimEnd()).toBe('Existing prose.');
    });

    test.each(CONTINUATION_PATHS)('auto-continue asks again after a continuation that adds text: %s', async (_, options) => {
        const runtime = await makeRuntime(options);
        loaded.state.power_user.auto_continue.target_length = 100;
        loaded.mocks['scripts/tokenizers.js'].getTokenCount.mockReturnValue(1);
        runtime.state.chunks = [{ text: runtime.state.reply }];
        const continueClicks = [];
        runtime.$('#option_continue').off('click').on('click', (_e, data) => continueClicks.push(data));

        const result = await runtime.script.Generate('continue', { suppressUserMessage: true });
        expect(continueClicks).toEqual([{ generationOptions: expect.objectContaining({ suppressUserMessage: true }) }]);
        expect(result.messageChunk).toBe('New prose.');
        expect(runtime.script.chat[0].mes).toBe('Existing prose. New prose.');
    });

    describe.each([
        ['a whole reply', {}],
        ['a buffered streamed reply', { api: 'textgenerationwebui', stream: true, buffer: true }],
    ])('an output interceptor that rewrites %s', (_, options) => {
        async function generateRewritten(type) {
            const runtime = await makeRuntime(options);
            runtime.state.chunks = [{ text: runtime.state.reply }];
            runtime.eventSource.on(event_types.MAIN_GENERATION_OUTPUT_READY, data => { data.text = data.text.toUpperCase(); });
            const result = await runtime.script.Generate(type, { suppressUserMessage: true, suppressAutoContinue: true });
            return { result, saved: runtime.script.chat.at(-1).mes };
        }

        test('leaves the chunk of a continuation as the text the model added', async () => {
            const { result, saved } = await generateRewritten('continue');
            expect(result.messageChunk).toBe('New prose.');
            expect(saved).toBe('EXISTING PROSE. NEW PROSE.');
        });

        test('gives a fresh reply the rewritten text as its chunk', async () => {
            const { result, saved } = await generateRewritten('normal');
            expect(result.messageChunk).toBe('NEW PROSE.');
            expect(saved).toBe('NEW PROSE.');
        });
    });

    test('the swipe entry point forwards retry controls into the real successor request', async () => {
        const runtime = await makeRuntime({ composer: '/echo untouched' });
        runtime.script.chat_metadata.tainted = true;
        runtime.script.chat[0].extra.overswipe_behavior = OVERSWIPE_BEHAVIOR.REGENERATE;
        const controls = { suppressUserMessage: true, suppressAutoContinue: true, maxOutputTokens: 2 };
        const starts = [];
        runtime.eventSource.on(event_types.GENERATION_STARTED, (type, options) => starts.push({ type, options }));
        runtime.state.reply = 'abcdefgh-overrun';

        await runtime.script.swipe(null, SWIPE_DIRECTION.RIGHT, {
            source: SWIPE_SOURCE.SLASH_COMMAND,
            forceDuration: 0,
            generationOptions: controls,
        });

        expect(runtime.requests).toHaveLength(1);
        expect(runtime.requests[0].body.max_tokens).toBe(2);
        expect(starts).toEqual([{ type: 'swipe', options: expect.objectContaining(controls) }]);
        expect(runtime.script.chat[0].mes).toBe('abcdefgh');
        expect(runtime.script.chat[0].swipes).toEqual(['Existing prose. ', 'abcdefgh']);
        expect(runtime.textarea.value).toBe('/echo untouched');
        expect(runtime.script.swipeState).toBe(SWIPE_STATE.NONE);
    });

    test('separates and locally caps non-streamed reasoning without cancelling or losing the existing block', async () => {
        const runtime = await makeRuntime({ model: 'o3' });
        runtime.state.reply = '<think>' + 'reasoning '.repeat(200) + '</think>' + 'p'.repeat(900);
        const received = jest.fn();
        runtime.eventSource.on(event_types.MESSAGE_RECEIVED, received);

        const result = await runtime.script.Generate('continue', { suppressUserMessage: true, suppressAutoContinue: true, maxOutputTokens: 160 });

        expect(runtime.requests[0].body.max_completion_tokens).toBe(8192);
        expect(runtime.script.chat[0].mes).toBe('Existing prose. ' + 'p'.repeat(640));
        expect(runtime.script.chat[0].extra.reasoning).toBe('reasoning '.repeat(200));
        expect(result.finishReason).toBe('length');
        expect(received).toHaveBeenCalledTimes(1);
    });

    test('never treats a Gemini thinking-only response as prose through the extraction fallback', async () => {
        const runtime = await makeRuntime();
        runtime.openai.oai_settings.chat_completion_source = 'makersuite';
        runtime.openai.oai_settings.google_model = 'gemini-2.5-flash';
        runtime.fetchResumable.mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                choices: [{ message: { content: '' } }],
                responseContent: { parts: [{ thought: true, text: 'thinking '.repeat(1000) }] },
            }),
        });

        const result = await runtime.script.Generate('continue', { suppressUserMessage: true, suppressAutoContinue: true, maxOutputTokens: 2 });

        expect(runtime.script.chat[0].mes).toBe('Existing prose.');
        expect(runtime.script.chat[0].extra.reasoning).toBe('thinking '.repeat(1000));
        expect(runtime.toastr.warning).toHaveBeenCalledTimes(1);
        expect(result.finishReason).toBeNull();
        expect(runtime.script.extractMessageFromData({ responseContent: { parts: [null, { thought: true, text: 'hidden' }, { text: 'prose' }] } })).toBe('prose');
        expect(runtime.script.extractMessageFromData({ responseContent: { parts: 'plain fallback' } })).toBe('plain fallback');
    });

    test.each(['nonstream', 'stream', 'buffer'])('retains the accepted partial sentence on length completion: %s', async mode => {
        const runtime = await makeRuntime({ api: 'textgenerationwebui', model: 'deepseek-r1', stream: mode !== 'nonstream', buffer: mode === 'buffer', trimSentences: true });
        runtime.state.reply = 'abcdefgh-overrun';
        runtime.state.chunks = [{ text: runtime.state.reply }];

        const result = await runtime.script.Generate('continue', { suppressUserMessage: true, suppressAutoContinue: true, maxOutputTokens: 2 });

        expect(runtime.script.chat[0].mes).toBe('Existing prose. abcdefgh');
        expect(result.finishReason).toBe('length');
    });

    test.each(['nonstream', 'stream', 'buffer'])('continues an incomplete thinking prefix without consuming the new prose: %s', async mode => {
        const runtime = await makeRuntime({ api: 'textgenerationwebui', model: 'deepseek-r1', stream: mode !== 'nonstream', buffer: mode === 'buffer' });
        runtime.script.chat[0].mes = '';
        runtime.script.chat[0].extra.reasoning = 'prior ';
        runtime.state.reply = 'more</think>abcdefgh-overrun';
        runtime.state.chunks = [{ text: runtime.state.reply }];

        const result = await runtime.script.Generate('continue', { suppressUserMessage: true, suppressAutoContinue: true, maxOutputTokens: 2 });

        expect(runtime.script.chat[0].mes).toBe('abcdefgh');
        expect(runtime.script.chat[0].extra.reasoning).toBe('prior more');
        expect(result.finishReason).toBe('length');
    });

    test.each(['nonstream', 'stream', 'buffer'])('keeps all reasoning continuation text when whitespace trimming is enabled: %s', async mode => {
        const runtime = await makeRuntime({ api: 'textgenerationwebui', model: 'deepseek-r1', stream: mode !== 'nonstream', buffer: mode === 'buffer' });
        loaded.state.power_user.trim_spaces = true;
        runtime.script.chat[0].mes = '';
        runtime.script.chat[0].extra.reasoning = ' prior ';
        runtime.state.reply = 'more</think>abcdefgh-overrun';
        runtime.state.chunks = [{ text: runtime.state.reply }];

        await runtime.script.Generate('continue', { suppressUserMessage: true, suppressAutoContinue: true, maxOutputTokens: 2 });

        expect(runtime.script.chat[0].mes).toBe('abcdefgh');
        expect(runtime.script.chat[0].extra.reasoning.trim()).toBe('prior more');
    });

    test.each(['nonstream', 'stream', 'buffer'])('retains a final literal less-than sign rather than dropping a suspected thinking tag: %s', async mode => {
        const runtime = await makeRuntime({ api: 'textgenerationwebui', stream: mode !== 'nonstream', buffer: mode === 'buffer' });
        runtime.state.reply = 'a <';
        runtime.state.chunks = [{ text: runtime.state.reply }];

        const result = await runtime.script.Generate('continue', { suppressUserMessage: true, suppressAutoContinue: true, maxOutputTokens: 2 });

        expect(runtime.script.chat[0].mes).toBe('Existing prose. a <');
        expect(result.finishReason).toBeNull();
    });

    test.each(['nonstream', 'stream', 'buffer'])('honours the provider length ending before the character estimate: %s', async mode => {
        const runtime = await makeRuntime({ stream: mode !== 'nonstream', buffer: mode === 'buffer', trimSentences: true });
        runtime.fetchResumable.mockImplementation(async () => (mode === 'nonstream'
            ? new Response(JSON.stringify({ choices: [{ message: { content: 'partial' }, finish_reason: 'length' }] }))
            : new Response('data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n')));
        const received = [];
        const stopped = [];
        runtime.eventSource.on(event_types.MESSAGE_RECEIVED, () => received.push(runtime.script.chat[0].mes));
        runtime.eventSource.on(event_types.GENERATION_STOPPED, () => stopped.push('stopped'));

        const result = await runtime.script.Generate('continue', { suppressUserMessage: true, suppressAutoContinue: true, maxOutputTokens: 160 });

        expect(result.finishReason).toBe('length');
        expect(runtime.script.chat[0].mes).toBe('Existing prose. partial');
        expect(received).toEqual(['Existing prose. partial']);
        expect(stopped).toEqual([]);
    });

    test.each([false, true])('streamed cap completes once, including buffering: %s', async buffer => {
        const runtime = await makeRuntime({ api: 'textgenerationwebui', model: 'deepseek-r1', stream: true, buffer });
        runtime.state.chunks = [
            { text: '', state: { reasoning: 'hidden '.repeat(400) } },
            { text: 'abcd', state: { reasoning: 'hidden '.repeat(400) } },
            { text: 'abcd', state: { reasoning: 'hidden '.repeat(500) } },
            { text: 'abcdefgh-overrun', state: { reasoning: 'hidden '.repeat(500) } },
            { text: 'must not be accepted' },
        ];
        let processor;
        const postAgent = jest.fn();
        const stopped = [];
        runtime.eventSource.on(event_types.GENERATION_STOPPED, () => stopped.push('stopped'));
        runtime.eventSource.on(event_types.MESSAGE_RECEIVED, () => {
            processor ??= runtime.script.streamingProcessor;
            if (!processor.isStopped && !processor.abortController.signal.aborted) postAgent(runtime.script.chat[0].mes);
        });
        const intercepted = [];
        runtime.eventSource.on(event_types.MAIN_GENERATION_OUTPUT_READY, data => { intercepted.push(data.text); });

        const result = await runtime.script.Generate('continue', { suppressUserMessage: true, suppressAutoContinue: true, maxOutputTokens: 2 });

        expect(runtime.requests[0].body.max_tokens).toBe(8192);
        expect(runtime.requests[0].signal.aborted).toBe(true);
        expect(processor.abortController.signal.aborted).toBe(false);
        expect(processor.isCancelled).toBe(false);
        expect(processor.isStopped).toBe(false);
        expect(processor.isFinished).toBe(true);
        expect(result.finishReason).toBe('length');
        expect(runtime.script.chat[0].mes).toBe('Existing prose. abcdefgh');
        expect(postAgent).toHaveBeenCalledTimes(1);
        expect(intercepted).toEqual(buffer ? ['Existing prose. abcdefgh'] : []);
        expect(runtime.fetchMock.mock.calls.filter(([url]) => url === '/api/chats/save')).toHaveLength(1);
        expect(runtime.getTokenCount).not.toHaveBeenCalled();
        expect(stopped).toEqual([]);
        expect(runtime.script.streamingProcessor).toBeNull();
    });

    test.each([false, true])('inline thinking and repeated text do not consume the stream budget (buffer: %s)', async buffer => {
        const runtime = await makeRuntime({ api: 'textgenerationwebui', stream: true, buffer });
        runtime.state.chunks = [
            { text: '<think>' + 'x'.repeat(1000) },
            { text: '<think>' + 'x'.repeat(1000) },
            { text: '<think>' + 'x'.repeat(1000) + '</think>abcd' },
            { text: '<think>' + 'x'.repeat(1000) + '</think>abcd' },
        ];

        const result = await runtime.script.Generate('continue', { suppressUserMessage: true, suppressAutoContinue: true, maxOutputTokens: 2 });

        expect(result.finishReason).toBeNull();
        expect(runtime.requests[0].signal.aborted).toBe(false);
        expect(runtime.script.chat[0].mes).toBe('Existing prose. abcd');
        expect(runtime.script.chat[0].extra.reasoning).toBe('x'.repeat(1000));
        expect(runtime.getTokenCount).not.toHaveBeenCalled();
    });

    test.each([false, true])('explicit cancellation stays cancelled, not a length completion (buffer: %s)', async buffer => {
        let processor;
        const runtime = await makeRuntime({ api: 'textgenerationwebui', stream: true, buffer });
        runtime.streamTransport.mockImplementationOnce(async (_data, signal) => {
            processor = runtime.script.streamingProcessor;
            return async function* () {
                yield { text: 'abcd', state: {}, swipes: [] };
                runtime.script.stopGeneration();
                throw signal.reason;
            };
        });
        const received = jest.fn();
        runtime.eventSource.on(event_types.MESSAGE_RECEIVED, received);

        const result = await runtime.script.Generate('continue', { suppressUserMessage: true, suppressAutoContinue: true, maxOutputTokens: 2 });
        await new Promise(resolve => setTimeout(resolve, 10));

        expect(result).toBeUndefined();
        expect(processor.result).toBe('abcd');
        expect(processor.finishReason).toBeNull();
        expect(processor.isCancelled).toBe(true);
        expect(processor.isStopped).toBe(true);
        expect(processor.abortController.signal.aborted).toBe(true);
        expect(processor.requestAbortController.signal.aborted).toBe(true);
        expect(runtime.fetchMock.mock.calls.filter(([url]) => url === '/api/chats/save')).toHaveLength(buffer ? 0 : 1);
        expect(received).not.toHaveBeenCalled();
        expect(runtime.script.chat[0].mes).toBe(buffer ? 'Existing prose. ' : 'Existing prose. abcd');
    });

    async function stopDuringReasoning({ onReasoningDone = () => {} } = {}) {
        const runtime = await makeRuntime({ api: 'textgenerationwebui', stream: true });
        Object.assign(runtime.script.chat[0], { swipe_id: 0, swipes: ['Existing prose. '], swipe_info: [{ extra: {} }] });
        runtime.state.chunks = [
            { text: '', state: { reasoning: 'step one ' } },
            { text: '', state: { reasoning: 'step one step two ' } },
            { text: 'must not be accepted', state: { reasoning: 'step one step two step three ' } },
        ];
        const stopped = { placeholder: undefined };
        runtime.eventSource.on(event_types.STREAM_TOKEN_RECEIVED, () => {
            if (!runtime.script.streamingProcessor?.pendingReasoning?.includes('two')) return;
            stopped.placeholder = runtime.script.chat[0].extra.server_generation_placeholder;
            runtime.script.stopGeneration();
        });
        const reasoningDone = jest.fn(() => onReasoningDone(runtime));
        runtime.eventSource.on(event_types.STREAM_REASONING_DONE, reasoningDone);
        const received = jest.fn();
        runtime.eventSource.on(event_types.MESSAGE_RECEIVED, received);

        await runtime.script.Generate('continue', { suppressUserMessage: true, suppressAutoContinue: true });
        await new Promise(resolve => setTimeout(resolve, 15));
        return { runtime, stopped, reasoningDone, received };
    }

    test('Stop during streamed reasoning finishes the reasoning that arrived and saves the reply once', async () => {
        const { runtime, stopped, reasoningDone, received } = await stopDuringReasoning();
        const message = runtime.script.chat[0];
        expect(stopped.placeholder).toEqual(expect.any(String));
        expect(message.mes).toBe('Existing prose.');
        expect(message.extra.reasoning).toBe('step one step two');
        expect(message.extra.reasoning_duration).toEqual(expect.any(Number));
        expect(message.extra).not.toHaveProperty('server_generation_placeholder');
        expect(message.swipe_info[0].extra.reasoning_duration).toBe(message.extra.reasoning_duration);
        expect(message.swipe_info[0].extra).not.toHaveProperty('server_generation_placeholder');
        expect(reasoningDone).toHaveBeenCalledWith('step one step two', message.extra.reasoning_duration, 0, 'done');
        expect(received).not.toHaveBeenCalled();
        expect(runtime.fetchMock.mock.calls.filter(([url]) => url === '/api/chats/save')).toHaveLength(1);
    });

    test('Stop saves nothing after the chat changes while the stopped reply finishes', async () => {
        const { runtime, reasoningDone } = await stopDuringReasoning({
            onReasoningDone: rt => { rt.script.incrementChatGeneration(); },
        });
        expect(reasoningDone).toHaveBeenCalledTimes(1);
        expect(runtime.script.chat[0].swipe_info[0].extra.reasoning_duration).toBeNull();
        expect(runtime.fetchMock.mock.calls.filter(([url]) => url === '/api/chats/save')).toHaveLength(0);
    });

    test.each(['nonstream', 'stream', 'buffer'])('reloads the copy of a reply the server kept instead of saving its own: %s', async mode => {
        const runtime = await makeRuntime({ api: 'textgenerationwebui', stream: mode !== 'nonstream', buffer: mode === 'buffer' });
        runtime.state.chunks = [{ text: runtime.state.reply }];
        runtime.settleGenerationCommit.mockResolvedValue('committed');
        const received = jest.fn();
        runtime.eventSource.on(event_types.MESSAGE_RECEIVED, received);

        await runtime.script.Generate('continue', { suppressUserMessage: true, suppressAutoContinue: true });

        expect(runtime.settleGenerationCommit).toHaveBeenCalledWith(runtime.requests[0].signal);
        expect(runtime.reloadServerCommittedReply).toHaveBeenCalledTimes(1);
        expect(runtime.fetchMock.mock.calls.filter(([url]) => url === '/api/chats/save')).toHaveLength(0);
        expect(received).not.toHaveBeenCalled();
        expect(runtime.script.is_send_press).toBe(false);
        expect(runtime.script.streamingProcessor).toBeNull();
    });

    test.each(['nonstream', 'stream'])('saves the reply itself when the server let the page claim it: %s', async mode => {
        const runtime = await makeRuntime({ api: 'textgenerationwebui', stream: mode === 'stream' });
        runtime.state.chunks = [{ text: runtime.state.reply }];
        runtime.settleGenerationCommit.mockResolvedValue('claimed');

        await runtime.script.Generate('continue', { suppressUserMessage: true, suppressAutoContinue: true });

        expect(runtime.settleGenerationCommit).toHaveBeenCalledWith(runtime.requests[0].signal);
        expect(runtime.reloadServerCommittedReply).not.toHaveBeenCalled();
        expect(runtime.script.chat[0].mes).toBe('Existing prose. New prose.');
        expect(runtime.script.chat[0].extra).not.toHaveProperty('server_generation_placeholder');
    });
});

describe('hide request in the owned generation flow', () => {
    const options = { suppressUserMessage: true, suppressAutoContinue: true, maxOutputTokens: 160 };
    const line = mes => ({ name: 'Story', mes, extra: {}, is_user: false });

    test('leaves a line a handler hides out of the retained Companion candidates', async () => {
        const runtime = await makeRuntime();
        const [first] = runtime.script.chat;
        const second = line('Second line. ');
        runtime.script.chat.push(second);
        const seen = [];
        runtime.eventSource.on(event_types.GENERATION_HIDE_MESSAGES, request => {
            seen.push({ type: request.type, lines: request.messages.map(item => item.mes) });
            request.hide(0);
        });

        await runtime.script.Generate('normal', options);

        expect(seen).toEqual([{ type: 'normal', lines: ['Existing prose. ', 'Second line. '] }]);
        expect(runtime.selectCompanionChatHistory).toHaveBeenCalledTimes(1);
        expect(runtime.selectCompanionChatHistory.mock.calls[0][0]).toEqual([second]);
        expect(runtime.selectCompanionChatHistory.mock.calls[0][0]).not.toContain(first);
        expect(first.mes).toBe('Existing prose. ');
    });

    test('asks nothing on a dry run', async () => {
        const runtime = await makeRuntime();
        const handler = jest.fn();
        runtime.eventSource.on(event_types.GENERATION_HIDE_MESSAGES, handler);

        await runtime.script.Generate('normal', options, true);

        expect(handler).not.toHaveBeenCalled();
        expect(runtime.selectCompanionChatHistory).toHaveBeenCalledTimes(1);
        expect(runtime.selectCompanionChatHistory.mock.calls[0][0]).toEqual([runtime.script.chat[0]]);
    });

    test('offers a swipe the lines before the swiped one', async () => {
        const runtime = await makeRuntime();
        runtime.script.chat.push({ ...line('Second line. '), swipes: ['Second line. '], swipe_id: 0, swipe_info: [{}] });
        const seen = [];
        runtime.eventSource.on(event_types.GENERATION_HIDE_MESSAGES, request => {
            seen.push({ type: request.type, lines: request.messages.map(item => item.mes) });
        });

        await runtime.script.Generate('swipe', options);

        expect(seen).toEqual([{ type: 'swipe', lines: ['Existing prose. '] }]);
    });
});
