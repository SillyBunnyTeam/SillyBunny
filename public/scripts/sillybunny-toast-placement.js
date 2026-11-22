/*
 * SillyBunny toast placement: where #sb-toast-overlay sits, as numbers that the toast CSS reads.
 * A bottom toast sits above the composer and above the software keyboard, a toast in a dialog sits at the bottom of that
 * dialog's box, and an in-app notification at the same position as the toasts sits beyond them. The CSS owns every
 * metric that does not depend on the page; this module only measures what the CSS cannot know.
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

/** @param {HTMLElement} overlay */
function placeInWindow(overlay) {
    const composer = document.getElementById(COMPOSER_ID);
    const inset = bottomInset({
        layoutHeight: layoutHeight(),
        viewport: window.visualViewport,
        composerBox: composer?.getBoundingClientRect(),
    });
    setProperty(overlay, BOTTOM_INSET_PROPERTY, pixels(inset));
    for (const property of [FRAME_LEFT_PROPERTY, FRAME_WIDTH_PROPERTY, FRAME_BOTTOM_PROPERTY]) {
        setProperty(overlay, property, null);
    }
}

/**
 * Puts the overlay at the bottom of the dialog's surface. A Popup is the overlay's own containing block, so the CSS is
 * enough. A frame of the shared dialog is a full-window host, so its surface's box is written as three lengths.
 * Layout offsets are used, because the surface is scaled while it opens and a transformed box would be read too small.
 * @param {HTMLElement} overlay
 * @param {HTMLElement} host
 */
function placeInDialog(overlay, host) {
    setProperty(overlay, BOTTOM_INSET_PROPERTY, null);
    const surface = dialogSurfaceOf(host);
    if (surface === host) {
        for (const property of [FRAME_LEFT_PROPERTY, FRAME_WIDTH_PROPERTY, FRAME_BOTTOM_PROPERTY]) {
            setProperty(overlay, property, null);
        }
        return;
    }
    const left = surface.getBoundingClientRect().left - host.getBoundingClientRect().left;
    setProperty(overlay, FRAME_LEFT_PROPERTY, pixels(left));
    setProperty(overlay, FRAME_WIDTH_PROPERTY, pixels(surface.offsetWidth));
    setProperty(overlay, FRAME_BOTTOM_PROPERTY, pixels(host.clientHeight - surface.offsetTop - surface.offsetHeight));
}

/**
 * The in-app notifications sit beyond the toasts when both are at the same position. In a dialog the toast is at the
 * dialog's bottom and the notifications keep their window position, so they do not share a stack there.
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
    setProperty(notifications, STACK_OFFSET_PROPERTY, samePosition ? pixels(overlay.getBoundingClientRect().height) : null);
}

/** Measures the page and writes the placement of the overlay and of the notification container. */
export function updateToastPlacement() {
    const overlay = document.getElementById(TOAST_OVERLAY_ID);
    const notifications = document.getElementById(NOTIFICATION_CONTAINER_ID);
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
const hostsWithMotionListeners = new WeakSet();

/**
 * Watches what moves a toast: the window, the visual viewport, the composer, the overlay's own height and the dialog
 * surface. Elements come and go (a page change hides the composer, a toast makes the overlay), so `observe` is called
 * again whenever one may be new.
 */
export function observeToastPlacement() {
    if (typeof ResizeObserver !== 'function') {
        return;
    }
    resizeObserver ??= new ResizeObserver(scheduleToastPlacement);
    const overlay = document.getElementById(TOAST_OVERLAY_ID);
    const host = overlay?.parentElement;
    const targets = [
        document.getElementById(COMPOSER_ID),
        overlay,
        host instanceof HTMLDialogElement ? dialogSurfaceOf(host) : null,
        host instanceof HTMLDialogElement ? host : null,
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
    // A dialog that opens scales its surface, and a page slide moves it, with no resize. The surface's layout box is
    // final once the motion ends.
    if (host instanceof HTMLDialogElement && !hostsWithMotionListeners.has(host)) {
        hostsWithMotionListeners.add(host);
        host.addEventListener('transitionend', scheduleToastPlacement);
        host.addEventListener('animationend', scheduleToastPlacement);
    }
}

/** Starts the listeners once. Calling it again changes nothing. */
export function startToastPlacement() {
    if (started || typeof window === 'undefined') {
        return;
    }
    started = true;
    window.addEventListener('resize', scheduleToastPlacement, { passive: true });
    createMobileViewportObserver({ onViewportChange: scheduleToastPlacement }).start();
    observeToastPlacement();
    scheduleToastPlacement();
}
