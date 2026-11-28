import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';

import {
    STANDARD_UPSTREAM_ERRORS,
    createFakeUpstreamServer,
    createLoopbackNetworkGuard,
    initContractConfig,
    jsonReply,
    startContractApp,
} from './util/lower-risk-contract-harness.js';

const { default: actualNodeFetch } = await import('node-fetch');

let fakeServer = null;
let app = null;

const networkGuard = createLoopbackNetworkGuard({
    getFakeServer: () => fakeServer,
    getAllowedPorts: () => [app?.port],
    actualNodeFetch,
});

await jest.unstable_mockModule('node-fetch', () => ({
    default: networkGuard.guardedNodeFetch,
}));

const contractConfig = await initContractConfig('sillybunny-vectors-cfg-');

const { router: vectorsRouter } = await import('../src/endpoints/vectors.js');
const { router: openAiRouter } = await import('../src/endpoints/openai.js');
const { router: openRouterRouter } = await import('../src/endpoints/openrouter.js');
const { SECRET_KEYS } = await import('../src/endpoints/secrets.js');

const ALL_VECTOR_SECRETS = {
    [SECRET_KEYS.OPENAI]: 'test-openai-key',
    [SECRET_KEYS.TOGETHERAI]: 'test-together-key',
    [SECRET_KEYS.MISTRALAI]: 'test-mistral-key',
    [SECRET_KEYS.ELECTRONHUB]: 'test-electronhub-key',
    [SECRET_KEYS.OPENROUTER]: 'test-openrouter-key',
    [SECRET_KEYS.CHUTES]: 'test-chutes-key',
    [SECRET_KEYS.NANOGPT]: 'test-nanogpt-key',
    [SECRET_KEYS.SILICONFLOW]: 'test-siliconflow-key',
    [SECRET_KEYS.WORKERS_AI]: 'test-workers-ai-key',
    [SECRET_KEYS.NOMICAI]: 'test-nomic-key',
    [SECRET_KEYS.COHERE]: 'test-cohere-key',
    [SECRET_KEYS.MAKERSUITE]: 'test-makersuite-key',
    [SECRET_KEYS.VERTEXAI]: 'test-vertex-key',
};

const DOC_ALPHA_VECTOR = [1, 0, 0, 0];
const DOC_BETA_VECTOR = [0, 1, 0, 0];

const VECTOR_PROVIDERS = [
    {
        name: 'openai',
        source: 'openai',
        secretKey: SECRET_KEYS.OPENAI,
        body: { model: 'text-embedding-3-small' },
        expectedUrl: 'https://api.openai.com/v1/embeddings',
        expectedAuthHeader: ['authorization', 'Bearer test-openai-key'],
        assertInsertBody: (req) => {
            expect(req.json).toEqual({
                input: ['alpha memory', 'beta memory'],
                model: 'text-embedding-3-small',
            });
        },
        assertQueryBody: (req) => {
            expect(req.json).toEqual({
                input: ['find alpha'],
                model: 'text-embedding-3-small',
            });
        },
        insertReply: () => jsonReply({
            // Reverse index order verifies extractOpenAIEmbeddings sorts by index.
            data: [
                { index: 1, embedding: DOC_BETA_VECTOR },
                { index: 0, embedding: DOC_ALPHA_VECTOR },
            ],
        }),
        queryReply: () => jsonReply({
            data: [{ index: 0, embedding: DOC_ALPHA_VECTOR }],
        }),
        malformedReply: () => jsonReply({ data: 'not-an-array' }),
    },
    {
        name: 'togetherai',
        source: 'togetherai',
        secretKey: SECRET_KEYS.TOGETHERAI,
        body: { model: 'togethercomputer/m2-bert-80M-32k-retrieval' },
        expectedUrl: 'https://api.together.xyz/v1/embeddings',
        expectedAuthHeader: ['authorization', 'Bearer test-together-key'],
        assertInsertBody: (req) => {
            expect(req.json).toEqual({
                input: ['alpha memory', 'beta memory'],
                model: 'togethercomputer/m2-bert-80M-32k-retrieval',
            });
        },
        assertQueryBody: (req) => {
            expect(req.json.input).toEqual(['find alpha']);
        },
        insertReply: () => jsonReply({
            data: [
                { index: 0, embedding: DOC_ALPHA_VECTOR },
                { index: 1, embedding: DOC_BETA_VECTOR },
            ],
        }),
        queryReply: () => jsonReply({ data: [{ index: 0, embedding: DOC_ALPHA_VECTOR }] }),
        malformedReply: () => jsonReply({ unexpected: true }),
    },
    {
        name: 'mistral',
        source: 'mistral',
        secretKey: SECRET_KEYS.MISTRALAI,
        body: {},
        expectedUrl: 'https://api.mistral.ai/v1/embeddings',
        expectedAuthHeader: ['authorization', 'Bearer test-mistral-key'],
        assertInsertBody: (req) => {
            expect(req.json).toEqual({
                input: ['alpha memory', 'beta memory'],
                model: 'mistral-embed',
            });
        },
        assertQueryBody: (req) => {
            expect(req.json).toEqual({
                input: ['find alpha'],
                model: 'mistral-embed',
            });
        },
        insertReply: () => jsonReply({
            data: [
                { index: 0, embedding: DOC_ALPHA_VECTOR },
                { index: 1, embedding: DOC_BETA_VECTOR },
            ],
        }),
        queryReply: () => jsonReply({ data: [{ index: 0, embedding: DOC_ALPHA_VECTOR }] }),
        malformedReply: () => jsonReply({ data: null }),
    },
    {
        name: 'electronhub',
        source: 'electronhub',
        secretKey: SECRET_KEYS.ELECTRONHUB,
        body: { model: 'text-embedding-3-large' },
        expectedUrl: 'https://api.electronhub.ai/v1/embeddings',
        expectedAuthHeader: ['authorization', 'Bearer test-electronhub-key'],
        assertInsertBody: (req) => {
            expect(req.json).toEqual({
                input: ['alpha memory', 'beta memory'],
                model: 'text-embedding-3-large',
            });
        },
        assertQueryBody: (req) => {
            expect(req.json.model).toBe('text-embedding-3-large');
        },
        insertReply: () => jsonReply({
            data: [
                { index: 0, embedding: DOC_ALPHA_VECTOR },
                { index: 1, embedding: DOC_BETA_VECTOR },
            ],
        }),
        queryReply: () => jsonReply({ data: [{ index: 0, embedding: DOC_ALPHA_VECTOR }] }),
        malformedReply: () => jsonReply({}),
    },
    {
        name: 'openrouter',
        source: 'openrouter',
        secretKey: SECRET_KEYS.OPENROUTER,
        body: { model: 'openai/text-embedding-3-large' },
        expectedUrl: 'https://openrouter.ai/api/v1/embeddings',
        expectedAuthHeader: ['authorization', 'Bearer test-openrouter-key'],
        assertInsertBody: (req) => {
            expect(req.headers['http-referer']).toBeTruthy();
            expect(req.headers['x-title']).toBeTruthy();
            expect(req.json).toEqual({
                input: ['alpha memory', 'beta memory'],
                model: 'openai/text-embedding-3-large',
            });
        },
        assertQueryBody: (req) => {
            expect(req.json.model).toBe('openai/text-embedding-3-large');
        },
        insertReply: () => jsonReply({
            data: [
                { index: 0, embedding: DOC_ALPHA_VECTOR },
                { index: 1, embedding: DOC_BETA_VECTOR },
            ],
        }),
        queryReply: () => jsonReply({ data: [{ index: 0, embedding: DOC_ALPHA_VECTOR }] }),
        malformedReply: () => jsonReply({ data: {} }),
    },
    {
        name: 'chutes',
        source: 'chutes',
        secretKey: SECRET_KEYS.CHUTES,
        body: { model: 'chutes-qwen-qwen3-embedding-8b' },
        expectedUrl: 'https://chutes-qwen-qwen3-embedding-8b.chutes.ai/v1/embeddings',
        expectedAuthHeader: ['authorization', 'Bearer test-chutes-key'],
        assertInsertBody: (req) => {
            // Chutes encodes the model in the subdomain and sets body.model to null.
            expect(req.json).toEqual({
                input: ['alpha memory', 'beta memory'],
                model: null,
            });
        },
        assertQueryBody: (req) => {
            expect(req.json).toEqual({
                input: ['find alpha'],
                model: null,
            });
        },
        insertReply: () => jsonReply({
            data: [
                { index: 0, embedding: DOC_ALPHA_VECTOR },
                { index: 1, embedding: DOC_BETA_VECTOR },
            ],
        }),
        queryReply: () => jsonReply({ data: [{ index: 0, embedding: DOC_ALPHA_VECTOR }] }),
        malformedReply: () => jsonReply({ data: 'bad' }),
    },
    {
        name: 'nanogpt',
        source: 'nanogpt',
        secretKey: SECRET_KEYS.NANOGPT,
        body: { model: 'text-embedding-3-small' },
        expectedUrl: 'https://nano-gpt.com/api/v1/embeddings',
        expectedAuthHeader: ['authorization', 'Bearer test-nanogpt-key'],
        assertInsertBody: (req) => {
            expect(req.json).toEqual({
                input: ['alpha memory', 'beta memory'],
                model: 'text-embedding-3-small',
            });
        },
        assertQueryBody: (req) => {
            expect(req.json.input).toEqual(['find alpha']);
        },
        insertReply: () => jsonReply({
            data: [
                { index: 0, embedding: DOC_ALPHA_VECTOR },
                { index: 1, embedding: DOC_BETA_VECTOR },
            ],
        }),
        queryReply: () => jsonReply({ data: [{ index: 0, embedding: DOC_ALPHA_VECTOR }] }),
        malformedReply: () => jsonReply({}),
    },
    {
        name: 'siliconflow-global',
        source: 'siliconflow',
        secretKey: SECRET_KEYS.SILICONFLOW,
        body: { model: 'Qwen/Qwen3-Embedding-0.6B' },
        expectedUrl: 'https://api.siliconflow.com/v1/embeddings',
        expectedAuthHeader: ['authorization', 'Bearer test-siliconflow-key'],
        assertInsertBody: (req) => {
            expect(req.json).toEqual({
                input: ['alpha memory', 'beta memory'],
                model: 'Qwen/Qwen3-Embedding-0.6B',
            });
        },
        assertQueryBody: (req) => {
            expect(req.json.model).toBe('Qwen/Qwen3-Embedding-0.6B');
        },
        insertReply: () => jsonReply({
            data: [
                { index: 0, embedding: DOC_ALPHA_VECTOR },
                { index: 1, embedding: DOC_BETA_VECTOR },
            ],
        }),
        queryReply: () => jsonReply({ data: [{ index: 0, embedding: DOC_ALPHA_VECTOR }] }),
        malformedReply: () => jsonReply({}),
    },
    {
        name: 'siliconflow-cn',
        source: 'siliconflow',
        secretKey: SECRET_KEYS.SILICONFLOW,
        body: { model: 'Qwen/Qwen3-Embedding-0.6B', siliconflow_endpoint: 'cn' },
        expectedUrl: 'https://api.siliconflow.cn/v1/embeddings',
        expectedAuthHeader: ['authorization', 'Bearer test-siliconflow-key'],
        assertInsertBody: (req) => {
            expect(req.json.model).toBe('Qwen/Qwen3-Embedding-0.6B');
        },
        assertQueryBody: (req) => {
            expect(req.json.input).toEqual(['find alpha']);
        },
        insertReply: () => jsonReply({
            data: [
                { index: 0, embedding: DOC_ALPHA_VECTOR },
                { index: 1, embedding: DOC_BETA_VECTOR },
            ],
        }),
        queryReply: () => jsonReply({ data: [{ index: 0, embedding: DOC_ALPHA_VECTOR }] }),
        malformedReply: () => jsonReply({}),
    },
    {
        name: 'workers_ai',
        source: 'workers_ai',
        secretKey: SECRET_KEYS.WORKERS_AI,
        body: { model: '@cf/baai/bge-m3', workers_ai_account_id: 'acct-42' },
        expectedUrl: 'https://api.cloudflare.com/client/v4/accounts/acct-42/ai/v1/embeddings',
        expectedAuthHeader: ['authorization', 'Bearer test-workers-ai-key'],
        assertInsertBody: (req) => {
            expect(req.json).toEqual({
                input: ['alpha memory', 'beta memory'],
                model: '@cf/baai/bge-m3',
            });
        },
        assertQueryBody: (req) => {
            expect(req.json.model).toBe('@cf/baai/bge-m3');
        },
        insertReply: () => jsonReply({
            data: [
                { index: 0, embedding: DOC_ALPHA_VECTOR },
                { index: 1, embedding: DOC_BETA_VECTOR },
            ],
        }),
        queryReply: () => jsonReply({ data: [{ index: 0, embedding: DOC_ALPHA_VECTOR }] }),
        malformedReply: () => jsonReply({}),
    },
    {
        name: 'nomicai',
        source: 'nomicai',
        secretKey: SECRET_KEYS.NOMICAI,
        body: {},
        expectedUrl: 'https://api-atlas.nomic.ai/v1/embedding/text',
        expectedAuthHeader: ['authorization', 'Bearer test-nomic-key'],
        assertInsertBody: (req) => {
            expect(req.json).toEqual({
                texts: ['alpha memory', 'beta memory'],
                model: 'nomic-embed-text-v1.5',
            });
        },
        assertQueryBody: (req) => {
            expect(req.json).toEqual({
                texts: ['find alpha'],
                model: 'nomic-embed-text-v1.5',
            });
        },
        insertReply: () => jsonReply({ embeddings: [DOC_ALPHA_VECTOR, DOC_BETA_VECTOR] }),
        queryReply: () => jsonReply({ embeddings: [DOC_ALPHA_VECTOR] }),
        malformedReply: () => jsonReply({ embeddings: 'bad' }),
    },
    {
        name: 'cohere',
        source: 'cohere',
        secretKey: SECRET_KEYS.COHERE,
        body: { model: 'embed-english-v3.0' },
        expectedUrl: 'https://api.cohere.ai/v2/embed',
        expectedAuthHeader: ['authorization', 'Bearer test-cohere-key'],
        assertInsertBody: (req) => {
            expect(req.json).toEqual({
                texts: ['alpha memory', 'beta memory'],
                model: 'embed-english-v3.0',
                embedding_types: ['float'],
                input_type: 'search_document',
                truncate: 'END',
            });
        },
        assertQueryBody: (req) => {
            expect(req.json).toEqual({
                texts: ['find alpha'],
                model: 'embed-english-v3.0',
                embedding_types: ['float'],
                input_type: 'search_query',
                truncate: 'END',
            });
        },
        insertReply: () => jsonReply({ embeddings: { float: [DOC_ALPHA_VECTOR, DOC_BETA_VECTOR] } }),
        queryReply: () => jsonReply({ embeddings: { float: [DOC_ALPHA_VECTOR] } }),
        malformedReply: () => jsonReply({ embeddings: {} }),
    },
    {
        name: 'palm-makersuite',
        source: 'palm',
        secretKey: SECRET_KEYS.MAKERSUITE,
        body: { model: 'text-embedding-005', api: 'makersuite' },
        expectedUrl: 'https://generativelanguage.googleapis.com/v1beta/models/text-embedding-005:batchEmbedContents',
        expectedAuthHeader: ['x-goog-api-key', 'test-makersuite-key'],
        assertInsertBody: (req) => {
            expect(req.json).toEqual({
                requests: [
                    { model: 'models/text-embedding-005', content: { parts: [{ text: 'alpha memory' }] } },
                    { model: 'models/text-embedding-005', content: { parts: [{ text: 'beta memory' }] } },
                ],
            });
        },
        assertQueryBody: (req) => {
            expect(req.json).toEqual({
                requests: [
                    { model: 'models/text-embedding-005', content: { parts: [{ text: 'find alpha' }] } },
                ],
            });
        },
        insertReply: () => jsonReply({
            embeddings: [
                { values: DOC_ALPHA_VECTOR },
                { values: DOC_BETA_VECTOR },
            ],
        }),
        queryReply: () => jsonReply({ embeddings: [{ values: DOC_ALPHA_VECTOR }] }),
        malformedReply: () => jsonReply({ embeddings: null }),
    },
    {
        name: 'vertexai-express',
        source: 'vertexai',
        secretKey: SECRET_KEYS.VERTEXAI,
        body: {
            model: 'text-embedding-005',
            api: 'vertexai',
            vertexai_auth_mode: 'express',
            vertexai_region: 'us-central1',
            vertexai_express_project_id: 'demo-proj',
        },
        expectedUrl: 'https://us-central1-aiplatform.googleapis.com/v1/projects/demo-proj/locations/us-central1/publishers/google/models/text-embedding-005:predict',
        expectedAuthHeader: ['x-goog-api-key', 'test-vertex-key'],
        assertInsertBody: (req) => {
            expect(req.json).toEqual({
                instances: [
                    { content: 'alpha memory' },
                    { content: 'beta memory' },
                ],
            });
        },
        assertQueryBody: (req) => {
            expect(req.json).toEqual({
                instances: [{ content: 'find alpha' }],
            });
        },
        insertReply: () => jsonReply({
            predictions: [
                { embeddings: { values: DOC_ALPHA_VECTOR } },
                { embeddings: { values: DOC_BETA_VECTOR } },
            ],
        }),
        queryReply: () => jsonReply({ predictions: [{ embeddings: { values: DOC_ALPHA_VECTOR } }] }),
        malformedReply: () => jsonReply({ predictions: null }),
    },
    {
        name: 'ollama',
        source: 'ollama',
        secretKey: null,
        body: () => ({ apiUrl: fakeServer.baseUrl, model: 'nomic-embed-text', keep: true }),
        expectedUrl: () => `${fakeServer.baseUrl}/api/embed`,
        expectedAuthHeader: null,
        assertInsertBody: (req) => {
            expect(req.json).toEqual({
                input: ['alpha memory', 'beta memory'],
                model: 'nomic-embed-text',
                keep_alive: -1,
                truncate: true,
            });
        },
        assertQueryBody: (req) => {
            expect(req.json).toEqual({
                input: ['find alpha'],
                model: 'nomic-embed-text',
                keep_alive: -1,
                truncate: true,
            });
        },
        insertReply: () => jsonReply({ embeddings: [DOC_ALPHA_VECTOR, DOC_BETA_VECTOR] }),
        queryReply: () => jsonReply({ embeddings: [DOC_ALPHA_VECTOR] }),
        malformedReply: () => jsonReply({ embeddings: 'bad' }),
    },
    {
        name: 'llamacpp',
        source: 'llamacpp',
        secretKey: null,
        body: () => ({ apiUrl: `${fakeServer.baseUrl}/v1` }),
        expectedUrl: () => `${fakeServer.baseUrl}/v1/embeddings`,
        expectedAuthHeader: null,
        assertInsertBody: (req) => {
            expect(req.json).toEqual({ input: ['alpha memory', 'beta memory'] });
        },
        assertQueryBody: (req) => {
            expect(req.json).toEqual({ input: ['find alpha'] });
        },
        insertReply: () => jsonReply({
            data: [
                { index: 0, embedding: DOC_ALPHA_VECTOR },
                { index: 1, embedding: DOC_BETA_VECTOR },
            ],
        }),
        queryReply: () => jsonReply({ data: [{ index: 0, embedding: DOC_ALPHA_VECTOR }] }),
        malformedReply: () => jsonReply({ data: null }),
    },
    {
        name: 'vllm',
        source: 'vllm',
        secretKey: null,
        body: () => ({ apiUrl: `${fakeServer.baseUrl}/v1`, model: 'intfloat/e5-mistral-7b' }),
        expectedUrl: () => `${fakeServer.baseUrl}/v1/embeddings`,
        expectedAuthHeader: null,
        assertInsertBody: (req) => {
            expect(req.json).toEqual({
                input: ['alpha memory', 'beta memory'],
                model: 'intfloat/e5-mistral-7b',
            });
        },
        assertQueryBody: (req) => {
            expect(req.json).toEqual({
                input: ['find alpha'],
                model: 'intfloat/e5-mistral-7b',
            });
        },
        insertReply: () => jsonReply({
            data: [
                { index: 0, embedding: DOC_ALPHA_VECTOR },
                { index: 1, embedding: DOC_BETA_VECTOR },
            ],
        }),
        queryReply: () => jsonReply({ data: [{ index: 0, embedding: DOC_ALPHA_VECTOR }] }),
        malformedReply: () => jsonReply({ data: null }),
    },
    {
        name: 'extras',
        source: 'extras',
        secretKey: null,
        body: () => ({ extrasUrl: fakeServer.baseUrl, extrasKey: 'extras-secret' }),
        expectedUrl: () => `${fakeServer.baseUrl}/api/embeddings/compute`,
        expectedAuthHeader: ['authorization', 'Bearer extras-secret'],
        assertInsertBody: (req) => {
            expect(req.json).toEqual({ text: ['alpha memory', 'beta memory'] });
        },
        assertQueryBody: (req) => {
            expect(req.json).toEqual({ text: 'find alpha' });
        },
        insertReply: () => jsonReply({ embedding: [DOC_ALPHA_VECTOR, DOC_BETA_VECTOR] }),
        queryReply: () => jsonReply({ embedding: DOC_ALPHA_VECTOR }),
        malformedReply: () => jsonReply({ embedding: null }),
    },
];

describe('Vectors endpoint contract matrix', () => {
    beforeAll(async () => {
        fakeServer = await createFakeUpstreamServer();
        app = await startContractApp({
            routes: [
                ['/api/vector', vectorsRouter],
                ['/api/openai', openAiRouter],
                ['/api/openrouter', openRouterRouter],
            ],
            tempPrefix: 'sillybunny-vectors-contract-',
            secrets: ALL_VECTOR_SECRETS,
            skipConfigInit: true,
        });
    });

    beforeEach(() => {
        fakeServer.reset();
        networkGuard.setBlockExternal(false);
        app.resetUser(ALL_VECTOR_SECRETS);
    });

    afterAll(async () => {
        networkGuard.restore();
        await app?.close();
        await fakeServer?.close();
        contractConfig.cleanup();
    });

    describe.each(VECTOR_PROVIDERS)('provider $name', (provider) => {
        const resolveBody = () => (typeof provider.body === 'function' ? provider.body() : provider.body);
        const resolveUrl = () => (typeof provider.expectedUrl === 'function' ? provider.expectedUrl() : provider.expectedUrl);

        test('sends expected insert and query requests and retrieves ranked matches from Vectra', async () => {
            fakeServer.enqueue(provider.insertReply(), provider.queryReply());

            const insertRes = await app.postJson('/api/vector/insert', {
                collectionId: `col-${provider.name}`,
                source: provider.source,
                ...resolveBody(),
                items: [
                    { hash: 101, text: 'alpha memory', index: 0 },
                    { hash: 202, text: 'beta memory', index: 1 },
                ],
            });
            expect(insertRes.status).toBe(200);

            const queryRes = await app.postJson('/api/vector/query', {
                collectionId: `col-${provider.name}`,
                source: provider.source,
                ...resolveBody(),
                searchText: 'find alpha',
                topK: 2,
                threshold: 0.5,
            });
            expect(queryRes.status).toBe(200);
            expect(queryRes.json.metadata).toHaveLength(1);
            expect(queryRes.json.metadata[0]).toMatchObject({ hash: 101, text: 'alpha memory', index: 0 });
            expect(queryRes.json.hashes[0]).toBe(101);

            expect(fakeServer.requests).toHaveLength(2);
            const [insertReq, queryReq] = fakeServer.requests;
            expect(insertReq.method).toBe('POST');
            expect(insertReq.originalUrl).toBe(resolveUrl());
            expect(queryReq.method).toBe('POST');
            expect(queryReq.originalUrl).toBe(resolveUrl());
            const authHeaderName = provider.expectedAuthHeader?.[0];
            const authHeaderValue = provider.expectedAuthHeader?.[1] ?? null;
            expect(authHeaderName ? insertReq.headers[authHeaderName] : null).toBe(authHeaderValue);
            expect(authHeaderName ? queryReq.headers[authHeaderName] : null).toBe(authHeaderValue);
            provider.assertInsertBody(insertReq);
            provider.assertQueryBody(queryReq);
        });

        test.each(STANDARD_UPSTREAM_ERRORS)('returns 500 on upstream %s', async (_label, errorReply) => {
            fakeServer.enqueue(errorReply);

            const res = await app.postJson('/api/vector/insert', {
                collectionId: `err-${provider.name}`,
                source: provider.source,
                ...resolveBody(),
                items: [{ hash: 1, text: 'alpha memory', index: 0 }],
            });

            expect(res.status).toBe(500);
            expect(fakeServer.requests).toHaveLength(1);
        });

        test('returns 500 on malformed 200 JSON payload', async () => {
            fakeServer.enqueue(provider.malformedReply());

            const res = await app.postJson('/api/vector/insert', {
                collectionId: `malformed-${provider.name}`,
                source: provider.source,
                ...resolveBody(),
                items: [{ hash: 1, text: 'alpha memory', index: 0 }],
            });

            expect(res.status).toBe(500);
        });

        if (provider.secretKey) {
            test('returns 500 when API key is missing', async () => {
                app.clearSecrets();
                // Google AI Studio getGoogleApiConfig() sends an empty x-goog-api-key header instead of rejecting locally.
                if (provider.name === 'palm-makersuite') {
                    fakeServer.enqueue(jsonReply({ error: { message: 'API key missing' } }, 401));
                }

                const res = await app.postJson('/api/vector/insert', {
                    collectionId: `nokey-${provider.name}`,
                    source: provider.source,
                    ...resolveBody(),
                    items: [{ hash: 1, text: 'alpha memory', index: 0 }],
                });

                expect(res.status).toBe(500);
                expect(fakeServer.requests).toHaveLength(provider.name === 'palm-makersuite' ? 1 : 0);
                expect(fakeServer.requests[0]?.headers['x-goog-api-key'] ?? '').toBe('');
            });
        }
    });

    describe('inline local vector sources (webllm, koboldcpp)', () => {
        test.each(['webllm', 'koboldcpp'])('inserts and queries %s with zero outbound HTTP calls', async (source) => {
            networkGuard.setBlockExternal(true);
            const embeddings = {
                'first chunk': [1, 0, 0],
                'second chunk': [0, 1, 0],
                'lookup': [1, 0, 0],
            };

            const insertRes = await app.postJson('/api/vector/insert', {
                collectionId: `inline-${source}`,
                source,
                model: 'local-embed',
                embeddings,
                items: [
                    { hash: 11, text: 'first chunk', index: 0 },
                    { hash: 22, text: 'second chunk', index: 1 },
                ],
            });
            expect(insertRes.status).toBe(200);

            const queryRes = await app.postJson('/api/vector/query', {
                collectionId: `inline-${source}`,
                source,
                model: 'local-embed',
                embeddings,
                searchText: 'lookup',
                topK: 1,
                threshold: 0.9,
            });
            expect(queryRes.status).toBe(200);
            expect(queryRes.json.hashes).toEqual([11]);
            expect(queryRes.json.metadata).toEqual([{ hash: 11, text: 'first chunk', index: 0 }]);
            expect(fakeServer.requests).toHaveLength(0);
        });
    });

    describe('Vectra store lifecycle and route validation', () => {
        test('batches inserts over 10 items, lists hashes, queries multi-collection, deletes, and purges', async () => {
            const batch1 = Array.from({ length: 10 }, (_, i) => ({
                index: i,
                embedding: [i === 0 ? 1 : 0, i === 0 ? 0 : 1, 0, 0],
            }));
            const batch2 = [
                { index: 0, embedding: [0.9, 0.1, 0, 0] },
                { index: 1, embedding: [0, 0, 1, 0] },
            ];
            fakeServer.enqueue(
                jsonReply({ data: batch1 }),
                jsonReply({ data: batch2 }),
                jsonReply({ data: [{ index: 0, embedding: [0.95, 0.05, 0, 0] }] }),
                jsonReply({ data: [{ index: 0, embedding: [1, 0, 0, 0] }] }),
            );

            const twelveItems = Array.from({ length: 12 }, (_, i) => ({
                hash: 1000 + i,
                text: `doc-${i}`,
                index: i,
            }));

            const insertA = await app.postJson('/api/vector/insert', {
                collectionId: 'chat-a',
                source: 'openai',
                model: 'text-embedding-3-small',
                items: twelveItems,
            });
            expect(insertA.status).toBe(200);
            expect(fakeServer.requests).toHaveLength(2);
            expect(fakeServer.requests[0].json.input).toHaveLength(10);
            expect(fakeServer.requests[1].json.input).toHaveLength(2);

            const insertB = await app.postJson('/api/vector/insert', {
                collectionId: 'chat-b',
                source: 'openai',
                model: 'text-embedding-3-small',
                items: [{ hash: 2001, text: 'doc-b', index: 0 }],
            });
            expect(insertB.status).toBe(200);

            const listRes = await app.postJson('/api/vector/list', {
                collectionId: 'chat-a',
                source: 'openai',
                model: 'text-embedding-3-small',
            });
            expect(listRes.status).toBe(200);
            expect(listRes.json).toHaveLength(12);
            expect(listRes.json).toContain(1000);
            expect(listRes.json).toContain(1011);

            const multiRes = await app.postJson('/api/vector/query-multi', {
                collectionIds: ['chat-a', 'chat-b'],
                source: 'openai',
                model: 'text-embedding-3-small',
                searchText: 'find top two',
                topK: 2,
                threshold: 0.9,
            });
            expect(multiRes.status).toBe(200);
            expect(multiRes.json['chat-a'].hashes).toEqual([1000]);
            expect(multiRes.json['chat-b'].hashes).toEqual([2001]);

            const deleteRes = await app.postJson('/api/vector/delete', {
                collectionId: 'chat-a',
                source: 'openai',
                model: 'text-embedding-3-small',
                hashes: [1000, 1001],
            });
            expect(deleteRes.status).toBe(200);

            const listAfterDelete = await app.postJson('/api/vector/list', {
                collectionId: 'chat-a',
                source: 'openai',
                model: 'text-embedding-3-small',
            });
            expect(listAfterDelete.json).toHaveLength(10);
            expect(listAfterDelete.json).not.toContain(1000);
            expect(listAfterDelete.json).not.toContain(1001);

            const purgeRes = await app.postJson('/api/vector/purge', { collectionId: 'chat-a' });
            expect(purgeRes.status).toBe(200);
            expect(fs.existsSync(path.join(app.directories.vectors, 'openai', 'chat-a'))).toBe(false);
            expect(fs.existsSync(path.join(app.directories.vectors, 'openai', 'chat-b'))).toBe(true);

            const purgeAllRes = await app.postJson('/api/vector/purge-all', {});
            expect(purgeAllRes.status).toBe(200);
            expect(fs.existsSync(path.join(app.directories.vectors, 'openai'))).toBe(false);
        });

        test('regenerates a corrupted Vectra index on first SyntaxError and returns 500 if still corrupted', async () => {
            const indexDir = path.join(app.directories.vectors, 'openai', 'corrupt-col', 'text-embedding-3-small');
            fs.mkdirSync(indexDir, { recursive: true });
            fs.writeFileSync(path.join(indexDir, 'index.json'), '{not-valid-json');

            // First call follows the 307 redirect to ?regenerated=true after deleting the corrupt index, yielding an empty list.
            const recovered = await app.postJson('/api/vector/list', {
                collectionId: 'corrupt-col',
                source: 'openai',
                model: 'text-embedding-3-small',
            });
            expect(recovered.status).toBe(200);
            expect(recovered.json).toEqual([]);

            // When already marked regenerated=true, a corrupted index returns 500 instead of looping.
            fs.writeFileSync(path.join(indexDir, 'index.json'), '{still-corrupt');
            const failed = await app.postJson('/api/vector/list?regenerated=true', {
                collectionId: 'corrupt-col',
                source: 'openai',
                model: 'text-embedding-3-small',
            });
            expect(failed.status).toBe(500);
        });

        test.each([
            ['query missing collectionId', '/api/vector/query', { searchText: 'hi', source: 'openai' }],
            ['query missing searchText', '/api/vector/query', { collectionId: 'c1', source: 'openai' }],
            ['query-multi non-array collectionIds', '/api/vector/query-multi', { collectionIds: 'c1', searchText: 'hi' }],
            ['insert missing items', '/api/vector/insert', { collectionId: 'c1', source: 'openai' }],
            ['insert missing collectionId', '/api/vector/insert', { items: [], source: 'openai' }],
            ['list missing collectionId', '/api/vector/list', { source: 'openai' }],
            ['delete missing hashes', '/api/vector/delete', { collectionId: 'c1', source: 'openai' }],
            ['purge missing collectionId', '/api/vector/purge', {}],
            ['purge sanitized-to-empty collectionId', '/api/vector/purge', { collectionId: '///' }],
            ['list sanitized-to-empty collectionId', '/api/vector/list', { collectionId: '...', source: 'openai' }],
            ['list sanitized-to-empty source', '/api/vector/list', { collectionId: 'c1', source: '///' }],
        ])('returns 400 for %s', async (_label, route, body) => {
            const res = await app.postJson(route, body);
            expect(res.status).toBe(400);
            expect(fakeServer.requests).toHaveLength(0);
        });

        test('returns 500 for an unknown vector source', async () => {
            const res = await app.postJson('/api/vector/insert', {
                collectionId: 'c1',
                source: 'nonexistent-source',
                items: [{ hash: 1, text: 'hello', index: 0 }],
            });
            expect(res.status).toBe(500);
            expect(fakeServer.requests).toHaveLength(0);
        });
    });

    describe('embedding model discovery endpoints', () => {
        const DISCOVERY_CASES = [
            {
                name: 'chutes',
                route: '/api/openai/chutes/models/embedding',
                body: {},
                expectedUrl: 'https://api.chutes.ai/chutes/?template=embedding&include_public=true&limit=999',
                expectedAuth: 'Bearer test-chutes-key',
                reply: jsonReply({ items: [{ name: 'chutes-embed-1' }] }),
                expectedJson: [{ name: 'chutes-embed-1' }],
                requiresKey: true,
            },
            {
                name: 'nanogpt',
                route: '/api/openai/nanogpt/models/embedding',
                body: {},
                expectedUrl: 'https://nano-gpt.com/api/v1/embedding-models',
                expectedAuth: 'Bearer test-nanogpt-key',
                reply: jsonReply({ data: [{ id: 'text-embedding-3-small' }] }),
                expectedJson: [{ id: 'text-embedding-3-small' }],
                requiresKey: true,
            },
            {
                name: 'siliconflow-global',
                route: '/api/openai/siliconflow/models/embedding',
                body: {},
                expectedUrl: 'https://api.siliconflow.com/v1/models?type=text&sub_type=embedding',
                expectedAuth: 'Bearer test-siliconflow-key',
                reply: jsonReply({ data: [{ id: 'Qwen/Qwen3-Embedding-0.6B' }] }),
                expectedJson: [{ id: 'Qwen/Qwen3-Embedding-0.6B' }],
                requiresKey: true,
            },
            {
                name: 'siliconflow-cn',
                route: '/api/openai/siliconflow/models/embedding',
                body: { siliconflow_endpoint: 'cn' },
                expectedUrl: 'https://api.siliconflow.cn/v1/models?type=text&sub_type=embedding',
                expectedAuth: 'Bearer test-siliconflow-key',
                reply: jsonReply({ data: [{ id: 'BAAI/bge-m3' }] }),
                expectedJson: [{ id: 'BAAI/bge-m3' }],
                requiresKey: true,
            },
            {
                name: 'workers-ai',
                route: '/api/openai/workers-ai/models/embedding',
                body: { workers_ai_account_id: 'acct-99' },
                expectedUrl: 'https://api.cloudflare.com/client/v4/accounts/acct-99/ai/models/search?task=Text+Embeddings&per_page=100',
                expectedAuth: 'Bearer test-workers-ai-key',
                reply: jsonReply({ result: [{ name: '@cf/baai/bge-m3' }] }),
                expectedJson: [{ name: '@cf/baai/bge-m3', id: '@cf/baai/bge-m3' }],
                requiresKey: true,
            },
            {
                name: 'openrouter',
                route: '/api/openrouter/models/embedding',
                body: {},
                expectedUrl: 'https://openrouter.ai/api/v1/models?output_modalities=embeddings',
                expectedAuth: null,
                reply: jsonReply({
                    data: [
                        { id: 'openai/text-embedding-3-small', name: 'OpenAI Embed', architecture: { input_modalities: ['text'], output_modalities: ['embeddings'] } },
                        { id: 'ignored/chat', name: 'Chat', architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
                    ],
                }),
                expectedJson: [{ id: 'openai/text-embedding-3-small', name: 'OpenAI Embed' }],
                requiresKey: false,
            },
        ];

        test.each(DISCOVERY_CASES)('$name fetches and normalizes embedding models', async (entry) => {
            fakeServer.enqueue(entry.reply);

            const res = await app.postJson(entry.route, entry.body);

            expect(res.status).toBe(200);
            expect(res.json).toEqual(entry.expectedJson);
            expect(fakeServer.requests).toHaveLength(1);
            expect(fakeServer.requests[0].method).toBe('GET');
            expect(fakeServer.requests[0].originalUrl).toBe(entry.expectedUrl);
            expect(fakeServer.requests[0].headers.authorization ?? null).toBe(entry.expectedAuth);
        });

        test.each(DISCOVERY_CASES.filter(c => c.requiresKey))('$name returns 400 when secret key is missing', async (entry) => {
            app.clearSecrets();
            const res = await app.postJson(entry.route, entry.body);
            expect(res.status).toBe(400);
            expect(fakeServer.requests).toHaveLength(0);
        });

        test('workers-ai embedding model listing returns 400 when account ID is missing', async () => {
            const res = await app.postJson('/api/openai/workers-ai/models/embedding', {});
            expect(res.status).toBe(400);
            expect(fakeServer.requests).toHaveLength(0);
        });

        test.each(DISCOVERY_CASES.filter(c => c.requiresKey))('$name returns 500 on upstream 500 and non-JSON errors', async (entry) => {
            for (const [, errorReply] of STANDARD_UPSTREAM_ERRORS) {
                fakeServer.reset();
                fakeServer.enqueue(errorReply);
                const res = await app.postJson(entry.route, entry.body);
                expect(res.status).toBe(500);
            }
        });

        test('openrouter embedding model listing returns empty array on upstream HTTP error and 500 on non-JSON 200', async () => {
            fakeServer.enqueue(jsonReply({ error: 'rate limit' }, 429));
            const errRes = await app.postJson('/api/openrouter/models/embedding', {});
            expect(errRes.status).toBe(200);
            expect(errRes.json).toEqual([]);

            fakeServer.enqueue({ status: 200, headers: { 'Content-Type': 'text/html' }, body: '<html>bad</html>' });
            const badJsonRes = await app.postJson('/api/openrouter/models/embedding', {});
            expect(badJsonRes.status).toBe(500);
        });
    });
});
