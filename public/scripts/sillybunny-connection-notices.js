import { t } from './i18n.js';
import { fixToastrForDialogs } from './popup.js';
import { openShellTarget } from './sillybunny-home/shell-targets.js';

/** Marks the body of each notice, so a test or a stylesheet can find it without depending on its wording. */
export const CONNECTION_NOTICE_KINDS = Object.freeze({
    notConnected: 'not-connected',
    missingKey: 'missing-key',
});

/**
 * @param {string} kind One of {@link CONNECTION_NOTICE_KINDS}.
 * @param {string} text
 * @returns {HTMLDivElement}
 */
function createNoticeBody(kind, text) {
    const body = document.createElement('div');
    body.className = 'sb-connection-notice-body';
    body.dataset.sbConnectionNotice = kind;
    body.textContent = text;
    return body;
}

/** @type {Map<string, JQuery>} Notices on screen, by title. */
const liveNotices = new Map();

/**
 * @param {string} title
 * @returns {boolean} True while a notice with this title is still on screen.
 */
function isNoticeLive(title) {
    return Boolean(liveNotices.get(title)?.[0]?.isConnected);
}

/**
 * Shows a notice. Callers check {@link isNoticeLive} first, so that pressing Send again does not stack a copy
 * or replace a toast the user is about to press.
 * @param {HTMLElement} message
 * @param {string} title
 * @param {typeof globalThis.toastr} toast
 */
function showNotice(message, title, toast) {
    const shown = toast.warning(message, title, {
        timeOut: 8000,
        extendedTimeOut: 4000,
        closeButton: true,
        escapeHtml: false,
        onHidden: () => {
            liveNotices.delete(title);
            // A per-toast onHidden replaces the global one, which keeps the toast container alive inside open dialogs.
            fixToastrForDialogs();
        },
    });
    liveNotices.set(title, shown);
    return shown;
}

/**
 * Tells the user that Send did nothing because no API is connected, and offers to open Connections.
 * @param {object} [deps]
 * @param {typeof globalThis.toastr} [deps.toast]
 * @param {(target: string) => unknown} [deps.openTarget]
 */
export function notifyNotConnected({ toast = globalThis.toastr, openTarget = openShellTarget } = {}) {
    const title = t`Not connected to API!`;
    if (isNoticeLive(title)) {
        return;
    }

    const body = createNoticeBody(CONNECTION_NOTICE_KINDS.notConnected, t`Your message wasn't sent. Connect a model first, then send it again.`);

    const showMe = document.createElement('button');
    showMe.type = 'button';
    showMe.className = 'menu_button';
    showMe.style.whiteSpace = 'nowrap';
    showMe.textContent = t`Show Me`;

    const message = document.createElement('div');
    message.append(body, showMe);

    const shown = showNotice(message, title, toast);
    showMe.addEventListener('click', () => {
        toast.clear(shown, { force: true });
        openTarget('connections');
    }, { once: true });
}

/**
 * Answers Connect pressed with an empty key: marks the key field, moves focus into it and says what is missing.
 * The mark clears as soon as the user types, so the field does not stay red while they fix it.
 * @param {Element | null | undefined} keyInput The key field of the selected source.
 * @param {object} [deps]
 * @param {typeof globalThis.toastr} [deps.toast]
 */
export function flagMissingKey(keyInput, { toast = globalThis.toastr } = {}) {
    if (keyInput instanceof HTMLElement) {
        keyInput.setAttribute('aria-invalid', 'true');
        keyInput.addEventListener('input', () => keyInput.removeAttribute('aria-invalid'), { once: true });
        keyInput.focus();
    }

    const title = t`Missing key`;
    if (isNoticeLive(title)) {
        return;
    }
    showNotice(createNoticeBody(CONNECTION_NOTICE_KINDS.missingKey, t`Enter your API key, then press Connect.`), title, toast);
}
