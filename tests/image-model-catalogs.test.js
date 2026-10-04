import { describe, expect, test } from '@jest/globals';
import { getGoogleImageModels, getOpenAIImageModels, getPollinationsImageModels, getXAIImageModels, isGoogleImageGenerationModel } from '../public/scripts/image-model-catalogs.js';

const ids = models => models.map(model => model.value);

describe('image generation catalog compatibility', () => {
    test('OpenAI includes GPT Image releases and snapshots, not chat, edit-only or retired models', () => {
        const models = getOpenAIImageModels({ data: [
            'gpt-image-2', 'gpt-image-2-2026-04-21', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-flare',
            'gpt-image-1-mini', 'gpt-4o', 'chatgpt-image-latest', 'gpt-image-2-edit', 'gpt-image-2-vision',
            'dall-e-2', 'dall-e-3', 'sora-2', 'sora-2-pro',
        ].map(id => ({ id })) });
        expect(ids(models)).toEqual([
            'gpt-image-2', 'gpt-image-2-2026-04-21', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-flare', 'gpt-image-1-mini',
        ]);
    });

    test('Google selects output-capable methods and families, not vision or edit models', () => {
        const models = getGoogleImageModels({ models: [
            { name: 'models/gemini-3.1-flash-image', supportedGenerationMethods: ['generateContent'], displayName: 'Nano Banana 2' },
            { name: 'models/gemini-3.1-flash', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/gemini-3.1-flash-image', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/gemini-3-pro-image', supportedGenerationMethods: ['countTokens'] },
            { name: 'models/gemini-3-pro-image-edit', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/imagen-4.0-generate-001', supportedGenerationMethods: ['predict'] },
            { name: 'models/imagen-3.0-capability-001', supportedGenerationMethods: ['predict'] },
            { name: 'models/veo-3.1-fast-generate-001', supportedGenerationMethods: ['predictLongRunning'] },
            { name: 'models/veo-3.1-generate-001', supportedGenerationMethods: ['predict'] },
            { name: 'models/veo-3.0-generate-001', supportedGenerationMethods: ['predictLongRunning'] },
        ] });
        expect(models).toEqual([
            { value: 'gemini-3.1-flash-image', text: 'Nano Banana 2' },
            { value: 'veo-3.1-fast-generate-001', text: 'veo-3.1-fast-generate-001' },
        ]);
    });

    test('QIG can restrict Google discovery to its native Gemini image adapter', () => {
        expect(ids(getGoogleImageModels({ models: [
            { name: 'models/gemini-2.5-flash-image', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/veo-3.1-generate-001', supportedGenerationMethods: ['predictLongRunning'] },
        ] }, { includeVideo: false, includeImagen: false }))).toEqual(['gemini-2.5-flash-image']);
    });

    test('Vertex uses its publisher catalog schema without advertising foreign publishers or vision-only models', () => {
        expect(ids(getGoogleImageModels({ publisherModels: [
            { name: 'publishers/google/models/gemini-3.1-flash-lite-image' },
            { name: 'publishers/google/models/gemini-3-pro-image' },
            { name: 'publishers/google/models/veo-3.1-generate-001' },
            { name: 'publishers/google/models/gemini-3.1-pro' },
            { name: 'publishers/other/models/gemini-3-pro-image' },
            { name: 'publishers/google/models/imagegeneration@006' },
        ] }, { vertex: true }))).toEqual(['gemini-3.1-flash-lite-image', 'gemini-3-pro-image', 'veo-3.1-generate-001']);
    });

    for (const model of ['gemini-2.0-flash-preview-image-generation', 'gemini-2.5-pro', 'gemini-3-pro-image-embedding']) {
        test(`does not route ${model} as image generation`, () => {
            expect(isGoogleImageGenerationModel(model)).toBe(false);
        });
    }

    test('xAI trusts its dedicated catalog rather than image name guesses, respecting explicit modalities', () => {
        expect(ids(getXAIImageModels({ models: [
            { id: 'aurora', input_modalities: ['text'], output_modalities: ['image'] },
            { id: 'grok-imagine-image' },
            { id: 'grok-image-understanding', input_modalities: ['image', 'text'], output_modalities: ['text'] },
            { id: 'image-editor', input_modalities: ['image'], output_modalities: ['image'] },
            { id: 'grok-imagine-video', output_modalities: ['video'] },
        ] }))).toEqual(['aurora', 'grok-imagine-image']);
    });

    test('Pollinations excludes video, edit-only and non-GET image models', () => {
        expect(ids(getPollinationsImageModels([
            { name: 'flux', output_modalities: ['image'], input_modalities: ['text'], supported_endpoints: ['/image/{prompt}'] },
            { name: 'veo3.1', output_modalities: ['video'], input_modalities: ['text'] },
            { name: 'editor', output_modalities: ['image'], input_modalities: ['image'] },
            { name: 'image-understanding', category: 'image', output_modalities: ['text'] },
            { name: 'post-only', output_modalities: ['image'], supported_endpoints: ['/v1/images/generations'] },
            { name: 'category-image', category: 'image' },
            { name: 'unknown' },
        ]))).toEqual(['flux', 'category-image']);
    });

    for (const [normalize, payload] of [
        [getOpenAIImageModels, { data: null }],
        [getOpenAIImageModels, { data: [{ id: '' }] }],
        [getGoogleImageModels, { models: [{ displayName: 'Missing name' }] }],
        [getXAIImageModels, { data: [] }],
    ]) {
        test(`${normalize.name} rejects malformed catalog ${JSON.stringify(payload)}`, () => {
            expect(() => normalize(payload)).toThrow('Invalid model catalog');
        });
    }
});
