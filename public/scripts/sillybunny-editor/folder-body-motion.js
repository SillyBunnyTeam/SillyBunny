import { play, prefersReducedMotion } from '../sillybunny-motion.js';

/**
 * Opens or closes a folder whose members are the content of one element (a section body holding a grid), over the same
 * duration, easing, fade and height change as the member rows of a list. The caller has set `hidden` and the stored
 * state; `onEnd` runs when a close has finished or been cancelled, so the caller can hide the body and drop its content.
 * A click in the middle of a motion continues from the height and opacity on screen instead of from the end state.
 * @param {HTMLElement} body
 * @param {boolean} expanding
 * @param {{ onEnd?: (() => void) | null }} [options]
 */
export function animateFolderBody(body, expanding, { onEnd = null } = {}) {
    if (prefersReducedMotion() || !body.isConnected) {
        onEnd?.();
        return null;
    }
    let from = null;
    const running = typeof body.getAnimations === 'function' ? body.getAnimations() : [];
    if (running.length) {
        const style = getComputedStyle(body);
        from = {
            height: `${body.getBoundingClientRect().height}px`,
            paddingBlockStart: style.paddingBlockStart,
            paddingBlockEnd: style.paddingBlockEnd,
            borderBlockStartWidth: style.borderBlockStartWidth,
            borderBlockEndWidth: style.borderBlockEndWidth,
            opacity: Number(style.opacity),
        };
        // The settled height is measured below, so the running motion has to be gone first.
        for (const animation of running) animation.cancel();
    }
    const natural = body.getBoundingClientRect().height;
    // A body that has padding and a border cannot shrink below them with `height` alone, so they are animated too.
    const shut = { height: '0px', paddingBlockStart: '0px', paddingBlockEnd: '0px', borderBlockStartWidth: '0px', borderBlockEndWidth: '0px', opacity: 0 };
    const open = { height: `${natural}px`, opacity: 1 };
    return play(body, [from ?? (expanding ? shut : open), expanding ? open : shut], {
        fill: expanding ? 'none' : 'forwards',
        inert: !expanding,
        styles: { 'box-sizing': 'border-box', overflow: 'hidden' },
        onEnd,
    });
}
