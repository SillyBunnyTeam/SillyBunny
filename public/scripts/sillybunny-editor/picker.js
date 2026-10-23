import { t } from '../i18n.js';
import { MOBILE_QUERY, positionPopover } from '../sillybunny-action-menu.js';
import { animateIn, animateOut, stopMotion, MOTION_FAST, MOTION_POPOVER_CLOSE, MOTION_EASE_OUT_CUBIC } from '../sillybunny-motion.js';
import { blockUpstreamDrawerClose, createSheetController } from '../sillybunny-sheet.js';

let activePicker = null;
let pickerId = 0;
let mobileFrame = null;

function createId(prefix) {
    pickerId += 1;
    return `${prefix}-${pickerId}`;
}

function createIcon(icon, fallback = 'fa-solid fa-puzzle-piece') {
    if (icon instanceof Element) {
        const clone = /** @type {Element} */ (icon.cloneNode(true));
        clone.removeAttribute('id');
        clone.setAttribute('aria-hidden', 'true');
        return clone;
    }
    const element = document.createElement('i');
    element.className = icon || fallback;
    element.setAttribute('aria-hidden', 'true');
    return element;
}

function isMobileLayout() {
    return window.matchMedia(MOBILE_QUERY).matches;
}

function setTriggerExpanded(trigger, expanded) {
    trigger.setAttribute('aria-haspopup', 'dialog');
    trigger.setAttribute('aria-expanded', String(expanded));
    if (expanded) {
        return;
    }
    trigger.removeAttribute('aria-controls');
}

function createSheetFrame() {
    if (mobileFrame) {
        if (!mobileFrame.element.isConnected) {
            document.body.append(mobileFrame.backdrop, mobileFrame.element);
        }
        return mobileFrame;
    }

    const backdrop = document.createElement('button');
    backdrop.type = 'button';
    backdrop.className = 'sb-action-sheet-backdrop';
    backdrop.tabIndex = -1;
    backdrop.hidden = true;
    backdrop.setAttribute('aria-label', t`Close`);

    const element = document.createElement('div');
    element.className = 'sb-action-sheet sb-picker-sheet';
    element.hidden = true;
    element.setAttribute('role', 'dialog');
    element.setAttribute('aria-modal', 'true');

    const header = document.createElement('div');
    header.className = 'sb-action-sheet-header';
    const heading = document.createElement('div');
    heading.className = 'sb-action-sheet-heading';
    const title = document.createElement('h2');
    title.className = 'sb-action-sheet-title';
    title.tabIndex = -1;
    heading.append(title);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'sb-action-sheet-close';
    close.title = t`Close`;
    close.setAttribute('aria-label', t`Close`);
    close.append(createIcon('fa-solid fa-xmark'));
    close.addEventListener('click', () => closePicker({ restoreFocus: true }));
    header.append(heading, close);

    const body = document.createElement('div');
    body.className = 'sb-action-sheet-body';
    element.append(header, body);
    document.body.append(backdrop, element);
    blockUpstreamDrawerClose(backdrop);
    blockUpstreamDrawerClose(element);

    const controller = createSheetController({
        sheet: element,
        backdrop,
        getInitialFocus: () => activePicker?.input ?? title,
        getReturnFocus: () => activePicker?.trigger?.isConnected ? activePicker.trigger : null,
        canAnimateClose: isMobileLayout,
        onClose: () => finishClose(),
    });
    mobileFrame = { backdrop, element, body, title, controller };
    return mobileFrame;
}

function createSeparator() {
    const separator = document.createElement('div');
    separator.className = 'sb-action-menu-separator sb-picker__separator';
    separator.setAttribute('role', 'separator');
    return separator;
}

function createOption(item, selected, id, onClick, { multiple = false, state = null } = {}) {
    const option = document.createElement('li');
    option.id = id;
    option.className = 'sb-picker__option';
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', String(selected));
    option.tabIndex = -1;
    if (item.disabled) {
        option.setAttribute('aria-disabled', 'true');
        option.classList.add('is-disabled');
    }
    if (multiple) {
        option.classList.toggle('is-muted', Boolean(item.muted));
        // Keep pointer activation from moving the combobox's virtual focus onto a replaced option.
        option.addEventListener('mousedown', event => event.preventDefault());
    }
    if (item.icon) {
        option.append(createIcon(item.icon));
    }

    const text = document.createElement('span');
    text.className = 'sb-picker__option-text';
    const label = document.createElement('span');
    label.className = 'sb-picker__label';
    label.textContent = item.label;
    text.append(label);
    if (item.subtitle) {
        const subtitle = document.createElement('span');
        subtitle.className = 'sb-picker__subtitle';
        subtitle.textContent = item.subtitle;
        text.append(subtitle);
    }
    option.append(text);
    if (selected) {
        const check = createIcon('fa-solid fa-check');
        check.classList.add('sb-picker__check');
        option.append(check);
    }
    if (multiple && state === 'excluded') {
        const minus = createIcon('fa-solid fa-minus');
        minus.classList.add('sb-picker__check', 'sb-picker__excluded');
        const label = document.createElement('span');
        label.className = 'sr-only';
        label.textContent = t`Not selected.`;
        option.append(minus, label);
    }
    option.addEventListener('click', onClick);
    return option;
}

function buildPickerContent(state, body) {
    const input = document.createElement('input');
    input.type = 'search';
    input.className = 'sb-picker__search';
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-label', state.searchLabel);
    input.placeholder = state.searchLabel;
    input.id = createId('sb-picker-search');

    const list = document.createElement('ul');
    list.className = 'sb-picker__list';
    list.setAttribute('role', 'listbox');
    if (state.multiple) list.setAttribute('aria-multiselectable', 'true');
    list.id = createId('sb-picker-list');
    list.setAttribute('aria-label', state.title);
    input.setAttribute('aria-controls', list.id);
    body.replaceChildren(input, list);
    state.input = input;
    state.list = list;

    const footer = document.createElement('div');
    footer.className = 'sb-picker__footer';
    state.footer.forEach((item, index) => {
        if (index === 0) {
            body.append(createSeparator());
        }
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'sb-action-menu-item sb-picker__footer-item';
        button.append(createIcon(item.icon), Object.assign(document.createElement('span'), {
            className: 'sb-action-menu-label',
            textContent: item.label,
        }));
        button.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            closePicker({ restoreFocus: true });
            item.onSelect?.();
        });
        footer.append(button);
    });
    if (state.footer.length) {
        body.append(footer);
    }
}

/** Groups items by their `group` label in first-appearance order; ungrouped items form their own bucket. */
function groupBuckets(items) {
    const buckets = new Map();
    for (const item of items) {
        const key = item.group || null;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(item);
    }
    return [...buckets];
}

function createGroup(label, options) {
    const wrapper = document.createElement('li');
    wrapper.className = 'sb-picker__group-item';
    wrapper.setAttribute('role', 'presentation');
    const heading = document.createElement('div');
    heading.className = 'sb-picker__group-heading';
    heading.setAttribute('role', 'presentation');
    heading.id = createId('sb-picker-group');
    heading.textContent = label;
    const group = document.createElement('ul');
    group.className = 'sb-picker__group';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-labelledby', heading.id);
    group.append(...options);
    wrapper.append(heading, group);
    return wrapper;
}

function renderOptions(state) {
    clearTimeout(state.searchTimer);
    state.searchTimer = 0;
    const listScrollTop = state.list.scrollTop;
    const surfaceScrollTop = state.surface?.scrollTop ?? 0;
    const query = state.input.value.toLocaleLowerCase();
    const matches = state.items.filter(item => {
        const haystack = `${item.label} ${item.subtitle ?? ''} ${item.group ?? ''}`.toLocaleLowerCase();
        return !query || haystack.includes(query);
    });
    const grouped = state.items.some(item => item.group);
    const buckets = grouped ? groupBuckets(matches) : [[null, matches]];
    // Keyboard order follows the grouped visual order.
    state.filtered = buckets.flatMap(([, items]) => items);
    state.activeIndex = state.filtered.length
        ? Math.max(0, Math.min(state.activeIndex, state.filtered.length - 1))
        : -1;
    state.list.replaceChildren();

    if (!state.filtered.length) {
        const empty = document.createElement('li');
        empty.className = 'sb-picker__empty';
        empty.setAttribute('role', 'presentation');
        empty.textContent = state.emptyText;
        state.list.append(empty);
        state.input.removeAttribute('aria-activedescendant');
        return;
    }

    let index = 0;
    for (const [label, items] of buckets) {
        const options = items.map(item => {
            const itemState = state.multiple ? state.getItemState?.(item.value) : null;
            const selected = state.multiple ? itemState === 'selected' : Object.is(item.value, state.selected);
            const option = createOption(item, selected, createId('sb-picker-option'), () => {
                selectPickerItem(state, item.value);
            }, { multiple: state.multiple, state: itemState });
            option.classList.toggle('is-active', index === state.activeIndex);
            index += 1;
            return option;
        });
        if (label === null) state.list.append(...options);
        else state.list.append(createGroup(label, options));
    }
    const active = state.list.querySelectorAll('.sb-picker__option')[state.activeIndex];
    if (active) {
        state.input.setAttribute('aria-activedescendant', active.id);
    }
    if (state.multiple) {
        state.list.scrollTop = listScrollTop;
        if (state.surface) state.surface.scrollTop = surfaceScrollTop;
    }
}

function selectPickerItem(state, value) {
    if (activePicker !== state) {
        return;
    }
    if (state.items.find(item => Object.is(item.value, value))?.disabled) {
        return;
    }
    try {
        state.onSelect?.(value);
    } finally {
        if (activePicker === state) {
            if (state.multiple) renderOptions(state);
            else closePicker({ restoreFocus: true });
        }
    }
}

function updateActiveOption(state, nextIndex) {
    if (!state.filtered.length) {
        return;
    }
    state.activeIndex = Math.max(0, Math.min(nextIndex, state.filtered.length - 1));
    const options = [...state.list.querySelectorAll('.sb-picker__option')];
    options.forEach((option, index) => option.classList.toggle('is-active', index === state.activeIndex));
    const active = options[state.activeIndex];
    if (!active) {
        state.input.removeAttribute('aria-activedescendant');
        return;
    }
    state.input.setAttribute('aria-activedescendant', active.id);
    active.scrollIntoView?.({ block: 'nearest' });
}

function handlePickerKeydown(event) {
    const state = activePicker;
    if (!state || event.isComposing) {
        return;
    }
    if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closePicker({ restoreFocus: true });
        return;
    }
    if (event.target !== state.input) {
        return;
    }
    if (state.searchTimer && ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter'].includes(event.key)) {
        applyPickerSearch(state);
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        event.stopPropagation();
        const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
        const next = event.key === 'Home' ? 0
            : event.key === 'End' ? state.filtered.length - 1
                : state.activeIndex + step;
        updateActiveOption(state, next);
        return;
    }
    if (event.key === 'Enter' && state.filtered[state.activeIndex]) {
        event.preventDefault();
        event.stopPropagation();
        selectPickerItem(state, state.filtered[state.activeIndex].value);
    }
}

function applyPickerSearch(state) {
    if (activePicker !== state) return;
    state.activeIndex = 0;
    renderOptions(state);
    handleResize();
}

function handlePickerInput(event) {
    const state = activePicker;
    if (state?.input !== event.currentTarget) return;
    clearTimeout(state.searchTimer);
    if (!state.input.value) {
        applyPickerSearch(state);
        return;
    }
    state.searchTimer = setTimeout(() => applyPickerSearch(state), 300);
}

/** A press on the owner itself, not on another control inside it (a row's menu button still dismisses). */
function isOwnerBackground(state, target) {
    if (!state.owner.contains(target)) return false;
    const control = target instanceof Element ? target : target.parentElement;
    const inner = control?.closest('button, a, input, select, textarea, [role="button"], [tabindex]');
    return !inner || !state.owner.contains(inner) || inner === state.owner;
}

function handleOutsidePointerDown(event) {
    const state = activePicker;
    if (!state || state.kind !== 'popover') {
        return;
    }
    const target = event.target instanceof Node ? event.target : null;
    if (target && isOwnerBackground(state, target)) {
        // Keep focus inside until the owner's click toggles us; a focusable ancestor otherwise closes us first.
        event.preventDefault();
        return;
    }
    if (target && (state.surface.contains(target) || state.trigger.contains(target))) {
        return;
    }
    closePicker();
}

function handleResize() {
    const state = activePicker;
    if (!state || state.kind !== 'popover') {
        return;
    }
    const scrollTop = state.surface.scrollTop;
    if (state.matchTriggerWidth) {
        const bounds = state.bounds?.getBoundingClientRect();
        const available = bounds?.width > 0
            ? Math.min(bounds.right, window.innerWidth) - Math.max(bounds.left, 0) - 16
            : window.innerWidth - 16;
        // Measured once with every option rendered, so filtering never resizes the popover.
        if (state.contentWidth === undefined) {
            state.surface.style.inlineSize = 'max-content';
            state.surface.style.maxInlineSize = 'none';
            // max-content leaves out the list's scrollbar, which would then push the widest label onto a second line.
            const list = state.surface.querySelector('.sb-picker__list');
            const scrollbar = list ? Math.max(0, list.offsetWidth - list.clientWidth) : 0;
            // scrollWidth leaves out the borders, which border-box sizing counts; the box width includes them.
            const box = state.surface.getBoundingClientRect().width || 0;
            state.contentWidth = Math.ceil(Math.max(box, state.surface.scrollWidth || 0) + scrollbar);
        }
        const wanted = Math.max(320, state.trigger.getBoundingClientRect().width, state.contentWidth);
        const width = Math.max(0, Math.min(560, wanted, available));
        state.surface.style.inlineSize = `${width}px`;
        state.surface.style.maxInlineSize = `${width}px`;
        state.origin = positionPopover(state.surface, state.trigger, null, state.bounds, 'start');
    } else {
        state.origin = positionPopover(state.surface, state.trigger, null, state.bounds);
    }
    state.surface.style.transformOrigin = state.origin;
    if (state.multiple) state.surface.scrollTop = scrollTop;
}

function finishClose() {
    const state = activePicker;
    if (!state) {
        return;
    }
    activePicker = null;
    clearTimeout(state.searchTimer);
    state.removeContentListeners?.();
    window.removeEventListener('resize', handleResize);
    document.removeEventListener('pointerdown', handleOutsidePointerDown, true);
    state.input.setAttribute('aria-expanded', 'false');
    setTriggerExpanded(state.trigger, false);
    if (state.restoreFocus && state.trigger.isConnected) {
        state.trigger.focus({ preventScroll: true });
    }
    state.onClose?.();
}

/**
 * Opens a searchable value picker. Opening it again from the same trigger toggles it closed.
 * @param {object} options
 * @param {HTMLElement} options.trigger
 * @param {string} options.title
 * @param {{ value: unknown, label: string, subtitle?: string, group?: string, disabled?: boolean, icon?: string|Element, muted?: boolean }[]} options.items
 *     Items with a `group` render under that heading, groups in first-appearance order; search also matches it.
 * @param {unknown} [options.selected=null]
 * @param {boolean} [options.multiple=false] Toggle values without closing or changing search focus.
 * @param {(value: unknown) => 'selected'|'excluded'|null} [options.getItemState=null]
 * @param {(value: unknown) => void} options.onSelect
 * @param {{ label: string, icon?: string|Element, onSelect: () => void }[]} [options.footer=[]]
 * @param {string} [options.searchLabel]
 * @param {string} [options.emptyText]
 * @param {Element|null} [options.bounds=null]
 * @param {boolean} [options.matchTriggerWidth=false] Desktop: match the trigger up to 560px and align inline-start.
 * @param {boolean} [options.renderAsPopover=false] Keep a nested picker in the current modal on mobile.
 * @param {() => void|null} [options.onClose=null]
 * @param {HTMLElement|null} [options.owner=null] Element around the trigger (such as its row) whose presses
 *     do not dismiss the popover, so the owner can toggle it closed itself.
 * @returns {{ close: () => void, refresh: (items?: object[]) => void, readonly isOpen: boolean }}
 */
export function openPicker({
    trigger,
    title,
    items,
    selected = null,
    multiple = false,
    getItemState = null,
    onSelect,
    footer = [],
    searchLabel = t`Search`,
    emptyText = t`No results`,
    bounds = null,
    matchTriggerWidth = false,
    renderAsPopover = false,
    onClose = null,
    owner = null,
}) {
    if (!(trigger instanceof HTMLElement) || !Array.isArray(items) || !Array.isArray(footer) || typeof onSelect !== 'function') {
        throw new TypeError('openPicker requires a trigger, items, footer actions, and an onSelect callback');
    }
    if (activePicker?.trigger === trigger) {
        closePicker({ restoreFocus: true });
        return { close: () => {}, refresh: () => {}, get isOpen() { return false; } };
    }
    closePicker({ animate: false, restoreFocus: false });

    const state = {
        trigger,
        owner: owner instanceof HTMLElement ? owner : trigger,
        title,
        items: [...items],
        selected,
        multiple,
        getItemState,
        onSelect,
        footer: [...footer],
        searchLabel,
        emptyText,
        bounds,
        matchTriggerWidth,
        onClose,
        restoreFocus: true,
        input: null,
        list: null,
        filtered: [],
        activeIndex: 0,
        searchTimer: 0,
        surface: null,
        kind: renderAsPopover || !isMobileLayout() ? 'popover' : 'sheet',
    };
    setTriggerExpanded(trigger, true);

    if (state.kind === 'sheet') {
        const frame = createSheetFrame();
        frame.title.textContent = title;
        frame.element.setAttribute('aria-labelledby', frame.title.id || (frame.title.id = createId('sb-picker-title')));
        buildPickerContent(state, frame.body);
        frame.element.addEventListener('keydown', handlePickerKeydown, true);
        state.input.addEventListener('input', handlePickerInput);
        state.surface = frame.element;
        state.removeContentListeners = () => {
            frame.element.removeEventListener('keydown', handlePickerKeydown, true);
            state.input.removeEventListener('input', handlePickerInput);
        };
        activePicker = state;
        renderOptions(state);
        frame.controller.open();
    } else {
        const popover = document.createElement('div');
        popover.className = 'sb-action-popover sb-picker';
        if (multiple) popover.classList.add('sb-picker--multiple');
        popover.tabIndex = -1;
        popover.setAttribute('role', 'dialog');
        popover.setAttribute('aria-label', title);
        popover.style.width = 'min(320px, calc(100vw - 16px))';
        buildPickerContent(state, popover);
        popover.addEventListener('keydown', handlePickerKeydown);
        popover.addEventListener('focusout', handlePopoverFocusOut);
        state.input.addEventListener('input', handlePickerInput);
        blockUpstreamDrawerClose(popover);
        document.body.append(popover);
        state.surface = popover;
        state.removeContentListeners = () => {
            popover.removeEventListener('keydown', handlePickerKeydown);
            popover.removeEventListener('focusout', handlePopoverFocusOut);
            state.input.removeEventListener('input', handlePickerInput);
        };
        activePicker = state;
        renderOptions(state);
        handleResize();
        animateIn(popover, [{ opacity: 0, transform: 'scale(0.96)' }, { opacity: 1, transform: 'none' }], {
            duration: MOTION_FAST,
            easing: MOTION_EASE_OUT_CUBIC,
            styles: { 'transform-origin': state.origin },
        });
        window.addEventListener('resize', handleResize, { passive: true });
        document.addEventListener('pointerdown', handleOutsidePointerDown, true);
        requestAnimationFrame(() => {
            if (activePicker === state) {
                state.input.focus({ preventScroll: true });
            }
        });
    }
    state.surface.id ||= createId('sb-picker-dialog');
    trigger.setAttribute('aria-controls', state.surface.id);
    return {
        close: () => {
            if (activePicker === state) {
                closePicker({ restoreFocus: true });
            }
        },
        refresh: (items = state.items) => {
            if (activePicker !== state) return;
            if (!Array.isArray(items)) throw new TypeError('Picker items must be an array.');
            state.items = [...items];
            renderOptions(state);
            handleResize();
        },
        get isOpen() { return activePicker === state; },
    };
}

/** Keyboard focus leaving the desktop popover dismisses it without pulling focus back. */
function handlePopoverFocusOut(event) {
    const state = activePicker;
    if (!state || state.kind === 'sheet') return;
    const next = event.relatedTarget;
    if (next instanceof Node && (state.surface.contains(next) || state.trigger.contains(next))) return;
    if (!(next instanceof Node)) return;
    closePicker({ restoreFocus: false });
}

export function closePicker({ animate = true, restoreFocus = true } = {}) {
    const state = activePicker;
    if (!state) {
        return;
    }
    state.restoreFocus = restoreFocus;
    if (state.kind === 'sheet') {
        mobileFrame?.controller.close({ animate, restoreFocus });
        return;
    }
    finishClose();
    stopMotion(state.surface);
    const surface = state.surface;
    const motion = animateOut(surface, [{ opacity: 1 }, { opacity: 0 }], () => {
        surface.hidden = true;
    }, {
        enabled: animate,
        duration: MOTION_POPOVER_CLOSE,
        onEnd: () => surface.remove(),
    });
    if (!motion) {
        surface.remove();
    }
}

export function isPickerOpen(trigger = null) {
    return Boolean(activePicker) && (!trigger || activePicker.trigger === trigger);
}
