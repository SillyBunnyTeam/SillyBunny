import { expect, test } from '@playwright/test';
import { variantContextOptions } from '../helpers/surface-matrix.js';
import { bootSurfaceApp, openSurface } from '../helpers/surfaces/boot.js';
import { surfaceById } from '../helpers/surfaces/index.js';

/* eslint-disable playwright/no-conditional-in-test -- Each family names its own rows and grips. */

// Follow-ups of the list keyboard work: the grips of reorderable lists, and the swipe picker's one Tab stop per row.

const VIEWPORTS = ['1440x900', '390x844'];

/**
 * Reorderable lists whose grips come from upstream-shaped markup: a pointer-only handle. `moves` lists have the Alt+arrow moves on
 * the row; the Tag Manager and the Folders window have no keyboard move yet.
 */
const GRIP_FAMILIES = [
    { id: 'list.prompt', rows: '.sb-prompt-editor .sb-prompt-row:has(.sb-prompt-grip)', grip: '.sb-prompt-grip', hiddenGrip: true, moves: true, keepsFocus: true, attribute: 'data-prompt-id' },
    { id: 'list.worldinfo-entries', stateId: 'custom-order', rows: '.sb-wi-row:has(.sb-wi-grip)', grip: '.sb-wi-grip', hiddenGrip: true, moves: true, attribute: 'data-uid' },
    { id: 'list.tag-manager', rows: '.tag_view_item', grip: '.drag-handle', attribute: 'id' },
    { id: 'list.folder-manager', rows: '.sb-folder-manager__folder-row', grip: '.drag-handle', attribute: 'data-sb-list-key' },
];

for (const viewport of VIEWPORTS) {
    test.describe(`list grips at ${viewport}`, () => {
        test.use(variantContextOptions({ viewport }));

        for (const family of GRIP_FAMILIES) {
            test(`${family.id}: the grip is a pointer-only handle, not a button without a tab stop`, async ({ page, baseURL }) => {
                const surface = surfaceById(family.id);
                await bootSurfaceApp(page, baseURL, { variant: { viewport }, needs: surface.needs });
                await openSurface(page, surface, { viewport, stateId: family.stateId });
                const rows = page.locator(family.rows);
                expect(await rows.count()).toBeGreaterThanOrEqual(2);

                const grips = await rows.evaluateAll((nodes, selector) => nodes.map((row) => {
                    const grip = row.querySelector(selector);
                    return { role: grip.getAttribute('role'), label: grip.getAttribute('aria-label'), hidden: grip.getAttribute('aria-hidden'), tabindex: grip.getAttribute('tabindex') };
                }), family.grip);
                for (const grip of grips) {
                    expect(grip.role).toBeNull();
                    expect(grip.label).toBeNull();
                    // The icon is not announced as a control; the prompt list and World Info mark it hidden outright.
                    if (family.hiddenGrip) expect(grip.hidden).toBe('true');
                    expect(grip.tabindex).toBeNull();
                }

                if (!family.moves) return;
                // The row carries the keyboard moves that the grip used to be named for.
                const order = () => rows.evaluateAll((nodes, attribute) => nodes.map(node => node.getAttribute(attribute)), family.attribute);
                const before = await order();
                await rows.nth(0).focus();
                await page.keyboard.press('Alt+ArrowDown');
                await expect.poll(order).toEqual([before[1], before[0], ...before.slice(2)]);
                if (family.keepsFocus) await expect(rows.nth(1)).toBeFocused();
            });
        }
    });

    test.describe(`swipe picker rows at ${viewport}`, () => {
        test.use(variantContextOptions({ viewport }));

        test('a row is one Tab stop at its select button, and Enter selects', async ({ page, baseURL }) => {
            const surface = surfaceById('list.swipe-picker');
            await bootSurfaceApp(page, baseURL, { variant: { viewport }, needs: surface.needs });
            await openSurface(page, surface, { viewport });
            const rows = page.locator('.swipe_picker_block');
            expect(await rows.count()).toBeGreaterThanOrEqual(2);

            // No tabbable element of the list holds another one over the same box: the row itself is never a stop.
            const stops = await page.evaluate(() => [...document.querySelectorAll('.swipe_picker_div [tabindex], .swipe_picker_div button')]
                .filter(element => element.tabIndex >= 0 && element.getClientRects().length > 0)
                .map(element => (element.classList.contains('swipe_picker_block') ? 'row' : element.className.split(' ')[0] || element.tagName.toLowerCase())));
            expect(stops).not.toContain('row');
            expect(stops.filter(stop => stop === 'swipe_picker_select')).toHaveLength(1);

            const select = rows.first().locator('.swipe_picker_select');
            await select.focus();
            await page.keyboard.press('Tab');
            await expect(rows.first().locator('.ds-entity-row__button')).toBeFocused();
            await page.keyboard.press('Shift+Tab');
            await expect(select).toBeFocused();

            await page.keyboard.press('ArrowDown');
            await expect(rows.nth(1).locator('.swipe_picker_select')).toBeFocused();
            await page.keyboard.press('Home');
            await expect(select).toBeFocused();

            await rows.nth(1).locator('.swipe_picker_select').focus();
            await page.keyboard.press('Enter');
            // Enter presses the select button: the swipe is selected, and the window commits it when the message can jump.
            await expect.poll(() => page.evaluate(() => {
                const row = document.querySelectorAll('.swipe_picker_block')[1];
                return !row || row.classList.contains('is-selected');
            })).toBe(true);
        });
    });
}
