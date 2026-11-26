/**
 * Selectors for the toasts of the app. A plain message is a toast in `#sb-toast-overlay`, and a structured one is an
 * in-app notification in toastr's `#toast-container`. A spec that means "a message of either form" uses
 * `TOAST_SELECTOR`, and a spec that pins the look or the behaviour of one form uses that form's selector.
 */

/** Both containers. */
export const TOAST_CONTAINERS = ':is(#toast-container, #sb-toast-overlay)';

/** Every toast of either form. The hidden clone that measures a toast is not one. */
export const TOAST_SELECTOR = `${TOAST_CONTAINERS} > .toast:not(.sb-toast-measure)`;

/** The text of every toast of either form. */
export const TOAST_MESSAGE_SELECTOR = `${TOAST_SELECTOR} .toast-message`;

/** A toast: a plain message, as one line in a pill. */
export const TOAST_FORM_SELECTOR = '#sb-toast-overlay > .sb-form-toast:not(.sb-toast-measure)';

/** An in-app notification: a structured message. */
export const NOTIFICATION_FORM_SELECTOR = '#toast-container > .sb-form-notification';

/** The selectors as code that runs in the page, where a spec's imports are not reachable. */
export const TOAST_SELECTORS_IN_PAGE = { TOAST_CONTAINERS, TOAST_SELECTOR };

/**
 * The toasts of either form whose text contains `text`.
 * @param {import('@playwright/test').Page} page
 * @param {string|RegExp} text
 */
export function toastWithText(page, text) {
    return page.locator(TOAST_SELECTOR).filter({ hasText: text });
}
