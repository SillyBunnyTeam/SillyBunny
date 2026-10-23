/*
 * Shared bottom-sheet frame: open/close motion over a scrim, focus trap, Escape, focus return,
 * and one open sheet at a time. Callers own the sheet's markup and styles.
 */

import { MOTION_FAST, SPRING_SHEET, animateIn, animateOut, stopMotion } from './sillybunny-motion.js';

const FOCUSABLE_SELECTOR = 'button, select, input, textarea, [href], [tabindex]:not([tabindex="-1"])';

/** @type {ReturnType<typeof createSheetController>|null} */
let activeSheet = null;

// Upstream closes open drawers on html mousedown/touchstart (public/script.js); keep body-level
// layers out of that handler.
export function blockUpstreamDrawerClose(element) {
    for (const type of ['mousedown', 'touchstart']) {
        element.addEventListener(type, event => event.stopPropagation(), { passive: true });
    }
}

function isVisible(element) {
    return element instanceof HTMLElement && element.getClientRects().length > 0;
}

function isFocusOnBody() {
    const active = document.activeElement;
    return !active || active === document.body;
}

/**
 * @param {object} options
 * @param {HTMLElement} options.sheet
 * @param {HTMLElement} options.backdrop
 * @param {() => HTMLElement|null} options.getInitialFocus - Focus target after opening.
 * @param {() => HTMLElement|null} [options.getReturnFocus] - Focus target after closing, when focus was inside or fell back to body.
 * @param {() => boolean} [options.canAnimateClose] - Return false when the sheet's styles no longer apply.
 * @param {(reason: 'escape'|'scrim'|'programmatic') => boolean|Promise<boolean>} [options.canClose]
 * @param {() => void} [options.onClose]
 * @returns {{ isOpen: () => boolean, open: () => void,
 * close: (options?: { animate?: boolean, restoreFocus?: boolean, force?: boolean,
 * reason?: 'escape'|'scrim'|'programmatic' }) => boolean|Promise<boolean> }}
 */
export function createSheetController({ sheet, backdrop, getInitialFocus, getReturnFocus = () => null, canAnimateClose = () => true, canClose, onClose = () => {} }) {
    let closeRevision = 0;
    let closePending = false;
    const controller = {
        isOpen: () => !sheet.hidden,
        open,
        close,
    };

    function open() {
        if (controller.isOpen()) {
            return;
        }
        if (activeSheet && activeSheet !== controller) {
            activeSheet.close({ animate: false, restoreFocus: false, force: true });
        }
        closeRevision++;
        closePending = false;
        activeSheet = controller;
        stopMotion(sheet);
        stopMotion(backdrop);
        sheet.hidden = false;
        backdrop.hidden = false;
        // AdwBottomSheet: rises from the bottom edge over a fading scrim.
        animateIn(sheet, [{ transform: 'translateY(100%)' }, { transform: 'none' }], SPRING_SHEET);
        animateIn(backdrop, [{ opacity: 0 }, { opacity: 1 }], { duration: MOTION_FAST });
        requestAnimationFrame(() => getInitialFocus()?.focus({ preventScroll: true }));
    }

    function close({ animate = true, restoreFocus = true, force = false, reason = 'programmatic' } = {}) {
        if (!controller.isOpen()) return false;
        if (force) {
            closeRevision++;
            closePending = false;
            return finishClose({ animate, restoreFocus });
        }
        if (closePending) return false;
        if (!canClose) return finishClose({ animate, restoreFocus });

        const approved = canClose(reason);
        if (typeof approved?.then !== 'function') {
            return approved === false ? false : finishClose({ animate, restoreFocus });
        }

        const token = ++closeRevision;
        closePending = true;
        return Promise.resolve(approved).then(result => {
            if (token !== closeRevision || !controller.isOpen() || result === false) return false;
            return finishClose({ animate, restoreFocus });
        }).finally(() => {
            if (token === closeRevision) closePending = false;
        });
    }

    function finishClose({ animate, restoreFocus }) {
        if (activeSheet === controller) {
            activeSheet = null;
        }
        const activeElement = document.activeElement;
        const hadFocus = sheet.contains(activeElement) || activeElement === backdrop;
        const enabled = animate && canAnimateClose();
        animateOut(sheet, [{ transform: 'none' }, { transform: 'translateY(100%)' }], () => {
            sheet.hidden = true;
        }, { enabled });
        animateOut(backdrop, [{ opacity: 1 }, { opacity: 0 }], () => {
            backdrop.hidden = true;
        }, { enabled });
        // WebKit blurs the sheet to body on pointer down, before the click that closes it arrives,
        // so focus resting on body after the close counts as focus the sheet held.
        const returnTarget = restoreFocus && (hadFocus || isFocusOnBody()) ? getReturnFocus() : null;
        if (returnTarget?.isConnected && isVisible(returnTarget)) {
            returnTarget.focus({ preventScroll: true });
        }
        onClose();
        return true;
    }

    async function closeFromEvent(reason) {
        try {
            await close({ reason });
        } catch (error) {
            console.error('Sheet close failed', error);
        }
    }

    function handleKeydown(event) {
        if (event.key === 'Escape' && !event.isComposing) {
            event.preventDefault();
            event.stopPropagation();
            void closeFromEvent('escape');
            return;
        }
        if (event.key !== 'Tab') {
            return;
        }
        const focusable = [...sheet.querySelectorAll(FOCUSABLE_SELECTOR)]
            .filter(element => !(/** @type {HTMLButtonElement} */ (element).disabled) && isVisible(element));
        if (!focusable.length) {
            event.preventDefault();
            return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const current = document.activeElement;
        if (event.shiftKey && (current === first || !focusable.includes(/** @type {HTMLElement} */ (current)))) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && current === last) {
            event.preventDefault();
            first.focus();
        }
    }

    sheet.addEventListener('keydown', handleKeydown);
    backdrop.addEventListener('click', () => { void closeFromEvent('scrim'); });
    blockUpstreamDrawerClose(backdrop);
    blockUpstreamDrawerClose(sheet);

    return controller;
}
