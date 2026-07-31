import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from '@jest/globals';

async function readSource(relativePath) {
    return await fs.readFile(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
}

function getFunctionBody(source, start, end) {
    return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
}

describe('chat file hardening wiring', () => {
    test('uses pointer-only character rename persistence with rollback and exact reload checks', async () => {
        const source = await readSource('../public/script.js');
        const renameBody = getFunctionBody(
            source,
            'export async function renameGroupOrCharacterChat',
            'export async function renameChat',
        );

        expect(renameBody).toContain('await updateRemoteChatName(characterId, actualNewFileName);');
        expect(renameBody).not.toContain('createOrEditCharacter');
        expect(renameBody).toContain('await sendRenameRequest(rollbackBody);');
        expect(renameBody).toContain('wasActiveTarget && isStillActiveTarget');
        expect(renameBody).toContain('newFileName: `${actualNewFileName}.jsonl`');
    });

    test('does not turn strict character load failures into fresh greetings', async () => {
        const source = await readSource('../public/script.js');
        const getChatBody = getFunctionBody(
            source,
            'export async function getChat',
            'async function getChatResult',
        );

        expect(getChatBody).toContain('allow_create: resolvedChat.created');
        expect(getChatBody).toContain('return false;');
        expect(getChatBody.match(/getChatResult/g)).toHaveLength(1);
    });

    test('connects exact recovery to save, load, rename, and intentional deletion routes', async () => {
        const [source, characterSource, groupSource] = await Promise.all([
            readSource('../src/endpoints/chats.js'),
            readSource('../src/endpoints/characters.js'),
            readSource('../src/endpoints/groups.js'),
        ]);

        expect(source).toContain('writeLatestChatSnapshot(recoveryTarget, persistedChatData);');
        expect(source).toContain('loadActiveChatWithRecovery(target)');
        expect(source).toContain('rekeyChatRecoveryState(sourceRecoveryTarget, destinationRecoveryTarget)');
        expect(source).toContain('markChatDeleted(recoveryTarget)');
        expect(source).toContain('clearChatRecoveryState(recoveryTarget)');
        expect(source).toContain('maxRecoveryStates: maxTotalChatBackups');
        expect(characterSource).toContain('maxRecoveryStates: maxTotalChatBackups');
        expect(groupSource).toContain('maxRecoveryStates: maxTotalChatBackups');
    });

    test('uses the full chat list area while browsing backups', async () => {
        const [source, styles] = await Promise.all([
            readSource('../public/scripts/chat-backups.js'),
            readSource('../public/css/chat-backups.css'),
        ]);

        expect(source).toContain('classList.add(\'chatBackupsOpen\')');
        expect(source).toContain('classList.remove(\'chatBackupsOpen\')');
        expect(styles).toContain('#select_chat_popup.chatBackupsOpen .chatBackupsList');
        expect(styles).toContain('max-height: none;');
        expect(styles).toContain('#select_chat_div)');
    });

    test('renders backup content inline without opening a nested WebKit modal', async () => {
        const [source, styles] = await Promise.all([
            readSource('../public/scripts/chat-backups.js'),
            readSource('../public/css/chat-backups.css'),
        ]);
        const previewBody = getFunctionBody(source, 'function createBackupPreview', 'class BackupsBrowser');

        expect(previewBody).toContain('document.createElement(\'section\')');
        expect(previewBody).toContain('document.createElement(\'pre\')');
        expect(previewBody).not.toContain('document.createElement(\'textarea\')');
        expect(previewBody).toContain('preview.classList.add(\'chatBackupPreview\'');
        expect(source).toContain('this.#backupsListElement.replaceChildren(preview);');
        expect(source).not.toContain('callGenericPopup(preview');
        expect(styles).toContain('.chatBackupPreview');
        expect(styles).toContain('position: -webkit-sticky;');
    });
});
