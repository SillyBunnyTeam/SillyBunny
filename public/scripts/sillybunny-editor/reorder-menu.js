/**
 * Reordering by keyboard and menu, for the lists SillyBunny builds and the sortables upstream code builds.
 *
 * - reorderMenuItems: the move section of a reorderable row's action menu. Move Up and Move Down, plus Move to Top and
 *   Move to Bottom when asked. An item that cannot act at the row's position is left out, and so is the whole section
 *   while a search or filter hides rows. The adopter keeps its own data change and save path in `move`; this only builds
 *   the items, announces and returns focus.
 * - announceReorder: the new position in a polite live region. Keyboard and drag paths call it too.
 * - attachSortableKeys: makes the rows (or their drag handles) of one jQuery UI sortable list focusable, moves the focused
 *   row with Alt+ArrowUp, Alt+ArrowDown, Alt+Home and Alt+End, then runs the list's own `update` and `stop` options as a
 *   drag would, so the list saves through its own path.
 * - adoptUpstreamSortables: attaches that helper to each upstream list named in UPSTREAM_SORTABLES when its sortable is
 *   created.
 *
 * The sortable helper reads everything from the sortable at the time of the key press (`items`, `handle`, `cancel`,
 * `disabled`, `update`, `stop`), because some lists destroy and create their sortable again on every display. A list that
 * keeps its order inverted in the saved data (the logit bias lists) needs no case of its own: the helper moves the row where
 * the user sees it, and the list's handler converts the DOM order as it does for a drag.
 *
 * One module, because both load at startup and each module is a startup request.
 */

import { t } from '../i18n.js';
import { getTopmostDialog } from './overlay-host.js';

const REGION_CLASS = 'sb-reorder-status';

/**
 * Returns the shared live region of the topmost modal dialog, or of <body> when none is open. A modal dialog makes
 * everything outside it inert, and assistive technology skips announcements from inert content.
 * @returns {HTMLElement}
 */
function sharedRegion() {
    const host = getTopmostDialog() ?? document.body;
    let region = [...host.children].find(child => child.classList.contains(REGION_CLASS));
    if (!region) {
        region = document.createElement('div');
        region.className = `${REGION_CLASS} sr-only`;
        region.setAttribute('role', 'status');
        region.setAttribute('aria-live', 'polite');
        region.setAttribute('aria-atomic', 'true');
        host.append(region);
    }
    return region;
}

/**
 * Announces where a row now sits.
 * @param {object} options
 * @param {string} options.name Row name.
 * @param {number} options.position One-based position after the move.
 * @param {number} options.count Rows in the list.
 * @param {Element|null} [options.region] A live region the list already owns; the shared one is used otherwise.
 * @returns {void}
 */
export function announceReorder({ name, position, count, region = null }) {
    (region ?? sharedRegion()).textContent = t`Moved ${name} to position ${position} of ${count}`;
}

/**
 * @typedef {object} ReorderMenuOptions
 * @property {number} index Zero-based position of the row in the whole list, as saved.
 * @property {number} count Rows in the whole list.
 * @property {boolean} [filtered] True while a search, filter or non-manual sort hides or reorders rows.
 * @property {boolean} [extremes] Also offer Move to Top and Move to Bottom.
 * @property {string} name Row name, for the announcement.
 * @property {(to: number) => unknown} move The adopter's own change and save; `to` is the new zero-based position.
 *   Returning `false`, or a promise of `false`, says the move did not happen: nothing is announced.
 * @property {() => Element|null} [focus] Returns the control to focus inside the moved row once the list has rendered.
 * @property {Element|null} [region] A live region the list already owns.
 * @property {(error: unknown) => void} [onError] Receives an error that `move` throws or rejects with; without it the
 *   error propagates.
 */

/**
 * Builds the items of the move section, in the shape `openActionMenu` takes. Add the result to a section, or give it a
 * section of its own; an empty result adds nothing to a menu. Each item carries `data-sb-reorder` (`top`, `up`, `down`
 * or `bottom`), which tests and tools read.
 * @param {ReorderMenuOptions} options
 * @returns {import('../sillybunny-action-menu.js').ActionMenuItem[]}
 */
export function reorderMenuItems({ index, count, filtered = false, extremes = false, name, move, focus = null, region = null, onError = null }) {
    if (filtered || !Number.isInteger(index) || !Number.isInteger(count) || index < 0 || index >= count || count < 2) return [];

    const settle = (to, result) => {
        if (result === false) return false;
        announceReorder({ name, position: to + 1, count, region });
        const target = focus?.();
        if (target?.isConnected && document.activeElement !== target) target.focus({ preventScroll: true });
        return true;
    };
    const fail = error => {
        if (!onError) throw error;
        onError(error);
        return false;
    };
    // A synchronous move settles synchronously, so a caller that reads the order right after the click sees it.
    const perform = to => {
        let result;
        try {
            result = move(to);
        } catch (error) {
            return fail(error);
        }
        return typeof result?.then === 'function' ? result.then(value => settle(to, value), fail) : settle(to, result);
    };
    const item = (kind, label, glyph, to) => ({ label, icon: `fa-solid fa-${glyph}`, data: { sbReorder: kind }, onSelect: () => perform(to) });

    const items = [];
    if (extremes && index > 0) items.push(item('top', t`Move to Top`, 'angles-up', 0));
    if (index > 0) items.push(item('up', t`Move Up`, 'arrow-up', index - 1));
    if (index < count - 1) items.push(item('down', t`Move Down`, 'arrow-down', index + 1));
    if (extremes && index < count - 1) items.push(item('bottom', t`Move to Bottom`, 'angles-down', count - 1));
    return items;
}

const SHORTCUTS = 'Alt+ArrowUp Alt+ArrowDown Alt+Home Alt+End';
const attached = new WeakMap();
const patchedPrototypes = new WeakSet();

/**
 * @typedef {object} SortableKeysOptions
 * @property {(row: HTMLElement) => string} [name] The row's name, for its accessible name and the announcement.
 * @property {(row: HTMLElement) => boolean} [movable] False for a row that must stay where it is (and is not focusable).
 * @property {(row: HTMLElement) => unknown} [key] A value that identifies a row across a re-render of the list. Without
 *   it the row's `id`, `data-id` or `data-name` is used.
 */

/**
 * @typedef {object} SortableKeys
 * @property {() => void} refresh Reads the sortable and the rows again and updates which ones are focusable.
 * @property {() => void} detach Removes the listeners and everything the helper added to the rows.
 */

/**
 * @param {HTMLElement} list
 * @returns {{ $list: JQuery, option: (name: string) => any } | null} Null while the element has no sortable.
 */
function readSortable(list) {
    const jQuery = globalThis.jQuery;
    if (!jQuery?.fn?.sortable) return null;
    const $list = jQuery(list);
    if ($list.sortable('instance') === undefined) return null;
    return { $list, option: name => $list.sortable('option', name) };
}

function isHidden(row) {
    return row.closest('[hidden], [inert]') !== null || getComputedStyle(row).display === 'none';
}

function isThenable(value) {
    return typeof value?.then === 'function';
}

/**
 * Attaches the keyboard moves to a sortable list. Attaching a list twice returns the first attachment.
 * @param {HTMLElement} list The element that `.sortable()` was called on.
 * @param {SortableKeysOptions} [options]
 * @returns {SortableKeys}
 */
export function attachSortableKeys(list, { name = null, movable = null, key = null } = {}) {
    const existing = attached.get(list);
    if (existing) return existing;

    /** @type {Map<HTMLElement, { row: HTMLElement, tabindex: boolean, role: boolean, label: boolean, shortcuts: boolean }>} */
    const decorated = new Map();

    const nameOf = row => (name?.(row) ?? row.textContent ?? '').replace(/\s+/g, ' ').trim() || t`Entry`;
    const keyOf = row => (key ? key(row) : (row.id || row.dataset.id || row.dataset.name)) ?? null;
    const labelOf = row => t`Drag to reorder ${nameOf(row)}`;

    const handleOf = (row, sortable) => {
        const handle = sortable.option('handle');
        if (typeof handle !== 'string' || !handle) return row;
        return globalThis.jQuery(row).find(handle)[0] ?? null;
    };

    /** The rows that a drag could move, in DOM order, each with the element that takes the focus. */
    const moveTargets = sortable => {
        const items = sortable.option('items');
        const cancel = sortable.option('cancel');
        const rows = typeof items === 'string' ? [...sortable.$list.find(items)] : [...list.children];
        const result = [];
        for (const row of rows) {
            if (!(row instanceof HTMLElement) || row.classList.contains('ui-sortable-placeholder') || isHidden(row)) continue;
            const target = handleOf(row, sortable);
            if (!target || (typeof cancel === 'string' && cancel && target.closest(cancel))) continue;
            if (movable && movable(row) === false) continue;
            result.push({ row, target });
        }
        return result;
    };

    const isActive = sortable => sortable !== null && sortable.option('disabled') !== true;

    const decorate = (target, row) => {
        let entry = decorated.get(target);
        if (!entry) {
            entry = {
                row,
                tabindex: !target.hasAttribute('tabindex'),
                role: !target.hasAttribute('role'),
                label: !target.hasAttribute('aria-label'),
                shortcuts: !target.hasAttribute('aria-keyshortcuts'),
            };
            if (entry.tabindex) target.setAttribute('tabindex', '0');
            if (entry.role) target.setAttribute('role', target === row ? 'group' : 'button');
            if (entry.shortcuts) target.setAttribute('aria-keyshortcuts', SHORTCUTS);
            decorated.set(target, entry);
        }
        entry.row = row;
        if (entry.label) target.setAttribute('aria-label', labelOf(row));
    };

    const undecorate = target => {
        const entry = decorated.get(target);
        if (!entry) return;
        if (entry.tabindex) target.removeAttribute('tabindex');
        if (entry.role) target.removeAttribute('role');
        if (entry.label) target.removeAttribute('aria-label');
        if (entry.shortcuts) target.removeAttribute('aria-keyshortcuts');
        decorated.delete(target);
    };

    // One stop per list keeps Tab moving between lists, so a list of hundreds of rows is not hundreds of tab stops. The arrow
    // keys move the stop inside the list. Only a tabindex that this helper added is managed; a row's own value is left alone.
    let stop = null;
    const applyStop = () => {
        const owned = [...decorated.entries()].filter(([, entry]) => entry.tabindex).map(([target]) => target)
            .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
        const active = owned.includes(stop) ? stop : owned[0];
        for (const target of owned) target.setAttribute('tabindex', target === active ? '0' : '-1');
    };

    const refresh = () => {
        const sortable = readSortable(list);
        const targets = isActive(sortable) ? moveTargets(sortable) : [];
        const current = new Set(targets.map(({ target }) => target));
        for (const target of [...decorated.keys()]) {
            if (!current.has(target)) undecorate(target);
        }
        for (const { row, target } of targets) decorate(target, row);
        applyStop();
    };

    /** Calls the list's own handlers as a finished drag does: `update` when the order changed, then `stop`. */
    const runHandlers = (sortable, row) => {
        const jQuery = globalThis.jQuery;
        const ui = { item: jQuery(row), sender: null };
        const results = [];
        for (const type of ['update', 'stop']) {
            const handler = sortable.option(type);
            if (typeof handler !== 'function') continue;
            results.push(handler.call(list, jQuery.Event(`sort${type}`, { target: list }), ui));
        }
        return results.filter(isThenable);
    };

    const onKeydown = event => {
        if (!event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.isComposing && decorated.get(event.target)?.tabindex) {
            const step = { ArrowUp: -1, ArrowDown: 1 }[event.key];
            const sortable = readSortable(list);
            if ((step || event.key === 'Home' || event.key === 'End') && isActive(sortable)) {
                const targets = moveTargets(sortable);
                const from = targets.findIndex(({ target }) => target === event.target);
                const to = event.key === 'Home' ? 0 : event.key === 'End' ? targets.length - 1 : from + step;
                if (from >= 0 && to >= 0 && to < targets.length) {
                    event.preventDefault();
                    targets[to].target.focus();
                }
                return;
            }
        }
        if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing) return;
        if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
        const sortable = readSortable(list);
        if (!isActive(sortable)) return;
        const targets = moveTargets(sortable);
        const from = targets.findIndex(({ target }) => target === event.target);
        if (from < 0) return;
        event.preventDefault();

        const to = event.key === 'ArrowUp' ? from - 1
            : event.key === 'ArrowDown' ? from + 1
                : event.key === 'Home' ? 0 : targets.length - 1;
        if (to < 0 || to >= targets.length || to === from) return;

        const { row, target } = targets[from];
        const label = nameOf(row);
        const rowKey = keyOf(row);
        const count = targets.length;
        if (to < from) targets[to].row.before(row);
        else targets[to].row.after(row);
        target.focus();

        // A list may build its rows again while it saves (the regex lists reload the chat), so the row is found by its key.
        const finish = () => {
            announceReorder({ name: label, position: to + 1, count });
            refresh();
            let focusTarget = target;
            if (!focusTarget.isConnected && rowKey !== null) {
                const next = readSortable(list);
                focusTarget = (next ? moveTargets(next) : []).find(entry => keyOf(entry.row) === rowKey)?.target;
            }
            if (focusTarget?.isConnected && document.activeElement !== focusTarget) focusTarget.focus();
        };

        let pending;
        try {
            pending = runHandlers(sortable, row);
        } catch (error) {
            finish();
            throw error;
        }
        if (pending.length === 0) finish();
        else void Promise.all(pending).finally(finish);
    };

    const onFocusIn = event => {
        const entry = decorated.get(event.target);
        if (entry?.label) event.target.setAttribute('aria-label', labelOf(entry.row));
        if (entry?.tabindex && stop !== event.target) {
            stop = event.target;
            applyStop();
        }
    };

    // Only the list's own children and its class matter: the sortable toggles its disabled class on the list, and a list
    // that shows a row as off (the NovelAI samplers) toggles a class on the row.
    const observer = new MutationObserver(records => {
        if (records.some(record => record.target === list || record.target.parentNode === list)) refresh();
    });

    list.addEventListener('keydown', onKeydown);
    list.addEventListener('focusin', onFocusIn);
    observer.observe(list, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });

    const attachment = {
        refresh,
        detach() {
            list.removeEventListener('keydown', onKeydown);
            list.removeEventListener('focusin', onFocusIn);
            observer.disconnect();
            for (const target of [...decorated.keys()]) undecorate(target);
            attached.delete(list);
        },
    };
    attached.set(list, attachment);
    refresh();
    return attachment;
}

const textOf = (row, selector) => row.querySelector(selector)?.textContent ?? '';
const valueOf = (row, selector) => row.querySelector(selector)?.value ?? '';
const selectedTextOf = (row, selector) => row.querySelector(selector)?.selectedOptions?.[0]?.textContent ?? '';

/**
 * The upstream sortable lists that get the keyboard moves, matched by selector when their sortable is created. A list that
 * a drag could move but that must not move by key (`movable`) is left out of the tab order too.
 * @type {{ selector: string, options: SortableKeysOptions }[]}
 */
export const UPSTREAM_SORTABLES = [
    {
        selector: '#saved_regex_scripts, #saved_scoped_scripts, #saved_preset_scripts',
        options: { name: row => textOf(row, '.regex_script_name') },
    },
    {
        selector: '.qr--set-qrListContents',
        options: { name: row => valueOf(row, '.qr--set-itemLabel') },
    },
    {
        selector: '.qr--setList',
        options: { name: row => selectedTextOf(row, '.qr--set') },
    },
    {
        selector: '#qr--ctxEditor',
        options: { name: row => selectedTextOf(row, '.qr--set'), movable: row => row.classList.contains('qr--ctxItem') },
    },
    {
        selector: '.logit_bias_list, .openai_logit_bias_list',
        options: {
            name: row => valueOf(row, '.logit_bias_text, .openai_logit_bias_text'),
            key: row => globalThis.jQuery(row).data('id'),
        },
    },
    {
        selector: '#kobold_order, #koboldcpp_order, #llamacpp_samplers_sortable, #sampler_priority_container, #sampler_priority_container_aphrodite',
        options: { name: row => textOf(row, 'span') },
    },
    {
        // A sampler that is switched off is dropped from the saved order and parked at the bottom, so it does not move.
        selector: '#novel_order',
        options: { name: row => textOf(row, 'span'), movable: row => !row.classList.contains('disabled') },
    },
];

/**
 * Attaches the keyboard moves to every list of UPSTREAM_SORTABLES as its sortable is created. Call it before any of those
 * lists becomes sortable; a list that is already sortable is not reached.
 * @param {JQueryStatic} [jQuery] jQuery instance that carries jQuery UI.
 * @returns {boolean} True when the sortable prototype was patched by this call.
 */
export function adoptUpstreamSortables(jQuery = globalThis.jQuery) {
    const prototype = jQuery?.ui?.sortable?.prototype;
    if (!prototype || patchedPrototypes.has(prototype)) return false;

    const create = prototype._create;
    prototype._create = function (...args) {
        const result = create.apply(this, args);
        try {
            const list = this.element[0];
            const entry = UPSTREAM_SORTABLES.find(({ selector }) => list.matches(selector));
            if (entry) attachSortableKeys(list, entry.options);
        } catch (error) {
            console.error('Sortable keyboard moves were not attached', error);
        }
        return result;
    };
    patchedPrototypes.add(prototype);
    return true;
}
