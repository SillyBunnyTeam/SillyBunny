/**
 * Judges one string that the page renders, for the copy check of the surface audit. The rule is `capitalisation.js`, the same as the
 * unit test on the source strings; this adds what a rendered string needs: the placeholders that the copy pass leaves to the user, and a
 * verdict for a heading or tooltip that is a sentence in header capitalisation (it needs other words, so it is reported with no form).
 */

import { checkLabel, headerCase } from './capitalisation.js';

const PLACEHOLDER = /^(?:TODO\(copy\)|lorum ipsum)$/i;
// The maintainer keeps the loading pages' titles in character, a reference to the Touhou Project, so they do not name what
// loads. They are on purpose and not a violation.
const IN_CHARACTER_TITLES = new Set(['Loading…', 'Loading chats…', 'Loading chat…']);

/**
 * @param {string} role A role of `capitalisation.js`.
 * @param {string} text
 * @returns {null | { kind: string, expected: string }} `null` when the text follows the rule. `expected` is empty for kind `words`.
 */
export function judgeRendered(role, text) {
    const flat = text.replace(/\s+/g, ' ').trim();
    if (!/\p{L}/u.test(flat) || PLACEHOLDER.test(flat) || (role === 'heading' && IN_CHARACTER_TITLES.has(flat))) {
        return null;
    }
    const result = checkLabel(role, flat);
    if (!result.ok) {
        return { kind: result.why, expected: result.expected };
    }
    // A sentence-length label that already reads as a heading in header capitalisation ("Run This Companion on the Latest Reply") is fine.
    if (result.skipped === 'sentence-length' && headerCase(flat) !== flat) {
        return { kind: 'words', expected: '' };
    }
    return null;
}
