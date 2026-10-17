import { t } from '../i18n.js';

function createIcon(icon) {
    if (icon instanceof Element) {
        const clone = /** @type {Element} */ (icon.cloneNode(true));
        clone.removeAttribute('id');
        clone.setAttribute('aria-hidden', 'true');
        return clone;
    }
    const element = document.createElement('i');
    element.className = icon || 'fa-solid fa-puzzle-piece';
    element.setAttribute('aria-hidden', 'true');
    return element;
}

function normalizeKey(key) {
    return key === null || key === undefined ? null : String(key);
}

function normalizeKeys(keys) {
    if (keys === null || keys === undefined) {
        return [];
    }
    const values = typeof keys === 'string' ? [keys] : [...keys];
    return values.map(normalizeKey).filter(key => key !== null);
}

/**
 * Adds GNOME-style selection mode affordances and interactions to a keyed list.
 * @param {object} options
 * @param {HTMLElement} options.root
 * @param {HTMLElement} options.list
 * @param {string} [options.rowSelector='[data-sb-list-key]']
 * @param {string} [options.keySourceSelector=''] Row descendants (e.g. drag grips) whose Space/Enter toggle the row.
 * @param {(row: HTMLElement) => string} [options.rowLabel] Accessible name used for each row's checkbox.
 * @param {(row: HTMLElement) => string} [options.getKey]
 * @param {boolean} [options.range=false] Enables anchored Shift-click and Shift-Space/Enter ranges.
 * @param {() => Iterable<string>} [options.getAllKeys] Keys across every filtered page for select-all.
 * @param {HTMLElement} options.header
 * @param {HTMLElement} options.actionBar
 * @param {{ id: string, label: string, icon?: string|Element, danger?: boolean, onActivate: (keys: string[]) => void }[]} [options.actions=[]]
 * @param {(count: number) => string} [options.title]
 * @param {string} [options.selectAllLabel] Defaults to the existing Select all label.
 * @param {() => boolean} [options.canEnter] Whether gestures or enter() may start selection.
 * @param {(keys: string[]) => void|null} [options.onChange=null]
 * @param {() => void|null} [options.onExit=null]
 * @returns {{ enter: (initialKey?: string, trigger?: HTMLElement) => void, exit: () => void, toggle: (key: string) => void,
 * select: (keys: Iterable<string>) => void, clear: () => void, selectAll: () => void,
 * readonly isActive: boolean, readonly selectedKeys: string[], readonly count: number,
 * decorate: (options?: { prune?: boolean }) => void, destroy: () => void }}
 */
export function createSelectionMode({
    root,
    list,
    rowSelector = '[data-sb-list-key]',
    keySourceSelector = '',
    getKey = row => row.dataset.sbListKey,
    range = false,
    getAllKeys,
    rowLabel = row => row.getAttribute('aria-label') || row.querySelector('.ds-row-label, .sb-prompt-row-name')?.textContent?.trim() || '',
    header,
    actionBar,
    actions = [],
    title = count => t`${count} selected`,
    selectAllLabel = t`Select all`,
    canEnter = () => true,
    onChange = null,
    onExit = null,
}) {
    if (!(root instanceof HTMLElement) || !(list instanceof HTMLElement) || !(header instanceof HTMLElement) || !(actionBar instanceof HTMLElement)) {
        throw new TypeError('createSelectionMode requires root, list, header, and actionBar elements');
    }

    let active = false;
    let selected = new Set();
    let anchorKey = null;
    let focusReturn = null;
    let longPressTimer = 0;
    let longPressState = null;
    let suppressNextClick = false;
    root.dataset.selectionMode = 'false';
    header.hidden = true;
    actionBar.hidden = true;
    actionBar.classList.add('sb-selection-action-bar');
    actionBar.setAttribute('role', 'toolbar');
    actionBar.setAttribute('aria-label', t`Selection actions`);

    const rowFrom = target => {
        if (!(target instanceof Element)) {
            return null;
        }
        const row = target.closest(rowSelector);
        return row instanceof HTMLElement && list.contains(row) ? row : null;
    };
    const keyFromRow = row => normalizeKey(getKey(row));
    const rows = () => [...list.querySelectorAll(rowSelector)].filter(row => row instanceof HTMLElement);
    const allKeys = () => getAllKeys ? normalizeKeys(getAllKeys()) : rows().map(keyFromRow);
    const areAllSelected = keys => keys.length > 0 && keys.every(key => key !== null && selected.has(key));
    const selectedSnapshot = () => [...selected];

    function emitChange() {
        onChange?.(selectedSnapshot());
    }

    function removeCheck(row) {
        for (const check of row.querySelectorAll(':scope > .sb-selection-check')) {
            check.remove();
        }
    }

    function applyDecorations() {
        for (const row of rows()) {
            const key = keyFromRow(row);
            if (key === null) {
                continue;
            }
            let check = row.querySelector(':scope > .sb-selection-check');
            if (!check) {
                // The checkbox carries the selection semantics: generic list rows cannot take aria-selected.
                // It stays out of the tab order because the focused row already toggles with Space/Enter.
                check = document.createElement('input');
                check.type = 'checkbox';
                check.className = 'sb-selection-check';
                check.tabIndex = -1;
            }
            const name = rowLabel(row);
            if (name) check.setAttribute('aria-label', t`Select ${name}`);
            if (row.firstElementChild !== check) {
                row.prepend(check);
            }
            const isSelected = selected.has(key);
            row.classList.toggle('is-selection-selected', isSelected);
            check.checked = isSelected;
        }
    }

    function renderHeader() {
        const row = document.createElement('div');
        row.className = 'sb-selection-header';

        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'menu_button sb-selection-cancel';
        cancel.textContent = t`Cancel`;
        cancel.addEventListener('click', exit);

        const heading = document.createElement('h2');
        heading.className = 'sb-selection-title';
        heading.setAttribute('aria-live', 'polite');
        heading.textContent = title(selected.size);

        const selectAllButton = document.createElement('button');
        selectAllButton.type = 'button';
        selectAllButton.className = 'menu_button sb-selection-select-all';
        selectAllButton.textContent = selectAllLabel;
        selectAllButton.addEventListener('click', () => {
            const keys = allKeys();
            if (areAllSelected(keys)) {
                const pageKeys = new Set(keys);
                updateSelection(new Set([...selected].filter(key => !pageKeys.has(key))));
            } else {
                selectAll();
            }
        });
        row.append(cancel, heading, selectAllButton);
        header.replaceChildren(row);
        header.hidden = false;
    }

    function renderActionBar() {
        actionBar.replaceChildren();
        for (const action of actions) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'menu_button sb-selection-action';
            button.dataset.actionId = action.id;
            button.classList.toggle('is-danger', Boolean(action.danger));
            button.disabled = selected.size === 0;
            button.append(createIcon(action.icon));
            const label = document.createElement('span');
            label.textContent = action.label;
            button.append(label);
            button.addEventListener('click', event => {
                event.preventDefault();
                action.onActivate?.(selectedSnapshot());
            });
            actionBar.append(button);
        }
        actionBar.hidden = false;
    }

    function render() {
        if (!active) {
            return;
        }
        const heading = header.querySelector('.sb-selection-title');
        if (heading) {
            heading.textContent = title(selected.size);
        }
        const selectAllButton = header.querySelector('.sb-selection-select-all');
        selectAllButton?.setAttribute('aria-pressed', String(areAllSelected(allKeys())));
        for (const button of actionBar.querySelectorAll('.sb-selection-action')) {
            button.disabled = selected.size === 0;
        }
        applyDecorations();
    }

    function updateSelection(next) {
        const changed = next.size !== selected.size || [...next].some(key => !selected.has(key));
        selected = next;
        render();
        if (changed) {
            emitChange();
        }
    }

    function enter(initialKey = null, trigger = null) {
        if (active || !canEnter()) {
            return;
        }
        stopLongPress();
        const focusedRow = rowFrom(document.activeElement);
        focusReturn = trigger ?? focusedRow ?? (root.contains(document.activeElement) ? document.activeElement : list);
        active = true;
        root.dataset.selectionMode = 'true';
        selected = new Set();
        const normalized = normalizeKey(initialKey);
        anchorKey = normalized;
        if (normalized !== null) {
            selected.add(normalized);
        }
        renderHeader();
        renderActionBar();
        render();
        emitChange();
        header.querySelector('.sb-selection-cancel')?.focus({ preventScroll: true });
    }

    function exit() {
        if (!active) {
            return;
        }
        stopLongPress();
        suppressNextClick = false;
        const hadSelection = selected.size > 0;
        active = false;
        root.dataset.selectionMode = 'false';
        for (const row of rows()) {
            row.classList.remove('is-selection-selected');
            removeCheck(row);
        }
        header.hidden = true;
        actionBar.hidden = true;
        header.replaceChildren();
        actionBar.replaceChildren();
        selected = new Set();
        anchorKey = null;
        if (hadSelection) {
            emitChange();
        }
        onExit?.();
        const target = focusReturn?.isConnected ? focusReturn : list;
        if (target === list && !list.hasAttribute('tabindex')) {
            list.tabIndex = -1;
        }
        target?.focus?.({ preventScroll: true });
        focusReturn = null;
    }

    function toggle(key) {
        if (!active) {
            return;
        }
        const normalized = normalizeKey(key);
        if (normalized === null) {
            return;
        }
        const next = new Set(selected);
        if (next.has(normalized)) {
            next.delete(normalized);
        } else {
            next.add(normalized);
        }
        updateSelection(next);
    }

    function select(keys) {
        if (!active) {
            return;
        }
        updateSelection(new Set(normalizeKeys(keys)));
    }

    function clear() {
        anchorKey = null;
        if (!active || selected.size === 0) {
            return;
        }
        updateSelection(new Set());
    }

    function selectAll() {
        if (!active) {
            return;
        }
        updateSelection(new Set([...selected, ...allKeys().filter(key => key !== null)]));
    }

    function toggleRow(row, extendRange) {
        const key = keyFromRow(row);
        const orderedKeys = range && extendRange ? rows().map(keyFromRow) : [];
        const anchorIndex = anchorKey === null ? -1 : orderedKeys.indexOf(anchorKey);
        const targetIndex = key === null ? -1 : orderedKeys.indexOf(key);
        if (anchorIndex < 0 || targetIndex < 0) {
            toggle(key);
            if (range && key !== null) anchorKey = key;
            return;
        }
        const next = new Set(selected);
        const selectRange = selected.has(anchorKey);
        for (const rangeKey of orderedKeys.slice(Math.min(anchorIndex, targetIndex), Math.max(anchorIndex, targetIndex) + 1)) {
            if (rangeKey === null) continue;
            if (selectRange) next.add(rangeKey);
            else next.delete(rangeKey);
        }
        updateSelection(next);
    }

    function decorate({ prune = false } = {}) {
        if (!active) {
            return;
        }
        if (prune) {
            const present = new Set(rows().map(keyFromRow).filter(key => key !== null));
            const next = new Set([...selected].filter(key => present.has(key)));
            updateSelection(next);
            return;
        }
        render();
    }

    function stopLongPress() {
        clearTimeout(longPressTimer);
        longPressTimer = 0;
        longPressState = null;
        window.removeEventListener('pointermove', handleLongPressMove, true);
        window.removeEventListener('pointerup', stopLongPress, true);
        window.removeEventListener('pointercancel', stopLongPress, true);
    }

    function handleLongPressMove(event) {
        if (!longPressState || event.pointerId !== longPressState.pointerId) {
            return;
        }
        const distance = Math.hypot(event.clientX - longPressState.x, event.clientY - longPressState.y);
        if (distance > 8) {
            stopLongPress();
        }
    }

    function handlePointerDown(event) {
        suppressNextClick = false;
        if (active || event.pointerType !== 'touch' || !canEnter()) {
            return;
        }
        const row = rowFrom(event.target);
        if (!row) {
            return;
        }
        stopLongPress();
        longPressState = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, row };
        longPressTimer = setTimeout(() => {
            const pending = longPressState;
            stopLongPress();
            if (!pending || !pending.row.isConnected) {
                return;
            }
            suppressNextClick = true;
            enter(keyFromRow(pending.row), pending.row);
            if (typeof navigator.vibrate === 'function') {
                navigator.vibrate(10);
            }
        }, 500);
        window.addEventListener('pointermove', handleLongPressMove, true);
        window.addEventListener('pointerup', stopLongPress, true);
        window.addEventListener('pointercancel', stopLongPress, true);
    }

    function handleClick(event) {
        if (!active) {
            return;
        }
        const row = rowFrom(event.target);
        if (!row) {
            return;
        }
        // Checkbox activation precedes click dispatch; cancelling it would undo the new check state.
        const check = event.target instanceof HTMLInputElement && event.target.matches('.sb-selection-check') ? event.target : null;
        if (!check) {
            event.preventDefault();
        }
        event.stopPropagation();
        if (suppressNextClick) {
            suppressNextClick = false;
            if (check) {
                check.checked = selected.has(keyFromRow(row));
            }
            return;
        }
        toggleRow(row, event.shiftKey);
    }

    function handleKeydown(event) {
        if (!active || event.isComposing) {
            return;
        }
        const row = rowFrom(event.target);
        const fromRow = row && (event.target === row
            || event.target.matches?.('.sb-selection-check')
            || (keySourceSelector && event.target.closest?.(keySourceSelector)));
        if (!fromRow || ![' ', 'Enter'].includes(event.key)
            || event.altKey || event.ctrlKey || event.metaKey || (event.shiftKey && !range)) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        toggleRow(row, event.shiftKey);
    }

    function handleContextMenu(event) {
        const row = rowFrom(event.target);
        if (!row || (!active && !canEnter())) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (!active) {
            enter(keyFromRow(row), row);
        }
    }

    function handleRootKeydown(event) {
        if (!active || event.isComposing || event.defaultPrevented) {
            return;
        }
        if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'a') {
            const target = event.target;
            if (!(target instanceof Element) || target.closest('input:not(.sb-selection-check), textarea, select, [contenteditable="true"]')
                || ![list, header, actionBar].some(region => region.contains(target))) return;
            event.preventDefault();
            event.stopPropagation();
            selectAll();
            return;
        }
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        exit();
    }

    list.addEventListener('pointerdown', handlePointerDown);
    list.addEventListener('click', handleClick, true);
    list.addEventListener('keydown', handleKeydown, true);
    list.addEventListener('contextmenu', handleContextMenu);
    root.addEventListener('keydown', handleRootKeydown, true);

    return {
        enter,
        exit,
        toggle,
        select,
        clear,
        selectAll,
        get isActive() { return active; },
        get selectedKeys() { return selectedSnapshot(); },
        get count() { return selected.size; },
        decorate,
        destroy() {
            anchorKey = null;
            stopLongPress();
            list.removeEventListener('pointerdown', handlePointerDown);
            list.removeEventListener('click', handleClick, true);
            list.removeEventListener('keydown', handleKeydown, true);
            list.removeEventListener('contextmenu', handleContextMenu);
            root.removeEventListener('keydown', handleRootKeydown, true);
            if (active) {
                active = false;
                root.dataset.selectionMode = 'false';
                for (const row of rows()) {
                    row.classList.remove('is-selection-selected');
                    removeCheck(row);
                }
            }
            header.hidden = true;
            actionBar.hidden = true;
            header.replaceChildren();
            actionBar.replaceChildren();
            actionBar.classList.remove('sb-selection-action-bar');
            actionBar.removeAttribute('role');
            actionBar.removeAttribute('aria-label');
            selected = new Set();
        },
    };
}
