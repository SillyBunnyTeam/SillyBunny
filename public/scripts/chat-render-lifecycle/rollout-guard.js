export const CHAT_RENDER_LIFECYCLE_ROLLOUT_KEY = 'sillybunny.chatRenderLifecycle.enabled';
export const CHAT_RENDER_LIFECYCLE_ROUTE = Object.freeze({
    BOTTOM_SCROLL: 'bottom-scroll',
    INITIAL_LOAD: 'initial-load',
    MEDIA_RESIZE: 'media-resize',
    MESSAGE_UPDATE: 'message-update',
    MOBILE_VIEWPORT: 'mobile-viewport',
    REDISPLAY_BATCH: 'redisplay-batch',
    REPLACE_MESSAGE: 'replace-message',
    SHOW_MORE_BATCH: 'show-more-batch',
    STREAM_PROGRESS: 'stream-progress',
    STREAM_START: 'stream-start',
});
export const CHAT_RENDER_LIFECYCLE_ROUTE_DEFAULTS = Object.freeze({
    [CHAT_RENDER_LIFECYCLE_ROUTE.BOTTOM_SCROLL]: true,
    [CHAT_RENDER_LIFECYCLE_ROUTE.INITIAL_LOAD]: true,
    [CHAT_RENDER_LIFECYCLE_ROUTE.MEDIA_RESIZE]: true,
    [CHAT_RENDER_LIFECYCLE_ROUTE.MESSAGE_UPDATE]: true,
    [CHAT_RENDER_LIFECYCLE_ROUTE.MOBILE_VIEWPORT]: true,
    [CHAT_RENDER_LIFECYCLE_ROUTE.REDISPLAY_BATCH]: true,
    [CHAT_RENDER_LIFECYCLE_ROUTE.REPLACE_MESSAGE]: true,
    [CHAT_RENDER_LIFECYCLE_ROUTE.SHOW_MORE_BATCH]: true,
    [CHAT_RENDER_LIFECYCLE_ROUTE.STREAM_PROGRESS]: true,
    [CHAT_RENDER_LIFECYCLE_ROUTE.STREAM_START]: true,
});

function parseBooleanOverride(value) {
    if (value === true || value === 'true' || value === '1') {
        return true;
    }

    if (value === false || value === 'false' || value === '0') {
        return false;
    }

    return null;
}

function readStorageOverride(storage) {
    if (!storage || typeof storage.getItem !== 'function') {
        return null;
    }

    try {
        return parseBooleanOverride(storage.getItem(CHAT_RENDER_LIFECYCLE_ROLLOUT_KEY));
    } catch {
        return null;
    }
}

function resolveDefaultEnabled({ defaultEnabled, route, routeDefaults }) {
    if (typeof defaultEnabled === 'boolean') {
        return defaultEnabled;
    }

    if (!route || !routeDefaults || !Object.prototype.hasOwnProperty.call(routeDefaults, route)) {
        return false;
    }

    return Boolean(routeDefaults[route]);
}

/**
 * Resolves the device-local lifecycle kill switch and per-route defaults.
 * @param {object} [options] Options.
 * @param {boolean} [options.defaultEnabled] Explicit default override.
 * @param {string|boolean|null} [options.queryValue] Explicit query override value.
 * @param {string|null} [options.route] Lifecycle route name.
 * @param {Record<string, boolean>} [options.routeDefaults] Per-route default map.
 * @param {{getItem: (key: string) => string|null}|null} [options.storage] Device-local override source.
 * @returns {{enabled: boolean, source: 'query'|'storage'|'default'}}
 */
export function resolveChatRenderLifecycleRollout({
    defaultEnabled,
    queryValue = null,
    route = null,
    routeDefaults = CHAT_RENDER_LIFECYCLE_ROUTE_DEFAULTS,
    storage = null,
} = {}) {
    const queryOverride = parseBooleanOverride(queryValue);

    if (queryOverride !== null) {
        return { enabled: queryOverride, source: 'query' };
    }

    const storageOverride = readStorageOverride(storage);

    if (storageOverride !== null) {
        return { enabled: storageOverride, source: 'storage' };
    }

    return {
        enabled: resolveDefaultEnabled({ defaultEnabled, route, routeDefaults }),
        source: 'default',
    };
}
