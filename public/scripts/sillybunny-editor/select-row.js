/** Rows that mirror a native <select> through the shared picker (AdwComboRow). Labels arrive translated. */
import { closePicker, isPickerOpen, openPicker } from './picker.js';
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

/** Reads picker items from the select: optgroups become headings; hidden options are skipped. */
function readItems(select) {
    const items = [];
    for (const child of select.children) {
        if (child instanceof HTMLOptGroupElement) {
            for (const option of child.querySelectorAll('option')) {
                if (option.hidden) continue;
                items.push({ value: option.value, label: optionLabel(option), group: child.label, disabled: option.disabled || child.disabled });
            }
        } else if (child instanceof HTMLOptionElement && !child.hidden) {
            items.push({ value: child.value, label: optionLabel(child), disabled: child.disabled });
        }
    }
    return items;
}

function selectedValues(select) {
    return [...select.selectedOptions].map(option => option.value);
}

/**
 * Writes a value back with a native bubbling change event. jQuery binds its handlers natively, so this
 * reaches select2 and every jQuery handler as well as plain listeners; jQuery's own trigger('change')
 * would skip the plain listeners.
 */
function writeBack(select, value) {
    if (select.multiple) {
        for (const option of select.options) option.selected = value.includes(option.value);
    } else {
        select.value = value;
    }
    select.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * Listens for every change of the select. Profiles and upstream code change it with jQuery's
 * trigger('change'), which only jQuery handlers receive, so bind through jQuery when it is present.
 * @returns {() => void} unbind
 */
function onSelectChanges(select, handler) {
    const $ = globalThis.jQuery;
    if (typeof $ === 'function') {
        $(select).on('change.sbSelectRow', handler);
        return () => $(select).off('change.sbSelectRow', handler);
    }
    select.addEventListener('change', handler);
    return () => select.removeEventListener('change', handler);
}

/**
 * Mirrors a native select in a boxed-list row. The select is adopted (moved, never cloned) and stays
 * the source of truth; it is hidden from layout and focus while the row owns it.
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
 * @param {Element|null} [options.bounds=null]
 * @param {(value: string|string[]) => void} [options.onChange]  Called on every change event of the select.
 * @param {(value: string|string[]) => void} [options.onPick]  Called before write-back, only for a choice made in the picker.
 * @returns {object}
 */
export function createSelectRow({ select, label, subtitle, field, id, title = label, searchLabel, emptyText, noneLabel = '', suffix, ordered = false, bounds = null, onChange, onPick }) {
    if (!(select instanceof HTMLSelectElement)) throw new TypeError('Expected a select element.');
    const container = select.nextElementSibling?.matches('.select2-container') ? select.nextElementSibling : null;
    const previous = { tabIndex: select.getAttribute('tabindex'), ariaHidden: select.getAttribute('aria-hidden') };
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
    if (description) {
        description.id ||= uniqueId('sb-select-row-description');
        trigger.setAttribute('aria-describedby', description.id);
    }

    const currentValue = () => (select.multiple ? selectedValues(select) : select.value);
    const summary = () => {
        const labels = [...select.selectedOptions].map(optionLabel).filter(Boolean);
        return (select.multiple ? labels.join(', ') : labels[0]) || noneLabel;
    };
    const sync = () => {
        value.textContent = summary();
        trigger.disabled = select.disabled;
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
            items: readItems(select),
            selected: select.multiple ? null : select.value,
            multiple: select.multiple,
            getItemState: item => (selectedValues(select).includes(item) ? 'selected' : null),
            onSelect: choose,
            searchLabel,
            emptyText,
            bounds,
            matchTriggerWidth: true,
            owner: row,
        });
    };

    const onSelectChange = () => {
        sync();
        onChange?.(currentValue());
    };
    const unbindChange = onSelectChanges(select, onSelectChange);
    // Upstream fills model lists after connecting and toggles disabled state; follow both.
    const observer = new MutationObserver(() => {
        sync();
        if (isPickerOpen(trigger)) picker?.refresh(readItems(select));
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
            unbindChange();
            if (isPickerOpen(trigger)) closePicker({ animate: false, restoreFocus: false });
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
