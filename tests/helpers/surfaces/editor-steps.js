/**
 * Open and wait steps of the editor family. No Playwright import, so the registry loads in Jest.
 *
 * The smoke opens a surface once and then each of its states from a fresh open of the same page, so every open step here
 * starts by putting the previous state away: an action menu or picker that is still open, a Popup (the expanded text area,
 * the leave dialog), and the unsaved changes that an earlier state typed, which Cancel discards and drops the draft of. An
 * editor that keeps a draft would otherwise offer to restore it in a toast on the next open.
 */

import { settle } from './steps.js';

/** An action menu or popover: the popover on a desktop window, the sheet under the overlay breakpoint. */
export const MENU_ROOT = '.sb-action-popover, .sb-action-sheet:not([hidden])';

/** The longest text that any state types into a field. */
const SHORT_EDIT = ' Edited by the audit.';

export const shown = (page, selector) => page.locator(selector).first().waitFor({ state: 'visible' });
export const gone = (page, selector) => page.locator(selector).first().waitFor({ state: 'hidden' });

/** Waits until the animations inside `selector` that have an end are over, so that a measured box is the settled one. */
export const settled = (page, selector) => settle(page, { root: selector });

/** Waits until the overlay that matches `root` is shown and its open animation has ended. */
export async function settleOverlay(page, root) {
    await shown(page, root);
    await settle(page, { root });
}

/** Closes the action menu, popover or picker that is open, without the exit animation. */
export async function closeOverlays(page) {
    await page.evaluate(async () => {
        const menu = await import('/scripts/sillybunny-action-menu.js');
        const picker = await import('/scripts/sillybunny-editor/picker.js');
        menu.closeActionMenu({ animate: false, restoreFocus: false });
        picker.closePicker({ animate: false, restoreFocus: false });
    });
}

/**
 * Closes every open dialog (a Popup, or a sheet that `openDialog` made) with Escape, which each answers as Cancel or Back (a
 * leave dialog stays in its editor, an expanded text area writes back), one at a time from the top. A dialog that ignores
 * Escape is closed directly.
 */
export async function closePopups(page) {
    for (let pass = 0; pass < 6; pass++) {
        const open = await page.locator('dialog[open]').count();
        if (open === 0) {
            return;
        }
        await page.keyboard.press('Escape');
        await page.waitForFunction(before => document.querySelectorAll('dialog[open]').length < before, open, { timeout: 3000 }).catch(() => {});
    }
    await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()));
    await page.locator('dialog[open]').first().waitFor({ state: 'detached' });
}

/**
 * Closes a bottom sheet of the prompt and agent property bars. It is a plain element with a scrim, not a `<dialog>`, so
 * `closePopups` does not see it, and its scrim covers the editor's header until it is closed.
 */
export async function closeSheets(page) {
    const sheet = page.locator('.sb-prompt-sheet:not([hidden])').first();
    if (await sheet.count() === 0) {
        return;
    }
    await sheet.locator('.sb-prompt-sheet-header button').first().click();
    await sheet.waitFor({ state: 'hidden' });
    await page.locator('.sb-prompt-sheet-backdrop:not([hidden])').first().waitFor({ state: 'hidden' });
}

/** Puts away everything an earlier state can leave on top of an editor. */
export async function clearOverlays(page) {
    await closeOverlays(page);
    await closeSheets(page);
    await closePopups(page);
}

/**
 * Discards the unsaved changes of an open editor with its header Cancel, when the dirty mark is shown. Cancel keeps the
 * editor open and removes its stored draft.
 * @param {import('@playwright/test').Page} page
 * @param {{ dirty: string, cancel: string }} selectors The dirty mark (shown only while there are changes) and the Cancel button.
 */
export async function discardEdits(page, { dirty, cancel }) {
    const mark = page.locator(dirty).first();
    if (await mark.count() === 0 || !await mark.isVisible()) {
        return;
    }
    const button = page.locator(cancel).first();
    if (await button.isEnabled()) {
        await button.click();
    }
    await mark.waitFor({ state: 'hidden' });
}

/**
 * Goes back from a detail pane that covers its list (on a phone, and in some desktop layouts), when one is open.
 * @param {import('@playwright/test').Page} page
 * @param {string} back A selector for the pane's Back button.
 */
export async function leaveDetail(page, back) {
    const button = page.locator(back).first();
    if (await button.isVisible()) {
        await button.click();
        await button.waitFor({ state: 'hidden' });
    }
}

/**
 * Appends a short text to a field and leaves it, so that the editor has an unsaved change. The field is filled, not typed
 * into, so the editor sees one input event.
 * @param {import('@playwright/test').Page} page
 * @param {string} field
 */
export async function appendToField(page, field) {
    const control = page.locator(field).first();
    await control.fill(`${await control.inputValue()}${SHORT_EDIT}`);
    await control.blur();
}

/**
 * Renames the item in its header, which is an edit like any other: it is unsaved until Save.
 * @param {import('@playwright/test').Page} page
 * @param {string} titleButton The title button that swaps for an input.
 * @param {string} value
 */
export async function renameInHeader(page, titleButton, value) {
    await page.locator(titleButton).click();
    const input = page.locator('.sb-editor-title-input');
    await input.fill(value);
    await input.press('Enter');
}

/**
 * Leaves a dirty list-content editor, which asks Cancel, Discard or Save: with the pane's Back button where it is shown (a
 * phone), and by picking another row of the list where the list stands beside the pane (a desktop).
 * @param {import('@playwright/test').Page} page
 * @param {{ back: string, otherRow: string, exceptText?: string }} selectors `otherRow` matches the rows of the list; rows
 *     whose text holds `exceptText` (the item that is open) are not picked.
 */
export async function leaveDirtyDetail(page, { back, otherRow, exceptText }) {
    const button = page.locator(back).first();
    if (await button.isVisible()) {
        await button.click();
    } else {
        const rows = page.locator(otherRow).filter({ visible: true });
        await (exceptText ? rows.filter({ hasNotText: exceptText }) : rows).first().click();
    }
}

/**
 * Switches an editor to its preview, with the segmented control where the header shows it and with the single toggle where
 * the header is too narrow (a phone).
 * @param {import('@playwright/test').Page} page
 * @param {{ modes: string, toggle: string }} selectors
 */
export async function showPreview(page, { modes, toggle }) {
    const segment = page.locator(`${modes} label`).filter({ hasText: 'Preview' }).first();
    if (await segment.isVisible()) {
        await segment.click();
    } else {
        await page.locator(toggle).first().click();
    }
}

/**
 * Scrolls the body of an editor back to the top, which opening the same item again does not do, and waits until the header
 * that scrolling down hides on a phone is shown again.
 */
export async function scrollToTop(page, scroller) {
    await page.evaluate(selector => {
        const body = document.querySelector(selector);
        if (body) {
            body.scrollTop = 0;
        }
    }, scroller);
    await page.waitForFunction(() => !document.querySelector('.sb-editor-chrome-hidden'));
    await settle(page);
}

/**
 * Scrolls a section to the top of the sheet that holds it, the way the editors' own Sections menu does. It throws when the
 * sheet does not move, because a section state that is already in view repeats the surface it starts from; a step that does
 * more than scroll (it opens something in the section) sets `mustMove` to false.
 */
export async function scrollSectionIntoView(page, { scroller, section, mustMove = true }) {
    await page.evaluate(({ scroller, section, mustMove }) => {
        const body = document.querySelector(scroller);
        const target = document.querySelector(section);
        if (!body || !target) {
            throw new Error(`Cannot scroll ${section} into ${scroller}.`);
        }
        const before = body.scrollTop;
        body.scrollTop += target.getBoundingClientRect().top - body.getBoundingClientRect().top - parseFloat(getComputedStyle(body).paddingTop);
        if (mustMove && Math.abs(body.scrollTop - before) < 1) {
            throw new Error(`Scrolling ${section} into ${scroller} did not move it, so the state repeats the surface.`);
        }
    }, { scroller, section, mustMove });
    await settle(page);
}
