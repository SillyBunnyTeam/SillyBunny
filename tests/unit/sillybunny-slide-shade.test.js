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
