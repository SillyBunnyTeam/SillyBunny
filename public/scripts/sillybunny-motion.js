/*
 * Shared WAAPI motion helpers for the SillyBunny shell.
 * Durations and easing mirror --sb-transition-fast/--sb-transition/--sb-transition-slow (DESIGN.md Motion).
 * Every helper is a no-op when prefers-reduced-motion is set or WAAPI is unavailable.
 */

export const MOTION_FAST = 200;
export const MOTION_SLOW = 250;
export const MOTION_SURFACE = 300;
/** Popover and menu close: a short fade with no movement (DESIGN.md Motion, Per Surface). */
export const MOTION_POPOVER_CLOSE = 150;
export const MOTION_EASE = 'cubic-bezier(0.25, 0.1, 0.25, 1)';
export const MOTION_EASE_OUT_QUAD = 'cubic-bezier(0.25, 0.46, 0.45, 0.94)';
export const MOTION_EASE_OUT_CUBIC = 'cubic-bezier(0.33, 1, 0.68, 1)';

const supportsLinearEasing = typeof CSS !== 'undefined'
    && typeof CSS.supports === 'function'
    && CSS.supports('transition-timing-function', 'linear(0, 1)');

/*
 * libadwaita AdwSpringAnimation presets (damping ratio, mass, stiffness) sampled into linear().
 * The cubic-bezier fallbacks approximate each curve for engines without linear() (Safari < 17.2).
 */
function spring(duration, samples, fallback) {
    return Object.freeze({ duration, easing: supportsLinearEasing ? `linear(${samples})` : fallback });
}

export const SPRING_DIALOG = spring(511,
    '0, 0.096, 0.299, 0.533, 0.737, 0.897, 1, 1.059, 1.081, 1.079, 1.065, 1.046, 1.028, 1.013, 1.003, 0.997, 0.994, 0.993, 0.994, 0.996, 0.997, 0.998, 0.999, 1, 1',
    'cubic-bezier(0.34, 1.36, 0.64, 1)');
export const SPRING_SHEET = spring(472,
    '0, 0.063, 0.207, 0.371, 0.529, 0.669, 0.779, 0.863, 0.924, 0.964, 0.989, 1.005, 1.012, 1.014, 1.014, 1.012, 1.01, 1.008, 1.005, 1.004, 1.002, 1.001, 1.001, 1, 1',
    'cubic-bezier(0.22, 1, 0.36, 1)');
export const SPRING_NAVIGATION = spring(334,
    '0, 0.076, 0.227, 0.382, 0.528, 0.648, 0.742, 0.814, 0.867, 0.905, 0.933, 0.953, 0.967, 0.977, 0.984, 0.989, 0.993, 0.995, 0.996, 0.998, 0.998, 0.999, 0.999, 0.999, 1',
    'cubic-bezier(0.16, 1, 0.3, 1)');

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
const activeMotions = new WeakMap();

export function prefersReducedMotion() {
    return window.matchMedia(REDUCED_MOTION_QUERY).matches
        || document.body?.classList.contains('reduced-motion') === true;
}

function canAnimate(element) {
    return element instanceof HTMLElement
        && element.isConnected
        && typeof element.animate === 'function'
        && !prefersReducedMotion();
}

function applyInlineStyles(element, styles) {
    const saved = [];
    for (const [property, value] of Object.entries(styles)) {
        saved.push([property, element.style.getPropertyValue(property), element.style.getPropertyPriority(property)]);
        element.style.setProperty(property, value, 'important');
    }
    return saved;
}

function restoreInlineStyles(element, saved) {
    for (const [property, value, priority] of saved) {
        if (value) {
            element.style.setProperty(property, value, priority);
        } else {
            element.style.removeProperty(property);
        }
    }
}

/** Cancels any running helper animation on the element and restores its inline state. */
export function stopMotion(element) {
    const motion = element ? activeMotions.get(element) : null;
    if (motion) {
        motion.cancel();
    }
}

/**
 * Plays keyframes on the element. `styles` are applied inline (!important) for the duration,
 * `onFinish` runs only when the animation completes, `onEnd` runs on finish and on cancel.
 * Without motion, `onFinish` and `onEnd` run synchronously.
 */
export function play(element, keyframes, { duration = MOTION_SLOW, easing = MOTION_EASE, fill = 'none', styles = null, inert = false, onFinish = null, onEnd = null } = {}) {
    stopMotion(element);
    if (!canAnimate(element)) {
        onFinish?.();
        onEnd?.();
        return null;
    }

    const saved = styles ? applyInlineStyles(element, styles) : [];
    const wasInert = element.inert;
    if (inert) {
        element.inert = true;
    }
    const animation = element.animate(keyframes, { duration, easing, fill });

    const cleanup = () => {
        activeMotions.delete(element);
        restoreInlineStyles(element, saved);
        if (inert) {
            element.inert = wasInert;
        }
        onEnd?.();
    };
    const motion = {
        cancel() {
            cleanup();
            animation.cancel();
        },
    };
    activeMotions.set(element, motion);

    // onFinish commits the end state before the fill is dropped, all in one task, so nothing flashes.
    animation.finished.then(() => {
        if (activeMotions.get(element) !== motion) {
            return;
        }
        onFinish?.();
        cleanup();
        animation.cancel();
    }).catch(() => {});
    return motion;
}

/** Enter animation for an element that is already shown. */
export function animateIn(element, keyframes, options = {}) {
    return play(element, keyframes, options);
}

/**
 * Exit animation for an element hidden by `hide()` (usually `element.hidden = true`). The element
 * keeps its display and becomes inert while it animates out; its logical state changes at once.
 */
export function animateOut(element, keyframes, hide, { enabled = true, ...options } = {}) {
    stopMotion(element);
    const display = enabled && canAnimate(element) ? getComputedStyle(element).display : 'none';
    hide();
    if (display === 'none') {
        return null;
    }
    return play(element, keyframes, {
        duration: MOTION_FAST,
        easing: MOTION_EASE_OUT_CUBIC,
        ...options,
        fill: 'forwards',
        inert: true,
        styles: { display, 'pointer-events': 'none', ...options.styles },
    });
}

/** Fades an element out and removes it from the DOM. */
export function fadeOutAndRemove(element, { enabled = true } = {}) {
    if (!element) {
        return;
    }
    if (!enabled) {
        stopMotion(element);
        element.remove();
        return;
    }
    play(element, [{ opacity: 1 }, { opacity: 0 }], {
        duration: MOTION_FAST,
        easing: MOTION_EASE_OUT_CUBIC,
        fill: 'forwards',
        inert: true,
        styles: { 'pointer-events': 'none' },
        onFinish: () => element.remove(),
    });
}

/** transform-origin for `element` that points at the centre of `anchor`. */
export function originFrom(anchor, element) {
    if (!anchor || !element) {
        return 'center';
    }
    const anchorRect = anchor.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    const x = anchorRect.left + anchorRect.width / 2 - rect.left;
    const y = anchorRect.top + anchorRect.height / 2 - rect.top;
    return `${Math.round(x)}px ${Math.round(y)}px`;
}

/**
 * Shared-element morph: the element starts at `fromRect` (scaled by `scale`) and settles into its
 * own box, fading in from `fromOpacity`.
 */
export function morphFrom(element, fromRect, { scale = 1, fromOpacity = 0, duration = MOTION_SLOW, easing = MOTION_EASE, onEnd = null } = {}) {
    if (!fromRect || !canAnimate(element)) {
        onEnd?.();
        return null;
    }
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height || !fromRect.width || !fromRect.height) {
        onEnd?.();
        return null;
    }
    const dx = fromRect.left + fromRect.width / 2 - (rect.left + rect.width / 2);
    const dy = fromRect.top + fromRect.height / 2 - (rect.top + rect.height / 2);
    return play(element, [
        { transform: `translate(${dx}px, ${dy}px) scale(${scale})`, opacity: fromOpacity },
        { transform: 'none', opacity: 1 },
    ], { duration, easing, styles: { 'transform-origin': 'center' }, onEnd });
}

/** Animates the element's border-box height from `fromHeight` to its current height. */
export function animateHeightFrom(element, fromHeight, { duration = MOTION_SLOW, styles = null } = {}) {
    if (!canAnimate(element)) {
        return null;
    }
    // Measure the settled height, not a frame of an interrupted animation.
    stopMotion(element);
    const toHeight = element.getBoundingClientRect().height;
    if (!Number.isFinite(fromHeight) || Math.abs(toHeight - fromHeight) < 1) {
        return null;
    }
    return play(element, [
        { height: `${fromHeight}px` },
        { height: `${toHeight}px` },
    ], {
        duration,
        styles: { 'box-sizing': 'border-box', overflow: 'hidden', 'align-content': 'start', ...styles },
    });
}
