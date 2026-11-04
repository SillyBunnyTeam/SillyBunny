import { test, expect } from '@playwright/test';
import { testSetup } from './frontent-test-utils.js';

function frame(payload, fields = '') {
    return `${fields}data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

function parsed(events) {
    return events.map(({ type, data }) => ({ type, data: JSON.parse(data) }));
}

const chatDelta = text => ({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: text } }] });

/**
 * Runs inside the page, so it cannot use anything else from this file.
 * Sends each list of chunks through a new stream and reports the events that come out.
 * A string chunk is UTF-8 text and a list of numbers is raw bytes. Timers of the watched lengths are held
 * and released one at a time when the page is idle, so no real time passes and `after` tells
 * how many events were out before each pause.
 * @param {object} options
 * @param {'smooth'|'plain'|'factory'} [options.construct] Class to instantiate, or getEventSourceStream
 * @param {(string|number[])[][]} options.streams Chunks of each stream
 * @param {object} [options.settings] Overrides for the power_user settings
 * @param {'desktop'|'ios'|'android'} [options.platform] Platform that navigator reports
 * @param {boolean} [options.focus] Value that document.hasFocus returns
 * @param {number[]} [options.watchPauses] Timer lengths to hold, rounded to 3 decimals
 */
async function runStreams({ construct = 'smooth', streams, settings = {}, platform = 'desktop', focus = false, watchPauses = [] }) {
    const { default: EventSourceStream, SmoothEventSourceStream, getEventSourceStream } = await import('/scripts/sse-stream.js');
    const { power_user } = await import('/scripts/power-user.js');

    const defaults = {
        smooth_streaming: true,
        smooth_streaming_no_think: false,
        smooth_streaming_speed: 37,
        ios_webkit_disable_smooth_streaming: false,
        android_disable_smooth_streaming: false,
    };
    const identities = {
        desktop: {
            platform: 'Win32',
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        },
        ios: {
            platform: 'iPhone',
            userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
        },
        android: {
            platform: 'Linux armv81',
            userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
        },
    };
    const applied = { ...defaults, ...settings };
    const before = Object.fromEntries(Object.keys(applied).map(key => [key, Object.hasOwn(power_user, key) ? { value: power_user[key] } : null]));
    const realSetTimeout = window.setTimeout;
    const realDebug = console.debug;
    const watched = new Set(watchPauses);
    const held = [];
    const debug = [];
    const encoder = new TextEncoder();
    const output = [];

    try {
        Object.assign(power_user, applied);
        for (const [key, value] of Object.entries(identities[platform])) {
            Object.defineProperty(navigator, key, { value, configurable: true });
        }
        Object.defineProperty(document, 'hasFocus', { value: () => focus, configurable: true });
        window.setTimeout = (handler, timeout, ...args) => {
            const rounded = Math.round(timeout * 1000) / 1000;
            if (watched.has(rounded)) {
                held.push({ handler, pause: rounded });
                return 0;
            }
            return realSetTimeout.call(window, handler, timeout, ...args);
        };
        console.debug = (...args) => {
            if (args[0] === 'Smooth Streaming parsing error') {
                debug.push({ name: args[1].name, message: args[1].message });
            } else {
                realDebug.apply(console, args);
            }
        };

        for (const chunks of streams) {
            const stream = construct === 'factory' ? getEventSourceStream()
                : construct === 'plain' ? new EventSourceStream() : new SmoothEventSourceStream();
            const prototype = Object.getPrototypeOf(stream);
            const kind = prototype === SmoothEventSourceStream.prototype ? 'smooth' : prototype === EventSourceStream.prototype ? 'plain' : 'other';
            const source = new ReadableStream({
                start(controller) {
                    for (const chunk of chunks) {
                        controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : Uint8Array.from(chunk));
                    }
                    controller.close();
                },
            });
            const reader = source.pipeThrough(stream).getReader();
            const events = [];
            const pauses = [];
            let finished = false;
            let failure = null;

            (async () => {
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    events.push({ type: value.type, data: value.data, ...(value.lastEventId && { lastEventId: value.lastEventId }) });
                }
            })().catch(error => {
                failure = error;
            }).finally(() => {
                finished = true;
            });

            for (let tick = 0; !finished; tick++) {
                if (tick > 5000) throw new Error('The stream did not finish');
                await new Promise(resolve => realSetTimeout.call(window, resolve, 0));
                const next = held.shift();
                if (next) {
                    pauses.push({ pause: next.pause, after: events.length });
                    next.handler();
                }
            }
            if (failure) throw failure;
            output.push({ kind, events, pauses });
        }
    } finally {
        console.debug = realDebug;
        window.setTimeout = realSetTimeout;
        delete document.hasFocus;
        for (const key of Object.keys(identities[platform])) delete navigator[key];
        for (const [key, saved] of Object.entries(before)) {
            if (saved) power_user[key] = saved.value;
            else delete power_user[key];
        }
    }

    return { streams: output, debug };
}

test.describe('SseStream', () => {
    test.beforeEach(testSetup.awaitST);

    test.describe('getEventSourceStream', () => {
        const kindOf = async (page, platform, settings = {}) => {
            const result = await page.evaluate(runStreams, { construct: 'factory', streams: [[]], platform, settings });
            return result.streams[0].kind;
        };

        test.describe('on desktop', () => {
            test('returns the smooth stream when smooth streaming is on', async ({ page }) => {
                expect(await kindOf(page, 'desktop')).toBe('smooth');
            });

            test('returns the plain stream when smooth streaming is off', async ({ page }) => {
                expect(await kindOf(page, 'desktop', { smooth_streaming: false })).toBe('plain');
            });

            test('ignores both mobile switches', async ({ page }) => {
                const settings = { ios_webkit_disable_smooth_streaming: true, android_disable_smooth_streaming: true };

                expect(await kindOf(page, 'desktop', settings)).toBe('smooth');
            });
        });

        test.describe('on iOS', () => {
            test('returns the smooth stream when its switch is off', async ({ page }) => {
                expect(await kindOf(page, 'ios')).toBe('smooth');
            });

            test('returns the plain stream when its switch is on', async ({ page }) => {
                expect(await kindOf(page, 'ios', { ios_webkit_disable_smooth_streaming: true })).toBe('plain');
            });

            test('ignores the Android switch', async ({ page }) => {
                expect(await kindOf(page, 'ios', { android_disable_smooth_streaming: true })).toBe('smooth');
            });

            test('returns the plain stream when smooth streaming is off', async ({ page }) => {
                expect(await kindOf(page, 'ios', { smooth_streaming: false })).toBe('plain');
            });
        });

        test.describe('on Android', () => {
            test('returns the smooth stream when its switch is off', async ({ page }) => {
                expect(await kindOf(page, 'android')).toBe('smooth');
            });

            test('returns the plain stream when its switch is on', async ({ page }) => {
                expect(await kindOf(page, 'android', { android_disable_smooth_streaming: true })).toBe('plain');
            });

            test('ignores the iOS switch', async ({ page }) => {
                expect(await kindOf(page, 'android', { ios_webkit_disable_smooth_streaming: true })).toBe('smooth');
            });

            test('returns the plain stream when smooth streaming is off', async ({ page }) => {
                expect(await kindOf(page, 'android', { smooth_streaming: false })).toBe('plain');
            });
        });

        test('returns a stream that delivers events whole when smooth streaming is off', async ({ page }) => {
            const payload = chatDelta('Hello');

            const result = await page.evaluate(runStreams, {
                construct: 'factory',
                settings: { smooth_streaming: false },
                streams: [[frame(payload), frame('[DONE]')]],
            });

            expect(result.streams[0].kind).toBe('plain');
            expect(result.streams[0].events).toEqual([
                { type: 'message', data: JSON.stringify(payload) },
                { type: 'message', data: '[DONE]' },
            ]);
        });

        test('returns a stream that splits events per character when smooth streaming is on', async ({ page }) => {
            const result = await page.evaluate(runStreams, { construct: 'factory', streams: [[frame(chatDelta('Hi!'))]] });

            expect(result.streams[0].kind).toBe('smooth');
            expect(parsed(result.streams[0].events)).toEqual([
                { type: 'message', data: chatDelta('H') },
                { type: 'message', data: chatDelta('i') },
                { type: 'message', data: chatDelta('!') },
            ]);
        });
    });
});
