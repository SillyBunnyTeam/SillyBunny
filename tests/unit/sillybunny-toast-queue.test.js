/**
 * @jest-environment jsdom
 */
import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// The real jQuery and the real toastr run in jsdom, so the queue is tested against toastr's own timers and closures.
const libRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'lib');

let reducedMotion = false;
/** @type {{ element: HTMLElement, keyframes: Keyframe[], duration: number, finish: () => void }[]} */
let animations = [];
let toastr;
let toastQueue;

const shown = $toast => $toast[0].style.display !== 'none';
const queueState = () => {
    const { current, waiting } = toastQueue.getToastQueue();
    return { current, waiting };
};
/** The enter animations (they start from opacity 0) and the leave animations (they end at opacity 0). */
const enters = () => animations.filter(animation => animation.keyframes[0].opacity === 0);
const leaves = () => animations.filter(animation => animation.keyframes[1].opacity === 0);

async function finishAnimations() {
    const running = animations.filter(animation => !animation.done);
    for (const animation of running) {
        animation.finish();
    }
    for (let turn = 0; turn < 4; turn += 1) {
        await Promise.resolve();
    }
}

async function flush() {
    for (let turn = 0; turn < 4; turn += 1) {
        await Promise.resolve();
    }
}

async function advance(ms) {
    jest.advanceTimersByTime(ms);
    await flush();
}

beforeAll(async () => {
    window.matchMedia = () => ({ matches: reducedMotion });
    HTMLElement.prototype.animate = function (keyframes, options) {
        let resolve;
        const finished = new Promise((done) => {
            resolve = done;
        });
        const animation = {
            element: this,
            keyframes,
            duration: options.duration,
            done: false,
            finished,
            finish() {
                animation.done = true;
                resolve();
            },
            cancel() {
                animation.done = true;
            },
        };
        animations.push(animation);
        return animation;
    };
    window.eval(readFileSync(path.join(libRoot, 'jquery-3.5.1.min.js'), 'utf8'));
    window.eval(readFileSync(path.join(libRoot, 'toastr.min.js'), 'utf8'));
    toastr = window.toastr;
    toastQueue = await import('../../public/scripts/sillybunny-toast-motion.js');
    toastQueue.initializeToastMotion({ jQuery: window.jQuery, toastr });
    toastr.options = {
        positionClass: 'toast-top-center',
        showDuration: 300,
        hideDuration: 300,
        timeOut: 5000,
        extendedTimeOut: 5000,
        escapeHtml: true,
    };
});

beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] });
    reducedMotion = false;
    animations = [];
});

afterEach(async () => {
    toastr.clear(undefined, { force: true });
    await flush();
    toastr.remove();
    jest.clearAllTimers();
    jest.useRealTimers();
    toastQueue.resetToastQueue();
    document.body.innerHTML = '';
});

describe('the action class', () => {
    const marked = $toast => $toast[0].classList.contains(toastQueue.TOAST_ACTION_CLASS);
    const options = { escapeHtml: false, timeOut: 0, extendedTimeOut: 0 };

    test('is set on a toast with exactly one button, queued or not, and on no other toast', () => {
        expect(marked(toastr.info('<div>Removed <button type="button">Undo</button></div>', '', options))).toBe(true);
        expect(marked(toastr.info('<div><button>Restore</button><button>Discard</button></div>', '', options))).toBe(false);
        expect(marked(toastr.info('A plain toast', 'Plain', options))).toBe(false);
        expect(marked(toastr.info('<div>Queued <button type="button">Undo</button></div>', '', { ...options, timeOut: 5000 }))).toBe(true);
    });

    test('follows the content when a caller changes it after the toast is shown', async () => {
        const $toast = toastr.info('<div>Removed</div>', '', options);
        expect(marked($toast)).toBe(false);
        $toast.find('.toast-message').append('<button type="button">Undo</button>');
        await flush();
        expect(marked($toast)).toBe(true);
        $toast.find('.toast-message').append('<button type="button">Redo</button>');
        await flush();
        expect(marked($toast)).toBe(false);
    });
});

describe('the toast queue', () => {
    test('a second toast waits behind the first, and every call returns the toast element that toastr makes', () => {
        const first = toastr.info('first message', 'First');
        const second = toastr.success('second message', 'Second');
        const third = toastr.warning('third message');

        for (const $toast of [first, second, third]) {
            expect($toast.jquery).toBeTruthy();
            expect($toast.closest('#toast-container').length).toBe(1);
        }
        expect(second.find('.toast-title').text()).toBe('Second');
        expect(second.hasClass('toast-success')).toBe(true);
        expect(shown(first)).toBe(true);
        expect(shown(second)).toBe(false);
        expect(shown(third)).toBe(false);
        expect(queueState()).toEqual({ current: first[0], waiting: [second[0], third[0]] });
    });

    test('a waiting toast shows when the toast in front of it hides, and its own 5 seconds start then', async () => {
        const first = toastr.info('first');
        const second = toastr.info('second');
        const third = toastr.info('third');

        await advance(4999);
        expect(shown(second)).toBe(false);
        await advance(1);
        expect(first.hasClass('sb-toast-leaving')).toBe(true);
        expect(shown(second)).toBe(true);
        expect(shown(third)).toBe(false);
        await finishAnimations();
        expect(first.closest('body').length).toBe(0);

        // The second toast was created 5 seconds ago, but it only started to show now.
        await advance(4999);
        expect(second.closest('body').length).toBe(1);
        expect(shown(third)).toBe(false);
        await advance(1);
        expect(shown(third)).toBe(true);
        await finishAnimations();
        await advance(5000);
        await finishAnimations();
        expect(document.querySelectorAll('.toast').length).toBe(0);
    });

    test('a toast shows over 300ms, and over 500ms when it replaces a toast that is still leaving', async () => {
        toastr.info('first');
        toastr.info('second');
        expect(enters().map(animation => animation.duration)).toEqual([300]);

        await advance(5000);
        expect(leaves().map(animation => animation.duration)).toEqual([300]);
        expect(enters().map(animation => animation.duration)).toEqual([300, 500]);

        await finishAnimations();
        await advance(5000);
        await finishAnimations();
        toastr.info('later');
        expect(enters().at(-1).duration).toBe(300);
    });

    test('the toast that leaves is taken out of the flow where it is, so the one that replaces it does not move it', async () => {
        const first = toastr.info('first');
        toastr.info('second');
        await advance(5000);
        expect(first[0].style.position).toBe('absolute');
        expect(first[0].style.margin).toBe('0px');
    });

    test('a toast with a button shows at once, and the shown toast goes back to the head of the queue', async () => {
        const first = toastr.info('first');
        const second = toastr.info('second');
        const undo = toastr.info('<button type="button">Undo</button>', 'Deleted', { escapeHtml: false });

        expect(shown(undo)).toBe(true);
        expect(first[0].classList.contains('sb-toast-leaving')).toBe(true);
        expect(enters().at(-1).duration).toBe(500);
        await finishAnimations();
        expect(shown(first)).toBe(false);
        expect(queueState()).toEqual({ current: undo[0], waiting: [first[0], second[0]] });

        await advance(5000);
        await finishAnimations();
        expect(undo.closest('body').length).toBe(0);
        expect(shown(first)).toBe(true);
        expect(shown(second)).toBe(false);
        expect(queueState().current).toBe(first[0]);
        expect(first[0].style.position).toBe('');

        // The pushed back toast starts its 5 seconds again.
        await advance(4999);
        expect(shown(second)).toBe(false);
        await advance(1);
        expect(shown(second)).toBe(true);
    });

    test('a toast that asks for high priority, and one with a button in a node, are shown at once too', () => {
        toastr.info('first');
        const asked = toastr.info('asked', 'Priority', { priority: 'high' });
        expect(shown(asked)).toBe(true);

        const node = document.createElement('div');
        node.innerHTML = '<span>Removed</span> <button type="button">Undo</button>';
        const withNode = toastr.info(node, 'Node', { escapeHtml: false });
        expect(shown(withNode)).toBe(true);
        expect(asked[0].classList.contains('sb-toast-leaving')).toBe(true);

        const plain = toastr.info('<b>bold</b> text', 'Plain', { escapeHtml: false });
        expect(shown(plain)).toBe(false);
    });

    test('an escaped message that spells out a button is only text', () => {
        toastr.info('first');
        const text = toastr.info('<button>Undo</button>', 'Escaped');
        expect(shown(text)).toBe(false);
    });

    test('a toast that was shown before does not run onShown again when it comes back', async () => {
        const onShown = jest.fn();
        const first = toastr.info('first', '', { onShown });
        await finishAnimations();
        expect(onShown).toHaveBeenCalledTimes(1);
        expect(onShown.mock.contexts[0]).toBe(first[0]);
        toastr.info('<button>Undo</button>', '', { escapeHtml: false });
        await advance(5000);
        await finishAnimations();
        expect(shown(first)).toBe(true);
        expect(onShown).toHaveBeenCalledTimes(1);
    });

    test('onShown of a waiting toast runs when it shows, with the toast element as this', async () => {
        toastr.info('first');
        const onShown = jest.fn();
        const second = toastr.info('second', '', { onShown });
        expect(onShown).not.toHaveBeenCalled();
        await advance(5000);
        await finishAnimations();
        expect(onShown).toHaveBeenCalledTimes(1);
        expect(onShown.mock.contexts[0]).toBe(second[0]);
    });

    test('a toast that never times out is not queued and does not hold the queue', async () => {
        const progress = toastr.info('working', 'Please wait', { timeOut: 0, extendedTimeOut: 0 });
        const first = toastr.info('first');
        const second = toastr.info('second');
        expect(shown(progress)).toBe(true);
        expect(shown(first)).toBe(true);
        expect(shown(second)).toBe(false);

        const alsoSticky = toastr.error('failed', 'Sticky', { timeOut: 0, extendedTimeOut: 0 });
        expect(shown(alsoSticky)).toBe(true);
        expect(queueState()).toEqual({ current: first[0], waiting: [second[0]] });

        await advance(5000);
        expect(shown(second)).toBe(true);
        expect(shown(progress)).toBe(true);
    });

    test('an error goes ahead of the toasts that are not errors, and behind the errors that came before it', () => {
        const first = toastr.info('first');
        const info = toastr.info('info');
        const warning = toastr.warning('warning');
        const success = toastr.success('success');
        const firstError = toastr.error('first error');
        const secondError = toastr.error('second error');
        expect(queueState()).toEqual({
            current: first[0],
            waiting: [firstError[0], secondError[0], info[0], warning[0], success[0]],
        });
    });

    test('a long queue drops the oldest info or success toast, and never an error or a warning', () => {
        toastr.info('first');
        const notices = Array.from({ length: 8 }, (_, index) => toastr.info(`notice ${index}`));
        expect(queueState().waiting.length).toBe(6);
        expect(queueState().waiting[0]).toBe(notices[2][0]);
        expect(notices[0].closest('body').length).toBe(0);
        expect(notices[1].closest('body').length).toBe(0);

        const errors = Array.from({ length: 8 }, (_, index) => toastr.error(`error ${index}`));
        const waiting = queueState().waiting;
        for (const error of errors) {
            expect(waiting).toContain(error[0]);
        }
        expect(waiting.slice(0, 8)).toEqual(errors.map(error => error[0]));
    });

    test('an identical toast that waits is shown once', () => {
        toastr.info('first');
        const one = toastr.error('Could not save', 'Chat');
        const two = toastr.error('Could not save', 'Chat');
        const other = toastr.error('Could not save', 'Settings');
        expect(two[0]).toBe(one[0]);
        expect(other[0]).not.toBe(one[0]);
        expect(queueState().waiting.length).toBe(2);
    });

    test('the same toast again while it is on screen is not queued, and keeps it for another timeout', async () => {
        const first = toastr.error('Could not save', 'Chat');
        const second = toastr.info('another');
        await advance(4000);
        const again = toastr.error('Could not save', 'Chat');
        expect(again[0]).toBe(first[0]);
        expect(queueState()).toEqual({ current: first[0], waiting: [second[0]] });

        await advance(4999);
        expect(shown(second)).toBe(false);
        await advance(1);
        expect(shown(second)).toBe(true);
    });

    test('the same toast again while the shown one is hovered changes nothing, and the hover still lets it go', async () => {
        const first = toastr.error('Could not save', 'Chat');
        const second = toastr.info('another');
        first[0].matches = selector => selector === ':hover' || Element.prototype.matches.call(first[0], selector);
        first.trigger('mouseenter');
        await advance(6000);
        expect(toastr.error('Could not save', 'Chat')[0]).toBe(first[0]);
        await advance(20000);
        expect(shown(second)).toBe(false);
        delete first[0].matches;
        first.trigger('mouseleave');
        await advance(5000);
        expect(shown(second)).toBe(true);
    });

    test('toastr.clear() clears the waiting toasts without showing any of them', async () => {
        toastr.info('first');
        toastr.info('second');
        toastr.info('third');
        animations = [];
        toastr.clear();
        await flush();
        await finishAnimations();
        expect(enters()).toHaveLength(0);
        expect(document.querySelectorAll('.toast').length).toBe(0);
        expect(queueState()).toEqual({ current: null, waiting: [] });
    });

    test('clearing a waiting toast on its own removes it, and the queue goes on', async () => {
        const first = toastr.info('first');
        const second = toastr.info('second');
        const third = toastr.info('third');
        toastr.clear(second);
        await flush();
        expect(second.closest('body').length).toBe(0);
        expect(queueState()).toEqual({ current: first[0], waiting: [third[0]] });
    });

    test('tapping the shown toast hides it and shows the next one', async () => {
        const first = toastr.info('first');
        const second = toastr.info('second');
        first.trigger('click');
        await flush();
        expect(first.hasClass('sb-toast-leaving')).toBe(true);
        expect(shown(second)).toBe(true);
    });

    test('a toast that is hovered stays, and the next one keeps waiting', async () => {
        const first = toastr.info('first');
        const second = toastr.info('second');
        first.trigger('mouseenter');
        await advance(20000);
        expect(shown(first)).toBe(true);
        expect(shown(second)).toBe(false);
        first.trigger('mouseleave');
        await advance(5000);
        expect(shown(second)).toBe(true);
    });

    test('a toast with a button that is pressed on touch stays while the press lasts, and the next one keeps waiting', async () => {
        const press = (type, target, pointerType = 'touch') => {
            const event = new Event(type, { bubbles: true });
            Object.defineProperty(event, 'pointerType', { value: pointerType });
            target.dispatchEvent(event);
        };
        const message = document.createElement('div');
        const action = document.createElement('button');
        message.append(action);
        const first = toastr.info(message, '', { escapeHtml: false });
        const second = toastr.info('second');

        press('pointerdown', action);
        await advance(20000);
        expect(shown(first)).toBe(true);
        expect(shown(second)).toBe(false);

        press('pointerup', action);
        await advance(5000);
        expect(shown(second)).toBe(true);
    });

    test('a press with a mouse changes nothing: the pointer on the toast already holds it', async () => {
        const first = toastr.info('first');
        toastr.info('second');
        const event = new Event('pointerdown', { bubbles: true });
        Object.defineProperty(event, 'pointerType', { value: 'mouse' });
        first[0].dispatchEvent(event);
        await advance(5000);
        expect(first.hasClass('sb-toast-leaving')).toBe(true);
    });

    test('toastr keeps its answers: preventDuplicates returns nothing and the app listener still hears every toast', () => {
        const events = [];
        toastr.subscribe(args => events.push([args.state, args.map.message]));
        toastr.info('first');
        toastr.info('queued');
        expect(toastr.error('same', '', { preventDuplicates: true })).toBeTruthy();
        expect(toastr.error('same', '', { preventDuplicates: true })).toBeUndefined();
        expect(events.filter(([state]) => state === 'visible').map(([, message]) => message)).toEqual(['first', 'queued', 'same']);
    });

    test('with reduced motion a toast shows at once when the one in front of it hides', async () => {
        reducedMotion = true;
        const first = toastr.info('first');
        const second = toastr.info('second');
        await advance(5000);
        expect(first.closest('body').length).toBe(0);
        expect(shown(second)).toBe(true);
        expect(animations).toHaveLength(0);
    });
});
