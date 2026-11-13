/** @jest-environment jsdom */
/* eslint-disable playwright/prefer-web-first-assertions -- Jest/jsdom assertions are synchronous. */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

const popupShow = jest.fn();
const PopupCtor = jest.fn().mockImplementation(function () {
    this.show = popupShow;
});

await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((out, part, index) => out + part + (index < values.length ? values[index] : ''), ''),
}));
await jest.unstable_mockModule('../../public/scripts/popup.js', () => ({
    POPUP_TYPE: { CONFIRM: 'confirm' },
    POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 0 },
    Popup: PopupCtor,
}));

const { askLeaveEditor, LEAVE_DISCARD_RESULT } = await import('../../public/scripts/sillybunny-editor/leave-dialog.js');

describe('askLeaveEditor', () => {
    beforeEach(() => {
        popupShow.mockReset();
        PopupCtor.mockClear();
    });

    test('offers Cancel, Discard and Save, with Cancel as the default and Discard in the destructive class', async () => {
        popupShow.mockResolvedValue(0);
        await askLeaveEditor();
        const [content, type, , options] = PopupCtor.mock.calls[0];
        expect(content.textContent).toBe('You have unsaved changes');
        expect(type).toBe('confirm');
        expect(options.okButton).toBe('Save');
        expect(options.cancelButton).toBe('Cancel');
        expect(options.defaultResult).toBe(0);
        expect(options.customButtons).toEqual([{ text: 'Discard', result: LEAVE_DISCARD_RESULT, classes: ['sb-editor-discard'] }]);
    });

    test.each([
        [1, 'save'],
        [LEAVE_DISCARD_RESULT, 'discard'],
        [0, 'cancel'],
        [null, 'cancel'],
        [undefined, 'cancel'],
    ])('maps popup result %p to %s', async (result, expected) => {
        popupShow.mockResolvedValue(result);
        await expect(askLeaveEditor()).resolves.toBe(expected);
    });
});
