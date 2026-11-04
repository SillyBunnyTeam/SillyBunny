/**
 * @jest-environment jsdom
 */
import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';

/** A jQuery stand-in that accepts any chain of calls, because these modules only touch the page to show state. */
const jqueryChain = new Proxy(function () {}, { get: () => jqueryChain, apply: () => jqueryChain });
global.$ = jest.fn(() => jqueryChain);
// jsdom does not provide structuredClone, which the settings modules call when they load.
global.structuredClone ??= value => JSON.parse(JSON.stringify(value));
global.toastr = { error: jest.fn(), warning: jest.fn(), info: jest.fn(), success: jest.fn() };

const fetchResumable = jest.fn();
const nothing = () => undefined;

jest.unstable_mockModule('../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((text, part, index) => `${text}${part}${values[index] ?? ''}`, ''),
}));
jest.unstable_mockModule('../public/script.js', () => ({
    abortStatusCheck: { signal: undefined },
    amount_gen: 150,
    event_types: {},
    eventSource: { emit: jest.fn(), on: jest.fn() },
    extractJsonFromData: nothing,
    extractMessageFromData: nothing,
    getGenerateUrl: nothing,
    getRequestHeaders: () => ({}),
    getStoppingStrings: nothing,
    main_api: 'koboldhorde',
    max_context: 8192,
    name1: 'User',
    name2: 'Character',
    normalizeContentText: nothing,
    online_status: 'no_connection',
    resultCheckStatus: nothing,
    saveSettingsDebounced: nothing,
    setGenerationParamsFromPreset: nothing,
    setGenerationProgress: nothing,
    setOnlineStatus: nothing,
    startStatusLoading: nothing,
    substituteParams: value => value,
}));
jest.unstable_mockModule('../public/scripts/power-user.js', () => ({
    MAX_CONTEXT_DEFAULT: 8192,
    MAX_RESPONSE_DEFAULT: 150,
    power_user: {},
}));
jest.unstable_mockModule('../public/scripts/instruct-mode.js', () => ({
    autoSelectInstructPreset: nothing,
    formatInstructModeChat: nothing,
    formatInstructModePrompt: nothing,
    getInstructStoppingSequences: nothing,
}));
jest.unstable_mockModule('../public/scripts/sse-stream.js', () => ({
    default: class EventSourceStream {},
    getEventSourceStream: nothing,
}));
jest.unstable_mockModule('../public/scripts/resumable-generation.js', () => ({ fetchResumable }));
jest.unstable_mockModule('../public/scripts/utils.js', () => ({
    delay: nothing,
    getSortableDelay: nothing,
    getStringHash: nothing,
    onlyUnique: nothing,
    versionCompare: nothing,
}));
jest.unstable_mockModule('../public/scripts/secrets.js', () => ({
    SECRET_KEYS: {},
    secret_state: {},
    writeSecret: nothing,
}));
jest.unstable_mockModule('../public/scripts/RossAscends-mods.js', () => ({ isMobile: () => false }));
jest.unstable_mockModule('../public/scripts/popup.js', () => ({ callGenericPopup: nothing, POPUP_TYPE: {} }));
jest.unstable_mockModule('../public/scripts/tokenizers.js', () => ({
    getTextTokens: nothing,
    tokenizers: { NONE: 0, NERD: 1, NERD2: 2, LLAMA3: 3 },
}));
jest.unstable_mockModule('../public/scripts/logit-bias.js', () => ({
    BIAS_CACHE: new Map(),
    createNewLogitBiasEntry: nothing,
    displayLogitBias: nothing,
    getLogitBiasListResult: nothing,
}));
jest.unstable_mockModule('../public/scripts/preset-manager.js', () => ({ getPresetManager: nothing }));
jest.unstable_mockModule('../public/scripts/textgen-settings.js', () => ({
    createTextGenGenerationData: nothing,
    getTextGenServer: nothing,
    setting_names: [],
    textgenerationwebui_settings: {},
}));
jest.unstable_mockModule('../public/scripts/reasoning.js', () => ({ extractReasoningFromData: nothing }));
jest.unstable_mockModule('../public/scripts/openai.js', () => ({
    chat_completion_sources: {},
    createGenerationParameters: nothing,
    getNanoGptServiceTier: nothing,
    getStreamingReply: nothing,
    oai_settings: {},
    settingsToUpdate: {},
    tryParseStreamingError: jest.fn(),
}));
jest.unstable_mockModule('../public/scripts/openai-preset-utils.js', () => ({ migrateNanoGptProviderSettings: nothing }));

let generateKoboldWithStreaming;
let generateNovelWithStreaming;
let generateHorde;
let getHordeModels;
let horde_settings;
let TextCompletionService;
let ChatCompletionService;

beforeAll(async () => {
    ({ generateKoboldWithStreaming } = await import('../public/scripts/kai-settings.js'));
    ({ generateNovelWithStreaming } = await import('../public/scripts/nai-settings.js'));
    ({ generateHorde, getHordeModels, horde_settings } = await import('../public/scripts/horde.js'));
    ({ TextCompletionService, ChatCompletionService } = await import('../public/scripts/custom-request.js'));
});

beforeEach(() => {
    jest.clearAllMocks();
});

/**
 * @param {number} status
 * @param {string} body
 * @param {Record<string, string>} [headers]
 * @returns {Pick<Response, 'ok' | 'status' | 'statusText' | 'headers' | 'text'>}
 */
function failedResponse(status, body, headers = {}) {
    return { ok: false, status, statusText: 'Reason', headers: new Headers(headers), text: async () => body };
}

/** The toast that the last call to `toastr.error` made, as the page would show it. */
function lastToast() {
    const [content, title] = global.toastr.error.mock.calls.at(-1);
    return {
        title,
        message: typeof content === 'string' ? content : content.children[0].textContent,
        hintKind: typeof content === 'string' ? '' : content.children[1].dataset.sbRequestErrorHint,
    };
}

describe.each([
    ['KoboldAI', 'KoboldAI API', () => generateKoboldWithStreaming({})],
    ['NovelAI', 'NovelAI API', () => generateNovelWithStreaming({})],
])('the %s streaming request', (_name, title, run) => {
    test('shows the provider message and a hint for a JSON error body', async () => {
        fetchResumable.mockResolvedValue(failedResponse(401, '{"error":{"message":"Bad key"}}'));

        await expect(run()).rejects.toThrow();

        expect(global.toastr.error).toHaveBeenCalledTimes(1);
        expect(lastToast()).toEqual({ title, message: 'Bad key', hintKind: 'key' });
    });

    test('shows the text of a body that is not JSON, once', async () => {
        fetchResumable.mockResolvedValue(failedResponse(502, 'upstream connect error'));

        await expect(run()).rejects.toThrow('upstream connect error');

        expect(global.toastr.error).toHaveBeenCalledTimes(1);
        expect(lastToast()).toEqual({ title, message: 'upstream connect error', hintKind: 'down' });
    });

    test('reads the original status that the server hid behind a 400', async () => {
        fetchResumable.mockResolvedValue(failedResponse(400, '{"error":{"message":"Bad key"}}', { 'X-Upstream-Status': '401' }));

        await expect(run()).rejects.toThrow();

        expect(lastToast().hintKind).toBe('key');
    });
});

describe('the Horde request', () => {
    beforeAll(async () => {
        global.fetch = jest.fn(async url => ({ ok: true, json: async () => (String(url).endsWith('text-models') ? [{ name: 'model', cluster: 'c', performance: 1 }] : []) }));
        horde_settings.models = ['model'];
        await getHordeModels(true);
    });

    test('shows the provider message and a hint, and throws the same message', async () => {
        fetchResumable.mockResolvedValue(failedResponse(429, '{"error":{"message":"Rate limit reached"}}'));

        await expect(generateHorde('prompt', {}, undefined, nothing)).rejects.toThrow('Horde generation failed: Rate limit reached');

        expect(lastToast()).toEqual({ title: 'Horde generation failed', message: 'Rate limit reached', hintKind: 'rate' });
    });

    test('falls back to the HTTP reason for a body that says nothing', async () => {
        fetchResumable.mockResolvedValue(failedResponse(418, '<html></html>'));

        await expect(generateHorde('prompt', {}, undefined, nothing)).rejects.toThrow('Horde generation failed: Reason');

        expect(lastToast()).toEqual({ title: 'Horde generation failed', message: 'Reason', hintKind: '' });
    });
});

describe('the custom request services', () => {
    test.each([
        ['text completion', () => TextCompletionService.sendRequest({ stream: true })],
        ['chat completion', () => ChatCompletionService.sendRequest({ stream: true })],
    ])('throw the provider message of a failed %s stream', async (_name, run) => {
        fetchResumable.mockResolvedValue(failedResponse(401, '{"error":{"message":"Bad key"}}'));

        await expect(run()).rejects.toThrow('Bad key');
    });

    test('keep the status wording when the provider said nothing', async () => {
        fetchResumable.mockResolvedValue(failedResponse(502, '<html></html>'));

        await expect(TextCompletionService.sendRequest({ stream: true })).rejects.toThrow('Got response status 502');
    });
});
