/* eslint-disable playwright/no-standalone-expect -- Jest contracts for a state machine. */
import { describe, expect, jest, test } from '@jest/globals';
import { createBundledExtrasActions } from '../../public/scripts/sillybunny-home/bundled-extras-actions.js';

const extension = { id: 'deep-swipe', name: 'Deep Swipe', group: 'first-party-extensions', kind: 'extension', url: 'https://github.com/SillyBunnyTeam/SillyBunny-Deep-Swipe' };
const themeExtension = { id: 'terminal-ui', name: 'Terminal UI', group: 'themes', kind: 'theme-extension', url: 'https://github.com/SillyBunnyTeam/SillyBunny-Terminal-UI' };
const preset = { id: 'tld', name: 'TLD', group: 'presets', kind: 'preset', url: 'https://example.com', presetName: 'TLD Card Conversion Preset (Standalone)' };
const cssTheme = { id: 'midnight', name: 'Midnight', group: 'themes', kind: 'theme-css', url: 'https://example.com', themeName: 'Midnight' };
const assistant = { id: 'nahida', name: 'Nahida', group: 'assistants', kind: 'assistant', url: null };

/** Adapters over a small fake world: the extension names that are installed, which of them are enabled, and so on. */
function createWorld({ installed = {}, presets = [], themes = [], assistants = [], canRemove = true } = {}) {
    const world = { installed: { ...installed }, presets: new Set(presets), themes: new Set(themes), assistants: new Set(assistants) };
    const adapters = {
        extensions: {
            find: jest.fn(folder => (folder in world.installed ? { name: `third-party/${folder}`, enabled: world.installed[folder] } : null)),
            install: jest.fn(async (url) => { world.installed[new URL(url).pathname.split('/').at(-1)] = false; return true; }),
            enable: jest.fn(async (name) => { world.installed[name.replace('third-party/', '')] = true; }),
            disable: jest.fn(async (name) => { world.installed[name.replace('third-party/', '')] = false; }),
            remove: jest.fn(async (name) => { delete world.installed[name.replace('third-party/', '')]; }),
            canRemove: jest.fn(() => canRemove),
        },
        presets: {
            has: jest.fn(name => world.presets.has(name)),
            restore: jest.fn(async (name) => { world.presets.add(name); }),
        },
        assistants: {
            has: jest.fn(id => world.assistants.has(id)),
            install: jest.fn(async (id) => { world.assistants.add(id); }),
        },
        themes: {
            has: jest.fn(name => world.themes.has(name)),
            install: jest.fn(async () => { world.themes.add('Midnight Blue'); return { name: 'Midnight Blue' }; }),
            apply: jest.fn(async () => {}),
        },
    };
    return { world, adapters, actions: createBundledExtrasActions(adapters) };
}

describe('the state of an extension row', () => {
    test('is not installed, and offers to install, when the extension list does not know the folder', () => {
        const { actions, adapters } = createWorld();

        expect(actions.getState(extension)).toEqual({ status: 'not-installed', actions: ['install'] });
        expect(adapters.extensions.find).toHaveBeenCalledWith('SillyBunny-Deep-Swipe');
    });

    test('is installed, and offers to enable or remove, when the extension is switched off', () => {
        const { actions } = createWorld({ installed: { 'SillyBunny-Deep-Swipe': false } });

        expect(actions.getState(extension)).toEqual({ status: 'installed', actions: ['enable', 'remove'] });
    });

    test('is enabled, and offers to disable or remove, when the extension is on', () => {
        const { actions } = createWorld({ installed: { 'SillyBunny-Deep-Swipe': true } });

        expect(actions.getState(extension)).toEqual({ status: 'enabled', actions: ['disable', 'remove'] });
    });

    test('offers no removal of an extension that the user may not remove', () => {
        const { actions, adapters } = createWorld({ installed: { 'SillyBunny-Deep-Swipe': true }, canRemove: false });

        expect(actions.getState(extension)).toEqual({ status: 'enabled', actions: ['disable'] });
        expect(adapters.extensions.canRemove).toHaveBeenCalledWith('third-party/SillyBunny-Deep-Swipe');
    });

    test('is the same for a theme that is an extension', () => {
        const { actions } = createWorld({ installed: { 'SillyBunny-Terminal-UI': true } });

        expect(actions.getState(themeExtension)).toEqual({ status: 'enabled', actions: ['disable', 'remove'] });
    });
});

describe('running an action on an extension row', () => {
    test('installs from the address of the item, and then reports the extension as installed', async () => {
        const { actions, adapters } = createWorld();

        const state = await actions.run(extension, 'install');

        expect(adapters.extensions.install).toHaveBeenCalledTimes(1);
        expect(adapters.extensions.install).toHaveBeenCalledWith('https://github.com/SillyBunnyTeam/SillyBunny-Deep-Swipe');
        expect(state).toEqual({ status: 'installed', actions: ['enable', 'remove'] });
    });

    test('enables, disables and removes the extension by the name the list gave', async () => {
        const { actions, adapters } = createWorld({ installed: { 'SillyBunny-Deep-Swipe': false } });

        await actions.run(extension, 'enable');
        expect(adapters.extensions.enable).toHaveBeenCalledWith('third-party/SillyBunny-Deep-Swipe');
        expect(actions.getState(extension).status).toBe('enabled');

        await actions.run(extension, 'disable');
        expect(adapters.extensions.disable).toHaveBeenCalledWith('third-party/SillyBunny-Deep-Swipe');
        expect(actions.getState(extension).status).toBe('installed');

        await actions.run(extension, 'remove');
        expect(adapters.extensions.remove).toHaveBeenCalledWith('third-party/SillyBunny-Deep-Swipe');
        expect(actions.getState(extension).status).toBe('not-installed');
    });

    test('refuses an action that the state does not offer, and does nothing', async () => {
        const { actions, adapters } = createWorld();

        await expect(actions.run(extension, 'enable')).rejects.toThrow(/not offered/i);
        await expect(actions.run(extension, 'remove')).rejects.toThrow(/not offered/i);

        expect(adapters.extensions.enable).not.toHaveBeenCalled();
        expect(adapters.extensions.remove).not.toHaveBeenCalled();
    });

    test('refuses a removal that the user may not make, even when asked for', async () => {
        const { actions, adapters } = createWorld({ installed: { 'SillyBunny-Deep-Swipe': true }, canRemove: false });

        await expect(actions.run(extension, 'remove')).rejects.toThrow(/not offered/i);
        expect(adapters.extensions.remove).not.toHaveBeenCalled();
    });
});

describe('the state of a preset row', () => {
    test('is installed, with nothing to do, when the preset is in the preset list', () => {
        const { actions, adapters } = createWorld({ presets: [preset.presetName] });

        expect(actions.getState(preset)).toEqual({ status: 'installed', actions: [] });
        expect(adapters.presets.has).toHaveBeenCalledWith('TLD Card Conversion Preset (Standalone)');
    });

    test('is not installed, and offers to restore it, when the preset is not in the list', async () => {
        const { actions, adapters } = createWorld();
        expect(actions.getState(preset)).toEqual({ status: 'not-installed', actions: ['restore'] });

        const state = await actions.run(preset, 'restore');

        expect(adapters.presets.restore).toHaveBeenCalledWith('TLD Card Conversion Preset (Standalone)');
        expect(state).toEqual({ status: 'installed', actions: [] });
    });
});

describe('the state of a third-party CSS theme row', () => {
    test('is not installed, and offers to install, when the UI theme list lacks its name', () => {
        const { actions } = createWorld();

        expect(actions.getState(cssTheme)).toEqual({ status: 'not-installed', actions: ['install'] });
    });

    test('is installed, and offers to apply, when the UI theme list has its name', () => {
        const { actions } = createWorld({ themes: ['Midnight'] });

        expect(actions.getState(cssTheme)).toEqual({ status: 'installed', actions: ['apply'] });
    });

    test('installs by id, and then goes by the name the server returned', async () => {
        const { actions, adapters } = createWorld();

        const state = await actions.run(cssTheme, 'install');

        expect(adapters.themes.install).toHaveBeenCalledWith('midnight');
        expect(state).toEqual({ status: 'installed', actions: ['apply'] });
        await actions.run(cssTheme, 'apply');
        expect(adapters.themes.apply).toHaveBeenCalledWith('Midnight Blue');
    });

    test('stays not installed when the install fails, and passes the failure on', async () => {
        const { actions, adapters } = createWorld();
        adapters.themes.install.mockRejectedValueOnce(new Error('upstream_failed'));

        await expect(actions.run(cssTheme, 'install')).rejects.toThrow('upstream_failed');

        expect(actions.getState(cssTheme).status).toBe('not-installed');
    });
});

describe('the state of an assistant row', () => {
    test('is not installed, and offers to install, while the library has no card for the assistant', () => {
        const { actions, adapters } = createWorld();

        expect(actions.getState(assistant)).toEqual({ status: 'not-installed', actions: ['install'] });
        expect(adapters.assistants.has).toHaveBeenCalledWith('nahida');
    });

    test('is installed, and offers nothing, once the library has her card, so removing her is deleting a character', () => {
        const { actions } = createWorld({ assistants: ['nahida'] });

        expect(actions.getState(assistant)).toEqual({ status: 'installed', actions: [] });
    });

    test('offers to install again after her card is deleted', () => {
        const { actions, world } = createWorld({ assistants: ['nahida'] });
        world.assistants.delete('nahida');

        expect(actions.getState(assistant)).toEqual({ status: 'not-installed', actions: ['install'] });
    });
});

describe('running an action on an assistant row', () => {
    test('installs the assistant by its id, and then reports her as installed', async () => {
        const { actions, adapters } = createWorld();

        const state = await actions.run(assistant, 'install');

        expect(adapters.assistants.install).toHaveBeenCalledTimes(1);
        expect(adapters.assistants.install).toHaveBeenCalledWith('nahida');
        expect(state).toEqual({ status: 'installed', actions: [] });
    });

    test('refuses an action that the state does not offer, and installs nothing', async () => {
        const { actions, adapters } = createWorld({ assistants: ['nahida'] });

        await expect(actions.run(assistant, 'install')).rejects.toThrow(/not offered/);
        await expect(actions.run(assistant, 'remove')).rejects.toThrow(/not offered/);

        expect(adapters.assistants.install).not.toHaveBeenCalled();
    });

    test('keeps the row not installed, and passes the error on, when the install fails', async () => {
        const { actions, adapters } = createWorld();
        adapters.assistants.install.mockRejectedValueOnce(new Error('import failed'));

        await expect(actions.run(assistant, 'install')).rejects.toThrow('import failed');

        expect(actions.getState(assistant).status).toBe('not-installed');
    });

    test('never touches the extension, preset or theme adapters', async () => {
        const { actions, adapters } = createWorld();

        await actions.run(assistant, 'install');

        for (const adapter of [adapters.extensions, adapters.presets, adapters.themes]) {
            for (const method of Object.values(adapter)) {
                expect(method).not.toHaveBeenCalled();
            }
        }
    });
});
