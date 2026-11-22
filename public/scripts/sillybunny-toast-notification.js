/*
 * SillyBunny in-app notification: what CSS cannot do for toastr's markup.
 * The card is drawn by CSS (sillybunny-theme.css). This module lays out the buttons of the message without moving
 * them, decides what a click on the card does, and plays GNOME Shell's banner motion (messageTray.js).
 */

import { BUTTON_SELECTOR } from './sillybunny-toast-form.js';
import {
    MOTION_EASE_OUT_BACK,
    MOTION_EASE_OUT_QUAD,
    MOTION_NOTIFICATION,
    prefersReducedMotion,
} from './sillybunny-motion.js';

/** Set on every element that directly holds a button of the message: CSS lays it out as the button row. */
export const ACTIONS_CLASS = 'sb-toast-actions';
/** Wraps a run of text in a holder of buttons, so that the run is one item of the row layout. */
export const TEXT_CLASS = 'sb-toast-text';
/** A click on one of these is the control's own, and not a click on the card. */
const CONTROL_SELECTOR = `${BUTTON_SELECTOR}, a[href], input, select, textarea, label, summary, [contenteditable]`;

/** @param {Element} message @returns {Element[]} The buttons that are not inside another button, in document order. */
function outermostButtons(message) {
    return [...message.querySelectorAll(BUTTON_SELECTOR)].filter((button) => {
        const outer = button.parentElement?.closest(BUTTON_SELECTOR);
        return !outer || !message.contains(outer);
    });
}

function isWhitespaceText(node) {
    return node.nodeType === Node.TEXT_NODE && node.textContent.trim() === '';
}

/** Text, and an inline element that holds no button, are part of a line of text. A block element is its own item. */
function isTextRunMember(node) {
    if (node.nodeType === Node.TEXT_NODE) {
        return true;
    }
    if (!(node instanceof Element) || node.classList.contains(TEXT_CLASS) || node.matches(BUTTON_SELECTOR) || node.querySelector(BUTTON_SELECTOR)) {
        return false;
    }
    // An element that has no display value is inline, as a browser computes it.
    const { display } = getComputedStyle(node);
    return display === '' || display.startsWith('inline');
}

/**
 * The row is a flex container, and a run of text and inline elements among its items would be one item per element
 * with the spaces between them lost. Each run is wrapped in a span, which is one item. Only text and inline elements
 * move, and into an element of the holder, so the buttons and the holder keep their place in the caller's markup.
 * @param {Element} holder
 */
function wrapTextRuns(holder) {
    let run = [];
    const flush = () => {
        while (run.length > 0 && isWhitespaceText(run.at(-1))) {
            run.pop();
        }
        if (run.length > 0 && run.some(node => !isWhitespaceText(node))) {
            const wrapper = holder.ownerDocument.createElement('span');
            wrapper.className = TEXT_CLASS;
            holder.insertBefore(wrapper, run[0]);
            wrapper.append(...run);
        }
        run = [];
    };
    for (const node of [...holder.childNodes]) {
        if (isTextRunMember(node)) {
            run.push(node);
        } else {
            flush();
        }
    }
    flush();
}

/**
 * Marks every element that holds a button of the message as a button row. The buttons stay where the caller put them,
 * and so do their ancestors, so handlers bound on a button and handlers delegated from an ancestor keep working. It
 * can run again after the caller changes the content.
 * @param {Element} message The `.toast-message` element.
 */
export function arrangeButtons(message) {
    const holders = new Set(outermostButtons(message).map(button => button.parentElement).filter(Boolean));
    for (const stale of [message, ...message.querySelectorAll(`.${ACTIONS_CLASS}`)]) {
        if (stale.classList.contains(ACTIONS_CLASS) && !holders.has(stale)) {
            stale.classList.remove(ACTIONS_CLASS);
        }
    }
    for (const holder of holders) {
        holder.classList.add(ACTIONS_CLASS);
        wrapTextRuns(holder);
    }
}

/**
 * Arranges the buttons of a notification now and whenever a caller changes its content.
 * @param {HTMLElement} element The notification.
 */
export function watchButtons(element) {
    const arrange = () => {
        const message = element.querySelector(':scope > .toast-message');
        if (message) {
            arrangeButtons(message);
        }
    };
    arrange();
    if (typeof MutationObserver !== 'function') {
        return;
    }
    const observer = new MutationObserver(() => {
        arrange();
        // Wrapping a run is a change too, and must not start the next round.
        observer.takeRecords();
    });
    observer.observe(element, { childList: true, subtree: true });
}

// The click

function hasSelectedText(element) {
    try {
        const selection = element.ownerDocument.defaultView?.getSelection?.();
        return Boolean(selection && !selection.isCollapsed && selection.toString().trim() !== ''
            && (element.contains(selection.anchorNode) || element.contains(selection.focusNode)));
    } catch {
        return false;
    }
}

/**
 * Whether a click on the card does anything: the message's `onclick` runs and the notification goes, or it just goes.
 * A message with `tapToDismiss: false` and no `onclick` is not clickable.
 * @param {Record<string, any>} options The options object that toastr's closures read.
 */
export function cardClickActs(options) {
    return typeof options.onclick === 'function' || options.tapToDismiss !== false;
}

/**
 * Replaces toastr's click handlers on the card. toastr binds them to the whole card, so a press on a button or a link
 * dismissed the notification as well. Here a click outside every control acts, as GNOME Shell activates a banner, and
 * selecting text to copy it does not count as a click.
 * @param {any} $toast
 * @param {{ options: Record<string, any>, dismiss: () => void }} parts
 * @returns {boolean} Whether a click on the card acts.
 */
export function bindCardClick($toast, { options, dismiss }) {
    const element = $toast[0];
    const acts = cardClickActs(options);
    $toast.off('click');
    element.classList.toggle('interactable', acts);
    element.classList.toggle('toast-non-interactable', !acts);
    if (!acts) {
        element.removeAttribute('title');
        return false;
    }
    $toast.on('click', (event) => {
        const control = event.target instanceof Element ? event.target.closest(CONTROL_SELECTOR) : null;
        if ((control && element.contains(control)) || hasSelectedText(element)) {
            return;
        }
        if (typeof options.onclick === 'function') {
            options.onclick(event);
        }
        dismiss();
    });
    return true;
}

// The motion

/** @type {WeakMap<HTMLElement, { animations: Animation[], cancel: () => void }>} */
const playing = new WeakMap();

/** Cancels the animations that this module runs on the element. */
export function stopNotificationMotion(element) {
    playing.get(element)?.cancel();
}

/**
 * Plays several animations of one element together, each with its own easing, as GNOME Shell animates opacity and
 * position with different curves. `onFinish` runs when all have finished, `onEnd` when they finish or are cancelled.
 * Without WAAPI or a connected element both run at once.
 * @param {HTMLElement} element
 * @param {{ keyframes: Keyframe[], easing: string, fill?: FillMode }[]} effects
 * @param {{ onFinish?: (() => void)|null, onEnd?: (() => void)|null }} [callbacks]
 */
function playTogether(element, effects, { onFinish = null, onEnd = null } = {}) {
    stopNotificationMotion(element);
    if (typeof element.animate !== 'function' || !element.isConnected) {
        onFinish?.();
        onEnd?.();
        return;
    }
    const animations = effects.map(({ keyframes, easing, fill }) => element.animate(keyframes, { duration: MOTION_NOTIFICATION, easing, fill }));
    let ended = false;
    const end = () => {
        if (!ended) {
            ended = true;
            playing.delete(element);
            onEnd?.();
        }
    };
    const record = {
        animations,
        cancel() {
            end();
            for (const animation of animations) {
                animation.cancel();
            }
        },
    };
    playing.set(element, record);
    for (const animation of animations) {
        animation.oncancel = () => {
            if (playing.get(element) === record) {
                end();
            }
        };
    }
    Promise.all(animations.map(animation => animation.finished)).then(() => {
        if (playing.get(element) !== record) {
            return;
        }
        // The end state is committed before the fill is dropped, in one task, so nothing flashes.
        onFinish?.();
        end();
        for (const animation of animations) {
            animation.cancel();
        }
    }).catch(() => {});
}

/**
 * How far the notification is from its place when it starts and ends: one height, beyond the edge it sits at.
 * `offsetHeight` is the layout height, which a scale that is running does not change.
 */
function slideOffset(element, edge) {
    const height = element.offsetHeight || element.getBoundingClientRect().height || 0;
    return edge === 'bottom' ? height : -height;
}

/**
 * GNOME Shell's banner comes in over 200ms: opacity with ease-out-quad, and, at the same time, a slide from one height
 * beyond its edge and a scale from 0.9 about its centre with ease-out-back. Under reduced motion it fades.
 * @param {HTMLElement} element
 * @param {'top'|'bottom'} edge
 * @param {{ complete?: (() => void)|null }} [callbacks]
 */
export function playNotificationEnter(element, edge, { complete = null } = {}) {
    const fade = { keyframes: [{ opacity: 0 }, { opacity: 1 }], easing: MOTION_EASE_OUT_QUAD };
    const effects = prefersReducedMotion()
        ? [fade]
        : [fade, { keyframes: [{ transform: `translateY(${slideOffset(element, edge)}px) scale(0.9)` }, { transform: 'none' }], easing: MOTION_EASE_OUT_BACK }];
    playTogether(element, effects, { onFinish: complete });
}

/**
 * It leaves over 200ms: opacity and a slide back by its own height, both with ease-out-back, and no scale. Under
 * reduced motion it fades.
 * @param {HTMLElement} element
 * @param {'top'|'bottom'} edge
 * @param {{ onFinish?: (() => void)|null, onEnd?: (() => void)|null }} callbacks
 */
export function playNotificationLeave(element, edge, { onFinish = null, onEnd = null } = {}) {
    const reduced = prefersReducedMotion();
    const effects = [{ keyframes: [{ opacity: 1 }, { opacity: 0 }], easing: reduced ? MOTION_EASE_OUT_QUAD : MOTION_EASE_OUT_BACK, fill: /** @type {FillMode} */ ('forwards') }];
    if (!reduced) {
        effects.push({ keyframes: [{ transform: 'none' }, { transform: `translateY(${slideOffset(element, edge)}px)` }], easing: MOTION_EASE_OUT_BACK, fill: 'forwards' });
    }
    playTogether(element, effects, { onFinish, onEnd });
}

/** The top of a child in layout px from the window: a transform that is running does not move it. */
function layoutTop(child, container) {
    return container.getBoundingClientRect().top + child.offsetTop;
}

/**
 * Runs a change that moves the other notifications of the stack (one comes, one goes) and slides each of them from its
 * old place to its new one over 200ms with ease-out-quad. Only position moves. The slide uses the `translate`
 * property, which adds to the `transform` of an enter or leave that may be running.
 * @param {HTMLElement} element The notification that comes or goes. It does not take part in the slide.
 * @param {() => void} change
 */
export function shiftOthersAround(element, change) {
    const container = element.parentElement;
    if (!container || prefersReducedMotion() || typeof element.animate !== 'function') {
        change();
        return;
    }
    const before = new Map([...container.children]
        .filter(child => child !== element && child instanceof HTMLElement && child.getClientRects().length > 0)
        .map(child => [child, layoutTop(/** @type {HTMLElement} */ (child), container)]));
    change();
    for (const [child, top] of before) {
        const delta = top - layoutTop(/** @type {HTMLElement} */ (child), container);
        if (child.isConnected && Math.abs(delta) >= 1) {
            child.animate([{ translate: `0 ${delta}px` }, { translate: '0 0' }], { duration: MOTION_NOTIFICATION, easing: MOTION_EASE_OUT_QUAD, composite: 'add' });
        }
    }
}
