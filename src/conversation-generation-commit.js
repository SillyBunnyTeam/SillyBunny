/**
 * SillyBunny: the conversation-mode half of generation-commit.js. When no page is left to save a
 * conversation reply, the server appends it to the chat as one pending message: the speaker and
 * the raw text, marked `extra.server_generation.pending`. The next page that opens the chat splits
 * it into bubbles, resolves speaker prefixes and commands, and removes the mark.
 *
 * The validity rule is the one of the page's own send queue: the messages the reply answers must be
 * unchanged, and an explicit reply target must still be a message that can be replied to. Messages
 * that arrived after them do not matter, so a reply lands after a user message that was sent while
 * it was written. Two checks that the queue does not need are added here: a per-reply token, so
 * that a reply that landed once never lands again, and the speaker being a member still.
 */

import { hashCommitText } from '../public/scripts/generation-commit-plan.js';
import { getConversationMessageRevision } from '../public/scripts/sillybunny-conversation/message-identity-utils.js';
import { ConversationStoreError, readConversation, recordChatSummary } from './conversation-store.js';

/**
 * @typedef {import('../public/scripts/generation-commit-plan.js').GenerationCommitPlan} GenerationCommitPlan
 * @typedef {{ text: string, reasoning: string, swipes?: string[] }} GenerationReply
 * @typedef {{ id: string, finishedAt: Date }} GenerationCommitContext
 * @typedef {{ id: string, readThrough: string }} ChatEntry
 */

/**
 * @param {any} message Chat message
 * @returns {string} The hash that a plan carries for this message
 */
function getRevisionHash(message) {
    return hashCommitText(getConversationMessageRevision(message));
}

/**
 * @param {any} message Chat message
 * @returns {boolean}
 */
function isUserMessage(message) {
    return message?.is_user === true || message?.role === 'user';
}

/**
 * @param {any} message Chat message
 * @returns {boolean}
 */
function isSystemMessage(message) {
    return message?.is_system === true || message?.role === 'system';
}

/**
 * @param {any[]} messages Chat messages, without the header
 * @param {NonNullable<GenerationCommitPlan['reply']>} fields Reply fields of the plan
 * @returns {string|null} Why the reply may not land, or null
 */
function findRefusal(messages, fields) {
    const landed = messages.some(message => message?.extra?.reply_token === fields.token || message?.extra?.server_generation?.token === fields.token);
    if (landed) {
        return 'reply-landed';
    }

    const byId = new Map(messages.map(message => [message?.id, message]));
    if (fields.triggers.some(stamp => !byId.has(stamp.id) || getRevisionHash(byId.get(stamp.id)) !== stamp.rev)) {
        return 'trigger-changed';
    }

    const target = fields.target ? byId.get(fields.target.id) : null;
    if (fields.target && (!target || getRevisionHash(target) !== fields.target.rev || isUserMessage(target) || isSystemMessage(target))) {
        return 'target-changed';
    }

    if (fields.needs_user && !messages.some(isUserMessage)) {
        return 'no-user-message';
    }
    return null;
}

/**
 * The message id is made from the finish time and the start of the reply token, so that applying
 * the same reply twice builds the same message and the function stays pure.
 * @param {GenerationCommitPlan} plan Conversation plan
 * @param {GenerationReply} reply Reply
 * @param {GenerationCommitContext} context Commit context
 * @returns {object}
 */
function createPendingMessage(plan, reply, { id, finishedAt }) {
    const fields = /** @type {NonNullable<GenerationCommitPlan['reply']>} */ (plan.reply);
    const isMember = fields.speaker !== fields.anchor;
    const finishedMs = finishedAt.getTime();
    return {
        id: `${finishedMs}-${fields.token.slice(0, 8)}`,
        role: isMember ? 'member' : 'character',
        name: plan.message.name,
        is_user: false,
        is_system: false,
        mes: reply.text,
        send_date: finishedAt.toISOString(),
        created_at: finishedMs,
        extra: {
            ...(isMember ? { member_avatar: fields.speaker } : {}),
            reply_token: fields.token,
            server_generation: {
                id,
                kind: plan.kind,
                pending: true,
                token: fields.token,
                origin: fields.origin,
                route: fields.route,
                speaker: fields.speaker,
                anchor: fields.anchor,
                round: [...plan.round],
                round_started: fields.round_started,
                triggers: fields.triggers.map(stamp => stamp.id),
                target: fields.target?.id ?? null,
                ...(fields.reminder ? { reminder: fields.reminder } : {}),
            },
        },
    };
}

/**
 * Places a conversation reply into parsed chat records. Pure: returns new records or why it refused.
 * @param {object[]} records Chat file records, header first
 * @param {GenerationCommitPlan} plan Plan of a conversation reply
 * @param {GenerationReply} reply Reply
 * @param {GenerationCommitContext} context Commit context
 * @returns {{ records: object[] } | { reason: string }}
 */
export function applyConversationReply(records, plan, reply, context) {
    if (!String(reply?.text ?? '').trim()) {
        return { reason: 'empty-reply' };
    }
    const refusal = findRefusal(records.slice(1), /** @type {NonNullable<GenerationCommitPlan['reply']>} */ (plan.reply));
    if (refusal) {
        return { reason: refusal };
    }
    return { records: [...structuredClone(records), createPendingMessage(plan, reply, context)] };
}

/**
 * What the server must know before it opens the chat file: the conversation exists and lists the
 * chat, and the speaker is still one of its members. A chat file that no `chats[]` entry names is
 * never written.
 * @param {Parameters<typeof readConversation>[0]} user Owner of the generation
 * @param {GenerationCommitPlan} plan Plan of a conversation reply
 * @returns {{ entry: ChatEntry } | { reason: string }}
 */
export function checkConversationReplyTarget(user, plan) {
    let conversation;
    try {
        conversation = readConversation(user, /** @type {string} */ (plan.chat.conversation));
    } catch (error) {
        if (!(error instanceof ConversationStoreError)) {
            throw error;
        }
        return { reason: error.code === 'invalid_id' ? 'invalid-target' : 'missing' };
    }

    const entry = conversation.chats.find((/** @type {ChatEntry} */ chat) => chat.id === plan.file);
    if (!entry) {
        return { reason: 'missing' };
    }

    const speaker = /** @type {NonNullable<GenerationCommitPlan['reply']>} */ (plan.reply).speaker;
    const isMember = conversation.kind === 'group'
        ? conversation.characters.includes(speaker)
        : conversation.characters[0] === speaker || conversation.extras.includes(speaker);
    return isMember ? { entry } : { reason: 'speaker-gone' };
}

/**
 * Writes the index row of the chat that was just saved, so that the conversation list shows the
 * new preview and unread count without reading the file. `conversation.json` is not touched:
 * unread, preview and time all come from the chat file and the chat's read marker.
 * @param {Parameters<typeof readConversation>[0]} user Owner of the generation
 * @param {GenerationCommitPlan} plan Plan of a conversation reply
 * @param {ChatEntry} entry The chat's entry in `conversation.json`
 * @param {object[]} records The records that were saved
 * @param {string} integrity The slug that the save returned
 */
export function afterConversationCommit(user, plan, entry, records, integrity) {
    recordChatSummary(user, /** @type {string} */ (plan.chat.conversation), entry, records, integrity);
}
