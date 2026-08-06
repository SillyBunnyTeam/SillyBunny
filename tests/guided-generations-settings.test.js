import { describe, test, expect, jest, beforeEach } from '@jest/globals';

describe('Guided Generations settings migration', () => {
    let extensionSettings;
    let saveSettingsDebounced;

    beforeEach(async () => {
        jest.resetModules();

        extensionSettings = {};
        saveSettingsDebounced = jest.fn();

        await jest.unstable_mockModule('../public/script.js', () => ({
            saveSettingsDebounced,
            eventSource: { on: jest.fn() },
            event_types: {},
        }));
        await jest.unstable_mockModule('../public/scripts/extensions.js', () => ({
            extensionNames: [],
            extension_settings: extensionSettings,
            renderExtensionTemplateAsync: jest.fn(async () => ''),
        }));
        await jest.unstable_mockModule('../public/scripts/extensions/guided-generations/scripts/shared.js', () => ({
            extensionName: 'guided-generations',
            flushActiveGuides: jest.fn(async () => []),
            getActiveGuides: jest.fn(() => []),
            getPresetsForApiType: jest.fn(async () => []),
            getProfileApiType: jest.fn(async () => ''),
            getProfileList: jest.fn(async () => []),
            resolveStoredProfile: jest.fn(() => null),
        }));
        await jest.unstable_mockModule('../public/scripts/extensions/guided-generations/scripts/guidedCorrection.js', () => ({
            guidedCorrection: jest.fn(),
        }));
        await jest.unstable_mockModule('../public/scripts/extensions/guided-generations/scripts/guidedImpersonate.js', () => ({
            guidedImpersonate: jest.fn(),
        }));
        await jest.unstable_mockModule('../public/scripts/extensions/guided-generations/scripts/guidedResponse.js', () => ({
            guidedResponse: jest.fn(),
        }));
        await jest.unstable_mockModule('../public/scripts/extensions/guided-generations/scripts/guidedSwipe.js', () => ({
            guidedSwipe: jest.fn(),
        }));
        await jest.unstable_mockModule('../public/scripts/extensions/guided-generations/scripts/legacyForkWarning.js', () => ({
            markOldExtensionWarningDismissed: jest.fn(),
            shouldWarnOldExtensionDeprecated: jest.fn(() => false),
        }));
        await jest.unstable_mockModule('../public/scripts/extensions/guided-generations/scripts/simpleSend.js', () => ({
            simpleSend: jest.fn(),
        }));
    });

    test('removes legacy GGSystemPrompt values migrated into native settings', async () => {
        extensionSettings['GuidedGenerations-Extension'] = {
            promptGuidedResponse: 'GGSystemPrompt',
            promptGuidedSwipe: 'GGSytemPrompt',
            promptGuidedCorrection: 'custom correction: {{input}}',
            promptImpersonate1st: 'GGSytemPrompt',
            presetImpersonate1st: 'GGSytemPrompt',
        };

        const { defaultSettings, loadSettings } = await import('../public/scripts/extensions/guided-generations/index.js');

        loadSettings();

        expect(extensionSettings['guided-generations']).toMatchObject({
            _migrated: true,
            promptGuidedResponse: defaultSettings.promptGuidedResponse,
            promptGuidedSwipe: defaultSettings.promptGuidedSwipe,
            promptGuidedCorrection: 'custom correction: {{input}}',
            promptImpersonate1st: defaultSettings.promptImpersonate1st,
            presetImpersonate1st: '',
        });
        expect(saveSettingsDebounced).toHaveBeenCalledTimes(1);
    });

    test('cleans stale legacy preset references after the migration marker already exists', async () => {
        extensionSettings['guided-generations'] = {
            _migrated: true,
            promptGuidedResponse: 'keep this custom prompt: {{input}}',
            presetImpersonate1st: 'GGSystemPrompt',
            presetGuidedSwipe: 'GGSytemPrompt',
        };

        const { loadSettings } = await import('../public/scripts/extensions/guided-generations/index.js');

        loadSettings();

        expect(extensionSettings['guided-generations'].promptGuidedResponse).toBe('keep this custom prompt: {{input}}');
        expect(extensionSettings['guided-generations'].presetImpersonate1st).toBe('');
        expect(extensionSettings['guided-generations'].presetGuidedSwipe).toBeUndefined();
        expect(saveSettingsDebounced).toHaveBeenCalledTimes(1);
    });

    test('keeps valid custom presets and prompts unchanged', async () => {
        extensionSettings['guided-generations'] = {
            promptGuidedResponse: 'use my custom guide: {{input}}',
            presetImpersonate1st: 'My Custom Preset',
        };

        const { loadSettings } = await import('../public/scripts/extensions/guided-generations/index.js');

        loadSettings();

        expect(extensionSettings['guided-generations'].promptGuidedResponse).toBe('use my custom guide: {{input}}');
        expect(extensionSettings['guided-generations'].presetImpersonate1st).toBe('My Custom Preset');
        expect(saveSettingsDebounced).not.toHaveBeenCalled();
    });

    test('adds an empty helper prefill setting by default without forcing a save', async () => {
        const { loadSettings } = await import('../public/scripts/extensions/guided-generations/index.js');

        loadSettings();

        expect(extensionSettings['guided-generations'].helperPrefillMessages).toBe('');
        expect(saveSettingsDebounced).not.toHaveBeenCalled();
    });
});
