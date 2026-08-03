import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));

const { createCharacterChatTarget, getChatRecoveryPaths } = await import('../src/chat-recovery.js');
const { removeOldRegularChatBackups, trySaveChat } = await import('../src/endpoints/chats.js');

const OWNER = 'Test Character';
const FILENAME = 'Test Character - chat.jsonl';
const HANDLE = 'default-user';

function header(extra = {}) {
    return { chat_metadata: { ...extra }, user_name: 'unused', character_name: 'unused' };
}

function message(index) {
    return { name: 'Test Character', is_user: index % 2 === 1, mes: `message ${index}`, extra: {} };
}

function populatedChat(messageCount) {
    return [header(), ...Array.from({ length: messageCount }, (_, index) => message(index))];
}

function serialize(chatData) {
    return chatData.map(row => JSON.stringify(row)).join('\n');
}

function countRows(serializedChat) {
    return serializedChat.split('\n').filter(line => line.trim()).length;
}

describe('destructive chat save rejection', () => {
    let root;
    let chatsDirectory;
    let backupDirectory;
    let activeDirectory;
    let activePath;
    let recoveryTarget;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-chat-save-'));
        chatsDirectory = path.join(root, 'chats');
        backupDirectory = path.join(root, 'backups');
        activeDirectory = path.join(chatsDirectory, OWNER);
        fs.mkdirSync(activeDirectory, { recursive: true });
        fs.mkdirSync(backupDirectory, { recursive: true });
        activePath = path.join(activeDirectory, FILENAME);
        recoveryTarget = createCharacterChatTarget({
            chatsDirectory,
            backupDirectory,
            owner: OWNER,
            filename: FILENAME,
        });
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    const save = (chatData, { force = false, allowShrink = false } = {}) => trySaveChat(
        chatData,
        activePath,
        force,
        HANDLE,
        OWNER,
        backupDirectory,
        { recoveryTarget, allowShrink },
    );

    test('refuses a message-less payload over a populated chat and leaves the file untouched', async () => {
        const existing = serialize(populatedChat(8));
        fs.writeFileSync(activePath, existing, 'utf8');

        await expect(save([header()])).rejects.toMatchObject({ reason: 'emptied' });
        expect(fs.readFileSync(activePath, 'utf8')).toBe(existing);
    });

    test('refuses a greeting-only payload over a populated chat', async () => {
        const existing = serialize(populatedChat(8));
        fs.writeFileSync(activePath, existing, 'utf8');

        await expect(save([header(), message(0)])).rejects.toMatchObject({ reason: 'shrink' });
        expect(countRows(fs.readFileSync(activePath, 'utf8'))).toBe(9);
    });

    test('allows a save that keeps most of the chat', async () => {
        fs.writeFileSync(activePath, serialize(populatedChat(8)), 'utf8');

        await expect(save(populatedChat(7))).resolves.toMatchObject({ integrity: expect.any(String) });
        expect(countRows(fs.readFileSync(activePath, 'utf8'))).toBe(8);
    });

    test('allows a message-less save when the existing chat has no messages', async () => {
        fs.writeFileSync(activePath, serialize([header()]), 'utf8');

        await expect(save([header()])).resolves.toBeDefined();
    });

    test('allows a deliberate deletion that removes every message', async () => {
        fs.writeFileSync(activePath, serialize(populatedChat(8)), 'utf8');

        await expect(save([header()], { allowShrink: true })).resolves.toBeDefined();
        expect(countRows(fs.readFileSync(activePath, 'utf8'))).toBe(1);
    });

    test('allows a deliberate deletion that removes most of the chat', async () => {
        fs.writeFileSync(activePath, serialize(populatedChat(8)), 'utf8');

        await expect(save(populatedChat(1), { allowShrink: true })).resolves.toBeDefined();
        expect(countRows(fs.readFileSync(activePath, 'utf8'))).toBe(2);
    });

    test('refuses to overwrite an existing chat that cannot be read', async () => {
        // A directory at the chat path exists but cannot be read, standing in for a locked or
        // permission-denied file: the chat can be neither inspected nor backed up before the overwrite.
        fs.mkdirSync(activePath);

        await expect(save(populatedChat(9))).rejects.toMatchObject({ reason: 'unreadable' });
        expect(fs.statSync(activePath).isDirectory()).toBe(true);
    });

    test('allowShrink does not authorize overwriting an unreadable chat', async () => {
        fs.mkdirSync(activePath);

        await expect(save(populatedChat(1), { allowShrink: true })).rejects.toMatchObject({ reason: 'unreadable' });
        expect(fs.statSync(activePath).isDirectory()).toBe(true);
    });

    test('still allows a destructive save when the client forces it', async () => {
        fs.writeFileSync(activePath, serialize(populatedChat(8)), 'utf8');

        await expect(save([header()], { force: true })).resolves.toBeDefined();
        expect(countRows(fs.readFileSync(activePath, 'utf8'))).toBe(1);
    });

    test('a refused save cannot mirror itself into the recovery snapshot', async () => {
        const { latestPath } = getChatRecoveryPaths(recoveryTarget);
        fs.writeFileSync(activePath, serialize(populatedChat(8)), 'utf8');

        await save(populatedChat(9));
        expect(countRows(fs.readFileSync(latestPath, 'utf8'))).toBe(10);

        // The snapshot is only ever an exact mirror of a save that survived the destructive-write check.
        await expect(save([header()])).rejects.toThrow();
        expect(countRows(fs.readFileSync(latestPath, 'utf8'))).toBe(10);
        expect(countRows(fs.readFileSync(activePath, 'utf8'))).toBe(10);
    });

    test('an unchanged save leaves the chat file and its recovery snapshot untouched', async () => {
        const { latestPath } = getChatRecoveryPaths(recoveryTarget);
        const unchanged = [header({ integrity: 'disk-integrity' }), ...populatedChat(8).slice(1)];
        const serialized = serialize(unchanged);
        fs.writeFileSync(activePath, serialized, 'utf8');
        const beforeActive = fs.statSync(activePath);

        // The first save has nothing to change, so it only fills in the snapshot.
        await expect(save(unchanged)).resolves.toEqual({ integrity: 'disk-integrity' });
        const afterActive = fs.statSync(activePath);
        const beforeSnapshot = fs.statSync(latestPath);

        // Writes rename a temp file over the target, so a surviving inode is the real assertion.
        expect(afterActive.ino).toBe(beforeActive.ino);
        expect(afterActive.mtimeMs).toBe(beforeActive.mtimeMs);
        expect(fs.readFileSync(activePath, 'utf8')).toBe(serialized);
        expect(fs.readFileSync(latestPath, 'utf8')).toBe(serialized);

        // A repeat open has nothing left to write anywhere.
        await expect(save(unchanged)).resolves.toEqual({ integrity: 'disk-integrity' });
        expect(fs.statSync(activePath).ino).toBe(beforeActive.ino);
        expect(fs.statSync(latestPath).ino).toBe(beforeSnapshot.ino);
        expect(fs.readdirSync(backupDirectory).filter(f => f.startsWith('chat_pre_write_'))).toHaveLength(0);
    });

    test('a refused save does not consume the pre-write backup ring', async () => {
        fs.writeFileSync(activePath, serialize(populatedChat(8)), 'utf8');
        const preWriteCount = () => fs.readdirSync(backupDirectory).filter(f => f.startsWith('chat_pre_write_')).length;

        await save(populatedChat(9));
        const afterGoodSave = preWriteCount();

        await expect(save([header()])).rejects.toThrow();
        expect(preWriteCount()).toBe(afterGoodSave);
    });
});

describe('regular chat backup rotation', () => {
    let backupDirectory;

    beforeEach(() => {
        backupDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-backup-rotation-'));
    });

    afterEach(() => {
        fs.rmSync(backupDirectory, { recursive: true, force: true });
    });

    test('does not rotate away the pre-write and forced-overwrite recovery layers', () => {
        const write = (name) => fs.writeFileSync(path.join(backupDirectory, name), 'x', 'utf8');
        for (let index = 0; index < 6; index++) {
            write(`chat_character_2026010${index}-000000.jsonl`);
        }
        write('chat_pre_write_character_20260101-000000_id.jsonl');
        write('chat_forced_overwrite_character_20260101-000000.jsonl');

        removeOldRegularChatBackups(backupDirectory, 2);

        const remaining = fs.readdirSync(backupDirectory);
        expect(remaining).toContain('chat_pre_write_character_20260101-000000_id.jsonl');
        expect(remaining).toContain('chat_forced_overwrite_character_20260101-000000.jsonl');
        expect(remaining.filter(f => f.startsWith('chat_character_'))).toHaveLength(2);
    });
});
