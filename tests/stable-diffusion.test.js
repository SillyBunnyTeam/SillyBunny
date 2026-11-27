import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';

const fetchMock = jest.fn();
const readSecretMock = jest.fn();
const mockUntrustedAgent = { isUntrustedAgent: true };
const getUntrustedRequestAgentMock = jest.fn(() => mockUntrustedAgent);

jest.unstable_mockModule('node-fetch', () => ({ default: fetchMock }));
jest.unstable_mockModule('../src/endpoints/secrets.js', () => ({
    readSecret: readSecretMock,
    SECRET_KEYS: {
        NANOGPT: 'api_key_nanogpt',
    },
}));
jest.unstable_mockModule('../src/private-request-filter.js', () => ({
    getUntrustedRequestAgent: getUntrustedRequestAgentMock,
}));

describe('Stable Diffusion endpoints', () => {
    /** @type {import('node:http').Server} */
    let server;
    let baseUrl;

    beforeAll(async () => {
        const { default: express } = await import('express');
        const { router } = await import('../src/endpoints/stable-diffusion.js');
        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            req.user = { directories: { root: '/tmp/test-user' } };
            next();
        });
        app.use(router);
        server = app.listen(0, '127.0.0.1');
        await new Promise(resolve => server.once('listening', resolve));
        const address = server.address();
        baseUrl = `http://127.0.0.1:${address.port}`;
    });

    afterAll(async () => {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    });

    beforeEach(() => {
        fetchMock.mockReset();
        readSecretMock.mockReset();
        getUntrustedRequestAgentMock.mockClear();
    });

    describe('ComfyUI generation', () => {
        test('skips output nodes without images', async () => {
            fetchMock
                .mockResolvedValueOnce({ ok: true, json: async () => ({ prompt_id: 'prompt-1' }) })
                .mockResolvedValueOnce({
                    ok: true,
                    json: async () => ({
                        'prompt-1': {
                            status: { status_str: 'success' },
                            outputs: {
                                117: { a_images: [{ filename: 'comparison.png' }] },
                                197: { images: [{ filename: 'result.png', subfolder: '', type: 'temp' }] },
                            },
                        },
                    }),
                })
                .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer });

            const response = await fetch(`${baseUrl}/comfy/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: 'http://127.0.0.1:8188', prompt: '{}' }),
            });

            expect(response.status).toBe(200);
            expect(await response.json()).toEqual({ format: 'png', data: 'AQID' });
        });

        test('falls back to gifs when no output node has images', async () => {
            fetchMock
                .mockResolvedValueOnce({ ok: true, json: async () => ({ prompt_id: 'prompt-2' }) })
                .mockResolvedValueOnce({
                    ok: true,
                    json: async () => ({
                        'prompt-2': {
                            status: { status_str: 'success' },
                            outputs: {
                                10: { text: ['some non-media output'] },
                                42: { gifs: [{ filename: 'animation.webp', subfolder: '', type: 'output' }] },
                            },
                        },
                    }),
                })
                .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => Uint8Array.from([4, 5, 6]).buffer });

            const response = await fetch(`${baseUrl}/comfy/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: 'http://127.0.0.1:8188', prompt: '{}' }),
            });

            expect(response.status).toBe(200);
            expect(await response.json()).toEqual({ format: 'webp', data: 'BAUG' });
        });

        test('reports an error when no output has images or gifs', async () => {
            fetchMock
                .mockResolvedValueOnce({ ok: true, json: async () => ({ prompt_id: 'prompt-3' }) })
                .mockResolvedValueOnce({
                    ok: true,
                    json: async () => ({
                        'prompt-3': {
                            status: { status_str: 'success' },
                            outputs: {
                                10: { text: ['no media at all'] },
                            },
                        },
                    }),
                });

            const response = await fetch(`${baseUrl}/comfy/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: 'http://127.0.0.1:8188', prompt: '{}' }),
            });

            expect(response.status).toBe(500);
            expect(await response.text()).toContain('did not return any recognizable outputs');
        });
    });

    describe('NanoGPT generation', () => {
        beforeEach(() => {
            readSecretMock.mockImplementation((_dirs, key) => key === 'api_key_nanogpt' ? 'nanogpt-secret-key' : null);
        });

        test('returns inline b64_json without making a second request', async () => {
            fetchMock.mockResolvedValueOnce({
                ok: true,
                json: async () => ({ data: [{ b64_json: 'aW5saW5lLWltYWdl' }] }),
            });

            const response = await fetch(`${baseUrl}/nanogpt/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: 'a rabbit' }),
            });

            expect(response.status).toBe(200);
            expect(await response.json()).toEqual({ image: 'aW5saW5lLWltYWdl' });
            expect(fetchMock).toHaveBeenCalledTimes(1);
        });

        test('downloads HTTPS image URLs via the untrusted request agent without forwarding API keys', async () => {
            fetchMock
                .mockResolvedValueOnce({
                    ok: true,
                    json: async () => ({ data: [{ url: 'https://cdn.example.com/generated/large.png' }] }),
                })
                .mockResolvedValueOnce({
                    ok: true,
                    arrayBuffer: async () => Uint8Array.from([7, 8, 9]).buffer,
                });

            const response = await fetch(`${baseUrl}/nanogpt/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: 'a large painting' }),
            });

            expect(response.status).toBe(200);
            expect(await response.json()).toEqual({ image: 'BwgJ' });
            expect(fetchMock).toHaveBeenCalledTimes(2);
            expect(getUntrustedRequestAgentMock).toHaveBeenCalledTimes(1);

            const [downloadUrl, downloadOpts] = fetchMock.mock.calls[1];
            expect(downloadUrl).toBe('https://cdn.example.com/generated/large.png');
            expect(downloadOpts.agent).toBe(mockUntrustedAgent);
            expect(downloadOpts.signal).toBeInstanceOf(AbortSignal);
            expect(downloadOpts.headers).toBeUndefined();
        });

        test('rejects non-HTTPS and malformed image URLs without performing a second fetch', async () => {
            for (const badUrl of ['http://127.0.0.1:8000/internal.png', 'not-a-valid-url']) {
                fetchMock.mockReset();
                fetchMock.mockResolvedValueOnce({
                    ok: true,
                    json: async () => ({ data: [{ url: badUrl }] }),
                });

                const response = await fetch(`${baseUrl}/nanogpt/generate`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ prompt: 'ssrf test' }),
                });

                expect(response.status).toBe(500);
                expect(await response.text()).toContain('invalid image URL');
                expect(fetchMock).toHaveBeenCalledTimes(1);
            }
        });

        test('returns HTTP 500 with download status when downloading the image URL fails', async () => {
            fetchMock
                .mockResolvedValueOnce({
                    ok: true,
                    json: async () => ({ data: [{ url: 'https://cdn.example.com/expired.png' }] }),
                })
                .mockResolvedValueOnce({
                    ok: false,
                    status: 403,
                });

            const response = await fetch(`${baseUrl}/nanogpt/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: 'expired link' }),
            });

            expect(response.status).toBe(500);
            expect(await response.text()).toContain('HTTP 403');
        });

        test('forwards upstream NanoGPT error text on non-OK responses', async () => {
            fetchMock.mockResolvedValueOnce({
                ok: false,
                status: 402,
                text: async () => '{"error":"Insufficient balance"}',
            });

            const response = await fetch(`${baseUrl}/nanogpt/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: 'balance error' }),
            });

            expect(response.status).toBe(500);
            expect(await response.text()).toBe('{"error":"Insufficient balance"}');
        });
    });
});
