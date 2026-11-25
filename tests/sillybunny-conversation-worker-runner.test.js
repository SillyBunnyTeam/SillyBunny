import { describe, expect, jest, test } from '@jest/globals';

import { createWorkerRunner } from '../public/scripts/sillybunny-conversation/worker-runner.js';

/** A scheduler that a test fires by hand. */
function createScheduler() {
    let callback = null;
    let cleared = 0;
    return {
        schedule(fn) {
            callback = fn;
            return 1;
        },
        cancel() {
            callback = null;
            cleared++;
        },
        fire: () => callback?.(),
        get cleared() {
            return cleared;
        },
        get armed() {
            return callback !== null;
        },
    };
}

function createFakeLock({ leader = true } = {}) {
    const state = { leader, started: 0, stopped: 0, suspended: 0, resumed: 0 };
    return {
        state,
        start: () => state.started++,
        stop: () => state.stopped++,
        suspend: () => state.suspended++,
        resume: () => state.resumed++,
        isLeader: () => state.leader,
    };
}

function createTarget() {
    const listeners = new Map();
    return {
        addEventListener: (type, listener) => listeners.set(type, [...(listeners.get(type) ?? []), listener]),
        removeEventListener: (type, listener) => listeners.set(type, (listeners.get(type) ?? []).filter(item => item !== listener)),
        dispatch: (type, event = {}) => (listeners.get(type) ?? []).forEach(listener => listener(event)),
        count: type => (listeners.get(type) ?? []).length,
    };
}

function build({ leader = true, tick = jest.fn(async () => {}), now = () => 0, maxTickMs = 600_000 } = {}) {
    const scheduler = createScheduler();
    const lock = createFakeLock({ leader });
    const windowTarget = createTarget();
    const documentTarget = createTarget();
    const runner = createWorkerRunner({ lock, tick, schedule: scheduler.schedule, cancel: scheduler.cancel, intervalMs: 30_000, maxTickMs, now, windowTarget, documentTarget });
    return { runner, scheduler, lock, tick, windowTarget, documentTarget };
}

describe('a tick of the worker', () => {
    test('runs on each interval while this tab leads', async () => {
        const { runner, scheduler, tick } = build();
        runner.start();

        scheduler.fire();
        await Promise.resolve();

        expect(tick).toHaveBeenCalledTimes(1);
    });

    test('does not run in a tab that does not lead', async () => {
        const { runner, scheduler, tick } = build({ leader: false });
        runner.start();

        scheduler.fire();
        await Promise.resolve();

        expect(tick).not.toHaveBeenCalled();
    });

    test('does not start while the tick before it is still running', async () => {
        let finish;
        const tick = jest.fn(() => new Promise((resolve) => { finish = resolve; }));
        const { runner, scheduler } = build({ tick });
        runner.start();

        scheduler.fire();
        scheduler.fire();
        scheduler.fire();
        await Promise.resolve();

        expect(tick).toHaveBeenCalledTimes(1);
        finish();
        await new Promise(resolve => setTimeout(resolve, 0));
        scheduler.fire();
        await Promise.resolve();
        expect(tick).toHaveBeenCalledTimes(2);
    });

    test('starts again after a tick that failed', async () => {
        const tick = jest.fn()
            .mockRejectedValueOnce(new Error('the model is down'))
            .mockResolvedValue(undefined);
        const { runner, scheduler } = build({ tick });
        runner.start();

        scheduler.fire();
        await new Promise(resolve => setTimeout(resolve, 0));
        scheduler.fire();
        await Promise.resolve();

        expect(tick).toHaveBeenCalledTimes(2);
    });

    test('does not stay blocked for ever by a tick that never ends', async () => {
        let time = 0;
        const tick = jest.fn(() => new Promise(() => {}));
        const { runner, scheduler } = build({ tick, now: () => time, maxTickMs: 600_000 });
        runner.start();

        scheduler.fire();
        time = 599_999;
        scheduler.fire();
        await Promise.resolve();
        expect(tick).toHaveBeenCalledTimes(1);

        time = 600_000;
        scheduler.fire();
        await Promise.resolve();
        expect(tick).toHaveBeenCalledTimes(2);
    });

    test('a stuck tick that ends late does not unlock the tick that replaced it', async () => {
        let time = 0;
        const finishers = [];
        const tick = jest.fn(() => new Promise((resolve) => { finishers.push(resolve); }));
        const { runner, scheduler } = build({ tick, now: () => time, maxTickMs: 600_000 });
        runner.start();
        scheduler.fire();
        time = 600_000;
        scheduler.fire();
        await Promise.resolve();
        expect(tick).toHaveBeenCalledTimes(2);

        finishers[0]();
        await new Promise(resolve => setTimeout(resolve, 0));
        scheduler.fire();
        await Promise.resolve();

        expect(tick).toHaveBeenCalledTimes(2);
    });

    test('is handed a signal that stopping the worker aborts', async () => {
        let signal;
        const tick = jest.fn(async (options) => {
            signal = options.signal;
        });
        const { runner, scheduler } = build({ tick });
        runner.start();
        scheduler.fire();
        await Promise.resolve();

        expect(signal.aborted).toBe(false);
        runner.stop();
        expect(signal.aborted).toBe(true);
    });
});

describe('starting and stopping the worker', () => {
    test('joins the lock and arms the interval, and starting twice arms one', () => {
        const { runner, scheduler, lock } = build();

        runner.start();
        runner.start();

        expect(lock.state.started).toBe(1);
        expect(scheduler.armed).toBe(true);
    });

    test('stopping leaves the lock and disarms the interval', () => {
        const { runner, scheduler, lock } = build();
        runner.start();

        runner.stop();

        expect(lock.state.stopped).toBe(1);
        expect(scheduler.armed).toBe(false);
    });

    test('a page that goes away for good gives the lock up, and takes it back when it returns', () => {
        const { runner, lock, windowTarget, documentTarget } = build();
        runner.start();

        windowTarget.dispatch('pagehide', { persisted: false });
        expect(lock.state.suspended).toBe(1);
        windowTarget.dispatch('pageshow', { persisted: true });
        expect(lock.state.resumed).toBe(1);

        documentTarget.dispatch('freeze');
        expect(lock.state.suspended).toBe(2);
        documentTarget.dispatch('resume');
        expect(lock.state.resumed).toBe(2);
    });

    test('stopping removes the page listeners, so that a stopped worker does not take the lock again', () => {
        const { runner, lock, windowTarget, documentTarget } = build();
        runner.start();

        runner.stop();
        windowTarget.dispatch('pageshow', { persisted: true });
        documentTarget.dispatch('resume');

        expect(lock.state.resumed).toBe(0);
        expect(windowTarget.count('pagehide') + windowTarget.count('pageshow') + documentTarget.count('freeze') + documentTarget.count('resume')).toBe(0);
    });
});
