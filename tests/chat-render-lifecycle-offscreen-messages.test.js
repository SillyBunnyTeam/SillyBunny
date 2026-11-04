import { describe, expect, test } from '@jest/globals';

import {
    createOffscreenMessageTracker,
    OFFSCREEN_MESSAGE_SIZED_CLASS,
    OFFSCREEN_MESSAGE_WIDTH_SETTLE_MS,
} from '../public/scripts/chat-render-lifecycle/offscreen-messages.js';

function createFakeResizeObserverConstructor() {
    const instances = [];

    class FakeResizeObserver {
        constructor(callback) {
            this.callback = callback;
            this.observed = new Set();
            this.observeCalls = [];
            this.disconnectCount = 0;
            instances.push(this);
        }

        observe(element) {
            this.observed.add(element);
            this.observeCalls.push(element);
        }

        unobserve(element) {
            this.observed.delete(element);
        }

        disconnect() {
            this.observed.clear();
            this.disconnectCount++;
        }

        trigger(entries) {
            this.callback(entries);
        }
    }

    return { ResizeObserverImpl: FakeResizeObserver, instances };
}

function createFakeMessage(id) {
    const classes = new Set(['mes']);

    return {
        id,
        isConnected: true,
        classList: {
            add: name => classes.add(name),
            remove: name => classes.delete(name),
            contains: name => classes.has(name),
        },
    };
}

function createHarness() {
    const { ResizeObserverImpl, instances } = createFakeResizeObserverConstructor();
    const messages = [];
    const container = {
        querySelectorAll: () => [...messages],
    };
    const timers = new Map();
    let nextTimer = 1;
    const tracker = createOffscreenMessageTracker({
        container,
        ResizeObserverImpl,
        setTimeoutRef: (callback, delay) => {
            const handle = nextTimer++;
            timers.set(handle, { callback, delay });
            return handle;
        },
        clearTimeoutRef: handle => timers.delete(handle),
    });
    const [messageObserver, containerObserver] = instances;
    const addMessage = (id) => {
        const message = createFakeMessage(id);
        messages.push(message);
        return message;
    };
    const runTimers = () => {
        const pending = [...timers.entries()];
        timers.clear();
        pending.forEach(([, { callback }]) => callback());
    };
    const layout = (message, height = 240) => messageObserver.trigger([{ target: message, contentRect: { height } }]);
    const resizeContainer = (width) => containerObserver.trigger([{ target: container, contentRect: { width } }]);

    return { tracker, container, messageObserver, containerObserver, timers, addMessage, runTimers, layout, resizeContainer };
}

describe('chat render lifecycle off-screen message tracker', () => {
    test('marks a message after its first real layout and stops observing it', () => {
        const { tracker, messageObserver, addMessage, layout } = createHarness();
        const message = addMessage('1');

        expect(tracker.track(message)).toBe(true);
        expect(messageObserver.observed.has(message)).toBe(true);
        expect(message.classList.contains(OFFSCREEN_MESSAGE_SIZED_CLASS)).toBe(false);

        layout(message, 320);

        expect(message.classList.contains(OFFSCREEN_MESSAGE_SIZED_CLASS)).toBe(true);
        expect(messageObserver.observed.has(message)).toBe(false);
    });

    test('waits for a non-zero layout, such as a hidden chat becoming visible', () => {
        const { tracker, messageObserver, addMessage, layout } = createHarness();
        const message = addMessage('1');

        tracker.track(message);
        layout(message, 0);

        expect(message.classList.contains(OFFSCREEN_MESSAGE_SIZED_CLASS)).toBe(false);
        expect(messageObserver.observed.has(message)).toBe(true);

        layout(message, 180);

        expect(message.classList.contains(OFFSCREEN_MESSAGE_SIZED_CLASS)).toBe(true);
    });

    test('ignores messages that left the document before their layout arrived', () => {
        const { tracker, addMessage, layout } = createHarness();
        const message = addMessage('1');

        tracker.track(message);
        message.isConnected = false;
        layout(message, 200);

        expect(message.classList.contains(OFFSCREEN_MESSAGE_SIZED_CLASS)).toBe(false);
    });

    test('does not observe an already marked message again', () => {
        const { tracker, messageObserver, addMessage, layout } = createHarness();
        const message = addMessage('1');

        tracker.track(message);
        layout(message);

        expect(tracker.track(message)).toBe(false);
        expect(messageObserver.observeCalls).toEqual([message]);
    });

    test('a width change clears marks until the width settles, then marks messages again', () => {
        const { tracker, messageObserver, timers, addMessage, runTimers, layout, resizeContainer } = createHarness();
        const first = addMessage('1');
        const second = addMessage('2');

        resizeContainer(900);
        tracker.track(first);
        tracker.track(second);
        layout(first);
        layout(second);

        resizeContainer(600);

        expect(first.classList.contains(OFFSCREEN_MESSAGE_SIZED_CLASS)).toBe(false);
        expect(second.classList.contains(OFFSCREEN_MESSAGE_SIZED_CLASS)).toBe(false);
        expect([...timers.values()].map(timer => timer.delay)).toEqual([OFFSCREEN_MESSAGE_WIDTH_SETTLE_MS]);

        // A message laid out mid-resize is not marked yet; its height is about to change again.
        const third = addMessage('3');
        tracker.track(third);
        layout(third);
        expect(third.classList.contains(OFFSCREEN_MESSAGE_SIZED_CLASS)).toBe(false);

        runTimers();

        expect(messageObserver.observed).toEqual(new Set([first, second, third]));

        layout(first);
        layout(second);
        layout(third);

        expect([first, second, third].every(message => message.classList.contains(OFFSCREEN_MESSAGE_SIZED_CLASS))).toBe(true);
    });

    test('continued resizing restarts the settle timer', () => {
        const { timers, resizeContainer } = createHarness();

        resizeContainer(900);
        resizeContainer(800);
        resizeContainer(700);

        expect(timers.size).toBe(1);
    });

    test('keeps marks when the chat is hidden or only changes height', () => {
        const { tracker, timers, addMessage, layout, resizeContainer } = createHarness();
        const message = addMessage('1');

        resizeContainer(900);
        tracker.track(message);
        layout(message);

        resizeContainer(0);
        resizeContainer(900);
        resizeContainer(900.4);

        expect(message.classList.contains(OFFSCREEN_MESSAGE_SIZED_CLASS)).toBe(true);
        expect(timers.size).toBe(0);
    });

    test('untrack stops observing a message that never got a layout', () => {
        const { tracker, messageObserver, addMessage } = createHarness();
        const message = addMessage('1');

        tracker.track(message);
        tracker.untrack(message);

        expect(messageObserver.observed.has(message)).toBe(false);
    });

    test('dispose disconnects both observers, cancels the settle timer, and refuses new messages', () => {
        const { tracker, messageObserver, containerObserver, timers, addMessage, layout, resizeContainer } = createHarness();
        const message = addMessage('1');

        resizeContainer(900);
        tracker.track(message);
        layout(message);
        resizeContainer(500);
        tracker.dispose();

        expect(messageObserver.disconnectCount).toBe(1);
        expect(containerObserver.disconnectCount).toBe(1);
        expect(timers.size).toBe(0);
        expect(tracker.track(addMessage('2'))).toBe(false);
    });

    test('fails fast for invalid boundary options', () => {
        const { ResizeObserverImpl } = createFakeResizeObserverConstructor();
        const container = { querySelectorAll: () => [] };

        expect(() => createOffscreenMessageTracker()).toThrow('container');
        expect(() => createOffscreenMessageTracker({ container, ResizeObserverImpl: null })).toThrow('ResizeObserverImpl');
        expect(() => createOffscreenMessageTracker({ container, ResizeObserverImpl, setTimeoutRef: null })).toThrow('setTimeoutRef');
        expect(() => createOffscreenMessageTracker({ container, ResizeObserverImpl, clearTimeoutRef: null })).toThrow('clearTimeoutRef');
    });
});
