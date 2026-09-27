/* global globalThis */
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const presetSource = readFileSync(new URL('../public/scripts/extensions/guided-generations/scripts/presetUtils.js', import.meta.url), 'utf8');
const utilsSource = readFileSync(new URL('../public/scripts/utils.js', import.meta.url), 'utf8');

describe('Guided Generations profile and preset compatibility', () => {
    let settings;
    let context;
    let managers;
    let getPresetManager;

    function loadLivePresets(api = 'openai', status = 'connected') {
        const state = {
            main_api: api,
            online_status: status,
            extension_settings: settings,
            getContext: () => context,
            getPresetManager,
            setTimeout, clearTimeout, setInterval, clearInterval, console,
        };
        const waitSource = utilsSource.slice(utilsSource.indexOf('export async function waitUntilCondition('), utilsSource.indexOf('\n/**', utilsSource.indexOf('export async function waitUntilCondition(')));
        const exports = presetSource.match(/export \{([\s\S]*?)\};/)[1];
        const presets = runInNewContext(`${waitSource.replace('export ', '')}\n${presetSource.replace(/^import .*;\n/gm, '').replace(/export \{[\s\S]*?\};/, '')}\n({${exports}})`, state);
        return { state, presets };
    }

    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

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

        await jest.unstable_mockModule('../public/script.js', () => ({ main_api: 'openai', online_status: 'no_connection' }));
        await jest.unstable_mockModule('../public/scripts/utils.js', () => ({ waitUntilCondition: jest.fn() }));
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

    test.each(['novel', 'kobold', 'koboldhorde'])('uses the active %s API for API-excluded text profiles', async api => {
        settings.connectionManager.profiles.push({ id: 'excluded', name: 'Excluded API', mode: 'tc' });
        const { presets } = loadLivePresets(api);
        const expected = api === 'koboldhorde' ? 'kobold' : api;
        expect(await presets.getProfileApiType('excluded')).toBe(expected);
        expect(await presets.getProfileApiType('Excluded API')).toBe(expected);
    });

    test('waits for delayed preset reconnection and restores across APIs', async () => {
        jest.useFakeTimers();
        const { state, presets } = loadLivePresets();
        context.executeSlashCommandsWithOptions.mockImplementation(async command => {
            const local = command.includes('Local model');
            settings.connectionManager.selectedProfile = local ? 'local' : 'main';
            state.main_api = local ? 'textgenerationwebui' : 'openai';
            state.online_status = 'connected';
            await managers[state.main_api].selectPreset(0);
            state.online_status = 'connected';
        });
        for (const manager of [managers.openai, managers.textgenerationwebui]) {
            const select = manager.selectPreset.getMockImplementation();
            manager.selectPreset.mockImplementation(async index => {
                await select(index);
                state.online_status = 'no_connection';
                setTimeout(() => { state.online_status = 'connected'; }, 500);
            });
        }
        const switching = await presets.handleSwitching('local', 'Text helper');
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
        expect(state.main_api).toBe('openai');
        expect(settings.connectionManager.selectedProfile).toBe('main');
        expect(managers.openai.getSelectedPresetName()).toBe('Custom chat baseline');
        expect(state.online_status).toBe('connected');
    });

    test('preset readiness timeout aborts impersonation before clearing the draft and restores the connection', async () => {
        jest.useFakeTimers();
        jest.spyOn(console, 'error').mockImplementation(() => {});
        const { state, presets } = loadLivePresets();
        settings['guided-generations'] = { profileImpersonate1st: 'local', presetImpersonate1st: 'Text helper' };
        const select = managers.textgenerationwebui.selectPreset.getMockImplementation();
        managers.textgenerationwebui.selectPreset.mockImplementation(async index => {
            await select(index);
            state.online_status = 'no_connection';
        });
        context.executeSlashCommandsWithOptions.mockImplementation(async command => {
            if (command.includes('/impersonate')) {
                textarea.value = '';
                return;
            }
            const local = command.includes('Local model');
            state.main_api = local ? 'textgenerationwebui' : 'openai';
            state.online_status = 'connected';
            settings.connectionManager.selectedProfile = local ? 'local' : 'main';
            await managers.openai.selectPreset(0);
        });
        class Textarea {}
        const textarea = new Textarea();
        textarea.value = 'Untouched draft';
        textarea.dispatchEvent = jest.fn();
        globalThis.HTMLTextAreaElement = Textarea;
        globalThis.document = { getElementById: () => textarea };
        await jest.unstable_mockModule('../public/scripts/extensions/guided-generations/scripts/presetUtils.js', () => presets);
        const { guidedImpersonate } = await import('../public/scripts/extensions/guided-generations/scripts/guidedImpersonate.js');
        const pending = guidedImpersonate();
        await jest.advanceTimersByTimeAsync(11000);
        await pending;
        expect(textarea.value).toBe('Untouched draft');
        expect(context.executeSlashCommandsWithOptions.mock.calls.some(([command]) => command.includes('/impersonate'))).toBe(false);
        expect(settings.connectionManager.selectedProfile).toBe('main');
        expect(managers.openai.getSelectedPresetName()).toBe('Custom chat baseline');
        expect(state.main_api).toBe('openai');
    });

    test('does not wait for an unchanged preset or an already disconnected API', async () => {
        jest.useFakeTimers();
        const { state, presets } = loadLivePresets();
        await (await presets.handleSwitching('', 'Custom chat baseline')).switch();
        state.online_status = 'no_connection';
        await (await presets.handleSwitching('', 'Helper | "Voice"')).switch();
        expect(jest.getTimerCount()).toBe(0);
    });
});
