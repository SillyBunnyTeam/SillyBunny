export const MOBILE_SHELL_LIFECYCLE_NAV_DRAG_THRESHOLD_PX = 6;
export const MOBILE_SHELL_LIFECYCLE_NAV_CLICK_SUPPRESSION_MS = 350;

export const MOBILE_SHELL_NAV_SCROLL_BEHAVIOR = Object.freeze({
    AUTO: 'auto',
    SMOOTH: 'smooth',
});

export const MOBILE_SHELL_SURFACE = Object.freeze({
    LEFT_SHELL: 'left-shell',
    RIGHT_SHELL: 'right-shell',
    CHARACTER_PANEL: 'character-panel',
});

export const MOBILE_SHELL_CLOSE_ALL_SURFACES = Object.freeze([
    MOBILE_SHELL_SURFACE.LEFT_SHELL,
    MOBILE_SHELL_SURFACE.RIGHT_SHELL,
    MOBILE_SHELL_SURFACE.CHARACTER_PANEL,
]);

const MOBILE_SHELL_OVERLAY_EXCLUSION_TABLE = Object.freeze({
    [MOBILE_SHELL_SURFACE.LEFT_SHELL]: Object.freeze({
        mobile: Object.freeze([
            MOBILE_SHELL_SURFACE.RIGHT_SHELL,
            MOBILE_SHELL_SURFACE.CHARACTER_PANEL,
        ]),
        desktop: Object.freeze([
            MOBILE_SHELL_SURFACE.RIGHT_SHELL,
            MOBILE_SHELL_SURFACE.CHARACTER_PANEL,
        ]),
    }),
    [MOBILE_SHELL_SURFACE.RIGHT_SHELL]: Object.freeze({
        mobile: Object.freeze([
            MOBILE_SHELL_SURFACE.LEFT_SHELL,
            MOBILE_SHELL_SURFACE.CHARACTER_PANEL,
        ]),
        desktop: Object.freeze([
            MOBILE_SHELL_SURFACE.LEFT_SHELL,
            MOBILE_SHELL_SURFACE.CHARACTER_PANEL,
        ]),
    }),
    [MOBILE_SHELL_SURFACE.CHARACTER_PANEL]: Object.freeze({
        mobile: Object.freeze([
            MOBILE_SHELL_SURFACE.LEFT_SHELL,
            MOBILE_SHELL_SURFACE.RIGHT_SHELL,
        ]),
        desktop: Object.freeze([
            MOBILE_SHELL_SURFACE.LEFT_SHELL,
            MOBILE_SHELL_SURFACE.RIGHT_SHELL,
        ]),
    }),
});

function normalizeNumber(value, fallback = 0) {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : fallback;
}

export function normalizeMobileShellText(value) {
    return String(value ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

export function clampMobileShellText(value, maxLength = 120) {
    const normalizedValue = String(value ?? '').replace(/\s+/g, ' ').trim();
    const safeMaxLength = Math.max(1, Math.round(normalizeNumber(maxLength, 120)));
    if (normalizedValue.length <= safeMaxLength) {
        return normalizedValue;
    }

    return `${normalizedValue.slice(0, safeMaxLength - 1).trimEnd()}…`;
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
 * Resolves page inert policy from active mobile modal roots.
 * Every mobile surface docks below the top bar rather than covering it, so the bar
 * stays interactive: its proxy buttons are how an open panel is closed again.
 * @param {object} options Options.
 * @param {string[]} [options.activeRootIds=[]] Active modal root ids.
 * @returns {{hasActiveMobileModal: boolean, shouldInertShell: boolean}}
 */
export function resolveMobileModalA11yState({
    activeRootIds = [],
} = {}) {
    const ids = Array.isArray(activeRootIds) ? activeRootIds : [];
    const hasActiveMobileModal = ids.length > 0;

    return {
        hasActiveMobileModal,
        shouldInertShell: hasActiveMobileModal,
    };
}

export const MOBILE_SHELL_VIEWPORT_SYNC_STEP = Object.freeze({
    SYNC_SHELL_VIEWPORT_BOUNDS: 'sync-shell-viewport-bounds',
    APPLY_TOPBAR_OFFSET: 'apply-topbar-offset',
    SYNC_CHATBAR_VISIBILITY_STATE: 'sync-chatbar-visibility-state',
    UPDATE_TOP_BAR_BRAND: 'update-top-bar-brand',
    SCHEDULE_TOPBAR_CONTEXT_REFRESH: 'schedule-topbar-context-refresh',
    SYNC_MOBILE_MODAL_STATE: 'sync-mobile-modal-state',
});

const MOBILE_DOCUMENT_PAN_BACKGROUND_SELECTOR = [
    'html',
    'body',
    '#bg1',
    '#bg_custom',
].join(', ');

const MOBILE_DOCUMENT_PAN_GUARD_SELECTOR = [
    '#sheld',
    '#chat',
    '#form_sheld',
    '#top-bar',
    '#top-settings-holder',
    '#send_form',
    '#nonQRFormItems',
    '#leftSendForm',
    '#qr--bar',
    '#rightSendForm',
    '#sb-bottom-chat-bar',
    '#sb-persona-picker',
    '#select2-sb-bottom-chat-select-container',
    '[aria-labelledby="select2-sb-bottom-chat-select-container"]',
    '.select2-selection',
    '#shadow_popup',
    '#dialogue_popup',
    '#left-nav-panel',
    '#right-nav-panel',
    '#user-settings-block',
    '#ica--tracker-panel',
    '#ica--tracker-panel-handle',
    'dialog.popup',
    '.popup',
    '.sb-dialog-host',
    '.sb-dialog',
    '.sb-side-panel',
    '.sb-shell-root',
    '.sb-shell-header',
    '.ica--tpanel',
    '.ica--tpanel-handle',
].join(', ');

const MOBILE_DOCUMENT_PAN_HORIZONTAL_SCROLL_SELECTOR = [
    '#leftSendForm',
    '#qr--bar',
    '#sb-bottom-chat-secondary-row',
    '.sb-bottom-chat-secondary-row',
    '#sb-persona-picker',
    '.group_speaker_list',
    '.sb-shell-nav',
    '.sb-settings-tabs-nav',
    // The icons-only top bar is made entirely of buttons, so every swipe on it matches
    // MOBILE_DOCUMENT_PAN_CONTROL_SELECTOR and the pan guard blocks it unless the rail is
    // allowlisted here.
    '.sb-topbar-group-left',
    '.sb-conversation-channel-tabs',
    '.sb-character-create-bar',
    '#HotSwapWrapper .hotswap',
    '#right-nav-panel .rm_tag_controls',
    '#completion_prompt_manager .completion_prompt_manager_prompt > span:nth-child(3)',
    '.popup.horizontal_scrolling_dialogue_popup .popup-content',
    '.mes_text pre code',
    '.mes_reasoning pre code',
    '.img_enlarged_holder',
    '.img_enlarged_container pre code',
    '.select2-results__options',
].join(', ');

const MOBILE_DOCUMENT_PAN_EDITABLE_SELECTOR = [
    'input',
    'textarea',
    'select',
    '[contenteditable="true"]',
].join(', ');

const MOBILE_DOCUMENT_PAN_CONTROL_SELECTOR = [
    'button',
    '[role="button"]',
    '.menu_button',
    '.interactable',
    '#dialogue_popup_controls',
    '.popup-controls',
    '.popup-button-close',
    '.select2-selection',
    '#ica--tracker-panel-handle',
    '.ica--tpanel-handle',
].join(', ');

const MOBILE_DOCUMENT_PAN_MIN_GESTURE_PX = 3;
const SCROLLABLE_OVERFLOW_VALUES = new Set(['auto', 'scroll', 'overlay']);

function elementMatchesSelector(element, selector) {
    return Boolean(element && typeof element.matches === 'function' && element.matches(selector));
}

function getParentElementLike(element) {
    if (!element || typeof element !== 'object') {
        return null;
    }

    if (element.parentElement && typeof element.parentElement === 'object') {
        return element.parentElement;
    }

    if (element.parentNode && typeof element.parentNode === 'object' && element.parentNode !== element) {
        return element.parentNode;
    }

    if (element.host && typeof element.host === 'object' && element.host !== element) {
        return element.host;
    }

    return null;
}

function closestMatchingElement(target, selector) {
    let element = target;

    while (element && typeof element === 'object') {
        if (elementMatchesSelector(element, selector)) {
            return element;
        }

        if (typeof element.closest === 'function') {
            const closest = element.closest(selector);
            if (closest) {
                return closest;
            }
        }

        element = getParentElementLike(element);
    }

    return null;
}

function findTouchByIdentifier(touches, identifier) {
    return Array.from(touches ?? []).find(touch => touch?.identifier === identifier) ?? null;
}

function isHorizontalGesture(delta) {
    if (!delta) {
        return false;
    }

    const absX = Math.abs(delta.x);
    const absY = Math.abs(delta.y);

    return absX > MOBILE_DOCUMENT_PAN_MIN_GESTURE_PX && absX > absY;
}

function getGestureDelta(event, touchStart) {
    if (!touchStart) {
        return null;
    }

    const currentTouch = findTouchByIdentifier(event.touches, touchStart.identifier) ?? event.touches?.[0] ?? null;
    if (!currentTouch) {
        return null;
    }

    return {
        x: normalizeNumber(currentTouch.clientX) - normalizeNumber(touchStart.clientX),
        y: normalizeNumber(currentTouch.clientY) - normalizeNumber(touchStart.clientY),
    };
}

function canElementScrollOnAxis(element, axis) {
    if (typeof Element === 'undefined' || !(element instanceof Element) || typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') {
        return true;
    }

    if (typeof document !== 'undefined' && element === document.scrollingElement) {
        return true;
    }

    const style = window.getComputedStyle(element);
    const overflow = axis === 'x' ? style.overflowX : style.overflowY;

    // Firefox reports visible for native textarea scrolling, unlike Chromium's auto.
    return SCROLLABLE_OVERFLOW_VALUES.has(overflow)
        || (overflow === 'visible' && element.matches('textarea'));
}

function canElementScrollForGesture(element, delta, { requireAvailableScrollInDirection = false } = {}) {
    if (!element || !delta) {
        return false;
    }

    const absX = Math.abs(delta.x);
    const absY = Math.abs(delta.y);
    const wantsHorizontalScroll = absX > absY;
    const canScrollX = normalizeNumber(element.scrollWidth) - normalizeNumber(element.clientWidth) > MOBILE_DOCUMENT_PAN_MIN_GESTURE_PX && canElementScrollOnAxis(element, 'x');
    const canScrollY = normalizeNumber(element.scrollHeight) - normalizeNumber(element.clientHeight) > MOBILE_DOCUMENT_PAN_MIN_GESTURE_PX && canElementScrollOnAxis(element, 'y');

    if (!requireAvailableScrollInDirection) {
        return wantsHorizontalScroll ? canScrollX : canScrollY;
    }

    if (wantsHorizontalScroll) {
        if (!canScrollX) {
            return false;
        }

        const scrollLeft = normalizeNumber(element.scrollLeft);
        const maxScrollLeft = normalizeNumber(element.scrollWidth) - normalizeNumber(element.clientWidth);
        return delta.x > 0
            ? scrollLeft > MOBILE_DOCUMENT_PAN_MIN_GESTURE_PX
            : scrollLeft < maxScrollLeft - MOBILE_DOCUMENT_PAN_MIN_GESTURE_PX;
    }

    if (!canScrollY) {
        return false;
    }

    const scrollTop = normalizeNumber(element.scrollTop);
    const maxScrollTop = normalizeNumber(element.scrollHeight) - normalizeNumber(element.clientHeight);
    return delta.y > 0
        ? scrollTop > MOBILE_DOCUMENT_PAN_MIN_GESTURE_PX
        : scrollTop < maxScrollTop - MOBILE_DOCUMENT_PAN_MIN_GESTURE_PX;
}

function closestScrollableElementForGesture(target, delta, {
    requireAvailableScrollInDirection = false,
    boundary = null,
} = {}) {
    let element = target;

    while (element && typeof element === 'object') {
        if (canElementScrollForGesture(element, delta, { requireAvailableScrollInDirection })) {
            return element;
        }

        if (element === boundary) {
            break;
        }

        element = getParentElementLike(element);
    }

    return null;
}

/**
 * Decides whether a mobile touchmove started on fixed mobile chrome should be
 * cancelled before the browser pans the visual viewport.
 * @param {TouchEvent|object} event Touchmove-like event.
 * @param {object} [options] Options.
 * @param {{identifier: number, clientX: number, clientY: number}|null} [options.touchStart=null] Starting touch point.
 * @returns {boolean}
 */
export function shouldBlockMobileDocumentPan(event, { touchStart = null } = {}) {
    if (!event?.cancelable || event.defaultPrevented || event.touches?.length !== 1) {
        return false;
    }

    const target = event.target;
    const backgroundElement = elementMatchesSelector(target, MOBILE_DOCUMENT_PAN_BACKGROUND_SELECTOR);
    const guardedElement = backgroundElement ? null : closestMatchingElement(target, MOBILE_DOCUMENT_PAN_GUARD_SELECTOR);

    if (!guardedElement && !backgroundElement) {
        return false;
    }

    const gestureDelta = getGestureDelta(event, touchStart);
    const editableElement = closestMatchingElement(target, MOBILE_DOCUMENT_PAN_EDITABLE_SELECTOR);
    if (editableElement) {
        const isScrollableEditable = elementMatchesSelector(editableElement, 'textarea, [contenteditable="true"]');
        if (isScrollableEditable && gestureDelta && canElementScrollForGesture(editableElement, gestureDelta, { requireAvailableScrollInDirection: true })) {
            return false;
        }

        const ancestorScrollElement = guardedElement
            ? closestScrollableElementForGesture(getParentElementLike(editableElement), gestureDelta, {
                requireAvailableScrollInDirection: true,
                boundary: guardedElement,
            })
            : null;
        if (ancestorScrollElement && (!isHorizontalGesture(gestureDelta) || elementMatchesSelector(ancestorScrollElement, MOBILE_DOCUMENT_PAN_HORIZONTAL_SCROLL_SELECTOR))) {
            return false;
        }

        return true;
    }

    const scrollElement = guardedElement
        ? closestScrollableElementForGesture(target, gestureDelta, {
            requireAvailableScrollInDirection: true,
            boundary: guardedElement,
        })
        : null;
    if (closestMatchingElement(target, MOBILE_DOCUMENT_PAN_CONTROL_SELECTOR)) {
        if (scrollElement && (!isHorizontalGesture(gestureDelta) || elementMatchesSelector(scrollElement, MOBILE_DOCUMENT_PAN_HORIZONTAL_SCROLL_SELECTOR))) {
            return false;
        }

        return true;
    }

    if (scrollElement) {
        if (isHorizontalGesture(gestureDelta)) {
            return !elementMatchesSelector(scrollElement, MOBILE_DOCUMENT_PAN_HORIZONTAL_SCROLL_SELECTOR);
        }

        return false;
    }

    return true;
}

/**
 * Resolves the ordered viewport sync work without touching shell DOM.
 * @returns {{steps: string[]}}
 */
export function resolveMobileViewportSyncPlan() {
    return {
        steps: [
            MOBILE_SHELL_VIEWPORT_SYNC_STEP.SYNC_SHELL_VIEWPORT_BOUNDS,
            MOBILE_SHELL_VIEWPORT_SYNC_STEP.APPLY_TOPBAR_OFFSET,
            MOBILE_SHELL_VIEWPORT_SYNC_STEP.SYNC_CHATBAR_VISIBILITY_STATE,
            MOBILE_SHELL_VIEWPORT_SYNC_STEP.UPDATE_TOP_BAR_BRAND,
            MOBILE_SHELL_VIEWPORT_SYNC_STEP.SCHEDULE_TOPBAR_CONTEXT_REFRESH,
            MOBILE_SHELL_VIEWPORT_SYNC_STEP.SYNC_MOBILE_MODAL_STATE,
        ],
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
            scrollBehavior: MOBILE_SHELL_NAV_SCROLL_BEHAVIOR,
            createDragState: createMobileShellNavDragState,
            resolveDragMove: resolveMobileShellNavDragMove,
            resolveDragEnd: resolveMobileShellNavDragEnd,
            shouldSuppressClick: shouldSuppressMobileShellNavClick,
            resolvePageScroll: resolveMobileShellNavPageScroll,
            resolveScrollIndicators: resolveMobileShellNavScrollIndicators,
        },
        modal: {
            resolveA11yState: resolveMobileModalA11yState,
        },
        overlays: {
            surface: MOBILE_SHELL_SURFACE,
            closeAllSurfaces: MOBILE_SHELL_CLOSE_ALL_SURFACES,
            resolveExclusiveOpen: resolveMobileShellExclusiveOpen,
        },
        inlineDrawers: {
            resolveAutoCloseSiblings: resolveInlineDrawerAutoCloseSiblings,
            derivePersistenceKey: deriveInlineDrawerPersistenceKey,
        },
        viewportSync: {
            step: MOBILE_SHELL_VIEWPORT_SYNC_STEP,
            resolveSyncPlan: resolveMobileViewportSyncPlan,
        },
        timings: {
            navDragThresholdPx: MOBILE_SHELL_LIFECYCLE_NAV_DRAG_THRESHOLD_PX,
            navClickSuppressionMs: MOBILE_SHELL_LIFECYCLE_NAV_CLICK_SUPPRESSION_MS,
        },
    };
}
