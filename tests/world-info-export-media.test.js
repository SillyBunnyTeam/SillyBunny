/* global globalThis */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const getRequestHeaders = jest.fn(() => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'token' }));

await jest.unstable_mockModule('../public/script.js', () => ({
    getRequestHeaders,
}));

const { getWorldInfoExportText } = await import('../public/scripts/sillybunny-world-info-export.js');

describe('lorebook export text', () => {
    const data = { entries: { 0: { uid: 0, content: '![a](/user/images/Atlas/a-0123456789abcdef.png)' } } };
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        jest.restoreAllMocks();
    });

    test('uses the copy that the server gives back, with the editor data in the request', async () => {
        const restored = '{"entries":{"0":{"uid":0,"content":"![a](https://files.catbox.moe/a.png)"}}}';
        globalThis.fetch = jest.fn(async () => ({ ok: true, text: async () => restored }));

        await expect(getWorldInfoExportText(data)).resolves.toBe(restored);

        const [url, options] = globalThis.fetch.mock.calls[0];
        expect(url).toBe('/api/worldinfo/export');
        expect(options.method).toBe('POST');
        expect(options.headers['X-CSRF-Token']).toBe('token');
        expect(JSON.parse(options.body)).toEqual({ data });
    });

    test.each([
        ['an answer that is not ok', async () => ({ ok: false, text: async () => 'Bad Request' })],
        ['a request that fails', async () => { throw new Error('offline'); }],
    ])('exports the editor data as it is after %s', async (_label, implementation) => {
        globalThis.fetch = jest.fn(implementation);

        await expect(getWorldInfoExportText(data)).resolves.toBe(JSON.stringify(data));
    });
});
