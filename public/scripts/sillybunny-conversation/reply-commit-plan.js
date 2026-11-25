/**
 * The commit plan of a queued conversation reply: what the server needs to write the reply into the chat when no page
 * is left to do it (`src/conversation-generation-commit.js`). The plan names the messages that the reply answers, by
 * the hash of their revision as this page holds them, so that the server refuses a reply whose question was edited or
 * deleted, as the page's own `validateTarget()` does. Nothing here reads the page, so a test can build any plan.
 */

import { GENERATION_COMMIT_PLAN_VERSION, hashCommitText, normalizeCommitPlan } from '../generation-commit-plan.js';
import { MAX_REPLY_TRIGGERS } from '../conversation-commit-plan.js';
import { getConversationMessageRevision } from './message-identity-utils.js';

const MAX_NAME_LENGTH = 120;
const FALLBACK_NAME = 'Character';

/** @returns {string} 16 hex characters, one per logical reply; both request routes of one reply carry the same one. */
export function createReplyToken() {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

const stampOf = message => ({ id: message.id, rev: hashCommitText(getConversationMessageRevision(message)) });

/**
 * @param {object} parts
 * @param {{ conversationId: string, chatId: string }} parts.address The chat that the reply is for.
 * @param {{ messageIds: string[], replyTarget: { messageId: string }|null }} parts.queueItem The queue item that asked for the reply.
 * @param {{ avatar: string, name: string }} parts.speaker Who writes the reply.
 * @param {string} parts.anchorAvatar The avatar that names the conversation.
 * @param {'profile'|'raw'} parts.route The request route that carries the plan.
 * @param {Record<string, any>[]} parts.messages The messages of the chat now.
 * @param {string[]} parts.round Avatars that speak after this reply.
 * @param {string} parts.token
 * @param {string} parts.pageId
 * @param {number} parts.now
 * @param {number} parts.roundStarted When the round began; the same for every member of one round.
 * @returns {import('../generation-commit-plan.js').GenerationCommitPlan|null} Null when the page must write the reply
 * itself: a message that it answers is not in the chat, or the plan is not one that the server accepts. A plan that
 * the server would drop is never returned, because a dropped plan leaves the reply to a page that may be gone.
 */
export function createConversationReplyPlan({ address, queueItem, speaker, anchorAvatar, route, messages, round, token, pageId, now, roundStarted }) {
    const byId = new Map(messages.map(message => [message?.id, message]));
    const triggers = queueItem.messageIds.map(id => byId.get(id));
    const targetMessage = queueItem.replyTarget ? byId.get(queueItem.replyTarget.messageId) : null;
    if (!triggers.every(Boolean) || (queueItem.replyTarget && !targetMessage)) {
        return null;
    }

    return normalizeCommitPlan({
        v: GENERATION_COMMIT_PLAN_VERSION,
        chat: { conversation: address.conversationId },
        file: address.chatId,
        kind: 'reply',
        index: messages.length,
        started: new Date(now).toISOString(),
        page: pageId,
        round,
        message: { name: String(speaker.name || FALLBACK_NAME).slice(0, MAX_NAME_LENGTH) },
        reply: {
            token,
            speaker: speaker.avatar,
            anchor: anchorAvatar,
            origin: 'reply',
            route,
            triggers: triggers.slice(-MAX_REPLY_TRIGGERS).map(stampOf),
            target: targetMessage ? stampOf(targetMessage) : null,
            needs_user: false,
            round_started: roundStarted,
        },
    });
}
