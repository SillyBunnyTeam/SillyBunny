import { Buffer } from 'node:buffer';
import archiver from 'archiver';
import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { normalizeNovelAIImageParameters } from '../public/scripts/novelai-image-models.js';

const fetchMock = jest.fn();
jest.unstable_mockModule('node-fetch', () => ({ default: fetchMock }));
jest.unstable_mockModule('../src/endpoints/secrets.js', () => ({
    readSecret: () => 'test-token',
    SECRET_KEYS: { NOVEL: 'api_key_novel' },
}));

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function imageArchive() {
    return new Promise((resolve, reject) => {
        const archive = archiver('zip');
        const chunks = [];
        archive.on('data', chunk => chunks.push(chunk));
        archive.on('error', reject);
        archive.on('end', () => resolve(Buffer.concat(chunks)));
        archive.append(png, { name: 'image_0.png' });
        void archive.finalize();
    });
}

describe('NovelAI image request compatibility', () => {
    let server;
    let baseUrl;
    let archive;

    beforeAll(async () => {
        archive = await imageArchive();
        const { default: express } = await import('express');
        const { router } = await import('../src/endpoints/novelai.js');
        const app = express();
        app.use(express.json());
        app.use((request, _response, next) => {
            request.user = { directories: {} };
            next();
        });
        app.use(router);
        server = app.listen(0, '127.0.0.1');
        await new Promise(resolve => server.once('listening', resolve));
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    afterAll(async () => {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    });

    beforeEach(() => {
        fetchMock.mockReset();
        fetchMock.mockResolvedValue({ ok: true, arrayBuffer: async () => archive });
    });

    async function generate(model, overrides = {}) {
        const response = await fetch(`${baseUrl}/generate-image`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model,
                prompt: 'A lighthouse above the sea',
                negative_prompt: 'fog',
                seed: 0,
                width: 832,
                height: 1216,
                scale: 6,
                steps: 24,
                sampler: 'ddim',
                scheduler: 'native',
                decrisper: true,
                sm: true,
                sm_dyn: true,
                variety_boost: true,
                ...overrides,
            }),
        });
        expect(response.status).toBe(200);
        expect(await response.text()).toBe(png.toString('base64'));
        expect(fetchMock).toHaveBeenCalledTimes(1);
        return JSON.parse(fetchMock.mock.calls[0][1].body);
    }

    test.each(['nai-diffusion-5-full', 'nai-diffusion-5-curated'])('normalizes incompatible inherited settings for %s', async (model) => {
        const payload = await generate(model, { novel_anlas_guard: false });
        expect(payload).toMatchObject({
            action: 'generate',
            model,
            input: 'A lighthouse above the sea',
            parameters: {
                params_version: 4,
                seed: 0,
                width: 832,
                height: 1216,
                scale: 6,
                steps: 24,
                sampler: 'k_euler_ancestral',
                noise_schedule: 'karras',
                dynamic_thresholding: false,
                deliberate_euler_ancestral_bug: false,
                prefer_brownian: true,
                v4_prompt: { caption: { base_caption: 'A lighthouse above the sea', char_captions: [] } },
                v4_negative_prompt: { caption: { base_caption: 'fog', char_captions: [] } },
            },
        });
        expect(payload.parameters).not.toHaveProperty('sm');
        expect(payload.parameters).not.toHaveProperty('sm_dyn');
        expect(payload.parameters).not.toHaveProperty('skip_cfg_above_sigma');
    });

    test('blocks V5 without sending a provider request when avoiding Anlas spending', async () => {
        const response = await fetch(`${baseUrl}/generate-image`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'nai-diffusion-5-full', novel_anlas_guard: true, seed: 0, width: 832, height: 1216, steps: 24 }),
        });
        expect(response.status).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    test.each([
        ['nai-diffusion-3', 19, true],
        ['nai-diffusion-4-5-full', 58, false],
    ])('retains supported earlier-model settings for %s', async (model, varietySigma, legacyControls) => {
        const payload = await generate(model, { sampler: 'k_euler', scheduler: 'exponential', novel_anlas_guard: true, sm: legacyControls, sm_dyn: legacyControls, decrisper: legacyControls });
        expect(payload.parameters).toMatchObject({
            params_version: 3,
            sampler: 'k_euler',
            noise_schedule: 'exponential',
            seed: 0,
            sm: legacyControls,
            sm_dyn: legacyControls,
            dynamic_thresholding: legacyControls,
            skip_cfg_above_sigma: varietySigma,
        });
    });
});

describe('shared NovelAI parameter normalization', () => {
    test('keeps V5 character prompts, reproducible seeds, and supported sampler controls', () => {
        const parameters = {
            seed: 2468,
            sampler: 'k_dpmpp_2m_sde',
            noise_schedule: 'exponential',
            cfg_rescale: 0.4,
            scale: 12,
            v4_prompt: { caption: { base_caption: 'A harbor', char_captions: [{ char_caption: 'A sailor', centers: [{ x: 0.2, y: 0.8 }] }] }, use_coords: true },
            v4_negative_prompt: { caption: { base_caption: 'rain', char_captions: [{ char_caption: 'hat' }] } },
        };
        const original = structuredClone(parameters);
        const normalized = normalizeNovelAIImageParameters('nai-diffusion-5-full', parameters);
        expect(normalized).toBe(parameters);
        expect(normalized).toMatchObject({ ...original, noise_schedule: 'karras', params_version: 4, dynamic_thresholding: false });
    });

    test('replaces a legacy sampler unavailable for V5', () => {
        const parameters = normalizeNovelAIImageParameters('nai-diffusion-5-curated', { sampler: 'ddim_v3', seed: 42 });
        expect(parameters).toMatchObject({ sampler: 'k_euler_ancestral', seed: 42, noise_schedule: 'karras' });
    });

    for (const model of ['nai-diffusion-2', 'custom-image-model']) {
        test(`leaves prior or custom selection ${model} unchanged`, () => {
            const parameters = { params_version: 3, sampler: 'ddim', sm: true, noise_schedule: 'native', seed: 0 };
            const original = structuredClone(parameters);
            expect(normalizeNovelAIImageParameters(model, parameters)).toEqual(original);
        });
    }
});
