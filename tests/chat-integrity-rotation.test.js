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

        await fs.writeFile(chatFile, chatWithIntegrity('valid-integrity', 'same chat').map(JSON.stringify).join('\n'));
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

    test('warns on suspicious shrink but still preserves the existing chat', async () => {
        const { trySaveChat } = await import('../src/endpoints/chats.js');
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sillybunny-chat-integrity-shrink-'));
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
            false,
            'test-user',
            'Test Card',
            backupDir,
        );

        const backupFiles = await fs.readdir(backupDir);
        const preWriteBackup = backupFiles.find(fileName => fileName.startsWith('chat_pre_write_test_card_'));

        expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining('Suspicious chat shrink'));
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
        expect(scriptSource).toContain('return await saveChatImmediately({ chatName, withMetadata, metadataSnapshot: metadata, mesId, force: true, chatData, throwOnError, deferBackup, activeChatName, characterName, avatarUrl, wasGroupChat });');
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
        expect(groupChatSource).toContain('return await saveGroupChatImmediately({ groupId, shouldSaveGroup, force: true, throwOnError, chatId, chatData: chatMessages, metadata: metadataForSave, deferBackup });');
        expect(groupChatSource).toContain('const isActiveGroupChatSave = selected_group === groupId && group.chat_id === chatId;');
        expect(groupChatSource).toContain('if (isActiveGroupChatSave && typeof responseData?.integrity === \'string\' && responseData.integrity)');
    });
});
