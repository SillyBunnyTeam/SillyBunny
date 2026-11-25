import { beforeEach, describe, expect, test } from '@jest/globals';

import { createWorkerLock } from '../public/scripts/sillybunny-conversation/worker-lock.js';

/** A clock and a scheduler that a test moves by hand. */
function createClock() {
    let time = 1_000_000;
    let nextId = 1;
    const timers = new Map();
    return {
        now: () => time,
        setTimer(callback, delay) {
            const id = nextId++;
            timers.set(id, { callback, at: time + delay });
            return id;
        },
        clearTimer(id) {
            timers.delete(id);
        },
        /** Moves time forward and runs each timer that falls due, in order, including the ones that those timers set. */
        async advance(ms) {
            await flush();
            const end = time + ms;
            for (;;) {
                const due = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((first, second) => first[1].at - second[1].at)[0];
                if (!due) {
                    break;
                }
                timers.delete(due[0]);
                time = Math.max(time, due[1].at);
                due[1].callback();
                await flush();
            }
            time = end;
            await flush();
        },
    };
}

async function flush() {
    for (let turn = 0; turn < 8; turn++) {
        await Promise.resolve();
    }
}

/** The Web Locks API as far as the worker uses it: exclusive locks held until the callback's promise settles, and an abortable queue. */
function createFakeLocks() {
    const held = new Set();
    const queues = new Map();

    function grantNext(name) {
        const queue = queues.get(name) ?? [];
        if (held.has(name) || !queue.length) {
            return;
        }
        const next = queue.shift();
        held.add(name);
        Promise.resolve(next.callback({ name })).then(next.resolve, next.reject).finally(() => {
            held.delete(name);
            grantNext(name);
        });
    }

    return {
        request(name, options, callback) {
            return new Promise((resolve, reject) => {
                const entry = { callback, resolve, reject };
                const queue = queues.get(name) ?? [];
                queues.set(name, queue);
                queue.push(entry);
                options?.signal?.addEventListener('abort', () => {
                    const index = queue.indexOf(entry);
                    if (index >= 0) {
                        queue.splice(index, 1);
                        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
                    }
                });
                grantNext(name);
            });
        },
    };
}

/** BroadcastChannel as far as the worker uses it: every instance of a name hears the others, not itself. */
function createChannelHub() {
    const instances = new Set();
    const hub = {
        /** While true no message arrives anywhere: two tabs cannot hear each other. */
        partitioned: false,
        /** While true messages wait, and arrive together when `releaseHeld()` is called: calls that cross in flight. */
        holding: false,
        held: [],
        releaseHeld() {
            hub.holding = false;
            hub.held.splice(0).forEach(deliver => deliver());
        },
        /** The channels in the order that tabs opened them. A muted channel posts nothing: its tab is frozen. */
        channels: [],
        create(name) {
            const listeners = new Set();
            const instance = {
                name,
                muted: false,
                postMessage(data) {
                    if (instance.muted || hub.partitioned) {
                        return;
                    }
                    for (const other of instances) {
                        if (other !== instance && other.name === name) {
                            const deliver = () => other.deliver(structuredClone(data));
                            if (hub.holding) {
                                hub.held.push(deliver);
                            } else {
                                queueMicrotask(deliver);
                            }
                        }
                    }
                },
                addEventListener(type, listener) {
                    listeners.add(listener);
                },
                deliver(data) {
                    listeners.forEach(listener => listener({ data }));
                },
                close() {
                    instances.delete(instance);
                    listeners.clear();
                },
            };
            instances.add(instance);
            hub.channels.push(instance);
            return instance;
        },
    };
    return hub;
}

let clock;
let hub;
let random;

beforeEach(() => {
    clock = createClock();
    hub = createChannelHub();
    random = 0;
});

function openTab({ locks = null, channels = true } = {}) {
    return createWorkerLock({
        getLocks: () => locks ?? undefined,
        createChannel: channels ? name => hub.create(name) : null,
        now: clock.now,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
        createId: () => `tab-${++random}`,
    });
}

describe('with Web Locks', () => {
    test('the first tab runs the worker and a second one waits', async () => {
        const locks = createFakeLocks();
        const first = openTab({ locks });
        const second = openTab({ locks });

        first.start();
        second.start();
        await flush();

        expect(first.mode).toBe('web-locks');
        expect(first.isLeader()).toBe(true);
        expect(second.isLeader()).toBe(false);
    });

    test('the waiting tab takes over when the first one stops', async () => {
        const locks = createFakeLocks();
        const first = openTab({ locks });
        const second = openTab({ locks });
        first.start();
        second.start();
        await flush();

        first.stop();
        await flush();

        expect(first.isLeader()).toBe(false);
        expect(second.isLeader()).toBe(true);
    });

    test('a tab that is hidden for good lets go of the lock, and asks for it again when it comes back', async () => {
        const locks = createFakeLocks();
        const first = openTab({ locks });
        const second = openTab({ locks });
        first.start();
        second.start();
        await flush();

        first.suspend();
        await flush();
        expect(second.isLeader()).toBe(true);
        expect(first.isLeader()).toBe(false);

        first.resume();
        await flush();
        expect(first.isLeader()).toBe(false);
        second.stop();
        await flush();
        expect(first.isLeader()).toBe(true);
    });

    test('a tab that stopped while it waited never becomes the leader afterwards', async () => {
        const locks = createFakeLocks();
        const first = openTab({ locks });
        const second = openTab({ locks });
        first.start();
        second.start();
        await flush();

        second.stop();
        first.stop();
        await flush();

        expect(second.isLeader()).toBe(false);
    });

    test('a page that is refused every lock falls back to the election', async () => {
        const locks = { request: () => Promise.reject(Object.assign(new Error('opaque origin'), { name: 'SecurityError' })) };
        const tab = openTab({ locks });

        tab.start();
        await flush();
        await clock.advance(1000);

        expect(tab.mode).toBe('election');
        expect(tab.isLeader()).toBe(true);
    });
});

describe('without Web Locks, which is a plain http address', () => {
    test('a lone tab becomes the leader once nobody answered its call', async () => {
        const tab = openTab();

        tab.start();
        expect(tab.isLeader()).toBe(false);
        await clock.advance(1000);

        expect(tab.mode).toBe('election');
        expect(tab.isLeader()).toBe(true);
    });

    test('a tab that opens while another one leads stays a follower', async () => {
        const first = openTab();
        first.start();
        await clock.advance(1000);
        const second = openTab();

        second.start();
        await clock.advance(1000);
        await clock.advance(60_000);

        expect(first.isLeader()).toBe(true);
        expect(second.isLeader()).toBe(false);
    });

    test('two tabs that open together agree on one leader, the one that started first', async () => {
        const first = openTab();
        const second = openTab();

        first.start();
        await clock.advance(50);
        second.start();
        await clock.advance(5000);

        expect([first.isLeader(), second.isLeader()]).toEqual([true, false]);
    });

    test('three tabs that open at the same moment still leave one leader', async () => {
        const tabs = [openTab(), openTab(), openTab()];

        tabs.forEach(tab => tab.start());
        await clock.advance(5000);
        await clock.advance(60_000);

        expect(tabs.filter(tab => tab.isLeader())).toHaveLength(1);
    });

    test('three tabs whose claims cross in flight leave the one that started first as the leader', async () => {
        const tabs = [openTab(), openTab(), openTab()];
        hub.holding = true;
        tabs.forEach((tab, index) => {
            tab.start();
            clock.advance(index);
        });
        await clock.advance(600);
        expect(hub.held.length).toBeGreaterThan(0);

        hub.releaseHeld();
        await clock.advance(5000);
        await clock.advance(60_000);

        expect(tabs.map(tab => tab.isLeader())).toEqual([true, false, false]);
    });

    test('a follower takes over at once when the leader says goodbye', async () => {
        const first = openTab();
        const second = openTab();
        first.start();
        await clock.advance(1000);
        second.start();
        await clock.advance(1000);

        first.stop();
        await clock.advance(1000);

        expect(first.isLeader()).toBe(false);
        expect(second.isLeader()).toBe(true);
    });

    test('a follower takes over when the leader goes quiet without a goodbye', async () => {
        const first = openTab();
        const second = openTab();
        first.start();
        await clock.advance(1000);
        second.start();
        await clock.advance(1000);

        // The leader's tab is frozen: it stops beating and says nothing, and its channel stays open.
        hub.channels[0].muted = true;
        await clock.advance(120_000);

        expect(second.isLeader()).toBe(true);
    });

    test('two leaders that meet again leave one: the one that started first keeps it', async () => {
        const first = openTab();
        const second = openTab();
        hub.partitioned = true;
        first.start();
        await clock.advance(50);
        second.start();
        await clock.advance(5000);
        expect([first.isLeader(), second.isLeader()]).toEqual([true, true]);

        hub.partitioned = false;
        await clock.advance(30_000);

        expect([first.isLeader(), second.isLeader()]).toEqual([true, false]);
    });

    test('a tab that stops no longer leads', async () => {
        const tab = openTab();
        tab.start();
        await clock.advance(1000);

        tab.stop();

        expect(tab.isLeader()).toBe(false);
    });
});

describe('where nothing can coordinate the tabs', () => {
    test('every tab runs the worker, as before', () => {
        const tab = openTab({ channels: false });

        tab.start();

        expect(tab.mode).toBe('none');
        expect(tab.isLeader()).toBe(true);
    });
});
