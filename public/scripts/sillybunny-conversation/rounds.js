/**
 * The rules of a group round: the members that answer one message of the user, one after another, each seeing the
 * reply before it. A round lives in memory while the page is open. For a page that closes in between, the last bubble
 * of each reply carries a marker (`extra.conversation_round`) that names the members still to speak, so that the next
 * page that opens the chat within 30 minutes carries on. Nothing here reads the page, so the rules run in a unit test.
 */

import { resolveConversationQueueTriggerMessages } from './send-queue-utils.js';

/** A round that began longer ago than this is not carried on by a page that opens the chat: the conversation moved on. */
export const ROUND_RESUME_WINDOW_MS = 30 * 60 * 1000;
/** How far ahead of this clock a round may have begun, for a device whose clock differs from the one that made the marker. */
const CLOCK_SKEW_MS = 60 * 1000;

/**
 * @param {object} round
 * @param {string[]} round.remaining Avatars that still have to speak after the reply that carries the marker.
 * @param {number} round.started Milliseconds since the epoch at which the round began; the same for every member.
 * @param {string[]} round.triggers Ids of the messages of the user that the round answers.
 * @returns {{ remaining: string[], started: number, triggers: string[] }}
 */
export function createRoundMarker({ remaining, started, triggers }) {
    return { remaining: [...remaining], started, triggers: [...triggers] };
}

function readMarker(value) {
    if (!value || typeof value !== 'object') {
        return null;
    }
    const { remaining, started, triggers } = value;
    const isNames = list => Array.isArray(list) && list.every(item => typeof item === 'string' && item);
    if (!isNames(remaining) || !remaining.length || !isNames(triggers) || !Number.isFinite(started)) {
        return null;
    }
    return createRoundMarker({ remaining, started, triggers });
}

/**
 * The round that a page that opens a chat should carry on. The marker is only read from the last message: a message
 * written after it means that the conversation went on, and a selfie that follows the last bubble hides it, which is a
 * round that is not resumed.
 * @param {Record<string, any>[]} messages The messages of the chat, after the replies of the server are landed.
 * @param {number} now
 * @returns {{ remaining: string[], started: number, triggers: string[] }|null}
 */
export function findRoundToResume(messages, now) {
    const last = messages.at(-1);
    const marker = readMarker(last?.extra?.conversation_round);
    if (!marker || marker.started > now + CLOCK_SKEW_MS || now - marker.started > ROUND_RESUME_WINDOW_MS) {
        return null;
    }
    const lastUser = [...messages].reverse().find(message => message?.role === 'user');
    return lastUser && marker.triggers.includes(lastUser.id) ? marker : null;
}

/**
 * Whether the member after the one that has just spoken is still wanted. The reply that is being written when the user
 * sends a message is allowed to finish; the members that have not started are dropped, and the new message starts a
 * round of its own through the queue.
 * @param {object} parts
 * @param {object} parts.queueItem The queue item that started the round.
 * @param {Record<string, any>[]} parts.messages The messages of the chat now.
 * @param {object[]} parts.queue The queue of replies that wait. A forced reply that names no new message is in it too.
 * @returns {boolean}
 */
export function roundMayContinue({ queueItem, messages, queue }) {
    const triggers = resolveConversationQueueTriggerMessages(queueItem, messages);
    if (!triggers) {
        return false;
    }
    if (triggers.length) {
        const lastTriggerIndex = messages.indexOf(triggers.at(-1));
        if (messages.slice(lastTriggerIndex + 1).some(message => message?.role === 'user')) {
            return false;
        }
    }
    return !queue.some(queued => queued.conversationKey === queueItem.conversationKey && queued.chatId === queueItem.chatId);
}

/**
 * The rounds that a page ran or resumed, by their start. A page carries a round on at most once, however often it
 * reads the chat again, and a page that ran a round itself never resumes it.
 */
export function createRoundMemory() {
    const seen = new Set();
    return Object.freeze({
        /** @param {number} started */
        note: started => void seen.add(started),
        /** @param {number} started */
        has: started => seen.has(started),
        clear: () => seen.clear(),
    });
}

/** The memory of this page. */
export const roundMemory = createRoundMemory();
