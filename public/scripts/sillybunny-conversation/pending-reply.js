/**
 * A reply that the server wrote into a conversation chat while no page took it waits there as one message, marked
 * `extra.server_generation.pending`, with the raw text of the model. The next page that loads the chat turns it into
 * bubbles (`reply-finalizer.js`). This file only reads the marker, and imports nothing, so that the readers that must
 * not show a pending message (the timeline, the prompt) can use it without loading the finalizer.
 *
 * @typedef {object} PendingReply
 * @property {string} generationId The id that the page acknowledges to the server.
 * @property {string} token One per logical reply; it is on every bubble that the reply becomes.
 * @property {string} origin `reply` for an answer to a message of the user.
 * @property {'profile'|'raw'} route The request route, which decides the clean-up of the text.
 * @property {string} speaker Avatar of the member that spoke.
 * @property {string} anchor Avatar that named the conversation when the reply was asked for.
 * @property {string[]} round Avatars still to speak after this reply.
 * @property {number} roundStarted Milliseconds since the epoch at which the round began.
 * @property {string[]} triggers Ids of the messages that the reply answers.
 * @property {string|null} target Id of the message that the user chose to reply to, if any.
 */

/** @param {any} message */
export function isPendingServerReply(message) {
    return message?.extra?.server_generation?.pending === true;
}

function readStrings(value) {
    return Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
}

function readString(value) {
    return typeof value === 'string' ? value : '';
}

/**
 * Parses the marker once, where the message comes in from the server, so that the code after it does not check each field again.
 * @param {any} message
 * @returns {PendingReply|null} Null when the message is not pending.
 */
export function readPendingReply(message) {
    if (!isPendingServerReply(message)) {
        return null;
    }

    const marker = message.extra.server_generation;
    const roundStarted = Number(marker.round_started);
    return {
        generationId: readString(marker.id),
        token: readString(marker.token) || readString(message.extra.reply_token),
        origin: readString(marker.origin) || 'reply',
        route: marker.route === 'raw' ? 'raw' : 'profile',
        speaker: readString(marker.speaker),
        anchor: readString(marker.anchor),
        round: readStrings(marker.round),
        roundStarted: Number.isFinite(roundStarted) ? roundStarted : 0,
        triggers: readStrings(marker.triggers),
        target: typeof marker.target === 'string' && marker.target ? marker.target : null,
    };
}
