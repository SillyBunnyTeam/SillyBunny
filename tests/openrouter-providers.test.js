import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

describe.each(['openrouter', 'nanogpt'])('%s POST /providers', (provider) => {
    const nano = provider === 'nanogpt';
    const source = readFileSync(new URL(`../src/endpoints/${provider}.js`, import.meta.url), 'utf8');
    const routeSource = source.slice(source.indexOf(`const API_${provider.toUpperCase()} =`), source.indexOf(`router.post('${nano ? '/credits' : '/models/providers'}'`));
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
            json: async () => nano ? {
                providers: [
                    { id: 'z', label: 'Zeta', secret: 'strip-me' }, { id: 'a', label: 'Alpha' },
                    { id: 'z', label: 'Zeta' }, { id: 'b', label: 'Beta' }, null, {},
                    { id: 42, label: 'No' }, { id: 'no-label' }, { id: ' ', label: 'No' },
                ],
            } : {
                data: [
                    { name: 'Zeta' }, { name: 'Alpha' }, { name: 'Zeta' }, { name: 'Beta' },
                    null, {}, { name: 42 }, { name: '' }, { name: '   ' },
                ],
            },
        });

        await handler({
            body: { url: 'https://example.invalid/providers', api_key: 'do-not-forward' },
            headers: { authorization: 'Bearer do-not-forward' },
        }, res);

        expect(fetch).toHaveBeenCalledTimes(1);
        const [url, options] = fetch.mock.calls[0];
        expect(url).toBe(nano ? 'https://nano-gpt.com/api/models/providers' : 'https://openrouter.ai/api/v1/providers');
        expect(options.headers).toEqual({ Accept: 'application/json' });
        expect(options.method ?? 'GET').toBe('GET');
        expect(options.body).toBeUndefined();
        expect(options.signal).toBeInstanceOf(AbortSignal);
        expect(res.json).toHaveBeenCalledTimes(1);
        expect(res.json).toHaveBeenCalledWith(nano ? [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }, { id: 'z', label: 'Zeta' }] : ['Alpha', 'Beta', 'Zeta']);
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

test('OpenRouter endpoint discovery exposes documented tiers and preserves its legacy response', async () => {
    const source = readFileSync(new URL('../src/endpoints/openrouter.js', import.meta.url), 'utf8');
    const code = source.slice(source.indexOf("router.post('/models/providers'"), source.indexOf("router.post('/models/multimodal'"));
    const post = jest.fn();
    const fetch = jest.fn(async () => ({ ok: true, json: async () => ({ data: { endpoints: [
        { provider_name: 'OpenAI', tag: 'openai/flex' },
        { provider_name: 'OpenAI', tag: 'openai/fast' },
        { provider_name: 'Azure', tag: 'azure/priority' },
        { provider_name: 'Other', tag: 'other-fast' },
        null,
    ] } }) }));
    runInNewContext(code, { router: { post }, fetch, API_OPENROUTER: 'https://openrouter.ai/api/v1', AbortSignal, console });
    const handler = post.mock.calls[0][1];
    const res = { json: jest.fn(), sendStatus: jest.fn() };
    await handler({ body: { model: 'author/model?query#fragment', include_service_tiers: true } }, res);
    expect(fetch.mock.calls[0][0]).toBe('https://openrouter.ai/api/v1/models/author/model%3Fquery%23fragment/endpoints');
    expect(res.json).toHaveBeenLastCalledWith({ providers: ['OpenAI', 'Azure', 'Other'], service_tiers: ['flex', 'priority'] });
    await handler({ body: { model: 'author/model' } }, res);
    expect(res.json).toHaveBeenLastCalledWith(['OpenAI', 'Azure', 'Other']);
    fetch.mockResolvedValueOnce({ ok: false });
    await handler({ body: { model: 'author/model', include_service_tiers: true } }, res);
    expect(res.sendStatus).toHaveBeenLastCalledWith(502);
});
