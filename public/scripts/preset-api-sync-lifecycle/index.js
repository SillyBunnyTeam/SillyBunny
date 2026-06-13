export const PRESET_API_SYNC_CONNECT_BUTTON_SELECTORS = Object.freeze({
    kobold: '#api_button',
    koboldhorde: '#api_button',
    horde: '#api_button',
    novel: '#api_button_novel',
    openai: '#api_button_openai',
    textgenerationwebui: '#api_button_textgenerationwebui',
});

export const PRESET_API_SYNC_CONNECTION_SOURCE_STATE = Object.freeze({
    MISSING: 'missing',
    READY: 'ready',
});

function normalizeString(value) {
    return String(value ?? '').trim();
}

function stripDecoratedConnectionProfileText(value) {
    return String(value ?? '').replace(/[[(].*?[\])]/g, '').trim();
}

/**
 * Normalizes a main API id for preset/API sync lookups.
 * @param {unknown} value Main API id.
 * @returns {string} Normalized API id.
 */
export function normalizePresetApiId(value) {
    return normalizeString(value).toLowerCase();
}

/**
 * Resolves the current main API id from a DOM select value or context fallback.
 * @param {object} options Options.
 * @param {unknown} [options.selectValue=''] Value read from `#main_api`.
 * @param {unknown} [options.contextMainApi=''] Context fallback.
 * @returns {string} Normalized API id.
 */
export function resolvePresetMainApiValue({
    selectValue = '',
    contextMainApi = '',
} = {}) {
    const normalizedSelectValue = normalizePresetApiId(selectValue);

    if (normalizedSelectValue) {
        return normalizedSelectValue;
    }

    return normalizePresetApiId(contextMainApi);
}

/**
 * Resolves the connect button selector for the active API route.
 * @param {unknown} apiValue Main API id.
 * @param {Record<string, string>} [selectorMap] Optional selector map.
 * @returns {string|null} CSS selector, or null when unsupported.
 */
export function resolvePresetApiConnectButtonSelector(
    apiValue,
    selectorMap = PRESET_API_SYNC_CONNECT_BUTTON_SELECTORS,
) {
    return selectorMap[normalizePresetApiId(apiValue)] ?? null;
}

/**
 * Resolves whether a connection-profile mirror should update the source select.
 * @param {object} options Options.
 * @param {unknown} [options.requestedValue=''] Requested profile id.
 * @param {unknown} [options.currentValue=''] Current source select value.
 * @returns {{shouldSync: boolean, nextValue: string}}
 */
export function resolveConnectionProfileSelectionSync({
    requestedValue = '',
    currentValue = '',
} = {}) {
    const nextValue = normalizeString(requestedValue);

    return {
        nextValue,
        shouldSync: Boolean(nextValue) && normalizeString(currentValue) !== nextValue,
    };
}

/**
 * Resolves how the shell should rebind the source connection-profile select.
 * @param {object} options Options.
 * @param {boolean} [options.isSameSource=false] Whether the current and next source are identical.
 * @param {boolean} [options.hasCurrentSource=false] Whether an old source select is bound.
 * @param {boolean} [options.hasNextSource=false] Whether a new source select is available.
 * @param {boolean} [options.hasChangeHandler=false] Whether the old source has a change handler.
 * @returns {{shouldSkip: boolean, shouldUnbindCurrent: boolean, shouldDisconnectObserver: boolean, shouldStoreNextSource: boolean, shouldClearChangeHandler: boolean, shouldBindNext: boolean}}
 */
export function resolveConnectionProfileSourceBinding({
    isSameSource = false,
    hasCurrentSource = false,
    hasNextSource = false,
    hasChangeHandler = false,
} = {}) {
    const shouldSkip = Boolean(isSameSource);

    return {
        shouldSkip,
        shouldUnbindCurrent: !shouldSkip && Boolean(hasCurrentSource && hasChangeHandler),
        shouldDisconnectObserver: !shouldSkip,
        shouldStoreNextSource: !shouldSkip,
        shouldClearChangeHandler: !shouldSkip,
        shouldBindNext: !shouldSkip && Boolean(hasNextSource),
    };
}

/**
 * Resolves UI state for mirrored connection-profile controls.
 * @param {object} options Options.
 * @param {boolean} [options.hasConnectionProfiles=false] Whether source select exists.
 * @param {boolean} [options.isConnectionStripOpen=false] Whether desktop strip is open.
 * @param {boolean} [options.hasActiveConnectButton=false] Whether active API can connect.
 * @returns {{sourceState: string, shouldShowToggle: boolean, shouldShowDesktopStrip: boolean, shouldCloseDesktopStrip: boolean, shouldClearMirrors: boolean, shouldShowMobileSection: boolean, shouldDisableConnectButton: boolean}}
 */
export function resolveConnectionProfileMirrorState({
    hasConnectionProfiles = false,
    isConnectionStripOpen = false,
    hasActiveConnectButton = false,
} = {}) {
    if (!hasConnectionProfiles) {
        return {
            sourceState: PRESET_API_SYNC_CONNECTION_SOURCE_STATE.MISSING,
            shouldShowToggle: false,
            shouldShowDesktopStrip: false,
            shouldCloseDesktopStrip: true,
            shouldClearMirrors: true,
            shouldShowMobileSection: false,
            shouldDisableConnectButton: true,
        };
    }

    return {
        sourceState: PRESET_API_SYNC_CONNECTION_SOURCE_STATE.READY,
        shouldShowToggle: true,
        shouldShowDesktopStrip: Boolean(isConnectionStripOpen),
        shouldCloseDesktopStrip: false,
        shouldClearMirrors: false,
        shouldShowMobileSection: true,
        shouldDisableConnectButton: !hasActiveConnectButton,
    };
}

/**
 * Resolves mirrored connection-profile control updates without touching DOM.
 * @param {object} options Options.
 * @param {boolean} [options.shouldClearMirrors=false] Whether mirrored controls should be cleared.
 * @param {boolean} [options.shouldShowMobileSection=false] Whether the mobile section should be visible.
 * @param {boolean} [options.shouldDisableConnectButton=true] Whether connect buttons should be disabled.
 * @param {unknown} [options.sourceOptionsMarkup=''] Source select option markup to mirror.
 * @param {unknown} [options.sourceValue=''] Source select value to mirror.
 * @param {unknown} [options.connectionStatusText=''] Current connection status text.
 * @returns {{shouldClearMirrors: boolean, shouldShowMobileSection: boolean, shouldDisableConnectButton: boolean, optionsMarkup: string, selectedValue: string, statusText: string}}
 */
export function resolveConnectionProfileMirrorUpdate({
    shouldClearMirrors = false,
    shouldShowMobileSection = false,
    shouldDisableConnectButton = true,
    sourceOptionsMarkup = '',
    sourceValue = '',
    connectionStatusText = '',
} = {}) {
    const shouldClear = Boolean(shouldClearMirrors);

    return {
        shouldClearMirrors: shouldClear,
        shouldShowMobileSection: Boolean(shouldShowMobileSection),
        shouldDisableConnectButton: Boolean(shouldDisableConnectButton),
        optionsMarkup: shouldClear ? '' : String(sourceOptionsMarkup ?? ''),
        selectedValue: shouldClear ? '' : String(sourceValue ?? ''),
        statusText: shouldClear ? '' : String(connectionStatusText ?? ''),
    };
}

/**
 * Resolves the mirrored connection-profile status label without touching DOM.
 * @param {object} options Options.
 * @param {boolean} [options.hasContext=false] Whether SillyTavern context is available.
 * @param {boolean} [options.isNoConnection=false] Whether the active backend is disconnected.
 * @param {unknown} [options.apiValue='Connected'] API value selected by context or slash command.
 * @param {unknown} [options.modelValue=''] Model/status value selected by context or slash command.
 * @param {unknown} [options.apiOptionText] Decorated API option label, when available.
 * @param {unknown} [options.modelOptionText] Decorated model option label, when available.
 * @returns {string}
 */
export function resolveConnectionProfileStatusText({
    hasContext = false,
    isNoConnection = false,
    apiValue = 'Connected',
    modelValue = '',
    apiOptionText,
    modelOptionText,
} = {}) {
    if (!hasContext) {
        return '';
    }

    if (isNoConnection) {
        return 'No connection...';
    }

    const resolvedApiValue = stripDecoratedConnectionProfileText(apiOptionText ?? apiValue);
    const resolvedModelValue = stripDecoratedConnectionProfileText(modelOptionText ?? modelValue);

    return resolvedModelValue ? `${resolvedApiValue} - ${resolvedModelValue}` : resolvedApiValue;
}

/**
 * Resolves connection-strip state transitions without touching DOM.
 * @param {object} options Options.
 * @param {boolean} [options.shouldOpen=false] Requested strip open state.
 * @param {boolean} [options.hasDesktopStrip=false] Whether the desktop strip exists.
 * @returns {{shouldApply: boolean, nextState: boolean, shouldApplySurfaceExclusivity: boolean}}
 */
export function resolveConnectionStripOpenState({
    shouldOpen = false,
    hasDesktopStrip = false,
} = {}) {
    const nextState = Boolean(shouldOpen);
    const shouldApply = Boolean(hasDesktopStrip);

    return {
        shouldApply,
        nextState,
        shouldApplySurfaceExclusivity: shouldApply && nextState,
    };
}

/**
 * Creates the compatibility-facing preset/API sync lifecycle seam.
 * Runtime call sites should depend on this shape instead of individual helpers.
 * @returns {object}
 */
export function createPresetApiSyncLifecycle() {
    return {
        api: {
            connectButtonSelectors: PRESET_API_SYNC_CONNECT_BUTTON_SELECTORS,
            normalizeId: normalizePresetApiId,
            resolveMainValue: resolvePresetMainApiValue,
            resolveConnectButtonSelector: resolvePresetApiConnectButtonSelector,
        },
        connectionProfiles: {
            sourceState: PRESET_API_SYNC_CONNECTION_SOURCE_STATE,
            resolveSelectionSync: resolveConnectionProfileSelectionSync,
            resolveSourceBinding: resolveConnectionProfileSourceBinding,
            resolveMirrorState: resolveConnectionProfileMirrorState,
            resolveMirrorUpdate: resolveConnectionProfileMirrorUpdate,
            resolveStatusText: resolveConnectionProfileStatusText,
            resolveStripOpenState: resolveConnectionStripOpenState,
        },
    };
}
