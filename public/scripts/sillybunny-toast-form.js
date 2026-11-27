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
/** Upstream and extensions draw buttons as `div.menu_button` as often as `button`. The toast CSS lists the same selectors. */
export const BUTTON_SELECTOR = 'button, [role="button"], input[type="button"], input[type="submit"], input[type="reset"], .menu_button';
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

/** Set on a toast whose message holds a button, so that the CSS lays the button out without a `:has()` rule. */
export const TOAST_BUTTON_CLASS = 'sb-toast--button';
/** Set on the element that directly holds a button of a toast's message, when that element is not the message itself. */
export const TOAST_BUTTON_HOLDER_CLASS = 'sb-toast-button-holder';

/**
 * Marks where the buttons of a toast are, for the CSS that puts the one button at the end of the label. A `:has()` rule
 * that names `[role="button"]` makes the browser check its anchors at every write of a `role` attribute anywhere in the
 * page, and a Welcome slide, which writes `role` on its buttons, restyles the whole document once more because of it.
 * Markers that follow the content cost nothing outside the toast. toastr builds the message as a direct child of the toast.
 * @param {Element} toast
 */
export function markButtons(toast) {
    const message = [...toast.children].find(child => child.classList.contains('toast-message')) ?? null;
    const buttons = message ? [...message.querySelectorAll(BUTTON_SELECTOR)] : [];
    toast.classList.toggle(TOAST_BUTTON_CLASS, buttons.length > 0);
    const holders = new Set(buttons.map(button => button.parentElement).filter(parent => parent && parent !== message));
    for (const stale of toast.querySelectorAll(`.${TOAST_BUTTON_HOLDER_CLASS}`)) {
        if (!holders.has(stale)) {
            stale.classList.remove(TOAST_BUTTON_HOLDER_CLASS);
        }
    }
    for (const holder of holders) {
        holder.classList.add(TOAST_BUTTON_HOLDER_CLASS);
    }
}

/** @type {WeakMap<Element, MutationObserver>} */
const toastButtonObservers = new WeakMap();

/**
 * Stops watching a toast for dynamic button changes.
 * @param {Element | null | undefined} toast
 */
export function unwatchToastButtons(toast) {
    if (!toast) {
        return;
    }
    const observer = toastButtonObservers.get(toast);
    if (observer) {
        observer.disconnect();
        toastButtonObservers.delete(toast);
    }
}

/**
 * Marks the buttons of a toast again each time a caller changes its content after it shows, as a message that adds an
 * Undo button to a text that is already on screen does. Only the toast form needs it: an in-app notification keeps the
 * markup of its caller.
 * @param {Element} toast
 * @returns {() => void} Stops observing the toast.
 */
export function watchToastButtons(toast) {
    unwatchToastButtons(toast);
    if (typeof MutationObserver !== 'function') {
        return () => {};
    }
    const observer = new MutationObserver(() => {
        if (!toast.isConnected) {
            unwatchToastButtons(toast);
            return;
        }
        markButtons(toast);
        observer.takeRecords();
    });
    observer.observe(toast, { childList: true, subtree: true });
    toastButtonObservers.set(toast, observer);
    return () => unwatchToastButtons(toast);
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
 * A clone that is added to the document runs the inline handlers of its elements and loads its images, which would
 * repeat what the message already did, such as a counter in an `onerror`. The elements stay, so the clone has the same
 * structure for the block and width rules.
 * @param {HTMLElement} clone
 */
function stripActiveContent(clone) {
    for (const node of [clone, ...clone.querySelectorAll('*')]) {
        for (const { name } of [...node.attributes]) {
            if (name.startsWith('on')) {
                node.removeAttribute(name);
            }
        }
    }
    for (const node of clone.querySelectorAll('img, source')) {
        node.removeAttribute('src');
        node.removeAttribute('srcset');
    }
}

/**
 * The width of the box of `element` in layout px. getBoundingClientRect() includes the transforms of the ancestors, and a
 * toast can be measured inside a surface that is scaled, such as a Popup while it opens, where a message of 560px
 * would read as 448px. The computed width is the used width of the layout. Where the layout gives none (jsdom), the
 * box is the answer.
 * @param {HTMLElement} element
 * @param {CSSStyleDeclaration} style The computed style of `element`.
 * @returns {number}
 */
function layoutWidth(element, style) {
    const width = parseFloat(style.width);
    if (!Number.isFinite(width)) {
        return element.getBoundingClientRect().width;
    }
    if (style.boxSizing !== 'content-box') {
        return width;
    }
    const sides = [style.paddingLeft, style.paddingRight, style.borderLeftWidth, style.borderRightWidth];
    return width + sides.reduce((sum, side) => sum + (parseFloat(side) || 0), 0);
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
    stripActiveContent(clone);
    // A toast that waits for its turn is hidden with an inline `display: none`, which would measure as zero, and an
    // inline transform from a running animation would change the width that is read.
    clone.removeAttribute('style');
    clone.classList.add(TOAST_FORM_CLASS, TOAST_MEASURE_CLASS);
    // The clone is laid out as a toast, and a toast puts its button in a row that measures differently from a block.
    markButtons(clone);
    (document.getElementById(TOAST_OVERLAY_ID) ?? document.body).append(clone);
    try {
        const style = getComputedStyle(clone);
        return { width: layoutWidth(clone, style), em: parseFloat(style.fontSize) };
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
