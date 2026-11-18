/*
 * SillyBunny toast motion and queue (AdwToast, AdwToastOverlay).
 * Upstream toastr animates with jQuery fadeIn/fadeOut (script.js toastr.options). Instead of editing
 * that file, this registers jQuery methods that use the shared WAAPI helpers and points toastr at
 * them, re-applying the names whenever upstream reassigns toastr.options.
 *
 * The queue wraps toastr.info/success/warning/error. A toast that times out is created at once, so the
 * jQuery element that the caller receives is always real, but it stays hidden (display: none, no hide timer)
 * until it is its turn. A toast that never times out (timeOut 0: progress and persistent states) is not queued:
 * it would hold every error behind it for as long as it stays.
 */

import { MOTION_EASE, MOTION_EASE_OUT_CUBIC, MOTION_SURFACE, play, stopMotion } from './sillybunny-motion.js';

export const TOAST_SHOW_METHOD = 'sbToastIn';
export const TOAST_HIDE_METHOD = 'sbToastOut';
export const TOAST_LEAVING_CLASS = 'sb-toast-leaving';

export const TOAST_HOLD_METHOD = 'sbToastHold';
/** libadwaita's REPLACE_DURATION: how long a toast takes to show while another one is still leaving. */
export const TOAST_REPLACE_DURATION = 500;
/** Waiting toasts above this number drop the oldest info or success toast. Errors and warnings are never dropped. */
export const TOAST_MAX_WAITING = 6;

const NOTIFIER_TYPES = ['info', 'success', 'warning', 'error'];
const DEFAULT_TIME_OUT = 5000;
const DEFAULT_EXTENDED_TIME_OUT = 1000;
const WAITING = 'waiting';
const SHOWN = 'shown';

const leaving = new WeakSet();
let initialized = false;

/**
 * @typedef {object} QueuedToast
 * @property {any} $toast The jQuery element toastr returned.
 * @property {HTMLElement} element
 * @property {Record<string, any>} options The options object that toastr's own closures read.
 * @property {string} type
 * @property {string|null} key Same type, title and message, for collapsing repeats. Null when a repeat is not a duplicate.
 * @property {string} state
 * @property {boolean} resumed True once the toast was shown and pushed back by a high-priority toast.
 * @property {string} showMethod
 * @property {number} timeOut
 * @property {number} extendedTimeOut
 * @property {Function|undefined} onShown
 */

/** @type {WeakMap<HTMLElement, QueuedToast>} */
const queued = new WeakMap();
/** @type {QueuedToast[]} */
let waiting = [];
/** @type {QueuedToast|null} */
let current = null;
/** How many toasts are playing their leave animation. */
let hiding = 0;
let promotionScheduled = false;
let queueEnabled = true;
let capturedOptions = null;
let userListener = null;
let subscribeHooked = false;

function getToastElement(collection) {
    const element = collection?.[0];
    return element instanceof HTMLElement ? element : null;
}

function isHidden(element) {
    return element.style.display === 'none';
}

function enterOffset(element) {
    const height = element.getBoundingClientRect().height || 0;
    // Bottom-anchored containers rise from below; the rest drop in from above.
    const fromBelow = /\btoast-bottom-/.test(element.parentElement?.className ?? '');
    return `${fromBelow ? height : -height}px`;
}

function showDuration() {
    return hiding > 0 ? TOAST_REPLACE_DURATION : MOTION_SURFACE;
}

function enter(element, complete) {
    element.style.removeProperty('display');
    play(element, [
        { opacity: 0, transform: `translateY(${enterOffset(element)})` },
        { opacity: 1, transform: 'none' },
    ], {
        duration: showDuration(),
        easing: MOTION_EASE,
        onFinish: () => complete?.call(element),
    });
}

/** toastr calls this as `$toast[showMethod]({ duration, easing, complete })`, and again on hover. */
function sbToastIn({ complete } = {}) {
    const element = getToastElement(this);
    if (!element) {
        complete?.();
        return this;
    }

    if (leaving.has(element)) {
        // Hovering a toast while it leaves keeps it, like toastr's stop(true, true) + fadeIn.
        leaving.delete(element);
        stopMotion(element);
        element.classList.remove(TOAST_LEAVING_CLASS);
        unpin(element);
        const entry = queued.get(element);
        if (entry && !current) {
            current = entry;
        }
        complete?.call(element);
        return this;
    }
    if (!isHidden(element)) {
        complete?.call(element);
        return this;
    }

    enter(element, complete);
    return this;
}

/** The method of a toast that waits: toastr has hidden the element and the queue shows it later. */
function sbToastHold() {
    return this;
}

function leave(element, { pinned = false, complete = null } = {}) {
    leaving.add(element);
    element.classList.add(TOAST_LEAVING_CLASS);
    if (pinned) {
        pin(element);
    }
    hiding += 1;
    play(element, [
        { opacity: 1, transform: 'none' },
        { opacity: 0, transform: 'scale(0.95)' },
    ], {
        duration: MOTION_SURFACE,
        easing: MOTION_EASE_OUT_CUBIC,
        fill: 'forwards',
        onFinish: () => {
            leaving.delete(element);
            // toastr's removeToast() skips elements that are still :visible.
            element.style.display = 'none';
            complete?.call(element);
        },
        onEnd: () => {
            hiding -= 1;
        },
    });
}

/** toastr calls this as `$toast[hideMethod]({ duration, easing, complete })` and removes the toast in `complete`. */
function sbToastOut({ complete } = {}) {
    const element = getToastElement(this);
    if (!element) {
        complete?.();
        return this;
    }
    if (leaving.has(element)) {
        return this;
    }

    const entry = queued.get(element);
    if (entry?.state === WAITING) {
        // A toast that never showed has nothing to animate. toastr removes it in `complete`.
        waiting = waiting.filter(other => other !== entry);
        element.style.display = 'none';
        complete?.call(element);
        return this;
    }

    const wasCurrent = entry !== undefined && entry === current;
    if (wasCurrent) {
        current = null;
    }
    // The next toast shows in the place of this one while this one fades, so this one is taken out of the flow first.
    leave(element, { pinned: wasCurrent && waiting.length > 0, complete });
    if (wasCurrent) {
        scheduleNext();
    }
    return this;
}

// The queue

const PINNED_PROPERTIES = ['position', 'top', 'left', 'width', 'margin'];

/** Takes a leaving toast out of the flow at the place it has, so the toast that replaces it does not move it. */
function pin(element) {
    const { offsetTop, offsetLeft, offsetWidth } = element;
    Object.assign(element.style, {
        position: 'absolute',
        top: `${offsetTop}px`,
        left: `${offsetLeft}px`,
        width: `${offsetWidth}px`,
        margin: '0',
    });
}

function unpin(element) {
    for (const property of PINNED_PROPERTIES) {
        element.style.removeProperty(property);
    }
}

function isHeld(element) {
    return element.matches(':hover') || element.contains(element.ownerDocument.activeElement);
}

function pruneDetached() {
    waiting = waiting.filter(entry => entry.element.isConnected);
    if (current && !current.element.isConnected) {
        current = null;
    }
}

/**
 * Starts the hide timer of a toast that was created without one. toastr starts it only while it shows the toast, and
 * keeps no handle to it outside its closures, so this runs the handler of a pointer that leaves the toast with the
 * timeout as the extended timeout.
 * @param {QueuedToast} entry
 */
function startHideTimer(entry) {
    const { options, $toast } = entry;
    if (!(entry.timeOut > 0)) {
        return;
    }
    if (options.closeOnHover === false) {
        // Without hover handlers there is nothing to run, so the timer is the module's own.
        setTimeout(() => globalThis.toastr.clear($toast), entry.timeOut);
        return;
    }
    const extended = options.extendedTimeOut;
    options.extendedTimeOut = entry.timeOut;
    $toast.triggerHandler('mouseleave');
    options.extendedTimeOut = extended;
}

/** @param {QueuedToast} entry */
function activate(entry) {
    const { options, $toast, element } = entry;
    current = entry;
    entry.state = SHOWN;
    options.showMethod = entry.showMethod;
    options.timeOut = entry.timeOut;
    leaving.delete(element);
    stopMotion(element);
    element.classList.remove(TOAST_LEAVING_CLASS);
    unpin(element);
    // A toast that was pushed back by a high-priority toast already ran onShown.
    $toast[entry.showMethod]({ complete: entry.resumed ? undefined : entry.onShown });
    startHideTimer(entry);
}

function showNext() {
    promotionScheduled = false;
    pruneDetached();
    if (current) {
        return;
    }
    const next = waiting.shift();
    if (next) {
        activate(next);
    }
}

/**
 * Shows the next toast after the current task. `toastr.clear()` hides every toast in one loop, and a toast that was
 * promoted inside that loop would show for a moment and be cleared again.
 */
function scheduleNext() {
    if (promotionScheduled) {
        return;
    }
    promotionScheduled = true;
    queueMicrotask(showNext);
}

/** Puts the shown toast back at the head of the queue and stops its hide timer. */
function pushBack(entry) {
    current = null;
    // The handler of a pointer that enters the toast clears its hide timer.
    entry.$toast.triggerHandler('mouseenter');
    entry.state = WAITING;
    entry.resumed = true;
    waiting.unshift(entry);
    const { element } = entry;
    leaving.add(element);
    element.classList.add(TOAST_LEAVING_CLASS);
    pin(element);
    hiding += 1;
    play(element, [
        { opacity: 1, transform: 'none' },
        { opacity: 0, transform: 'scale(0.95)' },
    ], {
        duration: MOTION_SURFACE,
        easing: MOTION_EASE_OUT_CUBIC,
        fill: 'forwards',
        onFinish: () => {
            leaving.delete(element);
            element.style.display = 'none';
        },
        onEnd: () => {
            hiding -= 1;
        },
    });
}

/**
 * A toast with a button, such as an Undo, or one that asks for it with `priority: 'high'`. The buttons of this app's
 * toasts are in the markup of a message that is not escaped, as a string, a jQuery object or a node.
 */
function isHighPriority(message, options) {
    if (options.priority === 'high') {
        return true;
    }
    const buttons = 'button, [role="button"]';
    const root = message?.jquery ? message[0] : message;
    if (typeof root === 'string') {
        return options.escapeHtml === false && /<button[\s>]|role=["']button["']/i.test(root);
    }
    return root instanceof Element && (root.matches(buttons) || root.querySelector(buttons) !== null);
}

function duplicateKey(type, title, message, options, high) {
    // With preventDuplicates, toastr answers a repeat itself, and a caller may read that answer.
    if (high || typeof message !== 'string' || options.onclick || options.onShown || options.preventDuplicates) {
        return null;
    }
    return `${type}\u0000${title ?? ''}\u0000${message}`;
}

function dropWaiting(entry) {
    waiting = waiting.filter(other => other !== entry);
    globalThis.toastr.remove(entry.$toast);
    entry.options.onHidden?.();
}

/** Keeps the waiting toasts to a number that a user can read through: the oldest info or success toast goes first. */
function trimWaiting() {
    while (waiting.length > TOAST_MAX_WAITING) {
        const oldest = waiting.find(entry => !entry.resumed && (entry.type === 'info' || entry.type === 'success'));
        if (!oldest) {
            return;
        }
        dropWaiting(oldest);
    }
}

/** An error goes ahead of the toasts that are not errors, so a long queue of notices does not hide it. */
function insertWaiting(entry) {
    if (entry.type === 'error') {
        const index = waiting.findIndex(other => !other.resumed && other.type !== 'error');
        if (index !== -1) {
            waiting.splice(index, 0, entry);
            return;
        }
    }
    waiting.push(entry);
}

/** Calls toastr's own function and returns the element with the options object that toastr's closures read. */
function createToast(original, args) {
    capturedOptions = null;
    const $toast = original(...args);
    const options = capturedOptions;
    capturedOptions = null;
    return { $toast, options };
}

function toastEntry(type, message, title, effective, high, { $toast, options }) {
    const element = $toast[0];
    /** @type {QueuedToast} */
    const entry = {
        $toast,
        element,
        options,
        type,
        key: duplicateKey(type, title, message, effective, high),
        state: SHOWN,
        resumed: false,
        showMethod: effective.showMethod ?? TOAST_SHOW_METHOD,
        timeOut: Number(effective.timeOut ?? DEFAULT_TIME_OUT),
        extendedTimeOut: Number(effective.extendedTimeOut ?? DEFAULT_EXTENDED_TIME_OUT),
        onShown: effective.onShown,
    };
    queued.set(element, entry);
    return entry;
}

function wrapNotifier(toastr, type) {
    if (typeof toastr[type] !== 'function') {
        return;
    }
    const original = toastr[type].bind(toastr);
    toastr[type] = function (message, title, optionsOverride) {
        const args = [message, title, optionsOverride];
        const effective = { ...toastr.options, ...optionsOverride };
        if (!queueEnabled || !(Number(effective.timeOut) > 0)) {
            return original(...args);
        }

        pruneDetached();
        const high = isHighPriority(message, effective);
        const key = duplicateKey(type, title, message, effective, high);
        if (key !== null) {
            if (current?.key === key) {
                // The same toast is on screen already, so the repeat only keeps it for another timeout. A toast that
                // is hovered or has focus inside holds itself, and toastr starts its timer again when it is let go.
                if (!isHeld(current.element)) {
                    current.$toast.triggerHandler('mouseenter');
                    startHideTimer(current);
                }
                return current.$toast;
            }
            const repeat = waiting.find(entry => entry.key === key);
            if (repeat) {
                return repeat.$toast;
            }
        }

        const busy = current !== null || waiting.length > 0;
        if (!busy || high) {
            if (current) {
                pushBack(current);
            }
            const created = createToast(original, args);
            if (!created.$toast) {
                return created.$toast;
            }
            if (!created.options) {
                // Nothing told toastr's options to this module, so this toast cannot be queued, and no later one can.
                queueEnabled = false;
                return created.$toast;
            }
            current = toastEntry(type, message, title, effective, high, created);
            return created.$toast;
        }

        const created = createToast(original, [message, title, {
            ...optionsOverride,
            showMethod: TOAST_HOLD_METHOD,
            timeOut: 0,
            onShown: () => {},
        }]);
        if (!created.$toast) {
            return created.$toast;
        }
        if (!created.options) {
            queueEnabled = false;
            return created.$toast;
        }
        const entry = toastEntry(type, message, title, effective, false, created);
        entry.state = WAITING;
        insertWaiting(entry);
        trimWaiting();
        if (!current) {
            scheduleNext();
        }
        return created.$toast;
    };
}

/**
 * toastr hands the options object of a toast to its listener, and nothing else reaches it. The queue needs that object
 * to start the hide timer of a toast later, so it listens first and passes every event on to the listener that the app
 * sets. This has to run before the app calls toastr.subscribe.
 */
function hookSubscribe(toastr) {
    if (subscribeHooked || typeof toastr?.subscribe !== 'function') {
        return;
    }
    subscribeHooked = true;
    const subscribe = toastr.subscribe.bind(toastr);
    subscribe((args) => {
        if (args.state === 'visible') {
            capturedOptions = args.options;
        }
        userListener?.(args);
    });
    toastr.subscribe = (listener) => {
        userListener = listener;
    };
}

/** The shown toast and the waiting ones, in the order they show. */
export function getToastQueue() {
    pruneDetached();
    return { current: current?.element ?? null, waiting: waiting.map(entry => entry.element) };
}

export function resetToastQueue() {
    waiting = [];
    current = null;
    hiding = 0;
    promotionScheduled = false;
    queueEnabled = true;
}

if (globalThis.toastr) {
    hookSubscribe(globalThis.toastr);
}

function applyMotionOptions(options) {
    if (options && typeof options === 'object') {
        options.showMethod = TOAST_SHOW_METHOD;
        options.hideMethod = TOAST_HIDE_METHOD;
        options.showDuration = MOTION_SURFACE;
        options.hideDuration = MOTION_SURFACE;
    }
    return options;
}

/**
 * A finger on a toast holds it like a pointer over it does. Touch sends no hover while the finger is down (the
 * compatibility mouse events come after the release), so the press runs toastr's own hover handlers. A mouse
 * already holds the toast by hovering it.
 */
function holdWhilePressed(jQuery, document) {
    if (!document?.addEventListener) {
        return;
    }
    let pressed = null;
    const release = () => {
        pressed?.triggerHandler('mouseleave');
        pressed = null;
    };
    document.addEventListener('pointerdown', (event) => {
        if (event.pointerType === 'mouse' || !(event.target instanceof Element)) {
            return;
        }
        const element = event.target.closest('#toast-container .toast');
        if (!element) {
            return;
        }
        release();
        pressed = jQuery(element);
        pressed.triggerHandler('mouseenter');
    }, true);
    document.addEventListener('pointerup', release, true);
    document.addEventListener('pointercancel', release, true);
}

export function initializeToastMotion({ jQuery = globalThis.jQuery, toastr = globalThis.toastr } = {}) {
    if (initialized || !jQuery?.fn || !toastr) {
        return;
    }
    initialized = true;
    jQuery.fn[TOAST_SHOW_METHOD] = sbToastIn;
    jQuery.fn[TOAST_HIDE_METHOD] = sbToastOut;
    jQuery.fn[TOAST_HOLD_METHOD] = sbToastHold;
    hookSubscribe(toastr);
    holdWhilePressed(jQuery, globalThis.document);
    for (const type of NOTIFIER_TYPES) {
        wrapNotifier(toastr, type);
    }

    // script.js assigns a fresh toastr.options after an awaited page load, so catch reassignment.
    let options = applyMotionOptions(toastr.options ?? {});
    Object.defineProperty(toastr, 'options', {
        configurable: true,
        enumerable: true,
        get: () => options,
        set: value => {
            options = applyMotionOptions(value);
        },
    });
}
