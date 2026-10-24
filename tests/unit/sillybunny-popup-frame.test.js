/** @jest-environment jsdom */
/* global globalThis */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions. */
import { jest, describe, test, expect, afterEach } from '@jest/globals';

await jest.unstable_mockModule('../../public/scripts/sillybunny-action-menu.js', () => ({
    closeActionMenu: jest.fn(),
    openActionMenu: jest.fn(),
}));
await jest.unstable_mockModule('../../public/scripts/sillybunny-editor/picker.js', () => ({
    closePicker: jest.fn(),
}));
await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((text, part, index) => text + part + (values[index] ?? ''), ''),
}));

const { findLeadingHeading, framePopup, resolvePopupTier, shouldPromoteAlert } = await import('../../public/scripts/sillybunny-editor/popup-frame.js');
const POPUP_TYPE = { TEXT: 1, CONFIRM: 2, INPUT: 3, DISPLAY: 4 };
const POPUP_RESULT = { AFFIRMATIVE: 1, NEGATIVE: 0 };

afterEach(() => document.body.replaceChildren());

function popupDom({ type = POPUP_TYPE.CONFIRM, contentHtml = '', customInputs = [] } = {}) {
    const dlg = document.createElement('dialog');
    dlg.className = 'popup';
    const body = document.createElement('div');
    body.className = 'popup-body';
    const content = document.createElement('div');
    content.className = 'popup-content';
    content.innerHTML = contentHtml;
    const mainInput = document.createElement('textarea');
    mainInput.className = 'popup-input result-control';
    mainInput.rows = 1;
    const inputControls = document.createElement('div');
    inputControls.className = 'popup-inputs';
    for (const option of customInputs) {
        const label = document.createElement('label');
        label.className = 'checkbox_label';
        const input = document.createElement('input');
        input.id = option.id;
        input.type = 'checkbox';
        input.checked = Boolean(option.defaultState);
        const caption = document.createElement('span');
        caption.dataset.i18n = option.label;
        caption.textContent = option.label;
        label.append(input, caption);
        if (option.tooltip) label.title = option.tooltip;
        inputControls.append(label);
    }
    const buttonControls = document.createElement('div');
    buttonControls.className = 'popup-controls';
    const okButton = document.createElement('button');
    okButton.className = 'popup-button-ok menu_button';
    okButton.dataset.result = String(POPUP_RESULT.AFFIRMATIVE);
    okButton.textContent = 'Save';
    const cancelButton = document.createElement('button');
    cancelButton.className = 'popup-button-cancel menu_button';
    cancelButton.dataset.result = String(POPUP_RESULT.NEGATIVE);
    cancelButton.textContent = 'Cancel';
    const closeButton = document.createElement('button');
    closeButton.className = 'popup-button-close fa-circle-xmark';
    closeButton.dataset.result = String(POPUP_RESULT.NEGATIVE);
    buttonControls.append(okButton, cancelButton);
    if (type === POPUP_TYPE.TEXT) cancelButton.style.display = 'none';
    if (type === POPUP_TYPE.DISPLAY) {
        buttonControls.style.display = 'none';
        okButton.style.display = 'none';
        cancelButton.style.display = 'none';
        closeButton.style.display = 'block';
    }
    body.append(content, mainInput, inputControls);
    dlg.append(body, buttonControls, closeButton);
    document.body.append(dlg);
    return {
        type, dlg, body, content, mainInput, inputControls, buttonControls, okButton, cancelButton, closeButton,
        customInputs,
    };
}

function setupDialogMedia({ sheet = false } = {}) {
    window.matchMedia = () => ({ matches: sheet, addEventListener() {}, removeEventListener() {} });
    HTMLDialogElement.prototype.showModal ??= function () { this.setAttribute('open', ''); };
    HTMLDialogElement.prototype.close ??= function () { this.removeAttribute('open'); };
}

function pointerEvent(type, { x = 10, y = 10, id = 1, button = 0 } = {}) {
    return Object.assign(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button }), { pointerId: id, isPrimary: true });
}

function clickBackdrop(dialog) {
    dialog.dispatchEvent(pointerEvent('pointerdown'));
    dialog.dispatchEvent(pointerEvent('pointerup'));
    dialog.dispatchEvent(pointerEvent('click'));
}

function popup({ type = 2, content = '', classes = [], rows = 1, options = {} } = {}) {
    const body = document.createElement('div');
    const node = document.createElement('dialog');
    const contentNode = document.createElement('div');
    contentNode.className = 'popup-content';
    contentNode.innerHTML = content;
    const inputControls = document.createElement('div');
    const mainInput = document.createElement('textarea');
    mainInput.rows = rows;
    const dlg = node;
    dlg.className = ['popup', ...classes].join(' ');
    dlg.matches = dlg.matches.bind(dlg);
    body.append(contentNode, inputControls);
    dlg.append(body);
    Object.defineProperty(contentNode, 'scrollHeight', { configurable: true, value: options.scrollHeight ?? 0 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: options.innerHeight ?? 900 });
    return { type, dlg, body, content: contentNode, inputControls, mainInput, ...options };
}

describe('Popup tier resolution', () => {
    test('explicit tier wins over all inferred flags', () => {
        const value = popup({ classes: ['large_dialogue_popup'], options: { tier: 'alert' } });
        expect(resolvePopupTier(value, value.tier)).toBe('alert');
    });

    test('special frames are excluded unless explicitly promoted', () => {
        expect(resolvePopupTier(popup({ classes: ['transparent_dialogue_popup'] }))).toBeNull();
        expect(resolvePopupTier(popup({ content: '<div class="img_enlarged_container"></div>' }))).toBeNull();
        expect(resolvePopupTier(popup({ classes: ['wide_dialogue_popup'] }))).toBe('dialog');
        expect(resolvePopupTier(popup({ classes: ['large_dialogue_popup'] }))).toBe('window');
    });

    test('promotion turns controls, multiline inputs and tall content into Dialogs', () => {
        expect(resolvePopupTier(popup({ content: '<label><input type="checkbox"></label><label><input type="checkbox"></label>' }))).toBe('dialog');
        expect(resolvePopupTier(popup({ content: '<select><option>One</option></select>' }))).toBe('dialog');
        expect(resolvePopupTier(popup({ type: 3, content: '<p>Prompt</p>', rows: 4 }))).toBe('dialog');
        expect(resolvePopupTier(popup({ content: '<p>Long</p>', options: { scrollHeight: 451, innerHeight: 900 } }))).toBe('dialog');
    });

    test('one checkbox remains an Alert', () => {
        const value = popup({ content: '<label><input type="checkbox"></label>' });
        expect(shouldPromoteAlert(value)).toBe(false);
        expect(resolvePopupTier(value)).toBe('alert');
    });
});

describe('Popup heading promotion', () => {
    test('promotes the first leading h2/h3/header and rejects content before it', () => {
        const content = document.createElement('div');
        content.innerHTML = '<h2 data-i18n="Title">Title</h2><p>Body</p>';
        expect(findLeadingHeading(content)).toBe(content.querySelector('h2'));

        const blocked = document.createElement('div');
        blocked.innerHTML = '<p>Intro</p><h3>Title</h3>';
        expect(findLeadingHeading(blocked)).toBeNull();
    });
});

describe('Popup frame adapter', () => {
    test('Alert replaces the translated default negative response and preserves custom responses', () => {
        setupDialogMedia();
        const template = document.createElement('template');
        template.id = 'popup_template';
        template.setAttribute('popup-button-no', 'No');
        document.body.append(template);

        const defaultPopup = popupDom();
        defaultPopup.cancelButton.textContent = 'No';
        const defaultFrame = framePopup(defaultPopup);
        defaultPopup.dlg.showModal();
        defaultFrame.opened();
        expect(defaultPopup.cancelButton.textContent).toBe('Cancel');
        defaultFrame.dispose();

        const customPopup = popupDom();
        customPopup.cancelButton.textContent = 'Keep';
        const customFrame = framePopup(customPopup, { cancelButtonProvided: true });
        customPopup.dlg.showModal();
        customFrame.opened();
        expect(customPopup.cancelButton.textContent).toBe('Keep');
        customFrame.dispose();
    });

    test('Alert keeps its leading heading in the body and adopts one checkbox as an extra switch row', () => {
        setupDialogMedia();
        const popupValue = popupDom({ contentHtml: '<h3>Delete Character?</h3><p>Permanent.</p><label class="checkbox_label"><input id="delete-chat-files" type="checkbox"><small data-i18n="Also delete chat files">Also delete chat files</small></label>' });
        const checkbox = popupValue.content.querySelector('#delete-chat-files');
        const frame = framePopup(popupValue);
        popupValue.dlg.showModal();
        frame.opened();
        expect(popupValue.dlg.classList.contains('sb-dialog--alert')).toBe(true);
        expect(popupValue.content.querySelector('.sb-dialog__heading')).toBe(popupValue.content.querySelector('h3'));
        expect(popupValue.dlg.getAttribute('aria-labelledby')).toBe(popupValue.content.querySelector('h3').id);
        expect(popupValue.dlg.getAttribute('aria-describedby')).toBe(popupValue.content.id);
        expect(checkbox.closest('.ds-row-switch')).not.toBeNull();
        expect(checkbox.id).toBe('delete-chat-files');
        expect(checkbox.classList.contains('sb-switch')).toBe(true);
        expect(checkbox.getAttribute('role')).toBe('switch');
        expect(popupValue.body.querySelector('.sb-dialog__extra')).not.toBeNull();
        expect(popupValue.buttonControls.parentElement).toBe(popupValue.dlg);
        expect(popupValue.closeButton.style.display).toBe('none');
        frame.dispose();
    });

    test('Dialog moves the first heading itself to its header, keeps i18n and puts Cancel before Save', () => {
        setupDialogMedia();
        const popupValue = popupDom({ contentHtml: '<h3 data-i18n="Install Extension">Install Extension</h3><p>Details</p>' });
        const heading = popupValue.content.querySelector('h3');
        const frame = framePopup(popupValue, { tier: 'dialog' });
        popupValue.dlg.showModal();
        frame.opened();
        expect(heading.closest('.sb-dialog__header')).not.toBeNull();
        expect(heading.dataset.i18n).toBe('Install Extension');
        expect(popupValue.dlg.getAttribute('aria-labelledby')).toBe(heading.id);
        expect(popupValue.buttonControls.parentElement.classList.contains('sb-dialog__header')).toBe(true);
        expect([...popupValue.buttonControls.querySelectorAll('.menu_button')].map(button => button.textContent)).toEqual(['Save', 'Cancel']);
        expect(popupValue.closeButton.style.display).toBe('none');
        frame.dispose();
    });

    test('OK-only TEXT hides OK and header Close clicks OK; DISPLAY close stays NEGATIVE', () => {
        setupDialogMedia();
        const text = popupDom({ type: POPUP_TYPE.TEXT, contentHtml: '<h3>Information</h3><p>Details</p>' });
        text.cancelButton.style.display = 'none';
        const textFrame = framePopup(text, { tier: 'dialog' });
        text.dlg.showModal();
        textFrame.opened();
        expect(text.okButton.style.display).toBe('none');
        expect(text.closeButton.classList.contains('sb-dialog__close')).toBe(true);
        const complete = jest.fn();
        text.okButton.addEventListener('click', complete);
        text.closeButton.click();
        expect(complete).toHaveBeenCalledTimes(1);
        textFrame.dispose();

        const display = popupDom({ type: POPUP_TYPE.DISPLAY, contentHtml: '<p>Details</p>' });
        display.buttonControls.style.display = 'none';
        display.okButton.style.display = 'none';
        display.cancelButton.style.display = 'none';
        display.closeButton.style.display = 'block';
        const displayFrame = framePopup(display, { tier: 'dialog' });
        display.dlg.showModal();
        displayFrame.opened();
        expect(display.closeButton.dataset.result).toBe(String(POPUP_RESULT.NEGATIVE));
        expect(display.closeButton.classList.contains('sb-dialog__close')).toBe(true);
        displayFrame.dispose();
    });

    test('customInputs checkbox keeps its id and becomes a switch row', () => {
        setupDialogMedia();
        const popupValue = popupDom({ customInputs: [{ id: 'custom-delete', label: 'Also delete files' }] });
        const input = popupValue.inputControls.querySelector('#custom-delete');
        const frame = framePopup(popupValue);
        popupValue.dlg.showModal();
        frame.opened();
        expect(input.closest('.ds-row-switch')).not.toBeNull();
        expect(input.id).toBe('custom-delete');
        expect(input.getAttribute('role')).toBe('switch');
        frame.dispose();
    });

    test('plain DISPLAY always has a working header Close, including an explicit Alert request', () => {
        setupDialogMedia();
        for (const tier of [null, 'alert']) {
            const value = popupDom({ type: POPUP_TYPE.DISPLAY, contentHtml: '<p>Read-only content</p>' });
            const close = jest.fn();
            value.closeButton.addEventListener('click', close);
            const frame = framePopup(value, { tier });
            value.dlg.showModal();
            frame.opened();
            expect(value.dlg.classList.contains('sb-dialog--dialog')).toBe(true);
            expect(value.closeButton.style.display).not.toBe('none');
            expect(value.closeButton.parentElement.classList.contains('sb-dialog__header')).toBe(true);
            expect(value.buttonControls.contains(value.closeButton)).toBe(false);
            value.closeButton.click();
            expect(close).toHaveBeenCalledTimes(1);
            frame.dispose();
        }
    });

    test('custom default responses stay inside buttonControls and receive autofocus', () => {
        setupDialogMedia();
        const value = popupDom();
        const custom = document.createElement('button');
        custom.className = 'popup-button-custom';
        custom.dataset.result = '7';
        value.buttonControls.prepend(custom);
        value.setAutoFocus = () => value.buttonControls.querySelector('[data-result="7"]').focus();
        const frame = framePopup(value, { tier: 'window' });
        value.dlg.showModal();
        frame.opened();
        expect([...value.buttonControls.querySelectorAll('[data-result]')]).toEqual(expect.arrayContaining([custom, value.okButton, value.cancelButton]));
        expect(custom.closest('.sb-dialog__bottom-bar')).not.toBeNull();
        expect(document.activeElement).toBe(custom);
        expect(value.okButton.compareDocumentPosition(value.cancelButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        frame.dispose();
    });

    test.each([
        { sheet: false, allowEscapeClose: true, expected: 1 },
        { sheet: true, allowEscapeClose: true, expected: 0 },
        { sheet: false, allowEscapeClose: false, expected: 0 },
    ])('backdrop clicks cancel only closable floating popups: %o', ({ sheet, allowEscapeClose, expected }) => {
        setupDialogMedia({ sheet });
        const value = popupDom();
        value.dlg.getBoundingClientRect = () => ({ left: 100, right: 400, top: 100, bottom: 400 });
        const cancel = jest.fn(event => event.preventDefault());
        value.dlg.addEventListener('cancel', cancel);
        const frame = framePopup(value, { allowEscapeClose });
        value.dlg.showModal();
        frame.opened();
        value.dlg.dispatchEvent(new MouseEvent('click', { clientX: 150, clientY: 150 }));
        value.content.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 10, clientY: 10 }));
        expect(cancel).not.toHaveBeenCalled();
        clickBackdrop(value.dlg);
        expect(cancel).toHaveBeenCalledTimes(expected);
        frame.dispose();
    });

    test('pushed pages ignore backdrop clicks', () => {
        setupDialogMedia();
        const parent = popupDom();
        const parentFrame = framePopup(parent, { tier: 'window' });
        parent.dlg.showModal();
        parentFrame.opened();
        const child = popupDom();
        const cancel = jest.fn();
        child.dlg.addEventListener('cancel', cancel);
        const childFrame = framePopup(child, { tier: 'dialog' });
        child.dlg.showModal();
        childFrame.opened();
        expect(child.dlg.classList.contains('sb-dialog--page')).toBe(true);
        clickBackdrop(child.dlg);
        expect(cancel).not.toHaveBeenCalled();
        childFrame.dispose();
        parentFrame.dispose();
    });

    test.each(['inside start', 'inside release', 'cancelled', 'different pointer', 'secondary button'])('backdrop ignores a %s pointer sequence', sequence => {
        setupDialogMedia();
        const value = popupDom();
        value.dlg.getBoundingClientRect = () => ({ left: 100, right: 400, top: 100, bottom: 400 });
        const cancel = jest.fn();
        value.dlg.addEventListener('cancel', cancel);
        const frame = framePopup(value, { tier: 'dialog' });
        value.dlg.showModal();
        frame.opened();
        const origin = sequence === 'inside start' ? value.content : value.dlg;
        origin.dispatchEvent(pointerEvent('pointerdown', { button: sequence === 'secondary button' ? 2 : 0 }));
        if (sequence === 'cancelled') value.dlg.dispatchEvent(pointerEvent('pointercancel'));
        value.dlg.dispatchEvent(pointerEvent('pointerup', {
            x: sequence === 'inside release' ? 150 : 10,
            y: sequence === 'inside release' ? 150 : 10,
            id: sequence === 'different pointer' ? 2 : 1,
        }));
        value.dlg.dispatchEvent(pointerEvent('click'));
        expect(cancel).not.toHaveBeenCalled();
        frame.dispose();
    });

    test.each(['alert', 'dialog'])('%s boolean adoption keeps caller selectors and delegated listeners', tier => {
        setupDialogMedia();
        const value = popupDom({ contentHtml: '<label class="checkbox_label"><input id="delegated-option" type="checkbox"><span>Keep data</span></label>' });
        const label = value.content.querySelector('label.checkbox_label');
        const delegated = jest.fn();
        const listener = event => {
            if (event.target.matches('.checkbox_label input')) delegated(event);
        };
        document.addEventListener('change', listener);
        const frame = framePopup(value, { tier });
        try {
            value.dlg.showModal();
            frame.opened();
            expect(value.dlg.querySelector('label.checkbox_label')).toBe(label);
            expect(label.matches('.ds-row-switch')).toBe(true);
            expect(Boolean(label.closest('.sb-dialog__extra'))).toBe(tier === 'alert');
            label.querySelector('input').dispatchEvent(new Event('change', { bubbles: true }));
            expect(delegated).toHaveBeenCalledTimes(1);
        } finally {
            document.removeEventListener('change', listener);
            frame.dispose();
        }
    });

    test('header and footer reservations use untransformed layout dimensions', () => {
        setupDialogMedia();
        const value = popupDom();
        Object.defineProperty(value.okButton, 'offsetWidth', { value: 120 });
        value.okButton.getBoundingClientRect = () => ({ width: 96 });
        const custom = document.createElement('button');
        custom.className = 'popup-button-custom';
        value.buttonControls.prepend(custom);
        const height = jest.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(60);
        const frame = framePopup(value, { tier: 'dialog' });
        try {
            value.dlg.showModal();
            frame.opened();
            expect(value.dlg.querySelector('.sb-dialog__header').style.getPropertyValue('--sb-dialog-header-side')).toBe('120px');
            expect(value.dlg.style.getPropertyValue('--sb-popup-response-height')).toBe('60px');
        } finally {
            frame.dispose();
            height.mockRestore();
        }
    });

    test('Dialog adopts a plain boolean without losing identity, state, caption or listeners', () => {
        setupDialogMedia();
        const value = popupDom({ contentHtml: '<h3>Delete user</h3><label class="checkbox_label"><input id="purge" name="deleteUserData" type="checkbox" checked><span data-i18n="Delete data">Delete data</span></label><input name="deleteUserHandle">' });
        const input = value.content.querySelector('#purge');
        const label = input.parentElement;
        const onInput = jest.fn();
        const onLabelInput = jest.fn();
        input.addEventListener('input', onInput);
        label.addEventListener('input', onLabelInput);
        const frame = framePopup(value);
        value.dlg.showModal();
        frame.opened();
        expect(value.dlg.classList.contains('sb-dialog--dialog')).toBe(true);
        expect(value.content.querySelector('.ds-row-switch > input')).toBe(input);
        expect(input.parentElement).toBe(label);
        expect(input.name).toBe('deleteUserData');
        expect(input.checked).toBe(true);
        expect(value.content.querySelector('.ds-row-label > span').dataset.i18n).toBe('Delete data');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        expect(onInput).toHaveBeenCalledTimes(1);
        expect(onLabelInput).toHaveBeenCalledTimes(1);
        frame.dispose();
    });

    test('Dialog leaves custom forms, existing rows and composite checkbox labels alone', () => {
        setupDialogMedia();
        const value = popupDom({ contentHtml: '<form><label class="checkbox_label"><input type="checkbox"></label></form><div class="ds-row"><label class="checkbox_label"><input type="checkbox"></label></div><label class="checkbox_label"><input type="checkbox"><input type="checkbox"></label>' });
        const labels = [...value.content.querySelectorAll('label')];
        const frame = framePopup(value, { tier: 'dialog' });
        value.dlg.showModal();
        frame.opened();
        expect([...value.content.querySelectorAll('label')]).toEqual(labels);
        expect(value.content.querySelector('.ds-row-switch')).toBeNull();
        frame.dispose();
    });

    test.each(['custom', 'plain'])('teardown removes the adopted %s switch listener without removing caller listeners', source => {
        setupDialogMedia();
        const value = popupDom(source === 'custom'
            ? { customInputs: [{ id: 'qa-cleanup', label: 'Retain data' }] }
            : { contentHtml: '<label class="checkbox_label"><input id="qa-cleanup" type="checkbox"><span>Retain data</span></label>' });
        const input = value.dlg.querySelector('#qa-cleanup');
        const caller = jest.fn();
        input.addEventListener('change', caller);
        const add = jest.spyOn(input, 'addEventListener');
        const remove = jest.spyOn(input, 'removeEventListener');
        const frame = framePopup(value, { tier: 'dialog' });
        value.dlg.showModal();
        frame.opened();
        const notify = add.mock.calls.find(([type]) => type === 'change')[1];
        frame.dispose();
        expect(remove).toHaveBeenCalledWith('change', notify);
        input.dispatchEvent(new Event('change'));
        expect(caller).toHaveBeenCalledTimes(1);
    });

    test('teardown disconnects the header and custom-response measurement observers', () => {
        setupDialogMedia();
        const previousObserver = globalThis.ResizeObserver;
        const observers = [];
        globalThis.ResizeObserver = class {
            observe = jest.fn();
            disconnect = jest.fn();
            constructor() { observers.push(this); }
        };
        try {
            const value = popupDom({ contentHtml: '<h3>Responses</h3>' });
            const custom = document.createElement('button');
            custom.className = 'popup-button-custom';
            value.buttonControls.prepend(custom);
            const frame = framePopup(value, { tier: 'dialog' });
            value.dlg.showModal();
            frame.opened();
            expect(observers).toHaveLength(2);
            frame.dispose();
            for (const observer of observers) expect(observer.disconnect).toHaveBeenCalledTimes(1);
        } finally {
            globalThis.ResizeObserver = previousObserver;
        }
    });

    test('teardown lets hosted layers close before any surviving cached layers are released', () => {
        setupDialogMedia();
        const value = popupDom();
        const frame = framePopup(value, { tier: 'dialog' });
        value.dlg.showModal();
        frame.opened();
        const sheet = document.createElement('dialog');
        sheet.dataset.sbOverlayLayer = '';
        const cached = document.createElement('div');
        cached.dataset.sbOverlayLayer = '';
        value.dlg.append(sheet, cached);
        sheet.showModal();
        sheet.addEventListener('sb-overlay-host-closing', () => {
            sheet.close();
            sheet.remove();
        });
        frame.closing();
        expect(sheet.isConnected).toBe(false);
        expect(sheet.hasAttribute('open')).toBe(false);
        expect(cached.parentElement).toBe(document.body);
        frame.dispose();
    });
});
