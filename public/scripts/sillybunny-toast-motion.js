/*
 * SillyBunny toast motion (AdwToast, DESIGN.md Motion > Per Surface).
 * Upstream toastr animates with jQuery fadeIn/fadeOut (script.js toastr.options). Instead of editing
 * that file, this registers jQuery methods that use the shared WAAPI helpers and points toastr at
 * them, re-applying the names whenever upstream reassigns toastr.options.
 */

import { MOTION_EASE, MOTION_EASE_OUT_CUBIC, MOTION_SURFACE, play, stopMotion } from './sillybunny-motion.js';

export const TOAST_SHOW_METHOD = 'sbToastIn';
export const TOAST_HIDE_METHOD = 'sbToastOut';
export const TOAST_LEAVING_CLASS = 'sb-toast-leaving';

const leaving = new WeakSet();
let initialized = false;

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
        complete?.();
        return this;
    }
    if (!isHidden(element)) {
        complete?.();
        return this;
    }

    element.style.removeProperty('display');
    play(element, [
        { opacity: 0, transform: `translateY(${enterOffset(element)})` },
        { opacity: 1, transform: 'none' },
    ], {
        duration: MOTION_SURFACE,
        easing: MOTION_EASE,
        onFinish: () => complete?.(),
    });
    return this;
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

    leaving.add(element);
    element.classList.add(TOAST_LEAVING_CLASS);
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
            complete?.();
        },
    });
    return this;
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

export function initializeToastMotion({ jQuery = globalThis.jQuery, toastr = globalThis.toastr } = {}) {
    if (initialized || !jQuery?.fn || !toastr) {
        return;
    }
    initialized = true;
    jQuery.fn[TOAST_SHOW_METHOD] = sbToastIn;
    jQuery.fn[TOAST_HIDE_METHOD] = sbToastOut;

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
