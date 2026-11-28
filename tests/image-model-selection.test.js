/** @jest-environment jsdom */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { getExtensionCapability } from '../public/scripts/sillybunny-conversation/extension-capabilities.js';
import { loadSdModule } from './util/sd-module-harness.js';

let activeHarness = null;

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

async function flushMicrotasks(rounds = 6) {
    for (let i = 0; i < rounds; i++) {
        await Promise.resolve();
    }
}

async function bootSdWithModelMock({
    source = 'openai',
    model = 'saved-model',
    initialModels = [{ value: model, text: model }],
    sdSettings = {},
    secretState = { api_key_openai: true },
    onFetch,
} = {}) {
    let discoveryHandler = async () => ({
        ok: true,
        json: async () => initialModels,
    });

    const fetchMock = jest.fn(async (url, options) => {
        if (onFetch) {
            const custom = await onFetch(url, options);
            if (custom !== undefined) return custom;
        }
        if (String(url) === '/api/sd/openai/models') {
            return discoveryHandler(url, options);
        }
        return { ok: true, json: async () => [], text: async () => '' };
    });

    activeHarness = await loadSdModule({
        fetch: fetchMock,
        secretState,
        sdSettings: {
            source,
            model,
            ...sdSettings,
        },
    });
    await activeHarness.sdModule.init();
    activeHarness.saveSettingsDebounced.mockClear();
    activeHarness.toastr.warning.mockClear();

    const select = document.getElementById('sd_model');
    const customInput = document.getElementById('sd_model_custom');

    return {
        harness: activeHarness,
        select,
        customInput,
        fetchMock,
        setDiscovery(handler) {
            discoveryHandler = handler;
        },
        async triggerRefresh() {
            window.$('#sd_models_refresh').trigger('click');
            await flushMicrotasks();
        },
    };
}

afterEach(() => {
    activeHarness?.cleanup();
    activeHarness = null;
    jest.restoreAllMocks();
});

describe('image model selection', () => {
    test('keeps a saved model absent from refreshed suggestions', async () => {
        const { harness, select, setDiscovery, triggerRefresh } = await bootSdWithModelMock({
            model: 'custom-provider-model',
        });

        setDiscovery(async () => ({
            ok: true,
            json: async () => [{ value: 'new-image-model', text: 'New image model' }],
        }));
        await triggerRefresh();

        expect([...select.options].map(option => option.value)).toEqual(['new-image-model', 'custom-provider-model']);
        expect(select.value).toBe('custom-provider-model');
        expect(harness.extension_settings.sd.model).toBe('custom-provider-model');
        expect(harness.saveSettingsDebounced).not.toHaveBeenCalled();
    });

    test('preserves the current list and selection after a discovery failure', async () => {
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const { harness, select, setDiscovery, triggerRefresh } = await bootSdWithModelMock();

        setDiscovery(async () => { throw new Error('Provider unavailable'); });
        await triggerRefresh();

        expect([...select.options].map(option => option.value)).toEqual(['saved-model']);
        expect(select.value).toBe('saved-model');
        expect(harness.extension_settings.sd.model).toBe('saved-model');
        expect(harness.toastr.warning).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalled();
    });

    test('ignores late catalogs from a previously selected provider', async () => {
        const { harness, select, setDiscovery } = await bootSdWithModelMock();
        const old = deferred();
        setDiscovery(() => old.promise);

        window.$('#sd_models_refresh').trigger('click');
        await flushMicrotasks(2);

        // Switch source to NovelAI while OpenAI discovery is still in flight.
        harness.extension_settings.sd.source = 'novel';
        harness.extension_settings.sd.model = 'nai-diffusion-5-curated';
        window.$('#sd_models_refresh').trigger('click');
        await flushMicrotasks(8);

        old.resolve({
            ok: true,
            json: async () => [{ value: 'old-provider-model', text: 'Old' }],
        });
        await flushMicrotasks(8);

        expect([...select.options].map(option => option.value)).not.toContain('old-provider-model');
        expect([...select.options].map(option => option.value)).toContain('nai-diffusion-5-curated');
        expect(select.value).toBe('nai-diffusion-5-curated');
        expect(harness.extension_settings.sd.model).toBe('nai-diffusion-5-curated');
    });

    test('uses the latest refresh result and preserves a selection changed while loading', async () => {
        const { harness, select, setDiscovery } = await bootSdWithModelMock();
        const old = deferred();
        const latest = deferred();
        let call = 0;
        setDiscovery(() => (++call === 1 ? old.promise : latest.promise));

        window.$('#sd_models_refresh').trigger('click');
        window.$('#sd_models_refresh').trigger('click');
        harness.extension_settings.sd.model = 'chosen-during-refresh';

        latest.resolve({
            ok: true,
            json: async () => [{ value: 'current-model', text: 'Current' }],
        });
        await flushMicrotasks(8);

        old.resolve({
            ok: true,
            json: async () => [{ value: 'obsolete-model', text: 'Obsolete' }],
        });
        await flushMicrotasks(8);

        expect([...select.options].map(option => option.value)).toEqual(['current-model', 'chosen-during-refresh']);
        expect(select.value).toBe('chosen-during-refresh');
    });

    test('does not replace a custom ID being typed when discovery finishes', async () => {
        const { harness, select, customInput, setDiscovery } = await bootSdWithModelMock();
        const pending = deferred();
        setDiscovery(() => pending.promise);

        window.$('#sd_models_refresh').trigger('click');
        window.$(customInput).val('unfinished-custom-id');

        pending.resolve({
            ok: true,
            json: async () => [{ value: 'listed', text: 'Listed' }],
        });
        await flushMicrotasks(8);

        expect(customInput.value).toBe('unfinished-custom-id');
        expect(select.value).toBe('saved-model');

        window.$(customInput).trigger('change');
        await flushMicrotasks(4);
        expect(harness.extension_settings.sd.model).toBe('unfinished-custom-id');
    });

    test('keeps a preexisting draft after discovery fails', async () => {
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        const { harness, customInput, setDiscovery, triggerRefresh } = await bootSdWithModelMock();

        window.$(customInput).val('uncommitted-id');
        setDiscovery(async () => { throw new Error('Unavailable'); });
        await triggerRefresh();

        expect(customInput.value).toBe('uncommitted-id');
        expect(harness.extension_settings.sd.model).toBe('saved-model');
    });

    test('sends the selected local checkpoint even if the server loaded another one', async () => {
        const requests = [];
        await bootSdWithModelMock({
            source: 'auto',
            model: 'saved-checkpoint',
            sdSettings: {
                auto_url: 'http://local.invalid',
                seed: 0,
            },
            onFetch: async (url, options) => {
                if (String(url) === '/api/sd/generate') {
                    requests.push(JSON.parse(options.body));
                    return { ok: true, json: async () => ({ images: ['image'] }) };
                }
                if (String(url) === '/api/sd/options') {
                    return { ok: true, json: async () => ({ sd_model_checkpoint: 'different-server-checkpoint' }), text: async () => 'different-server-checkpoint' };
                }
                return { ok: true, json: async () => [], text: async () => 'different-server-checkpoint' };
            },
        });

        const sdCapability = getExtensionCapability('stable-diffusion');
        await sdCapability.generateScopedImage('portrait', '', { character: { name: 'Seraphina' } });

        expect(requests).toHaveLength(1);
        expect(requests[0].override_settings.sd_model_checkpoint).toBe('saved-checkpoint');
        expect(requests[0].override_settings_restore_afterwards).toBe(true);
        expect(requests[0].seed).toBe(0);
    });

    test('accepts a trimmed custom ID and retains it through refresh', async () => {
        const { harness, select, customInput, setDiscovery, triggerRefresh } = await bootSdWithModelMock();

        window.$(customInput).val('  future-image-model  ').trigger('change');
        await flushMicrotasks(4);

        setDiscovery(async () => ({
            ok: true,
            json: async () => [{ value: 'listed-model', text: 'Listed' }],
        }));
        await triggerRefresh();

        expect(select.value).toBe('future-image-model');
        expect(harness.extension_settings.sd.model).toBe('future-image-model');

        window.$(customInput).val('  ').trigger('change');
        await flushMicrotasks(4);
        expect(harness.extension_settings.sd.model).toBe('future-image-model');
    });

    test('OpenAI image generation and settings omit retired Sora 2 video paths', async () => {
        const requests = [];
        const { harness } = await bootSdWithModelMock({
            source: 'openai',
            model: 'gpt-image-2',
            sdSettings: {
                width: 1024,
                height: 1536,
                openai_quality: 'standard',
                openai_quality_gpt: 'high',
                openai_style: 'vivid',
                prompt_prefix: '',
                negative_prompt: '',
            },
            onFetch: async (url, options) => {
                if (String(url).startsWith('/api/openai/')) {
                    requests.push({ url: String(url), body: JSON.parse(options.body) });
                    return { ok: true, json: async () => ({ data: [{ b64_json: 'aW1hZ2U=' }] }) };
                }
                return undefined;
            },
        });

        const sdCapability = getExtensionCapability('stable-diffusion');
        const result = await sdCapability.generateScopedImage('A lighthouse', '', { character: { name: 'Seraphina' } });

        expect(result).toEqual({ url: '/user/images/Seraphina/Seraphina_timestamp.png' });
        expect(requests).toEqual([{
            url: '/api/openai/generate-image',
            body: expect.objectContaining({
                model: 'gpt-image-2',
                size: '1024x1536',
                quality: 'high',
                moderation: 'low',
            }),
        }]);
        expect(harness.extension_settings.sd).not.toHaveProperty('openai_duration');
        expect(document.getElementById('sd_openai_duration')).toBeNull();

        // Keep genuine markup contract check on settings.html.
        const settingsHtml = readFileSync(new URL('../public/scripts/extensions/stable-diffusion/settings.html', import.meta.url), 'utf8');
        expect(settingsHtml).not.toContain('sd_openai_duration');
        expect(settingsHtml).not.toContain('sora-2');
    });
});
