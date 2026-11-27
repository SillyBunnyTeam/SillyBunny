/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect -- Jest test.each tables run assertions inside callbacks. */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { importStoryModeRuntime } from './util/story-mode-harness.js';
import { event_types } from '../public/scripts/events.js';

let loaded = null;

afterEach(() => {
    loaded?.cleanup();
    loaded = null;
    jest.restoreAllMocks();
});

const APIS = ['openai', 'textgenerationwebui', 'kobold', 'koboldhorde', 'novel'];
const PRESET = { amount_gen: 8192, openai_max_tokens: 4096 };
const lengthField = api => (['kobold', 'koboldhorde', 'novel'].includes(api) ? 'max_length' : 'max_tokens');
const presetLength = api => (api === 'openai' ? PRESET.openai_max_tokens : PRESET.amount_gen);
const rawPromptEvent = api => (api === 'openai' ? event_types.CHAT_COMPLETION_PROMPT_READY : event_types.GENERATE_AFTER_COMBINE_PROMPTS);
const rawPromptText = data => String(data?.prompt ?? data?.chat?.[0]?.content ?? '').trim();

async function setupOverlapRuntime(api) {
    const requests = [];
    let settingsVersion = 1;

    const fetchResumable = jest.fn(async (url, init = {}) => {
        const body = JSON.parse(init.body);
        requests.push({ url, body, signal: init.signal });
        return {
            ok: true,
            status: 200,
            json: async () => {
                if (url.includes('/openai') || url.includes('/chat-completions')) {
                    return { choices: [{ message: { content: 'New prose. ' } }] };
                }
                if (url.includes('/novelai')) return { output: 'New prose. ' };
                if (url.includes('/kobold')) return { results: [{ text: 'New prose. ' }] };
                return { choices: [{ text: 'New prose. ' }] };
            },
        };
    });

    const generateHorde = jest.fn(async (_prompt, data, signal) => {
        requests.push({ body: data, signal });
        return { text: 'New prose. ' };
    });

    const fetchMock = jest.fn(async (url) => {
        if (url === '/api/settings/get') {
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    settings: JSON.stringify({
                        _version: settingsVersion,
                        main_api: api,
                        amount_gen: PRESET.amount_gen,
                        max_context: 32768,
                        oai_settings: {
                            chat_completion_source: 'openai',
                            openai_model: 'gpt-4o',
                            openai_max_tokens: PRESET.openai_max_tokens,
                            openai_max_context: 32768,
                            stream_openai: false,
                        },
                    }),
                    openai_setting_names: [],
                    openai_settings: [],
                }),
            };
        }
        if (url === '/api/settings/save') {
            settingsVersion += 1;
            return { ok: true, status: 200, json: async () => ({ version: settingsVersion }) };
        }
        return { ok: true, status: 200, json: async () => [] };
    });

    loaded = await importStoryModeRuntime({
        keepReal: ['scripts/openai.js'],
        fetch: fetchMock,
        extraMocks: {
            'scripts/resumable-generation.js': { fetchResumable },
            'scripts/horde.js': {
                generateHorde,
                isHordeGenerationNotAllowed: jest.fn(() => false),
                MIN_LENGTH: 16,
            },
            'scripts/textgen-settings.js': base => ({
                ...base,
                getTextGenGenerationData: jest.fn(async (prompt, maxTokens) => {
                    const data = { prompt, model: 'gpt-4o', max_new_tokens: maxTokens, max_tokens: maxTokens, n_predict: maxTokens, num_predict: maxTokens };
                    await loaded.eventSource.emit(event_types.TEXT_COMPLETION_SETTINGS_READY, data);
                    return data;
                }),
            }),
            'scripts/nai-settings.js': base => ({
                ...base,
                nai_settings: { ...base.nai_settings, preset_settings_novel: 'preset', model_novel: 'erato' },
                novelai_settings: [{}],
                novelai_setting_names: { preset: 0 },
                getNovelGenerationData: (prompt, _settings, maxLength) => ({ input: prompt, model: 'erato', max_length: maxLength }),
            }),
            'scripts/kai-settings.js': base => ({
                ...base,
                kai_settings: { preset_settings: 'gui' },
                kai_flags: {},
            }),
            'scripts/sillybunny-settings-sync.js': {
                createSettingsSync: () => ({
                    getFingerprint: json => json,
                    remember() {},
                    isSynced: () => false,
                }),
            },
        },
    });

    const openai = await import('../public/scripts/openai.js');
    await loaded.runReady();
    loaded.script.setOnlineStatus('gpt-4o');
    openai.oai_settings.chat_completion_source = 'openai';
    openai.oai_settings.openai_model = 'gpt-4o';
    openai.oai_settings.openai_max_tokens = PRESET.openai_max_tokens;
    openai.oai_settings.stream_openai = false;

    loaded.script.characters.push({ name: 'Story', avatar: 'story.png', chat: 'story', data: { extensions: {} } });
    loaded.script.setCharacterId(0);
    loaded.script.setCharacterName('Story');
    loaded.script.chat.push({ name: 'Story', mes: 'Existing prose. ', extra: {}, is_user: false });

    const preset = () => ({
        amount_gen: loaded.script.amount_gen,
        openai_max_tokens: openai.oai_settings.openai_max_tokens,
    });
    const lengths = () => requests.map(request => request.body[lengthField(api)]);
    return {
        ...loaded,
        openai,
        requests,
        preset,
        lengths,
        state: () => ({ lengths: lengths(), ...preset() }),
    };
}

function holdEvent(eventSource, name, matches) {
    let reach;
    let release;
    const reached = new Promise(resolve => { reach = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    eventSource.on(name, async (...args) => {
        if (!matches(...args)) return;
        reach();
        await gate;
    });
    return { reached, release };
}

async function holdTwoRawCalls(runtime, api) {
    const { script, eventSource } = runtime;
    const first = holdEvent(eventSource, rawPromptEvent(api), data => rawPromptText(data).includes('first'));
    const second = holdEvent(eventSource, rawPromptEvent(api), data => rawPromptText(data).includes('second'));
    const firstCall = script.generateRaw({ prompt: 'first', responseLength: 100 });
    await first.reached;
    const secondCall = script.generateRaw({ prompt: 'second', responseLength: 200 });
    await second.reached;
    return { first, second, firstCall, secondCall };
}

describe('overlapping temporary response lengths in script.js', () => {
    test.each(APIS)('%s: a raw call inside another raw call leaves the preset in place', async api => {
        const { script, eventSource, state } = await setupOverlapRuntime(api);
        eventSource.on(rawPromptEvent(api), async data => {
            if (rawPromptText(data).includes('outer')) await script.generateRaw({ prompt: 'inner', responseLength: 200 });
        });
        await script.generateRaw({ prompt: 'outer', responseLength: 100 });
        expect(state()).toEqual({ lengths: [200, 100], ...PRESET });
    });

    test.each(APIS)('%s: the raw call that restores last keeps its length and the preset returns', async api => {
        const runtime = await setupOverlapRuntime(api);
        const { first, second, firstCall, secondCall } = await holdTwoRawCalls(runtime, api);
        first.release();
        await firstCall;
        second.release();
        await secondCall;
        expect(runtime.lengths()[1]).toBe(200);
        expect(runtime.preset()).toEqual(PRESET);
    });

    test.each(APIS)('%s: two raw calls that start together leave the preset in place', async api => {
        const { script, requests, preset } = await setupOverlapRuntime(api);
        await Promise.all([
            script.generateRaw({ prompt: 'first', responseLength: 100 }),
            script.generateRaw({ prompt: 'second', responseLength: 200 }),
        ]);
        expect(requests).toHaveLength(2);
        expect(preset()).toEqual(PRESET);
    });

    test.each(APIS)('%s: a raw call inside a quiet prompt leaves the preset in place', async api => {
        const { script, eventSource, state } = await setupOverlapRuntime(api);
        eventSource.on(event_types.GENERATION_STARTED, async () => {
            await script.generateRaw({ prompt: 'raw', responseLength: 200 });
        });
        await script.generateQuietPrompt({ quietPrompt: 'quiet', responseLength: 100 });
        expect(state()).toEqual({ lengths: [200, 100], ...PRESET });
    });

    test.each(APIS)('%s: a quiet prompt inside a raw call leaves the preset in place', async api => {
        const { script, eventSource, state } = await setupOverlapRuntime(api);
        eventSource.on(rawPromptEvent(api), async data => {
            if (rawPromptText(data).includes('raw')) await script.generateQuietPrompt({ quietPrompt: 'quiet', responseLength: 200 });
        });
        await script.generateRaw({ prompt: 'raw', responseLength: 100 });
        expect(state()).toEqual({ lengths: [200, 100], ...PRESET });
    });

    test.each(APIS)('%s: a quiet prompt inside another quiet prompt leaves the preset in place', async api => {
        const { script, eventSource, state } = await setupOverlapRuntime(api);
        let nested = false;
        eventSource.on(event_types.GENERATION_STARTED, async () => {
            if (nested) return;
            nested = true;
            await script.generateQuietPrompt({ quietPrompt: 'inner', responseLength: 200 });
        });
        await script.generateQuietPrompt({ quietPrompt: 'outer', responseLength: 100 });
        expect(state()).toEqual({ lengths: [200, 100], ...PRESET });
    });

    test.each(APIS)('%s: a quiet prompt that starts after a raw call keeps its length and the preset returns', async api => {
        const { script, eventSource, lengths, preset } = await setupOverlapRuntime(api);
        const raw = holdEvent(eventSource, rawPromptEvent(api), data => rawPromptText(data).includes('raw'));
        const quiet = holdEvent(eventSource, event_types.GENERATION_STARTED, () => true);
        const rawCall = script.generateRaw({ prompt: 'raw', responseLength: 100 });
        await raw.reached;
        const quietCall = script.generateQuietPrompt({ quietPrompt: 'quiet', responseLength: 200 });
        await quiet.reached;
        raw.release();
        await rawCall;
        quiet.release();
        await quietCall;
        expect(lengths()[1]).toBe(200);
        expect(preset()).toEqual(PRESET);
    });

    test.each(APIS)('%s: a call without a length inside a quiet prompt leaves the preset in place', async api => {
        const { script, requests, eventSource, preset } = await setupOverlapRuntime(api);
        eventSource.on(event_types.GENERATION_STARTED, async () => {
            await script.generateRaw({ prompt: 'raw' });
        });
        await script.generateQuietPrompt({ quietPrompt: 'quiet', responseLength: 100 });
        expect(requests).toHaveLength(2);
        expect(preset()).toEqual(PRESET);
    });

    test.each(APIS)('%s: a call without a length leaves the preset in place while two quiet prompts wait', async api => {
        const { script, requests, eventSource, preset } = await setupOverlapRuntime(api);
        let started = 0;
        eventSource.on(event_types.GENERATION_STARTED, async () => {
            const index = ++started;
            if (index === 1) await script.generateQuietPrompt({ quietPrompt: 'inner', responseLength: 200 });
            if (index === 2) await script.generateRaw({ prompt: 'raw' });
        });
        await script.generateQuietPrompt({ quietPrompt: 'outer', responseLength: 100 });
        expect(requests).toHaveLength(3);
        expect(preset()).toEqual(PRESET);
    });

    test('a Chat Completion call and a Text Completion call that overlap keep their own presets', async () => {
        const { script, requests, eventSource, preset } = await setupOverlapRuntime('openai');
        const chat = holdEvent(eventSource, event_types.CHAT_COMPLETION_PROMPT_READY, data => rawPromptText(data).includes('chat'));
        const text = holdEvent(eventSource, event_types.GENERATE_AFTER_COMBINE_PROMPTS, data => rawPromptText(data).includes('text'));
        const chatCall = script.generateRawData({ prompt: 'chat', responseLength: 100 });
        await chat.reached;
        const textCall = script.generateRawData({ prompt: 'text', api: 'textgenerationwebui', responseLength: 200 });
        await text.reached;
        chat.release();
        await chatCall;
        text.release();
        await textCall;
        expect(requests.map(request => request.body.max_tokens)).toEqual([100, 200]);
        expect(preset()).toEqual(PRESET);
    });

    test.each(APIS)('%s: the forced restore of a settings save puts the preset back while two calls overlap', async api => {
        const runtime = await setupOverlapRuntime(api);
        const { first, second, firstCall, secondCall } = await holdTwoRawCalls(runtime, api);
        await expect(runtime.script.saveSettings(3, { returnResult: true })).resolves.toBe(true);
        expect(runtime.preset()).toEqual(PRESET);
        first.release();
        second.release();
        await Promise.all([firstCall, secondCall]);
        expect(runtime.state()).toEqual({ lengths: [presetLength(api), presetLength(api)], ...PRESET });
    });

    test.each(APIS)('%s: Stop puts the preset back while two calls overlap', async api => {
        const runtime = await setupOverlapRuntime(api);
        const { first, second, firstCall, secondCall } = await holdTwoRawCalls(runtime, api);
        await runtime.eventSource.emit(event_types.GENERATION_STOPPED);
        first.release();
        second.release();
        await expect(firstCall).rejects.toThrow('Cancelled by extension');
        await expect(secondCall).rejects.toThrow('Cancelled by extension');
        expect(runtime.state()).toEqual({ lengths: [], ...PRESET });
    });
});
