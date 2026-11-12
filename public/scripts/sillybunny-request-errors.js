import { t } from './i18n.js';
import { extractProviderMessage } from './sillybunny-provider-message.js';

export { extractProviderMessage };

/** The kinds of failure that a status code points at. Each has one hint for what the user can do. */
export const REQUEST_ERROR_HINT_KINDS = Object.freeze({
    key: 'key',
    model: 'model',
    rate: 'rate',
    down: 'down',
});

/**
 * @param {number} status HTTP status of the failed response, or 0 when the failure was not an HTTP error.
 * @returns {string} The hint kind for this status, or an empty string when no hint fits.
 */
export function hintKindFor(status) {
    if (status === 401 || status === 403) {
        return REQUEST_ERROR_HINT_KINDS.key;
    }
    if (status === 404) {
        return REQUEST_ERROR_HINT_KINDS.model;
    }
    if (status === 429) {
        return REQUEST_ERROR_HINT_KINDS.rate;
    }
    if (status >= 500) {
        return REQUEST_ERROR_HINT_KINDS.down;
    }
    return '';
}

/**
 * @param {string} kind One of {@link REQUEST_ERROR_HINT_KINDS}.
 * @returns {string} What the user can do about this kind of failure, or an empty string for an unknown kind.
 */
export function getRequestErrorHint(kind) {
    switch (kind) {
        case REQUEST_ERROR_HINT_KINDS.key:
            return t`The provider didn't accept your API key. Check it in Backend ▸ Connections.`;
        case REQUEST_ERROR_HINT_KINDS.model:
            return t`The provider couldn't find the selected model or address. Check both in Backend ▸ Connections.`;
        case REQUEST_ERROR_HINT_KINDS.rate:
            return t`The provider is limiting your requests, or your credits ran out. Wait a moment and try again, or check your account with the provider.`;
        case REQUEST_ERROR_HINT_KINDS.down:
            return t`The provider couldn't be reached or is having problems. Try again in a few minutes.`;
        default:
            return '';
    }
}

/**
 * @param {Response} response A failed response from one of the generation routes.
 * @returns {number} The status the provider answered with. The server turns a provider 401 into 400, so that the
 *   browser does not reset its Basic auth, and sends the original in a header.
 */
export function getFailureStatus(response) {
    const upstream = Number(response.headers?.get?.('X-Upstream-Status'));
    return Number.isInteger(upstream) && upstream >= 400 ? upstream : response.status;
}

/**
 * Decides what a failed request tells the user.
 * @param {object} failure
 * @param {number} [failure.status] HTTP status of the response.
 * @param {string} [failure.statusText] HTTP reason phrase. Used only when the provider said nothing.
 * @param {unknown} [failure.body] Response body as text, or parsed.
 * @param {string} [failure.message] A message the caller already extracted. Wins over the body.
 * @returns {{ message: string, hintKind: string }}
 */
export function describeRequestError({ status = 0, statusText = '', body = '', message = '' } = {}) {
    const text = String(message || '').trim() || extractProviderMessage(body) || String(statusText || '').trim();
    return {
        message: text || (status ? `${t`Unknown error`} (${status})` : t`Unknown error`),
        hintKind: hintKindFor(status),
    };
}

/**
 * Reads a response body that a caller threw as is, which is how the generation routes report a failed request.
 * @param {unknown} thrown Whatever was thrown.
 * @returns {{ status: number, body: object } | null} Null for real errors, which their own code already reported, and for bodies with nothing to say.
 */
export function getThrownResponseFailure(thrown) {
    if (!thrown || typeof thrown !== 'object' || thrown instanceof Error) {
        return null;
    }
    const { status } = /** @type {{ status?: unknown }} */ (thrown);
    const isErrorBody = Boolean(/** @type {{ error?: unknown }} */ (thrown).error);
    if (!isErrorBody && !extractProviderMessage(thrown)) {
        return null;
    }
    if (Number.isInteger(status)) {
        return { status: /** @type {number} */ (status), body: thrown };
    }
    // The server reports a network failure as a code such as ECONNREFUSED, which means the provider could not be reached.
    return { status: status ? 503 : 0, body: thrown };
}

/**
 * Builds the error to throw after a failed response was reported, so callers that show the error text later
 * (the conversation toast, extensions) get the provider's sentence instead of only a status number.
 * @param {object} failure Same shape as the argument of {@link describeRequestError}.
 * @returns {Error}
 */
export function createFailedResponseError({ status = 0, body = '' } = {}) {
    return new Error(extractProviderMessage(body) || `Got response status ${status}`);
}

/**
 * Shows a failed request as an error toast: what went wrong, and a hint for what to do when the status says so.
 * @param {object} options
 * @param {string} options.title Toast title.
 * @param {number} [options.status]
 * @param {string} [options.statusText]
 * @param {unknown} [options.body]
 * @param {string} [options.message]
 * @param {object} [options.toastOptions] Extra toastr options.
 * @param {typeof globalThis.toastr} [options.toast]
 * @returns {{ message: string, hintKind: string }} What was shown.
 */
export function showRequestError({ title, status = 0, statusText = '', body = '', message = '', toastOptions = {}, toast = globalThis.toastr }) {
    const description = describeRequestError({ status, statusText, body, message });
    if (!description.hintKind) {
        toast.error(description.message, title, toastOptions);
        return description;
    }

    const content = document.createElement('div');
    const what = document.createElement('div');
    what.textContent = description.message;
    const hint = document.createElement('div');
    hint.className = 'sb-request-error-hint';
    hint.dataset.sbRequestErrorHint = description.hintKind;
    hint.textContent = getRequestErrorHint(description.hintKind);
    content.append(what, hint);
    // escapeHtml covers the title as well as the message, so callers must pass a title that they trust.
    toast.error(content, title, { ...toastOptions, escapeHtml: false });
    return description;
}
