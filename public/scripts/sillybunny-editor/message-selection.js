import { t } from '../i18n.js';
import { confirmDestructiveAction } from '../sillybunny-delete-confirm.js';
import { bindListFocus } from './list-focus.js';
import { createSelectionMode } from './selection-mode.js';

const SELECT_TO_END_ID = 'select-to-end';
const DELETE_ID = 'delete';

/**
 * Selection mode for the messages of a chat, shared by the conversation timeline and roleplay's "Delete messages".
 * Delete is the only action. "Select to End" is the touch route to "this and everything after", which a Shift-click gives
 * with a pointer.
 *
 * @param {object} options
 * @param {HTMLElement} options.root The element that carries `data-selection-mode`; it holds the list, the header and the action bar.
 * @param {HTMLElement} options.list
 * @param {string} options.rowSelector
 * @param {(row: HTMLElement) => string|null} options.getKey The key of a row. Rows that belong together (a message and its tool calls) share one.
 * @param {(row: HTMLElement) => string} options.rowLabel
 * @param {HTMLElement} options.header
 * @param {HTMLElement} options.actionBar
 * @param {(keys: string[]) => number} [options.countMessages] How many messages the keys stand for. Defaults to the number of keys.
 * @param {boolean} [options.longPressEnters=false] Whether a long press with a finger enters the mode.
 * @param {() => void} [options.onEnter] Runs once when the mode starts, however it was started.
 * @param {() => boolean} [options.isStale] True once the list shows other messages than the mode started on. Checked after each render of the list.
 * @param {(keys: string[]) => void|Promise<void>} options.onDelete Runs after the mode has ended, once the user confirmed.
 * @param {() => void} [options.onExit]
 * @returns {{ enter: (initialKey?: string|null, trigger?: HTMLElement|null) => void, exit: () => void, destroy: () => void,
 * readonly isActive: boolean, readonly selection: ReturnType<typeof createSelectionMode> }}
 */
export function createMessageSelection({
    root,
    list,
    rowSelector,
    getKey,
    rowLabel,
    header,
    actionBar,
    countMessages = keys => keys.length,
    longPressEnters = false,
    onEnter = () => {},
    isStale = () => false,
    onDelete,
    onExit = () => {},
}) {
    let armed = false;
    let lastPointerType = 'mouse';
    let listFocus = null;
    let observer = null;
    /** Rows that got a tabindex from this mode, so that exit removes only those. */
    let markedRows = new Set();

    const rows = () => [...list.querySelectorAll(rowSelector)].filter(row => row instanceof HTMLElement);
    const orderedKeys = () => rows().map(getKey).filter(key => key !== null);

    function markRows() {
        for (const row of rows()) {
            if (!row.hasAttribute('tabindex')) {
                row.setAttribute('tabindex', '-1');
                markedRows.add(row);
            }
        }
    }

    function selectToEnd(keys) {
        const ordered = orderedKeys();
        const first = Math.min(...keys.map(key => ordered.indexOf(key)).filter(index => index >= 0));
        if (Number.isFinite(first)) {
            selection.select(ordered.slice(first));
        }
    }

    async function confirmAndDelete(keys) {
        const count = countMessages(keys);
        const heading = count === 1 ? t`Delete Message?` : t`Delete ${count} Messages?`;
        const confirmed = await confirmDestructiveAction({ heading, text: 'TODO(copy)', confirmLabel: t`Delete`, copyPlaceholder: true });
        if (!confirmed) {
            return;
        }
        selection.exit();
        await onDelete(keys);
    }

    const selection = createSelectionMode({
        root,
        list,
        rowSelector,
        getKey,
        rowLabel,
        range: true,
        header,
        actionBar,
        iconOnlyAtNarrow: true,
        title: () => t`${countMessages(selection.selectedKeys)} Selected`,
        // A right-click on a row keeps its own meaning outside the mode, so only a deliberate call or a finger's long press starts it.
        canEnter: () => armed || (longPressEnters && lastPointerType === 'touch'),
        actions: [
            { id: SELECT_TO_END_ID, label: t`Select to End`, icon: 'fa-solid fa-angles-down', onActivate: selectToEnd },
            { id: DELETE_ID, label: t`Delete`, icon: 'fa-solid fa-trash-can', danger: true, onActivate: keys => void confirmAndDelete(keys) },
        ],
        onChange: () => {
            // A long press enters the mode inside createSelectionMode, so the first change is where the rest is set up.
            if (selection.isActive) {
                setup();
                listFocus?.sync();
            }
        },
        onExit: () => {
            teardown();
            onExit();
        },
    });

    function handleEscape(event) {
        // A dialog or a menu that is open takes its own Escape first.
        if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented || document.querySelector('dialog[open]')) {
            return;
        }
        event.preventDefault();
        selection.exit();
    }

    function trackPointerType(event) {
        lastPointerType = event.pointerType;
    }

    function setup() {
        markRows();
        if (listFocus) {
            return;
        }
        onEnter();
        listFocus = bindListFocus(list, { rowSelector, isSelected: row => row.classList.contains('is-selection-selected') });
        // The list renders in place while the mode is on, and a render drops the checks and the tabindex.
        observer ??= new MutationObserver(() => {
            if (selection.isActive && isStale()) {
                selection.exit();
            } else if (selection.isActive) {
                markRows();
                selection.decorate({ prune: true });
                listFocus?.sync();
            }
        });
        observer.observe(list, { childList: true });
        document.addEventListener('keydown', handleEscape);
    }

    function teardown() {
        document.removeEventListener('keydown', handleEscape);
        observer?.disconnect();
        listFocus?.destroy();
        listFocus = null;
        for (const row of markedRows) {
            row.removeAttribute('tabindex');
        }
        markedRows = new Set();
    }

    window.addEventListener('pointerdown', trackPointerType, true);

    return {
        enter(initialKey = null, trigger = null) {
            if (selection.isActive) {
                return;
            }
            armed = true;
            try {
                selection.enter(initialKey, trigger ?? undefined);
            } finally {
                armed = false;
            }
        },
        exit: () => selection.exit(),
        destroy() {
            window.removeEventListener('pointerdown', trackPointerType, true);
            teardown();
            selection.destroy();
        },
        get isActive() {
            return selection.isActive;
        },
        get selection() {
            return selection;
        },
    };
}
