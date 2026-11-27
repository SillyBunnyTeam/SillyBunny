/**
 * The messages of every conversation chat, in the shape that Data Maid reads, so that an image or a file that a
 * conversation names counts as in use.
 *
 * Data Maid knows only the two roleplay chat folders. A conversation chat sits in
 * `conversations/<conversationId>/chats/<chatId>.jsonl` and names its uploads in the same `extra.media` and
 * `extra.files`, so without this reader every upload of a conversation would be offered for deletion.
 *
 * The group avatar is not read here. It is `conversations/<conversationId>/avatar.<ext>`, inside the conversations
 * folder, and Data Maid lists nothing from that folder.
 */

import fs from 'node:fs';
import path from 'node:path';

import { CHATS_DIRECTORY_NAME, ConversationPathError, getChatFilePath, isChatId, isConversationId } from './conversation-paths.js';
import { tryParse } from './util.js';

const CHAT_FILE_EXTENSION = '.jsonl';

async function listEntries(directory) {
    try {
        return await fs.promises.readdir(directory, { withFileTypes: true });
    } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
            return [];
        }
        throw error;
    }
}

/**
 * A generated image ("selfie") is stored as `extra.image_url`, a field that roleplay chats do not have. Data Maid reads
 * `extra.media`, so the URL is added there on the copy that Data Maid gets. The chat file is not changed.
 * @param {any} record
 * @returns {any}
 */
function readGeneratedImageAsMedia(record) {
    const url = record?.extra?.image_url;
    if (typeof url !== 'string' || url === '') {
        return record;
    }
    const media = Array.isArray(record.extra.media) ? record.extra.media : [];
    return { ...record, extra: { ...record.extra, media: [...media, { url }] } };
}

async function readChatRecords(filePath) {
    const content = await fs.promises.readFile(filePath, 'utf8');
    return content.split('\n').map(tryParse).filter(Boolean).map(readGeneratedImageAsMedia);
}

/**
 * Reads every chat file of every conversation of a user.
 *
 * By default this never throws: a chat that cannot be read is logged and left out, as Data Maid does for a roleplay
 * chat. A caller that lists loose files from the result passes `strict`, because a chat that is left out makes the
 * files that only it names look loose. A read failure then rejects. A folder or file that does not exist, and a chat
 * that the path check refuses, count as empty.
 * @param {{ conversations?: string }} directories The user's directories.
 * @param {{ strict?: boolean }} [options] `strict` rethrows a read failure instead of logging it.
 * @returns {Promise<object[]>} The header and the messages of every chat file, one after the other. Empty for a user
 * without a conversations folder.
 */
export async function readConversationChatMessages(directories, options = {}) {
    const root = directories?.conversations;
    const records = [];
    if (typeof root !== 'string' || root === '') {
        return records;
    }

    try {
        for (const folder of await listEntries(root)) {
            if (!folder.isDirectory() || !isConversationId(folder.name)) {
                continue;
            }
            for (const file of await listEntries(path.join(root, folder.name, CHATS_DIRECTORY_NAME))) {
                const chatId = path.parse(file.name).name;
                if (!file.isFile() || path.extname(file.name) !== CHAT_FILE_EXTENSION || !isChatId(chatId)) {
                    continue;
                }
                try {
                    // The path check refuses a `chats` folder that is a link to a place outside the conversations folder.
                    records.push(...await readChatRecords(getChatFilePath(directories, folder.name, chatId)));
                } catch (error) {
                    if (error instanceof ConversationPathError) {
                        continue;
                    }
                    if (!options.strict) {
                        console.error(`[Data Maid] Error reading conversation chat ${folder.name}/${file.name}:`, error);
                    } else if (error?.code !== 'ENOENT') {
                        throw error;
                    }
                }
            }
        }
    } catch (error) {
        if (options.strict) {
            throw error;
        }
        console.error('[Data Maid] Error listing the conversation chats:', error);
    }
    return records;
}
