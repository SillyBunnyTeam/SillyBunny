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
    // ARIA in HTML forbids aria-checked on a native checkbox; `checked` is the switch state.
    control.removeAttribute('aria-checked');
    if (checked !== undefined) control.checked = Boolean(checked);
    if (disabled !== undefined) control.disabled = Boolean(disabled);
    const row = element('label', 'ds-row ds-row-switch');
    markField(row, field);
    row.htmlFor = control.id;
    row.append(textColumn(label, subtitle, control), control);
    const notify = () => onChange?.(control.checked);
    control.addEventListener('change', notify);
    const controller = rowController(row, control);
    return {
        ...controller,
        destroy() {
            control.removeEventListener('change', notify);
            controller.destroy();
        },
        getValue: () => control.checked,
        setValue(value, { silent = true } = {}) {
            control.checked = Boolean(value);
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

const FLOATING_ENTRY_TYPES = new Set(['text', 'url', 'search', 'email', 'tel']);

function prepareFloatingInput(input, id) {
    if (input && (input.tagName !== 'INPUT' || !FLOATING_ENTRY_TYPES.has(input.type))) {
        throw new TypeError('Expected a single-line text input.');
    }
    const control = input ?? document.createElement('input');
    if (!input) control.type = 'text';
    ensureId(control, id);
    return control;
}

function secretStatus(control, { savedText, missingText }) {
    const status = element('span', 'ds-row-entry__status');
    ensureId(status);
    const icon = element('i', 'fa-solid');
    icon.setAttribute('aria-hidden', 'true');
    const text = element('span', 'sr-only');
    status.append(icon, text);
    associateDescription(control, status);
    const read = () => {
        const placeholder = control.getAttribute('placeholder') ?? '';
        const state = savedText && placeholder.startsWith(savedText) ? 'saved'
            : missingText && placeholder.startsWith(missingText) ? 'missing'
                : 'unknown';
        status.dataset.state = state;
        status.hidden = state === 'unknown';
        icon.className = `fa-solid ${state === 'saved' ? 'fa-circle-check' : 'fa-circle-exclamation'}`;
        text.textContent = placeholder;
    };
    read();
    // secrets.js reports key status by rewriting the placeholder; follow it rather than edit secrets.js.
    const observer = new MutationObserver(read);
    observer.observe(control, { attributes: true, attributeFilter: ['placeholder'] });
    return { status, disconnect: () => observer.disconnect() };
}

function revealToggle(control, label) {
    if (!globalThis.CSS?.supports?.('-webkit-text-security', 'disc')) return null;
    control.classList.add('is-masked');
    const button = element('button', 'ds-row-entry__reveal');
    button.type = 'button';
    button.setAttribute('aria-pressed', 'false');
    button.setAttribute('aria-controls', control.id);
    button.setAttribute('aria-label', label);
    button.title = label;
    const icon = element('i', 'fa-solid fa-eye');
    icon.setAttribute('aria-hidden', 'true');
    button.append(icon);
    button.addEventListener('click', () => {
        const revealed = control.classList.toggle('is-masked') === false;
        button.setAttribute('aria-pressed', String(revealed));
        icon.className = `fa-solid ${revealed ? 'fa-eye-slash' : 'fa-eye'}`;
    });
    return button;
}

function floatingEntryRow({ label, subtitle, field, control, suffix, secret }) {
    // :placeholder-shown tells an empty field from a filled one, including programmatic .val() writes.
    if (!control.hasAttribute('placeholder')) control.setAttribute('placeholder', ' ');
    const row = element('div', 'ds-row ds-row-entry ds-row-entry--floating');
    markField(row, field);
    const line = element('span', 'ds-row-entry__line');
    const fieldBox = element('span', 'ds-row-text ds-row-entry__field');
    const title = element('label', 'ds-row-label ds-row-entry__title', label);
    title.htmlFor = control.id;
    fieldBox.append(title, control);
    line.append(fieldBox);
    const trailing = [];
    const keyStatus = secret ? secretStatus(control, secret) : null;
    if (keyStatus) trailing.push(keyStatus.status);
    const reveal = secret ? revealToggle(control, secret.revealLabel) : null;
    if (reveal) trailing.push(reveal);
    if (suffix) trailing.push(...(Array.isArray(suffix) ? suffix : [suffix]));
    if (trailing.length) {
        const tail = element('span', 'ds-row-suffix');
        tail.append(...trailing);
        line.append(tail);
    }
    row.append(line);
    if (subtitle) {
        const caption = element('small', 'ds-row-subtitle ds-row-entry__caption', subtitle);
        associateDescription(control, caption);
        row.append(caption);
    }
    return { row, disconnect: () => keyStatus?.disconnect() };
}

/**
 * @param {object} options
 * @param {string} options.label
 * @param {string} options.field
 * @param {string} [options.id]
 * @param {string} [options.subtitle]  With `floating`, shown as a caption under the field.
 * @param {string} [options.value]
 * @param {string} [options.placeholder]
 * @param {number} [options.maxLength]
 * @param {boolean} [options.floating=false]  Title inside the field that floats on focus or value (AdwEntryRow).
 * @param {Node|Node[]} [options.suffix]  Trailing controls; `floating` only.
 * @param {{savedText: string, missingText: string, revealLabel: string}} [options.secret]
 *     Mirrors key status from the placeholder and masks where supported; the input type never changes. `floating` only.
 * @param {(value: string) => void} [options.onInput]
 * @param {(value: string) => void} [options.onChange]
 * @param {HTMLInputElement} [options.input]
 * @returns {object}
 */
export function createEntryRow({ label, subtitle, field, id, value, placeholder, maxLength, floating = false, suffix, secret, onInput, onChange, input }) {
    if ((secret || suffix) && !floating) throw new TypeError('Secret and suffix options need the floating layout.');
    const control = floating ? prepareFloatingInput(input, id) : prepareInput(input, 'text', id);
    if (value !== undefined) control.value = value;
    if (placeholder !== undefined) control.placeholder = placeholder;
    if (maxLength !== undefined) control.maxLength = maxLength;
    let row;
    let disconnect = () => {};
    if (floating) {
        ({ row, disconnect } = floatingEntryRow({ label, subtitle, field, control, suffix, secret }));
    } else {
        row = element('div', 'ds-row ds-row-entry');
        markField(row, field);
        const text = textColumn(label, subtitle, control, 'label');
        text.append(control);
        row.append(text);
    }
    control.addEventListener('input', () => onInput?.(control.value));
    control.addEventListener('change', () => onChange?.(control.value));
    const controller = rowController(row, control);
    return {
        ...controller,
        destroy() {
            disconnect();
            controller.destroy();
        },
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
