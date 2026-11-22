/*
 * SillyBunny toast placement: where #sb-toast-overlay sits, as numbers that the toast CSS reads.
 * A bottom toast sits above the bottom bars and above the software keyboard, a toast in a dialog sits at the bottom centre
 * of that dialog's box and above its action row, and an in-app notification at the same position as the toasts sits
 * beyond them. A bottom bar is the composer while it is docked at the bottom edge and nothing covers it, and a sheet that
 * is docked at the bottom edge or on a bar: with none, the window edge is the bottom edge. At the bottom centre a message is
 * centred on the bar that it sits above. The CSS owns every metric that does not depend on the page; this module only
 * measures what the CSS cannot know.
 */

import { createMobileViewportObserver } from './chat-render-lifecycle/mobile-viewport.js';
import { MOTION_SURFACE, prefersReducedMotion } from './sillybunny-motion.js';
import { TOAST_MEASURE_CLASS } from './sillybunny-toast-form.js';

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
/** How far the middle of the bar that a bottom message sits above is from the middle of the window, in px. */
export const BAR_SHIFT_PROPERTY = '--sb-toast-bar-shift';
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

/** Points across the composer's width, as shares of it, where the topmost element is read. */
const COVER_PROBE_SHARES = [0.1, 0.3, 0.5, 0.7, 0.9];
/** How far inside the composer's top edge the points lie, in px. */
const COVER_PROBE_DEPTH = 3;
/** The composer is covered when more than this share of the points that answer lie under another surface. */
const COVER_MAJORITY = 0.5;
const MESSAGE_SELECTOR = `#${NOTIFICATION_CONTAINER_ID}, #${TOAST_OVERLAY_ID}`;

function elementsAtPoint(x, y) {
    return typeof document.elementsFromPoint === 'function' ? document.elementsFromPoint(x, y) : [];
}

/**
 * Whether another surface covers the composer, whichever surface it is. A few points just inside the composer's top edge
 * are hit-tested, and a point is covered when the topmost element there is not part of the composer. A message of either
 * form is drawn above whatever it sits over, so it does not count, and an element that holds the composer (the chat shell,
 * where a gap of the composer lets the pointer through) does not cover it either. A small menu over a part of the edge does
 * not count: most of the points that answer have to be covered.
 * @param {HTMLElement} composer
 * @param {{ elementsAt?: (x: number, y: number) => Element[], layoutWidth?: number, layoutHeight?: number }} [reader]
 * @returns {boolean}
 */
export function composerCovered(composer, {
    elementsAt = elementsAtPoint,
    layoutWidth = document.documentElement.clientWidth || window.innerWidth,
    layoutHeight = document.documentElement.clientHeight || window.innerHeight,
} = {}) {
    const box = composer.getBoundingClientRect();
    const y = box.top + COVER_PROBE_DEPTH;
    if (!(box.height > 0) || y < 0 || y >= layoutHeight) {
        return false;
    }
    let answered = 0;
    let covered = 0;
    for (const share of COVER_PROBE_SHARES) {
        const x = Math.min(Math.max(box.left + box.width * share, 0), layoutWidth - 1);
        const elements = elementsAt(x, y);
        if (!elements?.length) {
            continue;
        }
        answered += 1;
        const topmost = elements.find(element => element.closest(MESSAGE_SELECTOR) === null);
        if (topmost && !composer.contains(topmost) && !topmost.contains(composer)) {
            covered += 1;
        }
    }
    return answered > 0 && covered / answered > COVER_MAJORITY;
}

/** How far the bottom of a bar may be below the bottom of the window or the top of the bar under it, and still rest on it: a height has a fraction. */
const DOCK_TOLERANCE = 4;

/**
 * Whether the composer rests on the bottom of the window. One that floats above it (MovingUI moved it) is not a bar.
 * @param {{ bottom: number, height: number }|null|undefined} box The composer's box in the layout viewport.
 * @param {number} layoutHeight
 * @returns {boolean}
 */
export function composerDocked(box, layoutHeight) {
    return Boolean(box) && box.height > 0 && layoutHeight > 0 && Math.abs(box.bottom - layoutHeight) <= DOCK_TOLERANCE;
}

/**
 * How far the middle of a bar is from the middle of the window, counting the part of the bar that is in the window.
 * @param {{ left: number, right: number }|null|undefined} box
 * @param {number} layoutWidth
 * @returns {number} px, negative to the left.
 */
export function barShift(box, layoutWidth) {
    if (!box || !(layoutWidth > 0)) {
        return 0;
    }
    const left = Math.max(box.left, 0);
    const right = Math.min(box.right, layoutWidth);
    return right > left ? Math.round((left + right) / 2 - layoutWidth / 2) : 0;
}

/** Points across the window, as shares of its width, where a sheet is looked for. */
const SHEET_PROBE_SHARES = [0.25, 0.5, 0.75];
/** How far above the edge that a sheet rests on the points lie, in px: beyond the gap that a bar keeps under a sheet. */
const SHEET_PROBE_DEPTH = 14;
/** How far above the edge a sheet may end, in px: the sheet of a side panel ends where the margin of the composer starts. */
const SHEET_GAP_ABOVE_EDGE = 12;
/** A sheet spans at least this share of the window; a panel that is docked at one side is narrower. */
const SHEET_MIN_WIDTH_SHARE = 0.5;
/** A sheet leaves at least this much of the window under the top bar uncovered; a page that covers the window does not. */
const SHEET_MIN_ROOM = 24;
/** Sheets that stand on one another, counted from the edge. */
const SHEET_MAX_STACK = 3;

/**
 * The box of an element when it is a sheet that rests on `support`: it is fixed to the window, its bottom is on `support`
 * (the bottom of the window, or the top of the bar under it) or a little above it, it spans half the window or more, and it
 * leaves room under the top bar. A dialog, an element in a dialog, a message, an element that holds the composer and the composer itself
 * are not sheets.
 * @returns {{ top: number, bottom: number, left: number, right: number }|null}
 */
function sheetBoxOn(element, support, { layoutWidth, contentTop, composer }) {
    if ((composer && (element.contains(composer) || composer.contains(element))) || element.closest(`dialog, ${MESSAGE_SELECTOR}`) !== null) {
        return null;
    }
    const box = element.getBoundingClientRect();
    if (!(box.height > 0)
        || box.bottom > support + DOCK_TOLERANCE
        || box.bottom < support - SHEET_GAP_ABOVE_EDGE
        || box.width < layoutWidth * SHEET_MIN_WIDTH_SHARE
        || box.top < contentTop + SHEET_MIN_ROOM
        || getComputedStyle(element).position !== 'fixed') {
        return null;
    }
    return { top: box.top, bottom: box.bottom, left: box.left, right: box.right };
}

/**
 * The sheets that are docked above an edge, from the lowest: a sheet that rests on the edge, then one that rests on it,
 * and so on. A few points just above the support are hit-tested, and the topmost element at each point and the elements
 * that hold it are asked whether they are a sheet, so that what lies under another surface is not found. The action menu
 * of a phone rests on the bottom of the window, and the sheet of a side panel rests on the top of the composer.
 * @param {{ edge: number, layoutWidth: number, contentTop: number, composer: HTMLElement|null, elementsAt?: (x: number, y: number) => Element[] }} reader
 * `edge` is the bottom of the window, or the top of the composer while the composer is a bar. `contentTop` is the bottom of the top bar.
 * @returns {{ top: number, bottom: number, left: number, right: number }[]}
 */
export function sheetsAbove({ edge, layoutWidth, contentTop, composer, elementsAt = elementsAtPoint }) {
    const found = [];
    let support = edge;
    while (found.length < SHEET_MAX_STACK) {
        let highest = null;
        for (const share of SHEET_PROBE_SHARES) {
            const topmost = elementsAt(layoutWidth * share, support - SHEET_PROBE_DEPTH)?.find(element => element.closest(MESSAGE_SELECTOR) === null);
            for (let element = topmost; element && element !== document.body && element !== document.documentElement; element = element.parentElement) {
                const box = sheetBoxOn(element, support, { layoutWidth, contentTop, composer });
                if (box && (highest === null || box.top < highest.top)) {
                    highest = box;
                }
            }
        }
        if (highest === null) {
            break;
        }
        found.push(highest);
        support = highest.top;
    }
    return found;
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

function layoutWidth() {
    return document.documentElement.clientWidth || window.innerWidth;
}

/**
 * What the bottom messages sit above, and what they are centred on.
 * `source` is what reaches highest: the window edge when nothing does, the keyboard, the composer or a sheet. A message
 * eases when the source changes, as when a panel opens over the composer, and follows at once when the same bar grows.
 * @typedef {{ inset: number, shift: number, source: 'edge'|'keyboard'|'composer'|'sheet' }} Placement
 */

/** The bars of the window, from the lowest: the composer while it is docked and nothing covers it, and the sheets above it. */
function readBars() {
    const composer = document.getElementById(COMPOSER_ID);
    const height = layoutHeight();
    const bars = [];
    let edge = height;
    if (composer) {
        const box = composer.getBoundingClientRect();
        if (composerDocked(box, height) && !composerCovered(composer)) {
            bars.push({ kind: 'composer', top: box.top, bottom: box.bottom, left: box.left, right: box.right });
            edge = box.top;
        }
    }
    const contentTop = document.getElementById('top-bar')?.getBoundingClientRect().bottom ?? 0;
    for (const sheet of sheetsAbove({ edge, layoutWidth: layoutWidth(), contentTop, composer })) {
        bars.push({ kind: 'sheet', ...sheet });
    }
    return bars;
}

/** @returns {Placement} */
function readPlacement() {
    const height = layoutHeight();
    const highest = readBars().reduce((best, bar) => (best === null || bar.top < best.top ? bar : best), null);
    const barBox = highest && { top: highest.top, bottom: highest.bottom, height: highest.bottom - highest.top };
    const inset = bottomInset({ layoutHeight: height, viewport: window.visualViewport, composerBox: barBox });
    let source = 'edge';
    if (inset > 0) {
        source = keyboardInset(window.visualViewport, height) >= inset ? 'keyboard' : highest.kind;
    }
    return { inset, shift: source === 'composer' || source === 'sheet' ? barShift(highest, layoutWidth()) : 0, source };
}

/** What the last write used, which the watch compares with the page as it is now. */
let lastPlacement = { inset: 0, shift: 0, source: 'edge' };

/**
 * The shift of a message is written for a bottom position only, where the CSS centres it on the bar.
 * @param {HTMLElement} element
 * @param {Placement} placement
 */
function writeShift(element, placement) {
    setProperty(element, BAR_SHIFT_PROPERTY, placement.shift !== 0 && edgeOf(element.className, false) === 'bottom' ? pixels(placement.shift) : null);
}

/**
 * @param {HTMLElement} overlay
 * @param {Placement} placement
 */
function placeInWindow(overlay, placement) {
    setProperty(overlay, BOTTOM_INSET_PROPERTY, pixels(placement.inset));
    writeShift(overlay, placement);
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
    setProperty(overlay, BAR_SHIFT_PROPERTY, null);
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
 * the space under the toasts. Otherwise a bottom notification sits above the bottom bars and the keyboard as a toast does.
 * In a dialog the toast is at the dialog's bottom and the notifications keep their window position, so they do not
 * share a stack there.
 * @param {HTMLElement|null} overlay
 * @param {HTMLElement|null} notifications
 * @param {boolean} inDialog
 * @param {Placement} placement What the bars and the keyboard cover at the bottom of the window.
 */
function placeNotifications(overlay, notifications, inDialog, placement) {
    if (!notifications) {
        return;
    }
    const samePosition = overlay !== null
        && !inDialog
        && POSITION_CLASSES.some(name => overlay.classList.contains(name) && notifications.classList.contains(name));
    const edge = edgeOf(notifications.className, false);
    const offset = samePosition ? stackOffset({ edge, layoutHeight: layoutHeight(), overlayBox: overlayTargetBox(overlay, edge, placement.inset) }) : null;
    setProperty(notifications, STACK_OFFSET_PROPERTY, offset === null ? null : pixels(offset));
    setProperty(notifications, BOTTOM_INSET_PROPERTY, samePosition || edge === 'top' ? null : pixels(placement.inset));
    writeShift(notifications, placement);
}

/**
 * The box that the overlay is going to have, not the one it has while it glides to a new place, which would give the
 * notifications beyond it an offset from where the toasts were.
 * @param {HTMLElement} overlay
 * @param {'top'|'bottom'} edge
 * @param {number} inset
 * @returns {{ top: number, height: number }}
 */
function overlayTargetBox(overlay, edge, inset) {
    const { top, height } = overlay.getBoundingClientRect();
    return { top: edge === 'bottom' ? layoutHeight() - inset - height : top, height };
}

/** Longer than the glide, so that the transition is not taken off while it runs. */
const GLIDE_SLACK = 50;
/** @type {WeakMap<HTMLElement, number>} */
const glideTimers = new WeakMap();

/**
 * Lets a bottom container ease to the place that the next write gives it, for a message that is on screen: its `bottom`,
 * and its `margin`, which the stack offset moves. A transition that is taken off while it runs ends at once, so it stays
 * until the glide is over. It is skipped under reduced motion, as the CSS transition of the margin is.
 * @param {HTMLElement|null} element
 */
function glideToPlace(element) {
    if (!element || edgeOf(element.className, false) !== 'bottom' || prefersReducedMotion()) {
        return;
    }
    clearTimeout(glideTimers.get(element));
    element.style.setProperty('transition', 'margin var(--sb-transition-slow), bottom var(--sb-transition-slow)');
    glideTimers.set(element, setTimeout(() => element.style.removeProperty('transition'), MOTION_SURFACE + GLIDE_SLACK));
}

/**
 * Measures the page and writes the placement of the overlay and of the notification container.
 * @param {{ jump?: boolean }} [options] `jump` moves the notification container to its place at once. The container eases
 * its margin when the stack offset changes, which suits a toast that comes or goes beside notifications that are on
 * screen, but a container that has just been made would glide from the top bar to its place under the toasts, and its
 * clip edge with it.
 * `glide` eases a bottom message that is on screen to its new place, as when a panel opens over the composer.
 */
export function updateToastPlacement({ jump = false, glide = false } = {}) {
    const notifications = document.getElementById(NOTIFICATION_CONTAINER_ID);
    if (jump && notifications) {
        notifications.style.setProperty('transition', 'none');
        writeToastPlacement(notifications, glide);
        // The style is resolved without the transition before it comes back.
        void notifications.offsetHeight;
        notifications.style.removeProperty('transition');
        return;
    }
    writeToastPlacement(notifications, glide);
}

/**
 * @param {HTMLElement|null} notifications
 * @param {boolean} glide
 */
function writeToastPlacement(notifications, glide) {
    const overlay = document.getElementById(TOAST_OVERLAY_ID);
    if (!overlay && !notifications) {
        syncBarWatch();
        return;
    }
    const inDialog = overlay?.parentElement instanceof HTMLDialogElement;
    if (glide && !inDialog) {
        glideToPlace(overlay);
        glideToPlace(notifications);
    }
    const placement = readPlacement();
    lastPlacement = placement;
    if (overlay) {
        overlay.toggleAttribute(IN_DIALOG_ATTRIBUTE, inDialog);
        if (inDialog) {
            placeInDialog(overlay, overlay.parentElement);
        } else {
            placeInWindow(overlay, placement);
        }
    }
    placeNotifications(overlay, notifications, inDialog, placement);
    if (overlay) {
        // A dialog builds its action rows after it opens, and the rows that are watched are the ones it has now.
        observeToastPlacement();
    }
    syncBarWatch();
}

/** What opens, closes or shows a surface: a class, an inline style, `hidden`, a dialog's `open`, `inert` and `aria-hidden`. */
const SURFACE_ATTRIBUTES = ['class', 'style', 'hidden', 'open', 'inert', 'aria-hidden'];

/** Whether either container holds a message. A toast that is only being measured is not one. */
function messagesOnScreen() {
    return [TOAST_OVERLAY_ID, NOTIFICATION_CONTAINER_ID].some((id) => {
        const container = document.getElementById(id);
        return container !== null && [...container.children].some(child => !child.classList.contains(TOAST_MEASURE_CLASS));
    });
}

/** @type {MutationObserver[]} */
let barObservers = [];
let barFrame = 0;
/** @type {WeakSet<Animation>} */
const watchedAnimations = new WeakSet();

/** The messages themselves change all the time, and none of that moves a surface. */
function isSurface(target) {
    return !(target instanceof Element) || target.closest(MESSAGE_SELECTOR) === null;
}

/**
 * A surface that the Web Animations API moves, as a sheet that springs in does, fires no event when it stops, and a
 * bar that is still on its way is not on its edge yet. The check looks again when each running animation has finished.
 */
function watchSurfaceAnimations() {
    if (typeof document.getAnimations !== 'function') {
        return;
    }
    for (const animation of document.getAnimations()) {
        if (watchedAnimations.has(animation) || animation.playState === 'finished' || !isSurface(animation.effect?.target)) {
            continue;
        }
        watchedAnimations.add(animation);
        animation.finished.then(scheduleBarCheck, scheduleBarCheck);
    }
}

/**
 * Looks at the bars once per frame, however many surfaces changed. A change that leaves the bars as they were writes
 * nothing, so a message that is on screen stays where it is while the page changes around it. A message eases when the
 * source of its place changes (a panel covers the composer, a sheet opens), and follows at once when the same bar moves
 * or grows.
 */
function checkBars() {
    barFrame = 0;
    if (!messagesOnScreen()) {
        stopBarWatch();
        return;
    }
    const now = readPlacement();
    if (now.inset !== lastPlacement.inset || now.shift !== lastPlacement.shift) {
        updateToastPlacement({ glide: now.source !== lastPlacement.source });
    } else {
        lastPlacement = now;
    }
    watchSurfaceAnimations();
}

function scheduleBarCheck() {
    if (barFrame || typeof requestAnimationFrame !== 'function') {
        return;
    }
    barFrame = requestAnimationFrame(checkBars);
}

function onSurfaceMutation(records) {
    if (!messagesOnScreen()) {
        stopBarWatch();
        return;
    }
    if (records.some(record => isSurface(record.target))) {
        scheduleBarCheck();
    }
}

function onSurfaceMotionEnd(event) {
    if (isSurface(event.target)) {
        scheduleBarCheck();
    }
}

/**
 * What a bar covers changes when a surface opens, closes, moves or ends a motion, and nothing else reports that. The
 * watch runs only while a message is on screen: the page's own attributes, the children of the body, the end of a
 * transition or an animation, which is when a panel that slides in has reached its place.
 */
function startBarWatch() {
    if (barObservers.length > 0 || typeof MutationObserver !== 'function' || !document.body) {
        return;
    }
    const attributes = new MutationObserver(onSurfaceMutation);
    attributes.observe(document.body, { attributes: true, attributeFilter: SURFACE_ATTRIBUTES, subtree: true });
    const children = new MutationObserver(onSurfaceMutation);
    children.observe(document.body, { childList: true });
    barObservers = [attributes, children];
    document.addEventListener('transitionend', onSurfaceMotionEnd, true);
    document.addEventListener('animationend', onSurfaceMotionEnd, true);
}

function stopBarWatch() {
    if (barObservers.length === 0) {
        return;
    }
    for (const observer of barObservers) {
        observer.disconnect();
    }
    barObservers = [];
    document.removeEventListener('transitionend', onSurfaceMotionEnd, true);
    document.removeEventListener('animationend', onSurfaceMotionEnd, true);
}

function syncBarWatch() {
    if (messagesOnScreen()) {
        startBarWatch();
    } else {
        stopBarWatch();
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
