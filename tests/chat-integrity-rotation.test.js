import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));

function chatWithIntegrity(integrity, message) {
    return [
        {
            chat_metadata: { integrity },
            user_name: 'unused',
            character_name: 'unused',
        },
        {
            name: 'User',
            is_user: true,
            send_date: '2026-06-06T00:00:00.000Z',
            mes: message,
        },
    ];
}

function chatWithMessages(integrity, messages) {
    return [
        {
            chat_metadata: { integrity },
            user_name: 'unused',
            character_name: 'unused',
        },
        ...messages.map((message, index) => ({
            name: index % 2 === 0 ? 'User' : 'Assistant',
            is_user: index % 2 === 0,
            send_date: `2026-06-06T00:00:${String(index).padStart(2, '0')}.000Z`,
            mes: message,
        })),
    ];
}

function noncanonicalChat(integrity) {
    const payload = chatWithIntegrity(integrity, 'café');
    payload[0].chat_metadata.layout = { alpha: 1, beta: 2 };

    return {
        payload,
        serialized: `\r\n{ "unknown_header": true, "character_name": "Original", "chat_metadata": { "layout": { "beta": 2, "alpha": 1 }, "integrity": ${JSON.stringify(integrity)} }, "user_name": "Original" }\r\n\r\n{"mes":"caf\\u00e9","send_date":"2026-06-06T00:00:00.000Z","is_user":true,"name":"User"}\r\n`,
    };
}

async function readHeader(filePath) {
    const content = await fs.readFile(filePath, 'utf8');
    return JSON.parse(content.split('\n')[0]);
}

describe('chat integrity rotation', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.runOnlyPendingTimers();
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    test('rotates integrity on save and rejects stale second writers', async () => {
        const { trySaveChat } = await import('../src/endpoints/chats.js');
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sillybunny-chat-integrity-'));
        const chatFile = path.join(tempDir, 'chat.jsonl');
        const backupDir = path.join(tempDir, 'backups');
        await fs.mkdir(backupDir);

        const sharedIntegrity = 'shared-integrity';
        await fs.writeFile(chatFile, chatWithIntegrity(sharedIntegrity, 'original').map(JSON.stringify).join('\n'));

        const firstResult = await trySaveChat(
            chatWithIntegrity(sharedIntegrity, 'device one'),
            chatFile,
            false,
            'test-user',
            'Test Card',
            backupDir,
        );

        expect(firstResult?.integrity).toEqual(expect.any(String));
        expect(firstResult.integrity).not.toBe(sharedIntegrity);
        await expect(readHeader(chatFile)).resolves.toMatchObject({
            chat_metadata: { integrity: firstResult.integrity },
        });

        await expect(trySaveChat(
            chatWithIntegrity(sharedIntegrity, 'stale device two'),
            chatFile,
            false,
            'test-user',
            'Test Card',
            backupDir,
        )).rejects.toThrow(/integrity/i);
    });

    test('keeps forced-overwrite safety backup distinct from the same-second post-save backup', async () => {
        const { trySaveChat } = await import('../src/endpoints/chats.js');
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sillybunny-chat-integrity-force-'));
        const chatFile = path.join(tempDir, 'chat.jsonl');
        const backupDir = path.join(tempDir, 'backups');
        await fs.mkdir(backupDir);
        jest.setSystemTime(new Date('2026-06-06T12:34:56.000Z'));

        await fs.writeFile(chatFile, chatWithIntegrity('old-integrity', 'original disk chat').map(JSON.stringify).join('\n'));
        await trySaveChat(
            chatWithIntegrity('ignored-forced-integrity', 'forced overwrite chat'),
            chatFile,
            true,
            'forced-overwrite-user',
            'Test Card',
            backupDir,
        );

        const backupFiles = await fs.readdir(backupDir);
        const forcedBackup = backupFiles.find(fileName => fileName.startsWith('chat_forced_overwrite_test_card_'));
        const postSaveBackup = backupFiles.find(fileName => fileName.startsWith('chat_test_card_'));

        expect(backupFiles).toHaveLength(3);
        expect(forcedBackup).toEqual(expect.any(String));
        expect(postSaveBackup).toEqual(expect.any(String));
        expect(backupFiles.some(fileName => fileName.startsWith('chat_pre_write_test_card_'))).toBe(true);
        await expect(fs.readFile(path.join(backupDir, forcedBackup), 'utf8')).resolves.toContain('original disk chat');
        await expect(fs.readFile(path.join(backupDir, postSaveBackup), 'utf8')).resolves.toContain('forced overwrite chat');
    });

    test('creates a pre-write backup before every valid overwrite', async () => {
        const { trySaveChat } = await import('../src/endpoints/chats.js');
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sillybunny-chat-integrity-prewrite-'));
        const chatFile = path.join(tempDir, 'chat.jsonl');
        const backupDir = path.join(tempDir, 'backups');
        await fs.mkdir(backupDir);

        const originalContent = chatWithIntegrity('valid-integrity', 'original disk chat').map(JSON.stringify).join('\n');
        await fs.writeFile(chatFile, originalContent);

        await trySaveChat(
            chatWithIntegrity('valid-integrity', 'new disk chat'),
            chatFile,
            false,
            'test-user',
            'Test Card',
            backupDir,
        );

        const backupFiles = await fs.readdir(backupDir);
        const preWriteBackup = backupFiles.find(fileName => fileName.startsWith('chat_pre_write_test_card_'));

        expect(preWriteBackup).toEqual(expect.any(String));
        await expect(fs.readFile(path.join(backupDir, preWriteBackup), 'utf8')).resolves.toBe(originalContent);
    });

    test('skips duplicate post-save backups when only chat integrity changes', async () => {
        const { trySaveChat } = await import('../src/endpoints/chats.js');
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sillybunny-chat-integrity-duplicate-backup-'));
        const chatFile = path.join(tempDir, 'chat.jsonl');
        const backupDir = path.join(tempDir, 'backups');
        await fs.mkdir(backupDir);
        jest.setSystemTime(new Date('2026-06-06T12:34:56.000Z'));

        // The seeded chat differs from the first save so that save writes for real. The second save
        // repeats its content and only rotates the slug, which is the duplicate this test is about.
        await fs.writeFile(chatFile, chatWithIntegrity('valid-integrity', 'seeded chat').map(JSON.stringify).join('\n'));
        const firstResult = await trySaveChat(
            chatWithIntegrity('valid-integrity', 'same chat'),
            chatFile,
            false,
            'duplicate-backup-user',
            'Test Card',
            backupDir,
        );
        await trySaveChat(
            chatWithIntegrity(firstResult.integrity, 'same chat'),
            chatFile,
            false,
            'duplicate-backup-user',
            'Test Card',
            backupDir,
        );
        jest.runOnlyPendingTimers();

        const backupFiles = await fs.readdir(backupDir);
        const postSaveBackups = backupFiles.filter(fileName => fileName.startsWith('chat_test_card_'));
        const preWriteBackups = backupFiles.filter(fileName => fileName.startsWith('chat_pre_write_test_card_'));

        expect(postSaveBackups).toHaveLength(1);
        expect(preWriteBackups).toHaveLength(1);
    });

    test('skips duplicate pre-write backups when on-disk content is unchanged', async () => {
        const { trySaveChat } = await import('../src/endpoints/chats.js');
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sillybunny-chat-integrity-prewrite-dedup-'));
        const chatFile = path.join(tempDir, 'chat.jsonl');
        const backupDir = path.join(tempDir, 'backups');
        await fs.mkdir(backupDir);
        jest.setSystemTime(new Date('2026-06-06T12:34:56.000Z'));

        await fs.writeFile(chatFile, chatWithIntegrity('original-integrity', 'original content').map(JSON.stringify).join('\n'));

        const firstResult = await trySaveChat(
            chatWithIntegrity('original-integrity', 'original content'),
            chatFile,
            false,
            'prewrite-dedup-user',
            'Test Card',
            backupDir,
        );

        const secondResult = await trySaveChat(
            chatWithIntegrity(firstResult.integrity, 'different content'),
            chatFile,
            false,
            'prewrite-dedup-user',
            'Test Card',
            backupDir,
        );

        await trySaveChat(
            chatWithIntegrity(secondResult.integrity, 'final content'),
            chatFile,
            false,
            'prewrite-dedup-user',
            'Test Card',
            backupDir,
        );

        const backupFiles = await fs.readdir(backupDir);
        const preWriteBackups = backupFiles.filter(fileName => fileName.startsWith('chat_pre_write_test_card_'));

        expect(preWriteBackups).toHaveLength(2);
    });

    test('defers regular chat backups until a final non-deferred save', async () => {
        const { trySaveChat } = await import('../src/endpoints/chats.js');
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sillybunny-chat-integrity-defer-backup-'));
        const chatFile = path.join(tempDir, 'chat.jsonl');
        const backupDir = path.join(tempDir, 'backups');
        await fs.mkdir(backupDir);
        jest.setSystemTime(new Date('2026-06-06T12:34:56.000Z'));

        await fs.writeFile(chatFile, chatWithIntegrity('valid-integrity', 'original disk chat').map(JSON.stringify).join('\n'));
        const firstResult = await trySaveChat(
            chatWithIntegrity('valid-integrity', 'agent pass one'),
            chatFile,
            false,
            'deferred-backup-user',
            'Test Card',
            backupDir,
            { deferBackup: true },
        );
        const secondResult = await trySaveChat(
            chatWithIntegrity(firstResult.integrity, 'agent pass two'),
            chatFile,
            false,
            'deferred-backup-user',
            'Test Card',
            backupDir,
            { deferBackup: true },
        );
        const finalResult = await trySaveChat(
            chatWithIntegrity(secondResult.integrity, 'final post-processed chat'),
            chatFile,
            false,
            'deferred-backup-user',
            'Test Card',
            backupDir,
        );
        expect(finalResult?.integrity).toEqual(expect.any(String));
        jest.runOnlyPendingTimers();

        const backupFiles = await fs.readdir(backupDir);
        const postSaveBackups = backupFiles.filter(fileName => fileName.startsWith('chat_test_card_'));
        const preWriteBackups = backupFiles.filter(fileName => fileName.startsWith('chat_pre_write_test_card_'));

        expect(postSaveBackups).toHaveLength(1);
        expect(preWriteBackups).toHaveLength(3);
        await expect(fs.readFile(path.join(backupDir, postSaveBackups[0]), 'utf8')).resolves.toContain('final post-processed chat');
    });

    test('leaves a semantically unchanged noncanonical chat untouched and returns its disk integrity', async () => {
        const { trySaveChat } = await import('../src/endpoints/chats.js');
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sillybunny-chat-unchanged-save-'));
        const chatFile = path.join(tempDir, 'chat.jsonl');
        const backupDir = path.join(tempDir, 'backups');
        await fs.mkdir(backupDir);

        const { payload, serialized } = noncanonicalChat('disk-integrity');
        await fs.writeFile(chatFile, serialized);
        const before = await fs.stat(chatFile);

        const result = await trySaveChat(
            payload,
            chatFile,
            false,
            'unchanged-save-user',
            'Test Card',
            backupDir,
        );
        jest.runOnlyPendingTimers();
        const after = await fs.stat(chatFile);

        expect(result).toEqual({ integrity: 'disk-integrity' });
        await expect(fs.readFile(chatFile, 'utf8')).resolves.toBe(serialized);
        // Writes rename a temp file over the target, so a surviving inode proves nothing was written.
        expect(after.ino).toBe(before.ino);
        expect(after.mtimeMs).toBe(before.mtimeMs);
        expect(after.birthtimeMs).toBe(before.birthtimeMs);

        const backupFiles = await fs.readdir(backupDir);
        expect(backupFiles.filter(fileName => fileName.startsWith('chat_pre_write_test_card_'))).toHaveLength(0);
    });

    test('preserves an existing chat file identity during a genuine shorter save', async () => {
        const { trySaveChat } = await import('../src/endpoints/chats.js');
        const { createCharacterChatTarget } = await import('../src/chat-recovery.js');
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sillybunny-chat-identity-save-'));
        const chatsDirectory = path.join(tempDir, 'chats');
        const backupDir = path.join(tempDir, 'backups');
        const owner = 'Test Card';
        const fileName = 'chat.jsonl';
        const chatFile = path.join(chatsDirectory, owner, fileName);
        await fs.mkdir(path.dirname(chatFile), { recursive: true });
        await fs.mkdir(backupDir);
        const recoveryTarget = createCharacterChatTarget({ chatsDirectory, backupDirectory: backupDir, owner, filename: fileName });

        const oldIntegrity = 'existing-integrity';
        const onDisk = chatWithIntegrity(oldIntegrity, 'a much longer message that must be truncated completely').map(JSON.stringify).join('\n');
        await fs.writeFile(chatFile, onDisk);
        const before = await fs.stat(chatFile);

        const result = await trySaveChat(
            chatWithIntegrity(oldIntegrity, 'short'),
            chatFile,
            false,
            'identity-save-user',
            'Test Card',
            backupDir,
            { deferBackup: true, recoveryTarget },
        );
        const after = await fs.stat(chatFile);
        const saved = await fs.readFile(chatFile, 'utf8');

        expect(result.integrity).toEqual(expect.any(String));
        expect(result.integrity).not.toBe(oldIntegrity);
        expect(after.ino).toBe(before.ino);
        expect(after.birthtimeMs).toBe(before.birthtimeMs);
        expect(after.size).toBeLessThan(before.size);
        expect(saved).toContain('"mes":"short"');
        expect(saved).not.toContain('truncated completely');
        expect((await readHeader(chatFile)).chat_metadata.integrity).toBe(result.integrity);

        const preWriteBackups = (await fs.readdir(backupDir)).filter(fileName => fileName.startsWith('chat_pre_write_test_card_'));
        expect(preWriteBackups).toHaveLength(1);
        await expect(fs.readFile(path.join(backupDir, preWriteBackups[0]), 'utf8')).resolves.toBe(onDisk);
    });

    test('recovers the complete new chat after an interrupted identity-preserving write', async () => {
        const { trySaveChat } = await import('../src/endpoints/chats.js');
        const { createCharacterChatTarget, getChatRecoveryPaths, loadActiveChatWithRecovery } = await import('../src/chat-recovery.js');
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sillybunny-chat-interrupted-save-'));
        const chatsDirectory = path.join(tempDir, 'chats');
        const backupDir = path.join(tempDir, 'backups');
        const owner = 'Test Card';
        const fileName = 'chat.jsonl';
        const chatFile = path.join(chatsDirectory, owner, fileName);
        await fs.mkdir(path.dirname(chatFile), { recursive: true });
        await fs.mkdir(backupDir);
        const recoveryTarget = createCharacterChatTarget({ chatsDirectory, backupDirectory: backupDir, owner, filename: fileName });
        await fs.writeFile(chatFile, chatWithIntegrity('existing-integrity', 'before').map(JSON.stringify).join('\n'));
        const truncateSpy = jest.spyOn(fsSync, 'ftruncateSync').mockImplementationOnce(() => {
            throw Object.assign(new Error('I/O failure'), { code: 'EIO' });
        });

        await expect(trySaveChat(
            chatWithIntegrity('existing-integrity', 'complete new chat'),
            chatFile,
            false,
            'interrupted-save-user',
            owner,
            backupDir,
            { deferBackup: true, recoveryTarget },
        )).rejects.toThrow('I/O failure');
        const interrupted = await fs.readFile(chatFile, 'utf8');
        expect(() => JSON.parse(interrupted.split('\n')[0])).toThrow();
        const expectedSnapshot = await fs.readFile(getChatRecoveryPaths(recoveryTarget).latestPath, 'utf8');

        truncateSpy.mockRestore();
        const recovered = loadActiveChatWithRecovery(recoveryTarget);
        expect(recovered.recovered).toBe(true);
        expect(recovered.records[1].mes).toBe('complete new chat');
        await expect(fs.readFile(chatFile, 'utf8')).resolves.toBe(expectedSnapshot);
    });

    test('keeps a concurrent writer valid after an unchanged save', async () => {
        const { trySaveChat } = await import('../src/endpoints/chats.js');
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sillybunny-chat-unchanged-cas-'));
        const chatFile = path.join(tempDir, 'chat.jsonl');
        const backupDir = path.join(tempDir, 'backups');
        await fs.mkdir(backupDir);

        await fs.writeFile(chatFile, chatWithIntegrity('shared-integrity', 'shared chat').map(JSON.stringify).join('\n'));

        // Both tabs hold 'shared-integrity'. The first saves nothing, so the second must still be valid.
        const noopResult = await trySaveChat(
            chatWithIntegrity('shared-integrity', 'shared chat'),
            chatFile,
            false,
            'cas-user',
            'Test Card',
            backupDir,
        );
        expect(noopResult).toEqual({ integrity: 'shared-integrity' });

        const editResult = await trySaveChat(
            chatWithIntegrity('shared-integrity', 'edited by the second tab'),
            chatFile,
            false,
            'cas-user',
            'Test Card',
            backupDir,
        );
        expect(editResult.integrity).toEqual(expect.any(String));
        expect(editResult.integrity).not.toBe('shared-integrity');

        // The first tab is stale now that the content really changed.
        await expect(trySaveChat(
            chatWithIntegrity('shared-integrity', 'edited by the first tab'),
            chatFile,
            false,
            'cas-user',
            'Test Card',
            backupDir,
        )).rejects.toThrow(/integrity/i);
    });

    test('still rejects a stale writer whose payload matches the file', async () => {
        const { trySaveChat } = await import('../src/endpoints/chats.js');
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sillybunny-chat-unchanged-stale-'));
        const chatFile = path.join(tempDir, 'chat.jsonl');
        const backupDir = path.join(tempDir, 'backups');
        await fs.mkdir(backupDir);

        const { payload, serialized } = noncanonicalChat('current-integrity');
        payload[0].chat_metadata.integrity = 'stale-integrity';
        await fs.writeFile(chatFile, serialized);

        // The integrity check runs before the content comparison, so identical content cannot bypass it.
        await expect(trySaveChat(
            payload,
            chatFile,
            false,
            'stale-writer-user',
            'Test Card',
            backupDir,
        )).rejects.toThrow(/integrity/i);
    });

    test('still rejects a stale writer when the existing chat body is corrupt', async () => {
        const { trySaveChat } = await import('../src/endpoints/chats.js');
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sillybunny-chat-corrupt-stale-'));
        const chatFile = path.join(tempDir, 'chat.jsonl');
        const backupDir = path.join(tempDir, 'backups');
        await fs.mkdir(backupDir);

        const header = chatWithIntegrity('current-integrity', 'unused')[0];
        const onDisk = `\r\n${JSON.stringify(header)}\r\n{"truncated":`;
        await fs.writeFile(chatFile, onDisk);

        await expect(trySaveChat(
            chatWithIntegrity('stale-integrity', 'replacement'),
            chatFile,
            false,
            'corrupt-stale-user',
            'Test Card',
            backupDir,
        )).rejects.toThrow(/integrity/i);

        await expect(fs.readFile(chatFile, 'utf8')).resolves.toBe(onDisk);
        await expect(fs.readdir(backupDir)).resolves.toHaveLength(0);
    });

    test('still rejects a stale writer when the existing chat starts with a byte-order mark', async () => {
        const { trySaveChat } = await import('../src/endpoints/chats.js');
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sillybunny-chat-bom-stale-'));
        const chatFile = path.join(tempDir, 'chat.jsonl');
        const backupDir = path.join(tempDir, 'backups');
        await fs.mkdir(backupDir);

        const onDisk = `\uFEFF${chatWithIntegrity('current-integrity', 'current chat').map(JSON.stringify).join('\r\n')}`;
        await fs.writeFile(chatFile, onDisk);

        await expect(trySaveChat(
            chatWithIntegrity('stale-integrity', 'replacement'),
            chatFile,
            false,
            'bom-stale-user',
            'Test Card',
            backupDir,
        )).rejects.toThrow(/integrity/i);

        await expect(fs.readFile(chatFile, 'utf8')).resolves.toBe(onDisk);
        await expect(fs.readdir(backupDir)).resolves.toHaveLength(0);
    });

    test('skips a forced overwrite that would rewrite identical content', async () => {
        const { trySaveChat } = await import('../src/endpoints/chats.js');
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sillybunny-chat-unchanged-forced-'));
        const chatFile = path.join(tempDir, 'chat.jsonl');
        const backupDir = path.join(tempDir, 'backups');
        await fs.mkdir(backupDir);

        const onDisk = chatWithIntegrity('disk-integrity', 'forced but identical').map(JSON.stringify).join('\n');
        await fs.writeFile(chatFile, onDisk);
        const before = await fs.stat(chatFile);

        const result = await trySaveChat(
            chatWithIntegrity('stale-integrity', 'forced but identical'),
            chatFile,
            true,
            'forced-unchanged-user',
            'Test Card',
            backupDir,
        );
        jest.runOnlyPendingTimers();
        const after = await fs.stat(chatFile);

        // Forcing an overwrite of the same bytes only costs the file its identity, so it is skipped
        // and the forcing client is resynced with the slug that is really on disk.
        expect(result).toEqual({ integrity: 'disk-integrity' });
        expect(after.ino).toBe(before.ino);
        await expect(fs.readFile(chatFile, 'utf8')).resolves.toBe(onDisk);

        const backupFiles = await fs.readdir(backupDir);
        expect(backupFiles.filter(fileName => fileName.startsWith('chat_forced_overwrite_test_card_'))).toHaveLength(0);
        expect(backupFiles.filter(fileName => fileName.startsWith('chat_pre_write_test_card_'))).toHaveLength(0);
    });

    test('keeps an unchanged legacy chat slugless until its first genuine edit', async () => {
        const { trySaveChat } = await import('../src/endpoints/chats.js');
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sillybunny-chat-unchanged-legacy-'));
        const chatFile = path.join(tempDir, 'chat.jsonl');
        const backupDir = path.join(tempDir, 'backups');
        await fs.mkdir(backupDir);

        const payload = chatWithIntegrity(undefined, 'legacy chat');
        const onDisk = `\n${JSON.stringify({ name: 'Legacy Chat', unknown_header: true })}\r\n${JSON.stringify(payload[1])}\r\n`;
        await fs.writeFile(chatFile, onDisk);
        const before = await fs.stat(chatFile);

        const result = await trySaveChat(
            payload,
            chatFile,
            false,
            'legacy-chat-user',
            'Test Card',
            backupDir,
            { deferBackup: true },
        );
        const after = await fs.stat(chatFile);

        expect(result).toEqual({ integrity: '' });
        await expect(fs.readFile(chatFile, 'utf8')).resolves.toBe(onDisk);
        expect(after.ino).toBe(before.ino);
        expect(after.mtimeMs).toBe(before.mtimeMs);
        expect(after.birthtimeMs).toBe(before.birthtimeMs);
        expect(await fs.readdir(backupDir)).toHaveLength(0);

        const editResult = await trySaveChat(
            chatWithIntegrity(undefined, 'edited legacy chat'),
            chatFile,
            false,
            'legacy-chat-user',
            'Test Card',
            backupDir,
            { deferBackup: true },
        );

        expect(editResult.integrity).toEqual(expect.any(String));
        expect((await readHeader(chatFile)).chat_metadata.integrity).toBe(editResult.integrity);
    });

    test('keeps the regular backup when a deferred session ends on an unchanged save', async () => {
        const { trySaveChat } = await import('../src/endpoints/chats.js');
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sillybunny-chat-unchanged-deferred-'));
        const chatFile = path.join(tempDir, 'chat.jsonl');
        const backupDir = path.join(tempDir, 'backups');
        await fs.mkdir(backupDir);
        jest.setSystemTime(new Date('2026-06-06T12:34:56.000Z'));

        await fs.writeFile(chatFile, chatWithIntegrity('valid-integrity', 'before the run').map(JSON.stringify).join('\n'));

        const deferredResult = await trySaveChat(
            chatWithIntegrity('valid-integrity', 'agent run output'),
            chatFile,
            false,
            'deferred-unchanged-user',
            'Test Card',
            backupDir,
            { deferBackup: true },
        );

        // The run closes with a non-deferred save of content it already wrote. Skipping the backup
        // there would leave the whole run with none.
        const finalResult = await trySaveChat(
            chatWithIntegrity(deferredResult.integrity, 'agent run output'),
            chatFile,
            false,
            'deferred-unchanged-user',
            'Test Card',
            backupDir,
        );
        expect(finalResult).toEqual({ integrity: deferredResult.integrity });
        jest.runOnlyPendingTimers();

        const backupFiles = await fs.readdir(backupDir);
        const postSaveBackups = backupFiles.filter(fileName => fileName.startsWith('chat_test_card_'));
        expect(postSaveBackups).toHaveLength(1);
        await expect(fs.readFile(path.join(backupDir, postSaveBackups[0]), 'utf8')).resolves.toContain('agent run output');
    });

    test('refreshes exact recovery snapshots for deferred saves and restores missing active files', async () => {
        const { trySaveChat } = await import('../src/endpoints/chats.js');
        const { createCharacterChatTarget, getChatRecoveryPaths, loadActiveChatWithRecovery } = await import('../src/chat-recovery.js');
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sillybunny-chat-recovery-save-'));
        const chatsDirectory = path.join(tempDir, 'chats');
        const backupDirectory = path.join(tempDir, 'backups');
        const owner = 'Test Card';
        const fileName = 'Session.jsonl';
        const chatDirectory = path.join(chatsDirectory, owner);
        const chatFile = path.join(chatDirectory, fileName);
        await fs.mkdir(chatDirectory, { recursive: true });
        await fs.mkdir(backupDirectory);

        const recoveryTarget = createCharacterChatTarget({ chatsDirectory, backupDirectory, owner, filename: fileName });
        await trySaveChat(
            chatWithIntegrity('initial-integrity', 'deferred recovery data'),
            chatFile,
            true,
            'recovery-user',
            owner,
            backupDirectory,
            { deferBackup: true, recoveryTarget },
        );

        const { latestPath } = getChatRecoveryPaths(recoveryTarget);
        await expect(fs.readFile(latestPath, 'utf8')).resolves.toContain('deferred recovery data');
        await fs.unlink(chatFile);

        const restored = loadActiveChatWithRecovery(recoveryTarget);
        expect(restored).toMatchObject({ status: 'ok', recovered: true });
        await expect(fs.readFile(chatFile, 'utf8')).resolves.toContain('deferred recovery data');
    });

    test('saves valid chats when the exact recovery directory is unavailable', async () => {
        const { trySaveChat } = await import('../src/endpoints/chats.js');
        const { CHAT_RECOVERY_DIRECTORY, createCharacterChatTarget } = await import('../src/chat-recovery.js');
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sillybunny-chat-recovery-unavailable-'));
        const chatsDirectory = path.join(tempDir, 'chats');
        const backupDirectory = path.join(tempDir, 'backups');
        const owner = 'Test Card';
        const fileName = 'Session.jsonl';
        const chatDirectory = path.join(chatsDirectory, owner);
        const chatFile = path.join(chatDirectory, fileName);
        await fs.mkdir(chatDirectory, { recursive: true });
        await fs.mkdir(backupDirectory);
        await fs.writeFile(path.join(backupDirectory, CHAT_RECOVERY_DIRECTORY), 'not a directory');
        const consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const recoveryTarget = createCharacterChatTarget({ chatsDirectory, backupDirectory, owner, filename: fileName });

        await expect(trySaveChat(
            chatWithIntegrity('initial-integrity', 'saved without recovery'),
            chatFile,
            true,
            'recovery-user',
            owner,
            backupDirectory,
            { deferBackup: true, recoveryTarget },
        )).resolves.toEqual({ integrity: expect.any(String) });

        await expect(fs.readFile(chatFile, 'utf8')).resolves.toContain('saved without recovery');
        expect(consoleWarn).toHaveBeenCalledWith(
            'Failed to write the exact chat recovery snapshot; continuing with the active chat save.',
            expect.any(Error),
        );
    });

    test('exposes default-off backup diagnostic logging for chat and settings backups', async () => {
        const configSource = await fs.readFile(fileURLToPath(new URL('../default/config.yaml', import.meta.url)), 'utf8');
        const chatsSource = await fs.readFile(fileURLToPath(new URL('../src/endpoints/chats.js', import.meta.url)), 'utf8');
        const settingsSource = await fs.readFile(fileURLToPath(new URL('../src/endpoints/settings.js', import.meta.url)), 'utf8');

        expect(configSource).toContain('logging: false');
        expect(chatsSource).toContain('const isBackupLoggingEnabled = !!getConfigValue(\'backups.chat.logging\', false, \'boolean\');');
        expect(chatsSource).toContain('console.info(color.cyan(`[Backup] ${action}${fields ? ` ${fields}` : \'\'}`));');
        expect(chatsSource).toContain('chat-backup-written');
        expect(chatsSource).toContain('chat-backup-skipped');
        expect(chatsSource).toContain('chat-save-written');
        expect(chatsSource).toContain('reason: \'deferred\'');
        expect(chatsSource).toContain('reason: \'duplicate\'');
        expect(settingsSource).toContain('settings-autosave-requested');
        expect(settingsSource).toContain('settings-autosave-fired');
        expect(settingsSource).toContain('settings-backup-written');
        expect(settingsSource).toContain('settings-backup-skipped');
    });

    test('keeps distinct pre-write backups for rapid overwrites in the same second', async () => {
        const { trySaveChat } = await import('../src/endpoints/chats.js');
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sillybunny-chat-integrity-prewrite-rapid-'));
        const chatFile = path.join(tempDir, 'chat.jsonl');
        const backupDir = path.join(tempDir, 'backups');
        await fs.mkdir(backupDir);
        jest.setSystemTime(new Date('2026-06-06T12:34:56.000Z'));

        await fs.writeFile(chatFile, chatWithIntegrity('valid-integrity', 'original disk chat').map(JSON.stringify).join('\n'));
        const firstResult = await trySaveChat(
            chatWithIntegrity('valid-integrity', 'first replacement'),
            chatFile,
            false,
            'test-user',
            'Test Card',
            backupDir,
        );
        const secondResult = await trySaveChat(
            chatWithIntegrity(firstResult.integrity, 'second replacement'),
            chatFile,
            false,
            'test-user',
            'Test Card',
            backupDir,
        );
        await trySaveChat(
            chatWithIntegrity(secondResult.integrity, 'third replacement'),
            chatFile,
            false,
            'test-user',
            'Test Card',
            backupDir,
        );

        const backupFiles = await fs.readdir(backupDir);
        const preWriteBackups = backupFiles.filter(fileName => fileName.startsWith('chat_pre_write_test_card_'));

        expect(new Set(preWriteBackups).size).toBe(3);
        expect(preWriteBackups).toHaveLength(3);
    });

    test('rejects a suspicious shrink without overwriting the existing chat', async () => {
        const { trySaveChat } = await import('../src/endpoints/chats.js');
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sillybunny-chat-integrity-shrink-'));
        const chatFile = path.join(tempDir, 'chat.jsonl');
        const backupDir = path.join(tempDir, 'backups');
        await fs.mkdir(backupDir);

        const originalChat = chatWithMessages('valid-integrity', ['one', 'two', 'three', 'four', 'five', 'six']);
        const originalContent = originalChat.map(JSON.stringify).join('\n');
        await fs.writeFile(chatFile, originalContent);

        await expect(trySaveChat(
            chatWithIntegrity('valid-integrity', 'short replacement'),
            chatFile,
            false,
            'test-user',
            'Test Card',
            backupDir,
        )).rejects.toMatchObject({ reason: 'shrink' });

        await expect(fs.readFile(chatFile, 'utf8')).resolves.toBe(originalContent);

        // A rejected save must not spend a slot in the pre-write ring that holds the last good state.
        const backupFiles = await fs.readdir(backupDir);
        expect(backupFiles.filter(fileName => fileName.startsWith('chat_pre_write_test_card_'))).toHaveLength(0);
    });

    test('still overwrites a shrunken chat when the client forces the save', async () => {
        const { trySaveChat } = await import('../src/endpoints/chats.js');
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sillybunny-chat-integrity-shrink-forced-'));
        const chatFile = path.join(tempDir, 'chat.jsonl');
        const backupDir = path.join(tempDir, 'backups');
        await fs.mkdir(backupDir);
        const consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => {});

        const originalChat = chatWithMessages('valid-integrity', ['one', 'two', 'three', 'four', 'five', 'six']);
        const originalContent = originalChat.map(JSON.stringify).join('\n');
        await fs.writeFile(chatFile, originalContent);

        await trySaveChat(
            chatWithIntegrity('valid-integrity', 'short replacement'),
            chatFile,
            true,
            'test-user',
            'Test Card',
            backupDir,
        );

        const backupFiles = await fs.readdir(backupDir);
        const preWriteBackup = backupFiles.find(fileName => fileName.startsWith('chat_pre_write_test_card_'));

        expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining('Forced destructive chat save'));
        expect(preWriteBackup).toEqual(expect.any(String));
        await expect(fs.readFile(path.join(backupDir, preWriteBackup), 'utf8')).resolves.toBe(originalContent);

        consoleWarn.mockRestore();
    });

    test('rejects invalid save payloads without overwriting an existing chat', async () => {
        const { trySaveChat } = await import('../src/endpoints/chats.js');
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sillybunny-chat-integrity-invalid-'));
        const chatFile = path.join(tempDir, 'chat.jsonl');
        const backupDir = path.join(tempDir, 'backups');
        await fs.mkdir(backupDir);

        const originalContent = chatWithIntegrity('valid-integrity', 'original disk chat').map(JSON.stringify).join('\n');
        await fs.writeFile(chatFile, originalContent);

        await expect(trySaveChat(
            [],
            chatFile,
            false,
            'test-user',
            'Test Card',
            backupDir,
        )).rejects.toThrow(/invalid chat save payload/i);
        await expect(fs.readFile(chatFile, 'utf8')).resolves.toBe(originalContent);

        await expect(trySaveChat(
            [{ user_name: 'unused', character_name: 'unused' }],
            chatFile,
            false,
            'test-user',
            'Test Card',
            backupDir,
        )).rejects.toThrow(/invalid chat save payload/i);
        await expect(fs.readFile(chatFile, 'utf8')).resolves.toBe(originalContent);
    });

    test('adopts returned integrity only for the active chat file', async () => {
        const scriptSource = await fs.readFile(fileURLToPath(new URL('../public/script.js', import.meta.url)), 'utf8');

        expect(scriptSource).toContain('const currentActiveChatName = characters[this_chid]?.chat;');
        expect(scriptSource).toContain('const isActiveChatSave = fileName === currentActiveChatName;');
        expect(scriptSource).toContain('if (isActiveChatSave && typeof responseData?.integrity === \'string\' && responseData.integrity)');
    });

    test('queues chat saves and keeps forced overwrites inside the active queue task', async () => {
        const scriptSource = await fs.readFile(fileURLToPath(new URL('../public/script.js', import.meta.url)), 'utf8');

        expect(scriptSource).toContain('let chatSaveQueue = Promise.resolve();');
        expect(scriptSource).toContain('export function saveChat(...saveChatArguments)');
        expect(scriptSource).toContain('const metadataSnapshot = structuredClone({ ...chat_metadata, ...(options.withMetadata || {}) });');
        expect(scriptSource).toContain('const chatData = cloneChatSavePayload(sourceChatData);');
        expect(scriptSource).toContain('activeChatName: activeCharacter?.chat');
        expect(scriptSource).toContain('characterName: activeCharacter?.name');
        expect(scriptSource).toContain('avatarUrl: activeCharacter?.avatar');
        expect(scriptSource).toContain('wasGroupChat: Boolean(selected_group)');
        expect(scriptSource).toContain('setChatSaveActive(true);');
        expect(scriptSource).toContain('.then(() => saveChatImmediately(...queuedSaveArguments))');
        expect(scriptSource).toContain('.finally(() => setChatSaveActive(false));');
        expect(scriptSource).toContain('async function saveChatImmediately');
        expect(scriptSource).toContain('applyQueuedChatIntegrity(metadata, integrityKey, isActiveChatSave);');
        expect(scriptSource).toContain('rememberQueuedChatIntegrity(integrityKey, responseData?.integrity);');
        expect(scriptSource).toContain('deferBackup: Boolean(deferBackup)');
        expect(scriptSource).toContain('return await saveChatImmediately({ chatName, withMetadata, metadataSnapshot: metadata, mesId, force: true, chatData, throwOnError, deferBackup, allowShrink, activeChatName, characterName, avatarUrl, wasGroupChat });');
    });

    test('debounced chat saves abort after the active chat generation changes', async () => {
        const guardSource = await fs.readFile(fileURLToPath(new URL('../public/scripts/chat-save-guard.js', import.meta.url)), 'utf8');
        const scriptSource = await fs.readFile(fileURLToPath(new URL('../public/script.js', import.meta.url)), 'utf8');

        expect(scriptSource).toContain('let chatGeneration = 0;');
        expect(scriptSource).toContain('export function incrementChatGeneration()');
        expect(scriptSource).toContain('const generation = chatGeneration;');
        expect(scriptSource).toContain('scheduledGeneration: generation');
        expect(scriptSource).toContain('currentGeneration: chatGeneration');
        expect(guardSource).toContain('scheduledGeneration !== currentGeneration');
    });

    test('saveChatConditional delegates ordering to the save queues instead of dropping slow saves', async () => {
        const scriptSource = await fs.readFile(fileURLToPath(new URL('../public/script.js', import.meta.url)), 'utf8');
        const saveConditionalBody = scriptSource.slice(
            scriptSource.indexOf('export async function saveChatConditional(options = {})'),
            scriptSource.indexOf('export async function importCharacterChat', scriptSource.indexOf('export async function saveChatConditional(options = {})')),
        );

        expect(saveConditionalBody).not.toContain('waitUntilCondition(() => !isChatSaving');
        expect(saveConditionalBody).toContain('await saveChat(options);');
        expect(saveConditionalBody).toContain('await saveGroupChat(selected_group, true, false, false, options);');
        expect(scriptSource).toContain('let chatSaveActivityCount = 0;');
        expect(scriptSource).toContain('function setChatSaveActive(isActive)');
        expect(scriptSource).toContain('isChatSaving = chatSaveActivityCount > 0;');
    });

    test('queues group chat saves and keeps forced overwrites inside the active queue task', async () => {
        const groupChatSource = await fs.readFile(fileURLToPath(new URL('../public/scripts/group-chats.js', import.meta.url)), 'utf8');

        expect(groupChatSource).toContain('let groupChatSaveQueue = Promise.resolve();');
        expect(groupChatSource).toContain('function saveGroupChat(groupId, shouldSaveGroup, force = false, throwOnError = false, options = {})');
        expect(groupChatSource).toContain('const chatSnapshot = cloneGroupChatSavePayload(chat);');
        expect(groupChatSource).toContain('const metadataSnapshot = structuredClone(chat_metadata);');
        expect(groupChatSource).toContain('.then(() => saveGroupChatImmediately({');
        expect(groupChatSource).toContain('applyQueuedGroupChatIntegrity(metadataForSave, chatId, isActiveGroupChatSave);');
        expect(groupChatSource).toContain('rememberQueuedGroupChatIntegrity(chatId, responseData?.integrity);');
        expect(groupChatSource).toContain('deferBackup: Boolean(options.deferBackup)');
        expect(groupChatSource).toContain('return await saveGroupChatImmediately({ groupId, shouldSaveGroup, force: true, throwOnError, chatId, chatData: chatMessages, metadata: metadataForSave, deferBackup, allowShrink });');
        expect(groupChatSource).toContain('const isActiveGroupChatSave = selected_group === groupId && group.chat_id === chatId;');
        expect(groupChatSource).toContain('if (isActiveGroupChatSave && typeof responseData?.integrity === \'string\' && responseData.integrity)');
    });

    test('retries group chat load requests after stale CSRF before integrity metadata is initialized', async () => {
        const groupChatSource = await fs.readFile(fileURLToPath(new URL('../public/scripts/group-chats.js', import.meta.url)), 'utf8');
        const loadGroupChatBody = groupChatSource.slice(
            groupChatSource.indexOf('async function loadGroupChat(chatId, allowCreate = false)'),
            groupChatSource.indexOf('/**\n * Checks whether a group chat file currently exists on the server.'),
        );
        const groupChatExistsBody = groupChatSource.slice(
            groupChatSource.indexOf('async function groupChatExists(chatId)'),
            groupChatSource.indexOf('/**\n * Validates a group by checking if all members exist'),
        );

        expect(loadGroupChatBody).toContain('fetchWithCsrfRetry(\'/api/chats/group/get\'');
        expect(loadGroupChatBody).toContain('{ refreshCsrfToken }');
        expect(groupChatExistsBody).toContain('fetchWithCsrfRetry(\'/api/chats/group/info\'');
        expect(groupChatExistsBody).toContain('{ refreshCsrfToken }');
    });
});
