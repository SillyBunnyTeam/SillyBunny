/* global globalThis */
/**
 * A throwaway user for the conversation store and its routes: the `directories` the server gives a request, made
 * of real folders in a temp root, so that saves go through the real `trySaveChat` and the real recovery store.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { conversationIndex } from '../../src/conversation-index.js';
import { setConfigFilePath } from '../../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../../default/config.yaml', import.meta.url)));

export const PERSONA = 'user-default.png';
export const PERSONA_TWO = 'persona-two.png';

let sandboxCount = 0;

/**
 * The sandbox root is also the data root, so that the conversation index (`_cache/conversations.sqlite`) lives in the
 * sandbox and goes with it. `cleanup()` closes the index first, because it keeps its database file open.
 *
 * The handle is unique per sandbox because the regular chat backups are throttled per handle and chat name for the
 * life of the process, so that two tests with one handle would see each other's throttle window.
 * @param {string} [handle]
 * @returns {{ user: { profile: { handle: string }, directories: Record<string, string> }, root: string, cleanup: () => void }}
 */
export function createSandboxUser(handle = `store-test-user-${++sandboxCount}`) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'sillybunny-conversation-store-'));
    const directories = {
        root,
        conversations: path.join(root, 'conversations'),
        backups: path.join(root, 'backups'),
        chats: path.join(root, 'chats'),
        groupChats: path.join(root, 'group chats'),
    };
    for (const directory of Object.values(directories)) {
        fs.mkdirSync(directory, { recursive: true });
    }
    const previousDataRoot = globalThis.DATA_ROOT;
    globalThis.DATA_ROOT = root;
    return {
        user: { profile: { handle }, directories },
        root,
        cleanup: () => {
            conversationIndex.close();
            globalThis.DATA_ROOT = previousDataRoot;
            fs.rmSync(root, { recursive: true, force: true });
        },
    };
}

/** The header line that a chat file starts with. */
export function header(metadata = {}) {
    return { chat_metadata: metadata, user_name: 'unused', character_name: 'unused' };
}

/**
 * @param {string} id Message id.
 * @param {string} text
 * @param {{ user?: boolean, system?: boolean, minute?: number }} [options]
 */
export function line(id, text, { user = false, system = false, minute = 0 } = {}) {
    const at = Date.UTC(2026, 0, 1, 0, minute, 0);
    return {
        id,
        name: user ? 'You' : 'Nova',
        is_user: user,
        is_system: system,
        role: system ? 'system' : user ? 'user' : 'character',
        send_date: new Date(at).toISOString(),
        created_at: at,
        mes: text,
        extra: {},
    };
}

/** A chat as the client sends it: the header, then `count` alternating lines from the character and the user. */
export function chat(count, { integrity, prefix = 'm' } = {}) {
    const records = [header(integrity ? { integrity } : {})];
    for (let index = 0; index < count; index++) {
        records.push(line(`${prefix}${index}`, `${prefix} text ${index}`, { user: index % 2 === 1, minute: index }));
    }
    return records;
}

export function listBackups(user, prefix = 'chat_') {
    return fs.readdirSync(user.directories.backups).filter(name => name.startsWith(prefix) && name.endsWith('.jsonl'));
}

export function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/** Smallest valid files for each image type the avatar route takes. */
export const IMAGES = Object.freeze({
    png: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24)]),
    jpeg: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(24)]),
    gif: Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(24)]),
    webp: Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x1a, 0, 0, 0]), Buffer.from('WEBP'), Buffer.alloc(24)]),
});
