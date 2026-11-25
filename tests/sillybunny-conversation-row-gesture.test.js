import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const {
    DRAG_DISTANCE_PX,
    LIFT_DELAY_MS,
    SCROLL_CANCEL_DISTANCE_PX,
    createRowGesture,
} = await import('../public/scripts/sillybunny-conversation/conversation-list-gesture.js');

/** Timers that fire only when the test moves the clock. */
function createFakeTimers() {
    let now = 0;
    let nextId = 1;
    const pending = new Map();
    return {
        set: (callback, delay) => {
            const id = nextId++;
            pending.set(id, { callback, at: now + delay });
            return id;
        },
        clear: id => pending.delete(id),
        advance(ms) {
            now += ms;
            for (const [id, timer] of [...pending]) {
                if (timer.at <= now) {
                    pending.delete(id);
                    timer.callback();
                }
            }
        },
        get pending() {
            return pending.size;
        },
    };
}

let timers;
let on;

const start = (pointerType, x = 100, y = 100) => createRowGesture({ pointerType, x, y, timers, on });

beforeEach(() => {
    timers = createFakeTimers();
    on = { lift: jest.fn(), dragStart: jest.fn(), dragMove: jest.fn(), drop: jest.fn(), menu: jest.fn(), abort: jest.fn(), cancel: jest.fn() };
});

describe('a press with a mouse', () => {
    test('a move of up to the drag distance is still a click, so nothing is reported', () => {
        const gesture = start('mouse');

        gesture.move(100 + DRAG_DISTANCE_PX, 100);
        gesture.release(100 + DRAG_DISTANCE_PX, 100);

        expect(on.dragStart).not.toHaveBeenCalled();
        expect(on.drop).not.toHaveBeenCalled();
        expect(on.menu).not.toHaveBeenCalled();
        expect(gesture.phase).toBe('ended');
    });

    test('a move past the drag distance starts a drag at once, and the release drops where the pointer is', () => {
        const gesture = start('mouse');

        gesture.move(100, 100 + DRAG_DISTANCE_PX + 1);
        expect(on.dragStart).toHaveBeenCalledWith(100, 100 + DRAG_DISTANCE_PX + 1);
        expect(gesture.phase).toBe('dragging');
        gesture.move(100, 200);
        gesture.move(110, 240);
        gesture.release(110, 240);

        expect(on.dragMove).toHaveBeenCalledTimes(2);
        expect(on.dragMove).toHaveBeenLastCalledWith(110, 240);
        expect(on.drop).toHaveBeenCalledWith(110, 240);
        expect(gesture.phase).toBe('ended');
    });

    test('a pen presses as a mouse does', () => {
        const gesture = start('pen');

        gesture.move(100, 130);

        expect(on.dragStart).toHaveBeenCalledTimes(1);
    });

    test('Escape during a drag cancels it and the release afterwards drops nothing', () => {
        const gesture = start('mouse');
        gesture.move(100, 150);

        gesture.cancel();
        gesture.release(100, 150);

        expect(on.cancel).toHaveBeenCalledTimes(1);
        expect(on.drop).not.toHaveBeenCalled();
    });

    test('never lifts, because a mouse has no long press of its own', () => {
        start('mouse');

        timers.advance(LIFT_DELAY_MS * 3);

        expect(on.lift).not.toHaveBeenCalled();
        expect(timers.pending).toBe(0);
    });
});

describe('a press by touch', () => {
    test('a tap that ends before the lift reports nothing and leaves no timer behind', () => {
        const gesture = start('touch');
        timers.advance(LIFT_DELAY_MS - 1);

        gesture.release(100, 100);
        timers.advance(1000);

        expect(on.lift).not.toHaveBeenCalled();
        expect(on.menu).not.toHaveBeenCalled();
        expect(timers.pending).toBe(0);
    });

    test('a long press lifts the row, and a release without a move opens the menu where the finger was', () => {
        const gesture = start('touch');

        timers.advance(LIFT_DELAY_MS);
        expect(on.lift).toHaveBeenCalledTimes(1);
        expect(gesture.phase).toBe('lifted');
        gesture.release(101, 99);

        expect(on.menu).toHaveBeenCalledWith(101, 99);
        expect(on.drop).not.toHaveBeenCalled();
    });

    test('a small slip of the finger after the lift is not a move', () => {
        const gesture = start('touch');
        timers.advance(LIFT_DELAY_MS);

        gesture.move(100 + DRAG_DISTANCE_PX, 100);
        gesture.release(100 + DRAG_DISTANCE_PX, 100);

        expect(on.dragStart).not.toHaveBeenCalled();
        expect(on.menu).toHaveBeenCalledTimes(1);
    });

    test('a move after the lift drags the row, and the release drops it', () => {
        const gesture = start('touch');
        timers.advance(LIFT_DELAY_MS);

        gesture.move(100, 160);
        gesture.move(100, 220);
        gesture.release(100, 220);

        expect(on.dragStart).toHaveBeenCalledWith(100, 160);
        expect(on.dragMove).toHaveBeenCalledWith(100, 220);
        expect(on.drop).toHaveBeenCalledWith(100, 220);
        expect(on.menu).not.toHaveBeenCalled();
    });

    test('a move before the lift is a scroll: the press is given up and the lift never comes', () => {
        const gesture = start('touch');
        timers.advance(100);

        gesture.move(100, 100 + SCROLL_CANCEL_DISTANCE_PX + 1);
        timers.advance(LIFT_DELAY_MS);

        expect(on.abort).toHaveBeenCalledTimes(1);
        expect(on.lift).not.toHaveBeenCalled();
        expect(gesture.phase).toBe('ended');
        expect(timers.pending).toBe(0);
    });

    test('a slip before the lift that stays under the scroll distance keeps the press', () => {
        const gesture = start('touch');

        gesture.move(100 + SCROLL_CANCEL_DISTANCE_PX, 100);
        timers.advance(LIFT_DELAY_MS);

        expect(on.abort).not.toHaveBeenCalled();
        expect(on.lift).toHaveBeenCalledTimes(1);
    });

    test('a cancel by the browser after the lift ends the press without a menu', () => {
        const gesture = start('touch');
        timers.advance(LIFT_DELAY_MS);

        gesture.cancel();
        gesture.release(100, 100);

        expect(on.abort).toHaveBeenCalledTimes(1);
        expect(on.menu).not.toHaveBeenCalled();
    });

    test('a cancel during a drag reports the cancel, not an abort', () => {
        const gesture = start('touch');
        timers.advance(LIFT_DELAY_MS);
        gesture.move(100, 160);

        gesture.cancel();

        expect(on.cancel).toHaveBeenCalledTimes(1);
        expect(on.abort).not.toHaveBeenCalled();
    });

    test('a cancel before the lift clears the timer and reports nothing', () => {
        const gesture = start('touch');

        gesture.cancel();
        timers.advance(LIFT_DELAY_MS * 2);

        expect(on.lift).not.toHaveBeenCalled();
        expect(timers.pending).toBe(0);
    });
});
