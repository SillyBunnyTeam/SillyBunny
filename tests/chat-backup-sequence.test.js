/** @jest-environment jsdom */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { resetChatBackupSequence } from '../public/scripts/chat-backup-sequence.js';
import { setConfigFilePath } from '../src/util.js';
import { importScriptModule } from './util/script-harness.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const { trySaveChat, clearActiveDeferredChatPreWrites } = await import('../src/endpoints/chats.js');

function records(integrity, text) {
    return [{ chat_metadata: { integrity } }, { name: 'Bunny', is_user: false, mes: text }];
}

let directory;
let chatFile;
let backups;
let handle;
let activeRuntime = null;

beforeEach(() => {
    resetChatBackupSequence();
    clearActiveDeferredChatPreWrites();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-backup-sequence-'));
    chatFile = path.join(directory, 'chat.jsonl');
    backups = path.join(directory, 'backups');
    handle = randomUUID();
    fs.mkdirSync(backups);
    fs.writeFileSync(chatFile, records('original', 'before the turn').map(JSON.stringify).join('\n'));
});

afterEach(() => {
    activeRuntime?.cleanup();
    activeRuntime = null;
    jest.restoreAllMocks();
    fs.rmSync(directory, { recursive: true, force: true });
});

function preWriteFiles() {
    return fs.readdirSync(backups).filter(name => name.startsWith('chat_pre_write_'));
}

async function createSoloClient() {
    const sent = [];
    const fetchMock = jest.fn(async (url, request) => {
        if (String(url) === '/api/chats/save') {
            const payload = JSON.parse(request.body);
            sent.push(payload);
            const result = await trySaveChat(payload.chat, chatFile, payload.force, handle, 'Bunny', backups, payload);
            return { ok: true, status: 200, json: async () => result, text: async () => JSON.stringify(result) };
        }
        return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
    });

    const loaded = await importScriptModule({
        fetch: fetchMock,
        keepReal: ['scripts/chat-save-guard.js', 'scripts/chat-backup-sequence.js'],
        mocks: {
            'scripts/utils.js': {
                uuidv4: () => randomUUID(),
            },
        },
    });
    activeRuntime = loaded;

    const { resetChatBackupSequence: resetActiveSequence } = await import('../public/scripts/chat-backup-sequence.js');
    resetActiveSequence();

    const { script } = loaded;
    script.characters.push({ name: 'Bunny', avatar: 'bunny.png', chat: 'chat' });
    script.setCharacterId(0);
    script.setCharacterName('Bunny');
    script.chat.push({ name: 'Bunny', is_user: false, mes: 'first pass' });
    script.updateChatMetadata({ integrity: 'original' }, true);

    return {
        script,
        sent,
        resetSequence: resetActiveSequence,
        save: options => script.saveChat(options),
        completeDeferredSave: () => script.saveChat({ deferBackup: false, completeDeferredBackup: true }),
    };
}

describe('deferred backups through the real solo chat save queue', () => {
    test('keeps one baseline and one final backup across four passes', async () => {
        const { script, save, completeDeferredSave, sent } = await createSoloClient();
        for (let pass = 1; pass <= 4; pass++) {
            script.chat[0].mes = `pass ${pass}`;
            await expect(save({ deferBackup: true })).resolves.toBe(true);
        }
        script.chat[0].mes = 'final reply';
        await expect(completeDeferredSave()).resolves.toBe(true);

        expect(new Set(sent.map(payload => payload.deferSequenceId)).size).toBe(1);
        expect(sent[0].deferSequenceId).toEqual(expect.any(String));
        expect(preWriteFiles()).toHaveLength(1);
        expect(fs.readFileSync(path.join(backups, preWriteFiles()[0]), 'utf8')).toContain('before the turn');
        const completed = fs.readdirSync(backups).filter(name => name.startsWith('chat_bunny_'));
        expect(completed).toHaveLength(1);
        expect(fs.readFileSync(path.join(backups, completed[0]), 'utf8')).toContain('final reply');
    });

    test('ordinary edits do not inherit an abandoned sequence', async () => {
        const { script, save, sent } = await createSoloClient();
        await save({ deferBackup: true });
        script.chat[0].mes = 'manual edit';
        await save({});
        expect(sent[1].deferSequenceId).toBeUndefined();
        expect(preWriteFiles()).toHaveLength(2);
        script.chat[0].mes = 'new agent run';
        await save({ deferBackup: true });
        expect(sent[2].deferSequenceId).not.toBe(sent[0].deferSequenceId);
    });

    test('a new generation gets its own baseline after an abandoned run', async () => {
        const { script, save, sent, resetSequence } = await createSoloClient();
        await save({ deferBackup: true });
        resetSequence();
        script.chat[0].mes = 'new generation';
        await save({ deferBackup: true });
        expect(sent[1].deferSequenceId).not.toBe(sent[0].deferSequenceId);
        expect(preWriteFiles()).toHaveLength(2);
    });

    test('an unrelated explicit regular save does not close an abandoned agent run', async () => {
        const { script, save, sent } = await createSoloClient();
        await save({ deferBackup: true });
        script.chat[0].mes = 'manual companion edit';
        await save({ deferBackup: false });
        expect(sent[1].deferSequenceId).toBeUndefined();
        expect(preWriteFiles()).toHaveLength(2);
    });
});

describe('deferred recovery anchor failures', () => {
    test('an unchanged opening save cannot suppress the first actual backup', async () => {
        const options = { deferBackup: true, deferSequenceId: 'no-op-first' };
        await trySaveChat(records('original', 'before the turn'), chatFile, false, handle, 'Bunny', backups, options);
        expect(preWriteFiles()).toHaveLength(0);
        await trySaveChat(records('original', 'changed'), chatFile, false, handle, 'Bunny', backups, options);
        expect(preWriteFiles()).toHaveLength(1);
        expect(fs.readFileSync(path.join(backups, preWriteFiles()[0]), 'utf8')).toContain('before the turn');
    });

    test('a failed baseline backup rejects the save and allows a protected retry', async () => {
        const options = { deferBackup: true, deferSequenceId: 'failed-backup' };
        const open = fs.openSync.bind(fs);
        const failure = jest.spyOn(fs, 'openSync').mockImplementation((target, ...args) => {
            if (String(target).startsWith(backups + path.sep)) throw new Error('backup disk unavailable');
            return open(target, ...args);
        });
        await expect(trySaveChat(records('original', 'must not be written'), chatFile, false, handle, 'Bunny', backups, options)).rejects.toThrow('backup disk unavailable');
        expect(fs.readFileSync(chatFile, 'utf8')).toContain('before the turn');
        failure.mockRestore();
        await trySaveChat(records('original', 'safe retry'), chatFile, false, handle, 'Bunny', backups, options);
        expect(preWriteFiles()).toHaveLength(1);
    });

    test('a failed authoritative write does not open a suppression sequence', async () => {
        const options = { deferBackup: true, deferSequenceId: 'failed-write' };
        const open = fs.openSync.bind(fs);
        const failure = jest.spyOn(fs, 'openSync').mockImplementation((target, flags, ...args) => {
            if (target === chatFile && flags === 'r+') throw new Error('chat disk unavailable');
            return open(target, flags, ...args);
        });
        await expect(trySaveChat(records('original', 'failed write'), chatFile, false, handle, 'Bunny', backups, options)).rejects.toThrow('chat disk unavailable');
        failure.mockRestore();
        fs.writeFileSync(chatFile, records('other', 'another writer').map(JSON.stringify).join('\n'));
        await trySaveChat(records('other', 'safe retry'), chatFile, false, handle, 'Bunny', backups, options);
        expect(preWriteFiles()).toHaveLength(2);
        expect(preWriteFiles().some(name => fs.readFileSync(path.join(backups, name), 'utf8').includes('another writer'))).toBe(true);
    });
});
