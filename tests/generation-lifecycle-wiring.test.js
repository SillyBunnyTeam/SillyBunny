/** @jest-environment jsdom */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import {
    GENERATION_LIFECYCLE_ABORT_REASON,
} from '../public/scripts/generation-lifecycle/index.js';
import { importScriptModule } from './util/script-harness.js';

let activeRuntime = null;

afterEach(() => {
    activeRuntime?.cleanup();
    activeRuntime = null;
    document.body.innerHTML = '';
    document.head.innerHTML = '';
    delete document.body.dataset.generating;
    jest.restoreAllMocks();
});

const GENERATION_DOM = `
    <select id="main_api"><option value="openai" selected>openai</option></select>
    <div id="send_form">
        <textarea id="send_textarea"></textarea>
        <div id="send_but"></div>
        <div id="mes_stop" style="display: none;"></div>
    </div>
    <div id="chat"></div>
    <div id="message_template" hidden>
        <div class="mes">
            <div class="mes_block">
                <div class="ch_name"><span class="name_text"></span></div>
                <div class="mes_text"></div>
                <div class="mes_timer"></div>
                <div class="tokenCounterDisplay"></div>
            </div>
            <div class="swipe_left"></div>
            <div class="swipe_right"></div>
            <div class="swipes-counter"></div>
        </div>
    </div>
`;

async function createGenerationRuntime({
    stream = false,
    sendOpenAIRequest = jest.fn(async () => ({ choices: [{ message: { content: 'AI reply' } }] })),
    dom = GENERATION_DOM,
} = {}) {
    const loaded = await importScriptModule({
        dom,
        mocks: {
            'scripts/openai.js': {
                sendOpenAIRequest,
                prepareOpenAIMessages: jest.fn(async () => [[{ role: 'user', content: 'Hi' }], 10]),
            },
        },
    });
    activeRuntime = loaded;
    loaded.state.oai_settings.stream_openai = stream;
    loaded.state.oai_settings.chat_completion_source = 'openai';
    loaded.state.oai_settings.openai_model = 'gpt-4o';

    const { script, $ } = loaded;
    await loaded.runReady();
    $('#main_api').val('openai').trigger('change');
    script.characters.push({
        name: 'Aster',
        avatar: 'aster.png',
        chat: 'aster-chat',
        description: '',
        personality: '',
        scenario: '',
        first_mes: 'Hello',
        mes_example: '',
        data: { extensions: {} },
    });
    script.setCharacterId(0);
    script.setCharacterName('Aster');
    script.setOnlineStatus('connected');
    script.chat.push({
        name: 'User',
        is_user: true,
        is_system: false,
        mes: 'Hello there',
        extra: {},
    });

    return {
        ...loaded,
        sendOpenAIRequest,
    };
}

describe('generation lifecycle wiring', () => {
    test('deactivateSendButtons and activateSendButtons drive UI lock state and body generating marker', async () => {
        const { script, eventSource } = await createGenerationRuntime();
        const endedEvents = [];
        eventSource.on(script.event_types.GENERATION_ENDED, (...args) => endedEvents.push(args));

        script.deactivateSendButtons();
        expect(document.body.dataset.generating).toBe('true');
        expect(document.getElementById('send_form').classList.contains('sb-generating-controls')).toBe(true);
        expect(document.getElementById('mes_stop').style.display).toBe('flex');

        script.activateSendButtons();
        expect(document.body.dataset.generating).toBeUndefined();
        expect(document.getElementById('send_form').classList.contains('sb-generating-controls')).toBe(false);
        expect(document.getElementById('mes_stop').style.display).toBe('none');
        expect(endedEvents).toEqual([[1]]);

        // markBodyGenerating: false still shows stop controls without marking body.dataset.generating.
        script.deactivateSendButtons({ markBodyGenerating: false });
        expect(document.body.dataset.generating).toBeUndefined();
        expect(document.getElementById('mes_stop').style.display).toBe('flex');

        // When offline, activateSendButtons restores #send_but visibility.
        script.setOnlineStatus('no_connection');
        document.getElementById('send_but').classList.add('displayNone');
        script.activateSendButtons({ emitGenerationEnded: false });
        expect(document.getElementById('send_but').classList.contains('displayNone')).toBe(false);
        expect(endedEvents).toHaveLength(1);
    });

    test('emits GENERATION_ENDED once even when the mobile stylesheet hides the stop button on class removal', async () => {
        const { script, eventSource } = await createGenerationRuntime();
        const style = document.createElement('style');
        style.textContent = '#send_form:not(.sb-generating-controls) #mes_stop { display: none !important; }';
        document.head.appendChild(style);

        const endedEvents = [];
        eventSource.on(script.event_types.GENERATION_ENDED, (...args) => endedEvents.push(args));

        script.chat.push(
            { name: 'Aster', is_user: false, is_system: false, mes: 'One', extra: {} },
            { name: 'User', is_user: true, is_system: false, mes: 'Two', extra: {} },
        );

        script.deactivateSendButtons();
        script.activateSendButtons();
        script.activateSendButtons();

        expect(endedEvents).toEqual([[3]]);
        expect(document.getElementById('send_form').classList.contains('sb-generating-controls')).toBe(false);
        expect(document.getElementById('mes_stop').style.display).toBe('none');
    });

    test('stopGeneration is a no-op when idle and aborts an active request with the lifecycle abort reason', async () => {
        let capturedSignal = null;
        let rejectRequest = null;
        const sendOpenAIRequest = jest.fn((_type, _prompt, signal) => {
            capturedSignal = signal;
            return new Promise((_resolve, reject) => {
                rejectRequest = reject;
                signal?.addEventListener('abort', () => reject(new Error('Aborted')));
            });
        });

        const { script, eventSource } = await createGenerationRuntime({ sendOpenAIRequest });
        const stoppedEvents = [];
        const endedEvents = [];
        eventSource.on(script.event_types.GENERATION_STOPPED, (...args) => stoppedEvents.push(args));
        eventSource.on(script.event_types.GENERATION_ENDED, (...args) => endedEvents.push(args));

        expect(script.stopGeneration()).toBe(false);
        expect(stoppedEvents).toHaveLength(0);

        const generation = script.Generate('normal');
        for (let i = 0; i < 40 && !capturedSignal; i++) {
            await Promise.resolve();
        }
        expect(capturedSignal).toBeTruthy();
        expect(capturedSignal.aborted).toBe(false);

        expect(script.stopGeneration()).toBe(true);
        expect(capturedSignal.aborted).toBe(true);
        expect(capturedSignal.reason).toBe(GENERATION_LIFECYCLE_ABORT_REASON);
        expect(stoppedEvents).toHaveLength(1);
        expect(endedEvents).toHaveLength(0);
        expect(document.getElementById('mes_stop').style.display).toBe('none');

        rejectRequest?.(new Error('Aborted'));
        await generation.catch(() => {});
        expect(endedEvents).toHaveLength(0);
    });

    test('nested quiet generation does not unblock an active streaming main generation, while explicit stop does', async () => {
        let yieldChunk = null;
        let streamRequestCount = 0;
        const sendOpenAIRequest = jest.fn(async (type) => {
            if (type === 'quiet') {
                return { choices: [{ message: { content: 'quiet helper result' } }] };
            }
            streamRequestCount++;
            return async function* () {
                yield { text: 'Partial stream', swipes: [], logprobs: null, toolCalls: [], state: {} };
                await new Promise(resolve => { yieldChunk = resolve; });
                yield { text: 'Partial stream finished', swipes: [], logprobs: null, toolCalls: [], state: {} };
            };
        });

        const { script, eventSource } = await createGenerationRuntime({ stream: true, sendOpenAIRequest });
        const stoppedEvents = [];
        const endedEvents = [];
        eventSource.on(script.event_types.GENERATION_STOPPED, (...args) => stoppedEvents.push(args));
        eventSource.on(script.event_types.GENERATION_ENDED, (...args) => endedEvents.push(args));

        const mainGen = script.Generate('normal');
        for (let i = 0; i < 60 && !yieldChunk; i++) {
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        expect(streamRequestCount).toBe(1);
        expect(document.getElementById('mes_stop').style.display).toBe('flex');

        // Run a nested quiet generation while the main stream is active; it must not unlock main UI.
        const quietResult = await script.Generate('quiet', { quiet_prompt: 'summarize' });
        expect(String(quietResult)).toBe('quiet helper result');
        expect(document.getElementById('mes_stop').style.display).toBe('flex');
        expect(endedEvents).toHaveLength(0);

        // Explicit Stop force-unblocks the UI and emits GENERATION_STOPPED without GENERATION_ENDED.
        expect(script.stopGeneration()).toBe(true);
        yieldChunk();
        await mainGen.catch(() => {});

        expect(stoppedEvents).toHaveLength(1);
        expect(endedEvents).toHaveLength(0);
        expect(document.getElementById('mes_stop').style.display).toBe('none');
    });

    test('routes streaming provider-error cleanup through GENERATION_STOPPED without GENERATION_ENDED', async () => {
        const sendOpenAIRequest = jest.fn(async () => async function* () {
            yield { text: 'Before error', swipes: [], logprobs: null, toolCalls: [], state: {} };
            throw new Error('Upstream provider failed');
        });

        const { script, eventSource } = await createGenerationRuntime({ stream: true, sendOpenAIRequest });
        const stoppedEvents = [];
        const endedEvents = [];
        eventSource.on(script.event_types.GENERATION_STOPPED, (...args) => stoppedEvents.push(args));
        eventSource.on(script.event_types.GENERATION_ENDED, (...args) => endedEvents.push(args));

        await script.Generate('normal').catch(() => {});

        expect(stoppedEvents.length).toBeGreaterThanOrEqual(1);
        expect(endedEvents).toHaveLength(0);
        expect(document.getElementById('mes_stop').style.display).toBe('none');
    });

    test('keeps buffered streaming output hidden until post-main intercept completes and saves intercepted text', async () => {
        let releaseSecondChunk = null;
        let chatLengthDuringStream = null;
        let domCountDuringStream = null;
        const sendOpenAIRequest = jest.fn(async () => async function* () {
            yield { text: 'First chunk', swipes: [], logprobs: null, toolCalls: [], state: {} };
            await new Promise(resolve => { releaseSecondChunk = resolve; });
            yield { text: 'First chunk and second chunk', swipes: [], logprobs: null, toolCalls: [], state: {} };
        });

        const { script, eventSource } = await createGenerationRuntime({ stream: true, sendOpenAIRequest });
        const events = [];

        eventSource.on(script.event_types.GENERATION_OUTPUT_BUFFERING_DECISION, (eventData) => {
            events.push(['buffering_decision', eventData.type, eventData.isStreaming]);
            eventData.hasPostMainInterceptors = true;
        });

        eventSource.on(script.event_types.MAIN_GENERATION_OUTPUT_READY, (eventData) => {
            events.push(['output_ready', eventData.type, eventData.isStreaming, eventData.text]);
            // Still hidden before saveReply runs.
            expect(script.chat).toHaveLength(1);
            expect(document.querySelectorAll('#chat > .mes')).toHaveLength(0);
            eventData.text = 'Intercepted streamed reply';
        });

        eventSource.on(script.event_types.MESSAGE_RECEIVED, (mesId) => {
            events.push(['message_received', mesId, script.chat[mesId]?.mes]);
        });

        const pending = script.Generate('normal');
        for (let i = 0; i < 60 && !releaseSecondChunk; i++) {
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        chatLengthDuringStream = script.chat.length;
        domCountDuringStream = document.querySelectorAll('#chat > .mes').length;
        releaseSecondChunk();
        const result = await pending;

        expect(chatLengthDuringStream).toBe(1);
        expect(domCountDuringStream).toBe(0);
        expect(String(result)).toBe('Intercepted streamed reply');
        expect(script.chat).toHaveLength(2);
        expect(script.chat[1].mes).toBe('Intercepted streamed reply');
        expect(events).toEqual([
            ['buffering_decision', 'normal', true],
            ['output_ready', 'normal', true, 'First chunk and second chunk'],
            ['message_received', 1, 'Intercepted streamed reply'],
        ]);
    });

    test('cancelling a buffered streaming intercept skips saving and unblocks cleanly', async () => {
        const sendOpenAIRequest = jest.fn(async () => async function* () {
            yield { text: 'Hidden draft', swipes: [], logprobs: null, toolCalls: [], state: {} };
        });

        const { script, eventSource } = await createGenerationRuntime({ stream: true, sendOpenAIRequest });
        const endedEvents = [];
        eventSource.on(script.event_types.GENERATION_ENDED, () => endedEvents.push('ended'));
        eventSource.on(script.event_types.GENERATION_OUTPUT_BUFFERING_DECISION, (eventData) => {
            eventData.hasPostMainInterceptors = true;
        });
        eventSource.on(script.event_types.MAIN_GENERATION_OUTPUT_READY, (eventData) => {
            eventData.cancelled = true;
        });

        await script.Generate('normal');

        expect(script.chat).toHaveLength(1);
        expect(endedEvents).toHaveLength(1);
        expect(document.getElementById('mes_stop').style.display).toBe('none');
    });

    test('runs main output intercept before saveReply stores non-streaming replies and skips excluded types', async () => {
        const sendOpenAIRequest = jest.fn(async () => ({
            choices: [{ message: { content: 'Original non-stream reply' } }],
        }));

        const { script, eventSource } = await createGenerationRuntime({ stream: false, sendOpenAIRequest });
        const order = [];

        eventSource.on(script.event_types.MAIN_GENERATION_OUTPUT_READY, (eventData) => {
            order.push(`intercept:${eventData.type}:${eventData.isStreaming}:${script.chat.length}`);
            eventData.text = 'Rewritten non-stream reply';
        });
        eventSource.on(script.event_types.MESSAGE_RECEIVED, (mesId) => {
            order.push(`saved:${mesId}:${script.chat[mesId]?.mes}`);
        });

        await script.Generate('normal');

        expect(order).toEqual([
            'intercept:normal:false:1',
            'saved:1:Rewritten non-stream reply',
        ]);
        expect(script.chat[1].mes).toBe('Rewritten non-stream reply');

        // Excluded generation types (quiet, impersonate) bypass MAIN_GENERATION_OUTPUT_READY.
        order.length = 0;
        const quietReply = await script.Generate('quiet', { quiet_prompt: 'internal check' });
        expect(String(quietReply)).toBe('Original non-stream reply');
        expect(order).toEqual([]);
    });
});
