/*
 * Mobile section navigation for the Workspace, Customize and Characters shells.
 * Replaces the scrolling tab strip with a header section menu, and remembers each panel's
 * last mobile view in memory until the application is refreshed. Desktop keeps the original
 * shell layout.
 */

import { t, translate } from './i18n.js';
import { initializeMobileBottomBar, syncMobileBottomBar } from './sillybunny-mobile-bottom-bar.js';
import { MOTION_EASE_OUT_QUAD, MOTION_FAST, MOTION_POPOVER_CLOSE, SPRING_NAVIGATION, animateIn, animateOut, morphFrom, originFrom, stopMotion } from './sillybunny-motion.js';

const PANEL_CONFIGS = [
    {
        id: 'workspace',
        shellKey: 'left',
        title: 'Workspace',
        rootSelectors: ['#left-nav-panel.sb-shell-root', '#left-nav-panel'],
        navSelector: 'nav.sb-shell-nav[role="tablist"]',
        tabSelector: '[role="tab"][data-sb-tab]',
        tabAttribute: 'data-sb-tab',
    },
    {
        id: 'customize',
        shellKey: 'right',
        title: 'Customize',
        rootSelectors: ['#user-settings-block.sb-shell-root', '#user-settings-block'],
        navSelector: 'nav.sb-shell-nav[role="tablist"]',
        tabSelector: '[role="tab"][data-sb-tab]',
        tabAttribute: 'data-sb-tab',
    },
    {
        id: 'characters',
        shellKey: 'characters',
        title: 'Characters',
        rootSelectors: ['#right-nav-panel.sb-character-drawer-root', '#right-nav-panel.sb-shell-root', '#right-nav-panel'],
        navSelector: '.sb-character-shell-nav[role="tablist"]',
        tabSelector: '[role="tab"][data-sb-character-tab]',
        tabAttribute: 'data-sb-character-tab',
    },
];

const MOBILE_QUERY = '(max-width: 768px)';

const state = {
    panels: new Map(),
    pendingMobileViews: new Map(),
    initialized: false,
};

function isMobileViewport() {
    return window.matchMedia(MOBILE_QUERY).matches;
}

function isPanelOpen(panel) {
    return panel.root.classList.contains('openDrawer');
}

function focusElement(element) {
    if (element?.isConnected) {
        element.focus({ preventScroll: true });
    }
}

function captureOriginalPlacement(element) {
    return element
        ? { parent: element.parentElement, nextSibling: element.nextSibling }
        : null;
}

function restoreOriginalPlacement(element, placement) {
    if (!element || !placement?.parent?.isConnected) {
        return;
    }

    const nextSibling = placement.nextSibling?.parentNode === placement.parent
        ? placement.nextSibling
        : null;
    placement.parent.insertBefore(element, nextSibling);
}

// The shell focuses its own header title in rAF callbacks; run after those settle.
function afterAppFocus(callback) {
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(callback, 60)));
}

// Upstream closes every open drawer on html touchstart/mousedown outside .openDrawer
// (public/script.js). Section menus must not reach that handler.
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

function findRoot(config) {
    for (const selector of config.rootSelectors) {
        const match = [...document.querySelectorAll(selector)]
            .find(element => element.querySelector(config.navSelector) && element.querySelector('.sb-shell-header'));
        if (match) {
            return match;
        }
    }
    return null;
}

function getPanelTabs(panel) {
    const seenIds = new Set();
    const tabs = [];
    for (const button of panel.root.querySelectorAll(`${panel.config.navSelector} ${panel.config.tabSelector}`)) {
        const id = button.getAttribute(panel.config.tabAttribute);
        if (!id || seenIds.has(id)) {
            continue;
        }
        seenIds.add(id);
        tabs.push({
            id,
            label: button.querySelector('.sb-shell-tab-copy strong')?.textContent?.trim() || button.textContent.trim() || translate('Section'),
            iconClass: button.querySelector('i')?.className || 'fa-solid fa-circle',
            button,
        });
    }
    return tabs;
}

function getActiveTab(tabs) {
    return tabs.find(tab => tab.button.getAttribute('aria-selected') === 'true') ?? tabs[0] ?? null;
}

function getMenuItems(panel) {
    return [...panel.menu.querySelectorAll('.sb-section-nav-menu-item')];
}

function createMenuItem(panel, tab) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'sb-section-nav-menu-item';
    item.setAttribute('role', 'menuitemradio');
    item.setAttribute('aria-checked', 'false');
    item.tabIndex = -1;
    item.dataset.sbSectionTab = tab.id;

    const label = document.createElement('span');
    label.className = 'sb-section-nav-item-label';
    label.textContent = tab.label;

    item.append(createIcon(tab.iconClass), label, createIcon('fa-solid fa-check sb-section-nav-item-check'));
    item.addEventListener('click', () => activatePanelTab(panel, tab.id));
    return item;
}

function createHubItem(panel, tab) {
    const listItem = document.createElement('li');
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'sb-section-nav-hub-item';
    item.dataset.sbSectionTab = tab.id;

    const label = document.createElement('span');
    label.className = 'sb-section-nav-item-label';
    label.textContent = tab.label;

    item.append(createIcon(tab.iconClass), label, createIcon('fa-solid fa-chevron-right sb-section-nav-hub-chevron'));
    item.addEventListener('click', () => activatePanelTab(panel, tab.id));
    listItem.append(item);
    return listItem;
}

function syncPanel(panel) {
    const tabs = getPanelTabs(panel);
    const signature = tabs.map(tab => `${tab.id}:${tab.label}`).join('|');

    // Rebuilding while the menu is open would drop keyboard focus, so defer until it closes.
    if (signature !== panel.tabSignature && panel.menu.hidden) {
        panel.menu.replaceChildren(...tabs.map(tab => createMenuItem(panel, tab)));
        panel.hubList.replaceChildren(...tabs.map(tab => createHubItem(panel, tab)));
        panel.tabSignature = signature;
    }

    const activeTab = getActiveTab(tabs);
    const inHub = panel.view === 'hub';
    const triggerText = activeTab?.label ?? panel.hubTitle.textContent;
    const previousTriggerText = panel.triggerLabel.textContent;

    panel.root.dataset.sbSectionView = panel.view;
    panel.root.dataset.sbSectionPanel = panel.config.id;
    if (previousTriggerText !== triggerText) {
        panel.triggerLabel.textContent = triggerText;
        // Sibling section switches crossfade the label; hub pushes already slide the whole row.
        if (previousTriggerText && !inHub && performance.now() > panel.pushUntil && isPanelOpen(panel) && isMobileViewport()) {
            animateIn(panel.triggerLabel, [
                { opacity: 0, transform: 'translateY(4px)' },
                { opacity: 1, transform: 'none' },
            ], { duration: MOTION_FAST, easing: MOTION_EASE_OUT_QUAD });
        }
    }
    panel.trigger.hidden = inHub;
    panel.trigger.setAttribute('aria-expanded', String(!panel.menu.hidden));
    panel.hubTitle.hidden = !inHub;
    panel.kickerLabel.setAttribute('aria-hidden', String(inHub));
    panel.backButton.hidden = inHub;

    for (const item of getMenuItems(panel)) {
        const isCurrent = item.dataset.sbSectionTab === activeTab?.id;
        item.classList.toggle('is-current', isCurrent);
        item.setAttribute('aria-checked', String(isCurrent));
    }

    for (const item of panel.hubList.querySelectorAll('.sb-section-nav-hub-item')) {
        const isCurrent = item.dataset.sbSectionTab === activeTab?.id;
        item.classList.toggle('is-current', isCurrent);
        if (isCurrent) {
            item.setAttribute('aria-current', 'true');
        } else {
            item.removeAttribute('aria-current');
        }
    }
}

function closePanelMenu(panel, { restoreFocus = false } = {}) {
    if (panel.menu.hidden) {
        return;
    }
    animateOut(panel.menu, [{ opacity: 1 }, { opacity: 0 }], () => {
        panel.menu.hidden = true;
    }, { enabled: isMobileViewport(), duration: MOTION_POPOVER_CLOSE });
    syncPanel(panel);
    if (restoreFocus) {
        focusElement(panel.trigger);
    }
}

function closeAllMenus(exceptPanel = null) {
    for (const panel of state.panels.values()) {
        if (panel !== exceptPanel) {
            closePanelMenu(panel);
        }
    }
}

function openPanelMenu(panel, focusTarget = 'current') {
    closeAllMenus(panel);
    syncPanel(panel);

    if (panel.menu.parentElement !== panel.header) {
        panel.header.append(panel.menu);
    }

    panel.menu.hidden = false;
    panel.trigger.setAttribute('aria-expanded', 'true');

    // Popover grows out of the trigger, like an AdwSplitButton menu.
    animateIn(panel.menu, [
        { opacity: 0, transform: 'scale(0.96)' },
        { opacity: 1, transform: 'none' },
    ], { duration: MOTION_FAST, easing: MOTION_EASE_OUT_QUAD, styles: { 'transform-origin': originFrom(panel.trigger, panel.menu) } });

    const items = getMenuItems(panel);
    const target = focusTarget === 'last'
        ? items.at(-1)
        : items.find(item => item.classList.contains('is-current')) ?? items[0];
    focusElement(target);
}

function handleMenuKeydown(panel, event) {
    const items = getMenuItems(panel);
    const index = items.indexOf(document.activeElement);
    let next = null;

    switch (event.key) {
        case 'ArrowDown':
            next = items[index < 0 ? 0 : (index + 1) % items.length];
            break;
        case 'ArrowUp':
            next = items[index < 0 ? items.length - 1 : (index - 1 + items.length) % items.length];
            break;
        case 'Home':
            next = items[0];
            break;
        case 'End':
            next = items.at(-1);
            break;
        case 'Escape':
        case 'Tab':
            event.preventDefault();
            event.stopPropagation();
            closePanelMenu(panel, { restoreFocus: true });
            return;
        default:
            return;
    }

    event.preventDefault();
    event.stopPropagation();
    focusElement(next);
}

function isVisible(element) {
    return element instanceof HTMLElement && element.getClientRects().length > 0;
}

function getSectionContent(panel) {
    if (panel.config.id === 'characters') {
        return [...panel.root.children].filter(element => element !== panel.header
            && element !== panel.hub
            && !element.classList.contains('sb-shell-header')
            && !element.classList.contains('sb-character-shell-header')
            && isVisible(element));
    }
    return [panel.root.querySelector('.sb-shell-panel-active')].filter(isVisible);
}

function getFontSize(element) {
    return Number.parseFloat(getComputedStyle(element).fontSize) || 1;
}

/**
 * Switches hub/section view. With `animate`, returns a transition for playViewTransition()
 * that remembers where the shared title sat before the switch.
 */
function setPanelView(panel, view, { animate = false } = {}) {
    const previousView = panel.view;
    if (previousView === view) {
        syncPanel(panel);
        return null;
    }

    const forward = view === 'section';
    const source = forward ? panel.hubTitle : panel.kickerLabel;
    const transition = animate && isPanelOpen(panel) && isMobileViewport() && isVisible(source)
        ? { forward, fromRect: source.getBoundingClientRect(), fromFontSize: getFontSize(source) }
        : null;
    if (transition) {
        panel.pushUntil = performance.now() + SPRING_NAVIGATION.duration;
    }

    panel.view = view;
    if (isMobileViewport()) {
        panel.mobileView = view;
    }
    syncPanel(panel);
    return transition;
}

/*
 * AdwNavigationView-style push/pop: pushing a section slides it in from the end, popping back
 * slides the hub in from the start, and the panel title travels between the hub heading and the
 * kicker so the user can see which level they are on.
 */
function playViewTransition(panel, transition) {
    if (!transition) {
        return;
    }
    const { forward, fromRect, fromFontSize } = transition;
    const isRtl = getComputedStyle(panel.root).direction === 'rtl';
    const offset = (forward ? 24 : -24) * (isRtl ? -1 : 1);
    const slide = [
        { opacity: 0, transform: `translateX(${offset}px)` },
        { opacity: 1, transform: 'none' },
    ];
    const targets = forward
        ? [panel.backButton, panel.trigger, ...getSectionContent(panel)]
        : [panel.hub];
    for (const target of targets.filter(isVisible)) {
        animateIn(target, slide, SPRING_NAVIGATION);
    }

    const title = forward ? panel.kickerLabel : panel.hubTitle;
    // A reversed push must not leave the outgoing title's morph holding its opacity.
    stopMotion(forward ? panel.hubTitle : panel.kickerLabel);
    const kickerOverflow = panel.kicker.style.overflow;
    // The kicker clips its label to one 16px line; let the label travel outside it while morphing.
    panel.kicker.style.overflow = 'visible';
    morphFrom(title, fromRect, {
        ...SPRING_NAVIGATION,
        scale: fromFontSize / getFontSize(title),
        onEnd: () => {
            panel.kicker.style.overflow = kickerOverflow;
        },
    });
}

function activatePanelTab(panel, tabId) {
    const transition = setPanelView(panel, 'section', { animate: true });
    // Keep focus inside the panel so the shell's focus-origin capture and close-time restore stay intact.
    focusElement(panel.trigger);
    closePanelMenu(panel);

    const api = window.SillyBunnyShell;
    if (typeof api?.openTab === 'function') {
        api.openTab(panel.config.shellKey, tabId);
    } else {
        getPanelTabs(panel).find(tab => tab.id === tabId)?.button.click();
    }
    // After openTab so the newly active section is the one that slides in.
    playViewTransition(panel, transition);

    afterAppFocus(() => {
        syncPanel(panel);
        const active = document.activeElement;
        if (isPanelOpen(panel) && (!active || active === document.body || panel.root.contains(active))) {
            focusElement(panel.trigger);
        }
    });
}

function showPanelHub(panel) {
    closePanelMenu(panel);
    playViewTransition(panel, setPanelView(panel, 'hub', { animate: true }));
    focusElement(panel.hubTitle);
}

function getOpeningView(panel) {
    return isMobileViewport() ? panel.mobileView : 'section';
}

function syncPanelOpenState(panel) {
    const isOpen = isPanelOpen(panel);
    if (isOpen === panel.wasOpen) {
        return;
    }
    panel.wasOpen = isOpen;

    if (!isOpen) {
        closePanelMenu(panel);
        panel.listToolbar?.closePopover();
        return;
    }

    setPanelView(panel, getOpeningView(panel));
    if (!isMobileViewport()) {
        return;
    }

    afterAppFocus(() => {
        if (!isPanelOpen(panel)) {
            return;
        }
        const active = document.activeElement;
        const canMoveFocus = !active
            || active === document.body
            || panel.root.contains(active)
            || Boolean(active.closest?.('#top-bar'));
        if (canMoveFocus) {
            focusElement(panel.view === 'hub' ? panel.hubTitle : panel.trigger);
        }
    });
}

function createPanelNavigation(config, root) {
    const header = root.querySelector('.sb-shell-header');
    const nav = root.querySelector(config.navSelector);
    const title = header?.querySelector('.sb-shell-title');
    const kicker = header?.querySelector('.sb-shell-kicker');
    const closeButton = header?.querySelector('.sb-shell-close');
    const modeToggle = config.id === 'characters' ? header?.querySelector('#sb_character_mode_toggle') : null;
    if (!header || !nav || !title || !kicker || !closeButton) {
        return null;
    }

    title.classList.add('sb-section-nav-original-title');

    const menuId = `sb-section-nav-menu-${config.id}`;
    const hubTitleId = `sb-section-nav-hub-title-${config.id}`;
    const panelTitle = translate(config.title);
    const allSectionsLabel = t`All ${panelTitle} sections`;
    const sectionsLabel = t`${panelTitle} sections`;

    const row = document.createElement('div');
    row.className = 'sb-section-nav-row';

    const backButton = document.createElement('button');
    backButton.type = 'button';
    backButton.className = 'sb-section-nav-back';
    backButton.hidden = true;
    backButton.setAttribute('aria-label', allSectionsLabel);
    backButton.title = allSectionsLabel;
    backButton.append(createIcon('fa-solid fa-chevron-left'));

    const hubTitle = document.createElement('span');
    hubTitle.id = hubTitleId;
    hubTitle.className = 'sb-section-nav-hub-title';
    hubTitle.hidden = true;
    hubTitle.tabIndex = -1;
    hubTitle.setAttribute('role', 'heading');
    hubTitle.setAttribute('aria-level', '2');
    hubTitle.textContent = panelTitle;

    const kickerLabel = document.createElement('span');
    kickerLabel.className = 'sb-section-nav-kicker-label';
    kickerLabel.textContent = kicker.textContent.trim() || panelTitle;
    kicker.replaceChildren(kickerLabel);

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'sb-section-nav-menu-trigger';
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-controls', menuId);

    const triggerLabel = document.createElement('span');
    triggerLabel.className = 'sb-section-nav-trigger-label';
    const triggerHint = document.createElement('span');
    triggerHint.className = 'sb-visually-hidden';
    triggerHint.textContent = `, ${sectionsLabel}`;
    trigger.append(triggerLabel, triggerHint, createIcon('fa-solid fa-chevron-down sb-section-nav-trigger-chevron'));

    row.append(backButton, hubTitle, trigger);
    title.after(row);

    const menu = document.createElement('div');
    menu.id = menuId;
    menu.className = 'sb-section-nav-menu';
    menu.hidden = true;
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', sectionsLabel);
    blockUpstreamDrawerClose(menu);
    header.append(menu);

    const hub = document.createElement('section');
    hub.className = 'sb-section-nav-hub';
    hub.setAttribute('aria-labelledby', hubTitleId);
    const hubList = document.createElement('ul');
    hubList.className = 'sb-section-nav-hub-list';
    hub.append(hubList);

    const body = root.querySelector('.sb-shell-body');
    if (body) {
        body.prepend(hub);
    } else {
        header.after(hub);
    }

    const panel = {
        config,
        root,
        nav,
        header,
        trigger,
        triggerLabel,
        backButton,
        row,
        hubTitle,
        menu,
        hub,
        hubList,
        kicker,
        kickerLabel,
        closeButton,
        modeToggle,
        modeBand: modeToggle ? root.querySelector('#CharListButtonAndHotSwaps') : null,
        listToolbar: config.id === 'characters' ? createCharacterListToolbar(root) : null,
        originalClosePlacement: captureOriginalPlacement(closeButton),
        originalModePlacement: captureOriginalPlacement(modeToggle),
        tabSignature: '',
        mobileView: state.pendingMobileViews.get(config.shellKey) ?? 'hub',
        view: isMobileViewport()
            ? state.pendingMobileViews.get(config.shellKey) ?? 'hub'
            : 'section',
        wasOpen: false,
        pushUntil: 0,
    };
    state.pendingMobileViews.delete(config.shellKey);

    trigger.addEventListener('click', () => {
        if (panel.menu.hidden) {
            openPanelMenu(panel);
        } else {
            closePanelMenu(panel, { restoreFocus: true });
        }
    });
    trigger.addEventListener('keydown', event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            event.stopPropagation();
            openPanelMenu(panel, event.key === 'ArrowUp' ? 'last' : 'current');
        } else if (event.key === 'Escape' && !panel.menu.hidden) {
            event.preventDefault();
            event.stopPropagation();
            closePanelMenu(panel, { restoreFocus: true });
        }
    });
    menu.addEventListener('keydown', event => handleMenuKeydown(panel, event));
    backButton.addEventListener('click', () => showPanelHub(panel));

    new MutationObserver(() => syncPanelOpenState(panel))
        .observe(root, { attributes: true, attributeFilter: ['class'] });
    new MutationObserver(() => syncPanel(panel))
        .observe(nav, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-selected'] });

    syncMobileHeaderPlacement(panel);
    syncCharacterListToolbar(panel);
    syncPanel(panel);
    syncPanelOpenState(panel);
    return panel;
}

function syncMobileHeaderPlacement(panel) {
    if (isMobileViewport()) {
        if (panel.closeButton.parentElement !== panel.row) {
            panel.row.append(panel.closeButton);
        }
        // The favorites band becomes the mode bar; tag filters already cover favorites.
        if (panel.modeToggle && panel.modeBand && panel.modeToggle.parentElement !== panel.modeBand) {
            panel.modeBand.append(panel.modeToggle);
        }
        return;
    }

    restoreOriginalPlacement(panel.modeToggle, panel.originalModePlacement);
    restoreOriginalPlacement(panel.closeButton, panel.originalClosePlacement);
}

function getControlLabel(element) {
    return element.getAttribute('aria-label')
        || element.getAttribute('data-sttt--title')
        || element.getAttribute('title')
        || '';
}

/*
 * Mobile Characters list toolbar: one non-scrolling row (create, sort, search,
 * bulk edit, More) with the pager moved below the list. The production layout
 * helper (ensureCharacterListToolbarLayout) moves the pagination back into the
 * create bar on every panel toggle, so placement is re-applied by observer.
 */
function createCharacterListToolbar(root) {
    const moreId = 'sb-character-list-more-popover';
    const more = document.createElement('div');
    more.className = 'sb-character-list-more';

    const moreTrigger = document.createElement('button');
    moreTrigger.type = 'button';
    moreTrigger.className = 'menu_button sb-character-list-more-trigger';
    const moreLabel = translate('More list actions');
    moreTrigger.setAttribute('aria-label', moreLabel);
    moreTrigger.title = moreLabel;
    moreTrigger.setAttribute('aria-expanded', 'false');
    moreTrigger.setAttribute('aria-controls', moreId);
    moreTrigger.append(createIcon('fa-solid fa-ellipsis'));

    const popover = document.createElement('div');
    popover.id = moreId;
    popover.className = 'sb-character-list-more-popover';
    popover.hidden = true;
    popover.setAttribute('role', 'group');
    popover.setAttribute('aria-label', moreLabel);
    more.append(moreTrigger, popover);

    const bulkGroup = document.createElement('div');
    bulkGroup.className = 'sb-character-list-bulk';

    const toolbar = {
        root,
        more,
        moreTrigger,
        popover,
        bulkGroup,
        placements: new Map(),
        active: false,
    };

    const getPopoverItems = () => [...popover.querySelectorAll('button, [role="button"], .menu_button')]
        .filter(item => item.offsetParent !== null);

    const closePopover = ({ restoreFocus = false } = {}) => {
        if (popover.hidden) {
            return;
        }
        animateOut(popover, [{ opacity: 1 }, { opacity: 0 }], () => {
            popover.hidden = true;
        }, { enabled: isMobileViewport(), duration: MOTION_POPOVER_CLOSE });
        moreTrigger.setAttribute('aria-expanded', 'false');
        if (restoreFocus) {
            focusElement(moreTrigger);
        }
    };
    toolbar.closePopover = closePopover;

    moreTrigger.addEventListener('click', () => {
        if (!popover.hidden) {
            closePopover();
            return;
        }
        stopMotion(popover);
        popover.hidden = false;
        moreTrigger.setAttribute('aria-expanded', 'true');
        animateIn(popover, [
            { opacity: 0, transform: 'scale(0.96)' },
            { opacity: 1, transform: 'none' },
        ], { duration: MOTION_FAST, easing: MOTION_EASE_OUT_QUAD, styles: { 'transform-origin': originFrom(moreTrigger, popover) } });
        focusElement(getPopoverItems()[0]);
    });

    popover.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            closePopover({ restoreFocus: true });
            return;
        }
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
            return;
        }
        const items = getPopoverItems();
        const index = items.indexOf(document.activeElement);
        const step = event.key === 'ArrowDown' ? 1 : -1;
        event.preventDefault();
        focusElement(items[(index + step + items.length) % items.length]);
    });

    // Items act immediately (grid switch, Chat Archive dialog), so close after activation.
    popover.addEventListener('click', event => {
        if (event.target instanceof Element && event.target.closest('button, [role="button"], .menu_button')) {
            closePopover();
        }
    });

    document.addEventListener('click', event => {
        if (event.target instanceof Node && !more.contains(event.target)) {
            closePopover();
        }
    });

    let scheduled = false;
    const observer = new MutationObserver(() => {
        if (!toolbar.active || scheduled) {
            return;
        }
        scheduled = true;
        queueMicrotask(() => {
            scheduled = false;
            applyCharacterListToolbar(toolbar);
        });
    });
    const observeTargets = () => {
        const fixedTop = document.getElementById('charListFixedTop');
        const listBlock = document.getElementById('rm_characters_block');
        if (fixedTop) {
            observer.observe(fixedTop, { childList: true, subtree: true });
        }
        if (listBlock) {
            observer.observe(listBlock, { childList: true });
        }
    };
    toolbar.observeTargets = observeTargets;
    observeTargets();

    return toolbar;
}

function moveWithPlacement(toolbar, element, parent, before = null) {
    if (!element || !parent) {
        return;
    }
    if (!toolbar.placements.has(element)) {
        toolbar.placements.set(element, captureOriginalPlacement(element));
    }
    // Skip no-op moves: each move is a mutation the toolbar observer reacts to.
    const inPlace = element.parentElement === parent
        && (!before || element === before || element.nextSibling === before);
    if (!inPlace) {
        parent.insertBefore(element, before);
    }
}

function applyCharacterListToolbar(toolbar) {
    const createBar = toolbar.root.querySelector('.sb-character-create-bar');
    const buttonBar = document.getElementById('rm_button_bar');
    const pagination = document.getElementById('rm_print_characters_pagination');
    const listBlock = document.getElementById('rm_print_characters_block');
    if (!createBar || !buttonBar) {
        return;
    }

    const gridToggle = document.getElementById('charListGridToggle');
    if (gridToggle && !gridToggle.dataset.sbListLabel) {
        // Icon-only upstream control; the popover row shows its existing tooltip text.
        gridToggle.dataset.sbListLabel = getControlLabel(gridToggle);
    }
    moveWithPlacement(toolbar, gridToggle, toolbar.popover, toolbar.popover.firstChild);
    moveWithPlacement(toolbar, document.getElementById('rm_buttons_container'), toolbar.popover);

    for (const id of ['bulkSelectedCount', 'bulkSelectAllButton', 'bulkDeleteButton', 'bulkEditButton']) {
        moveWithPlacement(toolbar, document.getElementById(id), toolbar.bulkGroup);
    }
    const selectedCount = document.getElementById('bulkSelectedCount');
    if (selectedCount && !selectedCount.dataset.sbSelectedLabel) {
        selectedCount.dataset.sbSelectedLabel = translate('selected');
    }

    if (toolbar.bulkGroup.parentElement !== createBar || toolbar.bulkGroup.previousElementSibling !== buttonBar) {
        createBar.insertBefore(toolbar.bulkGroup, buttonBar.nextSibling);
    }
    if (toolbar.more.parentElement !== createBar || createBar.lastElementChild !== toolbar.more) {
        createBar.append(toolbar.more);
    }
    if (pagination && listBlock?.parentElement && pagination.previousElementSibling !== listBlock) {
        if (!toolbar.placements.has(pagination)) {
            toolbar.placements.set(pagination, captureOriginalPlacement(pagination));
        }
        listBlock.after(pagination);
    }
}

function restoreCharacterListToolbar(toolbar) {
    toolbar.closePopover();
    // Pagination first: the grid and bulk controls restore into it.
    const pagination = document.getElementById('rm_print_characters_pagination');
    const buttonBar = document.getElementById('rm_button_bar');
    if (pagination && toolbar.placements.has(pagination)) {
        const createBar = toolbar.root.querySelector('.sb-character-create-bar');
        if (createBar && buttonBar?.parentElement === createBar) {
            createBar.insertBefore(pagination, buttonBar.nextSibling);
        } else {
            restoreOriginalPlacement(pagination, toolbar.placements.get(pagination));
        }
    }
    for (const [element, placement] of toolbar.placements) {
        if (element !== pagination) {
            restoreOriginalPlacement(element, placement);
        }
    }
    toolbar.placements.clear();
    toolbar.more.remove();
    toolbar.bulkGroup.remove();
}

function syncCharacterListToolbar(panel) {
    const toolbar = panel.listToolbar;
    if (!toolbar) {
        return;
    }
    const shouldBeActive = isMobileViewport();
    if (shouldBeActive) {
        toolbar.active = true;
        toolbar.observeTargets();
        applyCharacterListToolbar(toolbar);
    } else if (toolbar.active) {
        toolbar.active = false;
        restoreCharacterListToolbar(toolbar);
    }
}

function closeMenusOnOutsideClick(event) {
    const target = event.target;
    if (!(target instanceof Element)) {
        return;
    }
    for (const panel of state.panels.values()) {
        if (panel.menu.hidden || panel.menu.contains(target) || panel.trigger.contains(target)) {
            continue;
        }
        closePanelMenu(panel);
    }
}

function applyMobileState() {
    const isMobile = isMobileViewport();
    document.documentElement.dataset.sbMobileUiMode = isMobile ? 'mobile' : 'desktop';
    syncMobileBottomBar(isMobile);
    for (const panel of state.panels.values()) {
        syncMobileHeaderPlacement(panel);
        syncCharacterListToolbar(panel);
        if (isMobile) {
            setPanelView(panel, panel.mobileView);
        } else {
            closePanelMenu(panel);
            setPanelView(panel, 'section');
        }
    }
}

/** Remembers the view for the next mobile opening, including requests made before attachment. */
export function requestMobileSectionView(shellKey, view = 'section') {
    const panel = [...state.panels.values()].find(candidate => candidate.config.shellKey === shellKey);
    if (!panel) {
        state.pendingMobileViews.set(shellKey, view);
        return;
    }

    panel.mobileView = view;
    if (isMobileViewport()) {
        setPanelView(panel, view);
    }
}

function attachPanels(attempt = 0) {
    for (const config of PANEL_CONFIGS) {
        if (state.panels.has(config.id)) {
            continue;
        }
        const root = findRoot(config);
        const panel = root ? createPanelNavigation(config, root) : null;
        if (panel) {
            state.panels.set(config.id, panel);
        }
    }
    if (state.panels.size < PANEL_CONFIGS.length && attempt < 10) {
        setTimeout(() => attachPanels(attempt + 1), 500);
    } else if (state.panels.size < PANEL_CONFIGS.length) {
        console.warn('[SillyBunny] Mobile section navigation could not find panels:', PANEL_CONFIGS.map(config => config.id).filter(id => !state.panels.has(id)));
    }
}

export function initializeMobileSectionNav() {
    if (state.initialized) {
        return;
    }
    state.initialized = true;

    document.documentElement.dataset.sbMobileUi = 'section-nav';
    document.addEventListener('click', closeMenusOnOutsideClick);

    initializeMobileBottomBar();
    applyMobileState();
    attachPanels();

    window.matchMedia(MOBILE_QUERY).addEventListener('change', applyMobileState);
}
