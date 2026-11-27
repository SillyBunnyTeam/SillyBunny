/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect -- Jest test.each assertions run inside test callbacks. */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { importStoryModeRuntime } from './util/story-mode-harness.js';

let loaded = null;

afterEach(() => {
    loaded?.cleanup();
    loaded = null;
    jest.restoreAllMocks();
});

async function setupSamplingRuntime({
    api = 'textgenerationwebui',
    model = 'llama-3.1-8b',
} = {}) {
    const requests = [];
    const fetchResumable = jest.fn(async (url, init = {}) => {
        const body = JSON.parse(init.body);
        requests.push({ url, body, signal: init.signal });
        return {
            ok: true,
            status: 200,
            json: async () => (api === 'openai'
                ? { choices: [{ message: { content: 'New prose. ' } }] }
                : { choices: [{ text: 'New prose. ' }] }),
        };
    });

    const fetchMock = jest.fn(async (url) => {
        if (url === '/api/settings/get') {
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    settings: JSON.stringify({
                        main_api: api,
                        amount_gen: 8192,
                        max_context: 32768,
                        oai_settings: {
                            chat_completion_source: 'openai',
                            openai_model: model,
                            openai_max_tokens: 8192,
                            openai_max_context: 32768,
                            temp_openai: 0.7,
                            stream_openai: false,
                        },
                        textgenerationwebui_settings: {
                            type: 'llamacpp',
                            llamacpp_model: model,
                            temp: 0.6,
                            top_p: 0.9,
                            typical_p: 0.85,
                            min_length: 0,
                        },
                    }),
                    openai_setting_names: [],
                    openai_settings: [],
                    textgenerationwebui_setting_names: [],
                    textgenerationwebui_settings: [],
                }),
            };
        }
        return { ok: true, status: 200, json: async () => [] };
    });

    loaded = await importStoryModeRuntime({
        keepReal: ['scripts/openai.js', 'scripts/textgen-settings.js'],
        fetch: fetchMock,
        extraMocks: {
            'scripts/resumable-generation.js': { fetchResumable },
        },
    });

    const openai = await import('../public/scripts/openai.js');
    const textgen = await import('../public/scripts/textgen-settings.js');
    await loaded.runReady();

    loaded.script.setOnlineStatus(model);
    loaded.script.characters.push({ name: 'Story', avatar: 'story.png', chat: 'story', data: { extensions: {} } });
    loaded.script.setCharacterId(0);
    loaded.script.setCharacterName('Story');
    loaded.script.chat.push({ name: 'Story', mes: 'Existing prose. ', extra: {}, is_user: false });

    return { ...loaded, openai, textgen, requests, fetchResumable };
}

describe('text sampling policy request integration', () => {
    test('the text setter omits typical sampling from the serialized request and restores the preset on inherit', async () => {
        const { textgen } = await setupSamplingRuntime({ api: 'textgenerationwebui' });
        const settings = textgen.textgenerationwebui_settings;
        Object.assign(settings, { type: 'llamacpp', llamacpp_model: 'llama-3.1-8b', typical_p: 0.85, top_p: 0.9 });
        const preset = structuredClone(settings);
        const build = () => JSON.parse(JSON.stringify(textgen.createTextGenGenerationData(settings, null, 'Hello', 120)));

        expect(build()).toMatchObject({ typical_p: 0.85, typical: 0.85, top_p: 0.9 });
        textgen.setTextSamplingParameterTransmissionState('typical_p', 'omit');
        const omitted = build();
        expect(omitted).not.toHaveProperty('typical_p');
        expect(omitted).not.toHaveProperty('typical');
        expect(omitted.top_p).toBe(0.9);
        expect(textgen.getTextSamplingParameterTransmissionState('typical_p')).toBe('omit');
        textgen.setTextSamplingParameterTransmissionState('typical_p', 'inherit');
        expect(build()).toMatchObject({ typical_p: 0.85, typical: 0.85 });
        expect(settings).toEqual(preset);
    });

    test('Ollama capability removes both flat typical fields even when explicitly included', async () => {
        const { textgen } = await setupSamplingRuntime({ api: 'textgenerationwebui' });
        const settings = textgen.textgenerationwebui_settings;
        Object.assign(settings, { type: 'ollama', ollama_model: 'llama-3.1-8b', typical_p: 0.85 });
        textgen.setTextSamplingParameterTransmissionState('typical_p', 'include');
        const payload = textgen.createTextGenGenerationData(settings, null, 'Hello', 120);
        expect(payload).not.toHaveProperty('typical_p');
        expect(payload).not.toHaveProperty('typical');
        expect(settings.typical_p).toBe(0.85);
    });

    test('text policies remain isolated by model and adapter from the selected chat target', async () => {
        const { textgen, openai } = await setupSamplingRuntime({ api: 'textgenerationwebui', model: 'llama-3.1-8b' });
        const settings = textgen.textgenerationwebui_settings;
        Object.assign(settings, { type: 'llamacpp', llamacpp_model: 'llama-3.1-8b', temp: 0.6 });
        openai.oai_settings.chat_completion_source = 'openai';
        openai.oai_settings.openai_model = 'llama-3.1-8b';
        openai.oai_settings.temp_openai = 0.7;

        const build = () => textgen.createTextGenGenerationData(settings, null, 'Hello', 120);
        const buildChat = async () => (await openai.createGenerationParameters(openai.oai_settings, 'llama-3.1-8b', 'quiet', [])).generate_data;

        textgen.setTextSamplingParameterTransmissionState('temperature', 'omit');
        expect(build()).not.toHaveProperty('temperature');
        expect((await buildChat()).temperature).toBe(0.7);

        settings.llamacpp_model = 'llama-3.1-70b';
        expect(textgen.getTextSamplingParameterTransmissionState('temperature')).toBe('inherit');
        expect(build().temperature).toBe(0.6);

        Object.assign(settings, { type: 'ollama', ollama_model: 'llama-3.1-8b' });
        expect(build().temperature).toBe(0.6);
        textgen.setTextSamplingParameterTransmissionState('temperature', 'include');
        openai.setSamplingParameterTransmissionState('temperature', 'omit');
        expect(await buildChat()).not.toHaveProperty('temperature');
        expect(build().temperature).toBe(0.6);

        Object.assign(settings, { type: 'llamacpp', llamacpp_model: 'llama-3.1-8b' });
        expect(build()).not.toHaveProperty('temperature');
        expect(settings.temp).toBe(0.6);
        expect(openai.oai_settings.temp_openai).toBe(0.7);
    });
});

describe('real text-completion reasoning payload preservation', () => {
    test.each(['generateRaw', 'generateQuietPrompt'])('%s preserves the exact real text-completion reasoning payload, not a backend default', async method => {
        const { script, textgen, requests } = await setupSamplingRuntime({
            api: 'textgenerationwebui',
            model: 'deepseek-r1',
        });
        Object.assign(textgen.textgenerationwebui_settings, {
            type: 'llamacpp',
            llamacpp_model: 'deepseek-r1',
            temp: 0.6,
            min_length: 128,
            top_p: 0.9,
            include_reasoning: true,
        });
        const settings = structuredClone(textgen.textgenerationwebui_settings);

        await script[method]({ prompt: 'helper', quietPrompt: 'helper' });
        await script[method]({ prompt: 'helper', quietPrompt: 'helper', responseLength: 64, preserveReasoningBudget: true });

        expect(requests[1].body).toEqual(requests[0].body);
        expect(requests[1].body).toMatchObject({ max_tokens: 8192, max_new_tokens: 8192, n_predict: 8192, num_predict: 8192 });
        expect(textgen.textgenerationwebui_settings).toEqual(settings);
        expect(script.amount_gen).toBe(8192);
    });
});
