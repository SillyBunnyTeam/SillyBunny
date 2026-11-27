import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { createWorld, installAutoEngineMocks, NOW } from './util/auto-engine-harness.js';

const world = createWorld(jest);
await installAutoEngineMocks(jest, world);

const { startConversationAutoWorker, stopConversationAutoWorker } = await import('../public/scripts/sillybunny-conversation/auto-engine.js');

const { generateConversationReply } = world.spies;
const INTERVAL_MS = 30_000;

/** The Web Locks API with one lock that a test grants by hand, as another tab would hold it. */
function createHeldLocks() {
    const requests = [];
    return {
        requests,
        request(name, options, callback) {
            return new Promise((resolve, reject) => {
                requests.push({ name, options, grant: () => Promise.resolve(callback({ name })).then(resolve, reject), reject });
                options?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
            });
        },
    };
}

function createPageTarget() {
    const listeners = new Map();
    return {
        addEventListener: (type, listener) => listeners.set(type, [...(listeners.get(type) ?? []), listener]),
        removeEventListener: (type, listener) => listeners.set(type, (listeners.get(type) ?? []).filter(item => item !== listener)),
        count: () => [...listeners.values()].reduce((total, list) => total + list.length, 0),
    };
}

let locks;
let windowTarget;
let documentTarget;

beforeEach(() => {
    world.reset();
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    locks = createHeldLocks();
    windowTarget = createPageTarget();
    documentTarget = createPageTarget();
    global.window = windowTarget;
    global.document = documentTarget;
    Object.defineProperty(global, 'navigator', { value: { locks }, configurable: true });
    const view = world.addConversation('conv_1_direct', { quietMinutes: 100_000, settings: { proactive_messaging: true } });
    world.railItems = [world.railItemFor(view)];
});

afterEach(() => {
    stopConversationAutoWorker();
    jest.useRealTimers();
    delete global.window;
    delete global.document;
    Object.defineProperty(global, 'navigator', { value: undefined, configurable: true });
});

async function runIntervals(count) {
    for (let index = 0; index < count; index++) {
        jest.advanceTimersByTime(INTERVAL_MS);
        for (let turn = 0; turn < 20; turn++) {
            await Promise.resolve();
        }
    }
}

describe('the automatic worker of a tab', () => {
    test('does nothing in a tab that another tab leads, however due the chat is', async () => {
        startConversationAutoWorker();

        await runIntervals(3);

        expect(locks.requests).toHaveLength(1);
        expect(locks.requests[0].name).toBe('sb-conversation-worker');
        expect(generateConversationReply).not.toHaveBeenCalled();
    });

    test('starts to send once the tab leads', async () => {
        startConversationAutoWorker();
        await runIntervals(1);
        expect(generateConversationReply).not.toHaveBeenCalled();

        locks.requests[0].grant();
        await runIntervals(1);

        expect(generateConversationReply).toHaveBeenCalledTimes(1);
    });

    test('lets go of the lock when it is stopped, and a tab that waits can lead', async () => {
        startConversationAutoWorker();
        let released = false;
        locks.requests[0].grant().then(() => {
            released = true;
        });
        await runIntervals(1);

        stopConversationAutoWorker();
        await Promise.resolve();
        await Promise.resolve();

        expect(released).toBe(true);
    });

    test('starting it again leaves one worker: the old one gives up its lock and its page listeners', async () => {
        startConversationAutoWorker();
        const first = windowTarget.count() + documentTarget.count();
        startConversationAutoWorker();

        expect(locks.requests).toHaveLength(2);
        expect(windowTarget.count() + documentTarget.count()).toBe(first);
        locks.requests[1].grant();
        await runIntervals(1);

        expect(generateConversationReply).toHaveBeenCalledTimes(1);
    });

    test('stopped, it sends nothing and leaves no listener behind', async () => {
        startConversationAutoWorker();
        locks.requests[0].grant();
        stopConversationAutoWorker();

        await runIntervals(3);

        expect(generateConversationReply).not.toHaveBeenCalled();
        expect(windowTarget.count() + documentTarget.count()).toBe(0);
        expect(world.state.conversationState.autoWorkerStarted).toBe(false);
    });
});
