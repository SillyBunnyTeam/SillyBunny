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

function requireSlots(slots) {
    const { header, headerStart, headerEnd, titleNode } = slots;
    if (![header, headerStart, headerEnd, titleNode].every(node => node instanceof HTMLElement)) {
        throw new TypeError('createSelectionMode headerSlots needs header, headerStart, headerEnd, and titleNode elements');
    }
    return { ...slots };
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
 * @param {HTMLElement} [options.header] Standalone header. Required unless `headerSlots` is given, which ignores it.
 * @param {{ header: HTMLElement, headerStart: HTMLElement, headerEnd: HTMLElement, titleNode: HTMLElement,
 * search?: { isOpen: boolean, query: string, open: () => void, close: () => void, setQuery: (value: string) => void },
 * closeButton?: HTMLElement }|null} [options.headerSlots] Real dialog header to reuse. Read on every entry, so the caller
 * may point it at another page between selections.
 * @param {HTMLElement} options.actionBar
 * @param {{ id: string, label: string, icon?: string|Element, danger?: boolean, onActivate: (keys: string[]) => void }[]} [options.actions=[]]
 * @param {(count: number) => string} [options.title]
 * @param {string} [options.selectAllLabel] Defaults to the existing Select All label.
 * @param {() => boolean} [options.canEnter] Whether gestures or enter() may start selection.
 * @param {(keys: string[]) => void|null} [options.onChange=null]
 * @param {() => void|null} [options.onExit=null]
 * @returns {{ enter: (initialKey?: string, trigger?: HTMLElement) => void, exit: () => void, toggle: (key: string) => void,
 * select: (keys: Iterable<string>) => void, clear: () => void, selectAll: () => void,
 * readonly isActive: boolean, readonly selectedKeys: string[], readonly count: number,
 * readonly cancelButton: HTMLElement|null, readonly selectAllButton: HTMLElement|null, readonly selectionTitle: HTMLElement|null,
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
    selectAllLabel = t`Select All`,
    canEnter = () => true,
    onChange = null,
    onExit = null,
    headerSlots = null,
    iconOnlyAtNarrow = false,
}) {
    if (!(root instanceof HTMLElement) || !(list instanceof HTMLElement) || !(actionBar instanceof HTMLElement)
        || (!headerSlots && !(header instanceof HTMLElement))) {
        throw new TypeError('createSelectionMode requires root, list, and actionBar elements, plus header or headerSlots');
    }

    // Only a standalone header is owned by the mode. Slotted headers belong to the dialog frame and stay visible.
    const standaloneHeader = headerSlots ? null : header;
    let active = false;
    let selected = new Set();
    let anchorKey = null;
    let focusReturn = null;
    let longPressTimer = 0;
    let longPressState = null;
    let suppressNextClick = false;
    let headerState = null;
    let parts = null;
    root.dataset.selectionMode = 'false';
    if (standaloneHeader) standaloneHeader.hidden = true;
    actionBar.hidden = true;
    actionBar.classList.add('sb-selection-action-bar');
    actionBar.classList.toggle('sb-selection-action-bar--icon-only-narrow', iconOnlyAtNarrow);
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

    function toggleSelectAll() {
        const keys = allKeys();
        if (!areAllSelected(keys)) {
            selectAll();
            return;
        }
        const pageKeys = new Set(keys);
        updateSelection(new Set([...selected].filter(key => !pageKeys.has(key))));
    }

    function renderSlottedHeader(slots) {
        const { headerStart, headerEnd, titleNode, search, header: slotHeader } = slots;
        const managed = [...headerStart.children, ...headerEnd.children].filter(node => node !== slots.closeButton);
        const originalFocus = document.activeElement;
        headerState = {
            slots,
            title: titleNode.textContent,
            titleHidden: titleNode.hidden,
            headerHidden: slotHeader.hidden,
            searchOpen: Boolean(search?.isOpen),
            searchQuery: search?.query ?? '',
            focus: originalFocus instanceof HTMLElement ? originalFocus : null,
            managed: managed.map(node => ({ node, hidden: node.hidden })),
        };
        search?.close();
        for (const node of managed) node.hidden = true;
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'menu_button sb-selection-cancel sb-dialog__selection-cancel';
        cancel.textContent = t`Cancel`;
        cancel.addEventListener('click', exit);
        const selectAllButton = document.createElement('button');
        selectAllButton.type = 'button';
        selectAllButton.className = 'menu_button sb-selection-select-all sb-dialog__selection-select-all';
        selectAllButton.textContent = selectAllLabel;
        selectAllButton.addEventListener('click', toggleSelectAll);
        parts = { cancel, selectAll: selectAllButton, title: titleNode };
        headerStart.append(cancel);
        headerEnd.prepend(selectAllButton);
        titleNode.classList.add('sb-dialog__selection-title');
        titleNode.textContent = title(selected.size);
        slotHeader.classList.add('is-selection-mode');
    }

    function renderStandaloneHeader() {
        const row = document.createElement('div');
        row.className = 'sb-selection-header';

        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'sb-editor-action sb-editor-action--secondary sb-selection-cancel';
        cancel.textContent = t`Cancel`;
        cancel.addEventListener('click', exit);

        const heading = document.createElement('h2');
        heading.className = 'sb-selection-title';
        heading.setAttribute('aria-live', 'polite');
        heading.textContent = title(selected.size);

        const selectAllButton = document.createElement('button');
        selectAllButton.type = 'button';
        selectAllButton.className = 'sb-editor-action sb-editor-action--primary sb-selection-select-all';
        selectAllButton.textContent = selectAllLabel;
        selectAllButton.addEventListener('click', toggleSelectAll);
        row.append(cancel, heading, selectAllButton);
        standaloneHeader.replaceChildren(row);
        standaloneHeader.hidden = false;
        parts = { cancel, selectAll: selectAllButton, title: heading };
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
            button.setAttribute('aria-label', action.label);
            button.title = action.label;
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
        // Closing the dialog search while the header is built can re-render the list before the header parts exist.
        if (!active || !parts) {
            return;
        }
        parts.title.textContent = title(selected.size);
        parts.selectAll.setAttribute('aria-pressed', String(areAllSelected(allKeys())));
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
        const slots = headerSlots ? requireSlots(headerSlots) : null;
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
        try {
            if (slots) renderSlottedHeader(slots);
            else renderStandaloneHeader();
            renderActionBar();
            render();
            emitChange();
        } catch (error) {
            // A half-built header must not leave the mode active with nothing to cancel it.
            exit({ restoreFocus: false, notify: false });
            throw error;
        }
        // A change handler may have left selection mode already.
        parts?.cancel.focus({ preventScroll: true });
    }

    function exit({ restoreFocus = true, notify = true } = {}) {
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
        if (standaloneHeader) standaloneHeader.hidden = true;
        actionBar.hidden = true;
        if (headerState) {
            const { slots, title: savedTitle, titleHidden, headerHidden, searchOpen, searchQuery, managed, focus } = headerState;
            parts?.cancel.remove();
            parts?.selectAll.remove();
            for (const { node, hidden } of managed) node.hidden = hidden;
            slots.titleNode.textContent = savedTitle;
            slots.titleNode.classList.remove('sb-dialog__selection-title');
            slots.titleNode.hidden = titleHidden;
            slots.header.hidden = headerHidden;
            slots.header.classList.remove('is-selection-mode');
            if (searchOpen) {
                slots.search?.open();
                slots.search?.setQuery(searchQuery);
            }
            const focusTarget = focus?.isConnected ? focus : focusReturn;
            headerState = null;
            if (restoreFocus && focusTarget instanceof HTMLElement && focusTarget.isConnected) focusTarget.focus({ preventScroll: true });
        } else standaloneHeader?.replaceChildren();
        parts = null;
        actionBar.replaceChildren();
        selected = new Set();
        anchorKey = null;
        if (hadSelection) {
            emitChange();
        }
        if (notify) onExit?.();
        const target = focusReturn?.isConnected ? focusReturn : list;
        if (target === list && !list.hasAttribute('tabindex')) {
            list.tabIndex = -1;
        }
        if (standaloneHeader) target?.focus?.({ preventScroll: true });
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
                || ![list, standaloneHeader, actionBar].some(region => region?.contains(target))) return;
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
        get cancelButton() { return parts?.cancel ?? null; },
        get selectAllButton() { return parts?.selectAll ?? null; },
        get selectionTitle() { return parts?.title ?? null; },
        decorate,
        destroy() {
            anchorKey = null;
            stopLongPress();
            list.removeEventListener('pointerdown', handlePointerDown);
            list.removeEventListener('click', handleClick, true);
            list.removeEventListener('keydown', handleKeydown, true);
            list.removeEventListener('contextmenu', handleContextMenu);
            root.removeEventListener('keydown', handleRootKeydown, true);
            if (active) exit({ restoreFocus: false, notify: false });
            if (standaloneHeader) {
                standaloneHeader.hidden = true;
                standaloneHeader.replaceChildren();
            }
            actionBar.hidden = true;
            actionBar.replaceChildren();
            actionBar.classList.remove('sb-selection-action-bar');
            actionBar.classList.remove('sb-selection-action-bar--icon-only-narrow');
            actionBar.removeAttribute('role');
            actionBar.removeAttribute('aria-label');
            selected = new Set();
        },
    };
}
