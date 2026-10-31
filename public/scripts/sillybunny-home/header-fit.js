const HEADER_SELECTOR = '.sbHomeHeader';
const VERSION_SELECTOR = '.sbHomeVersion';
const BUTTON_SELECTOR = '.sbHomeMenuButton';
const BELOW = 'data-sb-version-below';
/** The space the version keeps from the menu button, in px. */
const VERSION_BUTTON_GAP = 8;

/** @type {(() => void) | null} */
let stopPrevious = null;

/**
 * Whether the version, with a gap on both sides, touches the menu button.
 * @param {DOMRect} version
 * @param {DOMRect} button
 */
export function versionTouchesButton(version, button) {
    return version.left - VERSION_BUTTON_GAP < button.right
        && version.right + VERSION_BUTTON_GAP > button.left
        && version.top < button.bottom
        && version.bottom > button.top;
}

/**
 * Puts the version below the title when, beside it, it would touch the menu button. How wide the version is
 * depends on the font size and on the text, so a width breakpoint cannot decide it. The inline placement is
 * measured on every pass, so the answer follows the current size and never depends on the last one.
 * @param {HTMLElement} header
 */
export function updateVersionPlacement(header) {
    const version = header.querySelector(VERSION_SELECTOR);
    const button = header.querySelector(BUTTON_SELECTOR);
    if (!version || !button || version.getClientRects().length === 0) {
        return;
    }
    header.removeAttribute(BELOW);
    header.toggleAttribute(BELOW, versionTouchesButton(version.getBoundingClientRect(), button.getBoundingClientRect()));
}

/**
 * Keeps the placement of the version in a Home panel in step with the room it has. Only one Home panel exists
 * at a time, so the observer of the previous panel is stopped here; it would keep that panel alive.
 * @param {HTMLElement} panel
 */
export function fitHomeHeader(panel) {
    stopPrevious?.();
    stopPrevious = null;
    const header = panel.querySelector(HEADER_SELECTOR);
    if (!(header instanceof HTMLElement)) {
        return;
    }

    let stopped = false;
    let queued = false;
    // The write changes the height of the header, and a resize observed inside its own callback raises a loop
    // error. A frame of its own also merges a burst of resizes into one measure.
    const schedule = () => {
        if (stopped || queued) {
            return;
        }
        queued = true;
        requestAnimationFrame(() => {
            queued = false;
            if (!stopped) {
                updateVersionPlacement(header);
            }
        });
    };

    const observer = new ResizeObserver(schedule);
    observer.observe(header);
    header.querySelectorAll(`${VERSION_SELECTOR}, .sbHomeTitle`).forEach(node => observer.observe(node));
    // Below the title the version has no width, so a new text does not resize it and the observer stays silent.
    const textObserver = new MutationObserver(schedule);
    textObserver.observe(header, { childList: true, characterData: true, subtree: true });
    // A web font that arrives late changes the widths without resizing the header.
    document.fonts?.ready.then(schedule);
    document.fonts?.addEventListener?.('loadingdone', schedule);
    schedule();

    stopPrevious = () => {
        stopped = true;
        observer.disconnect();
        textObserver.disconnect();
        document.fonts?.removeEventListener?.('loadingdone', schedule);
    };
}
