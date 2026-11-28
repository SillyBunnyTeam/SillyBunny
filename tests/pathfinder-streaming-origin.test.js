/** @jest-environment jsdom */
/* global globalThis */
/* eslint-disable playwright/no-standalone-expect */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import * as realChatRenderLifecycle from '../public/scripts/chat-render-lifecycle/index.js';
import { event_types } from '../public/scripts/events.js';
import { importScriptModule } from './util/script-harness.js';

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function replacement() {
    return {
        mes: 'different chat',
        name: 'Other',
        is_user: false,
        extra: {},
        swipe_id: 0,
        swipes: ['untouched'],
        swipe_info: [{ extra: { keep: true } }],
    };
}

const STREAM_DOM = `
    <div id="options_button"></div>
    <div id="options"></div>
    <div id="export_button"></div>
    <div id="export_format_popup"></div>
    <div id="online_status_indicator"></div>
    <div id="online_status_text"></div>
    <select id="main_api">
        <option value="openai">openai</option>
    </select>
    <div id="chat"></div>
    <div id="message_template" hidden>
        <div class="mes">
            <div class="mes_block">
                <div class="ch_name">
                    <span class="name_text"></span>
                    <span class="mes_timer"></span>
                    <span class="tokenCounterDisplay"></span>
                </div>
                <div class="mes_text"></div>
            </div>
        </div>
    </div>
    <textarea id="send_textarea"></textarea>
    <div id="send_but"></div>
    <div id="mes_stop"></div>
`;

const originalRaf = globalThis.requestAnimationFrame;
const originalCaf = globalThis.cancelAnimationFrame;

afterEach(() => {
    jest.restoreAllMocks();
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.cancelAnimationFrame = originalCaf;
    if (typeof globalThis.window !== 'undefined') {
        globalThis.window.requestAnimationFrame = originalRaf;
        globalThis.window.cancelAnimationFrame = originalCaf;
    }
});

/**
 * Installs a controllable animation-frame queue before importing `public/script.js`
 * so `createStreamWriteBuffer`'s frame scheduler runs deterministically on demand.
 */
function installManualFrames() {
    let nextId = 1;
    const frames = new Map();
    const requestAnimationFrame = jest.fn(callback => {
        const id = nextId++;
        frames.set(id, callback);
        return id;
    });
    const cancelAnimationFrame = jest.fn(id => {
        frames.delete(id);
    });
    globalThis.requestAnimationFrame = requestAnimationFrame;
    globalThis.cancelAnimationFrame = cancelAnimationFrame;
    if (typeof globalThis.window !== 'undefined') {
        globalThis.window.requestAnimationFrame = requestAnimationFrame;
        globalThis.window.cancelAnimationFrame = cancelAnimationFrame;
    }
    return {
        requestAnimationFrame,
        cancelAnimationFrame,
        pendingCount: () => frames.size,
        runFrame: () => {
            const entries = [...frames.entries()];
            frames.clear();
            for (const [, callback] of entries) {
                callback(0);
            }
        },
    };
}

/**
 * Boots the real `public/script.js` with streaming enabled and starts a real
 * `Generate(type)` run paused inside its async generator so tests can drive
 * both real streamed chunks and direct `StreamingProcessor` / `saveReply` races.
 */
async function createStreamingSession({
    type = 'normal',
    initialChat = null,
    chunks = [{ text: 'stale output', swipes: [], toolCalls: [], state: {} }],
    pauseBeforeChunks = true,
    pauseAfterChunks = true,
    pauseOnInitialSaveReply = false,
} = {}) {
    const frames = installManualFrames();
    const reasoningDomWrite = jest.fn();
    const applyStreamDomPatch = jest.fn((element, html) => { element.innerHTML = html; });
    const applyStreamFadeIn = jest.fn((element, html) => { element.innerHTML = html; });
    const updateReasoningTokenAccounting = jest.fn(async () => ({ outputTokens: 1, reasoningTokens: 0 }));

    let initialTokenStarted = null;
    let initialTokenRelease = null;
    if (pauseOnInitialSaveReply) {
        const started = deferred();
        const release = deferred();
        initialTokenStarted = started.promise;
        initialTokenRelease = release.resolve;
        updateReasoningTokenAccounting.mockImplementationOnce(() => {
            started.resolve();
            return release.promise;
        });
    }

    const generatorReady = deferred();
    const allowChunks = deferred();
    const chunksYielded = deferred();
    const allowFinish = deferred();

    let createdReasoningHandler = null;
    class TrackingReasoningHandler {
        constructor() {
            this.reasoning = '';
            createdReasoningHandler = this;
        }
        initContinue() {}
        async process() {}
        updateDom(...args) { reasoningDomWrite(...args); }
        updateReasoning() {}
        hasReasoningContent() { return false; }
        getDuration() { return 0; }
        async finish() {}
    }

    const sendOpenAIRequest = jest.fn(async () => async function* () {
        generatorReady.resolve();
        if (pauseBeforeChunks) {
            await allowChunks.promise;
        }
        for (const chunk of chunks) {
            yield chunk;
        }
        chunksYielded.resolve();
        if (pauseAfterChunks) {
            await allowFinish.promise;
        }
    });

    let capturedBuffer = null;
    const loaded = await importScriptModule({
        dom: STREAM_DOM,
        mocks: {
            'scripts/chat-render-lifecycle/index.js': {
                ...realChatRenderLifecycle,
                createStreamWriteBuffer: (...args) => {
                    capturedBuffer = realChatRenderLifecycle.createStreamWriteBuffer(...args);
                    return capturedBuffer;
                },
            },
            'scripts/openai.js': base => ({
                ...base,
                oai_settings: { ...base.oai_settings, stream_openai: true },
                prepareOpenAIMessages: jest.fn(async () => [[{ role: 'user', content: 'hi' }], false]),
                sendOpenAIRequest,
            }),
            'scripts/util/stream-fadein.js': {
                applyStreamDomPatch,
                applyStreamFadeIn,
            },
            'scripts/reasoning.js': base => ({
                ...base,
                ReasoningHandler: TrackingReasoningHandler,
            }),
            'scripts/reasoning-token-accounting.js': {
                formatTokenCounterText: () => '',
                getPositiveTokenCount: value => Number(value) || 0,
                updateReasoningTokenAccounting,
            },
        },
    });

    const { script, eventSource, state, mocks } = loaded;
    const makeHtml = mocks['lib.js'].showdown.Converter().makeHtml;
    state.power_user.stream_fade_in = false;
    state.power_user.streaming_fps = 30;
    state.power_user.message_token_count_enabled = false;
    state.power_user.trim_spaces = false;

    script.characters.push({ name: 'Assistant', avatar: 'assistant.png', chat: 'original' });
    script.setCharacterId(0);
    script.setCharacterName('Assistant');
    await script.changeMainAPI('openai');
    script.setOnlineStatus('Connected');

    const seedChat = initialChat ?? (type === 'continue'
        ? [{
            mes: 'original',
            name: 'Assistant',
            is_user: false,
            is_system: false,
            extra: {},
            swipe_id: 0,
            swipes: ['original'],
            swipe_info: [{ extra: {} }],
        }]
        : []);
    for (const msg of seedChat) {
        script.chat.push(msg);
        script.addOneMessage(msg);
    }

    const generatePromise = script.Generate(type);

    if (pauseOnInitialSaveReply) {
        await initialTokenStarted;
        return {
            script,
            eventSource,
            frames,
            makeHtml,
            applyStreamDomPatch,
            reasoningDomWrite,
            updateReasoningTokenAccounting,
            releaseInitialToken: () => initialTokenRelease({ outputTokens: 1, reasoningTokens: 0 }),
            finish: async () => {
                allowChunks.resolve();
                allowFinish.resolve();
                await generatePromise;
            },
        };
    }

    await generatorReady.promise;
    // Wait until StreamingProcessor.generate has completed onStartStreaming and entered the generator.
    const processor = script.streamingProcessor;
    makeHtml.mockClear();
    applyStreamDomPatch.mockClear();
    reasoningDomWrite.mockClear();
    updateReasoningTokenAccounting.mockClear();

    return {
        script,
        processor,
        reasoningHandler: createdReasoningHandler,
        messageId: processor.messageId,
        eventSource,
        frames,
        getBuffer: () => capturedBuffer,
        makeHtml,
        applyStreamDomPatch,
        reasoningDomWrite,
        updateReasoningTokenAccounting,
        releaseChunks: async () => {
            allowChunks.resolve();
            await chunksYielded.promise;
            // Let the final yielded token's onProgressStreaming settle before inspecting.
            await new Promise(resolve => setTimeout(resolve, 10));
        },
        finish: async () => {
            allowChunks.resolve();
            allowFinish.resolve();
            await generatePromise;
        },
    };
}

describe('streaming message origin', () => {
    test('formats only the latest queued snapshot while retaining every token event', async () => {
        const tokenEvents = [];
        const session = await createStreamingSession({
            chunks: ['a', 'ab', 'abc'].map(text => ({ text, swipes: [], toolCalls: [], state: {} })),
            pauseBeforeChunks: true,
            pauseAfterChunks: true,
        });
        session.eventSource.on(event_types.STREAM_TOKEN_RECEIVED, text => tokenEvents.push(text));

        await session.releaseChunks();
        expect(tokenEvents).toEqual(['a', 'ab', 'abc']);
        expect(session.makeHtml).not.toHaveBeenCalled();

        session.frames.runFrame();
        expect(session.makeHtml).toHaveBeenCalledTimes(1);
        expect(session.makeHtml.mock.calls[0][0]).toBe('abc');
        expect(session.processor.messageTextDom.innerHTML).toBe('abc');

        await session.finish();
    });

    test('finalization synchronously formats the final snapshot and cancels the pending preview', async () => {
        const session = await createStreamingSession();
        const { processor, messageId, frames, getBuffer, makeHtml, applyStreamDomPatch } = session;

        await processor.onProgressStreaming(messageId, 'preview', false);
        expect(getBuffer().size()).toBe(1);

        await processor.onProgressStreaming(messageId, 'final', true);
        expect(getBuffer().size()).toBe(0);
        expect(processor.messageTextDom.innerHTML).toBe('final');
        expect(makeHtml).toHaveBeenCalledTimes(1);
        expect(makeHtml.mock.calls[0][0]).toBe('final');
        expect(applyStreamDomPatch).not.toHaveBeenCalled();

        frames.runFrame();
        expect(makeHtml).toHaveBeenCalledTimes(1);

        processor.onStopStreaming();
        await session.finish();
    });

    test.each(['Stop', 'chat switch', 'swipe'])('drops queued formatting before doing any work after %s', async reason => {
        const session = await createStreamingSession();
        const { script, processor, messageId, frames, makeHtml, applyStreamDomPatch } = session;

        await processor.onProgressStreaming(messageId, 'preview', false);
        if (reason === 'Stop') processor.onStopStreaming();
        else if (reason === 'swipe') script.chat[messageId].swipe_id++;
        else script.incrementChatGeneration();

        frames.runFrame();
        expect(makeHtml).not.toHaveBeenCalled();
        expect(applyStreamDomPatch).not.toHaveBeenCalled();

        processor.onStopStreaming();
        await session.finish();
    });

    test('records format and DOM cost, then decays it after a cheaper visible update', async () => {
        const session = await createStreamingSession();
        const { processor, messageId, frames } = session;
        const nowSpy = jest.spyOn(performance, 'now');

        await processor.onProgressStreaming(messageId, 'first', false);
        nowSpy.mockReturnValueOnce(0).mockReturnValueOnce(30);
        frames.runFrame();
        expect(processor.streamingRenderDurationMs).toBe(30);

        await processor.onProgressStreaming(messageId, 'second', false);
        nowSpy.mockReturnValueOnce(40).mockReturnValueOnce(45);
        frames.runFrame();
        expect(processor.streamingRenderDurationMs).toBe(24);

        processor.onStopStreaming();
        await session.finish();
    });

    test('routes a scheduled formatter failure through stream error cleanup', async () => {
        const session = await createStreamingSession();
        const { processor, messageId, frames, makeHtml, applyStreamDomPatch } = session;
        jest.spyOn(console, 'error').mockImplementation(() => {});
        makeHtml.mockImplementation(() => { throw new Error('formatter failed'); });

        await processor.onProgressStreaming(messageId, 'preview', false);
        expect(() => frames.runFrame()).not.toThrow();
        expect(processor.abortController.signal.aborted).toBe(true);
        expect(processor.isStopped).toBe(true);
        expect(processor.isFinished).toBe(true);
        expect(applyStreamDomPatch).not.toHaveBeenCalled();

        await session.finish();
    });

    test('propagates final formatting errors to the caller', async () => {
        const session = await createStreamingSession();
        const { processor, messageId, makeHtml } = session;
        makeHtml.mockImplementation(() => { throw new Error('final formatter failed'); });

        await expect(processor.onProgressStreaming(messageId, 'final', true)).rejects.toThrow('final formatter failed');

        processor.onStopStreaming();
        await session.finish();
    });

    test('continues updating the original message and swipe through normal stream completion', async () => {
        const session = await createStreamingSession({
            chunks: [{ text: 'final output', swipes: [], toolCalls: [], state: {} }],
            pauseBeforeChunks: false,
            pauseAfterChunks: false,
        });
        await session.finish();
        expect(session.script.chat[0].mes).toBe('final output');
        expect(session.script.chat[0].swipes[0]).toBe('final output');
    });

    test.each(['chat switch', 'Stop'])('rechecks after token listeners before progress writes on %s', async reason => {
        const session = await createStreamingSession();
        const { script, processor, messageId, eventSource } = session;
        const originalSnapshot = structuredClone(script.chat[messageId]);

        eventSource.once(event_types.STREAM_TOKEN_RECEIVED, async () => {
            if (reason === 'Stop') {
                processor.onStopStreaming();
            } else {
                script.chat.splice(0, script.chat.length, replacement());
                script.incrementChatGeneration();
            }
        });

        await session.finish();
        const expected = reason === 'Stop' ? originalSnapshot : replacement();
        expect(script.chat[0]).toEqual(expected);
    });

    test('does not write through a reused index after the DOM lookup await', async () => {
        const session = await createStreamingSession();
        const { script, processor, messageId } = session;

        const pending = processor.onProgressStreaming(messageId, 'stale output', false);
        script.chat.splice(0, script.chat.length, replacement());
        script.incrementChatGeneration();
        await pending;

        expect(script.chat[0]).toEqual(replacement());

        processor.onStopStreaming();
        await session.finish();
    });

    test('honours the originating host run guard before updating an otherwise unchanged message', async () => {
        const session = await createStreamingSession();
        const { script, processor, messageId } = session;
        const before = structuredClone(script.chat[messageId]);

        processor.isCurrentGeneration = () => false;
        await processor.onProgressStreaming(messageId, 'cancelled output', false);
        expect(script.chat[messageId]).toEqual(before);

        processor.onStopStreaming();
        await session.finish();
    });

    test('does not update replacement swipe metadata after token accounting', async () => {
        const session = await createStreamingSession({ type: 'continue' });
        const { script, processor, messageId, updateReasoningTokenAccounting } = session;
        const started = deferred();
        const release = deferred();

        updateReasoningTokenAccounting.mockImplementationOnce(() => {
            started.resolve();
            return release.promise;
        });

        const pending = processor.onProgressStreaming(messageId, 'stale output', true);
        await started.promise;
        script.chat[messageId] = replacement();
        release.resolve({ outputTokens: 1, reasoningTokens: 0 });
        await pending;

        expect(script.chat[messageId]).toEqual(replacement());

        processor.onStopStreaming();
        await session.finish();
    });

    test('does not let cancellation cleanup change a different message', async () => {
        const session = await createStreamingSession();
        const { script, processor, messageId } = session;

        script.chat[messageId] = replacement();
        processor.onStopStreaming();
        processor.setFirstSwipe(messageId);
        expect(script.chat[messageId]).toEqual(replacement());

        await session.finish();
    });

    test('guards the real initial saveReply after its token-count await', async () => {
        const session = await createStreamingSession({ pauseOnInitialSaveReply: true });
        const { script, releaseInitialToken } = session;

        script.chat.splice(0, script.chat.length, replacement());
        script.incrementChatGeneration();
        releaseInitialToken();
        await session.finish();

        expect(script.chat[0]).toEqual(replacement());
        expect(document.querySelectorAll('#chat .mes')).toHaveLength(0);
    });

    test('does not let delayed reasoning completion repaint a different chat', async () => {
        const session = await createStreamingSession();
        const { script, processor, messageId, reasoningDomWrite } = session;
        const started = deferred();
        const release = deferred();

        processor.reasoningHandler.process = async () => {
            started.resolve();
            await release.promise;
            processor.reasoningHandler.updateDom(messageId);
        };

        const pending = processor.onProgressStreaming(messageId, 'valid output', false);
        await started.promise;
        script.chat.splice(0, script.chat.length, replacement());
        script.incrementChatGeneration();
        release.resolve();
        await pending;

        expect(script.chat[0]).toEqual(replacement());
        expect(reasoningDomWrite).not.toHaveBeenCalled();

        processor.onStopStreaming();
        await session.finish();
    });

    test('rejects a queued DOM write after a chat switch', async () => {
        const session = await createStreamingSession();
        const { script, processor, messageId, frames, getBuffer, makeHtml, applyStreamDomPatch } = session;
        const initialHtml = processor.messageTextDom.innerHTML;

        await processor.onProgressStreaming(messageId, 'valid output', false);
        expect(getBuffer().size()).toBe(1);

        script.chat.splice(0, script.chat.length, replacement());
        script.incrementChatGeneration();
        frames.runFrame();

        expect(makeHtml).not.toHaveBeenCalled();
        expect(applyStreamDomPatch).not.toHaveBeenCalled();
        expect(processor.messageTextDom.innerHTML).toBe(initialHtml);

        processor.onStopStreaming();
        await session.finish();
    });

    test('rejects a queued write when the renderer reused its DOM node for a different message', async () => {
        const session = await createStreamingSession();
        const { processor, messageId, frames, getBuffer, makeHtml, applyStreamDomPatch } = session;
        const initialHtml = processor.messageTextDom.innerHTML;

        await processor.onProgressStreaming(messageId, 'valid output', false);
        expect(getBuffer().size()).toBe(1);

        processor.messageDom.setAttribute('mesid', '999');
        frames.runFrame();

        expect(makeHtml).not.toHaveBeenCalled();
        expect(applyStreamDomPatch).not.toHaveBeenCalled();
        expect(processor.messageTextDom.innerHTML).toBe(initialHtml);

        processor.onStopStreaming();
        await session.finish();
    });
});
