import { isIOSWebKitPlatform } from './mobile-send-button.js';

export const IOS_STREAMING_UPDATE_INTERVAL_MS = 250;
export const IOS_REASONING_RENDER_INTERVAL_MS = 1500;
export const ANDROID_STREAMING_UPDATE_INTERVAL_MS = 250;
export const ANDROID_REASONING_RENDER_INTERVAL_MS = 1500;
export const ANDROID_STREAMING_SETTING_DEFAULTS = Object.freeze({
    android_conservative_streaming: true,
    android_reduce_streaming_work: true,
    android_disable_smooth_streaming: true,
    android_disable_stream_fade_in: true,
    android_streaming_basic_markdown: false,
});
export const ANDROID_STREAMING_SETTINGS_INITIALIZED_KEY = 'android_streaming_settings_initialized';
const STREAMING_PREVIEW_ESCAPE_MAP = Object.freeze({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    '\'': '&#39;',
});

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

function shouldUsePlatformStreamingReduction(navigatorRef, { enabled = true, iosEnabled = enabled, androidEnabled = false } = {}) {
    if (isIOSWebKitPlatform(navigatorRef)) {
        return Boolean(iosEnabled);
    }

    if (isAndroidStreamingPlatform(navigatorRef)) {
        return Boolean(androidEnabled);
    }

    return false;
}

/**
 * Initializes newly added Android settings without replacing values saved by earlier releases.
 * @param {Record<string, any>} target Loaded power-user settings
 * @param {Record<string, any> | undefined} savedSettings Persisted power-user settings
 * @returns {boolean} Whether the initialization marker was added
 */
export function initializeAndroidStreamingSettings(target, savedSettings) {
    const saved = savedSettings && typeof savedSettings === 'object' ? savedSettings : {};
    if (Object.hasOwn(saved, ANDROID_STREAMING_SETTINGS_INITIALIZED_KEY)) {
        return false;
    }

    for (const [key, value] of Object.entries(ANDROID_STREAMING_SETTING_DEFAULTS)) {
        if (!Object.hasOwn(saved, key)) {
            target[key] = value;
        }
    }

    target[ANDROID_STREAMING_SETTINGS_INITIALIZED_KEY] = true;
    return true;
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
 * Checks whether reduced mobile streaming should use a plain-text preview before the final render.
 * @param {object} options Options
 * @param {boolean} [options.isFinal] Whether this is the final streamed render
 * @param {boolean} [options.isReducedDomWork] Whether reduced mobile DOM work is active
 * @param {boolean} [options.isAndroidPlatform] Whether the current browser is Android
 * @param {boolean} [options.isImpersonate] Whether the stream writes to the user input box
 * @param {boolean} [options.useBasicMarkdown] Whether to use basic markdown (middle ground)
 * @returns {boolean}
 */
export function shouldUsePlainTextStreamingPreview({
    isFinal = false,
    isReducedDomWork = false,
    isAndroidPlatform = false,
    isImpersonate = false,
    useBasicMarkdown = false,
} = {}) {
    return Boolean(isReducedDomWork) && Boolean(isAndroidPlatform) && !isFinal && !isImpersonate && !useBasicMarkdown;
}

/**
 * Formats an interim streaming preview without running the full markdown and sanitizer pipeline.
 * The final streamed render still uses normal message formatting.
 * @param {string} text Raw streamed message text
 * @returns {string} Safe HTML preview
 */
export function formatPlainTextStreamingPreview(text = '') {
    if (!text) {
        return '';
    }

    const str = String(text);
    let result = '';
    let lastIndex = 0;

    for (let i = 0; i < str.length; i++) {
        const char = str[i];
        const replacement = STREAMING_PREVIEW_ESCAPE_MAP[char];

        if (replacement) {
            result += str.slice(lastIndex, i) + replacement;
            lastIndex = i + 1;
        } else if (char === '\r') {
            result += str.slice(lastIndex, i);
            lastIndex = i + 1;
            if (str[i + 1] === '\n') {
                i++;
                lastIndex = i + 1;
            }
            result += '<br>';
        } else if (char === '\n') {
            result += str.slice(lastIndex, i) + '<br>';
            lastIndex = i + 1;
        }
    }

    if (lastIndex < str.length) {
        result += str.slice(lastIndex);
    }

    return result;
}

/**
 * Formats streaming preview with basic markdown and the production message sanitizer.
 * @param {string} text Raw streamed message text
 * @param {object} context Context object with converter
 * @param {import('showdown').Converter} context.converter Showdown converter instance
 * @param {(html: string) => string} context.sanitizeHtml Production message sanitizer
 * @returns {string} Basic markdown HTML
 */
export function formatBasicMarkdownStreamingPreview(text = '', { converter = null, sanitizeHtml = null } = {}) {
    if (!text) {
        return '';
    }

    if (!converter || typeof converter.makeHtml !== 'function' || typeof sanitizeHtml !== 'function') {
        return formatPlainTextStreamingPreview(text);
    }

    try {
        const str = String(text);
        let escaped = '';
        let lastIndex = 0;

        for (let i = 0; i < str.length; i++) {
            const char = str[i];
            const replacement = STREAMING_PREVIEW_ESCAPE_MAP[char];

            if (replacement) {
                escaped += str.slice(lastIndex, i) + replacement;
                lastIndex = i + 1;
            }
        }

        if (lastIndex < str.length) {
            escaped += str.slice(lastIndex);
        }

        let mes = escaped.replaceAll('\\begin{align*}', '$$').replaceAll('\\end{align*}', '$$');
        mes = converter.makeHtml(mes);
        mes = mes.replace(/<code(.*)>[\s\S]*?<\/code>/g, function (match) {
            return match.replace(/\n/gm, '\u0000');
        });
        mes = mes.replace(/\u0000/g, '\n');

        return String(sanitizeHtml(mes)).trim();
    } catch (error) {
        console.warn('[Mobile Streaming] Basic markdown formatting failed:', error);
        return formatPlainTextStreamingPreview(text);
    }
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
export function getStreamingUpdateInterval(baseIntervalMs, { navigatorRef = globalThis.navigator, enabled = true, iosEnabled = enabled, androidEnabled = false } = {}) {
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
