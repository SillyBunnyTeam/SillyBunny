/*
 * SillyBunny message actions (DESIGN.md "Message Actions").
 * Row: mobile shows Edit + menu button; desktop shows Copy + Edit + menu button. The menu button
 * (upstream's .extraMesButtonsHint) opens a labelled menu built from the message's own buttons,
 * which stay in the DOM so upstream and extension handlers keep working; menu rows forward to them.
 * Desktop: Shift over a message, or the Expand Message Actions setting, shows every action inline.
 * Touch and pen: press and hold any message action to see its label.
 */

import { eventSource, event_types } from './events.js';
import { translate } from './i18n.js';
import { MOBILE_QUERY, closeActionMenu, getActionMenuTrigger, isActionMenuOpen, openActionMenu } from './sillybunny-action-menu.js';
import { initializeConversationMessageMenu } from './sillybunny-conversation/message-menu.js';
import { animateIn, MOTION_FAST, MOTION_EASE_OUT_QUAD, stopMotion } from './sillybunny-motion.js';

const HINT_SELECTOR = '#chat .mes .mes_buttons > .extraMesButtonsHint';
const EDIT_MORE_SELECTOR = '#chat .mes .mes_edit_buttons > .sb-mes-edit-more';
const PRESSABLE_SELECTOR = '#chat .mes :is(.mes_buttons .mes_button, .mes_edit_buttons .menu_button)';
const REVEAL_HOST_SELECTOR = '#chat > .mes, .sb-conversation-message';
const EXPANDED_ATTRIBUTE = 'data-sb-actions-expanded';
const PROBE_ATTRIBUTE = 'data-sb-actions-probe';
const WRAPPED_ATTRIBUTE = 'data-sb-wrapped';
const DIVIDER_CLASS = 'sb-actions-divider';
const ROW_CONTROL_SELECTOR = `.extraMesButtons, .mes_edit, .extraMesButtonsHint, .${DIVIDER_CLASS}`;
const VIEWPORT_MARGIN = 8;
const LONG_PRESS_MS = 450;
const PRESS_MOVE_TOLERANCE = 10;
const TOOLTIP_HIDE_DELAY = 1500;
const CLICK_SUPPRESS_WINDOW = 400;

/*
 * Menu sections, in order. Unknown buttons (extensions) fall into OTHER_SECTION, Delete is last.
 * The template keeps .extraMesButtons in the same order so the expanded row matches.
 */
const ROW_SECTIONS = [
    ['mes_delete_add_swipe', 'mes_swipe_picker', 'mes_narrate', 'mes_translate', 'sd_message_gen', 'qig-message-generate'],
    ['mes_copy', 'mes_screenshot'],
    ['mes_create_branch', 'mes_create_bookmark', 'mes_bookmark', 'mes_hide', 'mes_unhide'],
    ['mes_prompt', 'mes_view_agent_changes', 'mes_fix_trackers', 'mes_run_companions', 'mes_run_card_scripts', 'mes_embed', 'mes_media_gallery', 'mes_media_list'],
    [],
    ['mes_delete'],
];
const OTHER_SECTION = 4;
/** The expanded row ends with Copy, Edit, and the menu button after a divider. */
const TRAILING_SECTION = ROW_SECTIONS.length;
const TRAILING_CLASSES = ['mes_copy', 'mes_edit', 'extraMesButtonsHint'];
const EDIT_SECTIONS = [['mes_edit_copy', 'mes_edit_add_reasoning'], ['mes_edit_up', 'mes_edit_down'], ['mes_edit_delete']];
const DANGER_CLASSES = new Set(['mes_delete', 'mes_edit_delete']);
// Upstream binds these on pointerup instead of click (script.js, itemized-prompts.js).
const POINTERUP_CLASSES = ['mes_copy', 'mes_prompt'];

let initialized = false;
let mobileQuery = null;
let press = null;
let suppressClick = false;
let suppressClickTimer = 0;
let tooltip = null;
let tooltipFor = null;
let tooltipHideTimer = 0;
let hoverHost = null;
/** @type {{ x: number, y: number } | null} */
let lastMousePoint = null;
/** @type {{ host: HTMLElement, source: 'pointer'|'focus' } | null} */
let reveal = null;
let layoutFrame = 0;
const pendingLayout = new Set();

function isMobileLayout() {
    return mobileQuery?.matches === true;
}

function isSettingExpanded() {
    return document.body.classList.contains('expandMessageActions');
}

function asElement(target) {
    return target instanceof Element ? target : null;
}

function isTypingTarget(element) {
    return element instanceof HTMLElement
        && (element.isContentEditable || element.matches('textarea, input:not([type="radio"], [type="checkbox"], [type="button"], [type="submit"]), select'));
}

function getRow(mes) {
    return mes?.querySelector(':scope .ch_name > .mes_buttons') ?? null;
}

function sectionOf(element) {
    const index = ROW_SECTIONS.findIndex(classes => classes.some(name => element.classList.contains(name)));
    return index < 0 ? OTHER_SECTION : index;
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

function getActionIcon(element) {
    const classes = [...element.classList].filter(name => name === 'fa' || name.startsWith('fa-'));
    if (classes.length) {
        return classes.join(' ');
    }
    return element.querySelector(':scope > :is(i, svg, img)') ?? 'fa-solid fa-puzzle-piece';
}

function isAvailable(element) {
    return element instanceof HTMLElement
        && !element.classList.contains('displayNone')
        && getComputedStyle(element).display !== 'none'
        && Boolean(getActionLabel(element));
}

/** Reads availability with the row's layout hiding switched off, so only real conditions apply. */
function probeAvailable(mes, elements) {
    mes.setAttribute(PROBE_ATTRIBUTE, '');
    try {
        return elements.filter(isAvailable);
    } finally {
        mes.removeAttribute(PROBE_ATTRIBUTE);
    }
}

function forwardActivation(element, event) {
    if (!element.isConnected) {
        return;
    }
    const init = {
        bubbles: true,
        cancelable: true,
        view: window,
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
    };
    const known = sectionOf(element) !== OTHER_SECTION || [...EDIT_SECTIONS.flat()].some(name => element.classList.contains(name));
    const usesPointerUp = POINTERUP_CLASSES.some(name => element.classList.contains(name));
    // Unknown extension buttons get the same pair a real tap produces.
    if (usesPointerUp || !known) {
        element.dispatchEvent(new PointerEvent('pointerup', { ...init, pointerType: 'mouse', isPrimary: true }));
    }
    if (!usesPointerUp) {
        element.dispatchEvent(new MouseEvent('click', { ...init, detail: 1 }));
    }
}

function toMenuItem(element) {
    const title = element.getAttribute('title') || element.getAttribute('data-sttt--title') || element.getAttribute('data-tooltip') || '';
    const lines = title.split('\n').map(line => line.trim());
    const item = {
        label: getActionLabel(element),
        icon: getActionIcon(element),
        title,
        danger: [...DANGER_CLASSES].some(name => element.classList.contains(name)),
        disabled: element.classList.contains('disabled'),
        onSelect: event => forwardActivation(element, event),
    };
    // updateBookmarkDisplay() writes "Checkpoint\n<chat name>\n\n<tooltip>".
    if (element.classList.contains('mes_bookmark') && lines[1]) {
        item.detail = lines[1];
    }
    return item;
}

function getMessageSubtitle(mes) {
    const name = mes.querySelector('.ch_name .name_text')?.textContent?.trim() ?? '';
    const id = mes.getAttribute('mesid');
    return [name, id !== null ? `#${id}` : ''].filter(Boolean).join(' · ');
}

function buildRowSections(mes) {
    const row = getRow(mes);
    if (!row) {
        return [];
    }
    const extras = row.querySelector(':scope > .extraMesButtons');
    const candidates = [
        ...(extras ? [...extras.children] : []),
        ...[...row.children].filter(child => !child.matches(ROW_CONTROL_SELECTOR)),
    ].filter(element => !element.classList.contains(DIVIDER_CLASS));
    const sections = ROW_SECTIONS.map(() => []);
    for (const element of probeAvailable(mes, candidates)) {
        sections[sectionOf(element)].push(toMenuItem(element));
    }
    return sections.map(items => ({ items }));
}

function buildEditSections(mes) {
    const extra = mes.querySelector(':scope .mes_edit_buttons > .sb-mes-edit-extra');
    if (!extra) {
        return [];
    }
    return EDIT_SECTIONS.map(classes => ({
        items: classes
            .map(name => extra.querySelector(`:scope > .${name}`))
            // The theme hides disabled Move up/down in the row; the menu lists them disabled.
            .filter(element => isAvailable(element) || (element?.classList.contains('disabled') && /mes_edit_(up|down)/.test(element.className)))
            .map(toMenuItem),
    }));
}

function openMessageMenu(trigger, { point = null, keyboard = false } = {}) {
    const mes = trigger.closest('#chat > .mes');
    if (!(mes instanceof HTMLElement)) {
        return;
    }
    const editing = trigger.classList.contains('sb-mes-edit-more') || Boolean(mes.querySelector('#curEditTextarea'));
    hideTooltip();
    mes.classList.add('sb-message-actions-open');
    openActionMenu({
        trigger,
        sections: editing ? buildEditSections(mes) : buildRowSections(mes),
        subtitle: getMessageSubtitle(mes),
        point,
        keyboard,
        bounds: document.getElementById('chat'),
        onClose: () => {
            mes.classList.remove('sb-message-actions-open');
            requestAnimationFrame(collapseRevealIfLeft);
        },
    });
}

function getMenuTrigger(mes) {
    const editing = Boolean(mes.querySelector('#curEditTextarea'));
    return mes.querySelector(editing ? ':scope .mes_edit_buttons > .sb-mes-edit-more' : ':scope .ch_name > .mes_buttons > .extraMesButtonsHint');
}

/* ---------- Expanded row (desktop) ---------- */

function isRowExpanded(mes) {
    return !isMobileLayout() && (isSettingExpanded() || mes.hasAttribute(EXPANDED_ATTRIBUTE));
}

function createDivider() {
    const divider = document.createElement('span');
    divider.className = DIVIDER_CLASS;
    divider.setAttribute('aria-hidden', 'true');
    return divider;
}

/** Keeps known actions in section order; extensions append theirs at the end of .extraMesButtons. */
function normalizeExtrasOrder(extras) {
    const children = [...extras.children].filter(child => !child.classList.contains(DIVIDER_CLASS));
    const rank = element => {
        const section = sectionOf(element);
        const position = ROW_SECTIONS[section].findIndex(name => element.classList.contains(name));
        return section * 100 + (position < 0 ? 99 : position);
    };
    const sorted = children
        .map((element, index) => ({ element, index, rank: rank(element) }))
        .sort((a, b) => a.rank - b.rank || a.index - b.index);
    if (sorted.some((entry, index) => entry.element !== children[index])) {
        extras.append(...sorted.map(entry => entry.element));
    }
}

/** Places dividers between non-empty sections and hides them once the row wraps. */
function layoutExpandedRow(mes) {
    const row = getRow(mes);
    if (!row || !isRowExpanded(mes)) {
        return;
    }
    row.querySelectorAll(`.${DIVIDER_CLASS}`).forEach(divider => divider.remove());
    const extras = row.querySelector(':scope > .extraMesButtons');
    if (extras) {
        normalizeExtrasOrder(extras);
    }
    const items = [
        ...(extras ? [...extras.children] : []),
        ...[...row.children].filter(child => child !== extras),
    ].filter(element => element instanceof HTMLElement && element.getClientRects().length > 0);

    let previousSection = -1;
    for (const element of items) {
        const section = TRAILING_CLASSES.some(name => element.classList.contains(name)) ? TRAILING_SECTION : sectionOf(element);
        if (previousSection >= 0 && section !== previousSection) {
            element.before(createDivider());
        }
        previousSection = section;
    }

    row.removeAttribute(WRAPPED_ATTRIBUTE);
    const first = items[0];
    const last = items.at(-1);
    if (first && last && first !== last && Math.abs(last.getBoundingClientRect().top - first.getBoundingClientRect().top) > 2) {
        row.setAttribute(WRAPPED_ATTRIBUTE, '');
    }
}

function scheduleLayout(mes) {
    if (!(mes instanceof HTMLElement)) {
        return;
    }
    pendingLayout.add(mes);
    if (layoutFrame) {
        return;
    }
    layoutFrame = requestAnimationFrame(() => {
        layoutFrame = 0;
        const batch = [...pendingLayout];
        pendingLayout.clear();
        batch.filter(item => item.isConnected).forEach(layoutExpandedRow);
    });
}

function scheduleLayoutForAll() {
    if (isMobileLayout()) {
        return;
    }
    const chat = document.getElementById('chat');
    if (isSettingExpanded()) {
        chat?.querySelectorAll(':scope > .mes').forEach(scheduleLayout);
    } else if (reveal?.host.matches('#chat > .mes')) {
        scheduleLayout(reveal.host);
    }
}

function scheduleLayoutForMessage(messageId) {
    if (isMobileLayout()) {
        return;
    }
    const mes = document.querySelector(`#chat > .mes[mesid="${messageId}"]`);
    if (mes && isRowExpanded(/** @type {HTMLElement} */ (mes))) {
        scheduleLayout(mes);
    }
}

/* ---------- Shift reveal (desktop, Roleplay and Conversation) ---------- */

function setReveal(next) {
    if (reveal?.host === next?.host) {
        if (next) {
            reveal = next;
        }
        return;
    }
    reveal?.host.removeAttribute(EXPANDED_ATTRIBUTE);
    reveal = next;
    if (!next) {
        return;
    }
    next.host.setAttribute(EXPANDED_ATTRIBUTE, '');
    if (next.host.matches('#chat > .mes')) {
        layoutExpandedRow(next.host);
    }
}

function isEditingHost(host) {
    return Boolean(host.querySelector('#curEditTextarea')) || host.classList.contains('is-editing');
}

function collapseRevealIfLeft() {
    if (!reveal || isActionMenuOpen()) {
        return;
    }
    if (!reveal.host.isConnected) {
        reveal = null;
        return;
    }
    if (reveal.source === 'pointer' ? hoverHost !== reveal.host : !reveal.host.contains(document.activeElement)) {
        setReveal(null);
    }
}

function handleRevealKeydown(event) {
    if (event.key === 'Escape') {
        if (reveal && !isActionMenuOpen()) {
            setReveal(null);
        }
        return;
    }
    const isShift = event.key === 'Shift' || event.code === 'ShiftLeft' || event.code === 'ShiftRight';
    if (!isShift || event.repeat) {
        return;
    }
    const pointerHost = getHostUnderMouse();
    const focusHost = asElement(document.activeElement)?.closest(REVEAL_HOST_SELECTOR) ?? null;
    revealHost(pointerHost ?? focusHost, pointerHost ? 'pointer' : 'focus');
}

/** Hit-tests the last mouse position instead of trusting pointerover/leave bookkeeping, which Firefox can drop. */
function getHostUnderMouse() {
    if (!lastMousePoint) {
        return hoverHost;
    }
    const hit = document.elementFromPoint(lastMousePoint.x, lastMousePoint.y);
    const host = hit?.closest(REVEAL_HOST_SELECTOR) ?? null;
    if (host instanceof HTMLElement) {
        hoverHost = host;
        return host;
    }
    return null;
}

function revealHost(host, source) {
    if (!(host instanceof HTMLElement) || isEditingHost(host) || reveal?.host === host) {
        return;
    }
    if (isMobileLayout() || isSettingExpanded() || isActionMenuOpen()) {
        return;
    }
    if (isTypingTarget(document.activeElement) || document.querySelector('dialog[open]')) {
        return;
    }
    setReveal({ host, source });
}

function handlePointerOver(event) {
    if (event.pointerType && event.pointerType !== 'mouse') {
        return;
    }
    // Before the native or extension tooltip reads the title.
    prepareTrigger(event.target);
    const host = asElement(event.target)?.closest(REVEAL_HOST_SELECTOR) ?? null;
    if (host === hoverHost) {
        return;
    }
    hoverHost = /** @type {HTMLElement|null} */ (host);
    // Hover-reveal on desktop: refresh dividers once per entered message in setting mode.
    if (host && isSettingExpanded() && host.matches('#chat > .mes')) {
        scheduleLayout(host);
    }
    if (reveal?.source === 'pointer' && reveal.host !== host && getActionMenuTrigger()?.closest(REVEAL_HOST_SELECTOR) !== reveal.host) {
        setReveal(null);
    }
    // Shift already held when the pointer arrives; also covers setups where the Shift keydown never reaches the page.
    if (event.shiftKey) {
        revealHost(host, 'pointer');
    }
}

function handlePointerLeaveDocument() {
    hoverHost = null;
    collapseRevealIfLeft();
}

function handleFocusOut() {
    if (reveal?.source === 'focus') {
        requestAnimationFrame(collapseRevealIfLeft);
    }
}

/* ---------- Hint tooltip ---------- */

function syncHintTitle(hint) {
    const label = translate('Message Actions');
    const title = isMobileLayout() || isSettingExpanded() ? label : `${label}\n${translate('Hold shift to expand.')}`;
    const attribute = hint.hasAttribute('data-sttt--title') ? 'data-sttt--title' : 'title';
    if (hint.getAttribute(attribute) !== title) {
        hint.setAttribute(attribute, title);
    }
    if (!hint.hasAttribute('aria-haspopup')) {
        hint.setAttribute('role', 'button');
        hint.setAttribute('aria-label', label);
        hint.setAttribute('aria-haspopup', 'menu');
        hint.setAttribute('aria-expanded', 'false');
    }
}

function prepareTrigger(target) {
    const trigger = asElement(target)?.closest(`${HINT_SELECTOR}, ${EDIT_MORE_SELECTOR}`);
    if (!trigger) {
        return;
    }
    if (trigger.classList.contains('extraMesButtonsHint')) {
        syncHintTitle(trigger);
    } else if (!trigger.hasAttribute('aria-haspopup')) {
        trigger.setAttribute('role', 'button');
        trigger.setAttribute('aria-haspopup', 'menu');
        trigger.setAttribute('aria-expanded', 'false');
    }
}

/* ---------- Press-and-hold labels (touch and pen) ---------- */

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
    if (event.pointerType === 'mouse') {
        lastMousePoint = { x: event.clientX, y: event.clientY };
        if (event.shiftKey) {
            revealHost(getHostUnderMouse(), 'pointer');
        }
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

/* ---------- Event wiring ---------- */

function handlePointerDownCapture(event) {
    hideTooltip();
    prepareTrigger(event.target);
    startPress(event);
}

function handleClickCapture(event) {
    const target = asElement(event.target);
    if (!target) {
        return;
    }
    if (suppressClick) {
        suppressClick = false;
        if (target.closest(PRESSABLE_SELECTOR)) {
            event.preventDefault();
            event.stopImmediatePropagation();
            return;
        }
    }

    const trigger = target.closest(`${HINT_SELECTOR}, ${EDIT_MORE_SELECTOR}`);
    if (trigger instanceof HTMLElement) {
        // Replaces upstream's inline expansion of .extraMesButtons (script.js).
        event.preventDefault();
        event.stopImmediatePropagation();
        prepareTrigger(trigger);
        openMessageMenu(trigger, { keyboard: event.detail === 0 });
        return;
    }

    // Hide/include, checkpoint, and similar toggles change which actions the row shows.
    const mes = target.closest('#chat > .mes');
    if (mes instanceof HTMLElement && isRowExpanded(mes) && target.closest('.mes_buttons')) {
        window.setTimeout(() => scheduleLayout(mes), 0);
    }
}

function handleContextMenu(event) {
    const target = asElement(event.target);
    if (!target) {
        return;
    }
    if (target.closest(PRESSABLE_SELECTOR) && (isMobileLayout() || press)) {
        event.preventDefault();
        return;
    }
    if (isMobileLayout() || event.shiftKey) {
        return;
    }
    const mes = target.closest('#chat > .mes');
    if (!(mes instanceof HTMLElement) || !target.closest('.ch_name') || isTypingTarget(target)) {
        return;
    }
    const trigger = getMenuTrigger(mes);
    if (!(trigger instanceof HTMLElement)) {
        return;
    }
    event.preventDefault();
    prepareTrigger(trigger);
    openMessageMenu(trigger, { point: { x: event.clientX, y: event.clientY } });
}

function handleMenuKey(event) {
    const isMenuKey = event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey);
    if (!isMenuKey || isTypingTarget(document.activeElement)) {
        return;
    }
    const mes = asElement(document.activeElement)?.closest('#chat > .mes');
    const trigger = mes instanceof HTMLElement ? getMenuTrigger(mes) : null;
    if (!(trigger instanceof HTMLElement)) {
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    prepareTrigger(trigger);
    openMessageMenu(trigger, { keyboard: true });
}

function handleLayoutChange() {
    hideTooltip();
    setReveal(null);
    scheduleLayoutForAll();
}

function observeChat(chat) {
    new MutationObserver(records => {
        if (reveal && !reveal.host.isConnected) {
            reveal = null;
        }
        if (!isSettingExpanded() || isMobileLayout()) {
            return;
        }
        for (const record of records) {
            for (const node of record.addedNodes) {
                if (node instanceof HTMLElement && node.classList.contains('mes')) {
                    scheduleLayout(node);
                }
            }
        }
    }).observe(chat, { childList: true });

    new MutationObserver(() => {
        document.querySelectorAll(HINT_SELECTOR).forEach(hint => hint.hasAttribute('aria-haspopup') && syncHintTitle(hint));
        scheduleLayoutForAll();
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
}

export function initializeMessageActions() {
    if (initialized) {
        return;
    }
    const chat = document.getElementById('chat');
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
    window.addEventListener('keydown', handleMenuKey, true);
    document.addEventListener('keydown', handleRevealKeydown);
    document.addEventListener('pointerover', handlePointerOver, { passive: true });
    document.documentElement.addEventListener('pointerleave', handlePointerLeaveDocument);
    document.addEventListener('focusin', event => prepareTrigger(event.target));
    document.addEventListener('focusout', handleFocusOut);
    document.addEventListener('contextmenu', handleContextMenu);
    window.addEventListener('resize', () => scheduleLayoutForAll(), { passive: true });
    observeChat(chat);
    initializeConversationMessageMenu();

    const closeImmediately = () => closeActionMenu({ animate: false });
    // Dry runs (prompt/token previews) and auxiliary jobs also emit GENERATION_STARTED.
    eventSource.on(event_types.GENERATION_STARTED, (_type, options, dryRun) => {
        if (!dryRun && !options?.isAuxiliaryGeneration) {
            closeImmediately();
        }
    });
    eventSource.on(event_types.CHAT_CHANGED, () => {
        closeImmediately();
        setReveal(null);
        scheduleLayoutForAll();
    });
    for (const type of [event_types.CHARACTER_MESSAGE_RENDERED, event_types.USER_MESSAGE_RENDERED, event_types.MESSAGE_UPDATED, event_types.MESSAGE_SWIPED, event_types.MESSAGE_EDITED]) {
        eventSource.on(type, messageId => scheduleLayoutForMessage(messageId));
    }
    eventSource.on(event_types.GENERATION_ENDED, () => scheduleLayoutForAll());
    scheduleLayoutForAll();
}
