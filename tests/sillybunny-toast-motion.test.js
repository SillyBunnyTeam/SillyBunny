import { beforeAll, beforeEach, describe, expect, test } from '@jest/globals';

let reducedMotion = false;
const animations = [];

class FakeElement {
    constructor({ display = 'none', height = 64, containerClass = 'toast-top-center' } = {}) {
        this.isConnected = true;
        this.inert = false;
        this.parentElement = { className: containerClass };
        this.height = height;
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

    animate(keyframes, options) {
        let resolve;
        const finished = new Promise(resolvePromise => {
            resolve = resolvePromise;
        });
        const animation = { keyframes, options, finished, finish: () => resolve(), cancel() {} };
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

    test('slides in from its own height with a 300ms fade', async () => {
        const element = new FakeElement({ height: 80 });
        let completed = false;
        $(element).sbToastIn({ duration: 250, easing: 'linear', complete: () => { completed = true; } });

        expect(element.style.display).toBeUndefined();
        expect(animations).toHaveLength(1);
        expect(animations[0].keyframes).toEqual([
            { opacity: 0, transform: 'translateY(-80px)' },
            { opacity: 1, transform: 'none' },
        ]);
        expect(animations[0].options.duration).toBe(300);
        expect(completed).toBe(false);

        animations[0].finish();
        await flush();
        expect(completed).toBe(true);
    });

    test('rises from below in bottom-anchored containers', () => {
        const element = new FakeElement({ height: 50, containerClass: 'toast-bottom-right' });
        $(element).sbToastIn({});
        expect(animations[0].keyframes[0].transform).toBe('translateY(50px)');
    });

    test('fades and scales out over 300ms, then hides so toastr can remove it', async () => {
        const element = new FakeElement({ display: '' });
        let completed = false;
        $(element).sbToastOut({ complete: () => { completed = true; } });

        expect(element.classList.contains('sb-toast-leaving')).toBe(true);
        expect(animations[0].keyframes).toEqual([
            { opacity: 1, transform: 'none' },
            { opacity: 0, transform: 'scale(0.95)' },
        ]);
        expect(animations[0].options).toMatchObject({ duration: 300, fill: 'forwards' });

        animations[0].finish();
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
        animations[0].finish();
        await flush();
        expect(removed).toBe(false);
        expect(element.style.display).toBe('');
    });

    test('reduced motion shows and hides at once and still completes', () => {
        reducedMotion = true;
        const element = new FakeElement();
        let shown = false;
        let hidden = false;

        $(element).sbToastIn({ complete: () => { shown = true; } });
        expect(shown).toBe(true);
        expect(element.style.display).toBeUndefined();

        $(element).sbToastOut({ complete: () => { hidden = true; } });
        expect(hidden).toBe(true);
        expect(element.style.display).toBe('none');
        expect(animations).toHaveLength(0);
    });
});
