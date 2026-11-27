/**
 * What the talkativeness of a character card means for a conversation. The card holds one number `t` from 0 to 1 (the
 * slider of the character editor), and every formula below is equal to the behaviour of the mode before the card was
 * used, for the default value of 0.5. Nothing here reads the page.
 */

export const DEFAULT_CARD_TALKATIVENESS = 0.5;

/**
 * @param {unknown} value What the card holds: a number, a numeric string, or nothing.
 * @returns {number} From 0 to 1; the default for a value that is not a number. A card at 0 is a card at 0, not the default.
 */
export function parseTalkativeness(value) {
    if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) {
        return DEFAULT_CARD_TALKATIVENESS;
    }
    const number = Number(value);
    if (!Number.isFinite(number)) {
        return DEFAULT_CARD_TALKATIVENESS;
    }
    return Math.min(1, Math.max(0, number));
}

/** The weight of a group member in the draw of the next speaker is multiplied by this: a member at 0 speaks only when named. */
export function getSpeakerWeightFactor(t) {
    return 2 * t;
}

/** The chance that the member who spoke last answers a message that names nobody; otherwise the weighted draw decides. */
export function getFollowUpChance(t) {
    return Math.min(1, 2 * t);
}

/** The chance that the member who would join a round as its second speaker does. */
export function getSecondSpeakerChance(t) {
    return 0.6 * t;
}

/** The simulated typing time of a reply is multiplied by this. */
export function getReplyDelayFactor(t) {
    return 1.15 - t / 2;
}

/** The patience of a conversation is multiplied by this: a quiet character waits longer, a chatty one less. */
export function getPatienceFactor(t) {
    return 1.5 - t;
}
