/**
 * The migration of conversation mode storage against real folders: the layout it writes, the check it makes, what it
 * leaves behind when it fails, and what a second run does. Runs in an install sandbox, so nothing outside a temp
 * folder is written.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';

import { assertSandboxedInstall, createInstallSandbox, snapshotTree } from './util/install-sandbox.js';
import { GROUP_AVATAR_BYTES, populateUser, ROLEPLAY_GROUP_FILE } from './util/conversation-migration-harness.js';
import {
    BASE,
    branch,
    buildLegacySettingsFixture,
    keyFor,
    lines,
    PERSONA,
    PERSONA_TWO,
    thread,
} from './util/conversation-legacy-fixture.js';

const sandbox = createInstallSandbox('sillybunny-conversation-migration');
await assertSandboxedInstall(sandbox);
const originalDataRoot = global.DATA_ROOT;
const originalWorkingDirectory = process.cwd();

const { setConfigFilePath } = await import('../src/util.js');
setConfigFilePath(sandbox.configPath);
global.DATA_ROOT = sandbox.dataRoot;

const { getUserDirectories } = await import('../src/users.js');
const { conversationIndex } = await import('../src/conversation-index.js');
const { planMigration } = await import('../src/conversation-migration-plan.js');
const {
    BACKUP_FOLDER_NAME,
    ensureMigrated,
    importLegacyThreads,
    MARKER_FILE_NAME,
    MigrationError,
    RETRY_AFTER_MS,
    runMigration,
    verifyWrittenPlan,
    writePlan,
} = await import('../src/conversation-migration.js');
const { ConversationStoreError, createConversation, listConversations, readCharacterState, readConversation } = await import('../src/conversation-store.js');
const { prepareSettingsSave } = await import('../src/settings-version.js');

const MIGRATION_TIME = BASE + 20_000 * 60_000;
const MIGRATION_DAY = new Date(MIGRATION_TIME).toISOString().slice(0, 10);

let handleCounter = 0;
let user;
let settingsPath;
let fixture;

function createUser(options = {}) {
    const handle = `migration-user-${++handleCounter}`;
    const populated = populateUser(handle, getUserDirectories(handle), options);
    return { ...populated, directories: populated.user.directories };
}

function useFixtureUser(mutate = () => {}) {
    fixture = buildLegacySettingsFixture();
    fixture.settings.accountStorage = {
        pinnedChats: JSON.stringify({
            'conversation_char_Aria.png_branch_main': { avatar: 'Aria.png', file_name: 'Main', is_conversation: true, conversation_branch_id: 'main' },
            'char_Aria.png_roleplay chat': { avatar: 'Aria.png', file_name: 'roleplay chat' },
        }),
    };
    mutate(fixture);
    const created = createUser({
        settings: fixture.settings,
        groups: { [ROLEPLAY_GROUP_FILE.id]: ROLEPLAY_GROUP_FILE },
        userImages: { 'group-four.png': GROUP_AVATAR_BYTES },
    });
    user = created.user;
    settingsPath = created.settingsPath;
    return created;
}

const readSettings = () => JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
const conversationFolders = () => fs.readdirSync(user.directories.conversations).filter(name => name.startsWith('conv_'));

afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    conversationIndex.close();
});

afterAll(() => {
    global.DATA_ROOT = originalDataRoot;
    process.chdir(originalWorkingDirectory);
    sandbox.dispose();
});

describe('the migration of the shared fixture', () => {
    let result;
    let before;

    beforeAll(() => {
        useFixtureUser();
        before = readSettings();
        result = runMigration(user, { now: MIGRATION_TIME });
    });

    test('writes one folder per planned conversation, and the store lists them with the counts of the report', () => {
        const { report } = result;
        const listed = listConversations(user);

        expect(result.state).toBe('migrated');
        expect(listed.problems).toEqual([]);
        expect(listed.conversations).toHaveLength(report.migrated.conversations);
        expect(listed.conversations.reduce((sum, item) => sum + item.chats.length, 0)).toBe(report.migrated.chats);
        expect(listed.conversations.reduce((sum, item) => sum + item.messageCount, 0)).toBe(report.migrated.messages);
        expect(conversationFolders()).toHaveLength(report.migrated.conversations);
    });

    test('keeps the legacy key and the persona of every conversation, and unique direct conversations', () => {
        const listed = listConversations(user).conversations;
        const directKeys = listed.filter(item => item.kind === 'direct').map(item => `${item.personaId}\0${item.characters[0]}`);

        expect(new Set(directKeys).size).toBe(directKeys.length);
        expect(listed.every(item => item.legacyKey && [PERSONA, PERSONA_TWO].includes(item.personaId))).toBe(true);
    });

    test('legacy keys: an unscoped thread is a conversation of the persona that it belongs to, and a conflicting copy is a second chat', () => {
        const listed = listConversations(user).conversations;
        const byKey = key => listed.find(item => item.legacyKey === key);

        expect(byKey(keyFor(PERSONA, 'Nova.png')).messageCount).toBe(12);
        expect(byKey(keyFor(PERSONA_TWO, 'Sol.png')).messageCount).toBe(3);
        expect(byKey('Sol.png')).toBeUndefined();
        expect(byKey(keyFor(PERSONA, 'Lyra.png')).chats.map(chat => chat.name)).toEqual(['Main', 'Main (earlier copy)']);
    });

    test('alias threads: the threads of the members of a group are one conversation, and a line shared by two aliases is there once', () => {
        const group = listConversations(user).conversations.find(item => item.kind === 'group' && item.name === 'Fixture Group One');
        const file = path.join(user.directories.conversations, group.id, 'chats', `${group.activeChatId}.jsonl`);
        const messages = fs.readFileSync(file, 'utf8').split('\n').slice(1).map(line => JSON.parse(line));

        expect(group.characters).toEqual(['Nova.png', 'Orion.png', 'Lyra.png']);
        expect(group.chats).toHaveLength(1);
        expect(messages).toHaveLength(7);
        expect(messages.filter(message => message.mes === 'shared line in two aliases')).toHaveLength(1);
    });

    test('orphans: threads of a missing character or persona are not written, are counted, and are in the backup', () => {
        const folders = listConversations(user).conversations.map(item => item.legacyKey);
        const backup = JSON.parse(fs.readFileSync(path.join(user.directories.backups, result.report.backupFile), 'utf8'));

        expect(folders).not.toContain(keyFor(PERSONA, 'Ghost.png'));
        expect(folders).not.toContain(keyFor('persona-gone.png', 'Nova.png'));
        expect(result.report.skipped['character-missing']).toMatchObject({ threads: 1, messages: 4 });
        expect(result.report.skipped['persona-missing']).toMatchObject({ threads: 1, messages: 3 });
        expect(Object.hasOwn(backup.characters, keyFor(PERSONA, 'Ghost.png'))).toBe(true);
        expect(result.report.dropped.remindersUnplaced).toBe(2);
    });

    test('copies the uploaded avatar of a group into its folder, and counts one that was not copied', () => {
        const withAvatar = listConversations(user).conversations.filter(item => item.avatar);

        expect(withAvatar).toHaveLength(1);
        expect(fs.readFileSync(path.join(user.directories.conversations, withAvatar[0].id, withAvatar[0].avatar))).toEqual(GROUP_AVATAR_BYTES);
        expect(result.report.avatarsNotCopied).toBe(0);
    });

    test('writes the routine and the status override of a character to characters.json', () => {
        const { characters } = readCharacterState(user);

        expect(characters['Aria.png'].routine).toMatchObject({ enabled: true });
        expect(characters['Cass.png']).toEqual({ statusOverride: 'offline' });
    });

    test('removes the moved parts from settings.json, and keeps the rest of it', () => {
        const after = readSettings();
        const kept = after.extension_settings.sillybunny_conversation;

        for (const part of ['characters', 'groups', 'reminders', 'legacyThreadPersonaAssignments']) {
            expect(kept).not.toHaveProperty(part);
        }
        expect(kept).toMatchObject({ version: 2, localStorageMigrated: true, userStatus: 'online', userPersonaStatus: 'working from home' });
        expect(kept.settings).toMatchObject({ custom_instructions: 'Be brief.', simulate_reply_delay: true, quiet_hours_start: '21:30' });
        expect(kept.settings).not.toHaveProperty('idle_followup');
        expect(after.extension_settings.unrelated).toEqual(before.extension_settings.unrelated);
        expect({ ...after, extension_settings: null, _version: null, accountStorage: null }).toEqual({ ...before, extension_settings: null, _version: null, accountStorage: null });
    });

    test('re-keys the Home pins of conversations in settings.json, and leaves the other pins', () => {
        const pins = JSON.parse(readSettings().accountStorage.pinnedChats);
        const aria = listConversations(user).conversations.find(item => item.legacyKey === keyFor(PERSONA, 'Aria.png'));

        expect(Object.keys(pins).toSorted()).toEqual([`conversation_${aria.id}_main`, 'char_Aria.png_roleplay chat'].toSorted());
        expect(pins[`conversation_${aria.id}_main`]).toMatchObject({ conversation_id: aria.id, conversation_chat_id: 'main' });
    });

    test('writes the old object, untouched, to the backup folder, with the old pins beside it', () => {
        const backup = path.join(user.directories.backups, result.report.backupFile);

        expect(result.report.backupFile).toBe(path.join(BACKUP_FOLDER_NAME, MIGRATION_DAY, 'sillybunny_conversation.json'));
        expect(JSON.parse(fs.readFileSync(backup, 'utf8'))).toEqual(fixture.store);
        expect(JSON.parse(fs.readFileSync(path.join(path.dirname(backup), 'pinnedChats.json'), 'utf8'))).toEqual(JSON.parse(before.accountStorage.pinnedChats));
    });

    test('raises the settings version, so that a page with the old version is refused', () => {
        const after = readSettings();

        expect(after._version).toBe(before._version + 1);
        expect(result.report.settingsVersion).toBe(after._version);
        expect(prepareSettingsSave({ ...before }, after)).toEqual({ ok: false, currentVersion: after._version });
        expect(prepareSettingsSave({ ...after }, after).ok).toBe(true);
    });

    test('leaves no marker file behind', () => {
        expect(fs.existsSync(path.join(user.directories.conversations, MARKER_FILE_NAME))).toBe(false);
    });

    test('a second run changes nothing', () => {
        const tree = snapshotTree(user.directories.root);

        expect(runMigration(user)).toEqual({ state: 'migrated' });
        expect(snapshotTree(user.directories.root)).toEqual(tree);
    });
});

describe('a settings save from a page that still holds the old object', () => {
    let server;
    let baseUrl;
    let root;

    beforeAll(async () => {
        process.chdir(path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'));
        const { router } = await import('../src/endpoints/settings.js');
        const app = express();
        app.use(express.json({ limit: '10mb' }));
        app.use((request, _response, next) => {
            request.user = { profile: { handle: 'settings-race-user' }, directories: { root } };
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
    });

    test('answers 409 and writes nothing, so that the old conversations do not come back', async () => {
        useFixtureUser();
        root = user.directories.root;
        const stale = readSettings();
        runMigration(user);
        const migrated = fs.readFileSync(settingsPath, 'utf8');

        const response = await fetch(`${baseUrl}/api/settings/save`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(stale),
        });

        expect(response.status).toBe(409);
        expect((await response.json()).error).toBe('settings_conflict');
        expect(fs.readFileSync(settingsPath, 'utf8')).toBe(migrated);
    });
});

describe('when the migration fails', () => {
    beforeEach(() => {
        useFixtureUser();
    });

    function expectNothingChanged(before) {
        expect(fs.readFileSync(settingsPath, 'utf8')).toBe(before.settings);
        expect(conversationFolders()).toEqual([]);
        expect(fs.existsSync(path.join(user.directories.conversations, MARKER_FILE_NAME))).toBe(false);
    }

    test('a backup that cannot be written removes the folders it made, and leaves settings.json as it was', () => {
        const before = { settings: fs.readFileSync(settingsPath, 'utf8') };
        fs.writeFileSync(path.join(user.directories.backups, BACKUP_FOLDER_NAME), 'a file where the folder should be');
        const previousCharacters = JSON.stringify({ version: 1, characters: { 'Cass.png': { statusOverride: 'dnd' } } });
        fs.writeFileSync(path.join(user.directories.conversations, 'characters.json'), previousCharacters);

        expect(() => runMigration(user)).toThrow();

        expectNothingChanged(before);
        expect(fs.readFileSync(path.join(user.directories.conversations, 'characters.json'), 'utf8')).toBe(previousCharacters);
    });

    test('a settings.json that changed during the run is reported, nothing is kept, and the file is not written', () => {
        const before = { settings: fs.readFileSync(settingsPath, 'utf8') };
        const original = fs.readFileSync;
        let reads = 0;
        jest.spyOn(fs, 'readFileSync').mockImplementation((file, ...rest) => {
            const text = original(file, ...rest);
            return String(file) === settingsPath && ++reads === 2 ? `${text} ` : text;
        });

        let error;
        try {
            runMigration(user);
        } catch (caught) {
            error = caught;
        }

        expect(error).toBeInstanceOf(MigrationError);
        expect(error.code).toBe('settings_changed');
        jest.restoreAllMocks();
        expectNothingChanged(before);
        expect(listConversations(user).conversations).toEqual([]);
    });

    test('a settings.json that is not JSON is reported without writing anything', () => {
        fs.writeFileSync(settingsPath, '{ not json');

        expect(() => runMigration(user)).toThrow(expect.objectContaining({ code: 'settings_unreadable' }));
        expect(fs.readFileSync(settingsPath, 'utf8')).toBe('{ not json');
        expect(conversationFolders()).toEqual([]);
    });

    test('is remembered for a while and tried again after that, and the retry works once the cause is gone', () => {
        jest.useFakeTimers({ now: BASE });
        jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.spyOn(console, 'info').mockImplementation(() => {});
        const blocker = path.join(user.directories.backups, BACKUP_FOLDER_NAME);
        fs.writeFileSync(blocker, 'a file where the folder should be');

        const failed = ensureMigrated(user);
        expect(failed).toMatchObject({ state: 'failed', code: 'unexpected', retryAt: BASE + RETRY_AFTER_MS });
        expect(failed.message).not.toContain(user.directories.root);

        fs.rmSync(blocker);
        expect(ensureMigrated(user)).toBe(failed);
        jest.setSystemTime(BASE + RETRY_AFTER_MS);

        expect(ensureMigrated(user)).toMatchObject({ state: 'migrated' });
        expect(ensureMigrated(user)).toMatchObject({ state: 'migrated' });
    });

    test('leaves the folders of a run that was stopped in the middle to the next run, which removes them first', () => {
        const stray = createConversation(user, { kind: 'direct', personaId: PERSONA, characters: ['Nova.png'], id: 'conv_1700000000000_stale00001' }).conversation;
        fs.writeFileSync(path.join(user.directories.conversations, MARKER_FILE_NAME), JSON.stringify({ conversationIds: [stray.id, 'not-an-id'], charactersBefore: null }));

        const result = runMigration(user);

        expect(result.state).toBe('migrated');
        expect(conversationFolders()).not.toContain(stray.id);
        expect(conversationFolders()).toHaveLength(result.report.migrated.conversations);
        expect(fs.existsSync(path.join(user.directories.conversations, MARKER_FILE_NAME))).toBe(false);
    });

    test('a marker that is left after the last step is only removed, and the conversations stay', () => {
        const done = runMigration(user);
        fs.writeFileSync(path.join(user.directories.conversations, MARKER_FILE_NAME), JSON.stringify({ conversationIds: conversationFolders(), charactersBefore: null }));

        expect(runMigration(user)).toEqual({ state: 'migrated' });

        expect(conversationFolders()).toHaveLength(done.report.migrated.conversations);
        expect(fs.existsSync(path.join(user.directories.conversations, MARKER_FILE_NAME))).toBe(false);
    });
});

describe('when there is nothing to migrate', () => {
    test('a user without settings.json writes nothing', () => {
        const created = createUser();

        expect(runMigration(created.user)).toEqual({ state: 'nothing_to_migrate' });
        expect(fs.readdirSync(created.user.directories.conversations)).toEqual([]);
    });

    test.each([
        ['no conversation object', { username: 'x' }],
        ['an object of the mode with only its settings', { extension_settings: { sillybunny_conversation: { version: 1, settings: { custom_instructions: 'x' }, characters: {}, groups: [], reminders: [] } } }],
    ])('%s leaves settings.json as it is', (_name, settings) => {
        const created = createUser({ settings });
        const text = fs.readFileSync(created.settingsPath, 'utf8');

        expect(runMigration(created.user)).toEqual({ state: 'nothing_to_migrate' });
        expect(fs.readFileSync(created.settingsPath, 'utf8')).toBe(text);
        expect(fs.existsSync(path.join(created.user.directories.backups, BACKUP_FOLDER_NAME))).toBe(false);
    });

    test('an object that is migrated already is not read again', () => {
        const created = createUser({ settings: { extension_settings: { sillybunny_conversation: { version: 2, settings: {} } } } });

        expect(runMigration(created.user)).toEqual({ state: 'migrated' });
    });

    test('everything in the old object may stay in the backup: the settings are still moved and trimmed', () => {
        const store = {
            version: 1,
            settings: {},
            characters: { [keyFor(PERSONA, 'Cass.png')]: thread('solo', [branch('main', 'Main', [])], { settings: { enabled: false }, avatar: 'Cass.png' }) },
            groups: [],
            reminders: [],
        };
        const created = createUser({ settings: { user_avatar: PERSONA, power_user: { personas: { [PERSONA]: 'x' } }, extension_settings: { sillybunny_conversation: store }, _version: 4 } });

        const result = runMigration(created.user, { now: BASE });

        expect(result.report.migrated.conversations).toBe(0);
        expect(result.report.skipped['hidden-and-empty']).toMatchObject({ threads: 1 });
        expect(JSON.parse(fs.readFileSync(created.settingsPath, 'utf8')).extension_settings.sillybunny_conversation).toMatchObject({ version: 2 });
        expect(fs.readdirSync(path.join(created.user.directories.backups, BACKUP_FOLDER_NAME))).toHaveLength(1);
    });
});

describe('what counts as an existing persona', () => {
    test('a persona that is a file in User Avatars is enough, whether or not power_user lists it', () => {
        const store = { version: 1, settings: {}, characters: { [keyFor(PERSONA_TWO, 'Nova.png')]: thread('solo', [branch('main', 'Main', lines(2))], { settings: { enabled: true } }) }, groups: [], reminders: [] };
        const created = createUser({ settings: { user_avatar: PERSONA, extension_settings: { sillybunny_conversation: store } }, userAvatars: [PERSONA_TWO] });

        expect(runMigration(created.user, { now: BASE }).report.migrated.conversations).toBe(1);
    });

    test('a persona that is in neither place leaves the thread in the backup', () => {
        const store = { version: 1, settings: {}, characters: { [keyFor(PERSONA_TWO, 'Nova.png')]: thread('solo', [branch('main', 'Main', lines(2))], { settings: { enabled: true } }) }, groups: [], reminders: [] };
        const created = createUser({ settings: { user_avatar: PERSONA, extension_settings: { sillybunny_conversation: store } } });

        expect(runMigration(created.user, { now: BASE }).report.skipped['persona-missing']).toMatchObject({ threads: 1 });
    });
});

describe('the backup folder', () => {
    test('never replaces a backup of the same day that holds other data', () => {
        useFixtureUser();
        const folder = path.join(user.directories.backups, BACKUP_FOLDER_NAME, MIGRATION_DAY);
        fs.mkdirSync(folder, { recursive: true });
        fs.writeFileSync(path.join(folder, 'sillybunny_conversation.json'), 'an older backup');

        const result = runMigration(user, { now: MIGRATION_TIME });

        expect(fs.readFileSync(path.join(folder, 'sillybunny_conversation.json'), 'utf8')).toBe('an older backup');
        expect(result.report.backupFile).toBe(path.join(BACKUP_FOLDER_NAME, `${MIGRATION_DAY}-2`, 'sillybunny_conversation.json'));
    });
});

describe('the avatar of a group that cannot be copied', () => {
    test('is counted, and the group is still written', () => {
        useFixtureUser();
        fs.rmSync(path.join(user.directories.userImages, 'group-four.png'));

        const result = runMigration(user);

        expect(result.report.avatarsNotCopied).toBe(1);
        expect(listConversations(user).conversations.every(item => !item.avatar)).toBe(true);
    });
});

describe('verifyWrittenPlan', () => {
    function writtenPlan() {
        useFixtureUser();
        const settings = fixture.settings;
        const plan = planMigration(settings.extension_settings.sillybunny_conversation, {
            activePersona: PERSONA,
            characterExists: () => true,
            personaExists: () => true,
            readRoleplayGroup: () => null,
            pinnedChats: {},
            now: BASE,
        });
        writePlan(user, plan);
        return plan;
    }

    test('finds nothing wrong with what was just written', () => {
        const plan = writtenPlan();

        expect(verifyWrittenPlan(user, plan)).toEqual([]);
    });

    test('finds a chat whose text changed on disk, though its message count is the same', () => {
        const plan = writtenPlan();
        const { id, input } = plan.conversations.find(item => item.input.chats.some(chat => chat.records.length > 2));
        const file = path.join(user.directories.conversations, id, 'chats', `${input.chats.find(chat => chat.records.length > 2).id}.jsonl`);
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/"mes":"[^"]*"/, '"mes":"changed"'));

        expect(verifyWrittenPlan(user, plan)).toContain('a chat differs from the source in message count, order or content');
    });

    test('finds a chat file that is gone, a conversation that is gone and a character state that differs', () => {
        const plan = writtenPlan();
        const [first, second] = plan.conversations;
        fs.rmSync(path.join(user.directories.conversations, first.id, 'chats', `${first.input.chats[0].id}.jsonl`));
        fs.rmSync(path.join(user.directories.conversations, second.id), { recursive: true });
        fs.writeFileSync(path.join(user.directories.conversations, 'characters.json'), JSON.stringify({ version: 1, characters: {} }));

        const problems = verifyWrittenPlan(user, plan);

        expect(problems).toContain('a chat file cannot be read');
        expect(problems).toContain('a conversation is missing');
        expect(problems).toContain('the character state differs from the plan');
    });
});

describe('importLegacyThreads', () => {
    const personaFiles = [PERSONA];

    function importSettings(extra = {}) {
        return { user_avatar: PERSONA, power_user: { personas: { [PERSONA]: 'x' } }, extension_settings: { sillybunny_conversation: { version: 2, localStorageMigrated: false, settings: {} } }, _version: 5, ...extra };
    }

    test('writes the threads as conversations, and marks the import done so that it runs once', () => {
        const created = createUser({ settings: importSettings(), userAvatars: personaFiles });
        const characters = { 'Nova.png': thread('solo', [branch('main', 'Main', lines(3))], { settings: { enabled: true } }) };

        const first = importLegacyThreads(created.user, { personaId: PERSONA, characters });
        const second = importLegacyThreads(created.user, { personaId: PERSONA, characters });

        expect(first).toEqual({ state: 'imported', conversations: 1, chats: 1, messages: 3 });
        expect(second).toEqual({ state: 'already_imported' });
        const listed = listConversations(created.user).conversations;
        expect(listed).toHaveLength(1);
        expect(listed[0]).toMatchObject({ kind: 'direct', personaId: PERSONA, characters: ['Nova.png'], messageCount: 3 });
        const settings = JSON.parse(fs.readFileSync(created.settingsPath, 'utf8'));
        expect(settings.extension_settings.sillybunny_conversation.localStorageMigrated).toBe(true);
        expect(settings._version).toBe(6);
    });

    test('adds the chats to the conversation that the character has already, under new ids', () => {
        const created = createUser({ settings: importSettings() });
        const { conversation } = createConversation(created.user, { kind: 'direct', personaId: PERSONA, characters: ['Nova.png'] });
        const characters = { 'Nova.png': thread('solo', [branch('main', 'Main', lines(2))], { settings: { enabled: true } }) };

        importLegacyThreads(created.user, { personaId: PERSONA, characters });

        const after = readConversation(created.user, conversation.id);
        expect(after.chats).toHaveLength(2);
        expect(new Set(after.chats.map(chat => chat.id)).size).toBe(2);
        expect(listConversations(created.user).conversations).toHaveLength(1);
    });

    test('leaves out a thread whose character has no card, and still marks the import done', () => {
        const created = createUser({ settings: importSettings(), characters: [] });
        const characters = { 'Nova.png': thread('solo', [branch('main', 'Main', lines(2))], { settings: { enabled: true } }) };

        expect(importLegacyThreads(created.user, { personaId: PERSONA, characters })).toEqual({ state: 'imported', conversations: 0, chats: 0, messages: 0 });

        expect(listConversations(created.user).conversations).toEqual([]);
        expect(JSON.parse(fs.readFileSync(created.settingsPath, 'utf8')).extension_settings.sillybunny_conversation.localStorageMigrated).toBe(true);
    });

    test('removes what it wrote and marks nothing done when settings.json changes during the import', () => {
        const created = createUser({ settings: importSettings() });
        const text = fs.readFileSync(created.settingsPath, 'utf8');
        const characters = { 'Nova.png': thread('solo', [branch('main', 'Main', lines(2))], { settings: { enabled: true } }) };
        const original = fs.readFileSync;
        let reads = 0;
        jest.spyOn(fs, 'readFileSync').mockImplementation((file, ...rest) => {
            const data = original(file, ...rest);
            return String(file) === created.settingsPath && ++reads === 2 ? `${data} ` : data;
        });

        expect(() => importLegacyThreads(created.user, { personaId: PERSONA, characters })).toThrow(expect.objectContaining({ code: 'settings_changed' }));

        jest.restoreAllMocks();
        expect(fs.readFileSync(created.settingsPath, 'utf8')).toBe(text);
        expect(listConversations(created.user).conversations).toEqual([]);
    });

    test.each([
        ['a persona that is not a file name', { personaId: '../x', characters: {} }],
        ['characters that are not an object', { personaId: PERSONA, characters: [] }],
        ['no persona', { characters: {} }],
    ])('refuses %s', (_name, body) => {
        const created = createUser({ settings: importSettings() });

        expect(() => importLegacyThreads(created.user, body)).toThrow(ConversationStoreError);
    });
});
