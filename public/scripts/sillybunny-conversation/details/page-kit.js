/**
 * The parts that the pages of the details window share: the page frame, a group of rows, the rows of a collection, the
 * toast that offers Undo, and the watcher that redraws a page when the conversation it shows changes.
 */

import { createEntityRow } from '../../sillybunny-editor/entity-row.js';
import { createPrefGroup, createRow } from '../../sillybunny-editor/rows.js';
import { openActionMenu } from '../../sillybunny-action-menu.js';
import { conversationData } from './access.js';

export function el(tag, className = '', text = undefined) {
    const node = document.createElement(tag);
    if (className) {
        node.className = className;
    }
    if (text !== undefined) {
        node.textContent = text;
    }
    return node;
}

export function icon(name) {
    const glyph = el('i', `fa-solid fa-${name}`);
    glyph.setAttribute('aria-hidden', 'true');
    return glyph;
}

/** A paragraph that stands where the maintainer's copy goes. It is reported by `scripts/check-copy-placeholders.js`. */
export function copyPlaceholder(tag = 'p', className = '') {
    const node = el(tag, className, 'TODO(copy)');
    node.dataset.sbCopyPlaceholder = 'true';
    return node;
}

/** The body of a page: a column the width of a libadwaita preferences page, that the window's body scrolls. */
export function createPage(extraClass = '') {
    const page = el('div', `sb-details-page ${extraClass}`.trim());
    const clamp = el('div', 'sb-details-clamp');
    page.append(clamp);
    return { page, clamp };
}

/**
 * A boxed list under a heading. A group with no title names its box with `label`. The headings are level 4, because the theme
 * boxes every `h3` outside a dialog and the page's own heading is level 2.
 */
export function createGroup({ title, subtitle, label, rows = [], field }) {
    const made = createPrefGroup({ title, subtitle, field: field ?? (title ?? label ?? 'group').toLowerCase().replace(/\W+/g, '-'), rows, headingLevel: 4 });
    if (!title && label) {
        made.group.setAttribute('aria-label', label);
    }
    return made;
}

/** A row that opens a page, with the count of what the page holds. */
export function createNavRow({ label, count, field, onActivate }) {
    let suffix;
    if (count !== undefined) {
        suffix = el('span', 'sb-details-count', String(count));
        suffix.dataset.sbDetailsCount = '';
    }
    return createRow({ label, field, activatable: true, suffix, onActivate });
}

/** The single button of a view that stands apart from the list above it. */
export function createPillButton(label, { suggested = true, onClick }) {
    const button = el('button', `menu_button sb-details-pill${suggested ? ' is-suggested menu_button_primary' : ''}`, label);
    button.type = 'button';
    button.addEventListener('click', onClick);
    return button;
}

function createRowIconButton(glyph, label) {
    const button = el('button', 'ds-entity-row__button sb-details-row-button');
    button.type = 'button';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.append(icon(glyph));
    return button;
}

/** The Remove button that ends a row of a list that can change (DESIGN.md, Adding and removing). */
export function createRemoveButton(label, onClick) {
    const button = createRowIconButton('user-minus', label);
    button.addEventListener('click', (event) => {
        event.stopPropagation();
        onClick(button);
    });
    return button;
}

/**
 * A row of a collection: the shared entity row, which a press or Enter activates. Its end holds at most two controls: a
 * button that you pass in `end`, or the ⋮ menu that `menu` makes.
 * @param {object} options
 * @param {string} options.key
 * @param {string} options.label The row's accessible name and title.
 * @param {Node|null} [options.avatar]
 * @param {string|null} [options.subtitle]
 * @param {string|null} [options.preview]
 * @param {(event: Event) => void} [options.onActivate]
 * @param {HTMLElement[]} [options.end]
 * @param {{ label: string, sections: () => object[] }|null} [options.menu]
 * @param {boolean} [options.current] The chat that is open: marked, and named for assistive technology.
 */
export function createCollectionRow({ key, label, avatar = null, subtitle = null, preview = null, onActivate, end = [], menu = null, current = false }) {
    const menuButton = menu ? createRowIconButton('ellipsis-vertical', menu.label) : null;
    if (menuButton) {
        menuButton.setAttribute('aria-haspopup', 'menu');
    }
    const entity = createEntityRow({
        key,
        label,
        avatar,
        subtitle,
        preview,
        suffix: [...end, ...(menuButton ? [menuButton] : [])],
        activation: onActivate ? 'activate' : 'none',
    });
    const { row } = entity;
    row.classList.add('sb-details-collection-row');
    if (current) {
        row.classList.add('is-selected');
        row.setAttribute('aria-current', 'true');
    }
    const inSuffix = event => event.target instanceof Element && event.target.closest('.ds-entity-row__suffix');
    if (onActivate) {
        row.addEventListener('click', (event) => {
            if (!inSuffix(event)) {
                onActivate(event);
            }
        });
        row.addEventListener('keydown', (event) => {
            if ((event.key === 'Enter' || event.key === ' ') && event.target === row) {
                event.preventDefault();
                onActivate(event);
            }
        });
    }
    if (menuButton) {
        const open = (point = null) => openActionMenu({ trigger: menuButton, title: label, sections: menu.sections(), point, bounds: row.closest('dialog') ?? undefined });
        menuButton.addEventListener('click', (event) => {
            event.stopPropagation();
            open();
        });
        row.addEventListener('contextmenu', (event) => {
            event.preventDefault();
            open({ x: event.clientX, y: event.clientY });
        });
        row.addEventListener('keydown', (event) => {
            if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
                event.preventDefault();
                open();
            }
        });
    }
    return { ...entity, menuButton };
}

/** The container of a collection's rows, named for assistive technology. */
export function createCollection(label) {
    const list = el('div', 'sb-details-collection');
    list.setAttribute('role', 'list');
    list.setAttribute('aria-label', label);
    return list;
}

export function createMenuItem(label, glyph, onSelect, danger = false) {
    return { label, icon: `fa-solid fa-${glyph}`, onSelect, danger };
}

/** An explanation under a list that has nothing to show, or a note under one that has. */
export function createHint(text) {
    return el('p', 'sb-inline-hint', text);
}

/** A toast with an Undo button. The toast is gone after five seconds, or as soon as Undo is pressed. */
export function showUndoToast(message, onUndo) {
    const body = el('div', '', message);
    const button = el('button', 'menu_button sb-details-toast-undo', 'Undo');
    button.type = 'button';
    body.append(button);
    const shown = globalThis.toastr.info(body, '', { timeOut: 5000, escapeHtml: false });
    button.addEventListener('click', () => {
        globalThis.toastr.clear(shown, { force: true });
        onUndo();
    });
}

/** Runs `redraw`, and puts focus back on the row that had it, found by its list key. */
export function redrawKeepingFocus(container, redraw) {
    const focused = document.activeElement instanceof HTMLElement && container.contains(document.activeElement)
        ? document.activeElement.closest('[data-sb-list-key]')?.dataset.sbListKey
        : null;
    redraw();
    if (focused) {
        const again = [...container.querySelectorAll('[data-sb-list-key]')].find(row => row.dataset.sbListKey === focused);
        again?.focus({ preventScroll: true });
    }
}

/**
 * Calls `onChange` when what a page shows of a conversation changes, and `onGone` when the conversation is deleted.
 * `select` turns the conversation into the string that the page draws from, so that a message that arrives, which
 * changes nothing a page shows, does not redraw it.
 * @returns {() => void} Stops watching.
 */
export function watchConversation(conversationId, select, { onChange, onGone }) {
    let last = select(conversationData.get(conversationId) ?? {});
    const stopEvents = conversationData.subscribe((event) => {
        if (event.type !== 'list' || (event.id && event.id !== conversationId)) {
            return;
        }
        const view = conversationData.get(conversationId);
        if (!view) {
            onGone?.();
            return;
        }
        const next = select(view);
        if (next !== last) {
            last = next;
            onChange(view);
        }
    });
    const stopRemoval = conversationData.onRemoval((removed) => {
        if (removed.conversationId === conversationId && !removed.chatId) {
            onGone?.();
        }
    });
    return () => {
        stopEvents();
        stopRemoval();
    };
}
