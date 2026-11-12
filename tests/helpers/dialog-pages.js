import { expect } from '@playwright/test';

/**
 * The Close of the one page a dialog host shows. A push slides the new page over the covered one, and a pop
 * slides the leaving page away, so for the length of that slide two pages are in the DOM and each has its
 * own Close. The covered page is then hidden, and a leaving page is removed. Waiting for a single unhidden
 * page proves both happened, and it has to come first, because Playwright counts every match of a strict
 * locator at once and does not wait for the count to drop.
 * @param {import('@playwright/test').Locator} host The `.sb-dialog-host` that holds the pages.
 * @returns {Promise<import('@playwright/test').Locator>}
 */
export async function visiblePageClose(host) {
    await expect(host.locator('.sb-dialog__page:not([hidden])'), 'the covered page is hidden and a leaving page is removed once the slide ends').toHaveCount(1);
    // A Popup page turns its own close button into Back and keeps the close class, so Back is excluded.
    return host.locator('.sb-dialog__page:not([hidden]) .sb-dialog__close:not(.sb-dialog__back)');
}
