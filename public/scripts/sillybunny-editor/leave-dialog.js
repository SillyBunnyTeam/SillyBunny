// SillyBunny: the one unsaved-changes dialog every explicit-save editor asks before it is left.
// Cancel · Discard (Destructive Red, `.sb-editor-discard`) · Save (the suggested response). The theme orders
// `.popup-button-cancel` first and `.popup-button-ok` last, and the custom Discard button sits between them.

import { Popup, POPUP_TYPE, POPUP_RESULT } from '../popup.js';
import { t } from '../i18n.js';

export const LEAVE_DISCARD_RESULT = 2;

/**
 * Asks what to do with unsaved changes. Cancel is the default response, so Escape and a click outside keep the user in place.
 * @returns {Promise<'save'|'discard'|'cancel'>}
 */
export async function askLeaveEditor() {
    const message = document.createElement('p');
    message.textContent = t`You have unsaved changes`;
    const popup = new Popup(message, POPUP_TYPE.CONFIRM, '', {
        okButton: t`Save`,
        cancelButton: t`Cancel`,
        customButtons: [{ text: t`Discard`, result: LEAVE_DISCARD_RESULT, classes: ['sb-editor-discard'] }],
        defaultResult: POPUP_RESULT.NEGATIVE,
    });
    const result = await popup.show();
    if (result === POPUP_RESULT.AFFIRMATIVE) return 'save';
    if (result === LEAVE_DISCARD_RESULT) return 'discard';
    return 'cancel';
}
