/**
 * Keyboard focus for a long list of rows, as GTK's `GTK_LIST_TAB_ITEM` (libadwaita's `AdwSidebar`).
 *
 * - One Tab stop per list: the current row has `tabindex="0"`, the other rows and every control inside them `-1`. Tab enters
 *   the list on its current row, passes through that row's own controls, and leaves the list.
 * - Up and Down move focus to the previous or next row, Home and End to the first and last, Page Up and Page Down by a page.
 *   In a flow layout (a grid of cards) Left and Right move between cards and Up and Down by a line of cards.
 * - Hidden, `inert` and `aria-disabled` rows are skipped. A current row that stops being navigable gives its stop to the
 *   first row that is.
 * - A trailing stop (the Show More button) follows the last row for Down. Pressing it from the keyboard moves focus to the
 *   first row that the press added.
 *
 * Alt with an arrow key is left to the caller's reordering, and a row's own keys (Enter, Space, F2) are not handled here.
 *
 * `bindRovingFocus` below gives the same one-Tab-stop behaviour to a short group of controls (a tab list, a filter group). It
 * lives in this module because both load at startup and each module is a startup request.
 */

const CONTROL_SELECTOR = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [contenteditable=""], [contenteditable="true"], [tabindex]';
const GROWTH_WINDOW_MS = 5000;
const SAME_LINE_TOLERANCE_PX = 2;

const originalTabindex = new WeakMap();

function isRendered(element) {
    if (element.closest('[hidden], [inert]')) return false;
    // A document with no layout at all (a DOM that unit tests build) has no boxes to ask, so only the attributes decide.
    return element.getClientRects().length > 0 || element.ownerDocument.documentElement.getClientRects().length === 0;
}

function defaultIsSelected(row) {
    return row.getAttribute('aria-current') === 'true' || row.classList.contains('is-selected');
}

function setTabindex(element, value) {
    if (element.getAttribute('tabindex') !== value) element.setAttribute('tabindex', value);
}

/** The scroll box that bounds a page of rows: the nearest vertical scroller, else the viewport. */
function pageHeightOf(element) {
    for (let node = element.parentElement; node; node = node.parentElement) {
        const { overflowY } = getComputedStyle(node);
        if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) return node.clientHeight;
    }
    return window.innerHeight;
}

/**
 * @param {HTMLElement} container The element that holds the rows (rows may be nested in groups inside it).
 * @param {object} options
 * @param {string} options.rowSelector Selects the rows inside `container`.
 * @param {string} [options.keySourceSelector] Row descendants (a drag grip) whose arrow keys move focus like the row's own.
 * @param {() => HTMLElement[]} [options.trailingStops] Controls after the last row, reached by Down from it, such as Show More.
 * @param {boolean} [options.singleTabStop] False keeps every row in the Tab order and only adds the arrow keys; for a short list.
 * @param {(row: HTMLElement) => boolean} [options.isSelected] The selected row holds the Tab stop until focus has been in the list.
 * @returns {{ sync: () => void, focusRow: (row: HTMLElement) => void, destroy: () => void }}
 */
export function bindListFocus(container, { rowSelector, keySourceSelector = '', trailingStops = () => [], singleTabStop = true, isSelected = defaultIsSelected }) {
    let current = null;
    let currentKey = null;
    let hasHadFocus = false;
    let growth = null;
    let knownRows = new Set();
    let destroyed = false;

    const allRows = () => [...container.querySelectorAll(rowSelector)].filter(row => row instanceof HTMLElement);
    const isNavigable = row => row.isConnected && row.getAttribute('aria-disabled') !== 'true' && isRendered(row);
    const visibleTrailing = () => trailingStops().filter(stop => stop instanceof HTMLElement && !stop.disabled && isRendered(stop));
    const rowOf = target => {
        const row = target instanceof Element ? target.closest(rowSelector) : null;
        return row instanceof HTMLElement && container.contains(row) ? row : null;
    };
    const controlsOf = row => [...row.querySelectorAll(CONTROL_SELECTOR)];
    const ownsTabstop = row => row.hasAttribute('tabindex');

    /** A row that is not focusable itself (it only holds controls) is entered at its first control. */
    function primaryOf(row) {
        if (ownsTabstop(row) || row.matches(CONTROL_SELECTOR)) return row;
        return controlsOf(row).find(control => control.getAttribute('tabindex') !== '-1' || originalTabindex.has(control)) ?? row;
    }

    function settleRow(row, isCurrent) {
        if (ownsTabstop(row)) setTabindex(row, isCurrent ? '0' : '-1');
        for (const control of controlsOf(row)) {
            if (control === row) continue;
            if (isCurrent) {
                if (!originalTabindex.has(control)) continue;
                const original = originalTabindex.get(control);
                originalTabindex.delete(control);
                if (original === null) control.removeAttribute('tabindex');
                else control.setAttribute('tabindex', original);
            } else if (!originalTabindex.has(control) && control.getAttribute('tabindex') !== '-1') {
                originalTabindex.set(control, control.getAttribute('tabindex'));
                control.setAttribute('tabindex', '-1');
            }
        }
    }

    function chooseCurrent(rows) {
        if (current && rows.includes(current) && isNavigable(current)) return current;
        const remembered = currentKey === null ? null : rows.find(row => row.dataset.sbListKey === currentKey);
        if (remembered && isNavigable(remembered)) return remembered;
        const selected = hasHadFocus ? null : rows.find(row => isSelected(row) && isNavigable(row));
        if (selected) return selected;
        // A list that is not laid out yet has no navigable row; the first row holds the stop until it is.
        return rows.find(isNavigable) ?? rows[0] ?? null;
    }

    function sync() {
        if (destroyed) return;
        const rows = allRows();
        current = chooseCurrent(rows);
        knownRows = new Set(rows);
        if (singleTabStop) for (const row of rows) settleRow(row, row === current);
        observer.takeRecords();
    }

    function remember(row) {
        current = row;
        currentKey = row.dataset.sbListKey ?? null;
        hasHadFocus = true;
        sync();
    }

    function focusRow(row) {
        row.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
        remember(row);
        primaryOf(row).focus({ preventScroll: true });
    }

    function onFocusin(event) {
        const row = rowOf(event.target);
        if (!row) return;
        growth = null;
        const from = event.relatedTarget;
        const arrivedBackwards = from instanceof Node && !container.contains(from)
            && Boolean(container.compareDocumentPosition(from) & Node.DOCUMENT_POSITION_FOLLOWING);
        const hadStop = hasHadFocus || allRows().some(isSelected);
        if (arrivedBackwards && !hadStop && event.target.matches(':focus-visible')) {
            // Shift+Tab into a list with no remembered or selected row enters on the last row, as GTK does. It lands on the
            // last control of the Tab-stop row first, because that control comes last in the page order.
            const last = allRows().reverse().find(isNavigable);
            if (last && last !== row) {
                focusRow(last);
                return;
            }
        }
        if (row !== current) remember(row);
        else hasHadFocus = true;
    }

    function neighbours(rows, index) {
        const rect = rows[index].getBoundingClientRect();
        const sameLine = other => other && Math.abs(other.getBoundingClientRect().top - rect.top) <= SAME_LINE_TOLERANCE_PX;
        return { rect, flow: sameLine(rows[index + 1]) || sameLine(rows[index - 1]) };
    }

    function lineTarget(rows, index, direction) {
        const from = rows[index].getBoundingClientRect();
        const centre = from.left + from.width / 2;
        let cursor = index + direction;
        while (rows[cursor]) {
            const rect = rows[cursor].getBoundingClientRect();
            if (direction > 0 ? rect.top >= from.bottom - SAME_LINE_TOLERANCE_PX : rect.bottom <= from.top + SAME_LINE_TOLERANCE_PX) break;
            cursor += direction;
        }
        const first = rows[cursor];
        if (!first) return null;
        const lineTop = first.getBoundingClientRect().top;
        let best = first;
        let bestDistance = Infinity;
        for (let candidate = cursor; rows[candidate]; candidate += direction) {
            const rect = rows[candidate].getBoundingClientRect();
            if (Math.abs(rect.top - lineTop) > SAME_LINE_TOLERANCE_PX) break;
            const distance = Math.abs(rect.left + rect.width / 2 - centre);
            if (distance < bestDistance) {
                best = rows[candidate];
                bestDistance = distance;
            }
        }
        return best;
    }

    function pageTarget(rows, index, direction) {
        const from = rows[index].getBoundingClientRect();
        const reach = Math.max(pageHeightOf(rows[index]) - from.height, from.height);
        let target = index;
        for (let cursor = index + direction; rows[cursor]; cursor += direction) {
            if (Math.abs(rows[cursor].getBoundingClientRect().top - from.top) > reach) break;
            target = cursor;
        }
        if (target === index && rows[index + direction]) target = index + direction;
        return rows[target];
    }

    function moveTarget(key, row) {
        const rows = allRows().filter(isNavigable);
        const index = rows.indexOf(row);
        if (index < 0) return undefined;
        const { flow } = neighbours(rows, index);
        if (key === 'Home') return rows[0];
        if (key === 'End') return rows.at(-1);
        if (key === 'PageUp' || key === 'PageDown') return pageTarget(rows, index, key === 'PageUp' ? -1 : 1);
        if (key === 'ArrowLeft' || key === 'ArrowRight') return flow ? rows[index + (key === 'ArrowLeft' ? -1 : 1)] ?? null : undefined;
        const direction = key === 'ArrowUp' ? -1 : 1;
        if (flow) {
            const target = lineTarget(rows, index, direction);
            if (target || direction < 0) return target;
        } else if (rows[index + direction]) {
            return rows[index + direction];
        }
        return direction > 0 ? visibleTrailing()[0] ?? null : null;
    }

    function onKeydown(event) {
        if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) return;
        const row = rowOf(event.target);
        if (!row) return;
        const fromRow = event.target === primaryOf(row) || (keySourceSelector && event.target.closest(keySourceSelector));
        if (!fromRow) return;
        const target = moveTarget(event.key, row);
        if (target === undefined) return;
        event.preventDefault();
        if (!target || target === row) return;
        if (target.matches(rowSelector)) focusRow(target);
        else target.focus();
    }

    function onTrailingKeydown(event) {
        if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        if (event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return;
        const last = allRows().reverse().find(isNavigable);
        if (!last) return;
        event.preventDefault();
        focusRow(last);
    }

    function onTrailingClick(event) {
        // A click with no pointer behind it (detail 0) comes from Enter or Space on the focused button.
        if (event.detail !== 0) return;
        // The rows of the last pass, because the press may have added rows before this listener runs.
        growth = { rows: knownRows, until: Date.now() + GROWTH_WINDOW_MS };
    }

    function focusGrowth() {
        if (!growth) return;
        if (Date.now() > growth.until) {
            growth = null;
            return;
        }
        const { rows } = growth;
        const added = allRows().find(row => !rows.has(row) && isNavigable(row));
        if (!added) return;
        growth = null;
        focusRow(added);
    }

    const bound = new Set();
    function bindTrailing() {
        for (const stop of trailingStops()) {
            if (!(stop instanceof HTMLElement) || bound.has(stop)) continue;
            bound.add(stop);
            stop.addEventListener('keydown', onTrailingKeydown);
            stop.addEventListener('click', onTrailingClick);
        }
    }

    const observer = new MutationObserver(() => {
        bindTrailing();
        sync();
        focusGrowth();
    });
    observer.observe(container, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['hidden', 'inert', 'aria-disabled', 'aria-current', 'tabindex'],
    });
    const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
        if (!current || !isNavigable(current)) sync();
    }) : null;
    resizeObserver?.observe(container);
    container.addEventListener('keydown', onKeydown);
    container.addEventListener('focusin', onFocusin);
    bindTrailing();
    sync();

    return {
        sync,
        focusRow,
        destroy() {
            destroyed = true;
            observer.disconnect();
            resizeObserver?.disconnect();
            container.removeEventListener('keydown', onKeydown);
            container.removeEventListener('focusin', onFocusin);
            // A list can outlive its binding (the message rows while selection mode ends), so the controls get their own tabindex back.
            for (const row of allRows()) {
                for (const control of controlsOf(row)) {
                    if (!originalTabindex.has(control)) continue;
                    const original = originalTabindex.get(control);
                    originalTabindex.delete(control);
                    if (original === null) control.removeAttribute('tabindex');
                    else control.setAttribute('tabindex', original);
                }
            }
            for (const stop of bound) {
                stop.removeEventListener('keydown', onTrailingKeydown);
                stop.removeEventListener('click', onTrailingClick);
            }
            bound.clear();
        },
    };
}

const NEXT_KEYS = Object.freeze({ horizontal: 'ArrowRight', vertical: 'ArrowDown' });
const PREVIOUS_KEYS = Object.freeze({ horizontal: 'ArrowLeft', vertical: 'ArrowUp' });

/**
 * Gives a group of related controls one Tab stop. The current item has `tabindex="0"` and the others `-1`; the arrow keys of the
 * group's axis, Home and End move focus between the items and wrap at the ends. Moving only focuses unless `onMove` selects.
 *
 * An item that the page hides (`hidden`, or `display: none` on the item itself) is skipped. The stops follow the group on their
 * own: a MutationObserver re-reads the items when they are added, hidden or selected.
 *
 * @param {HTMLElement} container The element that holds the items.
 * @param {object} options
 * @param {string} options.itemSelector Selects the items inside `container`.
 * @param {'horizontal'|'vertical'} [options.orientation] The axis of the arrow keys.
 * @param {(item: HTMLElement) => boolean} [options.isSelected] Whether an item is the selected one. It holds the Tab stop when focus is elsewhere.
 * @param {(item: HTMLElement) => void} [options.onMove] Runs after focus moved with a key; a group that selects on arrow keys selects here.
 * @returns {{ sync: () => void, destroy: () => void }}
 */
export function bindRovingFocus(container, { itemSelector, orientation = 'horizontal', isSelected = () => false, onMove = null }) {
    const items = () => [...container.querySelectorAll(itemSelector)].filter(item => item instanceof HTMLElement && !item.hidden && getComputedStyle(item).display !== 'none');

    function setCurrent(current) {
        for (const item of container.querySelectorAll(itemSelector)) {
            const value = item === current ? '0' : '-1';
            if (item.getAttribute('tabindex') !== value) item.setAttribute('tabindex', value);
        }
    }

    function sync() {
        const available = items();
        const focused = available.find(item => item === document.activeElement);
        setCurrent(focused ?? available.find(isSelected) ?? available[0] ?? null);
    }

    function onKeydown(event) {
        if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        const from = event.target instanceof Element ? event.target.closest(itemSelector) : null;
        if (!from || !container.contains(from)) return;
        const available = items();
        const index = available.indexOf(from);
        if (index < 0) return;
        let target = null;
        if (event.key === NEXT_KEYS[orientation]) target = available[(index + 1) % available.length];
        else if (event.key === PREVIOUS_KEYS[orientation]) target = available[(index - 1 + available.length) % available.length];
        else if (event.key === 'Home') target = available[0];
        else if (event.key === 'End') target = available.at(-1);
        if (!target) return;
        event.preventDefault();
        setCurrent(target);
        target.focus({ preventScroll: false });
        if (target !== from) onMove?.(target);
    }

    function onFocusin(event) {
        const item = event.target instanceof Element ? event.target.closest(itemSelector) : null;
        if (item && container.contains(item)) setCurrent(item);
    }

    container.addEventListener('keydown', onKeydown);
    container.addEventListener('focusin', onFocusin);
    const observer = new MutationObserver(sync);
    observer.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden', 'aria-selected', 'aria-pressed'] });
    sync();

    return {
        sync,
        destroy() {
            observer.disconnect();
            container.removeEventListener('keydown', onKeydown);
            container.removeEventListener('focusin', onFocusin);
        },
    };
}
