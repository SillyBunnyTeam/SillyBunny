/** Rows that mirror a native <select> through the shared picker (AdwComboRow). Labels arrive translated. */
import { closePicker, isPickerOpen, openPicker } from './picker.js';
import { renderDetails } from './option-details.js';
import { createRow } from './rows.js';

let nextId = 0;

function uniqueId(prefix) {
    let id;
    do {
        id = `${prefix}-${++nextId}`;
    } while (document.getElementById(id));
    return id;
}

function icon(className) {
    const node = document.createElement('i');
    node.className = className;
    node.setAttribute('aria-hidden', 'true');
    return node;
}

function optionLabel(option) {
    return option.textContent.replace(/\s+/g, ' ').trim();
}

/**
 * Maps one option's item. A mapper that returns nothing, or throws on an entry it cannot read, keeps
 * the plain item, so a bad catalogue entry never stops the row or its list.
 */
function mapOption(mapItem, item, option) {
    if (!mapItem) return item;
    try {
        return mapItem(item, option) || item;
    } catch {
        return item;
    }
}

/**
 * Reads picker items from the select: optgroups become headings; hidden options are skipped. The
 * mapper may return a richer item for an option (a title or a subtitle, say); one that returns nothing keeps the item.
 */
function readItems(select, mapItem) {
    const items = [];
    const add = (item, option) => {
        items.push(mapOption(mapItem, item, option));
    };
    for (const child of select.children) {
        if (child instanceof HTMLOptGroupElement) {
            for (const option of child.querySelectorAll('option')) {
                if (option.hidden) continue;
                add({ value: option.value, label: optionLabel(option), group: child.label, disabled: option.disabled || child.disabled }, option);
            }
        } else if (child instanceof HTMLOptionElement && !child.hidden) {
            add({ value: child.value, label: optionLabel(child), disabled: child.disabled }, child);
        }
    }
    return items;
}

function selectedValues(select) {
    return [...select.selectedOptions].map(option => option.value);
}

/**
 * Writes a value back with the native bubbling `input` and `change` events that a picked option fires, in
 * that order: upstream binds some selects on `input` (`#image_overswipe`) and others on `change`. jQuery
 * binds its handlers natively, so this reaches select2 and every jQuery handler as well as plain listeners;
 * jQuery's own trigger('change') would skip the plain listeners.
 */
function writeBack(select, value) {
    if (select.multiple) {
        for (const option of select.options) option.selected = value.includes(option.value);
    } else {
        select.value = value;
    }
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * Listens for every change of the select. Profiles and upstream code change it with jQuery's
 * trigger('change'), which only jQuery handlers receive, so bind through jQuery when it is present.
 *
 * Upstream also writes a value with trigger('change.select2') to refresh select2 without running the
 * page's change handlers. jQuery runs only the handlers in the `select2` namespace for that event, so
 * `refresh` is bound in that namespace too. select2 removes every `.select2` handler when it is destroyed
 * or initialised again, so `rebind` puts it back.
 * @param {HTMLSelectElement} select
 * @param {() => void} handler  Runs for a plain change.
 * @param {() => void} refresh  Runs for a plain change and for a select2-namespaced one; it must be idempotent.
 * @returns {{ unbind: () => void, rebind: () => void }}
 */
function onSelectChanges(select, handler, refresh) {
    const $ = globalThis.jQuery;
    if (typeof $ === 'function') {
        const bindRefresh = () => $(select).off('change.select2.sbSelectRow', refresh).on('change.select2.sbSelectRow', refresh);
        $(select).on('change.sbSelectRow', handler);
        bindRefresh();
        return {
            unbind() {
                $(select).off('change.sbSelectRow', handler);
                $(select).off('change.select2.sbSelectRow', refresh);
            },
            rebind: bindRefresh,
        };
    }
    select.addEventListener('change', handler);
    return { unbind: () => select.removeEventListener('change', handler), rebind() {} };
}

/**
 * Remembers where the adopted nodes sit. The returned function puts back the ones that are still
 * inside `row`, so it is safe to call twice or after a caller moved the select itself. Neighbours
 * that were adopted too have moved away by then, so the nodes follow the old next sibling, else the
 * old previous one, else go to the end of the old parent. Selects that sat side by side therefore
 * regain their order whichever is destroyed first.
 * @param {HTMLElement[]} nodes  The select and its select2 container, in document order.
 * @returns {(row: HTMLElement) => void}
 */
function rememberPosition(nodes) {
    const parent = nodes[0].parentNode;
    const next = nodes.at(-1).nextSibling;
    const previous = nodes[0].previousSibling;
    return row => {
        const adopted = nodes.filter(node => row.contains(node));
        if (!parent || !adopted.length) return;
        const anchor = next?.parentNode === parent
            ? next
            : previous?.parentNode === parent ? previous.nextSibling : null;
        for (const node of adopted) parent.insertBefore(node, anchor);
    };
}

/**
 * Mirrors a native select in a boxed-list row. The select is adopted (moved, never cloned) and stays
 * the source of truth; it is hidden from layout and focus while the row owns it. `destroy()` puts the
 * select back where it was adopted from.
 * @param {object} options
 * @param {HTMLSelectElement} options.select
 * @param {string} options.label
 * @param {string} options.field
 * @param {string} [options.id]
 * @param {string} [options.subtitle]
 * @param {string} [options.title=label]  Picker title.
 * @param {string} [options.searchLabel]
 * @param {string} [options.emptyText]
 * @param {string} [options.noneLabel='']  Trigger text when nothing is selected.
 * @param {Node|Node[]} [options.suffix]  Extra trailing nodes after the trigger.
 * @param {boolean} [options.ordered=false]  Newly selected options move last (routing priority).
 * @param {(item: object, option: HTMLOptionElement) => object|void} [options.mapItem]  Called for each option
 *     with its picker item (`value`, `label`, `group`, `disabled`); returns the item to show, with a different
 *     `label` (the title) or a `subtitle` and `details` (see option-details.js). The list shows both, the trigger
 *     shows the title, and a single select shows the chosen option's subtitle under the row title. The select stays the source of truth.
 * @param {Element|null} [options.bounds=null]
 * @param {(value: string|string[]) => void} [options.onChange]  Called on every change event of the select.
 * @param {(value: string|string[]) => void} [options.onPick]  Called before write-back, only for a choice made in the picker.
 * @param {{ label: string, icon?: string|Element, onSelect: () => void }[]} [options.footer=[]]  Actions under the picker's list.
 * @param {{ onCreate: (text: string) => void, label?: (text: string) => string }|null} [options.create=null]  Offers to create
 *     what the picker's search names when no option has that label (see openPicker).
 * @param {((items: object[]) => string)|null} [options.summarize=null]  The trigger's text for the chosen items, in place of their
 *     labels (a count, for a multiple select whose labels the row shows elsewhere).
 * @returns {object}
 */
export function createSelectRow({ select, label, subtitle, field, id, title = label, searchLabel, emptyText, noneLabel = '', suffix, ordered = false, mapItem, bounds = null, onChange, onPick, footer = [], create = null, summarize = null }) {
    if (!(select instanceof HTMLSelectElement)) throw new TypeError('Expected a select element.');
    const container = select.nextElementSibling?.matches('.select2-container') ? select.nextElementSibling : null;
    const previous = { tabIndex: select.getAttribute('tabindex'), ariaHidden: select.getAttribute('aria-hidden') };
    const restorePosition = rememberPosition([select, ...(container ? [container] : [])]);
    select.classList.add('ds-select-row__native');
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'ds-select-row__trigger';
    const value = document.createElement('span');
    value.className = 'ds-select-row__value';
    value.id = uniqueId('sb-select-row-value');
    trigger.append(value, icon('fa-solid fa-chevron-down ds-select-row__arrow'));

    const extra = suffix ? (Array.isArray(suffix) ? suffix : [suffix]) : [];
    const base = createRow({ label, subtitle, field, id, suffix: [select, ...(container ? [container] : []), trigger, ...extra] });
    const { row } = base;
    row.classList.add('ds-select-row');
    const caption = row.querySelector('.ds-row-label');
    caption.id ||= uniqueId('sb-select-row-label');
    trigger.setAttribute('aria-labelledby', `${caption.id} ${value.id}`);
    const description = row.querySelector('.ds-row-subtitle');
    if (description) description.id ||= uniqueId('sb-select-row-description');
    // The select is hidden from assistive technology, so the trigger carries the select's descriptions.
    // sync() reads them on every run because callers such as the Connections form add some after the row is built.
    const describedBy = () => [...new Set([...(select.getAttribute('aria-describedby') ?? '').split(/\s+/), description?.id, detail?.id])]
        .filter(Boolean).join(' ');

    const currentValue = () => (select.multiple ? selectedValues(select) : select.value);
    const selectedItems = () => [...select.selectedOptions]
        .map(option => mapOption(mapItem, { value: option.value, label: optionLabel(option), disabled: option.disabled }, option));
    const itemLabel = item => (typeof item.label === 'string' ? item.label.trim() : '');
    const summary = items => {
        if (summarize) return summarize(items) || noneLabel;
        const labels = items.map(itemLabel).filter(Boolean);
        return (select.multiple ? labels.join(', ') : labels[0]) || noneLabel;
    };
    // The details of the chosen option sit under the row title, because the trigger itself keeps one line and a
    // height that every select row shares. A multiple select has no single choice to describe.
    let detail = null;
    let detailKey = '';
    const syncDetail = items => {
        const item = select.multiple ? null : items[0];
        const details = item?.details ?? (item?.subtitle ? [[item.subtitle]] : null);
        const key = details ? JSON.stringify(details) : '';
        if (key === detailKey) return;
        detailKey = key;
        if (!details) {
            detail?.remove();
            detail = null;
            return;
        }
        if (!detail) {
            detail = document.createElement('small');
            detail.className = 'ds-row-subtitle ds-select-row__detail';
            detail.id = uniqueId('sb-select-row-detail');
            row.querySelector('.ds-row-text').append(detail);
        }
        detail.replaceChildren(renderDetails(details));
    };
    const sync = () => {
        const items = selectedItems();
        const text = summary(items);
        // Writing an unchanged value still queues a mutation, and some callers re-sync on every panel update.
        if (value.textContent !== text) value.textContent = text;
        if (trigger.disabled !== select.disabled) trigger.disabled = select.disabled;
        syncDetail(items);
        const ids = describedBy();
        if ((trigger.getAttribute('aria-describedby') ?? '') !== ids) {
            if (ids) trigger.setAttribute('aria-describedby', ids);
            else trigger.removeAttribute('aria-describedby');
        }
    };

    let picker = null;
    const choose = chosen => {
        const values = selectedValues(select);
        const next = !select.multiple ? chosen
            : values.includes(chosen) ? values.filter(item => item !== chosen) : [...values, chosen];
        if (ordered && select.multiple && !values.includes(chosen)) {
            const option = [...select.options].find(option => option.value === chosen);
            if (option) select.append(option);
        }
        onPick?.(next);
        writeBack(select, next);
    };
    const open = () => {
        if (trigger.disabled) return;
        picker = openPicker({
            trigger,
            title,
            items: readItems(select, mapItem),
            selected: select.multiple ? null : select.value,
            multiple: select.multiple,
            getItemState: item => (selectedValues(select).includes(item) ? 'selected' : null),
            onSelect: choose,
            searchLabel,
            emptyText,
            bounds,
            matchTriggerWidth: true,
            owner: row,
            footer,
            create,
        });
    };

    const onSelectChange = () => {
        sync();
        onChange?.(currentValue());
    };
    const changes = onSelectChanges(select, onSelectChange, sync);
    // Upstream fills model lists after connecting and toggles disabled state; follow both.
    const observer = new MutationObserver(() => {
        // select2 changes the select's class and attributes when it is initialised or destroyed, and its destroy drops the change.select2 listener.
        changes.rebind();
        sync();
        if (isPickerOpen(trigger)) picker?.refresh(readItems(select, mapItem));
    });
    observer.observe(select, { childList: true, subtree: true, attributes: true, characterData: true });

    trigger.addEventListener('click', open);
    trigger.addEventListener('keydown', event => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        if (!isPickerOpen(trigger)) open();
    });
    // HIG boxed lists: clicking the row background activates its control, so it toggles like the trigger.
    row.addEventListener('click', event => {
        if (event.target instanceof Element && event.target.closest('button, a, input, select, textarea')) return;
        open();
    });
    sync();

    return {
        ...base,
        control: select,
        trigger,
        open,
        sync,
        getValue: currentValue,
        setValue(next, { silent = true } = {}) {
            if (!silent) {
                writeBack(select, next);
                return;
            }
            if (select.multiple) {
                for (const option of select.options) option.selected = next.includes(option.value);
            } else {
                select.value = next;
            }
            sync();
        },
        destroy() {
            observer.disconnect();
            changes.unbind();
            if (isPickerOpen(trigger)) closePicker({ animate: false, restoreFocus: false });
            restorePosition(row);
            select.classList.remove('ds-select-row__native');
            if (previous.tabIndex === null) select.removeAttribute('tabindex');
            else select.setAttribute('tabindex', previous.tabIndex);
            if (previous.ariaHidden === null) select.removeAttribute('aria-hidden');
            else select.setAttribute('aria-hidden', previous.ariaHidden);
            base.destroy();
        },
    };
}

/**
 * A select-mirror row for connection profiles with a trailing menu button (two controls).
 * Favourites and folders come from the select's own optgroups.
 * @param {object} options  Everything `createSelectRow` accepts, plus:
 * @param {string} options.menuLabel  Accessible name and tooltip of the menu button.
 * @param {(button: HTMLButtonElement) => void} options.onMenu
 * @returns {object}
 */
export function createProfileRow({ menuLabel, onMenu, suffix, ...options }) {
    const menuButton = onMenu ? document.createElement('button') : null;
    if (menuButton) {
        menuButton.type = 'button';
        menuButton.className = 'ds-select-row__menu';
        menuButton.setAttribute('aria-haspopup', 'menu');
        menuButton.setAttribute('aria-label', menuLabel);
        menuButton.title = menuLabel;
        menuButton.append(icon('fa-solid fa-ellipsis-vertical'));
        menuButton.addEventListener('click', () => onMenu(menuButton));
    }
    const extra = suffix ? (Array.isArray(suffix) ? suffix : [suffix]) : [];
    const result = createSelectRow({ ...options, suffix: [...extra, ...(menuButton ? [menuButton] : [])] });
    result.row.classList.add('ds-profile-row');
    return { ...result, menuButton };
}
