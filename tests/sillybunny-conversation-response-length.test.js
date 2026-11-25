import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const PRESET_RESPONSE_LENGTH = 512;
const PRESET_CONTEXT_LENGTH = 32768;
const HORDE_MIN_LENGTH = 16;

const adjustHordeGenerationParams = jest.fn();
const horde_settings = { auto_adjust_response_length: false };

// Each active API gets its own module load, because a mocked `main_api` export cannot change after the import.
async function loadForApi(mainApi) {
    jest.resetModules();
    await jest.unstable_mockModule('../public/script.js', () => ({
        amount_gen: PRESET_RESPONSE_LENGTH,
        main_api: mainApi,
        max_context: PRESET_CONTEXT_LENGTH,
    }));
    await jest.unstable_mockModule('../public/scripts/horde.js', () => ({
        MIN_LENGTH: HORDE_MIN_LENGTH,
        adjustHordeGenerationParams,
        horde_settings,
    }));
    const { getActiveApiResponseLength } = await import('../public/scripts/sillybunny-conversation/response-length.js');
    return getActiveApiResponseLength;
}

const presets = { openai: new Map(), textgenerationwebui: new Map() };
const oaiSettings = { openai_max_tokens: 1200 };

// The length that a scoped profile asks for is read from its preset, so the three modules that know profiles are mocked.
async function loadProfileLength(mainApi) {
    jest.resetModules();
    await jest.unstable_mockModule('../public/script.js', () => ({
        amount_gen: PRESET_RESPONSE_LENGTH,
        main_api: mainApi,
        max_context: PRESET_CONTEXT_LENGTH,
    }));
    await jest.unstable_mockModule('../public/scripts/horde.js', () => ({ MIN_LENGTH: HORDE_MIN_LENGTH, adjustHordeGenerationParams, horde_settings }));
    await jest.unstable_mockModule('../public/scripts/slash-commands.js', () => ({
        CONNECT_API_MAP: { openai: { selected: 'openai' }, ooba: { selected: 'textgenerationwebui' } },
    }));
    await jest.unstable_mockModule('../public/scripts/preset-manager.js', () => ({
        getPresetManager: apiId => ({ getCompletionPresetByName: name => presets[apiId]?.get(name) }),
    }));
    await jest.unstable_mockModule('../public/scripts/openai.js', () => ({ oai_settings: oaiSettings }));
    const { getProfileResponseLength } = await import('../public/scripts/sillybunny-conversation/response-length.js');
    return getProfileResponseLength;
}

function useWorkerLimit(maxLength) {
    horde_settings.auto_adjust_response_length = true;
    adjustHordeGenerationParams.mockResolvedValue({ maxContextLength: PRESET_CONTEXT_LENGTH, maxLength });
}

describe('Conversation Mode response length for the active API', () => {
    beforeEach(() => {
        adjustHordeGenerationParams.mockReset();
        horde_settings.auto_adjust_response_length = false;
    });

    describe('on AI Horde', () => {
        let getActiveApiResponseLength;

        beforeEach(async () => {
            getActiveApiResponseLength = await loadForApi('koboldhorde');
        });

        test('asks for the preset response length instead of a longer Conversation Mode length', async () => {
            await expect(getActiveApiResponseLength(16000)).resolves.toBe(PRESET_RESPONSE_LENGTH);
            expect(adjustHordeGenerationParams).not.toHaveBeenCalled();
        });

        test('lowers the length to the worker limit when Horde adjusts the response length', async () => {
            useWorkerLimit(256);

            await expect(getActiveApiResponseLength(32000)).resolves.toBe(256);
            expect(adjustHordeGenerationParams).toHaveBeenCalledWith(PRESET_CONTEXT_LENGTH, PRESET_RESPONSE_LENGTH);
        });

        test('keeps a length below the preset and the worker limit', async () => {
            useWorkerLimit(PRESET_RESPONSE_LENGTH);

            await expect(getActiveApiResponseLength(80)).resolves.toBe(80);
        });

        test('never asks for less than the Horde minimum', async () => {
            useWorkerLimit(8);

            await expect(getActiveApiResponseLength(80)).resolves.toBe(HORDE_MIN_LENGTH);
        });

        test('gives a request without a length the preset response length', async () => {
            await expect(getActiveApiResponseLength(undefined)).resolves.toBe(PRESET_RESPONSE_LENGTH);
        });

        test('rejects when the worker limits cannot be read', async () => {
            horde_settings.auto_adjust_response_length = true;
            adjustHordeGenerationParams.mockRejectedValue(new Error('No Horde model available'));

            await expect(getActiveApiResponseLength(16000)).rejects.toThrow('No Horde model available');
        });
    });

    test.each(['openai', 'textgenerationwebui', 'kobold', 'novel'])('keeps the length on %s', async (mainApi) => {
        const getActiveApiResponseLength = await loadForApi(mainApi);
        useWorkerLimit(256);

        await expect(getActiveApiResponseLength(16000)).resolves.toBe(16000);
        await expect(getActiveApiResponseLength(undefined)).resolves.toBeUndefined();
        expect(adjustHordeGenerationParams).not.toHaveBeenCalled();
    });
});

describe('Conversation Mode response length for a scoped connection profile', () => {
    beforeEach(() => {
        presets.openai.clear();
        presets.textgenerationwebui.clear();
        oaiSettings.openai_max_tokens = 1200;
    });

    test('is the response length of the preset of a Chat Completion profile', async () => {
        presets.openai.set('Warm', { openai_max_tokens: 700 });
        const getProfileResponseLength = await loadProfileLength('openai');

        await expect(getProfileResponseLength({ api: 'openai', preset: 'Warm' })).resolves.toBe(700);
    });

    test('is the response length of the preset of a Text Completion profile', async () => {
        presets.textgenerationwebui.set('Short', { genamt: 350 });
        const getProfileResponseLength = await loadProfileLength('openai');

        await expect(getProfileResponseLength({ api: 'ooba', preset: 'Short' })).resolves.toBe(350);
    });

    test('is the response length of the active connection for a profile without a preset, or whose preset is gone', async () => {
        const onChat = await loadProfileLength('openai');
        await expect(onChat({ api: 'openai', preset: '' })).resolves.toBe(1200);
        await expect(onChat({ api: 'openai', preset: 'Missing' })).resolves.toBe(1200);

        const onText = await loadProfileLength('textgenerationwebui');
        await expect(onText({ api: 'ooba', preset: '' })).resolves.toBe(PRESET_RESPONSE_LENGTH);
    });
});
