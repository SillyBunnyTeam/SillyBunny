/**
 * Shared list-row helpers for List→Editor sidebars (boxed-list rows).
 *
 * - reconcileRows: keyed DOM reconciliation; rows are rebuilt only when their signature changes.
 * - bindListKeyboard: delegated click/keyboard handling (open, rename, move, arrow navigation).
 * - bindSortable: idempotent jQuery UI sortable wrapper that can be disabled while filtering.
 *
 * Consumers own row markup. Every row must carry `data-sb-list-key` (set by reconcileRows).
 */

const rowEntries = new WeakMap();
const sortables = new WeakMap();

const DEFAULT_ROW_SELECTOR = '[data-sb-list-key]';
const DEFAULT_IGNORE = 'button, input, select, textarea, a, [role="switch"], [role="button"]';

/**
 * Returns the entry a reconciled row was last rendered from.
 * @param {Element|null} row
 * @returns {unknown}
 */
export function rowEntry(row) {
    return row ? rowEntries.get(row) : undefined;
}

/**
 * Keyed reconciliation of `entries` into `container`.
 *
 * Rows are reused while `signature(entry)` is unchanged and replaced when it differs. `update`
 * runs on every row each pass for cheap state (selection, switch state, counts). Rows are
 * reordered with the minimum number of moves and removed when their key disappears.
 *
 * @template T
 * @param {object} options
 * @param {HTMLElement} options.container
 * @param {Map<string, { row: HTMLElement, signature: string }>} options.cache Per-container row cache.
 * @param {T[]} options.entries
 * @param {(entry: T) => string|number} options.key
 * @param {(entry: T) => string} [options.signature] Defaults to JSON of the entry.
 * @param {(entry: T) => HTMLElement} options.create
 * @param {(row: HTMLElement, entry: T) => void} [options.update]
 * @returns {Set<string>} Keys rendered in this pass.
 */
export function reconcileRows({ container, cache, entries, key, signature = entry => JSON.stringify(entry), create, update = null }) {
    const keys = new Set();
    let cursor = container.firstElementChild;
    for (const entry of entries) {
        const id = String(key(entry));
        keys.add(id);
        const nextSignature = signature(entry);
        let cached = cache.get(id);
        if (!cached || cached.signature !== nextSignature) {
            const row = create(entry);
            row.dataset.sbListKey = id;
            if (cached) {
                if (cursor === cached.row) cursor = cached.row.nextElementSibling;
                cached.row.replaceWith(row);
            }
            cached = { row, signature: nextSignature };
            cache.set(id, cached);
        }
        const row = cached.row;
        rowEntries.set(row, entry);
        update?.(row, entry);
        if (row === cursor) cursor = cursor.nextElementSibling;
        else if (row.nextElementSibling !== cursor || row.parentElement !== container) container.insertBefore(row, cursor);
    }
    for (const [id, cached] of cache) {
        if (keys.has(id)) continue;
        cached.row.remove();
        cache.delete(id);
    }
    return keys;
}

function isRendered(row) {
    return !row.closest('[hidden], [inert]');
}

/**
 * Delegated row interactions on a list container, following GTK list conventions.
 *
 * - Click on a row (not on a nested control) or Enter/Space on a focused row → `onOpen`.
 * - F2 → `onRename`. Alt+ArrowUp/Down → `onMove(row, -1|1)`.
 * - ArrowUp/Down/Home/End move focus between rendered rows (`navigate: false` disables).
 *
 * Callbacks return `false` to decline (the event is then left alone).
 *
 * @param {HTMLElement} container
 * @param {object} options
 * @param {string} [options.rowSelector]
 * @param {string} [options.ignoreSelector] Click targets that never open the row.
 * @param {string} [options.keySourceSelector] Descendants (besides the row itself) whose keys act on the row, e.g. a drag grip.
 * @param {(row: HTMLElement, event: Event) => unknown} [options.onOpen]
 * @param {(row: HTMLElement, event: Event) => unknown} [options.onRename]
 * @param {(row: HTMLElement, direction: -1|1, event: Event) => unknown} [options.onMove]
 * @param {boolean} [options.navigate=true]
 * @returns {() => void} Unbind.
 */
export function bindListKeyboard(container, {
    rowSelector = DEFAULT_ROW_SELECTOR,
    ignoreSelector = DEFAULT_IGNORE,
    keySourceSelector = '',
    onOpen = null,
    onRename = null,
    onMove = null,
    navigate = true,
} = {}) {
    const rowFrom = target => target instanceof Element ? target.closest(rowSelector) : null;
    const rowsIn = () => [...container.querySelectorAll(rowSelector)].filter(isRendered);

    const onClick = event => {
        const row = rowFrom(event.target);
        if (!row || !container.contains(row) || !onOpen) return;
        const control = event.target.closest(ignoreSelector);
        if (control && control !== row && row.contains(control)) return;
        if (keySourceSelector && event.target.closest(keySourceSelector)) return;
        void onOpen(row, event);
    };

    const onKeydown = event => {
        if (event.isComposing) return;
        const row = rowFrom(event.target);
        if (!row || !container.contains(row)) return;
        const fromRow = event.target === row || (keySourceSelector && event.target.closest(keySourceSelector));
        if (!fromRow) return;
        const plain = !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
        if ((event.key === 'Enter' || event.key === ' ') && plain && onOpen) {
            if (onOpen(row, event) === false) return;
            event.preventDefault();
            return;
        }
        if (event.key === 'F2' && plain && onRename) {
            if (onRename(row, event) === false) return;
            event.preventDefault();
            return;
        }
        if (event.altKey && !event.ctrlKey && !event.metaKey && ['ArrowUp', 'ArrowDown'].includes(event.key) && onMove) {
            if (onMove(row, event.key === 'ArrowUp' ? -1 : 1, event) === false) return;
            event.preventDefault();
            event.stopPropagation();
            return;
        }
        if (!navigate || !plain || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
        const rows = rowsIn();
        const index = rows.indexOf(row);
        if (index < 0) return;
        const next = event.key === 'Home' ? rows[0]
            : event.key === 'End' ? rows.at(-1)
                : rows[index + (event.key === 'ArrowUp' ? -1 : 1)];
        if (!next || next === row) return;
        event.preventDefault();
        next.focus({ preventScroll: false });
    };

    container.addEventListener('click', onClick);
    container.addEventListener('keydown', onKeydown);
    return () => {
        container.removeEventListener('click', onClick);
        container.removeEventListener('keydown', onKeydown);
    };
}

/**
 * Binds jQuery UI sortable once per box and returns a controller.
 * Requires `$.fn.sortable`; returns null when it is unavailable.
 *
 * @param {HTMLElement} box
 * @param {object} options
 * @param {string} options.handle
 * @param {string} options.items
 * @param {boolean} [options.disabled]
 * @param {() => boolean} [options.touch] Adds a short delay on touch layouts so scrolling still works.
 * @param {(event: unknown, ui: unknown) => void} [options.start]
 * @param {(event: unknown, ui: unknown) => void} options.update
 * @param {() => void} [options.stop]
 * @returns {{ setDisabled: (disabled: boolean) => void, destroy: () => void }|null}
 */
export function bindSortable(box, { handle, items, disabled = false, touch = null, start = null, update, stop = null }) {
    const existing = sortables.get(box);
    if (existing) {
        existing.setDisabled(disabled);
        return existing;
    }
    const jq = globalThis.$;
    if (!jq?.fn?.sortable) return null;
    jq(box).sortable({
        handle,
        items,
        axis: 'y',
        delay: touch?.() ? 30 : 0,
        distance: 4,
        cancel: 'input,textarea,button,select,option',
        disabled,
        start: (event, ui) => start?.(event, ui),
        update,
        stop: () => stop?.(),
    });
    let current = disabled;
    const controller = {
        // Sortable refreshes items and positions on drag start; toggling only on change avoids a forced layout.
        setDisabled(next) {
            if (current === Boolean(next)) return;
            current = Boolean(next);
            jq(box).sortable('option', 'disabled', current);
        },
        destroy() {
            sortables.delete(box);
            if (box.classList.contains('ui-sortable')) jq(box).sortable('destroy');
        },
    };
    sortables.set(box, controller);
    return controller;
}
