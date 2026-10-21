/** @jest-environment jsdom */
/* global globalThis */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions. */
// Characterises the public `Popup` behaviour that callers (core, built-in and third-party extensions) rely on.
// It must stay green while the SillyBunny dialog frame hooks into popup.js.
import { jest, describe, test, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';

await jest.unstable_mockModule('../../public/lib/dialog-polyfill.esm.js', () => ({
    default: { registerDialog: jest.fn(), reposition: jest.fn() },
}));
await jest.unstable_mockModule('../../public/scripts/RossAscends-mods.js', () => ({
    shouldSendOnEnter: () => true,
}));
await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((text, part, index) => text + part + (values[index] ?? ''), ''),
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
        return () => `popup-${++next}`;
    })(),
}));

const { Popup, POPUP_TYPE, POPUP_RESULT, callGenericPopup, getTopmostModalLayer } = await import('../../public/scripts/popup.js');

const settle = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
const templateHtml = fs.readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8')
    .match(/<template id="popup_template"[\s\S]*?<\/template>/)[0];
const PUBLIC_ELEMENTS = {
    dlg: 'dialog.popup',
    body: '.popup-body',
    content: '.popup-content',
    mainInput: '.popup-input',
    inputControls: '.popup-inputs',
    buttonControls: '.popup-controls',
    okButton: '.popup-button-ok',
    cancelButton: '.popup-button-cancel',
    closeButton: '.popup-button-close',
    cropWrap: '.popup-crop-wrap',
    cropImage: '.popup-crop-image',
};

/** @param {Popup} popup */
const isShown = popup => popup.dlg.isConnected && popup.dlg.hasAttribute('open');
/** @param {Popup} popup */
const escape = popup => popup.dlg.dispatchEvent(new Event('cancel', { cancelable: true }));
const visible = element => element.style.display !== 'none';

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
});

afterEach(async () => {
    for (const popup of [...Popup.util.popups]) {
        if (isShown(popup)) await popup.completeCancelled();
    }
    Popup.util.popups.length = 0;
    document.body.replaceChildren();
});

describe('Popup DOM contract', () => {
    test('exposes every public element property inside the dialog', () => {
        const popup = new Popup('<p>Body</p>', POPUP_TYPE.TEXT);
        for (const [property, selector] of Object.entries(PUBLIC_ELEMENTS)) {
            expect(popup[property]).toBeInstanceOf(HTMLElement);
            expect(popup[property].matches(selector)).toBe(true);
            expect(popup.dlg.contains(popup[property])).toBe(true);
        }
    });

    test('keeps the caller content directly inside .popup-content inside .popup-body', async () => {
        const node = document.createElement('section');
        node.id = 'caller-content';
        const popup = new Popup(node, POPUP_TYPE.TEXT);
        void popup.show();
        await settle();
        expect(node.parentElement).toBe(popup.content);
        expect(popup.content.closest('.popup-body')).toBe(popup.body);
    });

    test('keeps OK before Cancel in DOM order and the buttons inside buttonControls', async () => {
        const popup = new Popup('Sure?', POPUP_TYPE.CONFIRM);
        void popup.show();
        await settle();
        expect(popup.buttonControls.contains(popup.okButton)).toBe(true);
        expect(popup.buttonControls.contains(popup.cancelButton)).toBe(true);
        expect(popup.okButton.compareDocumentPosition(popup.cancelButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    test('shows the native modal dialog and tracks it as the topmost layer', async () => {
        const popup = new Popup('Hello', POPUP_TYPE.TEXT);
        void popup.show();
        await settle();
        expect(isShown(popup)).toBe(true);
        expect(Popup.util.isPopupOpen()).toBe(true);
        expect(getTopmostModalLayer()).toBe(popup.dlg);
        popup.dlg.setAttribute('closing', '');
        expect(getTopmostModalLayer()).toBe(document.body);
    });

    test('applies the upstream size classes', () => {
        const popup = new Popup('x', POPUP_TYPE.TEXT, '', { wide: true, wider: true, large: true, transparent: true, leftAlign: true });
        expect([...popup.dlg.classList]).toEqual(expect.arrayContaining([
            'popup', 'wide_dialogue_popup', 'wider_dialogue_popup', 'large_dialogue_popup',
            'transparent_dialogue_popup', 'left_aligned_dialogue_popup',
        ]));
    });
});

describe('Popup button visibility and captions per type', () => {
    test('TEXT shows OK only by default', () => {
        const popup = new Popup('x', POPUP_TYPE.TEXT);
        expect(visible(popup.okButton)).toBe(true);
        expect(visible(popup.cancelButton)).toBe(false);
        expect(visible(popup.closeButton)).toBe(false);
        expect(popup.okButton.textContent).toBe('OK');
    });

    test('CONFIRM shows Yes and No by default and custom captions when given', () => {
        const plain = new Popup('x', POPUP_TYPE.CONFIRM);
        expect(plain.okButton.textContent).toBe('Yes');
        expect(plain.cancelButton.textContent).toBe('No');
        const custom = new Popup('x', POPUP_TYPE.CONFIRM, '', { okButton: 'Delete', cancelButton: 'Keep' });
        expect(custom.okButton.textContent).toBe('Delete');
        expect(custom.cancelButton.textContent).toBe('Keep');
        expect(visible(custom.okButton) && visible(custom.cancelButton)).toBe(true);
    });

    test('INPUT shows the main input and Save', () => {
        const popup = new Popup('x', POPUP_TYPE.INPUT, 'value', { rows: 4, placeholder: 'Type' });
        expect(visible(popup.mainInput)).toBe(true);
        expect(popup.mainInput.value).toBe('value');
        expect(popup.mainInput.rows).toBe(4);
        expect(popup.mainInput.placeholder).toBe('Type');
        expect(popup.okButton.textContent).toBe('Save');
    });

    test('DISPLAY hides the responses and shows the close button', () => {
        const popup = new Popup('x', POPUP_TYPE.DISPLAY);
        expect(visible(popup.buttonControls)).toBe(false);
        expect(visible(popup.closeButton)).toBe(true);
    });

    test('okButton/cancelButton false hide the buttons', () => {
        const popup = new Popup('x', POPUP_TYPE.CONFIRM, '', { okButton: false, cancelButton: false });
        expect(visible(popup.okButton)).toBe(false);
        expect(visible(popup.cancelButton)).toBe(false);
    });
});

describe('Popup results', () => {
    test('OK resolves AFFIRMATIVE and Cancel resolves NEGATIVE', async () => {
        const ok = new Popup('x', POPUP_TYPE.CONFIRM);
        const okResult = ok.show();
        ok.okButton.click();
        await expect(okResult).resolves.toBe(POPUP_RESULT.AFFIRMATIVE);
        expect(ok.result).toBe(POPUP_RESULT.AFFIRMATIVE);

        const cancel = new Popup('x', POPUP_TYPE.CONFIRM);
        const cancelResult = cancel.show();
        cancel.cancelButton.click();
        await expect(cancelResult).resolves.toBe(POPUP_RESULT.NEGATIVE);
    });

    test('the close button resolves NEGATIVE', async () => {
        const popup = new Popup('x', POPUP_TYPE.DISPLAY);
        const result = popup.show();
        popup.closeButton.click();
        await expect(result).resolves.toBe(POPUP_RESULT.NEGATIVE);
    });

    test('Escape resolves CANCELLED', async () => {
        const popup = new Popup('x', POPUP_TYPE.CONFIRM);
        const result = popup.show();
        escape(popup);
        await expect(result).resolves.toBe(POPUP_RESULT.CANCELLED);
    });

    test('allowEscapeClose: false keeps the popup open on a single Escape', async () => {
        const popup = new Popup('x', POPUP_TYPE.CONFIRM, '', { allowEscapeClose: false });
        void popup.show();
        await settle();
        const event = new Event('cancel', { cancelable: true });
        popup.dlg.dispatchEvent(event);
        await settle();
        expect(event.defaultPrevented).toBe(true);
        expect(isShown(popup)).toBe(true);
        expect(popup.result).toBeUndefined();
    });

    test('INPUT resolves the string on OK, false on Cancel and null on Escape', async () => {
        const ok = new Popup('x', POPUP_TYPE.INPUT, 'start');
        const okResult = ok.show();
        ok.mainInput.value = 'typed';
        ok.okButton.click();
        await expect(okResult).resolves.toBe('typed');

        const negative = new Popup('x', POPUP_TYPE.INPUT, 'start');
        const negativeResult = negative.show();
        negative.cancelButton.click();
        await expect(negativeResult).resolves.toBe(false);

        const cancelled = new Popup('x', POPUP_TYPE.INPUT, 'start');
        const cancelledResult = cancelled.show();
        escape(cancelled);
        await expect(cancelledResult).resolves.toBeNull();
    });

    test('Popup.show.input returns an empty string as success and null on cancel', async () => {
        const empty = Popup.show.input('Header', 'Text', '');
        await settle();
        Popup.util.popups.at(-1).okButton.click();
        await expect(empty).resolves.toBe('');

        const cancelled = Popup.show.input('Header', 'Text', 'x');
        await settle();
        escape(Popup.util.popups.at(-1));
        await expect(cancelled).resolves.toBeNull();
    });

    test('callGenericPopup resolves with the popup value', async () => {
        const result = callGenericPopup('x', POPUP_TYPE.CONFIRM);
        await settle();
        Popup.util.popups.at(-1).okButton.click();
        await expect(result).resolves.toBe(POPUP_RESULT.AFFIRMATIVE);
    });

    test('custom buttons resolve their results; string buttons count from 2', async () => {
        const popup = new Popup('x', POPUP_TYPE.CONFIRM, '', {
            customButtons: ['First', { text: 'Custom', result: POPUP_RESULT.CUSTOM3 }],
        });
        const result = popup.show();
        const buttons = [...popup.buttonControls.querySelectorAll('.popup-button-custom')];
        expect(buttons.map(button => button.dataset.result)).toEqual(['2', String(POPUP_RESULT.CUSTOM3)]);
        buttons[1].click();
        await expect(result).resolves.toBe(POPUP_RESULT.CUSTOM3);

        const second = new Popup('x', POPUP_TYPE.CONFIRM, '', { customButtons: ['First'] });
        const secondResult = second.show();
        second.buttonControls.querySelector('.popup-button-custom').click();
        await expect(secondResult).resolves.toBe(2);
    });

    test('custom buttons go before OK, or after Cancel with appendAtEnd', () => {
        const popup = new Popup('x', POPUP_TYPE.CONFIRM, '', {
            customButtons: [{ text: 'Before', result: 5 }, { text: 'After', result: 6, appendAtEnd: true }],
        });
        const order = [...popup.buttonControls.children].map(button => button.textContent);
        expect(order).toEqual(['Before', 'Yes', 'No', 'After']);
    });

    test('a custom button without a result runs its action and keeps the popup open', async () => {
        const action = jest.fn();
        const popup = new Popup('x', POPUP_TYPE.TEXT, '', { customButtons: [{ text: 'Act', action }] });
        void popup.show();
        await settle();
        popup.buttonControls.querySelector('.popup-button-custom').click();
        await settle();
        expect(action).toHaveBeenCalledTimes(1);
        expect(isShown(popup)).toBe(true);
    });
});

describe('Popup custom inputs', () => {
    test.each([
        [undefined, '1'],
        [true, '1'],
        [false, '0'],
    ])('numeric clamping %s retains native bounds and collected results', async (clampToBounds, expected) => {
        const popup = new Popup('x', POPUP_TYPE.TEXT, '', {
            customInputs: [{ id: 'contract-step', label: 'Step', type: 'number', defaultState: '1', min: 1, clampToBounds }],
        });
        const result = popup.show();
        const input = popup.dlg.querySelector('#contract-step');
        expect(input.min).toBe('1');
        input.value = '';
        input.dispatchEvent(new Event('change'));
        expect(input.value).toBe('');
        input.value = '0';
        input.dispatchEvent(new Event('change'));
        expect(input.value).toBe(expected);
        popup.okButton.click();
        await expect(result).resolves.toBe(POPUP_RESULT.AFFIRMATIVE);
        expect(popup.inputResults.get('contract-step')).toBe(expected);
    });

    test('inputResults are keyed by id for every input type', async () => {
        const popup = new Popup('x', POPUP_TYPE.CONFIRM, '', {
            customInputs: [
                { id: 'contract-check', label: 'Check', defaultState: true },
                { id: 'contract-text', label: 'Text', type: 'text', defaultState: 'abc' },
                { id: 'contract-area', label: 'Area', type: 'textarea', defaultState: 'long' },
                { id: 'contract-number', label: 'Number', type: 'number', defaultState: '3' },
            ],
        });
        const result = popup.show();
        popup.dlg.querySelector('#contract-check').checked = false;
        popup.dlg.querySelector('#contract-text').value = 'changed';
        popup.okButton.click();
        await result;
        expect(popup.inputResults).toEqual(new Map([
            ['contract-check', false],
            ['contract-text', 'changed'],
            ['contract-area', 'long'],
            ['contract-number', '3'],
        ]));
    });

    test('checkbox inputs are real checkboxes that keep their id and label text', () => {
        const popup = new Popup('x', POPUP_TYPE.CONFIRM, '', {
            customInputs: [{ id: 'contract-delete-chats', label: 'Also delete chat files', tooltip: 'Hint' }],
        });
        const input = popup.dlg.querySelector('#contract-delete-chats');
        expect(input).toBeInstanceOf(HTMLInputElement);
        expect(input.type).toBe('checkbox');
        expect(input.checked).toBe(false);
        expect(popup.inputControls.contains(input)).toBe(true);
        // jsdom has no innerText, which popup.js uses for the caption; the i18n key carries the same text.
        expect(input.closest('label').querySelector('[data-i18n="Also delete chat files"]')).not.toBeNull();
    });
});

describe('Popup closing lifecycle', () => {
    test('a falsy onClosing blocks the close, returns undefined and resets the result', async () => {
        let allow = false;
        const onClosing = jest.fn(() => allow);
        const popup = new Popup('x', POPUP_TYPE.CONFIRM, '', { onClosing });
        const shown = popup.show();
        await expect(popup.completeAffirmative()).resolves.toBeUndefined();
        expect(isShown(popup)).toBe(true);
        expect(popup.result).toBeUndefined();
        expect(popup.value).toBeUndefined();
        allow = true;
        popup.okButton.click();
        await expect(shown).resolves.toBe(POPUP_RESULT.AFFIRMATIVE);
        expect(onClosing).toHaveBeenCalledTimes(2);
    });

    test('onOpen runs after show; onClose runs before DOM removal; the promise resolves after removal', async () => {
        const events = [];
        const popup = new Popup('x', POPUP_TYPE.TEXT, '', {
            onOpen: () => events.push(['open', popup.dlg.isConnected]),
            onClose: () => events.push(['close', popup.dlg.isConnected]),
        });
        const result = popup.show();
        await settle();
        popup.okButton.click();
        await result;
        events.push(['resolved', popup.dlg.isConnected]);
        expect(events).toEqual([['open', true], ['close', true], ['resolved', false]]);
        expect(Popup.util.popups).not.toContain(popup);
        expect(Popup.util.lastResult).toEqual({ value: POPUP_RESULT.AFFIRMATIVE, result: POPUP_RESULT.AFFIRMATIVE, inputResults: undefined });
    });
});

describe('Popup focus', () => {
    test('the default response button is marked default and autofocused', () => {
        const popup = new Popup('x', POPUP_TYPE.CONFIRM);
        expect(popup.okButton.classList.contains('menu_button_default')).toBe(true);
        expect(popup.okButton.hasAttribute('autofocus')).toBe(true);
    });

    test('defaultResult NEGATIVE moves the default and autofocus to Cancel', () => {
        const popup = new Popup('x', POPUP_TYPE.CONFIRM, '', { defaultResult: POPUP_RESULT.NEGATIVE });
        expect(popup.cancelButton.classList.contains('menu_button_default')).toBe(true);
        expect(popup.cancelButton.hasAttribute('autofocus')).toBe(true);
        expect(popup.okButton.hasAttribute('autofocus')).toBe(false);
    });

    test('INPUT autofocuses the main input', () => {
        const popup = new Popup('x', POPUP_TYPE.INPUT);
        expect(popup.mainInput.hasAttribute('autofocus')).toBe(true);
    });

    test('a custom input with autoFocus takes focus over the default button', () => {
        const popup = new Popup('x', POPUP_TYPE.CONFIRM, '', {
            customInputs: [{ id: 'contract-focus', label: 'Focus', type: 'text', autoFocus: true }],
        });
        expect(popup.dlg.querySelector('#contract-focus').hasAttribute('autofocus')).toBe(true);
        expect(popup.okButton.hasAttribute('autofocus')).toBe(false);
    });

    test('setAutoFocus focuses the default button inside buttonControls', async () => {
        const popup = new Popup('x', POPUP_TYPE.CONFIRM);
        void popup.show();
        await settle();
        popup.okButton.removeAttribute('autofocus');
        popup.setAutoFocus();
        expect(document.activeElement).toBe(popup.okButton);
    });

    test('framed custom defaultResult is discoverable and focused after removing native autofocus', async () => {
        const popup = new Popup('x', POPUP_TYPE.CONFIRM, '', {
            tier: 'window', defaultResult: 7, customButtons: [{ text: 'Custom', result: 7 }],
        });
        void popup.show();
        await settle();
        const custom = popup.buttonControls.querySelector('[data-result="7"]');
        expect(custom).not.toBeNull();
        popup.dlg.querySelectorAll('[autofocus]').forEach(element => element.removeAttribute('autofocus'));
        popup.setAutoFocus();
        expect(document.activeElement).toBe(custom);
        expect(popup.buttonControls.querySelectorAll('[data-result]')).toHaveLength(3);
    });
});
