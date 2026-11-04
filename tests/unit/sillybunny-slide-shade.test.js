/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions. */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

await jest.unstable_mockModule('../../public/scripts/sillybunny-action-menu.js', () => ({
    openActionMenu: jest.fn(), closeActionMenu: jest.fn(), MOBILE_QUERY: '(max-width: 768px)', positionPopover: jest.fn(),
}));
await jest.unstable_mockModule('../../public/scripts/sillybunny-editor/picker.js', () => ({ closePicker: jest.fn(), openPicker: jest.fn() }));
await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((text, part, index) => text + part + (values[index] ?? ''), ''),
    translate: text => text,
}));

const { installSlideShade } = await import('../../public/scripts/sillybunny-editor/slide-shade.js');
const { openDialog } = await import('../../public/scripts/sillybunny-editor/dialog.js');

const SHADE_STYLE = 'style[data-sb-slide-shade]';

/** A document of its own, so each case starts without the shade that loading the module put in the main document. */
function freshDocument() {
    const frame = document.createElement('iframe');
    document.body.append(frame);
    return frame.contentDocument;
}

/** jsdom has no constructable style sheets, so this stands in for the browser's. */
function supportConstructableSheets(doc) {
    const { defaultView } = doc;
    defaultView.CSSStyleSheet = class { replaceSync(text) { this.text = text; } };
    doc.adoptedStyleSheets = [];
}

afterEach(() => {
    document.body.replaceChildren();
});

describe('slide shade styles', () => {
    test('loading the module installs them in the document once', () => {
        expect(document.head.querySelectorAll(SHADE_STYLE)).toHaveLength(1);
        installSlideShade();
        expect(document.head.querySelectorAll(SHADE_STYLE)).toHaveLength(1);
    });

    test('they carry the sliding page shadow and the dim layer, both from the dialog backdrop token', () => {
        const css = document.head.querySelector(SHADE_STYLE).textContent;
        expect(css).toContain('.sb-dialog__page.is-sliding {');
        expect(css).toContain('.sb-dialog__page.is-sliding::before {');
        expect(css.match(/var\(--sb-dialog-backdrop\)/g)).toHaveLength(2);
    });

    test('a browser with constructable style sheets gets one adopted sheet and no style element', () => {
        const doc = freshDocument();
        supportConstructableSheets(doc);
        installSlideShade(doc);
        installSlideShade(doc);
        expect(doc.adoptedStyleSheets).toHaveLength(1);
        expect(doc.adoptedStyleSheets[0].text).toContain('.is-sliding');
        expect(doc.head.querySelectorAll(SHADE_STYLE)).toHaveLength(0);
    });

    test('an adopted sheet comes back when other code reassigns the adopted sheets without it, and their sheets stay', () => {
        const doc = freshDocument();
        supportConstructableSheets(doc);
        installSlideShade(doc);
        const others = [{ text: 'a' }, { text: 'b' }];
        doc.adoptedStyleSheets = others;

        installSlideShade(doc);

        expect(doc.adoptedStyleSheets).toHaveLength(3);
        expect(doc.adoptedStyleSheets.slice(0, 2)).toEqual(others);
        expect(doc.adoptedStyleSheets[2].text).toContain('.is-sliding');
        installSlideShade(doc);
        expect(doc.adoptedStyleSheets).toHaveLength(3);
        expect(doc.head.querySelectorAll(SHADE_STYLE)).toHaveLength(0);
    });

    test('a browser without them gets one style element, however often it is asked', () => {
        const doc = freshDocument();
        installSlideShade(doc);
        installSlideShade(doc);
        installSlideShade(doc);
        expect(doc.head.querySelectorAll(SHADE_STYLE)).toHaveLength(1);
    });

    test('a sheet that fails to build falls back to the style element', () => {
        const doc = freshDocument();
        doc.defaultView.CSSStyleSheet = class { replaceSync() { throw new Error('unsupported'); } };
        doc.adoptedStyleSheets = [];
        installSlideShade(doc);
        expect(doc.adoptedStyleSheets).toHaveLength(0);
        expect(doc.head.querySelectorAll(SHADE_STYLE)).toHaveLength(1);
    });

    test('they come back when something removes them', () => {
        const doc = freshDocument();
        installSlideShade(doc);
        doc.head.querySelector(SHADE_STYLE).remove();
        installSlideShade(doc);
        expect(doc.head.querySelectorAll(SHADE_STYLE)).toHaveLength(1);
    });

    test('each document gets its own', () => {
        const first = freshDocument();
        const second = freshDocument();
        installSlideShade(first);
        installSlideShade(second);
        expect(first.head.querySelectorAll(SHADE_STYLE)).toHaveLength(1);
        expect(second.head.querySelectorAll(SHADE_STYLE)).toHaveLength(1);
    });
});

describe('slide shade in the dialog frame', () => {
    beforeEach(() => {
        window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
        HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
        HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
    });

    test('a second dialog, and a page pushed in each, leave a single set of rules', () => {
        const first = openDialog({ title: 'First', content: document.createElement('p') });
        first.push({ title: 'Page', content: document.createElement('p') });
        first.forceClose();
        const second = openDialog({ title: 'Second', content: document.createElement('p') });
        second.push({ title: 'Page', content: document.createElement('p') });
        expect(document.head.querySelectorAll(SHADE_STYLE)).toHaveLength(1);
        second.forceClose();
    });

    test('sliding a page puts the rules back when they are gone', () => {
        document.head.querySelector(SHADE_STYLE).remove();
        const dialog = openDialog({ title: 'First', content: document.createElement('p') });
        dialog.push({ title: 'Page', content: document.createElement('p') });
        expect(document.head.querySelectorAll(SHADE_STYLE)).toHaveLength(1);
        dialog.forceClose();
    });
});

describe('the dialog surface while pages slide', () => {
    let runs;

    beforeEach(() => {
        window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
        HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
        HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
        // jsdom has no Web Animations: every animate() call is recorded and ends when the test says so.
        runs = [];
        Element.prototype.animate = function animate(keyframes, options) {
            let finish;
            const animation = {
                finished: new Promise((resolve) => { finish = resolve; }),
                effect: { target: this },
                oncancel: null,
                persist() {},
                cancel() { animation.oncancel?.(); },
            };
            runs.push({ target: this, keyframes, options, finish, animation });
            return animation;
        };
    });

    afterEach(() => {
        delete Element.prototype.animate;
    });

    const surfaceOf = () => document.querySelector('.sb-dialog-host .sb-dialog');
    const isPaging = () => surfaceOf().classList.contains('is-paging');
    const pageSlides = () => runs.filter(run => run.target.matches('.sb-dialog__page') && !run.options.pseudoElement && run.keyframes[0]?.transform !== undefined);
    const heightMotions = () => runs.filter(run => run.target.matches('.sb-dialog__pages'));
    /** Lets the microtask that starts the height motion run. */
    const settled = () => new Promise(resolve => setTimeout(resolve, 0));
    const end = async (run) => {
        run.finish();
        await settled();
    };

    function openWithPage() {
        const dialog = openDialog({ title: 'Root', content: document.createElement('p') });
        const page = dialog.push({ title: 'Page', content: document.createElement('p') });
        return { dialog, page };
    }

    test('a pushed page puts is-paging on the surface until its slide and the height motion are over', async () => {
        const { dialog } = openWithPage();
        await settled();
        expect(pageSlides()).toHaveLength(1);
        expect(heightMotions()).toHaveLength(1);
        expect(isPaging()).toBe(true);

        await end(pageSlides()[0]);
        expect(isPaging()).toBe(true);
        await end(heightMotions()[0]);
        expect(isPaging()).toBe(false);
        dialog.forceClose();
    });

    test('the class stays while the slide outlasts the height motion', async () => {
        const { dialog } = openWithPage();
        await settled();
        await end(heightMotions()[0]);
        expect(isPaging()).toBe(true);
        await end(pageSlides()[0]);
        expect(isPaging()).toBe(false);
        dialog.forceClose();
    });

    test('a second slide that starts while the first runs keeps the class until it has ended too', async () => {
        const { dialog } = openWithPage();
        dialog.push({ title: 'Second', content: document.createElement('p') });
        await settled();
        const slides = pageSlides();
        expect(slides).toHaveLength(2);

        await end(slides[0]);
        for (const motion of heightMotions()) await end(motion);
        expect(isPaging()).toBe(true);
        await end(slides[1]);
        expect(isPaging()).toBe(false);
        dialog.forceClose();
    });

    test('popping a page holds the class for the slide that takes it away', async () => {
        const { dialog, page } = openWithPage();
        await settled();
        for (const run of [...pageSlides(), ...heightMotions()]) await end(run);
        expect(isPaging()).toBe(false);

        page.close();
        await settled();
        expect(isPaging()).toBe(true);
        for (const run of [...pageSlides(), ...heightMotions()]) await end(run);
        expect(isPaging()).toBe(false);
        dialog.forceClose();
    });

    test('popping a page in the middle of its own slide keeps the class through every read that starts the way back', async () => {
        const { dialog, page } = openWithPage();
        await settled();
        // Only the slide is left to hold the class, and the pop stops it.
        await end(heightMotions()[0]);
        expect(isPaging()).toBe(true);

        const reads = [];
        const readBox = Element.prototype.getBoundingClientRect;
        Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
            if (this.matches('.sb-dialog__pages')) reads.push(isPaging());
            return readBox.call(this);
        };
        try {
            page.close();
            await settled();
        } finally {
            Element.prototype.getBoundingClientRect = readBox;
        }

        expect(reads.length).toBeGreaterThan(0);
        expect(reads).toEqual(reads.map(() => true));
        expect(isPaging()).toBe(true);
        for (const run of [...pageSlides(), ...heightMotions()]) await end(run);
        expect(isPaging()).toBe(false);
        dialog.forceClose();
    });

    test('a slide that ends while the dialog fades out leaves the class on until the dialog is gone', async () => {
        const { dialog } = openWithPage();
        await settled();
        const surface = surfaceOf();

        const running = runs.length;
        dialog.forceClose();
        for (const run of runs.slice(0, running)) await end(run);
        expect(surface.isConnected).toBe(true);
        expect(surface.classList.contains('is-paging')).toBe(true);

        for (const run of runs.slice(running)) await end(run);
        await settled();
        expect(surface.isConnected).toBe(false);
        expect(surface.classList.contains('is-paging')).toBe(false);
    });

    test('a dialog that closes with no motion running does not lose its shadow for the fade', async () => {
        const { dialog } = openWithPage();
        await settled();
        for (const run of [...pageSlides(), ...heightMotions()]) await end(run);
        const surface = surfaceOf();
        expect(isPaging()).toBe(false);

        const running = runs.length;
        dialog.forceClose();
        expect(surface.classList.contains('is-paging')).toBe(false);
        for (const run of runs.slice(running)) await end(run);
        await settled();
        expect(surface.classList.contains('is-paging')).toBe(false);
    });

    test('a slide that cannot start releases the class', async () => {
        const dialog = openDialog({ title: 'Root', content: document.createElement('p') });
        const record = Element.prototype.animate;
        Element.prototype.animate = function animate(keyframes, options) {
            if (this.matches('.sb-dialog__page') && keyframes[0]?.transform !== undefined && !options.pseudoElement) throw new Error('no slide');
            return record.call(this, keyframes, options);
        };
        expect(() => dialog.push({ title: 'Page', content: document.createElement('p') })).toThrow('no slide');
        await settled();
        // The height motion of the swap still runs, and it is the only hold left.
        expect(isPaging()).toBe(true);
        await end(heightMotions()[0]);
        expect(isPaging()).toBe(false);
    });

    test('closing the dialog in the middle of a slide leaves no class behind, although its motions never end', async () => {
        const { dialog } = openWithPage();
        await settled();
        const surface = surfaceOf();
        expect(surface.classList.contains('is-paging')).toBe(true);

        // Only the motions of the exit end: the slide and the height motion of the page are left running.
        const running = runs.length;
        dialog.forceClose();
        for (const run of runs.slice(running)) await end(run);
        await settled();
        expect(surface.isConnected).toBe(false);
        expect(surface.classList.contains('is-paging')).toBe(false);

        for (const run of runs.slice(0, running)) await end(run);
        expect(surface.classList.contains('is-paging')).toBe(false);
    });

    test('a slide that is cancelled releases the class', async () => {
        const { dialog } = openWithPage();
        await settled();
        pageSlides()[0].animation.cancel();
        heightMotions()[0].animation.cancel();
        expect(isPaging()).toBe(false);
        dialog.forceClose();
    });

    test('with reduced motion no slide runs and the class never appears, not even for a moment', async () => {
        window.matchMedia = query => ({ matches: query.includes('prefers-reduced-motion'), addEventListener() {}, removeEventListener() {} });
        const dialog = openDialog({ title: 'Root', content: document.createElement('p') });
        // A class that is added and removed in one task leaves no trace in a later read, but it leaves mutation records.
        const classChanges = [];
        const watcher = new MutationObserver(records => classChanges.push(...records));
        watcher.observe(surfaceOf(), { attributes: true, attributeFilter: ['class'], attributeOldValue: true });

        const page = dialog.push({ title: 'Page', content: document.createElement('p') });
        await settled();
        expect(pageSlides()).toHaveLength(0);
        page.close();
        await settled();
        expect(isPaging()).toBe(false);
        dialog.forceClose();
        await settled();

        const records = [...classChanges, ...watcher.takeRecords()];
        watcher.disconnect();
        expect(records.filter(record => record.oldValue?.includes('is-paging'))).toEqual([]);
    });

    test('the surface rule that drops its shadow is one of the shade styles', () => {
        const css = document.head.querySelector(SHADE_STYLE).textContent;
        expect(css).toMatch(/\.sb-dialog\.is-paging \{\s*box-shadow: none;\s*\}/);
    });
});
