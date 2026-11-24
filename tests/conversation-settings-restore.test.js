/**
 * What a settings snapshot restore does to conversations. A restore replaces `settings.json` with an older copy. A
 * copy from before the migration holds the old conversation object again, and the migration decides from that object
 * (and from a flag inside it for the import of the old browser storage) whether there is anything left to move.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';

import { assertSandboxedInstall, createInstallSandbox, snapshotTree } from './util/install-sandbox.js';
import { populateUser, ROLEPLAY_GROUP_FILE } from './util/conversation-migration-harness.js';
import { branch, buildLegacySettingsFixture, lines, PERSONA, thread } from './util/conversation-legacy-fixture.js';

const sandbox = createInstallSandbox('sillybunny-conversation-settings-restore');
await assertSandboxedInstall(sandbox);
const originalDataRoot = global.DATA_ROOT;
const originalWorkingDirectory = process.cwd();

const { setConfigFilePath } = await import('../src/util.js');
setConfigFilePath(sandbox.configPath);
global.DATA_ROOT = sandbox.dataRoot;

const { getUserDirectories } = await import('../src/users.js');
const { conversationIndex } = await import('../src/conversation-index.js');
const { BACKUP_FOLDER_NAME, ensureMigrated, importLegacyThreads, runMigration } = await import('../src/conversation-migration.js');
const { listConversations, readCharacterState, readConversation, updateCharacterState } = await import('../src/conversation-store.js');

let server;
let baseUrl;
let user;
let settingsPath;
let handleCounter = 0;

beforeAll(async () => {
    process.chdir(path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'));
    const { router } = await import('../src/endpoints/settings.js');
    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use((request, _response, next) => {
        request.user = user;
        next();
    });
    app.use('/api/settings', router);
    await new Promise((resolve) => {
        server = app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
    conversationIndex.close();
    global.DATA_ROOT = originalDataRoot;
    process.chdir(originalWorkingDirectory);
    sandbox.dispose();
});

beforeEach(() => {
    jest.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
    jest.restoreAllMocks();
    conversationIndex.close();
});

function useUser(options) {
    const handle = `settings-restore-user-${++handleCounter}`;
    const populated = populateUser(handle, getUserDirectories(handle), options);
    user = populated.user;
    settingsPath = populated.settingsPath;
}

function useFixtureUser() {
    const { settings } = buildLegacySettingsFixture();
    useUser({ settings, groups: { [ROLEPLAY_GROUP_FILE.id]: ROLEPLAY_GROUP_FILE } });
}

async function post(route, body = {}) {
    const response = await fetch(`${baseUrl}/api/settings${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return { status: response.status, text: await response.text() };
}

/** Takes a snapshot of settings.json as it is now, through the route of the Settings panel. */
async function makeSnapshot() {
    expect((await post('/make-snapshot')).status).toBe(204);
    const { text } = await post('/get-snapshots');
    return JSON.parse(text).map(item => item.name).sort().at(-1);
}

async function restoreSnapshot(name) {
    expect((await post('/restore-snapshot', { name })).status).toBe(204);
}

const readSettings = () => JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
const conversationFolders = () => fs.readdirSync(user.directories.conversations).filter(name => name.startsWith('conv_'));

describe('a snapshot of settings.json from before the migration', () => {
    async function migrateThenRestoreTheOldSnapshot() {
        useFixtureUser();
        const snapshot = await makeSnapshot();
        const before = readSettings();
        const state = ensureMigrated(user);
        const migrated = conversationFolders();
        await restoreSnapshot(snapshot);
        return { before, state, migrated };
    }

    test('brings the old conversation object back into settings.json, with its old version, until the next settings read', async () => {
        const { before, state } = await migrateThenRestoreTheOldSnapshot();

        expect(state.state).toBe('migrated');
        expect(readSettings()).toEqual(before);
        expect(Object.keys(readSettings().extension_settings.sillybunny_conversation.characters).length).toBeGreaterThan(0);
        expect(readSettings().extension_settings.sillybunny_conversation.version).toBe(1);
    });

    test('is trimmed at the next settings read of the server that migrated, without a restart, and no conversation is written', async () => {
        const { before, migrated } = await migrateThenRestoreTheOldSnapshot();
        const tree = snapshotTree(user.directories.conversations);

        // `POST /api/settings/get` calls this before it reads settings.json.
        expect(ensureMigrated(user)).toMatchObject({ state: 'migrated' });

        const kept = readSettings().extension_settings.sillybunny_conversation;
        for (const part of ['characters', 'groups', 'reminders', 'legacyThreadPersonaAssignments']) {
            expect(kept).not.toHaveProperty(part);
        }
        expect(kept.version).toBe(2);
        expect(readSettings()._version).toBe(before._version + 1);
        expect(readSettings().extension_settings.unrelated).toEqual(before.extension_settings.unrelated);
        expect(conversationFolders()).toEqual(migrated);
        expect(snapshotTree(user.directories.conversations)).toEqual(tree);
    });

    test('keeps the old object in a backup file, beside the one that the migration wrote', async () => {
        const { before } = await migrateThenRestoreTheOldSnapshot();

        ensureMigrated(user);

        const backups = fs.readdirSync(path.join(user.directories.backups, BACKUP_FOLDER_NAME));
        expect(backups.length).toBeGreaterThan(0);
        const file = path.join(user.directories.backups, BACKUP_FOLDER_NAME, backups[0], 'sillybunny_conversation.json');
        expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(before.extension_settings.sillybunny_conversation);
    });

    test('is not migrated again by the first request after a restart, so that no conversation is written twice', async () => {
        const { migrated } = await migrateThenRestoreTheOldSnapshot();

        // `runMigration()` is what `ensureMigrated()` runs for a user whom the server has not seen yet, as after a restart.
        runMigration(user);

        expect(conversationFolders()).toEqual(migrated);
        expect(listConversations(user).conversations).toHaveLength(migrated.length);
    });

    test('does not reset the status that a character got after the migration, when the server restarts', async () => {
        useFixtureUser();
        const snapshot = await makeSnapshot();
        ensureMigrated(user);
        updateCharacterState(user, 'Cass.png', { statusOverride: 'dnd' });
        await restoreSnapshot(snapshot);

        runMigration(user);

        expect(readCharacterState(user).characters['Cass.png']).toEqual({ statusOverride: 'dnd' });
    });
});

describe('a snapshot of settings.json from before the import of the old browser storage', () => {
    test('does not import the same threads again, so that the conversation does not get the chat twice', async () => {
        useUser({
            settings: { user_avatar: PERSONA, power_user: { personas: { [PERSONA]: 'x' } }, extension_settings: { sillybunny_conversation: { version: 2, localStorageMigrated: false, settings: {} } }, _version: 5 },
            userAvatars: [PERSONA],
        });
        const characters = { 'Nova.png': thread('solo', [branch('main', 'Main', lines(2))], { settings: { enabled: true } }) };
        const snapshot = await makeSnapshot();
        importLegacyThreads(user, { personaId: PERSONA, characters });
        const [conversation] = listConversations(user).conversations;
        await restoreSnapshot(snapshot);

        const outcome = importLegacyThreads(user, { personaId: PERSONA, characters });

        expect(outcome).toEqual({ state: 'already_imported' });
        expect(readConversation(user, conversation.id).chats).toHaveLength(1);
    });
});
