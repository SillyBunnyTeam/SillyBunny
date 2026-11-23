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

/** The row that holds a run of buttons of the message: CSS lays it out as the button row. */
export const ACTIONS_CLASS = 'sb-toast-actions';
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

/** The buttons that follow `first` with nothing but whitespace between them, and the whitespace between them. */
function runFrom(first) {
    const run = [first];
    let pending = [];
    for (let next = first.nextSibling; next; next = next.nextSibling) {
        if (isWhitespaceText(next)) {
            pending.push(next);
        } else if (next instanceof Element && next.matches(BUTTON_SELECTOR)) {
            run.push(...pending, next);
            pending = [];
        } else {
            break;
        }
    }
    return run;
}

/**
 * Puts each run of buttons of the message in a row of its own, in the place of the run. The row is inside the element
 * that held the buttons, so the buttons stay descendants of every ancestor that the caller gave them: handlers bound on
 * a button and handlers that an ancestor delegates keep working. Only a selector that needs the button to be a direct
 * child of its old parent no longer matches. It can run again after the caller changes the content.
 * @param {Element} message The `.toast-message` element.
 */
export function arrangeButtons(message) {
    for (const row of message.querySelectorAll(`.${ACTIONS_CLASS}`)) {
        if (!row.querySelector(BUTTON_SELECTOR)) {
            row.remove();
        }
    }
    for (const button of outermostButtons(message)) {
        if (button.parentElement?.classList.contains(ACTIONS_CLASS)) {
            continue;
        }
        const row = message.ownerDocument.createElement('div');
        row.className = ACTIONS_CLASS;
        button.before(row);
        row.append(...runFrom(button));
    }
}

/** @type {WeakMap<Element, MutationObserver>} */
const notificationButtonObservers = new WeakMap();

/**
 * Stops watching a notification for dynamic button changes.
 * @param {Element | null | undefined} element
 */
export function unwatchButtons(element) {
    if (!element) {
        return;
    }
    const observer = notificationButtonObservers.get(element);
    if (observer) {
        observer.disconnect();
        notificationButtonObservers.delete(element);
    }
}

/**
 * Arranges the buttons of a notification now and whenever a caller changes its content.
 * @param {HTMLElement} element The notification.
 * @returns {() => void} Stops observing the notification.
 */
export function watchButtons(element) {
    unwatchButtons(element);
    const arrange = () => {
        const message = element.querySelector(':scope > .toast-message');
        if (message) {
            arrangeButtons(message);
        }
    };
    arrange();
    if (typeof MutationObserver !== 'function') {
        return () => {};
    }
    const observer = new MutationObserver(() => {
        if (!element.isConnected) {
            unwatchButtons(element);
            return;
        }
        arrange();
        // Moving the buttons into a row is a change too, and must not start the next round.
        observer.takeRecords();
    });
    observer.observe(element, { childList: true, subtree: true });
    notificationButtonObservers.set(element, observer);
    return () => unwatchButtons(element);
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
 * How long the card waits before a click on it acts, in ms. The first click of a double click, which selects a word, and of a
 * triple click, which selects a paragraph, is a click on the card too, and the card must not go with the word. A click that
 * a second click or a selection follows within this time does nothing; a double click that is slower than this still
 * dismisses the card.
 */
export const CARD_CLICK_DELAY = 250;

/**
 * Whether a click on the card does anything: the message's `onclick` runs and the notification goes, or it just goes.
 * A message with `tapToDismiss: false` and no `onclick` is not clickable.
 * @param {Record<string, any>} options The options object that toastr's closures read.
 */
function cardClickActs(options) {
    return typeof options.onclick === 'function' || options.tapToDismiss !== false;
}

/**
 * Replaces toastr's click handlers on the card. toastr binds them to the whole card, so a press on a button or a link
 * dismissed the notification as well. Here a click outside every control acts, as GNOME Shell activates a banner, after
 * `CARD_CLICK_DELAY`, so that a double click and a selection to copy the text do not count as a click. The action runs at
 * most once, and not on a card that is leaving.
 * @param {any} $toast
 * @param {{ options: Record<string, any>, dismiss: () => void, isLeaving: () => boolean }} parts
 */
export function bindCardClick($toast, { options, dismiss, isLeaving }) {
    const element = $toast[0];
    const acts = cardClickActs(options);
    $toast.off('click');
    element.classList.toggle('interactable', acts);
    element.classList.toggle('toast-non-interactable', !acts);
    if (!acts) {
        element.removeAttribute('title');
        return;
    }
    let timer = 0;
    let acted = false;
    let lastClick = null;
    const act = () => {
        timer = 0;
        if (acted || isLeaving() || !element.isConnected || hasSelectedText(element)) {
            return;
        }
        acted = true;
        if (typeof options.onclick === 'function') {
            options.onclick(lastClick);
        }
        dismiss();
    };
    $toast.on('click', (event) => {
        const control = event.target instanceof Element ? event.target.closest(CONTROL_SELECTOR) : null;
        if (control && element.contains(control)) {
            return;
        }
        clearTimeout(timer);
        timer = 0;
        const isLaterClickOfMany = (event.originalEvent?.detail ?? event.detail ?? 0) > 1;
        if (isLaterClickOfMany || hasSelectedText(element)) {
            return;
        }
        lastClick = event;
        timer = setTimeout(act, CARD_CLICK_DELAY);
    });
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
