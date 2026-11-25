import { power_user } from './power-user.js';
import { isSmoothStreamingEffectivelyEnabled } from './mobile-streaming.js';
import { delay } from './utils.js';

// Symbol for not primary swipe error
const NOT_PRIMARY = Symbol('not_primary_swipe');

/**
 * A stream which handles Server-Sent Events from a binary ReadableStream like you get from the fetch API.
 */
class EventSourceStream {
    constructor() {
        const decoder = new TextDecoderStream('utf-8');

        let streamBuffer = '';
        let lastEventId = '';

        function processChunk(controller) {
            // Events are separated by two newlines
            const events = streamBuffer.split(/\r\n\r\n|\r\r|\n\n/g);
            if (events.length === 0) return;

            // The leftover text to remain in the buffer is whatever doesn't have two newlines after it. If the buffer ended
            // with two newlines, this will be an empty string.
            streamBuffer = events.pop();

            for (const eventChunk of events) {
                let eventType = '';
                // Split up by single newlines.
                const lines = eventChunk.split(/\n|\r|\r\n/g);
                let eventData = '';
                for (const line of lines) {
                    const lineMatch = /([^:]+)(?:: ?(.*))?/.exec(line);
                    if (lineMatch) {
                        const field = lineMatch[1];
                        const value = lineMatch[2] || '';

                        switch (field) {
                            case 'event':
                                eventType = value;
                                break;
                            case 'data':
                                eventData += value;
                                eventData += '\n';
                                break;
                            case 'id':
                                // The ID field cannot contain null, per the spec
                                if (!value.includes('\0')) lastEventId = value;
                                break;
                            // We do nothing for the `delay` type, and other types are explicitly ignored
                        }
                    }
                }


                // https://html.spec.whatwg.org/multipage/server-sent-events.html#dispatchMessage
                // Skip the event if the data buffer is the empty string.
                if (eventData === '') continue;

                if (eventData[eventData.length - 1] === '\n') {
                    eventData = eventData.slice(0, -1);
                }

                // Trim the *last* trailing newline only.
                const event = new MessageEvent(eventType || 'message', { data: eventData, lastEventId });
                controller.enqueue(event);
            }
        }

        const sseStream = new TransformStream({
            transform(chunk, controller) {
                streamBuffer += chunk;
                processChunk(controller);
            },
        });

        decoder.readable.pipeThrough(sseStream);

        this.readable = sseStream.readable;
        this.writable = decoder.writable;
    }
}

/**
 * Gets a delay based on the character.
 * @param {string} s The character.
 * @returns {number} The delay in milliseconds.
 */
function getDelay(s) {
    if (!s) {
        return 0;
    }

    const speedFactor = Math.max(100 - power_user.smooth_streaming_speed, 1);
    const defaultDelayMs = speedFactor * 0.4;
    const punctuationDelayMs = defaultDelayMs * 25;

    if ([',', '\n'].includes(s)) {
        return punctuationDelayMs / 2;
    }

    if (['.', '!', '?'].includes(s)) {
        return punctuationDelayMs;
    }

    return defaultDelayMs;
}

/**
 * Parses the stream data and returns the parsed data and the chunk to be sent.
 *
 * Text is split by Unicode code points, so astral characters (emoji, rare CJK) stay whole.
 * Each yielded payload is a shallow copy of the event that only replaces the streamed text.
 *
 * With `segments: true` the generator yields one descriptor per streamed text run instead of
 * one item per code point, so a caller can build payloads for slices of any size. Descriptors
 * have `text`, `suffix` (appended to the last slice), `reasoning` (undefined when the provider
 * shape carries no reasoning flag) and `build(slice, isLast)`. Payloads that cannot be split
 * are yielded as `{ data, chunk: '' }` in both modes.
 * @param {object} json The JSON data.
 * @param {object} [options]
 * @param {boolean} [options.segments=false] Yield text run descriptors instead of single characters
 * @returns {AsyncGenerator<{data: object, chunk: string, reasoning?: boolean}|{text: string, suffix: string, reasoning?: boolean, build: (slice: string, isLast: boolean) => object}>}
 */
// SillyBunny: eliminate per-character structuredClone via shallow delta builders and split by Unicode code points / grapheme clusters.
async function* parseStreamData(json, { segments = false } = {}) {
    /**
     * @param {string} text
     * @param {boolean|undefined} reasoning
     * @param {(slice: string, isLast: boolean) => object} build
     * @param {string} [suffix]
     */
    function* emit(text, reasoning, build, suffix = '') {
        if (segments) {
            yield { text, suffix, reasoning, build };
            return;
        }
        const units = Array.from(text);
        for (let index = 0; index < units.length; index++) {
            const isLast = index === units.length - 1;
            const chunk = isLast ? units[index] + suffix : units[index];
            const data = build(chunk, isLast);
            yield reasoning === undefined ? { data, chunk } : { data, chunk, reasoning };
        }
    }

    if (typeof json.delta === 'object' && typeof json.delta.message === 'object' && ['tool-plan-delta', 'content-delta'].includes(json.type)) {
        // Cohere
        const text = json?.delta?.message?.content?.text ?? '';
        if (text.length > 0) {
            yield* emit(text, undefined, str => ({ ...json, delta: { message: { content: { text: str } } } }));
        }
        return;
    } else if (typeof json.delta === 'object' && typeof json.delta.text === 'string') {
        // Claude
        if (json.delta.text.length > 0) {
            yield* emit(json.delta.text, undefined, str => ({ ...json, delta: { text: str } }));
        }
        return;
    } else if (typeof json.delta === 'object' && typeof json.delta.thinking === 'string') {
        // Claude (reasoning content)
        if (json.delta.thinking.length > 0) {
            yield* emit(json.delta.thinking, true, str => ({ ...json, delta: { thinking: str } }));
        }
        return;
    } else if (Array.isArray(json.candidates)) {
        // Google VertexAI / AI Studio
        for (let i = 0; i < json.candidates.length; i++) {
            const isNotPrimary = json.candidates?.[0]?.index > 0;
            const hasToolCalls = json?.candidates?.[0]?.content?.parts?.some(p => p?.functionCall);
            const hasInlineData = json?.candidates?.[0]?.content?.parts?.some(p => p?.inlineData);
            if (isNotPrimary || json.candidates.length === 0) {
                return null;
            }
            if (hasToolCalls || hasInlineData) {
                yield { data: json, chunk: '' };
                return;
            }
            if (typeof json.candidates[0].content === 'object' && Array.isArray(json.candidates[i].content.parts)) {
                const parts = json.candidates[i].content.parts;
                const base = json.candidates[0];
                for (let j = 0; j < parts.length; j++) {
                    const text = parts[j].text;
                    if (typeof text !== 'string' || text.length === 0) {
                        continue;
                    }
                    const addNewline = parts.length > 1 && j !== parts.length - 1;
                    const reasoning = parts[j].thought ?? false;
                    const build = str => ({
                        ...json,
                        candidates: [{ ...base, content: { ...base.content, parts: [{ ...base.content.parts[j], text: str }] } }],
                    });
                    yield* emit(text, reasoning, build, addNewline ? '\n\n' : '');
                }
            }
        }
        return;
    } else if (typeof json.token === 'string' && json.token.length > 0) {
        // NovelAI / KoboldCpp Classic
        yield* emit(json.token, undefined, str => ({ ...json, token: str }));
        return;
    } else if (typeof json.content === 'string' && json.content.length > 0 && json.object !== 'chat.completion.chunk') {
        // llama.cpp?
        const isNotPrimary = json?.index > 0;
        if (isNotPrimary) {
            throw new Error('Not a primary swipe', { cause: NOT_PRIMARY });
        }
        yield* emit(json.content, undefined, str => ({ ...json, content: str }));
        return;
    } else if (Array.isArray(json.choices)) {
        // OpenAI-likes and friends
        const isNotPrimary = json?.choices?.[0]?.index > 0;
        if (isNotPrimary || json.choices.length === 0) {
            throw new Error('Not a primary swipe', { cause: NOT_PRIMARY });
        }

        const choice = json.choices[0];
        const withChoice = next => ({ ...json, choices: [next] });

        if (typeof choice.text === 'string' && choice.text.length > 0) {
            yield* emit(choice.text, undefined, str => withChoice({ ...choice, text: str }));
            return;
        } else if (typeof choice.thinking === 'string' && choice.thinking.length > 0) {
            yield* emit(choice.thinking, true, str => withChoice({ ...choice, thinking: str }));
            return;
        } else if (typeof choice.delta === 'object') {
            const delta = choice.delta;
            if (typeof delta.text === 'string' && delta.text.length > 0) {
                yield* emit(delta.text, undefined, str => withChoice({ ...choice, delta: { ...delta, text: str } }));
                return;
            } else if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
                // The answer text of a mixed delta goes out with the last reasoning slice only.
                yield* emit(delta.reasoning_content, true, (str, isLast) => withChoice({ ...choice, delta: { ...delta, reasoning_content: str, content: isLast ? delta.content : '' } }));
                return;
            } else if (typeof delta.reasoning === 'string' && delta.reasoning.length > 0) {
                yield* emit(delta.reasoning, true, (str, isLast) => withChoice({ ...choice, delta: { ...delta, reasoning: str, content: isLast ? delta.content : '' } }));
                return;
            } else if (typeof delta.content === 'string' && delta.content.length > 0) {
                yield* emit(delta.content, undefined, str => withChoice({ ...choice, delta: { ...delta, content: str } }));
                return;
            } else if (Array.isArray(delta.content) && delta.content.length > 0) {
                const block = delta.content[0];
                if (Array.isArray(block.thinking) && block.thinking.length > 0) {
                    const thought = block.thinking[0];
                    if (typeof thought.text === 'string' && thought.text.length > 0) {
                        const build = str => withChoice({
                            ...choice,
                            delta: {
                                ...delta,
                                content: [{ ...block, thinking: [{ ...thought, text: str }, ...block.thinking.slice(1)] }, ...delta.content.slice(1)],
                            },
                        });
                        yield* emit(thought.text, true, build);
                        return;
                    }
                }
            }
        } else if (typeof choice.message === 'object') {
            if (typeof choice.message.content === 'string' && choice.message.content.length > 0) {
                yield* emit(choice.message.content, undefined, str => withChoice({ ...choice, message: { ...choice.message, content: str } }));
                return;
            }
        }
    }

    throw new Error('Unknown event data format');
}

// SillyBunny: coalesce sub-frame smooth-streaming waits into ~16 ms rAF slices with bounded timer fallback and backlog catch-up.
/** A single-step wait shorter than this is coalesced into a ~16 ms frame slice instead of its own timer. */
const SMOOTH_MIN_PAUSE_MS = 12;
/** Target presentation frame slice when coalescing sub-frame waits via rAF. */
const SMOOTH_FRAME_SLICE_MS = 16;
/** Characters left in one event before the pauses start shrinking to catch up. */
const SMOOTH_CATCH_UP_UNITS = 120;

function waitForAnimationFrameOrDelay(waitMs) {
    if (
        typeof globalThis.requestAnimationFrame === 'function'
        && globalThis.document?.visibilityState !== 'hidden'
    ) {
        const fallbackMs = Math.max(Number.isFinite(waitMs) ? waitMs : SMOOTH_FRAME_SLICE_MS, 50);
        return new Promise((resolve) => {
            let settled = false;
            let frameId = null;
            let timerId = null;
            const finish = () => {
                if (settled) return;
                settled = true;
                if (frameId !== null && typeof globalThis.cancelAnimationFrame === 'function') {
                    globalThis.cancelAnimationFrame(frameId);
                }
                if (timerId !== null) {
                    clearTimeout(timerId);
                }
                resolve();
            };
            frameId = globalThis.requestAnimationFrame(finish);
            timerId = setTimeout(finish, fallbackMs);
        });
    }
    return delay(waitMs);
}

/** @type {Intl.Segmenter|null|undefined} */
let graphemeSegmenter;

/**
 * Splits text into user-perceived characters, falling back to code points.
 * @param {string} text
 * @returns {string[]}
 */
function splitStreamUnits(text) {
    if (graphemeSegmenter === undefined) {
        graphemeSegmenter = typeof Intl?.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
    }
    if (!graphemeSegmenter) {
        return Array.from(text);
    }
    const units = [];
    for (const { segment } of graphemeSegmenter.segment(text)) {
        units.push(segment);
    }
    return units;
}

/**
 * Paces the characters of one smooth stream. Each character is still delivered as its own event,
 * but sub-frame pauses are accumulated into ~16 ms presentation slices (yielded via rAF when
 * available), and a large backlog in one event shortens pauses adaptively so text catches up.
 */
export class StreamPacer {
    /** Last character delivered, which sets the pause before the next one. */
    lastUnit = '';
    /** Sub-frame pause owed and not slept yet. */
    owedMs = 0;

    reset() {
        this.lastUnit = '';
        this.owedMs = 0;
    }

    /**
     * Takes the pause before the next character.
     * @param {boolean} paced Whether this character waits at all
     * @param {number} backlog Characters left in the current event, this one included
     * @returns {Promise<void>|null} A promise to await, or null when no timer is needed now
     */
    pause(paced, backlog) {
        if (!paced) {
            this.owedMs = 0;
            return null;
        }
        const catchUp = backlog > SMOOTH_CATCH_UP_UNITS ? SMOOTH_CATCH_UP_UNITS / backlog : 1;
        const stepMs = getDelay(this.lastUnit) * catchUp;
        if (stepMs < SMOOTH_MIN_PAUSE_MS) {
            this.owedMs += stepMs;
            if (this.owedMs < SMOOTH_FRAME_SLICE_MS) {
                return null;
            }
            const wait = this.owedMs;
            this.owedMs = 0;
            return waitForAnimationFrameOrDelay(wait);
        }
        const wait = this.owedMs + stepMs;
        this.owedMs = 0;
        return delay(wait);
    }
}

/**
 * Like the default one, but multiplies the events by the number of letters in the event data.
 */
export class SmoothEventSourceStream extends EventSourceStream {
    constructor() {
        super();
        const pacer = new StreamPacer();
        const isFocused = () => (typeof document !== 'undefined' && typeof document.hasFocus === 'function'
            ? document.hasFocus()
            : false);
        const transformStream = new TransformStream({
            async transform(chunk, controller) {
                const event = chunk;
                const data = event.data;
                try {
                    if (data === '[DONE]') {
                        pacer.reset();
                        return controller.enqueue(event);
                    }

                    const json = JSON.parse(data);

                    if (!json) {
                        pacer.reset();
                        return controller.enqueue(event);
                    }

                    // SillyBunny: stream per-segment shallow clones with rAF pacing and single-event no_think reasoning passthrough.
                    for await (const segment of parseStreamData(json, { segments: true })) {
                        if (typeof segment.build !== 'function') {
                            const wait = pacer.pause(isFocused(), 1);
                            if (wait) await wait;
                            controller.enqueue(new MessageEvent(event.type, { data: JSON.stringify(segment.data) }));
                            pacer.lastUnit = segment.chunk;
                            continue;
                        }

                        if (power_user.smooth_streaming_no_think && segment.reasoning) {
                            // Reasoning is shown without pacing, so it goes out whole without segmenting the full string.
                            controller.enqueue(new MessageEvent(event.type, { data: JSON.stringify(segment.build(segment.text + segment.suffix, true)) }));
                            pacer.lastUnit = segment.text.slice(-1) + segment.suffix;
                            continue;
                        }

                        const units = splitStreamUnits(segment.text);
                        for (let index = 0; index < units.length; index++) {
                            const wait = pacer.pause(isFocused(), units.length - index);
                            if (wait) await wait;
                            const isLast = index === units.length - 1;
                            const unit = isLast ? units[index] + segment.suffix : units[index];
                            controller.enqueue(new MessageEvent(event.type, { data: JSON.stringify(segment.build(unit, isLast)) }));
                            pacer.lastUnit = unit;
                        }
                    }
                } catch (error) {
                    if (error instanceof Error && error.cause !== NOT_PRIMARY) {
                        console.debug('Smooth Streaming parsing error', error);
                    }
                    controller.enqueue(event);
                }
            },
        });

        this.readable = this.readable.pipeThrough(transformStream);
    }
}

export function getEventSourceStream() {
    // SillyBunny: smooth streaming can be disabled per mobile platform even
    // when the normal upstream setting remains enabled.
    if (isSmoothStreamingEffectivelyEnabled({
        smoothStreaming: power_user.smooth_streaming,
        iosWebKitDisableSmoothStreaming: power_user.ios_webkit_disable_smooth_streaming,
        androidDisableSmoothStreaming: power_user.android_disable_smooth_streaming,
    })) {
        return new SmoothEventSourceStream();
    }

    return new EventSourceStream();
}

export default EventSourceStream;
