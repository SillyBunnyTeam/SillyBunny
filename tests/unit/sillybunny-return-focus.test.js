/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions. */
// returnFocusTo gives focus back to the control that opened a dialog, and never takes focus from a
// control the user has moved to.
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const { returnFocusTo } = await import('../../public/scripts/sillybunny-editor/page-chain.js');

let frames;
const runFrame = () => {
    const queued = frames;
    frames = [];
    queued.forEach(callback => callback());
};
const runFrames = count => { for (let index = 0; index < count; index++) runFrame(); };

function mount(html) {
    document.body.innerHTML = html;
    return id => document.getElementById(id);
}

beforeEach(() => {
    frames = [];
    jest.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => frames.push(callback));
});

afterEach(() => {
    jest.restoreAllMocks();
    document.body.innerHTML = '';
});

describe('returnFocusTo', () => {
    test('focuses an enabled opener at once', () => {
        const get = mount('<button id="opener">Open</button><button id="other">Other</button>');
        get('other').focus();

        returnFocusTo(get('opener'));

        expect(document.activeElement).toBe(get('opener'));
        expect(frames).toHaveLength(0);
    });

    test('waits for a disabled opener for 8 frames, then uses the fallback', () => {
        const get = mount('<button id="opener" disabled>Open</button><button id="fallback">Fallback</button>');

        returnFocusTo(get('opener'), { fallback: get('fallback') });
        runFrames(7);
        expect(document.activeElement).toBe(document.body);
        expect(frames).toHaveLength(1);

        runFrame();
        expect(document.activeElement).toBe(get('fallback'));
        expect(frames).toHaveLength(0);
    });

    test('focuses the opener as soon as it is enabled again', () => {
        const get = mount('<button id="opener" disabled>Open</button><button id="fallback">Fallback</button>');

        returnFocusTo(get('opener'), { fallback: get('fallback') });
        runFrames(2);
        get('opener').disabled = false;
        runFrame();

        expect(document.activeElement).toBe(get('opener'));
        expect(frames).toHaveLength(0);
    });

    test('stops waiting once focus has moved to another control', () => {
        const get = mount('<button id="opener" disabled>Open</button><button id="user">User</button><button id="fallback">Fallback</button>');

        returnFocusTo(get('opener'), { fallback: get('fallback') });
        runFrame();
        get('user').focus();
        runFrame();

        expect(document.activeElement).toBe(get('user'));
        expect(frames).toHaveLength(0);
    });

    test('does not move focus that is already on another control when the opener is hidden', () => {
        const get = mount('<div hidden><button id="opener">Open</button></div><button id="user">User</button><button id="fallback">Fallback</button>');
        get('user').focus();

        returnFocusTo(get('opener'), { fallback: get('fallback') });

        expect(document.activeElement).toBe(get('user'));
    });

    test('a hidden opener sends focus to the fallback', () => {
        const get = mount('<div hidden><button id="opener">Open</button></div><button id="fallback">Fallback</button>');

        returnFocusTo(get('opener'), { fallback: get('fallback') });

        expect(document.activeElement).toBe(get('fallback'));
    });

    test('a hidden opener without a fallback sends focus to a control next to it', () => {
        const get = mount('<section id="group"><button id="opener" hidden>Open</button><button id="neighbour">Neighbour</button></section><button id="far">Far</button>');

        returnFocusTo(get('opener'));

        expect(document.activeElement).toBe(get('neighbour'));
    });

    test('an inert opener is not focused', () => {
        const get = mount('<div inert><button id="opener">Open</button></div><button id="fallback">Fallback</button>');

        returnFocusTo(get('opener'), { fallback: get('fallback') });

        expect(document.activeElement).toBe(get('fallback'));
    });

    test('a null opener uses the fallback', () => {
        const get = mount('<button id="fallback">Fallback</button>');

        returnFocusTo(null, { fallback: get('fallback') });

        expect(document.activeElement).toBe(get('fallback'));
    });

    test('a removed opener uses the control in its recorded container', () => {
        const get = mount('<section id="group"><button id="opener">Open</button><button id="neighbour">Neighbour</button></section><button id="fallback">Fallback</button>');
        const opener = get('opener');
        const container = get('group');
        opener.remove();

        returnFocusTo(opener, { fallback: get('fallback'), container });

        expect(document.activeElement).toBe(get('neighbour'));
    });

    test('a removed opener without a container uses the fallback', () => {
        const get = mount('<button id="opener">Open</button><button id="fallback">Fallback</button>');
        const opener = get('opener');
        opener.remove();

        returnFocusTo(opener, { fallback: get('fallback') });

        expect(document.activeElement).toBe(get('fallback'));
    });

    test('a removed opener whose container is gone too uses the fallback', () => {
        const get = mount('<section id="group"><button id="opener">Open</button></section><button id="fallback">Fallback</button>');
        const opener = get('opener');
        const container = get('group');
        container.remove();

        returnFocusTo(opener, { fallback: get('fallback'), container });

        expect(document.activeElement).toBe(get('fallback'));
    });

    describe('an enabled, visible opener that refuses focus', () => {
        // WebKit can refuse focus for a frame after the dialog it came from is removed. The stub refuses
        // until `acceptFrom` frames have run, then lets the real focus() through.
        function refuseFocus(opener, acceptFrom) {
            let framesRun = 0;
            const realFocus = opener.focus.bind(opener);
            const attempts = jest.fn(options => { if (framesRun >= acceptFrom) realFocus(options); });
            opener.focus = attempts;
            return { attempts, advance: () => { framesRun += 1; runFrame(); } };
        }

        test('takes focus on a later frame, and the fallback never gets it', () => {
            const get = mount('<button id="opener">Open</button><button id="fallback">Fallback</button>');
            const { advance } = refuseFocus(get('opener'), 2);

            returnFocusTo(get('opener'), { fallback: get('fallback') });
            expect(document.activeElement).toBe(document.body);
            advance();
            expect(document.activeElement).toBe(document.body);
            advance();

            expect(document.activeElement).toBe(get('opener'));
            expect(frames).toHaveLength(0);
        });

        test('falls back after 8 frames when it never takes focus', () => {
            const get = mount('<button id="opener">Open</button><button id="fallback">Fallback</button>');
            const { attempts, advance } = refuseFocus(get('opener'), Infinity);

            returnFocusTo(get('opener'), { fallback: get('fallback') });
            for (let frame = 0; frame < 7; frame++) advance();
            expect(document.activeElement).toBe(document.body);
            advance();

            expect(document.activeElement).toBe(get('fallback'));
            expect(frames).toHaveLength(0);
            expect(attempts.mock.calls.length).toBeGreaterThan(1);
        });
    });

    describe('an opener that can never take focus', () => {
        test.each([
            ['has no tabindex and is not a control', '<div id="opener">Open</div>'],
            ['has tabindex -1', '<div id="opener" tabindex="-1">Open</div>'],
            ['has visibility hidden', '<button id="opener" style="visibility: hidden">Open</button>'],
            ['has display none', '<button id="opener" style="display: none">Open</button>'],
        ])('goes straight to the fallback when it %s', (_name, markup) => {
            const get = mount(`${markup}<button id="fallback">Fallback</button>`);
            // jsdom does no rendering checks, so the browser's refusal is stated here.
            get('opener').focus = () => {};

            returnFocusTo(get('opener'), { fallback: get('fallback') });

            expect(document.activeElement).toBe(get('fallback'));
            expect(frames).toHaveLength(0);
        });
    });

    describe('with modal dialogs open', () => {
        // jsdom has no `:modal`. Every selector that asks for it is answered from a data-modal attribute instead,
        // so the code under test sees what a browser shows, whichever DOM API it uses to ask.
        const asked = [];
        const emulateModal = selector => selector.replace(/:modal/g, '[data-modal]');
        const patch = (prototype, name) => {
            const original = prototype[name];
            prototype[name] = function patched(selector, ...rest) {
                if (typeof selector === 'string' && selector.includes(':modal')) asked.push(selector);
                return original.call(this, typeof selector === 'string' ? emulateModal(selector) : selector, ...rest);
            };
            return () => { prototype[name] = original; };
        };
        let restore;

        beforeEach(() => {
            asked.length = 0;
            restore = [
                patch(Element.prototype, 'matches'),
                patch(Element.prototype, 'closest'),
                patch(Element.prototype, 'querySelector'),
                patch(Element.prototype, 'querySelectorAll'),
                patch(Document.prototype, 'querySelector'),
                patch(Document.prototype, 'querySelectorAll'),
            ];
        });

        afterEach(() => {
            restore.forEach(undo => undo());
        });

        const modal = (id, html, attributes = '') => `<dialog id="${id}" open data-modal ${attributes}>${html}</dialog>`;

        test('never focuses an opener behind the modal', () => {
            const get = mount(`<button id="opener">Open</button><button id="fallback">Fallback</button>${modal('top', '<button id="inside">Inside</button>')}`);

            returnFocusTo(get('opener'), { fallback: get('fallback') });

            expect(document.activeElement).toBe(document.body);
            expect(asked.length).toBeGreaterThan(0);
        });

        test('focuses an opener that is inside the modal', () => {
            const get = mount(modal('top', '<button id="inside">Inside</button>'));

            returnFocusTo(get('inside'));

            expect(document.activeElement).toBe(get('inside'));
        });

        test('focuses an opener in a middle level of a three-level chain, whose first modal is another level', () => {
            // The top level has closed and gone, so the middle level takes focus back. The root level is the first
            // modal in the document, and is inert because the middle level covers it.
            const get = mount([
                modal('root', '<button id="root-button">Root</button>', 'inert'),
                modal('middle', '<button id="middle-opener">Open</button>'),
            ].join(''));

            returnFocusTo(get('middle-opener'));

            expect(document.activeElement).toBe(get('middle-opener'));
        });

        test('sends a fallback inside the middle level to that level, not to the root level', () => {
            const get = mount([
                modal('root', '<button id="root-button">Root</button>', 'inert'),
                modal('middle', '<div hidden><button id="middle-opener">Open</button></div><button id="middle-fallback">Fallback</button>'),
            ].join(''));

            returnFocusTo(get('middle-opener'), { fallback: get('middle-fallback') });

            expect(document.activeElement).toBe(get('middle-fallback'));
        });
    });
});
