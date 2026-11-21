/**
 * The keys that open Help and Keyboard Shortcuts. The windows come in through `registerHelpKeys`, so a test can run
 * the handler without the app.
 */

import { isApplePlatform } from '../sillybunny-platform.js';
import { HELP_DIALOG_CLASS, SHORTCUTS_DIALOG_CLASS } from './dialog-classes.js';

const HELP_WINDOW_SELECTOR = `.${HELP_DIALOG_CLASS}, .${SHORTCUTS_DIALOG_CLASS}`;

/**
 * A question mark with the modifier of the shell shortcuts: Command on an Apple platform, Control elsewhere. Super,
 * which Windows and Linux report as Meta, is not a modifier of the app. Alt is left out because Windows reports AltGr
 * as Control and Alt together, and a layout that types the question mark with AltGr would otherwise lose the key in
 * every text box.
 * @param {KeyboardEvent} event
 * @param {{ apple?: boolean }} [platform]
 * @returns {boolean}
 */
export function isShortcutsKey(event, { apple = isApplePlatform() } = {}) {
    const modifier = apple ? event.metaKey : event.ctrlKey;
    return event.key === '?' && modifier && !event.altKey && !event.isComposing;
}

/**
 * F1 on its own: with a modifier it belongs to the browser or the system.
 * @param {KeyboardEvent} event
 * @returns {boolean}
 */
export function isHelpKey(event) {
    return event.key === 'F1' && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && !event.isComposing;
}

/**
 * Whether a dialog other than the Help and Keyboard Shortcuts windows is open. A page that one of the two windows
 * pushes lives in the host of the window that pushed it, so it counts as that window.
 * @param {ParentNode} [root]
 * @returns {boolean}
 */
export function hasOtherModalOpen(root = document) {
    return [...root.querySelectorAll('dialog[open]:not([closing])')].some(host => !host.querySelector(HELP_WINDOW_SELECTOR));
}

/**
 * Both keys are always held back from the browser, because F1 would otherwise open its own help page over the app.
 * A window opens only when no other modal is open and the key is not a repeat of one held down. A window that is
 * already open is not opened again: the openers do nothing while their window is open.
 * @param {object} options
 * @param {() => void} options.openHelp
 * @param {() => void} options.openShortcuts
 * @param {() => boolean} [options.isBlocked]
 * @param {boolean} [options.apple] Whether Command, and not Control, is the modifier.
 * @returns {(event: KeyboardEvent) => void}
 */
export function createHelpKeyHandler({ openHelp, openShortcuts, isBlocked = hasOtherModalOpen, apple = isApplePlatform() }) {
    const findOpener = (event) => {
        if (isHelpKey(event)) {
            return openHelp;
        }
        return isShortcutsKey(event, { apple }) ? openShortcuts : null;
    };
    return (event) => {
        if (event.defaultPrevented) {
            return;
        }
        const open = findOpener(event);
        if (!open) {
            return;
        }
        event.preventDefault();
        if (!event.repeat && !isBlocked()) {
            open();
        }
    };
}

const listening = new WeakSet();

/**
 * Listens for the two keys once the app is ready, once for the whole session. The listener runs in the capture
 * phase, so a field that stops its own keys cannot keep F1 from the browser.
 * @param {object} options
 * @param {{ once: (name: string, listener: () => void) => void }} options.eventSource
 * @param {{ APP_READY: string }} options.eventTypes
 * @param {() => void} options.openHelp
 * @param {() => void} options.openShortcuts
 * @param {EventTarget} [options.target]
 */
export function registerHelpKeys({ eventSource, eventTypes, openHelp, openShortcuts, target = document }) {
    if (listening.has(target)) {
        return;
    }
    listening.add(target);
    eventSource.once(eventTypes.APP_READY, () => {
        target.addEventListener('keydown', createHelpKeyHandler({ openHelp, openShortcuts }), true);
    });
}
