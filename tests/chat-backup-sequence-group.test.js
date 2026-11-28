/** @jest-environment jsdom */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { resetChatBackupSequence } from '../public/scripts/chat-backup-sequence.js';
import { setConfigFilePath } from '../src/util.js';
import { importGroupChatsModule } from './util/group-chats-module-harness.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const { trySaveChat, clearActiveDeferredChatPreWrites } = await import('../src/endpoints/chats.js');

function records(integrity, text) {
    return [{ chat_metadata: { integrity } }, { name: 'Bunny', is_user: false, mes: text }];
}

let directory;
let chatFile;
let backups;
let handle;

beforeEach(() => {
    resetChatBackupSequence();
    clearActiveDeferredChatPreWrites();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-backup-sequence-group-'));
    chatFile = path.join(directory, 'chat.jsonl');
    backups = path.join(directory, 'backups');
    handle = randomUUID();
    fs.mkdirSync(backups);
    fs.writeFileSync(chatFile, records('original', 'before the turn').map(JSON.stringify).join('\n'));
});

afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(directory, { recursive: true, force: true });
});

function preWriteFiles() {
    return fs.readdirSync(backups).filter(name => name.startsWith('chat_pre_write_'));
}

describe('deferred backups through the real group chat save queue', () => {
    test('keeps one baseline and one final backup across four passes', async () => {
        const sent = [];
        const fetchMock = jest.fn(async (url, request) => {
            const target = String(url);
            if (target === '/api/chats/group/save') {
                const payload = JSON.parse(request.body);
                sent.push(payload);
                const result = await trySaveChat(payload.chat, chatFile, payload.force, handle, 'Bunny', backups, payload);
                return { ok: true, status: 200, json: async () => result, text: async () => JSON.stringify(result) };
            }
            if (target === '/api/chats/group/get') {
                const initial = records('original', 'first pass');
                return { ok: true, status: 200, json: async () => initial, text: async () => JSON.stringify(initial) };
            }
            return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
        });

        const { groupChats, state } = await importGroupChatsModule({
            fetch: fetchMock,
            chat: [{ name: 'Bunny', is_user: false, mes: 'first pass' }],
            chat_metadata: { integrity: 'original' },
            utils: {
                uuidv4: () => randomUUID(),
            },
        });
        const { resetChatBackupSequence: resetActiveSequence } = await import('../public/scripts/chat-backup-sequence.js');
        resetActiveSequence();

        groupChats.groups.push({ id: 'group', name: 'Bunny Group', chat_id: 'chat', chats: ['chat'], members: [] });
        await groupChats.openGroupById('group');
        if (state.chat.length === 0) {
            state.chat.push({ name: 'Bunny', is_user: false, mes: 'first pass' });
        }
        state.chat_metadata.integrity = 'original';

        for (let pass = 1; pass <= 4; pass++) {
            state.chat[0].mes = `pass ${pass}`;
            await expect(groupChats.saveGroupChat('group', false, false, true, { deferBackup: true })).resolves.toBe(true);
        }
        state.chat[0].mes = 'final reply';
        await expect(groupChats.saveGroupChat('group', false, false, true, {
            deferBackup: false,
            completeDeferredBackup: true,
        })).resolves.toBe(true);

        expect(new Set(sent.map(payload => payload.deferSequenceId)).size).toBe(1);
        expect(sent[0].deferSequenceId).toEqual(expect.any(String));
        expect(preWriteFiles()).toHaveLength(1);
        expect(fs.readFileSync(path.join(backups, preWriteFiles()[0]), 'utf8')).toContain('before the turn');
        const completed = fs.readdirSync(backups).filter(name => name.startsWith('chat_bunny_'));
        expect(completed).toHaveLength(1);
        expect(fs.readFileSync(path.join(backups, completed[0]), 'utf8')).toContain('final reply');
    });
});
