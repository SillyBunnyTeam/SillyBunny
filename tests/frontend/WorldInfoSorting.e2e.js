import { test, expect } from '@playwright/test';
import { testSetup } from './frontent-test-utils.js';
import { gunzipSync } from 'node:zlib';

test.describe('World Info sorting controls', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
    test.beforeEach(async ({ page }) => {
        await page.route('**/api/settings/save', route => {
            const request = route.request();
            const body = request.headers()['content-encoding'] === 'gzip' ? gunzipSync(request.postDataBuffer()) : request.postDataBuffer();
            const payload = JSON.parse(body.toString());
            return route.fulfill({ json: { result: 'ok', version: payload._version + 1 } });
        });
        await testSetup.awaitST({ page });
    });

    test('applies ascending steps and descending clamping to native and character-book orders', async ({ page }) => {
        const name = `PARITY_SORT_${Date.now()}`;
        const readSavedOrders = () => page.evaluate(async (worldName) => {
            const { getRequestHeaders } = await import('./script.js');
            const response = await fetch('/api/worldinfo/get', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ name: worldName }),
            });
            const data = await response.json();
            const byComment = (a, b) => a.comment.localeCompare(b.comment);
            return {
                native: Object.values(data.entries).sort(byComment).map(entry => entry.order),
                card: [...data.originalData.entries].sort(byComment).map(entry => entry.insertion_order),
                cardIds: data.originalData.entries.map(entry => entry.id),
            };
        }, name);

        try {
            await page.evaluate(async (worldName) => {
                const { saveWorldInfo, updateWorldInfoList, convertCharacterBook, openWorldInfoEditor } = await import('./scripts/world-info.js');
                const data = convertCharacterBook({
                    entries: ['Gamma', 'Alpha', 'Beta'].map((comment, index) => ({
                        id: (index + 1) * 4,
                        comment,
                        content: comment,
                        keys: [comment],
                        insertion_order: 100,
                        enabled: true,
                    })),
                });
                if (!await saveWorldInfo(worldName, data, true)) throw new Error('Could not save sorting test lorebook');
                await updateWorldInfoList();
                openWorldInfoEditor(worldName);
            }, name);

            // The rebuilt editor owns the list; sorting and Apply current sorting live in its menus.
            const editor = page.locator('#WorldInfo .sb-wi-editor');
            const entries = editor.locator('.sb-wi-row');
            await expect(editor).toBeAttached();
            await expect(entries).toHaveCount(3);
            await editor.locator('.sb-wi-sort-button').click();
            await page.locator('.sb-action-menu [role^="menuitem"]', { hasText: 'Title A-Z' }).click();
            await expect(entries.first()).toContainText('Alpha');
            const applySorting = async () => {
                await editor.locator('.sb-wi-list-header button:has(.fa-ellipsis-vertical)').click();
                await page.locator('.sb-action-menu [role^="menuitem"]', { hasText: 'Apply current sorting as Order' }).click();
            };
            await applySorting();

            const start = page.locator('#wi_sort_start');
            const step = page.locator('#wi_sort_step');
            const ascending = page.locator('#wi_sort_ascending');
            const popup = page.locator('.popup').filter({ has: start });
            await expect(start).toBeFocused();
            await start.fill('0');
            await step.fill('5');
            await ascending.check();
            await expect(popup.locator('.info-block')).toBeHidden();

            const fitsViewport = await popup.evaluate(element => {
                const bounds = element.getBoundingClientRect();
                return bounds.left >= 0 && bounds.right <= window.innerWidth + 1;
            });
            expect(fitsViewport).toBe(true);
            await popup.locator('.popup-button-ok').click();
            await expect.poll(readSavedOrders).toEqual({ native: [0, 5, 10], card: [0, 5, 10], cardIds: [4, 8, 12] });

            await applySorting();
            await start.fill('8');
            await step.fill('5');
            await expect(popup.locator('.info-block')).toContainText('clamped');
            await popup.locator('.popup-button-ok').click();
            await expect.poll(readSavedOrders).toEqual({ native: [8, 3, 0], card: [8, 3, 0], cardIds: [4, 8, 12] });
        } finally {
            await page.evaluate(async (worldName) => {
                const { deleteWorldInfo, world_names } = await import('./scripts/world-info.js');
                if (world_names.includes(worldName)) await deleteWorldInfo(worldName);
            }, name);
        }
    });
});
