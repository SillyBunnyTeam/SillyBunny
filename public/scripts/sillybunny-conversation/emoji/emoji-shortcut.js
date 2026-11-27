/**
 * The key that opens the chooser from the composer entry: Ctrl+. as in GTK's text widgets (`insert-emoji`).
 */

/** Whether a `keydown` is Ctrl and the period key and nothing else. The place of the key counts, so a layout that has the period elsewhere on its letters still has it. */
export function isEmojiShortcut(event) {
    return event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey && !event.isComposing && !event.repeat
        && (event.code === 'Period' || event.key === '.');
}

const FIREFOX_VERSION = /Firefox\/(\d+)/;
const FIREFOX_LINUX_PICKER = 150;

/**
 * Whether the browser opens its own emoji picker on the same key. Firefox 150 on Linux (2026-04-20) opens GTK's chooser on
 * Ctrl+. in a text field, so the page does not bind the key there and the browser's chooser does the same job.
 */
export function hasNativeEmojiPicker(userAgent) {
    const version = Number(FIREFOX_VERSION.exec(userAgent ?? '')?.[1] ?? 0);
    return version >= FIREFOX_LINUX_PICKER && /\b(?:X11|Linux)\b/.test(userAgent) && !/Android/.test(userAgent);
}
