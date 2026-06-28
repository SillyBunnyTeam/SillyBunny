import { isIOSWebKitPlatform } from './mobile-send-button.js';

export const IOS_STREAMING_UPDATE_INTERVAL_MS = 250;
export const IOS_REASONING_RENDER_INTERVAL_MS = 1500;
export const ANDROID_STREAMING_UPDATE_INTERVAL_MS = 250;
export const ANDROID_REASONING_RENDER_INTERVAL_MS = 1500;

/**
 * Detects Android browser surfaces, including Chromium mobile emulation.
 * @param {Navigator} [navigatorRef] Navigator-like object
 * @returns {boolean}
 */
export function isAndroidStreamingPlatform(navigatorRef = globalThis.navigator) {
    if (!navigatorRef) {
        return false;
    }

    const userAgent = String(navigatorRef.userAgent || '');
    const platform = String(navigatorRef.platform || '');
    const userAgentDataPlatform = String(navigatorRef.userAgentData?.platform || '');
    return /Android/i.test(`${userAgent} ${platform} ${userAgentDataPlatform}`);
}

/**
 * Checks whether the browser should use reduced live streaming DOM work.
 * @param {Navigator} [navigatorRef] Navigator-like object
 * @returns {boolean}
 */
export function isReducedStreamingDomWorkPlatform(navigatorRef = globalThis.navigator) {
    return isIOSWebKitPlatform(navigatorRef) || isAndroidStreamingPlatform(navigatorRef);
}

function shouldUsePlatformStreamingReduction(navigatorRef, { enabled = undefined, iosEnabled = true, androidEnabled = true } = {}) {
    if (enabled !== undefined) {
        return Boolean(enabled) && isReducedStreamingDomWorkPlatform(navigatorRef);
    }

    if (isIOSWebKitPlatform(navigatorRef)) {
        return Boolean(iosEnabled);
    }

    if (isAndroidStreamingPlatform(navigatorRef)) {
        return Boolean(androidEnabled);
    }

    return false;
}

function getStreamingUpdateIntervalFloor(navigatorRef = globalThis.navigator) {
    if (isAndroidStreamingPlatform(navigatorRef)) {
        return ANDROID_STREAMING_UPDATE_INTERVAL_MS;
    }

    return IOS_STREAMING_UPDATE_INTERVAL_MS;
}

/**
 * Gets the minimum live reasoning render interval for the current mobile platform.
 * @param {Navigator} [navigatorRef] Navigator-like object
 * @returns {number}
 */
export function getStreamingReasoningRenderInterval(navigatorRef = globalThis.navigator) {
    if (isAndroidStreamingPlatform(navigatorRef)) {
        return ANDROID_REASONING_RENDER_INTERVAL_MS;
    }

    return IOS_REASONING_RENDER_INTERVAL_MS;
}

/**
 * Checks whether Smooth Streaming is effectively active for the current platform.
 * @param {object} [options]
 * @param {boolean} [options.smoothStreaming] Whether Smooth Streaming is enabled in settings
 * @param {boolean} [options.iosWebKitDisableSmoothStreaming] Whether iOS WebKit should bypass Smooth Streaming
 * @param {boolean} [options.androidDisableSmoothStreaming] Whether Android should bypass Smooth Streaming
 * @param {Navigator} [options.navigatorRef] Navigator-like object
 * @returns {boolean}
 */
export function isSmoothStreamingEffectivelyEnabled({
    smoothStreaming = false,
    iosWebKitDisableSmoothStreaming = false,
    androidDisableSmoothStreaming = false,
    navigatorRef = globalThis.navigator,
} = {}) {
    const shouldBypassSmoothStreaming = shouldUsePlatformStreamingReduction(navigatorRef, {
        iosEnabled: iosWebKitDisableSmoothStreaming,
        androidEnabled: androidDisableSmoothStreaming,
    });
    return Boolean(smoothStreaming) && !shouldBypassSmoothStreaming;
}

/**
 * Resolves the scroll behavior for mobile streaming bottom pins.
 * Native smooth scrolling can keep running after an iOS touch gesture starts,
 * which makes streaming fight manual/momentum scroll and visibly snap.
 * @param {object} [options]
 * @param {boolean} [options.isFinal] Whether this is the final streaming pin
 * @param {boolean} [options.allowSmooth] Whether the scheduler requested a smooth intermediate pin
 * @param {Navigator} [options.navigatorRef] Navigator-like object
 * @returns {'auto'|'smooth'}
 */
export function getMobileStreamingBottomPinBehavior({
    isFinal = false,
    allowSmooth = true,
    navigatorRef = globalThis.navigator,
} = {}) {
    if (isFinal || !allowSmooth || isReducedStreamingDomWorkPlatform(navigatorRef)) {
        return 'auto';
    }

    return 'smooth';
}

/**
 * Checks whether live streaming DOM work should be reduced for the current browser.
 * @param {Navigator} [navigatorRef] Navigator-like object
 * @param {object} [options]
 * @param {boolean} [options.enabled] Legacy all-mobile reduction toggle
 * @param {boolean} [options.iosEnabled] Whether the iOS WebKit reduction is enabled
 * @param {boolean} [options.androidEnabled] Whether the Android reduction is enabled
 * @returns {boolean}
 */
export function shouldReduceStreamingDomWork(navigatorRef = globalThis.navigator, options = {}) {
    return shouldUsePlatformStreamingReduction(navigatorRef, options);
}

/**
 * Applies a conservative floor to live streaming UI updates on reduced-DOM mobile platforms.
 * @param {number} baseIntervalMs Requested streaming interval
 * @param {object} [options]
 * @param {Navigator} [options.navigatorRef] Navigator-like object
 * @param {boolean} [options.enabled] Legacy all-mobile override
 * @param {boolean} [options.iosEnabled] Whether iOS WebKit floor is enabled
 * @param {boolean} [options.androidEnabled] Whether Android floor is enabled
 * @returns {number}
 */
export function getStreamingUpdateInterval(baseIntervalMs, { navigatorRef = globalThis.navigator, enabled = undefined, iosEnabled = true, androidEnabled = true } = {}) {
    const interval = Number(baseIntervalMs);
    const normalizedInterval = Number.isFinite(interval) && interval > 0 ? interval : 1;

    if (!shouldReduceStreamingDomWork(navigatorRef, { enabled, iosEnabled, androidEnabled })) {
        return normalizedInterval;
    }

    return Math.max(normalizedInterval, getStreamingUpdateIntervalFloor(navigatorRef));
}

/**
 * Decides whether a live reasoning body should be rendered on this streaming tick.
 * @param {object} options
 * @param {boolean} options.isReducedDomWork Whether live DOM work is reduced for the platform
 * @param {string} options.state Current reasoning state
 * @param {boolean} options.detailsOpen Whether the reasoning details panel is open
 * @param {boolean} options.hasRenderedContent Whether the reasoning body already has rendered content
 * @param {number} options.lastRenderAt Last render timestamp
 * @param {number} options.now Current timestamp
 * @param {number} [options.minIntervalMs] Minimum interval between open-panel renders
 * @returns {boolean}
 */
export function shouldRenderLiveReasoningContent({
    isReducedDomWork,
    state,
    detailsOpen,
    hasRenderedContent,
    lastRenderAt,
    now,
    minIntervalMs = IOS_REASONING_RENDER_INTERVAL_MS,
}) {
    if (!isReducedDomWork || state !== 'thinking' || !hasRenderedContent) {
        return true;
    }

    if (!detailsOpen) {
        return false;
    }

    return now - lastRenderAt >= minIntervalMs;
}
