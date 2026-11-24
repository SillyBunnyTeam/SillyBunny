/**
 * "Reset settings" deletes `settings.json` and puts the default one back. Conversations are in `conversations/` and
 * not in that file, so a reset must leave them as they are.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeEach, describe, expect, test } from '@jest/globals';

import { branch, lines, thread } from './util/conversation-legacy-fixture.js';
import { snapshotTree } from './util/install-sandbox.js';
import { OPEN_MEMBER, startAccountServer } from './util/user-account-harness.js';

const harness = await startAccountServer();
const { conversationIndex } = await import('../src/conversation-index.js');
const { importLegacyThreads, runMigration } = await import('../src/conversation-migration.js');
const { createConversation, listConversations, readCharacterState, readConversation, updateCharacterState } = await import('../src/conversation-store.js');

const DEFAULT_SETTINGS_PATH = fileURLToPath(new URL('../default/content/settings.json', import.meta.url));
const PERSONA = 'user-default.png';
const CONVERSATION_ID = 'conv_1700000000000_abcdef0123';
const PIN_KEY = `conversation_${CONVERSATION_ID}_main`;

beforeEach(() => harness.reset());

afterAll(async () => {
    conversationIndex.close();
    await harness.close();
});

function userOf(handle) {
    return { profile: { handle }, directories: harness.users.getUserDirectories(handle) };
}

/** A user who has been migrated: settings.json holds the part of the old object that stays, and the pins of the new keys. */
function seedMigratedUser(handle) {
    const user = userOf(handle);
    const at = Date.UTC(2026, 0, 1);
    createConversation(user, {
        id: CONVERSATION_ID,
        kind: 'direct',
        personaId: PERSONA,
        characters: ['Nova.png'],
        settings: { quiet_hours_start: '23:00' },
        chats: [{
            id: 'main',
            name: 'Main',
            createdAt: at,
            records: [
                { chat_metadata: {}, user_name: 'unused', character_name: 'unused' },
                { id: 'm1', name: 'Nova', is_user: false, is_system: false, role: 'character', send_date: new Date(at).toISOString(), created_at: at, mes: 'Hello', extra: {} },
            ],
        }],
    });
    updateCharacterState(user, 'Nova.png', { routine: { enabled: true, text: '{"days":{}}', generatedAt: at } });
    fs.writeFileSync(path.join(user.directories.root, 'settings.json'), JSON.stringify({
        user_avatar: PERSONA,
        _version: 7,
        extension_settings: { sillybunny_conversation: { version: 2, localStorageMigrated: true, settings: { quiet_hours_start: '23:00' }, userStatus: { text: 'away' } } },
        accountStorage: { pinnedChats: JSON.stringify({ [PIN_KEY]: { is_conversation: true, conversation_id: CONVERSATION_ID, conversation_chat_id: 'main' } }) },
    }));
    return user;
}

describe('the import of the old browser storage after a reset', () => {
    // `localStorageMigrated` is the only record that the import ran, and it sits in the file that a reset deletes.
    test.failing('does not run a second time, so that the imported chats are not added to their conversation again', async () => {
        const client = await harness.loginAs(OPEN_MEMBER);
        const user = seedMigratedUser(OPEN_MEMBER.handle);
        for (const [directory, name] of [[user.directories.characters, 'Nova.png'], [user.directories.avatars, PERSONA]]) {
            fs.mkdirSync(directory, { recursive: true });
            fs.writeFileSync(path.join(directory, name), 'PNG');
        }
        const characters = { 'Nova.png': thread('solo', [branch('main', 'Main', lines(2))], { settings: { enabled: true } }) };

        await client.post('/api/users/reset-settings');
        const outcome = importLegacyThreads(user, { personaId: PERSONA, characters });

        expect(outcome).toEqual({ state: 'already_imported' });
        expect(readConversation(user, CONVERSATION_ID).chats).toHaveLength(1);
    });
});

describe('POST /api/users/reset-settings with conversations', () => {
    test('puts the default settings back and leaves every file of conversations/ as it was', async () => {
        const client = await harness.loginAs(OPEN_MEMBER);
        const user = seedMigratedUser(OPEN_MEMBER.handle);
        const before = snapshotTree(user.directories.conversations);

        const response = await client.post('/api/users/reset-settings');

        expect(response.status).toBe(204);
        expect(snapshotTree(user.directories.conversations)).toEqual(before);
        expect(JSON.parse(fs.readFileSync(path.join(user.directories.root, 'settings.json'), 'utf8'))).toEqual(JSON.parse(fs.readFileSync(DEFAULT_SETTINGS_PATH, 'utf8')));
    });

    test('the conversations and the character state are still there, and nothing is left to migrate', async () => {
        const client = await harness.loginAs(OPEN_MEMBER);
        const user = seedMigratedUser(OPEN_MEMBER.handle);

        await client.post('/api/users/reset-settings');

        const listed = listConversations(user);
        expect(listed.problems).toEqual([]);
        expect(listed.conversations.map(item => item.id)).toEqual([CONVERSATION_ID]);
        expect(listed.conversations[0].messageCount).toBe(1);
        expect(readCharacterState(user).characters['Nova.png'].routine.enabled).toBe(true);
        expect(runMigration(user)).toEqual({ state: 'nothing_to_migrate' });
    });

    test('the mode-wide settings and the pins of conversations live in settings.json, so they are reset', async () => {
        const client = await harness.loginAs(OPEN_MEMBER);
        const user = seedMigratedUser(OPEN_MEMBER.handle);

        await client.post('/api/users/reset-settings');

        const settings = JSON.parse(fs.readFileSync(path.join(user.directories.root, 'settings.json'), 'utf8'));
        expect(settings.extension_settings?.sillybunny_conversation).toBeUndefined();
        expect(settings.accountStorage?.pinnedChats ?? '{}').not.toContain(PIN_KEY);
    });
});
