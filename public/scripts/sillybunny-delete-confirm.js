/*
 * Message deletion confirmation: an alert dialog with Cancel first and focused, and the
 * destructive responses in the destructive colour, so Return cancels.
 */

import { t } from './i18n.js';
import { POPUP_RESULT, POPUP_TYPE, Popup } from './popup.js';

export const DELETE_CHOICE = Object.freeze({
    MESSAGE: 'message',
    SWIPE: 'swipe',
});

/**
 * Popup options for an upstream confirm that would otherwise show the generic "Yes". An upstream call site spreads
 * the result into its options, so the label stays at the call site and the destructive rule lives here.
 * @param {string} label The affirmative response, a verb for the action.
 * @param {object} [options]
 * @param {boolean} [options.destructive] Cancel is the default response and OK is drawn in the destructive colour.
 * @param {string} [options.negative] Label of the negative response. Setting it stops the frame from renaming that
 * response to "Cancel", which is wrong where the negative means "do not do this part" and the flow goes on.
 * @returns {{ okButton: string, cancelButton?: string, defaultResult?: number, onOpening?: (popup: Popup) => void }}
 */
export function confirmVerb(label, { destructive = false, negative = null } = {}) {
    const options = { okButton: label };
    if (negative) options.cancelButton = negative;
    if (destructive) {
        options.defaultResult = POPUP_RESULT.NEGATIVE;
        // `onOpening` runs before the first paint, so OK is never drawn in the suggested colour first.
        options.onOpening = popup => popup.okButton.classList.add('is-destructive');
    }
    return options;
}

export async function confirmDestructiveAction({ text, confirmLabel, heading = null, copyPlaceholder = false }) {
    const popup = new Popup(text, POPUP_TYPE.CONFIRM, null, {
        okButton: confirmLabel,
        cancelButton: t`Cancel`,
        defaultResult: POPUP_RESULT.NEGATIVE,
        title: heading,
    });
    popup.dlg.classList.add('sb-popup-destructive-confirm');
    // `is-destructive` carries the shared Destructive Red fill; `sb-popup-destructive` stays for callers that query it.
    popup.okButton.classList.add('sb-popup-destructive', 'is-destructive');
    if (copyPlaceholder) popup.content.dataset.sbCopyPlaceholder = 'true';
    const cancelOnReturn = event => {
        if (event.key !== 'Enter' || event.isComposing) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        void popup.complete(POPUP_RESULT.NEGATIVE);
    };
    popup.dlg.addEventListener('keydown', cancelOnReturn, true);
    try {
        return await popup.show() === POPUP_RESULT.AFFIRMATIVE;
    } finally {
        popup.dlg.removeEventListener('keydown', cancelOnReturn, true);
    }
}

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
    popup.okButton.classList.add('sb-popup-destructive', 'is-destructive');
    const result = await popup.show();
    if (result === POPUP_RESULT.AFFIRMATIVE) {
        return DELETE_CHOICE.MESSAGE;
    }
    if (result === POPUP_RESULT.CUSTOM1) {
        return DELETE_CHOICE.SWIPE;
    }
    return null;
}
