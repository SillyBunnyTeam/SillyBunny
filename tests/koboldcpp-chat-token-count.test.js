import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';

/**
 * @param {string} name Top-level declaration to take from the KoboldCpp models script
 * @returns {string} Source of that declaration
 */
function getDeclarationSource(name) {
    const source = readFileSync(new URL('../public/scripts/sillybunny-koboldcpp-models.js', import.meta.url), 'utf8');
    const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
    const node = ast.body.map(node => node.declaration ?? node)
        .find(node => node.id?.name === name || node.declarations?.some(item => item.id.name === name));
    if (!node) throw new Error(`Missing declaration: ${name}`);
    return source.slice(node.start, node.end);
}

const fetchMock = jest.fn();
const context = vm.createContext({
    fetch: fetchMock,
    getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
    getServerUrl: () => 'http://localhost:5001',
    textgen_types: { KOBOLDCPP: 'koboldcpp' },
    online_status: 'Valid',
    console: { error: () => {} },
});
vm.runInContext(getDeclarationSource('countKoboldCppChatTokens'), context);

/**
 * @param {object[]} messages Chat Completion messages
 * @returns {Promise<{ count: number|null, text: string }>} Count that the function returned, and the text it sent to KoboldCpp
 */
async function count(messages) {
    const count = await context.countKoboldCppChatTokens(messages);
    const [, options] = fetchMock.mock.calls[0] ?? [];
    return { count, text: options ? JSON.parse(options.body).text : '' };
}

const IMAGE = { type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(4096)}`, detail: 'auto' } };
const AUDIO = { type: 'audio_url', audio_url: { url: `data:audio/wav;base64,${'B'.repeat(4096)}` } };
const VIDEO = { type: 'video_url', video_url: { url: `data:video/mp4;base64,${'C'.repeat(4096)}`, detail: 'auto' } };

describe('KoboldCpp Chat Completion token counts', () => {
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
