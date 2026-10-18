/** Shared boxed-list row factories. Labels arrive translated; adopted controls retain their identity. */

let nextRowId = 0;
const reservedIds = new Map();
const idReservations = new WeakMap();

function releaseId(node) {
    const id = idReservations.get(node);
    if (!id) return;
    const owners = reservedIds.get(id);
    if (owners === 1) reservedIds.delete(id);
    else reservedIds.set(id, owners - 1);
    idReservations.delete(node);
}

function reserveId(node) {
    if (idReservations.get(node) === node.id) return;
    releaseId(node);
    idReservations.set(node, node.id);
    reservedIds.set(node.id, (reservedIds.get(node.id) ?? 0) + 1);
}

/** Releases this subtree's reservations even if an adopted control's ID has since changed. */
export function releaseRowIds(root) {
    releaseId(root);
    root.querySelectorAll('*').forEach(releaseId);
}

function uniqueId() {
    let id;
    do {
        id = `sb-row-${++nextRowId}`;
    } while (reservedIds.has(id) || document.getElementById(id));
    return id;
}

function ensureId(control, id) {
    if (!control.id) control.id = id || uniqueId();
    reserveId(control);
}

function element(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text ?? '';
    return node;
}

function markField(row, field, id) {
    row.dataset.sbEditorField = field;
    if (id) {
        row.id = id;
        reserveId(row);
    }
}

function associateDescription(control, description) {
    ensureId(description);
    const ids = new Set((control.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean));
    ids.add(description.id);
    control.setAttribute('aria-describedby', [...ids].join(' '));
}

function textColumn(label, subtitle, control = null, labelTag = 'span') {
    const text = element('span', 'ds-row-text');
    const caption = element(labelTag, 'ds-row-label', label);
    if (labelTag === 'label') caption.htmlFor = control.id;
    text.append(caption);
    if (subtitle) {
        const description = element('small', 'ds-row-subtitle', subtitle);
        if (control) associateDescription(control, description);
        text.append(description);
    }
    return text;
}

function rowController(row, control = null) {
    const controller = {
        row,
        ...(control ? { control } : {}),
        setDisabled(disabled) {
            const insensitive = Boolean(disabled);
            if (control && 'disabled' in control) control.disabled = insensitive;
            else row.toggleAttribute('inert', insensitive);
            row.setAttribute('aria-disabled', String(insensitive));
            row.classList.toggle('is-insensitive', insensitive);
        },
        setVisible(visible) {
            row.hidden = !visible;
        },
        destroy() {
            releaseRowIds(row);
            row.remove();
        },
    };
    controller.setDisabled(control?.disabled ?? false);
    return controller;
}

function prepareInput(input, type, id) {
    if (input && (input.tagName !== 'INPUT' || input.type !== type)) {
        throw new TypeError(`Expected an input of type ${type}.`);
    }
    const control = input ?? document.createElement('input');
    control.type = type;
    ensureId(control, id);
    return control;
}

function suffixRow(label, subtitle, field, control) {
    const row = element('div', 'ds-row');
    markField(row, field);
    const suffix = element('span', 'ds-row-suffix');
    suffix.append(control);
    row.append(textColumn(label, subtitle, control, 'label'), suffix);
    return row;
}

function appendRows(container, rows) {
    container.append(...rows.map(row => row.row ?? row));
}

/**
 * @param {object} options
 * @param {string} options.label
 * @param {string} options.field
 * @param {string} [options.id]
 * @param {string} [options.subtitle]
 * @param {Node} [options.prefix]
 * @param {Node|Node[]} [options.suffix]
 * @param {boolean} [options.activatable=false]
 * @param {boolean} [options.stacked=false]  Label above a full-width suffix (chip entries, wide controls).
 * @param {(event: MouseEvent) => void} [options.onActivate]
 * @returns {object}
 */
export function createRow({ label, subtitle, field, id, prefix, suffix, activatable = false, stacked = false, onActivate }) {
    const row = element(activatable ? 'button' : 'div', 'ds-row');
    markField(row, field, id);
    if (stacked) row.classList.add('ds-row--stacked');
    if (activatable) {
        row.type = 'button';
        row.classList.add('ds-row--activatable');
        row.addEventListener('click', event => onActivate?.(event));
    }
    if (prefix) row.append(prefix);
    row.append(textColumn(label, subtitle, activatable ? row : null));
    if (suffix) {
        const tail = element('span', 'ds-row-suffix');
        tail.append(...(Array.isArray(suffix) ? suffix : [suffix]));
        row.append(tail);
    }
    if (activatable) {
        const chevron = element('i', 'fa-solid fa-chevron-right ds-row__chevron');
        chevron.setAttribute('aria-hidden', 'true');
        row.append(chevron);
    }
    return rowController(row, activatable ? row : null);
}

/**
 * @param {object} options
 * @param {string} options.label
 * @param {string} options.field
 * @param {string} [options.id]
 * @param {string} [options.subtitle]
 * @param {boolean} [options.checked]
 * @param {boolean} [options.disabled]
 * @param {(checked: boolean) => void} [options.onChange]
 * @param {HTMLInputElement} [options.input]
 * @returns {object}
 */
export function createSwitchRow({ label, subtitle, field, id, checked, disabled, onChange, input }) {
    const control = prepareInput(input, 'checkbox', id);
    control.classList.add('sb-switch');
    control.setAttribute('role', 'switch');
    if (checked !== undefined) control.checked = Boolean(checked);
    if (disabled !== undefined) control.disabled = Boolean(disabled);
    const row = element('label', 'ds-row ds-row-switch');
    markField(row, field);
    row.htmlFor = control.id;
    row.append(textColumn(label, subtitle, control), control);
    const notify = () => {
        control.setAttribute('aria-checked', String(control.checked));
        onChange?.(control.checked);
    };
    control.setAttribute('aria-checked', String(control.checked));
    control.addEventListener('change', notify);
    return {
        ...rowController(row, control),
        getValue: () => control.checked,
        setValue(value, { silent = true } = {}) {
            control.checked = Boolean(value);
            control.setAttribute('aria-checked', String(control.checked));
            if (!silent) notify();
        },
    };
}

/**
 * @param {object} options
 * @param {string} options.label
 * @param {string} options.field
 * @param {string} [options.id]
 * @param {string} [options.subtitle]
 * @param {{value: string, label: string, disabled?: boolean}[]} [options.options]
 * @param {string} [options.value]
 * @param {boolean} [options.wide=false]
 * @param {(value: string) => void} [options.onChange]
 * @param {HTMLSelectElement} [options.select]
 * @returns {object}
 */
export function createComboRow({ label, subtitle, field, id, options, value, wide = false, onChange, select }) {
    if (select && select.tagName !== 'SELECT') throw new TypeError('Expected a select element.');
    const control = select ?? document.createElement('select');
    ensureId(control, id);
    if (options !== undefined) {
        const previousValue = control.value;
        control.replaceChildren(...options.map(({ value, label, disabled = false }) => {
            const option = element('option', '', label);
            option.value = value;
            option.disabled = disabled;
            return option;
        }));
        if (value === undefined && [...control.options].some(option => option.value === previousValue)) {
            control.value = previousValue;
        }
    }
    if (value !== undefined) control.value = value;
    if (wide) control.classList.add('ds-control-flex');
    const row = suffixRow(label, subtitle, field, control);
    control.addEventListener('change', () => onChange?.(control.value));
    return {
        ...rowController(row, control),
        getValue: () => control.value,
        setValue(value, { silent = true } = {}) {
            control.value = value;
            if (!silent) onChange?.(control.value);
        },
    };
}

function numberAttribute(input, name) {
    const raw = input.getAttribute(name);
    if (raw === null || raw.trim() === '') return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
}

/**
 * @param {object} options
 * @param {string} options.label
 * @param {string} options.field
 * @param {string} [options.id]
 * @param {string} [options.subtitle]
 * @param {number|null} [options.value]
 * @param {number} [options.min]
 * @param {number} [options.max]
 * @param {number} [options.step=1]
 * @param {boolean} [options.nullable=false]
 * @param {string} [options.placeholder]
 * @param {(value: number|null) => void} [options.onChange]
 * @param {HTMLInputElement} [options.input]
 * @returns {object}
 */
export function createSpinRow({ label, subtitle, field, id, value, min, max, step = 1, nullable = false, placeholder, onChange, input }) {
    const control = prepareInput(input, 'number', id);
    // Created spin inputs take the app's themed field style; adopted ones keep their own classes.
    if (!input) control.classList.add('text_pole', 'ds-spin');
    control.inputMode = 'numeric';
    if (min !== undefined) control.min = String(min);
    if (max !== undefined) control.max = String(max);
    control.step = String(step);
    if (placeholder !== undefined) control.placeholder = placeholder;
    const lower = numberAttribute(control, 'min') ?? -Infinity;
    const upper = numberAttribute(control, 'max') ?? Infinity;
    if (lower > upper) throw new RangeError('The spin row minimum must not exceed its maximum.');
    const clamp = number => Math.min(upper, Math.max(lower, number));
    let previousValue = nullable ? null : clamp(0);
    const normalize = raw => {
        if (raw === null || raw === undefined || String(raw).trim() === '') {
            return nullable ? null : previousValue;
        }
        const number = Number(raw);
        return Number.isFinite(number) ? clamp(number) : previousValue;
    };
    const commit = raw => {
        previousValue = normalize(raw);
        control.value = previousValue === null ? '' : String(previousValue);
        return previousValue;
    };
    commit(value === undefined ? control.value : value);
    const row = suffixRow(label, subtitle, field, control);
    control.addEventListener('change', () => {
        const next = commit(control.value);
        onChange?.(next);
    });
    return {
        ...rowController(row, control),
        getValue: () => normalize(control.value),
        setValue(value, { silent = true } = {}) {
            const next = commit(value);
            if (!silent) onChange?.(next);
        },
    };
}

/**
 * @param {object} options
 * @param {string} options.label
 * @param {string} options.field
 * @param {string} [options.id]
 * @param {string} [options.subtitle]
 * @param {string} [options.value]
 * @param {string} [options.placeholder]
 * @param {number} [options.maxLength]
 * @param {(value: string) => void} [options.onInput]
 * @param {(value: string) => void} [options.onChange]
 * @param {HTMLInputElement} [options.input]
 * @returns {object}
 */
export function createEntryRow({ label, subtitle, field, id, value, placeholder, maxLength, onInput, onChange, input }) {
    const control = prepareInput(input, 'text', id);
    if (value !== undefined) control.value = value;
    if (placeholder !== undefined) control.placeholder = placeholder;
    if (maxLength !== undefined) control.maxLength = maxLength;
    const row = element('div', 'ds-row ds-row-entry');
    markField(row, field);
    const text = textColumn(label, subtitle, control, 'label');
    text.append(control);
    row.append(text);
    control.addEventListener('input', () => onInput?.(control.value));
    control.addEventListener('change', () => onChange?.(control.value));
    return {
        ...rowController(row, control),
        getValue: () => control.value,
        setValue(value, { silent = true } = {}) {
            control.value = value ?? '';
            if (!silent) onChange?.(control.value);
        },
    };
}

/**
 * @param {object} options
 * @param {string} options.label
 * @param {string|number} options.value
 * @param {string} options.field
 * @param {string} [options.id]
 * @param {boolean} [options.selectable=true]
 * @returns {object}
 */
export function createPropertyRow({ label, value, field, id, selectable = true }) {
    const row = element('div', 'ds-row ds-row-property');
    markField(row, field, id);
    const text = element('span', 'ds-row-text');
    const caption = element('span', 'ds-row-subtitle', label);
    const display = element('span', 'ds-row-label ds-row-property__value', value);
    display.style.setProperty('-webkit-user-select', selectable ? 'text' : 'none');
    display.style.setProperty('user-select', selectable ? 'text' : 'none');
    text.append(caption, display);
    row.append(text);
    return {
        ...rowController(row),
        setValue(value) {
            display.textContent = value ?? '';
        },
    };
}

/**
 * @param {object} options
 * @param {string} options.label
 * @param {string} options.field
 * @param {string} [options.id]
 * @param {string} [options.subtitle]
 * @param {boolean} [options.open=false]
 * @param {(Node|{row: HTMLElement})[]} [options.children=[]]
 * @param {(open: boolean) => void} [options.onToggle]
 * @returns {object}
 */
export function createExpanderRow({ label, subtitle, field, id, open = false, children = [], onToggle }) {
    const row = element('details', 'ds-row-expander');
    markField(row, field, id);
    const summary = element('summary', 'ds-row');
    summary.append(textColumn(label, subtitle, summary));
    const content = element('div', 'ds-row-expander-content');
    appendRows(content, children);
    row.append(summary, content);
    row.open = Boolean(open);
    row.addEventListener('toggle', () => onToggle?.(row.open));
    const preventDisabledToggle = event => {
        if (row.getAttribute('aria-disabled') === 'true') event.preventDefault();
    };
    summary.addEventListener('click', preventDisabledToggle);
    summary.addEventListener('keydown', event => {
        if (event.key === ' ' || event.key === 'Enter') preventDisabledToggle(event);
    });
    return {
        ...rowController(row, summary),
        content,
        setOpen(open) {
            row.open = Boolean(open);
        },
    };
}

/**
 * @param {object} options
 * @param {string} options.label
 * @param {string} options.field
 * @param {string} [options.id]
 * @param {string} [options.icon] Font Awesome icon name without the fa- prefix.
 * @param {boolean} [options.danger=false]
 * @param {(event: MouseEvent) => void} [options.onActivate]
 * @returns {object}
 */
export function createButtonRow({ label, icon, field, id, danger = false, onActivate }) {
    const row = element('button', 'ds-row ds-button-row');
    markField(row, field, id);
    row.type = 'button';
    row.classList.toggle('is-destructive', Boolean(danger));
    if (icon) {
        const glyph = element('i', `fa-solid fa-${icon}`);
        glyph.setAttribute('aria-hidden', 'true');
        row.append(glyph);
    }
    row.append(element('span', 'ds-row-label', label));
    row.addEventListener('click', event => onActivate?.(event));
    return rowController(row, row);
}

/**
 * @param {object} options
 * @param {string} options.field
 * @param {string} [options.id]
 * @param {string} [options.title]
 * @param {string} [options.subtitle]
 * @param {(Node|{row: HTMLElement})[]} [options.rows=[]]
 * @param {Node} [options.headerSuffix]
 * @returns {object}
 */
export function createPrefGroup({ title, subtitle, field, id, rows = [], headerSuffix }) {
    const section = element('section', 'sb-editor-section');
    markField(section, field, id);
    const group = element('div', 'ds-pref-group');
    group.setAttribute('role', 'group');
    if (title || subtitle) {
        const header = element('div', 'ds-pref-group-header');
        if (title) {
            const heading = element('h3', 'ds-pref-group-heading', title);
            ensureId(heading);
            group.setAttribute('aria-labelledby', heading.id);
            header.append(heading);
        }
        if (subtitle) {
            const description = element('p', 'ds-pref-group-subtitle', subtitle);
            associateDescription(group, description);
            header.append(description);
        }
        if (headerSuffix) header.append(headerSuffix);
        section.append(header);
    }
    appendRows(group, rows);
    section.append(group);
    return {
        ...rowController(section),
        section,
        group,
        append(...rows) {
            appendRows(group, rows);
        },
    };
}
