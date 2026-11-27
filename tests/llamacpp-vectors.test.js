import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const fetchMock = jest.fn();
const setAdditionalHeadersByTypeMock = jest.fn();

jest.unstable_mockModule('node-fetch', () => ({ default: fetchMock }));
jest.unstable_mockModule('../src/additional-headers.js', () => ({
    setAdditionalHeadersByType: setAdditionalHeadersByTypeMock,
}));

const { getLlamaCppBatchVector, getLlamaCppVector } = await import('../src/vectors/llamacpp-vectors.js');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

describe('llama.cpp vector model ID support (ST #6171)', () => {
    const fakeDirs = { root: '/tmp/user-dirs' };

    beforeEach(() => {
        fetchMock.mockReset();
        setAdditionalHeadersByTypeMock.mockReset();
    });

    test('omits model from the JSON payload when model is empty and trims trailing /v1', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                data: [
                    { index: 1, embedding: [0.3, 0.4] },
                    { index: 0, embedding: [0.1, 0.2] },
                ],
            }),
        });

        const vectors = await getLlamaCppBatchVector(['alpha', 'beta'], 'http://127.0.0.1:8080/v1', '', fakeDirs);

        expect(vectors).toEqual([[0.1, 0.2], [0.3, 0.4]]);
        expect(setAdditionalHeadersByTypeMock).toHaveBeenCalledWith(expect.any(Object), 'llamacpp', 'http://127.0.0.1:8080/v1', fakeDirs);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        const [url, options] = fetchMock.mock.calls[0];
        expect(String(url)).toBe('http://127.0.0.1:8080/v1/embeddings');
        const parsedBody = JSON.parse(options.body);
        expect(parsedBody).toEqual({ input: ['alpha', 'beta'] });
        expect(Object.hasOwn(parsedBody, 'model')).toBe(false);
    });

    test('includes model in the JSON payload when provided', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                data: [{ index: 0, embedding: [0.5, 0.6] }],
            }),
        });

        const vectors = await getLlamaCppBatchVector(['hello'], 'http://127.0.0.1:8080', 'nomic-embed-text-v1.5', fakeDirs);

        expect(vectors).toEqual([[0.5, 0.6]]);
        const [, options] = fetchMock.mock.calls[0];
        expect(JSON.parse(options.body)).toEqual({
            input: ['hello'],
            model: 'nomic-embed-text-v1.5',
        });
    });

    test('getLlamaCppVector forwards model and directories to the batch function', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                data: [{ index: 0, embedding: [0.9, 0.8, 0.7] }],
            }),
        });

        const vector = await getLlamaCppVector('single chunk', 'http://127.0.0.1:8080', 'bge-m3', fakeDirs);

        expect(vector).toEqual([0.9, 0.8, 0.7]);
        expect(setAdditionalHeadersByTypeMock).toHaveBeenCalledWith(expect.any(Object), 'llamacpp', 'http://127.0.0.1:8080', fakeDirs);
        const [, options] = fetchMock.mock.calls[0];
        expect(JSON.parse(options.body)).toEqual({
            input: ['single chunk'],
            model: 'bge-m3',
        });
    });

    test('wires llamacpp_model across server endpoint, client extension, and settings template', () => {
        const endpointSource = fs.readFileSync(path.join(repoRoot, 'src', 'endpoints', 'vectors.js'), 'utf8');
        const clientSource = fs.readFileSync(path.join(repoRoot, 'public', 'scripts', 'extensions', 'vectors', 'index.js'), 'utf8');
        const templateSource = fs.readFileSync(path.join(repoRoot, 'public', 'scripts', 'extensions', 'vectors', 'settings.html'), 'utf8');

        expect(endpointSource).toContain('getLlamaCppVector(text, sourceSettings.apiUrl, sourceSettings.model, directories)');
        expect(endpointSource).toContain('getLlamaCppBatchVector(batch, sourceSettings.apiUrl, sourceSettings.model, directories)');
        expect(endpointSource).toMatch(/case 'llamacpp':[\s\S]*?model:\s*String\(request\.body\.model \|\| ''\)/);

        expect(clientSource).toContain('llamacpp_model: \'\',');
        expect(clientSource).toContain('body.model = extension_settings.vectors.llamacpp_model;');
        expect(clientSource).toContain('$(\'#vectors_llamacpp_model\').val(settings.llamacpp_model)');

        expect(templateSource).toContain('id="vectors_llamacpp_model"');
        expect(templateSource).toContain('for="vectors_llamacpp_model"');
    });
});
