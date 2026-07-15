const MOVING_UI_VIEWPORT_TOLERANCE_PX = 1;
const MOVING_UI_BOUND_PROPERTIES = ['width', 'height', 'left', 'top', 'right', 'bottom'];

function parsePixelValue(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }

    if (typeof value !== 'string') {
        return null;
    }

    const trimmedValue = value.trim();
    if (!/^-?\d+(?:\.\d+)?(?:px)?$/.test(trimmedValue)) {
        return null;
    }

    return Number.parseFloat(trimmedValue);
}

function normalizeViewportDimension(value) {
    const numericValue = Number(value);
    return Number.isFinite(numericValue) && numericValue > 0 ? numericValue : 0;
}

function getUsableElementBounds(elementBounds) {
    if (!elementBounds) {
        return null;
    }

    const bounds = Object.fromEntries(MOVING_UI_BOUND_PROPERTIES.map(property => [property, Number(elementBounds[property])]));
    if (MOVING_UI_BOUND_PROPERTIES.some(property => !Number.isFinite(bounds[property])) || bounds.width <= 0 || bounds.height <= 0) {
        return null;
    }

    return bounds;
}

function getStateBounds(state, viewportWidth, viewportHeight) {
    const width = parsePixelValue(state?.width);
    const height = parsePixelValue(state?.height);
    const right = parsePixelValue(state?.right);
    const bottom = parsePixelValue(state?.bottom);
    let left = parsePixelValue(state?.left);
    let top = parsePixelValue(state?.top);

    if (left === null && right !== null && width !== null) {
        left = viewportWidth - right - width;
    }

    if (top === null && bottom !== null && height !== null) {
        top = viewportHeight - bottom - height;
    }

    if ([left, top, width, height].some(value => value === null) || width <= 0 || height <= 0) {
        return null;
    }

    return {
        left,
        top,
        right: left + width,
        bottom: top + height,
        width,
        height,
    };
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function roundBound(value) {
    return Math.round(value);
}

function isBoundsOutOfViewport(bounds, viewportWidth, viewportHeight) {
    return bounds.left < -MOVING_UI_VIEWPORT_TOLERANCE_PX
        || bounds.top < -MOVING_UI_VIEWPORT_TOLERANCE_PX
        || bounds.right > viewportWidth + MOVING_UI_VIEWPORT_TOLERANCE_PX
        || bounds.bottom > viewportHeight + MOVING_UI_VIEWPORT_TOLERANCE_PX;
}

function getContainmentUpdates(state, bounds, nextBounds, viewportWidth, viewportHeight) {
    /** @type {Record<string, number>} */
    const updates = {};
    const horizontalOverflow = bounds.left < -MOVING_UI_VIEWPORT_TOLERANCE_PX
        || bounds.right > viewportWidth + MOVING_UI_VIEWPORT_TOLERANCE_PX;
    const verticalOverflow = bounds.top < -MOVING_UI_VIEWPORT_TOLERANCE_PX
        || bounds.bottom > viewportHeight + MOVING_UI_VIEWPORT_TOLERANCE_PX;

    if (horizontalOverflow) {
        if (bounds.width > viewportWidth + MOVING_UI_VIEWPORT_TOLERANCE_PX || parsePixelValue(state?.width) !== null) {
            updates.width = nextBounds.width;
        }
        updates.left = nextBounds.left;
        updates.right = nextBounds.right;
    }

    if (verticalOverflow) {
        if (bounds.height > viewportHeight + MOVING_UI_VIEWPORT_TOLERANCE_PX || parsePixelValue(state?.height) !== null) {
            updates.height = nextBounds.height;
        }
        updates.top = nextBounds.top;
        updates.bottom = nextBounds.bottom;
    }

    return updates;
}

/**
 * Resolves persisted MovingUI geometry into a fully viewport-contained state.
 * Rendered bounds take precedence because CSS min/max rules can make stored
 * dimensions differ from the box that actually contributes document overflow.
 *
 * @param {object} state Persisted MovingUI state.
 * @param {object} options Viewport and optional rendered geometry.
 * @param {number} options.viewportWidth Layout viewport width.
 * @param {number} options.viewportHeight Layout viewport height.
 * @param {object|null} [options.elementBounds=null] Current rendered bounds.
 * @returns {{state: object, updates: object, changed: boolean, canContain: boolean}}
 */
export function resolveMovingUIViewportState(state, {
    viewportWidth,
    viewportHeight,
    elementBounds = null,
} = {}) {
    const sourceState = state && typeof state === 'object' ? state : {};
    const safeViewportWidth = normalizeViewportDimension(viewportWidth);
    const safeViewportHeight = normalizeViewportDimension(viewportHeight);

    if (!safeViewportWidth || !safeViewportHeight) {
        return { state: sourceState, updates: {}, changed: false, canContain: false };
    }

    const bounds = getUsableElementBounds(elementBounds)
        ?? getStateBounds(sourceState, safeViewportWidth, safeViewportHeight);
    if (!bounds) {
        return { state: sourceState, updates: {}, changed: false, canContain: false };
    }

    if (!isBoundsOutOfViewport(bounds, safeViewportWidth, safeViewportHeight)) {
        return { state: sourceState, updates: {}, changed: false, canContain: true };
    }

    const width = roundBound(Math.min(bounds.width, safeViewportWidth));
    const height = roundBound(Math.min(bounds.height, safeViewportHeight));
    const left = roundBound(clamp(bounds.left, 0, Math.max(0, safeViewportWidth - width)));
    const top = roundBound(clamp(bounds.top, 0, Math.max(0, safeViewportHeight - height)));
    const nextBounds = {
        width,
        height,
        left,
        top,
        right: roundBound(Math.max(0, safeViewportWidth - left - width)),
        bottom: roundBound(Math.max(0, safeViewportHeight - top - height)),
    };
    const updates = Object.fromEntries(Object.entries(
        getContainmentUpdates(sourceState, bounds, nextBounds, safeViewportWidth, safeViewportHeight),
    ).filter(([property, value]) => {
        const currentValue = parsePixelValue(sourceState[property]);
        return currentValue === null || Math.abs(currentValue - value) > MOVING_UI_VIEWPORT_TOLERANCE_PX;
    }));
    const changed = Object.keys(updates).length > 0;

    return {
        state: changed ? { ...sourceState, ...updates } : sourceState,
        updates,
        changed,
        canContain: true,
    };
}

/**
 * Scales only persisted pixel geometry, preserving responsive and absent values.
 * @param {object} state Persisted MovingUI state.
 * @param {object} options Axis scale factors.
 * @param {number} options.scaleX Horizontal scale factor.
 * @param {number} options.scaleY Vertical scale factor.
 * @returns {object}
 */
export function scaleMovingUIViewportState(state, { scaleX, scaleY } = {}) {
    const sourceState = state && typeof state === 'object' ? state : {};
    const scales = {
        width: Number(scaleX),
        left: Number(scaleX),
        right: Number(scaleX),
        height: Number(scaleY),
        top: Number(scaleY),
        bottom: Number(scaleY),
    };
    const updates = {};

    for (const [property, scale] of Object.entries(scales)) {
        const value = parsePixelValue(sourceState[property]);
        if (value !== null && Number.isFinite(scale) && scale > 0) {
            updates[property] = String(roundBound(value * scale));
        }
    }

    return { ...sourceState, ...updates };
}
