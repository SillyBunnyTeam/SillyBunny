import { MOTION_EASE, MOTION_SLOW, animateOut, play, stopMotion } from '../sillybunny-motion.js';

/** The sheet that styles `.sb-banner`. It is the editor shell's, so a banner outside an editor loads it itself. */
const BANNER_STYLESHEET = { href: 'css/sillybunny-editor-shell.css?v=20261118zze', id: 'deferred-editor-shell-css' };

// libadwaita's AdwBanner measures, in px: the title is 6 from the edge, parts are 6 apart, the button is at least 84
// wide beside the title, and a centred title keeps 36 clear of the button on each side. CSS holds the same numbers.
const PADDING = 6;
const SPACING = 6;
const SPACING_CENTERED = 36;
const BUTTON_MIN_WIDTH = 84;

const BOX_STYLES = { overflow: 'hidden', 'box-sizing': 'border-box' };

/**
 * Reads the natural width of a node by letting it take the width of its content for one read.
 * @param {HTMLElement} node
 * @param {Record<string, string>} overrides
 * @returns {number}
 */
function naturalWidth(node, overrides) {
    const saved = node.getAttribute('style');
    for (const [property, value] of Object.entries(overrides)) {
        node.style.setProperty(property, value);
    }
    const { width } = node.getBoundingClientRect();
    if (saved === null) node.removeAttribute('style');
    else node.setAttribute('style', saved);
    return width;
}

function afterNextFrame(callback) {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(callback);
    else setTimeout(callback, 16);
}

/**
 * A banner (libadwaita AdwBanner): a strip under a view's header bar with one title and at most one button, for a
 * persistent state that one action resolves. It reveals and hides over the reveal transition, which is none when the
 * system or the page asks for reduced motion.
 *
 * The strip is a polite live region (`role="status"`) and is written again when it is shown, so that a screen reader
 * says it when it appears. libadwaita's banner is a labelled group and announces nothing itself.
 * @param {object} options
 * @param {string} options.title One short title, written as an informal heading. It may wrap.
 * @param {string} [options.actionLabel] The label of the one button. Without it the banner has no button.
 * @param {() => void} [options.onActivate] Runs when the button is pressed.
 * @param {'default'|'suggested'} [options.buttonStyle] `suggested` for a button that is the clear way forward.
 * @param {boolean} [options.revealed] Whether it starts shown. Defaults to shown.
 */
export function createBanner({ title, actionLabel, onActivate, buttonStyle = 'default', revealed = true }) {
    const element = document.createElement('div');
    element.className = 'sb-banner';
    element.setAttribute('role', 'status');
    const text = document.createElement('span');
    text.className = 'sb-banner__title';
    text.textContent = title;
    element.append(text);

    /** @type {{ node: HTMLButtonElement, activate: () => void }|null} */
    let action = null;
    let announceToken = 0;
    let measuredWidth = -1;
    let destroyed = false;

    const loadStyles = globalThis.SillyBunnyAssets?.loadStylesheetAsync;
    const styled = loadStyles ? Promise.resolve(loadStyles(BANNER_STYLESHEET.href, { id: BANNER_STYLESHEET.id })).catch(() => {}) : null;

    function isShown() {
        return !element.hidden && element.isConnected;
    }

    /** Puts the title beside the button, centred, or above it, as AdwBanner allocates it. */
    function measure() {
        const available = element.clientWidth - PADDING * 2;
        if (!(available > 0)) return;
        measuredWidth = element.clientWidth;
        element.removeAttribute('data-layout');
        if (!action) {
            element.dataset.layout = 'title';
            return;
        }
        const titleWidth = naturalWidth(text, { flex: 'none', width: 'max-content', 'max-width': 'none', 'white-space': 'nowrap' });
        const buttonWidth = Math.max(naturalWidth(action.node, { flex: 'none', width: 'auto', 'min-width': '0' }), BUTTON_MIN_WIDTH);
        if (PADDING + titleWidth + SPACING + buttonWidth > available) {
            element.dataset.layout = 'stacked';
        } else if (titleWidth + (buttonWidth + SPACING_CENTERED) * 2 <= available) {
            element.dataset.layout = 'centered';
        }
    }

    function remeasure() {
        if (isShown()) measure();
    }

    function announce() {
        const token = ++announceToken;
        afterNextFrame(() => {
            if (token !== announceToken || element.hidden || destroyed) return;
            // Replacing the text node is a change that a live region reports, and the title looks the same.
            text.replaceChildren(document.createTextNode(text.textContent ?? ''));
        });
    }

    function reveal() {
        stopMotion(element);
        element.hidden = false;
        measure();
        announce();
        const { height } = element.getBoundingClientRect();
        if (!(height > 0)) return;
        play(element, [
            { height: '0px', paddingTop: '0px', paddingBottom: '0px', opacity: 0 },
            { height: `${height}px`, opacity: 1 },
        ], { duration: MOTION_SLOW, easing: MOTION_EASE, styles: BOX_STYLES });
    }

    function collapse() {
        announceToken += 1;
        const { height } = element.getBoundingClientRect();
        if (!(height > 0)) {
            stopMotion(element);
            element.hidden = true;
            return;
        }
        animateOut(element, [
            { height: `${height}px`, opacity: 1 },
            { height: '0px', paddingTop: '0px', paddingBottom: '0px', opacity: 0 },
        ], () => { element.hidden = true; }, { duration: MOTION_SLOW, easing: MOTION_EASE, styles: BOX_STYLES });
    }

    function setRevealed(next) {
        const wanted = Boolean(next);
        if (wanted === !element.hidden) return;
        if (wanted) reveal();
        else collapse();
    }

    /**
     * Sets the one button, or removes it with `null`. The old button and its listener are dropped.
     * @param {{ label: string, onActivate?: () => void, style?: 'default'|'suggested' }|null} next
     */
    function setButton(next) {
        if (action) {
            action.node.removeEventListener('click', action.activate);
            action.node.remove();
            action = null;
        }
        if (next) {
            const node = document.createElement('button');
            node.type = 'button';
            node.className = 'menu_button sb-banner__action';
            if (next.style === 'suggested') node.classList.add('menu_button_primary', 'is-suggested');
            node.textContent = next.label;
            const activate = () => next.onActivate?.();
            node.addEventListener('click', activate);
            element.append(node);
            action = { node, activate };
        }
        remeasure();
    }

    if (actionLabel !== undefined) {
        setButton({ label: actionLabel, onActivate, style: buttonStyle });
    }
    element.hidden = !revealed;

    const observer = typeof ResizeObserver === 'function'
        ? new ResizeObserver(() => { if (isShown() && element.clientWidth !== measuredWidth) measure(); })
        : null;
    observer?.observe(element);
    styled?.then(remeasure);

    return {
        element,
        show() { setRevealed(true); },
        hide() { setRevealed(false); },
        setRevealed,
        isRevealed() { return !element.hidden; },
        setTitle(next) {
            text.textContent = next;
            remeasure();
        },
        setButton,
        measure,
        destroy() {
            destroyed = true;
            observer?.disconnect();
            stopMotion(element);
            if (action) action.node.removeEventListener('click', action.activate);
            element.remove();
        },
    };
}
