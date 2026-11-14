import { MOTION_FAST, SPRING_SHEET, play, stopMotion } from '../sillybunny-motion.js';
import { MENU_SHEET_QUERY } from './breakpoints.js';

const SWIPE_DISTANCE_RATIO = 0.3;
const SWIPE_VELOCITY = 0.5;
const DRAG_SLOP = 4;
const INTERACTIVE_SELECTOR = 'button, input, select, textarea, a[href], [contenteditable], [role="button"], [role="switch"], [role="menuitem"]';

function settle(result, onResolved) {
    return typeof result?.then === 'function' ? Promise.resolve(result).then(onResolved) : onResolved(result);
}

/**
 * Drag-to-close for bottom sheets (AdwDialog bottom sheet): the sheet follows the finger and
 * either closes or springs back.
 * @param {object} options
 * @param {HTMLElement} options.surface
 * @param {HTMLElement|null} [options.scrim]
 * @param {HTMLElement[]} options.targets Elements that receive the pointer listeners.
 * @param {string} [options.startSelector] Drags start only inside a match (the handle or a header bar);
 *     drags that start on a control are always ignored, except on the handle.
 * @param {'transform'|'translate'} [options.property] The property that carries the drag offset. A surface whose
 *     `transform` belongs to someone else (Popper writes one inline) uses `translate`, which composes with it.
 * @param {() => boolean} options.isActive
 * @param {(offset: number) => boolean|Promise<boolean>} options.requestClose
 * @returns {() => void} Unbinds the listeners.
 */
export function bindSheetGestures({ surface, scrim = null, targets, startSelector = null, property = 'transform', isActive, requestClose }) {
    let drag = null;
    const offsetValue = offset => (property === 'translate' ? `0 ${offset}px` : `translateY(${offset}px)`);
    const restValue = property === 'translate' ? '0 0' : 'none';

    function reset() {
        surface.style.removeProperty(property);
        scrim?.style.removeProperty('opacity');
    }

    function springBack(offset) {
        reset();
        if (offset <= 0) return;
        play(surface, [{ [property]: offsetValue(offset) }, { [property]: restValue }], SPRING_SHEET);
        if (scrim) play(scrim, [{ opacity: 0.5 }, { opacity: 1 }], { duration: MOTION_FAST });
    }

    // A sheet can hide or change presentation while a pointer is held. Its pointer events then stop,
    // so the next event is where a stale drag is found and dropped.
    function dropStaleDrag() {
        if (!drag || isActive()) return;
        drag = null;
        reset();
    }

    function onDown(event) {
        dropStaleDrag();
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
        dropStaleDrag();
        if (!drag || event.pointerId !== drag.id) return;
        const offset = track(event);
        if (offset < DRAG_SLOP) return;
        surface.style.setProperty(property, offsetValue(offset));
        if (scrim && drag.height > 0) scrim.style.setProperty('opacity', String(Math.max(0, 1 - offset / drag.height)));
    }

    function onUp(event) {
        dropStaleDrag();
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

    // The browser releases pointer capture when the sheet hides, which ends the drag without a pointerup.
    const listeners = [['pointerdown', onDown], ['pointermove', onMove], ['pointerup', onUp], ['pointercancel', onCancel], ['lostpointercapture', onCancel]];
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

/** The grab handle shared by every bottom sheet. The sheet's own styles decide when it shows. */
export function createSheetHandle() {
    const handle = document.createElement('div');
    handle.className = 'sb-dialog__handle';
    handle.setAttribute('aria-hidden', 'true');
    return handle;
}

/**
 * Swipe-down close for an overlay sheet that a sheet controller opens and closes. The controller
 * continues its close animation from the dragged position, so `close` is the normal close path.
 * @param {object} options
 * @param {HTMLElement} options.sheet
 * @param {HTMLElement} options.backdrop
 * @param {string} options.headerSelector The sheet's header bar, which starts a drag like the handle does.
 * @param {() => unknown} options.close
 * @returns {() => void} Unbinds the listeners.
 */
export function bindSheetSwipeClose({ sheet, backdrop, headerSelector, close }) {
    return bindSheetGestures({
        surface: sheet,
        scrim: backdrop,
        targets: [sheet],
        startSelector: `.sb-dialog__handle, ${headerSelector}`,
        isActive: () => !sheet.hidden,
        requestClose: () => close(),
    });
}

const MENU_SHEET_ATTRIBUTE = 'data-sb-menu-sheet';
const MENU_SHEET_LEVEL = '--sb-menu-sheet-level';
const CLOSE_GUARD_MS = 500;
const ROW_SELECTOR = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Menus that are shown, in the order they opened. Escape closes the last one. */
const shownMenus = [];
let escapeBound = false;

function isRendered(element) {
    return element.getClientRects().length > 0;
}

function onEscapeKey(event) {
    if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return;
    const top = shownMenus.at(-1);
    if (!top?.owns(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    top.escape();
}

function setEscapeBound(bound) {
    if (bound === escapeBound) return;
    escapeBound = bound;
    if (bound) document.addEventListener('keydown', onEscapeKey, true);
    else document.removeEventListener('keydown', onEscapeKey, true);
}

function readTriggerTooltip(trigger) {
    const tooltip = trigger.getAttribute('title') || trigger.querySelector('[title]')?.getAttribute('title') || trigger.getAttribute('aria-label') || '';
    return tooltip.trim();
}

function matchesFocusVisible(element) {
    try {
        return element.matches(':focus-visible');
    } catch {
        return false;
    }
}

function restoreAttribute(element, name, value) {
    if (value === null) element.removeAttribute(name);
    else element.setAttribute(name, value);
}

/**
 * Presents a menu that upstream code already opens and closes (a node it shows with `display`, positioned by
 * Popper) as a bottom sheet under the overlay breakpoint (`MENU_SHEET_QUERY`), and leaves it as that popover above it. The node, its
 * children and the upstream open and close paths stay as they are: the presenter watches the node, and while it
 * is shown on a phone it adds a grab handle (first child), a scrim (the node's previous sibling) and the
 * `data-sb-menu-sheet` attribute that the sheet rules of `sillybunny-mobile-shell.css` read. Those rules win over
 * Popper's inline `position`, `inset` and `transform` with `!important`; a swipe moves the sheet through `translate`,
 * which composes with Popper's `transform`, so Popper keeps writing and nothing here fights it. Popper's placement
 * returns by itself: the node is closed when the width crosses the breakpoint, and the next open measures it again.
 * At every width Escape closes the menu and focus moves in on open and back to the trigger on close; nothing traps focus.
 * @param {object} options
 * @param {HTMLElement} options.node The menu node.
 * @param {() => HTMLElement|null} [options.getTrigger] The control that opens the menu, read when it is needed.
 * @param {() => void} [options.close] Runs the upstream close path. Defaults to a click on the trigger, which
 *     closes a menu that its trigger toggles.
 * @param {(trigger: HTMLElement) => string} [options.getTitle] The sheet's accessible name; defaults to the trigger's tooltip.
 * @returns {{ readonly isOpen: boolean, readonly isPresented: boolean, close: () => void, dispose: () => void }}
 */
export function presentMenuAsSheet({ node, getTrigger = () => null, close = null, getTitle = readTriggerTooltip }) {
    const media = window.matchMedia(MENU_SHEET_QUERY);
    let open = false;
    let closing = false;
    let closingTimer = 0;
    let lastOpacity = null;
    let addedTabindex = false;
    let chrome = null;

    function isShown() {
        if (!node.isConnected) return false;
        const inline = node.style.display;
        if (inline === 'none') return false;
        return inline !== '' || getComputedStyle(node).display !== 'none';
    }

    function resetDrag() {
        node.style.removeProperty('translate');
        chrome?.scrim.style.removeProperty('opacity');
    }

    // The close request can fail to hide the node (a toggle whose state drifted), so the guard expires.
    function markClosing() {
        closing = true;
        clearTimeout(closingTimer);
        closingTimer = setTimeout(() => {
            closing = false;
            if (open) resetDrag();
        }, CLOSE_GUARD_MS);
    }

    function requestClose() {
        if (!open || closing) return;
        markClosing();
        if (close) close();
        else getTrigger()?.click();
    }

    function focusTrigger() {
        const trigger = getTrigger();
        if (trigger?.isConnected && isRendered(trigger)) trigger.focus({ preventScroll: true });
    }

    function moveFocusIn() {
        if (!open || closing) return;
        const trigger = getTrigger();
        const row = trigger && matchesFocusVisible(trigger)
            ? [...node.querySelectorAll(ROW_SELECTOR)].find(candidate => isRendered(candidate))
            : null;
        if (!row && !node.hasAttribute('tabindex')) {
            node.tabIndex = -1;
            addedTabindex = true;
        }
        (row ?? node).focus({ preventScroll: true });
    }

    // A drag from the handle captures the pointer on the node, so the click that follows it targets the node. Upstream
    // outside-click handlers close a menu for any click that is not on a row, which a tap or a swipe on the handle is not.
    function onNodeClick(event) {
        if (event.target === node || event.target === chrome?.handle) event.stopPropagation();
    }

    function onScrimClick(event) {
        event.preventDefault();
        event.stopPropagation();
        requestClose();
    }

    function presentChrome() {
        if (chrome) return;
        const trigger = getTrigger();
        const title = trigger ? getTitle(trigger) : '';
        const level = String(Math.max(0, shownMenus.findIndex(menu => menu.node === node)));
        const saved = { role: node.getAttribute('role'), label: node.getAttribute('aria-label') };
        const handle = createSheetHandle();
        const scrim = document.createElement('div');
        scrim.className = 'sb-menu-sheet-scrim';
        scrim.setAttribute('aria-hidden', 'true');
        scrim.style.setProperty(MENU_SHEET_LEVEL, level);
        scrim.addEventListener('click', onScrimClick);

        node.setAttribute(MENU_SHEET_ATTRIBUTE, '');
        node.style.setProperty(MENU_SHEET_LEVEL, level);
        // Nothing traps focus, so the sheet is not a dialog. Its rows keep the list parent that the menu's own role gives them
        // (`a11y.js` makes `.options-content` and `.list-group` lists); a node with no role gets a group, which can carry a name.
        if (title) {
            if (!node.hasAttribute('role')) node.setAttribute('role', 'group');
            node.setAttribute('aria-label', title);
        }
        node.prepend(handle);
        node.before(scrim);
        node.addEventListener('click', onNodeClick);
        const unbind = bindSheetGestures({
            surface: node,
            scrim,
            targets: [node],
            startSelector: '.sb-dialog__handle',
            property: 'translate',
            isActive: () => Boolean(chrome) && open && !closing,
            requestClose: () => {
                requestClose();
                return true;
            },
        });
        chrome = { handle, scrim, unbind, saved, mirrored: false };
        play(node, [{ translate: '0 100%' }, { translate: '0 0' }], SPRING_SHEET);
        play(scrim, [{ opacity: 0 }, { opacity: 1 }], { duration: MOTION_FAST });
    }

    function dismissChrome() {
        if (!chrome) return;
        const { handle, scrim, unbind, saved } = chrome;
        chrome = null;
        unbind();
        node.removeEventListener('click', onNodeClick);
        stopMotion(node);
        stopMotion(scrim);
        handle.remove();
        scrim.remove();
        node.removeAttribute(MENU_SHEET_ATTRIBUTE);
        node.style.removeProperty(MENU_SHEET_LEVEL);
        node.style.removeProperty('translate');
        restoreAttribute(node, 'role', saved.role);
        restoreAttribute(node, 'aria-label', saved.label);
    }

    // The upstream fade writes the node's opacity, and the scrim follows it so both leave together.
    function followOpacity() {
        const value = node.style.opacity;
        const opacity = value === '' ? null : Number.parseFloat(value);
        if (opacity !== null && lastOpacity !== null) {
            if (opacity < lastOpacity) markClosing();
            else if (opacity > lastOpacity) closing = false;
        }
        lastOpacity = opacity;
        if (!chrome) return;
        if (value !== '') {
            chrome.scrim.style.opacity = value;
            chrome.mirrored = true;
        } else if (chrome.mirrored) {
            chrome.scrim.style.removeProperty('opacity');
            chrome.mirrored = false;
        }
    }

    function onOpen() {
        open = true;
        closing = false;
        lastOpacity = null;
        shownMenus.push(entry);
        setEscapeBound(true);
        if (media.matches) presentChrome();
        requestAnimationFrame(moveFocusIn);
    }

    function onHidden() {
        const active = document.activeElement;
        const returnFocus = !active || active === document.body || node.contains(active);
        open = false;
        closing = false;
        clearTimeout(closingTimer);
        const index = shownMenus.indexOf(entry);
        if (index >= 0) shownMenus.splice(index, 1);
        if (!shownMenus.length) setEscapeBound(false);
        dismissChrome();
        if (addedTabindex) {
            node.removeAttribute('tabindex');
            addedTabindex = false;
        }
        if (returnFocus) focusTrigger();
    }

    function sync() {
        const shown = isShown();
        if (shown && !open) onOpen();
        else if (!shown && open) onHidden();
        if (open) followOpacity();
    }

    function onLayoutChange() {
        if (!open) return;
        dismissChrome();
        requestClose();
    }

    const entry = {
        node,
        owns(target) {
            const trigger = getTrigger();
            return target === document.body || target === document.documentElement
                || (target instanceof Node && (node.contains(target) || Boolean(trigger?.contains(target))));
        },
        escape() {
            requestClose();
            focusTrigger();
        },
    };

    const observer = new MutationObserver(sync);
    observer.observe(node, { attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
    media.addEventListener('change', onLayoutChange);
    sync();

    return {
        get isOpen() {
            return open;
        },
        get isPresented() {
            return Boolean(chrome);
        },
        close: requestClose,
        dispose() {
            observer.disconnect();
            media.removeEventListener('change', onLayoutChange);
            if (open) onHidden();
        },
    };
}

/** The composer menus that upstream shows as popovers: the menu node's id and the id of the control that opens it. */
const COMPOSER_MENUS = Object.freeze([
    { id: 'options', trigger: 'options_button' },
    { id: 'extensionsMenu', trigger: 'extensionsMenuButton' },
    { id: 'sd_dropdown', trigger: 'sd_gen' },
]);

/**
 * Presents each composer menu as a sheet on phones. The wand menu and the image-generation drop-down are added to
 * `<body>` after startup (and the second only when its extension is on), so the nodes are adopted as they appear.
 * @returns {() => void} Stops watching and releases every presenter.
 */
export function adoptComposerMenus() {
    const adopted = new Map();
    const scan = () => {
        for (const { id, trigger } of COMPOSER_MENUS) {
            const node = document.getElementById(id);
            const current = adopted.get(id);
            if (current?.node === node) continue;
            current?.presenter.dispose();
            adopted.delete(id);
            if (node) adopted.set(id, { node, presenter: presentMenuAsSheet({ node, getTrigger: () => document.getElementById(trigger) }) });
        }
    };
    scan();
    const observer = new MutationObserver(scan);
    observer.observe(document.body, { childList: true });
    return () => {
        observer.disconnect();
        for (const { presenter } of adopted.values()) presenter.dispose();
        adopted.clear();
    };
}
