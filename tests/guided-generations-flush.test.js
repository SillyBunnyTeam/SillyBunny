import { describe, test, expect, jest, beforeEach } from '@jest/globals';

describe('Guided Generations flush guides', () => {
    let context;
    let executeSlashCommandsWithOptions;

    beforeEach(async () => {
        jest.resetModules();

        executeSlashCommandsWithOptions = jest.fn(async command => {
            const id = String(command).replace('/flushinject ', '');
            delete context.chatMetadata.script_injects[id];
        });
        context = {
            chatMetadata: {
                script_injects: {},
            },
            executeSlashCommandsWithOptions,
        };

        await jest.unstable_mockModule('../public/scripts/extensions.js', () => ({
            extension_settings: {},
            getContext: () => context,
        }));
        await jest.unstable_mockModule('../public/scripts/extensions/guided-generations/scripts/presetUtils.js', () => ({
            getCurrentProfile: jest.fn(),
            getCurrentProfileId: jest.fn(),
            getPresetsForApiType: jest.fn(async () => []),
            getProfileApiType: jest.fn(async () => ''),
            getProfileById: jest.fn(),
            getProfileList: jest.fn(async () => []),
            handleSwitching: jest.fn(),
            resolveStoredProfile: jest.fn(),
        }));
    });

    test('detects only active guided-generation injects', async () => {
        context.chatMetadata.script_injects = {
            instruct: { value: 'guide' },
            unrelated: { value: 'other inject' },
            correction: { value: 'correction' },
            'gg-guided-response': { value: 'guide' },
            'gg-guided-correction': { value: 'correction' },
        };

        const { getActiveGuides } = await import('../public/scripts/extensions/guided-generations/scripts/shared.js');

        expect(getActiveGuides()).toEqual(['gg-guided-response', 'gg-guided-correction']);
    });

    test('flushes only active guided-generation injects', async () => {
        const unrelatedInject = { value: 'other inject' };
        const instructInject = { value: 'foreign instruct' };
        context.chatMetadata.script_injects = {
            instruct: instructInject,
            unrelated: unrelatedInject,
            'gg-guided-swipe': { value: 'guide' },
            'gg-impersonate-voice': { value: 'voice' },
        };

        const { flushActiveGuides } = await import('../public/scripts/extensions/guided-generations/scripts/shared.js');

        await expect(flushActiveGuides()).resolves.toEqual(['gg-guided-swipe', 'gg-impersonate-voice']);
        expect(executeSlashCommandsWithOptions).toHaveBeenNthCalledWith(1, '/flushinject gg-guided-swipe');
        expect(executeSlashCommandsWithOptions).toHaveBeenNthCalledWith(2, '/flushinject gg-impersonate-voice');
        expect(executeSlashCommandsWithOptions).toHaveBeenCalledTimes(2);
        expect(context.chatMetadata.script_injects).toEqual({ instruct: instructInject, unrelated: unrelatedInject });
    });

    test('does nothing when no guided-generation injects are active', async () => {
        context.chatMetadata.script_injects = {
            unrelated: { value: 'other inject' },
        };

        const { flushActiveGuides } = await import('../public/scripts/extensions/guided-generations/scripts/shared.js');

        await expect(flushActiveGuides()).resolves.toEqual([]);
        expect(executeSlashCommandsWithOptions).not.toHaveBeenCalled();
    });
});
