/** @jest-environment jsdom */
/* global globalThis */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CHAT_RENDER_LIFECYCLE_ROLLOUT_KEY } from '../public/scripts/chat-render-lifecycle/index.js';
import { importScriptModule } from './util/script-harness.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let activeRuntime = null;

afterEach(() => {
    activeRuntime?.cleanup();
    activeRuntime = null;
    localStorage.removeItem(CHAT_RENDER_LIFECYCLE_ROLLOUT_KEY);
    document.body.innerHTML = '';
    jest.restoreAllMocks();
});

const LIFECYCLE_DOM = `
    <select id="main_api"><option value="openai" selected>openai</option></select>
    <div id="sheld">
        <div id="chat_wrapper">
            <div id="chat"></div>
        </div>
        <div id="form_sheld">
            <div id="send_form">
                <textarea id="send_textarea"></textarea>
                <div id="send_but"></div>
                <div id="mes_stop" style="display: none;"></div>
            </div>
        </div>
    </div>
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
            <button class="mes_swipe_picker" type="button"></button>
            <button class="mes_delete_add_swipe" type="button"></button>
        </div>
    </div>
`;

function setScrollGeometry(el, { scrollHeight = 2000, clientHeight = 500, scrollTop = 1500 } = {}) {
    let currentScrollTop = scrollTop;
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => scrollHeight });
    Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => clientHeight });
    Object.defineProperty(el, 'scrollTop', {
        configurable: true,
        get: () => currentScrollTop,
        set: (value) => { currentScrollTop = Number(value); },
    });
    el.scrollTo = jest.fn((arg1, arg2) => {
        if (typeof arg1 === 'object' && arg1 !== null && typeof arg1.top === 'number') {
            currentScrollTop = arg1.top;
        } else if (typeof arg2 === 'number') {
            currentScrollTop = arg2;
        }
    });
    return {
        getScrollTop: () => currentScrollTop,
        setScrollTop: (val) => { currentScrollTop = val; },
    };
}

async function createRenderRuntime({
    rolloutEnabled = true,
    isMobile = false,
    autoScroll = true,
    chatTruncation = 10,
    sendOpenAIRequest,
    stream = false,
    runReady = false,
    installObservers = false,
    installVisualViewport = false,
} = {}) {
    if (!rolloutEnabled) {
        localStorage.setItem(CHAT_RENDER_LIFECYCLE_ROLLOUT_KEY, 'false');
    } else {
        localStorage.removeItem(CHAT_RENDER_LIFECYCLE_ROLLOUT_KEY);
    }

    const resizeInstances = [];
    const intersectionInstances = [];
    const origResizeObserver = globalThis.ResizeObserver;
    const origIntersectionObserver = globalThis.IntersectionObserver;
    const origVisualViewport = window.visualViewport;

    if (installObservers) {
        class FakeResizeObserver {
            constructor(callback) {
                this.callback = callback;
                this.observed = new Set();
                this.disconnected = false;
                resizeInstances.push(this);
            }
            observe(target) { this.observed.add(target); }
            unobserve(target) { this.observed.delete(target); }
            disconnect() { this.observed.clear(); this.disconnected = true; }
            trigger(entries) { this.callback(entries, this); }
        }
        class FakeIntersectionObserver {
            constructor(callback) {
                this.callback = callback;
                this.observed = new Set();
                this.disconnected = false;
                intersectionInstances.push(this);
            }
            observe(target) { this.observed.add(target); }
            unobserve(target) { this.observed.delete(target); }
            disconnect() { this.observed.clear(); this.disconnected = true; }
        }
        globalThis.ResizeObserver = FakeResizeObserver;
        window.ResizeObserver = FakeResizeObserver;
        globalThis.IntersectionObserver = FakeIntersectionObserver;
        window.IntersectionObserver = FakeIntersectionObserver;
    }

    const visualViewportListeners = { scroll: new Set(), resize: new Set() };
    if (installVisualViewport) {
        Object.defineProperty(window, 'visualViewport', {
            configurable: true,
            value: {
                height: 700,
                offsetTop: 0,
                addEventListener: jest.fn((type, fn) => visualViewportListeners[type]?.add(fn)),
                removeEventListener: jest.fn((type, fn) => visualViewportListeners[type]?.delete(fn)),
            },
        });
    }

    const loaded = await importScriptModule({
        dom: LIFECYCLE_DOM,
        mocks: {
            'scripts/RossAscends-mods.js': {
                isMobile: jest.fn(() => isMobile),
            },
            ...(sendOpenAIRequest ? {
                'scripts/openai.js': {
                    sendOpenAIRequest,
                    prepareOpenAIMessages: jest.fn(async () => [[{ role: 'user', content: 'Hi' }], 10]),
                },
            } : {}),
        },
    });

    loaded.state.power_user.chat_truncation = chatTruncation;
    loaded.state.power_user.auto_scroll_chat_to_bottom = autoScroll;
    loaded.state.oai_settings.stream_openai = stream;
    loaded.state.oai_settings.chat_completion_source = 'openai';
    loaded.state.oai_settings.openai_model = 'gpt-4o';

    activeRuntime = {
        cleanup() {
            loaded.cleanup();
            if (installObservers) {
                globalThis.ResizeObserver = origResizeObserver;
                window.ResizeObserver = origResizeObserver;
                globalThis.IntersectionObserver = origIntersectionObserver;
                window.IntersectionObserver = origIntersectionObserver;
            }
            if (installVisualViewport) {
                Object.defineProperty(window, 'visualViewport', { configurable: true, value: origVisualViewport });
            }
        },
    };

    if (runReady) {
        await loaded.runReady();
        loaded.$('#main_api').val('openai').trigger('change');
    }

    const { script } = loaded;
    script.characters.push({
        name: 'Bunny',
        avatar: 'bunny.png',
        chat: 'render-chat',
        first_mes: 'Hi',
        data: { extensions: {} },
    });
    script.setCharacterId(0);
    script.setCharacterName('Bunny');
    script.setOnlineStatus('connected');

    return {
        ...loaded,
        resizeInstances,
        intersectionInstances,
        visualViewportListeners,
    };
}

describe('chat render lifecycle script wiring', () => {
    test.each([true, false])('printMessages and redisplayChat render the bounded window and pin initial load to bottom (rollout=%s)', async (rolloutEnabled) => {
        const runtime = await createRenderRuntime({ rolloutEnabled, chatTruncation: 4 });
        const chatEl = document.getElementById('chat');
        const geom = setScrollGeometry(chatEl, { scrollHeight: 2400, clientHeight: 400, scrollTop: 0 });

        for (let i = 0; i < 6; i++) {
            runtime.script.chat.push({ name: 'Bunny', is_user: i % 2 === 0, is_system: false, mes: `Message ${i}`, extra: {} });
        }

        await runtime.script.printMessages();

        const rendered = Array.from(document.querySelectorAll('#chat > .mes')).map(el => Number(el.getAttribute('mesid')));
        expect(rendered).toEqual([2, 3, 4, 5]);
        expect(document.querySelector('#chat > .mes[mesid="5"]').classList.contains('last_mes')).toBe(true);
        expect(document.getElementById('show_more_messages')).toBeTruthy();
        expect(geom.getScrollTop()).toBeGreaterThanOrEqual(2000);
        expect(runtime.mocks['scripts/tags.js'].applyCharacterTagsToMessageDivs).toHaveBeenCalledWith({ mesIds: [2, 3, 4, 5] });
    });

    test.each([true, false])('showMoreMessages and showNewerMessages page history windows and emit MORE_MESSAGES_LOADED (rollout=%s)', async (rolloutEnabled) => {
        const runtime = await createRenderRuntime({ rolloutEnabled, chatTruncation: 3 });
        runtime.state.power_user.aggressive_dom_unload = true;
        runtime.state.power_user.aggressive_dom_window_size = 3;
        for (let i = 0; i < 12; i++) {
            runtime.script.chat.push({ name: 'Bunny', is_user: false, is_system: false, mes: `Msg ${i}`, extra: {} });
        }

        const loadedEvents = [];
        runtime.eventSource.on(runtime.script.event_types.MORE_MESSAGES_LOADED, () => loadedEvents.push('loaded'));

        await runtime.script.printMessages();
        expect(Array.from(document.querySelectorAll('#chat > .mes')).map(el => Number(el.getAttribute('mesid')))).toEqual([9, 10, 11]);

        await runtime.script.showMoreMessages();
        const afterOlder = Array.from(document.querySelectorAll('#chat > .mes')).map(el => Number(el.getAttribute('mesid')));
        expect(afterOlder[0]).toBeLessThan(9);
        expect(loadedEvents).toHaveLength(1);

        // Page further back so the tail is pruned below message 11, then page forward with showNewerMessages.
        for (let step = 0; step < 6 && Number(document.querySelector('#chat > .mes').getAttribute('mesid')) > 0; step++) {
            await runtime.script.showMoreMessages();
        }
        expect(document.getElementById('show_more_messages')).toBeNull();
        expect(Number(document.querySelector('#chat > .mes').getAttribute('mesid'))).toBe(0);

        const beforeNewerLast = Number(Array.from(document.querySelectorAll('#chat > .mes')).at(-1).getAttribute('mesid'));
        expect(beforeNewerLast).toBeLessThan(11);
        await runtime.script.showNewerMessages();
        const afterNewerLast = Number(Array.from(document.querySelectorAll('#chat > .mes')).at(-1).getAttribute('mesid'));
        expect(afterNewerLast).toBeGreaterThan(beforeNewerLast);
        expect(loadedEvents.length).toBeGreaterThanOrEqual(3);
    });

    test.each([true, false])('addOneMessage returns the rendered element, updates .last_mes, and honors pre-mutation scroll position (rollout=%s)', async (rolloutEnabled) => {
        const runtime = await createRenderRuntime({ rolloutEnabled, autoScroll: true, chatTruncation: 3 });
        const chatEl = document.getElementById('chat');
        const geom = setScrollGeometry(chatEl, { scrollHeight: 2000, clientHeight: 500, scrollTop: 1500 });

        for (let i = 0; i < 3; i++) {
            const msg = { name: 'Bunny', is_user: false, is_system: false, mes: `M${i}`, extra: {} };
            runtime.script.chat.push(msg);
            const el = runtime.script.addOneMessage(msg);
            expect(el[0]).toBeInstanceOf(HTMLElement);
        }
        expect(document.querySelector('#chat > .mes[mesid="2"]').classList.contains('last_mes')).toBe(true);

        // User scrolls far up away from the bottom before a new tail message arrives.
        geom.setScrollTop(100);
        const tailMsg = { name: 'Bunny', is_user: false, is_system: false, mes: 'M3', extra: {} };
        runtime.script.chat.push(tailMsg);
        const rendered = runtime.script.addOneMessage(tailMsg);
        expect(rendered[0].getAttribute('mesid')).toBe('3');
        expect(document.querySelector('#chat > .mes[mesid="3"]').classList.contains('last_mes')).toBe(true);
        // Pruned to window size (3).
        expect(document.querySelectorAll('#chat > .mes')).toHaveLength(3);
        // Did not yank scroll position back to the bottom.
        expect(geom.getScrollTop()).toBe(100);
    });

    test.each([true, false])('updateMessageBlock updates message DOM through lifecycle or legacy path (rollout=%s)', async (rolloutEnabled) => {
        const runtime = await createRenderRuntime({ rolloutEnabled });
        const msg = { name: 'Bunny', is_user: false, is_system: false, mes: 'Initial text', extra: {} };
        runtime.script.chat.push(msg);
        runtime.script.addOneMessage(msg);

        msg.mes = 'Updated text';
        await runtime.script.updateMessageBlock(0, msg);
        expect(document.querySelector('#chat .mes[mesid="0"] .mes_text').textContent).toContain('Updated text');
    });

    test.each([true, false])('streaming start and progress render chunks and finalize cleanly (rollout=%s)', async (rolloutEnabled) => {
        const sendOpenAIRequest = jest.fn(async () => async function* () {
            yield { text: 'Hello', swipes: [], logprobs: null, toolCalls: [], state: {} };
            yield { text: 'Hello streamed world', swipes: [], logprobs: null, toolCalls: [], state: {} };
        });

        const runtime = await createRenderRuntime({ rolloutEnabled, stream: true, sendOpenAIRequest, runReady: true });
        runtime.script.chat.push({ name: 'User', is_user: true, is_system: false, mes: 'Hi', extra: {} });
        runtime.script.addOneMessage(runtime.script.chat[0]);

        const result = await runtime.script.Generate('normal');
        expect(String(result)).toBe('Hello streamed world');
        expect(runtime.script.chat).toHaveLength(2);
        expect(document.querySelector('#chat .mes[mesid="1"] .mes_text').textContent).toContain('Hello streamed world');
    });

    test.each([true, false])('display-only swipe replacement updates rendered text without starting generation (rollout=%s)', async (rolloutEnabled) => {
        const sendOpenAIRequest = jest.fn();
        const runtime = await createRenderRuntime({ rolloutEnabled, sendOpenAIRequest });
        runtime.script.chat.push({
            name: 'Bunny',
            is_user: false,
            is_system: false,
            mes: 'First swipe',
            swipe_id: 0,
            swipes: ['First swipe', 'Second swipe'],
            swipe_info: [{}, {}],
            extra: {},
        });
        runtime.script.addOneMessage(runtime.script.chat[0]);

        await runtime.script.swipe(null, 'right', { forceMesId: 0 });
        expect(document.querySelector('#chat .mes[mesid="0"] .mes_text').textContent).toContain('Second swipe');
        expect(sendOpenAIRequest).not.toHaveBeenCalled();
    });

    test('delegated ResizeObserver and offscreen message tracker observe rendered messages and clean up on removal and unload', async () => {
        const queuedFrames = [];
        const origRaf = window.requestAnimationFrame;
        const origCaf = window.cancelAnimationFrame;
        const asyncRaf = jest.fn(cb => {
            queuedFrames.push(cb);
            return queuedFrames.length;
        });
        window.requestAnimationFrame = asyncRaf;
        globalThis.requestAnimationFrame = asyncRaf;
        window.cancelAnimationFrame = jest.fn();
        globalThis.cancelAnimationFrame = window.cancelAnimationFrame;

        try {
            const runtime = await createRenderRuntime({ rolloutEnabled: true, installObservers: true, runReady: true });
            const chatEl = document.getElementById('chat');
            setScrollGeometry(chatEl, { scrollHeight: 1000, clientHeight: 400, scrollTop: 600 });

            runtime.script.chat.push(
                { name: 'Bunny', is_user: false, is_system: false, mes: 'Msg 0', extra: {} },
                { name: 'Bunny', is_user: false, is_system: false, mes: 'Msg 1', extra: {} },
            );
            runtime.script.addOneMessage(runtime.script.chat[0]);
            runtime.script.addOneMessage(runtime.script.chat[1]);

            while (queuedFrames.length) {
                queuedFrames.shift()(0);
            }

            expect(runtime.resizeInstances.length).toBeGreaterThanOrEqual(2);
            const block0 = document.querySelector('#chat .mes[mesid="0"] .mes_block');
            const block1 = document.querySelector('#chat .mes[mesid="1"] .mes_block');
            const mes0 = document.querySelector('#chat .mes[mesid="0"]');
            const mes1 = document.querySelector('#chat .mes[mesid="1"]');
            const resizeObserver = runtime.resizeInstances.find(obs => obs.observed.has(block0));
            const offscreenObserver = runtime.resizeInstances.find(obs => obs.observed.has(mes0));
            expect(resizeObserver).toBeTruthy();
            expect(resizeObserver.observed.has(block1)).toBe(true);
            expect(offscreenObserver).toBeTruthy();
            expect(offscreenObserver.observed.has(mes1)).toBe(true);

            // Deleting the last message unobserves its block and untracks its message while keeping msg 0.
            await runtime.script.deleteLastMessage();
            expect(resizeObserver.observed.has(block1)).toBe(false);
            expect(resizeObserver.observed.has(block0)).toBe(true);
            expect(offscreenObserver.observed.has(mes1)).toBe(false);
            expect(offscreenObserver.observed.has(mes0)).toBe(true);

            // Clearing chat disposes both observers.
            await runtime.script.clearChat();
            expect(resizeObserver.disconnected).toBe(true);
            expect(offscreenObserver.disconnected).toBe(true);
        } finally {
            window.requestAnimationFrame = origRaf;
            globalThis.requestAnimationFrame = origRaf;
            window.cancelAnimationFrame = origCaf;
            globalThis.cancelAnimationFrame = origCaf;
        }
    });

    test('refreshSwipeButtons avoids redundant display toggles when control visibility does not change', async () => {
        const runtime = await createRenderRuntime({ rolloutEnabled: true });
        runtime.script.chat.push({
            name: 'Bunny',
            is_user: false,
            is_system: false,
            mes: 'Single swipe',
            swipe_id: 0,
            swipes: ['Single swipe'],
            swipe_info: [{}],
            extra: {},
        });
        runtime.script.addOneMessage(runtime.script.chat[0]);

        runtime.script.refreshSwipeButtons(false, false);
        const picker = document.querySelector('#chat .mes[mesid="0"] .mes_swipe_picker');
        const initialDisplay = picker.style.display;
        const setPropertySpy = jest.spyOn(picker.style, 'setProperty');

        // Calling refreshSwipeButtons again with unchanged state does not flip display unnecessarily.
        runtime.script.refreshSwipeButtons(false, false);
        expect(picker.style.display).toBe(initialDisplay);
        expect(setPropertySpy).not.toHaveBeenCalled();
    });

    test.each([true, false])('mobile viewport observer registers visualViewport listeners, resets on clearChat, and routes shell wheel events to #chat (rollout=%s)', async (rolloutEnabled) => {
        const runtime = await createRenderRuntime({
            rolloutEnabled,
            isMobile: true,
            installVisualViewport: true,
            runReady: true,
        });

        expect(window.visualViewport.addEventListener).toHaveBeenCalledWith('scroll', expect.any(Function), expect.anything());
        expect(window.visualViewport.addEventListener).toHaveBeenCalledWith('resize', expect.any(Function), expect.anything());

        // Shell wheel events over #sheld route deltaY onto #chat.scrollTop.
        const chatEl = document.getElementById('chat');
        const geom = setScrollGeometry(chatEl, { scrollHeight: 1200, clientHeight: 400, scrollTop: 100 });
        const wheelEvent = new window.WheelEvent('wheel', {
            bubbles: true,
            cancelable: true,
            deltaX: 0,
            deltaY: 60,
            deltaMode: 0,
        });
        document.getElementById('sheld').dispatchEvent(wheelEvent);
        expect(geom.getScrollTop()).toBe(160);

        // clearChat resets mobile viewport lifecycle and beforeunload disposes observer listeners.
        await runtime.script.clearChat();
        runtime.$(window).trigger('beforeunload');
        expect(window.visualViewport.removeEventListener.mock.calls.length > 0).toBe(rolloutEnabled);
    });

    test('off-screen message skipping CSS only skips laid-out history and never collapses it', () => {
        const styleSource = readFileSync(path.join(repoRoot, 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n');

        expect(styleSource).toMatch(/#chat > \.mes \{[^}]*flex-shrink: 0;/);
        expect(styleSource).toContain('#chat > .mes.sb-mes-sized:not(.last_mes):not(:nth-last-child(-n + 20)) {\n    content-visibility: auto;\n}');
        expect(styleSource).toMatch(/\n\.mes \{[^}]*contain-intrinsic-size: auto 180px;/);
    });
});
