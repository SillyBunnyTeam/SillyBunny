/** @jest-environment jsdom */
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { importScriptModule } from './util/script-harness.js';

const pub = rel => fileURLToPath(new URL(`../public/${rel}`, import.meta.url));

describe('Guided Generations profile and preset compatibility', () => {
    let settings;
    let context;
    let managers;
    let getPresetManager;
    let script;

    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    beforeEach(async () => {
        jest.useRealTimers();
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

        const loaded = await importScriptModule({
            keepReal: ['scripts/utils.js'],
            mocks: {
                'scripts/extensions.js': {
                    extension_settings: settings,
                    getContext: () => context,
                },
                'scripts/preset-manager.js': {
                    getPresetManager,
                },
                'scripts/slash-commands/SlashCommandClosure.js': {
                    SlashCommandClosure: class {},
                },
                'scripts/sillybunny-version-map.js': {
                    mapSillyBunnyVersionToStEquivalent: value => value,
                },
                'scripts/sillybunny-editor/adapters/utility-dialogs.js': {
                    iconPickerOptions: () => ({}),
                },
            },
        });
        script = loaded.script;
        script.changeMainAPI('openai');
    });

    test.each([
        ['helper', 'openai'],
        ['Helper renamed', 'openai'],
        ['local', 'textgenerationwebui'],
        ['main', 'openai'],
        ['', 'openai'],
    ])('maps profile %s to the %s preset manager', async (profile, expected) => {
        const { getProfileApiType } = await import(pub('scripts/extensions/guided-generations/scripts/presetUtils.js'));
        expect(await getProfileApiType(profile)).toBe(expected);
    });

    test.each([
        ['custom', 'openai'],
        ['generic', 'textgenerationwebui'],
        ['koboldhorde', 'kobold'],
        ['chatcompletion', 'openai'],
    ])('normalizes the preset manager for API %s', async (apiType, expected) => {
        const { getPresetsForApiType } = await import(pub('scripts/extensions/guided-generations/scripts/presetUtils.js'));
        await getPresetsForApiType(apiType);
        expect(getPresetManager).toHaveBeenCalledWith(expected);
    });

    test('selects a renamed profile by stored ID and applies the exact preset through its manager', async () => {
        const { handleSwitching } = await import(pub('scripts/extensions/guided-generations/scripts/presetUtils.js'));
        const switching = await handleSwitching('helper', 'Helper | "Voice"');

        await switching.switch();

        expect(context.executeSlashCommandsWithOptions).toHaveBeenCalledWith('/profile await=true "Helper renamed"');
        expect(settings.connectionManager.selectedProfile).toBe('helper');
        expect(managers.openai.selectPreset).toHaveBeenLastCalledWith(2);
        expect(managers.openai.getSelectedPresetName()).toBe('Helper | "Voice"');

        await switching.restore();

        expect(context.executeSlashCommandsWithOptions).toHaveBeenLastCalledWith('/profile await=true "Main chat"');
        expect(settings.connectionManager.selectedProfile).toBe('main');
        expect(managers.openai.getSelectedPresetName()).toBe('Custom chat baseline');
    });

    test('restores the actual original preset after a profile-only impersonation', async () => {
        const { handleSwitching } = await import(pub('scripts/extensions/guided-generations/scripts/presetUtils.js'));
        const switching = await handleSwitching('helper');

        await switching.switch();
        expect(managers.openai.getSelectedPresetName()).toBe('Profile default');

        await switching.restore();
        expect(managers.openai.getSelectedPresetName()).toBe('Custom chat baseline');
    });

    test('continues to accept legacy profile names', async () => {
        const { handleSwitching } = await import(pub('scripts/extensions/guided-generations/scripts/presetUtils.js'));
        const switching = await handleSwitching('Helper renamed');

        await switching.switch();

        expect(context.executeSlashCommandsWithOptions).toHaveBeenCalledWith('/profile await=true "Helper renamed"');
        expect(settings.connectionManager.selectedProfile).toBe('helper');
    });

    test('rejects missing profiles before changing the active connection', async () => {
        const { handleSwitching } = await import(pub('scripts/extensions/guided-generations/scripts/presetUtils.js'));
        const switching = await handleSwitching('deleted-profile-id');

        await expect(switching.switch()).rejects.toThrow('Guided Impersonate connection profile is unavailable.');
        expect(context.executeSlashCommandsWithOptions).not.toHaveBeenCalled();
        expect(settings.connectionManager.selectedProfile).toBe('main');
    });

    test('rejects a failed profile application instead of generating on the previous connection', async () => {
        context.executeSlashCommandsWithOptions.mockResolvedValue(undefined);
        const { handleSwitching } = await import(pub('scripts/extensions/guided-generations/scripts/presetUtils.js'));
        const switching = await handleSwitching('helper');

        await expect(switching.switch()).rejects.toThrow('Guided Impersonate connection profile was not applied.');
        expect(settings.connectionManager.selectedProfile).toBe('main');
    });

    test('rejects a missing preset and can restore the original connection', async () => {
        const { handleSwitching } = await import(pub('scripts/extensions/guided-generations/scripts/presetUtils.js'));
        const switching = await handleSwitching('helper', 'Deleted preset');

        await expect(switching.switch()).rejects.toThrow('Guided Impersonate preset was not applied.');
        await switching.restore();

        expect(settings.connectionManager.selectedProfile).toBe('main');
        expect(managers.openai.getSelectedPresetName()).toBe('Custom chat baseline');
    });

    test('restores an unbound current profile without an extra event waiter', async () => {
        settings.connectionManager.selectedProfile = '';
        const { handleSwitching } = await import(pub('scripts/extensions/guided-generations/scripts/presetUtils.js'));
        const switching = await handleSwitching('helper');

        await switching.switch();
        await switching.restore();

        expect(context.executeSlashCommandsWithOptions).toHaveBeenLastCalledWith('/profile await=true "<None>"');
        expect(settings.connectionManager.selectedProfile).toBe('');
        expect(managers.openai.getSelectedPresetName()).toBe('Custom chat baseline');
    });

    test.each(['novel', 'kobold', 'koboldhorde'])('uses the active %s API for API-excluded text profiles', async api => {
        script.changeMainAPI(api);
        script.setOnlineStatus('connected');
        settings.connectionManager.profiles.push({ id: 'excluded', name: 'Excluded API', mode: 'tc' });
        const { getProfileApiType } = await import(pub('scripts/extensions/guided-generations/scripts/presetUtils.js'));
        const expected = api === 'koboldhorde' ? 'kobold' : api;
        expect(await getProfileApiType('excluded')).toBe(expected);
        expect(await getProfileApiType('Excluded API')).toBe(expected);
    });

    test('waits for delayed preset reconnection and restores across APIs', async () => {
        script.changeMainAPI('openai');
        script.setOnlineStatus('connected');
        const { handleSwitching } = await import(pub('scripts/extensions/guided-generations/scripts/presetUtils.js'));
        jest.useFakeTimers();

        context.executeSlashCommandsWithOptions.mockImplementation(async command => {
            const local = command.includes('Local model');
            settings.connectionManager.selectedProfile = local ? 'local' : 'main';
            script.changeMainAPI(local ? 'textgenerationwebui' : 'openai');
            script.setOnlineStatus('connected');
            await managers[script.main_api].selectPreset(0);
            script.setOnlineStatus('connected');
        });
        for (const manager of [managers.openai, managers.textgenerationwebui]) {
            const select = manager.selectPreset.getMockImplementation();
            manager.selectPreset.mockImplementation(async index => {
                await select(index);
                script.setOnlineStatus('no_connection');
                setTimeout(() => { script.setOnlineStatus('connected'); }, 500);
            });
        }
        const switching = await handleSwitching('local', 'Text helper');
        let ready = false;
        const pending = switching.switch().then(() => { ready = true; });
        await jest.advanceTimersByTimeAsync(400);
        expect(ready).toBe(false);
        await jest.advanceTimersByTimeAsync(200);
        await pending;
        expect(managers.textgenerationwebui.getSelectedPresetName()).toBe('Text helper');
        const restoring = switching.restore();
        await jest.advanceTimersByTimeAsync(600);
        await restoring;
        expect(script.main_api).toBe('openai');
        expect(settings.connectionManager.selectedProfile).toBe('main');
        expect(managers.openai.getSelectedPresetName()).toBe('Custom chat baseline');
        expect(script.online_status).toBe('connected');
    });

    test('preset readiness timeout aborts impersonation before clearing the draft and restores the connection', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        script.changeMainAPI('openai');
        script.setOnlineStatus('connected');
        settings['guided-generations'] = { profileImpersonate1st: 'local', presetImpersonate1st: 'Text helper' };
        const select = managers.textgenerationwebui.selectPreset.getMockImplementation();
        managers.textgenerationwebui.selectPreset.mockImplementation(async index => {
            await select(index);
            script.setOnlineStatus('no_connection');
        });
        const textarea = document.getElementById('send_textarea');
        textarea.value = 'Untouched draft';
        context.executeSlashCommandsWithOptions.mockImplementation(async command => {
            if (command.includes('/impersonate')) {
                textarea.value = '';
                return;
            }
            const local = command.includes('Local model');
            script.changeMainAPI(local ? 'textgenerationwebui' : 'openai');
            script.setOnlineStatus('connected');
            settings.connectionManager.selectedProfile = local ? 'local' : 'main';
            await managers.openai.selectPreset(0);
        });
        const { guidedImpersonate } = await import(pub('scripts/extensions/guided-generations/scripts/guidedImpersonate.js'));
        jest.useFakeTimers();
        const pending = guidedImpersonate();
        await jest.advanceTimersByTimeAsync(11000);
        await pending;
        expect(textarea.value).toBe('Untouched draft');
        expect(context.executeSlashCommandsWithOptions.mock.calls.some(([command]) => command.includes('/impersonate'))).toBe(false);
        expect(settings.connectionManager.selectedProfile).toBe('main');
        expect(managers.openai.getSelectedPresetName()).toBe('Custom chat baseline');
        expect(script.main_api).toBe('openai');
    });

    test('does not wait for an unchanged preset or an already disconnected API', async () => {
        script.changeMainAPI('openai');
        script.setOnlineStatus('connected');
        const { handleSwitching } = await import(pub('scripts/extensions/guided-generations/scripts/presetUtils.js'));
        jest.useFakeTimers();
        await (await handleSwitching('', 'Custom chat baseline')).switch();
        script.setOnlineStatus('no_connection');
        await (await handleSwitching('', 'Helper | "Voice"')).switch();
        expect(jest.getTimerCount()).toBe(0);
    });
});
