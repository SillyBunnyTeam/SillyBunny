import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../src/endpoints/openrouter.js', import.meta.url), 'utf8');
const routeSource = source.slice(source.indexOf('const API_OPENROUTER ='), source.indexOf('router.post(\'/models/providers\''));

describe('OpenRouter POST /providers', () => {
    let fetch;
    let handler;
    let res;

    beforeEach(() => {
        fetch = jest.fn();
        res = { json: jest.fn(), sendStatus: jest.fn() };
        const post = jest.fn();
        runInNewContext(routeSource, {
            router: { post },
            fetch,
            AbortSignal,
            console: { warn: jest.fn() },
        });
        handler = post.mock.calls.find(([path]) => path === '/providers')[1];
    });

    test('uses the fixed public URL without auth and returns sorted, deduplicated valid names', async () => {
        fetch.mockResolvedValue({
            ok: true,
            json: async () => ({
                data: [
                    { name: 'Zeta' }, { name: 'Alpha' }, { name: 'Zeta' }, { name: 'Beta' },
                    null, {}, { name: 42 }, { name: '' }, { name: '   ' },
                ],
            }),
        });

        await handler({
            body: { url: 'https://example.invalid/providers', api_key: 'do-not-forward' },
            headers: { authorization: 'Bearer do-not-forward' },
        }, res);

        expect(fetch).toHaveBeenCalledTimes(1);
        const [url, options] = fetch.mock.calls[0];
        expect(url).toBe('https://openrouter.ai/api/v1/providers');
        expect(options.headers).toEqual({ Accept: 'application/json' });
        expect(options.method ?? 'GET').toBe('GET');
        expect(options.body).toBeUndefined();
        expect(options.signal).toBeInstanceOf(AbortSignal);
        expect(res.json).toHaveBeenCalledTimes(1);
        expect(res.json).toHaveBeenCalledWith(['Alpha', 'Beta', 'Zeta']);
        expect(res.sendStatus).not.toHaveBeenCalled();
    });

    test.each([
        ['upstream HTTP failure', { ok: false }],
        ['null payload', { ok: true, json: async () => null }],
        ['missing data', { ok: true, json: async () => ({}) }],
        ['non-array data', { ok: true, json: async () => ({ data: {} }) }],
        ['empty catalogue', { ok: true, json: async () => ({ data: [] }) }],
        ['no valid names', { ok: true, json: async () => ({ data: [null, {}, { name: 1 }, { name: '' }, { name: ' \t' }] }) }],
        ['invalid JSON', { ok: true, json: async () => { throw new SyntaxError('Invalid JSON'); } }],
    ])('returns 502 for %s', async (_name, response) => {
        fetch.mockResolvedValue(response);

        await handler({}, res);

        expect(res.sendStatus).toHaveBeenCalledTimes(1);
        expect(res.sendStatus).toHaveBeenCalledWith(502);
        expect(res.json).not.toHaveBeenCalled();
    });

    test('returns 502 when the request throws', async () => {
        fetch.mockRejectedValue(new Error('Network unavailable'));

        await handler({}, res);

        expect(res.sendStatus).toHaveBeenCalledTimes(1);
        expect(res.sendStatus).toHaveBeenCalledWith(502);
        expect(res.json).not.toHaveBeenCalled();
    });
});
