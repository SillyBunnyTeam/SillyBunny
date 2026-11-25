import { DEFAULT_INACTIVITY_THRESHOLD, MAX_INACTIVITY_THRESHOLD, MIN_INACTIVITY_THRESHOLD } from './constants.js';
import { getCharacterForAvatar } from './media.js';
import { getPatienceFactor, parseTalkativeness } from './talkativeness-utils.js';

/**
 * The talkativeness of a character, from its card, read at the moment of the call so that an edit of the card applies
 * at once. The list of characters holds the value as `talkativeness`; the extensions block of the card is the source for
 * a card that the list has not filled in.
 * @param {string} avatar
 * @returns {number} From 0 to 1; 0.5 for a character that is missing or has no value.
 */
export function getTalkativeness(avatar) {
    const card = avatar ? getCharacterForAvatar(avatar) : null;
    return parseTalkativeness(card?.talkativeness ?? card?.data?.extensions?.talkativeness);
}

/**
 * The minutes that a conversation waits before a character writes first: the patience of the conversation scaled by the
 * card of that character. Each member of a group has its own, because each card has its own value.
 * @param {{ settings?: Record<string, any> }|Record<string, any>} conversation A conversation, or a settings object that already
 * holds the patience as `inactivity_threshold`.
 * @param {string} avatar The character that would write.
 * @returns {number} Minutes, not rounded.
 */
export function getEffectivePatienceMinutes(conversation, avatar) {
    const stored = conversation?.settings && typeof conversation.settings === 'object' ? conversation.settings : conversation;
    const patience = Number.parseInt(stored?.inactivity_threshold, 10);
    const minutes = Number.isFinite(patience)
        ? Math.min(MAX_INACTIVITY_THRESHOLD, Math.max(MIN_INACTIVITY_THRESHOLD, patience))
        : DEFAULT_INACTIVITY_THRESHOLD;
    return minutes * getPatienceFactor(getTalkativeness(avatar));
}
