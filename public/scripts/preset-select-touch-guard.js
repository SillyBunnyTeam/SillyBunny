export const PRESET_SELECT_TOUCH_GUARD_DRAG_THRESHOLD_PX = 6;

function normalizeNumber(value, fallback = 0) {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : fallback;
}

function normalizePointerId(pointerId) {
    return pointerId === undefined ? null : pointerId;
}

function isGuardedPointerType(pointerType) {
    return pointerType === 'touch' || pointerType === 'pen';
}

function isSamePointer(touchGuardState, pointerId) {
    return touchGuardState?.pointerId === normalizePointerId(pointerId);
}

/**
 * Creates touch guard state for mobile preset selects.
 * @param {object} options Options.
 * @param {boolean} [options.isMobileViewport=false] Whether mobile viewport behavior is active.
 * @param {string} [options.pointerType=''] Pointer event type.
 * @param {number|null} [options.pointerId=null] Pointer identifier.
 * @param {number} [options.clientX=0] Pointer X coordinate.
 * @param {number} [options.clientY=0] Pointer Y coordinate.
 * @returns {{pointerId: number|null, startX: number, startY: number, dragging: boolean}|null}
 */
export function createPresetSelectTouchGuardState({
    isMobileViewport = false,
    pointerType = '',
    pointerId = null,
    clientX = 0,
    clientY = 0,
} = {}) {
    if (!isMobileViewport || !isGuardedPointerType(pointerType)) {
        return null;
    }

    return {
        pointerId: normalizePointerId(pointerId),
        startX: normalizeNumber(clientX),
        startY: normalizeNumber(clientY),
        dragging: false,
    };
}

/**
 * Updates preset select touch guard state after pointer movement.
 * @param {object} options Options.
 * @param {object|null} [options.touchGuardState=null] Existing touch guard state.
 * @param {number|null} [options.pointerId=null] Pointer identifier.
 * @param {number} [options.clientX=0] Pointer X coordinate.
 * @param {number} [options.clientY=0] Pointer Y coordinate.
 * @param {number} [options.thresholdPx=PRESET_SELECT_TOUCH_GUARD_DRAG_THRESHOLD_PX] Drag threshold.
 * @returns {object|null} Updated touch guard state.
 */
export function resolvePresetSelectTouchGuardMove({
    touchGuardState = null,
    pointerId = null,
    clientX = 0,
    clientY = 0,
    thresholdPx = PRESET_SELECT_TOUCH_GUARD_DRAG_THRESHOLD_PX,
} = {}) {
    if (!touchGuardState || !isSamePointer(touchGuardState, pointerId)) {
        return touchGuardState;
    }

    const threshold = Math.max(0, normalizeNumber(thresholdPx, PRESET_SELECT_TOUCH_GUARD_DRAG_THRESHOLD_PX));
    const deltaX = normalizeNumber(clientX) - normalizeNumber(touchGuardState.startX);
    const deltaY = normalizeNumber(clientY) - normalizeNumber(touchGuardState.startY);
    const dragging = Boolean(touchGuardState.dragging)
        || Math.abs(deltaX) > threshold
        || Math.abs(deltaY) > threshold;

    return {
        ...touchGuardState,
        dragging,
    };
}

/**
 * Clears preset select touch guard state and reports whether the following click should be swallowed.
 * @param {object} options Options.
 * @param {object|null} [options.touchGuardState=null] Existing touch guard state.
 * @param {number|null} [options.pointerId=null] Pointer identifier.
 * @param {boolean} [options.forceSuppress=false] Whether to suppress even if movement was not observed.
 * @returns {{touchGuardState: object|null, shouldSuppressClick: boolean}}
 */
export function resolvePresetSelectTouchGuardEnd({
    touchGuardState = null,
    pointerId = null,
    forceSuppress = false,
} = {}) {
    if (!touchGuardState || !isSamePointer(touchGuardState, pointerId)) {
        return {
            touchGuardState,
            shouldSuppressClick: false,
        };
    }

    return {
        touchGuardState: null,
        shouldSuppressClick: Boolean(forceSuppress || touchGuardState.dragging),
    };
}

/**
 * Resolves whether a preset select click should be suppressed after a mobile drag.
 * @param {object} options Options.
 * @param {boolean} [options.isMobileViewport=false] Whether mobile viewport behavior is active.
 * @param {boolean} [options.suppressClick=false] Pending click suppression flag.
 * @returns {boolean}
 */
export function shouldSuppressPresetSelectTouchClick({
    isMobileViewport = false,
    suppressClick = false,
} = {}) {
    return Boolean(isMobileViewport && suppressClick);
}
