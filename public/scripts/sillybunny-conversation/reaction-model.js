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
 * @typedef {{ e: string, n?: string }} QuickReaction An emoji of the quick row, and the name that it had when it was chosen, which the default ones do not carry.
 */

import { DEFAULT_QUICK_REACTIONS } from './emoji/emoji-defaults.js';
import { emojiKey, isSingleEmoji, qualifyEmoji } from './emoji/emoji-validate.js';

export const USER_REACTOR = 'user';
export const MAX_DISTINCT_REACTIONS = 20;
const MAX_READ_ENTRIES = 64;
const MAX_REACTOR_LENGTH = 256;
export const QUICK_ROW_SIZE = 6;

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

// The words that the capitalisation rule of DESIGN.md leaves in lower case inside a label (`tests/helpers/capitalisation.js`).
const LABEL_FUNCTION_WORDS = new Set(['a', 'an', 'the', 'and', 'or', 'but', 'nor', 'for', 'as', 'at', 'by', 'in', 'of', 'to', 'per', 'via', 'vs', 'if']);

/**
 * The name of an emoji as the text of a label. The names of Unicode are written in lower case, and a tooltip or an
 * accessible name of the interface is in header capitalisation: "face with tears of joy" is "Face With Tears of Joy".
 */
export function toLabelCase(name) {
    return String(name ?? '').split(' ')
        .map((word, index) => (index > 0 && LABEL_FUNCTION_WORDS.has(word.toLowerCase()) ? word.toLowerCase() : word.charAt(0).toUpperCase() + word.slice(1)))
        .join(' ');
}

/** The accessible name of a chip. The names of the reactors are not in it: they are one command away, in a list. */
export function describeReactionChip(chip, name) {
    return `${name || chip.emoji}, ${chip.count} ${chip.count === 1 ? 'reaction' : 'reactions'}`;
}

/**
 * The emoji of a quick row: the recent reactions, topped up from the default six. The recents are those that the store
 * of the chooser keeps (`readRecentReactions()` in `emoji/emoji-store.js`), already valid and newest first.
 * @param {QuickReaction[]} recents
 * @param {number} [size]
 * @returns {QuickReaction[]}
 */
export function getQuickReactions(recents, size = QUICK_ROW_SIZE) {
    const row = [];
    const seen = new Set();
    for (const item of [...recents, ...DEFAULT_QUICK_REACTIONS.map(e => ({ e }))]) {
        if (!seen.has(emojiKey(item.e))) {
            seen.add(emojiKey(item.e));
            row.push(item);
        }
    }
    return row.slice(0, size);
}
