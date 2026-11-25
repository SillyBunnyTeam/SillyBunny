/**
 * Stand-in for `getTalkativeness()` and `getEffectivePatienceMinutes()` of the settings work of Phase 5 (task 5B), with
 * the same names and signatures, so that the worker has one place to read them from until that work is merged. When it is,
 * the worker imports them from there and this file is deleted.
 */

import { DEFAULT_INACTIVITY_THRESHOLD, MAX_INACTIVITY_THRESHOLD, MIN_INACTIVITY_THRESHOLD } from './constants.js';
import { getCharacterForAvatar } from './media.js';

const DEFAULT_TALKATIVENESS = 0.5;

/** @returns {number} The talkativeness of the character card, 0 to 1, read when it is asked for. 0.5 when the card has none. */
export function getTalkativeness(avatar) {
    const value = getCharacterForAvatar(avatar)?.talkativeness;
    const talkativeness = value === undefined || value === null || value === '' ? NaN : Number(value);
    return Number.isFinite(talkativeness) ? Math.min(Math.max(talkativeness, 0), 1) : DEFAULT_TALKATIVENESS;
}

/**
 * @param {{ settings?: Record<string, any> }|null} conversation The conversation, as the data module holds it.
 * @param {string} avatar The character that would send the message.
 * @returns {number} Minutes of silence before the character starts a message: the patience of the conversation times
 * `1.5 - talkativeness`, so that a card at 0.5 waits exactly as long as the patience says.
 */
export function getEffectivePatienceMinutes(conversation, avatar) {
    const requested = Number(conversation?.settings?.inactivity_threshold);
    const patience = Math.min(Math.max(Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_INACTIVITY_THRESHOLD, MIN_INACTIVITY_THRESHOLD), MAX_INACTIVITY_THRESHOLD);
    return patience * (1.5 - getTalkativeness(avatar));
}
