/**
 * Drag of a whole row of the conversation list to the other section, with pointer events (mouse, pen and touch alike).
 * The press itself is `createRowGesture`; this file draws what the user sees (the lifted row, the ghost under the
 * pointer, the ring on the section that a drop would reach) and reports the drop and the menu to its caller.
 *
 * Esc cancels a drag. A row has no insertion marker, because a section sorts by itself and the dropped row lands in its
 * order: the caller highlights the row that moved.
 */

import { createRowGesture } from './conversation-list-gesture.js';

const HOLD_EXPAND_MS = 500;
const AUTOSCROLL_EDGE_PX = 40;
const AUTOSCROLL_DIVISOR = 4;
const CLICK_SWALLOW_MS = 600;
const LIFT_VIBRATION_MS = 10;

/**
 * @param {HTMLElement} list The scroller that holds the sections and their rows.
 * @param {object} options
 * @param {string} options.rowSelector
 * @param {string} options.sectionSelector Each section has `data-section`.
 * @param {() => boolean} options.canDrag False while a search filters the list.
 * @param {(row: HTMLElement) => string} options.getSectionOfRow
 * @param {(row: HTMLElement, section: string) => void} options.onDrop A drop on a section other than the row's own.
 * @param {(row: HTMLElement, point: { x: number, y: number }) => void} options.onMenu A long press on a lifted row ended without a move.
 * @param {(section: string) => void} options.onHoldOver The pointer rested on a section for half a second while dragging, which opens it if it is collapsed.
 * @param {string} [options.menuOnlySelector] Elements that a finger can press for a long time to open a menu, and never drag: the heading of a folder.
 * @param {(element: HTMLElement, point: { x: number, y: number }) => void} [options.onMenuOnly] A long press on such an element ended without a move.
 * @param {() => void} options.onDragEnd A drag ended, by a drop or by Escape, after `onDrop` ran: what the drag opened for now is undone here.
 * @param {(text: string) => void} options.announce
 * @param {() => HTMLElement} [options.getGhostHost] The element the ghost row lives in; the row styles are scoped to it.
 */
export function bindRowDrag(list, { rowSelector, sectionSelector, canDrag, getSectionOfRow, onDrop, onMenu, menuOnlySelector = '', onMenuOnly = () => {}, onHoldOver, onDragEnd, announce, getGhostHost = () => list.closest('#sheld') ?? document.body }) {
    /** @type {null | { menuOnly: boolean, pointerId: number, row: HTMLElement, gesture: ReturnType<typeof createRowGesture>, cancelled: boolean, ghost: HTMLElement | null, offsetX: number, offsetY: number, lastY: number, from: string, holdKey: string, holdTimer: number, scrollFrame: number }} */
    let session = null;
    let swallowUntil = 0;

    const armClickSwallow = () => {
        swallowUntil = Date.now() + CLICK_SWALLOW_MS;
    };

    function sectionAt(x, y) {
        for (const section of list.querySelectorAll(sectionSelector)) {
            // A section that is hidden has no box; a collapsed one is a thin strip while a drag runs.
            if (!(section instanceof HTMLElement) || section.offsetParent === null) {
                continue;
            }
            const rect = section.getBoundingClientRect();
            if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
                return section;
            }
        }
        return null;
    }

    function setDropTarget(target) {
        for (const section of list.querySelectorAll(sectionSelector)) {
            section.classList.toggle('is-drop-target', section === target);
        }
    }

    function stopAutoscroll() {
        if (session) {
            cancelAnimationFrame(session.scrollFrame);
            session.scrollFrame = 0;
        }
    }

    function startAutoscroll() {
        const step = () => {
            if (!session?.ghost) {
                return;
            }
            const rect = list.getBoundingClientRect();
            const { lastY } = session;
            const top = rect.top + AUTOSCROLL_EDGE_PX;
            const bottom = rect.bottom - AUTOSCROLL_EDGE_PX;
            const speed = lastY < top ? -(top - lastY) / AUTOSCROLL_DIVISOR : lastY > bottom ? (lastY - bottom) / AUTOSCROLL_DIVISOR : 0;
            if (speed) {
                list.scrollTop += speed;
            }
            session.scrollFrame = requestAnimationFrame(step);
        };
        stopAutoscroll();
        session.scrollFrame = requestAnimationFrame(step);
    }

    function clearChrome() {
        if (!session) {
            return;
        }
        clearTimeout(session.holdTimer);
        stopAutoscroll();
        session.ghost?.remove();
        session.ghost = null;
        session.row.classList.remove('is-drag-source', 'is-lifted');
        delete list.dataset.dragging;
        setDropTarget(null);
    }

    function detach() {
        window.removeEventListener('pointermove', onPointerMove, true);
        window.removeEventListener('pointerup', onPointerUp, true);
        window.removeEventListener('pointercancel', onPointerCancel, true);
        document.removeEventListener('keydown', onKeydown, true);
        session = null;
    }

    function targetOf(x, y) {
        const section = sectionAt(x, y);
        return section && section.dataset.section !== session.from ? section : null;
    }

    const callbacks = {
        lift() {
            session.row.classList.add('is-lifted');
            navigator.vibrate?.(LIFT_VIBRATION_MS);
        },
        dragStart(x, y) {
            const { row, pointerId } = session;
            const rect = row.getBoundingClientRect();
            const ghost = /** @type {HTMLElement} */ (row.cloneNode(true));
            ghost.classList.add('sb-conversation-list-ghost');
            ghost.classList.remove('is-lifted', 'is-just-moved', 'is-selected');
            ghost.removeAttribute('data-sb-list-key');
            ghost.style.inlineSize = `${rect.width}px`;
            ghost.setAttribute('aria-hidden', 'true');
            ghost.querySelectorAll('[tabindex]').forEach(node => node.removeAttribute('tabindex'));
            getGhostHost().append(ghost);
            Object.assign(session, { ghost, offsetX: x - rect.left, offsetY: y - rect.top, lastY: y });
            list.dataset.dragging = 'true';
            row.classList.remove('is-lifted');
            row.classList.add('is-drag-source');
            try {
                row.setPointerCapture?.(pointerId);
            } catch {
                // The pointer can already be gone; the listeners on the window still receive its events.
            }
            callbacks.dragMove(x, y);
            startAutoscroll();
            announce('Dragging. Press Escape to cancel.');
        },
        dragMove(x, y) {
            const { ghost, offsetX, offsetY } = session;
            ghost.style.transform = `translate(${x - offsetX}px, ${y - offsetY}px)`;
            session.lastY = y;
            const target = targetOf(x, y);
            setDropTarget(target);
            // The rest is timed for the section that the pointer is over now: crossing other sections on the way to a closed one
            // must not leave the timer of the first of them to fire in its place.
            const holdKey = target?.dataset.section ?? '';
            if (holdKey !== session.holdKey) {
                clearTimeout(session.holdTimer);
                session.holdKey = holdKey;
                session.holdTimer = holdKey ? window.setTimeout(() => onHoldOver(holdKey), HOLD_EXPAND_MS) : 0;
            }
        },
        drop(x, y) {
            const { row } = session;
            const target = targetOf(x, y);
            armClickSwallow();
            clearChrome();
            if (target) {
                onDrop(row, target.dataset.section);
            } else {
                announce('Move cancelled.');
            }
            onDragEnd();
        },
        menu(x, y) {
            const { row, menuOnly } = session;
            row.classList.remove('is-lifted');
            armClickSwallow();
            (menuOnly ? onMenuOnly : onMenu)(row, { x, y });
        },
        abort() {
            session.row.classList.remove('is-lifted');
        },
        cancel() {
            clearChrome();
            announce('Move cancelled.');
            onDragEnd();
        },
    };

    function onPointerMove(event) {
        if (session && event.pointerId === session.pointerId && !session.cancelled) {
            if (session.gesture.phase === 'dragging') {
                event.preventDefault();
            }
            session.gesture.move(event.clientX, event.clientY);
        }
    }

    function onPointerUp(event) {
        if (!session || event.pointerId !== session.pointerId) {
            return;
        }
        if (session.cancelled) {
            // The press that Escape cancelled still ends in a click on the row, which must not open it.
            armClickSwallow();
        } else {
            session.gesture.release(event.clientX, event.clientY);
        }
        clearChrome();
        detach();
    }

    function onPointerCancel(event) {
        if (!session || event.pointerId !== session.pointerId) {
            return;
        }
        if (!session.cancelled) {
            session.gesture.cancel();
        }
        clearChrome();
        detach();
    }

    function onKeydown(event) {
        if (event.key !== 'Escape' || !session || session.cancelled || session.gesture.phase === 'ended') {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        session.cancelled = true;
        session.gesture.cancel();
        clearChrome();
    }

    function onPointerDown(event) {
        if (session || !event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) {
            return;
        }
        const target = event.target instanceof Element ? event.target : null;
        const row = target?.closest(rowSelector) ?? null;
        // A finger pressing the heading of a folder for a long time opens its menu. A mouse and a pen open it by the secondary click.
        const menuOnlyElement = !row && event.pointerType === 'touch' && menuOnlySelector ? target?.closest(menuOnlySelector) ?? null : null;
        const element = menuOnlyElement ?? row;
        const draggable = !menuOnlyElement && canDrag();
        if (!(element instanceof HTMLElement) || !list.contains(element) || (!menuOnlyElement && !draggable && event.pointerType !== 'touch')) {
            return;
        }
        const state = {
            menuOnly: Boolean(menuOnlyElement),
            pointerId: event.pointerId,
            row: element,
            cancelled: false,
            ghost: null,
            offsetX: 0,
            offsetY: 0,
            lastY: 0,
            from: draggable ? getSectionOfRow(element) : '',
            holdKey: '',
            holdTimer: 0,
            scrollFrame: 0,
        };
        session = { ...state, gesture: createRowGesture({ pointerType: event.pointerType, x: event.clientX, y: event.clientY, canDrag: draggable, on: callbacks }) };
        window.addEventListener('pointermove', onPointerMove, true);
        window.addEventListener('pointerup', onPointerUp, true);
        window.addEventListener('pointercancel', onPointerCancel, true);
        document.addEventListener('keydown', onKeydown, true);
    }

    // A lifted finger must not scroll the list under the row. The browser decides on the first touchmove whether the touch
    // scrolls, so the listener is registered before any touch starts and is not passive. Scoped to the list so touch scrolling
    // elsewhere in the app stays off the main thread.
    function onTouchMove(event) {
        if (session && session.gesture.phase !== 'pressed' && session.gesture.phase !== 'ended' && event.cancelable) {
            event.preventDefault();
        }
    }

    // A click that follows a drop or a long press lands on whatever is under the finger, which may be the menu just opened.
    function onClickCapture(event) {
        if (event.isTrusted && Date.now() < swallowUntil) {
            event.preventDefault();
            event.stopImmediatePropagation();
            swallowUntil = 0;
        }
    }

    // The browser's own drag of a picture would start a native drag over the pointer events.
    function onDragStart(event) {
        if (event.target instanceof Element && event.target.closest(rowSelector)) {
            event.preventDefault();
        }
    }

    list.addEventListener('pointerdown', onPointerDown);
    list.addEventListener('dragstart', onDragStart);
    list.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('click', onClickCapture, true);

    return () => {
        clearChrome();
        detach();
        list.removeEventListener('pointerdown', onPointerDown);
        list.removeEventListener('dragstart', onDragStart);
        list.removeEventListener('touchmove', onTouchMove);
        window.removeEventListener('click', onClickCapture, true);
    };
}
