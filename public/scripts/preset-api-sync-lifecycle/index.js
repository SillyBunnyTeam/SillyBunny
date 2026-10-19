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
 * @returns {{sourceState: string, shouldClearMirrors: boolean, shouldShowMobileSection: boolean}}
 */
export function resolveConnectionProfileMirrorState({
    hasConnectionProfiles = false,
} = {}) {
    if (!hasConnectionProfiles) {
        return {
            sourceState: PRESET_API_SYNC_CONNECTION_SOURCE_STATE.MISSING,
            shouldClearMirrors: true,
            shouldShowMobileSection: false,
        };
    }

    return {
        sourceState: PRESET_API_SYNC_CONNECTION_SOURCE_STATE.READY,
        shouldClearMirrors: false,
        shouldShowMobileSection: true,
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
            normalizeId: normalizePresetApiId,
            resolveMainValue: resolvePresetMainApiValue,
        },
        connectionProfiles: {
            sourceState: PRESET_API_SYNC_CONNECTION_SOURCE_STATE,
            resolveSelectionSync: resolveConnectionProfileSelectionSync,
            resolveMirrorState: resolveConnectionProfileMirrorState,
        },
    };
}
