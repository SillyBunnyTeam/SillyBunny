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

    test('adopts returned integrity only for the active chat file', async () => {
        const scriptSource = await fs.readFile(fileURLToPath(new URL('../public/script.js', import.meta.url)), 'utf8');

        expect(scriptSource).toContain('const activeChatName = characters[this_chid]?.chat;');
        expect(scriptSource).toContain('const isActiveChatSave = fileName === activeChatName;');
        expect(scriptSource).toContain('if (isActiveChatSave && typeof responseData?.integrity === \'string\' && responseData.integrity)');
    });
});
