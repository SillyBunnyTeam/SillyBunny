/** Shared boxed-list row factories. Labels arrive translated; adopted controls retain their identity. */

import { animateHeightFrom, play, stopMotion, MOTION_SLOW } from '../sillybunny-motion.js';

let nextRowId = 0;
const reservedIds = new Map();
const idReservations = new WeakMap();
const floatingDescriptionSources = new WeakMap();

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

/**
 * Moves the content of an upstream caption into a row's label, subtitle or group heading, so its
 * text and `data-i18n` survive. A missing caption leaves the target as it is.
 * @param {Element} target
 * @param {Element|null|undefined} source
 * @param {object} [options]
 * @param {boolean} [options.copyId=false]  Also move the caption's `id`, for references that name it.
 * @param {boolean} [options.keepSource=false]  Leave the emptied caption in the document.
 * @param {boolean} [options.stripColon=false]  Flatten to trimmed plain text without a trailing colon.
 */
export function moveCaption(target, source, { copyId = false, keepSource = false, stripColon = false } = {}) {
    if (!source) return;
    if (source.dataset.i18n) target.dataset.i18n = source.dataset.i18n;
    if (copyId && source.id) target.id = source.id;
    target.replaceChildren(...source.childNodes);
    if (stripColon) target.textContent = target.textContent.trim().replace(/[：:]$/, '').trim();
    if (!keepSource) source.remove();
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
 * @param {boolean} [options.chevron=true]  The trailing arrow of an activatable row; a row that runs an action instead of opening a view leaves it out.
 * @param {boolean} [options.stacked=false]  Label above a full-width suffix (chip entries, wide controls).
 * @param {(event: MouseEvent) => void} [options.onActivate]
 * @returns {object}
 */
export function createRow({ label, subtitle, field, id, prefix, suffix, activatable = false, chevron = true, stacked = false, onActivate }) {
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
    if (activatable && chevron) {
        const arrow = element('i', 'fa-solid fa-chevron-right ds-row__chevron');
        arrow.setAttribute('aria-hidden', 'true');
        row.append(arrow);
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
    return checkboxRow('ds-row-switch', { label, subtitle, field, checked, disabled, onChange, control });
}

/**
 * One item of a pick-several list: a native checkbox at the start, and the whole row toggles it.
 * Same contract as {@link createSwitchRow}; use a switch row for a single on/off setting.
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
export function createCheckRow({ label, subtitle, field, id, checked, disabled, onChange, input }) {
    const control = prepareInput(input, 'checkbox', id);
    control.classList.remove('sb-switch');
    control.removeAttribute('role');
    return checkboxRow('ds-row-check', { label, subtitle, field, checked, disabled, onChange, control });
}

function checkboxRow(variant, { label, subtitle, field, checked, disabled, onChange, control }) {
    // ARIA in HTML forbids aria-checked on a native checkbox; `checked` is the state.
    control.removeAttribute('aria-checked');
    if (checked !== undefined) control.checked = Boolean(checked);
    if (disabled !== undefined) control.disabled = Boolean(disabled);
    const row = element('label', `ds-row ${variant}`);
    markField(row, field);
    row.htmlFor = control.id;
    const text = textColumn(label, subtitle, control);
    // A check leads its row and a switch ends it, as libadwaita's check prefix and switch suffix.
    row.append(...(variant === 'ds-row-check' ? [control, text] : [text, control]));
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

// Named after GTK's value-decrease and value-increase icons. rows.js takes no i18n import, so these stay untranslated.
const SPIN_BUTTON_LABELS = Object.freeze({ down: 'Decrease', up: 'Increase' });

/** The step of the buttons is the input's `step`; `any`, a missing or a non-positive step steps by 1. */
function spinStep(control) {
    const step = numberAttribute(control, 'step');
    return step !== undefined && step > 0 ? step : 1;
}

function decimalPlaces(number) {
    const [, fraction = '', exponent = '0'] = /(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(number));
    return Math.max(0, fraction.length - Number(exponent));
}

function spinValue(control) {
    const raw = control.value.trim();
    const number = raw === '' ? Number.NaN : Number(raw);
    return Number.isFinite(number) ? number : null;
}

/**
 * The minus and plus buttons of a spin row. They act on the field as typing would: the new value is
 * written, then `input` and `change` are dispatched on it, so every listener on the field runs.
 * An empty (or unparsable) field counts as 0 before the step, as the native stepper does, so the first
 * press adds or subtracts one step and the bounds then apply (a minimum above 0 is what either press sets).
 */
function createSpinButtons(control, row) {
    const button = (direction, icon) => {
        const node = element('button', `ds-spin-btn ds-spin-btn--${direction}`);
        node.type = 'button';
        node.setAttribute('aria-label', SPIN_BUTTON_LABELS[direction]);
        node.title = SPIN_BUTTON_LABELS[direction];
        const glyph = element('i', `fa-solid ${icon}`);
        glyph.setAttribute('aria-hidden', 'true');
        node.append(glyph);
        return node;
    };
    const decrease = button('down', 'fa-minus');
    const increase = button('up', 'fa-plus');
    const bounds = () => [numberAttribute(control, 'min') ?? -Infinity, numberAttribute(control, 'max') ?? Infinity];

    const sync = () => {
        const locked = control.disabled || control.readOnly;
        const [lower, upper] = bounds();
        const current = spinValue(control);
        const refresh = (node, limited) => {
            const disabled = locked || (current !== null && limited);
            // A disabled button drops focus, so a keyboard user who reached a bound keeps their place in the field.
            if (disabled && !node.disabled && node.ownerDocument.activeElement === node) control.focus();
            node.disabled = disabled;
        };
        refresh(decrease, current !== null && current <= lower);
        refresh(increase, current !== null && current >= upper);
    };

    const step = direction => {
        const [lower, upper] = bounds();
        const current = spinValue(control) ?? 0;
        const size = spinStep(control);
        const places = Math.max(decimalPlaces(size), decimalPlaces(current));
        const next = Math.min(upper, Math.max(lower, Number((current + direction * size).toFixed(places))));
        if (next === spinValue(control)) return;
        control.value = String(next);
        control.dispatchEvent(new Event('input', { bubbles: true }));
        control.dispatchEvent(new Event('change', { bubbles: true }));
    };
    decrease.addEventListener('click', () => step(-1));
    increase.addEventListener('click', () => step(1));

    // Other code writes the value without an event, so the row also looks again when the user reaches it.
    control.addEventListener('input', sync);
    control.addEventListener('change', sync);
    row.addEventListener('pointerover', sync);
    row.addEventListener('focusin', sync);
    sync();
    return {
        nodes: [decrease, increase],
        sync,
        destroy() {
            control.removeEventListener('input', sync);
            control.removeEventListener('change', sync);
        },
    };
}

/** Builds the row, adds the spin buttons after the field and lets the row controller drive them. */
function spinRow(label, subtitle, field, control) {
    const row = suffixRow(label, subtitle, field, control);
    row.classList.add('ds-row--spin');
    // The stylesheet cannot measure a placeholder, so the row reserves room for its length.
    if (control.placeholder) row.style.setProperty('--sb-spin-chars', String(control.placeholder.length));
    const buttons = createSpinButtons(control, row);
    row.querySelector('.ds-row-suffix').append(...buttons.nodes);
    const controller = rowController(row, control);
    buttons.sync();
    return {
        row,
        buttons,
        controller: {
            ...controller,
            setDisabled(disabled) {
                controller.setDisabled(disabled);
                buttons.sync();
            },
            destroy() {
                buttons.destroy();
                controller.destroy();
            },
        },
    };
}

/**
 * The value is right-aligned at the end of the row with a minus and a plus button beside it. The buttons
 * step by the input's `step` (`any` steps by 1), stop at `min` and `max`, and disable there.
 * @param {object} options
 * @param {string} options.label
 * @param {string} options.field
 * @param {string} [options.id]
 * @param {string} [options.subtitle]
 * @param {number|null} [options.value]
 * @param {number} [options.min]
 * @param {number} [options.max]
 * @param {number|'any'} [options.step=1]
 * @param {boolean} [options.nullable=false]
 * @param {boolean} [options.normalize=true]  False keeps an adopted text/number input's upstream validation unchanged.
 * @param {string} [options.placeholder]
 * @param {(value: number|null) => void} [options.onChange]
 * @param {HTMLInputElement} [options.input]
 * @returns {object}
 */
export function createSpinRow({ label, subtitle, field, id, value, min, max, step = 1, nullable = false, normalize: normalizeInput = true, placeholder, onChange, input }) {
    if (!normalizeInput) {
        if (!input || input.tagName !== 'INPUT' || !['text', 'number'].includes(input.type)) {
            throw new TypeError('An unnormalized spin row needs a text or number input.');
        }
        ensureId(input, id);
        input.classList.add('ds-spin');
        input.inputMode = 'numeric';
        return spinRow(label, subtitle, field, input).controller;
    }
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
    const { buttons, controller } = spinRow(label, subtitle, field, control);
    control.addEventListener('change', () => {
        const next = commit(control.value);
        buttons.sync();
        onChange?.(next);
    });
    return {
        ...controller,
        getValue: () => normalize(control.value),
        setValue(value, { silent = true } = {}) {
            const next = commit(value);
            buttons.sync();
            if (!silent) onChange?.(next);
        },
    };
}

const ENTRY_TYPES = new Set(['text', 'password', 'url', 'search', 'email', 'tel']);

/** An adopted input keeps its own type, so a requested type must agree with it. */
function assertEntryType(input, type) {
    if (type === undefined) return;
    if (!ENTRY_TYPES.has(type) || (input && input.type !== type)) throw new TypeError(`Expected an entry input of type ${type}.`);
}

function prepareFloatingInput(input, id, type) {
    // A value that may hold line breaks keeps its textarea, which the row shows at one line and lets grow with its text.
    if (input?.tagName === 'TEXTAREA') {
        if (type !== undefined) throw new TypeError(`Expected an entry input of type ${type}.`);
        input.rows = 1;
        ensureId(input, id);
        return input;
    }
    if (input && (input.tagName !== 'INPUT' || !ENTRY_TYPES.has(input.type))) {
        throw new TypeError('Expected a single-line text input or a textarea.');
    }
    assertEntryType(input, type);
    const control = input ?? document.createElement('input');
    if (!input) control.type = type ?? 'text';
    ensureId(control, id);
    return control;
}

export function prepareFloatingPlaceholder(control, { describe = true } = {}) {
    const hint = control.getAttribute('placeholder')?.trim();
    if (hint) {
        control.dataset.sbFloatingPlaceholder = hint;
        if (describe) {
            if (!floatingDescriptionSources.has(control)) {
                floatingDescriptionSources.set(control, control.getAttribute('aria-description') ?? '');
            }
            const description = [floatingDescriptionSources.get(control), hint]
                .filter((value, index, values) => value && values.indexOf(value) === index)
                .join(' ');
            if (control.getAttribute('aria-description') !== description) control.setAttribute('aria-description', description);
        }
    }
    if (control.getAttribute('placeholder') !== ' ') control.setAttribute('placeholder', ' ');
}

function prepareEntryInput(input, id, type) {
    // Popup's public mainInput is a textarea, including its single-line name prompts.
    if (input?.tagName !== 'TEXTAREA') {
        if (input && (input.tagName !== 'INPUT' || !ENTRY_TYPES.has(input.type))) {
            throw new TypeError('Expected a text or password entry input.');
        }
        assertEntryType(input, type);
        const control = input ?? document.createElement('input');
        if (!input) control.type = type ?? 'text';
        ensureId(control, id);
        return control;
    }
    if (type !== undefined) throw new TypeError(`Expected an entry input of type ${type}.`);
    ensureId(input, id);
    return input;
}

/**
 * The error state of a field: the caller's text in a caption that `place` puts under the control, with `aria-invalid`
 * and a description link. An empty message clears it. Shared by the entry row and the text-area field.
 * @param {HTMLElement} control
 * @param {string} className  Classes of the caption.
 * @param {(caption: HTMLElement) => void} place
 */
function createErrorState(control, className, place) {
    let caption = null;
    const clearError = () => {
        if (!caption) return;
        const ids = (control.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(id => id && id !== caption.id);
        if (ids.length) control.setAttribute('aria-describedby', ids.join(' '));
        else control.removeAttribute('aria-describedby');
        control.removeAttribute('aria-invalid');
        releaseRowIds(caption);
        caption.remove();
        caption = null;
    };
    const setError = message => {
        const text = String(message ?? '').trim();
        if (!text) return clearError();
        if (!caption) {
            caption = element('small', className);
            place(caption);
            associateDescription(control, caption);
        }
        caption.textContent = text;
        control.setAttribute('aria-invalid', 'true');
    };
    return { setError, clearError };
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
        const rawPlaceholder = control.getAttribute('placeholder')?.trim();
        if (rawPlaceholder) control.dataset.sbFloatingPlaceholder = rawPlaceholder;
        const placeholder = control.dataset.sbFloatingPlaceholder ?? '';
        const state = savedText && placeholder.startsWith(savedText) ? 'saved'
            : missingText && placeholder.startsWith(missingText) ? 'missing'
                : 'unknown';
        status.dataset.state = state;
        status.hidden = state === 'unknown';
        icon.className = `fa-solid ${state === 'saved' ? 'fa-circle-check' : 'fa-circle-exclamation'}`;
        text.textContent = placeholder;
        prepareFloatingPlaceholder(control, { describe: false });
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

/** The pencil at the end of an entry row's editable area; the stylesheet hides it while the text has focus. */
export function createEntryEditIcon() {
    const icon = element('i', 'fa-solid fa-pencil ds-row-entry__edit');
    icon.setAttribute('aria-hidden', 'true');
    return icon;
}

/** Pressing an entry row anywhere but on one of its own controls starts editing, as AdwEntryRow does. */
function focusOnPress(row, control) {
    row.addEventListener('click', event => {
        if (event.defaultPrevented || !(event.target instanceof Element) || event.target.closest('input, select, textarea, button, a, [role="button"], .menu_button')) return;
        control.focus();
    });
}

function floatingEntryRow({ label, subtitle, field, control, suffix, secret }) {
    prepareFloatingPlaceholder(control);
    const row = element('div', 'ds-row ds-row-entry ds-row-entry--floating');
    markField(row, field);
    focusOnPress(row, control);
    const line = element('span', 'ds-row-entry__line');
    const fieldBox = element('span', 'ds-row-text ds-row-entry__field');
    const title = element('label', 'ds-row-label ds-row-entry__title', label);
    title.htmlFor = control.id;
    // The key status belongs to the field, before the pencil, where AdwEntryRow keeps its indicator; the buttons after it
    // are separate targets, set apart by the separator the stylesheet draws before them.
    const keyStatus = secret ? secretStatus(control, secret) : null;
    fieldBox.append(title, control, ...(keyStatus ? [keyStatus.status] : []), createEntryEditIcon());
    line.append(fieldBox);
    const trailing = [];
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
 * @param {string} [options.type='text']  `password` keeps the browser's own masking, with no reveal toggle. An adopted input keeps its type, which must agree.
 * @param {boolean} [options.floating=false]  AdwEntryRow: the row is the field. The title stands where the text goes and moves above it on focus or value; a pencil marks the row as editable while it is not being edited.
 * @param {Node|Node[]} [options.suffix]  Trailing controls; `floating` only.
 * @param {{savedText: string, missingText: string, revealLabel: string}} [options.secret]
 *     Mirrors key status from the placeholder and masks where supported; the input type never changes. `floating` only; not for a password input.
 * @param {(value: string) => void} [options.onInput]
 * @param {(value: string) => void} [options.onChange]
 * @param {HTMLInputElement|HTMLTextAreaElement} [options.input]  Textareas are supported in the stacked layout only.
 * @returns {object}  The row controller, plus `setError(message)` and `clearError()`. `setError` shows the caller's text in a caption under the field and sets `aria-invalid` and `aria-describedby`; an empty message clears.
 */
export function createEntryRow({ label, subtitle, field, id, value, placeholder, maxLength, type, floating = false, suffix, secret, onInput, onChange, input }) {
    if ((secret || suffix) && !floating) throw new TypeError('Secret and suffix options need the floating layout.');
    if (secret && (type ?? input?.type) === 'password') throw new TypeError('A password input has its own masking and takes no secret option.');
    const control = floating ? prepareFloatingInput(input, id, type) : prepareEntryInput(input, id, type);
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
    const { setError, clearError } = createErrorState(control, 'ds-row-subtitle ds-row-entry__caption ds-row-entry__error', caption => (floating ? row.firstElementChild : control).after(caption));
    return {
        ...controller,
        destroy() {
            disconnect();
            clearError();
            controller.destroy();
        },
        setError,
        clearError,
        getValue: () => control.value,
        setValue(value, { silent = true } = {}) {
            control.value = value ?? '';
            if (!silent) onChange?.(control.value);
        },
    };
}

function textAreaCount({ label, element: adopted }) {
    const caption = element('small', 'ds-row-subtitle ds-row-textarea__count');
    const value = adopted ?? element('span', '');
    value.classList.add('ds-row-textarea__count-value');
    caption.append(element('span', 'ds-row-textarea__count-label', label), ' ', value);
    return { caption, value };
}

function textAreaExpand(control, label) {
    const button = element('button', 'menu_button menu_button_icon editor_maximize ds-row-textarea__expand');
    button.type = 'button';
    // The shared .editor_maximize handler finds its field by this id.
    button.dataset.for = control.id;
    button.setAttribute('aria-label', label);
    button.title = label;
    const glyph = element('i', 'fa-solid fa-maximize');
    glyph.setAttribute('aria-hidden', 'true');
    button.append(glyph);
    return button;
}

/**
 * A multi-line field with a label row above it: the label, an optional count of this field's tokens, and Expand at
 * the inline end. The textarea carries the shell's field tokens; a help caption sits under it. An adopted textarea
 * moves into the row with its id, name, classes and listeners; the caller inserts `row` where it was.
 * @param {object} options
 * @param {string} options.label
 * @param {string} options.field
 * @param {string} [options.id]
 * @param {string} [options.subtitle]  One line of help under the field, linked by `aria-describedby`.
 * @param {string} [options.value]
 * @param {string} [options.placeholder]
 * @param {number} [options.rows]
 * @param {number} [options.maxLength]
 * @param {{ label: string, element?: HTMLElement }} [options.count]
 *     Shows a dimmed count in the label row, under the label `label` (for example "Tokens:"). `element` adopts a node
 *     that other code already writes the number to; without it the field makes its own and `setCount` writes it.
 * @param {boolean} [options.expand=true]  The Expand button, which opens the shared expanded editor for the textarea.
 * @param {string} [options.expandLabel]  The translated name of Expand. Required unless `expand` is false.
 * @param {(value: string) => void} [options.onInput]
 * @param {(value: string) => void} [options.onChange]
 * @param {HTMLTextAreaElement} [options.input]
 * @returns {object}  The row controller, plus `labelRow`, `expand` (null when left out), `setCount(value)`,
 *     `setError(message)` and `clearError()` as on the entry row, and `getValue` and `setValue`.
 */
export function createTextAreaField({ label, subtitle, field, id, value, placeholder, rows, maxLength, count, expand = true, expandLabel, onInput, onChange, input }) {
    if (input && input.tagName !== 'TEXTAREA') throw new TypeError('Expected a textarea.');
    if (expand && !expandLabel) throw new TypeError('The text-area field needs the translated name of its Expand button.');
    const control = input ?? element('textarea', 'text_pole');
    ensureId(control, id);
    control.classList.add('ds-row-textarea__input');
    if (value !== undefined) control.value = value;
    if (placeholder !== undefined) control.placeholder = placeholder;
    if (rows !== undefined) control.rows = rows;
    if (maxLength !== undefined) control.maxLength = maxLength;

    const row = element('div', 'ds-row ds-row--stacked ds-row-textarea');
    markField(row, field);
    // The class is the one the editors' label rows share (see attachToLabelRow in chrome.js).
    const labelRow = element('div', 'ds-row-textarea__label-row sb-editor-label-row');
    const title = element('label', 'ds-row-label ds-row-textarea__label', label);
    title.htmlFor = control.id;
    labelRow.append(title);
    const counter = count ? textAreaCount(count) : null;
    if (counter) labelRow.append(counter.caption);
    const expandButton = expand ? textAreaExpand(control, expandLabel) : null;
    if (expandButton) labelRow.append(expandButton);
    row.append(labelRow, control);
    if (subtitle) {
        const caption = element('small', 'ds-row-subtitle ds-row-textarea__caption', subtitle);
        associateDescription(control, caption);
        row.append(caption);
    }

    control.addEventListener('input', () => onInput?.(control.value));
    control.addEventListener('change', () => onChange?.(control.value));
    const controller = rowController(row, control);
    const { setError, clearError } = createErrorState(control, 'ds-row-subtitle ds-row-textarea__error', caption => control.after(caption));
    return {
        ...controller,
        labelRow,
        expand: expandButton,
        destroy() {
            clearError();
            controller.destroy();
        },
        setCount(number) {
            if (counter) counter.value.textContent = number === null || number === undefined ? '' : String(number);
        },
        setError,
        clearError,
        getValue: () => control.value,
        setValue(next, { silent = true } = {}) {
            control.value = next ?? '';
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
 * @param {boolean} [options.mono=false] The value is code or an identifier (an id, a path, a hash), which takes the Mono role.
 * @returns {object}
 */
export function createPropertyRow({ label, value, field, id, selectable = true, mono = false }) {
    const row = element('div', 'ds-row ds-row-property');
    markField(row, field, id);
    const text = element('span', 'ds-row-text');
    const caption = element('span', 'ds-row-subtitle', label);
    const display = element('span', 'ds-row-label ds-row-property__value', value);
    display.classList.toggle('is-monospace', mono);
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

/** Reveals or hides an expander's content over the shared expander motion; with no motion it switches at once. */
function revealContent(content, open) {
    stopMotion(content);
    if (open) {
        content.hidden = false;
        animateHeightFrom(content, 0, { duration: MOTION_SLOW });
        return;
    }
    play(content, [{ height: `${content.getBoundingClientRect().height}px` }, { height: '0px' }], {
        duration: MOTION_SLOW,
        fill: 'forwards',
        inert: true,
        styles: { 'box-sizing': 'border-box', overflow: 'hidden' },
        onFinish: () => { content.hidden = true; },
    });
}

/**
 * Wires a header button to the content it discloses. The button keeps focus when it toggles, and
 * closed content is `hidden`, so nothing inside it is in the tab order.
 */
function bindExpander({ row, toggle, content, open = false, onToggle }) {
    ensureId(content);
    toggle.setAttribute('aria-controls', content.id);
    const isOpen = () => toggle.getAttribute('aria-expanded') === 'true';
    const render = expanded => {
        toggle.setAttribute('aria-expanded', String(expanded));
        row.classList.toggle('is-open', expanded);
    };
    render(Boolean(open));
    content.hidden = !open;
    function setOpen(next, { animate = true } = {}) {
        const expanded = Boolean(next);
        if (expanded === isOpen()) return;
        if (!expanded && content.contains(document.activeElement)) toggle.focus({ preventScroll: true });
        render(expanded);
        if (animate) revealContent(content, expanded);
        else {
            stopMotion(content);
            content.hidden = !expanded;
        }
        onToggle?.(expanded);
    }
    toggle.addEventListener('click', () => {
        if (row.getAttribute('aria-disabled') !== 'true') setOpen(!isOpen());
    });
    return { isOpen, setOpen };
}

/**
 * A row that discloses nested rows. The header is a row with a toggle button, so a control in its
 * suffix (a switch, as AdwExpanderRow's enable switch) keeps its own focus and does not toggle the
 * row. Several expanders may be open at once. Disabling the row makes all of it inert.
 * @param {object} options
 * @param {string} options.label
 * @param {string} options.field
 * @param {string} [options.id]
 * @param {string} [options.subtitle]
 * @param {boolean} [options.open=false]
 * @param {(Node|{row: HTMLElement})[]} [options.children=[]]
 * @param {Node|Node[]} [options.suffix] Controls placed in the header before the arrow.
 * @param {(open: boolean) => void} [options.onToggle] Runs on every change of state, from the user or from `setOpen`.
 * @returns {object} The row controller, plus `header`, `toggle`, `content`, `isOpen()` and `setOpen(open, { animate })`.
 */
export function createExpanderRow({ label, subtitle, field, id, open = false, children = [], suffix, onToggle }) {
    const row = element('div', 'ds-row-expander');
    markField(row, field, id);
    const header = element('div', 'ds-row ds-row-expander__header');
    const toggle = element('button', 'ds-row-expander__toggle');
    toggle.type = 'button';
    toggle.append(textColumn(label, subtitle, toggle));
    header.append(toggle);
    if (suffix) {
        const tail = element('span', 'ds-row-suffix');
        tail.append(...(Array.isArray(suffix) ? suffix : [suffix]));
        header.append(tail);
    }
    const arrow = element('span', 'ds-row-expander__arrow');
    arrow.setAttribute('aria-hidden', 'true');
    header.append(arrow);
    const content = element('div', 'ds-row-expander-content');
    appendRows(content, children);
    row.append(header, content);
    const { isOpen, setOpen } = bindExpander({ row, toggle, content, open, onToggle });
    return { ...rowController(row), control: toggle, header, toggle, content, isOpen, setOpen };
}

/**
 * Binds markup that is already in the page: `.ds-row-expander` holding a `.ds-row-expander__header`
 * with a `.ds-row-expander__toggle` button, and a `.ds-row-expander-content`. Use it where the
 * expander is authored in HTML; {@link createExpanderRow} builds the same structure.
 * @param {HTMLElement} row
 * @param {object} [options]
 * @param {boolean} [options.open=false]
 * @param {(open: boolean) => void} [options.onToggle]
 * @returns {{row: HTMLElement, toggle: HTMLButtonElement, content: HTMLElement, isOpen: () => boolean, setOpen: (open: boolean, options?: {animate?: boolean}) => void}}
 */
export function adoptExpanderRow(row, { open = false, onToggle } = {}) {
    const toggle = row.querySelector(':scope > .ds-row-expander__header > .ds-row-expander__toggle');
    const content = row.querySelector(':scope > .ds-row-expander-content');
    if (!toggle || !content) throw new TypeError('Expected an expander row with a header toggle and content.');
    return { row, toggle, content, ...bindExpander({ row, toggle, content, open, onToggle }) };
}

// Classes that dress a control as a stand-alone button; on a row they would restyle it.
const BUTTON_CLASSES = Object.freeze(['menu_button', 'menu_button_icon', 'margin0']);

/**
 * Turns an upstream button into the row. A node that is not a `<button>` gets the button role, a tab stop and Enter and
 * Space. The translation key of its caption moves to the label, because a key on the button itself would rewrite the row.
 * @returns {{ cleanup: () => void, i18n: string|undefined }}
 */
function adoptButtonNode(node) {
    const key = node.dataset.i18n ?? node.querySelector('[data-i18n]')?.dataset.i18n;
    delete node.dataset.i18n;
    node.classList.remove(...BUTTON_CLASSES);
    node.classList.add('ds-row', 'ds-button-row');
    node.replaceChildren();
    const i18n = key && !key.startsWith('[') ? key : undefined;
    if (node.localName === 'button') {
        node.type = 'button';
        return { cleanup: () => {}, i18n };
    }
    node.setAttribute('role', 'button');
    if (!node.hasAttribute('tabindex')) node.tabIndex = 0;
    const keydown = event => {
        if (event.target !== node || !['Enter', ' '].includes(event.key)) return;
        event.preventDefault();
        node.click();
    };
    node.addEventListener('keydown', keydown);
    return { cleanup: () => node.removeEventListener('keydown', keydown), i18n };
}

/**
 * @param {object} options
 * @param {string} options.label
 * @param {string} options.field
 * @param {string} [options.id]
 * @param {string} [options.icon] Font Awesome icon name without the fa- prefix.
 * @param {boolean} [options.danger=false]
 * @param {boolean} [options.arrow=false]  A trailing arrow, for a row that opens a window or a new view.
 * @param {boolean} [options.start=false]  The title at the start of the row, for a row that is one choice of a list.
 * @param {HTMLElement} [options.button]  An upstream button that becomes the row, with its id, handlers and visibility.
 * @param {(event: MouseEvent) => void} [options.onActivate]
 * @returns {object}
 */
export function createButtonRow({ label, icon, field, id, danger = false, arrow = false, start = false, button, onActivate }) {
    const row = button ?? element('button', 'ds-row ds-button-row');
    const adopted = button ? adoptButtonNode(row) : null;
    markField(row, field, id);
    if (adopted && row.id) reserveId(row);
    if (!button) row.type = 'button';
    row.classList.toggle('is-destructive', Boolean(danger));
    row.classList.toggle('ds-button-row--arrow', Boolean(arrow));
    row.classList.toggle('ds-button-row--start', Boolean(start));
    if (icon) {
        const glyph = element('i', `fa-solid fa-${icon}`);
        glyph.setAttribute('aria-hidden', 'true');
        row.append(glyph);
    }
    const title = element('span', 'ds-row-label', label);
    if (adopted?.i18n) title.dataset.i18n = adopted.i18n;
    row.append(title);
    if (arrow) {
        const glyph = element('i', 'fa-solid fa-chevron-right fa-fw ds-row__chevron');
        glyph.setAttribute('aria-hidden', 'true');
        row.append(glyph);
    }
    row.addEventListener('click', event => onActivate?.(event));
    const controller = rowController(row, row);
    return adopted ? { ...controller, destroy() { adopted.cleanup(); controller.destroy(); } } : controller;
}

/**
 * @param {object} options
 * @param {string} options.field
 * @param {string} [options.id]
 * @param {string} [options.title]
 * @param {string} [options.subtitle]
 * @param {(Node|{row: HTMLElement})[]} [options.rows=[]]
 * @param {Node} [options.headerSuffix]
 * @param {number} [options.headingLevel=3] Level of the title heading, 1 to 6. A group below a page heading takes the next level.
 * @returns {object}
 */
export function createPrefGroup({ title, subtitle, field, id, rows = [], headerSuffix, headingLevel = 3 }) {
    if (!Number.isInteger(headingLevel) || headingLevel < 1 || headingLevel > 6) {
        throw new RangeError(`A group heading level is a whole number from 1 to 6, not ${headingLevel}.`);
    }
    const section = element('section', 'sb-editor-section');
    markField(section, field, id);
    const group = element('div', 'ds-pref-group');
    group.setAttribute('role', 'group');
    if (title || subtitle) {
        const header = element('div', 'ds-pref-group-header');
        if (title) {
            const heading = element(`h${headingLevel}`, 'ds-pref-group-heading', title);
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

const ENTRY_INPUT = 'input:not([type]), input[type="text"]';

/** The field wrappers of a sheet whose label names a control: `.ds-field` with a label (and its header row) above it. */
function labelledFields(root) {
    return [...root.querySelectorAll('.ds-field')].flatMap(wrapper => {
        const label = wrapper.querySelector(':scope > label.ds-field-label, :scope > .ds-field-header > label.ds-field-label');
        const control = label?.control ?? null;
        return control && wrapper.contains(control) ? [{ wrapper, label, control, header: label.parentElement !== wrapper ? label.parentElement : null }] : [];
    });
}

function tokenCounterOf(wrapper, control) {
    return [...wrapper.querySelectorAll('[data-token-counter]')].find(counter => counter.dataset.tokenCounter === control.id) ?? null;
}

/**
 * Puts the fields of a single-content editor sheet in the shared field anatomy, in place: a single-line field becomes an
 * entry row and a multi-line field a text-area field, each keeping its control, id, name, classes and listeners. The label,
 * its help link, the field's token count, the Edit/Preview placeholder and Expand move into the field's label row.
 * @param {HTMLElement|null} root
 * @param {{ t: (strings: TemplateStringsArray) => string, entryTextAreas?: string[] }} options  The translator, for the names of
 *     the controls the rows add; the ids of textareas that hold a short value (a name, a version) and take an entry row.
 */
export function adoptEditorFields(root, { t, entryTextAreas = [] }) {
    if (!root) return;
    for (const { wrapper, label, control, header } of labelledFields(root)) {
        if (control.closest('.ds-row-entry, .ds-row-textarea')) continue;
        const entry = control.matches(ENTRY_INPUT) || (control instanceof HTMLTextAreaElement && entryTextAreas.includes(control.id));
        if (control instanceof HTMLTextAreaElement && !entry) {
            const counter = tokenCounterOf(wrapper, control);
            const expand = header?.querySelector('.editor_maximize');
            const caption = wrapper.querySelector(':scope > :is(.ds-field-subtitle, .ds-field-hint)');
            const view = createTextAreaField({
                label: ' ',
                field: `${control.dataset.sbEditorField || control.id}-field`,
                input: control,
                subtitle: caption ? ' ' : undefined,
                count: counter ? { label: t`Tokens:`, element: counter } : undefined,
                expand: Boolean(expand),
                expandLabel: t`Expand the Editor`,
            });
            const title = view.row.querySelector('.ds-row-textarea__label');
            moveCaption(title, label);
            if (caption) moveCaption(view.row.querySelector('.ds-row-textarea__caption'), caption);
            const help = header?.querySelector(':scope > .notes-link');
            if (help) title.after(help);
            const preview = header?.querySelector('.sb-preview-toggle');
            if (preview) view.labelRow.insertBefore(preview, view.expand);
            const pane = wrapper.querySelector(':scope > .sb-preview-pane');
            if (pane) control.after(pane);
            header?.remove();
            wrapper.querySelector(':scope > .extension_token_counter')?.remove();
            wrapper.prepend(view.row);
        } else if (entry) {
            const controls = control.closest('.tag_controls');
            const counter = tokenCounterOf(wrapper, control);
            const suffix = [
                ...(counter ? [textAreaCount({ label: t`Tokens:`, element: counter }).caption] : []),
                ...(controls ? controls.querySelectorAll(':scope > button') : []),
            ];
            const view = createEntryRow({
                label: ' ',
                field: control.id,
                input: control,
                floating: true,
                suffix: suffix.length ? suffix : undefined,
            });
            wrapper.querySelector(':scope > .extension_token_counter')?.remove();
            moveCaption(view.row.querySelector('.ds-row-entry__title'), label);
            // The title stands where the placeholder was, so a locale pass must not write the hint back.
            if (control.dataset.i18n) control.dataset.i18n = control.dataset.i18n.split(';').filter(part => !part.startsWith('[placeholder]')).join(';');
            if (!control.dataset.i18n) delete control.dataset.i18n;
            controls?.remove();
            wrapper.prepend(view.row);
        } else {
            continue;
        }
    }
}

export const REVEALED_CLASS = 'sb-editor-sheet--definitions-revealed';

/**
 * Per-character reveal for Spoiler Free Mode. The reveal belongs to the character that was open when the
 * button was pressed, so it changes no setting and ends when another character opens or the editor closes.
 * @param {object} options
 * @param {{ classList: DOMTokenList }} options.sheet  The element that carries the sheet classes.
 * @param {{ addEventListener: (type: string, handler: () => void) => void }} options.button
 * @param {() => string|null} options.getEntityId  The character the editor shows now.
 * @param {() => void} [options.onReveal]
 */
export function createDefinitionsReveal({ sheet, button, getEntityId, onReveal = () => {} }) {
    /** @type {string|null} */
    let revealedFor = null;

    const render = () => sheet.classList.toggle(REVEALED_CLASS, revealedFor !== null);

    button.addEventListener('click', () => {
        revealedFor = getEntityId() ?? null;
        render();
        onReveal();
    });

    return {
        /** Ends the reveal unless the editor still shows the character it was granted for. */
        follow(entityId) {
            if (revealedFor !== entityId) {
                revealedFor = null;
                render();
            }
        },
        reset() {
            revealedFor = null;
            render();
        },
    };
}
