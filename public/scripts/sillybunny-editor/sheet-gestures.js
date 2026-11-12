import { MOTION_FAST, SPRING_SHEET, play, stopMotion } from '../sillybunny-motion.js';

const SWIPE_DISTANCE_RATIO = 0.3;
const SWIPE_VELOCITY = 0.5;
const DRAG_SLOP = 4;
const INTERACTIVE_SELECTOR = 'button, input, select, textarea, a[href], [contenteditable], [role="button"], [role="switch"], [role="menuitem"]';

function settle(result, onResolved) {
    return typeof result?.then === 'function' ? Promise.resolve(result).then(onResolved) : onResolved(result);
}

/**
 * Drag-to-close for bottom sheets (AdwDialog bottom sheet): the sheet follows the finger and
 * either closes or springs back.
 * @param {object} options
 * @param {HTMLElement} options.surface
 * @param {HTMLElement|null} [options.scrim]
 * @param {HTMLElement[]} options.targets Elements that receive the pointer listeners.
 * @param {string} [options.startSelector] Drags start only inside a match (the handle or a header bar);
 *     drags that start on a control are always ignored, except on the handle.
 * @param {() => boolean} options.isActive
 * @param {(offset: number) => boolean|Promise<boolean>} options.requestClose
 * @returns {() => void} Unbinds the listeners.
 */
export function bindSheetGestures({ surface, scrim = null, targets, startSelector = null, isActive, requestClose }) {
    let drag = null;

    function reset() {
        surface.style.removeProperty('transform');
        scrim?.style.removeProperty('opacity');
    }

    function springBack(offset) {
        reset();
        if (offset <= 0) return;
        play(surface, [{ transform: `translateY(${offset}px)` }, { transform: 'none' }], SPRING_SHEET);
        if (scrim) play(scrim, [{ opacity: 0.5 }, { opacity: 1 }], { duration: MOTION_FAST });
    }

    // A sheet can hide or change presentation while a pointer is held. Its pointer events then stop,
    // so the next event is where a stale drag is found and dropped.
    function dropStaleDrag() {
        if (!drag || isActive()) return;
        drag = null;
        reset();
    }

    function onDown(event) {
        dropStaleDrag();
        if (drag || !isActive() || (event.button ?? 0) > 0) return;
        const target = event.target instanceof Element ? event.target : null;
        if (startSelector && !target?.closest(startSelector)) return;
        if (target?.closest(INTERACTIVE_SELECTOR) && !target.closest('.sb-dialog__handle')) return;
        // Cancelling pointerdown suppresses the compatibility mousedown, so a drag keeps focus where it was.
        if (event.cancelable) event.preventDefault();
        stopMotion(surface);
        if (scrim) stopMotion(scrim);
        drag = {
            id: event.pointerId,
            startY: event.clientY,
            lastY: event.clientY,
            lastTime: event.timeStamp,
            velocity: 0,
            offset: 0,
            height: surface.getBoundingClientRect().height,
        };
        event.currentTarget.setPointerCapture?.(event.pointerId);
    }

    function track(event) {
        const offset = Math.max(0, event.clientY - drag.startY);
        const elapsed = event.timeStamp - drag.lastTime;
        if (elapsed > 0) drag.velocity = (event.clientY - drag.lastY) / elapsed;
        drag.lastY = event.clientY;
        drag.lastTime = event.timeStamp;
        drag.offset = offset;
        return offset;
    }

    function onMove(event) {
        dropStaleDrag();
        if (!drag || event.pointerId !== drag.id) return;
        const offset = track(event);
        if (offset < DRAG_SLOP) return;
        surface.style.setProperty('transform', `translateY(${offset}px)`);
        if (scrim && drag.height > 0) scrim.style.setProperty('opacity', String(Math.max(0, 1 - offset / drag.height)));
    }

    function onUp(event) {
        dropStaleDrag();
        if (!drag || event.pointerId !== drag.id) return;
        const offset = track(event);
        const { height, velocity } = drag;
        drag = null;
        if (offset < DRAG_SLOP) {
            reset();
            return;
        }
        if (offset <= height * SWIPE_DISTANCE_RATIO && velocity <= SWIPE_VELOCITY) {
            springBack(offset);
            return;
        }
        settle(requestClose(offset), closed => {
            if (closed === false) springBack(offset);
        });
    }

    function onCancel(event) {
        if (!drag || event.pointerId !== drag.id) return;
        const { offset } = drag;
        drag = null;
        springBack(offset);
    }

    // The browser releases pointer capture when the sheet hides, which ends the drag without a pointerup.
    const listeners = [['pointerdown', onDown], ['pointermove', onMove], ['pointerup', onUp], ['pointercancel', onCancel], ['lostpointercapture', onCancel]];
    for (const target of targets) {
        if (!target) continue;
        for (const [type, listener] of listeners) target.addEventListener(type, listener);
    }
    return () => {
        for (const target of targets) {
            if (!target) continue;
            for (const [type, listener] of listeners) target.removeEventListener(type, listener);
        }
    };
}

/** The grab handle shared by every bottom sheet. The sheet's own styles decide when it shows. */
export function createSheetHandle() {
    const handle = document.createElement('div');
    handle.className = 'sb-dialog__handle';
    handle.setAttribute('aria-hidden', 'true');
    return handle;
}

/**
 * Swipe-down close for an overlay sheet that a sheet controller opens and closes. The controller
 * continues its close animation from the dragged position, so `close` is the normal close path.
 * @param {object} options
 * @param {HTMLElement} options.sheet
 * @param {HTMLElement} options.backdrop
 * @param {string} options.headerSelector The sheet's header bar, which starts a drag like the handle does.
 * @param {() => unknown} options.close
 * @returns {() => void} Unbinds the listeners.
 */
export function bindSheetSwipeClose({ sheet, backdrop, headerSelector, close }) {
    return bindSheetGestures({
        surface: sheet,
        scrim: backdrop,
        targets: [sheet],
        startSelector: `.sb-dialog__handle, ${headerSelector}`,
        isActive: () => !sheet.hidden,
        requestClose: () => close(),
    });
}
