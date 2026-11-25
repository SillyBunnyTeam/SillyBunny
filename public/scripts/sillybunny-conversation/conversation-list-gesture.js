/**
 * The press on a row of the conversation list, from the pointer going down to the pointer going up, with no DOM.
 *
 * A mouse or a pen drags once it has moved a few pixels. A finger cannot tell a scroll, a menu and a drag apart by
 * movement alone, so a touch waits: a move before the long press is a scroll and gives the press up; after
 * `LIFT_DELAY_MS` the row is lifted, and from then on a move drags it and a release without a move opens the row's
 * menu. The caller draws the lift, the ghost row and the drop ring, and decides what a drop means.
 */

export const LIFT_DELAY_MS = 380;
export const DRAG_DISTANCE_PX = 4;
export const SCROLL_CANCEL_DISTANCE_PX = 8;

/**
 * @typedef {object} RowGestureCallbacks
 * @property {() => void} lift The finger stayed down long enough: the row is lifted.
 * @property {(x: number, y: number) => void} dragStart
 * @property {(x: number, y: number) => void} dragMove
 * @property {(x: number, y: number) => void} drop The pointer went up while dragging.
 * @property {(x: number, y: number) => void} menu The finger went up on a lifted row that never moved.
 * @property {() => void} abort A press that never became a drag or a menu ended: a scroll began, or the browser took the touch back.
 * @property {() => void} cancel A drag was cancelled (Escape, or the browser took the pointer back).
 */

/**
 * @param {object} options
 * @param {string} options.pointerType `mouse`, `pen` or `touch`.
 * @param {number} options.x Where the pointer went down.
 * @param {number} options.y
 * @param {{ set: (callback: () => void, delay: number) => any, clear: (handle: any) => void }} [options.timers]
 * @param {boolean} [options.canDrag] False for a press that only opens a menu, such as the press on the heading of a folder:
 * a move after the lift gives the press up, and the release of a lifted press opens the menu.
 * @param {RowGestureCallbacks} options.on
 * @returns {{ move: (x: number, y: number) => void, release: (x: number, y: number) => void, cancel: () => void, readonly phase: 'pressed' | 'lifted' | 'dragging' | 'ended' }}
 */
export function createRowGesture({ pointerType, x, y, timers = { set: (callback, delay) => setTimeout(callback, delay), clear: handle => clearTimeout(handle) }, canDrag = true, on }) {
    const isTouch = pointerType === 'touch';
    let phase = 'pressed';
    let liftTimer = null;

    const distanceFromStart = (nowX, nowY) => Math.hypot(nowX - x, nowY - y);

    function stopLiftTimer() {
        if (liftTimer !== null) {
            timers.clear(liftTimer);
            liftTimer = null;
        }
    }

    function end() {
        stopLiftTimer();
        phase = 'ended';
    }

    if (isTouch) {
        liftTimer = timers.set(() => {
            liftTimer = null;
            if (phase === 'pressed') {
                phase = 'lifted';
                on.lift();
            }
        }, LIFT_DELAY_MS);
    }

    return {
        get phase() {
            return phase;
        },
        move(nowX, nowY) {
            if (phase === 'dragging') {
                on.dragMove(nowX, nowY);
                return;
            }
            if (phase === 'pressed' && isTouch) {
                if (distanceFromStart(nowX, nowY) > SCROLL_CANCEL_DISTANCE_PX) {
                    end();
                    on.abort();
                }
                return;
            }
            if (!canDrag && phase === 'lifted' && distanceFromStart(nowX, nowY) > DRAG_DISTANCE_PX) {
                end();
                on.abort();
                return;
            }
            if (canDrag && (phase === 'pressed' || phase === 'lifted') && distanceFromStart(nowX, nowY) > DRAG_DISTANCE_PX) {
                stopLiftTimer();
                phase = 'dragging';
                on.dragStart(nowX, nowY);
            }
        },
        release(nowX, nowY) {
            const before = phase;
            end();
            if (before === 'dragging') {
                on.drop(nowX, nowY);
            } else if (before === 'lifted') {
                on.menu(nowX, nowY);
            }
        },
        cancel() {
            const before = phase;
            end();
            if (before === 'dragging') {
                on.cancel();
            } else if (before === 'lifted') {
                on.abort();
            }
        },
    };
}
