/*
 * Tells code that lives in a dialog page whether the pages of its dialog are moving. The dialog surface carries
 * `is-paging` through holds, one for each page slide and one for each height motion, so the class stays until the last
 * of them has ended. A slide brings in a page, covers one or uncovers one, and the same class covers all three.
 *
 * A layer insertion, an inline style write or a `hidden` change can restyle the whole document where a `:has()` rule
 * is rooted at the body, as at phone widths, and every such write during a slide is a chance to drop a frame. Code that
 * writes to the DOM of a page for its own reasons, such as the art of a window, waits for the end of the motion with
 * this module.
 */

/** The class that the dialog surface carries while its pages move. */
export const PAGING_CLASS = 'is-paging';

const SURFACE_SELECTOR = '.sb-dialog';

/**
 * @param {Element} node
 * @returns {boolean} Whether `node` is inside a dialog whose pages are sliding or changing height. A node outside any
 *   dialog, such as the hero of Home, is never in motion.
 */
export function isPageMotionRunning(node) {
    return node.closest(SURFACE_SELECTOR)?.classList.contains(PAGING_CLASS) ?? false;
}

/**
 * Calls `callback` once, in a microtask after the dialog of `node` has stopped moving its pages. The microtask runs in
 * the task that ends the motion, so a write that the callback makes lands in the same frame as the end of the slide.
 * When no motion runs, `callback` runs in a microtask at once, so a caller treats both cases alike.
 * @param {Element} node
 * @param {() => void} callback
 * @returns {() => void} Cancels the call, which is safe to do after it has been made.
 */
export function afterPageMotion(node, callback) {
    let cancelled = false;
    const run = () => {
        if (!cancelled) {
            cancelled = true;
            callback();
        }
    };
    const surface = node.closest(SURFACE_SELECTOR);
    if (!surface?.classList.contains(PAGING_CLASS)) {
        queueMicrotask(run);
        return () => {
            cancelled = true;
        };
    }
    const observer = new MutationObserver(() => {
        if (surface.classList.contains(PAGING_CLASS)) {
            return;
        }
        observer.disconnect();
        run();
    });
    observer.observe(surface, { attributes: true, attributeFilter: ['class'] });
    return () => {
        cancelled = true;
        observer.disconnect();
    };
}
