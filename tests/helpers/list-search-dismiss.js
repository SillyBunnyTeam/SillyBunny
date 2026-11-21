import { expect, test } from '@playwright/test';

/**
 * A list editor's search bar that holds a Sort button dismisses itself on a press outside it, also after the
 * sort menu was used (the button keeps the focus, so the input never blurs again).
 *
 * @param {object} parts
 * @param {import('@playwright/test').Page} parts.page
 * @param {() => Promise<void>} parts.reveal Reveals the search from its header toggle.
 * @param {import('@playwright/test').Locator} parts.field The revealed search field.
 * @param {import('@playwright/test').Locator} parts.input
 * @param {import('@playwright/test').Locator} parts.sort The Sort (or Filter) button inside the field.
 * @param {() => Promise<void>} parts.chooseSort Picks a sort in the open menu.
 * @param {import('@playwright/test').Locator} parts.outside A target in the list, outside the field, that takes no focus when pressed.
 * @param {number} [parts.outsideOffset=3] Distance in px of the press from the top-left corner of `outside`.
 * @param {string} [parts.menuRole='menuitemradio'] Role of the items in the button's menu.
 * @param {import('@playwright/test').Locator} [parts.focusable] A control outside the field that takes focus when pressed, and opens a menu.
 */
export async function expectSortKeepsSearchDismissable({ page, reveal, field, input, sort, chooseSort, outside, outsideOffset = 3, focusable = null, menuRole = 'menuitemradio' }) {
    const menus = page.getByRole(menuRole);
    const popups = page.locator('.sb-action-popover, .sb-action-sheet');
    // A mouse press at the spot, because a sheet's backdrop covers the target and a locator click waits for it to clear.
    const pressOutside = async () => {
        const box = await outside.boundingBox();
        await page.mouse.click(box.x + outsideOffset, box.y + outsideOffset);
    };
    const openSearch = async () => {
        if (await field.isHidden()) await reveal();
        await expect(input).toBeFocused();
    };
    const failures = [];
    // Every step starts from a closed search and no menu, so one failing step does not hide the others.
    const step = async (title, body) => {
        if (await popups.count()) {
            await page.keyboard.press('Escape');
            await expect(popups).toHaveCount(0);
        }
        if (await field.isVisible()) {
            await input.focus();
            await page.keyboard.press('Escape');
            await expect(field).toBeHidden();
        }
        try {
            await test.step(title, body);
        } catch (error) {
            failures.push(`${title}: ${String(error.message).split('\n')[0]}`);
        }
    };

    await step('picking a sort, then pressing the list, closes the empty search', async () => {
        await openSearch();
        await sort.click();
        await expect(menus.first()).toBeVisible();
        await chooseSort();
        await expect(menus).toHaveCount(0);
        await expect(field).toBeVisible();
        await pressOutside();
        await expect(field).toBeHidden();
    });

    await step('closing the sort menu with Escape, then pressing the list, closes the empty search', async () => {
        await openSearch();
        await sort.click();
        await expect(menus.first()).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(menus).toHaveCount(0);
        await expect(field).toBeVisible();
        await expect(sort).toBeFocused();
        await pressOutside();
        await expect(field).toBeHidden();
    });

    await step('a press outside while the sort menu is open closes the menu only; the next one closes the search', async () => {
        await openSearch();
        await sort.click();
        await expect(menus.first()).toBeVisible();
        await pressOutside();
        await expect(menus).toHaveCount(0);
        await expect(field).toBeVisible();
        await pressOutside();
        await expect(field).toBeHidden();
    });

    if (focusable) {
        await step('a press on a control outside, after the sort menu, closes the empty search', async () => {
            await openSearch();
            await sort.click();
            await expect(menus.first()).toBeVisible();
            await chooseSort();
            await focusable.click();
            await expect(field).toBeHidden();
            await expect(popups).toHaveCount(1);
        });
    }

    await step('Tab out of the empty field from its Sort button closes it', async () => {
        await openSearch();
        await page.keyboard.press('Tab');
        await expect(sort).toBeFocused();
        await page.keyboard.press('Tab');
        await expect(field).toBeHidden();
    });

    await step('a field with a query stays open through the sort menu and a press outside', async () => {
        await openSearch();
        await input.fill('a');
        await sort.click();
        await expect(menus.first()).toBeVisible();
        await chooseSort();
        await expect(menus).toHaveCount(0);
        await pressOutside();
        await expect(field).toBeVisible();
        await expect(input).toHaveValue('a');
        await input.fill('');
        await pressOutside();
        await expect(field).toBeHidden();
    });

    expect(failures).toEqual([]);
}
