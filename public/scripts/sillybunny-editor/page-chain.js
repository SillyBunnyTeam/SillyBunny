/**
 * A Dialog or Window opened over another Dialog or Window is a page in a chain. Each page is its own
 * native <dialog>: a framed Popup, or an openDialog host. The pages stay in the DOM and sit at the
 * same rectangle, so the chain is tracked here instead of in the DOM.
 */

const COVERED_ATTRIBUTE = 'data-sb-covered';
const COVERS_SHEET_ATTRIBUTE = 'data-covers-sheet';
const COVERS_POPUP_ATTRIBUTE = 'data-covers-popup';
export const FOCUSABLE_SELECTOR = 'button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])';

/**
 * @typedef {object} ChainLevel
 * @property {HTMLElement} surface The visible Dialog or Window surface of this level.
 * @property {ChainLevel|null} parent The level this one covers, or null for the chain root.
 * @property {() => Promise<boolean>} close Closes only this level through its own close path.
 *     Resolves true when the level is gone, and false when it refused to close.
 * @property {() => Promise<boolean>|null} pending Returns the close that the level already runs, for
 *     example a completion that waits for an async veto handler, or null. It resolves true when
 *     the level ended up closed and false when it refused.
 * @property {() => void} onOrphan Called when the level this one covers is removed while this level
 *     is still open, for example by code that closes the covered Popup. The level then stops following
 *     the removed level, and the chain closes it and the pages above it, top first.
 * @property {Set<ChainLevel>} pages The levels opened directly over this one.
 * @property {HTMLElement|null} lastFocus The last element inside the surface that had focus.
 * @property {() => void} stopTracking Stops following focus inside the surface.
 */

/** @type {WeakMap<HTMLElement, ChainLevel>} */
const levels = new WeakMap();
/** @type {Map<ChainLevel, Promise<boolean>>} Walks by the level they started at. */
const walks = new Map();
/** @type {Set<ChainLevel>} Levels that a walk is closing right now. */
const closing = new Set();

/**
 * The Dialog or Window surface under `except`, when it is the dialog directly beneath it.
 * @param {HTMLElement|null} [except] The dialog that is being presented.
 * @returns {HTMLElement|null}
 */
export function findCoveredSurface(except = null) {
    const below = [...document.querySelectorAll('dialog[open]:not([closing])')].filter(node => node !== except).at(-1);
    if (!below) return null;
    if (below.matches('.sb-dialog-host:not([data-tier="alert"])')) return below.querySelector(':scope > .sb-dialog');
    if (below.matches('dialog.popup.sb-dialog:is(.sb-dialog--dialog, .sb-dialog--window)')) return below;
    return null;
}

/**
 * @param {object} options
 * @param {HTMLElement} options.surface
 * @param {() => Promise<boolean>} options.close
 * @param {HTMLElement|null} [options.covered] The surface this level is opened over.
 * @param {() => Promise<boolean>|null} [options.pending] See {@link ChainLevel.pending}.
 * @returns {ChainLevel}
 */
export function registerChainLevel({ surface, close, covered = null, pending = () => null }) {
    // A page takes focus away from the level it covers, so the level has to remember its own focus.
    const remember = event => {
        if (event.target instanceof HTMLElement && event.target !== surface) level.lastFocus = event.target;
    };
    surface.addEventListener('focusin', remember);
    const level = {
        surface,
        parent: covered ? levels.get(covered) ?? null : null,
        close,
        pending,
        onOrphan: () => {},
        pages: new Set(),
        lastFocus: null,
        stopTracking: () => surface.removeEventListener('focusin', remember),
    };
    level.parent?.pages.add(level);
    levels.set(surface, level);
    return level;
}

/** @param {ChainLevel} level */
function topmostPage(level) {
    let top = level;
    while (top.pages.size) top = [...top.pages].at(-1);
    return top;
}

/**
 * Removes a level from the chain. A page that is still open over it cannot return to it, so the pages
 * above the removed level close top first, like a chain Close that stops at the first refusal.
 * @param {ChainLevel} level
 * @returns {Promise<unknown>|null} Resolves when those pages have closed or refused, or null when none was open.
 */
export function unregisterChainLevel(level) {
    level.stopTracking();
    level.parent?.pages.delete(level);
    if (levels.get(level.surface) === level) levels.delete(level.surface);
    const orphans = [...level.pages];
    for (const page of orphans) {
        // A chain Close must not walk into the removed level.
        page.parent = null;
        level.pages.delete(page);
        page.onOrphan();
    }
    if (!orphans.length) return null;
    return Promise.all(orphans.map(page => closeChain(topmostPage(page))));
}

/**
 * Returns focus into `surface` after a page that covered it has gone. A level that never had focus
 * (for example a read-only view) falls back to its first control, and then to the surface itself.
 */
export function restoreChainFocus(surface) {
    const remembered = levels.get(surface)?.lastFocus;
    const target = remembered?.isConnected && surface.contains(remembered)
        ? remembered
        : [...surface.querySelectorAll(FOCUSABLE_SELECTOR)].find(node => node.getClientRects().length > 0) ?? surface;
    target.focus({ preventScroll: true });
}

async function walkDown(start) {
    // A level can already be closing when the walk starts, for example while its veto handler waits on
    // a page that the walk now closes. That close decides the level, so the walk never starts a second one.
    const running = new Map();
    for (let current = start; current; current = current.parent) {
        const run = current.pending();
        if (run) running.set(current, run);
    }
    for (let current = start; current; current = current.parent) {
        // A veto handler can open its own page and close it again while its level is still
        // closing. The walk that owns the level decides the result, so this walk stops here.
        if (closing.has(current)) return false;
        closing.add(current);
        try {
            if (!(await (running.get(current) ?? current.close()))) return false;
        } finally {
            closing.delete(current);
        }
    }
    return true;
}

/**
 * Closes `level` and then each level below it, one at a time, like Back repeated down to the chain
 * root. Each close finishes (including its animation and disposal) before the next one starts, so a
 * parent never closes while a child close is pending. The walk stops at the first level that
 * refuses: that level and the levels below it stay open.
 * @param {ChainLevel} level
 * @returns {Promise<boolean>} True when the whole chain closed.
 */
export function closeChain(level) {
    // A second Close during an async veto must not start a second walk.
    const running = walks.get(level);
    if (running) return running;
    const walk = walkDown(level).finally(() => walks.delete(level));
    walks.set(level, walk);
    return walk;
}

/**
 * Places `page` over `covered`: same rectangle, with `covered` inert and hidden until released.
 * The rectangle is written as `--sb-page-*` properties on `page`. When `covered` is a bottom sheet,
 * `page` also gets `data-covers-sheet` so that it takes the sheet's shape. `data-covers-popup` marks
 * a page that has to keep the dim: a covered Popup hides its own backdrop, but an openDialog frame
 * keeps its scrim, and a page over a Popup page already inherits the dim from the page beneath it.
 * @param {HTMLElement} covered
 * @param {HTMLElement} page
 * @returns {{ release: () => void, standalone: () => void }} `release` uncovers the surface and stops
 *     following its rectangle. `standalone` is for a page that stays open after `covered` was removed:
 *     it keeps its last rectangle and takes over the dim.
 */
export function coverSurface(covered, page) {
    const wasInert = covered.inert;
    covered.inert = true;
    let released = false;
    const place = () => {
        // A removed surface reports an empty rectangle, which would collapse the page.
        if (released || !covered.isConnected) return;
        // A page over a sheet takes the sheet's shape, and so does a page over such a page.
        const coversSheet = covered.hasAttribute(COVERS_SHEET_ATTRIBUTE)
            || (covered.dataset.presentation ?? covered.closest('[data-presentation]')?.dataset.presentation) === 'sheet';
        page.toggleAttribute(COVERS_SHEET_ATTRIBUTE, coversSheet);
        page.toggleAttribute(COVERS_POPUP_ATTRIBUTE, covered.matches(`dialog.popup:not(.sb-dialog--page), dialog.popup[${COVERS_POPUP_ATTRIBUTE}]`));
        const rect = covered.getBoundingClientRect();
        for (const [name, value] of Object.entries({ top: rect.top, left: rect.left, width: rect.width, height: rect.height })) {
            page.style.setProperty(`--sb-page-${name}`, `${Math.round(value)}px`);
        }
    };
    place();
    // An opening animation moves or scales the covered surface, so its rectangle is only final after it ends.
    const running = covered.getAnimations?.() ?? [];
    if (running.length) {
        void Promise.allSettled(running.map(animation => animation.finished)).then(place);
    }
    covered.setAttribute(COVERED_ATTRIBUTE, '');
    window.addEventListener('resize', place, { passive: true });
    const stopFollowing = () => {
        released = true;
        window.removeEventListener('resize', place);
    };
    return {
        release() {
            stopFollowing();
            covered.removeAttribute(COVERED_ATTRIBUTE);
            covered.inert = wasInert;
        },
        standalone() {
            stopFollowing();
            const own = page.closest('dialog');
            const dimmedBeneath = [...document.querySelectorAll('dialog[open]:not([closing])')].some(node => node !== own);
            page.toggleAttribute(COVERS_POPUP_ATTRIBUTE, !dimmedBeneath);
        },
    };
}
