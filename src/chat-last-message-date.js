import fs from 'node:fs';

import { tryParse } from './util.js';

const TAIL_CHUNK_BYTES = 64 * 1024;
// A last line above this size is not read, so that listing the chats of a character cannot hold a whole large file in memory.
const MAX_LAST_LINE_BYTES = 8 * 1024 * 1024;

/**
 * Reads the last line of an open file from its end, in the line breaks that `readline` knows (`\n`, `\r\n` and `\r`).
 * A trailing line break does not start a line of its own, as in `readline`.
 * @param {fs.promises.FileHandle} handle Open file
 * @param {number} size File size in bytes, above zero
 * @returns {Promise<string>} The last line, or an empty string when the file ends with a blank line or the line is too long
 */
async function readLastLine(handle, size) {
    for (let chunkBytes = TAIL_CHUNK_BYTES; ; chunkBytes *= 4) {
        const length = Math.min(chunkBytes, size, MAX_LAST_LINE_BYTES);
        const start = size - length;
        const buffer = Buffer.alloc(length);
        let filled = 0;
        while (filled < length) {
            const { bytesRead } = await handle.read(buffer, filled, length - filled, start + filled);
            if (bytesRead === 0) {
                break;
            }
            filled += bytesRead;
        }

        let end = filled;
        if (buffer[end - 1] === 0x0a) {
            end--;
            if (end > 0 && buffer[end - 1] === 0x0d) {
                end--;
            }
        } else if (buffer[end - 1] === 0x0d) {
            end--;
        }

        for (let index = end - 1; index >= 0; index--) {
            if (buffer[index] === 0x0a || buffer[index] === 0x0d) {
                return buffer.toString('utf8', index + 1, end);
            }
        }
        if (start === 0) {
            return buffer.toString('utf8', 0, end);
        }
        if (length >= MAX_LAST_LINE_BYTES) {
            return '';
        }
    }
}

/**
 * Gives the `last_mes` that the full chat listing (`getChatInfo()` in `src/endpoints/chats.js`) gives for a chat file, from the end of the file only.
 * Clients pick the newest chat by this value, so a listing that skips the full read must still give the date of the last message.
 * @param {string} filePath Path of the chat file
 * @returns {Promise<string | number>} The `send_date` of the last message, or an ISO date from the modification time when it has none, or the modification time in milliseconds when the last line is not a message
 */
export async function readChatLastMessageDate(filePath) {
    const handle = await fs.promises.open(filePath, 'r');
    try {
        const { size, mtimeMs } = await handle.stat();
        if (size === 0) {
            return mtimeMs;
        }
        const lastLine = await readLastLine(handle, size);
        const record = lastLine ? tryParse(lastLine) : undefined;
        if (record && (record.name || record.character_name || record.chat_metadata)) {
            return record.send_date || new Date(Math.round(mtimeMs)).toISOString();
        }
        return mtimeMs;
    } finally {
        await handle.close();
    }
}
