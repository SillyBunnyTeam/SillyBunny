import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from '@jest/globals';
import express from 'express';

import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));

const contentManager = await import('../src/endpoints/content-manager.js');
const { router: presetsRouter } = await import('../src/endpoints/presets.js');

const PRESET_NAME = 'Default';

describe('saving over a deleted bundled default preset', () => {
    let baseUrl;
    let directories;
    let server;
    let tempRoot;

    beforeAll(async () => {
        const app = express();
        app.use(express.json());
        app.use((request, _response, next) => {
            request.user = {
                profile: { handle: 'preset-save-test-user' },
                directories,
            };
            next();
        });
        app.use('/api/presets', presetsRouter);

        await new Promise((resolve) => {
            server = app.listen(0, '127.0.0.1', resolve);
        });
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    beforeEach(() => {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-preset-save-'));
        directories = {
            root: tempRoot,
            openAI_Settings: path.join(tempRoot, 'presets', 'openai'),
        };
        fs.mkdirSync(directories.openAI_Settings, { recursive: true });
    });

    afterEach(() => {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    afterAll(async () => {
        await new Promise((resolve) => server.close(resolve));
    });

    function savePreset(preset) {
        return fetch(`${baseUrl}/api/presets/save`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: PRESET_NAME, apiId: 'openai', preset }),
        });
    }

    function getDefaultPreset() {
        return contentManager.findDefaultPreset(directories, {
            folder: directories.openAI_Settings,
            name: PRESET_NAME,
        });
    }

    test('writes the preset and clears the tombstone', async () => {
        const defaultPreset = getDefaultPreset();
        expect(defaultPreset).toBeTruthy();
        contentManager.recordDefaultPresetDeletion(directories, defaultPreset);

        const response = await savePreset({ imported: true });

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ name: PRESET_NAME });

        const targetPath = path.join(directories.openAI_Settings, `${PRESET_NAME}.json`);
        expect(JSON.parse(fs.readFileSync(targetPath, 'utf8'))).toEqual({ imported: true });
        expect(contentManager.isDefaultPresetDeleted(directories, defaultPreset)).toBe(false);
    });

    test('allows a rename onto a deleted default name without a restore flag', async () => {
        const defaultPreset = getDefaultPreset();
        contentManager.recordDefaultPresetDeletion(directories, defaultPreset);

        const first = await savePreset({ renamed: 1 });
        const second = await savePreset({ renamed: 2 });

        expect(first.status).toBe(200);
        expect(second.status).toBe(200);

        const targetPath = path.join(directories.openAI_Settings, `${PRESET_NAME}.json`);
        expect(JSON.parse(fs.readFileSync(targetPath, 'utf8'))).toEqual({ renamed: 2 });
    });

    test('deleting the preset again records the tombstone', async () => {
        const defaultPreset = getDefaultPreset();
        await savePreset({ imported: true });

        const response = await fetch(`${baseUrl}/api/presets/delete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: PRESET_NAME, apiId: 'openai' }),
        });

        expect(response.status).toBe(200);
        expect(contentManager.isDefaultPresetDeleted(directories, defaultPreset)).toBe(true);
        expect(fs.existsSync(path.join(directories.openAI_Settings, `${PRESET_NAME}.json`))).toBe(false);
    });
});
