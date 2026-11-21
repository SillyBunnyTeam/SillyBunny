import { expect, test } from '@playwright/test';
import { variantContextOptions } from '../helpers/surface-matrix.js';
import { bootSurfaceApp, openSurface } from '../helpers/surfaces/boot.js';
import { surfaceById } from '../helpers/surfaces/index.js';

/* eslint-disable playwright/no-conditional-in-test -- A family may name its own scope instead of the surface's root. */

// The long entity lists are one Tab stop with arrow-key navigation (public/scripts/sillybunny-editor/list-focus.js). Each surface
// below is opened on the seeded server; the check reads the page, so the same assertions hold for every list family.

const FAMILIES = [
    { id: 'list.persona', rows: '.sb-persona-row' },
    { id: 'list.worldinfo-entries', rows: '.sb-wi-row' },
    { id: 'list.prompt', rows: '.sb-prompt-row' },
    { id: 'list.agents', rows: '.ica-agent-row' },
    { id: 'list.tag-manager', rows: '.tag_view_item' },
    { id: 'list.folder-manager', rows: '.sb-folder-manager__folder-row' },
    { id: 'list.archive', rows: '.sbca-row' },
    { id: 'list.chat-history', rows: '.sb-chat-history-row' },
    { id: 'list.databank', rows: '.attachmentListItem', root: '.dataBankAttachments' },
    { id: 'list.swipe-picker', rows: '.swipe_picker_block' },
    { id: 'list.group-members', rows: '.group_member', root: '#rm_group_members' },
    { id: 'list.group-candidates', rows: '.group_member', root: '#rm_group_add_members' },
    // A search hides rows with `hidden`: the stop must be on a row that is still shown.
    { id: 'list.tag-manager', stateId: 'search-results', rows: '.tag_view_item', minRows: 1 },
    { id: 'list.folder-manager', stateId: 'search-results', rows: '.sb-folder-manager__folder-row', minRows: 1 },
    // The rows of a members page are not focusable themselves: their Remove button is the stop.
    { id: 'list.tag-manager', stateId: 'members-page', rows: '.ds-entity-row', minRows: 1 },
    { id: 'list.folder-manager', stateId: 'members-page', rows: '.sb-folder-manager__member-row', minRows: 1 },
];
const VIEWPORTS = ['1440x900', '390x844'];

/** The visible rows of a list, and which of them hold a control that Tab reaches. */
function readList({ root, rows }) {
    const container = document.querySelector(root);
    const visible = element => element instanceof HTMLElement && !element.closest('[hidden], [inert]') && element.getClientRects().length > 0;
    const rowList = [...container.querySelectorAll(rows)].filter(visible);
    const focusable = [...container.querySelectorAll('a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex]')]
        .filter(element => visible(element) && !element.disabled && element.tabIndex >= 0);
    const stopRows = new Set(focusable.map(element => rowList.find(row => row.contains(element))).filter(Boolean));
    return { count: rowList.length, stopRowIndexes: [...stopRows].map(row => rowList.indexOf(row)) };
}

/** Index of the row that holds the focus, or -1. */
function focusedRow({ root, rows }) {
    const container = document.querySelector(root);
    const rowList = [...container.querySelectorAll(rows)].filter(element => element.getClientRects().length > 0);
    return rowList.findIndex(row => row.contains(document.activeElement));
}

for (const viewport of VIEWPORTS) {
    test.describe(`list keyboard at ${viewport}`, () => {
        test.use(variantContextOptions({ viewport }));

        for (const family of FAMILIES) {
            test(`${family.id}${family.stateId ? ` (${family.stateId})` : ''} is one Tab stop and moves by arrow keys`, async ({ page, baseURL }) => {
                const surface = surfaceById(family.id);
                await bootSurfaceApp(page, baseURL, { variant: { viewport }, needs: surface.needs });
                const root = await openSurface(page, surface, { viewport, stateId: family.stateId });
                const target = { root: family.root ?? root, rows: family.rows };

                const before = await page.evaluate(readList, target);
                expect(before.count).toBeGreaterThanOrEqual(family.minRows ?? 2);
                expect(before.stopRowIndexes).toHaveLength(1);

                // Focus goes to the one stop with the keyboard path: the first control that Tab reaches in the stop's row.
                const stop = before.stopRowIndexes[0];
                await page.evaluate(({ root: scope, rows, index }) => {
                    const row = [...document.querySelector(scope).querySelectorAll(rows)].filter(element => element.getClientRects().length > 0)[index];
                    const control = row.matches('[tabindex]') ? row : [...row.querySelectorAll('a[href], button, input:not([type="hidden"]), select, textarea, [tabindex]')].find(element => element.tabIndex >= 0);
                    control.focus();
                }, { ...target, index: stop });
                expect(await page.evaluate(focusedRow, target)).toBe(stop);

                // Tab passes through the row's own controls and then leaves the list; it never lands in another row.
                for (let press = 0; press < 8; press++) {
                    await page.keyboard.press('Tab');
                    const index = await page.evaluate(focusedRow, target);
                    expect(index === -1 || index === stop).toBe(true);
                }
                await page.keyboard.press('Shift+Tab');
                await page.evaluate(({ root: scope, rows, index }) => {
                    const row = [...document.querySelector(scope).querySelectorAll(rows)].filter(element => element.getClientRects().length > 0)[index];
                    const control = row.matches('[tabindex]') ? row : [...row.querySelectorAll('a[href], button, input:not([type="hidden"]), select, textarea, [tabindex]')].find(element => element.tabIndex >= 0);
                    control.focus();
                }, { ...target, index: stop });

                const last = before.count - 1;
                if (last < 1) return;
                await page.keyboard.press('End');
                await expect.poll(() => page.evaluate(focusedRow, target)).toBe(last);
                await page.keyboard.press('Home');
                await expect.poll(() => page.evaluate(focusedRow, target)).toBe(0);
                await page.keyboard.press('ArrowDown');
                await expect.poll(() => page.evaluate(focusedRow, target)).toBe(1);
                await page.keyboard.press('ArrowUp');
                await expect.poll(() => page.evaluate(focusedRow, target)).toBe(0);
                const after = await page.evaluate(readList, target);
                expect(after.stopRowIndexes).toEqual([0]);
            });
        }
    });
}

for (const viewport of VIEWPORTS) {
    test.describe(`list reordering keys at ${viewport}`, () => {
        test.use(variantContextOptions({ viewport }));

        test('Alt+Down still moves a prompt row, and the plain arrows only move focus', async ({ page, baseURL }) => {
            const surface = surfaceById('list.prompt');
            await bootSurfaceApp(page, baseURL, { variant: { viewport }, needs: surface.needs });
            await openSurface(page, surface, { viewport });
            const rows = page.locator('.sb-prompt-editor .sb-prompt-row:visible');
            const order = () => rows.evaluateAll(nodes => nodes.map(node => node.dataset.promptId));
            const before = await order();
            expect(before.length).toBeGreaterThanOrEqual(3);

            await rows.nth(0).focus();
            await page.keyboard.press('ArrowDown');
            await expect(rows.nth(1)).toBeFocused();
            expect(await order()).toEqual(before);

            await rows.nth(0).focus();
            await page.keyboard.press('Alt+ArrowDown');
            await expect.poll(order).toEqual([before[1], before[0], ...before.slice(2)]);
            await expect(rows.nth(1)).toBeFocused();
            await expect(rows.nth(1)).toHaveAttribute('data-prompt-id', before[0]);
            await page.keyboard.press('Alt+ArrowUp');
            await expect.poll(order).toEqual(before);
            await expect(rows.nth(0)).toBeFocused();
        });
    });
}

for (const viewport of VIEWPORTS) {
    test.describe(`row control focus rings at ${viewport}`, () => {
        test.use(variantContextOptions({ viewport }));

        test('the Agent Menu button draws the focus ring when Tab reaches it, on a fine and a coarse pointer', async ({ page, baseURL }) => {
            const surface = surfaceById('list.agents');
            await bootSurfaceApp(page, baseURL, { variant: { viewport }, needs: surface.needs });
            await openSurface(page, surface, { viewport });
            const row = page.locator('.ica-agent-row').first();
            await row.focus();
            await page.keyboard.press('Tab');
            const menu = row.locator('[aria-label="Agent Menu"]');
            const toggle = row.locator('input[role="switch"]');
            // The switch comes before the menu in the row: Tab until the menu has focus.
            for (let press = 0; press < 3 && !(await menu.evaluate(button => button === document.activeElement)); press++) await page.keyboard.press('Tab');
            await expect(menu).toBeFocused();
            await expect(toggle).toHaveCount(1);
            await expect(menu).toHaveCSS('box-shadow', /inset/);
        });
    });
}
