/*
 * Shared bottom-sheet frame: open/close motion over a scrim, focus trap, Escape, focus return,
 * and one open sheet at a time. Callers own the sheet's markup and styles.
 */

import { MOTION_FAST, SPRING_SHEET, animateIn, animateOut, stopMotion } from './sillybunny-motion.js';

const FOCUSABLE_SELECTOR = 'button, select, input, textarea, [href], [tabindex]:not([tabindex="-1"])';

/** @type {{ close: (options?: { animate?: boolean, restoreFocus?: boolean }) => void } | null} */
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

/**
 * @param {object} options
 * @param {HTMLElement} options.sheet
 * @param {HTMLElement} options.backdrop
 * @param {() => HTMLElement|null} options.getInitialFocus - Focus target after opening.
 * @param {() => HTMLElement|null} [options.getReturnFocus] - Focus target after closing, when focus was inside.
 * @param {() => boolean} [options.canAnimateClose] - Return false when the sheet's styles no longer apply.
 * @param {() => void} [options.onClose]
 */
export function createSheetController({ sheet, backdrop, getInitialFocus, getReturnFocus = () => null, canAnimateClose = () => true, onClose = () => {} }) {
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
            activeSheet.close({ animate: false, restoreFocus: false });
        }
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

    function close({ animate = true, restoreFocus = true } = {}) {
        if (!controller.isOpen()) {
            return;
        }
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
        const returnTarget = restoreFocus && hadFocus ? getReturnFocus() : null;
        if (returnTarget && isVisible(returnTarget)) {
            returnTarget.focus({ preventScroll: true });
        }
        onClose();
    }

    function handleKeydown(event) {
        if (event.key === 'Escape' && !event.isComposing) {
            event.preventDefault();
            event.stopPropagation();
            close();
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
    backdrop.addEventListener('click', () => close());
    blockUpstreamDrawerClose(backdrop);
    blockUpstreamDrawerClose(sheet);

    return controller;
}
