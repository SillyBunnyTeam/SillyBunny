import { t } from '../i18n.js';
import { MOTION_EASE_OUT_CUBIC, MOTION_FAST, SPRING_SHEET, play, stopMotion } from '../sillybunny-motion.js';
import { bindHeaderLayout } from './dialog.js';
import { bindSheetGestures, createSheetHandle } from './sheet-gestures.js';

export const SIDE_PANEL_STYLESHEET = {
    href: 'css/sillybunny-side-panel.css?v=20261027b',
    id: 'deferred-side-panel-css',
};

const MIN_PANEL_WIDTH = 280;
const MAX_PANEL_WIDTH = 420;
const MIN_CHAT_WIDTH = 360;
const SHEET_COMPOSER_CLEARANCE = 6;
const PANEL_FOCUSABLE_SELECTOR = 'button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])';
const ROOT_LAYOUT_PROPERTIES = ['--sb-dock-start', '--sb-dock-end', '--sb-chat-offset', '--sb-chat-shift', '--sb-chat-width', '--sb-side-panel-width', '--sb-side-panel-chat-height'];
const sidePanels = new Map();

let nextPanelTitleId = 0;
let nextOpenOrder = 0;
let layoutObserver = null;
let rootStyleObserver = null;
let lastConfiguredChatWidth = '';
let windowEventsBound = false;
let resizeFrame = 0;
let pendingLayoutRevealTimer = 0;
let layoutSettled = Promise.resolve();
let getMovingUIState = () => ({});
let setMovingUIState = () => {};

function requireFiniteNumber(value, name, { allowZero = true } = {}) {
    if (!Number.isFinite(value) || value < 0 || (!allowZero && value === 0)) {
        throw new TypeError(`${name} must be a ${allowZero ? 'non-negative' : 'positive'} finite number`);
    }
    return value;
}

function normalizeSide(side) {
    if (side !== 'left' && side !== 'right') {
        throw new TypeError('Side panel side must be either "left" or "right"');
    }
    return side;
}

function clamp(value, minimum, maximum) {
    return Math.min(Math.max(value, minimum), maximum);
}

function resolvePersistedSide(state, defaultSide) {
    if (!state || typeof state !== 'object') {
        return defaultSide;
    }

    const leftIsUnset = state.left === 'unset' || state.left === undefined || state.left === null;
    const rightIsUnset = state.right === 'unset' || state.right === undefined || state.right === null;
    const leftIsOrigin = state.left === '0px' || state.left === '0' || state.left === 0;
    const rightIsOrigin = state.right === '0px' || state.right === '0' || state.right === 0;

    if (leftIsOrigin && !rightIsOrigin) return 'left';
    if (rightIsOrigin && !leftIsOrigin) return 'right';
    if (!leftIsUnset && rightIsUnset) return 'left';
    if (!rightIsUnset && leftIsUnset) return 'right';
    return defaultSide;
}

function validatePanelList(panels) {
    if (!Array.isArray(panels)) {
        throw new TypeError('panels must be an array');
    }

    const ids = new Set();
    return panels.map(panel => {
        if (!panel || typeof panel.id !== 'string' || panel.id.trim() === '') {
            throw new TypeError('Every open side panel must have a non-empty id');
        }
        if (ids.has(panel.id)) {
            throw new TypeError(`Duplicate open side panel id: ${panel.id}`);
        }
        ids.add(panel.id);
        return { id: panel.id, side: normalizeSide(panel.side) };
    });
}

export function computeSidePanelLayout({ viewport, chat, topBarHeight, panels }) {
    if (!viewport || typeof viewport !== 'object') {
        throw new TypeError('viewport must provide width and height');
    }
    if (!chat || typeof chat !== 'object') {
        throw new TypeError('chat must provide its unoccluded width');
    }

    const viewportWidth = requireFiniteNumber(viewport.width, 'viewport.width', { allowZero: false });
    const viewportHeight = requireFiniteNumber(viewport.height, 'viewport.height', { allowZero: false });
    const chatWidth = requireFiniteNumber(chat.width, 'chat.width');
    const headerHeight = requireFiniteNumber(topBarHeight, 'topBarHeight');
    const openPanels = validatePanelList(panels);
    const centeredChatLeft = (viewportWidth - chatWidth) / 2;
    const normalChatRect = {
        x: centeredChatLeft,
        y: headerHeight,
        width: chatWidth,
        height: Math.max(0, viewportHeight - headerHeight),
    };

    if (openPanels.length === 0) {
        return {
            mode: 'none',
            panelWidth: 0,
            panelRects: {},
            panelModes: {},
            sheetPanelId: null,
            chatRect: normalChatRect,
            chatOffset: centeredChatLeft,
            chatWidth,
            dockStart: 0,
            dockEnd: 0,
            chatShift: 0,
        };
    }

    const panelWidth = clamp((viewportWidth - chatWidth) / 2, MIN_PANEL_WIDTH, MAX_PANEL_WIDTH);
    const leftPanels = openPanels.filter(panel => panel.side === 'left');
    const rightPanels = openPanels.filter(panel => panel.side === 'right');
    const dockStart = leftPanels.length > 0 ? panelWidth : 0;
    const dockEnd = rightPanels.length > 0 ? panelWidth : 0;
    const availableChatWidth = viewportWidth - dockStart - dockEnd;
    const chatFitsAtConfiguredWidth = chatWidth <= availableChatWidth;
    const laidOutChatWidth = chatFitsAtConfiguredWidth ? chatWidth : availableChatWidth;
    const laidOutChatLeft = chatFitsAtConfiguredWidth
        ? clamp(centeredChatLeft, dockStart, viewportWidth - dockEnd - chatWidth)
        : dockStart;

    if (laidOutChatWidth < MIN_CHAT_WIDTH) {
        const sheetPanelId = openPanels.at(-1).id;
        return {
            mode: 'sheet',
            panelWidth,
            panelRects: {},
            panelModes: Object.fromEntries(openPanels.map(panel => [panel.id, panel.id === sheetPanelId ? 'sheet' : 'hidden'])),
            sheetPanelId,
            chatRect: normalChatRect,
            chatOffset: centeredChatLeft,
            chatWidth,
            dockStart: 0,
            dockEnd: 0,
            chatShift: 0,
        };
    }

    const panelRects = {};
    const panelModes = {};
    const panelHeight = Math.max(0, viewportHeight - headerHeight);

    for (const [side, sidePanels] of [['left', leftPanels], ['right', rightPanels]]) {
        sidePanels.forEach((panel, index) => {
            const x = side === 'left' ? 0 : viewportWidth - panelWidth;
            const height = panelHeight / sidePanels.length;
            panelRects[panel.id] = {
                x,
                y: headerHeight + height * index,
                width: panelWidth,
                height,
            };
            panelModes[panel.id] = 'docked';
        });
    }

    return {
        mode: 'docked',
        panelWidth,
        panelRects,
        panelModes,
        sheetPanelId: null,
        chatRect: {
            x: laidOutChatLeft,
            y: headerHeight,
            width: laidOutChatWidth,
            height: Math.max(0, viewportHeight - headerHeight),
        },
        chatOffset: laidOutChatLeft,
        chatWidth: laidOutChatWidth,
        dockStart,
        dockEnd,
        chatShift: laidOutChatLeft - (viewportWidth - laidOutChatWidth) / 2,
    };
}

function createElement(tagName, className, text = '') {
    const element = document.createElement(tagName);
    element.className = className;
    if (text) element.textContent = text;
    return element;
}

function createIconButton({ className, iconName, label }) {
    const button = createElement('button', className);
    button.type = 'button';
    button.title = label;
    button.setAttribute('aria-label', label);
    const icon = createElement('i', `fa-solid fa-${iconName}`);
    icon.setAttribute('aria-hidden', 'true');
    button.append(icon);
    return button;
}

function createPanelShell({ id, element, title }) {
    const panel = document.createElement('aside');
    panel.className = 'sb-side-panel sb-dialog sb-dialog--window';
    panel.dataset.sbSidePanelId = id;
    panel.hidden = true;
    panel.setAttribute('role', 'complementary');

    const titleNodeId = `sb-side-panel-title-${++nextPanelTitleId}`;
    panel.setAttribute('aria-labelledby', titleNodeId);

    const header = createElement('header', 'sb-dialog__header sb-side-panel__header');
    const start = createElement('div', 'sb-dialog__header-start');
    const titles = createElement('div', 'sb-dialog__titles');
    const titleNode = createElement('h2', 'sb-dialog__title sb-side-panel__title', title);
    titleNode.id = titleNodeId;
    titles.append(titleNode);
    const controls = createElement('div', 'sb-dialog__header-end sb-side-panel__controls');

    const panelMenuLabel = t`Menu`;
    const menuButton = createIconButton({
        className: 'sb-dialog__icon-button sb-dialog__menu sb-side-panel__icon-button sb-side-panel__menu-trigger',
        iconName: 'ellipsis-vertical',
        label: panelMenuLabel,
    });
    menuButton.setAttribute('aria-haspopup', 'menu');
    menuButton.setAttribute('aria-expanded', 'false');

    const moveSideLabel = t`Move to Other Side`;
    const menu = createElement('div', 'sb-side-panel__menu');
    menu.setAttribute('role', 'menu');
    menu.hidden = true;
    const moveSideButton = createElement('button', 'sb-side-panel__menu-item', moveSideLabel);
    moveSideButton.type = 'button';
    moveSideButton.setAttribute('role', 'menuitem');
    menu.append(moveSideButton);

    const closeButton = createIconButton({
        className: 'sb-dialog__icon-button sb-dialog__close sb-side-panel__icon-button sb-side-panel__close',
        iconName: 'xmark',
        label: t`Close`,
    });

    controls.append(menuButton, closeButton);
    header.append(start, titles, controls, menu);

    const grabHandle = createSheetHandle();
    const body = createElement('div', 'sb-dialog__body sb-side-panel__body');
    const content = createElement('div', 'sb-side-panel__content');
    content.append(element);
    body.append(content);
    panel.append(grabHandle, header, body);

    return { panel, header, unbindHeaderLayout: bindHeaderLayout(header), menuButton, menu, moveSideButton, closeButton, body, content };
}

function getPanelRoot() {
    return document.getElementById('movingDivs') ?? document.body;
}

function resolveChatWidth(viewportWidth) {
    const chatShell = document.getElementById('sheld');
    if (!chatShell) return viewportWidth;

    const isFullWidthBreakpoint = viewportWidth <= 768 || (viewportWidth >= 769 && viewportWidth <= 1180);
    if (isFullWidthBreakpoint) return viewportWidth;

    const root = document.documentElement;
    const probe = document.createElement('div');
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    probe.style.pointerEvents = 'none';
    probe.style.width = 'var(--sheldWidth)';
    root.append(probe);
    const configuredWidth = probe.getBoundingClientRect().width;
    probe.remove();

    return configuredWidth || chatShell.getBoundingClientRect().width || viewportWidth;
}

function readLayoutInputs(openPanels) {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const chat = { width: resolveChatWidth(viewport.width) };
    const chatShell = document.getElementById('sheld');
    const configuredOffset = getComputedStyle(document.documentElement).getPropertyValue('--sb-topbar-layout-offset').trim();
    const offsetProbe = document.createElement('div');
    offsetProbe.style.position = 'absolute';
    offsetProbe.style.visibility = 'hidden';
    offsetProbe.style.height = 'var(--sb-topbar-layout-offset)';
    document.documentElement.append(offsetProbe);
    const resolvedOffset = offsetProbe.getBoundingClientRect().height;
    offsetProbe.remove();
    const topBarHeight = chatShell?.getBoundingClientRect().top || resolvedOffset || Number.parseFloat(configuredOffset) || 0;
    return { viewport, chat, topBarHeight, panels: openPanels };
}

function openEntries() {
    return [...sidePanels.values()].filter(entry => entry.isOpen).sort((left, right) => left.openedAt - right.openedAt);
}

function closeEntry(entry, { restoreFocus = false, notify = true } = {}) {
    if (!entry.isOpen) return;
    entry.isOpen = false;
    stopMotion(entry.panel);
    entry.panel.style.removeProperty('transform');
    entry.shell.panel.hidden = true;
    entry.shell.menu.hidden = true;
    entry.shell.menuButton.setAttribute('aria-expanded', 'false');

    if (notify && !entry.isClosing) {
        entry.isClosing = true;
        try {
            entry.onClose?.();
        } finally {
            entry.isClosing = false;
        }
    }

    if (restoreFocus && entry.opener?.isConnected) {
        entry.opener.focus({ preventScroll: true });
    }
}

function movePanelToDockRoot(entry) {
    const root = getPanelRoot();
    if (entry.panel.parentElement !== root) root.append(entry.panel);
}

function movePanelToSheetRoot(entry) {
    const chatShell = document.getElementById('sheld');
    const composer = document.getElementById('form_sheld');
    if (!chatShell || !composer) {
        movePanelToDockRoot(entry);
        return;
    }
    if (entry.panel.parentElement !== chatShell) chatShell.insertBefore(entry.panel, composer);
}

function applySheetGeometry(entry) {
    const chatShell = document.getElementById('sheld');
    const chat = document.getElementById('chat');
    const composer = document.getElementById('form_sheld');
    if (!chatShell || !chat || !composer) return;

    const shellRect = chatShell.getBoundingClientRect();
    const composerRect = composer.getBoundingClientRect();
    const availableHeight = Math.max(0, composerRect.top - shellRect.top - SHEET_COMPOSER_CLEARANCE);
    const sheetHeight = Math.min(window.innerHeight / 2, availableHeight);
    const panelTop = Math.max(shellRect.top, composerRect.top - sheetHeight - SHEET_COMPOSER_CLEARANCE);
    const chatHeight = Math.max(0, panelTop - shellRect.top);
    entry.panel.style.setProperty('--sb-side-panel-sheet-height', `${sheetHeight}px`);
    entry.panel.style.setProperty('--sb-side-panel-sheet-top', `${panelTop}px`);
    chat.style.setProperty('--sb-side-panel-chat-height', `${chatHeight}px`);
}

// This is not a CSS animation because a CSS animation overrides the inline transform that a drag sets. The motion helper lets a drag cancel the entry, so the sheet follows the finger at once.
function playSheetEntry(panel) {
    play(panel, [{ opacity: 0, transform: 'translateY(12px)' }, { opacity: 1, transform: 'none' }], SPRING_SHEET);
}

/** Slides the sheet down from where the finger left it, then closes through the normal path. */
function slideSheetOut(entry) {
    return new Promise(resolve => {
        const from = entry.panel.style.transform || 'none';
        entry.panel.style.removeProperty('transform');
        // Without motion, play() ends at once and the panel closes without a slide.
        play(entry.panel, [{ transform: from }, { transform: 'translateY(100%)' }], {
            duration: MOTION_FAST,
            easing: MOTION_EASE_OUT_CUBIC,
            fill: 'forwards',
            inert: true,
            onEnd: () => resolve(closeSidePanel(entry.id)),
        });
    });
}

function applyPanelRect(entry, rect) {
    entry.panel.style.setProperty('--sb-side-panel-x', `${rect.x}px`);
    entry.panel.style.setProperty('--sb-side-panel-y', `${rect.y}px`);
    entry.panel.style.setProperty('--sb-side-panel-width', `${rect.width}px`);
    entry.panel.style.setProperty('--sb-side-panel-height', `${rect.height}px`);
}

function notifySidePanelLayoutChanged() {
    window.dispatchEvent(new Event('sb:side-panel-layout'));
}

function deferPanelRevealUntilChatSettles(open, chatShell, targetRect) {
    if (pendingLayoutRevealTimer) return layoutSettled;
    const currentRect = chatShell.getBoundingClientRect();
    const chatIsMoving = Math.abs(currentRect.left - targetRect.x) > 1 || Math.abs(currentRect.width - targetRect.width) > 1;
    if (!chatIsMoving) return Promise.resolve();

    const reduceMotion = document.body.classList.contains('reduced-motion') || matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion) return Promise.resolve();

    open.forEach(entry => { entry.panel.style.visibility = 'hidden'; });
    layoutSettled = new Promise(resolve => {
        const reveal = () => {
            clearTimeout(pendingLayoutRevealTimer);
            pendingLayoutRevealTimer = 0;
            chatShell.removeEventListener('transitionend', onTransitionEnd);
            for (const entry of sidePanels.values()) {
                entry.panel.style.removeProperty('visibility');
            }
            resolve();
        };
        const onTransitionEnd = event => {
            if (event.target === chatShell && ['transform', 'width'].includes(event.propertyName)) reveal();
        };
        chatShell.addEventListener('transitionend', onTransitionEnd);
        pendingLayoutRevealTimer = setTimeout(reveal, 300);
    });
    return layoutSettled;
}

function updateLayout() {
    const root = document.documentElement;
    const body = document.body;
    const open = openEntries();

    if (open.length === 0) {
        body.classList.remove('sb-has-docked-panel', 'sb-has-side-panel-sheet');
        for (const property of ROOT_LAYOUT_PROPERTIES) root.style.removeProperty(property);
        document.getElementById('chat')?.style.removeProperty('--sb-side-panel-chat-height');
        for (const entry of sidePanels.values()) {
            entry.panel.classList.remove('sb-side-panel--sheet', 'sb-side-panel--left', 'sb-side-panel--right');
            entry.panel.style.removeProperty('--sb-side-panel-x');
            entry.panel.style.removeProperty('--sb-side-panel-y');
            entry.panel.style.removeProperty('--sb-side-panel-width');
            entry.panel.style.removeProperty('--sb-side-panel-height');
            entry.panel.style.removeProperty('--sb-side-panel-sheet-height');
            entry.panel.style.removeProperty('--sb-side-panel-sheet-top');
            if (entry.panel.parentElement !== entry.originalParent) {
                const insertionPoint = entry.originalPlaceholder?.parentElement === entry.originalParent
                    ? entry.originalPlaceholder
                    : entry.originalNextSibling?.parentElement === entry.originalParent ? entry.originalNextSibling : null;
                entry.originalParent?.insertBefore(entry.panel, insertionPoint);
            }
        }
        layoutObserver?.disconnect();
        layoutObserver = null;
        rootStyleObserver?.disconnect();
        rootStyleObserver = null;
        if (windowEventsBound) {
            window.removeEventListener('resize', scheduleLayout);
            window.removeEventListener('orientationchange', scheduleLayout);
            windowEventsBound = false;
        }
        notifySidePanelLayoutChanged();
        return;
    }

    let layout = computeSidePanelLayout(readLayoutInputs(open.map(entry => ({ id: entry.id, side: entry.side }))));
    if (layout.mode === 'sheet' && open.length > 1) {
        const visibleEntry = open.at(-1);
        open.slice(0, -1).forEach(entry => closeEntry(entry, { notify: true }));
        layout = computeSidePanelLayout(readLayoutInputs([{ id: visibleEntry.id, side: visibleEntry.side }]));
    }

    if (layout.mode === 'sheet') {
        const activeEntry = sidePanels.get(layout.sheetPanelId);
        const isEntering = Boolean(activeEntry) && !activeEntry.panel.classList.contains('sb-side-panel--sheet');
        body.classList.remove('sb-has-docked-panel');
        body.classList.add('sb-has-side-panel-sheet');
        for (const property of ROOT_LAYOUT_PROPERTIES) root.style.removeProperty(property);
        for (const entry of sidePanels.values()) {
            entry.panel.dataset.sbSidePanelSide = entry.side;
            entry.panel.classList.remove('sb-side-panel--left', 'sb-side-panel--right');
            entry.panel.classList.toggle('sb-side-panel--sheet', entry === activeEntry);
            if (entry !== activeEntry) {
                entry.panel.hidden = true;
                continue;
            }
            movePanelToSheetRoot(entry);
            entry.panel.hidden = false;
        }
        if (activeEntry) applySheetGeometry(activeEntry);
        if (isEntering) playSheetEntry(activeEntry.panel);
        notifySidePanelLayoutChanged();
        return;
    }

    const chatShell = document.getElementById('sheld');
    if (chatShell) deferPanelRevealUntilChatSettles(open, chatShell, layout.chatRect);
    const chatShellRect = chatShell?.getBoundingClientRect();
    if (chatShellRect && Number.isFinite(chatShellRect.top) && Number.isFinite(chatShellRect.bottom)) {
        for (const side of ['left', 'right']) {
            const sidePanels = open.filter(entry => entry.side === side);
            const panelHeight = Math.max(0, chatShellRect.height / sidePanels.length);
            sidePanels.forEach((entry, index) => {
                const rect = layout.panelRects[entry.id];
                if (!rect) return;
                rect.y = chatShellRect.top + panelHeight * index;
                rect.height = panelHeight;
            });
        }
    }
    body.classList.remove('sb-has-side-panel-sheet');
    body.classList.add('sb-has-docked-panel');
    root.style.setProperty('--sb-dock-start', `${layout.dockStart}px`);
    root.style.setProperty('--sb-dock-end', `${layout.dockEnd}px`);
    root.style.setProperty('--sb-chat-offset', `${layout.chatOffset}px`);
    root.style.setProperty('--sb-chat-shift', `${layout.chatShift}px`);
    root.style.setProperty('--sb-chat-width', `${layout.chatWidth}px`);
    root.style.setProperty('--sb-side-panel-width', `${layout.panelWidth}px`);
    document.getElementById('chat')?.style.removeProperty('--sb-side-panel-chat-height');

    for (const entry of sidePanels.values()) {
        entry.panel.dataset.sbSidePanelSide = entry.side;
        const rect = layout.panelRects[entry.id];
        if (entry.panel.classList.contains('sb-side-panel--sheet')) {
            stopMotion(entry.panel);
            entry.panel.style.removeProperty('transform');
            entry.panel.classList.remove('sb-side-panel--sheet');
        }
        entry.panel.style.removeProperty('--sb-side-panel-sheet-height');
        entry.panel.style.removeProperty('--sb-side-panel-sheet-top');
        entry.panel.classList.toggle('sb-side-panel--left', entry.side === 'left');
        entry.panel.classList.toggle('sb-side-panel--right', entry.side === 'right');
        if (!entry.isOpen || !rect) {
            entry.panel.hidden = true;
            continue;
        }
        movePanelToDockRoot(entry);
        applyPanelRect(entry, rect);
        entry.panel.hidden = false;
    }
    notifySidePanelLayoutChanged();
}

function scheduleLayout() {
    if (resizeFrame) return;
    resizeFrame = requestAnimationFrame(() => {
        resizeFrame = 0;
        updateLayout();
    });
}

function observeLayoutChanges() {
    if (!layoutObserver && typeof ResizeObserver !== 'undefined') {
        layoutObserver = new ResizeObserver(scheduleLayout);
        for (const id of ['sheld', 'top-bar', 'form_sheld']) {
            const element = document.getElementById(id);
            if (element) layoutObserver.observe(element);
        }
    }
    if (!windowEventsBound) {
        window.addEventListener('resize', scheduleLayout, { passive: true });
        window.addEventListener('orientationchange', scheduleLayout, { passive: true });
        windowEventsBound = true;
    }

    if (!rootStyleObserver) {
        lastConfiguredChatWidth = document.documentElement.style.getPropertyValue('--sheldWidth');
        rootStyleObserver = new MutationObserver(() => {
            const configuredChatWidth = document.documentElement.style.getPropertyValue('--sheldWidth');
            if (configuredChatWidth === lastConfiguredChatWidth) return;
            lastConfiguredChatWidth = configuredChatWidth;
            scheduleLayout();
        });
        rootStyleObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
    }
}

function focusPanel(entry) {
    const focusable = [...entry.shell.content.querySelectorAll(PANEL_FOCUSABLE_SELECTOR)]
        .find(element => element.getClientRects().length > 0 && !element.closest('[hidden], [inert]'));
    const target = focusable ?? entry.shell.closeButton;
    target.focus({ preventScroll: true });
}

function setMenuOpen(entry, isOpen, { focusItem = false } = {}) {
    entry.shell.menu.hidden = !isOpen;
    entry.shell.menuButton.setAttribute('aria-expanded', String(isOpen));
    if (isOpen && focusItem) entry.shell.moveSideButton.focus({ preventScroll: true });
    if (!isOpen) entry.shell.menuButton.focus({ preventScroll: true });
}

function movePanelToOtherSide(entry) {
    entry.side = entry.side === 'left' ? 'right' : 'left';
    const movingUIState = getMovingUIState() ?? {};
    movingUIState[entry.id] = {
        left: entry.side === 'left' ? '0px' : 'unset',
        right: entry.side === 'right' ? '0px' : 'unset',
    };
    setMovingUIState(movingUIState);
    updateLayout();
}

function bindPanelControls(entry) {
    entry.shell.menuButton.addEventListener('click', () => {
        setMenuOpen(entry, entry.shell.menu.hidden, { focusItem: entry.shell.menu.hidden });
    });
    entry.shell.moveSideButton.addEventListener('click', () => {
        entry.shell.menu.hidden = true;
        entry.shell.menuButton.setAttribute('aria-expanded', 'false');
        entry.shell.menuButton.focus({ preventScroll: true });
        movePanelToOtherSide(entry);
    });
    entry.shell.closeButton.addEventListener('click', () => closeSidePanel(entry.id));
    entry.unbindSheetGestures = bindSheetGestures({
        surface: entry.panel,
        targets: [entry.panel],
        startSelector: '.sb-side-panel > .sb-dialog__handle, .sb-side-panel > .sb-side-panel__header',
        isActive: () => entry.panel.classList.contains('sb-side-panel--sheet'),
        requestClose: () => slideSheetOut(entry),
    });
    entry.outsidePointerListener = event => {
        if (!entry.shell.menu.hidden && !entry.panel.contains(event.target)) {
            entry.shell.menu.hidden = true;
            entry.shell.menuButton.setAttribute('aria-expanded', 'false');
        }
    };
    document.addEventListener('pointerdown', entry.outsidePointerListener, true);
}

function isVisibleSurface(element) {
    if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;

    const style = getComputedStyle(element);
    return element.getClientRects().length > 0 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0;
}

function hasHigherPriorityEscapeSurface(event, entry) {
    if (event.defaultPrevented || event.isComposing || document.querySelector('dialog[open]')) {
        return true;
    }

    const openModal = [...document.querySelectorAll('[aria-modal="true"]')].find(isVisibleSurface);
    if (openModal) return true;

    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement && (activeElement.matches('input, textarea, select') || activeElement.isContentEditable)) {
        return true;
    }

    const openOverlay = [...document.querySelectorAll('[role="menu"], [role="listbox"], .sb-picker, .sb-picker-sheet, .sb-action-popover, .sb-action-sheet, .sb-model-id-picker-menu')]
        .find(element => element !== entry.shell.menu && isVisibleSurface(element));
    return Boolean(openOverlay);
}

export function closeTopmostSidePanelOnEscape(event) {
    if (event.key !== 'Escape') return false;

    const activeEntry = openEntries().at(-1);
    if (!activeEntry || hasHigherPriorityEscapeSurface(event, activeEntry)) return false;

    event.preventDefault();
    if (!activeEntry.shell.menu.hidden) {
        setMenuOpen(activeEntry, false);
        return true;
    }

    closeSidePanel(activeEntry.id);
    return true;
}

export function configureMovingUIState({ getState, setState }) {
    if (typeof getState !== 'function' || typeof setState !== 'function') {
        throw new TypeError('MovingUI side-panel access requires getState and setState functions');
    }
    getMovingUIState = getState;
    setMovingUIState = setState;
}

export function registerSidePanel({ id, element, title, defaultSide, onClose }) {
    if (typeof id !== 'string' || id.trim() === '') throw new TypeError('Side panel id must be a non-empty string');
    if (!(element instanceof HTMLElement)) throw new TypeError('Side panel element must be an HTMLElement');
    if (typeof title !== 'string' || title.trim() === '') throw new TypeError('Side panel title must be a non-empty string');
    if (typeof onClose !== 'undefined' && typeof onClose !== 'function') throw new TypeError('onClose must be a function when provided');
    const normalizedDefaultSide = normalizeSide(defaultSide);
    if (sidePanels.has(id)) throw new Error(`Side panel is already registered: ${id}`);
    if (!element.parentElement) throw new Error(`Side panel element must be attached before registration: ${id}`);

    const originalParent = element.parentElement;
    const originalNextSibling = element.nextSibling;
    const originalPlaceholder = document.createComment('');
    originalParent.insertBefore(originalPlaceholder, element);
    const originalDisplay = element.style.display;
    const originalClass = element.classList.contains('sb-side-panel__source');
    const originalPanelId = element.dataset.sbSidePanelId;
    const shell = createPanelShell({ id, element, title });
    const entry = {
        id,
        element,
        title,
        defaultSide: normalizedDefaultSide,
        side: resolvePersistedSide(getMovingUIState()?.[id], normalizedDefaultSide),
        onClose,
        originalParent,
        originalNextSibling,
        originalPlaceholder,
        originalDisplay,
        originalClass,
        originalPanelId,
        shell,
        panel: shell.panel,
        isOpen: false,
        isClosing: false,
        openedAt: 0,
        opener: null,
        styleError: null,
        unbindSheetGestures: () => {},
    };
    entry.panel.dataset.sbSidePanelSide = entry.side;

    originalParent.insertBefore(entry.panel, originalPlaceholder);
    element.classList.add('sb-side-panel__source');
    element.dataset.sbSidePanelId = id;
    element.style.display = 'flex';
    sidePanels.set(id, entry);
    bindPanelControls(entry);
    observeLayoutChanges();

    const loader = globalThis.SillyBunnyAssets?.loadStylesheetAsync;
    entry.stylesReady = loader
        ? Promise.resolve().then(() => loader(SIDE_PANEL_STYLESHEET.href, { id: SIDE_PANEL_STYLESHEET.id })).catch(error => {
            entry.styleError = error;
        })
        : Promise.resolve();

    return Object.freeze({
        get isOpen() { return entry.isOpen; },
        open: options => openSidePanel(id, options),
        close: options => closeSidePanel(id, options),
        moveToOtherSide: () => movePanelToOtherSide(entry),
        unregister: () => unregisterSidePanel(id),
    });
}

export async function openSidePanel(id, { opener = document.activeElement } = {}) {
    const entry = sidePanels.get(id);
    if (!entry) throw new Error(`Side panel is not registered: ${id}`);
    await entry.stylesReady;
    if (entry.styleError) throw entry.styleError;

    entry.opener = opener instanceof HTMLElement ? opener : null;
    entry.openedAt = ++nextOpenOrder;
    entry.isOpen = true;
    entry.element.style.display = 'flex';
    entry.panel.hidden = false;
    observeLayoutChanges();
    updateLayout();
    await layoutSettled;
    await new Promise(resolve => requestAnimationFrame(resolve));
    if (entry.isOpen) focusPanel(entry);
    return entry.panel;
}

export function closeSidePanel(id, { restoreFocus = true, notify = true } = {}) {
    const entry = sidePanels.get(id);
    if (!entry) return false;
    closeEntry(entry, { restoreFocus, notify });
    updateLayout();
    return true;
}

export function unregisterSidePanel(id) {
    const entry = sidePanels.get(id);
    if (!entry) return false;
    closeEntry(entry, { restoreFocus: false, notify: false });
    document.removeEventListener('pointerdown', entry.outsidePointerListener, true);
    entry.unbindSheetGestures();
    entry.shell.unbindHeaderLayout();
    entry.element.classList.toggle('sb-side-panel__source', entry.originalClass);
    if (entry.originalPanelId === undefined) delete entry.element.dataset.sbSidePanelId;
    else entry.element.dataset.sbSidePanelId = entry.originalPanelId;
    entry.element.style.display = entry.originalDisplay;
    entry.originalParent.insertBefore(entry.element, entry.originalPlaceholder.parentElement === entry.originalParent ? entry.originalPlaceholder : null);
    entry.originalPlaceholder.remove();
    entry.panel.remove();
    sidePanels.delete(id);
    updateLayout();
    return true;
}

export function applyMovingUIState(id, state) {
    const entry = sidePanels.get(id);
    if (!entry) return false;
    entry.side = resolvePersistedSide(state, entry.defaultSide);
    updateLayout();
    return true;
}

export function resetSidePanelSides() {
    for (const entry of sidePanels.values()) entry.side = entry.defaultSide;
    updateLayout();
}

export function isSidePanelElement(element) {
    return element instanceof HTMLElement && Boolean(element.closest('.sb-side-panel'));
}

export function refreshSidePanelLayout() {
    updateLayout();
}

globalThis.SillyBunnySidePanels = {
    registerSidePanel,
    openSidePanel,
    closeSidePanel,
    computeSidePanelLayout,
    applyMovingUIState,
    resetSidePanelSides,
    isSidePanelElement,
    closeTopmostSidePanelOnEscape,
    refreshSidePanelLayout,
};
