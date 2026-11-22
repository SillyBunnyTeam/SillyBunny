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
let toastForm;
let measured = { width: 0, em: 16 };

const shown = $toast => $toast[0].style.display !== 'none';
const queueState = () => {
    const { current, waiting } = toastQueue.getToastQueue();
    return { current, waiting };
};
const notificationState = () => {
    const { shown: onScreen, waiting } = toastQueue.getNotificationQueue();
    return { shown: onScreen, waiting };
};
const inOverlay = $toast => $toast.closest('#sb-toast-overlay').length === 1;
const inNotifications = $toast => $toast.closest('#toast-container').length === 1;
/** A message with a title is an in-app notification, so these tests make notifications with a title. */
const notice = (type, name, options) => toastr[type](`${name} message`, name, options);
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
            pause() {
                animation.paused = true;
            },
        };
        animations.push(animation);
        return animation;
    };
    window.eval(readFileSync(path.join(libRoot, 'jquery-3.5.1.min.js'), 'utf8'));
    window.eval(readFileSync(path.join(libRoot, 'toastr.min.js'), 'utf8'));
    toastr = window.toastr;
    toastQueue = await import('../../public/scripts/sillybunny-toast-motion.js');
    toastForm = await import('../../public/scripts/sillybunny-toast-form.js');
    // jsdom has no layout, so the width rule reads whatever the test sets here.
    toastQueue.initializeToastMotion({ jQuery: window.jQuery, toastr, measure: () => measured });
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
    measured = { width: 0, em: 16 };
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

    test('is not set on a toast whose message lays out several text blocks beside its button', () => {
        expect(marked(toastr.info('<div class="sbHomeToast"><div>Well done.</div><div>Next is Start Chatting.</div><button type="button">Show Me</button></div>', 'Get a Character Card', options))).toBe(false);
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
        const first = toastr.info('first message');
        const second = toastr.success('second message');
        const third = toastr.warning('third message');

        for (const $toast of [first, second, third]) {
            expect($toast.jquery).toBeTruthy();
            expect(inOverlay($toast)).toBe(true);
        }
        expect(second.find('.toast-message').text()).toBe('second message');
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
        const undo = toastr.info('<button type="button">Undo</button>', '', { escapeHtml: false });

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
        const asked = toastr.info('asked', '', { priority: 'high' });
        expect(shown(asked)).toBe(true);

        const node = document.createElement('div');
        node.innerHTML = '<span>Removed</span> <button type="button">Undo</button>';
        const withNode = toastr.info(node, '', { escapeHtml: false });
        expect(shown(withNode)).toBe(true);
        expect(asked[0].classList.contains('sb-toast-leaving')).toBe(true);

        const plain = toastr.info('<b>bold</b> text', '', { escapeHtml: false });
        expect(shown(plain)).toBe(false);
    });

    test('an escaped message that spells out a button is only text', () => {
        toastr.info('first');
        const text = toastr.info('<button>Undo</button>');
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
        const one = toastr.error('Could not save the chat');
        const two = toastr.error('Could not save the chat');
        const other = toastr.error('Could not save the settings');
        expect(two[0]).toBe(one[0]);
        expect(other[0]).not.toBe(one[0]);
        expect(queueState().waiting.length).toBe(2);
    });

    test('the same toast again while it is on screen is not queued, and keeps it for another timeout', async () => {
        const first = toastr.error('Could not save the chat');
        const second = toastr.info('another');
        await advance(4000);
        const again = toastr.error('Could not save the chat');
        expect(again[0]).toBe(first[0]);
        expect(queueState()).toEqual({ current: first[0], waiting: [second[0]] });

        await advance(4999);
        expect(shown(second)).toBe(false);
        await advance(1);
        expect(shown(second)).toBe(true);
    });

    test('the same toast again while the shown one is hovered changes nothing, and the hover still lets it go', async () => {
        const first = toastr.error('Could not save the chat');
        const second = toastr.info('another');
        first[0].matches = selector => selector === ':hover' || Element.prototype.matches.call(first[0], selector);
        first.trigger('mouseenter');
        await advance(6000);
        expect(toastr.error('Could not save the chat')[0]).toBe(first[0]);
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

describe('the two queues', () => {
    const overlay = () => document.getElementById('sb-toast-overlay');
    const notificationContainer = () => document.getElementById('toast-container');
    const leavingOrGone = $toast => !$toast[0].isConnected || $toast[0].classList.contains('sb-toast-leaving');

    afterEach(() => {
        toastQueue.setToastPosition('toast-bottom-center');
        toastQueue.setNotificationPosition('toast-top-center');
        toastr.subscribe(() => {});
    });

    test('a toast and a notification show at once, each in its container with its marker class and position class', () => {
        const toast = toastr.info('Saved');
        const notification = toastr.info('Saved the chat', 'Chat');

        expect(shown(toast)).toBe(true);
        expect(shown(notification)).toBe(true);
        expect(inOverlay(toast)).toBe(true);
        expect(toast[0].classList.contains(toastForm.TOAST_FORM_CLASS)).toBe(true);
        expect(toast[0].classList.contains(toastForm.NOTIFICATION_FORM_CLASS)).toBe(false);
        expect(overlay().className).toBe('toast-bottom-center');
        expect(inNotifications(notification)).toBe(true);
        expect(notification[0].classList.contains(toastForm.NOTIFICATION_FORM_CLASS)).toBe(true);
        expect(notification[0].classList.contains(toastForm.TOAST_FORM_CLASS)).toBe(false);
        expect(notificationContainer().classList.contains('toast-top-center')).toBe(true);
        expect(notificationContainer().contains(toast[0])).toBe(false);
        expect(queueState()).toEqual({ current: toast[0], waiting: [] });
        expect(notificationState()).toEqual({ shown: [notification[0]], waiting: [] });
    });

    test('both forms keep toastr\'s class names and content', () => {
        const toast = toastr.error('Could not save');
        const notification = toastr.success('Saved the chat', 'Chat');
        expect(toast.hasClass('toast') && toast.hasClass('toast-error')).toBe(true);
        expect(toast.find('.toast-message').text()).toBe('Could not save');
        expect(notification.hasClass('toast') && notification.hasClass('toast-success')).toBe(true);
        expect(notification.find('.toast-title').text()).toBe('Chat');
        expect(notification.find('.toast-message').text()).toBe('Saved the chat');
    });

    test('three notifications show at once, and a fourth waits and shows when one is dismissed', async () => {
        const [a, b, c, d] = ['A', 'B', 'C', 'D'].map(name => notice('info', name));
        expect([a, b, c].map(shown)).toEqual([true, true, true]);
        expect(shown(d)).toBe(false);
        expect(notificationState()).toEqual({ shown: [a[0], b[0], c[0]], waiting: [d[0]] });

        toastr.clear(b);
        await flush();
        expect(shown(d)).toBe(true);
        expect(notificationState()).toEqual({ shown: [a[0], c[0], d[0]], waiting: [] });
    });

    test('an error and a warning stay until they are dismissed: no timer, and none after a hover and a leave', async () => {
        const error = notice('error', 'Failed');
        const warning = notice('warning', 'Careful');
        await advance(60000);
        expect(leavingOrGone(error) || leavingOrGone(warning)).toBe(false);

        error.trigger('mouseenter');
        error.trigger('mouseleave');
        warning.trigger('mouseenter');
        warning.trigger('mouseleave');
        await advance(60000);
        expect(leavingOrGone(error) || leavingOrGone(warning)).toBe(false);

        toastr.clear(error);
        await finishAnimations();
        expect(error[0].isConnected).toBe(false);
    });

    test('an info and a success notification leave after 4 seconds, and a global timeout is not the caller\'s', async () => {
        toastr.options = { ...toastr.options, timeOut: 9000, extendedTimeOut: 9000 };
        const info = notice('info', 'Note');
        const success = notice('success', 'Done');
        await advance(3999);
        expect(leavingOrGone(info) || leavingOrGone(success)).toBe(false);
        await advance(1);
        expect(leavingOrGone(info) && leavingOrGone(success)).toBe(true);
        toastr.options = { ...toastr.options, timeOut: 5000, extendedTimeOut: 5000 };
    });

    test('a timeout of the caller replaces the default of a notification, and so does its extended timeout', async () => {
        const error = notice('error', 'Failed', { timeOut: 2000, extendedTimeOut: 1000 });
        await advance(1999);
        expect(leavingOrGone(error)).toBe(false);
        await advance(1);
        expect(leavingOrGone(error)).toBe(true);

        const info = notice('info', 'Note', { timeOut: 9000, extendedTimeOut: 1500 });
        await advance(8999);
        expect(leavingOrGone(info)).toBe(false);
        await advance(1);
        expect(leavingOrGone(info)).toBe(true);

        const held = notice('success', 'Held', { timeOut: 9000, extendedTimeOut: 1500 });
        held.trigger('mouseenter');
        await advance(30000);
        expect(leavingOrGone(held)).toBe(false);
        held.trigger('mouseleave');
        await advance(1499);
        expect(leavingOrGone(held)).toBe(false);
        await advance(1);
        expect(leavingOrGone(held)).toBe(true);
    });

    test('a toast takes the timeout of the call or the global 5 seconds, whatever the status', async () => {
        const error = toastr.error('Could not save');
        const custom = toastr.info('Custom', '', { timeOut: 1000, extendedTimeOut: 1000 });
        await advance(5000);
        expect(leavingOrGone(error)).toBe(true);
        await finishAnimations();
        expect(shown(custom)).toBe(true);
        await advance(1000);
        expect(leavingOrGone(custom)).toBe(true);
    });

    test('a repeat collapses into a notification that is shown or waits, and into a toast that waits', () => {
        const [a, , , d] = ['A', 'B', 'C', 'D'].map(name => notice('info', name));
        expect(notice('info', 'D')[0]).toBe(d[0]);
        expect(notice('info', 'A')[0]).toBe(a[0]);
        expect(notificationState().waiting).toEqual([d[0]]);

        toastr.info('first');
        const second = toastr.info('second');
        expect(toastr.info('second')[0]).toBe(second[0]);
        expect(queueState().waiting).toEqual([second[0]]);
    });

    test('a high-priority notification shows at once and pushes back the oldest one that is not high priority', () => {
        const [a, b, c] = ['A', 'B', 'C'].map(name => notice('info', name));
        const waiting = notice('info', 'W');
        const urgent = notice('info', 'U', { priority: 'high' });

        expect(shown(urgent)).toBe(true);
        expect(a[0].classList.contains('sb-toast-leaving')).toBe(true);
        expect(notificationState()).toEqual({ shown: [b[0], c[0], urgent[0]], waiting: [a[0], waiting[0]] });
    });

    test('when every notification on screen is high priority, a fourth one shows as well', () => {
        const high = ['A', 'B', 'C', 'D'].map(name => notice('info', name, { priority: 'high' }));
        expect(high.map(shown)).toEqual([true, true, true, true]);
        expect(notificationState().shown).toEqual(high.map($toast => $toast[0]));
        expect(notificationState().waiting).toEqual([]);
    });

    test('a high-priority toast pushes back the shown toast and leaves the notifications alone', () => {
        const notification = notice('info', 'Note');
        const first = toastr.info('first');
        const undo = toastr.info('<button type="button">Undo</button>', '', { escapeHtml: false });
        expect(shown(undo)).toBe(true);
        expect(first[0].classList.contains('sb-toast-leaving')).toBe(true);
        expect(notification[0].classList.contains('sb-toast-leaving')).toBe(false);
        expect(queueState()).toEqual({ current: undo[0], waiting: [first[0]] });
    });

    test('a notification with a timeout of 0 from the caller shows at once whatever is on screen, and takes no place', async () => {
        const staying = ['A', 'B', 'C', 'D'].map(name => notice('info', name, { timeOut: 0, extendedTimeOut: 0 }));
        expect(staying.map(shown)).toEqual([true, true, true, true]);
        expect(notificationState()).toEqual({ shown: [], waiting: [] });

        const next = ['E', 'F', 'G'].map(name => notice('info', name));
        expect(next.map(shown)).toEqual([true, true, true]);
        expect(notificationState().shown).toEqual(next.map($toast => $toast[0]));
        const waiting = notice('info', 'H');
        expect(shown(waiting)).toBe(false);

        toastr.clear(staying[0]);
        await flush();
        expect(shown(waiting)).toBe(false);
    });

    test('three progress notifications on screen do not hold a titled error back', () => {
        const progress = ['A', 'B', 'C'].map(name => notice('info', name, { timeOut: 0, extendedTimeOut: 0 }));
        const error = notice('error', 'Failed');
        expect(progress.map(shown)).toEqual([true, true, true]);
        expect(shown(error)).toBe(true);
        expect(notificationState()).toEqual({ shown: [error[0]], waiting: [] });
    });

    test('three errors that stay fill the places, a fourth error waits, and a progress notification still shows at once', () => {
        const errors = ['A', 'B', 'C'].map(name => notice('error', name));
        const fourth = notice('error', 'D');
        const progress = notice('info', 'Working', { timeOut: 0, extendedTimeOut: 0 });
        expect(errors.map(shown)).toEqual([true, true, true]);
        expect(shown(fourth)).toBe(false);
        expect(shown(progress)).toBe(true);
        expect(notificationState()).toEqual({ shown: errors.map($toast => $toast[0]), waiting: [fourth[0]] });
    });

    test('a high-priority notification never pushes back one that the caller made to stay', () => {
        const staying = notice('info', 'Working', { timeOut: 0, extendedTimeOut: 0 });
        const [a, b, c] = ['A', 'B', 'C'].map(name => notice('info', name));
        const urgent = notice('info', 'Urgent', { priority: 'high' });
        expect(staying[0].classList.contains('sb-toast-leaving')).toBe(false);
        expect(a[0].classList.contains('sb-toast-leaving')).toBe(true);
        expect(notificationState()).toEqual({ shown: [b[0], c[0], urgent[0]], waiting: [a[0]] });
    });

    test('a toast with a timeout of 0 does not take the place of the toast queue', () => {
        const progress = toastr.info('Working', '', { timeOut: 0, extendedTimeOut: 0 });
        const first = toastr.info('first');
        expect(shown(progress) && shown(first)).toBe(true);
        expect(queueState()).toEqual({ current: first[0], waiting: [] });
    });

    test('a toast that a class hides is shown outside the queue with its own timer and takes no place', async () => {
        const style = document.createElement('style');
        style.textContent = '.displayNone { display: none !important; }';
        document.head.append(style);
        try {
            const hidden = toastr.info('Moving entries', '', { toastClass: 'displayNone', timeOut: 3000, extendedTimeOut: 3000 });
            const real = toastr.info('A real message');
            expect(shown(real)).toBe(true);
            expect(queueState()).toEqual({ current: real[0], waiting: [] });
            expect(hidden[0].classList.contains('displayNone')).toBe(true);

            await advance(3000);
            expect(hidden[0].classList.contains('sb-toast-leaving')).toBe(true);
            expect(real[0].classList.contains('sb-toast-leaving')).toBe(false);
            const another = toastr.info('Another real message');
            expect(shown(another)).toBe(false);
        } finally {
            style.remove();
        }
    });

    test('toastr.clear() and toastr.remove() without a toast reach both containers', async () => {
        toastr.info('A toast');
        notice('info', 'Note');
        toastr.clear();
        await flush();
        await finishAnimations();
        await flush();
        expect(document.querySelectorAll('.toast').length).toBe(0);
        expect(overlay()).toBeNull();
        expect(notificationContainer()).toBeNull();

        toastr.info('A toast');
        notice('info', 'Note');
        toastr.remove();
        await flush();
        expect(document.querySelectorAll('.toast').length).toBe(0);
        expect(overlay()).toBeNull();
        expect(notificationContainer()).toBeNull();
    });

    test('toastr.clear() and toastr.remove() with a toast act on that toast wherever it is', async () => {
        const toast = toastr.info('A toast');
        const notification = notice('info', 'Note');
        toastr.clear(toast);
        await finishAnimations();
        expect(toast[0].isConnected).toBe(false);
        expect(notification[0].isConnected).toBe(true);

        toastr.remove(notification);
        expect(notification[0].isConnected).toBe(false);
        await flush();
        expect(overlay()).toBeNull();
        expect(notificationContainer()).toBeNull();
    });

    test('waiting toasts leave their queue when they are cleared or removed', async () => {
        toastr.info('first');
        const second = toastr.info('second');
        const third = toastr.info('third');
        toastr.remove(second);
        toastr.clear(third);
        await flush();
        expect(queueState().waiting).toEqual([]);
        notice('info', 'A');
        notice('info', 'B');
        notice('info', 'C');
        const waiting = notice('info', 'D');
        toastr.remove(waiting);
        await flush();
        expect(notificationState().waiting).toEqual([]);
    });

    test('an empty overlay is removed, and the toast container goes when the last notification has gone', async () => {
        const toast = toastr.info('A toast');
        expect(overlay()).not.toBeNull();
        expect(notificationContainer()).toBeNull();
        toast.remove();
        await flush();
        expect(overlay()).toBeNull();

        const notification = notice('info', 'Note');
        expect(overlay()).toBeNull();
        expect(notificationContainer()).not.toBeNull();
        notification.remove();
        await flush();
        expect(notificationContainer()).toBeNull();
    });

    test('a position class, container id or target of a call or of the global options does not move or merge the containers', () => {
        const options = { positionClass: 'toast-bottom-left', containerId: 'my-container', target: '#nowhere' };
        const check = (toast, notification) => {
            expect(inOverlay(toast)).toBe(true);
            expect(inNotifications(notification)).toBe(true);
            expect(overlay().className).toBe('toast-bottom-center');
            expect(notificationContainer().className).toBe('toast-top-center');
            expect(document.getElementById('my-container')).toBeNull();
            expect(document.getElementById('global-container')).toBeNull();
        };
        check(toastr.info('A toast', '', options), toastr.info('A notice', 'Notice', options));

        toastr.clear(undefined, { force: true });
        toastr.remove();
        const saved = toastr.options;
        toastr.options = { ...saved, containerId: 'global-container', positionClass: 'toast-bottom-right', target: '#nowhere' };
        try {
            check(toastr.info('Another toast'), toastr.info('Another notice', 'Notice'));
        } finally {
            toastr.options = saved;
        }
    });

    test('the call returns toastr\'s element at once, and it is in #toast-container while the subscriber runs', () => {
        const seen = [];
        toastr.subscribe((args) => {
            if (args.state === 'visible') {
                seen.push([...document.querySelectorAll('#toast-container > .toast')]);
            }
        });
        const toast = toastr.info('A toast');
        const notification = toastr.info('A notice', 'Notice');

        expect(toast.jquery).toBeTruthy();
        expect(seen[0]).toEqual([toast[0]]);
        expect(seen[1]).toEqual([notification[0]]);
        expect(inOverlay(toast)).toBe(true);
    });

    test('a wrapper that an extension installs afterwards and that returns null breaks nothing', () => {
        const inner = toastr.info;
        toastr.info = (...args) => {
            inner(...args);
            return null;
        };
        try {
            expect(toastr.info('first')).toBeNull();
            expect(toastr.info('second')).toBeNull();
            expect(toastr.info('A notice', 'Notice')).toBeNull();
        } finally {
            toastr.info = inner;
        }
        expect(queueState().current).not.toBeNull();
        expect(queueState().waiting).toHaveLength(1);
        expect(notificationState().shown).toHaveLength(1);
    });

    test('a toast with a title, a click action or two buttons is a notification', () => {
        expect(inNotifications(toastr.info('Message', 'Title'))).toBe(true);
        expect(inNotifications(toastr.info('Message', '', { onclick: () => {} }))).toBe(true);
        expect(inNotifications(toastr.info('<button>A</button><button>B</button>', '', { escapeHtml: false }))).toBe(true);
        expect(inOverlay(toastr.info('Message', ''))).toBe(true);
        expect(inOverlay(toastr.info('Message', undefined, { onclick: undefined }))).toBe(true);
    });

    test('the width rule reads the toast\'s own measure, and 34em itself is still a toast', () => {
        measured = { width: toastForm.TOAST_MAX_WIDTH_EM * 16 + 1, em: 16 };
        expect(inNotifications(toastr.info('A long message'))).toBe(true);
        measured = { width: toastForm.TOAST_MAX_WIDTH_EM * 16, em: 16 };
        expect(inOverlay(toastr.info('A message of the limit'))).toBe(true);
    });

    test('a toast that cannot be classified is a notification, and the call still returns its element', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        measured = null;
        const $toast = toastr.info('A message');
        warn.mockRestore();
        expect($toast.jquery).toBeTruthy();
        expect(inNotifications($toast)).toBe(true);
        expect($toast[0].classList.contains(toastForm.NOTIFICATION_FORM_CLASS)).toBe(true);
    });

    test('a toast keeps its form when its text grows after it is shown', async () => {
        const toast = toastr.info('Working', '', { timeOut: 0, extendedTimeOut: 0 });
        toast.find('.toast-message').text('x'.repeat(2000));
        measured = { width: 100000, em: 16 };
        await flush();
        expect(inOverlay(toast)).toBe(true);
        expect(toast[0].classList.contains(toastForm.TOAST_FORM_CLASS)).toBe(true);
    });

    test('the notification queue keeps the rules of the toast queue: errors first, six waiting, a hover holds', async () => {
        const shownNotifications = ['A', 'B', 'C'].map(name => notice('info', name));
        const infos = Array.from({ length: 8 }, (_, index) => notice('info', `Info ${index}`));
        expect(notificationState().waiting).toHaveLength(6);
        expect(notificationState().waiting[0]).toBe(infos[2][0]);

        const error = notice('error', 'Failed');
        expect(notificationState().waiting[0]).toBe(error[0]);

        shownNotifications[0].trigger('mouseenter');
        await advance(20000);
        expect(shown(shownNotifications[0])).toBe(true);
        expect(leavingOrGone(shownNotifications[1])).toBe(true);
    });

    test('the position setters accept toastr\'s six classes, refuse others, and move an existing container', () => {
        toastr.info('A toast');
        notice('info', 'Note');

        expect(toastQueue.setToastPosition('toast-top-right')).toBe(true);
        expect(overlay().className).toBe('toast-top-right');
        expect(toastQueue.setToastPosition('toast-middle')).toBe(false);
        expect(overlay().className).toBe('toast-top-right');

        expect(toastQueue.setNotificationPosition('toast-bottom-left')).toBe(true);
        expect(notificationContainer().className).toBe('toast-bottom-left');
        expect(toastQueue.setNotificationPosition('toast-top-full-width')).toBe(false);
        expect(toastQueue.getNotificationPosition()).toBe('toast-bottom-left');
    });

    test('placeToastContainers moves both containers into the top open modal dialog, back to the body, and drops them when empty', async () => {
        const toast = toastr.info('A toast');
        const dialog = document.createElement('dialog');
        dialog.setAttribute('open', '');
        dialog.setAttribute('data-sb-modal', '');
        document.body.append(dialog);
        toastQueue.placeToastContainers();
        expect(overlay().parentElement).toBe(dialog);

        const inside = toastr.info('Another toast in the dialog');
        expect(inside.closest('#sb-toast-overlay').length).toBe(1);
        expect(overlay().parentElement).toBe(dialog);

        // A Popup is marked closing before it is removed, and fixToastrForDialogs() runs in between.
        dialog.setAttribute('closing', '');
        toastQueue.placeToastContainers();
        expect(overlay().parentElement).toBe(document.body);
        dialog.remove();

        toastr.remove(toast);
        toastr.remove(inside);
        toastQueue.placeToastContainers();
        expect(overlay()).toBeNull();
    });

    test('a toast made while a dialog is open lands in the overlay inside that dialog', () => {
        const dialog = document.createElement('dialog');
        dialog.setAttribute('open', '');
        dialog.setAttribute('data-sb-modal', '');
        document.body.append(dialog);
        const toast = toastr.info('A toast');
        expect(overlay().parentElement).toBe(dialog);
        expect(inOverlay(toast)).toBe(true);
    });

    test('newestOnTop decides where in the overlay a toast goes', () => {
        const saved = toastr.options;
        toastr.options = { ...saved, newestOnTop: false };
        try {
            const first = toastr.info('first');
            const second = toastr.info('second');
            const third = toastr.info('third');
            expect([...overlay().children]).toEqual([first[0], second[0], third[0]]);
        } finally {
            toastr.options = saved;
        }
        toastr.clear(undefined, { force: true });
        toastr.remove();
        const first = toastr.info('first');
        const second = toastr.info('second');
        expect([...overlay().children]).toEqual([second[0], first[0]]);
    });
});

describe('the progress bar', () => {
    const bars = () => animations.filter(animation => animation.keyframes[0].width === '100%');
    const withBar = { progressBar: true };

    test('runs down over the timeout of a toast that shows, because toastr only starts it for a toast with a timeout', () => {
        const toast = toastr.info('Saved', '', withBar);
        expect(toast.find('.toast-progress')).toHaveLength(1);
        expect(bars().map(animation => [animation.element, animation.duration, animation.keyframes[1].width]))
            .toEqual([[toast.find('.toast-progress')[0], 5000, '0%']]);
    });

    test('starts when a toast that waited shows, and over the 4 seconds of a notification', async () => {
        toastr.info('first');
        const second = toastr.info('second', '', withBar);
        expect(bars()).toHaveLength(0);
        await advance(5000);
        expect(bars().map(animation => [animation.element, animation.duration])).toEqual([[second.find('.toast-progress')[0], 5000]]);

        animations = [];
        const notification = notice('info', 'Note', withBar);
        expect(bars().map(animation => [animation.element, animation.duration])).toEqual([[notification.find('.toast-progress')[0], 4000]]);
    });

    test('stops while the toast is held, and runs down over the extended timeout when it is let go', () => {
        const toast = toastr.info('Saved', '', { ...withBar, timeOut: 3000, extendedTimeOut: 1500 });
        const [running] = bars();
        toast.trigger('mouseenter');
        expect(running.paused).toBe(true);
        toast.trigger('mouseleave');
        expect(bars().map(animation => animation.duration)).toEqual([3000, 1500]);
        expect(running.done).toBe(true);
    });

    test('is not drawn for a toast that stays, or when the option is off', () => {
        toastr.info('Working', '', { ...withBar, timeOut: 0, extendedTimeOut: 0 });
        toastr.info('Saved');
        notice('error', 'Failed', withBar);
        expect(bars()).toHaveLength(0);
    });

    test('starts again when a toast that a high-priority toast pushed back shows again', async () => {
        const first = toastr.info('first', '', withBar);
        const bar = first.find('.toast-progress')[0];
        toastr.info('<button type="button">Undo</button>', '', { escapeHtml: false });
        const [pushedBack] = bars();
        expect(pushedBack.paused).toBe(true);

        await advance(5000);
        expect(first.hasClass('sb-toast-leaving')).toBe(false);
        const runs = bars().filter(animation => animation.element === bar);
        expect(runs).toHaveLength(2);
        expect(runs[1].duration).toBe(5000);
    });
});

describe('toasts and modal dialogs', () => {
    const overlay = () => document.getElementById('sb-toast-overlay');
    const notificationContainer = () => document.getElementById('toast-container');
    const openHosts = [];

    // jsdom has no showModal() and close(). A browser fires `close` in a task after close(), and SillyBunny's own frames
    // carry the attribute that marks them as modal, because jsdom does not know :modal.
    beforeAll(() => {
        HTMLDialogElement.prototype.showModal = function showModal() {
            this.setAttribute('open', '');
        };
        HTMLDialogElement.prototype.close = function close() {
            this.removeAttribute('open');
            queueMicrotask(() => this.dispatchEvent(new Event('close')));
        };
    });

    function openHost() {
        const host = document.createElement('dialog');
        host.setAttribute('data-sb-modal', '');
        document.body.append(host);
        host.showModal();
        openHosts.push(host);
        return host;
    }

    afterEach(() => {
        openHosts.splice(0).forEach(host => host.remove());
    });

    test('a toast and a notification raised while a modal dialog is open are inside it', () => {
        const host = openHost();
        toastr.info('A toast');
        notice('info', 'Note');
        expect(overlay().parentElement).toBe(host);
        expect(notificationContainer().parentElement).toBe(host);
    });

    test('a dialog that closes and is removed takes no toast and no notification with it, and none leaves its queue', async () => {
        const host = openHost();
        const shownToast = toastr.info('first');
        const waitingToast = toastr.info('second');
        const notification = notice('info', 'Note');

        host.close();
        host.remove();
        // The `close` event has not fired yet, and a look at the queues must already find every message.
        expect(queueState()).toEqual({ current: shownToast[0], waiting: [waitingToast[0]] });
        expect(notificationState()).toEqual({ shown: [notification[0]], waiting: [] });
        await flush();

        expect(shownToast[0].isConnected && waitingToast[0].isConnected && notification[0].isConnected).toBe(true);
        expect(overlay().parentElement).toBe(document.body);
        expect(notificationContainer().parentElement).toBe(document.body);
    });

    test('a dialog that closes and is removed puts the containers back by itself, when nothing else asks', async () => {
        const host = openHost();
        const toast = toastr.info('A toast');
        const notification = notice('info', 'Note');
        // The observers of the containers have seen the new messages, so only the dialog's own change is left to ask.
        await flush();
        host.close();
        host.remove();
        expect(document.body.contains(toast[0])).toBe(false);

        await flush();
        expect(overlay().parentElement).toBe(document.body);
        expect(notificationContainer().parentElement).toBe(document.body);
        expect(document.body.contains(toast[0]) && document.body.contains(notification[0])).toBe(true);
    });

    test('a dialog that only closes lets the next toast land in the body, with the toasts that were in it', async () => {
        const host = openHost();
        const before = toastr.info('first');
        host.close();
        const after = toastr.info('second');

        expect(overlay().parentElement).toBe(document.body);
        expect([...overlay().children]).toEqual([after[0], before[0]]);
        await flush();
        expect(overlay().parentElement).toBe(document.body);
    });

    test('a message raised after the dialog was removed and before its `close` event joins the same containers', async () => {
        const host = openHost();
        const first = toastr.info('first');
        const note = notice('info', 'Note');
        host.close();
        host.remove();

        const second = toastr.info('second');
        const next = notice('info', 'Next');
        await flush();

        expect(document.querySelectorAll('#sb-toast-overlay')).toHaveLength(1);
        expect(document.querySelectorAll('#toast-container')).toHaveLength(1);
        expect([...overlay().children]).toEqual(expect.arrayContaining([first[0], second[0]]));
        expect([...notificationContainer().children]).toEqual(expect.arrayContaining([note[0], next[0]]));
    });

    test('a dialog that opens over a message that is on screen takes the containers in, and the next dialog down gets them back', async () => {
        toastr.info('A toast');
        notice('info', 'Note');
        await flush();
        const lower = openHost();
        await flush();
        expect(overlay().parentElement).toBe(lower);
        expect(notificationContainer().parentElement).toBe(lower);

        const upper = openHost();
        await flush();
        expect(overlay().parentElement).toBe(upper);

        upper.setAttribute('closing', '');
        await flush();
        expect(overlay().parentElement).toBe(lower);
        expect(notificationContainer().parentElement).toBe(lower);
    });

    test('a container that toastr.remove() took away on purpose does not come back when its dialog goes', async () => {
        const host = openHost();
        toastr.info('A toast');
        notice('info', 'Note');
        toastr.remove();
        host.close();
        host.remove();
        await flush();
        expect(document.querySelectorAll('.toast')).toHaveLength(0);
        expect(overlay()).toBeNull();
        expect(notificationContainer()).toBeNull();
    });
});

describe('preventDuplicates across the two containers', () => {
    const stays = { preventDuplicates: true, timeOut: 0, extendedTimeOut: 0 };
    // toastr keeps the last message of a preventDuplicates toast in a variable of its own, so each test has its own text.
    const textsOf = selector => [...document.querySelectorAll(selector)].map(node => node.textContent);

    async function letOneToastCome() {
        toastr.info('B');
        await advance(5000);
        await finishAnimations();
    }

    test('a toast is not made twice while it is on screen, though another toast came and went', async () => {
        toastr.info('Toast one', '', stays);
        await letOneToastCome();
        expect(textsOf('.toast-message')).toEqual(['Toast one']);

        expect(toastr.info('Toast one', '', stays)).toBeUndefined();
        expect(textsOf('.toast-message')).toEqual(['Toast one']);
    });

    test('a notification is not made twice while it is on screen, though a toast came and went', async () => {
        notice('info', 'Notice two', stays);
        await letOneToastCome();

        expect(notice('info', 'Notice two', stays)).toBeUndefined();
        expect(textsOf('.toast-title')).toEqual(['Notice two']);
    });

    test('a notification is not made twice while it is on screen, though another notification came and went', async () => {
        notice('info', 'Notice three', stays);
        notice('info', 'Passing', { timeOut: 1000, extendedTimeOut: 1000 });
        await advance(1000);
        await finishAnimations();

        expect(notice('info', 'Notice three', stays)).toBeUndefined();
    });

    test('the same message is made again once no toast is left on screen', async () => {
        const first = toastr.info('Toast four', '', stays);
        toastr.clear(first, { force: true });
        await finishAnimations();
        expect(document.querySelectorAll('.toast')).toHaveLength(0);

        expect(toastr.info('Toast four', '', stays)).toBeDefined();
    });
});
