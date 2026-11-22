/*
 * SillyBunny toast placement: where #sb-toast-overlay sits, as numbers that the toast CSS reads.
 * A bottom toast sits above the composer and above the software keyboard, a toast in a dialog sits at the bottom centre
 * of that dialog's box and above its action row, and an in-app notification at the same position as the toasts sits
 * beyond them. The CSS owns every metric that does not depend on the page; this module only measures what the CSS
 * cannot know.
 */

import { createMobileViewportObserver } from './chat-render-lifecycle/mobile-viewport.js';

export const TOAST_OVERLAY_ID = 'sb-toast-overlay';
export const NOTIFICATION_CONTAINER_ID = 'toast-container';
const POSITION_CLASSES = [
    'toast-top-left',
    'toast-top-center',
    'toast-top-right',
    'toast-bottom-left',
    'toast-bottom-center',
    'toast-bottom-right',
];
/** The composer stack: the chat bar and the message box. Home and other pages hide it with `display: none`. */
const COMPOSER_ID = 'form_sheld';

export const BOTTOM_INSET_PROPERTY = '--sb-toast-bottom-inset';
export const FRAME_LEFT_PROPERTY = '--sb-toast-frame-left';
export const FRAME_WIDTH_PROPERTY = '--sb-toast-frame-width';
export const FRAME_BOTTOM_PROPERTY = '--sb-toast-frame-bottom';
export const STACK_OFFSET_PROPERTY = '--sb-toast-stack-offset';
/**
 * The rows that hold the actions of a dialog at its foot: the responses of an alert (`openAlert`), the extra responses
 * of a Dialog or Window (`openDialog` and the framed Popups), and the controls of an alert Popup and of an upstream
 * Popup. The controls of a framed Dialog or Window Popup are `display: contents` in its header, so they have no box.
 */
export const ACTION_ROW_SELECTOR = '.sb-dialog__responses, .sb-dialog__bottom-bar, .popup-controls';
/** Set on the overlay while it sits in a dialog, where it is at the bottom centre whatever the setting says. */
export const IN_DIALOG_ATTRIBUTE = 'data-sb-toast-in-dialog';

/**
 * How much of the bottom of the layout viewport the software keyboard covers. With `interactive-widget=resizes-visual`
 * the layout viewport keeps its height and only the visual viewport shrinks, and fixed elements stay anchored to the
 * layout viewport, so a bottom toast has to be lifted by this much. A pinch zoom shrinks the visual viewport too, and
 * lifting by the same formula keeps the toast at the bottom of what the user sees.
 * @param {{ height: number, offsetTop: number }|null|undefined} viewport The visual viewport.
 * @param {number} layoutHeight The height of the layout viewport.
 * @returns {number} px, never negative.
 */
export function keyboardInset(viewport, layoutHeight) {
    const height = Number(viewport?.height);
    const top = Number(viewport?.offsetTop ?? 0);
    if (!Number.isFinite(height) || !Number.isFinite(top) || !(layoutHeight > 0)) {
        return 0;
    }
    return Math.max(0, Math.round(layoutHeight - top - height));
}

/**
 * How much of the bottom of the layout viewport the composer covers. A box that is hidden (Home hides the composer), that
 * is empty, or that lies outside the window covers nothing.
 * @param {{ top: number, bottom: number, height: number }|null|undefined} box The composer's box in the layout viewport.
 * @param {number} layoutHeight
 * @returns {number} px, never negative.
 */
export function composerInset(box, layoutHeight) {
    if (!box || !(box.height > 0) || !(layoutHeight > 0) || box.top >= layoutHeight || box.bottom <= 0) {
        return 0;
    }
    return Math.max(0, Math.round(layoutHeight - box.top));
}

/**
 * The space that a bottom toast keeps clear: the composer or the keyboard, whichever reaches higher.
 * @param {{ layoutHeight: number, viewport?: { height: number, offsetTop: number }|null, composerBox?: { top: number, bottom: number, height: number }|null }} measures
 * @returns {number} px
 */
export function bottomInset({ layoutHeight, viewport, composerBox }) {
    return Math.max(keyboardInset(viewport, layoutHeight), composerInset(composerBox, layoutHeight));
}

/**
 * Which edge a toast sits at. In a dialog it is the bottom edge of the dialog whatever the position class says.
 * @param {string} positionClass One of toastr's six position classes.
 * @param {boolean} inDialog
 * @returns {'top'|'bottom'}
 */
export function edgeOf(positionClass, inDialog) {
    return inDialog || /\btoast-bottom-/.test(positionClass) ? 'bottom' : 'top';
}

/**
 * The element whose box is "the dialog" for a toast. A Popup is itself the surface. A frame of the shared dialog
 * (`sillybunny-editor/dialog.js`) is a transparent modal host that covers the window, with the visible surface inside.
 * @param {HTMLElement} host The dialog that holds the overlay.
 * @returns {HTMLElement}
 */
export function dialogSurfaceOf(host) {
    if (!host.classList.contains('sb-dialog-host')) {
        return host;
    }
    return [...host.children].find(child => child.classList.contains('sb-dialog')) ?? host;
}

/**
 * How far from its own edge the in-app notifications at the position of the toasts start. A toast keeps the edge, so the
 * notifications start where the toasts end: at a top position the container already sits under the top bar, so that is
 * the height of the toasts; at a bottom position the container sits at the window edge, so it is the space from the
 * window edge to the top of the toasts, which includes the composer or the keyboard that the toasts sit above. With no
 * toast on screen the notifications keep their own place.
 * @param {{ edge: 'top'|'bottom', layoutHeight: number, overlayBox: { top: number, height: number } }} measures
 * @returns {number} px, never negative.
 */
export function stackOffset({ edge, layoutHeight, overlayBox }) {
    if (!(overlayBox.height > 0)) {
        return 0;
    }
    return Math.max(0, Math.round(edge === 'bottom' ? layoutHeight - overlayBox.top : overlayBox.height));
}

/**
 * The space that a toast in a dialog keeps clear at the bottom of the dialog's padding box: what lies under the
 * action row when there is one, and what lies under the surface when there is not.
 * @param {{ hostHeight: number, surfaceBottom: number, rowTop: number|null }} measures All in px from the top of the host's padding box.
 * @returns {number} px, never negative.
 */
export function dialogToastBottom({ hostHeight, surfaceBottom, rowTop }) {
    const top = rowTop === null ? surfaceBottom : Math.min(surfaceBottom, rowTop);
    return Math.max(0, Math.round(hostHeight - top));
}

/**
 * Where the action row at the foot of a dialog starts, in layout px from the top of the surface. A row counts when it
 * has a box, is not hidden and lies in the lower half of the surface, so the controls of a header do not. Of several
 * rows the highest counts, so that the toast clears all of them. A surface that is scaled, as while it opens, is
 * read at its layout size.
 * @param {HTMLElement} surface
 * @returns {number|null} Null when the surface has no action row.
 */
export function actionRowTop(surface) {
    const surfaceBox = surface.getBoundingClientRect();
    const scale = surface.offsetHeight > 0 ? surfaceBox.height / surface.offsetHeight : 1;
    const middle = surfaceBox.top + surfaceBox.height / 2;
    let top = null;
    for (const row of surface.querySelectorAll(ACTION_ROW_SELECTOR)) {
        if (row.getClientRects().length === 0 || getComputedStyle(row).visibility === 'hidden') {
            continue;
        }
        const box = row.getBoundingClientRect();
        if (!(box.height > 0) || box.top + box.height / 2 <= middle) {
            continue;
        }
        const offset = (box.top - surfaceBox.top) / scale;
        top = top === null ? offset : Math.min(top, offset);
    }
    return top;
}

function layoutHeight() {
    return document.documentElement.clientHeight || window.innerHeight;
}

function setProperty(element, property, value) {
    if (value === null) {
        element.style.removeProperty(property);
    } else if (element.style.getPropertyValue(property) !== value) {
        element.style.setProperty(property, value);
    }
}

function pixels(value) {
    return `${Math.round(value)}px`;
}

/** How much of the bottom of the window the composer and the software keyboard cover, in px. */
function windowBottomInset() {
    const composer = document.getElementById(COMPOSER_ID);
    return bottomInset({
        layoutHeight: layoutHeight(),
        viewport: window.visualViewport,
        composerBox: composer?.getBoundingClientRect(),
    });
}

/** @param {HTMLElement} overlay */
function placeInWindow(overlay) {
    setProperty(overlay, BOTTOM_INSET_PROPERTY, pixels(windowBottomInset()));
    for (const property of [FRAME_LEFT_PROPERTY, FRAME_WIDTH_PROPERTY, FRAME_BOTTOM_PROPERTY]) {
        setProperty(overlay, property, null);
    }
}

/**
 * Puts the overlay at the bottom of the dialog's surface, above its action row. The host is the overlay's containing
 * block. A Popup is its own surface, so the CSS gives the overlay its width. A frame of the shared dialog is a
 * full-window host, so the left and width of its surface are written too.
 * Layout offsets are used, because a surface is scaled while it opens and a drawn box would be read too small.
 * @param {HTMLElement} overlay
 * @param {HTMLElement} host
 */
function placeInDialog(overlay, host) {
    setProperty(overlay, BOTTOM_INSET_PROPERTY, null);
    const surface = dialogSurfaceOf(host);
    const isFrame = surface !== host;
    const originInHost = isFrame ? surface.offsetTop : -host.clientTop;
    const rowTop = actionRowTop(surface);
    const bottom = dialogToastBottom({
        hostHeight: host.clientHeight,
        surfaceBottom: isFrame ? surface.offsetTop + surface.offsetHeight : host.clientHeight,
        rowTop: rowTop === null ? null : originInHost + rowTop,
    });
    setProperty(overlay, FRAME_BOTTOM_PROPERTY, pixels(bottom));
    setProperty(overlay, FRAME_LEFT_PROPERTY, isFrame ? pixels(surface.offsetLeft) : null);
    setProperty(overlay, FRAME_WIDTH_PROPERTY, isFrame ? pixels(surface.offsetWidth) : null);
}

/**
 * The in-app notifications sit beyond the toasts when both are at the same position, and the stack offset already holds
 * the space under the toasts. Otherwise a bottom notification sits above the composer and the keyboard as a toast does.
 * In a dialog the toast is at the dialog's bottom and the notifications keep their window position, so they do not
 * share a stack there.
 * @param {HTMLElement|null} overlay
 * @param {HTMLElement|null} notifications
 * @param {boolean} inDialog
 */
function placeNotifications(overlay, notifications, inDialog) {
    if (!notifications) {
        return;
    }
    const samePosition = overlay !== null
        && !inDialog
        && POSITION_CLASSES.some(name => overlay.classList.contains(name) && notifications.classList.contains(name));
    const edge = edgeOf(notifications.className, false);
    const offset = samePosition ? stackOffset({ edge, layoutHeight: layoutHeight(), overlayBox: overlay.getBoundingClientRect() }) : null;
    setProperty(notifications, STACK_OFFSET_PROPERTY, offset === null ? null : pixels(offset));
    setProperty(notifications, BOTTOM_INSET_PROPERTY, samePosition || edge === 'top' ? null : pixels(windowBottomInset()));
}

/**
 * Measures the page and writes the placement of the overlay and of the notification container.
 * @param {{ jump?: boolean }} [options] `jump` moves the notification container to its place at once. The container eases
 * its margin when the stack offset changes, which suits a toast that comes or goes beside notifications that are on
 * screen, but a container that has just been made would glide from the top bar to its place under the toasts, and its
 * clip edge with it.
 */
export function updateToastPlacement({ jump = false } = {}) {
    const notifications = document.getElementById(NOTIFICATION_CONTAINER_ID);
    if (jump && notifications) {
        notifications.style.setProperty('transition', 'none');
        writeToastPlacement(notifications);
        // The style is resolved without the transition before it comes back.
        void notifications.offsetHeight;
        notifications.style.removeProperty('transition');
        return;
    }
    writeToastPlacement(notifications);
}

/** @param {HTMLElement|null} notifications */
function writeToastPlacement(notifications) {
    const overlay = document.getElementById(TOAST_OVERLAY_ID);
    if (overlay) {
        const host = overlay.parentElement;
        const inDialog = host instanceof HTMLDialogElement;
        overlay.toggleAttribute(IN_DIALOG_ATTRIBUTE, inDialog);
        if (inDialog) {
            placeInDialog(overlay, host);
        } else {
            placeInWindow(overlay);
        }
        placeNotifications(overlay, notifications, inDialog);
        // A dialog builds its action rows after it opens, and the rows that are watched are the ones it has now.
        observeToastPlacement();
    } else {
        placeNotifications(null, notifications, false);
    }
}

let scheduled = 0;

/** Measures once per frame, however many events asked for it. */
export function scheduleToastPlacement() {
    if (scheduled || typeof requestAnimationFrame !== 'function') {
        return;
    }
    scheduled = requestAnimationFrame(() => {
        scheduled = 0;
        updateToastPlacement();
    });
}

let started = false;
/** @type {ResizeObserver|null} */
let resizeObserver = null;
const observed = new Set();

/**
 * Watches what moves a toast: the window, the visual viewport, the composer, the overlay's own height, and the dialog
 * surface and its action rows. Elements come and go (a page change hides the composer, a toast makes the overlay), so `observe` is called
 * again whenever one may be new.
 */
export function observeToastPlacement() {
    if (typeof ResizeObserver !== 'function') {
        return;
    }
    resizeObserver ??= new ResizeObserver(scheduleToastPlacement);
    const overlay = document.getElementById(TOAST_OVERLAY_ID);
    const host = overlay?.parentElement;
    const surface = host instanceof HTMLDialogElement ? dialogSurfaceOf(host) : null;
    const targets = [
        document.getElementById(COMPOSER_ID),
        overlay,
        surface,
        surface ? host : null,
        ...(surface?.querySelectorAll(ACTION_ROW_SELECTOR) ?? []),
    ];
    for (const target of targets) {
        if (target && !observed.has(target)) {
            observed.add(target);
            resizeObserver.observe(target);
        }
    }
    for (const target of observed) {
        if (!target.isConnected) {
            resizeObserver.unobserve(target);
            observed.delete(target);
        }
    }
}

/** Starts the listeners once. Calling it again changes nothing. */
export function startToastPlacement() {
    if (started || typeof window?.addEventListener !== 'function' || typeof document?.addEventListener !== 'function') {
        return;
    }
    started = true;
    window.addEventListener('resize', scheduleToastPlacement, { passive: true });
    createMobileViewportObserver({ onViewportChange: scheduleToastPlacement }).start();
    observeToastPlacement();
    scheduleToastPlacement();
}
