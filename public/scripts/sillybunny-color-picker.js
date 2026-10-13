import { animateIn, MOTION_FAST, SPRING_SHEET } from './sillybunny-motion.js';
import { blockUpstreamDrawerClose } from './sillybunny-sheet.js';

const PICKER_SELECTOR = 'toolcool-color-picker';
const MENU_ID = 'sb-color-picker-menu';
const MARGIN = 12;
const GAP = 8;
const bindings = new WeakMap();
let initialization;
let active = null;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

/** Six-digit edits retain the existing opacity; explicit alpha in hex takes precedence. */
export function parsePickerHex(value, alpha) {
    let hex = value.trim().replace(/^#/, '');
    if (!/^(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(hex)) return null;
    if (hex.length <= 4) hex = [...hex].map(character => character.repeat(2)).join('');
    const channels = [0, 2, 4].map(offset => parseInt(hex.slice(offset, offset + 2), 16));
    const opacity = hex.length === 8 ? parseInt(hex.slice(6), 16) / 255 : alpha;
    return `rgba(${channels.join(', ')}, ${opacity})`;
}

export function positionColorMenu(anchor, size, viewport) {
    const minLeft = viewport.left + MARGIN;
    const minTop = viewport.top + MARGIN;
    const below = viewport.bottom - anchor.bottom - GAP - MARGIN;
    const above = anchor.top - viewport.top - GAP - MARGIN;
    const upwards = size.height > below && above > below;
    return {
        left: clamp(anchor.right - size.width, minLeft, Math.max(minLeft, viewport.right - MARGIN - size.width)),
        top: clamp(upwards ? anchor.top - GAP - size.height : anchor.bottom + GAP,
            minTop, Math.max(minTop, viewport.bottom - MARGIN - size.height)),
    };
}

function viewportBounds() {
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft ?? 0;
    const top = viewport?.offsetTop ?? 0;
    return {
        left, top,
        right: left + (viewport?.width ?? window.innerWidth),
        bottom: top + (viewport?.height ?? window.innerHeight),
    };
}

function node(tag, className, text = '') {
    const element = document.createElement(tag);
    element.className = className;
    element.textContent = text;
    return element;
}

function pickerLabel(picker) {
    const labels = picker.getAttribute('aria-labelledby')?.split(/\s+/)
        .map(id => document.getElementById(id)?.textContent?.trim()).filter(Boolean).join(' ');
    return labels || picker.getAttribute('aria-label')
        || picker.closest('.ds-row, .sb-accent-picker-row')?.querySelector('.ds-row-label, label, span')?.textContent?.trim()
        || picker.shadowRoot?.querySelector('.button')?.title || 'Select Color';
}

function range(label, className, min, max, step) {
    const input = node('input', className);
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.setAttribute('aria-label', label);
    input.setAttribute('data-i18n', `[aria-label]${label}`);
    return input;
}

function buildMenu(picker, button) {
    const menu = node('div', 'sb-color-picker-menu');
    menu.id = MENU_ID;
    menu.setAttribute('role', 'dialog');
    menu.setAttribute('aria-labelledby', `${MENU_ID}-title`);
    const header = node('div', 'sb-color-picker-header');
    const title = node('h2', 'sb-color-picker-title', pickerLabel(picker));
    title.id = `${MENU_ID}-title`;
    const close = node('button', 'sb-color-picker-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.setAttribute('data-i18n', '[aria-label]Close');
    close.addEventListener('click', () => closeColorMenu());
    header.append(title, close);

    const body = node('div', 'sb-color-picker-body');
    const plane = node('div', 'sb-color-picker-plane');
    const cursor = node('span', 'sb-color-picker-cursor');
    cursor.setAttribute('aria-hidden', 'true');
    const saturation = range('Saturation', 'sb-color-picker-axis', 0, 100, 1);
    const brightness = range('Brightness', 'sb-color-picker-axis', 0, 100, 1);
    plane.append(cursor, saturation, brightness);
    const hue = range('Hue', 'sb-color-picker-hue', 0, 360, 1);
    const alpha = range('Opacity', 'sb-color-picker-alpha', 0, 1, 0.01);
    for (const [label, control] of [['Hue', hue], ['Opacity', alpha]]) {
        const row = node('label', 'sb-color-picker-bar');
        const text = node('span', '', label);
        text.setAttribute('data-i18n', label);
        row.append(text, control);
        body.append(row);
    }
    body.prepend(plane);

    const preview = node('div', 'sb-color-picker-preview');
    const swatch = node('span', 'sb-color-picker-current');
    swatch.setAttribute('aria-hidden', 'true');
    const value = node('output', 'sb-color-picker-preview-value');
    preview.append(swatch, value);
    body.append(preview);

    const fields = node('div', 'sb-color-picker-fields');
    const inputs = {};
    for (const [key, label] of [['hex', 'Hex'], ['r', 'R'], ['g', 'G'], ['b', 'B'], ['a', 'A']]) {
        const field = node('label', 'sb-color-picker-field');
        field.dataset.colorField = key;
        const input = node('input', '');
        input.dataset.colorField = key;
        input.type = key === 'hex' ? 'text' : 'number';
        if (key === 'hex') {
            input.spellcheck = false;
            input.autocomplete = 'off';
            input.maxLength = 9;
        } else {
            input.min = '0';
            input.max = key === 'a' ? '1' : '255';
            input.step = key === 'a' ? 'any' : '1';
            input.inputMode = key === 'a' ? 'decimal' : 'numeric';
        }
        field.append(node('span', '', label), input);
        fields.append(field);
        inputs[key] = input;
    }
    body.append(fields);
    menu.append(header, body);
    blockUpstreamDrawerClose(menu);
    return {
        picker, button, menu, title, body, plane, cursor, saturation, brightness, hue, alpha,
        value, inputs, hsv: picker.color.toHsv(), writing: false, sheet: null,
        hexPending: false, hexAlpha: picker.color.toRgb().a, finalizeHex: null,
    };
}

function render(state) {
    const rgb = state.picker.color.toRgb();
    const hsv = state.hsv;
    state.menu.style.setProperty('--sb-picker-hue', String(hsv.h));
    state.menu.style.setProperty('--sb-picker-rgb', `${rgb.r} ${rgb.g} ${rgb.b}`);
    state.menu.style.setProperty('--sb-picker-color', state.picker.rgba);
    state.cursor.style.left = `${hsv.s * 100}%`;
    state.cursor.style.top = `${(1 - hsv.v) * 100}%`;
    state.saturation.value = String(hsv.s * 100);
    state.brightness.value = String(hsv.v * 100);
    state.hue.value = String(hsv.h);
    state.alpha.value = String(rgb.a);
    state.alpha.setAttribute('aria-valuetext', `${Math.round(rgb.a * 100)}%`);
    state.value.textContent = state.picker.rgba;
    const values = { hex: state.picker.hex, r: rgb.r, g: rgb.g, b: rgb.b, a: rgb.a };
    for (const [key, input] of Object.entries(state.inputs)) {
        if (document.activeElement !== input) input.value = String(values[key]);
    }
}

function commit(state, color, hsv = null) {
    // The vendor setter emits every supported format, including RGB for Quick Reply consumers.
    state.writing = true;
    try {
        state.picker.color = color;
    } finally {
        state.writing = false;
    }
    // Preserve a selected hue at zero saturation/brightness, where an RGB round trip loses it.
    state.hsv = hsv ?? state.picker.color.toHsv();
    render(state);
}

function commitHsv(state, patch) {
    const hsv = { ...state.hsv, ...patch };
    commit(state, `hsva(${hsv.h}, ${hsv.s * 100}%, ${hsv.v * 100}%, ${hsv.a})`, hsv);
}

function bindControls(state) {
    state.hue.addEventListener('input', () => commitHsv(state, { h: Number(state.hue.value) }));
    state.alpha.addEventListener('input', () => commitHsv(state, { a: Number(state.alpha.value) }));
    state.saturation.addEventListener('input', () => commitHsv(state, { s: Number(state.saturation.value) / 100 }));
    state.brightness.addEventListener('input', () => commitHsv(state, { v: Number(state.brightness.value) / 100 }));
    for (const [key, input] of Object.entries(state.inputs)) {
        if (key === 'hex') {
            input.addEventListener('focus', () => { state.hexAlpha = state.picker.color.toRgb().a; });
        }
        const applyInput = (finalize = false) => {
            const rgb = state.picker.color.toRgb();
            const color = key === 'hex' ? parsePickerHex(input.value, state.hexAlpha) : null;
            const number = Number(input.value);
            const valid = key === 'hex' ? color !== null
                : input.value.trim() !== '' && Number.isFinite(number) && input.validity.valid;
            input.setAttribute('aria-invalid', String(!valid));
            if (!valid) return;
            if (key === 'hex') {
                // Short hex is ambiguous while typing a six/eight-digit value; accept it on commit.
                const length = input.value.trim().replace(/^#/, '').length;
                if (!finalize && length <= 4) return;
                state.hexPending = false;
                commit(state, color);
                return;
            }
            rgb[key] = number;
            commit(state, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${rgb.a})`);
        };
        if (key === 'hex') {
            state.finalizeHex = () => {
                if (state.hexPending) applyInput(true);
                state.hexPending = false;
                state.hexAlpha = state.picker.color.toRgb().a;
            };
        }
        input.addEventListener('input', () => {
            if (key === 'hex') state.hexPending = true;
            applyInput();
        });
        input.addEventListener('keydown', event => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            event.stopPropagation();
            if (key === 'hex') state.finalizeHex();
            else applyInput(true);
        });
        input.addEventListener('blur', () => {
            if (key === 'hex' && active === state) state.finalizeHex();
            input.removeAttribute('aria-invalid');
            render(state);
        });
    }

    let pointerId = null;
    const updatePlane = event => {
        const rect = state.plane.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        commitHsv(state, {
            s: clamp((event.clientX - rect.left) / rect.width, 0, 1),
            v: 1 - clamp((event.clientY - rect.top) / rect.height, 0, 1),
        });
    };
    state.plane.addEventListener('pointerdown', event => {
        if (!event.isPrimary || event.button !== 0) return;
        event.preventDefault();
        pointerId = event.pointerId;
        state.plane.setPointerCapture(pointerId);
        state.saturation.focus({ preventScroll: true });
        updatePlane(event);
    });
    state.plane.addEventListener('pointermove', event => {
        if (event.pointerId === pointerId) updatePlane(event);
    });
    state.plane.addEventListener('lostpointercapture', () => { pointerId = null; });
    state.plane.addEventListener('pointerup', event => {
        if (event.pointerId !== pointerId) return;
        state.plane.releasePointerCapture(pointerId);
        pointerId = null;
    });
    state.menu.addEventListener('keydown', event => {
        if (event.key === 'Tab' && state.sheet) {
            const controls = [...state.menu.querySelectorAll('button, input')];
            const first = controls[0];
            const last = controls.at(-1);
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
            return;
        }
        if (event.key !== 'Escape' || event.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        closeColorMenu({ commitPending: false });
    });
    state.menu.addEventListener('focusout', event => {
        if (state.menu.contains(event.relatedTarget) || event.relatedTarget === state.picker) return;
        queueMicrotask(() => {
            if (active !== state || state.sheet) return;
            if (!state.menu.contains(document.activeElement) && document.activeElement !== state.picker) {
                closeColorMenu({ restoreFocus: false });
            }
        });
    });
    state.menu.addEventListener('focusin', () => revealFocusedControl(state));
}

function revealFocusedControl(state) {
    requestAnimationFrame(() => {
        const focused = document.activeElement;
        if (active !== state || !state.body.contains(focused)) return;
        const bounds = state.body.getBoundingClientRect();
        const rect = focused.getBoundingClientRect();
        if (rect.top < bounds.top) state.body.scrollTop -= bounds.top - rect.top + GAP;
        else if (rect.bottom > bounds.bottom) state.body.scrollTop += rect.bottom - bounds.bottom + GAP;
    });
}

function syncPlacement() {
    if (!active) return;
    const state = active;
    if (!state.picker.isConnected || !state.button.getClientRects().length
        || Boolean(state.sheet) !== window.matchMedia('(max-width: 768px)').matches) {
        closeColorMenu();
        return;
    }
    const bounds = viewportBounds();
    const height = Math.max(0, bounds.bottom - bounds.top - MARGIN * 2);
    if (state.sheet) {
        state.sheet.style.maxBlockSize = `${height}px`;
        state.sheet.style.bottom = `${Math.max(0, window.innerHeight - bounds.bottom)}px`;
        revealFocusedControl(state);
        return;
    }
    state.menu.style.maxBlockSize = `${height}px`;
    state.menu.style.maxInlineSize = `${Math.max(0, bounds.right - bounds.left - MARGIN * 2)}px`;
    const rect = state.menu.getBoundingClientRect();
    const position = positionColorMenu(state.button.getBoundingClientRect(), rect, bounds);
    state.menu.style.left = `${Math.round(position.left)}px`;
    state.menu.style.top = `${Math.round(position.top)}px`;
    revealFocusedControl(state);
}

function openColorMenu(picker, button) {
    if (active?.picker === picker) {
        closeColorMenu();
        return;
    }
    closeColorMenu({ restoreFocus: false });
    picker.opened = false;
    const state = buildMenu(picker, button);
    active = state;
    bindControls(state);
    render(state);
    button.setAttribute('aria-expanded', 'true');
    if (window.matchMedia('(max-width: 768px)').matches) {
        const sheet = node('dialog', 'sb-color-picker-sheet');
        sheet.setAttribute('aria-labelledby', state.title.id);
        state.menu.removeAttribute('role');
        state.menu.removeAttribute('aria-labelledby');
        sheet.append(state.menu);
        state.sheet = sheet;
        document.body.append(sheet);
        sheet.addEventListener('cancel', event => {
            event.preventDefault();
            closeColorMenu({ commitPending: false });
        });
        sheet.addEventListener('close', () => {
            if (active === state) closeColorMenu();
        });
        sheet.addEventListener('click', event => {
            if (event.target !== sheet) return;
            const rect = sheet.getBoundingClientRect();
            if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) {
                closeColorMenu();
            }
        });
        sheet.showModal();
        syncPlacement();
        animateIn(sheet, [{ transform: 'translateY(100%)' }, { transform: 'none' }], SPRING_SHEET);
    } else {
        // Popover's top layer escapes clipped cards. WebKit 16.4 falls back inside any open modal.
        const root = picker.closest('dialog[open]') ?? document.body;
        root.append(state.menu);
        if (typeof state.menu.showPopover === 'function') {
            state.menu.setAttribute('popover', 'manual');
            state.menu.showPopover();
        }
        syncPlacement();
        animateIn(state.menu, [{ opacity: 0 }, { opacity: 1 }], { duration: MOTION_FAST });
    }
    (state.sheet ? state.menu.querySelector('.sb-color-picker-close') : state.inputs.hex).focus({ preventScroll: true });
}

function closeColorMenu({ restoreFocus = true, commitPending = true } = {}) {
    const state = active;
    if (!state) return;
    if (commitPending) state.finalizeHex();
    active = null;
    state.button.setAttribute('aria-expanded', 'false');
    state.sheet?.close();
    (state.sheet ?? state.menu).remove();
    if (restoreFocus && state.button.isConnected && state.button.getClientRects().length) {
        state.button.focus({ preventScroll: true });
    }
}

function enhancePicker(picker) {
    const button = picker.shadowRoot?.querySelector('.button');
    if (!button) return;
    if (active?.picker === picker && active.button !== button) {
        active.button = button;
        active.hsv = picker.color.toHsv();
        render(active);
        syncPlacement();
    }
    button.setAttribute('aria-label', pickerLabel(picker));
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-expanded', String(active?.picker === picker));
    if (!picker.shadowRoot.querySelector('[data-sb-color-picker-style]')) {
        const style = document.createElement('style');
        style.dataset.sbColorPickerStyle = '';
        style.textContent = `
            .button { position: relative; width: 52px !important; height: 40px !important;
                padding: 6px !important; border: 0; border-radius: var(--sb-radius-control, 9px);
                background: var(--sb-raised-bg); touch-action: manipulation; }
            .button::before { content: ''; position: absolute; inset: 6px; border-radius: 4px;
                background: repeating-conic-gradient(var(--sb-layer-window) 0% 25%,
                    var(--sb-layer-popover) 0% 50%) 0 / 8px 8px; }
            .button-color { position: relative; border: 1px solid var(--sb-shell-border); border-radius: 4px; }
            .button:focus-visible { outline: none; box-shadow: var(--sb-focus-ring-inset); }
            .button:active, .button[aria-expanded='true'] { background: var(--sb-raised-active-bg); }
            @media (hover: hover) { .button:hover { background: var(--sb-raised-hover-bg); } }
            @media (pointer: coarse) { .button { height: 44px !important; } }
        `;
        picker.shadowRoot.append(style);
    }
    if (bindings.has(picker)) return;
    const activate = event => {
        if (!event.composedPath().some(element => element instanceof Element && element.matches('.button'))) return;
        if (event.type === 'keydown' && !['Enter', ' '].includes(event.key)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        openColorMenu(picker, picker.shadowRoot.querySelector('.button'));
    };
    picker.addEventListener('click', activate, true);
    picker.addEventListener('keydown', activate, true);
    picker.addEventListener('change', () => {
        if (active?.picker !== picker || active.writing) return;
        if (!active.hexPending) {
            active.inputs.hex.value = picker.hex;
            active.hexAlpha = picker.color.toRgb().a;
        }
        active.hsv = picker.color.toHsv();
        render(active);
    });
    bindings.set(picker, true);
}

function enhanceWithin(root) {
    if (!(root instanceof Element)) return;
    if (root.matches(PICKER_SELECTOR)) enhancePicker(root);
    for (const picker of root.querySelectorAll(PICKER_SELECTOR)) enhancePicker(picker);
}

export function initializeColorPickers() {
    initialization ??= customElements.whenDefined(PICKER_SELECTOR).then(() => {
        enhanceWithin(document.body);
        const observer = new MutationObserver(mutations => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) enhanceWithin(node);
            }
            if (active && !active.picker.isConnected) closeColorMenu({ restoreFocus: false, commitPending: false });
        });
        observer.observe(document.body, { childList: true, subtree: true });
        document.addEventListener('pointerdown', event => {
            if (!active || active.sheet) return;
            const path = event.composedPath();
            if (!path.includes(active.menu) && !path.includes(active.picker)) closeColorMenu({ restoreFocus: false });
        }, true);
        document.addEventListener('scroll', event => {
            if (active && !active.sheet && !active.menu.contains(event.target)) closeColorMenu({ restoreFocus: false });
        }, true);
        window.addEventListener('resize', syncPlacement);
        window.visualViewport?.addEventListener('resize', syncPlacement);
        window.visualViewport?.addEventListener('scroll', syncPlacement);
    });
    return initialization;
}
