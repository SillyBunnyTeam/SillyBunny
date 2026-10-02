import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const fetchMock = jest.fn();
await jest.unstable_mockModule('node-fetch', () => ({ default: fetchMock }));
const { router: discoveryRouter } = await import('../src/endpoints/image-models.js');
const { router: googleRouter } = await import('../src/endpoints/google.js');
const { router: sdRouter } = await import('../src/endpoints/stable-diffusion.js');
const { SecretManager, SECRET_KEYS } = await import('../src/endpoints/secrets.js');

const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const googleModel = name => ({ name: `models/${name}`, supportedGenerationMethods: ['generateContent'] });

describe('image provider discovery and native Gemini generation', () => {
    let server;
    let baseUrl;
    let root;
    let keys;

    beforeAll(async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-image-models-'));
        keys = new SecretManager({ root, backups: root });
        keys.writeSecret(SECRET_KEYS.OPENAI, 'test-openai');
        keys.writeSecret(SECRET_KEYS.XAI, 'test-xai');
        keys.writeSecret(SECRET_KEYS.MAKERSUITE, 'test-google');
        keys.writeSecret(SECRET_KEYS.VERTEXAI, 'test-vertex');
        keys.writeSecret(SECRET_KEYS.STABILITY, 'test-stability');
        const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
        keys.writeSecret(SECRET_KEYS.VERTEXAI_SERVICE_ACCOUNT, JSON.stringify({
            project_id: 'test-project', client_email: 'test@example.invalid',
            private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
        }));
        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            req.user = { directories: { root: req.headers['x-empty-keys'] ? path.join(root, 'empty') : root, backups: root } };
            next();
        });
        app.use('/api/sd', discoveryRouter);
        app.use('/api/sd', sdRouter);
        app.use('/api/google', googleRouter);
        await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    beforeEach(() => {
        fetchMock.mockReset();
        fetchMock.mockImplementation(async () => { throw new Error('Unexpected provider request'); });
    });

    afterAll(async () => {
        if (server) await new Promise(resolve => server.close(resolve));
        if (root) fs.rmSync(root, { recursive: true, force: true });
    });

    const post = (endpoint, body = {}, headers = {}) => fetch(`${baseUrl}${endpoint}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
    });

    test('uses server OpenAI credentials, not client overrides or Conversations proxy settings', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ data: [{ id: 'gpt-image-2' }, { id: 'gpt-4o' }] }));
        const result = await post('/api/sd/openai/models', { api_key: 'wrong-key', reverse_proxy: 'https://wrong.invalid' });
        expect(result.status).toBe(200);
        expect(await result.json()).toEqual([{ value: 'gpt-image-2', text: 'gpt-image-2' }]);
        expect(fetchMock.mock.calls[0][0]).toBe('https://api.openai.com/v1/models');
        expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer test-openai');
    });

    test('xAI uses the dedicated image generation metadata endpoint', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ models: [{ id: 'aurora' }] }));
        const result = await post('/api/sd/xai/models');
        expect(await result.json()).toEqual([{ value: 'aurora', text: 'aurora' }]);
        expect(fetchMock.mock.calls[0][0]).toBe('https://api.x.ai/v1/image-generation-models');
    });

    test.each(['openai', 'google', 'xai'])('missing %s server credentials fail without upstream requests', async provider => {
        const result = await post(`/api/sd/${provider}/models`, {}, { 'x-empty-keys': 'true' });
        expect(result.status).toBe(400);
        expect(await result.json()).toMatchObject({ code: 'MODEL_DISCOVERY_FAILED' });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    test('Google consumes all pages, with credentials in headers and no duplicate model IDs', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ models: [googleModel('gemini-2.5-flash-image')], nextPageToken: 'page-two' }))
            .mockResolvedValueOnce(jsonResponse({ models: [googleModel('gemini-3-pro-image'), googleModel('gemini-2.5-flash-image')] }));
        const result = await post('/api/sd/google/models', { reverse_proxy: 'https://wrong.invalid', proxy_password: 'wrong-key' });
        expect(result.status).toBe(200);
        expect((await result.json()).map(model => model.value)).toEqual(['gemini-2.5-flash-image', 'gemini-3-pro-image']);
        const url = new URL(fetchMock.mock.calls[1][0]);
        expect(url.hostname).toBe('generativelanguage.googleapis.com');
        expect(url.searchParams.get('pageToken')).toBe('page-two');
        expect(url.searchParams.has('key')).toBe(false);
        expect(fetchMock.mock.calls[1][1].headers['x-goog-api-key']).toBe('test-google');
    });

    test.each([401, 403, 429, 503])('does not turn a later-page HTTP %s failure into a partial catalog', async status => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ models: [googleModel('gemini-3-pro-image')], nextPageToken: 'next' }))
            .mockResolvedValueOnce(jsonResponse({ error: 'provider-secret-must-not-leak' }, status));
        const result = await post('/api/sd/google/models');
        expect(result.status).toBe(status === 503 ? 502 : status);
        expect(await result.json()).toEqual({ error: `Model catalog request failed (HTTP ${status}).`, code: 'MODEL_DISCOVERY_FAILED' });
    });

    test.each([
        { models: [], nextPageToken: 'again' },
        { models: [], nextPageToken: 1 },
    ])('rejects repeated or malformed pagination tokens', async secondPage => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ models: [], nextPageToken: 'again' })).mockResolvedValueOnce(jsonResponse(secondPage));
        const result = await post('/api/sd/google/models');
        expect(result.status).toBe(502);
        expect(await result.json()).toMatchObject({ code: 'MODEL_DISCOVERY_FAILED' });
    });

    test.each([
        { data: [] }, { data: [{ id: 'gpt-4o' }] }, { wrongField: [] },
    ])('does not report empty or malformed catalogs as success', async payload => {
        fetchMock.mockResolvedValueOnce(jsonResponse(payload));
        const result = await post('/api/sd/openai/models');
        expect(result.status).toBe(502);
        expect((await result.json()).error).toBeTruthy();
    });

    test('transport and JSON failures return errors without exposing provider details', async () => {
        fetchMock.mockRejectedValueOnce(new Error('secret upstream URL'));
        const networkResult = await post('/api/sd/openai/models');
        expect(networkResult.status).toBe(502);
        expect(await networkResult.json()).toEqual({ error: 'Could not contact the model catalog.', code: 'MODEL_DISCOVERY_FAILED' });

        fetchMock.mockResolvedValueOnce(new Response('not JSON', { status: 200 }));
        const parseResult = await post('/api/sd/xai/models');
        expect(parseResult.status).toBe(502);
        expect(await parseResult.json()).toEqual({ error: 'The model catalog returned invalid JSON.', code: 'MODEL_DISCOVERY_FAILED' });
    });

    test('Vertex token exchange failure does not authorize a maintained-catalog fallback', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'invalid_grant' }, 401));
        const result = await post('/api/sd/google/models', { api: 'vertexai', vertexai_auth_mode: 'full' });
        expect(result.status).toBe(401);
        expect(await result.json()).toEqual({ error: 'Google model catalog authentication failed.', code: 'MODEL_DISCOVERY_FAILED' });
    });

    test('Vertex full auth discovers publisher models using its selected region and bearer token', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: 'test-access-token' }))
            .mockResolvedValueOnce(jsonResponse({ publisherModels: [{ name: 'publishers/google/models/gemini-3-pro-image' }] }));
        const result = await post('/api/sd/google/models', { api: 'vertexai', vertexai_auth_mode: 'full', vertexai_region: 'global' });
        expect(result.status).toBe(200);
        expect(await result.json()).toEqual([{ value: 'gemini-3-pro-image', text: 'gemini-3-pro-image' }]);
        const url = new URL(fetchMock.mock.calls[1][0]);
        expect(url.origin + url.pathname).toBe('https://aiplatform.googleapis.com/v1beta1/publishers/google/models');
        expect(url.searchParams.get('listAllVersions')).toBe('true');
        expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer test-access-token');
    });

    test('only unsupported Vertex Express discovery returns the explicit fallback code', async () => {
        const result = await post('/api/sd/google/models', { api: 'vertexai', vertexai_auth_mode: 'express' });
        expect(result.status).toBe(501);
        expect(await result.json()).toMatchObject({ code: 'MODEL_DISCOVERY_UNSUPPORTED' });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    test('invalid Vertex regions cannot receive server credentials', async () => {
        const result = await post('/api/sd/google/models', { api: 'vertexai', vertexai_auth_mode: 'full', vertexai_region: 'evil.invalid/' });
        expect(result.status).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    test('Gemini generates with native modalities/aspect ratio and returns the actual image format', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ candidates: [{ finishReason: 'STOP', content: { parts: [
            { thought: true, inlineData: { mimeType: 'image/png', data: 'thought-image' } },
            { text: 'Here is the image.' },
            { inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } },
        ] } }] }));
        const result = await post('/api/google/generate-image', { model: 'gemini-3.1-flash-image', prompt: 'An otter', aspect_ratio: '3:4', negative_prompt: 'unused', seed: 123 });
        expect(result.status).toBe(200);
        expect(await result.json()).toEqual({ image: 'aW1hZ2U=', format: 'png' });
        expect(String(fetchMock.mock.calls[0][0])).toContain('/models/gemini-3.1-flash-image:generateContent');
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'An otter' }] }]);
        expect(body.generationConfig).toEqual({ responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '3:4' } });
        expect(body).not.toHaveProperty('instances');
        expect(body).not.toHaveProperty('parameters');
    });

    test.each([
        { candidates: [{ finishReason: 'SAFETY', content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'blocked' } }] } }] },
        { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'No image generated.' }] } }] },
        { candidates: [{ finishReason: 'STOP', content: { parts: [{ inlineData: { mimeType: 'audio/wav', data: 'audio' } }] } }] },
    ])('Gemini text-only, non-image or safety-blocked output is not an image success', async payload => {
        fetchMock.mockResolvedValueOnce(jsonResponse(payload));
        const result = await post('/api/google/generate-image', { model: 'gemini-2.5-flash-image', prompt: 'An otter' });
        expect(result.status).toBe(502);
    });

    test('Gemini Vertex Express generation keeps its independent server key and project path', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/jpeg', data: 'aW1hZ2U=' } }] } }] }));
        const result = await post('/api/google/generate-image', { model: 'gemini-2.5-flash-image', api: 'vertexai', vertexai_auth_mode: 'express', vertexai_express_project_id: 'test-project', vertexai_region: 'us-central1', prompt: 'An otter' });
        expect(await result.json()).toEqual({ image: 'aW1hZ2U=', format: 'jpg' });
        expect(String(fetchMock.mock.calls[0][0])).toContain('/projects/test-project/locations/us-central1/publishers/google/models/gemini-2.5-flash-image:generateContent');
        expect(fetchMock.mock.calls[0][1].headers['x-goog-api-key']).toBe('test-vertex');
    });

    test('passes a custom Stability SD3 model to its compatible generation endpoint', async () => {
        fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])));
        const result = await post('/api/sd/stability/generate', {
            model: 'sd3.5-medium', payload: { prompt: 'A lighthouse', seed: 0, output_format: 'png' },
        });
        expect(result.status).toBe(200);
        expect(await result.text()).toBe('AQID');
        const [url, options] = fetchMock.mock.calls[0];
        expect(url).toBe('https://api.stability.ai/v2beta/stable-image/generate/sd3');
        expect(options.body.get('model')).toBe('sd3.5-medium');
        expect(options.body.get('seed')).toBe('0');
    });

    test('saved/custom Imagen models retain the predict generation protocol', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ predictions: [{ bytesBase64Encoded: 'aW1hZ2U=' }] }));
        const result = await post('/api/google/generate-image', { model: 'imagen-4.0-generate-001', prompt: 'An otter', aspect_ratio: '4:3' });
        expect(await result.json()).toEqual({ image: 'aW1hZ2U=' });
        expect(String(fetchMock.mock.calls[0][0])).toContain(':predict');
        expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ instances: [{ prompt: 'An otter' }], parameters: { aspectRatio: '4:3' } });
    });
});
