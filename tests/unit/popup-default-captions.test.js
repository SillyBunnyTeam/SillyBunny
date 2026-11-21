/** @jest-environment jsdom */
/* global globalThis */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions. */
// A Popup that is given no captions shows the default of its type (Yes, Save, Crop, Cancel), read from the data holder
// in `#popup_template`. A locale pass that runs later translates each button by its data-i18n key, so that key must be
// the template key the caption came from, not the key of the generic "OK" the constructor starts with.
import { jest, describe, test, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';

await jest.unstable_mockModule('../../public/lib/dialog-polyfill.esm.js', () => ({
    default: { registerDialog: jest.fn(), reposition: jest.fn() },
}));
await jest.unstable_mockModule('../../public/scripts/RossAscends-mods.js', () => ({
    shouldSendOnEnter: () => true,
}));
await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((result, part, index) => result + part + (values[index] ?? ''), ''),
    translate: text => text,
}));
await jest.unstable_mockModule('../../public/scripts/power-user.js', () => ({
    power_user: { never_resize_avatars: false },
    toastPositionClasses: ['toast-top-center'],
}));
await jest.unstable_mockModule('../../public/scripts/utils.js', () => ({
    clamp: (value, min, max) => Math.min(Math.max(value, min), max),
    removeFromArray: (array, item) => {
        const index = array.indexOf(item);
        if (index >= 0) array.splice(index, 1);
        return index >= 0;
    },
    runAfterAnimation: (control, callback) => callback(control),
    uuidv4: (() => {
        let next = 0;
        return () => `caption-${++next}`;
    })(),
}));

const { Popup, POPUP_TYPE } = await import('../../public/scripts/popup.js');

const templateHtml = fs.readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8')
    .match(/<template id="popup_template"[\s\S]*?<\/template>/)[0];
const zh = JSON.parse(fs.readFileSync(new URL('../../public/locales/zh-cn.json', import.meta.url), 'utf8'));

/** What the app's locale pass does to an element: a `[attribute]key` entry sets the attribute, a plain key sets the text. */
function localePass(map, root = document) {
    for (const element of root.querySelectorAll('[data-i18n]')) {
        for (const key of element.getAttribute('data-i18n').split(';')) {
            const tagged = key.match(/\[(\S+)\](.+)/);
            if (tagged) {
                if (map[tagged[2]] !== undefined) element.setAttribute(tagged[1], map[tagged[2]]);
            } else if (map[key] !== undefined && element.textContent !== map[key]) {
                element.textContent = map[key];
            }
        }
    }
}

beforeAll(() => {
    HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
    HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
    globalThis.jQuery = class FakeJQuery {};
    globalThis.$ = () => ({ append() {}, cropper() {}, data() {} });
    globalThis.toastr = { options: { positionClass: 'toast-top-center' }, warning: jest.fn() };
    window.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
});

beforeEach(() => {
    document.body.innerHTML = templateHtml;
    // The page's first pass translates the data holder, so its attributes already hold the locale's words.
    localePass(zh);
});

afterEach(async () => {
    for (const popup of [...Popup.util.popups]) {
        if (popup.dlg.hasAttribute('open')) await popup.completeCancelled();
    }
    Popup.util.popups.length = 0;
    document.body.replaceChildren();
});

/** Opens a popup with no captions and runs the locale pass again, as a language change or a late data load does. */
async function openAndTranslate(type, options = {}) {
    const popup = new Popup('<p>Content</p>', type, '', options);
    void popup.show();
    localePass(zh);
    return { ok: popup.okButton.textContent.trim(), cancel: popup.cancelButton.textContent.trim(), popup };
}

describe('default captions keep the key of the template attribute they came from', () => {
    test('a confirm shows the locale\'s Yes, and its negative response is the frame\'s Cancel', async () => {
        const { ok, cancel, popup } = await openAndTranslate(POPUP_TYPE.CONFIRM);
        expect(ok).toBe(zh['popup-button-yes']);
        expect(ok).not.toBe(zh.OK);
        expect(popup.okButton.dataset.i18n).toBe('popup-button-yes');
        // The frame renames a default "No" to Cancel, and the locale pass must not undo that.
        expect(cancel).toBe(zh.Cancel);
        expect(popup.cancelButton.dataset.i18n).toBe('Cancel');
    });

    test('a confirm that keeps its own frame shows the locale\'s No', async () => {
        const { cancel, popup } = await openAndTranslate(POPUP_TYPE.CONFIRM, { transparent: true });
        expect(cancel).toBe(zh['popup-button-no']);
        expect(popup.cancelButton.dataset.i18n).toBe('popup-button-no');
    });

    test('an input shows the locale\'s Save and Cancel', async () => {
        const { ok, cancel, popup } = await openAndTranslate(POPUP_TYPE.INPUT);
        expect(ok).toBe(zh['popup-button-save']);
        expect(cancel).toBe(zh['popup-button-cancel']);
        expect(popup.okButton.dataset.i18n).toBe('popup-button-save');
        expect(popup.cancelButton.dataset.i18n).toBe('popup-button-cancel');
    });

    test('a crop shows the locale\'s Crop and Cancel', async () => {
        const { ok, cancel, popup } = await openAndTranslate(POPUP_TYPE.CROP);
        expect(ok).toBe(zh['popup-button-crop']);
        expect(cancel).toBe(zh['popup-button-cancel']);
        expect(popup.okButton.dataset.i18n).toBe('popup-button-crop');
    });

    test('a text popup keeps the generic OK and its key', async () => {
        const { ok, popup } = await openAndTranslate(POPUP_TYPE.TEXT);
        expect(ok).toBe(zh.OK);
        expect(popup.okButton.dataset.i18n).toBe('OK');
    });

    test('a caption the caller gives stays its own i18n key', async () => {
        const { ok, cancel, popup } = await openAndTranslate(POPUP_TYPE.CONFIRM, { okButton: 'Delete', cancelButton: 'Keep' });
        expect(popup.okButton.dataset.i18n).toBe('Delete');
        expect(ok).toBe(zh.Delete);
        expect(popup.cancelButton.dataset.i18n).toBe('Keep');
        expect(cancel).toBe('Keep');
    });
});
