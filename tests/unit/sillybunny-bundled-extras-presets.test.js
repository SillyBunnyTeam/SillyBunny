/* eslint-disable playwright/no-standalone-expect -- Jest contracts for an adapter and for shipped data. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, jest, test } from '@jest/globals';

jest.unstable_mockModule('../../src/util.js', () => ({
    color: {
        blue: value => value,
        yellow: value => value,
    },
    getConfigValue: jest.fn((_key, defaultValue) => defaultValue),
    isValidUrl: jest.fn(() => false),
    recoverFileWriteSync: jest.fn(),
    setPermissionsSync: jest.fn(),
}));
// content-manager loads the thumbnail module, which needs more of util.js than this mock gives.
jest.unstable_mockModule('../../src/endpoints/thumbnails.js', () => ({ invalidateThumbnail: jest.fn() }));
jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => String.raw({ raw: strings }, ...values),
}));

const { createPresetsAdapter } = await import('../../public/scripts/sillybunny-home/bundled-extras-presets.js');
const { BUNDLED_EXTRAS } = await import('../../public/scripts/sillybunny-bundled-extras.js');
const contentManager = await import('../../src/endpoints/content-manager.js');

const NAME = 'Geechan - Universal Roleplay (Chat Completions) (v5.2)';

/** A preset manager of the openai list, which keeps what it is asked to do. */
function createFakeManager({ listed = [], bundled = { isDefault: true, preset: { temperature: 1 } } } = {}) {
    const names = new Set(listed);
    return {
        names,
        findPreset: jest.fn(name => (names.has(name) ? name : undefined)),
        getDefaultPreset: jest.fn(async () => bundled),
        savePreset: jest.fn(async () => {}),
        refreshRestoredDefaultOptions: jest.fn(async () => {}),
        restoreDefaultPresets: jest.fn(async () => ({ restored: [] })),
    };
}

const adapterOf = manager => createPresetsAdapter({ getManager: () => manager, apiId: 'openai' });

describe('the presets adapter of Bundled Extras', () => {
    test('says whether the preset is in the list', () => {
        const adapter = adapterOf(createFakeManager({ listed: [NAME] }));

        expect(adapter.has(NAME)).toBe(true);
        expect(adapter.has('Another preset')).toBe(false);
    });

    test('restores the one preset of the row: it reads its bundled copy, saves it, and adds it to the list', async () => {
        const manager = createFakeManager();

        await adapterOf(manager).restore(NAME);

        expect(manager.getDefaultPreset).toHaveBeenCalledTimes(1);
        expect(manager.getDefaultPreset).toHaveBeenCalledWith(NAME);
        expect(manager.savePreset).toHaveBeenCalledTimes(1);
        expect(manager.savePreset).toHaveBeenCalledWith(NAME, { temperature: 1 }, { skipUpdate: true });
        expect(manager.refreshRestoredDefaultOptions).toHaveBeenCalledTimes(1);
    });

    test('never runs the bulk restore, which copies every bundled preset over the file of the user', async () => {
        const manager = createFakeManager();

        await adapterOf(manager).restore(NAME);

        expect(manager.restoreDefaultPresets).not.toHaveBeenCalled();
    });

    test('saves without selecting the preset, so the preset in use stays', async () => {
        const manager = createFakeManager();

        await adapterOf(manager).restore(NAME);

        expect(manager.savePreset.mock.calls[0][2]).toEqual({ skipUpdate: true });
    });

    test('hands the list refresh a file name, because the refresh cuts the extension off and "(v5.2)" has a dot', async () => {
        const manager = createFakeManager();

        await adapterOf(manager).restore(NAME);

        const [filenames] = manager.refreshRestoredDefaultOptions.mock.calls[0];
        expect(filenames).toHaveLength(1);
        expect(filenames[0].replace(/\.[^.]+$/, '')).toBe(NAME);
    });

    test('does not touch a preset that is in the list already, edited or not', async () => {
        const manager = createFakeManager({ listed: [NAME] });

        await expect(adapterOf(manager).restore(NAME)).rejects.toThrow('in the list already');

        expect(manager.getDefaultPreset).not.toHaveBeenCalled();
        expect(manager.savePreset).not.toHaveBeenCalled();
    });

    test.each([
        ['the server has no bundled copy of that name', { isDefault: false, preset: {} }],
        ['the bundled copy is empty', { isDefault: true, preset: {} }],
        ['the request failed', null],
    ])('saves nothing when %s', async (_why, bundled) => {
        const manager = createFakeManager({ bundled });

        await expect(adapterOf(manager).restore(NAME)).rejects.toThrow('no bundled copy');

        expect(manager.savePreset).not.toHaveBeenCalled();
        expect(manager.refreshRestoredDefaultOptions).not.toHaveBeenCalled();
    });

    test('fails when the app has no preset manager for the list', async () => {
        const adapter = createPresetsAdapter({ getManager: () => null, apiId: 'openai' });

        expect(adapter.has(NAME)).toBe(false);
        await expect(adapter.restore(NAME)).rejects.toThrow('no preset manager');
    });
});

describe('the bundled presets of Bundled Extras, against what ships in default/content', () => {
    const tempRoots = [];
    afterEach(() => {
        for (const root of tempRoots.splice(0)) {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    function makeDirectories() {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-extras-presets-'));
        tempRoots.push(root);
        const directories = { root, openAI_Settings: path.join(root, 'presets', 'openai') };
        fs.mkdirSync(directories.openAI_Settings, { recursive: true });
        return directories;
    }

    const presetItems = BUNDLED_EXTRAS.filter(item => item.kind === 'preset');

    test('there are preset items to check', () => {
        expect(presetItems.length).toBeGreaterThan(0);
    });

    test.each(presetItems.map(item => [item.name, item]))('%s has a bundled copy under its preset name, which the single restore returns', (_name, item) => {
        const directories = makeDirectories();

        const found = contentManager.findDefaultPreset(directories, { folder: directories.openAI_Settings, name: item.presetName });

        expect(found).toBeTruthy();
        expect(Object.keys(contentManager.getDefaultPresetFile(found.filename) ?? {})).not.toHaveLength(0);
    });

    test('a single restore writes nothing: the file of another edited preset stays as the user left it', () => {
        const directories = makeDirectories();
        const edited = path.join(directories.openAI_Settings, 'Geechan - Universal Roleplay (Chat Completions) (v5.2).json');
        fs.writeFileSync(edited, '{"temperature":0.1}');
        const found = contentManager.findDefaultPreset(directories, { folder: directories.openAI_Settings, name: 'TLD Card Conversion Preset (Standalone)' });

        contentManager.getDefaultPresetFile(found.filename);
        contentManager.clearDefaultPresetDeletion(directories, found);

        expect(fs.readFileSync(edited, 'utf8')).toBe('{"temperature":0.1}');
        expect(fs.readdirSync(directories.openAI_Settings)).toEqual([path.basename(edited)]);
    });
});
