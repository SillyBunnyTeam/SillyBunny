import { expect, test } from '@playwright/test';
import { gunzipSync } from 'node:zlib';

const BOOK = `WI_EDITOR_E2E_${Date.now()}`;
const TARGET_BOOK = `${BOOK}_TARGET`;

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
    await page.evaluate(async names => {
        const worldInfo = await import('./scripts/world-info.js');
        for (const name of names) {
            if (worldInfo.world_names.includes(name)) await worldInfo.deleteWorldInfo(name);
            for (const key of Object.keys(localStorage)) if (key.startsWith('sb-wi-editor-draft-') && key.includes(encodeURIComponent(name))) localStorage.removeItem(key);
        }
        await worldInfo.updateWorldInfoList();
        if (names.some(name => worldInfo.world_names.includes(name))) throw new Error('Test lorebook cleanup failed');
    }, [BOOK, TARGET_BOOK]);
});

const readEntries = (page, name = BOOK) => page.evaluate(async name => {
    const { getRequestHeaders } = await import('./script.js');
    const response = await fetch('/api/worldinfo/get', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ name }) });
    return (await response.json()).entries;
}, name);

async function openBook(page, expectedCount = 3) {
    await page.evaluate(async name => {
        const { openWorldInfoEditor } = await import('./scripts/world-info.js');
        openWorldInfoEditor(name);
    }, BOOK);
    const editor = page.locator('#WorldInfo .sb-wi-editor');
    await expect(editor.locator('.sb-wi-row')).toHaveCount(expectedCount);
    return editor;
}

const row = (editor, title) => editor.locator('.sb-wi-row', { hasText: title });

async function enterSelection(page, editor) {
    await editor.locator('.sb-wi-book-actions').click();
    await page.getByRole('menuitem', { name: 'Select', exact: true }).click();
    await expect(editor).toHaveAttribute('data-selection-mode', 'true');
    await expect(editor.locator('.sb-selection-cancel')).toBeFocused();
}

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

    test('properties bar owns insertion fields, preserves draft isolation, and persists after reopen', async ({ page }) => {
        const editor = await openBook(page);
        await row(editor, 'Alpha').click();
        const entry = editor.locator('.sb-wi-entry');
        const bar = entry.locator(':scope > .sb-wi-properties');
        await expect(bar).toBeVisible();
        await expect(entry.locator('.sb-wi-property-summary')).toBeHidden();
        await expect(entry.locator('.sb-wi-entry-body [data-sb-editor-field="section-entry"], .sb-wi-entry-body [data-sb-editor-field="section-insertion"]')).toHaveCount(0);
        await expect(entry.locator('.sb-wi-entry-body [data-sb-editor-field="enabled"], .sb-wi-entry-body [data-sb-editor-field="position"]')).toHaveCount(0);
        await bar.getByRole('button', { name: 'Strategy', exact: true }).click();
        await page.getByRole('option', { name: 'Constant', exact: true }).click();
        await entry.locator('.sb-wi-entry-save').focus();
        await page.keyboard.press('Tab');
        await expect(bar.getByRole('button', { name: 'Strategy', exact: true })).toBeFocused();
        await bar.getByRole('button', { name: 'Position', exact: true }).click();
        await page.getByRole('option', { name: '@D 👤', exact: true }).click();
        await expect(bar.getByRole('spinbutton', { name: 'Depth', exact: true })).toBeVisible();
        await expect(bar.getByRole('textbox', { name: 'Outlet Name', exact: true })).toBeHidden();
        await bar.getByRole('spinbutton', { name: 'Depth', exact: true }).fill('8');
        await bar.getByRole('spinbutton', { name: 'Order', exact: true }).fill('250');
        await bar.getByRole('spinbutton', { name: 'Trigger %', exact: true }).fill('45');
        await page.keyboard.press('Tab');
        expect(await entry.locator('.sb-wi-entry-body').evaluate(node => node.contains(document.activeElement))).toBe(true);
        expect((await readEntries(page))[0]).toMatchObject({ constant: false, position: 0, order: 100 });
        await entry.locator('.sb-wi-entry-save').click();
        await expect(entry.locator('.sb-wi-entry-dirty')).toBeHidden();
        expect((await readEntries(page))[0]).toMatchObject({ constant: true, vectorized: false, position: 4, role: 1, depth: 8, order: 250, probability: 45 });
        await page.reload();
        await page.waitForFunction(() => window.SillyTavern?.getContext?.()?.eventSource?.autoFireLastArgs?.has('app_ready'), null, { timeout: 60000 });
        const reopened = await openBook(page);
        await row(reopened, 'Alpha').click();
        await expect(reopened.getByRole('spinbutton', { name: 'Depth', exact: true })).toHaveValue('8');
        await expect(reopened.getByRole('spinbutton', { name: 'Trigger %', exact: true })).toHaveValue('45');
    });

    test('expanded content writes through the draft, saves explicitly, and reopens', async ({ page }) => {
        const editor = await openBook(page);
        await row(editor, 'Alpha').click();
        const entry = editor.locator('.sb-wi-entry');
        const textarea = entry.locator('.sb-wi-entry-textarea');
        const expand = entry.locator('.sb-wi-entry-footer .editor_maximize');
        await expect(expand).toHaveAttribute('data-for', await textarea.getAttribute('id'));
        await expect(expand.locator('.fa-solid.fa-maximize')).toHaveCount(1);
        const minHeight = await textarea.evaluate(node => parseFloat(getComputedStyle(node).minHeight));
        expect(minHeight).toBeGreaterThanOrEqual(320);
        await expect(textarea).toHaveCSS('resize', 'vertical');
        await expand.click();
        const popup = page.locator('dialog.popup[open]');
        await expect(popup.locator('.maximized_textarea')).toHaveValue('Alpha content');
        await popup.locator('.maximized_textarea').fill('Expanded WI content');
        await popup.locator('.popup-button-ok').click();
        await expect(textarea).toHaveValue('Expanded WI content');
        await expect(expand).toBeFocused();
        await expect(entry.locator('.sb-wi-entry-dirty')).toBeVisible();
        expect((await readEntries(page))[0].content).toBe('Alpha content');
        await entry.locator('.sb-wi-entry-modes label').filter({ hasText: 'Preview' }).click();
        await expect(expand).toBeHidden();
        await entry.locator('.sb-wi-entry-modes label').filter({ hasText: 'Edit' }).click();
        await entry.locator('.sb-wi-entry-save').click();
        await expect(entry.locator('.sb-wi-entry-dirty')).toBeHidden();
        await entry.locator('.sb-wi-detail-back').click();
        await row(editor, 'Alpha').click();
        await expect(textarea).toHaveValue('Expanded WI content');
        expect((await readEntries(page))[0].content).toBe('Expanded WI content');
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
        await expect(page.locator('.sb-action-menu [aria-disabled="true"]')).toHaveCount(9);
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

    test('properties sheet edits survive Escape, explicit save, and persisted reopen', async ({ page }) => {
        const editor = await openBook(page);
        await row(editor, 'Alpha').click();
        const entry = editor.locator('.sb-wi-entry');
        const summary = entry.locator('.sb-wi-property-summary');
        await expect(summary).toBeVisible();
        await expect(entry.locator(':scope > .sb-wi-properties')).toBeHidden();
        await summary.click();
        const sheet = page.locator('.sb-wi-property-sheet');
        await expect(sheet).toBeVisible();
        await sheet.getByRole('button', { name: 'Position', exact: true }).click();
        await page.getByRole('option', { name: '➡️ Outlet', exact: true }).click();
        await sheet.getByRole('textbox', { name: 'Outlet Name', exact: true }).fill('mobile-outlet');
        await expect(sheet.getByRole('spinbutton', { name: 'Depth', exact: true })).toBeHidden();
        await sheet.getByRole('spinbutton', { name: 'Order', exact: true }).fill('350');
        await sheet.getByRole('spinbutton', { name: 'Trigger %', exact: true }).fill('60');
        const target = await sheet.getByRole('button', { name: 'Position', exact: true }).boundingBox();
        expect(target.height).toBeGreaterThanOrEqual(44);
        await page.keyboard.press('Escape');
        await expect(sheet).toBeHidden();
        await expect(entry).toBeVisible();
        await expect(summary).toBeFocused();
        await expect(summary).toContainText('mobile-outlet');
        await expect(summary).toContainText('60%');
        expect((await readEntries(page))[0].position).toBe(0);
        await summary.click();
        await expect(sheet.getByRole('textbox', { name: 'Outlet Name', exact: true })).toHaveValue('mobile-outlet');
        await sheet.getByRole('button', { name: 'Close', exact: true }).click();
        await entry.locator('.sb-wi-entry-save').click();
        await expect(entry.locator('.sb-wi-entry-dirty')).toBeHidden();
        await page.reload();
        await page.waitForFunction(() => window.SillyTavern?.getContext?.()?.eventSource?.autoFireLastArgs?.has('app_ready'), null, { timeout: 60000 });
        const reopened = await openBook(page);
        await row(reopened, 'Alpha').click();
        await expect(reopened.locator('.sb-wi-property-summary')).toContainText('mobile-outlet');
        expect((await readEntries(page))[0]).toMatchObject({ position: 7, role: null, outletName: 'mobile-outlet', order: 350, probability: 60 });
        const expand = reopened.locator('.sb-wi-entry-expand');
        await expand.scrollIntoViewIfNeeded();
        const expandBounds = await expand.boundingBox();
        expect(expandBounds.width).toBeGreaterThanOrEqual(44);
        expect(expandBounds.height).toBeGreaterThanOrEqual(44);
    });
});

test.describe('World Info selection mode', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('menu selection supports row clicks, Space, Ctrl/Cmd+A and Escape focus return', async ({ page }) => {
        const editor = await openBook(page);
        await enterSelection(page, editor);
        await expect(editor.locator('.sb-wi-list-header')).toBeHidden();
        await expect(editor.locator('.sb-selection-title')).toHaveText('0 lorum ipsum');
        await expect(editor.locator('.sb-selection-action:disabled')).toHaveCount(4);
        await row(editor, 'Alpha').click();
        await expect(row(editor, 'Alpha').locator('.sb-selection-check')).toBeChecked();
        await expect(editor.locator('.sb-wi-entry')).toHaveCount(0);
        await row(editor, 'Beta').focus();
        await page.keyboard.press('Space');
        await expect(editor.locator('.sb-selection-title')).toHaveText('2 lorum ipsum');
        await page.keyboard.press('Control+a');
        await expect(editor.locator('.sb-selection-title')).toHaveText('3 lorum ipsum');
        await editor.locator('.sb-selection-select-all').click();
        await expect(editor.locator('.sb-selection-title')).toHaveText('0 lorum ipsum');
        await page.keyboard.press('Meta+a');
        await expect(editor.locator('.sb-selection-title')).toHaveText('3 lorum ipsum');
        await page.keyboard.press('Escape');
        await expect(editor).toHaveAttribute('data-selection-mode', 'false');
        await expect(editor.locator('.sb-wi-book-actions')).toBeFocused();
        await expect(editor.locator('.sb-selection-check')).toHaveCount(0);
    });

    test('bulk enable/disable commits once and preserves dirty content and list order', async ({ page }) => {
        const editor = await openBook(page);
        await row(editor, 'Alpha').click();
        await editor.locator('.sb-wi-entry-textarea').fill('Still an unsaved draft');
        const before = await editor.locator('.sb-wi-row').evaluateAll(rows => rows.map(row => row.dataset.uid));
        await enterSelection(page, editor);
        await row(editor, 'Alpha').click();
        await row(editor, 'Beta').click();
        const saves = [];
        page.on('request', request => {
            if (request.url().endsWith('/api/worldinfo/edit')) saves.push(request);
        });
        await editor.locator('[data-action-id="disable"]').click();
        await expect.poll(async () => Object.values(await readEntries(page)).every(entry => entry.disable)).toBe(true);
        expect(saves).toHaveLength(1);
        expect(await editor.locator('.sb-wi-row').evaluateAll(rows => rows.map(row => row.dataset.uid))).toEqual(before);
        await expect(editor.locator('.sb-wi-entry-textarea')).toHaveValue('Still an unsaved draft');
        await expect(editor.locator('.sb-wi-entry-dirty')).toBeVisible();
        await editor.locator('[data-action-id="enable"]').click();
        await expect.poll(async () => {
            const entries = await readEntries(page);
            return [entries[0].disable, entries[1].disable];
        }).toEqual([false, false]);
        expect(saves).toHaveLength(2);
        await expect(editor.locator('.sb-wi-entry-dirty')).toBeVisible();
        await editor.locator('.sb-selection-cancel').click();
        await editor.locator('.sb-wi-entry-cancel').click();
        await expect(editor.locator('.sb-wi-entry-dirty')).toBeHidden();
    });

    test('bulk Delete confirms once, commits once and closes a removed open entry', async ({ page }) => {
        const editor = await openBook(page);
        await row(editor, 'Alpha').click();
        await enterSelection(page, editor);
        await row(editor, 'Alpha').click();
        await row(editor, 'Beta').click();
        const saves = [];
        page.on('request', request => {
            if (request.url().endsWith('/api/worldinfo/edit')) saves.push(request);
        });
        await editor.locator('[data-action-id="delete"]').click();
        const popup = page.locator('dialog.popup[open]');
        await expect(popup).toContainText('(2)');
        await popup.locator('.popup-button-ok').click();
        await expect.poll(async () => Object.keys(await readEntries(page))).toEqual(['2']);
        expect(saves).toHaveLength(1);
        await expect(editor.locator('.sb-wi-entry')).toHaveCount(0);
        await expect(editor.locator('.sb-selection-title')).toHaveText('0 lorum ipsum');
    });

    test('bulk Copy retains sources and selection; bulk Move removes sources and clears selection', async ({ page }) => {
        await page.evaluate(async name => {
            const { saveWorldInfo, updateWorldInfoList } = await import('./scripts/world-info.js');
            if (!await saveWorldInfo(name, { entries: {} }, true)) throw new Error('Could not save target lorebook');
            await updateWorldInfoList();
        }, TARGET_BOOK);
        const editor = await openBook(page);
        await row(editor, 'Alpha').click();
        await enterSelection(page, editor);
        await row(editor, 'Alpha').click();
        await row(editor, 'Beta').click();
        const transfer = async label => {
            await editor.locator('[data-action-id="move"]').click();
            await page.locator('.sb-picker__option').filter({ hasText: TARGET_BOOK }).click();
            await page.locator('dialog.popup[open]').getByText(label, { exact: true }).click();
        };
        await transfer('Copy');
        await expect.poll(async () => Object.values(await readEntries(page, TARGET_BOOK)).map(entry => entry.comment).sort()).toEqual(['Alpha', 'Beta']);
        await expect(editor.locator('.sb-selection-title')).toHaveText('2 lorum ipsum');
        expect(Object.keys(await readEntries(page))).toHaveLength(3);
        await expect(editor.locator('.sb-wi-entry')).toBeVisible();
        await transfer('Move');
        await expect.poll(async () => Object.keys(await readEntries(page))).toEqual(['2']);
        await expect.poll(async () => Object.keys(await readEntries(page, TARGET_BOOK)).length).toBe(4);
        await expect(editor.locator('.sb-selection-title')).toHaveText('0 lorum ipsum');
        await expect(editor.locator('.sb-wi-entry')).toHaveCount(0);
    });

    test('paging and filtering retain selection and a book change exits it', async ({ page }) => {
        await page.evaluate(async name => {
            const { loadWorldInfo, saveWorldInfo } = await import('./scripts/world-info.js');
            const { accountStorage } = await import('./scripts/util/AccountStorage.js');
            accountStorage.setItem('WI_PerPage', '10');
            const data = await loadWorldInfo(name);
            for (let uid = 3; uid < 12; uid++) data.entries[uid] = { ...data.entries[0], uid, comment: `Extra ${uid}`, displayIndex: uid };
            await saveWorldInfo(name, data, true);
        }, BOOK);
        const editor = await openBook(page, 10);
        await editor.getByRole('listitem', { name: 'Alpha', exact: true }).click({ button: 'right' });
        await expect(editor.locator('.sb-selection-title')).toHaveText('1 lorum ipsum');
        await editor.locator('.sb-list-pagination__next').click();
        await expect(editor.locator('.sb-wi-row')).toHaveCount(2);
        await editor.locator('.sb-selection-select-all').click();
        await expect(editor.locator('.sb-selection-title')).toHaveText('3 lorum ipsum');
        await editor.locator('.sb-wi-search').evaluate(node => { node.value = 'missing'; node.dispatchEvent(new Event('input', { bubbles: true })); });
        await expect(editor.locator('.sb-wi-list-status')).toHaveText('No results');
        await expect(editor.locator('.sb-selection-title')).toHaveText('3 lorum ipsum');
        await page.evaluate(async () => (await import('./scripts/world-info.js')).openWorldInfoEditor(''));
        await expect(editor).toHaveAttribute('data-selection-mode', 'false');
    });
});

test.describe('World Info selection touch entry', () => {
    test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

    test('long press selects without opening and action targets stay visible and at least 44px', async ({ page }) => {
        const editor = await openBook(page);
        await page.locator('#sb-settings-tab-list .sb-settings-tab[data-sb-settings-tab="world-info"]').click();
        const alpha = row(editor, 'Alpha');
        await expect(alpha).toBeInViewport();
        await alpha.dispatchEvent('pointerdown', { pointerType: 'touch', pointerId: 1, clientX: 100, clientY: 200 });
        await expect(editor).toHaveAttribute('data-selection-mode', 'true');
        await alpha.dispatchEvent('pointerup', { pointerType: 'touch', pointerId: 1 });
        await alpha.dispatchEvent('click');
        await expect(alpha.locator('.sb-selection-check')).toBeChecked();
        await expect(editor.locator('.sb-wi-entry')).toHaveCount(0);
        for (const action of await editor.locator('.sb-selection-action').all()) {
            await expect(action).toBeInViewport();
            const box = await action.boundingBox();
            expect(box.width).toBeGreaterThanOrEqual(44);
            expect(box.height).toBeGreaterThanOrEqual(44);
        }
        await editor.locator('.sb-selection-cancel').click();
        await expect(alpha).toBeFocused();
    });
});
