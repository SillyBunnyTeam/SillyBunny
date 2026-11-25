/**
 * What a character or a persona that goes away, or a character that is renamed, does to the conversations of a user
 * (plan S4). The routes of `characters.js` and `avatars.js` call these after their own work is done. They are the
 * seams of the conversation store into those upstream routes, so each one answers a count and never throws: the card or
 * the persona is already gone or renamed, and a conversation that could not be changed is logged and counted in
 * `failed`, not turned into a failure of that route.
 */

import fs from 'node:fs';

import { getChatFilePath } from './conversation-paths.js';
import {
    ConversationStoreError,
    deleteConversation,
    readCharacterState,
    removeMember,
    renameAvatarInConversation,
    renameCharacterState,
    scanConversations,
    updateCharacterState,
} from './conversation-store.js';
import { isSafeName } from './conversation-schema.js';
import { updateChatRecords } from './endpoints/chats.js';

function isName(value) {
    return typeof value === 'string' && isSafeName(value);
}

/** A user whose directory list has no conversations folder, such as a test harness, has nothing to clean. */
function hasConversationsFolder(user) {
    return typeof user?.directories?.conversations === 'string';
}

/** Runs `work` for each conversation, and counts what throws in `result.failed`. */
function forEachConversation(user, result, work) {
    let conversations;
    try {
        ({ conversations } = scanConversations(user));
    } catch (error) {
        console.error('Could not read the conversations.', error);
        result.failed++;
        return;
    }
    for (const conversation of conversations) {
        try {
            work(conversation);
        } catch (error) {
            console.error(`Could not update the conversation ${conversation.id}.`, error instanceof ConversationStoreError ? error.message : error);
            result.failed++;
        }
    }
}

/**
 * A character was deleted together with its chats: its direct conversations go, whatever the persona, and it leaves
 * every group. A group that falls to one member is converted into the direct conversation of that member, as when the
 * member is removed by hand. The character's routine and status are forgotten.
 * @param {{ profile: { handle: string }, directories: Record<string, string> }} user
 * @param {string} avatar The avatar file name of the card that was deleted.
 * @returns {{ deleted: number, removedFromGroups: number, converted: number, failed: number }}
 */
export function deleteConversationsOfCharacter(user, avatar) {
    const result = { deleted: 0, removedFromGroups: 0, converted: 0, failed: 0 };
    if (!isName(avatar) || !hasConversationsFolder(user)) {
        return result;
    }
    forEachConversation(user, result, (conversation) => {
        if (conversation.kind === 'direct' && conversation.characters[0] === avatar) {
            deleteConversation(user, conversation.id);
            result.deleted++;
        } else if (conversation.kind === 'group' && conversation.characters.includes(avatar)) {
            if (conversation.characters.length === 1) {
                deleteConversation(user, conversation.id);
                result.deleted++;
                return;
            }
            const { converted } = removeMember(user, conversation.id, avatar);
            result[converted ? 'converted' : 'removedFromGroups']++;
        }
    });
    try {
        if (readCharacterState(user).characters[avatar]) {
            updateCharacterState(user, avatar, { routine: null, statusOverride: null });
        }
    } catch (error) {
        console.error('Could not forget the state of a deleted character.', error);
        result.failed++;
    }
    return result;
}

/**
 * A persona was deleted: every conversation it had goes, direct and group. The backups of their chats stay.
 * @param {{ profile: { handle: string }, directories: Record<string, string> }} user
 * @param {string} personaId The avatar file name of the persona.
 * @returns {{ deleted: number, failed: number }}
 */
export function deleteConversationsOfPersona(user, personaId) {
    const result = { deleted: 0, failed: 0 };
    if (!isName(personaId) || !hasConversationsFolder(user)) {
        return result;
    }
    forEachConversation(user, result, (conversation) => {
        if (conversation.personaId === personaId) {
            deleteConversation(user, conversation.id);
            result.deleted++;
        }
    });
    return result;
}

/**
 * Rewrites who wrote a chat's lines. Only `extra.member_avatar`, and only when it is the whole old name, changes.
 * @returns {Promise<'saved'|'skipped'|'failed'>}
 */
async function renameLinesOfChat(user, conversationId, chatId, from, to) {
    const answer = await updateChatRecords(user, { conversationChat: { conversationId, chatId } }, (records) => {
        let changed = false;
        const next = records.map((record, index) => {
            if (index === 0 || record?.extra?.member_avatar !== from) {
                return record;
            }
            changed = true;
            return { ...record, extra: { ...record.extra, member_avatar: to } };
        });
        return changed ? { records: next } : null;
    });
    if (answer.status === 'conflict') {
        console.error(`The chat ${chatId} of the conversation ${conversationId} changed while a character was renamed, and kept the old name on its lines.`, answer.reason);
        return 'failed';
    }
    return answer.status === 'saved' ? 'saved' : 'skipped';
}

/**
 * A character was renamed: its avatar file name changes in the member and extra lists, the reminders and the state of
 * the conversations, and on the lines that it wrote. The lists go first, so that a failure part way leaves a group
 * with its members and, at worst, lines that show a default picture.
 *
 * Every chat of every conversation is looked at, because a member that left a group still has lines in it. A chat file
 * is read as bytes and parsed only when it holds the old name, so the cost is one read of every chat file, plus a
 * save, with its backups, of each chat that changes.
 * @param {{ profile: { handle: string }, directories: Record<string, string> }} user
 * @param {string} from The old avatar file name.
 * @param {string} to The new one.
 * @returns {Promise<{ conversations: number, chats: number, failed: number }>}
 */
export async function renameCharacterInConversations(user, from, to) {
    const result = { conversations: 0, chats: 0, failed: 0 };
    if (!isName(from) || !isName(to) || from === to || !hasConversationsFolder(user)) {
        return result;
    }
    try {
        renameCharacterState(user, from, to);
    } catch (error) {
        console.error('Could not move the state of a renamed character.', error);
        result.failed++;
    }
    const needle = Buffer.from(JSON.stringify(from).slice(1, -1));
    const chats = [];
    forEachConversation(user, result, (conversation) => {
        if (renameAvatarInConversation(user, conversation.id, from, to)) {
            result.conversations++;
        }
        chats.push(...conversation.chats.map(chat => ({ conversationId: conversation.id, chatId: chat.id })));
    });
    for (const { conversationId, chatId } of chats) {
        try {
            if (!(await chatFileHolds(user, conversationId, chatId, needle))) {
                continue;
            }
            const outcome = await renameLinesOfChat(user, conversationId, chatId, from, to);
            if (outcome === 'saved') {
                result.chats++;
            } else if (outcome === 'failed') {
                result.failed++;
            }
        } catch (error) {
            console.error(`Could not rename the character on the lines of the chat ${chatId} of ${conversationId}.`, error);
            result.failed++;
        }
    }
    return result;
}

async function chatFileHolds(user, conversationId, chatId, needle) {
    try {
        return (await fs.promises.readFile(getChatFilePath(user.directories, conversationId, chatId))).includes(needle);
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return false;
        }
        throw error;
    }
}
