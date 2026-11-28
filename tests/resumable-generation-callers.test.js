/* global globalThis */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { fileURLToPath } from 'node:url';
import { createNoopJQuery } from './util/openai-harness.js';

const pub = relative => fileURLToPath(new URL(`../public/${relative}`, import.meta.url));

const fetchResumableMock = jest.fn();
const rawFetchMock = jest.fn();
const getGenerateUrlMock = jest.fn(type => `/api/backends/generate/${type}`);

await jest.unstable_mockModule(pub('scripts/resumable-generation.js'), () => ({
    fetchResumable: fetchResumableMock,
}));
await jest.unstable_mockModule(pub('script.js'), () => ({
    amount_gen: 128,
    extractJsonFromData: jest.fn(data => data),
    extractMessageFromData: jest.fn(data => data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? ''),
    getGenerateUrl: getGenerateUrlMock,
    getRequestHeaders: jest.fn(() => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'csrf' })),
    main_api: 'koboldhorde',
    max_context: 4096,
    name1: 'User',
    name2: 'Assistant',
    normalizeContentText: value => String(value ?? ''),
    resultCheckStatus: jest.fn(),
    saveSettingsDebounced: jest.fn(),
    setGenerationProgress: jest.fn(),
    setOnlineStatus: jest.fn(),
}));
await jest.unstable_mockModule(pub('scripts/preset-manager.js'), () => ({
    getPresetManager: jest.fn(() => null),
}));
await jest.unstable_mockModule(pub('scripts/textgen-settings.js'), () => ({
    createTextGenGenerationData: jest.fn(() => ({})),
    getTextGenServer: jest.fn(() => 'http://localhost:5000'),
    setting_names: {},
    textgenerationwebui_settings: {},
}));
await jest.unstable_mockModule(pub('scripts/reasoning.js'), () => ({
    extractReasoningFromData: jest.fn(() => ''),
}));
await jest.unstable_mockModule(pub('scripts/instruct-mode.js'), () => ({
    autoSelectInstructPreset: jest.fn(),
    formatInstructModeChat: jest.fn(() => ''),
    formatInstructModePrompt: jest.fn(() => ''),
    getInstructStoppingSequences: jest.fn(() => []),
}));
await jest.unstable_mockModule(pub('scripts/openai.js'), () => ({
    chat_completion_sources: { OPENAI: 'openai', NANOGPT: 'nanogpt' },
    createGenerationParameters: jest.fn(async () => ({ generate_data: {} })),
    getNanoGptServiceTier: jest.fn(async () => ''),
    getStreamingReply: jest.fn(() => ''),
    oai_settings: {},
    settingsToUpdate: {},
    tryParseStreamingError: jest.fn(),
}));
await jest.unstable_mockModule(pub('scripts/sse-stream.js'), () => ({
    default: class EventSourceStream {
        constructor() {
            this.writable = new WritableStream();
            this.readable = new ReadableStream({
                start(controller) {
                    controller.close();
                },
            });
        }
    },
}));
await jest.unstable_mockModule(pub('scripts/openai-preset-utils.js'), () => ({
    migrateNanoGptProviderSettings: jest.fn(),
}));
await jest.unstable_mockModule(pub('scripts/sillybunny-request-errors.js'), () => ({
    createFailedResponseError: jest.fn(({ status }) => new Error(`HTTP ${status}`)),
    getFailureStatus: jest.fn(response => response?.status ?? 500),
    showRequestError: jest.fn(({ status }) => ({ message: `HTTP ${status}` })),
}));
await jest.unstable_mockModule(pub('scripts/secrets.js'), () => ({
    SECRET_KEYS: { HORDE: 'api_key_horde' },
    writeSecret: jest.fn(),
}));
await jest.unstable_mockModule(pub('scripts/utils.js'), () => ({
    delay: jest.fn(async () => {}),
    escapeHtml: value => String(value ?? ''),
}));
await jest.unstable_mockModule(pub('scripts/RossAscends-mods.js'), () => ({
    isMobile: jest.fn(() => false),
}));
await jest.unstable_mockModule(pub('scripts/i18n.js'), () => ({
    t: (strings, ...values) => strings.reduce((out, part, idx) => out + part + (values[idx] ?? ''), ''),
}));
await jest.unstable_mockModule(pub('scripts/popup.js'), () => ({
    POPUP_TYPE: { TEXT: 1 },
    callGenericPopup: jest.fn(async () => null),
}));
await jest.unstable_mockModule(pub('scripts/kai-settings.js'), () => ({
    kai_settings: {},
}));
await jest.unstable_mockModule(pub('scripts/sillybunny-editor/option-details.js'), () => ({
    registerOptionDetails: jest.fn(),
}));
await jest.unstable_mockModule(pub('scripts/sillybunny-model-details.js'), () => ({
    describeHordeModel: jest.fn(),
    plainText: value => String(value ?? ''),
}));

const { ChatCompletionService, TextCompletionService } = await import('../public/scripts/custom-request.js');
const { generateHorde, getHordeModels, horde_settings } = await import('../public/scripts/horde.js');

const originalFetch = globalThis.fetch;
const originalToastr = globalThis.toastr;
const originalDollar = globalThis.$;
const originalDocument = globalThis.document;

beforeEach(() => {
    fetchResumableMock.mockReset();
    rawFetchMock.mockReset();
    getGenerateUrlMock.mockClear();
    globalThis.fetch = rawFetchMock;
    globalThis.toastr = { error: jest.fn(), warning: jest.fn(), info: jest.fn() };
    globalThis.$ = createNoopJQuery();
    globalThis.document = { createElement: () => ({}) };
});

afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.toastr = originalToastr;
    globalThis.$ = originalDollar;
    globalThis.document = originalDocument;
});

describe('resumable generation caller routing', () => {
    test('routes TextCompletionService non-streaming and streaming requests through fetchResumable', async () => {
        fetchResumableMock.mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ text: 'hello' }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        }));

        const nonStream = await TextCompletionService.sendRequest({ prompt: 'Hi', stream: false, api_type: 'llamacpp' });
        expect(nonStream.content).toBe('hello');
        expect(getGenerateUrlMock).toHaveBeenCalledWith('textgenerationwebui');
        expect(fetchResumableMock).toHaveBeenCalledWith(
            '/api/backends/generate/textgenerationwebui',
            expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ 'X-CSRF-Token': 'csrf' }) }),
        );

        fetchResumableMock.mockResolvedValueOnce(new Response(new ReadableStream({
            start(controller) {
                controller.close();
            },
        }), { status: 200 }));

        const streamFactory = await TextCompletionService.sendRequest({ prompt: 'Hi', stream: true, api_type: 'llamacpp' });
        expect(typeof streamFactory).toBe('function');
        expect(fetchResumableMock).toHaveBeenCalledWith(
            '/api/backends/text-completions/generate',
            expect.objectContaining({ method: 'POST' }),
        );
        expect(rawFetchMock).not.toHaveBeenCalled();
    });

    test('routes ChatCompletionService requests through fetchResumable', async () => {
        fetchResumableMock.mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: 'reply' } }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        }));

        const result = await ChatCompletionService.sendRequest({
            stream: false,
            messages: [{ role: 'user', content: 'Hi' }],
            model: 'gpt-4o',
            chat_completion_source: 'openai',
        });

        expect(result.content).toBe('reply');
        expect(fetchResumableMock).toHaveBeenCalledWith(
            '/api/backends/chat-completions/generate',
            expect.objectContaining({ method: 'POST' }),
        );
        expect(rawFetchMock).not.toHaveBeenCalled();
    });

    test('routes Horde generation requests through fetchResumable instead of raw fetch', async () => {
        horde_settings.models = ['horde-model'];
        const controller = new AbortController();
        rawFetchMock.mockImplementation(async (url) => {
            if (url === '/api/horde/text-models') {
                return new Response(JSON.stringify([{ name: 'horde-model' }]), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            if (url === '/api/horde/text-workers') {
                return new Response(JSON.stringify([]), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            return new Response(JSON.stringify({
                done: true,
                generations: [{ text: 'Horde reply', worker_name: 'worker-1', model: 'horde-model' }],
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        });
        await getHordeModels(true);
        fetchResumableMock.mockResolvedValueOnce(new Response(JSON.stringify({ id: 'task-1' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        }));

        const result = await generateHorde('Hello', { max_length: 64 }, controller.signal, jest.fn());

        expect(result.text).toBe('Horde reply');
        expect(result.workerName).toContain('worker-1');
        expect(fetchResumableMock).toHaveBeenCalledWith(
            '/api/horde/generate-text',
            expect.objectContaining({ method: 'POST', signal: controller.signal }),
        );
        expect(rawFetchMock.mock.calls.some(([url]) => url === '/api/horde/generate-text')).toBe(false);
    });
});
