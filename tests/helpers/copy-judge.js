/**
 * Judges one string that the page renders, for the copy check of the surface audit. The rule is `capitalisation.js`, the same as the
 * unit test on the source strings; this adds what a rendered string needs: the placeholders that the copy pass leaves to the user, and a
 * verdict for a heading or tooltip that is a sentence in header capitalisation (it needs other words, so it is reported with no form).
 */

import { checkLabel, headerCase } from './capitalisation.js';

const PLACEHOLDER = /^(?:TODO\(copy\)|lorum ipsum)$/i;

/**
 * @param {string} role A role of `capitalisation.js`.
 * @param {string} text
 * @param {{ origin?: string }} [options] `origin` is the one `copy-origin.js` gives. Only a string that SillyBunny wrote must lose the period of a one-sentence caption.
 * @returns {null | { kind: string, expected: string }} `null` when the text follows the rule. `expected` is empty for kind `words`.
 */
export function judgeRendered(role, text, { origin } = {}) {
    const flat = text.replace(/\s+/g, ' ').trim();
    if (!/\p{L}/u.test(flat) || PLACEHOLDER.test(flat)) {
        return null;
    }
    // Upstream keeps its wording and its period, and a string of unknown origin may be upstream's, so only a SillyBunny string is held to the period rule.
    const result = checkLabel(role, flat, { captionPeriod: origin === 'sillybunny' });
    if (!result.ok) {
        return { kind: result.why, expected: result.expected };
    }
    // A sentence-length label that already reads as a heading in header capitalisation ("Run This Companion on the Latest Reply") is fine.
    if (result.skipped === 'sentence-length' && headerCase(flat) !== flat) {
        return { kind: 'words', expected: '' };
    }
    return null;
}
