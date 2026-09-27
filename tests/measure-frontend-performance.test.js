/* global globalThis */
import { describe, expect, test } from '@jest/globals';

import {
    collectBudgetFailures,
    createLongChatRenderFixture,
    createStreamingRenderFixture,
    installLongTaskObserver,
    LONG_CHAT_RENDER_FILLER_REPEAT,
    LONG_CHAT_RENDER_MESSAGE_COUNT,
    LONG_CHAT_RENDER_VISIBLE_COUNT,
    measureLongChatRender,
    measureProfile,
    measureScrollFps,
    measureStreamingRender,
    parseCpuThrottleRate,
    parseProfileNames,
    STREAM_RENDER_CODE_REPEAT,
    STREAM_RENDER_FILLER_REPEAT,
    STREAM_RENDER_STEP_COUNT,
    summarizeRequestByteFields,
    summarizeRequests,
    waitForAppReady,
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

function withLongTaskObserver(Observer, callback) {
    const previousObserver = globalThis.PerformanceObserver;
    const previousMetrics = globalThis.__sillyBunnyLongTaskMetrics;
    try {
        globalThis.PerformanceObserver = Observer;
        installLongTaskObserver();
        callback(globalThis.__sillyBunnyLongTaskMetrics);
    } finally {
        globalThis.PerformanceObserver = previousObserver;
        globalThis.__sillyBunnyLongTaskMetrics = previousMetrics;
    }
}

describe('frontend performance measurement helpers', () => {
    test('validates CPU throttling while preserving the unthrottled default', () => {
        expect(parseCpuThrottleRate()).toBe(1);
        expect(parseCpuThrottleRate('4')).toBe(4);
        expect(parseCpuThrottleRate(1.5)).toBe(1.5);
        for (const value of [0, -1, NaN, Infinity, '', 'fast', true, null, []]) {
            expect(() => parseCpuThrottleRate(value)).toThrow('CPU throttle rate');
        }
    });

    test('aggregates observed long tasks and drains pending records exactly once', () => {
        let deliverEntries;
        let observedOptions;
        const pending = [{ entryType: 'longtask', duration: 90 }];
        class Observer {
            static supportedEntryTypes = ['longtask'];
            constructor(callback) {
                deliverEntries = entries => callback({ getEntries: () => entries });
            }
            observe(options) {
                observedOptions = options;
            }
            takeRecords() {
                return pending.splice(0);
            }
        }

        withLongTaskObserver(Observer, metrics => {
            deliverEntries([
                { entryType: 'longtask', duration: 70 },
                { entryType: 'longtask', duration: 115 },
                { entryType: 'resource', duration: 1000 },
            ]);
            const snapshot = metrics.snapshot();
            expect(observedOptions).toEqual({ type: 'longtask', buffered: true });
            expect(snapshot).toEqual({ available: true, count: 3, totalDuration: 275, longest: 115 });
            expect(metrics.snapshot()).toEqual(snapshot);
            snapshot.count = 999;
            deliverEntries([{ entryType: 'longtask', duration: 55 }]);
            expect(metrics.snapshot()).toEqual({ available: true, count: 4, totalDuration: 330, longest: 115 });
        });
    });

    test('reports unsupported long-task observation without zero-valued measurements', () => {
        class UnsupportedObserver {
            static supportedEntryTypes = ['resource'];
            constructor() {
                throw new Error('Unsupported observer should not be constructed');
            }
        }
        for (const Observer of [undefined, UnsupportedObserver]) {
            withLongTaskObserver(Observer, metrics => {
                expect(metrics.snapshot()).toEqual({
                    available: false,
                    reason: 'longtask-not-supported',
                    count: null,
                    totalDuration: null,
                    longest: null,
                });
            });
        }
    });

    test('disconnects the observer when observation setup fails', () => {
        let disconnectCount = 0;
        class Observer {
            static supportedEntryTypes = ['longtask'];
            observe() {
                throw new Error('Observation unavailable');
            }
            disconnect() {
                disconnectCount++;
            }
        }
        withLongTaskObserver(Observer, metrics => {
            expect(metrics.snapshot()).toEqual({
                available: false,
                reason: 'longtask-observer-setup-failed',
                count: null,
                totalDuration: null,
                longest: null,
            });
        });
        expect(disconnectCount).toBe(1);
    });

    test('waits for completed APP_READY listeners and disposes the event handle', async () => {
        const events = { event_types: { APP_READY: 'app_ready' }, eventSource: { autoFireLastArgs: new Map() } };
        let disposed = false;
        const waits = [];
        const handle = { dispose: async () => { disposed = true; } };
        const page = {
            evaluateHandle: async () => handle,
            waitForFunction: async (callback, argument, options) => {
                waits.push({ callback, argument, options, disposed });
            },
        };
        await waitForAppReady(page);
        expect(waits).toHaveLength(2);
        expect(waits[0].argument).toBe(handle);
        expect(waits[0].options).toEqual({ timeout: 60000 });
        expect(waits[0].callback(events)).toBe(false);
        events.eventSource.autoFireLastArgs.set(events.event_types.APP_READY, []);
        expect(waits[0].callback(events)).toBe(true);
        expect(waits[1]).toEqual(expect.objectContaining({ argument: null, options: { timeout: 60000 }, disposed: true }));
        expect(disposed).toBe(true);
    });

    test('disposes the event handle when APP_READY times out', async () => {
        let disposed = false;
        const page = {
            evaluateHandle: async () => ({ dispose: async () => { disposed = true; } }),
            waitForFunction: async () => { throw new Error('ready timeout'); },
        };
        await expect(waitForAppReady(page)).rejects.toThrow('ready timeout');
        expect(disposed).toBe(true);
    });

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

    test('applies default and explicit CPU throttling before navigation, then cleans up', async () => {
        for (const rate of [undefined, 4]) {
            const calls = [];
            const page = {
                evaluate: async () => undefined,
                goto: async () => {
                    calls.push('navigate');
                    throw new Error('navigation failed');
                },
            };
            const context = {
                addInitScript: async callback => { calls.push(callback.name); },
                newPage: async () => page,
                newCDPSession: async target => {
                    expect(target).toBe(page);
                    return {
                        send: async (method, params) => { calls.push({ method, params }); },
                        detach: async () => { calls.push('detach'); },
                    };
                },
                close: async () => { calls.push('close'); },
            };
            await expect(measureProfile({ newContext: async () => context }, {
                name: 'test', label: 'Test', contextOptions: {},
            }, {
                url: 'http://example.test', serviceWorkers: 'block', instrumentation: false, cpuThrottleRate: rate,
            })).rejects.toThrow('navigation failed');
            expect(calls).toEqual([
                'installResourceTimingBuffer',
                'installLongTaskObserver',
                { method: 'Emulation.setCPUThrottlingRate', params: { rate: rate ?? 1 } },
                'navigate',
                'detach',
                'close',
            ]);
        }
    });

    test('cleans up the CDP session and context if CPU throttling setup fails', async () => {
        const calls = [];
        const context = {
            addInitScript: async () => undefined,
            newPage: async () => ({}),
            newCDPSession: async () => ({
                send: async () => { throw new Error('CPU setup failed'); },
                detach: async () => { calls.push('detach'); },
            }),
            close: async () => { calls.push('close'); },
        };
        await expect(measureProfile({ newContext: async () => context }, {
            name: 'test', label: 'Test', contextOptions: {},
        }, {
            url: 'http://example.test', serviceWorkers: 'block', instrumentation: false, cpuThrottleRate: 4,
        })).rejects.toThrow('CPU setup failed');
        expect(calls).toEqual(['detach', 'close']);
    });
});
