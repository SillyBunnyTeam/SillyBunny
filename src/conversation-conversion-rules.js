/**
 * The two rules that decide what a group's chats become when the group is converted into the direct conversation of
 * its last member (plan S4). The migration of the old store (row 16 of the 1U table) and the live conversion in
 * `conversation-store.js` both apply them, so a group converted by either gets the same names and ids.
 */

import crypto from 'node:crypto';

import { createChatId, isChatId } from './conversation-paths.js';
import { MAX_NAME_LENGTH } from './conversation-schema.js';

export const DEFAULT_CHAT_NAME = 'Main';

function cleanName(value) {
    return String(value ?? '').replaceAll('\0', '').trim().slice(0, MAX_NAME_LENGTH);
}

/**
 * A chat that has no name of its own, or the default one, takes the name of its group; any other chat is named
 * `<group> - <chat>`. A group with no name leaves the chat names as they are.
 * @param {string} chatName
 * @param {string} groupName
 * @returns {string}
 */
export function nameChatAfterGroup(chatName, groupName) {
    const name = cleanName(chatName || DEFAULT_CHAT_NAME);
    const group = cleanName(groupName);
    if (!group) {
        return name;
    }
    return !name || name === DEFAULT_CHAT_NAME ? group : cleanName(`${group} - ${name}`);
}

/**
 * Chooses the id that a chat has in the conversation that takes it in. The id it had is kept when it is free; a taken
 * id gets `_2`, `_3` and so on, and an id that is not a valid chat id is replaced by one made from the time and a hash
 * of the old id.
 * @param {string} preferredId The id the chat had.
 * @param {number} createdAt Milliseconds since the epoch; part of a replacement id.
 * @param {Set<string>} used The ids that are taken. The chosen id is added.
 * @returns {string}
 */
export function chooseChatId(preferredId, createdAt, used) {
    const base = isChatId(preferredId)
        ? preferredId
        : createChatId(createdAt, crypto.createHash('sha1').update(String(preferredId)).digest('hex').slice(0, 6));
    let id = base;
    for (let suffix = 2; used.has(id); suffix++) {
        id = `${base.slice(0, 60)}_${suffix}`;
    }
    used.add(id);
    return id;
}
