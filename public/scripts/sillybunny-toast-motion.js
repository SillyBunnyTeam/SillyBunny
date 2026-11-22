/*
 * SillyBunny toast motion and queues (AdwToast, AdwToastOverlay).
 * Upstream toastr animates with jQuery fadeIn/fadeOut (script.js toastr.options). Instead of editing
 * that file, this registers jQuery methods that use the shared WAAPI helpers and points toastr at
 * them, re-applying the names whenever upstream reassigns toastr.options.
 *
 * The wrapper of toastr.info/success/warning/error makes every toast hidden and held, so the jQuery element that
 * the caller receives is always real, and decides its form on that element (sillybunny-toast-form.js). A toast moves
 * into #sb-toast-overlay, an in-app notification stays in toastr's own #toast-container. Each form has a queue of its
 * own. A message that waits stays hidden, with no hide timer, until it is its turn. A toast that a caller made to
 * stay (timeOut 0: progress and persistent states) is never held back, because it would hold every later message
 * behind it for as long as it stays.
 *
 * A toast moves as libadwaita's AdwToastOverlay moves it: in, it slides out of the edge it sits at (that edge clips it,
 * see the overlay's clip-path), with no fade; out, it fades and scales to 0.95. An in-app notification keeps its fade
 * and slide until its own motion is drawn. Under reduced motion a toast fades.
 */

import { MOTION_EASE, MOTION_EASE_OUT_CUBIC, MOTION_SURFACE, play, stopMotion } from './sillybunny-motion.js';
import { getTopmostDialog } from './sillybunny-editor/overlay-host.js';
import {
    BUTTON_SELECTOR,
    NOTIFICATION_FORM,
    NOTIFICATION_FORM_CLASS,
    NOTIFICATION_MAX_SHOWN,
    NOTIFICATION_TIMEOUT,
    TOAST_FORM,
    TOAST_FORM_CLASS,
    TOAST_MEASURE_CLASS,
    TOAST_OVERLAY_ID,
    classifyToast,
} from './sillybunny-toast-form.js';
import { IN_DIALOG_ATTRIBUTE, edgeOf, observeToastPlacement, scheduleToastPlacement, startToastPlacement, updateToastPlacement } from './sillybunny-toast-placement.js';

export const TOAST_SHOW_METHOD = 'sbToastIn';
export const TOAST_HIDE_METHOD = 'sbToastOut';
export const TOAST_LEAVING_CLASS = 'sb-toast-leaving';
/** On a toast that holds exactly one button, so its styles can put the button at the end of the text. */
export const TOAST_ACTION_CLASS = 'sb-toast--action';

export const TOAST_HOLD_METHOD = 'sbToastHold';
/** libadwaita's REPLACE_DURATION: how long a toast takes to show while another one is still leaving. */
export const TOAST_REPLACE_DURATION = 500;
/** Waiting messages above this number drop the oldest info or success one. Errors and warnings are never dropped. */
export const TOAST_MAX_WAITING = 6;

const NOTIFIER_TYPES = ['info', 'success', 'warning', 'error'];
const DEFAULT_TIME_OUT = 5000;
const DEFAULT_EXTENDED_TIME_OUT = 1000;
const WAITING = 'waiting';
const SHOWN = 'shown';
/** The id that toastr gives its container. In-app notifications stay in it, because readers and styles look there. */
const NOTIFICATION_CONTAINER_ID = 'toast-container';
/**
 * toastr builds the selector of a container as `'#' + containerId`, so this id makes `$container` hold both containers.
 * toastr checks that one object for being empty after each removal, and `preventDuplicates` forgets the last message
 * then, so it has to be empty only when no toast is left in either container.
 */
const BOTH_CONTAINERS_ID = `${NOTIFICATION_CONTAINER_ID}, #${TOAST_OVERLAY_ID}`;
const DISMISS_LABEL = 'Dismiss';
const POSITION_CLASSES = [
    'toast-top-left',
    'toast-top-center',
    'toast-top-right',
    'toast-bottom-left',
    'toast-bottom-center',
    'toast-bottom-right',
];

const leaving = new WeakSet();
let initialized = false;

/**
 * @typedef {object} QueuedToast
 * @property {any} $toast The jQuery element toastr returned.
 * @property {HTMLElement} element
 * @property {Record<string, any>} options The options object that toastr's own closures read.
 * @property {string} type
 * @property {string} form
 * @property {string|null} key Same type, title and message, for collapsing repeats. Null when a repeat is not a duplicate.
 * @property {string} state
 * @property {boolean} high The message asked to show at once.
 * @property {boolean} persistent The caller made it stay with a timeOut of 0. It shows at once and is not in a queue.
 * @property {boolean} resumed True once the toast was shown and pushed back by a high-priority toast.
 * @property {string} showMethod
 * @property {number} timeOut
 * @property {number} extendedTimeOut
 * @property {Function|undefined} onShown
 * @property {Animation|undefined} [progress] The running animation of the progress bar.
 * @property {boolean} [progressBound] True once the hover handlers of the progress bar are bound.
 * @property {boolean} [startingTimer] True while startHideTimer runs the hover handler of toastr.
 */

/**
 * @typedef {object} FormQueue
 * @property {string} form
 * @property {number} capacity How many messages show at once.
 * @property {(entry: QueuedToast) => boolean} canPushBack Whether a high-priority message may take the place of this one.
 * @property {QueuedToast[]} shown In the order they were shown.
 * @property {QueuedToast[]} waiting In the order they show.
 * @property {number} hiding How many messages of this form play their leave animation.
 * @property {boolean} promotionScheduled
 */

/** @type {WeakMap<HTMLElement, QueuedToast>} */
const queued = new WeakMap();

/** @returns {FormQueue} */
function createQueue(form, capacity, canPushBack) {
    return { form, capacity, canPushBack, shown: [], waiting: [], hiding: 0, promotionScheduled: false };
}

const queues = {
    // One toast at a time, as in libadwaita. A high-priority toast takes the place of the shown one, whatever it is.
    [TOAST_FORM]: createQueue(TOAST_FORM, 1, () => true),
    [NOTIFICATION_FORM]: createQueue(NOTIFICATION_FORM, NOTIFICATION_MAX_SHOWN, entry => !entry.high),
};
const allQueues = Object.values(queues);

let queueEnabled = true;
let capturedOptions = null;
let userListener = null;
let subscribeHooked = false;
let toastrApi = null;
let measureOverride = null;
let translateLabel = text => text;
let toastPosition = 'toast-bottom-center';
let notificationPosition = 'toast-top-center';
let uncapturedLogged = false;
/**
 * The two containers as last seen. A dialog that is removed takes the containers that it holds out of the document,
 * and these references find them again, so that no message is lost with the dialog.
 * @type {{ overlay: HTMLElement|null, notifications: HTMLElement|null }}
 */
const seen = { overlay: null, notifications: null };

function getToastElement(collection) {
    const element = collection?.[0];
    return element instanceof HTMLElement ? element : null;
}

function isHidden(element) {
    return element.style.display === 'none';
}

/** A toast without a form marker is one that toastr made without this wrapper, which sits in #toast-container. */
function queueOf(element) {
    return element.classList.contains(TOAST_FORM_CLASS) ? queues[TOAST_FORM] : queues[NOTIFICATION_FORM];
}

/** @returns {'top'|'bottom'} The edge that the toast's container sits at. */
function edgeOfToast(element) {
    const container = element.parentElement;
    return edgeOf(container?.className ?? '', container?.hasAttribute(IN_DIALOG_ATTRIBUTE) === true);
}

/** A notification enters from the edge its container sits at, by its own height, and fades in. */
function notificationEnterOffset(element) {
    const height = element.getBoundingClientRect().height || 0;
    return `${edgeOfToast(element) === 'bottom' ? height : -height}px`;
}

/**
 * A toast starts fully beyond the edge it sits at: libadwaita offsets it by the height of its widget, which includes
 * the margins, and the edge clips it. The margin box is read from the computed style because the margins differ at
 * the edge and elsewhere.
 */
function toastEnterOffset(element) {
    const { marginTop, marginBottom } = getComputedStyle(element);
    const height = (element.getBoundingClientRect().height || 0) + (parseFloat(marginTop) || 0) + (parseFloat(marginBottom) || 0);
    return `${edgeOfToast(element) === 'bottom' ? height : -height}px`;
}

function isToastForm(element) {
    return element.classList.contains(TOAST_FORM_CLASS);
}

const FADE_IN = [{ opacity: 0 }, { opacity: 1 }];
const FADE_OUT = [{ opacity: 1 }, { opacity: 0 }];

function showDuration(element) {
    return queueOf(element).hiding > 0 ? TOAST_REPLACE_DURATION : MOTION_SURFACE;
}

function enter(element, complete) {
    element.style.removeProperty('display');
    const toast = isToastForm(element);
    const keyframes = toast
        ? [{ transform: `translateY(${toastEnterOffset(element)})` }, { transform: 'none' }]
        : [{ opacity: 0, transform: `translateY(${notificationEnterOffset(element)})` }, { opacity: 1, transform: 'none' }];
    play(element, keyframes, {
        duration: showDuration(element),
        easing: MOTION_EASE,
        reducedKeyframes: toast ? FADE_IN : null,
        onFinish: () => complete?.call(element),
    });
}

/** The leave animation of both forms and of a toast that a high-priority toast pushes back: a fade and a scale to 0.95. */
function playLeave(element, { onFinish, onEnd }) {
    play(element, [
        { opacity: 1, transform: 'none' },
        { opacity: 0, transform: 'scale(0.95)' },
    ], {
        duration: MOTION_SURFACE,
        easing: MOTION_EASE_OUT_CUBIC,
        fill: 'forwards',
        reducedKeyframes: isToastForm(element) ? FADE_OUT : null,
        onFinish,
        onEnd,
    });
}

/** A toast that a pointer saved while it left is on screen again, so it takes a place in its queue if one is free. */
function keepShown(entry) {
    const queue = entry && queues[entry.form];
    if (queue && !queue.shown.includes(entry) && queue.shown.length < queue.capacity) {
        queue.shown.push(entry);
    }
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
        keepShown(queued.get(element));
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
    const queue = queueOf(element);
    leaving.add(element);
    element.classList.add(TOAST_LEAVING_CLASS);
    if (pinned) {
        pin(element);
    }
    queue.hiding += 1;
    playLeave(element, {
        onFinish: () => {
            leaving.delete(element);
            // toastr's removeToast() skips elements that are still :visible.
            element.style.display = 'none';
            pointToastrAtBothContainers();
            complete?.call(element);
        },
        onEnd: () => {
            queue.hiding -= 1;
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
    const queue = entry ? queues[entry.form] : null;
    if (entry?.state === WAITING) {
        // A toast that never showed has nothing to animate. toastr removes it in `complete`.
        queue.waiting = queue.waiting.filter(other => other !== entry);
        element.style.display = 'none';
        pointToastrAtBothContainers();
        complete?.call(element);
        return this;
    }

    const wasShown = queue !== null && queue.shown.includes(entry);
    if (wasShown) {
        queue.shown = queue.shown.filter(other => other !== entry);
    }
    // The next toast shows in the place of this one while this one fades, so this one is taken out of the flow first.
    leave(element, { pinned: wasShown && queue.waiting.length > 0, complete });
    if (wasShown) {
        scheduleNext(queue);
    }
    return this;
}

// The queues

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
    // A message in a container that left the document with its dialog is not gone yet.
    adoptOrphans();
    for (const queue of allQueues) {
        queue.waiting = queue.waiting.filter(entry => entry.element.isConnected);
        queue.shown = queue.shown.filter(entry => entry.element.isConnected);
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
        setTimeout(() => toastrApi.clear($toast), entry.timeOut);
        return;
    }
    const extended = options.extendedTimeOut;
    options.extendedTimeOut = entry.timeOut;
    // The progress bar listens to the same event, and it starts over the full timeout once this has run.
    entry.startingTimer = true;
    $toast.triggerHandler('mouseleave');
    entry.startingTimer = false;
    options.extendedTimeOut = extended;
}

/**
 * toastr runs the progress bar only while it shows a toast that has a timeout, and every toast is made held, so the
 * bar runs here: down over the timeout, stopped while the toast is held, and down over the extended timeout after it.
 * @param {QueuedToast} entry
 */
function runProgressBar(entry) {
    const { options, element, $toast } = entry;
    if (!options.progressBar || !(entry.timeOut > 0)) {
        return;
    }
    const progressClass = options.progressClass ?? 'toast-progress';
    const bar = [...element.children].find(child => child.classList.contains(progressClass));
    if (typeof bar?.animate !== 'function') {
        return;
    }
    const start = (duration) => {
        entry.progress?.cancel();
        entry.progress = bar.animate([{ width: '100%' }, { width: '0%' }], { duration, easing: 'linear', fill: 'forwards' });
    };
    if (!entry.progressBound) {
        entry.progressBound = true;
        $toast.on('mouseenter', () => entry.progress?.pause());
        $toast.on('mouseleave', () => {
            if (!entry.startingTimer && entry.extendedTimeOut > 0) {
                start(entry.extendedTimeOut);
            }
        });
    }
    start(entry.timeOut);
}

/**
 * Shows a toast that was made held. toastr's closures read the options object, so it gets the real values again.
 * @param {QueuedToast} entry
 */
function show(entry) {
    const { options, $toast, element } = entry;
    options.showMethod = entry.showMethod;
    options.timeOut = entry.timeOut;
    options.extendedTimeOut = entry.extendedTimeOut;
    leaving.delete(element);
    stopMotion(element);
    element.classList.remove(TOAST_LEAVING_CLASS);
    unpin(element);
    // A toast that was pushed back by a high-priority toast already ran onShown.
    $toast[entry.showMethod]({ complete: entry.resumed ? undefined : entry.onShown });
    startHideTimer(entry);
    runProgressBar(entry);
}

/**
 * @param {FormQueue} queue
 * @param {QueuedToast} entry
 */
function activate(queue, entry) {
    queue.shown.push(entry);
    entry.state = SHOWN;
    show(entry);
}

/** @param {FormQueue} queue */
function showNext(queue) {
    queue.promotionScheduled = false;
    pruneDetached();
    while (queue.shown.length < queue.capacity && queue.waiting.length > 0) {
        activate(queue, queue.waiting.shift());
    }
}

/**
 * Shows the next toast after the current task. `toastr.clear()` hides every toast in one loop, and a toast that was
 * promoted inside that loop would show for a moment and be cleared again.
 * @param {FormQueue} queue
 */
function scheduleNext(queue) {
    if (queue.promotionScheduled) {
        return;
    }
    queue.promotionScheduled = true;
    queueMicrotask(() => showNext(queue));
}

/**
 * Puts a shown toast back at the head of its queue and stops its hide timer.
 * @param {FormQueue} queue
 * @param {QueuedToast} entry
 */
function pushBack(queue, entry) {
    queue.shown = queue.shown.filter(other => other !== entry);
    // The handler of a pointer that enters the toast clears its hide timer.
    entry.$toast.triggerHandler('mouseenter');
    entry.state = WAITING;
    entry.resumed = true;
    queue.waiting.unshift(entry);
    const { element } = entry;
    leaving.add(element);
    element.classList.add(TOAST_LEAVING_CLASS);
    pin(element);
    queue.hiding += 1;
    playLeave(element, {
        onFinish: () => {
            leaving.delete(element);
            element.style.display = 'none';
        },
        onEnd: () => {
            queue.hiding -= 1;
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
    // With preventDuplicates, toastr answers a repeat itself, and a caller may read that answer. A toast that never
    // times out is a state that a caller updates, and two of them are not one.
    if (high || typeof message !== 'string' || options.onclick || options.onShown || options.preventDuplicates || !(Number(options.timeOut) > 0)) {
        return null;
    }
    return `${type}\u0000${title ?? ''}\u0000${message}`;
}

/** @returns {{ queue: FormQueue, entry: QueuedToast }|null} The message with this key that is shown or waits, in either form. */
function findDuplicate(key) {
    for (const queue of allQueues) {
        const entry = [...queue.shown, ...queue.waiting].find(other => other.key === key);
        if (entry) {
            return { queue, entry };
        }
    }
    return null;
}

/**
 * The same message is on screen or waits already, so the repeat only keeps it for another timeout. A toast that is
 * hovered or has focus inside holds itself, and toastr starts its timer again when it is let go.
 */
function keepRepeat({ queue, entry }) {
    if (queue.shown.includes(entry) && entry.timeOut > 0 && !isHeld(entry.element)) {
        entry.$toast.triggerHandler('mouseenter');
        startHideTimer(entry);
        runProgressBar(entry);
    }
    return entry.$toast;
}

function dropWaiting(queue, entry) {
    queue.waiting = queue.waiting.filter(other => other !== entry);
    toastrApi.remove(entry.$toast);
    entry.options.onHidden?.();
}

/** Keeps the waiting messages to a number that a user can read through: the oldest info or success one goes first. */
function trimWaiting(queue) {
    while (queue.waiting.length > TOAST_MAX_WAITING) {
        const oldest = queue.waiting.find(entry => !entry.resumed && (entry.type === 'info' || entry.type === 'success'));
        if (!oldest) {
            return;
        }
        dropWaiting(queue, oldest);
    }
}

/** An error goes ahead of the messages that are not errors, so a long queue of notices does not hide it. */
function insertWaiting(queue, entry) {
    if (entry.type === 'error') {
        const index = queue.waiting.findIndex(other => !other.resumed && other.type !== 'error');
        if (index !== -1) {
            queue.waiting.splice(index, 0, entry);
            return;
        }
    }
    queue.waiting.push(entry);
}

/** Makes room for a message that must show at once: the shown message that may be pushed back goes back to the queue. */
function makeRoom(queue) {
    if (queue.shown.length < queue.capacity) {
        return;
    }
    const victim = queue.shown.find(entry => queue.canPushBack(entry));
    if (victim) {
        pushBack(queue, victim);
    }
}

// The two containers

function getOverlay() {
    return document.getElementById(TOAST_OVERLAY_ID);
}

/** A container that was removed together with an ancestor, such as its dialog. One that was removed itself has no parent. */
function isOrphaned(container) {
    return container !== null && !container.isConnected && container.parentElement !== null;
}

/** Puts a container that left the document inside a removed dialog back, or merges its messages into the live one. */
function adoptOrphans() {
    for (const [key, id] of [['overlay', TOAST_OVERLAY_ID], ['notifications', NOTIFICATION_CONTAINER_ID]]) {
        const orphan = seen[key];
        if (!isOrphaned(orphan)) {
            continue;
        }
        const live = document.getElementById(id);
        if (live) {
            live.append(...orphan.children);
        } else {
            (getTopmostDialog() ?? document.body).append(orphan);
        }
        seen[key] = live ?? orphan;
    }
}

/** Both containers are children of `host`. The messages show above a modal dialog only when they are inside it. */
function moveContainersInto(host) {
    const notifications = document.getElementById(NOTIFICATION_CONTAINER_ID);
    for (const container of [getOverlay(), notifications]) {
        if (container && container.parentElement !== host) {
            host.append(container);
        }
    }
    seen.notifications = notifications ?? seen.notifications;
}

/** The hidden clone that the form measure lays out is not a toast. */
function holdsToasts(container) {
    return [...container.children].some(child => !child.classList.contains(TOAST_MEASURE_CLASS));
}

function setPositionClass(container, positionClass) {
    container.classList.remove(...POSITION_CLASSES);
    container.classList.add(positionClass);
}

let containerObserver = null;

/** Watches a container for toasts that leave without the queue knowing, such as a caller that removes its own toast. */
function watchContainer(container) {
    if (typeof MutationObserver !== 'function') {
        return;
    }
    containerObserver ??= new MutationObserver(settleContainers);
    containerObserver.observe(container, { childList: true });
}

function removeOverlayIfEmpty() {
    const overlay = getOverlay();
    if (overlay && !holdsToasts(overlay)) {
        overlay.remove();
    }
}

/** toastr removes its container when it is empty, but the toast that moved out of it did not go through toastr. */
function removeEmptyNotificationContainer() {
    const container = document.getElementById(NOTIFICATION_CONTAINER_ID);
    // A dialog keeps the empty container alive, so the next notification shows inside the dialog and not behind it.
    if (container && !container.hasChildNodes() && getTopmostDialog() === null) {
        container.remove();
    }
}

function settleContainers() {
    pruneDetached();
    for (const queue of allQueues) {
        if (queue.waiting.length > 0) {
            scheduleNext(queue);
        }
    }
    removeOverlayIfEmpty();
    removeEmptyNotificationContainer();
    scheduleToastPlacement();
}

/** The overlay is made when the first toast needs it, and it is in the top open modal dialog or else in the body. */
function ensureOverlay() {
    let overlay = getOverlay();
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = TOAST_OVERLAY_ID;
        overlay.classList.add(toastPosition);
        watchContainer(overlay);
        seen.overlay = overlay;
    }
    const host = getTopmostDialog() ?? document.body;
    if (overlay.parentElement !== host) {
        host.append(overlay);
    }
    // The CSS reads whether the overlay is in a dialog from the first frame, so the placement is written now.
    updateToastPlacement();
    observeToastPlacement();
    return overlay;
}

/**
 * Decides the form of a toast that toastr has made and puts it in the container of that form. The overlay exists
 * while the form is decided, so that the measure of the width gets the toast's own CSS.
 * @param {HTMLElement} element
 * @param {Record<string, any>} effective
 * @param {Record<string, any>} options The options object of the toast, with toastr's defaults.
 * @returns {string} The form.
 */
function placeToast(element, effective, options) {
    ensureOverlay();
    // toastr made its container in the body if there was none, and a modal dialog hides everything outside it.
    moveContainersInto(getTopmostDialog() ?? document.body);
    const { form } = classifyToast(element, effective, measureOverride ? { measure: measureOverride } : undefined);
    if (form === TOAST_FORM) {
        element.classList.add(TOAST_FORM_CLASS);
        const overlay = ensureOverlay();
        if (options.newestOnTop) {
            overlay.prepend(element);
        } else {
            overlay.append(element);
        }
        removeEmptyNotificationContainer();
    } else {
        element.classList.add(NOTIFICATION_FORM_CLASS);
        removeOverlayIfEmpty();
    }
    return form;
}

/**
 * A class can hide a toast, as WI-Bulk-Mover's `toastClass = 'displayNone'` does to silence every toast during a bulk
 * move. A toast made held has an inline `display: none`, so the inline value is taken off while the class is read.
 */
function isHiddenByClass(element) {
    const inline = element.style.getPropertyValue('display');
    const priority = element.style.getPropertyPriority('display');
    element.style.removeProperty('display');
    try {
        return getComputedStyle(element).display === 'none';
    } finally {
        if (inline) {
            element.style.setProperty('display', inline, priority);
        }
    }
}

// Timing

function hasOwnValue(options, name) {
    return options != null && options[name] !== undefined;
}

/**
 * A toast keeps the timing of the call. An in-app notification follows GNOME Shell's urgency: an error or a warning
 * stays until it is dismissed, and an info or success message leaves after `NOTIFICATION_TIMEOUT`. A `timeOut` that
 * the call sets itself replaces these, and a global `toastr.options.timeOut` is not the call's own.
 * @returns {{ timeOut: number, extendedTimeOut: number, persistent: boolean }}
 */
function timingOf(form, type, optionsOverride, effective) {
    const effectiveExtended = Number(effective.extendedTimeOut ?? DEFAULT_EXTENDED_TIME_OUT);
    if (form === TOAST_FORM) {
        const timeOut = Number(effective.timeOut ?? DEFAULT_TIME_OUT);
        return { timeOut, extendedTimeOut: effectiveExtended, persistent: !(timeOut > 0) };
    }
    if (hasOwnValue(optionsOverride, 'timeOut')) {
        const timeOut = Number(optionsOverride.timeOut);
        return { timeOut, extendedTimeOut: effectiveExtended, persistent: !(timeOut > 0) };
    }
    if (type === 'error' || type === 'warning') {
        return { timeOut: 0, extendedTimeOut: 0, persistent: false };
    }
    const extendedTimeOut = hasOwnValue(optionsOverride, 'extendedTimeOut') ? Number(optionsOverride.extendedTimeOut) : NOTIFICATION_TIMEOUT;
    return { timeOut: NOTIFICATION_TIMEOUT, extendedTimeOut, persistent: false };
}

// The close button

/**
 * Every message has a close button (DESIGN: Toasts, Parts). toastr builds it from `closeHtml` and binds its click, which
 * also runs `onCloseClick`, so the button is made by toastr and only its markup is ours. The label is libadwaita's.
 * @returns {string}
 */
function dismissButtonHtml() {
    const label = translateLabel(DISMISS_LABEL);
    const button = document.createElement('button');
    button.type = 'button';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.dataset.i18n = `[title]${DISMISS_LABEL};[aria-label]${DISMISS_LABEL}`;
    const glyph = document.createElement('i');
    glyph.className = 'fa-solid fa-xmark';
    glyph.setAttribute('aria-hidden', 'true');
    button.append(glyph);
    return button.outerHTML;
}

/**
 * Tapping a toast does nothing: its button and its close button are the only ways to act on it. toastr binds the tap
 * to dismiss when it creates the toast, before the form is known, and the app's listener adds the "Tap to close" hint
 * after that, so both are taken off once the toast is known to be a toast. The close button is the last part of a toast,
 * and toastr puts it first.
 *
 * The tap also used to dismiss the toast when it landed on the button, so a toast with an Undo went after the Undo.
 * That stays, as libadwaita's `action_clicked_cb` does it: the button runs its action once, is disabled, and the toast
 * goes. A toast that a caller made with `tapToDismiss: false` keeps its button and stays, as it did.
 * @param {any} $toast
 * @param {boolean} dismissesAfterAction
 */
function makeInertToTaps($toast, dismissesAfterAction) {
    const element = $toast[0];
    $toast.off('click');
    element.classList.remove('interactable');
    element.removeAttribute('title');
    const close = [...element.children].find(child => child.classList.contains('toast-close-button'));
    if (close) {
        element.append(close);
    }
    if (dismissesAfterAction) {
        // The capture phase sees the click whether or not the button's own handler stops it, and the work waits for
        // the end of the event so that the handler of the caller runs first, on a button that is still enabled.
        element.addEventListener('click', (event) => {
            const button = event.target instanceof Element ? event.target.closest(BUTTON_SELECTOR) : null;
            if (!button || !element.querySelector('.toast-message')?.contains(button)) {
                return;
            }
            setTimeout(() => {
                button.setAttribute('aria-disabled', 'true');
                if (button instanceof HTMLButtonElement || button instanceof HTMLInputElement) {
                    button.disabled = true;
                }
                // Focus inside a toast keeps toastr from hiding it, unless the call forces it.
                toastrApi.clear($toast, { force: true });
            }, 0);
        }, true);
    }
}

// The wrapper

/** @see BOTH_CONTAINERS_ID */
function pointToastrAtBothContainers() {
    if (typeof toastrApi?.getContainer === 'function') {
        toastrApi.getContainer({ containerId: BOTH_CONTAINERS_ID }, false);
    }
}

/** Calls toastr's own function and returns the element with the options object that toastr's closures read. */
function createToast(original, args) {
    capturedOptions = null;
    const $toast = original(...args);
    const options = capturedOptions;
    capturedOptions = null;
    return { $toast, options };
}

/**
 * The action layout turns the message boxes into `display: contents`, so the text must be one block that the button can
 * follow. A message that holds several text blocks beside its button, such as the Getting Started toast, would put
 * them into the implicit grid columns and squeeze the text column to nothing; it keeps the layout of its own sheet.
 */
function hasInlineAction(element) {
    const buttons = element.querySelectorAll('.toast-message button');
    return buttons.length === 1 && buttons[0].parentElement.querySelectorAll(':scope > :not(button)').length <= 1;
}

function markAction(element) {
    element.classList.toggle(TOAST_ACTION_CLASS, hasInlineAction(element));
}

/** Marks the toast now and again when a caller changes its content after it is shown. */
function watchAction($toast) {
    const element = getToastElement($toast);
    if (element && typeof MutationObserver === 'function') {
        markAction(element);
        new MutationObserver(() => markAction(element)).observe(element, { childList: true, subtree: true });
    }
    return $toast;
}

/** Calls toastr directly, with no queue. The message is an in-app notification, because that form shows every part of a message. */
function showUnqueued(original, message, title, forcedOptions) {
    const $toast = original(message, title, forcedOptions);
    getToastElement($toast)?.classList.add(NOTIFICATION_FORM_CLASS);
    return $toast;
}

/**
 * toastr did not hand its options over, so nothing can start the hide timer of a toast that was made held. The held
 * toast is taken away and the message is made again without the queue, which switches off for every later call.
 */
function recoverUncaptured(original, created, message, title, forcedOptions) {
    queueEnabled = false;
    if (!uncapturedLogged) {
        uncapturedLogged = true;
        console.warn('SillyBunny: toastr did not hand over the options of a toast, so toasts are shown without a queue.');
    }
    toastrApi.remove(created.$toast);
    return showUnqueued(original, message, title, { ...forcedOptions, preventDuplicates: false });
}

/**
 * @param {string} type
 * @param {string|null} key
 * @param {Record<string, any>} effective
 * @param {Record<string, any>|undefined} optionsOverride
 * @param {boolean} high
 * @param {{ $toast: any, options: Record<string, any> }} created
 * @returns {QueuedToast}
 */
function toastEntry(type, key, effective, optionsOverride, high, { $toast, options }) {
    const element = $toast[0];
    const form = placeToast(element, effective, options);
    if (form === TOAST_FORM) {
        makeInertToTaps($toast, effective.tapToDismiss !== false);
    }
    const { timeOut, extendedTimeOut, persistent } = timingOf(form, type, optionsOverride, effective);
    return {
        $toast,
        element,
        options,
        type,
        form,
        key,
        state: SHOWN,
        high,
        persistent,
        resumed: false,
        showMethod: effective.showMethod ?? TOAST_SHOW_METHOD,
        timeOut,
        extendedTimeOut,
        onShown: effective.onShown,
    };
}

/** Shows the message now, or lets it wait for its turn in the queue of its form. */
function present(entry) {
    const queue = queues[entry.form];
    // A message that a class hides, or that a caller made to stay (progress and persistent states), shows at once and
    // takes no place, so it does not hold back the messages that time out or wait to be dismissed, errors included.
    if (isHiddenByClass(entry.element) || entry.persistent) {
        show(entry);
        return;
    }

    queued.set(entry.element, entry);
    const busy = queue.shown.length >= queue.capacity || queue.waiting.length > 0;
    if (entry.high || !busy) {
        if (entry.high) {
            makeRoom(queue);
        }
        activate(queue, entry);
        return;
    }

    entry.state = WAITING;
    insertWaiting(queue, entry);
    trimWaiting(queue);
    if (queue.shown.length < queue.capacity) {
        scheduleNext(queue);
    }
}

function wrapNotifier(toastr, type) {
    if (typeof toastr[type] !== 'function') {
        return;
    }
    const notify = toastr[type].bind(toastr);
    const original = (...args) => watchAction(notify(...args));
    toastr[type] = function (message, title, optionsOverride) {
        // The two settings own the containers, so a call or a global write of these options is not obeyed.
        const forced = {
            ...optionsOverride,
            containerId: NOTIFICATION_CONTAINER_ID,
            target: 'body',
            positionClass: notificationPosition,
            closeButton: true,
            closeHtml: dismissButtonHtml(),
        };
        if (!queueEnabled) {
            return showUnqueued(original, message, title, forced);
        }

        const effective = { ...toastr.options, ...optionsOverride };
        pruneDetached();
        const high = isHighPriority(message, effective);
        const key = duplicateKey(type, title, message, effective, high);
        const repeat = key === null ? null : findDuplicate(key);
        if (repeat) {
            return keepRepeat(repeat);
        }

        // Every message is made held: its form, and so its queue and its timing, is known only from the element.
        const created = createToast(original, [message, title, {
            ...forced,
            showMethod: TOAST_HOLD_METHOD,
            timeOut: 0,
            extendedTimeOut: 0,
            onShown: () => {},
        }]);
        if (!created.$toast) {
            return created.$toast;
        }
        if (!created.options) {
            return recoverUncaptured(original, created, message, title, forced);
        }

        const entry = toastEntry(type, key, effective, optionsOverride, high, created);
        const notifications = document.getElementById(NOTIFICATION_CONTAINER_ID);
        if (notifications) {
            watchContainer(notifications);
        }
        present(entry);
        return created.$toast;
    };
}

/**
 * toastr's `clear()` and `remove()` act on the one container that it looked up last. Both containers are one for them
 * now, so a call without a toast reaches every message, and a call with a toast acts on that toast wherever it is.
 */
function wrapContainerCommands(toastr) {
    if (typeof toastr.getContainer !== 'function') {
        return;
    }
    for (const command of ['clear', 'remove']) {
        if (typeof toastr[command] !== 'function') {
            continue;
        }
        const original = toastr[command].bind(toastr);
        toastr[command] = function (toastElement, ...rest) {
            pointToastrAtBothContainers();
            original(toastElement, ...rest);
            settleContainers();
        };
    }
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
    const { shown, waiting } = queues[TOAST_FORM];
    return { current: shown[0]?.element ?? null, waiting: waiting.map(entry => entry.element) };
}

/** The in-app notifications on screen, in the order they were shown, and the ones that wait. */
export function getNotificationQueue() {
    pruneDetached();
    const { shown, waiting } = queues[NOTIFICATION_FORM];
    return { shown: shown.map(entry => entry.element), waiting: waiting.map(entry => entry.element) };
}

export function resetToastQueue() {
    for (const queue of allQueues) {
        queue.shown = [];
        queue.waiting = [];
        queue.hiding = 0;
        queue.promotionScheduled = false;
    }
    seen.overlay = null;
    seen.notifications = null;
    queueEnabled = true;
}

/**
 * Sets where toasts show, and moves the overlay if it exists.
 * @param {string} positionClass One of toastr's six position classes.
 * @returns {boolean} False when the class is not one of them.
 */
export function setToastPosition(positionClass) {
    if (!POSITION_CLASSES.includes(positionClass)) {
        return false;
    }
    toastPosition = positionClass;
    const overlay = getOverlay();
    if (overlay) {
        setPositionClass(overlay, positionClass);
    }
    scheduleToastPlacement();
    return true;
}

/**
 * Sets where in-app notifications show, and moves toastr's container if it exists.
 * @param {string} positionClass One of toastr's six position classes.
 * @returns {boolean} False when the class is not one of them.
 */
export function setNotificationPosition(positionClass) {
    if (!POSITION_CLASSES.includes(positionClass)) {
        return false;
    }
    notificationPosition = positionClass;
    const container = document.getElementById(NOTIFICATION_CONTAINER_ID);
    if (container) {
        setPositionClass(container, positionClass);
    }
    scheduleToastPlacement();
    return true;
}

export function getNotificationPosition() {
    return notificationPosition;
}

/**
 * Puts both containers in the top open modal dialog, or in the body when none is open, and drops the ones that are empty
 * when no dialog is open. A message then shows above a modal dialog and not behind it, and it is not lost when the dialog
 * is removed. It runs whenever a dialog opens or closes, whoever owns the dialog, and before a message is made.
 */
export function placeToastContainers() {
    adoptOrphans();
    const dialog = getTopmostDialog();
    moveContainersInto(dialog ?? document.body);
    if (!dialog) {
        removeOverlayIfEmpty();
        removeEmptyNotificationContainer();
    }
    updateToastPlacement();
    observeToastPlacement();
}

/**
 * A dialog opens, starts to close or closes by a change of `open` or `closing`, whoever owns it, and a modal dialog hides
 * everything outside it. The observer only sees these two attributes, so it is cheap on a document of this size.
 */
function watchDialogs() {
    if (typeof MutationObserver !== 'function' || !globalThis.document?.body) {
        return;
    }
    new MutationObserver(() => placeToastContainers())
        .observe(document.body, { attributes: true, subtree: true, attributeFilter: ['open', 'closing'] });
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
        const element = event.target.closest(`#${NOTIFICATION_CONTAINER_ID} > *, #${TOAST_OVERLAY_ID} > *`);
        if (!element || element.classList.contains(TOAST_MEASURE_CLASS)) {
            return;
        }
        release();
        pressed = jQuery(element);
        pressed.triggerHandler('mouseenter');
    }, true);
    document.addEventListener('pointerup', release, true);
    document.addEventListener('pointercancel', release, true);
}

/**
 * @param {object} [dependencies]
 * @param {any} [dependencies.jQuery]
 * @param {any} [dependencies.toastr]
 * @param {(element: HTMLElement) => { width: number, em: number }} [dependencies.measure] Replaces the browser's measure
 * of a toast on one line, for a test that has no layout.
 * @param {(text: string) => string} [dependencies.translate] The app's translation of a UI string.
 */
export function initializeToastMotion({ jQuery = globalThis.jQuery, toastr = globalThis.toastr, measure, translate } = {}) {
    if (initialized || !jQuery?.fn || !toastr) {
        return;
    }
    initialized = true;
    toastrApi = toastr;
    measureOverride = measure ?? null;
    translateLabel = translate ?? translateLabel;
    startToastPlacement();
    jQuery.fn[TOAST_SHOW_METHOD] = sbToastIn;
    jQuery.fn[TOAST_HIDE_METHOD] = sbToastOut;
    jQuery.fn[TOAST_HOLD_METHOD] = sbToastHold;
    hookSubscribe(toastr);
    holdWhilePressed(jQuery, globalThis.document);
    watchDialogs();
    wrapContainerCommands(toastr);
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
