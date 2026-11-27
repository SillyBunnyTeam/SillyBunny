/**
 * The lists of recent emoji: pure functions on a list of `{ e, n? }`, `e` the emoji in its fully-qualified form and `n`
 * the name at the time of the pick. The name is stored so that a button that shows the emoji has an accessible name
 * without loading the emoji table.
 */

import { emojiKey, isSingleEmoji, qualifyEmoji } from './emoji-validate.js';

export const RECENT_LIMIT = 24;
const MAX_NAME_LENGTH = 120;

function normalizeEntry(entry) {
    if (!entry || typeof entry !== 'object' || typeof entry.e !== 'string') {
        return null;
    }
    const emoji = qualifyEmoji(entry.e);
    if (!isSingleEmoji(emoji)) {
        return null;
    }
    const named = typeof entry.n === 'string' && entry.n.length > 0 && entry.n.length <= MAX_NAME_LENGTH;
    return named ? { e: emoji, n: entry.n } : { e: emoji };
}

/** A list from the settings, or from a damaged file: only the valid entries, once each, at most `RECENT_LIMIT`. */
export function readRecents(raw) {
    if (!Array.isArray(raw)) {
        return [];
    }
    const seen = new Set();
    const list = [];
    for (const item of raw) {
        const entry = normalizeEntry(item);
        if (!entry || seen.has(emojiKey(entry.e))) {
            continue;
        }
        seen.add(emojiKey(entry.e));
        list.push(entry);
        if (list.length === RECENT_LIMIT) {
            break;
        }
    }
    return list;
}

/** A new list with the entry first. An entry that is not one emoji leaves the list as it is. */
export function pushRecent(list, entry) {
    const fresh = normalizeEntry(entry);
    if (!fresh) {
        return list;
    }
    return readRecents([fresh, ...list.filter(item => emojiKey(item.e) !== emojiKey(fresh.e))]);
}
