import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';

import {
    SAMPLE_PNG_BUFFER,
    STANDARD_UPSTREAM_ERRORS,
    binaryReply,
    createFakeUpstreamServer,
    createLoopbackNetworkGuard,
    createZipWithFile,
    initContractConfig,
    jsonReply,
    startContractApp,
} from './util/lower-risk-contract-harness.js';

const { default: actualNodeFetch } = await import('node-fetch');
const actualUtil = await import('../src/util.js');

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

// Eliminate multi-second polling sleeps in BFL, Fal.ai, Horde, SD WebUI, ComfyUI, and Z.AI during contract tests.
await jest.unstable_mockModule('../src/util.js', () => ({
    ...actualUtil,
    delay: () => Promise.resolve(),
}));

const contractConfig = await initContractConfig('sillybunny-image-gen-cfg-');

const { router: sdRouter } = await import('../src/endpoints/stable-diffusion.js');
const { router: openAiRouter } = await import('../src/endpoints/openai.js');
const { router: novelAiRouter } = await import('../src/endpoints/novelai.js');
const { router: googleRouter } = await import('../src/endpoints/google.js');
const { router: hordeRouter } = await import('../src/endpoints/horde.js');
const { router: openRouterRouter } = await import('../src/endpoints/openrouter.js');
const { router: imagesRouter } = await import('../src/endpoints/images.js');
const { SECRET_KEYS } = await import('../src/endpoints/secrets.js');

const SAMPLE_PNG_B64 = SAMPLE_PNG_BUFFER.toString('base64');

const ALL_IMAGE_SECRETS = {
    [SECRET_KEYS.OPENAI]: 'test-openai-key',
    [SECRET_KEYS.NOVEL]: 'test-novelai-key',
    [SECRET_KEYS.MAKERSUITE]: 'test-makersuite-key',
    [SECRET_KEYS.VERTEXAI]: 'test-vertex-key',
    [SECRET_KEYS.HORDE]: 'test-horde-key',
    [SECRET_KEYS.OPENROUTER]: 'test-openrouter-key',
    [SECRET_KEYS.COMFY_RUNPOD]: 'test-runpod-key',
    [SECRET_KEYS.TOGETHERAI]: 'test-together-key',
    [SECRET_KEYS.POLLINATIONS]: 'test-pollinations-key',
    [SECRET_KEYS.STABILITY]: 'test-stability-key',
    [SECRET_KEYS.HUGGINGFACE]: 'test-hf-key',
    [SECRET_KEYS.ELECTRONHUB]: 'test-electronhub-key',
    [SECRET_KEYS.CHUTES]: 'test-chutes-key',
    [SECRET_KEYS.NANOGPT]: 'test-nanogpt-key',
    [SECRET_KEYS.BFL]: 'test-bfl-key',
    [SECRET_KEYS.FALAI]: 'test-falai-key',
    [SECRET_KEYS.XAI]: 'test-xai-key',
    [SECRET_KEYS.AIMLAPI]: 'test-aimlapi-key',
    [SECRET_KEYS.ZAI]: 'test-zai-key',
    [SECRET_KEYS.WORKERS_AI]: 'test-workersai-key',
};

describe('Image generation endpoint contract matrix', () => {
    /** @type {Buffer} */
    let pngZipBuffer;

    beforeAll(async () => {
        pngZipBuffer = await createZipWithFile('image_0.png', SAMPLE_PNG_BUFFER);
        fakeServer = await createFakeUpstreamServer();
        app = await startContractApp({
            routes: [
                ['/api/sd', sdRouter],
                ['/api/openai', openAiRouter],
                ['/api/novelai', novelAiRouter],
                ['/api/google', googleRouter],
                ['/api/horde', hordeRouter],
                ['/api/openrouter', openRouterRouter],
                ['/api/images', imagesRouter],
            ],
            tempPrefix: 'sillybunny-image-gen-contract-',
            secrets: ALL_IMAGE_SECRETS,
            skipConfigInit: true,
        });
    });

    beforeEach(() => {
        fakeServer.reset();
        networkGuard.setBlockExternal(false);
        app.resetUser(ALL_IMAGE_SECRETS);
    });

    afterAll(async () => {
        networkGuard.restore();
        await app?.close();
        await fakeServer?.close();
        contractConfig.cleanup();
    });

    describe('SD WebUI / Automatic1111 / Forge / SD.Next (/api/sd/*)', () => {
        test('supports ping, upscalers, sd-next upscalers, vaes fallback, samplers, schedulers, models, get-model, and set-model', async () => {
            const sdUrl = fakeServer.baseUrl;
            const auth = 'user:pass';
            const expectedAuth = `Basic ${Buffer.from(auth).toString('base64')}`;

            fakeServer.enqueue(
                jsonReply({ sd_model_checkpoint: 'ckpt-a.safetensors' }), // /ping
                jsonReply([{ name: 'None' }, { name: 'ESRGAN' }]), // /upscalers -> upscalers
                jsonReply([{ name: 'Latent' }]), // /upscalers -> latent
                jsonReply([{ name: 'None' }, { name: 'ESRGAN' }]), // /sd-next/upscalers
                jsonReply({ error: 'not found' }, 404), // /vaes -> auto fails
                jsonReply([{ model_name: 'forge-vae.safetensors' }]), // /vaes -> forge succeeds
                jsonReply([{ name: 'Euler a' }]), // /samplers
                jsonReply([{ name: 'Karras' }]), // /schedulers
                jsonReply([{ title: 'modelA.safetensors' }]), // /models
                jsonReply({ sd_model_checkpoint: 'modelA.safetensors' }), // /get-model
                jsonReply({}), // /set-model POST options
                jsonReply({ progress: 0.5, state: { job_count: 1 } }), // /set-model progress 1
                jsonReply({ progress: 0.0, state: { job_count: 0 } }), // /set-model progress 2
            );

            expect((await app.postJson('/api/sd/ping', { url: sdUrl, auth })).status).toBe(200);
            expect((await app.postJson('/api/sd/upscalers', { url: sdUrl, auth })).json).toEqual(['None', 'Latent', 'ESRGAN']);
            expect((await app.postJson('/api/sd/sd-next/upscalers', { url: sdUrl, auth })).json).toContain('Latent (bicubic)');
            expect((await app.postJson('/api/sd/vaes', { url: sdUrl, auth })).json).toEqual(['forge-vae.safetensors']);
            expect((await app.postJson('/api/sd/samplers', { url: sdUrl, auth })).json).toEqual(['Euler a']);
            expect((await app.postJson('/api/sd/schedulers', { url: sdUrl, auth })).json).toEqual(['Karras']);
            expect((await app.postJson('/api/sd/models', { url: sdUrl, auth })).json).toEqual([{ value: 'modelA.safetensors', text: 'modelA.safetensors' }]);
            expect((await app.postJson('/api/sd/get-model', { url: sdUrl, auth })).text).toBe('modelA.safetensors');
            expect((await app.postJson('/api/sd/set-model', { url: sdUrl, auth, model: 'modelB.safetensors' })).status).toBe(200);

            expect(fakeServer.requests[0].headers.authorization).toBe(expectedAuth);
            const setOptReq = fakeServer.requests.find(r => r.method === 'POST' && r.pathname === '/sdapi/v1/options');
            expect(setOptReq.json).toEqual({ sd_model_checkpoint: 'modelB.safetensors' });
        });

        test('/generate strips forge_additional_modules on non-Forge and preserves it on Forge', async () => {
            const sdUrl = fakeServer.baseUrl;
            fakeServer.enqueue(
                jsonReply({ sd_model_checkpoint: 'auto.ckpt' }), // non-Forge options
                jsonReply({ images: [SAMPLE_PNG_B64] }), // txt2img
                jsonReply({ forge_preset: 'sdxl' }), // Forge options
                jsonReply({ images: [SAMPLE_PNG_B64] }), // txt2img
            );

            const autoRes = await app.postJson('/api/sd/generate', {
                url: sdUrl,
                prompt: 'moonlit forest',
                override_settings: { forge_additional_modules: ['vae.pt'], sd_vae: 'Automatic' },
            });
            expect(autoRes.status).toBe(200);
            expect(autoRes.json.images).toEqual([SAMPLE_PNG_B64]);
            expect(fakeServer.requests[1].pathname).toBe('/sdapi/v1/txt2img');
            expect(fakeServer.requests[1].json.override_settings).not.toHaveProperty('forge_additional_modules');

            const forgeRes = await app.postJson('/api/sd/generate', {
                url: sdUrl,
                prompt: 'sunlit hill',
                override_settings: { forge_additional_modules: ['vae.pt'] },
            });
            expect(forgeRes.status).toBe(200);
            expect(fakeServer.requests[3].json.override_settings.forge_additional_modules).toEqual(['vae.pt']);
        });

        test.each(STANDARD_UPSTREAM_ERRORS)('/generate returns 500 on upstream %s', async (_label, errorReply) => {
            fakeServer.enqueue(jsonReply({}), errorReply);
            const res = await app.postJson('/api/sd/generate', { url: fakeServer.baseUrl, prompt: 'test' });
            expect(res.status).toBe(500);
        });
    });

    describe('ComfyUI and ComfyUI RunPod (/api/sd/comfy/*, /api/sd/comfyrunpod/*)', () => {
        test('ComfyUI discovery, workflow file CRUD, and async prompt -> history -> view pipeline', async () => {
            const comfyUrl = fakeServer.baseUrl;
            const objectInfo = {
                KSampler: { input: { required: { sampler_name: [['euler', 'dpmpp_2m']], scheduler: [['normal', 'karras']] } } },
                CheckpointLoaderSimple: { input: { required: { ckpt_name: [['base_model.safetensors']] } } },
                UNETLoader: { input: { required: { unet_name: [['flux_dev.safetensors']] } } },
                UnetLoaderGGUF: { input: { required: { unet_name: [['flux_q4.gguf']] } } },
                VAELoader: { input: { required: { vae_name: [['ae.safetensors']] } } },
            };
            fakeServer.enqueue(
                jsonReply({ system: { os: 'linux' } }), // ping
                jsonReply(objectInfo), // samplers
                jsonReply(objectInfo), // models
                jsonReply(objectInfo), // schedulers
                jsonReply(objectInfo), // vaes
                jsonReply({ prompt_id: 'job-1' }), // generate -> /prompt
                jsonReply({}), // history poll 1 (pending)
                jsonReply({
                    'job-1': {
                        status: { status_str: 'success' },
                        outputs: { '9': { images: [{ filename: 'out.webp', subfolder: 'sub', type: 'output' }] } },
                    },
                }), // history poll 2 (ready)
                binaryReply(SAMPLE_PNG_BUFFER, 'image/webp'), // /view
            );

            expect((await app.postJson('/api/sd/comfy/ping', { url: comfyUrl })).status).toBe(200);
            expect((await app.postJson('/api/sd/comfy/samplers', { url: comfyUrl })).json).toEqual(['euler', 'dpmpp_2m']);
            expect((await app.postJson('/api/sd/comfy/models', { url: comfyUrl })).json).toEqual([
                { value: 'base_model.safetensors', text: 'base model' },
                { value: 'flux_dev.safetensors', text: 'UNet: flux dev' },
                { value: 'flux_q4.gguf', text: 'GGUF: flux q4' },
            ]);
            expect((await app.postJson('/api/sd/comfy/schedulers', { url: comfyUrl })).json).toEqual(['normal', 'karras']);
            expect((await app.postJson('/api/sd/comfy/vaes', { url: comfyUrl })).json).toEqual(['ae.safetensors']);

            const genRes = await app.postJson('/api/sd/comfy/generate', {
                url: comfyUrl,
                prompt: JSON.stringify({ prompt: { '1': { class_type: 'KSampler' } } }),
            });
            expect(genRes.status).toBe(200);
            expect(genRes.json).toEqual({ format: 'webp', data: SAMPLE_PNG_B64 });

            const viewReq = fakeServer.requests.at(-1);
            expect(viewReq.pathname).toBe('/view');
            expect(viewReq.query).toEqual({ filename: 'out.webp', subfolder: 'sub', type: 'output' });

            // Workflow file CRUD in ephemeral comfyWorkflows dir
            const savedList = await app.postJson('/api/sd/comfy/save-workflow', { file_name: 'a.json', workflow: '{"1":{}}' });
            expect(savedList.status).toBe(200);
            expect(savedList.json).toEqual(['a.json']);
            expect((await app.postJson('/api/sd/comfy/workflows', {})).json).toEqual(['a.json']);
            expect((await app.postJson('/api/sd/comfy/workflow', { file_name: 'a.json' })).json).toBe('{"1":{}}');
            expect((await app.postJson('/api/sd/comfy/rename-workflow', { old_name: 'a.json', new_name: 'b.txt' })).status).toBe(400);
            expect((await app.postJson('/api/sd/comfy/rename-workflow', { old_name: 'missing.json', new_name: 'b.json' })).status).toBe(404);
            expect((await app.postJson('/api/sd/comfy/rename-workflow', { old_name: 'a.json', new_name: 'b.json' })).status).toBe(204);
            expect((await app.postJson('/api/sd/comfy/delete-workflow', { file_name: 'b.json' })).status).toBe(200);
            expect((await app.postJson('/api/sd/comfy/workflows', {})).json).toEqual([]);
        });

        test('ComfyUI /generate reports node execution errors with 500', async () => {
            fakeServer.enqueue(
                jsonReply({ prompt_id: 'job-err' }),
                jsonReply({
                    'job-err': {
                        status: {
                            status_str: 'error',
                            messages: [['execution_error', { node_type: 'KSampler', node_id: '3', exception_type: 'ValueError', exception_message: 'bad seed' }]],
                        },
                        outputs: {},
                    },
                }),
            );

            const res = await app.postJson('/api/sd/comfy/generate', { url: fakeServer.baseUrl, prompt: '{}' });
            expect(res.status).toBe(500);
            expect(res.text).toContain('KSampler [3] ValueError: bad seed');
        });

        test('ComfyUI RunPod /ping and /generate wrap workflow, poll status, and enforce secret key', async () => {
            app.clearSecrets();
            expect((await app.postJson('/api/sd/comfyrunpod/ping', { url: fakeServer.baseUrl })).status).toBe(400);
            expect((await app.postJson('/api/sd/comfyrunpod/generate', { url: fakeServer.baseUrl, prompt: '{"prompt":{}}' })).status).toBe(400);

            app.seedSecrets(ALL_IMAGE_SECRETS);
            fakeServer.enqueue(
                jsonReply({ workers: { ready: 1 } }), // ping
                jsonReply({ id: 'rp-job-1' }), // /run
                jsonReply({ status: 'IN_PROGRESS' }), // /status poll 1
                jsonReply({ status: 'COMPLETED', output: { images: [{ filename: 'out.png', data: SAMPLE_PNG_B64 }] } }), // /status poll 2
            );

            expect((await app.postJson('/api/sd/comfyrunpod/ping', { url: fakeServer.baseUrl })).status).toBe(200);
            const genRes = await app.postJson('/api/sd/comfyrunpod/generate', {
                url: fakeServer.baseUrl,
                prompt: JSON.stringify({ prompt: { node1: { class_type: 'Test' } } }),
            });
            expect(genRes.status).toBe(200);
            expect(genRes.json).toEqual({ format: 'png', data: SAMPLE_PNG_B64 });
            expect(fakeServer.requests[1].pathname).toBe('/run');
            expect(fakeServer.requests[1].headers.authorization).toBe('Bearer test-runpod-key');
            expect(fakeServer.requests[1].json).toEqual({ input: { workflow: { node1: { class_type: 'Test' } } } });
        });
    });

    describe('stable-diffusion.cpp and DrawThings (/api/sd/sdcpp/*, /api/sd/drawthings/*)', () => {
        test('sdcpp supports ping (OPTIONS), models, and generate with clip_skip filtering', async () => {
            fakeServer.enqueue(
                { status: 200, body: '' },
                jsonReply({ data: [{ id: 'flux.gguf' }] }),
                jsonReply({ images: [SAMPLE_PNG_B64] }),
                jsonReply({ images: [SAMPLE_PNG_B64] }),
            );

            expect((await app.postJson('/api/sd/sdcpp/ping', { url: fakeServer.baseUrl })).status).toBe(200);
            expect((await app.postJson('/api/sd/sdcpp/models', { url: fakeServer.baseUrl })).json).toEqual({ data: [{ id: 'flux.gguf' }] });

            const genSkip1 = await app.postJson('/api/sd/sdcpp/generate', {
                url: fakeServer.baseUrl,
                prompt: 'castle',
                negative_prompt: '',
                clip_skip: 1,
                width: 512,
                height: 512,
            });
            expect(genSkip1.status).toBe(200);
            expect(fakeServer.requests[0].method).toBe('OPTIONS');
            expect(fakeServer.requests[2].json).not.toHaveProperty('clip_skip');
            expect(fakeServer.requests[2].json).not.toHaveProperty('negative_prompt');

            const genSkip2 = await app.postJson('/api/sd/sdcpp/generate', {
                url: fakeServer.baseUrl,
                prompt: 'castle',
                clip_skip: 2,
            });
            expect(genSkip2.status).toBe(200);
            expect(fakeServer.requests[3].json.clip_skip).toBe(2);
        });

        test('DrawThings supports ping (HEAD), get-model, get-upscaler, and generate stripping url/auth', async () => {
            fakeServer.enqueue(
                { status: 200, body: '' },
                jsonReply({ model: 'dt-model.ckpt' }),
                jsonReply({ upscaler: 'RealESRGAN' }),
                jsonReply({ images: [SAMPLE_PNG_B64] }),
            );

            expect((await app.postJson('/api/sd/drawthings/ping', { url: fakeServer.baseUrl })).status).toBe(200);
            expect((await app.postJson('/api/sd/drawthings/get-model', { url: fakeServer.baseUrl })).text).toBe('dt-model.ckpt');
            expect((await app.postJson('/api/sd/drawthings/get-upscaler', { url: fakeServer.baseUrl })).text).toBe('RealESRGAN');

            const genRes = await app.postJson('/api/sd/drawthings/generate', {
                url: fakeServer.baseUrl,
                auth: 'dt:secret',
                prompt: 'draw me a rabbit',
                steps: 20,
            });
            expect(genRes.status).toBe(200);
            expect(fakeServer.requests[0].method).toBe('HEAD');
            const genReq = fakeServer.requests[3];
            expect(genReq.pathname).toBe('/sdapi/v1/txt2img');
            expect(genReq.headers.authorization).toBe(`Basic ${Buffer.from('dt:secret').toString('base64')}`);
            expect(genReq.json).toEqual({ prompt: 'draw me a rabbit', steps: 20 });
        });
    });

    describe('Cloud image generation provider matrix', () => {
        const CLOUD_IMAGE_PROVIDERS = [
            {
                name: 'openai-dalle',
                route: '/api/openai/generate-image',
                requiresKey: true,
                body: { model: 'gpt-image-1', prompt: 'a starry harbor', size: '1024x1024' },
                replies: () => [jsonReply({ data: [{ b64_json: SAMPLE_PNG_B64 }] })],
                assertRequest: (reqs) => {
                    expect(reqs[0].originalUrl).toBe('https://api.openai.com/v1/images/generations');
                    expect(reqs[0].headers.authorization).toBe('Bearer test-openai-key');
                    expect(reqs[0].json).toMatchObject({ model: 'gpt-image-1', prompt: 'a starry harbor' });
                },
                assertResponse: (res) => {
                    expect(res.json).toEqual({ data: [{ b64_json: SAMPLE_PNG_B64 }] });
                },
            },
            {
                name: 'togetherai-b64',
                route: '/api/sd/together/generate',
                requiresKey: true,
                body: { model: 'black-forest-labs/FLUX.1-schnell', prompt: 'forest', width: 512, height: 512, steps: 4, seed: 42 },
                replies: () => [jsonReply({ data: [{ b64_json: SAMPLE_PNG_B64 }] })],
                assertRequest: (reqs) => {
                    expect(reqs[0].originalUrl).toBe('https://api.together.xyz/v1/images/generations');
                    expect(reqs[0].headers.authorization).toBe('Bearer test-together-key');
                    expect(reqs[0].json).toMatchObject({ prompt: 'forest', seed: 42, n: 1 });
                },
                assertResponse: (res) => {
                    expect(res.json).toEqual({ format: 'jpg', data: SAMPLE_PNG_B64 });
                },
            },
            {
                name: 'togetherai-url-fallback',
                route: '/api/sd/together/generate',
                requiresKey: true,
                body: { model: 'flux', prompt: 'harbor', seed: 1 },
                replies: () => [
                    jsonReply({ data: [{ url: 'https://cdn.together.example/out.jpg' }] }),
                    binaryReply(SAMPLE_PNG_BUFFER, 'image/jpeg'),
                ],
                assertRequest: (reqs) => {
                    expect(reqs).toHaveLength(2);
                    expect(reqs[1].originalUrl).toBe('https://cdn.together.example/out.jpg');
                },
                assertResponse: (res) => {
                    expect(res.json).toEqual({ format: 'jpg', data: SAMPLE_PNG_B64 });
                },
            },
            {
                name: 'pollinations',
                route: '/api/sd/pollinations/generate',
                requiresKey: true,
                body: { prompt: 'blue moon', model: 'flux', negative_prompt: 'blur', width: 768, height: 768, seed: 9, enhance: true },
                replies: () => [binaryReply(SAMPLE_PNG_BUFFER, 'image/png')],
                assertRequest: (reqs) => {
                    expect(reqs[0].method).toBe('GET');
                    expect(reqs[0].originalHost).toBe('gen.pollinations.ai');
                    expect(reqs[0].pathname).toBe('/image/blue%20moon');
                    expect(reqs[0].query).toEqual({
                        model: 'flux',
                        negative_prompt: 'blur',
                        seed: '9',
                        width: '768',
                        height: '768',
                        enhance: 'true',
                    });
                    expect(reqs[0].headers.authorization).toBe('Bearer test-pollinations-key');
                },
                assertResponse: (res) => {
                    expect(res.json).toEqual({ image: SAMPLE_PNG_B64, format: 'png' });
                },
            },
            {
                name: 'stability-ultra',
                route: '/api/sd/stability/generate',
                requiresKey: true,
                body: { model: 'stable-image-ultra', payload: { prompt: 'lighthouse', output_format: 'png' } },
                replies: () => [binaryReply(SAMPLE_PNG_BUFFER, 'image/png')],
                assertRequest: (reqs) => {
                    expect(reqs[0].originalUrl).toBe('https://api.stability.ai/v2beta/stable-image/generate/ultra');
                    expect(reqs[0].headers.authorization).toBe('Bearer test-stability-key');
                    expect(reqs[0].headers.accept).toBe('image/*');
                    expect(reqs[0].headers['content-type']).toContain('multipart/form-data');
                    expect(reqs[0].text).toContain('lighthouse');
                },
                assertResponse: (res) => {
                    expect(res.text).toBe(SAMPLE_PNG_B64);
                },
            },
            {
                name: 'stability-custom-sd3',
                route: '/api/sd/stability/generate',
                requiresKey: true,
                body: { model: 'sd3.5-large', payload: { prompt: 'meadow' } },
                replies: () => [binaryReply(SAMPLE_PNG_BUFFER, 'image/png')],
                assertRequest: (reqs) => {
                    expect(reqs[0].originalUrl).toBe('https://api.stability.ai/v2beta/stable-image/generate/sd3');
                    expect(reqs[0].text).toContain('sd3.5-large');
                },
                assertResponse: (res) => {
                    expect(res.text).toBe(SAMPLE_PNG_B64);
                },
            },
            {
                name: 'huggingface',
                route: '/api/sd/huggingface/generate',
                requiresKey: true,
                body: { model: 'stabilityai/sdxl', prompt: 'winter cabin' },
                replies: () => [binaryReply(SAMPLE_PNG_BUFFER, 'image/png')],
                assertRequest: (reqs) => {
                    expect(reqs[0].originalUrl).toBe('https://api-inference.huggingface.co/models/stabilityai/sdxl');
                    expect(reqs[0].headers.authorization).toBe('Bearer test-hf-key');
                    expect(reqs[0].json).toEqual({ inputs: 'winter cabin' });
                },
                assertResponse: (res) => {
                    expect(res.json).toEqual({ image: SAMPLE_PNG_B64 });
                },
            },
            {
                name: 'electronhub',
                route: '/api/sd/electronhub/generate',
                requiresKey: true,
                body: { model: 'flux-pro', prompt: 'sunset', size: '1024x1024', quality: 'hd' },
                replies: () => [jsonReply({ data: [{ b64_json: SAMPLE_PNG_B64 }] })],
                assertRequest: (reqs) => {
                    expect(reqs[0].originalUrl).toBe('https://api.electronhub.ai/v1/images/generations');
                    expect(reqs[0].headers.authorization).toBe('Bearer test-electronhub-key');
                    expect(reqs[0].json).toEqual({ model: 'flux-pro', prompt: 'sunset', response_format: 'b64_json', size: '1024x1024', quality: 'hd' });
                },
                assertResponse: (res) => {
                    expect(res.json).toEqual({ image: SAMPLE_PNG_B64 });
                },
            },
            {
                name: 'chutes',
                route: '/api/sd/chutes/generate',
                requiresKey: true,
                body: { model: 'FLUX.1-dev', prompt: 'garden', negative_prompt: 'fog', width: 512, height: 512, steps: 12, guidance_scale: 6.5 },
                replies: () => [binaryReply(SAMPLE_PNG_BUFFER, 'image/png')],
                assertRequest: (reqs) => {
                    expect(reqs[0].originalUrl).toBe('https://image.chutes.ai/generate');
                    expect(reqs[0].headers.authorization).toBe('Bearer test-chutes-key');
                    expect(reqs[0].json).toMatchObject({ model: 'FLUX.1-dev', num_inference_steps: 12, guidance_scale: 6.5 });
                },
                assertResponse: (res) => {
                    expect(res.json).toEqual({ image: SAMPLE_PNG_B64 });
                },
            },
            {
                name: 'nanogpt',
                route: '/api/sd/nanogpt/generate',
                requiresKey: true,
                body: { model: 'flux-pro', prompt: 'canyon' },
                replies: () => [jsonReply({ data: [{ b64_json: SAMPLE_PNG_B64 }] })],
                assertRequest: (reqs) => {
                    expect(reqs[0].originalUrl).toBe('https://nano-gpt.com/api/generate-image');
                    expect(reqs[0].headers['x-api-key']).toBe('test-nanogpt-key');
                    expect(reqs[0].json).toEqual({ model: 'flux-pro', prompt: 'canyon' });
                },
                assertResponse: (res) => {
                    expect(res.json).toEqual({ image: SAMPLE_PNG_B64 });
                },
            },
            {
                name: 'bfl-ultra-async',
                route: '/api/sd/bfl/generate',
                requiresKey: true,
                body: { model: 'flux-pro-1.1-ultra', prompt: 'mountain', width: 1024, height: 512, steps: 20, guidance: 3.5, seed: 7 },
                replies: () => [
                    jsonReply({ id: 'bfl-1', polling_url: 'https://api.bfl.ai/v1/get_result?id=bfl-1' }),
                    jsonReply({ status: 'Pending' }),
                    jsonReply({ status: 'Ready', result: { sample: 'https://cdn.bfl.example/img.jpg' } }),
                    binaryReply(SAMPLE_PNG_BUFFER, 'image/jpeg'),
                ],
                assertRequest: (reqs) => {
                    expect(reqs).toHaveLength(4);
                    expect(reqs[0].originalUrl).toBe('https://api.bfl.ai/v1/flux-pro-1.1-ultra');
                    expect(reqs[0].headers['x-key']).toBe('test-bfl-key');
                    expect(reqs[0].json.aspect_ratio).toBe('2:1');
                    expect(reqs[0].json).not.toHaveProperty('width');
                    expect(reqs[0].json).not.toHaveProperty('steps');
                    expect(reqs[1].headers['x-key']).toBe('test-bfl-key');
                    expect(reqs[3].originalUrl).toBe('https://cdn.bfl.example/img.jpg');
                },
                assertResponse: (res) => {
                    expect(res.json).toEqual({ image: SAMPLE_PNG_B64 });
                },
            },
            {
                name: 'falai-queue-async',
                route: '/api/sd/falai/generate',
                requiresKey: true,
                body: { model: 'flux/schnell', prompt: 'valley', width: 768, height: 512, steps: 8, guidance: 3, seed: 5 },
                replies: () => [
                    jsonReply({ status_url: 'https://queue.fal.run/fal-ai/flux/requests/req-1/status' }),
                    jsonReply({ status: 'IN_QUEUE' }),
                    jsonReply({ status: 'COMPLETED', response_url: 'https://queue.fal.run/fal-ai/flux/requests/req-1' }),
                    jsonReply({ images: [{ url: 'https://cdn.fal.example/img.png' }] }),
                    binaryReply(SAMPLE_PNG_BUFFER, 'image/png'),
                ],
                assertRequest: (reqs) => {
                    expect(reqs).toHaveLength(5);
                    expect(reqs[0].originalUrl).toBe('https://queue.fal.run/fal-ai/flux/schnell');
                    expect(reqs[0].headers.authorization).toBe('Key test-falai-key');
                    expect(reqs[0].json).toMatchObject({ prompt: 'valley', image_size: { width: 768, height: 512 }, num_inference_steps: 8 });
                },
                assertResponse: (res) => {
                    expect(res.json).toEqual({ image: SAMPLE_PNG_B64 });
                },
            },
            {
                name: 'xai-data-url',
                route: '/api/sd/xai/generate',
                requiresKey: true,
                body: { model: 'grok-2-image', prompt: 'comet', aspect_ratio: '16:9', resolution: '1k' },
                replies: () => [jsonReply({ data: [{ b64_json: `data:image/png;base64,${SAMPLE_PNG_B64}` }] })],
                assertRequest: (reqs) => {
                    expect(reqs[0].originalUrl).toBe('https://api.x.ai/v1/images/generations');
                    expect(reqs[0].headers.authorization).toBe('Bearer test-xai-key');
                    expect(reqs[0].json).toEqual({ model: 'grok-2-image', prompt: 'comet', aspect_ratio: '16:9', resolution: '1k', response_format: 'b64_json' });
                },
                assertResponse: (res) => {
                    expect(res.json).toEqual({ image: SAMPLE_PNG_B64, format: 'png' });
                },
            },
            {
                name: 'aimlapi-url-fallback',
                route: '/api/sd/aimlapi/generate-image',
                requiresKey: true,
                body: { model: 'flux/schnell', prompt: 'lake' },
                replies: () => [
                    jsonReply({ images: [{ url: 'https://cdn.aiml.example/out.png' }] }),
                    binaryReply(SAMPLE_PNG_BUFFER, 'image/png'),
                ],
                assertRequest: (reqs) => {
                    expect(reqs[0].originalUrl).toBe('https://api.aimlapi.com/v1/images/generations');
                    expect(reqs[0].headers.authorization).toBe('Bearer test-aimlapi-key');
                    expect(reqs[1].originalUrl).toBe('https://cdn.aiml.example/out.png');
                },
                assertResponse: (res) => {
                    expect(res.json).toEqual({ format: 'png', data: SAMPLE_PNG_B64 });
                },
            },
            {
                name: 'zai-with-404-retry',
                route: '/api/sd/zai/generate',
                requiresKey: true,
                body: { model: 'cogview-4', prompt: 'lantern', quality: 'hd', size: '1024x1024' },
                replies: () => [
                    jsonReply({ data: [{ url: 'https://cdn.z.ai/generated/pic.webp' }] }),
                    { status: 404, body: 'not ready yet' },
                    binaryReply(SAMPLE_PNG_BUFFER, 'image/webp'),
                ],
                assertRequest: (reqs) => {
                    expect(reqs).toHaveLength(3);
                    expect(reqs[0].originalUrl).toBe('https://api.z.ai/api/paas/v4/images/generations');
                    expect(reqs[0].headers.authorization).toBe('Bearer test-zai-key');
                    expect(reqs[2].originalUrl).toBe('https://cdn.z.ai/generated/pic.webp');
                },
                assertResponse: (res) => {
                    expect(res.json).toEqual({ image: SAMPLE_PNG_B64, format: 'webp' });
                },
            },
            {
                name: 'workersai-json-base64',
                route: '/api/sd/workersai/generate',
                requiresKey: true,
                body: { account_id: 'cf-acct', model: '@cf/black-forest-labs/flux-1-schnell', prompt: 'bridge', width: 512, height: 512, steps: 4, scale: 7, seed: 3 },
                replies: () => [jsonReply({ result: { image: SAMPLE_PNG_B64 } })],
                assertRequest: (reqs) => {
                    expect(reqs[0].originalUrl).toBe('https://api.cloudflare.com/client/v4/accounts/cf-acct/ai/run/@cf/black-forest-labs/flux-1-schnell');
                    expect(reqs[0].headers.authorization).toBe('Bearer test-workersai-key');
                    expect(reqs[0].json).toEqual({ prompt: 'bridge', width: 512, height: 512, num_steps: 4, guidance: 7, seed: 3 });
                },
                assertResponse: (res) => {
                    expect(res.json).toEqual({ format: 'png', image: SAMPLE_PNG_B64 });
                },
            },
            {
                name: 'workersai-flux2-multipart-binary',
                route: '/api/sd/workersai/generate',
                requiresKey: true,
                body: { account_id: 'cf-acct', model: '@cf/black-forest-labs/flux-2-dev', prompt: 'harbor' },
                replies: () => [binaryReply(SAMPLE_PNG_BUFFER, 'image/png')],
                assertRequest: (reqs) => {
                    expect(reqs[0].headers['content-type']).toContain('multipart/form-data');
                    expect(reqs[0].text).toContain('harbor');
                },
                assertResponse: (res) => {
                    expect(res.json).toEqual({ format: 'png', image: SAMPLE_PNG_B64 });
                },
            },
            {
                name: 'openrouter-image',
                route: '/api/openrouter/image/generate',
                requiresKey: true,
                body: { model: 'google/gemini-2.5-flash-image', prompt: 'river', aspect_ratio: '4:3' },
                replies: () => [jsonReply({
                    choices: [{ message: { images: [{ image_url: { url: `data:image/jpeg;base64,${SAMPLE_PNG_B64}` } }] } }],
                })],
                assertRequest: (reqs) => {
                    expect(reqs[0].originalUrl).toBe('https://openrouter.ai/api/v1/chat/completions');
                    expect(reqs[0].headers.authorization).toBe('Bearer test-openrouter-key');
                    expect(reqs[0].json).toMatchObject({
                        model: 'google/gemini-2.5-flash-image',
                        modalities: ['image'],
                        image_config: { aspect_ratio: '4:3' },
                    });
                },
                assertResponse: (res) => {
                    expect(res.json).toEqual({ format: 'jpg', image: SAMPLE_PNG_B64 });
                },
            },
            {
                name: 'novelai-zip-extract',
                route: '/api/novelai/generate-image',
                requiresKey: true,
                body: { model: 'nai-diffusion-3', prompt: 'clocktower', negative_prompt: 'blur', width: 512, height: 512, seed: 12 },
                replies: () => [binaryReply(pngZipBuffer, 'application/zip')],
                assertRequest: (reqs) => {
                    expect(reqs[0].originalUrl).toBe('https://image.novelai.net/ai/generate-image');
                    expect(reqs[0].headers.authorization).toBe('Bearer test-novelai-key');
                    expect(reqs[0].json).toMatchObject({ action: 'generate', input: 'clocktower', model: 'nai-diffusion-3' });
                },
                assertResponse: (res) => {
                    expect(res.text).toBe(SAMPLE_PNG_B64);
                },
            },
            {
                name: 'google-gemini-native-image',
                route: '/api/google/generate-image',
                requiresKey: false,
                body: { model: 'gemini-2.5-flash-image', prompt: 'red torii gate', aspect_ratio: '16:9' },
                replies: () => [jsonReply({
                    candidates: [{
                        finishReason: 'STOP',
                        content: {
                            parts: [
                                { text: 'thinking', thought: true },
                                { inlineData: { mimeType: 'image/jpeg', data: SAMPLE_PNG_B64 } },
                            ],
                        },
                    }],
                })],
                assertRequest: (reqs) => {
                    expect(reqs[0].originalUrl).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent');
                    expect(reqs[0].headers['x-goog-api-key']).toBe('test-makersuite-key');
                    expect(reqs[0].json.generationConfig).toEqual({
                        responseModalities: ['TEXT', 'IMAGE'],
                        imageConfig: { aspectRatio: '16:9' },
                    });
                },
                assertResponse: (res) => {
                    expect(res.json).toEqual({ image: SAMPLE_PNG_B64, format: 'jpg' });
                },
            },
            {
                name: 'google-imagen-predict',
                route: '/api/google/generate-image',
                requiresKey: false,
                body: { model: 'imagen-3.0-generate-002', prompt: 'snowy pine', aspect_ratio: '1:1' },
                replies: () => [jsonReply({ predictions: [{ bytesBase64Encoded: SAMPLE_PNG_B64 }] })],
                assertRequest: (reqs) => {
                    expect(reqs[0].originalUrl).toBe('https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:predict');
                    expect(reqs[0].json.instances).toEqual([{ prompt: 'snowy pine' }]);
                },
                assertResponse: (res) => {
                    expect(res.json).toEqual({ image: SAMPLE_PNG_B64 });
                },
            },
            {
                name: 'horde-async-image',
                route: '/api/horde/generate-image',
                requiresKey: false,
                body: {
                    prompt: 'a young girl in a garden',
                    negative_prompt: 'blurry',
                    model: 'AlbedoBase XL',
                    sampler: 'k_euler_a',
                    width: 512,
                    height: 512,
                    steps: 20,
                    scale: 7,
                    sanitize: true,
                    seed: 99,
                },
                replies: () => [
                    jsonReply({ id: 'horde-job-1' }),
                    jsonReply({ done: false, faulted: false }),
                    jsonReply({ done: true, faulted: false }),
                    jsonReply({ generations: [{ img: SAMPLE_PNG_B64 }] }),
                ],
                assertRequest: (reqs) => {
                    expect(reqs).toHaveLength(4);
                    expect(reqs[0].originalUrl).toBe('https://aihorde.net/api/v2/generate/async');
                    expect(reqs[0].headers.apikey).toBe('test-horde-key');
                    // sanitizeHordeImagePrompt replaces 'girl' -> 'woman' and removes 'young'
                    expect(reqs[0].json.prompt).toContain('woman');
                    expect(reqs[0].json.prompt).not.toMatch(/\byoung\b/i);
                    expect(reqs[1].originalUrl).toBe('https://aihorde.net/api/v2/generate/check/horde-job-1');
                    expect(reqs[3].originalUrl).toBe('https://aihorde.net/api/v2/generate/status/horde-job-1');
                },
                assertResponse: (res) => {
                    expect(res.text).toBe(SAMPLE_PNG_B64);
                },
            },
        ];

        describe.each(CLOUD_IMAGE_PROVIDERS)('$name', (provider) => {
            test('sends expected request and handles reply payload', async () => {
                fakeServer.enqueue(...provider.replies());

                const res = await app.postJson(provider.route, provider.body);

                expect(res.status).toBe(200);
                provider.assertRequest(fakeServer.requests);
                provider.assertResponse(res);
            });

            test.each(STANDARD_UPSTREAM_ERRORS)('returns 500 on upstream %s', async (_label, errorReply) => {
                fakeServer.enqueue(errorReply);
                const res = await app.postJson(provider.route, provider.body);
                expect(res.status).toBe(500);
            });

            if (provider.requiresKey) {
                test('returns 400 without outbound request when API key is missing', async () => {
                    app.clearSecrets();
                    const res = await app.postJson(provider.route, provider.body);
                    expect(res.status).toBe(400);
                    expect(fakeServer.requests).toHaveLength(0);
                });
            }
        });

        test('Z.AI rejects untrusted image CDN hostnames without fetching them', async () => {
            fakeServer.enqueue(jsonReply({ data: [{ url: 'https://untrusted.example/evil.png' }] }));
            const res = await app.postJson('/api/sd/zai/generate', { model: 'cogview-4', prompt: 'test' });
            expect(res.status).toBe(500);
            expect(fakeServer.requests).toHaveLength(1);
        });

        test('NovelAI /generate-image falls back to original image when upscaling fails', async () => {
            fakeServer.enqueue(
                binaryReply(pngZipBuffer, 'application/zip'),
                jsonReply({ message: 'upscale unavailable' }, 503),
            );

            const res = await app.postJson('/api/novelai/generate-image', {
                model: 'nai-diffusion-3',
                prompt: 'clocktower',
                width: 512,
                height: 512,
                upscale_ratio: 2,
            });
            expect(res.status).toBe(200);
            expect(res.text).toBe(SAMPLE_PNG_B64);
            expect(fakeServer.requests).toHaveLength(2);
            expect(fakeServer.requests[1].originalUrl).toBe('https://api.novelai.net/ai/upscale');
        });

        test('Horde validates missing prompt, lists samplers/models, and returns 500 on faulted job', async () => {
            expect((await app.postJson('/api/horde/generate-image', {})).status).toBe(400);
            const samplersRes = await app.postJson('/api/horde/sd-samplers', {});
            expect(samplersRes.status).toBe(200);
            expect(samplersRes.json).toContain('k_euler_a');

            fakeServer.enqueue(
                jsonReply([{ name: 'AlbedoBase XL', count: 5 }]),
                jsonReply({ id: 'horde-fault' }),
                jsonReply({ done: false, faulted: true }),
            );
            const modelsRes = await app.postJson('/api/horde/sd-models', {});
            expect(modelsRes.status).toBe(200);
            expect(modelsRes.json[0].name).toBe('AlbedoBase XL');

            const faultRes = await app.postJson('/api/horde/generate-image', { prompt: 'castle', model: 'AlbedoBase XL' });
            expect(faultRes.status).toBe(500);
        });
    });

    describe('Image model discovery and catalog routes', () => {
        test('lists models across TogetherAI, Pollinations, ElectronHub, Chutes, NanoGPT, Fal.ai, AI/ML API, Workers AI, OpenRouter', async () => {
            fakeServer.enqueue(
                jsonReply([{ id: 'flux', display_name: 'Flux', type: 'image' }, { id: 'llm', display_name: 'LLM', type: 'chat' }]),
                jsonReply([{ name: 'flux', output_modalities: ['image'] }]),
                jsonReply({ data: [{ id: 'eh-img', name: 'EH Image', endpoints: ['/v1/images/generations'] }, { id: 'eh-chat', name: 'Chat', endpoints: ['/v1/chat/completions'] }] }),
                jsonReply({ items: [{ name: 'b-model' }, { name: 'a-model' }] }),
                jsonReply({ models: { image: { m1: { model: 'nano-img', name: 'Nano Image' } } } }),
                jsonReply({
                    page: 1,
                    pages: 1,
                    items: [
                        { title: 'Flux Dev', modelUrl: 'https://fal.ai/models/fal-ai/flux/dev' },
                        { title: 'Flux Inpainting', modelUrl: 'https://fal.ai/models/fal-ai/flux/inpaint' },
                    ],
                }),
                jsonReply({
                    data: [
                        { id: 'flux/schnell', type: 'image', info: { name: 'Flux Schnell' } },
                        { id: 'triposr', type: 'image', info: { name: 'TripoSR' } },
                    ],
                }),
                jsonReply({ success: true, result: [{ name: '@cf/stabilityai/sdxl' }] }),
                jsonReply({ data: [{ id: 'google/gemini-img', name: 'Gemini Img', architecture: { input_modalities: ['text'], output_modalities: ['image'] } }] }),
            );

            expect((await app.postJson('/api/sd/together/models', {})).json).toEqual([{ value: 'flux', text: 'Flux' }]);
            expect((await app.postJson('/api/sd/pollinations/models', {})).status).toBe(200);
            expect((await app.postJson('/api/sd/electronhub/models', {})).json).toMatchObject([{ value: 'eh-img', text: 'EH Image' }]);
            expect((await app.postJson('/api/sd/chutes/models', {})).json).toEqual([
                { value: 'a-model', text: 'a-model' },
                { value: 'b-model', text: 'b-model' },
            ]);
            expect((await app.postJson('/api/sd/nanogpt/models', {})).json).toEqual([{ value: 'nano-img', text: 'Nano Image' }]);
            expect((await app.postJson('/api/sd/falai/models', {})).json).toEqual([{ value: 'flux/dev', text: 'Flux Dev (flux/dev)' }]);
            expect((await app.postJson('/api/sd/aimlapi/models', {})).json).toEqual({ data: [{ value: 'flux/schnell', text: 'Flux Schnell' }] });
            expect((await app.postJson('/api/sd/workersai/models', { account_id: 'cf-1' })).json).toEqual([{ value: '@cf/stabilityai/sdxl', text: '@cf/stabilityai/sdxl' }]);
            expect((await app.postJson('/api/openrouter/models/image', {})).json).toEqual([{ value: 'google/gemini-img', text: 'Gemini Img' }]);
        });

        test('ElectronHub /sizes returns supported sizes and rejects missing sizes with 500', async () => {
            fakeServer.enqueue(jsonReply({ sizes: ['512x512', '1024x1024'] }), jsonReply({}));

            const okRes = await app.postJson('/api/sd/electronhub/sizes', { model: 'flux-pro' });
            expect(okRes.status).toBe(200);
            expect(okRes.json).toEqual({ sizes: ['512x512', '1024x1024'] });

            const badRes = await app.postJson('/api/sd/electronhub/sizes', { model: 'flux-pro' });
            expect(badRes.status).toBe(500);
        });

        test('image-models.js catalogs (/openai/models, /xai/models, /google/models) handle pagination, status codes, and Vertex Express 501', async () => {
            fakeServer.enqueue(
                jsonReply({ data: [{ id: 'gpt-image-1' }, { id: 'gpt-4o-mini' }] }),
                jsonReply({ models: [{ id: 'grok-2-image', output_modalities: ['image'] }] }),
                jsonReply({
                    models: [
                        { name: 'models/imagen-3.0-generate-002', displayName: 'Retired Imagen 3', supportedGenerationMethods: ['predict'] },
                        { name: 'models/imagen-5.0-generate-001', displayName: 'Imagen 5', supportedGenerationMethods: ['predict'] },
                    ],
                    nextPageToken: 'p2',
                }),
                jsonReply({ models: [{ name: 'models/gemini-2.5-flash-image', displayName: 'Gemini Image', supportedGenerationMethods: ['generateContent'] }] }),
                jsonReply({ error: 'unauthorized' }, 401),
            );

            const oaiModels = await app.postJson('/api/sd/openai/models', {});
            expect(oaiModels.status).toBe(200);
            expect(oaiModels.json.some(m => m.value === 'gpt-image-1')).toBe(true);

            const xaiModels = await app.postJson('/api/sd/xai/models', {});
            expect(xaiModels.status).toBe(200);
            expect(xaiModels.json.some(m => m.value === 'grok-2-image')).toBe(true);

            const googleModels = await app.postJson('/api/sd/google/models', { api: 'makersuite' });
            expect(googleModels.status).toBe(200);
            expect(googleModels.json.map(m => m.value)).toEqual(['imagen-5.0-generate-001', 'gemini-2.5-flash-image']);

            const vertexExpress = await app.postJson('/api/sd/google/models', { api: 'vertexai', vertexai_auth_mode: 'express' });
            expect(vertexExpress.status).toBe(501);
            expect(vertexExpress.json.code).toBe('MODEL_DISCOVERY_UNSUPPORTED');

            const authFail = await app.postJson('/api/sd/openai/models', {});
            expect(authFail.status).toBe(401);
        });
    });

    describe('Local image storage endpoints (/api/images/*)', () => {
        test('uploads, lists folders/files, deletes, and rejects invalid formats or path traversal', async () => {
            expect((await app.postJson('/api/images/upload', { image: SAMPLE_PNG_B64, format: 'exe' })).status).toBe(400);

            const uploadRes = await app.postJson('/api/images/upload', {
                image: SAMPLE_PNG_B64,
                format: 'png',
                ch_name: 'Reisen',
                filename: 'portrait.png',
            });
            expect(uploadRes.status).toBe(200);
            expect(uploadRes.json.path).toContain('Reisen');
            expect(fs.existsSync(path.join(app.directories.root, uploadRes.json.path))).toBe(true);

            expect((await app.postJson('/api/images/folders', {})).json).toContain('Reisen');
            const listRes = await app.postJson('/api/images/list', { folder: 'Reisen' });
            expect(listRes.status).toBe(200);
            expect(listRes.json).toHaveLength(1);

            // Reject traversal outside userImages
            expect((await app.postJson('/api/images/delete', { path: '../secrets.json' })).status).toBe(400);

            const deleteRes = await app.postJson('/api/images/delete', { path: uploadRes.json.path });
            expect(deleteRes.status).toBe(200);
            expect((await app.postJson('/api/images/delete', { path: uploadRes.json.path })).status).toBe(404);
        });
    });
});
