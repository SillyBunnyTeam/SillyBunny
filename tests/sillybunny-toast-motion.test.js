import { beforeAll, beforeEach, describe, expect, test } from '@jest/globals';

let reducedMotion = false;
const animations = [];

class FakeElement {
    constructor({ display = 'none', height = 64, containerClass = 'toast-top-center' } = {}) {
        this.isConnected = true;
        this.inert = false;
        this.parentElement = { className: containerClass, hasAttribute: () => false, children: [], getBoundingClientRect: () => ({ top: 0 }) };
        this.height = height;
        this.offsetHeight = height;
        this.offsetTop = 0;
        this.classes = new Set(['toast']);
        this.classList = {
            add: name => this.classes.add(name),
            remove: name => this.classes.delete(name),
            contains: name => this.classes.has(name),
        };
        this.style = {
            display,
            removeProperty: property => {
                delete this.style[property];
            },
        };
    }

    getBoundingClientRect() {
        return { height: this.height };
    }

    getClientRects() {
        return [{ width: 1, height: this.height }];
    }

    animate(keyframes, options) {
        let resolve;
        const finished = new Promise(resolvePromise => {
            resolve = resolvePromise;
        });
        const animation = { keyframes, options, finished, finish: () => resolve(), cancel() {}, element: this };
        animations.push(animation);
        return animation;
    }
}

let toastMotion;
let jQuery;
let toastr;

function $(element) {
    return Object.assign([element], jQuery.fn);
}

async function flush() {
    await Promise.resolve();
    await Promise.resolve();
}

beforeAll(async () => {
    global.HTMLElement = FakeElement;
    global.window = { matchMedia: () => ({ matches: reducedMotion }) };
    global.document = { body: { classList: { contains: () => false } } };

    jQuery = { fn: {} };
    toastr = { options: { positionClass: 'toast-top-right', showMethod: 'fadeIn', hideMethod: 'fadeOut' } };
    toastMotion = await import('../public/scripts/sillybunny-toast-motion.js');
    toastMotion.initializeToastMotion({ jQuery, toastr });
});

beforeEach(() => {
    reducedMotion = false;
    animations.length = 0;
});

describe('sillybunny toast motion', () => {
    test('registers the jQuery methods and points toastr at them', () => {
        expect(typeof jQuery.fn.sbToastIn).toBe('function');
        expect(typeof jQuery.fn.sbToastOut).toBe('function');
        expect(toastr.options).toMatchObject({
            positionClass: 'toast-top-right',
            showMethod: 'sbToastIn',
            hideMethod: 'sbToastOut',
            showDuration: 300,
            hideDuration: 300,
        });
    });

    test('keeps the methods when upstream reassigns toastr.options', () => {
        const previous = toastr.options;
        toastr.options = { positionClass: 'toast-top-center', showMethod: 'fadeIn', hideMethod: 'fadeOut', timeOut: 4000 };
        expect(toastr.options).toMatchObject({ positionClass: 'toast-top-center', timeOut: 4000, showMethod: 'sbToastIn', hideMethod: 'sbToastOut' });
        toastr.options = previous;
    });

    test('an in-app notification enters as GNOME Shell\'s banner: a fade and a slide with a scale from 0.9, both over 200ms', async () => {
        const element = new FakeElement({ height: 80 });
        let completed = false;
        $(element).sbToastIn({ duration: 250, easing: 'linear', complete: () => { completed = true; } });

        expect(element.style.display).toBeUndefined();
        expect(animations.map(animation => animation.keyframes)).toEqual([
            [{ opacity: 0 }, { opacity: 1 }],
            [{ transform: 'translateY(-80px) scale(0.9)' }, { transform: 'none' }],
        ]);
        expect(animations.map(animation => animation.options)).toEqual([
            { duration: 200, easing: 'cubic-bezier(0.25, 0.46, 0.45, 0.94)', fill: undefined },
            { duration: 200, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)', fill: undefined },
        ]);
        expect(completed).toBe(false);

        animations[0].finish();
        await flush();
        // It is in when both animations have finished.
        expect(completed).toBe(false);
        animations[1].finish();
        await flush();
        expect(completed).toBe(true);
    });

    test('a notification rises from below in bottom-anchored containers', () => {
        const element = new FakeElement({ height: 50, containerClass: 'toast-bottom-right' });
        $(element).sbToastIn({});
        expect(animations[1].keyframes[0].transform).toBe('translateY(50px) scale(0.9)');
    });

    test('leaves with a fade and a slide back by its own height over 200ms, then hides so toastr can remove it', async () => {
        const element = new FakeElement({ display: '', height: 80 });
        let completed = false;
        $(element).sbToastOut({ complete: () => { completed = true; } });

        expect(element.classList.contains('sb-toast-leaving')).toBe(true);
        expect(animations.map(animation => animation.keyframes)).toEqual([
            [{ opacity: 1 }, { opacity: 0 }],
            [{ transform: 'none' }, { transform: 'translateY(-80px)' }],
        ]);
        expect(animations.map(animation => animation.options)).toEqual([
            { duration: 200, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)', fill: 'forwards' },
            { duration: 200, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)', fill: 'forwards' },
        ]);

        for (const animation of animations) {
            animation.finish();
        }
        await flush();
        expect(element.style.display).toBe('none');
        expect(completed).toBe(true);
    });

    test('hovering a leaving toast keeps it', async () => {
        const element = new FakeElement({ display: '' });
        let removed = false;
        $(element).sbToastOut({ complete: () => { removed = true; } });
        $(element).sbToastIn({});

        expect(element.classList.contains('sb-toast-leaving')).toBe(false);
        for (const animation of animations) {
            animation.finish();
        }
        await flush();
        expect(removed).toBe(false);
        expect(element.style.display).toBe('');
    });

    test('reduced motion fades in and out and still completes', async () => {
        reducedMotion = true;
        const element = new FakeElement();
        let shown = false;
        let hidden = false;

        $(element).sbToastIn({ complete: () => { shown = true; } });
        expect(element.style.display).toBeUndefined();
        expect(animations.map(animation => animation.keyframes)).toEqual([[{ opacity: 0 }, { opacity: 1 }]]);
        animations[0].finish();
        await flush();
        expect(shown).toBe(true);

        animations.length = 0;
        $(element).sbToastOut({ complete: () => { hidden = true; } });
        expect(animations.map(animation => animation.keyframes)).toEqual([[{ opacity: 1 }, { opacity: 0 }]]);
        animations[0].finish();
        await flush();
        expect(hidden).toBe(true);
        expect(element.style.display).toBe('none');
    });
});
