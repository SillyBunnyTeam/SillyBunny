/* global globalThis */
import { describe, expect, test } from '@jest/globals';

import {
    collectBudgetFailures,
    createLongChatRenderFixture,
    createStreamingRenderFixture,
    LONG_CHAT_RENDER_FILLER_REPEAT,
    LONG_CHAT_RENDER_MESSAGE_COUNT,
    LONG_CHAT_RENDER_VISIBLE_COUNT,
    measureLongChatRender,
    measureProfile,
    measureScrollFps,
    measureStreamingRender,
    parseProfileNames,
    STREAM_RENDER_CODE_REPEAT,
    STREAM_RENDER_FILLER_REPEAT,
    STREAM_RENDER_STEP_COUNT,
    summarizeRequestByteFields,
    summarizeRequests,
} from '../scripts/measure-frontend-performance.js';

function createScrollMeasurementPage(scroller) {
    return {
        evaluate: async (callback) => {
            const previousDocument = globalThis.document;
            const previousPerformance = globalThis.performance;
            const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
            let frameTime = 0;

            try {
                globalThis.document = {
                    getElementById: () => scroller,
                    scrollingElement: null,
                };
                globalThis.performance = {
                    now: () => 0,
                };
                globalThis.requestAnimationFrame = callbackRef => {
                    frameTime += 500;
                    callbackRef(frameTime);
                };

                return await callback();
            } finally {
                globalThis.document = previousDocument;
                globalThis.performance = previousPerformance;
                globalThis.requestAnimationFrame = previousRequestAnimationFrame;
            }
        },
    };
}

describe('frontend performance measurement helpers', () => {
    test('records the long-chat render fixture size used for baseline measurements', () => {
        const fixture = createLongChatRenderFixture();

        expect(fixture.messageCount).toBe(LONG_CHAT_RENDER_MESSAGE_COUNT);
        expect(fixture.visibleCount).toBe(LONG_CHAT_RENDER_VISIBLE_COUNT);
        expect(fixture.fillerRepeat).toBe(LONG_CHAT_RENDER_FILLER_REPEAT);
        expect(fixture.messages).toHaveLength(96);
        expect(fixture.messages.at(0)).toEqual(expect.objectContaining({
            name: 'Scroll Tester',
            is_user: true,
            is_system: false,
        }));
        expect(fixture.messages.at(1)).toEqual(expect.objectContaining({
            name: 'Bunny Guide',
            is_user: false,
            is_system: false,
        }));
        expect(fixture.messages.at(-1).mes).toContain('performance synthetic message 95');
    });

    test('summarizes request bytes by asset type', () => {
        expect(summarizeRequests([
            { url: 'http://example.test/script.js', bytes: 12 },
            { url: 'http://example.test/styles.css?v=1', bytes: 20 },
            { url: 'http://example.test/font.woff2', bytes: 30 },
            { url: 'http://example.test/image.webp', bytes: 40 },
            { url: 'http://example.test/api/status', bytes: 50 },
        ])).toEqual({
            count: 5,
            js: 12,
            css: 20,
            font: 30,
            image: 40,
            other: 50,
        });
    });

    test('summarizes transfer and body-size request byte fields separately', () => {
        expect(summarizeRequestByteFields([
            {
                url: 'http://example.test/script.js',
                bytes: 0,
                encodedBodySize: 120,
                decodedBodySize: 240,
            },
            {
                url: 'http://example.test/styles.css',
                bytes: 30,
                encodedBodySize: 40,
                decodedBodySize: 80,
            },
        ])).toEqual({
            transfer: {
                count: 2,
                js: 0,
                css: 30,
                font: 0,
                image: 0,
                other: 0,
            },
            encoded: {
                count: 2,
                js: 120,
                css: 40,
                font: 0,
                image: 0,
                other: 0,
            },
            decoded: {
                count: 2,
                js: 240,
                css: 80,
                font: 0,
                image: 0,
                other: 0,
            },
            zeroTransferCount: 1,
            zeroTransferWithEncodedBodyCount: 1,
        });
    });

    test('creates a streaming render fixture with cumulative steps', () => {
        const fixture = createStreamingRenderFixture();

        expect(fixture.stepCount).toBe(STREAM_RENDER_STEP_COUNT);
        expect(fixture.fillerRepeat).toBe(STREAM_RENDER_FILLER_REPEAT);
        expect(fixture.codeRepeat).toBe(STREAM_RENDER_CODE_REPEAT);
        expect(fixture.steps).toHaveLength(STREAM_RENDER_STEP_COUNT);
        expect(fixture.steps.at(0).length).toBeGreaterThan(0);
        expect(fixture.steps.at(-1)).toBe(fixture.fullText);
        expect(fixture.fullText).toContain('```js');
    });

    test('parses requested performance profile names', () => {
        expect(parseProfileNames('mobile, desktop, mobile')).toEqual(['mobile', 'desktop']);
        expect(parseProfileNames('')).toEqual(['mobile', 'desktop']);
        expect(() => parseProfileNames('mobile,unknown')).toThrow('Unknown performance profile');
    });

    test('collects max budget failures by metric path', () => {
        const result = {
            profiles: {
                mobile: {
                    cold: {
                        requests: {
                            js: 120,
                        },
                    },
                },
            },
        };

        expect(collectBudgetFailures(result, {
            max: {
                'profiles.mobile.cold.requests.js': 100,
                'profiles.mobile.cold.requests.css': 100,
            },
        })).toEqual([
            {
                path: 'profiles.mobile.cold.requests.js',
                expected: '<= 100',
                actual: 120,
                reason: 'over_budget',
            },
            {
                path: 'profiles.mobile.cold.requests.css',
                expected: 'number <= 100',
                actual: null,
                reason: 'missing_metric',
            },
        ]);
    });

    test('measures long-chat render timing through the browser page contract', async () => {
        const page = {
            evaluate: async (callback, fixture) => {
                const previousGlobal = globalThis.SillyTavern;
                const previousDocument = globalThis.document;
                const previousHTMLElement = globalThis.HTMLElement;
                const previousPerformance = globalThis.performance;
                const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
                const renderedMessages = [];
                const chatElement = {
                    scrollHeight: 1200,
                    clientHeight: 500,
                    scrollTop: 700,
                    replaceChildren: () => renderedMessages.splice(0),
                    querySelectorAll: () => renderedMessages,
                };
                const context = {
                    powerUserSettings: {},
                    chat: [],
                    printMessages: async () => {
                        renderedMessages.push(...fixture.messages.slice(-fixture.visibleCount).map((message, offset) => ({
                            getAttribute: attributeName => attributeName === 'mesid'
                                ? String(fixture.messageCount - fixture.visibleCount + offset)
                                : null,
                        })));
                    },
                };

                try {
                    globalThis.HTMLElement = Object;
                    globalThis.document = {
                        querySelector: () => chatElement,
                    };
                    globalThis.SillyTavern = {
                        getContext: () => context,
                    };
                    globalThis.performance = {
                        now: (() => {
                            let now = 100;
                            return () => {
                                now += 25;
                                return now;
                            };
                        })(),
                    };
                    globalThis.requestAnimationFrame = callbackRef => callbackRef();

                    return await callback(fixture);
                } finally {
                    globalThis.SillyTavern = previousGlobal;
                    globalThis.document = previousDocument;
                    globalThis.HTMLElement = previousHTMLElement;
                    globalThis.performance = previousPerformance;
                    globalThis.requestAnimationFrame = previousRequestAnimationFrame;
                }
            },
        };

        const result = await measureLongChatRender(page, createLongChatRenderFixture());

        expect(result).toEqual(expect.objectContaining({
            available: true,
            durationMs: 25,
            messageCount: 96,
            visibleCount: 24,
            fillerRepeat: 36,
            renderedCount: 24,
            firstRenderedMesId: '72',
            lastRenderedMesId: '95',
            bottomDelta: 0,
        }));
        expect(result.fixture).toEqual({
            messageCount: 96,
            visibleCount: 24,
            fillerRepeat: 36,
        });
    });

    test('measures synthetic streaming render work through the browser page contract', async () => {
        const plainPreviewModuleUrl = `data:text/javascript,${encodeURIComponent('export const formatPlainTextStreamingPreview = text => text;')}`;
        const page = {
            evaluate: async (callback, fixture) => {
                const previousGlobal = globalThis.SillyTavern;
                const previousDocument = globalThis.document;
                const previousPerformance = globalThis.performance;
                const previousRequestAnimationFrame = globalThis.requestAnimationFrame;

                const selectorResults = {
                    '*': [{}, {}],
                    'pre code': [{}],
                };
                const createElement = () => ({
                    className: '',
                    innerHTML: '',
                    appendChild: () => {},
                    remove: () => {},
                    setAttribute: () => {},
                    querySelectorAll: selector => selectorResults[selector],
                });
                const chatElement = createElement();
                const context = {
                    chat: [],
                    messageFormatting: text => `<p>${text}</p><pre><code>sample</code></pre>`,
                };
                let now = 100;

                try {
                    globalThis.document = {
                        body: createElement(),
                        createElement,
                        querySelector: () => chatElement,
                    };
                    globalThis.SillyTavern = {
                        getContext: () => context,
                    };
                    globalThis.performance = {
                        now: () => {
                            now += 5;
                            return now;
                        },
                    };
                    globalThis.requestAnimationFrame = callbackRef => {
                        now += 100;
                        callbackRef(now);
                    };

                    return await callback(fixture);
                } finally {
                    globalThis.SillyTavern = previousGlobal;
                    globalThis.document = previousDocument;
                    globalThis.performance = previousPerformance;
                    globalThis.requestAnimationFrame = previousRequestAnimationFrame;
                }
            },
        };

        const result = await measureStreamingRender(page, createStreamingRenderFixture({
            stepCount: 2,
            fillerRepeat: 1,
            codeRepeat: 1,
        }), { plainPreviewModuleUrl });

        expect(result).toEqual(expect.objectContaining({
            available: true,
            totalMs: 65,
            averageStepMs: 32.5,
            stepCount: 2,
            fillerRepeat: 1,
            codeRepeat: 1,
            domNodeCount: 2,
            codeBlockCount: 1,
        }));
        expect(result.formatTotalMs).toBeGreaterThan(0);
        expect(result.writeTotalMs).toBeGreaterThan(0);
        expect(result.finalHtmlBytes).toBeGreaterThan(0);
        expect(result.plainPreview).toEqual(expect.objectContaining({
            available: true,
            totalMs: 65,
            averageStepMs: 32.5,
        }));
        expect(result.fixture).toEqual({
            stepCount: 2,
            fillerRepeat: 1,
            codeRepeat: 1,
        });
    });

    test('measures scroll FPS upward from the bottom and records actual movement', async () => {
        let scrollTop = 100;
        const scroller = {
            scrollHeight: 200,
            clientHeight: 100,
            get scrollTop() {
                return scrollTop;
            },
            set scrollTop(value) {
                scrollTop = Math.min(100, Math.max(0, value));
            },
        };

        const result = await measureScrollFps(createScrollMeasurementPage(scroller));

        expect(result).toEqual(expect.objectContaining({
            available: true,
            direction: 'up',
            scrollRange: 100,
            startScrollTop: 100,
            endScrollTop: 52,
            movedPixels: 48,
        }));
        expect(scrollTop).toBe(100);
    });

    test('reports scroll FPS unavailable without a usable scroll range or movement', async () => {
        const notScrollable = await measureScrollFps(createScrollMeasurementPage({
            scrollHeight: 100,
            clientHeight: 100,
            scrollTop: 0,
        }));
        const lockedScroller = {
            scrollHeight: 200,
            clientHeight: 100,
            get scrollTop() {
                return 0;
            },
            set scrollTop(value) {
                void value;
            },
        };
        const noMovement = await measureScrollFps(createScrollMeasurementPage(lockedScroller));

        expect(notScrollable).toEqual({
            available: false,
            reason: 'not-scrollable',
            scrollRange: 0,
            movedPixels: 0,
        });
        expect(noMovement).toEqual(expect.objectContaining({
            available: false,
            reason: 'no-scroll-movement',
            scrollRange: 100,
            movedPixels: 0,
        }));
    });

    test('closes the browser context when init-script setup fails', async () => {
        const profile = {
            name: 'test',
            label: 'Test',
            contextOptions: {},
        };
        let closeCount = 0;
        const context = {
            addInitScript: async () => {
                throw new Error('init failed');
            },
            newPage: async () => {
                throw new Error('newPage should not be called');
            },
            close: async () => {
                closeCount++;
            },
        };
        const browser = {
            newContext: async () => context,
        };

        await expect(measureProfile(browser, profile, {
            url: 'http://example.test',
            serviceWorkers: 'block',
            instrumentation: false,
        })).rejects.toThrow('init failed');
        expect(closeCount).toBe(1);
    });

    test('closes the browser context when page creation fails', async () => {
        const profile = {
            name: 'test',
            label: 'Test',
            contextOptions: {},
        };
        let closeCount = 0;
        const context = {
            addInitScript: async () => undefined,
            newPage: async () => {
                throw new Error('page failed');
            },
            close: async () => {
                closeCount++;
            },
        };
        const browser = {
            newContext: async () => context,
        };

        await expect(measureProfile(browser, profile, {
            url: 'http://example.test',
            serviceWorkers: 'block',
            instrumentation: false,
        })).rejects.toThrow('page failed');
        expect(closeCount).toBe(1);
    });
});
