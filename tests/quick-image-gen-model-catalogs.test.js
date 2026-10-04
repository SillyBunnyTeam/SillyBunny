import { describe, expect, jest, test } from '@jest/globals';
import {
    createModelCatalogRefresher,
    fetchModelCatalog,
    getModelCatalogRequest,
    getRoutewayModelSizes,
    modelSuggestions,
    parseModelCatalog,
} from '../public/scripts/extensions/quick-image-gen/lib/model-catalogs.js';
import { getClosestSupportedImageSize } from '../public/scripts/extensions/quick-image-gen/lib/provider-capabilities.js';

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function target(value) {
    const ownerDocument = {
        createDocumentFragment: () => ({ children: [], append(option) { this.children.push(option); } }),
        createElement: () => ({ value: '', label: '' }),
    };
    return {
        input: { value, isConnected: true },
        datalist: { ownerDocument, children: [{ value: 'maintained' }], replaceChildren(fragment) { this.children = fragment.children; } },
        button: { disabled: false, setAttribute: jest.fn() },
    };
}

function setup(provider = 'routeway') {
    const settings = { provider, routewayKey: 'qig-key', navyKey: 'qig-navy-key' };
    const targets = { routeway: target('custom-routeway'), navy: target('custom-navy') };
    const pending = [];
    const fetchModels = jest.fn(() => {
        const work = deferred();
        pending.push(work);
        return work.promise;
    });
    const onError = jest.fn();
    const refresher = createModelCatalogRefresher({ getSettings: () => settings, getTarget: id => targets[id], fetchModels, onError });
    return { settings, targets, pending, fetchModels, onError, refresher };
}

describe('QIG catalog refresh ownership', () => {
    test('updates only suggestions and retains a custom ID typed while loading', async () => {
        const { targets, pending, refresher } = setup();
        const work = refresher.refresh('routeway');
        targets.routeway.input.value = 'typed-during-refresh';
        pending[0].resolve([{ value: 'new-image-model', text: 'New image' }]);
        expect(await work).toBe(true);
        expect(targets.routeway.input.value).toBe('typed-during-refresh');
        expect(targets.routeway.datalist.children.map(option => option.value)).toEqual(['new-image-model', 'typed-during-refresh']);
        expect(targets.routeway.button.disabled).toBe(false);
    });

    test('rejects late responses after switching providers and back', async () => {
        const { settings, targets, pending, refresher } = setup();
        const old = refresher.refresh('routeway');
        refresher.cancel();
        settings.provider = 'navy';
        const navy = refresher.refresh('navy');
        pending[1].resolve([{ value: 'navy-image', text: 'Navy image' }]);
        expect(await navy).toBe(true);
        settings.provider = 'routeway';
        pending[0].resolve([{ value: 'stale-routeway', text: 'Stale' }]);
        expect(await old).toBe(false);
        expect(targets.routeway.datalist.children.map(option => option.value)).toEqual(['maintained']);
        expect(targets.navy.datalist.children.map(option => option.value)).toEqual(['navy-image', 'custom-navy']);
    });

    test('latest refresh wins even when an aborted request finishes last', async () => {
        const { targets, pending, refresher } = setup();
        const old = refresher.refresh('routeway');
        const latest = refresher.refresh('routeway');
        pending[1].resolve([{ value: 'latest', text: 'Latest' }]);
        expect(await latest).toBe(true);
        pending[0].resolve([{ value: 'obsolete', text: 'Obsolete' }]);
        expect(await old).toBe(false);
        expect(targets.routeway.datalist.children.map(option => option.value)).toEqual(['latest', 'custom-routeway']);
    });

    for (const [change, mutate] of [
        ['key', (settings) => { settings.routewayKey = 'different-qig-key'; }],
        ['provider', (settings) => { settings.provider = 'navy'; }],
        ['detached', (_settings, targets) => { targets.routeway.input.isConnected = false; }],
    ]) {
        test(`does not apply catalogs after changed ${change} context`, async () => {
            const { settings, targets, pending, refresher } = setup();
            const work = refresher.refresh('routeway');
            mutate(settings, targets);
            pending[0].resolve([{ value: 'wrong-context', text: 'Wrong' }]);
            expect(await work).toBe(false);
            expect(targets.routeway.datalist.children.map(option => option.value)).toEqual(['maintained']);
            expect(targets.routeway.input.value).toBe('custom-routeway');
        });
    }

    for (const [kind, finish] of [
        ['failure', pending => pending.reject(new Error('Unavailable'))],
        ['empty', pending => pending.resolve([])],
    ]) {
        test(`retains previous suggestions and selection on ${kind}`, async () => {
            const { targets, pending, onError, refresher } = setup();
            const work = refresher.refresh('routeway');
            finish(pending[0]);
            expect(await work).toBe(false);
            expect(targets.routeway.datalist.children.map(option => option.value)).toEqual(['maintained']);
            expect(targets.routeway.input.value).toBe('custom-routeway');
            expect(onError).toHaveBeenCalledTimes(1);
        });
    }
});

describe('QIG compatible discovery contracts', () => {
    test('uses QIG proxy credentials and never redirects discovery to official service', () => {
        const request = getModelCatalogRequest('gptimage', {
            gptImageProxyUrl: 'https://proxy.example/image-provider/v1/images/generations',
            gptImageProxyKey: 'qig-proxy-key',
            gptImageKey: 'qig-official-key',
        });
        expect(request.url).toBe('https://proxy.example/image-provider/v1/models');
        expect(request.headers).toEqual({ Authorization: 'Bearer qig-proxy-key' });
        expect(getModelCatalogRequest('gptimage', { gptImageProxyUrl: 'https://proxy.example/custom-image-handler' })).toBeNull();
    });

    test('uses native Gemini or chat proxy authentication matching generation', () => {
        const settings = { nanobananaProxyUrl: 'https://proxy.example/google', nanobananaKey: 'qig-key' };
        expect(getModelCatalogRequest('nanobanana', settings)).toMatchObject({
            url: 'https://proxy.example/google/v1beta/models', headers: { 'x-goog-api-key': 'qig-key' }, format: 'nanobanana',
        });
        settings.nanobananaProxyUrl = 'https://proxy.example/v1/chat/completions';
        settings.nanobananaProxyKey = 'qig-proxy-key';
        expect(getModelCatalogRequest('nanobanana', settings)).toMatchObject({
            url: 'https://proxy.example/v1/models', headers: { Authorization: 'Bearer qig-proxy-key' }, format: 'gemini-openai',
        });
    });

    test('separates image generation from image input and unrelated protocols', () => {
        expect(parseModelCatalog('routeway', { data: [
            { id: 'vision-only', capabilities: { vision: true }, endpoints: ['/v1/chat/completions'] },
            { id: 'image-model', endpoints: ['/v1/images/generations'] },
            { id: 'unavailable', available: false, endpoints: ['/v1/images/generations'] },
        ] }).map(model => model.value)).toEqual(['image-model']);
        expect(parseModelCatalog('navy', { data: [
            { id: 'chat-image', output_modalities: ['image'], endpoint: '/v1/chat/completions' },
            { id: 'image-model', endpoint: '/v1/images/generations' },
        ] }).map(model => model.value)).toEqual(['image-model']);
        expect(parseModelCatalog('gptimage', { data: ['gpt-image-2', 'gpt-5', 'dall-e-3', 'sora-2'].map(id => ({ id })) }).map(model => model.value)).toEqual(['gpt-image-2']);
        expect(parseModelCatalog('nanobanana', { models: [
            { name: 'models/gemini-3-pro-image', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/gemini-3-pro', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/imagen-5-generate-001', supportedGenerationMethods: ['predict'] },
        ] }).map(model => model.value)).toEqual(['gemini-3-pro-image']);
    });

    test('uses discovered Routeway sizes instead of unsupported saved dimensions', () => {
        parseModelCatalog('routeway', { data: [{
            id: 'seedream-v4.5', endpoints: ['/v1/images/generations'],
            supported_sizes: ['1920x1920', '2048x2048', '2496x1664'],
        }] });
        const supported = getRoutewayModelSizes('seedream-v4.5');
        expect(getClosestSupportedImageSize({ width: 512, height: 512 }, supported)).toBe('1920x1920');
        expect(getClosestSupportedImageSize({ width: 1536, height: 1024 }, supported)).toBe('2496x1664');
    });

    test('does not suggest NanoGPT vector outputs to the raster-only adapter', () => {
        const image = { image_generation: true, inpainting: false };
        expect(parseModelCatalog('nanogpt', { data: [
            { id: 'raster-generator', capabilities: image, tags: ['png'] },
            { id: 'recraft-ai/recraft-v4.1-pro/text-to-vector', capabilities: image },
            { id: 'future-vector-generator', capabilities: image, tags: ['svg'] },
            { id: 'inpainting-model', capabilities: { ...image, inpainting: true } },
        ] }).map(model => model.value)).toEqual(['raster-generator']);
    });

    test('excludes Pollinations video, image-edit-only and vision-input models', () => {
        expect(parseModelCatalog('pollinations', [
            { name: 'provider/image-model', output_modalities: ['image'], input_modalities: ['text'], supported_endpoints: ['/v1/images/generations'] },
            { name: 'video-model', output_modalities: ['video'], supported_endpoints: ['/v1/images/generations'] },
            { name: 'edit-model', output_modalities: ['image'], supported_endpoints: ['/v1/images/edits'] },
            { name: 'vision-model', input_modalities: ['image'], output_modalities: ['text'] },
        ]).map(model => model.value)).toEqual(['', 'provider/image-model']);
        const anonymous = getModelCatalogRequest('pollinations', {});
        expect(parseModelCatalog(anonymous.format, [
            { name: 'prompt-route', category: 'image', supported_endpoints: ['/image/{prompt}'] },
            { name: 'api-only', category: 'image', supported_endpoints: ['/v1/images/generations'] },
        ]).map(model => model.value)).toEqual(['', 'prompt-route']);
    });

    test('excludes Fal endpoints requiring other adapter inputs', () => {
        const ids = ['fal-ai/flux/dev', 'fal-ai/flux/schnell', 'fal-ai/flux/dev/image-to-image', 'fal-ai/flux/dev/inpainting', 'fal-ai/flux/dev/controlnet-union', 'fal-ai/flux-lora', 'fal-ai/veo3', 'fal-ai/nano-banana'];
        expect(parseModelCatalog('fal', { models: ids.map(endpoint_id => ({ endpoint_id, metadata: { category: 'text-to-image', status: 'active' } })) }).map(model => model.value)).toEqual(['fal-ai/flux/dev', 'fal-ai/flux/schnell']);
    });

    test('paginates Gemini without losing compatible later models or sending a key in the URL', async () => {
        const request = getModelCatalogRequest('nanobanana', { nanobananaKey: 'qig-key' });
        const fetchImpl = jest.fn()
            .mockResolvedValueOnce(Response.json({ models: [{ name: 'models/gemini-3-pro', supportedGenerationMethods: ['generateContent'] }], nextPageToken: 'next-page' }))
            .mockResolvedValueOnce(Response.json({ models: [{ name: 'models/gemini-3-pro-image', supportedGenerationMethods: ['generateContent'] }] }));
        expect((await fetchModelCatalog(request, undefined, fetchImpl)).map(model => model.value)).toEqual(['gemini-3-pro-image']);
        expect(new URL(fetchImpl.mock.calls[1][0]).searchParams.get('pageToken')).toBe('next-page');
        expect(fetchImpl.mock.calls.every(([url]) => !url.includes('qig-key'))).toBe(true);
    });

    test('keeps manual input when the catalog contains duplicate or untrusted labels', () => {
        expect(modelSuggestions([
            { value: 'known', text: '<img src=x onerror=alert(1)>' },
            { value: 'known', text: 'Duplicate' },
        ], 'custom')).toEqual([
            { value: 'known', text: '<img src=x onerror=alert(1)>' },
            { value: 'custom', text: 'custom - current custom model' },
        ]);
    });
});
