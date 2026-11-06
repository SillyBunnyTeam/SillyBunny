/* eslint-disable playwright/no-standalone-expect -- Jest contracts for a plain function. */
import { describe, expect, jest, test } from '@jest/globals';
import { createMoveRunner } from '../../public/scripts/sillybunny-help/move-runner.js';

/** A load that stays pending until the test settles it. */
function createPendingLoad() {
    let finish;
    const promise = new Promise((resolve) => { finish = resolve; });
    return { promise, finish };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('the runner of Help moves', () => {
    test('runs a move at once when its page has nothing to load', () => {
        const dialog = { isOpen: true };
        const run = createMoveRunner({ isOpen: () => dialog.isOpen, load: () => null });
        const move = jest.fn();

        run('page', move);

        expect(move).toHaveBeenCalledTimes(1);
    });

    test('runs a move after its page has loaded, and not before', async () => {
        const dialog = { isOpen: true };
        const pending = createPendingLoad();
        const run = createMoveRunner({ isOpen: () => dialog.isOpen, load: () => pending.promise });
        const move = jest.fn();

        run('page', move);
        await flush();
        expect(move).not.toHaveBeenCalled();

        pending.finish();
        await flush();
        expect(move).toHaveBeenCalledTimes(1);
    });

    test('drops a move whose window closed while the page loaded', async () => {
        const dialog = { isOpen: true };
        const pending = createPendingLoad();
        const run = createMoveRunner({ isOpen: () => dialog.isOpen, load: () => pending.promise });
        const move = jest.fn();

        run('page', move);
        dialog.isOpen = false;
        pending.finish();
        await flush();

        expect(move).not.toHaveBeenCalled();
    });

    test('drops a move that a later move overtook, whichever page loads last', async () => {
        const dialog = { isOpen: true };
        const first = createPendingLoad();
        const second = createPendingLoad();
        const loads = { first: first.promise, second: second.promise };
        const run = createMoveRunner({ isOpen: () => dialog.isOpen, load: target => loads[target] });
        const firstMove = jest.fn();
        const secondMove = jest.fn();

        run('first', firstMove);
        run('second', secondMove);
        second.finish();
        await flush();
        first.finish();
        await flush();

        expect(secondMove).toHaveBeenCalledTimes(1);
        expect(firstMove).not.toHaveBeenCalled();
    });

    test('drops a move that a later move with nothing to load overtook', async () => {
        const dialog = { isOpen: true };
        const pending = createPendingLoad();
        const run = createMoveRunner({ isOpen: () => dialog.isOpen, load: target => (target === 'slow' ? pending.promise : null) });
        const slowMove = jest.fn();
        const quickMove = jest.fn();

        run('slow', slowMove);
        run('quick', quickMove);
        pending.finish();
        await flush();

        expect(quickMove).toHaveBeenCalledTimes(1);
        expect(slowMove).not.toHaveBeenCalled();
    });
});
