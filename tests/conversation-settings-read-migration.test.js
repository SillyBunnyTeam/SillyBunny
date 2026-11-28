/**
 * `POST /api/settings/get` moves the conversations out of settings.json before it reads the file, so that the page gets
 * the migrated settings and its first settings save carries the version that the migration raised.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';

// First-read migration rewrites conversation trees, backups, and the SQLite index, which can exceed Jest's 5 s default under parallel Windows runs.
jest.setTimeout(30_000);
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';

import { assertSandboxedInstall, createInstallSandbox } from './util/install-sandbox.js';
import { populateUser, ROLEPLAY_GROUP_FILE } from './util/conversation-migration-harness.js';
import { buildLegacySettingsFixture } from './util/conversation-legacy-fixture.js';

const sandbox = createInstallSandbox('sillybunny-conversation-settings-read');
await assertSandboxedInstall(sandbox);
const originalDataRoot = global.DATA_ROOT;

const { setConfigFilePath } = await import('../src/util.js');
setConfigFilePath(sandbox.configPath);
global.DATA_ROOT = sandbox.dataRoot;

const { getUserDirectories } = await import('../src/users.js');
const { conversationIndex } = await import('../src/conversation-index.js');
const { router: settingsRouter } = await import('../src/endpoints/settings.js');
const { router: conversationRouter } = await import('../src/endpoints/sillybunny-conversation.js');
const { BACKUP_FOLDER_NAME } = await import('../src/conversation-migration.js');

const LEGACY_PARTS = ['characters', 'groups', 'reminders', 'legacyThreadPersonaAssignments'];

let server;
let baseUrl;
let user;
let settingsPath;
let handleCounter = 0;

beforeAll(async () => {
    const app = express();
    app.use(express.json({ limit: '50mb' }));
    app.use((request, _response, next) => {
        request.user = user;
        next();
    });
    app.use('/api/settings', settingsRouter);
    app.use('/api/sillybunny-conversation', conversationRouter);
    await new Promise((resolve) => {
        server = app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
    conversationIndex.close();
    global.DATA_ROOT = originalDataRoot;
    sandbox.dispose();
});

beforeEach(() => {
    jest.spyOn(console, 'info').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    jest.restoreAllMocks();
    conversationIndex.close();
});

function useUser(settings, options = {}) {
    const handle = `settings-read-user-${++handleCounter}`;
    const populated = populateUser(handle, getUserDirectories(handle), { settings, ...options });
    user = populated.user;
    settingsPath = populated.settingsPath;
}

function useLegacyUser() {
    useUser(buildLegacySettingsFixture().settings, { groups: { [ROLEPLAY_GROUP_FILE.id]: ROLEPLAY_GROUP_FILE } });
}

async function readSettings() {
    const response = await fetch(`${baseUrl}/api/settings/get`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const body = await response.json();
    return { status: response.status, settings: JSON.parse(body.settings) };
}

async function saveSettings(settings) {
    const response = await fetch(`${baseUrl}/api/settings/save`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) });
    return response.status;
}

const modeObject = settings => settings.extension_settings.sillybunny_conversation;

describe('POST /api/settings/get', () => {
    test('answers the settings after the migration: the old parts are gone and the version is raised', async () => {
        useLegacyUser();
        const storedVersion = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))._version ?? 0;

        const { status, settings } = await readSettings();

        expect(status).toBe(200);
        expect(modeObject(settings).version).toBe(2);
        for (const part of LEGACY_PARTS) {
            expect(Object.keys(modeObject(settings)[part] ?? {})).toHaveLength(0);
        }
        expect(settings._version).toBeGreaterThan(storedVersion);
    });

    test('lets the first settings save of the page through after the page asked for its conversations, because the migration ran before the read', async () => {
        useLegacyUser();
        // A successful save starts the settings autosave, whose throttle leaves a ten minute timer that keeps Jest from exiting.
        jest.useFakeTimers({ doNotFake: ['Date', 'hrtime', 'nextTick', 'performance', 'queueMicrotask', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval'] });

        try {
            const { settings } = await readSettings();
            // The first conversation request would have run the migration, and raised the version past the one that the page holds.
            const list = await fetch(`${baseUrl}/api/sillybunny-conversation/list`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            expect(list.status).toBe(200);
            const status = await saveSettings({ ...settings, username: 'Changed' });

            expect(status).toBe(200);
            expect(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).username).toBe('Changed');
        } finally {
            jest.clearAllTimers();
            jest.useRealTimers();
        }
    });

    test('checks on every read: an old object that came back is trimmed before the next answer', async () => {
        useLegacyUser();
        const legacy = fs.readFileSync(settingsPath, 'utf8');
        await readSettings();
        fs.writeFileSync(settingsPath, legacy);

        const { settings } = await readSettings();

        expect(modeObject(settings).version).toBe(2);
        for (const part of LEGACY_PARTS) {
            expect(Object.keys(modeObject(settings)[part] ?? {})).toHaveLength(0);
        }
    });

    test('answers the settings of a user with no conversations as they are stored', async () => {
        useUser({ _version: 5, username: 'nobody' });

        const { status, settings } = await readSettings();

        expect(status).toBe(200);
        expect(settings).toEqual({ _version: 5, username: 'nobody' });
    });

    test('still answers the stored settings when the migration fails, and leaves the file alone', async () => {
        useLegacyUser();
        fs.writeFileSync(path.join(user.directories.backups, BACKUP_FOLDER_NAME), 'a file where the folder should be');
        const before = fs.readFileSync(settingsPath, 'utf8');

        const { status, settings } = await readSettings();

        expect(status).toBe(200);
        expect(settings).toEqual(JSON.parse(before));
        expect(fs.readFileSync(settingsPath, 'utf8')).toBe(before);
    });
});
