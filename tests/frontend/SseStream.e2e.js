import { test, expect } from '@playwright/test';
import { testSetup } from './frontent-test-utils.js';

// Pauses that getDelay returns at smooth_streaming_speed 37 and 61. The values are rare on purpose,
// so no other timer of the page matches them.
const FAST = { speed: 37, letter: 25.2, comma: 315, stop: 630 };
const SLOW = { speed: 61, letter: 15.6, comma: 195, stop: 390 };

function bytesCutAt(text, ...offsets) {
    const bytes = [...Buffer.from(text, 'utf8')];
    const edges = [0, ...offsets, bytes.length];
    return edges.slice(1).map((end, index) => bytes.slice(edges[index], end));
}

function offsetInto(text, character, bytes) {
    return Buffer.byteLength(text.slice(0, text.indexOf(character))) + bytes;
}

function frame(payload, fields = '') {
    return `${fields}data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

function parsed(events) {
    return events.map(({ type, data }) => ({ type, data: JSON.parse(data) }));
}

const chatDelta = text => ({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: text } }] });
const thinkingDelta = text => ({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: text } });
const textDelta = text => ({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text } });

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

    test.describe('plain stream', () => {
        test('reads fields and multibyte characters from bytes cut inside a character', async ({ page }) => {
            const text = 'event: delta\r\nid: 7\r\ndata: {"text":"Zoë 日本"}\r\n\r\ndata: [DONE]\r\n\r\n';
            const chunks = bytesCutAt(text, offsetInto(text, 'ë', 1), offsetInto(text, '日', 1), offsetInto(text, '日', 2));

            const result = await page.evaluate(runStreams, { construct: 'plain', streams: [chunks] });

            expect(chunks).toHaveLength(4);
            expect(result.streams[0].events).toEqual([
                { type: 'delta', data: '{"text":"Zoë 日本"}', lastEventId: '7' },
                { type: 'message', data: '[DONE]', lastEventId: '7' },
            ]);
        });
    });

    test.describe('SmoothEventSourceStream', () => {
        test.describe('splitting', () => {
            test('keeps the event type on every split event', async ({ page }) => {
                const result = await page.evaluate(runStreams, { streams: [[frame(chatDelta('ab'), 'event: delta\n')]] });

                expect(parsed(result.streams[0].events)).toEqual([
                    { type: 'delta', data: chatDelta('a') },
                    { type: 'delta', data: chatDelta('b') },
                ]);
            });

            test('splits the text of each provider shape into single characters', async ({ page }) => {
                const shapes = [
                    {
                        payload: text => ({ choices: [{ index: 0, text }] }),
                        piece: text => ({ choices: [{ index: 0, text }] }),
                    },
                    {
                        payload: text => ({ choices: [{ index: 0, delta: { text } }] }),
                        piece: text => ({ choices: [{ index: 0, delta: { text } }] }),
                    },
                    {
                        payload: text => ({ choices: [{ index: 0, message: { role: 'assistant', content: text } }] }),
                        piece: text => ({ choices: [{ index: 0, message: { role: 'assistant', content: text } }] }),
                    },
                    {
                        payload: text => textDelta(text),
                        piece: text => ({ type: 'content_block_delta', index: 1, delta: { text } }),
                    },
                    {
                        payload: text => ({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text }] } }] }),
                        piece: text => ({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text }] } }] }),
                    },
                    {
                        payload: text => ({ token: text }),
                        piece: text => ({ token: text }),
                    },
                    {
                        payload: text => ({ content: text, stop: false }),
                        piece: text => ({ content: text, stop: false }),
                    },
                    {
                        payload: text => ({ type: 'content-delta', index: 0, delta: { message: { content: { text } } } }),
                        piece: text => ({ type: 'content-delta', index: 0, delta: { message: { content: { text } } } }),
                    },
                ];

                const result = await page.evaluate(runStreams, { streams: shapes.map(shape => [frame(shape.payload('ab'))]) });

                expect(result.streams.map(stream => parsed(stream.events))).toEqual(
                    shapes.map(shape => [{ type: 'message', data: shape.piece('a') }, { type: 'message', data: shape.piece('b') }]),
                );
            });

            test('splits characters the same way whatever the byte chunks are', async ({ page }) => {
                const text = frame(chatDelta('Zoë 日本'));
                const wholeStream = [text];
                const byteByByte = bytesCutAt(text, ...Array.from({ length: Buffer.byteLength(text) - 1 }, (_, index) => index + 1));

                const result = await page.evaluate(runStreams, { streams: [wholeStream, byteByByte] });

                expect(byteByByte).toHaveLength(Buffer.byteLength(text));
                expect(result.streams[1].events).toEqual(result.streams[0].events);
                expect(parsed(result.streams[0].events).map(event => event.data.choices[0].delta.content)).toEqual([...'Zoë 日本']);
            });

            test('does not split a tool call', async ({ page }) => {
                const call = { candidates: [{ index: 0, content: { role: 'model', parts: [{ functionCall: { name: 'lookup', args: { q: 'weather' } } }] } }] };

                const result = await page.evaluate(runStreams, { streams: [[frame(call)]] });

                expect(result.streams[0].events).toEqual([{ type: 'message', data: JSON.stringify(call) }]);
            });
        });

        test.describe('passing events through', () => {
            test('passes the end marker through unchanged', async ({ page }) => {
                const result = await page.evaluate(runStreams, { streams: [[frame(chatDelta('a')), frame('[DONE]', 'event: done\n')]] });

                expect(result.streams[0].events.at(-1)).toEqual({ type: 'done', data: '[DONE]' });
                expect(result.streams[0].events).toHaveLength(2);
            });

            test('passes through data that it cannot split', async ({ page }) => {
                const unsplittable = [
                    '{"oops',
                    'null',
                    JSON.stringify({ unrelated: true }),
                    JSON.stringify({ error: { message: 'Rate limit reached', type: 'rate_limit_error' } }),
                    JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] }),
                    JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
                    JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":' } }] } }] }),
                    JSON.stringify({ choices: [{ index: 1, delta: { content: 'second swipe' } }] }),
                    JSON.stringify({ choices: [] }),
                ];

                const result = await page.evaluate(runStreams, { streams: unsplittable.map(data => [frame(data)]) });

                expect(result.streams.map(stream => stream.events)).toEqual(unsplittable.map(data => [{ type: 'message', data }]));
            });

            test('logs what it cannot parse at debug level', async ({ page }) => {
                const result = await page.evaluate(runStreams, { streams: [[frame('{"oops'), frame({ unrelated: true })]] });

                expect(result.debug.map(entry => entry.name)).toEqual(['SyntaxError', 'Error']);
                expect(result.debug[1].message).toBe('Unknown event data format');
            });

            test('stays quiet about the end marker, null and swipes that are not the first', async ({ page }) => {
                const result = await page.evaluate(runStreams, {
                    streams: [[
                        frame('[DONE]'),
                        frame('null'),
                        frame({ choices: [{ index: 1, delta: { content: 'second swipe' } }] }),
                        frame({ choices: [] }),
                    ]],
                });

                expect(result.streams[0].events).toHaveLength(4);
                expect(result.debug).toEqual([]);
            });
        });

        test.describe('pauses', () => {
            test('waits for the pause of the previous character before each character', async ({ page }) => {
                const { letter, comma, stop } = FAST;

                const result = await page.evaluate(runStreams, {
                    streams: [[frame(chatDelta('a,b.c!d?e\nf'))]],
                    focus: true,
                    watchPauses: [letter, comma, stop],
                });

                expect(result.streams[0].events).toHaveLength(11);
                expect(result.streams[0].pauses).toEqual([
                    { pause: letter, after: 1 },
                    { pause: comma, after: 2 },
                    { pause: letter, after: 3 },
                    { pause: stop, after: 4 },
                    { pause: letter, after: 5 },
                    { pause: stop, after: 6 },
                    { pause: letter, after: 7 },
                    { pause: stop, after: 8 },
                    { pause: letter, after: 9 },
                    { pause: comma, after: 10 },
                ]);
            });

            test('follows the speed setting', async ({ page }) => {
                const run = speed => page.evaluate(runStreams, {
                    streams: [[frame(chatDelta('ab.c'))]],
                    settings: { smooth_streaming_speed: speed.speed },
                    focus: true,
                    watchPauses: [speed.letter, speed.comma, speed.stop],
                });

                const fast = await run(FAST);
                const slow = await run(SLOW);

                expect(fast.streams[0].pauses).toEqual([
                    { pause: FAST.letter, after: 1 },
                    { pause: FAST.letter, after: 2 },
                    { pause: FAST.stop, after: 3 },
                ]);
                expect(slow.streams[0].pauses).toEqual([
                    { pause: SLOW.letter, after: 1 },
                    { pause: SLOW.letter, after: 2 },
                    { pause: SLOW.stop, after: 3 },
                ]);
            });

            test('finishes with real timers while the page has focus', async ({ page }) => {
                const result = await page.evaluate(runStreams, {
                    streams: [[frame(chatDelta('ab.c'))]],
                    settings: { smooth_streaming_speed: 100 },
                    focus: true,
                });

                expect(parsed(result.streams[0].events).map(event => event.data.choices[0].delta.content)).toEqual(['a', 'b', '.', 'c']);
            });

            test('does not wait while the page has no focus', async ({ page }) => {
                const { letter, comma, stop } = FAST;

                const result = await page.evaluate(runStreams, {
                    streams: [[frame(chatDelta('ab.c'))]],
                    focus: false,
                    watchPauses: [letter, comma, stop],
                });

                expect(result.streams[0].events).toHaveLength(4);
                expect(result.streams[0].pauses).toEqual([]);
            });

            test('starts a new message without a pause after the end marker', async ({ page }) => {
                const { letter, comma, stop } = FAST;

                const result = await page.evaluate(runStreams, {
                    streams: [[frame(chatDelta('a.')), frame('[DONE]'), frame(chatDelta('x'))]],
                    focus: true,
                    watchPauses: [letter, comma, stop],
                });

                expect(result.streams[0].events).toHaveLength(4);
                expect(result.streams[0].pauses).toEqual([{ pause: letter, after: 1 }]);
            });

            test('starts a new message without a pause after a null payload', async ({ page }) => {
                const { letter, comma, stop } = FAST;

                const result = await page.evaluate(runStreams, {
                    streams: [[frame(chatDelta('a.')), frame('null'), frame(chatDelta('x'))]],
                    focus: true,
                    watchPauses: [letter, comma, stop],
                });

                expect(result.streams[0].events).toHaveLength(4);
                expect(result.streams[0].pauses).toEqual([{ pause: letter, after: 1 }]);
            });

            test('starts every stream without a pause', async ({ page }) => {
                const { letter, comma, stop } = FAST;

                const result = await page.evaluate(runStreams, {
                    streams: [[frame(chatDelta('a.'))], [frame(chatDelta('x'))]],
                    focus: true,
                    watchPauses: [letter, comma, stop],
                });

                expect(result.streams[0].pauses).toEqual([{ pause: letter, after: 1 }]);
                expect(result.streams[1].pauses).toEqual([]);
            });

            test.describe('reasoning', () => {
                const streams = [[frame(thinkingDelta('ab')), frame(textDelta('c.'))]];
                const watchPauses = [FAST.letter, FAST.comma, FAST.stop];

                test('waits for reasoning characters when the no think setting is off', async ({ page }) => {
                    const result = await page.evaluate(runStreams, { streams, focus: true, watchPauses });

                    expect(result.streams[0].events).toHaveLength(4);
                    expect(result.streams[0].pauses).toEqual([
                        { pause: FAST.letter, after: 1 },
                        { pause: FAST.letter, after: 2 },
                        { pause: FAST.letter, after: 3 },
                    ]);
                });

                test('does not wait for reasoning characters when the no think setting is on', async ({ page }) => {
                    const result = await page.evaluate(runStreams, {
                        streams,
                        settings: { smooth_streaming_no_think: true },
                        focus: true,
                        watchPauses,
                    });

                    expect(parsed(result.streams[0].events)).toEqual([
                        { type: 'message', data: { type: 'content_block_delta', index: 0, delta: { thinking: 'a' } } },
                        { type: 'message', data: { type: 'content_block_delta', index: 0, delta: { thinking: 'b' } } },
                        { type: 'message', data: { type: 'content_block_delta', index: 1, delta: { text: 'c' } } },
                        { type: 'message', data: { type: 'content_block_delta', index: 1, delta: { text: '.' } } },
                    ]);
                    expect(result.streams[0].pauses).toEqual([
                        { pause: FAST.letter, after: 2 },
                        { pause: FAST.letter, after: 3 },
                    ]);
                });
            });
        });
    });
});
