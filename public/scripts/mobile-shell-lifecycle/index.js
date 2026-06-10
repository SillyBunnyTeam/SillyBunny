export const MOBILE_SHELL_LIFECYCLE_NAV_OPEN_GRACE_MS = 450;
export const MOBILE_SHELL_LIFECYCLE_NAV_DRAG_THRESHOLD_PX = 6;
export const MOBILE_SHELL_LIFECYCLE_NAV_CLICK_SUPPRESSION_MS = 350;

export const MOBILE_SHELL_NAV_TOGGLE_ACTION = Object.freeze({
    ACTIVATE_PAGE_TARGET: 'activate-page-target',
    CLOSE_NAV: 'close-nav',
    OPEN_NAV: 'open-nav',
});

export const MOBILE_SHELL_NAV_SCROLL_BEHAVIOR = Object.freeze({
    AUTO: 'auto',
    SMOOTH: 'smooth',
});

function normalizeNumber(value, fallback = 0) {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : fallback;
}

function getTouchPoint(touch) {
    if (!touch || typeof touch !== 'object') {
        return null;
    }

    return {
        clientX: normalizeNumber(touch.clientX),
        clientY: normalizeNumber(touch.clientY),
    };
}

/**
 * Captures the start state for mobile shell rail dragging.
 * @param {object} options Options.
 * @param {boolean} [options.isMobileViewport=false] Whether mobile shell policy is active.
 * @param {object|null} [options.touch=null] First touch point.
 * @param {number} [options.scrollLeft=0] Current rail scroll offset.
 * @returns {{startX: number, startY: number, scrollLeft: number, dragging: boolean}|null}
 */
export function createMobileShellNavDragState({
    isMobileViewport = false,
    touch = null,
    scrollLeft = 0,
} = {}) {
    const touchPoint = getTouchPoint(touch);
    if (!isMobileViewport || !touchPoint) {
        return null;
    }

    return {
        startX: touchPoint.clientX,
        startY: touchPoint.clientY,
        scrollLeft: normalizeNumber(scrollLeft),
        dragging: false,
    };
}

/**
 * Resolves one touch-move step for shell rail dragging.
 * @param {object} options Options.
 * @param {object|null} [options.dragState=null] Existing drag state.
 * @param {object|null} [options.touch=null] First touch point.
 * @param {number} [options.thresholdPx=MOBILE_SHELL_LIFECYCLE_NAV_DRAG_THRESHOLD_PX] Drag threshold.
 * @returns {{dragState: object|null, shouldPreventDefault: boolean, shouldStopPropagation: boolean, nextScrollLeft: number|null}}
 */
export function resolveMobileShellNavDragMove({
    dragState = null,
    touch = null,
    thresholdPx = MOBILE_SHELL_LIFECYCLE_NAV_DRAG_THRESHOLD_PX,
} = {}) {
    const touchPoint = getTouchPoint(touch);
    if (!dragState || !touchPoint) {
        return {
            dragState: null,
            shouldPreventDefault: false,
            shouldStopPropagation: false,
            nextScrollLeft: null,
        };
    }

    const deltaX = touchPoint.clientX - normalizeNumber(dragState.startX);
    const deltaY = touchPoint.clientY - normalizeNumber(dragState.startY);
    const isDragging = Boolean(dragState.dragging)
        || Math.abs(deltaX) > thresholdPx
        || Math.abs(deltaY) > thresholdPx;
    const nextDragState = {
        ...dragState,
        dragging: isDragging,
    };

    if (!isDragging) {
        return {
            dragState: nextDragState,
            shouldPreventDefault: false,
            shouldStopPropagation: false,
            nextScrollLeft: null,
        };
    }

    return {
        dragState: nextDragState,
        shouldPreventDefault: true,
        shouldStopPropagation: true,
        nextScrollLeft: normalizeNumber(dragState.scrollLeft) - deltaX,
    };
}

/**
 * Resolves touch-end cleanup and click suppression after shell rail dragging.
 * @param {object} options Options.
 * @param {object|null} [options.dragState=null] Existing drag state.
 * @param {number} [options.nowMs=0] Current timestamp.
 * @param {number} [options.suppressionMs=MOBILE_SHELL_LIFECYCLE_NAV_CLICK_SUPPRESSION_MS] Suppression window.
 * @returns {{dragState: null, shouldStopPropagation: boolean, suppressClickUntil: number}}
 */
export function resolveMobileShellNavDragEnd({
    dragState = null,
    nowMs = 0,
    suppressionMs = MOBILE_SHELL_LIFECYCLE_NAV_CLICK_SUPPRESSION_MS,
} = {}) {
    if (!dragState?.dragging) {
        return {
            dragState: null,
            shouldStopPropagation: false,
            suppressClickUntil: 0,
        };
    }

    return {
        dragState: null,
        shouldStopPropagation: true,
        suppressClickUntil: normalizeNumber(nowMs) + normalizeNumber(suppressionMs),
    };
}

/**
 * Resolves whether a click immediately after rail drag should be swallowed.
 * @param {object} options Options.
 * @param {number} [options.nowMs=0] Current timestamp.
 * @param {number} [options.suppressClickUntil=0] Suppression deadline.
 * @returns {boolean}
 */
export function shouldSuppressMobileShellNavClick({
    nowMs = 0,
    suppressClickUntil = 0,
} = {}) {
    return normalizeNumber(nowMs) < normalizeNumber(suppressClickUntil);
}

/**
 * Resolves shell rail page scroll without reading layout from the DOM.
 * @param {object} options Options.
 * @param {number} [options.direction=1] Scroll direction.
 * @param {number} [options.clientWidth=0] Rail viewport width.
 * @param {boolean} [options.prefersReducedMotion=false] Whether smooth motion should be avoided.
 * @returns {{left: number, behavior: string}}
 */
export function resolveMobileShellNavPageScroll({
    direction = 1,
    clientWidth = 0,
    prefersReducedMotion = false,
} = {}) {
    return {
        left: Math.sign(normalizeNumber(direction, 1) || 1) * Math.max(normalizeNumber(clientWidth) * 0.72, 160),
        behavior: prefersReducedMotion
            ? MOBILE_SHELL_NAV_SCROLL_BEHAVIOR.AUTO
            : MOBILE_SHELL_NAV_SCROLL_BEHAVIOR.SMOOTH,
    };
}

/**
 * Resolves rail scroll affordances from measured dimensions.
 * @param {object} options Options.
 * @param {number} [options.scrollLeft=0] Current scroll offset.
 * @param {number} [options.clientWidth=0] Visible width.
 * @param {number} [options.scrollWidth=0] Total scroll width.
 * @returns {{canScrollLeft: boolean, canScrollRight: boolean}}
 */
export function resolveMobileShellNavScrollIndicators({
    scrollLeft = 0,
    clientWidth = 0,
    scrollWidth = 0,
} = {}) {
    const currentScrollLeft = normalizeNumber(scrollLeft);
    const visibleWidth = normalizeNumber(clientWidth);
    const totalWidth = normalizeNumber(scrollWidth);

    return {
        canScrollLeft: currentScrollLeft > 0,
        canScrollRight: Math.ceil(currentScrollLeft + visibleWidth) < totalWidth,
    };
}

/**
 * Resolves hamburger behavior before runtime mutates drawers or overlay state.
 * @param {object} options Options.
 * @param {boolean} [options.isMobileViewport=false] Whether mobile shell policy is active.
 * @param {boolean} [options.isReplacementEnabled=false] Whether hamburger opens a configured page target.
 * @param {boolean} [options.isOpen=false] Whether nav overlay is currently open.
 * @returns {{action: string, shouldCloseCompetingPanels: boolean}}
 */
export function resolveMobileNavToggleIntent({
    isMobileViewport = false,
    isReplacementEnabled = false,
    isOpen = false,
} = {}) {
    if (isReplacementEnabled && isMobileViewport) {
        return {
            action: MOBILE_SHELL_NAV_TOGGLE_ACTION.ACTIVATE_PAGE_TARGET,
            shouldCloseCompetingPanels: false,
        };
    }

    if (isOpen) {
        return {
            action: MOBILE_SHELL_NAV_TOGGLE_ACTION.CLOSE_NAV,
            shouldCloseCompetingPanels: false,
        };
    }

    return {
        action: MOBILE_SHELL_NAV_TOGGLE_ACTION.OPEN_NAV,
        shouldCloseCompetingPanels: true,
    };
}

/**
 * Resolves mobile navigation overlay state for DOM adapters.
 * @param {object} options Options.
 * @param {boolean} [options.requestedOpen=false] Requested open state.
 * @param {boolean} [options.isMobileViewport=false] Whether mobile shell policy is active.
 * @param {boolean} [options.wasOpen=false] Whether overlay was previously open.
 * @param {boolean} [options.focusedInside=false] Whether current focus is inside overlay.
 * @returns {{shouldOpen: boolean, overlayHidden: boolean, overlayAriaHidden: string, overlayInert: boolean, buttonExpanded: string, buttonIcon: string, shouldRecordOpenedAt: boolean, shouldRefreshQuickActions: boolean, shouldFocusTitle: boolean, shouldRestoreButtonFocus: boolean}}
 */
export function resolveMobileNavOpenState({
    requestedOpen = false,
    isMobileViewport = false,
    wasOpen = false,
    focusedInside = false,
} = {}) {
    const shouldOpen = Boolean(requestedOpen) && Boolean(isMobileViewport);

    return {
        shouldOpen,
        overlayHidden: !shouldOpen,
        overlayAriaHidden: String(!shouldOpen),
        overlayInert: !shouldOpen,
        buttonExpanded: String(shouldOpen),
        buttonIcon: shouldOpen ? 'close' : 'menu',
        shouldRecordOpenedAt: shouldOpen,
        shouldRefreshQuickActions: shouldOpen,
        shouldFocusTitle: shouldOpen,
        shouldRestoreButtonFocus: !shouldOpen && Boolean(wasOpen) && Boolean(focusedInside),
    };
}

/**
 * Resolves outside-click auto-close policy for the mobile nav overlay.
 * @param {object} options Options.
 * @param {boolean} [options.isNavOpen=false] Whether nav overlay is open.
 * @param {boolean} [options.isTrusted=false] Whether click came from user input.
 * @param {number} [options.elapsedSinceOpenedMs=0] Milliseconds since nav opened.
 * @param {boolean} [options.isHamburgerTarget=false] Whether click is on hamburger.
 * @param {boolean} [options.isInsideNav=false] Whether click is inside nav overlay.
 * @param {boolean} [options.isAutoCloseArea=false] Whether click is in main content area.
 * @param {number} [options.openGraceMs=MOBILE_SHELL_LIFECYCLE_NAV_OPEN_GRACE_MS] Grace period.
 * @returns {boolean}
 */
export function shouldAutoCloseMobileNav({
    isNavOpen = false,
    isTrusted = false,
    elapsedSinceOpenedMs = 0,
    isHamburgerTarget = false,
    isInsideNav = false,
    isAutoCloseArea = false,
    openGraceMs = MOBILE_SHELL_LIFECYCLE_NAV_OPEN_GRACE_MS,
} = {}) {
    return Boolean(isNavOpen)
        && Boolean(isTrusted)
        && normalizeNumber(elapsedSinceOpenedMs) >= normalizeNumber(openGraceMs)
        && !isHamburgerTarget
        && !isInsideNav
        && Boolean(isAutoCloseArea);
}

/**
 * Resolves page inert policy from active mobile modal roots.
 * @param {object} options Options.
 * @param {string[]} [options.activeRootIds=[]] Active modal root ids.
 * @returns {{hasActiveMobileModal: boolean, shouldInertShell: boolean, shouldInertTopBar: boolean}}
 */
export function resolveMobileModalA11yState({
    activeRootIds = [],
} = {}) {
    const ids = Array.isArray(activeRootIds) ? activeRootIds : [];
    const hasActiveMobileModal = ids.length > 0;
    const shouldInertTopBar = ids.some(id => id !== 'sb-mobile-nav');

    return {
        hasActiveMobileModal,
        shouldInertShell: hasActiveMobileModal,
        shouldInertTopBar,
    };
}

export const MOBILE_SHELL_DRAWER_BOUND_ACTION = Object.freeze({
    BIND: 'bind',
    CLEAR: 'clear',
    SKIP: 'skip',
});

export const MOBILE_SHELL_DRAWER_BOUND_STYLE_PROPERTIES = Object.freeze([
    'top',
    'bottom',
    'height',
    'max-height',
    'box-sizing',
]);

export const MOBILE_SHELL_VIEWPORT_SYNC_STEP = Object.freeze({
    SYNC_SHELL_VIEWPORT_BOUNDS: 'sync-shell-viewport-bounds',
    SYNC_MOBILE_SHELL_DRAWER_BOUNDS: 'sync-mobile-shell-drawer-bounds',
    CLOSE_MOBILE_NAV: 'close-mobile-nav',
    CLOSE_MOBILE_CHAT_TOOLS: 'close-mobile-chat-tools',
    SYNC_MOBILE_SHELL_RAIL_ACTIONS: 'sync-mobile-shell-rail-actions',
    SYNC_DESKTOP_SHELL_SIZING: 'sync-desktop-shell-sizing',
    APPLY_TOPBAR_OFFSET: 'apply-topbar-offset',
    SYNC_CHATBAR_VISIBILITY_STATE: 'sync-chatbar-visibility-state',
    UPDATE_TOP_BAR_BRAND: 'update-top-bar-brand',
    SCHEDULE_TOPBAR_CONTEXT_REFRESH: 'schedule-topbar-context-refresh',
    SYNC_MOBILE_MODAL_STATE: 'sync-mobile-modal-state',
});

function clampBoundNumber(value, min, max) {
    return Math.min(Math.max(normalizeNumber(value, min), min), max);
}

/**
 * Resolves the viewport bound decision for a single mobile shell drawer.
 * Pure decision: callers read DOM state in, apply style writes/removals out.
 * @param {object} options Options.
 * @param {boolean} [options.isMobileViewport=false] Whether mobile shell policy is active.
 * @param {boolean} [options.isOpen=false] Whether the drawer has the openDrawer class.
 * @param {boolean} [options.isViewportBound=false] Whether the drawer carries the bound dataset marker.
 * @param {number} [options.viewportHeight=0] Current shell viewport height in px.
 * @param {number} [options.baseTopOffset=0] Resolved shell topbar offset in px.
 * @param {number} [options.shellGap=0] Drawer --sb-mobile-shell-gap value in px.
 * @returns {{action: string, styleWrites: Array<{property: string, value: string, priority: string}>, styleRemovals: string[]}}
 */
export function resolveMobileDrawerBounds({
    isMobileViewport = false,
    isOpen = false,
    isViewportBound = false,
    viewportHeight = 0,
    baseTopOffset = 0,
    shellGap = 0,
} = {}) {
    const shouldBind = Boolean(isMobileViewport) && Boolean(isOpen);

    if (!shouldBind) {
        return {
            action: isViewportBound ? MOBILE_SHELL_DRAWER_BOUND_ACTION.CLEAR : MOBILE_SHELL_DRAWER_BOUND_ACTION.SKIP,
            styleWrites: [],
            styleRemovals: isViewportBound ? [...MOBILE_SHELL_DRAWER_BOUND_STYLE_PROPERTIES] : [],
        };
    }

    const safeViewportHeight = Math.max(0, normalizeNumber(viewportHeight));
    const safeBaseTopOffset = Math.max(0, Math.round(normalizeNumber(baseTopOffset)));
    const topOffset = clampBoundNumber(Math.round(safeBaseTopOffset + normalizeNumber(shellGap)), 0, safeViewportHeight);
    const availableHeight = Math.max(0, safeViewportHeight - topOffset);

    return {
        action: MOBILE_SHELL_DRAWER_BOUND_ACTION.BIND,
        styleWrites: [
            { property: 'top', value: `${topOffset}px`, priority: 'important' },
            { property: 'bottom', value: 'auto', priority: 'important' },
            { property: 'box-sizing', value: 'border-box', priority: 'important' },
            { property: 'height', value: `${availableHeight}px`, priority: 'important' },
            { property: 'max-height', value: `${availableHeight}px`, priority: 'important' },
        ],
        styleRemovals: [],
    };
}

/**
 * Resolves the ordered viewport sync work without touching shell DOM.
 * @param {object} options Options.
 * @param {boolean} [options.isMobileViewport=false] Whether mobile shell policy is active.
 * @returns {{steps: string[]}}
 */
export function resolveMobileViewportSyncPlan({
    isMobileViewport = false,
} = {}) {
    const steps = [
        MOBILE_SHELL_VIEWPORT_SYNC_STEP.SYNC_SHELL_VIEWPORT_BOUNDS,
        MOBILE_SHELL_VIEWPORT_SYNC_STEP.SYNC_MOBILE_SHELL_DRAWER_BOUNDS,
    ];

    if (!isMobileViewport) {
        steps.push(
            MOBILE_SHELL_VIEWPORT_SYNC_STEP.CLOSE_MOBILE_NAV,
            MOBILE_SHELL_VIEWPORT_SYNC_STEP.CLOSE_MOBILE_CHAT_TOOLS,
            MOBILE_SHELL_VIEWPORT_SYNC_STEP.SYNC_MOBILE_SHELL_DRAWER_BOUNDS,
        );
    }

    steps.push(
        MOBILE_SHELL_VIEWPORT_SYNC_STEP.SYNC_MOBILE_SHELL_RAIL_ACTIONS,
        MOBILE_SHELL_VIEWPORT_SYNC_STEP.SYNC_DESKTOP_SHELL_SIZING,
        MOBILE_SHELL_VIEWPORT_SYNC_STEP.APPLY_TOPBAR_OFFSET,
        MOBILE_SHELL_VIEWPORT_SYNC_STEP.SYNC_CHATBAR_VISIBILITY_STATE,
        MOBILE_SHELL_VIEWPORT_SYNC_STEP.UPDATE_TOP_BAR_BRAND,
        MOBILE_SHELL_VIEWPORT_SYNC_STEP.SCHEDULE_TOPBAR_CONTEXT_REFRESH,
        MOBILE_SHELL_VIEWPORT_SYNC_STEP.SYNC_MOBILE_MODAL_STATE,
    );

    return { steps };
}

/**
 * Resolves how drawer bounds should be queued after mobile viewport movement.
 * @param {object} options Options.
 * @param {boolean} [options.isMobileViewport=false] Whether mobile shell policy is active.
 * @param {boolean} [options.hasAnimationFrame=false] Whether requestAnimationFrame is available.
 * @param {number} [options.followupDelayMs=350] Follow-up sync delay.
 * @returns {{shouldSchedule: boolean, useAnimationFrame: boolean, followupDelayMs: number}}
 */
export function resolveDrawerBoundsSyncSchedule({
    isMobileViewport = false,
    hasAnimationFrame = false,
    followupDelayMs = 350,
} = {}) {
    const shouldSchedule = Boolean(isMobileViewport);

    return {
        shouldSchedule,
        useAnimationFrame: shouldSchedule && Boolean(hasAnimationFrame),
        followupDelayMs: normalizeNumber(followupDelayMs, 350),
    };
}

/**
 * Creates the compatibility-facing mobile shell lifecycle seam.
 * Runtime call sites should depend on this shape instead of individual helpers.
 * @returns {object}
 */
export function createMobileShellLifecycle() {
    return {
        nav: {
            action: MOBILE_SHELL_NAV_TOGGLE_ACTION,
            scrollBehavior: MOBILE_SHELL_NAV_SCROLL_BEHAVIOR,
            createDragState: createMobileShellNavDragState,
            resolveDragMove: resolveMobileShellNavDragMove,
            resolveDragEnd: resolveMobileShellNavDragEnd,
            shouldSuppressClick: shouldSuppressMobileShellNavClick,
            resolvePageScroll: resolveMobileShellNavPageScroll,
            resolveScrollIndicators: resolveMobileShellNavScrollIndicators,
            resolveToggleIntent: resolveMobileNavToggleIntent,
            resolveOpenState: resolveMobileNavOpenState,
            shouldAutoClose: shouldAutoCloseMobileNav,
        },
        modal: {
            resolveA11yState: resolveMobileModalA11yState,
        },
        drawerBounds: {
            action: MOBILE_SHELL_DRAWER_BOUND_ACTION,
            boundStyleProperties: MOBILE_SHELL_DRAWER_BOUND_STYLE_PROPERTIES,
            resolveBounds: resolveMobileDrawerBounds,
        },
        viewportSync: {
            step: MOBILE_SHELL_VIEWPORT_SYNC_STEP,
            resolveSyncPlan: resolveMobileViewportSyncPlan,
            resolveDrawerBoundsSchedule: resolveDrawerBoundsSyncSchedule,
        },
        timings: {
            navOpenGraceMs: MOBILE_SHELL_LIFECYCLE_NAV_OPEN_GRACE_MS,
            navDragThresholdPx: MOBILE_SHELL_LIFECYCLE_NAV_DRAG_THRESHOLD_PX,
            navClickSuppressionMs: MOBILE_SHELL_LIFECYCLE_NAV_CLICK_SUPPRESSION_MS,
        },
    };
}
