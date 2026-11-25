/**
 * What is an emoji, without the emoji table. The reply path of the mode (the runtime tier) checks a model's reaction
 * with these functions before any table is loaded, so this file imports nothing.
 *
 * No regular expression here uses the `v` flag: iOS 16.4 has no `RegExp` `v`. Property escapes with the `u` flag and
 * `Intl.Segmenter` are older than that baseline.
 */

/** The longest emoji sequence in the data is a ZWJ sequence of 11 code points, 20 UTF-16 units. */
const MAX_UNITS = 32;

const SEGMENTER = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

const KEYCAP = /^[0-9#*]️?⃣$/u;
const FLAG = /^\p{Regional_Indicator}{2}$/u;
const SEQUENCE = /^\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier}|[\u{E0020}-\u{E007F}])*(?:‍\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})*)*$/u;

const IS_EMOJI = /\p{Emoji}/u;
const IS_EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u;
const IS_MODIFIER = /\p{Emoji_Modifier}/u;
const IS_KEYCAP_BASE = /^[0-9#*]$/;

function isOneGrapheme(text) {
    if (!SEGMENTER) {
        return [...text].length >= 1;
    }
    const segments = SEGMENTER.segment(text)[Symbol.iterator]();
    return segments.next().done !== true && segments.next().done === true;
}

/** Whether the text is exactly one emoji: a keycap, a flag, or a pictograph with its selectors, tones, tags and joined parts. */
export function isSingleEmoji(text) {
    if (typeof text !== 'string' || text.length === 0 || text.length > MAX_UNITS) {
        return false;
    }
    return isOneGrapheme(text) && (KEYCAP.test(text) || FLAG.test(text) || SEQUENCE.test(text));
}

/**
 * The fully-qualified form: U+FE0F after every emoji base that is text by default, has no selector and is not followed by
 * a skin tone. A keycap base takes it only when the keycap mark follows. A model writes `❤` as often as `❤️`, and the
 * table and the font are keyed on the qualified form.
 */
export function qualifyEmoji(text) {
    const points = [...String(text)];
    let qualified = '';
    for (let index = 0; index < points.length; index++) {
        const point = points[index];
        const next = points[index + 1];
        qualified += point;
        if (!IS_EMOJI.test(point) || IS_EMOJI_PRESENTATION.test(point) || IS_MODIFIER.test(point)) {
            continue;
        }
        if (IS_KEYCAP_BASE.test(point) && next !== '️' && next !== '⃣') {
            continue;
        }
        if (next === '️' || (next !== undefined && IS_MODIFIER.test(next))) {
            continue;
        }
        qualified += '️';
    }
    return qualified;
}

/** What two reactions are compared by: the emoji without its selector, so ❤ and ❤️ are one. */
export function emojiKey(text) {
    return String(text).replace(/️/g, '');
}
