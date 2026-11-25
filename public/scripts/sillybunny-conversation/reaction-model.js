/**
 * The reactions of a message, as pure rules: how they are stored, read, toggled and counted, and the list of recent
 * reactions that fills the quick row. Nothing here reads the page, so the live path, the finalizer of a reply that the
 * server wrote and the interface all use the same rules.
 *
 * A message keeps `extra.conversation_reactions` as an array of `{ emoji, by, at }`: `by` is `'user'` or the avatar file
 * name of a character, and `at` is a time in milliseconds. The first version of the mode stored an object that counted
 * three named reactions; `readReactions()` reads it as reactions of the user, and the first change writes the array.
 *
 * @typedef {{ emoji: string, by: string, at: number }} ReactionEntry
 * @typedef {{ key: string, emoji: string, count: number, mine: boolean, reactors: { by: string, at: number }[], at: number }} ReactionChip
 * @typedef {{ e: string, n: string }} RecentReaction The emoji, and the name that it had when it was chosen.
 */

import { emojiKey, isSingleEmoji, qualifyEmoji } from './emoji/emoji-validate.js';

export const USER_REACTOR = 'user';
export const MAX_DISTINCT_REACTIONS = 20;
export const REACTION_RECENTS_CAP = 24;
const MAX_READ_ENTRIES = 64;
const MAX_REACTOR_LENGTH = 256;
const MAX_NAME_LENGTH = 80;
export const QUICK_ROW_SIZE = 6;

/** The quick row of a user who has chosen nothing. The first three are the reactions that the mode started with. */
export const DEFAULT_QUICK_REACTIONS = Object.freeze([
    Object.freeze({ e: '❤️', n: 'red heart' }),
    Object.freeze({ e: '😂', n: 'face with tears of joy' }),
    Object.freeze({ e: '✨', n: 'sparkles' }),
    Object.freeze({ e: '👍', n: 'thumbs up' }),
    Object.freeze({ e: '😮', n: 'face with open mouth' }),
    Object.freeze({ e: '😢', n: 'crying face' }),
]);

/** The three reactions that the first version of the mode stored by name, in an object that counted them. */
const LEGACY_REACTION_EMOJI = Object.freeze({
    heart: '❤️',
    spark: '✨',
    laugh: '😂',
});

function readLegacyReactions(reactions) {
    const entries = [];
    for (const [key, count] of Object.entries(reactions)) {
        if (!(Number(count) > 0)) {
            continue;
        }
        const emoji = LEGACY_REACTION_EMOJI[key] ?? (isSingleEmoji(key) ? qualifyEmoji(key) : '');
        if (emoji) {
            entries.push({ emoji, by: USER_REACTOR, at: 0 });
        }
    }
    return entries;
}

function readEntry(item) {
    if (!item || typeof item !== 'object' || !isSingleEmoji(item.emoji)) {
        return null;
    }
    const by = typeof item.by === 'string' ? item.by.trim() : '';
    if (!by || by.length > MAX_REACTOR_LENGTH) {
        return null;
    }
    return { emoji: item.emoji, by, at: Number.isFinite(item.at) ? item.at : 0 };
}

/**
 * The reactions of a message, whichever way the file stored them. A reactor has one entry for an emoji, and a character
 * has one entry in all.
 * @returns {ReactionEntry[]} A new array.
 */
export function readReactions(message) {
    const stored = message?.extra?.conversation_reactions;
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
        return readLegacyReactions(stored);
    }
    if (!Array.isArray(stored)) {
        return [];
    }

    const entries = [];
    const seen = new Set();
    const characters = new Set();
    for (const item of stored) {
        const entry = readEntry(item);
        if (!entry) {
            continue;
        }
        const marker = `${entry.by}\u001f${emojiKey(entry.emoji)}`;
        const isCharacter = entry.by !== USER_REACTOR;
        if (seen.has(marker) || (isCharacter && characters.has(entry.by))) {
            continue;
        }
        seen.add(marker);
        if (isCharacter) {
            characters.add(entry.by);
        }
        entries.push(entry);
        if (entries.length >= MAX_READ_ENTRIES) {
            break;
        }
    }
    return entries;
}

/** Stores the entries in the message. A message with none carries no key, and the old object is replaced by the array. */
export function writeReactions(message, entries) {
    const extra = { ...(message.extra ?? {}) };
    if (entries.length) {
        extra.conversation_reactions = entries;
    } else {
        delete extra.conversation_reactions;
    }
    message.extra = extra;
}

function countDistinct(entries) {
    return new Set(entries.map(entry => emojiKey(entry.emoji))).size;
}

/**
 * The user pressing an emoji: the entry of the user goes when it is there, and comes when it is not. A message holds at
 * most 20 distinct emoji; a chip that a character started takes the user without a new place.
 * @param {ReactionEntry[]} entries
 * @param {string} emoji
 * @param {number} [now]
 * @returns {{ status: 'added'|'removed'|'refused'|'invalid', entries: ReactionEntry[] }} `entries` is the argument itself when nothing changed.
 */
export function toggleUserReaction(entries, emoji, now = Date.now()) {
    if (!isSingleEmoji(emoji)) {
        return { status: 'invalid', entries };
    }
    const qualified = qualifyEmoji(emoji);
    const key = emojiKey(qualified);
    if (entries.some(entry => entry.by === USER_REACTOR && emojiKey(entry.emoji) === key)) {
        return { status: 'removed', entries: entries.filter(entry => !(entry.by === USER_REACTOR && emojiKey(entry.emoji) === key)) };
    }
    const isNewChip = !entries.some(entry => emojiKey(entry.emoji) === key);
    if (isNewChip && countDistinct(entries) >= MAX_DISTINCT_REACTIONS) {
        return { status: 'refused', entries };
    }
    return { status: 'added', entries: [...entries, { emoji: qualified, by: USER_REACTOR, at: now }] };
}

/**
 * A character reacting. It has one reaction to a message, and a second one is ignored, so that a forced reply or a
 * second page that lands the same reply adds nothing.
 * @param {ReactionEntry[]} entries
 * @param {string} emoji
 * @param {string} by The avatar file name of the character.
 * @param {number} [at]
 * @returns {ReactionEntry[]} The argument itself when nothing was added.
 */
export function addCharacterReaction(entries, emoji, by, at = Date.now()) {
    const reactor = typeof by === 'string' ? by.trim() : '';
    if (!reactor || reactor === USER_REACTOR || !isSingleEmoji(emoji) || entries.some(entry => entry.by === reactor)) {
        return entries;
    }
    const qualified = qualifyEmoji(emoji);
    const isNewChip = !entries.some(entry => emojiKey(entry.emoji) === emojiKey(qualified));
    if (isNewChip && countDistinct(entries) >= MAX_DISTINCT_REACTIONS) {
        return entries;
    }
    return [...entries, { emoji: qualified, by: reactor, at }];
}

/**
 * One chip per emoji, in the order that the first reaction to each came, and by position when the times are equal.
 * @param {ReactionEntry[]} entries
 * @returns {ReactionChip[]}
 */
export function groupReactions(entries) {
    const chips = new Map();
    for (const entry of entries) {
        const key = emojiKey(entry.emoji);
        const chip = chips.get(key) ?? { key, emoji: qualifyEmoji(entry.emoji), count: 0, mine: false, reactors: [], at: entry.at };
        chip.count += 1;
        chip.mine ||= entry.by === USER_REACTOR;
        chip.reactors.push({ by: entry.by, at: entry.at });
        chip.at = Math.min(chip.at, entry.at);
        chips.set(key, chip);
    }
    return [...chips.values()]
        .map((chip, index) => ({ chip, index }))
        .sort((left, right) => left.chip.at - right.chip.at || left.index - right.index)
        .map(({ chip }) => chip);
}

/** The accessible name of a chip. The names of the reactors are not in it: they are one command away, in a list. */
export function describeReactionChip(chip, name) {
    return `${name || chip.emoji}, ${chip.count} ${chip.count === 1 ? 'reaction' : 'reactions'}`;
}

function readRecent(item) {
    if (!item || typeof item !== 'object' || !isSingleEmoji(item.e)) {
        return null;
    }
    return { e: qualifyEmoji(item.e), n: typeof item.n === 'string' ? item.n.slice(0, MAX_NAME_LENGTH) : '' };
}

/** The recent reactions that the mode's settings hold. Anything that is not an entry is dropped. */
export function readReactionRecents(stored) {
    if (!Array.isArray(stored)) {
        return [];
    }
    const recents = [];
    const seen = new Set();
    for (const item of stored) {
        const recent = readRecent(item);
        if (recent && !seen.has(emojiKey(recent.e))) {
            seen.add(emojiKey(recent.e));
            recents.push(recent);
        }
        if (recents.length >= REACTION_RECENTS_CAP) {
            break;
        }
    }
    return recents;
}

/**
 * Puts a reaction first among the recents.
 * @param {RecentReaction[]} recents
 * @param {RecentReaction} pick
 * @returns {RecentReaction[]} The argument itself when the pick is not one emoji.
 */
export function pushReactionRecent(recents, pick) {
    const recent = readRecent(pick);
    if (!recent) {
        return recents;
    }
    const earlier = recents.find(item => emojiKey(item.e) === emojiKey(recent.e));
    const next = { e: recent.e, n: recent.n || earlier?.n || '' };
    return [next, ...recents.filter(item => emojiKey(item.e) !== emojiKey(recent.e))].slice(0, REACTION_RECENTS_CAP);
}

/**
 * The emoji of a quick row: the recent reactions, topped up from the default six.
 * @param {RecentReaction[]} recents
 * @param {number} [size]
 * @returns {RecentReaction[]}
 */
export function getQuickReactions(recents, size = QUICK_ROW_SIZE) {
    const row = [];
    const seen = new Set();
    for (const item of [...readReactionRecents(recents), ...DEFAULT_QUICK_REACTIONS]) {
        if (!seen.has(emojiKey(item.e))) {
            seen.add(emojiKey(item.e));
            row.push({ e: item.e, n: item.n });
        }
    }
    return row.slice(0, size);
}
