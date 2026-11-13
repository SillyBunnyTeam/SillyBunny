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
