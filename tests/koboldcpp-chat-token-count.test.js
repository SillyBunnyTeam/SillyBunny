/* global globalThis */
import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { fileURLToPath } from 'node:url';

const resolvePublic = (relativePath) => fileURLToPath(new URL(`../public/${relativePath}`, import.meta.url));

const fetchMock = jest.fn();
let originalFetch;

await jest.unstable_mockModule(resolvePublic('script.js'), () => ({
    abortStatusCheck: new AbortController(),
    eventSource: { on: () => {} },
    event_types: { ONLINE_STATUS_CHANGED: 'online_status_changed' },
    getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
    is_send_press: false,
    main_api: 'openai',
    online_status: 'Valid',
    resultCheckStatus: () => {},
    setOnlineStatus: () => {},
    startStatusLoading: () => {},
    stopStatusLoading: () => {},
}));
await jest.unstable_mockModule(resolvePublic('scripts/i18n.js'), () => ({
    t: (strings, ...values) => String.raw({ raw: strings }, ...values),
}));
await jest.unstable_mockModule(resolvePublic('scripts/openai.js'), () => ({
    chat_completion_sources: { KOBOLDCPP: 'koboldcpp' },
    getStatusOpen: async () => {},
    oai_settings: { chat_completion_source: 'koboldcpp', koboldcpp_url: 'http://localhost:5001' },
}));
await jest.unstable_mockModule(resolvePublic('scripts/popup.js'), () => ({
    POPUP_TYPE: { TEXT: 1 },
    Popup: class {},
}));
await jest.unstable_mockModule(resolvePublic('scripts/server-history.js'), () => ({
    onServerConnectClick: () => {},
}));
await jest.unstable_mockModule(resolvePublic('scripts/slash-commands/SlashCommand.js'), () => ({
    SlashCommand: { fromProps: props => props },
}));
await jest.unstable_mockModule(resolvePublic('scripts/slash-commands/SlashCommandArgument.js'), () => ({
    ARGUMENT_TYPE: { STRING: 'string' },
    SlashCommandArgument: { fromProps: props => props },
}));
await jest.unstable_mockModule(resolvePublic('scripts/slash-commands/SlashCommandEnumValue.js'), () => ({
    SlashCommandEnumValue: class {},
}));
await jest.unstable_mockModule(resolvePublic('scripts/slash-commands/SlashCommandParser.js'), () => ({
    SlashCommandParser: { addCommandObject: () => {} },
}));
await jest.unstable_mockModule(resolvePublic('scripts/textgen-settings.js'), () => ({
    getStatusTextgen: async () => {},
    getTextGenServer: () => 'http://localhost:5001',
    textgen_types: { KOBOLDCPP: 'koboldcpp' },
    textgenerationwebui_settings: { type: 'koboldcpp', server_urls: { koboldcpp: 'http://localhost:5001' } },
}));
await jest.unstable_mockModule(resolvePublic('scripts/utils.js'), () => ({
    delay: async () => {},
}));

const { countKoboldCppChatTokens } = await import('../public/scripts/sillybunny-koboldcpp-models.js');

/**
 * @param {object[]} messages Chat Completion messages
 * @returns {Promise<{ count: number|null, text: string }>} Count that the function returned, and the text it sent to KoboldCpp
 */
async function count(messages) {
    const tokenCount = await countKoboldCppChatTokens(messages);
    const [, options] = fetchMock.mock.calls[0] ?? [];
    return { count: tokenCount, text: options ? JSON.parse(options.body).text : '' };
}

const IMAGE = { type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(4096)}`, detail: 'auto' } };
const AUDIO = { type: 'audio_url', audio_url: { url: `data:audio/wav;base64,${'B'.repeat(4096)}` } };
const VIDEO = { type: 'video_url', video_url: { url: `data:video/mp4;base64,${'C'.repeat(4096)}`, detail: 'auto' } };

describe('KoboldCpp Chat Completion token counts', () => {
    beforeAll(() => {
        originalFetch = globalThis.fetch;
        globalThis.fetch = fetchMock;
    });

    afterAll(() => {
        globalThis.fetch = originalFetch;
    });

    beforeEach(() => {
        fetchMock.mockReset();
        fetchMock.mockResolvedValue({ ok: true, json: async () => ({ count: 7 }) });
    });

    test('counts roles, names and string content as text', async () => {
        const { count: tokens, text } = await count([
            { role: 'user', content: 'Hello', name: 'Alice' },
            { role: 'assistant', content: 'Hi there' },
        ]);

        expect(tokens).toBe(7);
        expect(text).toBe('user\n\nHello\n\nAlice\n\nassistant\n\nHi there');
        expect(fetchMock.mock.calls[0][0]).toBe('/api/tokenizers/remote/textgenerationwebui/encode');
        expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ api_type: 'koboldcpp', url: 'http://localhost:5001' });
    });

    test('counts the text parts of a message and leaves out its media', async () => {
        const { text } = await count([
            { role: 'user', content: [{ type: 'text', text: 'Describe this picture.' }, IMAGE, AUDIO, VIDEO, { type: 'text', text: 'Then the clip.' }] },
        ]);

        expect(text).toBe('user\n\nDescribe this picture.\n\nThen the clip.');
    });

    test('counts a message that holds only media as its role', async () => {
        const { text } = await count([{ role: 'user', content: [IMAGE] }]);

        expect(text).toBe('user');
    });

    test('keeps counting the tool calls of a message', async () => {
        const toolCalls = [{ id: 'call_1', type: 'function', function: { name: 'roll', arguments: '{"sides":6}' } }];
        const { text } = await count([{ role: 'assistant', content: '', tool_calls: toolCalls }]);

        expect(text).toBe(`assistant\n\n\n\n${JSON.stringify(toolCalls)}`);
    });
});
