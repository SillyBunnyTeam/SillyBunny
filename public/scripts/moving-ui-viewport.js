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

function hasMeaningfulStateChange(state, nextBounds) {
    return MOVING_UI_BOUND_PROPERTIES.some(property => {
        const currentValue = parsePixelValue(state?.[property]);
        return currentValue === null || Math.abs(currentValue - nextBounds[property]) > MOVING_UI_VIEWPORT_TOLERANCE_PX;
    });
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
 * @returns {{state: object, changed: boolean, canContain: boolean}}
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
        return { state: sourceState, changed: false, canContain: false };
    }

    const bounds = getUsableElementBounds(elementBounds)
        ?? getStateBounds(sourceState, safeViewportWidth, safeViewportHeight);
    if (!bounds) {
        return { state: sourceState, changed: false, canContain: false };
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
    const changed = hasMeaningfulStateChange(sourceState, nextBounds);

    return {
        state: changed ? { ...sourceState, ...nextBounds } : sourceState,
        changed,
        canContain: true,
    };
}
