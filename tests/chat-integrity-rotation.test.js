import fs from 'node:fs/promises';
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

        expect(backupFiles).toHaveLength(2);
        expect(forcedBackup).toEqual(expect.any(String));
        expect(postSaveBackup).toEqual(expect.any(String));
        await expect(fs.readFile(path.join(backupDir, forcedBackup), 'utf8')).resolves.toContain('original disk chat');
        await expect(fs.readFile(path.join(backupDir, postSaveBackup), 'utf8')).resolves.toContain('forced overwrite chat');
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

        expect(scriptSource).toContain('const activeChatName = characters[this_chid]?.chat;');
        expect(scriptSource).toContain('const isActiveChatSave = fileName === activeChatName;');
        expect(scriptSource).toContain('if (isActiveChatSave && typeof responseData?.integrity === \'string\' && responseData.integrity)');
    });

    test('queues chat saves and keeps forced overwrites inside the active queue task', async () => {
        const scriptSource = await fs.readFile(fileURLToPath(new URL('../public/script.js', import.meta.url)), 'utf8');

        expect(scriptSource).toContain('let chatSaveQueue = Promise.resolve();');
        expect(scriptSource).toContain('export function saveChat(...saveChatArguments)');
        expect(scriptSource).toContain('.then(() => saveChatImmediately(...saveChatArguments));');
        expect(scriptSource).toContain('async function saveChatImmediately');
        expect(scriptSource).toContain('return await saveChatImmediately({ chatName, withMetadata, mesId, force: true, chatData, throwOnError });');
    });
});
