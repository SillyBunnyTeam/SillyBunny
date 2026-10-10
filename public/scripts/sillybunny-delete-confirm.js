/*
 * Message deletion confirmation (DESIGN.md "Message Actions" > Delete): an alert dialog with
 * Cancel first and focused, the destructive responses in Destructive Red, so Return cancels.
 */

import { t } from './i18n.js';
import { POPUP_RESULT, POPUP_TYPE, Popup } from './popup.js';

export const DELETE_CHOICE = Object.freeze({
    MESSAGE: 'message',
    SWIPE: 'swipe',
});

/**
 * @param {object} [options]
 * @param {string} [options.text]
 * @param {string} [options.confirmLabel]
 * @param {boolean} [options.canDeleteSwipe] - Adds a "Delete Swipe" response.
 * @returns {Promise<string|null>} One of DELETE_CHOICE, or null when cancelled.
 */
export async function confirmMessageDeletion({ text = t`Are you sure you want to delete this message?`, confirmLabel = t`Delete Message`, canDeleteSwipe = false } = {}) {
    const popup = new Popup(text, POPUP_TYPE.CONFIRM, null, {
        okButton: confirmLabel,
        cancelButton: t`Cancel`,
        customButtons: canDeleteSwipe
            ? [{ text: t`Delete Swipe`, result: POPUP_RESULT.CUSTOM1, classes: ['sb-popup-destructive'] }]
            : null,
        defaultResult: POPUP_RESULT.NEGATIVE,
    });
    popup.dlg.classList.add('sb-popup-destructive-confirm');
    popup.okButton.classList.add('sb-popup-destructive');
    const result = await popup.show();
    if (result === POPUP_RESULT.AFFIRMATIVE) {
        return DELETE_CHOICE.MESSAGE;
    }
    if (result === POPUP_RESULT.CUSTOM1) {
        return DELETE_CHOICE.SWIPE;
    }
    return null;
}
