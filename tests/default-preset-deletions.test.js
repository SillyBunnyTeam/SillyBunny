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
