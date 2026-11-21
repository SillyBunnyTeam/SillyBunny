/**
 * @jest-environment jsdom
 */
/* eslint-disable playwright/no-standalone-expect -- Jest contracts for a scheduler. */
import { describe, expect, jest, test } from '@jest/globals';
import { remountWhenIdle } from '../../public/scripts/sillybunny-home/assistants-refresh.js';

/** A schedule that holds its callbacks until the test runs them, so time is the test's. */
function createClock() {
    const waiting = [];
    return {
        schedule: jest.fn((callback, milliseconds) => { waiting.push({ callback, milliseconds }); }),
        tick() {
            const next = waiting.shift();
            next?.callback();
            return next?.milliseconds;
        },
        get pending() { return waiting.length; },
    };
}

function create({ stale = true, busy = false, connected = true } = {}) {
    const panel = document.createElement('div');
    if (connected) document.body.append(panel);
    const state = { stale, busy };
    const clock = createClock();
    const remount = jest.fn(() => { state.stale = false; });
    const run = () => remountWhenIdle({ panel, isStale: () => state.stale, isBusy: () => state.busy, remount, schedule: clock.schedule });
    return { panel, state, clock, remount, run };
}

describe('making the cards again', () => {
    test('happens at once when the status changed and nothing is open', () => {
        const world = create();

        world.run();

        expect(world.remount).toHaveBeenCalledTimes(1);
        expect(world.clock.pending).toBe(0);
    });

    test('does not happen when the status is what the cards were made from', () => {
        const world = create({ stale: false });

        world.run();

        expect(world.remount).not.toHaveBeenCalled();
        expect(world.clock.pending).toBe(0);
    });

    test('does not happen for a panel that a newer render replaced', () => {
        const world = create({ connected: false });

        world.run();

        expect(world.remount).not.toHaveBeenCalled();
        expect(world.clock.pending).toBe(0);
    });

    test('waits while a menu or a dialog is open, and happens once it is gone', () => {
        const world = create({ busy: true });
        world.run();
        expect(world.remount).not.toHaveBeenCalled();

        world.clock.tick();
        expect(world.remount).not.toHaveBeenCalled();
        world.state.busy = false;
        world.clock.tick();

        expect(world.remount).toHaveBeenCalledTimes(1);
        expect(world.clock.pending).toBe(0);
    });

    test('checks again at a short interval while the overlay stays open', () => {
        const world = create({ busy: true });

        world.run();

        expect(world.clock.schedule).toHaveBeenCalledWith(expect.any(Function), 250);
        expect(world.clock.pending).toBe(1);
    });

    test('stops waiting when a newer render replaced the panel meanwhile', () => {
        const world = create({ busy: true });
        world.run();

        world.panel.remove();
        world.clock.tick();

        expect(world.remount).not.toHaveBeenCalled();
        expect(world.clock.pending).toBe(0);
    });

    test('stops waiting when the status became current meanwhile', () => {
        const world = create({ busy: true });
        world.run();

        world.state.stale = false;
        world.clock.tick();

        expect(world.remount).not.toHaveBeenCalled();
        expect(world.clock.pending).toBe(0);
    });
});
