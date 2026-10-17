/*
 * Conversation mode dialogs on the shared Popup, replacing native prompt()/confirm().
 * Confirms follow the delete-confirm pattern: Cancel first and focused, the action in Destructive Red.
 */

import { t } from '../i18n.js';
import { POPUP_RESULT, POPUP_TYPE, Popup } from '../popup.js';

function buildContent(title, text) {
    const wrapper = document.createElement('div');
    wrapper.className = 'sb-conversation-dialog-copy';
    if (title) {
        const heading = document.createElement('h3');
        heading.textContent = title;
        wrapper.append(heading);
    }
    if (text) {
        const body = document.createElement('p');
        body.textContent = text;
        wrapper.append(body);
    }
    return wrapper;
}

/**
 * @param {object} options
 * @param {string} options.title
 * @param {string} [options.text]
 * @param {string} [options.defaultValue]
 * @param {string} [options.placeholder]
 * @param {string} [options.confirmLabel]
 * @param {number} [options.rows]
 * @returns {Promise<string|null>} The entered text, or null when cancelled.
 */
export async function promptConversationText({ title, text = '', defaultValue = '', placeholder = '', confirmLabel = t`Save`, rows = 1 }) {
    const popup = new Popup(buildContent(title, text), POPUP_TYPE.INPUT, defaultValue, {
        okButton: confirmLabel,
        cancelButton: t`Cancel`,
        placeholder,
        rows,
    });
    popup.dlg.classList.add('sb-conversation-dialog');
    const value = await popup.show();
    if (value === '') {
        return '';
    }
    return typeof value === 'string' ? value : null;
}

/**
 * @param {object} options
 * @param {string} options.title
 * @param {string} [options.text]
 * @param {string} [options.confirmLabel]
 * @param {boolean} [options.destructive]
 * @returns {Promise<boolean>}
 */
export async function confirmConversationAction({ title, text = '', confirmLabel = t`Delete`, destructive = true }) {
    const popup = new Popup(buildContent(title, text), POPUP_TYPE.CONFIRM, null, {
        okButton: confirmLabel,
        cancelButton: t`Cancel`,
        defaultResult: destructive ? POPUP_RESULT.NEGATIVE : POPUP_RESULT.AFFIRMATIVE,
    });
    popup.dlg.classList.add('sb-conversation-dialog');
    if (destructive) {
        popup.dlg.classList.add('sb-popup-destructive-confirm');
        popup.okButton.classList.add('sb-popup-destructive');
    }
    return await popup.show() === POPUP_RESULT.AFFIRMATIVE;
}
