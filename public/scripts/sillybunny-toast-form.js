/*
 * SillyBunny toast form: decides whether a message is shown as a toast or as an in-app notification.
 * The decision reads the element that toastr built, so a message is judged as toastr rendered it, whatever
 * the caller passed in (string, markup, element, jQuery object or number).
 */

export const TOAST_FORM = 'toast';
export const NOTIFICATION_FORM = 'notification';
export const TOAST_FORM_CLASS = 'sb-form-toast';
export const NOTIFICATION_FORM_CLASS = 'sb-form-notification';
/** The class of the hidden clone that the default measure lays out on one line. */
export const TOAST_MEASURE_CLASS = 'sb-toast-measure';
/** A toast is at most this wide in em, at its own font size, whatever the window. */
export const TOAST_MAX_WIDTH_EM = 34;
/** How many in-app notifications show at once. */
export const NOTIFICATION_MAX_SHOWN = 3;
/** How long an info or success in-app notification stays (GNOME Shell's `NOTIFICATION_TIMEOUT`). */
export const NOTIFICATION_TIMEOUT = 4000;

/** The container that holds the toasts. In-app notifications stay in toastr's own `#toast-container`. */
export const TOAST_OVERLAY_ID = 'sb-toast-overlay';
/** Upstream and extensions draw buttons as `div.menu_button` as often as `button`. */
const BUTTON_SELECTOR = 'button, [role="button"], input[type="button"], input[type="submit"], input[type="reset"], .menu_button';
/** Each of these is one block of its own, with or without text. Buttons are matched before this list. */
const ONE_BLOCK_SELECTOR = 'img, picture, video, audio, canvas, table, select, textarea, progress, meter, hr, input:not([type="hidden"])';
/** Elements that end a line of text. Any other element, including one the browser does not know, is inline. */
const BLOCK_TAGS = new Set([
    'address', 'article', 'aside', 'blockquote', 'center', 'dd', 'details', 'dialog', 'dir', 'div', 'dl', 'dt',
    'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup',
    'li', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'ul',
]);
const NOT_DRAWN_TAGS = new Set(['script', 'style', 'template', 'noscript']);
/** Layout rounds a width to a fraction of a pixel, so a message that is exactly the limit stays a toast. */
const WIDTH_TOLERANCE_PX = 0.5;

let failureLogged = false;

/**
 * @typedef {object} ToastMeasure
 * @property {number} width The width of the message on one line, in the toast form, in px.
 * @property {number} em The font size of the toast, in px.
 */

/**
 * @typedef {object} ToastFormResult
 * @property {'toast'|'notification'} form
 * @property {string} reason The rule that decided: `title`, `onclick`, `buttons`, `blocks`, `width`, `fits` or `error`.
 */

/**
 * @param {Node} element
 * @param {string} className A toastr class option; a caller may set several, separated by spaces.
 * @returns {Element|null} The direct child of the toast that carries every class.
 */
function childWithClass(element, className) {
    const tokens = String(className).split(/\s+/).filter(Boolean);
    if (tokens.length === 0) {
        return null;
    }
    return [...element.children].find(child => tokens.every(token => child.classList.contains(token))) ?? null;
}

/**
 * Counts the buttons of a message. A button inside another button is part of it and counts once.
 * @param {Element} messageElement
 * @returns {number}
 */
export function countButtons(messageElement) {
    return [...messageElement.querySelectorAll(BUTTON_SELECTOR)].filter((button) => {
        const outer = button.parentElement?.closest(BUTTON_SELECTOR);
        return !outer || outer === messageElement || !messageElement.contains(outer);
    }).length;
}

/**
 * Adds the blocks that `parent` holds to `count`. A run of text and inline elements is one block, and a line
 * break or a block element ends it. A button is neither a block nor the end of a run.
 * @param {Element} parent
 * @param {boolean} insideInline True inside an inline element, where an `svg` is an icon in a line of text.
 * @param {{ blocks: number, inRun: boolean }} count
 */
function addBlocks(parent, insideInline, count) {
    for (const node of parent.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
            if (node.textContent.trim() && !count.inRun) {
                count.blocks += 1;
                count.inRun = true;
            }
            continue;
        }
        // `instanceof Element` fails for a node that a caller built in another document, such as an iframe's.
        if (node.nodeType !== Node.ELEMENT_NODE || node.matches(BUTTON_SELECTOR)) {
            continue;
        }

        const name = node.localName;
        if (NOT_DRAWN_TAGS.has(name)) {
            continue;
        }
        if (name === 'br') {
            count.inRun = false;
        } else if (name === 'svg' && insideInline) {
            continue;
        } else if (name === 'svg' || node.matches(ONE_BLOCK_SELECTOR)) {
            count.blocks += 1;
            count.inRun = false;
        } else if (BLOCK_TAGS.has(name)) {
            count.inRun = false;
            addBlocks(node, false, count);
            count.inRun = false;
        } else {
            addBlocks(node, true, count);
        }
    }
}

/**
 * Counts the blocks of a message: lines of text and the elements that stand alone, such as an image or a table.
 * @param {Element} messageElement
 * @returns {number}
 */
export function countBlocks(messageElement) {
    const count = { blocks: 0, inRun: false };
    addBlocks(messageElement, false, count);
    return count.blocks;
}

/**
 * Lays out a hidden clone of the toast on one line and reads its width, so the toast's own CSS applies to the
 * measurement. It never reads the window width: the same message must take the same form in every window.
 * @param {HTMLElement} element
 * @returns {ToastMeasure}
 */
function measureOnOneLine(element) {
    const clone = /** @type {HTMLElement} */ (element.cloneNode(true));
    // A clone repeats ids and would start media or load frames a second time.
    clone.querySelectorAll('[id]').forEach(node => node.removeAttribute('id'));
    clone.querySelectorAll('audio, video, iframe, object, embed, script').forEach(node => node.remove());
    clone.removeAttribute('id');
    // A toast that waits for its turn is hidden with an inline `display: none`, which would measure as zero, and an
    // inline transform from a running animation would change the width that is read.
    clone.removeAttribute('style');
    clone.classList.add(TOAST_FORM_CLASS, TOAST_MEASURE_CLASS);
    (document.getElementById(TOAST_OVERLAY_ID) ?? document.body).append(clone);
    try {
        return {
            width: clone.getBoundingClientRect().width,
            em: parseFloat(getComputedStyle(clone).fontSize),
        };
    } finally {
        clone.remove();
    }
}

function logFailureOnce(error) {
    if (failureLogged) {
        return;
    }
    failureLogged = true;
    console.warn('SillyBunny: a toast could not be classified, so it is shown as an in-app notification.', error);
}

/**
 * Decides the form of a toast. The first rule that holds decides, in this order: a title with text, a click
 * action, more than one button, more than one block of text, a one-line width over `TOAST_MAX_WIDTH_EM`.
 * It never throws: when it fails, the message becomes a notification, which shows every part of it.
 * @param {HTMLElement} element The element toastr returned.
 * @param {Record<string, any>} [options] The effective options of the call (`{ ...toastr.options, ...optionsOverride }`).
 * @param {{ measure?: (element: HTMLElement) => ToastMeasure }} [dependencies] Replaces the browser measurement.
 * @returns {ToastFormResult}
 */
export function classifyToast(element, options, dependencies) {
    try {
        const title = childWithClass(element, options?.titleClass ?? 'toast-title');
        if (title?.textContent.trim()) {
            return { form: NOTIFICATION_FORM, reason: 'title' };
        }
        if (typeof options?.onclick === 'function') {
            return { form: NOTIFICATION_FORM, reason: 'onclick' };
        }

        const message = childWithClass(element, options?.messageClass ?? 'toast-message');
        if (message && countButtons(message) > 1) {
            return { form: NOTIFICATION_FORM, reason: 'buttons' };
        }

        if (message && countBlocks(message) > 1) {
            return { form: NOTIFICATION_FORM, reason: 'blocks' };
        }

        const measure = dependencies?.measure ?? measureOnOneLine;
        const { width, em } = measure(element);
        // Without layout (no em) the comparison is false, so a toast that cannot be measured stays a toast.
        if (width > TOAST_MAX_WIDTH_EM * em + WIDTH_TOLERANCE_PX) {
            return { form: NOTIFICATION_FORM, reason: 'width' };
        }
        return { form: TOAST_FORM, reason: 'fits' };
    } catch (error) {
        logFailureOnce(error);
        return { form: NOTIFICATION_FORM, reason: 'error' };
    }
}
