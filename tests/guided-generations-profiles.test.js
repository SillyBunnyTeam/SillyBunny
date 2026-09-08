import { beforeEach, describe, expect, jest, test } from '@jest/globals';

describe('Guided Generations profile and preset compatibility', () => {
    let settings;
    let context;
    let managers;
    let getPresetManager;

    beforeEach(async () => {
        jest.resetModules();
        settings = {
            connectionManager: {
                selectedProfile: 'main',
                profiles: [
                    { id: 'main', name: 'Main chat', api: 'openai', mode: 'cc' },
                    { id: 'helper', name: 'Helper renamed', api: 'claude', mode: 'cc' },
                    { id: 'local', name: 'Local model', api: 'koboldcpp', mode: 'tc' },
                ],
            },
        };
        const createManager = (initial, names) => {
            let selected = initial;
            return {
                getSelectedPresetName: jest.fn(() => selected),
                getAllPresets: jest.fn(() => names),
                findPreset: jest.fn(name => names.indexOf(name) >= 0 ? names.indexOf(name) : undefined),
                selectPreset: jest.fn(async index => { selected = names[index]; }),
            };
        };
        managers = {
            openai: createManager('Custom chat baseline', ['Profile default', 'Custom chat baseline', 'Helper | "Voice"']),
            textgenerationwebui: createManager('Text default', ['Text default', 'Text helper']),
            kobold: createManager('Kobold default', ['Kobold default']),
        };
        getPresetManager = jest.fn(api => managers[api]);
        context = {
            extensionSettings: settings,
            CONNECT_API_MAP: {
                openai: { selected: 'openai', source: 'openai' },
                claude: { selected: 'openai', source: 'claude' },
                custom: { selected: 'openai', source: 'custom' },
                koboldcpp: { selected: 'textgenerationwebui', type: 'koboldcpp' },
                generic: { selected: 'textgenerationwebui', type: 'generic' },
            },
            executeSlashCommandsWithOptions: jest.fn(async command => {
                const name = JSON.parse(command.replace('/profile await=true ', ''));
                settings.connectionManager.selectedProfile = settings.connectionManager.profiles.find(profile => profile.name === name)?.id ?? '';
                await managers.openai.selectPreset(0);
            }),
        };

        await jest.unstable_mockModule('../public/script.js', () => ({ main_api: 'openai' }));
        await jest.unstable_mockModule('../public/scripts/extensions.js', () => ({
            extension_settings: settings,
            getContext: () => context,
        }));
        await jest.unstable_mockModule('../public/scripts/preset-manager.js', () => ({ getPresetManager }));
    });

    test.each([
        ['helper', 'openai'],
        ['Helper renamed', 'openai'],
        ['local', 'textgenerationwebui'],
        ['main', 'openai'],
        ['', 'openai'],
    ])('maps profile %s to the %s preset manager', async (profile, expectedApi) => {
        const { getProfileApiType, getPresetsForApiType } = await import('../public/scripts/extensions/guided-generations/scripts/presetUtils.js');

        const api = await getProfileApiType(profile);
        const presets = await getPresetsForApiType(api);

        expect(api).toBe(expectedApi);
        expect(presets).toEqual(managers[expectedApi].getAllPresets());
        expect(getPresetManager).toHaveBeenCalledWith(expectedApi);
    });

    test.each(['custom', 'generic', 'koboldhorde', 'chatcompletion'])('normalizes the preset manager for API %s', async api => {
        const { getPresetsForApiType } = await import('../public/scripts/extensions/guided-generations/scripts/presetUtils.js');

        await getPresetsForApiType(api);

        const expectedApi = { custom: 'openai', generic: 'textgenerationwebui', koboldhorde: 'kobold', chatcompletion: 'openai' }[api];
        expect(getPresetManager).toHaveBeenCalledWith(expectedApi);
    });

    test('selects a renamed profile by stored ID and applies the exact preset through its manager', async () => {
        const { handleSwitching } = await import('../public/scripts/extensions/guided-generations/scripts/presetUtils.js');
        const switching = await handleSwitching('helper', 'Helper | "Voice"');

        await switching.switch();

        expect(settings.connectionManager.selectedProfile).toBe('helper');
        expect(context.executeSlashCommandsWithOptions).toHaveBeenCalledWith('/profile await=true "Helper renamed"');
        expect(managers.openai.getSelectedPresetName()).toBe('Helper | "Voice"');
        expect(context.executeSlashCommandsWithOptions.mock.calls.some(([command]) => command.startsWith('/preset'))).toBe(false);

        await switching.restore();

        expect(settings.connectionManager.selectedProfile).toBe('main');
        expect(managers.openai.getSelectedPresetName()).toBe('Custom chat baseline');
    });

    test('restores the actual original preset after a profile-only impersonation', async () => {
        const { handleSwitching } = await import('../public/scripts/extensions/guided-generations/scripts/presetUtils.js');
        const switching = await handleSwitching('helper');

        await switching.switch();
        expect(managers.openai.getSelectedPresetName()).toBe('Profile default');
        await switching.restore();

        expect(settings.connectionManager.selectedProfile).toBe('main');
        expect(managers.openai.getSelectedPresetName()).toBe('Custom chat baseline');
    });

    test('continues to accept legacy profile names', async () => {
        const { handleSwitching } = await import('../public/scripts/extensions/guided-generations/scripts/presetUtils.js');
        const switching = await handleSwitching('Helper renamed', 'Helper | "Voice"');

        await switching.switch();
        expect(settings.connectionManager.selectedProfile).toBe('helper');
        await switching.restore();
        expect(settings.connectionManager.selectedProfile).toBe('main');
    });

    test('rejects missing profiles before changing the active connection', async () => {
        const { handleSwitching } = await import('../public/scripts/extensions/guided-generations/scripts/presetUtils.js');
        const switching = await handleSwitching('deleted-profile');

        await expect(switching.switch()).rejects.toThrow('connection profile is unavailable');

        expect(context.executeSlashCommandsWithOptions).not.toHaveBeenCalled();
        expect(settings.connectionManager.selectedProfile).toBe('main');
    });

    test('rejects a failed profile application instead of generating on the previous connection', async () => {
        context.executeSlashCommandsWithOptions.mockResolvedValue({ pipe: '' });
        const { handleSwitching } = await import('../public/scripts/extensions/guided-generations/scripts/presetUtils.js');
        const switching = await handleSwitching('helper');

        await expect(switching.switch()).rejects.toThrow('connection profile was not applied');
        expect(settings.connectionManager.selectedProfile).toBe('main');
    });

    test('rejects a missing preset and can restore the original connection', async () => {
        const { handleSwitching } = await import('../public/scripts/extensions/guided-generations/scripts/presetUtils.js');
        const switching = await handleSwitching('helper', 'Missing preset');

        await expect(switching.switch()).rejects.toThrow('preset was not applied');
        await switching.restore();

        expect(settings.connectionManager.selectedProfile).toBe('main');
        expect(managers.openai.getSelectedPresetName()).toBe('Custom chat baseline');
    });

    test('restores an unbound current profile without an extra event waiter', async () => {
        settings.connectionManager.selectedProfile = '';
        const { handleSwitching } = await import('../public/scripts/extensions/guided-generations/scripts/presetUtils.js');
        const switching = await handleSwitching('helper');

        await switching.switch();
        await switching.restore();

        expect(context.executeSlashCommandsWithOptions).toHaveBeenLastCalledWith('/profile await=true "<None>"');
        expect(settings.connectionManager.selectedProfile).toBe('');
        expect(managers.openai.getSelectedPresetName()).toBe('Custom chat baseline');
    });
});
