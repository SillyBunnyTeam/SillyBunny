import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, jest, test } from '@jest/globals';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));

describe('getListableGroupChatInfo', () => {
    test('returns a file name fallback for corrupted group chat files', async () => {
        const { getListableGroupChatInfo } = await import('../src/endpoints/chats.js');
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sillybunny-group-chat-info-'));
        const chatFile = path.join(tempDir, 'Workspace.jsonl');

        await fs.writeFile(chatFile, [
            JSON.stringify({ chat_metadata: {}, user_name: 'User', character_name: 'Bot' }),
            '{"name":"Bot","mes":"unfinished',
        ].join('\n'));

        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

        try {
            await expect(getListableGroupChatInfo(chatFile, 'Workspace')).resolves.toMatchObject({
                file_id: 'Workspace',
                file_name: 'Workspace.jsonl',
            });
        } finally {
            warnSpy.mockRestore();
        }
    });
});
