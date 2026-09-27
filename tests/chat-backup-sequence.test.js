/* eslint-disable playwright/no-standalone-expect -- These parameterized cases run under Jest. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { getQueuedChatSaveAbortReason } from '../public/scripts/chat-save-guard.js';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { getChatBackupSaveOptions, resetChatBackupSequence } from '../public/scripts/chat-backup-sequence.js';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const { trySaveChat, clearActiveDeferredChatPreWrites } = await import('../src/endpoints/chats.js');
const sources = Object.fromEntries(['script.js', 'scripts/group-chats.js', 'scripts/extensions/in-chat-agents/agent-runner.js'].map(file => {
    const source = fs.readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');
    return [file, { source, ast: parse(source, { ecmaVersion: 'latest', sourceType: 'module' }) }];
}));

function records(integrity, text) {
    return [{ chat_metadata: { integrity } }, { name: 'Bunny', is_user: false, mes: text }];
}

let directory;
let chatFile;
let backups;
let handle;
beforeEach(() => {
    jest.useFakeTimers();
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
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    fs.rmSync(directory, { recursive: true, force: true });
});

function preWriteFiles() {
    return fs.readdirSync(backups).filter(name => name.startsWith('chat_pre_write_'));
}

function createClient(group) {
    const sent = [];
    async function send(_url, request) {
        const payload = JSON.parse(request.body);
        sent.push(payload);
        const result = await trySaveChat(payload.chat, chatFile, payload.force, handle, 'Bunny', backups, payload);
        return { ok: true, json: async () => result };
    }
    const runtime = vm.createContext({
        console, structuredClone, getChatBackupSaveOptions, uuidv4: randomUUID, getQueuedChatSaveAbortReason,
        chatSaveQueue: Promise.resolve(), groupChatSaveQueue: Promise.resolve(),
        chat: records('original', 'first pass').slice(1), chat_metadata: { integrity: 'original' },
        chatGeneration: 1, getChatGeneration: () => 1,
        this_chid: 0, selected_group: group ? 'group' : null,
        groups: [{ id: 'group', chat_id: 'chat', chats: ['chat'] }],
        characters: [{ name: 'Bunny', avatar: 'bunny.png', chat: 'chat' }],
        getCurrentChatId: () => 'chat', name2: 'Bunny', neutralCharacterName: 'Assistant',
        cloneChatSavePayload: structuredClone, cloneGroupChatSavePayload: structuredClone,
        setChatSaveActive: jest.fn(), getQueuedChatIntegrityKey: () => 'key',
        applyQueuedChatIntegrity: (metadata) => { metadata.integrity = runtime.chat_metadata.integrity; },
        applyQueuedGroupChatIntegrity: (metadata) => { metadata.integrity = runtime.chat_metadata.integrity; },
        rememberQueuedChatIntegrity: jest.fn(), rememberQueuedGroupChatIntegrity: jest.fn(),
        compressRequest: async request => request, getRequestHeaders: () => ({}),
        fetch: send, fetchWithCsrfRetry: async (url, build) => send(url, await build()),
        refreshCsrfToken: jest.fn(), editGroup: jest.fn(),
        toastr: { error: jest.fn() }, t: strings => strings.join(''),
    });
    const { source, ast } = sources[group ? 'scripts/group-chats.js' : 'script.js'];
    for (const name of group ? ['saveGroupChat', 'saveGroupChatImmediately'] : ['saveChat', 'saveChatImmediately']) {
        const node = ast.body.map(node => node.declaration ?? node).find(node => node.id?.name === name);
        vm.runInContext(source.slice(node.start, node.end), runtime);
    }
    const save = options => group ? runtime.saveGroupChat('group', false, false, true, options) : runtime.saveChat(options);
    const runner = sources['scripts/extensions/in-chat-agents/agent-runner.js'];
    const helper = runner.ast.body.find(node => node.id?.name === 'saveChatForAgent');
    vm.runInContext(runner.source.slice(helper.start, helper.end), runtime);
    return { runtime, sent, save, saveForAgent: options => runtime.saveChatForAgent({ saveChat: save }, options) };
}

describe('deferred backups through the real save queues', () => {
    test.each([false, true])('keeps one baseline and one final backup across four passes (group: %s)', async group => {
        const { runtime, save, saveForAgent, sent } = createClient(group);
        for (let pass = 1; pass <= 4; pass++) {
            runtime.chat[0].mes = `pass ${pass}`;
            await expect(save({ deferBackup: true })).resolves.toBe(true);
        }
        runtime.chat[0].mes = 'final reply';
        await saveForAgent({ deferBackup: false });
        expect(new Set(sent.map(payload => payload.deferSequenceId)).size).toBe(1);
        expect(sent[0].deferSequenceId).toEqual(expect.any(String));
        expect(preWriteFiles()).toHaveLength(1);
        expect(fs.readFileSync(path.join(backups, preWriteFiles()[0]), 'utf8')).toContain('before the turn');
        const completed = fs.readdirSync(backups).filter(name => name.startsWith('chat_bunny_'));
        expect(completed).toHaveLength(1);
        expect(fs.readFileSync(path.join(backups, completed[0]), 'utf8')).toContain('final reply');
    });

    test('ordinary edits do not inherit an abandoned sequence', async () => {
        const { runtime, save, sent } = createClient(false);
        await save({ deferBackup: true });
        runtime.chat[0].mes = 'manual edit';
        await save({});
        expect(sent[1].deferSequenceId).toBeUndefined();
        expect(preWriteFiles()).toHaveLength(2);
        runtime.chat[0].mes = 'new agent run';
        await save({ deferBackup: true });
        expect(sent[2].deferSequenceId).not.toBe(sent[0].deferSequenceId);
    });

    test('a new generation gets its own baseline after an abandoned run', async () => {
        const { runtime, save, sent } = createClient(false);
        await save({ deferBackup: true });
        resetChatBackupSequence();
        runtime.chat[0].mes = 'new generation';
        await save({ deferBackup: true });
        expect(sent[1].deferSequenceId).not.toBe(sent[0].deferSequenceId);
        expect(preWriteFiles()).toHaveLength(2);
    });

    test('an unrelated explicit regular save does not close an abandoned agent run', async () => {
        const { runtime, save, sent } = createClient(false);
        await save({ deferBackup: true });
        runtime.chat[0].mes = 'manual companion edit';
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
