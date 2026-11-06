import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { setConfigFilePath } from '../src/util.js';

const nodeFetchMock = jest.fn();
await jest.unstable_mockModule('node-fetch', () => ({
    default: nodeFetchMock,
}));

const API_KEY = 'kcpp-test-key';
const tempDirs = [];

const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-kcpp-config-'));
const configPath = path.join(configRoot, 'config.yaml');
fs.writeFileSync(configPath, fs.readFileSync(fileURLToPath(new URL('../default/config.yaml', import.meta.url)), 'utf8'));
tempDirs.push(configRoot);
setConfigFilePath(configPath);

const koboldCppAdmin = await import('../src/endpoints/backends/koboldcpp-admin.js');

afterAll(() => {
    for (const dir of tempDirs) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

/**
 * @param {Record<string, (options: any) => { status?: number, json: any }>} routes Handlers by URL path; any other path refuses the connection
 */
function mockKoboldCpp(routes) {
    nodeFetchMock.mockImplementation(async (url, options) => {
        const handler = routes[new URL(String(url)).pathname];
        if (!handler) {
            throw new Error(`connect ECONNREFUSED ${url}`);
        }
        const { status = 200, json } = handler(options);
        return new Response(JSON.stringify(json), {
            status,
            headers: { 'Content-Type': 'application/json' },
        });
    });
}

function getFetchedPaths() {
    return nodeFetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname);
}

describe('KoboldCpp switcher entries', () => {
    test('groups models, configs and actions, and drops files KoboldCpp cannot load as the main model', () => {
        const entries = koboldCppAdmin.getSwitcherEntries([
            'TLD.kcpps',
            'Zeta-70B.Q4_K_M.gguf',
            'alpha-7b.gguf',
            'mmproj-alpha-f16.gguf',
            'Qwen 3.8 Flash Next\\Qwen3.8-Flash-Next-IQ3_S-00001-of-00002.gguf',
            'Qwen 3.8 Flash Next\\Qwen3.8-Flash-Next-IQ3_S-00002-of-00002.gguf',
            'model-10.gguf',
            'model-9.gguf',
            'preset.kcppt',
            'notes.txt',
            42,
            '',
            'initial_model',
            'unload_model',
        ]);

        expect(entries).toEqual([
            { name: 'alpha-7b.gguf', type: 'model' },
            { name: 'model-9.gguf', type: 'model' },
            { name: 'model-10.gguf', type: 'model' },
            { name: 'Qwen 3.8 Flash Next\\Qwen3.8-Flash-Next-IQ3_S-00001-of-00002.gguf', type: 'model' },
            { name: 'Zeta-70B.Q4_K_M.gguf', type: 'model' },
            { name: 'preset.kcppt', type: 'config' },
            { name: 'TLD.kcpps', type: 'config' },
            { name: 'initial_model', type: 'action' },
            { name: 'unload_model', type: 'action' },
        ]);
    });

    test('returns no entries for a response that is not a list', () => {
        expect(koboldCppAdmin.getSwitcherEntries({ detail: 'nope' })).toEqual([]);
        expect(koboldCppAdmin.getSwitcherEntries(null)).toEqual([]);
    });

    test('matches the loaded model name to its file the way KoboldCpp derives the name', () => {
        const entries = koboldCppAdmin.getSwitcherEntries([
            'Foo 31B (Q4_K_M).gguf',
            'sub/Gemma-4 31B it.Q8_0.gguf',
            'Ünïcode Model.GGUF',
            'Foo31BQ4_K_M.kcpps',
            'initial_model',
        ]);

        expect(koboldCppAdmin.findLoadedFile(entries, 'koboldcpp/Foo31BQ4_K_M')).toBe('Foo 31B (Q4_K_M).gguf');
        expect(koboldCppAdmin.findLoadedFile(entries, 'koboldcpp/Gemma-431Bit.Q8_0')).toBe('sub/Gemma-4 31B it.Q8_0.gguf');
        expect(koboldCppAdmin.findLoadedFile(entries, 'koboldcpp/ÜnïcodeModel')).toBe('Ünïcode Model.GGUF');
        expect(koboldCppAdmin.findLoadedFile(entries, 'inactive')).toBeNull();
        expect(koboldCppAdmin.findLoadedFile(entries, 'koboldcpp/Missing')).toBeNull();
        expect(koboldCppAdmin.findLoadedFile(entries, null)).toBeNull();
    });
});

describe('KoboldCpp admin endpoints', () => {
    /** @type {import('http').Server} */
    let appServer;
    let baseUrl;

    beforeAll(async () => {
        const { router: textCompletionsRouter } = await import('../src/endpoints/backends/text-completions.js');
        const { SecretManager, SECRET_KEYS } = await import('../src/endpoints/secrets.js');
        const userRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-kcpp-user-'));
        tempDirs.push(userRoot);
        new SecretManager({ root: userRoot, backups: userRoot }).writeSecret(SECRET_KEYS.KOBOLDCPP, API_KEY);

        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            req.user = { directories: { root: userRoot, backups: userRoot } };
            next();
        });
        app.use('/api/backends/text-completions', textCompletionsRouter);

        await new Promise((resolve) => {
            appServer = app.listen(0, '127.0.0.1', resolve);
        });
        baseUrl = `http://127.0.0.1:${appServer.address().port}`;
    });

    beforeEach(() => {
        nodeFetchMock.mockReset();
    });

    afterAll(async () => {
        if (appServer) {
            await new Promise((resolve, reject) => {
                appServer.close((error) => error ? reject(error) : resolve());
            });
        }
    });

    async function post(route, body) {
        const response = await fetch(`${baseUrl}/api/backends/text-completions/koboldcpp/${route}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const isJson = response.headers.get('content-type')?.includes('application/json');
        return { status: response.status, body: isJson ? await response.json() : null };
    }

    test('lists switcher entries and the loaded file when admin mode is on', async () => {
        mockKoboldCpp({
            '/api/extra/version': () => ({ json: { result: 'KoboldCpp', version: '1.123.1', admin: 1, vision: true, audio: false } }),
            '/api/admin/list_options': () => ({ json: ['beta.gguf', 'alpha.gguf', 'TLD.kcpps', 'initial_model', 'unload_model'] }),
            '/v1/models': () => ({ json: { data: [{ id: 'koboldcpp/beta' }] } }),
            '/api/extra/true_max_context_length': () => ({ json: { value: 8192 } }),
        });

        const result = await post('models', { api_server: 'http://localhost:5001/v1/' });

        expect(result).toEqual({
            status: 200,
            body: {
                admin: 1,
                entries: [
                    { name: 'alpha.gguf', type: 'model' },
                    { name: 'beta.gguf', type: 'model' },
                    { name: 'TLD.kcpps', type: 'config' },
                    { name: 'initial_model', type: 'action' },
                    { name: 'unload_model', type: 'action' },
                ],
                loadedModel: 'koboldcpp/beta',
                loadedFile: 'beta.gguf',
                contextSize: 8192,
                vision: true,
                audio: false,
            },
        });
        for (const [url, options] of nodeFetchMock.mock.calls) {
            expect(new URL(String(url)).origin).toBe('http://127.0.0.1:5001');
            expect(options.headers.Authorization).toBe(`Bearer ${API_KEY}`);
        }
    });

    test('skips the admin list when admin mode is off', async () => {
        mockKoboldCpp({
            '/api/extra/version': () => ({ json: { result: 'KoboldCpp', version: '1.123.1', admin: 0 } }),
            '/api/admin/list_options': () => ({ json: ['alpha.gguf', 'initial_model', 'unload_model'] }),
            '/v1/models': () => ({ json: { data: [{ id: 'koboldcpp/alpha' }] } }),
        });

        const result = await post('models', { api_server: 'http://127.0.0.1:5001' });

        expect(result.body).toMatchObject({ admin: 0, entries: [], loadedModel: 'koboldcpp/alpha', loadedFile: null });
        expect(getFetchedPaths()).not.toContain('/api/admin/list_options');
    });

    test('reports no entries when KoboldCpp refuses the admin password', async () => {
        mockKoboldCpp({
            '/api/extra/version': () => ({ json: { admin: 2 } }),
            '/api/admin/list_options': () => ({ json: [] }),
            '/v1/models': () => ({ json: { data: [{ id: 'koboldcpp/alpha' }] } }),
        });

        const result = await post('models', { api_server: 'http://127.0.0.1:5001' });

        expect(result.body).toMatchObject({ admin: 2, entries: [], loadedModel: 'koboldcpp/alpha', loadedFile: null });
    });

    test('reports no context size or media support when KoboldCpp does not give them', async () => {
        for (const context of [{ value: -1 }, { value: 'abc' }, { value: 0 }, {}]) {
            mockKoboldCpp({
                '/api/extra/version': () => ({ json: { admin: 0, vision: 'yes' } }),
                '/v1/models': () => ({ json: { data: [{ id: 'koboldcpp/alpha' }] } }),
                '/api/extra/true_max_context_length': () => ({ json: context }),
            });

            const result = await post('models', { api_server: 'http://127.0.0.1:5001' });

            expect(result.body).toMatchObject({ contextSize: null, vision: false, audio: false });
        }

        mockKoboldCpp({
            '/api/extra/version': () => ({ json: { admin: 0 } }),
        });

        const result = await post('models', { api_server: 'http://127.0.0.1:5001' });

        expect(result.body).toEqual({ admin: 0, entries: [], loadedModel: null, loadedFile: null, contextSize: null, vision: false, audio: false });
    });

    test('fails the model list when KoboldCpp is unreachable', async () => {
        mockKoboldCpp({});

        const result = await post('models', { api_server: 'http://127.0.0.1:5001' });

        expect(result.status).toBe(502);
    });

    test.each([
        [{}],
        [{ api_server: '' }],
        [{ api_server: 'not a url' }],
        [{ api_server: 'file:///etc/passwd' }],
    ])('rejects a request without a usable server URL: %j', async (body) => {
        const result = await post('models', body);

        expect(result.status).toBe(400);
        expect(nodeFetchMock).not.toHaveBeenCalled();
    });

    test('forwards the chosen file to reload_config', async () => {
        let reloadOptions;
        mockKoboldCpp({
            '/api/admin/reload_config': (options) => {
                reloadOptions = options;
                return { json: { success: true } };
            },
        });

        const result = await post('load', { api_server: 'http://127.0.0.1:5001', filename: 'sub\\beta.gguf' });

        expect(result.body).toEqual({ success: true });
        expect(reloadOptions.method).toBe('POST');
        expect(JSON.parse(reloadOptions.body)).toEqual({ filename: 'sub\\beta.gguf' });
        expect(reloadOptions.headers.Authorization).toBe(`Bearer ${API_KEY}`);
    });

    test('reports a load request that KoboldCpp turned down', async () => {
        mockKoboldCpp({
            '/api/admin/reload_config': () => ({ json: { success: false } }),
        });

        const result = await post('load', { api_server: 'http://127.0.0.1:5001', filename: 'missing.gguf' });

        expect(result).toEqual({ status: 200, body: { success: false } });
    });

    test('rejects a load request without a file name', async () => {
        const result = await post('load', { api_server: 'http://127.0.0.1:5001', filename: '' });

        expect(result.status).toBe(400);
        expect(nodeFetchMock).not.toHaveBeenCalled();
    });

    test('fails a load request when KoboldCpp is unreachable', async () => {
        mockKoboldCpp({});

        const result = await post('load', { api_server: 'http://127.0.0.1:5001', filename: 'alpha.gguf' });

        expect(result.status).toBe(502);
    });

    test('reports uptime while KoboldCpp is up and offline while it restarts', async () => {
        mockKoboldCpp({
            '/api/extra/perf': () => ({ json: { uptime: 12.5, idle: 1 } }),
        });
        expect((await post('uptime', { api_server: 'http://127.0.0.1:5001' })).body).toEqual({ online: true, uptime: 12.5 });

        mockKoboldCpp({
            '/api/extra/perf': () => ({ json: { idle: 1 } }),
        });
        expect((await post('uptime', { api_server: 'http://127.0.0.1:5001' })).body).toEqual({ online: true, uptime: null });

        mockKoboldCpp({
            '/api/extra/perf': () => ({ status: 502, json: {} }),
        });
        expect((await post('uptime', { api_server: 'http://127.0.0.1:5001' })).body).toEqual({ online: false, uptime: null });

        mockKoboldCpp({});
        expect((await post('uptime', { api_server: 'http://127.0.0.1:5001' })).body).toEqual({ online: false, uptime: null });
    });
});
