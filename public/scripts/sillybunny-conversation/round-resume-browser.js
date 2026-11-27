/**
 * The round resumer of this page (`round-resume.js`) on the conversation data module and the send queue, and the hook
 * that runs it for every chat that the data module reads from the server, after the replies that the server wrote into
 * that chat are landed as bubbles.
 */

import { enqueueConversationReply } from './send-queue.js';
import { getConversationPersonaId } from './context.js';
import { conversationData } from './conversation-data-browser.js';
import { getCharacterForAvatar } from './media.js';
import { finalizePendingReplies } from './reply-finalizer-browser.js';
import { findLandedRoundToResume } from './reply-steps.js';
import { createRoundResumer } from './round-resume.js';
import { roundMayContinue, roundMemory } from './rounds.js';
import { createConversationMessageRevisionEntries, createConversationQueueItem, createConversationQueueReplyTarget } from './send-queue-utils.js';
import { sendQueue } from './state.js';

const LOCK_PREFIX = 'sb-conversation-round';
const MAX_HOLD_MS = 10 * 60 * 1000;

const getAnchor = view => view.characters.find(avatar => getCharacterForAvatar(avatar)) ?? view.characters[0] ?? '';
const hasQueuedReply = (view, chatId) => sendQueue.some(item => item.conversationKey === view.id && item.chatId === chatId);

const resumer = createRoundResumer({
    data: conversationData,
    enqueue: enqueueConversationReply,
    getPersonaId: () => getConversationPersonaId(),
    getAnchor,
    hasQueuedReply,
});

async function carryOnLandedRound(view, address, round, messages) {
    const triggerMessages = round.triggers.map(id => messages.find(message => message.id === id));
    if (!triggerMessages.every(Boolean)) {
        return false;
    }
    const item = createConversationQueueItem({
        avatar: getAnchor(view),
        chatId: address.chatId,
        coalesced: true,
        createdAt: Date.now(),
        groupId: view.id,
        messageIds: round.triggers,
        messageRevisions: createConversationMessageRevisionEntries(triggerMessages),
        personaId: view.personaId,
        replyTarget: createConversationQueueReplyTarget(triggerMessages, messages),
        round: { remaining: round.remaining, started: round.started },
        conversationKey: view.id,
        text: triggerMessages.at(-1).mes ?? '',
    });
    if (!roundMayContinue({ queueItem: item, messages, queue: sendQueue })) {
        return false;
    }
    let timer = null;
    await Promise.race([enqueueConversationReply(item), new Promise((resolve) => {
        timer = setTimeout(resolve, MAX_HOLD_MS);
    })]);
    clearTimeout(timer);
    return true;
}

/**
 * Fallback for a server-committed reaction-only turn (no bubbles), where no bubble existed to hold `conversation_round`.
 * @param {{ conversationId: string, chatId: string }} address
 * @param {import('./reply-finalizer.js').LandedReply[]} landed
 */
async function resumeReactionOnlyRound(address, landed) {
    const view = conversationData.get(address.conversationId);
    const messages = conversationData.chat(address)?.messages;
    if (!view || view.kind !== 'group' || !messages || view.personaId !== getConversationPersonaId()) {
        return false;
    }
    const round = findLandedRoundToResume(landed, messages, Date.now());
    if (!round || roundMemory.has(round.started) || hasQueuedReply(view, address.chatId)) {
        return false;
    }
    roundMemory.note(round.started);

    const locks = globalThis.navigator?.locks;
    if (typeof locks?.request !== 'function') {
        return carryOnLandedRound(view, address, round, messages);
    }
    let carried = false;
    try {
        await locks.request(`${LOCK_PREFIX}:${address.conversationId}:${address.chatId}`, { ifAvailable: true }, async (lock) => {
            if (lock) {
                carried = await carryOnLandedRound(view, address, round, messages);
            }
        });
    } catch (error) {
        if (error?.name !== 'SecurityError') {
            throw error;
        }
        return carryOnLandedRound(view, address, round, messages);
    }
    return carried;
}

let installed = false;

/**
 * Carries on a cut-off group round for every chat that the data module reads from the server. A round that the
 * server's reply ended in the middle of is found only after that reply is landed, so the hook lands it first.
 * Runs once.
 */
export function installRoundResume() {
    if (installed) {
        return;
    }
    installed = true;
    conversationData.onChatRead((address) => {
        finalizePendingReplies(address)
            .then(async (landed) => {
                if (await resumer.resume(address)) {
                    return;
                }
                await resumeReactionOnlyRound(address, landed);
            })
            .catch(error => console.warn('Conversation Mode: a group round could not be carried on', error));
    });
}
