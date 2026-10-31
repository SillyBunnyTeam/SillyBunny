/* eslint-disable playwright/no-duplicate-hooks */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, jest, test } from '@jest/globals';

jest.unstable_mockModule('../src/util.js', () => ({
    color: {
        blue: value => value,
        yellow: value => value,
    },
    getConfigValue: jest.fn((_key, defaultValue) => defaultValue),
    isValidUrl: jest.fn(() => false),
    recoverFileWriteSync: jest.fn(),
    setPermissionsSync: jest.fn(),
}));

/** @type {import('../src/endpoints/content-manager.js')} */
let contentManager;

const tempRoots = [];

function makeTempUserDirectories() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-default-presets-'));
    tempRoots.push(root);

    const directories = {
        root,
        openAI_Settings: path.join(root, 'presets', 'openai'),
        sysprompt: path.join(root, 'presets', 'sysprompt'),
    };

    fs.mkdirSync(directories.openAI_Settings, { recursive: true });
    fs.mkdirSync(directories.sysprompt, { recursive: true });

    return directories;
}

beforeAll(async () => {
    contentManager = await import('../src/endpoints/content-manager.js');
});

afterEach(() => {
    for (const root of tempRoots.splice(0)) {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

afterAll(() => {
    jest.restoreAllMocks();
});

describe('bundled default preset deletion tombstones', () => {
    test('records and filters deleted bundled presets', () => {
        const directories = makeTempUserDirectories();
        const defaultPreset = contentManager.findDefaultPreset(directories, {
            folder: directories.openAI_Settings,
            name: 'Default',
        });

        expect(defaultPreset).toBeTruthy();
        expect(contentManager.recordDefaultPresetDeletion(directories, defaultPreset)).toBe(true);
        expect(contentManager.isDefaultPresetDeleted(directories, defaultPreset)).toBe(true);

        const visibleDefaults = contentManager.getDefaultPresets(directories, { includeDeleted: false });
        expect(visibleDefaults).not.toContainEqual(expect.objectContaining({
            type: defaultPreset.type,
            filename: defaultPreset.filename,
        }));
    });

    test('single restore clears a matching tombstone', () => {
        const directories = makeTempUserDirectories();
        const defaultPreset = contentManager.findDefaultPreset(directories, {
            folder: directories.sysprompt,
            name: 'Neutral - Chat',
        });

        expect(defaultPreset).toBeTruthy();
        contentManager.recordDefaultPresetDeletion(directories, defaultPreset);

        expect(contentManager.clearDefaultPresetDeletion(directories, defaultPreset)).toBe(true);
        expect(contentManager.isDefaultPresetDeleted(directories, defaultPreset)).toBe(false);
    });

    test('bulk restore copies deleted defaults and clears only restored tombstones', () => {
        const directories = makeTempUserDirectories();
        const defaultPreset = contentManager.findDefaultPreset(directories, {
            folder: directories.openAI_Settings,
            name: 'Default',
        });

        expect(defaultPreset).toBeTruthy();
        contentManager.recordDefaultPresetDeletion(directories, defaultPreset);

        const targetPath = path.join(directories.openAI_Settings, path.basename(defaultPreset.filename));
        expect(fs.existsSync(targetPath)).toBe(false);

        const result = contentManager.restoreDefaultPresetFiles(directories, [defaultPreset.type]);

        expect(result.failed).toHaveLength(0);
        expect(result.restored).toContain(defaultPreset.filename);
        expect(fs.existsSync(targetPath)).toBe(true);
        expect(contentManager.isDefaultPresetDeleted(directories, defaultPreset)).toBe(false);
    });
});

describe('restoring the bundled default presets', () => {
    const bundledOf = (directories, name) => contentManager.findDefaultPreset(directories, { folder: directories.openAI_Settings, name });
    const targetOf = (directories, preset) => path.join(directories.openAI_Settings, path.basename(preset.filename));
    const allOpenAiDefaults = directories => contentManager.getDefaultPresets(directories)
        .filter(preset => preset.folder === directories.openAI_Settings);

    describe('what it did and keeps doing', () => {
        test('puts every bundled preset of the list into a folder that has none, and says which', () => {
            const directories = makeTempUserDirectories();
            const defaults = allOpenAiDefaults(directories);

            const result = contentManager.restoreDefaultPresetFiles(directories, [defaults[0].type]);

            expect(defaults.length).toBeGreaterThan(1);
            expect(result.failed).toEqual([]);
            expect(result.restored.sort()).toEqual(defaults.map(preset => preset.filename).sort());
            for (const preset of defaults) {
                expect(fs.existsSync(targetOf(directories, preset))).toBe(true);
            }
        });

        test('brings a deleted preset back with its bundled content and clears its tombstone', () => {
            const directories = makeTempUserDirectories();
            const deleted = bundledOf(directories, 'Default');
            contentManager.recordDefaultPresetDeletion(directories, deleted);

            const result = contentManager.restoreDefaultPresetFiles(directories, [deleted.type]);

            expect(result.restored).toContain(deleted.filename);
            expect(JSON.parse(fs.readFileSync(targetOf(directories, deleted), 'utf8'))).toEqual(contentManager.getDefaultPresetFile(deleted.filename));
            expect(contentManager.isDefaultPresetDeleted(directories, deleted)).toBe(false);
        });

        test('leaves a custom preset, which has no bundled copy, alone', () => {
            const directories = makeTempUserDirectories();
            const custom = path.join(directories.openAI_Settings, 'My Own Preset.json');
            fs.writeFileSync(custom, '{"custom":true}');

            contentManager.restoreDefaultPresetFiles(directories, ['openai']);

            expect(fs.readFileSync(custom, 'utf8')).toBe('{"custom":true}');
        });
    });

    describe('a preset that is there', () => {
        test('keeps the edits of a bundled preset that was never deleted', () => {
            const directories = makeTempUserDirectories();
            const edited = bundledOf(directories, 'Default');
            fs.writeFileSync(targetOf(directories, edited), '{"temperature":0.123,"edited":true}');

            const result = contentManager.restoreDefaultPresetFiles(directories, [edited.type]);

            expect(fs.readFileSync(targetOf(directories, edited), 'utf8')).toBe('{"temperature":0.123,"edited":true}');
            expect(result.failed).toEqual([]);
        });

        test('is not listed as restored, because nothing was written for it', () => {
            const directories = makeTempUserDirectories();
            const edited = bundledOf(directories, 'Default');
            fs.writeFileSync(targetOf(directories, edited), '{"edited":true}');

            const result = contentManager.restoreDefaultPresetFiles(directories, [edited.type]);

            expect(result.restored).not.toContain(edited.filename);
            expect(result.restored.length).toBe(allOpenAiDefaults(directories).length - 1);
        });

        test('restores the missing ones around it, and only those', () => {
            const directories = makeTempUserDirectories();
            const defaults = allOpenAiDefaults(directories);
            const [editedPreset, deletedPreset] = defaults;
            fs.writeFileSync(targetOf(directories, editedPreset), '{"edited":true}');
            contentManager.recordDefaultPresetDeletion(directories, deletedPreset);

            const result = contentManager.restoreDefaultPresetFiles(directories, [editedPreset.type]);

            expect(fs.readFileSync(targetOf(directories, editedPreset), 'utf8')).toBe('{"edited":true}');
            expect(fs.existsSync(targetOf(directories, deletedPreset))).toBe(true);
            expect(contentManager.isDefaultPresetDeleted(directories, deletedPreset)).toBe(false);
            expect(result.restored.sort()).toEqual(defaults.filter(preset => preset !== editedPreset).map(preset => preset.filename).sort());
        });

        test('keeps a file that is there even when a stale deletion record names it, and keeps the record', () => {
            const directories = makeTempUserDirectories();
            const preset = bundledOf(directories, 'Default');
            fs.writeFileSync(targetOf(directories, preset), '{"edited":true}');
            contentManager.recordDefaultPresetDeletion(directories, preset);

            const result = contentManager.restoreDefaultPresetFiles(directories, [preset.type]);

            expect(fs.readFileSync(targetOf(directories, preset), 'utf8')).toBe('{"edited":true}');
            expect(result.restored).not.toContain(preset.filename);
            expect(contentManager.isDefaultPresetDeleted(directories, preset)).toBe(true);
        });

        test('is never overwritten by a file that appears between the restore looking and copying', () => {
            const directories = makeTempUserDirectories();
            const preset = bundledOf(directories, 'Default');
            const target = targetOf(directories, preset);
            const realCopy = fs.copyFileSync;
            const copy = jest.spyOn(fs, 'copyFileSync').mockImplementation((from, to, mode) => {
                if (to === target) {
                    fs.writeFileSync(target, '{"appeared":"meanwhile"}');
                }
                return realCopy(from, to, mode);
            });

            try {
                const result = contentManager.restoreDefaultPresetFiles(directories, [preset.type]);

                expect(copy).toHaveBeenCalled();
                expect(fs.readFileSync(target, 'utf8')).toBe('{"appeared":"meanwhile"}');
                expect(result.restored).not.toContain(preset.filename);
                expect(result.failed).toEqual([]);
            } finally {
                copy.mockRestore();
            }
        });
    });
});

