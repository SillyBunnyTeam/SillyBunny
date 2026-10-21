/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions. */
import { jest, describe, test, expect } from '@jest/globals';

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

function setupDialogMedia() {
    window.matchMedia ??= query => ({ matches: query.includes('450px') ? false : false, addEventListener() {}, removeEventListener() {} });
    HTMLDialogElement.prototype.showModal ??= function () { this.setAttribute('open', ''); };
    HTMLDialogElement.prototype.close ??= function () { this.removeAttribute('open'); };
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
        expect([...popupValue.buttonControls.children].map(button => button.textContent)).toEqual(['Save', 'Cancel']);
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
});
