/*
 * Labelled message menu shared by Roleplay and Conversation message actions.
 * Desktop: a popover anchored to its trigger (or a pointer position).
 * Mobile (<=768px): a bottom sheet built on sillybunny-sheet.js.
 * Callers pass sections of rows; each row's onSelect runs after the menu has closed.
 */

import { translate } from './i18n.js';
import { MOTION_EASE_OUT_CUBIC, MOTION_FAST, MOTION_POPOVER_CLOSE, animateIn, animateOut, stopMotion } from './sillybunny-motion.js';
import { blockUpstreamDrawerClose, createSheetController } from './sillybunny-sheet.js';

export const MOBILE_QUERY = '(max-width: 768px)';
const POPOVER_GAP = 6;
const POPOVER_MARGIN = 8;
const POPOVER_MIN_HEIGHT = 120;
const SHEET_TITLE_ID = 'sb-action-sheet-title';
const MENU_ID = 'sb-action-menu';
const ITEM_SELECTOR = '[role^="menuitem"]:not([aria-disabled="true"])';

/**
 * @typedef {object} ActionMenuItem
 * @property {string} label
 * @property {string|Element} [icon] - Font Awesome classes, or an element to clone.
 * @property {string} [detail] - Secondary text after the label.
 * @property {string} [title] - Tooltip for the row.
 * @property {boolean} [danger]
 * @property {boolean} [disabled]
 * @property {(event: MouseEvent) => void} onSelect
 */

/**
 * @typedef {object} ActionMenuReaction
 * @property {string} text
 * @property {string} [label]
 * @property {boolean} [pressed]
 * @property {(event: MouseEvent) => void} onSelect
 */

/** @typedef {{ items: ActionMenuItem[] } | { reactions: ActionMenuReaction[] }} ActionMenuSection */

let mobileQuery = null;
let sheet = null;
let open = null;
let initialized = false;

function isMobileLayout() {
    mobileQuery ??= window.matchMedia(MOBILE_QUERY);
    return mobileQuery.matches;
}

function createIcon(icon) {
    if (icon instanceof Element) {
        const clone = /** @type {Element} */ (icon.cloneNode(true));
        clone.setAttribute('aria-hidden', 'true');
        clone.removeAttribute('id');
        return clone;
    }
    const element = document.createElement('i');
    element.className = icon || 'fa-solid fa-puzzle-piece';
    element.setAttribute('aria-hidden', 'true');
    return element;
}

function createSeparator() {
    const separator = document.createElement('div');
    separator.className = 'sb-action-menu-separator';
    separator.setAttribute('role', 'separator');
    return separator;
}

/** @param {ActionMenuSection[]} sections */
function buildMenu(sections, label) {
    const menu = document.createElement('div');
    menu.className = 'sb-action-menu';
    menu.id = MENU_ID;
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', label);

    const populated = sections.filter(section => ('reactions' in section ? section.reactions : section.items).length);
    populated.forEach((section, index) => {
        if (index > 0) {
            menu.append(createSeparator());
        }
        if ('reactions' in section) {
            const group = document.createElement('div');
            group.className = 'sb-action-menu-reactions';
            group.setAttribute('role', 'group');
            for (const reaction of section.reactions) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'sb-action-menu-reaction';
                button.setAttribute('role', 'menuitemcheckbox');
                button.setAttribute('aria-checked', String(Boolean(reaction.pressed)));
                if (reaction.label) {
                    button.setAttribute('aria-label', reaction.label);
                }
                button.textContent = reaction.text;
                button.addEventListener('click', event => activate(event, reaction.onSelect));
                group.append(button);
            }
            menu.append(group);
            return;
        }
        for (const item of section.items) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'sb-action-menu-item';
            button.classList.toggle('is-danger', Boolean(item.danger));
            button.setAttribute('role', 'menuitem');
            if (item.title && item.title !== item.label) {
                button.title = item.title;
            }
            if (item.disabled) {
                button.setAttribute('aria-disabled', 'true');
            }
            const text = document.createElement('span');
            text.className = 'sb-action-menu-label';
            text.textContent = item.label;
            button.append(createIcon(item.icon), text);
            if (item.detail) {
                const detail = document.createElement('span');
                detail.className = 'sb-action-menu-detail';
                detail.textContent = item.detail;
                button.append(detail);
            }
            button.addEventListener('click', event => {
                if (!item.disabled) {
                    activate(event, item.onSelect);
                }
            });
            menu.append(button);
        }
    });
    menu.addEventListener('keydown', handleMenuKeydown);
    return menu;
}

function activate(event, onSelect) {
    event.preventDefault();
    event.stopPropagation();
    // Close first so focus returns to the trigger before the action moves it (popups, editors).
    closeActionMenu({ restoreFocus: true });
    onSelect(event);
}

function getItems() {
    return open ? Array.from(/** @type {NodeListOf<HTMLElement>} */ (open.menu.querySelectorAll(ITEM_SELECTOR))) : [];
}

function handleMenuKeydown(event) {
    const items = getItems();
    if (!items.length) {
        return;
    }
    const current = /** @type {HTMLElement} */ (document.activeElement);
    const index = items.indexOf(current);
    const inReactions = current?.classList.contains('sb-action-menu-reaction');
    let next = -1;
    switch (event.key) {
        case 'ArrowDown':
        case 'ArrowUp': {
            // The reaction row is one stop for vertical movement; Left and Right move inside it.
            const stops = items.filter(item => !item.classList.contains('sb-action-menu-reaction') || !item.previousElementSibling);
            const stopIndex = stops.indexOf(inReactions ? /** @type {HTMLElement} */ (current.parentElement.firstElementChild) : current);
            const step = event.key === 'ArrowDown' ? 1 : -1;
            const target = stopIndex < 0
                ? stops[step > 0 ? 0 : stops.length - 1]
                : stops[(stopIndex + step + stops.length) % stops.length];
            next = items.indexOf(target);
            break;
        }
        case 'ArrowLeft':
        case 'ArrowRight':
            if (!inReactions) {
                return;
            }
            next = index + (event.key === 'ArrowRight' ? 1 : -1);
            if (!items[next]?.classList.contains('sb-action-menu-reaction')) {
                return;
            }
            break;
        case 'Home':
            next = 0;
            break;
        case 'End':
            next = items.length - 1;
            break;
        default:
            return;
    }
    event.preventDefault();
    // Arrow keys would otherwise swipe the message underneath.
    event.stopPropagation();
    items[next]?.focus({ preventScroll: true });
}

function ensureSheet() {
    if (sheet) {
        return sheet;
    }
    const backdrop = document.createElement('button');
    backdrop.type = 'button';
    backdrop.className = 'sb-action-sheet-backdrop';
    backdrop.tabIndex = -1;
    backdrop.hidden = true;
    backdrop.setAttribute('aria-label', translate('Close'));

    const element = document.createElement('div');
    element.className = 'sb-action-sheet';
    element.hidden = true;
    element.setAttribute('role', 'dialog');
    element.setAttribute('aria-modal', 'true');
    element.setAttribute('aria-labelledby', SHEET_TITLE_ID);

    const header = document.createElement('div');
    header.className = 'sb-action-sheet-header';
    const heading = document.createElement('div');
    heading.className = 'sb-action-sheet-heading';
    const title = document.createElement('h2');
    title.id = SHEET_TITLE_ID;
    title.className = 'sb-action-sheet-title';
    title.tabIndex = -1;
    const subtitle = document.createElement('div');
    subtitle.className = 'sb-action-sheet-subtitle';
    heading.append(title, subtitle);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'sb-action-sheet-close';
    close.title = translate('Close');
    close.setAttribute('aria-label', translate('Close'));
    close.append(createIcon('fa-solid fa-xmark'));
    close.addEventListener('click', () => closeActionMenu());
    header.append(heading, close);

    const body = document.createElement('div');
    body.className = 'sb-action-sheet-body';
    element.append(header, body);
    document.body.append(backdrop, element);

    const controller = createSheetController({
        sheet: element,
        backdrop,
        getInitialFocus: () => (open?.keyboard ? getItems()[0] : null) ?? title,
        getReturnFocus: () => (open?.trigger?.isConnected ? open.trigger : null),
        canAnimateClose: () => isMobileLayout(),
        onClose: () => finishClose(),
    });
    sheet = { element, backdrop, title, subtitle, body, controller };
    return sheet;
}

/**
 * Places the popover beside its anchor, trailing-aligned to the trigger, inside `bounds`.
 * Triggers in the start half of the bounds (mirrored rows) align to their start edge instead.
 */
function positionPopover(popover, trigger, point, boundsElement) {
    const boundsRect = boundsElement?.getBoundingClientRect();
    const bounds = boundsRect && boundsRect.width > 0
        ? {
            left: Math.max(boundsRect.left, 0),
            right: Math.min(boundsRect.right, window.innerWidth),
            top: Math.max(boundsRect.top, 0),
            bottom: Math.min(boundsRect.bottom, window.innerHeight),
        }
        : { left: 0, right: window.innerWidth, top: 0, bottom: window.innerHeight };
    const anchor = point
        ? { left: point.x, right: point.x, top: point.y, bottom: point.y }
        : trigger.getBoundingClientRect();

    popover.style.maxBlockSize = '';
    const natural = popover.scrollHeight + 2;
    const below = bounds.bottom - anchor.bottom - POPOVER_GAP - POPOVER_MARGIN;
    const above = anchor.top - bounds.top - POPOVER_GAP - POPOVER_MARGIN;
    const placeAbove = natural > below && above > below;
    const available = Math.max(POPOVER_MIN_HEIGHT, placeAbove ? above : below);
    popover.style.maxBlockSize = `${Math.floor(available)}px`;
    const height = Math.min(natural, available);
    const width = popover.offsetWidth;

    const startAligned = point
        ? true
        : (anchor.left + anchor.right) / 2 < (bounds.left + bounds.right) / 2;
    let left = startAligned ? anchor.left : anchor.right - width;
    if (point && left + width > bounds.right - POPOVER_MARGIN) {
        left = anchor.left - width;
    }
    const minLeft = bounds.left + POPOVER_MARGIN;
    const maxLeft = bounds.right - POPOVER_MARGIN - width;
    left = maxLeft < minLeft
        ? Math.max(bounds.left, Math.min(left, bounds.right - width))
        : Math.min(Math.max(left, minLeft), maxLeft);
    const top = placeAbove ? anchor.top - POPOVER_GAP - height : anchor.bottom + POPOVER_GAP;
    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(Math.max(top, POPOVER_MARGIN))}px`;
    const originX = Math.round((anchor.left + anchor.right) / 2 - left);
    return `${originX}px ${placeAbove ? '100%' : '0'}`;
}

function setTriggerExpanded(trigger, expanded) {
    if (!trigger) {
        return;
    }
    trigger.setAttribute('aria-expanded', String(expanded));
    if (expanded) {
        trigger.setAttribute('aria-controls', MENU_ID);
    } else {
        trigger.removeAttribute('aria-controls');
    }
}

function finishClose() {
    const state = open;
    if (!state) {
        return;
    }
    open = null;
    setTriggerExpanded(state.trigger, false);
    state.onClose?.();
}

/**
 * Opens the menu, or closes it when it is already open for the same trigger.
 * @param {object} options
 * @param {HTMLElement} options.trigger
 * @param {ActionMenuSection[]} options.sections
 * @param {string} [options.title]
 * @param {string} [options.subtitle]
 * @param {{ x: number, y: number }|null} [options.point] - Desktop: open at this pointer position.
 * @param {boolean} [options.keyboard] - Focus the first row instead of the surface.
 * @param {Element|null} [options.bounds] - Desktop popover stays inside this element.
 * @param {() => void} [options.onClose]
 */
export function openActionMenu({ trigger, sections, title = translate('Message Actions'), subtitle = '', point = null, keyboard = false, bounds = null, onClose = null }) {
    initialize();
    if (open?.trigger === trigger && !point) {
        closeActionMenu({ restoreFocus: true });
        return;
    }
    closeActionMenu({ animate: false, restoreFocus: false });

    const menu = buildMenu(sections, title);
    if (!menu.querySelector('[role^="menuitem"]')) {
        return;
    }

    if (isMobileLayout()) {
        const frame = ensureSheet();
        frame.title.textContent = title;
        frame.subtitle.textContent = subtitle;
        frame.subtitle.hidden = !subtitle;
        frame.body.replaceChildren(menu);
        open = { kind: 'sheet', trigger, menu, keyboard, onClose };
        setTriggerExpanded(trigger, true);
        frame.controller.open();
        return;
    }

    const popover = document.createElement('div');
    popover.className = 'sb-action-popover';
    popover.tabIndex = -1;
    popover.append(menu);
    popover.addEventListener('keydown', handlePopoverKeydown);
    popover.addEventListener('focusout', handlePopoverFocusOut);
    blockUpstreamDrawerClose(popover);
    document.body.append(popover);
    const origin = positionPopover(popover, trigger, point, bounds);
    open = { kind: 'popover', trigger, menu, popover, keyboard, onClose, point, bounds };
    setTriggerExpanded(trigger, true);
    // DESIGN.md: Popovers 200ms fade + scale 0.96 -> 1 from trigger.
    animateIn(popover, [{ opacity: 0, transform: 'scale(0.96)' }, { opacity: 1, transform: 'none' }], {
        duration: MOTION_FAST,
        easing: MOTION_EASE_OUT_CUBIC,
        styles: { 'transform-origin': origin },
    });
    requestAnimationFrame(() => {
        if (open?.popover === popover) {
            (keyboard ? getItems()[0] : popover)?.focus({ preventScroll: true });
        }
    });
}

export function closeActionMenu({ animate = true, restoreFocus = false } = {}) {
    const state = open;
    if (!state) {
        return;
    }
    if (state.kind === 'sheet') {
        sheet.controller.close({ animate, restoreFocus });
        return;
    }
    const { popover, trigger } = state;
    const hadFocus = popover.contains(document.activeElement);
    finishClose();
    stopMotion(popover);
    // DESIGN.md: Popover close 150ms fade (no scale or movement).
    const motion = animateOut(popover, [{ opacity: 1 }, { opacity: 0 }], () => {
        popover.hidden = true;
    }, { enabled: animate, duration: MOTION_POPOVER_CLOSE, onEnd: () => popover.remove() });
    if (!motion) {
        popover.remove();
    }
    if (restoreFocus && hadFocus && trigger?.isConnected) {
        trigger.focus({ preventScroll: true });
    }
}

export function isActionMenuOpen(trigger = null) {
    return Boolean(open) && (!trigger || open.trigger === trigger);
}

/** The element the open menu belongs to, for callers that keep a row expanded while it is open. */
export function getActionMenuTrigger() {
    return open?.trigger ?? null;
}

function handlePopoverKeydown(event) {
    if (event.key === 'Escape' && !event.isComposing) {
        event.preventDefault();
        event.stopPropagation();
        closeActionMenu({ restoreFocus: true });
        return;
    }
    if (event.key === 'Tab') {
        // Menus close when focus moves on, as GTK popover menus do.
        closeActionMenu({ restoreFocus: true });
        event.preventDefault();
        return;
    }
    if (event.target === open?.popover && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        handleMenuKeydown(event);
    }
}

function handlePopoverFocusOut(event) {
    const next = event.relatedTarget instanceof Node ? event.relatedTarget : null;
    if (open?.kind === 'popover' && next && !open.popover.contains(next) && next !== open.trigger) {
        closeActionMenu();
    }
}

function handlePointerDownCapture(event) {
    if (open?.kind !== 'popover') {
        return;
    }
    const target = event.target instanceof Node ? event.target : null;
    if (target && (open.popover.contains(target) || open.trigger?.contains(target))) {
        return;
    }
    closeActionMenu();
}

function handleScrollIntent(event) {
    if (open?.kind !== 'popover') {
        return;
    }
    if (event.type === 'keydown' && !['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' '].includes(event.key)) {
        return;
    }
    const target = event.target instanceof Node ? event.target : null;
    if (target && open.popover.contains(target)) {
        return;
    }
    closeActionMenu();
}

function handleLayoutChange() {
    closeActionMenu({ animate: false });
}

function initialize() {
    if (initialized) {
        return;
    }
    initialized = true;
    mobileQuery ??= window.matchMedia(MOBILE_QUERY);
    mobileQuery.addEventListener('change', handleLayoutChange);
    window.addEventListener('pointerdown', handlePointerDownCapture, true);
    window.addEventListener('wheel', handleScrollIntent, { capture: true, passive: true });
    window.addEventListener('touchmove', handleScrollIntent, { capture: true, passive: true });
    window.addEventListener('keydown', handleScrollIntent, { capture: true, passive: true });
    window.addEventListener('resize', handleLayoutChange, { passive: true });
    // Layout-driven scrolls (streaming, scroll anchoring) keep the popover pinned to its trigger.
    document.addEventListener('scroll', event => {
        if (open?.kind === 'popover' && !(event.target instanceof Node && open.popover.contains(event.target))) {
            if (!open.trigger?.isConnected) {
                closeActionMenu({ animate: false });
            } else if (!open.point) {
                positionPopover(open.popover, open.trigger, null, open.bounds);
            }
        }
    }, { capture: true, passive: true });
}
