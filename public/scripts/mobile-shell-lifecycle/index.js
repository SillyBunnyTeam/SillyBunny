export const MOBILE_SHELL_LIFECYCLE_NAV_OPEN_GRACE_MS = 450;
export const MOBILE_SHELL_LIFECYCLE_NAV_DRAG_THRESHOLD_PX = 6;
export const MOBILE_SHELL_LIFECYCLE_NAV_CLICK_SUPPRESSION_MS = 350;
export const MOBILE_SHELL_LIFECYCLE_DRAWER_GESTURE_THRESHOLD_PX = 8;
export const MOBILE_SHELL_LIFECYCLE_DRAWER_DISMISS_THRESHOLD_PX = 72;
export const MOBILE_SHELL_LIFECYCLE_DRAWER_CLICK_SUPPRESSION_MS = 350;

export const MOBILE_SHELL_NAV_TOGGLE_ACTION = Object.freeze({
    ACTIVATE_PAGE_TARGET: 'activate-page-target',
    CLOSE_NAV: 'close-nav',
    OPEN_NAV: 'open-nav',
});

export const MOBILE_SHELL_NAV_SCROLL_BEHAVIOR = Object.freeze({
    AUTO: 'auto',
    SMOOTH: 'smooth',
});

export const MOBILE_SHELL_SURFACE = Object.freeze({
    NAV: 'mobile-nav',
    LEFT_SHELL: 'left-shell',
    RIGHT_SHELL: 'right-shell',
    CHARACTER_PANEL: 'character-panel',
    CHAT_TOOLS: 'chat-tools',
    CONNECTION_STRIP: 'connection-strip',
});

export const MOBILE_SHELL_CLOSE_ALL_SURFACES = Object.freeze([
    MOBILE_SHELL_SURFACE.LEFT_SHELL,
    MOBILE_SHELL_SURFACE.RIGHT_SHELL,
    MOBILE_SHELL_SURFACE.CHARACTER_PANEL,
    MOBILE_SHELL_SURFACE.NAV,
    MOBILE_SHELL_SURFACE.CHAT_TOOLS,
    MOBILE_SHELL_SURFACE.CONNECTION_STRIP,
]);

export const MOBILE_SHELL_RAIL_QUICK_ACTION_LIMIT = 12;
export const MOBILE_SHELL_RAIL_QUICK_ACTION_LABEL_MAX_LENGTH = 36;
export const MOBILE_SHELL_RAIL_QUICK_ACTION_ICON_FALLBACK = 'fa-bolt';
export const MOBILE_SHELL_RAIL_CHARACTER_SHELL_KEY = 'characters';

const MOBILE_SHELL_RAIL_ICON_STYLE_CLASSES = Object.freeze(new Set(['fa-solid', 'fa-regular', 'fa-brands']));

const MOBILE_SHELL_OVERLAY_EXCLUSION_TABLE = Object.freeze({
    [MOBILE_SHELL_SURFACE.NAV]: Object.freeze({
        mobile: Object.freeze([
            MOBILE_SHELL_SURFACE.LEFT_SHELL,
            MOBILE_SHELL_SURFACE.RIGHT_SHELL,
            MOBILE_SHELL_SURFACE.CHARACTER_PANEL,
            MOBILE_SHELL_SURFACE.CHAT_TOOLS,
            MOBILE_SHELL_SURFACE.CONNECTION_STRIP,
        ]),
        desktop: Object.freeze([
            MOBILE_SHELL_SURFACE.LEFT_SHELL,
            MOBILE_SHELL_SURFACE.RIGHT_SHELL,
            MOBILE_SHELL_SURFACE.CHARACTER_PANEL,
            MOBILE_SHELL_SURFACE.CHAT_TOOLS,
            MOBILE_SHELL_SURFACE.CONNECTION_STRIP,
        ]),
    }),
    [MOBILE_SHELL_SURFACE.LEFT_SHELL]: Object.freeze({
        mobile: Object.freeze([
            MOBILE_SHELL_SURFACE.RIGHT_SHELL,
            MOBILE_SHELL_SURFACE.CHARACTER_PANEL,
            MOBILE_SHELL_SURFACE.NAV,
            MOBILE_SHELL_SURFACE.CHAT_TOOLS,
            MOBILE_SHELL_SURFACE.CONNECTION_STRIP,
        ]),
        desktop: Object.freeze([
            MOBILE_SHELL_SURFACE.RIGHT_SHELL,
            MOBILE_SHELL_SURFACE.CHARACTER_PANEL,
            MOBILE_SHELL_SURFACE.NAV,
            MOBILE_SHELL_SURFACE.CHAT_TOOLS,
            MOBILE_SHELL_SURFACE.CONNECTION_STRIP,
        ]),
    }),
    [MOBILE_SHELL_SURFACE.RIGHT_SHELL]: Object.freeze({
        mobile: Object.freeze([
            MOBILE_SHELL_SURFACE.LEFT_SHELL,
            MOBILE_SHELL_SURFACE.CHARACTER_PANEL,
            MOBILE_SHELL_SURFACE.NAV,
            MOBILE_SHELL_SURFACE.CHAT_TOOLS,
            MOBILE_SHELL_SURFACE.CONNECTION_STRIP,
        ]),
        desktop: Object.freeze([
            MOBILE_SHELL_SURFACE.LEFT_SHELL,
            MOBILE_SHELL_SURFACE.CHARACTER_PANEL,
            MOBILE_SHELL_SURFACE.NAV,
            MOBILE_SHELL_SURFACE.CHAT_TOOLS,
            MOBILE_SHELL_SURFACE.CONNECTION_STRIP,
        ]),
    }),
    [MOBILE_SHELL_SURFACE.CHARACTER_PANEL]: Object.freeze({
        mobile: Object.freeze([
            MOBILE_SHELL_SURFACE.LEFT_SHELL,
            MOBILE_SHELL_SURFACE.RIGHT_SHELL,
            MOBILE_SHELL_SURFACE.NAV,
            MOBILE_SHELL_SURFACE.CHAT_TOOLS,
            MOBILE_SHELL_SURFACE.CONNECTION_STRIP,
        ]),
        desktop: Object.freeze([
            MOBILE_SHELL_SURFACE.LEFT_SHELL,
            MOBILE_SHELL_SURFACE.RIGHT_SHELL,
            MOBILE_SHELL_SURFACE.NAV,
            MOBILE_SHELL_SURFACE.CHAT_TOOLS,
            MOBILE_SHELL_SURFACE.CONNECTION_STRIP,
        ]),
    }),
    [MOBILE_SHELL_SURFACE.CHAT_TOOLS]: Object.freeze({
        mobile: Object.freeze([
            MOBILE_SHELL_SURFACE.NAV,
            MOBILE_SHELL_SURFACE.LEFT_SHELL,
            MOBILE_SHELL_SURFACE.RIGHT_SHELL,
            MOBILE_SHELL_SURFACE.CHARACTER_PANEL,
            MOBILE_SHELL_SURFACE.CONNECTION_STRIP,
        ]),
        desktop: Object.freeze([
            MOBILE_SHELL_SURFACE.NAV,
            MOBILE_SHELL_SURFACE.LEFT_SHELL,
            MOBILE_SHELL_SURFACE.RIGHT_SHELL,
            MOBILE_SHELL_SURFACE.CHARACTER_PANEL,
            MOBILE_SHELL_SURFACE.CONNECTION_STRIP,
        ]),
    }),
    [MOBILE_SHELL_SURFACE.CONNECTION_STRIP]: Object.freeze({
        mobile: Object.freeze([
            MOBILE_SHELL_SURFACE.NAV,
            MOBILE_SHELL_SURFACE.LEFT_SHELL,
            MOBILE_SHELL_SURFACE.RIGHT_SHELL,
            MOBILE_SHELL_SURFACE.CHARACTER_PANEL,
            MOBILE_SHELL_SURFACE.CHAT_TOOLS,
        ]),
        desktop: Object.freeze([
            MOBILE_SHELL_SURFACE.NAV,
            MOBILE_SHELL_SURFACE.LEFT_SHELL,
            MOBILE_SHELL_SURFACE.RIGHT_SHELL,
            MOBILE_SHELL_SURFACE.CHARACTER_PANEL,
            MOBILE_SHELL_SURFACE.CHAT_TOOLS,
        ]),
    }),
});

function normalizeNumber(value, fallback = 0) {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : fallback;
}

function normalizeText(value) {
    return String(value ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function clampText(value, maxLength = 120) {
    const normalizedValue = String(value ?? '').replace(/\s+/g, ' ').trim();
    const safeMaxLength = Math.max(1, Math.round(normalizeNumber(maxLength, 120)));
    if (normalizedValue.length <= safeMaxLength) {
        return normalizedValue;
    }

    return `${normalizedValue.slice(0, safeMaxLength - 1).trimEnd()}…`;
}

function normalizeRailIcon(value, fallback = MOBILE_SHELL_RAIL_QUICK_ACTION_ICON_FALLBACK) {
    const fallbackIcon = clampText(fallback || MOBILE_SHELL_RAIL_QUICK_ACTION_ICON_FALLBACK, 60);
    const iconClass = String(value ?? '')
        .trim()
        .split(/\s+/)
        .find(token => /^fa-[a-z0-9-]+$/i.test(token) && !MOBILE_SHELL_RAIL_ICON_STYLE_CLASSES.has(token.toLowerCase()));

    return clampText(iconClass?.toLowerCase() || fallbackIcon, 60);
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
 * Captures the start state for mobile drawer swipe-down dismissal.
 * @param {object} options Options.
 * @param {boolean} [options.isMobileViewport=false] Whether mobile shell policy is active.
 * @param {boolean} [options.isOpen=false] Whether the drawer is currently open.
 * @param {object|null} [options.touch=null] First touch point.
 * @returns {{startX: number, startY: number, offsetY: number, dragging: boolean}|null}
 */
export function createMobileShellDrawerGestureState({
    isMobileViewport = false,
    isOpen = false,
    touch = null,
} = {}) {
    const touchPoint = getTouchPoint(touch);
    if (!isMobileViewport || !isOpen || !touchPoint) {
        return null;
    }

    return {
        startX: touchPoint.clientX,
        startY: touchPoint.clientY,
        offsetY: 0,
        dragging: false,
    };
}

/**
 * Resolves one touch-move step for mobile drawer swipe-down dismissal.
 * @param {object} options Options.
 * @param {object|null} [options.gestureState=null] Existing gesture state.
 * @param {object|null} [options.touch=null] Current touch point.
 * @param {number} [options.thresholdPx=MOBILE_SHELL_LIFECYCLE_DRAWER_GESTURE_THRESHOLD_PX] Drag threshold.
 * @returns {{gestureState: object|null, shouldPreventDefault: boolean, shouldStopPropagation: boolean, offsetY: number}}
 */
export function resolveMobileShellDrawerGestureMove({
    gestureState = null,
    touch = null,
    thresholdPx = MOBILE_SHELL_LIFECYCLE_DRAWER_GESTURE_THRESHOLD_PX,
} = {}) {
    const touchPoint = getTouchPoint(touch);
    if (!gestureState || !touchPoint) {
        return {
            gestureState: null,
            shouldPreventDefault: false,
            shouldStopPropagation: false,
            offsetY: 0,
        };
    }

    const deltaX = touchPoint.clientX - normalizeNumber(gestureState.startX);
    const deltaY = touchPoint.clientY - normalizeNumber(gestureState.startY);
    const isDownward = deltaY > 0;
    const isVerticalIntent = Math.abs(deltaY) >= Math.abs(deltaX);
    const isDragging = Boolean(gestureState.dragging)
        || (isDownward && isVerticalIntent && deltaY > normalizeNumber(thresholdPx));
    const offsetY = isDragging ? Math.max(0, deltaY) : 0;
    const nextGestureState = {
        ...gestureState,
        offsetY,
        dragging: isDragging,
    };

    return {
        gestureState: nextGestureState,
        shouldPreventDefault: isDragging,
        shouldStopPropagation: isDragging,
        offsetY,
    };
}

/**
 * Resolves touch-end cleanup and dismiss intent after mobile drawer dragging.
 * @param {object} options Options.
 * @param {object|null} [options.gestureState=null] Existing gesture state.
 * @param {number} [options.nowMs=0] Current timestamp.
 * @param {number} [options.dismissThresholdPx=MOBILE_SHELL_LIFECYCLE_DRAWER_DISMISS_THRESHOLD_PX] Dismiss threshold.
 * @param {number} [options.suppressionMs=MOBILE_SHELL_LIFECYCLE_DRAWER_CLICK_SUPPRESSION_MS] Suppression window.
 * @returns {{gestureState: null, shouldDismiss: boolean, shouldStopPropagation: boolean, suppressClickUntil: number, offsetY: number}}
 */
export function resolveMobileShellDrawerGestureEnd({
    gestureState = null,
    nowMs = 0,
    dismissThresholdPx = MOBILE_SHELL_LIFECYCLE_DRAWER_DISMISS_THRESHOLD_PX,
    suppressionMs = MOBILE_SHELL_LIFECYCLE_DRAWER_CLICK_SUPPRESSION_MS,
} = {}) {
    if (!gestureState?.dragging) {
        return {
            gestureState: null,
            shouldDismiss: false,
            shouldStopPropagation: false,
            suppressClickUntil: 0,
            offsetY: 0,
        };
    }

    return {
        gestureState: null,
        shouldDismiss: normalizeNumber(gestureState.offsetY) >= normalizeNumber(dismissThresholdPx),
        shouldStopPropagation: true,
        suppressClickUntil: normalizeNumber(nowMs) + normalizeNumber(suppressionMs),
        offsetY: 0,
    };
}

/**
 * Resolves whether a click immediately after drawer dragging should be swallowed.
 * @param {object} options Options.
 * @param {number} [options.nowMs=0] Current timestamp.
 * @param {number} [options.suppressClickUntil=0] Suppression deadline.
 * @returns {boolean}
 */
export function shouldSuppressMobileShellDrawerGestureClick({
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
 * Resolves the surfaces that must close when one shell surface opens.
 * @param {object} options Options.
 * @param {string} [options.surface=''] Surface being opened.
 * @param {boolean} [options.isMobileViewport=false] Whether mobile shell policy is active.
 * @returns {{closeSurfaces: string[]}}
 */
export function resolveMobileShellExclusiveOpen({
    surface = '',
    isMobileViewport = false,
} = {}) {
    const tableEntry = MOBILE_SHELL_OVERLAY_EXCLUSION_TABLE[surface];
    if (!tableEntry) {
        return { closeSurfaces: [] };
    }

    return {
        closeSurfaces: [...(isMobileViewport ? tableEntry.mobile : tableEntry.desktop)],
    };
}

/**
 * Resolves persisted quick-action route aliases before shell/tab validation.
 * @param {object} [action=null] Quick-action candidate.
 * @returns {{shellKey: string, tabId: string}}
 */
export function resolveMobileShellQuickActionRoute(action = null) {
    const legacyShellKey = normalizeText(action?.shellKey || action?.shell);
    const legacyTabId = normalizeText(action?.tabId || action?.tab);
    const isLegacyWorldInfoRoute = legacyShellKey === 'left' && legacyTabId === 'world-info';

    return {
        shellKey: isLegacyWorldInfoRoute ? MOBILE_SHELL_RAIL_CHARACTER_SHELL_KEY : legacyShellKey,
        tabId: isLegacyWorldInfoRoute ? 'world-info' : legacyTabId,
    };
}

/**
 * Normalizes a shell rail quick-action candidate without touching DOM state.
 * Runtime adapters provide shell/tab metadata from their current registry.
 * @param {object} options Options.
 * @param {object} [options.action=null] Quick-action candidate.
 * @param {object|null} [options.shellConfig=null] Shell metadata for non-character shells.
 * @param {object|null} [options.tabConfig=null] Tab metadata for tab actions.
 * @param {object} [options.limits={}] Limit overrides.
 * @returns {object|null}
 */
export function normalizeMobileShellQuickAction({
    action = null,
    shellConfig = null,
    tabConfig = null,
    limits = {},
} = {}) {
    if (!action || typeof action !== 'object') {
        return null;
    }

    const { shellKey, tabId } = resolveMobileShellQuickActionRoute(action);
    const requestedType = normalizeText(action.type);
    const isShellAction = requestedType === 'shell';
    const shellExists = shellKey === MOBILE_SHELL_RAIL_CHARACTER_SHELL_KEY || Boolean(shellConfig);

    if ((isShellAction ? !shellKey : !tabId) || !shellExists) {
        return null;
    }

    const dedupeKey = clampText(action.dedupeKey, 160);
    const type = dedupeKey ? 'custom' : isShellAction ? 'shell' : 'tab';
    const displayText = clampText(action.displayText, 80);
    const sectionLabel = clampText(action.sectionLabel, 80);
    const labelMaxLength = normalizeNumber(limits.labelMaxLength, MOBILE_SHELL_RAIL_QUICK_ACTION_LABEL_MAX_LENGTH);
    const iconFallback = limits.iconFallback || MOBILE_SHELL_RAIL_QUICK_ACTION_ICON_FALLBACK;
    const fallbackLabel = type === 'custom'
        ? displayText || sectionLabel
        : type === 'shell'
            ? shellConfig?.title || shellKey
            : tabConfig?.label || tabId;
    const label = clampText(action.label || fallbackLabel, labelMaxLength);

    if (!label) {
        return null;
    }

    const fallbackIcon = type === 'custom'
        ? iconFallback
        : type === 'shell'
            ? shellConfig?.proxyIcon || 'fa-bars'
            : tabConfig?.icon || 'fa-bars';
    const normalizedAction = {
        type,
        shellKey,
        tabId,
        icon: normalizeRailIcon(action.icon, fallbackIcon),
        label,
    };

    if (type === 'custom') {
        normalizedAction.sectionLabel = sectionLabel;
        normalizedAction.displayText = displayText || label;
        normalizedAction.dedupeKey = dedupeKey;
    }

    return normalizedAction;
}

/**
 * Derives the stable storage/dedupe key for a normalized quick action.
 * @param {object|null} [action=null] Normalized quick action.
 * @returns {string}
 */
export function getMobileShellQuickActionKey(action = null) {
    if (!action || typeof action !== 'object') {
        return '';
    }

    return [
        action.type,
        action.shellKey,
        action.tabId,
        action.dedupeKey,
    ].filter(Boolean).join('::');
}

/**
 * Resolves side-rail action groups without constructing DOM.
 * @param {object} options Options.
 * @param {boolean} [options.hasVerticalRail=false] Whether rail shortcuts render.
 * @param {boolean} [options.showCustomize=false] Whether built-in customize/workspace actions render.
 * @param {boolean} [options.showQuickActions=false] Whether custom quick actions render.
 * @param {object[]} [options.builtInActions=[]] Built-in actions for the current shell.
 * @param {string[]} [options.builtInActionKeys=[]] Built-in action keys to hide from custom actions.
 * @param {object[]} [options.quickActions=[]] Persisted quick actions for the active rail mode.
 * @param {object|null} [options.replacementAction=null] Optional single replacement quick action.
 * @param {string} [options.builtInGroupLabel=''] Label for the built-in action group.
 * @returns {{shouldHideCustomizeTabs: boolean, beforeGroups: object[], afterGroups: object[], quickActions: object[]}}
 */
export function resolveMobileShellRailActionVisibility({
    hasVerticalRail = false,
    showCustomize = false,
    showQuickActions = false,
    builtInActions = [],
    builtInActionKeys = [],
    quickActions = [],
    replacementAction = null,
    builtInGroupLabel = '',
} = {}) {
    const shouldRenderRail = Boolean(hasVerticalRail);
    const shouldShowCustomize = shouldRenderRail && Boolean(showCustomize);
    const builtInItems = shouldShowCustomize && Array.isArray(builtInActions)
        ? builtInActions.filter(Boolean)
        : [];
    const builtInKeys = new Set(shouldShowCustomize && Array.isArray(builtInActionKeys) ? builtInActionKeys : []);
    const visibleQuickActions = replacementAction
        ? [replacementAction].filter(Boolean)
        : (Array.isArray(quickActions) ? quickActions : [])
            .filter(action => !builtInKeys.has(getMobileShellQuickActionKey(action)));
    const beforeGroups = [];
    const afterGroups = [];

    if (builtInItems.length > 0) {
        beforeGroups.push({
            type: 'built-in',
            label: String(builtInGroupLabel || 'Built In'),
            actions: builtInItems,
        });
    }

    if (shouldRenderRail && Boolean(showQuickActions) && visibleQuickActions.length > 0) {
        afterGroups.push({
            type: 'quick-actions',
            label: 'Quick Actions',
            actions: visibleQuickActions,
        });
    }

    return {
        shouldHideCustomizeTabs: shouldShowCustomize,
        beforeGroups,
        afterGroups,
        quickActions: visibleQuickActions,
    };
}

/**
 * Resolves which open inline drawer siblings should close when a drawer opens.
 * The current shell behavior is viewport-agnostic; callers still pass viewport
 * state so the decision seam owns the policy if it becomes mobile-specific.
 * @param {object} [options={}] Options.
 * @param {string} [options.openedDrawerId=''] Stable id for the drawer being opened.
 * @param {string[]} [options.openDrawerIds=[]] Stable ids for currently open sibling drawers.
 * @param {boolean} [options.isMobileViewport=false] Current viewport state.
 * @returns {{closeIds: string[]}}
 */
export function resolveInlineDrawerAutoCloseSiblings(options = {}) {
    const openedDrawerId = String(options.openedDrawerId ?? '').trim();
    const openDrawerIds = Array.isArray(options.openDrawerIds) ? options.openDrawerIds : [];

    if (!openedDrawerId) {
        return { closeIds: [] };
    }

    const seenIds = new Set([openedDrawerId]);
    const closeIds = [];

    for (const drawerId of openDrawerIds) {
        const normalizedDrawerId = String(drawerId ?? '').trim();
        if (!normalizedDrawerId || seenIds.has(normalizedDrawerId)) {
            continue;
        }

        seenIds.add(normalizedDrawerId);
        closeIds.push(normalizedDrawerId);
    }

    return { closeIds };
}

/**
 * Derives the persistent storage key for an inline drawer from DOM-free context.
 * Adapter code owns DOM reads and segment sanitization; this helper owns the
 * key format so user drawer-state preferences keep their exact storage shape.
 * @param {object} [options={}] Options.
 * @param {string} [options.drawerId=''] Sanitized drawer id segment, when present.
 * @param {object} [options.context={}] Sanitized drawer context.
 * @param {string} [options.context.storagePrefix='sb-settings-inline-drawer'] Storage key prefix.
 * @param {string[]} [options.context.contextSegments=[]] Sanitized ancestor context segments.
 * @param {string} [options.context.drawerLabel=''] Sanitized drawer label segment for id-less drawers.
 * @param {number} [options.context.drawerIndex=0] Sibling index for id-less drawers.
 * @returns {string}
 */
export function deriveInlineDrawerPersistenceKey({
    drawerId = '',
    context = {},
} = {}) {
    const storagePrefix = String(context.storagePrefix ?? 'sb-settings-inline-drawer').trim();
    const contextSegments = Array.isArray(context.contextSegments)
        ? context.contextSegments.map(segment => String(segment ?? '').trim()).filter(Boolean)
        : [];

    if (!storagePrefix || contextSegments.length === 0) {
        return '';
    }

    const contextPath = contextSegments.join('/');
    const normalizedDrawerId = String(drawerId ?? '').trim();
    if (normalizedDrawerId) {
        return `${storagePrefix}:${contextPath}:drawer-id:${normalizedDrawerId}`;
    }

    const drawerLabel = String(context.drawerLabel ?? '').trim();
    if (!drawerLabel) {
        return '';
    }

    const drawerIndex = Math.max(0, Math.round(normalizeNumber(context.drawerIndex, 0)));
    return `${storagePrefix}:${contextPath}:drawer:${drawerLabel}:${drawerIndex}`;
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
 * @param {number} [options.safeAreaBottom=0] Bottom safe-area inset reserved below the drawer.
 * @returns {{action: string, styleWrites: Array<{property: string, value: string, priority: string}>, styleRemovals: string[]}}
 */
export function resolveMobileDrawerBounds({
    isMobileViewport = false,
    isOpen = false,
    isViewportBound = false,
    viewportHeight = 0,
    baseTopOffset = 0,
    shellGap = 0,
    safeAreaBottom = 0,
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
    const bottomInset = clampBoundNumber(
        Math.round(normalizeNumber(safeAreaBottom)),
        0,
        Math.max(0, safeViewportHeight - topOffset),
    );
    const availableHeight = Math.max(0, safeViewportHeight - topOffset - bottomInset);

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
        overlays: {
            surface: MOBILE_SHELL_SURFACE,
            closeAllSurfaces: MOBILE_SHELL_CLOSE_ALL_SURFACES,
            resolveExclusiveOpen: resolveMobileShellExclusiveOpen,
        },
        railModel: {
            limits: {
                quickActionLimit: MOBILE_SHELL_RAIL_QUICK_ACTION_LIMIT,
                labelMaxLength: MOBILE_SHELL_RAIL_QUICK_ACTION_LABEL_MAX_LENGTH,
                iconFallback: MOBILE_SHELL_RAIL_QUICK_ACTION_ICON_FALLBACK,
            },
            resolveQuickActionRoute: resolveMobileShellQuickActionRoute,
            normalizeQuickAction: normalizeMobileShellQuickAction,
            getQuickActionKey: getMobileShellQuickActionKey,
            resolveActionVisibility: resolveMobileShellRailActionVisibility,
        },
        inlineDrawers: {
            resolveAutoCloseSiblings: resolveInlineDrawerAutoCloseSiblings,
            derivePersistenceKey: deriveInlineDrawerPersistenceKey,
        },
        drawerGestures: {
            createGestureState: createMobileShellDrawerGestureState,
            resolveGestureMove: resolveMobileShellDrawerGestureMove,
            resolveGestureEnd: resolveMobileShellDrawerGestureEnd,
            shouldSuppressClick: shouldSuppressMobileShellDrawerGestureClick,
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
            drawerGestureThresholdPx: MOBILE_SHELL_LIFECYCLE_DRAWER_GESTURE_THRESHOLD_PX,
            drawerDismissThresholdPx: MOBILE_SHELL_LIFECYCLE_DRAWER_DISMISS_THRESHOLD_PX,
            drawerClickSuppressionMs: MOBILE_SHELL_LIFECYCLE_DRAWER_CLICK_SUPPRESSION_MS,
        },
    };
}
