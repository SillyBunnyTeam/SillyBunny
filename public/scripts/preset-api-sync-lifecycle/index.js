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
            resolveMirrorState: resolveConnectionProfileMirrorState,
        },
    };
}
