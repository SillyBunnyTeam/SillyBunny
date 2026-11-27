/*
 * A long press on a message with a finger opens the message's menu, as the secondary click does with a mouse.
 *
 * The press belongs to the message only where nothing under the finger has a press of its own: a reaction chip lists who
 * reacted, a button acts, a link has the platform's menu, a field has its caret and its selection. Everything else in the
 * row, the bubble, its text and its image included, opens the menu. The browser's own response to the same press (the
 * context menu of Android, the callout of iOS, the selection of a word) is switched off for the message in the style sheet
 * and in `contextmenu` here, so the press does one thing.
 */

export const LONG_PRESS_MS = 450;
export const LONG_PRESS_SLOP_PX = 10;
/** The click that ends a long press follows the release, and must not act on whatever the sheet that opened lies over. */
export const CLICK_SWALLOW_MS = 350;
const VIBRATION_MS = 10;

const MESSAGE_SELECTOR = '.sb-conversation-message[data-message-id]:not(.is-editing)';
const OWN_PRESS_SELECTOR = 'a[href], button, input, textarea, select, summary, audio, video, [contenteditable], [role="button"], [data-sb-own-long-press]';

const isSelecting = () => document.getElementById('sheld')?.dataset.selectionMode === 'true';

/** The message that a press on `target` belongs to, or null when the press is a control's, a field's or no message's. */
function getPressedMessage(target) {
    const item = target instanceof Element ? target.closest(MESSAGE_SELECTOR) : null;
    if (!item) {
        return null;
    }
    const control = target.closest(OWN_PRESS_SELECTOR);
    return control && item.contains(control) ? null : item;
}

/** A selection that reaches into the message is the platform's to handle: its handles and its copy menu are what a press there is for. */
function isSelectionInside(item) {
    const selection = getSelection();
    if (!selection || selection.isCollapsed) {
        return false;
    }
    return item.contains(selection.anchorNode) || item.contains(selection.focusNode);
}

/**
 * @param {object} options
 * @param {(item: HTMLElement, point: { x: number, y: number }) => void} options.onLongPress The finger stayed on a message; open its menu.
 * @returns {() => void} Stops listening.
 */
export function bindMessageLongPress({ onLongPress }) {
    /** @type {null | { item: HTMLElement, x: number, y: number, timer: ReturnType<typeof setTimeout> }} */
    let press = null;
    // The menu was opened by a press that the finger has not left yet.
    let opened = false;
    let swallowClicksUntil = 0;

    const abort = () => {
        if (press) {
            clearTimeout(press.timer);
            press = null;
        }
    };

    function open() {
        const current = press;
        abort();
        if (!current || !current.item.isConnected || isSelecting() || isSelectionInside(current.item)) {
            return;
        }
        opened = true;
        navigator.vibrate?.(VIBRATION_MS);
        onLongPress(current.item, { x: current.x, y: current.y });
    }

    function handlePointerDown(event) {
        abort();
        opened = false;
        if (event.pointerType !== 'touch' || event.isPrimary === false || isSelecting()) {
            return;
        }
        const item = getPressedMessage(event.target);
        if (item) {
            press = { item, x: event.clientX, y: event.clientY, timer: setTimeout(open, LONG_PRESS_MS) };
        }
    }

    function handlePointerMove(event) {
        if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > LONG_PRESS_SLOP_PX) {
            abort();
        }
    }

    function handlePointerUp() {
        if (opened) {
            opened = false;
            swallowClicksUntil = Date.now() + CLICK_SWALLOW_MS;
        }
        abort();
    }

    function handlePointerCancel() {
        opened = false;
        abort();
    }

    function handleContextMenu(event) {
        if (!getPressedMessage(event.target)) {
            return;
        }
        // A platform whose long press is shorter than ours sends this first: it is the same press, so it opens the menu now.
        if (press) {
            event.preventDefault();
            open();
        } else if (opened || Date.now() < swallowClicksUntil) {
            event.preventDefault();
        }
    }

    function handleClick(event) {
        if (Date.now() < swallowClicksUntil) {
            event.preventDefault();
            event.stopImmediatePropagation();
        }
    }

    document.addEventListener('pointerdown', handlePointerDown, { passive: true });
    document.addEventListener('pointermove', handlePointerMove, { passive: true });
    document.addEventListener('pointerup', handlePointerUp, { passive: true });
    document.addEventListener('pointercancel', handlePointerCancel, { passive: true });
    document.addEventListener('contextmenu', handleContextMenu);
    window.addEventListener('click', handleClick, true);

    return () => {
        abort();
        document.removeEventListener('pointerdown', handlePointerDown);
        document.removeEventListener('pointermove', handlePointerMove);
        document.removeEventListener('pointerup', handlePointerUp);
        document.removeEventListener('pointercancel', handlePointerCancel);
        document.removeEventListener('contextmenu', handleContextMenu);
        window.removeEventListener('click', handleClick, true);
    };
}
