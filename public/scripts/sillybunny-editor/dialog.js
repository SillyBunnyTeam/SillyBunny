import { t } from '../i18n.js';
import {
    MOTION_EASE_OUT_CUBIC,
    MOTION_FAST,
    SPRING_DIALOG,
    SPRING_NAVIGATION,
    SPRING_SHEET,
    animateIn,
    play,
    prefersReducedMotion,
    stopMotion,
} from '../sillybunny-motion.js';
import { blockUpstreamDrawerClose } from '../sillybunny-sheet.js';
import { closeActionMenu, openActionMenu } from '../sillybunny-action-menu.js';
import { closePicker } from './picker.js';
import { createListSearch } from './list-search.js';
import { OVERLAY_SHEET_QUERY } from './breakpoints.js';
import { MODAL_ATTRIBUTE, getTopmostDialog, hostOverlayLayer, releaseOverlayLayers } from './overlay-host.js';

/*
 * Shared Libadwaita dialog frame (DESIGN.md Dialogs).
 * - openAlert mirrors AdwAlertDialog: heading, body, optional extra child, 1–3 responses.
 * - openDialog mirrors AdwDialog with a header bar: the Dialog tier follows its content up to
 *   640px wide; the Window tier takes the shell's large pop-out footprint.
 * Both float above a scrim and become bottom sheets under OVERLAY_SHEET_QUERY.
 */

export { getTopmostDialog, hostOverlayLayer };

const SWIPE_DISTANCE_RATIO = 0.3;
const SWIPE_VELOCITY = 0.5;
const DRAG_SLOP = 4;
const INTERACTIVE_SELECTOR = 'button, input, select, textarea, a[href], [contenteditable], [role="button"], [role="switch"], [role="menuitem"]';
const FOCUSABLE_SELECTOR = 'button:not(:disabled), select:not(:disabled), input:not(:disabled):not([type="hidden"]), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])';

/** @type {WeakMap<HTMLDialogElement, { pushPage: (spec: object) => object }>} */
const frames = new WeakMap();
let nextId = 0;

function element(tag, className = '', text = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
}

function uid(prefix) {
    return `${prefix}-${++nextId}`;
}

function icon(glyph) {
    const node = element('i', `fa-solid fa-${glyph}`);
    node.setAttribute('aria-hidden', 'true');
    return node;
}

function iconButton(label, glyph, className) {
    const node = element('button', `sb-dialog__icon-button ${className}`);
    node.type = 'button';
    node.title = label;
    node.setAttribute('aria-label', label);
    node.append(icon(glyph));
    return node;
}

function responseButton({ id, label, appearance = null, enabled = true }) {
    const node = element('button', 'menu_button sb-dialog__response', label);
    node.type = 'button';
    node.dataset.response = id;
    if (appearance === 'suggested') node.classList.add('is-suggested', 'menu_button_primary');
    if (appearance === 'destructive') node.classList.add('is-destructive');
    node.disabled = !enabled;
    return node;
}

function isVisible(node) {
    return node instanceof HTMLElement && node.getClientRects().length > 0;
}

function firstFocusable(root) {
    const all = [...root.querySelectorAll(FOCUSABLE_SELECTOR)].filter(node => !node.closest('[hidden], [inert]'));
    return all.find(isVisible) ?? all[0] ?? null;
}

/** Reserve equal button tracks so the title stays centred while its own track can shrink. */
export function bindHeaderLayout(header) {
    const sides = [...header.querySelectorAll(':scope > .sb-dialog__header-start, :scope > .sb-dialog__header-end, :scope > .popup-controls > :is(.popup-button-ok, .popup-button-cancel), :scope > .popup-button-close')];
    const sync = () => {
        const width = Math.max(0, ...sides.map(node => node.offsetWidth));
        header.style.setProperty('--sb-dialog-header-side', `${width}px`);
    };
    sync();
    if (typeof ResizeObserver === 'undefined') return () => {};
    const observer = new ResizeObserver(sync);
    observer.observe(header);
    sides.forEach(node => observer.observe(node));
    return () => observer.disconnect();
}

function appendContent(target, content) {
    if (typeof content === 'function') content(target);
    else if (content instanceof Node) target.append(content);
}

function settle(result, onResolved) {
    return typeof result?.then === 'function' ? Promise.resolve(result).then(onResolved) : onResolved(result);
}

/**
 * Drag-to-close for bottom sheets (AdwDialog bottom sheet): the sheet follows the finger and
 * either closes or springs back. Exported for popup-frame.js and tests.
 * @param {object} options
 * @param {HTMLElement} options.surface
 * @param {HTMLElement|null} [options.scrim]
 * @param {HTMLElement[]} options.targets Elements that receive the pointer listeners.
 * @param {string} [options.startSelector] Drags start only inside a match (the handle or a header bar);
 *     drags that start on a control are always ignored, except on the handle.
 * @param {() => boolean} options.isActive
 * @param {(offset: number) => boolean|Promise<boolean>} options.requestClose
 * @returns {() => void} Unbinds the listeners.
 */
export function bindSheetGestures({ surface, scrim = null, targets, startSelector = null, isActive, requestClose }) {
    let drag = null;

    function reset() {
        surface.style.removeProperty('transform');
        scrim?.style.removeProperty('opacity');
    }

    function springBack(offset) {
        reset();
        if (offset <= 0) return;
        play(surface, [{ transform: `translateY(${offset}px)` }, { transform: 'none' }], SPRING_SHEET);
        if (scrim) play(scrim, [{ opacity: 0.5 }, { opacity: 1 }], { duration: MOTION_FAST });
    }

    function onDown(event) {
        if (drag || !isActive() || (event.button ?? 0) > 0) return;
        const target = event.target instanceof Element ? event.target : null;
        if (startSelector && !target?.closest(startSelector)) return;
        if (target?.closest(INTERACTIVE_SELECTOR) && !target.closest('.sb-dialog__handle')) return;
        // Cancelling pointerdown suppresses the compatibility mousedown, so a drag keeps focus where it was.
        if (event.cancelable) event.preventDefault();
        stopMotion(surface);
        if (scrim) stopMotion(scrim);
        drag = {
            id: event.pointerId,
            startY: event.clientY,
            lastY: event.clientY,
            lastTime: event.timeStamp,
            velocity: 0,
            offset: 0,
            height: surface.getBoundingClientRect().height,
        };
        event.currentTarget.setPointerCapture?.(event.pointerId);
    }

    function track(event) {
        const offset = Math.max(0, event.clientY - drag.startY);
        const elapsed = event.timeStamp - drag.lastTime;
        if (elapsed > 0) drag.velocity = (event.clientY - drag.lastY) / elapsed;
        drag.lastY = event.clientY;
        drag.lastTime = event.timeStamp;
        drag.offset = offset;
        return offset;
    }

    function onMove(event) {
        if (!drag || event.pointerId !== drag.id) return;
        const offset = track(event);
        if (offset < DRAG_SLOP) return;
        surface.style.setProperty('transform', `translateY(${offset}px)`);
        if (scrim && drag.height > 0) scrim.style.setProperty('opacity', String(Math.max(0, 1 - offset / drag.height)));
    }

    function onUp(event) {
        if (!drag || event.pointerId !== drag.id) return;
        const offset = track(event);
        const { height, velocity } = drag;
        drag = null;
        if (offset < DRAG_SLOP) {
            reset();
            return;
        }
        if (offset <= height * SWIPE_DISTANCE_RATIO && velocity <= SWIPE_VELOCITY) {
            springBack(offset);
            return;
        }
        settle(requestClose(offset), closed => {
            if (closed === false) springBack(offset);
        });
    }

    function onCancel(event) {
        if (!drag || event.pointerId !== drag.id) return;
        const { offset } = drag;
        drag = null;
        springBack(offset);
    }

    const listeners = [['pointerdown', onDown], ['pointermove', onMove], ['pointerup', onUp], ['pointercancel', onCancel]];
    for (const target of targets) {
        if (!target) continue;
        for (const [type, listener] of listeners) target.addEventListener(type, listener);
    }
    return () => {
        for (const target of targets) {
            if (!target) continue;
            for (const [type, listener] of listeners) target.removeEventListener(type, listener);
        }
    };
}

/**
 * Keeps a frame above the on-screen keyboard: writes the covered height to
 * `--sb-dialog-keyboard-inset` on `host` and keeps the focused field visible.
 * Exported for popup-frame.js and tests.
 * @param {HTMLElement} host
 * @returns {() => void}
 */
export function bindKeyboardInset(host) {
    const viewport = window.visualViewport;
    let frame = 0;
    function sync() {
        frame = 0;
        const inset = viewport ? Math.max(0, Math.round(window.innerHeight - viewport.offsetTop - viewport.height)) : 0;
        host.style.setProperty('--sb-dialog-keyboard-inset', `${inset}px`);
        const focused = document.activeElement;
        if (inset > 0 && focused instanceof HTMLElement && host.contains(focused) && focused.matches('input, textarea, select, [contenteditable]')) {
            focused.scrollIntoView?.({ block: 'nearest' });
        }
    }
    const schedule = () => {
        if (!frame) frame = requestAnimationFrame(sync);
    };
    viewport?.addEventListener('resize', schedule);
    viewport?.addEventListener('scroll', schedule);
    host.addEventListener('focusin', schedule);
    sync();
    return () => {
        if (frame) cancelAnimationFrame(frame);
        viewport?.removeEventListener('resize', schedule);
        viewport?.removeEventListener('scroll', schedule);
        host.removeEventListener('focusin', schedule);
        host.style.removeProperty('--sb-dialog-keyboard-inset');
    };
}

/**
 * The transparent full-viewport modal host with a scrim, shared by alerts, dialogs and windows.
 * Exported for tests and popup-frame.js; feature code uses openDialog/openAlert.
 * @param {object} options
 * @param {'alert'|'dialog'|'window'} options.tier
 * @param {string} [options.className]
 */
export function createDialogFrame({ tier, className = '' }) {
    const host = /** @type {HTMLDialogElement} */ (element('dialog', 'sb-dialog-host'));
    host.setAttribute(MODAL_ATTRIBUTE, '');
    host.dataset.tier = tier;
    const scrim = element('div', 'sb-dialog-scrim');
    scrim.setAttribute('aria-hidden', 'true');
    const surface = element('section', `sb-dialog sb-dialog--${tier}`);
    if (className) surface.classList.add(...className.split(/\s+/).filter(Boolean));
    const handle = element('div', 'sb-dialog__handle');
    handle.setAttribute('aria-hidden', 'true');
    surface.append(handle);
    host.append(scrim, surface);
    blockUpstreamDrawerClose(host);
    const query = window.matchMedia?.(OVERLAY_SHEET_QUERY) ?? { matches: false, addEventListener() {}, removeEventListener() {} };
    const isSheet = () => query.matches;
    const syncPresentation = () => {
        host.dataset.presentation = isSheet() ? 'sheet' : 'floating';
    };
    syncPresentation();
    return { host, scrim, surface, handle, query, isSheet, syncPresentation };
}

function openMotion(frame) {
    const { surface, scrim, isSheet, host } = frame;
    animateIn(scrim, [{ opacity: 0 }, { opacity: 1 }], { duration: MOTION_FAST });
    if (isSheet()) {
        animateIn(surface, [{ transform: 'translateY(100%)' }, { transform: 'none' }], SPRING_SHEET);
    } else if (host.dataset.tier === 'window') {
        animateIn(surface, [{ opacity: 0, transform: 'scale(0.96)' }, { opacity: 1, transform: 'none' }], SPRING_SHEET);
    } else {
        animateIn(surface, [{ opacity: 0, transform: 'scale(0.8)' }, { opacity: 1, transform: 'none' }], SPRING_DIALOG);
    }
}

function closeMotion(frame, offset, done) {
    const { surface, scrim, isSheet, host } = frame;
    const from = surface.style.transform || (offset > 0 ? `translateY(${offset}px)` : 'none');
    surface.style.removeProperty('transform');
    scrim.style.removeProperty('opacity');
    const options = { duration: MOTION_FAST, easing: MOTION_EASE_OUT_CUBIC, fill: 'forwards' };
    play(scrim, [{ opacity: 1 }, { opacity: 0 }], options);
    let keyframes;
    if (isSheet()) keyframes = [{ transform: from }, { transform: 'translateY(100%)' }];
    else if (host.dataset.tier === 'window') keyframes = [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(0.98)' }];
    else keyframes = [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(0.9)' }];
    play(surface, keyframes, { ...options, inert: true, onEnd: done });
}

function wrapTab(host, event) {
    if (event.key !== 'Tab' || event.defaultPrevented) return;
    const focusable = [...host.querySelectorAll(FOCUSABLE_SELECTOR)]
        .filter(node => !node.closest('[hidden], [inert]') && isVisible(node));
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
    }
}

/**
 * Builds one page: header bar, optional search row, scrolling body and optional bottom bar.
 * @returns {object}
 */
function createPage({ title, subtitle = '', content = null, search = null, menu = null, menuLabel = t`Menu`, responses = null, className = '', nested = false, onResponse, onBack }) {
    const page = element('section', 'sb-dialog__page');
    if (className) page.classList.add(...className.split(/\s+/).filter(Boolean));
    const header = element('header', 'sb-dialog__header');
    const start = element('div', 'sb-dialog__header-start');
    const titles = element('div', 'sb-dialog__titles');
    const titleNode = element('h2', 'sb-dialog__title', title);
    titleNode.id = uid('sb-dialog-title');
    const subtitleNode = element('span', 'sb-dialog__subtitle', subtitle);
    subtitleNode.hidden = !subtitle;
    titles.append(titleNode, subtitleNode);
    const end = element('div', 'sb-dialog__header-end');
    header.append(start, titles, end);
    page.append(header);

    const buttons = new Map();
    let menuButton = null;
    let closeButton = null;
    if (responses) {
        const cancel = responseButton({ id: 'cancel', label: responses.cancel?.label ?? t`Cancel` });
        cancel.classList.add('sb-dialog__cancel');
        cancel.addEventListener('click', () => onResponse('cancel', 'cancel'));
        start.append(cancel);
        buttons.set('cancel', cancel);
        const affirmative = responses.affirmative;
        if (affirmative) {
            const id = affirmative.id ?? 'affirmative';
            const node = responseButton({ ...affirmative, id, appearance: affirmative.appearance ?? 'suggested' });
            node.classList.add('sb-dialog__affirmative');
            node.addEventListener('click', () => onResponse('affirmative', id));
            end.append(node);
            buttons.set(id, node);
        }
    } else if (nested) {
        const back = iconButton(t`Back`, 'arrow-left', 'sb-dialog__back');
        back.addEventListener('click', () => onBack());
        start.append(back);
    }
    if (menu) {
        menuButton = iconButton(menuLabel, 'ellipsis-vertical', 'sb-dialog__menu');
        menuButton.setAttribute('aria-haspopup', 'menu');
        menuButton.setAttribute('aria-expanded', 'false');
        end.prepend(menuButton);
    }
    if (!responses && !nested) {
        closeButton = iconButton(t`Close`, 'xmark', 'sb-dialog__close');
        closeButton.addEventListener('click', () => onResponse('close', 'close'));
        end.append(closeButton);
    }

    let searchControl = null;
    let searchInput = null;
    const status = element('div', 'sb-dialog__status');
    status.setAttribute('aria-live', 'polite');
    const body = element('div', 'sb-dialog__body');
    if (search) {
        const field = element('label', 'sb-dialog__search');
        searchInput = /** @type {HTMLInputElement} */ (element('input', 'text_pole sb-dialog__search-input'));
        searchInput.type = 'search';
        searchInput.placeholder = search.placeholder ?? t`Search`;
        searchInput.setAttribute('aria-label', search.label ?? t`Search`);
        field.append(icon('magnifying-glass'), searchInput);
        page.append(field);
        searchControl = createListSearch({
            field, input: searchInput, scope: page, scroller: body, status,
            debounce: search.debounce ?? 0, onChange: query => search.onChange?.(query),
        });
        // The field is always shown (there is no reveal button), so Escape only clears it.
        searchInput.addEventListener('keydown', event => {
            if (event.key !== 'Escape' || event.isComposing) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            if (searchInput.value) searchControl.clear();
            else onBack?.('escape');
        }, true);
    }
    appendContent(body, content);
    page.append(body);

    let bottomBar = null;
    if (responses?.extra?.length) {
        bottomBar = element('div', 'sb-dialog__bottom-bar');
        for (const extra of responses.extra) {
            const node = responseButton(extra);
            node.addEventListener('click', () => onResponse(extra.id, extra.id));
            bottomBar.append(node);
            buttons.set(extra.id, node);
        }
        page.append(bottomBar);
    }
    page.append(status);
    const unbindHeaderLayout = bindHeaderLayout(header);

    return {
        page, header, titleNode, body, bottomBar, status, buttons, menuButton, closeButton,
        search: searchControl, searchInput,
        setTitle(text) { titleNode.textContent = text; },
        setSubtitle(text) {
            subtitleNode.textContent = text;
            subtitleNode.hidden = !text;
        },
        setResponseEnabled(id, enabled) {
            const node = buttons.get(id);
            if (node) node.disabled = !enabled;
        },
        destroy() {
            unbindHeaderLayout();
            searchControl?.destroy();
        },
    };
}

/**
 * Opens a Dialog- or Window-tier frame (§3.5 of the dialogs plan; docs/dialogs.md).
 * Opened while another frame is on top, it is pushed as a page into that frame (DESIGN.md Dialogs, stacking).
 *
 * @param {object} o
 * @param {'dialog'|'window'} [o.tier='dialog']
 * @param {string} o.title
 * @param {string} [o.subtitle]
 * @param {HTMLElement|((body: HTMLElement) => void)} [o.content]
 * @param {{ placeholder?: string, label?: string, debounce?: number, onChange: (query: string) => void }|null} [o.search]
 * @param {((trigger: HTMLElement) => object[])|null} [o.menu] Sections for openActionMenu.
 * @param {string} [o.menuLabel]
 * @param {null|{ cancel?: { label?: string }, affirmative?: { id?: string, label: string, appearance?: 'suggested'|'destructive', enabled?: boolean }, extra?: { id: string, label: string }[] }} [o.responses]
 *     null means immediate apply: the header shows Close.
 * @param {(reason: string) => boolean|Promise<boolean>} [o.canClose] Reasons: 'close', 'cancel', 'affirmative',
 *     'escape', 'scrim', 'swipe', 'programmatic', or an extra response id.
 * @param {() => HTMLElement|null} [o.initialFocus]
 * @param {string} [o.className] Added to the surface or, when pushed, to the page.
 */
export function openDialog({
    tier = 'dialog', title, subtitle = '', content = null, search = null, menu = null, menuLabel,
    responses = null, canClose = null, initialFocus = null, className = '',
}) {
    const parentHost = getTopmostDialog();
    const parent = parentHost ? frames.get(/** @type {HTMLDialogElement} */ (parentHost)) : null;
    if (parent) return parent.pushPage({ title, subtitle, content, search, menu, menuLabel, responses, canClose, initialFocus, className });

    const frame = createDialogFrame({ tier: tier === 'window' ? 'window' : 'dialog', className });
    const { host, scrim, surface, query, isSheet, syncPresentation } = frame;
    const pagesNode = element('div', 'sb-dialog__pages');
    surface.append(pagesNode);
    const returnFocus = document.activeElement;
    const closeResponse = responses ? 'cancel' : 'close';
    /** @type {'open'|'closing'|'closed'} */
    let state = 'open';
    let pending = false;
    let finish;
    const closed = new Promise(resolve => finish = resolve);
    /** @type {{ view: ReturnType<typeof createPage>, spec: object, resolve: Function }[]} */
    const stack = [];

    function topPage() {
        return stack.at(-1);
    }

    function openMenu(trigger, sections, label) {
        openActionMenu({ trigger, title: label, sections, bounds: surface });
    }

    function attempt(reason, response, offset = 0) {
        if (state !== 'open' || pending) return false;
        const approved = canClose ? canClose(reason) : true;
        if (typeof approved?.then === 'function') {
            pending = true;
            return Promise.resolve(approved).then(ok => {
                pending = false;
                if (ok === false || state !== 'open') return false;
                complete(response, offset);
                return true;
            }, error => {
                pending = false;
                throw error;
            });
        }
        if (approved === false) return false;
        complete(response, offset);
        return true;
    }

    function complete(response, offset = 0) {
        if (state !== 'open') return;
        state = 'closing';
        closeActionMenu({ animate: false });
        closePicker({ animate: false, restoreFocus: false });
        releaseOverlayLayers(host);
        host.setAttribute('closing', '');
        closeMotion(frame, offset, () => dispose(response));
    }

    function dispose(response) {
        if (state === 'closed') return;
        state = 'closed';
        query.removeEventListener('change', layoutChanged);
        unbindGestures();
        unbindKeyboard();
        for (const entry of stack) entry.view.destroy();
        frames.delete(host);
        releaseOverlayLayers(host);
        if (host.open) host.close();
        host.remove();
        if (returnFocus instanceof HTMLElement && returnFocus.isConnected) returnFocus.focus({ preventScroll: true });
        finish({ response });
    }

    function popPage(response, reason = response) {
        const entry = topPage();
        if (!entry || stack.length < 2 || state !== 'open') return false;
        const approved = entry.spec.canClose ? entry.spec.canClose(reason) : true;
        return settle(approved, ok => {
            if (ok === false || topPage() !== entry) return false;
            stack.pop();
            const previous = topPage();
            stopMotion(entry.view.page);
            previous.view.page.classList.remove('is-underlay');
            previous.view.page.hidden = false;
            previous.view.page.inert = false;
            host.setAttribute('aria-labelledby', previous.view.titleNode.id);
            const leaving = entry.view.page;
            leaving.inert = true;
            leaving.classList.add('is-leaving');
            const remove = () => {
                entry.view.destroy();
                leaving.remove();
            };
            if (prefersReducedMotion()) remove();
            else play(leaving, [{ transform: 'none' }, { transform: 'translateX(100%)' }], { ...SPRING_NAVIGATION, fill: 'forwards', onEnd: remove });
            (entry.returnFocus?.isConnected ? entry.returnFocus : firstFocusable(previous.view.page))?.focus({ preventScroll: true });
            entry.resolve({ response });
            return true;
        });
    }

    function mountPage(spec, nested) {
        const view = createPage({
            ...spec,
            nested,
            onResponse: (kind, id) => {
                if (nested) return popPage(id, kind === 'affirmative' ? 'affirmative' : id);
                return attempt(kind === 'affirmative' ? 'affirmative' : id, id);
            },
            onBack: reason => {
                if (nested) return popPage(spec.responses ? 'cancel' : 'back', reason ?? 'back');
                if (reason === 'escape') return attempt('escape', closeResponse);
                return false;
            },
        });
        if (view.menuButton) {
            view.menuButton.addEventListener('click', () => openMenu(view.menuButton, spec.menu(view.menuButton), spec.menuLabel ?? spec.title));
        }
        let resolve;
        const pageClosed = new Promise(done => resolve = done);
        const entry = { view, spec, resolve, returnFocus: nested ? document.activeElement : null };
        const previous = topPage();
        stack.push(entry);
        pagesNode.append(view.page);
        host.setAttribute('aria-labelledby', view.titleNode.id);
        if (previous) {
            previous.view.page.inert = true;
            previous.view.page.classList.add('is-underlay');
            const hidePrevious = () => {
                if (topPage() === previous) return;
                previous.view.page.hidden = true;
                previous.view.page.classList.remove('is-underlay');
            };
            if (prefersReducedMotion()) hidePrevious();
            else play(view.page, [{ transform: 'translateX(100%)' }, { transform: 'none' }], { ...SPRING_NAVIGATION, onEnd: hidePrevious });
            (spec.initialFocus?.() ?? view.searchInput ?? firstFocusable(view.body) ?? firstFocusable(view.header))?.focus({ preventScroll: true });
        }
        return { entry, pageClosed };
    }

    function handleFor(view) {
        return {
            header: view.header,
            body: view.body,
            search: view.search,
            setTitle: view.setTitle,
            setSubtitle: view.setSubtitle,
            setResponseEnabled: view.setResponseEnabled,
        };
    }

    function pushPage(spec) {
        const { entry, pageClosed } = mountPage(spec, true);
        return {
            root: host,
            surface,
            page: entry.view.page,
            ...handleFor(entry.view),
            closed: pageClosed,
            close: (response = spec.responses ? 'cancel' : 'back') => (topPage() === entry ? popPage(response, 'programmatic') : false),
            pop: (response = spec.responses ? 'cancel' : 'back') => (topPage() === entry ? popPage(response, 'programmatic') : false),
            forceClose: () => {
                if (topPage() !== entry) return;
                const original = entry.spec.canClose;
                entry.spec.canClose = null;
                popPage(spec.responses ? 'cancel' : 'back', 'programmatic');
                entry.spec.canClose = original;
            },
            push: pushPage,
        };
    }

    const { entry: rootEntry } = mountPage({ title, subtitle, content, search, menu, menuLabel, responses, initialFocus }, false);
    const root = rootEntry.view;
    frames.set(host, { pushPage });

    function requestDismiss(reason, offset = 0) {
        if (stack.length > 1) return popPage(topPage().spec.responses ? 'cancel' : 'back', reason);
        return attempt(reason, closeResponse, offset);
    }

    scrim.addEventListener('click', () => {
        if (!isSheet()) void requestDismiss('scrim');
    });
    host.addEventListener('cancel', event => {
        event.preventDefault();
        void requestDismiss('escape');
    });
    host.addEventListener('close', () => {
        // Some engines close a modal without a cancel event (repeated Escape); keep it open and ask instead.
        if (state !== 'open') return;
        host.showModal();
        void requestDismiss('escape');
    });
    host.addEventListener('keydown', event => wrapTab(host, event));

    const unbindGestures = bindSheetGestures({
        surface, scrim, targets: [surface], startSelector: '.sb-dialog__handle, .sb-dialog__header', isActive: isSheet,
        requestClose: offset => requestDismiss('swipe', offset),
    });
    const unbindKeyboard = bindKeyboardInset(host);

    function layoutChanged() {
        if (state !== 'open') return;
        stopMotion(surface);
        stopMotion(scrim);
        surface.style.removeProperty('transform');
        scrim.style.removeProperty('opacity');
        syncPresentation();
    }
    query.addEventListener('change', layoutChanged);

    document.body.append(host);
    host.showModal();
    openMotion(frame);
    (initialFocus?.() ?? root.searchInput ?? firstFocusable(root.body) ?? root.buttons.get('cancel') ?? root.closeButton)?.focus({ preventScroll: true });

    return {
        root: host,
        surface,
        page: root.page,
        ...handleFor(root),
        closed,
        close: (response = closeResponse, reason = 'programmatic') => attempt(reason, response),
        forceClose: () => complete(closeResponse),
        push: pushPage,
        get isOpen() { return state === 'open'; },
    };
}

/**
 * Mirrors AdwAlertDialog. Resolves with the activated response id, or `closeResponse` on
 * Escape, scrim or swipe. Responses are listed Cancel first; the destructive or suggested one last.
 * @param {object} o
 * @param {string} o.heading
 * @param {string} [o.body]
 * @param {Node|null} [o.bodyNode] Rich body content, used instead of `body`.
 * @param {Node|null} [o.extra] Extra child below the body (for example one switch row).
 * @param {{ id: string, label: string, appearance?: 'suggested'|'destructive', enabled?: boolean }[]} o.responses
 * @param {string|null} [o.defaultResponse] Activated by Return; leave null for destructive alerts.
 * @param {string} [o.closeResponse='cancel']
 * @param {boolean} [o.preferWide=false]
 * @returns {Promise<string>}
 */
export function openAlert({ heading, body = '', bodyNode = null, extra = null, responses, defaultResponse = null, closeResponse = 'cancel', preferWide = false }) {
    const frame = createDialogFrame({ tier: 'alert' });
    const { host, scrim, surface, query, isSheet, syncPresentation } = frame;
    host.setAttribute('role', 'alertdialog');
    if (preferWide) surface.classList.add('sb-dialog--wide');
    const content = element('div', 'sb-dialog__body');
    const headingNode = element('h2', 'sb-dialog__heading', heading);
    headingNode.id = uid('sb-alert-heading');
    host.setAttribute('aria-labelledby', headingNode.id);
    content.append(headingNode);
    const description = element('div', 'sb-dialog__message');
    description.id = uid('sb-alert-body');
    if (bodyNode instanceof Node) description.append(bodyNode);
    else description.textContent = body;
    if (description.childNodes.length) {
        content.append(description);
        host.setAttribute('aria-describedby', description.id);
    }
    if (extra instanceof Node) {
        const holder = element('div', 'sb-dialog__extra');
        holder.append(extra);
        content.append(holder);
    }
    const responsesNode = element('div', 'sb-dialog__responses');
    const buttons = new Map();
    for (const response of responses) {
        const node = responseButton(response);
        node.addEventListener('click', () => complete(response.id));
        responsesNode.append(node);
        buttons.set(response.id, node);
    }
    surface.append(content, responsesNode);
    const returnFocus = document.activeElement;
    let state = 'open';
    let finish;
    const result = new Promise(resolve => finish = resolve);

    // AdwAlertDialog lays responses out side by side at equal widths when the widest fits that
    // share, and stacks them otherwise. Sheets always stack (DESIGN.md Dialogs, narrow widths).
    function layoutResponses() {
        responsesNode.classList.remove('is-stacked');
        if (isSheet()) {
            responsesNode.classList.add('is-stacked');
            return;
        }
        responsesNode.classList.add('is-measuring');
        const nodes = [...buttons.values()];
        const widest = Math.max(0, ...nodes.map(node => node.getBoundingClientRect().width));
        const style = getComputedStyle(responsesNode);
        const gap = parseFloat(style.columnGap) || 0;
        const available = responsesNode.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
        responsesNode.classList.remove('is-measuring');
        if (widest * nodes.length + gap * (nodes.length - 1) > available + 1) responsesNode.classList.add('is-stacked');
    }

    function complete(response, offset = 0) {
        if (state !== 'open') return;
        state = 'closing';
        releaseOverlayLayers(host);
        host.setAttribute('closing', '');
        closeMotion(frame, offset, () => {
            state = 'closed';
            query.removeEventListener('change', layoutChanged);
            window.removeEventListener('resize', layoutResponses);
            unbindGestures();
            unbindKeyboard();
            if (host.open) host.close();
            host.remove();
            if (returnFocus instanceof HTMLElement && returnFocus.isConnected) returnFocus.focus({ preventScroll: true });
            finish(response);
        });
    }

    scrim.addEventListener('click', () => {
        if (!isSheet()) complete(closeResponse);
    });
    host.addEventListener('cancel', event => {
        event.preventDefault();
        complete(closeResponse);
    });
    host.addEventListener('close', () => complete(closeResponse));
    host.addEventListener('keydown', event => {
        wrapTab(host, event);
        if (event.key !== 'Enter' || event.isComposing || !defaultResponse) return;
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest('button, textarea, select, a[href]')) return;
        const node = buttons.get(defaultResponse);
        if (node && !node.disabled) {
            event.preventDefault();
            node.click();
        }
    });
    const unbindGestures = bindSheetGestures({
        surface, scrim, targets: [surface], startSelector: '.sb-dialog__handle, .sb-dialog__heading', isActive: isSheet,
        requestClose: offset => {
            complete(closeResponse, offset);
            return true;
        },
    });
    const unbindKeyboard = bindKeyboardInset(host);
    function layoutChanged() {
        if (state !== 'open') return;
        syncPresentation();
        layoutResponses();
    }
    query.addEventListener('change', layoutChanged);
    window.addEventListener('resize', layoutResponses, { passive: true });

    document.body.append(host);
    host.showModal();
    layoutResponses();
    openMotion(frame);
    const focusTarget = buttons.get(defaultResponse) ?? buttons.get(closeResponse) ?? firstFocusable(content) ?? responsesNode.querySelector('button');
    focusTarget?.focus({ preventScroll: true });
    return result;
}
