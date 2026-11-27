/**
 * Carries on a group round that was cut off. A reply ends in a marker (`extra.conversation_round`) that names the
 * members still to speak. The next page that has the chat loaded within 30 minutes of the start of the round queues
 * those members, as a reply of its own, so that the user who closed the tab in the middle of a round finds the whole
 * round when they come back. Whatever belongs to the page comes in through the arguments, so that tests run two pages
 * on one server.
 */

import { findRoundToResume, roundMemory } from './rounds.js';
import { createConversationMessageRevisionEntries, createConversationQueueItem, createConversationQueueReplyTarget } from './send-queue-utils.js';

const LOCK_PREFIX = 'sb-conversation-round';
/** The lock is let go after this long even if the queue never reports the reply as done (a reply that the user deleted). */
const MAX_HOLD_MS = 10 * 60 * 1000;

/**
 * @param {object} parts
 * @param {ReturnType<typeof import('./conversation-data.js').createConversationData>} parts.data
 * @param {(queueItem: object) => Promise<void>} parts.enqueue Puts the item in the send queue; resolves when the queue has processed it.
 * @param {() => ({ request: Function }|undefined)} [parts.getLocks] `navigator.locks`, read at each use.
 * @param {() => number} [parts.now]
 * @param {() => string} parts.getPersonaId The persona of this page. A round is carried on only for the persona that is signed in.
 * @param {(view: Record<string, any>) => string} parts.getAnchor The avatar that names the conversation on this page.
 * @param {(view: Record<string, any>, chatId: string) => boolean} parts.hasQueuedReply Whether a reply for the chat waits in the send queue.
 * @param {ReturnType<typeof import('./rounds.js').createRoundMemory>} [parts.rounds] The rounds that this page ran or resumed.
 */
export function createRoundResumer({ data, enqueue, getLocks = () => globalThis.navigator?.locks, now = Date.now, getPersonaId, getAnchor, hasQueuedReply, rounds = roundMemory }) {
    /** Queues the rest of the round and waits for it. */
    async function carryOn(view, address, round, messages) {
        const triggerMessages = round.triggers.map(id => messages.find(message => message.id === id));
        if (!triggerMessages.every(Boolean)) {
            return false;
        }
        const item = createConversationQueueItem({
            avatar: getAnchor(view),
            chatId: address.chatId,
            coalesced: true,
            createdAt: now(),
            groupId: view.id,
            messageIds: round.triggers,
            messageRevisions: createConversationMessageRevisionEntries(triggerMessages),
            personaId: view.personaId,
            replyTarget: createConversationQueueReplyTarget(triggerMessages, messages),
            round: { remaining: round.remaining, started: round.started },
            conversationKey: view.id,
            text: triggerMessages.at(-1).mes ?? '',
        });
        let timer = null;
        await Promise.race([enqueue(item), new Promise((resolve) => {
            timer = setTimeout(resolve, MAX_HOLD_MS);
        })]);
        clearTimeout(timer);
        return true;
    }

    /**
     * @param {{ conversationId: string, chatId: string }} address A chat that is loaded, after its pending replies landed.
     * @returns {Promise<boolean>} Whether this call carried a round on.
     */
    async function resume(address) {
        const view = data.get(address.conversationId);
        const messages = data.chat(address)?.messages;
        if (!view || view.kind !== 'group' || !messages || view.personaId !== getPersonaId()) {
            return false;
        }
        const round = findRoundToResume(messages, now());
        if (!round || rounds.has(round.started) || hasQueuedReply(view, address.chatId)) {
            return false;
        }
        rounds.note(round.started);

        const locks = getLocks();
        if (typeof locks?.request !== 'function') {
            return carryOn(view, address, round, messages);
        }
        let carried = false;
        try {
            await locks.request(`${LOCK_PREFIX}:${address.conversationId}:${address.chatId}`, { ifAvailable: true }, async (lock) => {
                if (lock) {
                    carried = await carryOn(view, address, round, messages);
                }
            });
        } catch (error) {
            if (error?.name !== 'SecurityError') {
                throw error;
            }
            // A page with an opaque origin has the API and is refused every lock.
            return carryOn(view, address, round, messages);
        }
        return carried;
    }

    return Object.freeze({ resume });
}
