/*
 * Compact mobile bottom chat bar.
 * One chip row (persona, current chat, extension tray toggle) sits above the composer. The chat
 * chip opens a sheet with the chat picker and every chat action; the tray toggle reveals the
 * extension action buttons in place. Driven by sillybunny-mobile-section-nav.js.
 */

import { translate } from './i18n.js';
import { MOTION_EASE_OUT_CUBIC, MOTION_EASE_OUT_QUAD, MOTION_FAST, MOTION_SLOW, SPRING_SHEET, animateHeightFrom, animateIn, animateOut, originFrom, play, stopMotion } from './sillybunny-motion.js';

const SHEET_ID = 'sb-bottom-chat-sheet';
const SHEET_TITLE_ID = 'sb-bottom-chat-sheet-title';
const GG_CONTAINER_ID = 'gg-action-button-container';
const TRAY_SELECTOR = `#send_form > #${GG_CONTAINER_ID}, #send_form > .stih--buttons.stih--standalone`;
const FOCUSABLE_SELECTOR = 'button, select, input, textarea, [href], [tabindex]:not([tabindex="-1"])';

const state = {
    initialized: false,
    mobile: false,
    active: false,
    bar: null,
    select: null,
    chip: null,
    chipLabel: null,
    trayToggle: null,
    searchClose: null,
    sheet: null,
    sheetTitle: null,
    sheetSelectSlot: null,
    sheetActions: null,
    backdrop: null,
    moved: [],
    selectObserver: null,
    barObserver: null,
    trayObserver: null,
    trayFrame: 0,
    trayOpen: false,
    barHeight: Number.NaN,
    barResizeObserver: null,
    searchOpen: false,
};

function captureOriginalPlacement(element) {
    return { parent: element.parentElement, nextSibling: element.nextSibling };
}

function restoreOriginalPlacement(element, placement) {
    if (!placement?.parent?.isConnected) {
        return;
    }
    const nextSibling = placement.nextSibling?.parentNode === placement.parent
        ? placement.nextSibling
        : null;
    placement.parent.insertBefore(element, nextSibling);
}

// Upstream closes open drawers on html mousedown/touchstart (public/script.js); keep body-level
// layers out of that handler.
function blockUpstreamDrawerClose(element) {
    for (const type of ['mousedown', 'touchstart']) {
        element.addEventListener(type, event => event.stopPropagation(), { passive: true });
    }
}

function createIcon(iconClass) {
    const icon = document.createElement('i');
    icon.className = iconClass;
    icon.setAttribute('aria-hidden', 'true');
    return icon;
}

function createBarButton(className, iconClass, title) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `sb-bottom-chat-btn ${className}`;
    button.title = title;
    button.setAttribute('aria-label', title);
    button.append(createIcon(iconClass));
    return button;
}

function isVisible(element) {
    return element instanceof HTMLElement && element.getClientRects().length > 0;
}

function getFocusableSheetElements() {
    return [...state.sheet.querySelectorAll(FOCUSABLE_SELECTOR)]
        .filter(element => !element.disabled && isVisible(element));
}

function isSheetOpen() {
    return Boolean(state.sheet && !state.sheet.hidden);
}

function openSheet() {
    if (!state.active || isSheetOpen()) {
        return;
    }
    stopMotion(state.sheet);
    stopMotion(state.backdrop);
    state.sheet.hidden = false;
    state.backdrop.hidden = false;
    state.chip.setAttribute('aria-expanded', 'true');
    // AdwBottomSheet: rises from the bottom edge the chip sits on, over a fading scrim.
    animateIn(state.sheet, [{ transform: 'translateY(100%)' }, { transform: 'none' }], SPRING_SHEET);
    animateIn(state.backdrop, [{ opacity: 0 }, { opacity: 1 }], { duration: MOTION_FAST });
    requestAnimationFrame(() => state.sheetTitle.focus({ preventScroll: true }));
}

function closeSheet({ animate = true } = {}) {
    if (!isSheetOpen()) {
        return;
    }
    const activeElement = document.activeElement;
    const hadFocus = state.sheet.contains(activeElement) || activeElement === state.backdrop;
    // Sheet styles are mobile-scoped, so a desktop switch must hide it at once.
    const enabled = animate && state.mobile;
    animateOut(state.sheet, [{ transform: 'none' }, { transform: 'translateY(100%)' }], () => {
        state.sheet.hidden = true;
    }, { enabled });
    animateOut(state.backdrop, [{ opacity: 1 }, { opacity: 0 }], () => {
        state.backdrop.hidden = true;
    }, { enabled });
    state.chip?.setAttribute('aria-expanded', 'false');
    if (hadFocus && isVisible(state.chip)) {
        state.chip.focus({ preventScroll: true });
    }
}

function handleSheetKeydown(event) {
    if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeSheet();
        return;
    }
    if (event.key !== 'Tab') {
        return;
    }
    const focusable = getFocusableSheetElements();
    if (!focusable.length) {
        event.preventDefault();
        return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const activeElement = document.activeElement;
    if (event.shiftKey && (activeElement === first || activeElement === state.sheetTitle)) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && activeElement === last) {
        event.preventDefault();
        first.focus();
    }
}

function ensureSheet() {
    if (state.sheet) {
        return;
    }

    const backdrop = document.createElement('button');
    backdrop.type = 'button';
    backdrop.className = 'sb-bottom-chat-sheet-backdrop';
    backdrop.tabIndex = -1;
    backdrop.hidden = true;
    backdrop.setAttribute('aria-label', translate('Close chat actions'));
    backdrop.addEventListener('click', () => closeSheet());

    const sheet = document.createElement('div');
    sheet.id = SHEET_ID;
    sheet.className = 'sb-bottom-chat-sheet';
    sheet.hidden = true;
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-labelledby', SHEET_TITLE_ID);

    const header = document.createElement('div');
    header.className = 'sb-bottom-chat-sheet-header';
    const title = document.createElement('h2');
    title.id = SHEET_TITLE_ID;
    title.className = 'sb-bottom-chat-sheet-title';
    title.tabIndex = -1;
    title.textContent = translate('Chat actions');
    const closeButton = createBarButton('sb-bottom-chat-sheet-close', 'fa-solid fa-xmark', translate('Close chat actions'));
    closeButton.addEventListener('click', () => closeSheet());
    header.append(title, closeButton);

    const selectSlot = document.createElement('div');
    selectSlot.className = 'sb-bottom-chat-sheet-select';
    const actions = document.createElement('div');
    actions.className = 'sb-bottom-chat-sheet-actions';

    // Bubble-phase listeners run after the moved controls' own handlers.
    actions.addEventListener('click', event => {
        const button = event.target instanceof Element ? event.target.closest('button') : null;
        if (button && !button.disabled) {
            closeSheet();
        }
    });
    selectSlot.addEventListener('change', () => closeSheet());

    sheet.addEventListener('keydown', handleSheetKeydown);
    sheet.append(header, selectSlot, actions);
    blockUpstreamDrawerClose(backdrop);
    blockUpstreamDrawerClose(sheet);
    document.body.append(backdrop, sheet);

    Object.assign(state, { sheet, sheetTitle: title, sheetSelectSlot: selectSlot, sheetActions: actions, backdrop });
}

function syncChipLabel() {
    if (!state.chipLabel) {
        return;
    }
    const text = state.select?.selectedOptions?.[0]?.textContent?.trim() || translate('No chat selected');
    if (state.chipLabel.textContent !== text) {
        const hadLabel = Boolean(state.chipLabel.textContent);
        state.chipLabel.textContent = text;
        if (hadLabel && state.active) {
            animateIn(state.chipLabel, [
                { opacity: 0, transform: 'translateY(4px)' },
                { opacity: 1, transform: 'none' },
            ], { duration: MOTION_FAST, easing: MOTION_EASE_OUT_QUAD });
        }
    }
}

function ensureBarControls(bar) {
    if (!state.chip) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'sb-bottom-chat-chip';
        chip.setAttribute('aria-haspopup', 'dialog');
        chip.setAttribute('aria-expanded', 'false');
        chip.setAttribute('aria-controls', SHEET_ID);
        const label = document.createElement('span');
        label.className = 'sb-bottom-chat-chip-label';
        chip.append(createIcon('fa-solid fa-comments'), label, createIcon('fa-solid fa-chevron-up'));
        chip.addEventListener('click', () => (isSheetOpen() ? closeSheet() : openSheet()));

        const trayToggle = createBarButton('sb-bottom-chat-tray-toggle', 'fa-solid fa-puzzle-piece', translate('Extension actions'));
        trayToggle.hidden = true;
        trayToggle.setAttribute('aria-expanded', 'false');
        trayToggle.addEventListener('click', () => setTrayOpen(!state.trayOpen));

        const searchClose = createBarButton('sb-bottom-chat-search-close', 'fa-solid fa-xmark', translate('Close chat search'));
        searchClose.addEventListener('click', () => {
            document.querySelector('#sb-bottom-chat-sheet .sb-bottom-chat-search-toggle, #sb-bottom-chat-bar .sb-bottom-chat-search-toggle')?.click();
            state.chip.focus({ preventScroll: true });
        });

        Object.assign(state, { chip, chipLabel: label, trayToggle, searchClose });
    }

    const persona = bar.querySelector(':scope > #sb-persona-bubble');
    if (state.chip.parentElement !== bar) {
        if (persona) {
            persona.after(state.chip);
        } else {
            bar.prepend(state.chip);
        }
    }
    if (state.trayToggle.parentElement !== bar) {
        bar.append(state.trayToggle);
    }
    if (state.searchClose.parentElement !== bar) {
        bar.append(state.searchClose);
    }
}

function moveIntoSheet(element, parent) {
    state.moved.push({ element, placement: captureOriginalPlacement(element) });
    parent.append(element);
}

function restoreMoved() {
    for (const { element, placement } of state.moved.reverse()) {
        restoreOriginalPlacement(element, placement);
    }
    state.moved = [];
}

function attach() {
    const bar = document.getElementById('sb-bottom-chat-bar');
    const select = bar?.querySelector(':scope > #sb-bottom-chat-select');
    const navCluster = bar?.querySelector(':scope > .sb-bottom-chat-nav-actions');
    const managementCluster = bar?.querySelector('.sb-bottom-chat-management-actions');
    if (!bar || !select || !navCluster || !managementCluster) {
        return false;
    }

    ensureSheet();
    ensureBarControls(bar);
    state.bar = bar;
    state.select = select;
    moveIntoSheet(select, state.sheetSelectSlot);
    moveIntoSheet(navCluster, state.sheetActions);
    moveIntoSheet(managementCluster, state.sheetActions);

    state.selectObserver?.disconnect();
    state.selectObserver = new MutationObserver(syncChipLabel);
    state.selectObserver.observe(select, { childList: true, subtree: true, characterData: true });
    select.addEventListener('change', syncChipLabel);
    syncChipLabel();
    return true;
}

function detach() {
    closeSheet({ animate: false });
    state.selectObserver?.disconnect();
    state.selectObserver = null;
    state.select?.removeEventListener('change', syncChipLabel);
    restoreMoved();
    state.chip?.remove();
    state.trayToggle?.remove();
    state.searchClose?.remove();
    state.select = null;
}

// buildBottomChatBar() rebuilds with replaceChildren(); the controls parked in the sheet are
// then stale, so drop them and adopt the new ones.
function handleBarMutation() {
    if (state.mobile && !state.active) {
        state.active = attach();
    } else if (state.active && state.chip && state.chip.parentElement !== state.bar) {
        closeSheet({ animate: false });
        state.selectObserver?.disconnect();
        state.moved = [];
        state.sheetSelectSlot.replaceChildren();
        state.sheetActions.replaceChildren();
        state.active = attach();
    }
    syncSearchMotion();
    syncBarShown();
}

function syncBarShown() {
    const shown = state.active && Boolean(state.bar) && !state.bar.classList.contains('displayNone');
    document.documentElement.toggleAttribute('data-sb-mobile-chat-bar-shown', shown);
    if (!shown) {
        closeSheet();
    }
    scheduleTraySync();
}

function trayHasContent(element) {
    if (element.id === GG_CONTAINER_ID) {
        return !element.hidden && Boolean(element.querySelector('.gg-action-button, .stih--buttons:not(.stih--hidden), #qr--bar'));
    }
    return !element.classList.contains('stih--hidden');
}

function getTrayFrame(element) {
    const style = getComputedStyle(element);
    return {
        height: `${element.getBoundingClientRect().height}px`,
        paddingTop: style.paddingTop,
        paddingBottom: style.paddingBottom,
        opacity: 1,
        transform: 'none',
    };
}

const TRAY_COLLAPSED = { height: '0px', paddingTop: '0px', paddingBottom: '0px', opacity: 0, transform: 'scale(0.94)' };

// The tray unfolds out of its toggle (GtkRevealer slide plus a scale anchored on the button),
// so the chip row rises while the extension buttons grow from where the user tapped.
function setTrayOpen(open) {
    const wasOpen = state.trayOpen;
    state.trayOpen = Boolean(open);
    const trayElements = [...document.querySelectorAll(TRAY_SELECTOR)];
    if (!state.trayOpen && trayElements.some(element => element.contains(document.activeElement)) && isVisible(state.trayToggle)) {
        state.trayToggle.focus({ preventScroll: true });
    }
    trayElements.forEach(stopMotion);

    const animate = state.mobile && isVisible(state.trayToggle) && wasOpen !== state.trayOpen;
    const closing = animate && !state.trayOpen
        ? trayElements.filter(isVisible).map(element => ({
            element,
            display: getComputedStyle(element).display,
            frame: getTrayFrame(element),
            origin: originFrom(state.trayToggle, element),
        }))
        : [];

    document.documentElement.toggleAttribute('data-sb-mobile-tray-open', state.trayOpen);
    state.trayToggle?.setAttribute('aria-expanded', String(state.trayOpen));

    if (!animate) {
        return;
    }
    if (state.trayOpen) {
        for (const element of trayElements.filter(isVisible)) {
            play(element, [TRAY_COLLAPSED, getTrayFrame(element)], {
                duration: MOTION_SLOW,
                styles: { overflow: 'hidden', 'box-sizing': 'border-box', 'transform-origin': originFrom(state.trayToggle, element) },
            });
        }
        return;
    }
    for (const { element, display, frame, origin } of closing) {
        play(element, [frame, TRAY_COLLAPSED], {
            duration: MOTION_FAST,
            easing: MOTION_EASE_OUT_CUBIC,
            fill: 'forwards',
            inert: true,
            styles: { display, overflow: 'hidden', 'box-sizing': 'border-box', 'transform-origin': origin, 'pointer-events': 'none' },
        });
    }
}

function syncSearchMotion() {
    const open = Boolean(state.active && state.bar?.classList.contains('sb-bottom-chat-search-open'));
    if (open === state.searchOpen) {
        return;
    }
    state.searchOpen = open;
    if (!state.mobile) {
        return;
    }
    // ResizeObserver has not run for this change yet, so barHeight is still the old height.
    animateHeightFrom(state.bar, state.barHeight);
    if (open) {
        const field = state.bar.querySelector(':scope > .sb-bottom-chat-search-field');
        for (const element of [field, state.searchClose].filter(isVisible)) {
            animateIn(element, [
                { opacity: 0, transform: 'translateY(-6px)' },
                { opacity: 1, transform: 'none' },
            ], { duration: MOTION_SLOW });
        }
    }
}

function syncTray() {
    state.trayFrame = 0;
    if (!state.trayToggle) {
        return;
    }
    const trayElements = [...document.querySelectorAll(TRAY_SELECTOR)];
    const hasContent = state.active && trayElements.some(trayHasContent);
    state.trayToggle.hidden = !hasContent;
    if (document.getElementById(GG_CONTAINER_ID)) {
        state.trayToggle.setAttribute('aria-controls', GG_CONTAINER_ID);
    } else {
        state.trayToggle.removeAttribute('aria-controls');
    }
    if (!hasContent && state.trayOpen) {
        setTrayOpen(false);
    }
}

function scheduleTraySync() {
    if (!state.trayFrame) {
        state.trayFrame = requestAnimationFrame(syncTray);
    }
}

export function initializeMobileBottomBar() {
    if (state.initialized) {
        return;
    }
    state.initialized = true;

    const bar = document.getElementById('sb-bottom-chat-bar');
    if (bar) {
        state.bar = bar;
        state.barObserver = new MutationObserver(handleBarMutation);
        state.barObserver.observe(bar, { childList: true, attributes: true, attributeFilter: ['class'] });
        if (typeof ResizeObserver === 'function') {
            state.barResizeObserver = new ResizeObserver(() => {
                state.barHeight = bar.getBoundingClientRect().height;
            });
            state.barResizeObserver.observe(bar);
        }
    }

    const sendForm = document.getElementById('send_form');
    if (sendForm) {
        state.trayObserver = new MutationObserver(scheduleTraySync);
        state.trayObserver.observe(sendForm, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class'] });
    }
}

export function syncMobileBottomBar(isMobile) {
    if (!state.initialized) {
        return;
    }
    state.mobile = isMobile;
    if (isMobile && !state.active) {
        state.active = attach();
    } else if (!isMobile && state.active) {
        detach();
        state.active = false;
        setTrayOpen(false);
    }
    syncBarShown();
}
