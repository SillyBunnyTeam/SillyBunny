/* eslint-disable jest/no-conditional-expect -- Assertions branch on the parameterized provider shape. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import { fileURLToPath } from 'node:url';

import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));

const nodeFetchMock = jest.fn();
await jest.unstable_mockModule('node-fetch', () => ({
    default: nodeFetchMock,
}));

const { router: openrouterRouter } = await import('../src/endpoints/openrouter.js');
const { router: nanogptRouter } = await import('../src/endpoints/nanogpt.js');

let server;
let baseUrl;

beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/openrouter', openrouterRouter);
    app.use('/api/nanogpt', nanogptRouter);

    await new Promise((resolve) => {
        server = app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
    if (server) {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
});

beforeEach(() => {
    nodeFetchMock.mockReset();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    jest.restoreAllMocks();
});

function postJson(route, body = {}, headers = {}) {
    return fetch(`${baseUrl}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
    });
}

describe.each(['openrouter', 'nanogpt'])('%s POST /providers', (provider) => {
    const nano = provider === 'nanogpt';

    test('uses the fixed public URL without auth and returns sorted, deduplicated valid names', async () => {
        nodeFetchMock.mockResolvedValue({
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

        const response = await postJson(
            `/api/${provider}/providers`,
            { url: 'https://example.invalid/providers', api_key: 'do-not-forward' },
            { authorization: 'Bearer do-not-forward' },
        );

        expect(response.status).toBe(200);
        expect(nodeFetchMock).toHaveBeenCalledTimes(1);
        const [url, options] = nodeFetchMock.mock.calls[0];
        expect(url).toBe(nano ? 'https://nano-gpt.com/api/models/providers' : 'https://openrouter.ai/api/v1/providers');
        expect(options.headers).toEqual({ Accept: 'application/json' });
        expect(options.method ?? 'GET').toBe('GET');
        expect(options.body).toBeUndefined();
        expect(options.signal).toBeInstanceOf(AbortSignal);
        await expect(response.json()).resolves.toEqual(
            nano
                ? [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }, { id: 'z', label: 'Zeta' }]
                : ['Alpha', 'Beta', 'Zeta'],
        );
    });

    test.each([
        ['upstream HTTP failure', { ok: false }],
        ['null payload', { ok: true, json: async () => null }],
        ['missing data', { ok: true, json: async () => ({}) }],
        ['non-array data', { ok: true, json: async () => (nano ? { providers: {} } : { data: {} }) }],
        ['empty catalogue', { ok: true, json: async () => (nano ? { providers: [] } : { data: [] }) }],
        ['no valid names', {
            ok: true,
            json: async () => (nano
                ? { providers: [null, {}, { id: 1, label: 'No' }, { id: '', label: 'No' }, { id: 'a', label: ' \t' }] }
                : { data: [null, {}, { name: 1 }, { name: '' }, { name: ' \t' }] }),
        }],
        ['invalid JSON', { ok: true, json: async () => { throw new SyntaxError('Invalid JSON'); } }],
    ])('returns 502 for %s', async (_name, upstreamResponse) => {
        nodeFetchMock.mockResolvedValue(upstreamResponse);

        const response = await postJson(`/api/${provider}/providers`);

        expect(response.status).toBe(502);
    });

    test('returns 502 when the request throws', async () => {
        nodeFetchMock.mockRejectedValue(new Error('Network unavailable'));

        const response = await postJson(`/api/${provider}/providers`);

        expect(response.status).toBe(502);
    });
});

test('OpenRouter endpoint discovery exposes documented tiers and preserves its legacy response', async () => {
    nodeFetchMock.mockImplementation(async () => ({
        ok: true,
        json: async () => ({
            data: {
                endpoints: [
                    { provider_name: 'OpenAI', tag: 'openai/flex' },
                    { provider_name: 'OpenAI', tag: 'openai/fast' },
                    { provider_name: 'Azure', tag: 'azure/priority' },
                    { provider_name: 'Other', tag: 'other-fast' },
                    null,
                ],
            },
        }),
    }));

    const tiersResponse = await postJson('/api/openrouter/models/providers', {
        model: 'author/model?query#fragment',
        include_service_tiers: true,
    });
    expect(tiersResponse.status).toBe(200);
    expect(nodeFetchMock.mock.calls[0][0]).toBe('https://openrouter.ai/api/v1/models/author/model%3Fquery%23fragment/endpoints');
    await expect(tiersResponse.json()).resolves.toEqual({
        providers: ['OpenAI', 'Azure', 'Other'],
        service_tiers: ['flex', 'priority'],
    });

    const legacyResponse = await postJson('/api/openrouter/models/providers', { model: 'author/model' });
    expect(legacyResponse.status).toBe(200);
    await expect(legacyResponse.json()).resolves.toEqual(['OpenAI', 'Azure', 'Other']);

    nodeFetchMock.mockResolvedValueOnce({ ok: false });
    const failedResponse = await postJson('/api/openrouter/models/providers', {
        model: 'author/model',
        include_service_tiers: true,
    });
    expect(failedResponse.status).toBe(502);
});
