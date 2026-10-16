import { expect, test } from '@playwright/test';
import { gunzipSync } from 'node:zlib';

const BOOK = `WI_EDITOR_E2E_${Date.now()}`;

test.beforeEach(async ({ page }) => {
    // Browser QA must not change the running instance's saved preferences.
    await page.route('**/api/settings/save', route => {
        const request = route.request();
        const body = request.headers()['content-encoding'] === 'gzip'
            ? gunzipSync(request.postDataBuffer()) : request.postDataBuffer();
        const payload = JSON.parse(body.toString());
        return route.fulfill({ json: { result: 'ok', version: payload._version + 1 } });
    });
    await page.goto('/');
    await page.waitForFunction(() => window.SillyTavern?.getContext?.()?.eventSource?.autoFireLastArgs?.has('app_ready'), null, { timeout: 60000 });
    await page.evaluate(async name => {
        const { saveWorldInfo, updateWorldInfoList } = await import('./scripts/world-info.js');
        const entry = (uid, comment, extra = {}) => ({
            uid, comment, key: [comment.toLowerCase()], keysecondary: [], content: `${comment} content`,
            constant: false, vectorized: false, selective: true, order: 100, position: 0, disable: false, displayIndex: uid, ...extra,
        });
        const data = { entries: { 0: entry(0, 'Alpha'), 1: entry(1, 'Beta'), 2: entry(2, 'Gamma', { disable: true }) } };
        if (!await saveWorldInfo(name, data, true)) throw new Error('Could not save test lorebook');
        await updateWorldInfoList();
        for (const key of Object.keys(localStorage)) if (key.startsWith('sb-wi-editor-draft-') && key.includes(encodeURIComponent(name))) localStorage.removeItem(key);
    }, BOOK);
});

test.afterEach(async ({ page }) => {
    await page.evaluate(async name => {
        const worldInfo = await import('./scripts/world-info.js');
        if (worldInfo.world_names.includes(name)) await worldInfo.deleteWorldInfo(name);
        await worldInfo.updateWorldInfoList();
        if (worldInfo.world_names.includes(name)) throw new Error(`Test lorebook cleanup failed: ${name}`);
        for (const key of Object.keys(localStorage)) if (key.startsWith('sb-wi-editor-draft-') && key.includes(encodeURIComponent(name))) localStorage.removeItem(key);
    }, BOOK);
});

const readEntries = page => page.evaluate(async name => {
    const { getRequestHeaders } = await import('./script.js');
    const response = await fetch('/api/worldinfo/get', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ name }) });
    return (await response.json()).entries;
}, BOOK);

async function openBook(page) {
    await page.evaluate(async name => {
        const { openWorldInfoEditor } = await import('./scripts/world-info.js');
        openWorldInfoEditor(name);
    }, BOOK);
    const editor = page.locator('#WorldInfo .sb-wi-editor');
    await expect(editor.locator('.sb-wi-row')).toHaveCount(3);
    return editor;
}

const row = (editor, title) => editor.locator('.sb-wi-row', { hasText: title });

async function selectSettings(page, editor) {
    await editor.locator('.sb-wi-book-actions').click();
    await page.locator('.sb-action-menu').last().getByRole('menuitem', { name: 'Global Settings', exact: true }).click();
}

async function selectSortOrFilter(page, editor, label) {
    await editor.locator('.sb-wi-sort-button').click();
    await page.locator('.sb-action-menu').last().getByRole('menuitemradio', { name: label, exact: true }).click();
}

test.describe('World Info editor', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('edits an entry with explicit save and persists it', async ({ page }) => {
        const editor = await openBook(page);
        await row(editor, 'Alpha').click();
        const entry = editor.locator('.sb-wi-entry');
        const content = entry.locator('.sb-wi-entry-textarea');
        await expect(content).toHaveValue('Alpha content');

        await content.fill('Edited content');
        await expect(entry.locator('.sb-wi-entry-dirty')).toBeVisible();
        expect((await readEntries(page))[0].content).toBe('Alpha content');

        await page.keyboard.press('Control+s');
        await expect(entry.locator('.sb-wi-entry-dirty')).toBeHidden();
        await expect.poll(async () => (await readEntries(page))[0].content).toBe('Edited content');

        await page.reload();
        await page.waitForFunction(() => window.SillyTavern?.getContext?.()?.eventSource?.autoFireLastArgs?.has('app_ready'), null, { timeout: 60000 });
        const reopened = await openBook(page);
        await row(reopened, 'Alpha').click();
        await expect(reopened.locator('.sb-wi-entry-textarea')).toHaveValue('Edited content');
    });

    test('guards switching entries and discards on request', async ({ page }) => {
        const editor = await openBook(page);
        await row(editor, 'Alpha').click();
        await editor.locator('.sb-wi-entry-textarea').fill('Unsaved');
        await row(editor, 'Beta').click();

        const dialog = page.locator('dialog.popup[open]');
        await expect(dialog).toBeVisible();
        await dialog.getByText('Discard', { exact: true }).click();
        await expect(editor.locator('.sb-wi-entry-textarea')).toHaveValue('Beta content');
        expect((await readEntries(page))[0].content).toBe('Alpha content');
    });

    test('row switch enables an entry immediately', async ({ page }) => {
        const editor = await openBook(page);
        const gamma = row(editor, 'Gamma').locator('input.sb-switch');
        await expect(gamma).not.toBeChecked();
        await gamma.check();
        await expect.poll(async () => (await readEntries(page))[2].disable).toBe(false);
    });

    test('row toggles keep Priority positions and Active matches until a deliberate sort change', async ({ page }) => {
        const editor = await openBook(page);
        await selectSortOrFilter(page, editor, 'All');
        await selectSortOrFilter(page, editor, 'Priority');
        const orderedTitles = () => editor.locator('.sb-wi-row').evaluateAll(rows => rows.map(row => row.getAttribute('aria-label')));
        const before = await orderedTitles();
        const alphaIndex = before.indexOf('Alpha');
        await row(editor, 'Alpha').locator('input.sb-switch').uncheck();
        await expect.poll(async () => (await readEntries(page))[0].disable).toBe(true);
        await expect(row(editor, 'Alpha')).toHaveClass(/is-disabled/);
        expect((await orderedTitles()).indexOf('Alpha')).toBe(alphaIndex);
        await selectSortOrFilter(page, editor, 'Title A-Z');
        await selectSortOrFilter(page, editor, 'Priority');
        await expect.poll(async () => (await orderedTitles()).indexOf('Alpha')).not.toBe(alphaIndex);
        await row(editor, 'Alpha').locator('input.sb-switch').check();
        await expect.poll(async () => (await readEntries(page))[0].disable).toBe(false);
        await selectSortOrFilter(page, editor, 'Active');
        await expect(editor.locator('.sb-wi-row')).toHaveCount(2);
        const activeBefore = await orderedTitles();
        await row(editor, 'Alpha').locator('input.sb-switch').uncheck();
        await expect.poll(async () => (await readEntries(page))[0].disable).toBe(true);
        await expect(row(editor, 'Alpha')).toHaveClass(/is-disabled/);
        expect(await orderedTitles()).toEqual(activeBefore);
        await selectSortOrFilter(page, editor, 'Title A-Z');
        await expect(row(editor, 'Alpha')).toHaveCount(0);
        await expect(editor.locator('.sb-wi-row')).toHaveCount(1);
    });

    test('offers to reload when another writer changes a dirty entry', async ({ page }) => {
        const editor = await openBook(page);
        await row(editor, 'Alpha').click();
        await editor.locator('.sb-wi-entry-textarea').fill('Mine');
        await page.evaluate(async name => {
            const { loadWorldInfo, saveWorldInfo, reloadEditor } = await import('./scripts/world-info.js');
            const data = await loadWorldInfo(name);
            data.entries[0].comment = 'Alpha (external)';
            await saveWorldInfo(name, data, true);
            /** @type {HTMLElement} */ (document.activeElement)?.blur();
            reloadEditor(name);
        }, BOOK);
        await expect(editor.locator('.sb-wi-entry-banner')).toBeVisible();
        await expect(editor.locator('.sb-wi-entry-textarea')).toHaveValue('Mine');
    });

    test('settings apply immediately with no book open', async ({ page }) => {
        await page.evaluate(() => window.SillyBunnyShell.openTab('characters', 'world-info'));
        const editor = page.locator('#WorldInfo .sb-wi-editor');
        await expect(editor.locator('.sb-wi-settings-button')).toHaveCount(0);
        await editor.locator('.sb-wi-book-actions').click();
        await expect(page.locator('.sb-action-menu [aria-disabled="true"]')).toHaveCount(8);
        await page.getByRole('menuitem', { name: 'Global Settings', exact: true }).click();
        const recursive = editor.locator('#world_info_recursive');
        await expect(recursive).toBeVisible();
        const before = await recursive.isChecked();
        await recursive.click();
        await expect.poll(() => page.evaluate(async () => (await import('./scripts/world-info.js')).world_info_recursive)).toBe(!before);
        await recursive.click();
    });

    test('desktop list fills the shell, splits on selection, and Back returns to the full list', async ({ page }) => {
        const editor = await openBook(page);
        const list = editor.locator('.sb-wi-list');
        const width = async locator => (await locator.boundingBox()).width;
        await expect.poll(async () => Math.abs(await width(list) - await width(editor))).toBeLessThanOrEqual(2);
        await expect(editor.locator('.sb-wi-empty-detail')).toHaveCount(0);
        await row(editor, 'Alpha').click();
        await expect(editor).toHaveAttribute('data-open', 'true');
        await expect.poll(async () => await width(list) / await width(editor)).toBeLessThan(0.5);
        await editor.locator('.sb-wi-entry .sb-wi-detail-back').click();
        await expect.poll(async () => Math.abs(await width(list) - await width(editor))).toBeLessThanOrEqual(2);
        await expect(row(editor, 'Alpha')).toBeFocused();
    });

    test('each header and row trigger toggles closed and picker keeps its title button pressed', async ({ page }) => {
        const editor = await openBook(page);
        const picker = editor.locator('.sb-wi-book-switcher');
        await picker.click();
        const popover = page.locator('.sb-picker');
        await expect(popover).toBeVisible();
        await expect(picker).toHaveCSS('transform', 'none');
        await expect(picker).toHaveAttribute('aria-expanded', 'true');
        // Wait for the scale animation to finish before checking pixel geometry.
        await popover.evaluate(node => Promise.all(node.getAnimations().map(animation => animation.finished)));
        const anchor = await picker.boundingBox();
        const bounds = await popover.boundingBox();
        expect(Math.abs(bounds.x - anchor.x)).toBeLessThanOrEqual(2);
        expect(bounds.width).toBeGreaterThanOrEqual(Math.min(anchor.width, 560) - 1);
        await picker.click();
        await expect(popover).toBeHidden();
        await expect(picker).toHaveAttribute('aria-expanded', 'false');
        for (const trigger of [editor.locator('.sb-wi-list-header button:has(.fa-ellipsis-vertical)'), editor.locator('.sb-wi-sort-button'), row(editor, 'Alpha').locator('.sb-wi-row-menu')]) {
            await trigger.click();
            await expect(trigger).toHaveAttribute('aria-expanded', 'true');
            await trigger.click();
            await expect(trigger).toHaveAttribute('aria-expanded', 'false');
            await expect(page.locator('.sb-action-popover:visible')).toHaveCount(0);
        }
        await selectSettings(page, editor);
        await expect(editor.locator('.sb-wi-settings')).toBeVisible();
        await selectSettings(page, editor);
        await expect(editor.locator('.sb-wi-settings')).toHaveCount(0);
        await expect(editor.locator('.sb-wi-book-actions')).toBeFocused();
        await selectSettings(page, editor);
        await editor.locator('.sb-wi-settings .sb-wi-detail-back').click();
        await expect(editor.locator('.sb-wi-book-actions')).toBeFocused();
    });
});

test.describe('World Info editor on mobile', () => {
    test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });

    test('opens an entry and returns to the list', async ({ page }) => {
        const editor = await openBook(page);
        await page.locator('#sb-settings-tab-list .sb-settings-tab[data-sb-settings-tab="world-info"]').click().catch(() => {});
        await row(editor, 'Beta').click();
        const back = editor.locator('.sb-wi-entry .sb-wi-detail-back');
        await expect(back).toBeVisible();
        const box = await back.boundingBox();
        expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
        await back.click();
        await expect(row(editor, 'Beta')).toBeVisible();
    });

    test('keeps Back and the compact preview toggle visible while scrolling the entry', async ({ page }) => {
        const editor = await openBook(page);
        await row(editor, 'Alpha').click();
        const entry = editor.locator('.sb-wi-entry');
        const toggle = entry.locator('.sb-wi-entry-mode-toggle');
        await expect(entry.locator('.sb-wi-entry-modes')).toBeHidden();
        await toggle.click();
        await expect(entry.locator('.sb-wi-entry-preview')).toHaveText('Alpha content');
        await expect(entry.locator('.sb-wi-entry-textarea')).toBeHidden();
        await toggle.click();
        await entry.locator('.sb-wi-entry-footer').scrollIntoViewIfNeeded();
        await expect(entry.locator('.sb-wi-entry-header')).not.toHaveClass(/sb-editor-chrome-hidden/);
        await expect(entry.locator('.sb-wi-detail-back')).toBeInViewport();
        await expect(toggle).toBeInViewport();
        await entry.locator('.sb-wi-detail-back').click();
        await expect(row(editor, 'Alpha')).toBeVisible();
    });
});
