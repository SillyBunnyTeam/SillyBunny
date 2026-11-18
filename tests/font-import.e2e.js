import { expect, test } from '@playwright/test';
import { gunzipSync } from 'node:zlib';
import { waitForAppReady } from './helpers/app-ready.js';
import { buildFontTables } from './helpers/font-fixtures.js';
import { protectMaintainerServer, showToasts } from './helpers/maintainer-server.js';
import { fetchJsonOrSkip } from './helpers/route-fetch.js';

// Importing fonts in Font Settings. The fonts are built from bytes in this file; nothing is downloaded. The upload and delete
// routes are the server's own, so an imported file is written to and removed from the throwaway server's `user/files`.

test.setTimeout(90_000);
test.use({ serviceWorkers: 'block' });

const FONT_REJECTED = /OTS parsing error|Failed to decode downloaded font/;
const ROW = '[data-sb-editor-field="google-font-preset"]';
const NOT_READABLE = { platform: 2 };

/**
 * Serves the saved fonts back after a reload: saves are stubbed, so the last saved `power_user` fields are written into the next
 * settings response. `initial` edits the first response, for a test that starts from stored settings.
 */
async function routeSettings(page, initial = () => {}) {
    const state = { saved: [], power: null };
    await page.route('**/api/settings/get', async route => {
        const payload = await fetchJsonOrSkip(route);
        if (!payload) return;
        const settings = JSON.parse(payload.settings);
        settings.power_user ??= {};
        if (state.power) Object.assign(settings.power_user, state.power);
        else initial(settings);
        return route.fulfill({ json: { ...payload, settings: JSON.stringify(settings) } });
    });
    await page.route('**/api/settings/save', route => {
        const request = route.request();
        const body = request.headers()['content-encoding'] === 'gzip' ? gunzipSync(request.postDataBuffer()) : request.postDataBuffer();
        const payload = JSON.parse(body.toString());
        state.saved.push(payload);
        state.power = { google_font: payload.power_user?.google_font ?? '', sb_fonts: payload.power_user?.sb_fonts ?? [] };
        return route.fulfill({ json: { result: 'ok', version: (payload._version ?? 0) + 1 } });
    });
    return state;
}

const stubStylesheets = page => page.route(/fonts\.googleapis\.com|\/webfonts\/(?:Inter|JetBrainsMono|Roboto|PublicSans|SourceSerif4)\/stylesheet\.css/, route => route.fulfill({ contentType: 'text/css', body: '' }));

async function boot(page) {
    await page.goto('/');
    await waitForAppReady(page);
}

async function openFontRow(page) {
    await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'appearance'));
    const row = page.locator(ROW);
    await expect(row).toBeVisible();
    await row.scrollIntoViewIfNeeded();
    return row;
}

const trigger = row => row.locator('.ds-select-row__trigger');
const power = page => page.evaluate(async () => {
    const { power_user } = await import('/scripts/power-user.js');
    return { choice: power_user.google_font, fonts: structuredClone(power_user.sb_fonts) };
});

async function openList(page, row) {
    await trigger(row).click();
    const list = page.locator('.sb-action-popover, .sb-action-sheet').filter({ has: page.locator('.sb-picker__list') }).last();
    await expect(list.locator('.sb-picker__list')).toBeVisible();
    return list;
}

async function choose(page, row, name) {
    const list = await openList(page, row);
    await list.getByRole('option', { name, exact: true }).click();
    await expect(trigger(row)).toHaveText(name);
}

async function openMenu(page, row) {
    await row.getByRole('button', { name: 'Font Actions', exact: true }).click();
    const menu = page.locator('.sb-action-menu[role="menu"], .sb-action-sheet:visible').last();
    await expect(menu.getByRole('menuitem', { name: 'Import Font', exact: true })).toBeVisible();
    return menu;
}

const importFile = (page, buffer, name) => page.locator('#sb_font_import_input').setInputFiles({ name, mimeType: 'application/octet-stream', buffer });
const familyOf = page => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--mainFontFamily'));
const fontLoads = (page, family) => page.evaluate(async name => {
    await document.fonts.load(`16px '${name}'`, 'abc');
    return { check: document.fonts.check(`16px '${name}'`), faces: [...document.fonts].filter(face => face.family.replace(/['"]/g, '') === name).map(face => face.status) };
}, family);

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    test.describe(`Font import at ${viewport.width}px`, () => {
        test.use({ viewport, hasTouch: viewport.width === 390, isMobile: viewport.width === 390 });

        test.beforeEach(async ({ page }) => {
            await protectMaintainerServer(page);
        });

        test('an imported font is listed, applied, kept over a reload and removed while it is in use', async ({ page }) => {
            const rejected = [];
            page.on('console', message => {
                if (FONT_REJECTED.test(message.text())) rejected.push(message.text());
            });
            const state = await routeSettings(page);
            await stubStylesheets(page);
            await boot(page);
            const row = await openFontRow(page);
            await expect(trigger(row)).toHaveText('Default (none)');
            expect(await openMenu(page, row)).toBeTruthy();
            await page.keyboard.press('Escape');

            await importFile(page, buildFontTables({ family: 'Sweep Test Face', weight: 700, subfamily: 'Bold' }).build(), 'whatever-the-file-is-called.ttf');
            await expect.poll(async () => (await power(page)).fonts.length).toBe(1);
            const [stored] = (await power(page)).fonts;
            expect(stored).toMatchObject({ family: 'Sweep Test Face', weight: 700, style: 'normal', format: 'truetype' });
            expect(stored.file).toMatch(/^\/user\/files\/sb-font-[0-9a-f]{12}\.ttf$/);
            await expect.poll(() => state.saved.length).toBeGreaterThan(0);

            const list = await openList(page, row);
            await expect(list.locator('.sb-picker__group-heading')).toHaveText(['Presets', 'Imported']);
            await page.keyboard.press('Escape');

            await choose(page, row, 'Sweep Test Face');
            await expect.poll(() => familyOf(page)).toBe('\'Sweep Test Face\', \'Adwaita Sans\', system-ui, sans-serif');
            await expect.poll(async () => (await fontLoads(page, 'Sweep Test Face')).check).toBe(true);
            expect((await fontLoads(page, 'Sweep Test Face')).faces).toEqual(['loaded']);
            expect((await page.request.get(stored.file)).status()).toBe(200);
            await expect.poll(async () => (await power(page)).choice).toBe('Sweep Test Face');
            // Saves are debounced and stubbed, so the reload waits for the one that holds the choice.
            await expect.poll(() => state.saved.at(-1)?.power_user?.google_font).toBe('Sweep Test Face');

            await page.reload();
            await waitForAppReady(page);
            expect(await power(page)).toMatchObject({ choice: 'Sweep Test Face', fonts: [stored] });
            await expect.poll(() => familyOf(page)).toContain('Sweep Test Face');
            expect((await fontLoads(page, 'Sweep Test Face')).check).toBe(true);
            const reloaded = await openFontRow(page);
            await expect(trigger(reloaded)).toHaveText('Sweep Test Face');

            await showToasts(page);
            const menu = await openMenu(page, reloaded);
            await menu.getByRole('menuitem', { name: 'Remove Font', exact: true }).click();
            const confirm = page.locator('dialog.sb-dialog-host[open]');
            await expect(confirm.getByRole('heading', { name: 'Remove Font' })).toBeVisible();
            await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
            await expect(confirm).toBeHidden();
            expect((await power(page)).fonts).toHaveLength(1);
            expect((await page.request.get(stored.file)).status()).toBe(200);

            await (await openMenu(page, reloaded)).getByRole('menuitem', { name: 'Remove Font', exact: true }).click();
            await page.locator('dialog.sb-dialog-host[open]').getByRole('button', { name: 'Delete', exact: true }).click();
            await expect(trigger(reloaded)).toHaveText('Default (none)');
            expect(await power(page)).toEqual({ choice: '', fonts: [] });
            expect(await familyOf(page)).not.toContain('Sweep Test Face');
            await expect(page.locator('#sb-imported-fonts')).toHaveCount(0);
            await expect.poll(async () => (await page.request.get(stored.file)).status()).toBe(404);
            // With nothing imported or selected, Remove Font is not offered.
            const bare = await openMenu(page, reloaded);
            await expect(bare.getByRole('menuitem', { name: 'Remove Font' })).toHaveCount(0);
            expect(rejected).toEqual([]);
        });

        test('a file whose family cannot be read is named in a dialog that opens with the file name\'s guess', async ({ page }) => {
            await routeSettings(page);
            await boot(page);
            const row = await openFontRow(page);
            const uploads = [];
            page.on('request', request => { if (request.url().endsWith('/api/files/upload')) uploads.push(request.url()); });

            await importFile(page, buildFontTables({ family: 'Hidden', ...NOT_READABLE }).build(), 'Nameless-BoldItalic.ttf');
            const dialog = page.locator('dialog.sb-dialog-host[open]:not([closing])');
            await expect(dialog.getByRole('heading', { name: 'Import Font' })).toBeVisible();
            await page.waitForTimeout(700);
            const frame = dialog.locator('section.sb-dialog');
            const geometry = await frame.evaluate(surface => {
                const box = node => node.getBoundingClientRect();
                const surfaceBox = box(surface);
                const header = surface.querySelector('.sb-dialog__header');
                const cancel = header.querySelector('.sb-dialog__header-start button');
                const confirm = header.querySelector('.sb-dialog__header-end button');
                const title = header.querySelector('.sb-dialog__title');
                return {
                    surfaceCenter: surfaceBox.left + surfaceBox.width / 2,
                    titleCenter: box(title).left + box(title).width / 2,
                    cancel: { text: cancel.textContent.trim(), left: box(cancel).left - surfaceBox.left, right: box(cancel).right },
                    confirm: { text: confirm.textContent.trim(), right: surfaceBox.right - box(confirm).right, left: box(confirm).left },
                    titleLeft: box(title).left,
                    titleRight: box(title).right,
                };
            });
            expect(geometry.cancel.text).toBe('Cancel');
            expect(geometry.confirm.text).toBe('Import');
            expect(Math.abs(geometry.titleCenter - geometry.surfaceCenter)).toBeLessThan(2);
            expect(geometry.cancel.right).toBeLessThanOrEqual(geometry.titleLeft);
            expect(geometry.confirm.left).toBeGreaterThanOrEqual(geometry.titleRight);
            expect(Math.abs(geometry.cancel.left - geometry.confirm.right)).toBeLessThan(2);

            await expect(dialog.getByRole('textbox', { name: 'Family' })).toHaveValue('Nameless');
            await expect(dialog.locator('[data-sb-editor-field="font-weight"] .ds-select-row__trigger')).toHaveText('700');
            await expect(dialog.locator('[data-sb-editor-field="font-style"]').getByRole('radio', { name: 'Italic' })).toBeChecked();
            // The Import response is off while the family is empty.
            const confirmButton = dialog.locator('.sb-dialog__header-end').getByRole('button', { name: 'Import', exact: true });
            await dialog.getByRole('textbox', { name: 'Family' }).fill('');
            await expect(confirmButton).toBeDisabled();
            await dialog.getByRole('textbox', { name: 'Family' }).fill('Named By Hand');
            await expect(confirmButton).toBeEnabled();
            await confirmButton.click();
            await expect.poll(async () => (await power(page)).fonts.length).toBe(1);
            expect((await power(page)).fonts[0]).toMatchObject({ family: 'Named By Hand', weight: 700, style: 'italic' });
            expect(uploads).toHaveLength(1);

            // Cancel keeps a second unreadable file out.
            await importFile(page, buildFontTables({ family: 'Hidden', ...NOT_READABLE }).build(), 'Other-Regular.ttf');
            await expect(dialog.getByRole('heading', { name: 'Import Font' })).toBeVisible();
            await dialog.locator('.sb-dialog__header-start').getByRole('button', { name: 'Cancel', exact: true }).click();
            await expect(dialog).toBeHidden();
            expect((await power(page)).fonts).toHaveLength(1);
            expect(uploads).toHaveLength(1);

            await trigger(row).click();
            await expect(page.locator('.sb-picker__option').filter({ hasText: 'Named By Hand' })).toBeVisible();
            const { fonts } = await power(page);
            await page.request.post('/api/files/delete', { data: { path: fonts[0].file } });
        });

        test('a file that fails the checks is named in an error and nothing is uploaded', async ({ page }) => {
            await routeSettings(page);
            await boot(page);
            await openFontRow(page);
            await showToasts(page);
            const uploads = [];
            page.on('request', request => { if (request.url().endsWith('/api/files/upload')) uploads.push(request.url()); });
            await importFile(page, Buffer.from('MZ this is a program'), 'program.ttf');
            await expect(page.locator('.toast-error').filter({ hasText: 'program.ttf' })).toBeVisible();
            expect(uploads).toHaveLength(0);
            expect((await power(page)).fonts).toEqual([]);
        });

        test('a saved Google Fonts name stays applied and listed under its own group until another font is picked', async ({ page }) => {
            const googleRequests = [];
            page.on('request', request => { if (request.url().includes('fonts.googleapis.com')) googleRequests.push(request.url()); });
            await routeSettings(page, settings => { settings.power_user.google_font = 'Lobster Two'; });
            await stubStylesheets(page);
            await boot(page);
            expect(await familyOf(page)).toBe('\'Lobster Two\', \'Adwaita Sans\', system-ui, sans-serif');
            await expect(page.locator('#google-font-style')).toHaveAttribute('href', /family=Lobster%20Two/);
            const row = await openFontRow(page);
            await expect(trigger(row)).toHaveText('Lobster Two');
            const subtitle = row.locator('.ds-row-text > .ds-row-subtitle').first();
            await expect(subtitle).not.toHaveText('Pick a locally saved global font for the user interface.');
            await expect(subtitle).toHaveAttribute('data-sb-copy-placeholder', 'true');
            const list = await openList(page, row);
            await expect(list.locator('.sb-picker__group-heading')).toHaveText(['Presets', 'Google Fonts']);
            await list.getByRole('option', { name: 'Inter', exact: true }).click();
            await expect(trigger(row)).toHaveText('Inter');
            await expect(subtitle).toHaveText('Pick a locally saved global font for the user interface.');
            await expect(page.locator('#google-font-style')).toHaveCount(0);
            await expect(page.locator('#sb-preset-font-style')).toHaveAttribute('href', /^webfonts\/Inter\/stylesheet\.css\?v=/);
            const after = googleRequests.length;
            const second = await openList(page, row);
            await expect(second.locator('.sb-picker__group-heading')).toHaveText(['Presets']);
            await expect(second.getByRole('option', { name: 'Lobster Two' })).toHaveCount(0);
            expect(googleRequests.length).toBe(after);
            expect((await power(page)).choice).toBe('Inter');
        });

        test('a name that differs from a preset only by case becomes the preset and makes no Google request', async ({ page }) => {
            const googleRequests = [];
            page.on('request', request => { if (request.url().includes('fonts.googleapis.com')) googleRequests.push(request.url()); });
            const state = await routeSettings(page, settings => { settings.power_user.google_font = 'public SANS'; });
            await stubStylesheets(page);
            await boot(page);
            await expect.poll(async () => (await power(page)).choice).toBe('Public Sans');
            await expect.poll(() => state.saved.at(-1)?.power_user?.google_font).toBe('Public Sans');
            await expect(page.locator('#sb-preset-font-style')).toHaveAttribute('href', /PublicSans/);
            expect(googleRequests).toEqual([]);
            const row = await openFontRow(page);
            await expect(trigger(row)).toHaveText('Public Sans');
        });
    });
}

test('default settings load no fonts module and request no font, preset or Google file at startup', async ({ page }) => {
    await protectMaintainerServer(page);
    await routeSettings(page, settings => {
        settings.power_user.google_font = '';
        settings.power_user.sb_fonts = [];
    });
    const requests = [];
    page.on('request', request => requests.push(new URL(request.url()).pathname + new URL(request.url()).hostname));
    await boot(page);
    await openFontRow(page);
    await page.waitForTimeout(1500);
    const unwanted = requests.filter(url => /sillybunny-fonts\.js|\/webfonts\/(?:Inter|JetBrainsMono|Roboto|PublicSans|SourceSerif4)\/|googleapis|gstatic|\/user\/files\/sb-font-/.test(url));
    expect(unwanted).toEqual([]);
    await expect(page.locator('#sb-imported-fonts, #sb-preset-font-style, #google-font-style')).toHaveCount(0);
});
