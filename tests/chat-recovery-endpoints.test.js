import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));

const {
    CHAT_RECOVERY_DIRECTORY,
    createCharacterChatTarget,
    createGroupChatTarget,
    getChatRecoveryPaths,
    markChatDeleted,
    writeLatestChatSnapshot,
} = await import('../src/chat-recovery.js');
const { router: chatsRouter } = await import('../src/endpoints/chats.js');
const { router: charactersRouter } = await import('../src/endpoints/characters.js');
const { router: groupsRouter } = await import('../src/endpoints/groups.js');

describe('chat recovery endpoint fallbacks', () => {
    let baseUrl;
    let directories;
    let server;
    let tempRoot;

    beforeAll(async () => {
        const app = express();
        app.use(express.json());
        app.use((request, _response, next) => {
            request.user = {
                profile: { handle: 'recovery-test-user' },
                directories,
            };
            next();
        });
        app.use('/api/chats', chatsRouter);
        app.use('/api/characters', charactersRouter);
        app.use('/api/groups', groupsRouter);

        await new Promise((resolve) => {
            server = app.listen(0, '127.0.0.1', resolve);
        });
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    beforeEach(() => {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-chat-recovery-endpoints-'));
        directories = {
            backups: path.join(tempRoot, 'backups'),
            chats: path.join(tempRoot, 'chats'),
            characters: path.join(tempRoot, 'characters'),
            groupChats: path.join(tempRoot, 'group chats'),
            groups: path.join(tempRoot, 'groups'),
            thumbnailsAvatar: path.join(tempRoot, 'thumbnails', 'avatar'),
            thumbnailsAvatarMobile: path.join(tempRoot, 'thumbnails', 'avatar-mobile'),
        };
        for (const directory of Object.values(directories)) {
            fs.mkdirSync(directory, { recursive: true });
        }
    });

    afterEach(() => {
        jest.restoreAllMocks();
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    afterAll(async () => {
        if (server) {
            await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
    });

    test('allows an explicitly new character chat when recovery storage is unavailable', async () => {
        fs.writeFileSync(path.join(directories.backups, CHAT_RECOVERY_DIRECTORY), 'not a directory');
        const consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => {});

        const response = await postJson('/api/chats/get', {
            avatar_url: 'Test Card.png',
            file_name: 'New Chat',
            allow_create: true,
        });

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual([]);
        expect(consoleWarn).toHaveBeenCalledWith(
            'Failed to inspect chat recovery state; continuing without sidecar recovery.',
            expect.any(Error),
        );
    });

    test('creates a new character chat through the normal save route', async () => {
        const owner = 'Test Card';
        const fileName = 'New Character.jsonl';
        const chatDirectory = path.join(directories.chats, owner);
        const chatPath = path.join(chatDirectory, fileName);
        fs.mkdirSync(chatDirectory, { recursive: true });

        const response = await postJson('/api/chats/save', {
            avatar_url: `${owner}.png`,
            file_name: path.parse(fileName).name,
            chat: createChatPayload(undefined, 'new chat'),
            deferBackup: true,
        });
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body).toEqual({ ok: true, integrity: expect.any(String) });
        expect(fs.readFileSync(chatPath, 'utf8')).toContain('"mes":"new chat"');
    });

    test('keeps a noncanonical character chat file untouched on a semantic no-op save', async () => {
        const owner = 'Test Card';
        const fileName = 'No-op Character.jsonl';
        const chatDirectory = path.join(directories.chats, owner);
        const chatPath = path.join(chatDirectory, fileName);
        const payload = createChatPayload('character-integrity', 'café');
        payload[0].chat_metadata.layout = { alpha: 1, beta: 2 };
        const onDisk = '\r\n{ "unknown_header": true, "chat_metadata": { "layout": { "beta": 2, "alpha": 1 }, "integrity": "character-integrity" }, "user_name": "Original" }\r\n\r\n{"mes":"caf\\u00e9","name":"Character"}\r\n';
        fs.mkdirSync(chatDirectory, { recursive: true });
        fs.writeFileSync(chatPath, onDisk);
        const before = fs.statSync(chatPath);

        const response = await postJson('/api/chats/save', {
            avatar_url: `${owner}.png`,
            file_name: path.parse(fileName).name,
            chat: payload,
            deferBackup: true,
        });
        const after = fs.statSync(chatPath);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ ok: true, integrity: 'character-integrity' });
        expect(fs.readFileSync(chatPath, 'utf8')).toBe(onDisk);
        expect(after.ino).toBe(before.ino);
        expect(after.mtimeMs).toBe(before.mtimeMs);
        expect(after.birthtimeMs).toBe(before.birthtimeMs);
    });

    test('updates an existing character chat without replacing its filesystem identity', async () => {
        const owner = 'Test Card';
        const fileName = 'Changed Character.jsonl';
        const chatDirectory = path.join(directories.chats, owner);
        const chatPath = path.join(chatDirectory, fileName);
        const oldIntegrity = 'character-integrity';
        const oldPayload = createChatPayload(oldIntegrity, 'unchanged message');
        const updatedPayload = createChatPayload(oldIntegrity, 'unchanged message');
        updatedPayload[0].chat_metadata.dialogue_colors_overrides = { message: { verified: true } };
        fs.mkdirSync(chatDirectory, { recursive: true });
        fs.writeFileSync(chatPath, oldPayload.map(JSON.stringify).join('\n'));
        const before = fs.statSync(chatPath);

        const response = await postJson('/api/chats/save', {
            avatar_url: `${owner}.png`,
            file_name: path.parse(fileName).name,
            chat: updatedPayload,
            deferBackup: true,
        });
        const body = await response.json();
        const after = fs.statSync(chatPath);
        const saved = fs.readFileSync(chatPath, 'utf8');

        expect(response.status).toBe(200);
        expect(body).toEqual({ ok: true, integrity: expect.any(String) });
        expect(body.integrity).not.toBe(oldIntegrity);
        expect(after.ino).toBe(before.ino);
        expect(after.birthtimeMs).toBe(before.birthtimeMs);
        expect(saved).toContain('"dialogue_colors_overrides"');
        expect(saved).toContain('"mes":"unchanged message"');
    });

    test('keeps an unchanged legacy group chat file untouched and slugless', async () => {
        const chatId = 'No-op Group';
        const chatPath = path.join(directories.groupChats, `${chatId}.jsonl`);
        const payload = createChatPayload(undefined, 'legacy group');
        const onDisk = `\n${JSON.stringify({ name: 'Legacy Group', unknown_header: true })}\r\n${JSON.stringify(payload[1])}\r\n`;
        fs.writeFileSync(chatPath, onDisk);
        const before = fs.statSync(chatPath);

        const response = await postJson('/api/chats/group/save', {
            id: chatId,
            chat: payload,
            deferBackup: true,
        });
        const after = fs.statSync(chatPath);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ ok: true, integrity: '' });
        expect(fs.readFileSync(chatPath, 'utf8')).toBe(onDisk);
        expect(after.ino).toBe(before.ino);
        expect(after.mtimeMs).toBe(before.mtimeMs);
        expect(after.birthtimeMs).toBe(before.birthtimeMs);
    });

    test('updates an existing group chat without replacing its filesystem identity', async () => {
        const chatId = 'Changed Group';
        const chatPath = path.join(directories.groupChats, `${chatId}.jsonl`);
        const oldIntegrity = 'group-integrity';
        const oldPayload = createChatPayload(oldIntegrity, 'unchanged group message');
        const updatedPayload = createChatPayload(oldIntegrity, 'unchanged group message');
        updatedPayload[0].chat_metadata.extension_state = { updated: true };
        fs.writeFileSync(chatPath, oldPayload.map(JSON.stringify).join('\n'));
        const before = fs.statSync(chatPath);

        const response = await postJson('/api/chats/group/save', {
            id: chatId,
            chat: updatedPayload,
            deferBackup: true,
        });
        const body = await response.json();
        const after = fs.statSync(chatPath);
        const saved = fs.readFileSync(chatPath, 'utf8');

        expect(response.status).toBe(200);
        expect(body).toEqual({ ok: true, integrity: expect.any(String) });
        expect(body.integrity).not.toBe(oldIntegrity);
        expect(after.ino).toBe(before.ino);
        expect(after.birthtimeMs).toBe(before.birthtimeMs);
        expect(saved).toContain('"extension_state":{"updated":true}');
        expect(saved).toContain('"mes":"unchanged group message"');
    });

    test('renames a character chat when recovery storage is unavailable', async () => {
        const chatDirectory = path.join(directories.chats, 'Test Card');
        const sourcePath = path.join(chatDirectory, 'Old Chat.jsonl');
        const destinationPath = path.join(chatDirectory, 'Renamed Chat.jsonl');
        fs.mkdirSync(chatDirectory, { recursive: true });
        fs.writeFileSync(sourcePath, createChatData('rename me'));
        fs.writeFileSync(path.join(directories.backups, CHAT_RECOVERY_DIRECTORY), 'not a directory');
        const consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => {});

        const response = await postJson('/api/chats/rename', {
            avatar_url: 'Test Card.png',
            original_file: 'Old Chat.jsonl',
            renamed_file: 'Renamed Chat.jsonl',
            is_group: false,
        });

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({ ok: true, sanitizedFileName: 'Renamed Chat' });
        expect(fs.existsSync(sourcePath)).toBe(false);
        expect(fs.readFileSync(destinationPath, 'utf8')).toContain('rename me');
        expect(consoleWarn).toHaveBeenCalledWith(
            'Failed to prepare chat recovery state; continuing with chat rename.',
            expect.any(Error),
        );
    });

    test('invalidates stale recovery state when a sidecar rekey fails after rename', async () => {
        const owner = 'Test Card';
        const sourceFileName = 'Old Chat.jsonl';
        const destinationFileName = 'Renamed Chat.jsonl';
        const chatDirectory = path.join(directories.chats, owner);
        const sourcePath = path.join(chatDirectory, sourceFileName);
        const destinationPath = path.join(chatDirectory, destinationFileName);
        fs.mkdirSync(chatDirectory, { recursive: true });
        fs.writeFileSync(sourcePath, createChatData('rename me'));
        const sourceTarget = createCharacterChatTarget({
            chatsDirectory: directories.chats,
            backupDirectory: directories.backups,
            owner,
            filename: sourceFileName,
        });
        const destinationTarget = createCharacterChatTarget({
            chatsDirectory: directories.chats,
            backupDirectory: directories.backups,
            owner,
            filename: destinationFileName,
        });
        writeLatestChatSnapshot(sourceTarget, createChatData('stale old-name snapshot'));
        const sourceRecoveryPaths = getChatRecoveryPaths(sourceTarget);
        const destinationRecoveryPaths = getChatRecoveryPaths(destinationTarget);
        const linkedFile = path.join(tempRoot, 'unsafe-destination-recovery.jsonl');
        const linkedData = createChatData('do not touch');
        fs.writeFileSync(linkedFile, linkedData);
        fs.symlinkSync(linkedFile, destinationRecoveryPaths.latestPath);
        const consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => {});

        const response = await postJson('/api/chats/rename', {
            avatar_url: `${owner}.png`,
            original_file: sourceFileName,
            renamed_file: destinationFileName,
            is_group: false,
        });

        expect(response.status).toBe(200);
        expect(fs.existsSync(sourcePath)).toBe(false);
        expect(fs.readFileSync(destinationPath, 'utf8')).toContain('rename me');
        expect(fs.existsSync(sourceRecoveryPaths.latestPath)).toBe(false);
        expect(fs.lstatSync(destinationRecoveryPaths.latestPath).isSymbolicLink()).toBe(true);
        expect(fs.readFileSync(linkedFile, 'utf8')).toBe(linkedData);
        expect(consoleWarn).toHaveBeenCalledWith(
            'Failed to move chat recovery state; continuing with renamed chat.',
            expect.any(Error),
        );
        expect(consoleWarn).toHaveBeenCalledWith(
            'Failed to clear destination chat recovery state after rename.',
            expect.any(Error),
        );
    });

    test('deletes a character chat when recovery storage is unavailable', async () => {
        const chatDirectory = path.join(directories.chats, 'Test Card');
        const chatPath = path.join(chatDirectory, 'Delete Me.jsonl');
        fs.mkdirSync(chatDirectory, { recursive: true });
        fs.writeFileSync(chatPath, createChatData('delete me'));
        fs.writeFileSync(path.join(directories.backups, CHAT_RECOVERY_DIRECTORY), 'not a directory');
        const consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => {});

        const response = await postJson('/api/chats/delete', {
            avatar_url: 'Test Card.png',
            chatfile: 'Delete Me.jsonl',
        });

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ ok: true });
        expect(fs.existsSync(chatPath)).toBe(false);
        expect(consoleWarn).toHaveBeenCalledWith(
            'Failed to mark chat recovery state for deletion; continuing with chat deletion.',
            expect.any(Error),
        );
    });

    test('clears character chat recovery state after successful deletion', async () => {
        const owner = 'Test Card';
        const fileName = 'Delete Cleanly.jsonl';
        const chatDirectory = path.join(directories.chats, owner);
        const chatPath = path.join(chatDirectory, fileName);
        fs.mkdirSync(chatDirectory, { recursive: true });
        fs.writeFileSync(chatPath, createChatData('delete cleanly'));
        const recoveryTarget = createCharacterChatTarget({
            chatsDirectory: directories.chats,
            backupDirectory: directories.backups,
            owner,
            filename: fileName,
        });
        writeLatestChatSnapshot(recoveryTarget, createChatData('snapshot'));
        markChatDeleted(recoveryTarget);
        const recoveryPaths = getChatRecoveryPaths(recoveryTarget);
        for (const quarantinePath of recoveryPaths.quarantinePaths) {
            fs.writeFileSync(quarantinePath, 'quarantined bytes');
        }

        const response = await postJson('/api/chats/delete', {
            avatar_url: `${owner}.png`,
            chatfile: fileName,
        });

        expect(response.status).toBe(200);
        expect(fs.existsSync(chatPath)).toBe(false);
        expect(fs.existsSync(recoveryPaths.latestPath)).toBe(false);
        expect(fs.existsSync(recoveryPaths.tombstonePath)).toBe(false);
        expect(recoveryPaths.quarantinePaths.every(filePath => !fs.existsSync(filePath))).toBe(true);
    });

    test('deletes a group chat when recovery storage is unavailable', async () => {
        const chatId = 'Group Chat';
        const chatPath = path.join(directories.groupChats, `${chatId}.jsonl`);
        fs.writeFileSync(chatPath, createChatData('delete group chat'));
        fs.writeFileSync(path.join(directories.backups, CHAT_RECOVERY_DIRECTORY), 'not a directory');
        const consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => {});

        const response = await postJson('/api/chats/group/delete', { id: chatId });

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ ok: true });
        expect(fs.existsSync(chatPath)).toBe(false);
        expect(consoleWarn).toHaveBeenCalledWith(
            'Failed to mark chat recovery state for deletion; continuing with chat deletion.',
            expect.any(Error),
        );
    });

    test('clears group chat recovery state after successful deletion', async () => {
        const chatId = 'Delete Group Cleanly';
        const fileName = `${chatId}.jsonl`;
        const chatPath = path.join(directories.groupChats, fileName);
        fs.writeFileSync(chatPath, createChatData('delete cleanly'));
        const recoveryTarget = createGroupChatTarget({
            groupChatsDirectory: directories.groupChats,
            backupDirectory: directories.backups,
            filename: fileName,
        });
        writeLatestChatSnapshot(recoveryTarget, createChatData('snapshot'));
        markChatDeleted(recoveryTarget);
        const recoveryPaths = getChatRecoveryPaths(recoveryTarget);

        const response = await postJson('/api/chats/group/delete', { id: chatId });

        expect(response.status).toBe(200);
        expect(fs.existsSync(chatPath)).toBe(false);
        expect(fs.existsSync(recoveryPaths.latestPath)).toBe(false);
        expect(fs.existsSync(recoveryPaths.tombstonePath)).toBe(false);
        expect(recoveryPaths.quarantinePaths.every(filePath => !fs.existsSync(filePath))).toBe(true);
    });

    test('deletes a character and its chats when recovery storage is unavailable', async () => {
        const owner = 'Test Card';
        const avatarFileName = `${owner}.png`;
        const avatarPath = path.join(directories.characters, avatarFileName);
        const chatDirectory = path.join(directories.chats, owner);
        fs.writeFileSync(avatarPath, 'avatar');
        fs.mkdirSync(chatDirectory, { recursive: true });
        fs.writeFileSync(path.join(chatDirectory, 'Delete With Character.jsonl'), createChatData('delete me'));
        fs.writeFileSync(path.join(directories.backups, CHAT_RECOVERY_DIRECTORY), 'not a directory');
        const consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => {});

        const response = await postJson('/api/characters/delete', {
            avatar_url: avatarFileName,
            delete_chats: true,
        });

        expect(response.status).toBe(200);
        expect(fs.existsSync(avatarPath)).toBe(false);
        expect(fs.existsSync(chatDirectory)).toBe(false);
        expect(consoleWarn).toHaveBeenCalledWith(
            'Failed to mark chat recovery state for deletion; continuing with character deletion.',
            expect.any(Error),
        );
    });

    test('clears recovery state after deleting a character and its chats', async () => {
        const owner = 'Test Card';
        const avatarFileName = `${owner}.png`;
        const fileName = 'Delete With Character.jsonl';
        const chatDirectory = path.join(directories.chats, owner);
        fs.writeFileSync(path.join(directories.characters, avatarFileName), 'avatar');
        fs.mkdirSync(chatDirectory, { recursive: true });
        fs.writeFileSync(path.join(chatDirectory, fileName), createChatData('delete me'));
        const recoveryTarget = createCharacterChatTarget({
            chatsDirectory: directories.chats,
            backupDirectory: directories.backups,
            owner,
            filename: fileName,
        });
        writeLatestChatSnapshot(recoveryTarget, createChatData('snapshot'));
        markChatDeleted(recoveryTarget);
        const recoveryPaths = getChatRecoveryPaths(recoveryTarget);

        const response = await postJson('/api/characters/delete', {
            avatar_url: avatarFileName,
            delete_chats: true,
        });

        expect(response.status).toBe(200);
        expect(fs.existsSync(recoveryPaths.latestPath)).toBe(false);
        expect(fs.existsSync(recoveryPaths.tombstonePath)).toBe(false);
        expect(recoveryPaths.quarantinePaths.every(filePath => !fs.existsSync(filePath))).toBe(true);
    });

    test('deletes a group and its chats when recovery storage is unavailable', async () => {
        const groupId = 'test-group';
        const chatId = 'Delete With Group';
        const groupPath = path.join(directories.groups, `${groupId}.json`);
        const chatPath = path.join(directories.groupChats, `${chatId}.jsonl`);
        fs.writeFileSync(groupPath, JSON.stringify({ id: groupId, chats: [chatId] }));
        fs.writeFileSync(chatPath, createChatData('delete me'));
        fs.writeFileSync(path.join(directories.backups, CHAT_RECOVERY_DIRECTORY), 'not a directory');
        const consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => {});

        const response = await postJson('/api/groups/delete', { id: groupId });

        expect(response.status).toBe(200);
        expect(fs.existsSync(groupPath)).toBe(false);
        expect(fs.existsSync(chatPath)).toBe(false);
        expect(consoleWarn).toHaveBeenCalledWith(
            'Failed to mark chat recovery state for deletion; continuing with group deletion.',
            expect.any(Error),
        );
    });

    test('clears recovery state after deleting a group and its chats', async () => {
        const groupId = 'test-group';
        const chatId = 'Delete With Group';
        const fileName = `${chatId}.jsonl`;
        fs.writeFileSync(
            path.join(directories.groups, `${groupId}.json`),
            JSON.stringify({ id: groupId, chats: [chatId] }),
        );
        fs.writeFileSync(path.join(directories.groupChats, fileName), createChatData('delete me'));
        const recoveryTarget = createGroupChatTarget({
            groupChatsDirectory: directories.groupChats,
            backupDirectory: directories.backups,
            filename: fileName,
        });
        writeLatestChatSnapshot(recoveryTarget, createChatData('snapshot'));
        markChatDeleted(recoveryTarget);
        const recoveryPaths = getChatRecoveryPaths(recoveryTarget);

        const response = await postJson('/api/groups/delete', { id: groupId });

        expect(response.status).toBe(200);
        expect(fs.existsSync(recoveryPaths.latestPath)).toBe(false);
        expect(fs.existsSync(recoveryPaths.tombstonePath)).toBe(false);
        expect(recoveryPaths.quarantinePaths.every(filePath => !fs.existsSync(filePath))).toBe(true);
    });

    function postJson(resource, body) {
        return fetch(`${baseUrl}${resource}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    }

    function createChatData(message) {
        return [
            JSON.stringify({ chat_metadata: {}, user_name: 'User', character_name: 'Character' }),
            JSON.stringify({ name: 'Character', mes: message }),
        ].join('\n');
    }

    function createChatPayload(integrity, message) {
        return [
            {
                chat_metadata: { integrity },
                user_name: 'unused',
                character_name: 'unused',
            },
            { name: 'Character', mes: message },
        ];
    }
});
