/** @jest-environment jsdom */
/* eslint-disable playwright/prefer-web-first-assertions -- Jest/jsdom assertions are synchronous. */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

let popup;
class FakePopup {
    constructor(text, type, value, options) {
        popup = this;
        this.options = options;
        this.dlg = document.createElement('dialog');
        this.content = document.createElement('div');
        this.content.textContent = text;
        this.okButton = document.createElement('button');
        this.cancelButton = document.createElement('button');
        this.dlg.append(this.content, this.cancelButton, this.okButton);
        this.okButton.addEventListener('click', () => this.complete(1));
        this.cancelButton.addEventListener('click', () => this.complete(0));
    }
    show() {
        document.body.append(this.dlg);
        (this.options.defaultResult === 0 ? this.cancelButton : this.okButton).focus();
        return new Promise(resolve => { this.resolve = resolve; });
    }
    complete(result) { this.resolve(result); }
}
jest.unstable_mockModule('../../public/scripts/popup.js', () => ({
    Popup: FakePopup, POPUP_TYPE: { CONFIRM: 1 }, POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null },
}));
jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({ t: strings => strings.join('') }));
const { confirmDestructiveAction } = await import('../../public/scripts/sillybunny-delete-confirm.js');

beforeEach(() => document.body.replaceChildren());

describe('confirmDestructiveAction', () => {
    test('defaults to Cancel and marks the explicit destructive response', async () => {
        const result = confirmDestructiveAction({ text: 'Delete?', confirmLabel: 'Delete' });
        expect(popup.options.defaultResult).toBe(0);
        expect(document.activeElement).toBe(popup.cancelButton);
        expect(popup.options.cancelButton).toBe('Cancel');
        expect(popup.options.okButton).toBe('Delete');
        expect(popup.dlg.classList.contains('sb-popup-destructive-confirm')).toBe(true);
        expect(popup.okButton.classList.contains('sb-popup-destructive')).toBe(true);
        popup.cancelButton.click();
        await expect(result).resolves.toBe(false);
    });

    test('Return cannot confirm even when the destructive response has focus', async () => {
        const result = confirmDestructiveAction({ text: 'Delete?', confirmLabel: 'Delete' });
        popup.okButton.focus();
        const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
        popup.okButton.dispatchEvent(enter);
        expect(enter.defaultPrevented).toBe(true);
        await expect(result).resolves.toBe(false);
    });

    test('only explicit affirmative activation returns true', async () => {
        const result = confirmDestructiveAction({ text: 'Delete?', confirmLabel: 'Delete' });
        popup.okButton.click();
        await expect(result).resolves.toBe(true);
    });

    test('dismissal returns false and placeholder copy is marked', async () => {
        const result = confirmDestructiveAction({ text: 'lorum ipsum', confirmLabel: 'Delete', copyPlaceholder: true });
        expect(popup.content.dataset.sbCopyPlaceholder).toBe('true');
        popup.complete(null);
        await expect(result).resolves.toBe(false);
    });
});
