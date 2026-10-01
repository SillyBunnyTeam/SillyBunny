/*
 * SillyBunny message actions.
 * Mobile: the "Message Actions" and edit-mode overflow buttons open an icon-grid popover instead of
 * expanding inline, so the name row keeps one fixed line of large touch targets.
 * Touch and pen: press and hold any message action to see its label.
 * Desktop keeps the upstream inline behaviour; only CSS changes there.
 */

import { eventSource, event_types } from './events.js';
import { animateIn, animateOut, MOTION_EASE_OUT_CUBIC, MOTION_FAST, MOTION_EASE_OUT_QUAD, MOTION_POPOVER_CLOSE, originFrom, stopMotion } from './sillybunny-motion.js';

const MOBILE_QUERY = '(max-width: 768px)';
const OPEN_CLASS = 'sb-message-actions-open';
const OPEN_ATTRIBUTE = 'data-sb-open';
const TRIGGER_MARKER = 'data-sb-actions-trigger';
const ROW_TRIGGER_SELECTOR = '#chat .mes .mes_buttons > .extraMesButtonsHint';
const EDIT_TRIGGER_SELECTOR = '#chat .mes .mes_edit_buttons > .sb-mes-edit-more';
const TRIGGER_SELECTOR = `${ROW_TRIGGER_SELECTOR}, ${EDIT_TRIGGER_SELECTOR}`;
const PRESSABLE_SELECTOR = '#chat .mes :is(.mes_buttons .mes_button, .extraMesButtons > div, .mes_edit_buttons .menu_button)';
const EDIT_EXIT_SELECTOR = '#chat .mes .mes_edit_buttons > :is(.mes_edit_done, .mes_edit_cancel)';
const NAVIGATION_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']);
const MAX_COLUMNS = 5;
const VIEWPORT_MARGIN = 8;
const POPOVER_OFFSET = 6;
const SCROLL_CLOSE_DELTA = 4;
const LONG_PRESS_MS = 450;
const PRESS_MOVE_TOLERANCE = 10;
const TOOLTIP_HIDE_DELAY = 1500;
const CLICK_SUPPRESS_WINDOW = 400;
const SCROLL_INTENT_WINDOW = 400;
const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' ']);

let initialized = false;
let mobileQuery = null;
let openState = null;
let popoverIdCounter = 0;
let press = null;
let suppressClick = false;
let suppressClickTimer = 0;
let tooltip = null;
let tooltipFor = null;
let tooltipHideTimer = 0;
let lastScrollIntent = -Infinity;

function isMobileLayout() {
    return mobileQuery?.matches === true;
}

function getChat() {
    return document.getElementById('chat');
}

function asElement(target) {
    return target instanceof Element ? target : null;
}

function getPopoverFor(trigger) {
    const selector = trigger.classList.contains('sb-mes-edit-more') ? ':scope > .sb-mes-edit-extra' : ':scope > .extraMesButtons';
    return trigger.parentElement?.querySelector(selector) ?? null;
}

function getVisibleItems(popover) {
    return [...popover.children].filter(child => child instanceof HTMLElement && child.getClientRects().length > 0);
}

function ensureTriggerAria(trigger) {
    const popover = getPopoverFor(trigger);
    if (!popover) {
        return null;
    }
    if (!popover.id) {
        popover.id = `sb-message-actions-${++popoverIdCounter}`;
    }
    popover.setAttribute('role', 'group');
    popover.setAttribute('aria-label', getActionLabel(trigger) || 'Message Actions');
    trigger.setAttribute(TRIGGER_MARKER, '');
    trigger.setAttribute('aria-haspopup', 'true');
    trigger.setAttribute('aria-controls', popover.id);
    if (!trigger.hasAttribute('aria-expanded')) {
        trigger.setAttribute('aria-expanded', 'false');
    }
    return popover;
}

function clearTriggerAria() {
    for (const trigger of document.querySelectorAll(`[${TRIGGER_MARKER}]`)) {
        trigger.removeAttribute(TRIGGER_MARKER);
        trigger.removeAttribute('aria-haspopup');
        trigger.removeAttribute('aria-controls');
        trigger.removeAttribute('aria-expanded');
    }
}

function openPopover(trigger, popover, { focus = true } = {}) {
    closePopover({ animate: false });
    const chat = getChat();
    const host = popover.parentElement;
    const mes = trigger.closest('.mes');
    if (!chat || !host || !mes) {
        return;
    }

    // Cancelling a running exit also runs its cleanup, so do it before marking the message open.
    stopMotion(popover);
    ensureTriggerAria(trigger);
    host.style.removeProperty('--sb-actions-max-h');
    host.style.removeProperty('--sb-actions-shift');
    host.style.setProperty('--sb-actions-cols', String(MAX_COLUMNS));
    popover.dataset.sbPlacement = 'bottom';
    popover.setAttribute(OPEN_ATTRIBUTE, '');
    mes.classList.add(OPEN_CLASS);
    trigger.setAttribute('aria-expanded', 'true');

    const items = getVisibleItems(popover);
    const styles = getComputedStyle(popover);
    const hit = items[0]?.getBoundingClientRect().width || trigger.getBoundingClientRect().width || 44;
    const gap = parseFloat(styles.columnGap) || 0;
    const chrome = (parseFloat(styles.paddingLeft) || 0) + (parseFloat(styles.paddingRight) || 0)
        + (parseFloat(styles.borderLeftWidth) || 0) + (parseFloat(styles.borderRightWidth) || 0);
    const chatRect = chat.getBoundingClientRect();
    const maxColumns = Math.max(1, Math.floor((chatRect.width - VIEWPORT_MARGIN * 2 - chrome + gap) / (hit + gap)));
    const columns = Math.max(1, Math.min(items.length, MAX_COLUMNS, maxColumns));
    host.style.setProperty('--sb-actions-cols', String(columns));

    const hostRect = host.getBoundingClientRect();
    const height = popover.getBoundingClientRect().height;
    const below = chatRect.bottom - hostRect.bottom - POPOVER_OFFSET - VIEWPORT_MARGIN;
    const above = hostRect.top - chatRect.top - POPOVER_OFFSET - VIEWPORT_MARGIN;
    const placement = height > below && above > below ? 'top' : 'bottom';
    const minimumHeight = hit + (parseFloat(styles.paddingTop) || 0) + (parseFloat(styles.paddingBottom) || 0);
    const space = Math.max(placement === 'bottom' ? below : above, minimumHeight);
    if (height > space) {
        host.style.setProperty('--sb-actions-max-h', `${Math.floor(space)}px`);
    }
    popover.dataset.sbPlacement = placement;

    const rect = popover.getBoundingClientRect();
    const overRight = rect.right - (chatRect.right - VIEWPORT_MARGIN);
    const overLeft = chatRect.left + VIEWPORT_MARGIN - rect.left;
    if (overRight > 0) {
        host.style.setProperty('--sb-actions-shift', `${Math.ceil(overRight)}px`);
    } else if (overLeft > 0) {
        host.style.setProperty('--sb-actions-shift', `${-Math.ceil(overLeft)}px`);
    }

    openState = { trigger, popover, host, mes, chat, scrollTop: chat.scrollTop };

    // DESIGN.md: Popovers 200ms fade + scale 0.96 -> 1 from trigger.
    animateIn(popover, [
        { opacity: 0, transform: 'scale(0.96)' },
        { opacity: 1, transform: 'none' },
    ], {
        duration: MOTION_FAST,
        easing: MOTION_EASE_OUT_QUAD,
        styles: { 'transform-origin': originFrom(trigger, popover) },
    });

    if (focus) {
        items[0]?.focus({ preventScroll: true });
    }
}

function closePopover({ restoreFocus = false, animate = true } = {}) {
    const state = openState;
    if (!state) {
        return;
    }
    openState = null;
    const { trigger, popover, mes } = state;
    trigger.setAttribute('aria-expanded', 'false');

    const finish = () => {
        if (openState?.mes !== mes) {
            mes.classList.remove(OPEN_CLASS);
        }
    };

    if (restoreFocus && trigger.isConnected) {
        trigger.focus({ preventScroll: true });
    }

    // DESIGN.md: Popover close 150ms fade (no scale or movement).
    const motion = animateOut(popover, [
        { opacity: 1 },
        { opacity: 0 },
    ], () => popover.removeAttribute(OPEN_ATTRIBUTE), {
        enabled: animate && popover.isConnected,
        duration: MOTION_POPOVER_CLOSE,
        easing: MOTION_EASE_OUT_CUBIC,
        onEnd: finish,
    });
    if (!motion) {
        finish();
    }
}

function togglePopover(trigger) {
    if (openState?.trigger === trigger) {
        closePopover({ restoreFocus: true });
        return;
    }
    const popover = getPopoverFor(trigger);
    if (popover) {
        openPopover(trigger, popover);
    }
}

function moveFocus(key) {
    if (!openState) {
        return;
    }
    const items = getVisibleItems(openState.popover);
    if (!items.length) {
        return;
    }
    const columns = Number(openState.host.style.getPropertyValue('--sb-actions-cols')) || items.length;
    let index = items.indexOf(/** @type {HTMLElement} */ (document.activeElement));
    if (key === 'Home') {
        index = 0;
    } else if (key === 'End') {
        index = items.length - 1;
    } else if (index < 0) {
        index = 0;
    } else {
        const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns }[key];
        const next = index + step;
        if (next >= 0 && next < items.length) {
            index = next;
        }
    }
    items[index]?.focus({ preventScroll: true });
}

/*
 * Checkpoint and one-click swipe replacement are conditional row actions; mobile keeps them in the
 * popover so the row stays ⋯ + Edit + Delete. They move once per render, so jQuery's toggle() keeps
 * working against the normal stylesheet display.
 */
function relocateConditionalActions(mes, mobile) {
    const buttons = mes.querySelector(':scope .ch_name > .mes_buttons');
    const extras = buttons?.querySelector(':scope > .extraMesButtons');
    if (!buttons || !extras) {
        return;
    }

    if (mobile) {
        const movable = buttons.querySelectorAll(':scope > :is(.mes_bookmark, .mes_delete_add_swipe)');
        if (movable.length) {
            extras.prepend(...movable);
        }
        return;
    }

    const bookmark = extras.querySelector(':scope > .mes_bookmark');
    if (bookmark) {
        const anchor = buttons.querySelector(':scope > .mes_edit');
        anchor ? anchor.before(bookmark) : buttons.append(bookmark);
    }
    const replaceSwipe = extras.querySelector(':scope > .mes_delete_add_swipe');
    if (replaceSwipe) {
        const anchor = buttons.querySelector(':scope > .mes_delete');
        anchor ? anchor.before(replaceSwipe) : buttons.append(replaceSwipe);
    }
}

function relocateAll(mobile) {
    const chat = getChat();
    if (!chat) {
        return;
    }
    for (const mes of chat.querySelectorAll(':scope > .mes')) {
        relocateConditionalActions(mes, mobile);
    }
}

/** Clears state left by the upstream inline expansion so the mobile popover starts clean. */
function clearInlineExpansionState() {
    for (const extras of document.querySelectorAll('#chat .extraMesButtons')) {
        extras.classList.remove('visible');
        extras.style.removeProperty('display');
        extras.style.removeProperty('opacity');
    }
    for (const hint of document.querySelectorAll('#chat .extraMesButtonsHint')) {
        hint.style.removeProperty('display');
        hint.style.removeProperty('opacity');
    }
}

function handleLayoutChange() {
    closePopover({ animate: false });
    hideTooltip();
    clearInlineExpansionState();
    const mobile = isMobileLayout();
    relocateAll(mobile);
    if (!mobile) {
        clearTriggerAria();
    }
}

function getActionLabel(element) {
    // data-sttt--title: the SillyTavern-Tooltips extension moves `title` there.
    const label = element.getAttribute('title')
        || element.getAttribute('data-sttt--title')
        || element.getAttribute('data-tooltip')
        || element.getAttribute('aria-label')
        || '';
    return label.split('\n')[0].trim();
}

function ensureTooltip() {
    if (tooltip?.isConnected) {
        return tooltip;
    }
    tooltip = document.createElement('div');
    tooltip.id = 'sb-press-tooltip';
    tooltip.className = 'sb-press-tooltip';
    tooltip.setAttribute('role', 'tooltip');
    tooltip.hidden = true;
    document.body.append(tooltip);
    return tooltip;
}

function showTooltip(target, label) {
    const element = ensureTooltip();
    clearTimeout(tooltipHideTimer);
    element.textContent = label;
    element.hidden = false;
    const targetRect = target.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    let top = targetRect.top - rect.height - 8;
    if (top < VIEWPORT_MARGIN) {
        top = targetRect.bottom + 8;
    }
    const left = Math.min(
        Math.max(targetRect.left + targetRect.width / 2 - rect.width / 2, VIEWPORT_MARGIN),
        window.innerWidth - rect.width - VIEWPORT_MARGIN,
    );
    element.style.top = `${Math.round(top)}px`;
    element.style.left = `${Math.round(left)}px`;
    tooltipFor?.removeAttribute('aria-describedby');
    target.setAttribute('aria-describedby', element.id);
    tooltipFor = target;
    // Press-and-hold tooltip: short fade + scale (similar to popover but simpler).
    animateIn(element, [
        { opacity: 0, transform: 'scale(0.96)' },
        { opacity: 1, transform: 'none' },
    ], { duration: MOTION_FAST, easing: MOTION_EASE_OUT_QUAD });
}

function hideTooltip() {
    clearTimeout(tooltipHideTimer);
    if (!tooltip || tooltip.hidden) {
        return;
    }
    stopMotion(tooltip);
    tooltip.hidden = true;
    tooltipFor?.removeAttribute('aria-describedby');
    tooltipFor = null;
}

function cancelPress() {
    if (press) {
        clearTimeout(press.timer);
    }
    press = null;
}

function startPress(event) {
    cancelPress();
    if (event.pointerType !== 'touch' && event.pointerType !== 'pen') {
        return;
    }
    const target = asElement(event.target)?.closest(PRESSABLE_SELECTOR);
    const label = target ? getActionLabel(target) : '';
    if (!target || !label) {
        return;
    }
    const current = { id: event.pointerId, x: event.clientX, y: event.clientY, fired: false, timer: 0 };
    current.timer = window.setTimeout(() => {
        current.fired = true;
        showTooltip(target, label);
    }, LONG_PRESS_MS);
    press = current;
}

function handlePointerMove(event) {
    if (press && event.pointerId === press.id && Math.hypot(event.clientX - press.x, event.clientY - press.y) > PRESS_MOVE_TOLERANCE) {
        cancelPress();
    }
}

function handlePointerEnd(event) {
    if (!press || event.pointerId !== press.id) {
        return;
    }
    const fired = press.fired;
    cancelPress();
    if (!fired) {
        return;
    }
    tooltipHideTimer = window.setTimeout(hideTooltip, TOOLTIP_HIDE_DELAY);
    suppressClick = true;
    clearTimeout(suppressClickTimer);
    // Some engines skip the click after a long press; don't let the flag eat a later click.
    suppressClickTimer = window.setTimeout(() => {
        suppressClick = false;
    }, CLICK_SUPPRESS_WINDOW);
}

function handlePointerDownCapture(event) {
    hideTooltip();
    if (openState) {
        const target = event.target instanceof Node ? event.target : null;
        if (!target || (!openState.popover.contains(target) && !openState.trigger.contains(target))) {
            closePopover();
        }
    }
    const trigger = asElement(event.target)?.closest(TRIGGER_SELECTOR);
    if (trigger && isMobileLayout()) {
        ensureTriggerAria(trigger);
    }
    startPress(event);
}

function handleClickCapture(event) {
    const target = asElement(event.target);
    if (suppressClick) {
        suppressClick = false;
        if (target?.closest(PRESSABLE_SELECTOR)) {
            event.preventDefault();
            event.stopImmediatePropagation();
            return;
        }
    }

    if (!target || !isMobileLayout()) {
        return;
    }

    const trigger = target.closest(TRIGGER_SELECTOR);
    if (trigger) {
        // Replaces the upstream inline expansion (script.js) on mobile.
        event.preventDefault();
        event.stopImmediatePropagation();
        togglePopover(trigger);
        return;
    }

    if (!openState) {
        return;
    }

    if (target.closest(EDIT_EXIT_SELECTOR)) {
        closePopover({ animate: false });
        return;
    }

    const state = openState;
    if (state.popover.contains(target) && target !== state.popover) {
        // Let the action's own handlers run first.
        window.setTimeout(() => {
            if (openState === state) {
                closePopover({ restoreFocus: state.popover.contains(document.activeElement) });
            }
        }, 0);
    }
}

function handleKeydownCapture(event) {
    if (!openState) {
        return;
    }
    if (event.key === 'Escape' && !event.isComposing) {
        // Stops the upstream Escape handler from also cancelling a message edit.
        event.preventDefault();
        event.stopImmediatePropagation();
        hideTooltip();
        closePopover({ restoreFocus: true });
        return;
    }
    if (NAVIGATION_KEYS.has(event.key) && openState.popover.contains(asElement(event.target))) {
        // Arrow keys would otherwise swipe the message.
        event.preventDefault();
        event.stopImmediatePropagation();
        moveFocus(event.key);
    }
}

function handleFocusIn(event) {
    const trigger = asElement(event.target)?.closest(TRIGGER_SELECTOR);
    if (trigger && isMobileLayout()) {
        ensureTriggerAria(trigger);
    }
}

function handleFocusOut(event) {
    if (!openState) {
        return;
    }
    const next = event.relatedTarget instanceof Node ? event.relatedTarget : null;
    if (next && !openState.popover.contains(next) && !openState.trigger.contains(next)) {
        closePopover();
    }
}

function markScrollIntent(event) {
    if (!openState) {
        return;
    }
    if (event.type === 'keydown' && !SCROLL_KEYS.has(event.key)) {
        return;
    }
    if (openState.popover.contains(asElement(event.target))) {
        return;
    }
    lastScrollIntent = performance.now();
}

function handleChatScroll() {
    if (!openState) {
        return;
    }
    // The popover moves with its message, so layout-driven scrolls (edit autosize, scroll
    // anchoring, new messages) leave it anchored; only a user scroll dismisses it.
    if (performance.now() - lastScrollIntent > SCROLL_INTENT_WINDOW) {
        openState.scrollTop = openState.chat.scrollTop;
        return;
    }
    if (Math.abs(openState.chat.scrollTop - openState.scrollTop) > SCROLL_CLOSE_DELTA) {
        closePopover();
    }
}

function handleContextMenu(event) {
    if (asElement(event.target)?.closest(PRESSABLE_SELECTOR)) {
        event.preventDefault();
    }
}

function observeRenderedMessages(chat) {
    const observer = new MutationObserver(records => {
        if (openState && !openState.mes.isConnected) {
            openState = null;
        }
        if (!isMobileLayout()) {
            return;
        }
        for (const record of records) {
            for (const node of record.addedNodes) {
                if (node instanceof HTMLElement && node.classList.contains('mes')) {
                    relocateConditionalActions(node, true);
                }
            }
        }
    });
    observer.observe(chat, { childList: true });
}

export function initializeMessageActions() {
    if (initialized) {
        return;
    }
    const chat = getChat();
    if (!chat) {
        return;
    }
    initialized = true;
    mobileQuery = window.matchMedia(MOBILE_QUERY);
    mobileQuery.addEventListener('change', handleLayoutChange);

    window.addEventListener('pointerdown', handlePointerDownCapture, true);
    window.addEventListener('pointermove', handlePointerMove, { capture: true, passive: true });
    window.addEventListener('pointerup', handlePointerEnd, true);
    window.addEventListener('pointercancel', handlePointerEnd, true);
    window.addEventListener('click', handleClickCapture, true);
    window.addEventListener('keydown', handleKeydownCapture, true);
    document.addEventListener('focusin', handleFocusIn);
    document.addEventListener('focusout', handleFocusOut);
    chat.addEventListener('contextmenu', handleContextMenu);
    chat.addEventListener('scroll', handleChatScroll, { passive: true });
    chat.addEventListener('wheel', markScrollIntent, { passive: true });
    chat.addEventListener('touchmove', markScrollIntent, { passive: true });
    window.addEventListener('keydown', markScrollIntent, { capture: true, passive: true });
    observeRenderedMessages(chat);

    const closeImmediately = () => closePopover({ animate: false });
    // Dry runs (prompt/token previews) and auxiliary jobs also emit GENERATION_STARTED.
    eventSource.on(event_types.GENERATION_STARTED, (_type, options, dryRun) => {
        if (!dryRun && !options?.isAuxiliaryGeneration) {
            closeImmediately();
        }
    });
    eventSource.on(event_types.CHAT_CHANGED, closeImmediately);

    if (isMobileLayout()) {
        relocateAll(true);
    }
}
