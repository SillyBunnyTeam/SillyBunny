import { isIOSWebKitPlatform } from './mobile-send-button.js';

export const IOS_STREAMING_UPDATE_INTERVAL_MS = 250;
export const IOS_REASONING_RENDER_INTERVAL_MS = 1500;

const ANDROID_REASONING_RENDER_INTERVAL_MS = IOS_REASONING_RENDER_INTERVAL_MS;

function isAndroidPlatform(navigatorRef = globalThis.navigator) {
    return /Android/i.test(String(navigatorRef?.userAgent || ''));
}

/**
 * Checks whether Smooth Streaming is effectively active for the current platform.
 * @param {object} [options]
 * @param {boolean} [options.smoothStreaming] Whether Smooth Streaming is enabled in settings
 * @param {boolean} [options.iosWebKitDisableSmoothStreaming] Whether iOS WebKit should bypass Smooth Streaming
 * @param {Navigator} [options.navigatorRef] Navigator-like object
 * @returns {boolean}
 */
export function isSmoothStreamingEffectivelyEnabled({
    smoothStreaming = false,
    iosWebKitDisableSmoothStreaming = false,
    navigatorRef = globalThis.navigator,
} = {}) {
    // SillyBunny: let iOS WebKit opt out of smooth streaming even when the global
    // preference is enabled, because that platform is the main regression target.
    return Boolean(smoothStreaming) && !(Boolean(iosWebKitDisableSmoothStreaming) && isIOSWebKitPlatform(navigatorRef));
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
    if (isFinal || !allowSmooth || isIOSWebKitPlatform(navigatorRef)) {
        return 'auto';
    }

    return 'smooth';
}

/**
 * Checks whether live streaming DOM work should be reduced for the current browser.
 * @param {Navigator} [navigatorRef] Navigator-like object
 * @param {object} [options]
 * @param {boolean} [options.enabled] Backwards-compatible iOS WebKit reduction toggle
 * @param {boolean} [options.iosEnabled] Whether the iOS WebKit reduction is enabled
 * @param {boolean} [options.androidEnabled] Whether the Android reduction is enabled
 * @returns {boolean}
 */
export function shouldReduceStreamingDomWork(navigatorRef = globalThis.navigator, { enabled = true, iosEnabled = enabled, androidEnabled = false } = {}) {
    return (Boolean(iosEnabled) && isIOSWebKitPlatform(navigatorRef))
        || (Boolean(androidEnabled) && isAndroidPlatform(navigatorRef));
}

/**
 * Resolves the minimum live reasoning render interval for reduced streaming platforms.
 * @param {Navigator} [navigatorRef] Navigator-like object
 * @returns {number}
 */
export function getStreamingReasoningRenderInterval(navigatorRef = globalThis.navigator) {
    if (isAndroidPlatform(navigatorRef)) {
        return ANDROID_REASONING_RENDER_INTERVAL_MS;
    }

    return IOS_REASONING_RENDER_INTERVAL_MS;
}

/**
 * Applies an iOS WebKit floor to live streaming UI updates.
 * @param {number} baseIntervalMs Requested streaming interval
 * @param {object} [options]
 * @param {Navigator} [options.navigatorRef] Navigator-like object
 * @param {boolean} [options.enabled] Whether the iOS WebKit floor is enabled
 * @returns {number}
 */
export function getStreamingUpdateInterval(baseIntervalMs, { navigatorRef = globalThis.navigator, enabled = true } = {}) {
    const interval = Number(baseIntervalMs);
    const normalizedInterval = Number.isFinite(interval) && interval > 0 ? interval : 1;

    if (!shouldReduceStreamingDomWork(navigatorRef, { enabled })) {
        return normalizedInterval;
    }

    return Math.max(normalizedInterval, IOS_STREAMING_UPDATE_INTERVAL_MS);
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
