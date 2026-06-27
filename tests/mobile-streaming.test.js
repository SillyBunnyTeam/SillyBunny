import {
    ANDROID_REASONING_RENDER_INTERVAL_MS,
    ANDROID_STREAMING_UPDATE_INTERVAL_MS,
    isReducedStreamingDomWorkPlatform,
    getMobileStreamingBottomPinBehavior,
    getStreamingReasoningRenderInterval,
    getStreamingUpdateInterval,
    IOS_REASONING_RENDER_INTERVAL_MS,
    IOS_STREAMING_UPDATE_INTERVAL_MS,
    isSmoothStreamingEffectivelyEnabled,
    shouldReduceStreamingDomWork,
    shouldRenderLiveReasoningContent,
} from '../public/scripts/mobile-streaming.js';

const androidNavigator = {
    platform: 'Linux armv8l',
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/124.0 Mobile Safari/537.36',
    maxTouchPoints: 5,
};

const firefoxAndroidNavigator = {
    platform: 'Linux armv8l',
    userAgent: 'Mozilla/5.0 (Android 14; Mobile; rv:126.0) Gecko/126.0 Firefox/126.0',
    maxTouchPoints: 5,
};

describe('mobile streaming helpers', () => {
    test('detects mobile platforms that need reduced live DOM work', () => {
        expect(isReducedStreamingDomWorkPlatform({ platform: 'iPhone', maxTouchPoints: 1 })).toBe(true);
        expect(isReducedStreamingDomWorkPlatform(androidNavigator)).toBe(true);
        expect(isReducedStreamingDomWorkPlatform(firefoxAndroidNavigator)).toBe(true);
        expect(isReducedStreamingDomWorkPlatform({ platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36', maxTouchPoints: 0 })).toBe(false);
    });

    test('applies platform-specific reduced DOM work toggles', () => {
        expect(shouldReduceStreamingDomWork({ platform: 'iPhone', maxTouchPoints: 1 }, {
            iosEnabled: false,
            androidEnabled: true,
        })).toBe(false);

        expect(shouldReduceStreamingDomWork(androidNavigator, {
            iosEnabled: false,
            androidEnabled: true,
        })).toBe(true);

        expect(shouldReduceStreamingDomWork(firefoxAndroidNavigator, {
            iosEnabled: false,
            androidEnabled: true,
        })).toBe(true);

        expect(shouldReduceStreamingDomWork(androidNavigator, {
            iosEnabled: true,
            androidEnabled: false,
        })).toBe(false);
    });

    test('uses conservative iOS streaming floors', () => {
        expect(IOS_STREAMING_UPDATE_INTERVAL_MS).toBe(250);
        expect(IOS_REASONING_RENDER_INTERVAL_MS).toBe(1500);
    });

    test('uses Android-specific streaming floor constants', () => {
        expect(ANDROID_STREAMING_UPDATE_INTERVAL_MS).toBe(250);
        expect(ANDROID_REASONING_RENDER_INTERVAL_MS).toBe(1500);
    });

    test('keeps desktop streaming intervals unchanged', () => {
        expect(getStreamingUpdateInterval(33, {
            navigatorRef: { platform: 'Linux x86_64', maxTouchPoints: 1 },
        })).toBe(33);
    });

    test('applies an iOS WebKit floor to streaming updates', () => {
        expect(getStreamingUpdateInterval(33, {
            navigatorRef: { platform: 'iPhone', maxTouchPoints: 1 },
        })).toBe(IOS_STREAMING_UPDATE_INTERVAL_MS);

        expect(getStreamingUpdateInterval(500, {
            navigatorRef: { platform: 'iPhone', maxTouchPoints: 1 },
        })).toBe(500);
    });

    test('applies a conservative Android floor to streaming updates', () => {
        expect(getStreamingUpdateInterval(33, {
            navigatorRef: androidNavigator,
        })).toBe(ANDROID_STREAMING_UPDATE_INTERVAL_MS);
    });

    test('uses platform-specific live reasoning render intervals', () => {
        expect(getStreamingReasoningRenderInterval({ platform: 'iPhone', maxTouchPoints: 1 })).toBe(IOS_REASONING_RENDER_INTERVAL_MS);
        expect(getStreamingReasoningRenderInterval(androidNavigator)).toBe(ANDROID_REASONING_RENDER_INTERVAL_MS);
    });

    test('allows iOS WebKit streaming floors to be disabled', () => {
        expect(getStreamingUpdateInterval(33, {
            navigatorRef: { platform: 'iPhone', maxTouchPoints: 1 },
            enabled: false,
        })).toBe(33);
    });

    test('allows Android streaming floors to be disabled independently', () => {
        expect(getStreamingUpdateInterval(33, {
            navigatorRef: androidNavigator,
            iosEnabled: true,
            androidEnabled: false,
        })).toBe(33);
    });

    test('reports effective Smooth Streaming after platform-specific bypasses', () => {
        expect(isSmoothStreamingEffectivelyEnabled({
            smoothStreaming: true,
            iosWebKitDisableSmoothStreaming: true,
            navigatorRef: { platform: 'Linux x86_64', maxTouchPoints: 1 },
        })).toBe(true);

        expect(isSmoothStreamingEffectivelyEnabled({
            smoothStreaming: true,
            iosWebKitDisableSmoothStreaming: true,
            navigatorRef: { platform: 'iPhone', maxTouchPoints: 1 },
        })).toBe(false);

        expect(isSmoothStreamingEffectivelyEnabled({
            smoothStreaming: true,
            iosWebKitDisableSmoothStreaming: true,
            navigatorRef: androidNavigator,
        })).toBe(true);

        expect(isSmoothStreamingEffectivelyEnabled({
            smoothStreaming: true,
            androidDisableSmoothStreaming: true,
            navigatorRef: androidNavigator,
        })).toBe(false);

        expect(isSmoothStreamingEffectivelyEnabled({
            smoothStreaming: true,
            iosWebKitDisableSmoothStreaming: false,
            navigatorRef: { platform: 'iPhone', maxTouchPoints: 1 },
        })).toBe(true);

        expect(isSmoothStreamingEffectivelyEnabled({
            smoothStreaming: false,
            iosWebKitDisableSmoothStreaming: true,
            navigatorRef: { platform: 'iPhone', maxTouchPoints: 1 },
        })).toBe(false);
    });

    test('uses instant streaming bottom pins on reduced mobile platforms', () => {
        expect(getMobileStreamingBottomPinBehavior({
            navigatorRef: { platform: 'Linux x86_64', maxTouchPoints: 1 },
        })).toBe('smooth');

        expect(getMobileStreamingBottomPinBehavior({
            isFinal: true,
            navigatorRef: { platform: 'Linux x86_64', maxTouchPoints: 1 },
        })).toBe('auto');

        expect(getMobileStreamingBottomPinBehavior({
            navigatorRef: { platform: 'iPhone', maxTouchPoints: 1 },
        })).toBe('auto');

        expect(getMobileStreamingBottomPinBehavior({
            navigatorRef: androidNavigator,
        })).toBe('auto');
    });

    test('skips repeated hidden live reasoning renders on reduced DOM platforms', () => {
        expect(shouldRenderLiveReasoningContent({
            isReducedDomWork: true,
            state: 'thinking',
            detailsOpen: false,
            hasRenderedContent: true,
            lastRenderAt: 1000,
            now: 2000,
        })).toBe(false);
    });

    test('renders the first and finished reasoning bodies', () => {
        expect(shouldRenderLiveReasoningContent({
            isReducedDomWork: true,
            state: 'thinking',
            detailsOpen: false,
            hasRenderedContent: false,
            lastRenderAt: 0,
            now: 1000,
        })).toBe(true);

        expect(shouldRenderLiveReasoningContent({
            isReducedDomWork: true,
            state: 'done',
            detailsOpen: false,
            hasRenderedContent: true,
            lastRenderAt: 1000,
            now: 1100,
        })).toBe(true);
    });

    test('throttles open live reasoning renders on reduced DOM platforms', () => {
        expect(shouldRenderLiveReasoningContent({
            isReducedDomWork: true,
            state: 'thinking',
            detailsOpen: true,
            hasRenderedContent: true,
            lastRenderAt: 1000,
            now: 1000 + IOS_REASONING_RENDER_INTERVAL_MS - 1,
        })).toBe(false);

        expect(shouldRenderLiveReasoningContent({
            isReducedDomWork: true,
            state: 'thinking',
            detailsOpen: true,
            hasRenderedContent: true,
            lastRenderAt: 1000,
            now: 1000 + IOS_REASONING_RENDER_INTERVAL_MS,
        })).toBe(true);
    });
});
