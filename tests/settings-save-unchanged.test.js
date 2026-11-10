import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from '@jest/globals';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { setConfigFilePath } from '../src/util.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const originalWorkingDirectory = process.cwd();
process.chdir(repoRoot);
setConfigFilePath(path.join(repoRoot, 'default', 'config.yaml'));

const { router: settingsRouter } = await import('../src/endpoints/settings.js');
const { SETTINGS_FILE } = await import('../src/constants.js');

// The cases here never write the settings, so they never start the settings autosave and its backup timer.
const HANDLE = 'settings-save-unchanged-test-user';

describe('settings save without a change', () => {
    let baseUrl;
    let server;
    let root;

    const settingsPath = () => path.join(root, SETTINGS_FILE);
    const store = settings => fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 4));
    const save = async body => {
        const response = await fetch(`${baseUrl}/api/settings/save`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        return { status: response.status, body: await response.json() };
    };

    beforeAll(async () => {
        const app = express();
        app.use(express.json({ limit: '10mb' }));
        app.use((request, _response, next) => {
            request.user = { profile: { handle: HANDLE }, directories: { root } };
            next();
        });
        app.use('/api/settings', settingsRouter);
        await new Promise(resolve => {
            server = app.listen(0, '127.0.0.1', resolve);
        });
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-settings-save-'));
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    afterAll(async () => {
        await new Promise(resolve => server.close(resolve));
        process.chdir(originalWorkingDirectory);
    });

    test('keeps the version and the file when the settings do not change', async () => {
        store({ _version: 3, username: 'User', power_user: { list: [1, 2] } });
        const before = fs.readFileSync(settingsPath(), 'utf8');

        const result = await save({ power_user: { list: [1, 2] }, username: 'User', _version: 3 });

        expect(result).toEqual({ status: 200, body: { result: 'ok', version: 3, unchanged: true } });
        expect(fs.readFileSync(settingsPath(), 'utf8')).toBe(before);
    });

    test('gives the stored version to a stale page that sends the stored settings', async () => {
        store({ _version: 3, username: 'User' });

        expect(await save({ _version: 1, username: 'User' })).toEqual({ status: 200, body: { result: 'ok', version: 3, unchanged: true } });
    });

    test('still refuses a stale page that changes the settings', async () => {
        store({ _version: 3, username: 'User' });

        expect(await save({ _version: 2, username: 'Other User' })).toEqual({ status: 409, body: { error: 'settings_conflict', version: 3 } });
        expect(JSON.parse(fs.readFileSync(settingsPath(), 'utf8'))).toEqual({ _version: 3, username: 'User' });
    });

});
