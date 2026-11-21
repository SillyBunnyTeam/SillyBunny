import { expect, test } from '@playwright/test';
import { variantContextOptions } from '../helpers/surface-matrix.js';
import { bootSurfaceApp, openSurface } from '../helpers/surfaces/boot.js';
import { surfaceById } from '../helpers/surfaces/index.js';

/* eslint-disable playwright/no-conditional-in-test -- Each family names its own rows, key attribute and view. */

// Reordering by keyboard: Alt+Home and Alt+End move the focused row to the first and last place, the Tag Manager and the Folders
// window move rows by Alt+arrow like the other lists, and focus stays on the moved row.

const VIEWPORTS = ['1440x900', '390x844'];

const FAMILIES = [
    { id: 'list.prompt', rows: '.sb-prompt-editor .sb-prompt-row:has(.sb-prompt-grip):visible', attribute: 'data-prompt-id' },
    { id: 'list.worldinfo-entries', stateId: 'custom-order', rows: '.sb-wi-row:has(.sb-wi-grip):visible', attribute: 'data-uid' },
    { id: 'list.tag-manager', rows: '.tag_view_item[data-sb-list-key]:not([hidden])', attribute: 'id' },
    { id: 'list.folder-manager', rows: '.sb-folder-manager__folder-row:not([hidden])', attribute: 'data-folder-id' },
];

async function openFamily(page, baseURL, viewport, family) {
    const surface = surfaceById(family.id);
    await bootSurfaceApp(page, baseURL, { variant: { viewport }, needs: surface.needs });
    await openSurface(page, surface, { viewport, stateId: family.stateId });
    const rows = page.locator(family.rows);
    const order = () => rows.evaluateAll((nodes, attribute) => nodes.map(node => node.getAttribute(attribute)), family.attribute);
    const focusedKey = () => page.evaluate(attribute => document.activeElement?.closest(`[${attribute}]`)?.getAttribute(attribute) ?? null, family.attribute);
    return { rows, order, focusedKey };
}

for (const viewport of VIEWPORTS) {
    test.describe(`reordering keys at ${viewport}`, () => {
        test.use(variantContextOptions({ viewport }));

        for (const family of FAMILIES) {
            test(`${family.id}: Alt+End and Alt+Home move the row to the ends, and Alt+arrow one place, keeping focus on it`, async ({ page, baseURL }) => {
                const { rows, order, focusedKey } = await openFamily(page, baseURL, viewport, family);
                const before = await order();
                expect(before.length).toBeGreaterThanOrEqual(2);
                const moved = before[0];
                const swapped = [before[1], before[0], ...before.slice(2)];
                const atEnd = [...before.slice(1), moved];

                await rows.nth(0).focus();
                await page.keyboard.press('Alt+ArrowDown');
                await expect.poll(order).toEqual(swapped);
                await expect.poll(focusedKey).toBe(moved);

                await page.keyboard.press('Alt+ArrowUp');
                await expect.poll(order).toEqual(before);
                await expect.poll(focusedKey).toBe(moved);

                await page.keyboard.press('Alt+End');
                await expect.poll(order).toEqual(atEnd);
                await expect.poll(focusedKey).toBe(moved);

                // Nothing happens at the boundary: no move, and focus stays.
                await page.keyboard.press('Alt+End');
                await page.keyboard.press('Alt+ArrowDown');
                expect(await order()).toEqual(atEnd);
                await expect.poll(focusedKey).toBe(moved);

                await page.keyboard.press('Alt+Home');
                await expect.poll(order).toEqual(before);
                await expect.poll(focusedKey).toBe(moved);

                await page.keyboard.press('Alt+Home');
                await page.keyboard.press('Alt+ArrowUp');
                expect(await order()).toEqual(before);
                await expect.poll(focusedKey).toBe(moved);
            });
        }

        for (const family of [
            { id: 'list.tag-manager', rows: '.tag_view_item[data-sb-list-key]:not([hidden])', attribute: 'id' },
            { id: 'list.folder-manager', rows: '.sb-folder-manager__folder-row:not([hidden])', attribute: 'data-folder-id' },
        ]) {
            test(`${family.id}: Alt+End does nothing while a search is on`, async ({ page, baseURL }) => {
                const surface = surfaceById(family.id);
                await bootSurfaceApp(page, baseURL, { variant: { viewport }, needs: surface.needs });
                await openSurface(page, surface, { viewport, stateId: 'search-results' });
                const rows = page.locator(family.rows);
                const order = () => rows.evaluateAll((nodes, attribute) => nodes.map(node => node.getAttribute(attribute)), family.attribute);
                const before = await order();
                await rows.first().focus();
                await page.keyboard.press('Alt+End');
                await page.keyboard.press('Alt+ArrowDown');
                expect(await order()).toEqual(before);
                await expect(rows.first()).toBeFocused();
            });

            test(`${family.id}: the row menu offers Move Up and Move Down, left out at the ends`, async ({ page, baseURL }) => {
                const { rows } = await openFamily(page, baseURL, viewport, family);
                const items = async index => {
                    await rows.nth(index).locator('.ds-entity-row__suffix button[aria-haspopup="menu"]').click();
                    const labels = await page.locator('[data-sb-reorder]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-sb-reorder')));
                    await page.keyboard.press('Escape');
                    await expect(page.locator('[data-sb-reorder]')).toHaveCount(0);
                    return labels;
                };
                const last = (await rows.count()) - 1;
                expect(await items(0)).toEqual(expect.arrayContaining(['down']));
                expect(await items(0)).not.toContain('up');
                if (last > 1) expect(await items(1)).toEqual(expect.arrayContaining(['up', 'down']));
                expect(await items(last)).not.toContain('down');
            });
        }
    });
}
