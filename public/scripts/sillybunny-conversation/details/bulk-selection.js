/**
 * Selection mode for a page of the details window, on the shared `createSelectionMode()`. The window's own header becomes
 * the selection header (Cancel, the count, Select All) and the action bar sits under the page's body, so the page adds
 * only what is its own: which rows are selectable, which keys Select All covers, and what the actions do.
 *
 * A page builds the controller with its builder, before the window has a frame for it, and calls `mount` from its
 * `onMount`, when the frame's header and body exist.
 */

import { bindListFocus } from '../../sillybunny-editor/list-focus.js';
import { createListShowMore } from '../../sillybunny-editor/list-show-more.js';
import { createSelectionMode } from '../../sillybunny-editor/selection-mode.js';
import { nextShownCount } from './bulk-logic.js';

/**
 * @typedef {object} BulkAction
 * @property {string} id
 * @property {string} label
 * @property {string} icon A Font Awesome class list, as `selection-mode` takes it.
 * @property {boolean} [danger]
 * @property {(keys: string[], options?: { signal: AbortSignal }) => Promise<boolean>|boolean} run Resolves to whether the action is done, which ends selection mode.
 */

/**
 * @param {object} options
 * @param {() => HTMLElement} options.getList The element that holds the rows. It must not be replaced while the page is open.
 * @param {string} options.rowSelector
 * @param {string} [options.keySourceSelector] Row descendants (such as a picture cell button) whose Space and Enter keys toggle selection.
 * @param {(row: HTMLElement) => string} options.getKey
 * @param {() => string[]} options.getAllKeys The key of every item, including those that Show More has not drawn yet.
 * @param {BulkAction[]} options.actions
 * @param {(row: HTMLElement) => string} [options.rowLabel]
 * @param {boolean} [options.gestures] Whether a secondary click or a long press on a row starts selection. A row that has
 * a menu leaves both to the menu, which holds a Select item instead (DESIGN.md, Selection Mode).
 * @param {string} [options.selectLabel] The accessible name and tooltip of the Select button of the header.
 */
export function createBulkSelection({ getList, rowSelector, keySourceSelector = '', getKey, getAllKeys, actions, rowLabel, gestures = false, selectLabel = 'Select' }) {
    /** @type {ReturnType<typeof createSelectionMode>|null} */
    let selection = null;
    let frame = null;
    let bar = null;
    let selectButton = null;
    let busy = false;
    let startedFromMenu = false;
    /** @type {AbortController|null} */
    let activeRun = null;

    function syncActionBarDisabled() {
        if (!bar) {
            return;
        }
        const disabled = busy || (selection?.count ?? 0) === 0;
        for (const button of bar.querySelectorAll('.sb-selection-action')) {
            button.disabled = disabled;
        }
    }

    function abortActiveRun() {
        activeRun?.abort();
        activeRun = null;
    }

    const guardedActions = actions.map(action => ({
        id: action.id,
        label: action.label,
        icon: action.icon,
        danger: action.danger,
        onActivate: async (keys) => {
            if (busy || !keys.length) {
                return;
            }
            const runController = new AbortController();
            activeRun = runController;
            busy = true;
            bar?.setAttribute('aria-busy', 'true');
            syncActionBarDisabled();
            try {
                const done = await action.run(keys, { signal: runController.signal });
                if (!runController.signal.aborted && done) {
                    selection?.exit();
                }
            } finally {
                if (activeRun === runController) {
                    activeRun = null;
                }
                busy = false;
                bar?.removeAttribute('aria-busy');
                syncActionBarDisabled();
            }
        },
    }));

    const controller = {
        /**
         * @param {{ frame: Record<string, any> }} context What `onMount` of a page receives. Its frame brings the dialog's
         * `createIconButton`, so that this module does not import the dialog and loads without it.
         */
        mount(context) {
            frame = context.frame;
            bar = document.createElement('div');
            bar.className = 'sb-details-selection-bar';
            frame.body.after(bar);
            selection = createSelectionMode({
                root: frame.page,
                list: getList(),
                rowSelector,
                keySourceSelector,
                getKey,
                getAllKeys,
                rowLabel,
                range: true,
                iconOnlyAtNarrow: true,
                // A heading is in header capitalisation (DESIGN.md, The Capitalisation Rule); the shared default is not.
                title: count => `${count} Selected`,
                actionBar: bar,
                actions: guardedActions,
                onExit: abortActiveRun,
                headerSlots: {
                    get header() { return frame.header; },
                    get headerStart() { return frame.headerStart; },
                    get headerEnd() { return frame.headerEnd; },
                    get titleNode() { return frame.titleNode; },
                    get search() { return frame.search; },
                    get closeButton() { return frame.closeButton; },
                },
                canEnter: () => !busy && (gestures || startedFromMenu),
            });
            selectButton = frame.createIconButton(selectLabel, 'check-double', 'sb-details-select');
            selectButton.addEventListener('click', () => controller.enter(null, selectButton));
            frame.headerEnd.prepend(selectButton);
        },

        /** Starts selection mode from a control: the Select button, or the Select item of a row's menu. */
        enter(initialKey = null, trigger = null) {
            startedFromMenu = true;
            try {
                selection?.enter(initialKey, trigger ?? undefined);
            } finally {
                startedFromMenu = false;
            }
        },

        exit() {
            selection?.exit();
        },

        get isActive() {
            return Boolean(selection?.isActive);
        },

        get selectedKeys() {
            return selection?.selectedKeys ?? [];
        },

        /** Shows or hides the Select button: a page with nothing to select has no use for it. */
        setSelectable(selectable) {
            const wasActive = Boolean(selection?.isActive);
            const selectHadFocus = Boolean(selectButton && document.activeElement === selectButton);
            // Leaving selection mode puts the header buttons back as they were when it started, so it comes first.
            if (!selectable) {
                selection?.exit();
            }
            if (selectButton) {
                selectButton.hidden = !selectable;
            }
            // If leaving selection mode returned focus to the now-hidden Select button or to a detached row, keep focus inside the page header.
            if (!selectable && (wasActive || selectHadFocus) && frame) {
                const active = document.activeElement;
                const lostFocus = !(active instanceof HTMLElement)
                    || !frame.page.contains(active)
                    || active === selectButton
                    || Boolean(active.closest('[hidden], [inert]'));
                if (lostFocus) {
                    const fallback = frame.headerStart.querySelector('button:not([hidden]):not([disabled])')
                        ?? (frame.closeButton && !frame.closeButton.hidden ? frame.closeButton : null);
                    fallback?.focus({ preventScroll: true });
                }
            }
        },

        /**
         * Brings selection mode in line with the rows the page just drew: the selected items that are gone leave the
         * selection, and the new rows get their checks. A key that Show More has not drawn yet stays selected.
         */
        sync() {
            if (!selection?.isActive) {
                return;
            }
            const present = new Set(getAllKeys());
            const kept = selection.selectedKeys.filter(key => present.has(key));
            if (kept.length !== selection.count) {
                selection.select(kept);
            }
            selection.decorate();
            if (busy) {
                syncActionBarDisabled();
            }
        },

        /**
         * The `canClose` of the page. Escape and a swipe down on a phone's sheet leave selection mode and keep the page,
         * so that one gesture takes one step back. Back, Close and a click outside leave it and go on.
         * @param {string} reason
         */
        canClose(reason) {
            if (!selection?.isActive || reason === 'programmatic') {
                return true;
            }
            selection.exit();
            return reason !== 'escape' && reason !== 'swipe';
        },

        destroy() {
            abortActiveRun();
            selection?.destroy();
            selection = null;
            selectButton?.remove();
            selectButton = null;
            bar?.remove();
            bar = null;
            frame = null;
        },
    };
    return controller;
}

/**
 * A list that shows its rows in batches of fifty, with the Show More row of the boxed lists after it. The page owns the
 * items and the rows; this keeps how many are drawn, so that a redraw while the user reads does not fold the list again.
 * With `rowSelector`, the list is one Tab stop with arrow-key navigation and Down from the last row reaching Show More.
 * @param {object} options
 * @param {HTMLElement} options.list The element that holds the rows.
 * @param {(item: any) => HTMLElement} options.renderRow
 * @param {string} [options.rowSelector] Selects the rows for single-Tab-stop keyboard navigation.
 * @param {string} [options.keySourceSelector] Row descendants whose arrow keys move focus like the row's own.
 * @param {() => void} [options.onDrawn] Called after each draw, so that the selection can decorate the rows.
 * @param {(row: HTMLElement) => HTMLElement|null} [options.focusTarget] What a row hands focus to after a Show More from the keyboard when `rowSelector` is not set.
 */
export function createBatchedList({ list, renderRow, rowSelector = '', keySourceSelector = '', onDrawn, focusTarget = row => row }) {
    let items = [];
    let shown = 0;
    let fromKeyboard = false;
    const showMore = createListShowMore({
        onShowMore() {
            const before = list.children.length;
            shown = nextShownCount(shown, items.length);
            if (shown > before) {
                list.append(...items.slice(before, shown).map(renderRow));
            }
            showMore.update({ shown: Math.min(shown, items.length), total: items.length });
            onDrawn?.();
            listFocus?.sync();
            if (fromKeyboard) {
                const firstAdded = /** @type {HTMLElement|undefined} */ (list.children[before]);
                if (firstAdded) {
                    if (listFocus) {
                        listFocus.focusRow(firstAdded);
                    } else {
                        focusTarget(firstAdded)?.focus({ preventScroll: false });
                    }
                }
            }
        },
    });
    const listFocus = rowSelector
        ? bindListFocus(list, { rowSelector, keySourceSelector, trailingStops: () => [showMore.button] })
        : null;
    // A press from the keyboard has no pointer: its click has a detail of zero. The capture runs before the button's own handler.
    showMore.element.addEventListener('click', (event) => {
        fromKeyboard = event.detail === 0;
    }, true);

    function draw() {
        list.replaceChildren(...items.slice(0, shown).map(renderRow));
        showMore.update({ shown: Math.min(shown, items.length), total: items.length });
        onDrawn?.();
        listFocus?.sync();
    }

    return {
        /** The Show More row; the page puts it after the list. */
        element: showMore.element,
        /** Draws the items. The count of rows that are shown stays, and grows to the first batch for a list that was empty. */
        update(next) {
            items = next;
            shown = Math.min(items.length, Math.max(shown, nextShownCount(0, items.length)));
            draw();
        },
        get shownCount() {
            return Math.min(shown, items.length);
        },
        destroy() {
            listFocus?.destroy();
            showMore.destroy();
        },
    };
}
