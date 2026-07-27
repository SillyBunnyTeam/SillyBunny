import showdown from 'showdown';

import {
    ANDROID_STREAMING_SETTING_DEFAULTS,
    ANDROID_STREAMING_SETTINGS_INITIALIZED_KEY,
    ANDROID_REASONING_RENDER_INTERVAL_MS,
    ANDROID_STREAMING_UPDATE_INTERVAL_MS,
    formatPlainTextStreamingPreview,
    formatBasicMarkdownStreamingPreview,
    formatMobileStreamingPreview,
    isReducedStreamingDomWorkPlatform,
    getMobileStreamingBottomPinBehavior,
    getStreamingReasoningRenderInterval,
    getStreamingUpdateInterval,
    initializeAndroidStreamingSettings,
    IOS_REASONING_RENDER_INTERVAL_MS,
    IOS_STREAMING_UPDATE_INTERVAL_MS,
    isSmoothStreamingEffectivelyEnabled,
    shouldReduceStreamingDomWork,
    shouldRenderLiveReasoningContent,
    shouldUsePlainTextStreamingPreview,
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
            androidEnabled: true,
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

    test('keeps the legacy enabled option scoped to iOS', () => {
        expect(shouldReduceStreamingDomWork(androidNavigator, { enabled: true })).toBe(false);
        expect(shouldReduceStreamingDomWork(androidNavigator, { enabled: false, androidEnabled: true })).toBe(true);
    });

    test('uses plain text streaming previews only for reduced non-final mobile ticks', () => {
        expect(shouldUsePlainTextStreamingPreview({
            isFinal: false,
            isReducedDomWork: true,
            isAndroidPlatform: true,
            isImpersonate: false,
        })).toBe(true);

        expect(shouldUsePlainTextStreamingPreview({
            isFinal: true,
            isReducedDomWork: true,
            isAndroidPlatform: true,
            isImpersonate: false,
        })).toBe(false);

        expect(shouldUsePlainTextStreamingPreview({
            isFinal: false,
            isReducedDomWork: false,
            isAndroidPlatform: true,
            isImpersonate: false,
        })).toBe(false);

        expect(shouldUsePlainTextStreamingPreview({
            isFinal: false,
            isReducedDomWork: true,
            isAndroidPlatform: true,
            isImpersonate: true,
        })).toBe(false);

        expect(shouldUsePlainTextStreamingPreview({
            isFinal: false,
            isReducedDomWork: true,
            isAndroidPlatform: true,
            isImpersonate: false,
            useBasicMarkdown: true,
        })).toBe(false);

        expect(shouldUsePlainTextStreamingPreview({
            isFinal: false,
            isReducedDomWork: true,
            isAndroidPlatform: false,
            isImpersonate: false,
        })).toBe(false);
    });

    test('escapes plain text streaming previews and preserves line breaks', () => {
        expect(formatPlainTextStreamingPreview('<tag a="1">A & B</tag>\nnext line'))
            .toBe('&lt;tag a=&quot;1&quot;&gt;A &amp; B&lt;/tag&gt;<br>next line');
    });

    test('formats basic markdown streaming previews with limited processing', () => {
        const mockConverter = {
            makeHtml: (text) => text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>'),
        };

        expect(formatBasicMarkdownStreamingPreview('**bold** text', { converter: mockConverter, sanitizeHtml: html => html }))
            .toBe('<strong>bold</strong> text');

        expect(formatBasicMarkdownStreamingPreview('<script>alert("xss")</script>', { converter: mockConverter, sanitizeHtml: html => html }))
            .toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');

        expect(formatBasicMarkdownStreamingPreview('test', { converter: null }))
            .toBe('test');
    });

    test('always sanitizes converter-created links and external media', () => {
        const converter = new showdown.Converter();
        let sanitizerInput = '';
        const sanitizeHtml = (html) => {
            sanitizerInput = html;
            return html
                .replace(/<img[^>]*>/gi, '')
                .replace(/\s+href="(?:javascript:|data:)[^"]*"/gi, '');
        };

        const preview = formatBasicMarkdownStreamingPreview('[click](javascript:alert(1)) ![track](https://private.example/track.png) [data](data:text/html,test)', { converter, sanitizeHtml });

        expect(sanitizerInput).toContain('javascript:');
        expect(preview).not.toContain('javascript:');
        expect(preview).not.toContain('data:text/html');
        expect(preview).not.toContain('<img');
    });

    test('collapses and escapes OOC blocks in plain-text streaming previews', () => {
        const preview = formatMobileStreamingPreview('Visible ((<img src=x onerror=alert(1)> note)) text');

        expect(preview).toContain('Visible <details class="ooc_block">');
        expect(preview).toContain('&lt;img src=x onerror=alert(1)&gt; note');
        expect(preview).toContain('</details> text');
        expect(preview).not.toContain('((<img');
    });

    test('collapses OOC blocks in basic-markdown streaming previews', () => {
        const converter = new showdown.Converter();
        const preview = formatMobileStreamingPreview('**Visible** ((private note))', {
            useBasicMarkdown: true,
            converter,
            sanitizeHtml: html => html,
        });

        expect(preview).toContain('<strong>Visible</strong>');
        expect(preview).toContain('<details class="ooc_block">');
        expect(preview).toContain('<div class="ooc_content">private note</div>');
        expect(preview).not.toContain('((private note))');
    });

    test('initializes only Android settings absent from persisted preferences', () => {
        const saved = {
            android_conservative_streaming: false,
            android_disable_stream_fade_in: false,
        };
        const target = { ...ANDROID_STREAMING_SETTING_DEFAULTS, ...saved };

        expect(initializeAndroidStreamingSettings(target, saved)).toBe(true);
        expect(target.android_conservative_streaming).toBe(false);
        expect(target.android_disable_stream_fade_in).toBe(false);
        expect(target.android_reduce_streaming_work).toBe(true);
        expect(target[ANDROID_STREAMING_SETTINGS_INITIALIZED_KEY]).toBe(true);
    });

    test('does not rerun Android setting migration after its marker exists', () => {
        const saved = {
            [ANDROID_STREAMING_SETTINGS_INITIALIZED_KEY]: true,
            android_reduce_streaming_work: false,
        };
        const target = { ...saved };

        expect(initializeAndroidStreamingSettings(target, saved)).toBe(false);
        expect(target).toEqual(saved);
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
