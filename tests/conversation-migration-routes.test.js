/**
 * The routes of conversation mode that touch the migration: the status route, the routes that need the new layout,
 * and the import of the very old browser storage.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';

// First-request migration rewrites conversation trees and rebuilds the SQLite index, which can exceed Jest's 5 s default under parallel Windows runs.
jest.setTimeout(30_000);
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';

import { assertSandboxedInstall, createInstallSandbox, snapshotTree } from './util/install-sandbox.js';
import { populateUser, ROLEPLAY_GROUP_FILE } from './util/conversation-migration-harness.js';
import { BASE, branch, buildLegacySettingsFixture, lines, PERSONA, thread } from './util/conversation-legacy-fixture.js';

const sandbox = createInstallSandbox('sillybunny-conversation-migration-routes');
await assertSandboxedInstall(sandbox);
const originalDataRoot = global.DATA_ROOT;

const { setConfigFilePath } = await import('../src/util.js');
setConfigFilePath(sandbox.configPath);
global.DATA_ROOT = sandbox.dataRoot;

const { getUserDirectories } = await import('../src/users.js');
const { conversationIndex } = await import('../src/conversation-index.js');
const { router } = await import('../src/endpoints/sillybunny-conversation.js');
const { BACKUP_FOLDER_NAME, RETRY_AFTER_MS } = await import('../src/conversation-migration.js');

const PREFIX = '/api/sillybunny-conversation';

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
    app.use(PREFIX, router);
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
    jest.useRealTimers();
    conversationIndex.close();
});

function useUser({ settings, ...options } = {}) {
    const handle = `migration-routes-user-${++handleCounter}`;
    const populated = populateUser(handle, getUserDirectories(handle), { settings, ...options });
    user = populated.user;
    settingsPath = populated.settingsPath;
}

function useFixtureUser() {
    const { settings } = buildLegacySettingsFixture();
    useUser({ settings, groups: { [ROLEPLAY_GROUP_FILE.id]: ROLEPLAY_GROUP_FILE } });
}

async function post(route, body = {}) {
    const response = await fetch(`${baseUrl}${PREFIX}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return { status: response.status, json: await response.json() };
}

const blockBackups = () => fs.writeFileSync(path.join(user.directories.backups, BACKUP_FOLDER_NAME), 'a file where the folder should be');

describe('POST /migration/status', () => {
    test('moves the conversations of the user the first time it is asked, and answers the counts', async () => {
        useFixtureUser();

        const { status, json } = await post('/migration/status');

        expect(status).toBe(200);
        expect(json.state).toBe('migrated');
        expect(json.report.migrated).toMatchObject({ conversations: 15 });
        expect(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).extension_settings.sillybunny_conversation.version).toBe(2);
        expect((await post('/list')).json.conversations).toHaveLength(15);
    });

    test('answers the same on the second request, and does not move anything again', async () => {
        useFixtureUser();
        const first = await post('/migration/status');
        const tree = snapshotTree(user.directories.root);

        const second = await post('/migration/status');

        expect(second).toEqual(first);
        expect(snapshotTree(user.directories.root)).toEqual(tree);
    });

    test('says that there was nothing to move for a user without conversations', async () => {
        useUser({ settings: { username: 'nobody' } });

        expect(await post('/migration/status')).toEqual({ status: 200, json: { state: 'nothing_to_migrate' } });
    });

    test('says why it failed, in words that name no path, while settings.json stays as it was', async () => {
        useFixtureUser();
        blockBackups();
        const before = fs.readFileSync(settingsPath, 'utf8');

        const { status, json } = await post('/migration/status');

        expect(status).toBe(200);
        expect(json).toMatchObject({ state: 'failed', error: { code: 'unexpected' }, retryAfterMs: expect.any(Number) });
        expect(json.retryAfterMs).toBeLessThanOrEqual(RETRY_AFTER_MS);
        expect(JSON.stringify(json)).not.toContain(user.directories.root);
        expect(fs.readFileSync(settingsPath, 'utf8')).toBe(before);
    });

    test('does not need a request body field, and refuses a body that is not an object', async () => {
        useFixtureUser();
        const response = await fetch(`${baseUrl}${PREFIX}/migration/status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '[1]' });

        expect(response.status).toBe(400);
    });
});

describe('the routes that need the new layout', () => {
    test('the first request to any of them moves the conversations first, so that the list is not empty', async () => {
        useFixtureUser();

        const { json } = await post('/list');

        expect(json.conversations).toHaveLength(15);
        expect(json.problems).toEqual([]);
    });

    test('a request for a conversation that exists only after the move finds it', async () => {
        useFixtureUser();
        const { json: { conversations } } = await post('/list');

        const { status, json } = await post('/get', { id: conversations[0].id });

        expect(status).toBe(200);
        expect(json.conversation.id).toBe(conversations[0].id);
    });

    test('answer 503 while the migration has failed, and write nothing', async () => {
        useFixtureUser();
        blockBackups();
        const before = snapshotTree(user.directories.root);

        const list = await post('/list');
        const create = await post('/create', { kind: 'direct', personaId: PERSONA, characters: ['Nova.png'] });
        const avatar = await fetch(`${baseUrl}${PREFIX}/avatar?id=conv_1_abcdef`);

        expect(list).toEqual({ status: 503, json: { error: 'migration_failed' } });
        expect(create.status).toBe(503);
        expect(avatar.status).toBe(503);
        expect(snapshotTree(user.directories.root)).toEqual(before);
    });

    test('work again after the cause is gone and the retry time has passed', async () => {
        jest.useFakeTimers({ now: BASE, doNotFake: ['setImmediate', 'nextTick', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask'] });
        useFixtureUser();
        blockBackups();
        expect((await post('/list')).status).toBe(503);

        fs.rmSync(path.join(user.directories.backups, BACKUP_FOLDER_NAME));
        expect((await post('/list')).status).toBe(503);
        jest.setSystemTime(BASE + RETRY_AFTER_MS + 1);

        const { status, json } = await post('/list');
        expect(status).toBe(200);
        expect(json.conversations).toHaveLength(15);
    });

    test('a user with nothing to move can use them at once', async () => {
        useUser({ settings: { username: 'nobody' } });

        const created = await post('/create', { kind: 'direct', personaId: PERSONA, characters: ['Nova.png'] });

        expect(created.status).toBe(200);
        expect((await post('/list')).json.conversations).toHaveLength(1);
    });
});

describe('POST /import-legacy', () => {
    const settings = () => ({
        user_avatar: PERSONA,
        power_user: { personas: { [PERSONA]: 'x' } },
        extension_settings: { sillybunny_conversation: { version: 2, localStorageMigrated: false, settings: {} } },
        _version: 2,
    });
    const characters = () => ({ 'Nova.png': thread('solo', [branch('main', 'Main', lines(4))], { settings: { enabled: true } }) });

    test('writes what the browser sends as conversations, and answers the counts', async () => {
        useUser({ settings: settings() });

        const { status, json } = await post('/import-legacy', { personaId: PERSONA, characters: characters() });

        expect({ status, json }).toEqual({ status: 200, json: { state: 'imported', conversations: 1, chats: 1, messages: 4 } });
        expect((await post('/list')).json.conversations[0]).toMatchObject({ characters: ['Nova.png'], messageCount: 4 });
    });

    test('answers that it was imported already the second time, and writes nothing', async () => {
        useUser({ settings: settings() });
        await post('/import-legacy', { personaId: PERSONA, characters: characters() });
        const tree = snapshotTree(user.directories.root);

        const second = await post('/import-legacy', { personaId: PERSONA, characters: characters() });

        expect(second).toEqual({ status: 200, json: { state: 'already_imported' } });
        expect(snapshotTree(user.directories.root)).toEqual(tree);
    });

    test.each([
        ['a persona that is a path', { personaId: '../outside', characters: {} }],
        ['characters that are a list', { personaId: PERSONA, characters: [] }],
        ['a field that the route does not take', { personaId: PERSONA, characters: {}, store: {} }],
    ])('refuses %s with 400', async (_name, body) => {
        useUser({ settings: settings() });
        const before = snapshotTree(user.directories.root);

        const { status, json } = await post('/import-legacy', body);

        expect(status).toBe(400);
        expect(json.error).toBe('invalid_input');
        expect(snapshotTree(user.directories.root)).toEqual(before);
    });

    test('refuses a thread key that tries to leave the persona folder, by never making a path of it', async () => {
        useUser({ settings: settings() });

        const { status, json } = await post('/import-legacy', { personaId: PERSONA, characters: { '../../x.png': thread('solo', [branch('main', 'Main', lines(2))], { settings: { enabled: true } }) } });

        expect(status).toBe(200);
        expect(json).toMatchObject({ state: 'imported', conversations: 0 });
        // The import is marked done even when it wrote nothing, so the marker is the only file.
        expect(fs.readdirSync(user.directories.conversations)).toEqual(['migration-done.json']);
    });

    test('answers 409 settings_changed when settings.json changes during the import', async () => {
        useUser({ settings: settings() });
        const originalReadFileSync = fs.readFileSync;
        let reads = 0;
        jest.spyOn(fs, 'readFileSync').mockImplementation((file, ...rest) => {
            const data = originalReadFileSync(file, ...rest);
            // ensureMigrated() reads settings.json first, then importLegacyThreads() reads it before and after writing.
            return String(file) === settingsPath && ++reads === 3 ? `${data} ` : data;
        });

        const { status, json } = await post('/import-legacy', { personaId: PERSONA, characters: characters() });

        expect(status).toBe(409);
        expect(json).toMatchObject({ error: 'settings_changed', message: expect.any(String) });
    });
});
