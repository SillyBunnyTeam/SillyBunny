/**
 * Puts an emoji into the composer entry. The chooser takes the focus while it is open, so the range that was selected when it
 * opened is passed in, and the entry gets the focus back.
 * @param {HTMLTextAreaElement} entry
 * @param {string} emoji
 * @param {{ start: number, end: number }} range The selection of the entry when the chooser opened.
 */
export function insertEmojiAtCaret(entry, emoji, { start, end }) {
    const length = entry.value.length;
    const from = Math.min(Math.max(0, start), length);
    const to = Math.min(Math.max(from, end), length);
    entry.setRangeText(emoji, from, to, 'end');
    // The caret goes after the emoji by `'end'` in a browser; setting it again does not depend on that.
    entry.setSelectionRange(from + emoji.length, from + emoji.length);
    // The entry grows with its text and saves its draft on `input`.
    entry.dispatchEvent(new Event('input', { bubbles: true }));
    entry.focus({ preventScroll: true });
}
