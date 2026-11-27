/**
 * The pin of a message, and the events that the timeline draws for the pins, as pure rules. Nothing here reads the page.
 *
 * A pin is `extra.conversation_pinned`, a boolean, which is what every earlier build wrote and read. The time of the pin
 * is a second key beside it, `extra.conversation_pinned_at`, in milliseconds. It is a second key and not a `{ at }` object
 * in the first one so that `Boolean(extra.conversation_pinned)` stays the whole test for a pin, in the code that has it
 * and in a build that does not know the time. A pin without a time is an old pin: it has its mark and its place in the
 * Pinned page, and no event.
 *
 * The event is not a record of the chat. It is worked out from the pinned messages each time the timeline is drawn, so
 * nothing that reads the records (prompt, unread count, preview, send queue, the server's replies) can meet it.
 */

import { isPendingServerReply } from './pending-reply.js';

export const PIN_FIELD = 'conversation_pinned';
export const PIN_TIME_FIELD = 'conversation_pinned_at';

const MAX_TIMESTAMP = 8_640_000_000_000_000;

/** @param {any} message */
export function isPinned(message) {
    return Boolean(message?.extra?.[PIN_FIELD]);
}

function isTime(value) {
    return Number.isSafeInteger(value) && value > 0 && value <= MAX_TIMESTAMP;
}

/**
 * @param {any} message
 * @returns {number} The time of the pin in milliseconds, or zero for a message that is not pinned and for an old pin.
 */
export function readPinnedAt(message) {
    if (!isPinned(message)) {
        return 0;
    }
    const at = message.extra[PIN_TIME_FIELD];
    return isTime(at) ? at : 0;
}

/**
 * Pins or unpins a message. The extra is replaced and not edited, as every writer of the extra of a message does, so
 * that a copy that something keeps does not change under it. Unpinning writes the boolean as `false`, as before, and
 * takes the time away; a time left behind would make a later pin look older than it is.
 * @param {any} message
 * @param {boolean} pinned
 * @param {{ at?: number }} [options] The time of the pin. Not given: now. Zero: none, which is how an old pin is written back.
 * @returns {{ pinned: boolean, at: number }} What the message had before, for an undo.
 */
export function setMessagePin(message, pinned, { at = Date.now() } = {}) {
    if (!message || typeof message !== 'object') {
        return { pinned: false, at: 0 };
    }
    const before = { pinned: isPinned(message), at: readPinnedAt(message) };
    const extra = { ...message.extra };
    delete extra[PIN_TIME_FIELD];
    extra[PIN_FIELD] = Boolean(pinned);
    if (pinned && isTime(at)) {
        extra[PIN_TIME_FIELD] = at;
    }
    message.extra = extra;
    return before;
}

/**
 * Whether the Pinned page has anything to list. A reply that the server wrote and no page has taken yet is not shown, so
 * it is not counted either.
 * @param {any[]|undefined} messages
 */
export function hasPinnedMessage(messages) {
    return Array.isArray(messages) && messages.some(message => isPinned(message) && !isPendingServerReply(message));
}

/**
 * @typedef {object} PinEvent
 * @property {string} messageId The pinned message.
 * @property {number} at The time of the pin.
 * @property {string} afterMessageId The message that the line follows.
 */

/**
 * Where the lines for the pins fall. The line of a pin follows the last message that is not newer than the pin, and
 * never comes before the pinned message itself, so a message that was sent after the pin stays after its line, and a
 * line does not move when more messages come. A message with no time ends the search: where the pin falls beyond it
 * cannot be known, and a line next to the message it is about is the safe place. Pins with no time give no event.
 * @param {any[]|undefined} messages The messages of the timeline, in order.
 * @param {(message: any) => number} timeOf The time of a message in milliseconds, zero when it has none.
 * @returns {PinEvent[]} In the order of the timeline, and within one place in the order that the messages were pinned.
 */
export function getPinEvents(messages, timeOf) {
    const list = Array.isArray(messages) ? messages : [];
    const placed = [];
    list.forEach((message, index) => {
        const at = readPinnedAt(message);
        if (!at || !message.id) {
            return;
        }
        let last = index;
        for (let next = list[last + 1]; next?.id; next = list[last + 1]) {
            const time = timeOf(next);
            if (!(time > 0 && time <= at)) {
                break;
            }
            last++;
        }
        placed.push({ position: last, event: { messageId: String(message.id), at, afterMessageId: String(list[last].id) } });
    });
    return placed.sort((left, right) => left.position - right.position || left.event.at - right.event.at).map(item => item.event);
}
