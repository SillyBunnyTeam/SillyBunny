const IOS_KEYBOARD_MIN_HEIGHT_PX = 80;
const IOS_KEYBOARD_PAN_THRESHOLD_PX = 2;
const IOS_KEYBOARD_LAYOUT_WIDTH_EPSILON_PX = 8;
const IOS_KEYBOARD_ESTIMATED_HEIGHT_RATIO = 0.52;
const IOS_KEYBOARD_ESTIMATED_MIN_HEIGHT_PX = 160;
const IOS_KEYBOARD_ESTIMATED_MAX_HEIGHT_PX = 480;
const IOS_COMPOSER_FOCUS_CLEARANCE_PX = 16;

function readViewportNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, number) : fallback;
}

function estimateIOSKeyboardHeight(layoutHeight) {
    const height = readViewportNumber(layoutHeight);
    const estimate = Math.round(height * IOS_KEYBOARD_ESTIMATED_HEIGHT_RATIO);
    return Math.min(height, Math.max(IOS_KEYBOARD_ESTIMATED_MIN_HEIGHT_PX, Math.min(IOS_KEYBOARD_ESTIMATED_MAX_HEIGHT_PX, estimate)));
}

/**
 * Resolves the shell inset without depending on browser state so first-focus,
 * viewport-pan, and orientation transitions can be covered independently.
 */
export function resolveIOSComposerKeyboardInset({
    layoutWidth,
    layoutHeight,
    visualHeight,
    visualTop,
    composerFocused,
    composerFocusPending = false,
    preShiftActive,
    rememberedKeyboardHeight = 0,
    rememberedLayoutWidth = 0,
}) {
    const width = readViewportNumber(layoutWidth);
    const height = readViewportNumber(layoutHeight);
    const visibleHeight = readViewportNumber(visualHeight, height);
    const viewportTop = readViewportNumber(visualTop);
    const layoutWidthChanged = rememberedLayoutWidth > 0
        && Math.abs(width - rememberedLayoutWidth) > IOS_KEYBOARD_LAYOUT_WIDTH_EPSILON_PX;
    const usableRememberedHeight = layoutWidthChanged ? 0 : readViewportNumber(rememberedKeyboardHeight);
    const measuredKeyboardHeight = Math.max(0, height - visibleHeight);
    const hasMeasuredKeyboard = measuredKeyboardHeight > IOS_KEYBOARD_MIN_HEIGHT_PX;
    const keyboardOpen = hasMeasuredKeyboard || viewportTop > IOS_KEYBOARD_PAN_THRESHOLD_PX;
    const composerActive = composerFocused || composerFocusPending;
    const openingInset = usableRememberedHeight > IOS_KEYBOARD_MIN_HEIGHT_PX
        ? usableRememberedHeight
        : estimateIOSKeyboardHeight(height);
    let nextRememberedHeight = usableRememberedHeight;

    if (hasMeasuredKeyboard) {
        nextRememberedHeight = composerActive && preShiftActive
            ? Math.max(measuredKeyboardHeight, openingInset)
            : measuredKeyboardHeight;
    }

    let inset = 0;
    if (composerActive && keyboardOpen) {
        inset = hasMeasuredKeyboard
            ? (preShiftActive ? Math.max(measuredKeyboardHeight, openingInset) : measuredKeyboardHeight)
            : openingInset;
    } else if (composerActive && preShiftActive) {
        inset = openingInset;
    }

    const focusSafeInset = inset > 0 ? Math.min(height, inset + IOS_COMPOSER_FOCUS_CLEARANCE_PX) : 0;

    return {
        inset: Math.round(focusSafeInset),
        rememberedKeyboardHeight: Math.round(nextRememberedHeight),
        rememberedLayoutWidth: Math.round(width),
    };
}
