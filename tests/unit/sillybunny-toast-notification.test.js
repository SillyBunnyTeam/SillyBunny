/**
 * @jest-environment jsdom
 */
import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// The real jQuery and the real toastr run in jsdom, as in the queue tests, so a click and a handler are the real ones.
const libRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'lib');

let reducedMotion = false;
/** @type {{ element: HTMLElement, keyframes: Keyframe[], duration: number, easing: string, composite?: string, fill?: string, finish: () => void, done: boolean }[]} */
let animations = [];
let toastr;
let motion;
let notification;
const measured = { width: 9999, em: 16 };

const message = $toast => $toast[0].querySelector('.toast-message');
const HTML = { escapeHtml: false, timeOut: 0, extendedTimeOut: 0 };

async function flush() {
    for (let turn = 0; turn < 4; turn += 1) {
        await Promise.resolve();
    }
}

async function finishAnimations() {
    for (const animation of animations.filter(candidate => !candidate.done)) {
        animation.finish();
    }
    await flush();
}

beforeAll(async () => {
    HTMLElement.prototype.getClientRects = function getClientRects() {
        return this.isConnected && this.style.display !== 'none' ? [{ width: 100, height: 20 }] : [];
    };
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
            easing: options.easing,
            composite: options.composite,
            fill: options.fill,
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
    motion = await import('../../public/scripts/sillybunny-toast-motion.js');
    notification = await import('../../public/scripts/sillybunny-toast-notification.js');
    // Every message is a notification here: the measure says it is wider than a toast.
    motion.initializeToastMotion({ jQuery: window.jQuery, toastr, measure: () => measured });
    toastr.options = { positionClass: 'toast-top-center', showDuration: 300, hideDuration: 300, timeOut: 5000, extendedTimeOut: 5000, escapeHtml: true };
});

beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] });
    reducedMotion = false;
    animations = [];
    motion.setNotificationPosition('toast-top-center');
});

afterEach(async () => {
    toastr.clear(undefined, { force: true });
    await flush();
    toastr.remove();
    jest.clearAllTimers();
    jest.useRealTimers();
    motion.resetToastQueue();
    document.body.innerHTML = '';
});

describe('the button row', () => {
    test('a holder of buttons is marked, and the buttons stay where the caller put them', () => {
        const $toast = toastr.info('<div class="wrapper"><button id="a">A</button><button id="b">B</button></div>', 'Title', HTML);
        const wrapper = $toast[0].querySelector('.wrapper');
        expect(wrapper.classList.contains(notification.ACTIONS_CLASS)).toBe(true);
        expect([...wrapper.children].map(child => child.id)).toEqual(['a', 'b']);
        expect($toast[0].querySelector('#a').parentElement).toBe(wrapper);
    });

    test('a button that sits in the message itself makes the message the holder', () => {
        const $toast = toastr.info('<button id="a">A</button>', 'Title', HTML);
        expect(message($toast).classList.contains(notification.ACTIONS_CLASS)).toBe(true);
    });

    test('a run of text and inline markup beside the buttons is one item, and the buttons and their parent do not move', () => {
        const $toast = toastr.info('<div>Removed <b>Main</b> Prompt <button id="undo" class="menu_button">Undo</button></div>', '', HTML);
        const holder = $toast[0].querySelector('.sb-toast-actions');
        const [text, undo] = [...holder.children];
        expect(text.className).toBe(notification.TEXT_CLASS);
        expect(text.textContent.trim()).toBe('Removed Main  Prompt'.replace('  ', ' '));
        expect(text.querySelector('b').textContent).toBe('Main');
        expect(undo.id).toBe('undo');
        expect(undo.parentElement).toBe(holder);
    });

    test('plain text beside a button is wrapped too, and a block element beside buttons is left as it is', () => {
        const plain = toastr.info('<div>Removed <button>Undo</button></div>', '', HTML);
        expect(plain[0].querySelector('.sb-toast-actions > .sb-toast-text').textContent).toBe('Removed ');
        const blocks = toastr.info('<div class="sbHomeToast"><div>Well done.</div><div>Next.</div><button>Show Me</button></div>', 'Title', { ...HTML, preventDuplicates: false });
        const holder = blocks[0].querySelector('.sbHomeToast');
        expect([...holder.children].map(child => child.tagName)).toEqual(['DIV', 'DIV', 'BUTTON']);
        expect(holder.querySelector('.sb-toast-text')).toBeNull();
    });

    test('whitespace between buttons is not a run, and a message with no button has no holder', () => {
        const spaced = toastr.info('<div>\n  <button>A</button>\n  <button>B</button>\n</div>', 'Title', HTML);
        expect(spaced[0].querySelector('.sb-toast-text')).toBeNull();
        const none = toastr.info('<div>Just text</div>', 'Other', HTML);
        expect(none[0].querySelector('.sb-toast-actions')).toBeNull();
    });

    test('a button inside another button counts once, and a button that a link holds is a button of the message', () => {
        const nested = toastr.info('<div><span role="button" id="outer"><button id="inner">x</button></span></div>', 'Title', HTML);
        expect([...nested[0].querySelectorAll('.sb-toast-actions')].map(holder => holder.tagName)).toEqual(['DIV']);
    });

    test('arranging again changes nothing', () => {
        const $toast = toastr.info('<div>Removed <button>Undo</button></div>', '', HTML);
        const before = message($toast).innerHTML;
        notification.arrangeButtons(message($toast));
        expect(message($toast).innerHTML).toBe(before);
    });

    test('follows the content when a caller changes it after the notification shows', async () => {
        const $toast = toastr.info('<div>Removed <button>Undo</button></div>', '', HTML);
        expect($toast[0].querySelector('.sb-toast-actions')).not.toBeNull();
        $toast.find('.toast-message').html('<span>Now <i>this</i> <button id="late">Late</button></span>');
        await flush();
        expect($toast[0].querySelector('#late').parentElement.classList.contains(notification.ACTIONS_CLASS)).toBe(true);
        expect($toast[0].querySelector('.sb-toast-text').textContent.trim()).toBe('Now this');
        $toast.find('.toast-message').text('No buttons any more');
        await flush();
        expect($toast[0].querySelector('.sb-toast-actions')).toBeNull();
        expect(message($toast).classList.contains(notification.ACTIONS_CLASS)).toBe(false);
    });

    describe('handlers', () => {
        test('a handler bound on a button fires, and so does one that jQuery delegates from the caller\'s own wrapper', () => {
            const body = document.createElement('div');
            body.append('Removed ');
            const undo = document.createElement('button');
            undo.textContent = 'Undo';
            body.append(undo);
            const direct = jest.fn();
            const delegated = jest.fn();
            undo.addEventListener('click', direct);
            window.jQuery(body).on('click', 'button', delegated);
            toastr.info(body, 'Title', HTML);
            undo.click();
            expect(direct).toHaveBeenCalledTimes(1);
            expect(delegated).toHaveBeenCalledTimes(1);
            expect(undo.parentElement).toBe(body);
        });

        test('a handler that a caller binds on the returned element after the call still finds the buttons', () => {
            const $toast = toastr.info('<div><button id="restore">Restore</button><button id="discard">Discard</button></div>', 'Title', HTML);
            const restore = jest.fn();
            const delegated = jest.fn();
            $toast.find('#restore').on('click', restore);
            $toast.on('click', '.toast-message button', delegated);
            $toast.find('#restore')[0].click();
            expect(restore).toHaveBeenCalledTimes(1);
            expect(delegated).toHaveBeenCalledTimes(1);
            expect($toast.find('.toast-message button')).toHaveLength(2);
        });

        test('the button of a notification of the bundled call sites keeps its handler: the Getting Started and connection patterns', () => {
            const showMe = document.createElement('button');
            showMe.className = 'sbHomeToastAction';
            const wrapper = document.createElement('div');
            wrapper.className = 'sbHomeToast';
            wrapper.append(Object.assign(document.createElement('div'), { textContent: 'Well done!' }), showMe);
            const clicked = jest.fn();
            showMe.addEventListener('click', clicked, { once: true });
            toastr.success(wrapper, 'Set up a preset', HTML);
            showMe.click();
            expect(clicked).toHaveBeenCalledTimes(1);
        });
    });
});

describe('a click on the card', () => {
    const dismissed = $toast => $toast.hasClass('sb-toast-leaving') || !$toast[0].isConnected;
    const options = { timeOut: 0, extendedTimeOut: 0 };

    test('dismisses the notification, and so does a click when the caller gave an onclick, after the onclick ran', () => {
        const plain = toastr.info('A message', 'Title', options);
        plain[0].click();
        expect(dismissed(plain)).toBe(true);

        const onclick = jest.fn();
        const clickable = toastr.warning('Details', 'Another', { ...options, onclick });
        clickable.find('.toast-message')[0].click();
        expect(onclick).toHaveBeenCalledTimes(1);
        expect(dismissed(clickable)).toBe(true);
    });

    test('does nothing with tapToDismiss false and no onclick, and runs the onclick and dismisses with tapToDismiss false and an onclick', () => {
        const inert = toastr.info('Stays', 'Title', { ...options, tapToDismiss: false });
        inert[0].click();
        expect(dismissed(inert)).toBe(false);
        expect(inert[0].classList.contains('toast-non-interactable')).toBe(true);
        expect(inert[0].getAttribute('title')).toBeNull();

        const onclick = jest.fn();
        const clickable = toastr.info('Open it', 'Other', { ...options, tapToDismiss: false, onclick });
        expect(clickable[0].classList.contains('interactable')).toBe(true);
        expect(clickable[0].classList.contains('toast-non-interactable')).toBe(false);
        clickable[0].click();
        expect(onclick).toHaveBeenCalledTimes(1);
        expect(dismissed(clickable)).toBe(true);
    });

    test('marks the card as one that a click acts on only where a click dismisses, and leaves the hint of the app to its subscriber', () => {
        const dismissing = toastr.info('Tap', 'Title', options);
        expect(dismissing[0].classList.contains('interactable')).toBe(true);
        expect(dismissing[0].classList.contains('toast-non-interactable')).toBe(false);
    });

    test('is not a click on a button, a link, an input or the close button, which keep their own action', () => {
        const onclick = jest.fn();
        const $toast = toastr.info('<a href="#x" id="link">Link</a> <button id="b">B</button> <input id="i"> <label id="l">L</label>', 'Title', { ...HTML, onclick });
        for (const selector of ['#link', '#b', '#i', '#l']) {
            $toast.find(selector)[0].click();
        }
        expect(onclick).not.toHaveBeenCalled();
        expect(dismissed($toast)).toBe(false);
    });

    test('the close button dismisses and runs onCloseClick, and not onclick', () => {
        const onclick = jest.fn();
        const onCloseClick = jest.fn();
        const $toast = toastr.info('Message', 'Title', { ...options, onclick, onCloseClick });
        $toast.find('.toast-close-button')[0].click();
        expect(onCloseClick).toHaveBeenCalledTimes(1);
        expect(onclick).not.toHaveBeenCalled();
        expect(dismissed($toast)).toBe(true);
    });

    test('is not a click when text of the card is selected, so that an error can be copied', () => {
        const $toast = toastr.error('Copy this error', 'Title', options);
        const range = document.createRange();
        range.selectNodeContents(message($toast));
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
        $toast[0].click();
        expect(dismissed($toast)).toBe(false);
        window.getSelection().removeAllRanges();
        $toast[0].click();
        expect(dismissed($toast)).toBe(true);
    });

    test('the handler of toastr\'s tap to dismiss is gone, so a click dismisses once and the app\'s other handlers stay', () => {
        const other = jest.fn();
        const $toast = toastr.info('Message', 'Title', options);
        $toast.on('click', other);
        $toast[0].click();
        expect(other).toHaveBeenCalledTimes(1);
        expect(dismissed($toast)).toBe(true);
    });
});

describe('the order and the container', () => {
    test('the newest notification is first in the document, whatever newestOnTop says, so a bottom position can draw it last', () => {
        const first = toastr.info('One', 'T1', { timeOut: 0, extendedTimeOut: 0 });
        const second = toastr.info('Two', 'T2', { timeOut: 0, extendedTimeOut: 0, newestOnTop: false });
        expect([...document.querySelectorAll('#toast-container > .toast')]).toEqual([second[0], first[0]]);
    });
});

describe('the motion', () => {
    const NOTIFICATION = { timeOut: 0, extendedTimeOut: 0 };
    const sized = (height) => {
        const real = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
        Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => height });
        return () => (real ? Object.defineProperty(HTMLElement.prototype, 'offsetHeight', real) : delete HTMLElement.prototype.offsetHeight);
    };

    test('in at a bottom position: a slide up from one height below and a scale from 0.9, with ease-out-back, and a fade with ease-out-quad, over 200ms', () => {
        const restore = sized(90);
        motion.setNotificationPosition('toast-bottom-center');
        toastr.info('A notification', 'Title', NOTIFICATION);
        restore();
        expect(animations.map(({ keyframes, duration, easing }) => ({ keyframes, duration, easing }))).toEqual([
            { keyframes: [{ opacity: 0 }, { opacity: 1 }], duration: 200, easing: 'cubic-bezier(0.25, 0.46, 0.45, 0.94)' },
            { keyframes: [{ transform: 'translateY(90px) scale(0.9)' }, { transform: 'none' }], duration: 200, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' },
        ]);
    });

    test.each([
        ['toast-top-center', 'translateY(-90px)'],
        ['toast-bottom-right', 'translateY(90px)'],
    ])('out at %s: a fade and a slide back by its own height, both with ease-out-back, over 200ms, and no scale', async (position, slide) => {
        const restore = sized(90);
        motion.setNotificationPosition(position);
        const $toast = toastr.info('A notification', 'Title', NOTIFICATION);
        await finishAnimations();
        animations = [];
        toastr.clear($toast, { force: true });
        restore();
        expect(animations.map(({ keyframes, duration, easing, fill }) => ({ keyframes, duration, easing, fill }))).toEqual([
            { keyframes: [{ opacity: 1 }, { opacity: 0 }], duration: 200, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)', fill: 'forwards' },
            { keyframes: [{ transform: 'none' }, { transform: slide }], duration: 200, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)', fill: 'forwards' },
        ]);
        await finishAnimations();
        expect($toast[0].isConnected).toBe(false);
    });

    test('under reduced motion it fades in and out, with no movement', async () => {
        reducedMotion = true;
        const $toast = toastr.info('A notification', 'Title', NOTIFICATION);
        expect(animations.map(animation => animation.keyframes)).toEqual([[{ opacity: 0 }, { opacity: 1 }]]);
        await finishAnimations();
        animations = [];
        toastr.clear($toast, { force: true });
        expect(animations.map(animation => animation.keyframes)).toEqual([[{ opacity: 1 }, { opacity: 0 }]]);
        expect(animations[0].duration).toBeLessThanOrEqual(200);
    });

    test('a notification that leaves is taken out of the flow at its place, and from the bottom edge at a bottom position', async () => {
        motion.setNotificationPosition('toast-bottom-center');
        const first = toastr.info('One', 'T1');
        toastr.info('Two', 'T2');
        const container = document.getElementById('toast-container');
        Object.defineProperty(container, 'clientHeight', { configurable: true, value: 200 });
        Object.defineProperty(first[0], 'offsetTop', { configurable: true, value: 100 });
        Object.defineProperty(first[0], 'offsetHeight', { configurable: true, value: 80 });
        toastr.clear(first, { force: true });
        expect(first[0].style.position).toBe('absolute');
        expect(first[0].style.bottom).toBe('20px');
        expect(first[0].style.top).toBe('');
    });

    describe('the others move over 200ms with ease-out-quad, as position only', () => {
        const stack = (tops) => {
            const container = document.createElement('div');
            document.body.append(container);
            container.getBoundingClientRect = () => ({ top: 0 });
            return tops.map(([top]) => {
                const child = document.createElement('div');
                Object.defineProperty(child, 'offsetTop', { configurable: true, get: () => child.dataset.top * 1 });
                child.dataset.top = String(top);
                child.getClientRects = () => [{ width: 1, height: 1 }];
                container.append(child);
                return child;
            });
        };

        test('a sibling that the change moves slides from its old place with a translate that adds to a transform that is running', () => {
            const [leaver, other] = stack([[0], [100]]);
            notification.shiftOthersAround(leaver, () => {
                other.dataset.top = '40';
            });
            const slide = animations.filter(animation => animation.element === other);
            expect(slide).toHaveLength(1);
            expect(slide[0].keyframes).toEqual([{ translate: '0 60px' }, { translate: '0 0' }]);
            expect(slide[0].duration).toBe(200);
            expect(slide[0].easing).toBe('cubic-bezier(0.25, 0.46, 0.45, 0.94)');
            expect(slide[0].composite).toBe('add');
            expect(animations.filter(animation => animation.element === leaver)).toHaveLength(0);
        });

        test('a sibling that does not move does not animate, and a change under reduced motion is not animated at all', () => {
            const [leaver, other] = stack([[0], [100]]);
            notification.shiftOthersAround(leaver, () => {});
            expect(animations).toHaveLength(0);
            reducedMotion = true;
            notification.shiftOthersAround(leaver, () => {
                other.dataset.top = '40';
            });
            expect(animations).toHaveLength(0);
        });
    });
});
