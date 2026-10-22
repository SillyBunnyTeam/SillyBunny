import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { openQuietChatForSmoke } from './chat-scroll-regression-helpers.js';
import { protectMaintainerServer } from './helpers/maintainer-server.js';

const publicRoot = path.resolve(fileURLToPath(new URL('../public/', import.meta.url)));
const WORLD_BOOK = `SB_MOBILE_OVERLAYS_${Date.now()}`;
const layouts = [
    { name: 'phone', width: 390, height: 844, mobile: true },
    { name: 'large phone', width: 600, height: 844, mobile: true },
    { name: 'tablet portrait', width: 768, height: 1024, mobile: true },
    { name: 'short landscape', width: 844, height: 390, mobile: false },
    { name: 'desktop', width: 1440, height: 900, mobile: false },
];

test.describe.configure({ timeout: 90_000 });

async function waitForApp(page) {
    await page.waitForFunction(() => window.SillyTavern?.getContext?.()?.eventSource?.autoFireLastArgs?.has('app_ready'), null, { timeout: 60_000 });
}

async function openPersonaEntry(page) {
    await page.evaluate(async () => {
        const { user_avatar } = await import('/scripts/personas.js');
        const { openPersonaEditor } = await import('/scripts/sillybunny-persona-editor.js');
        if (!await openPersonaEditor({ avatarId: user_avatar })) throw new Error('Could not open the current persona.');
    });
    const entry = page.locator('.sb-persona-entry');
    await expect(entry).toBeVisible();
    return entry;
}

async function openPromptEntry(page) {
    await page.evaluate(() => window.SillyBunnyShell.openTab('left', 'editor'));
    await page.getByRole('tab', { name: 'Editor', exact: true }).click();
    await page.locator('.sb-prompt-row[data-prompt-id="main"] .sb-prompt-row-name').click();
    const editor = page.locator('.sb-prompt-detail');
    await expect(editor).toBeVisible();
    return editor;
}

async function installWorldInfoFixture(page) {
    const entry = (uid, comment) => ({
        uid,
        comment,
        key: [comment.toLowerCase()],
        keysecondary: [],
        content: `${comment} content`,
        constant: false,
        vectorized: false,
        selective: true,
        order: 100,
        position: 0,
        disable: false,
        displayIndex: uid,
    });
    const book = { entries: { 0: entry(0, 'Alpha'), 1: entry(1, 'Beta') } };
    await page.route('**/api/settings/get', async route => {
        const response = await route.fetch();
        return route.fulfill({ response, json: { ...(await response.json()), world_names: [WORLD_BOOK] } });
    });
    await page.route('**/api/worldinfo/**', route => {
        const endpoint = new URL(route.request().url()).pathname.split('/').at(-1);
        if (endpoint === 'get') return route.fulfill({ json: book });
        if (endpoint === 'list') return route.fulfill({ json: [{ name: WORLD_BOOK, ...book }] });
        return route.abort();
    });
}

async function openWorldInfoEntry(page) {
    await page.evaluate(async name => {
        const { openWorldInfoEditor } = await import('/scripts/world-info.js');
        openWorldInfoEditor(name);
    }, WORLD_BOOK);
    const editor = page.locator('#WorldInfo .sb-wi-editor');
    await expect(editor.locator('.sb-wi-row')).toHaveCount(2);
    await editor.locator('.sb-wi-row').filter({ hasText: 'Alpha' }).click();
    const entryView = editor.locator('.sb-wi-entry');
    await expect(entryView).toBeVisible();
    return entryView;
}

async function expectDialogPresentation(page, className, width, height) {
    const host = page.locator(`.sb-dialog-host:has(.${className})`);
    await expect(host).toBeVisible();
    const shouldBeSheet = width <= 450 || height <= 360;
    await expect(host).toHaveAttribute('data-presentation', shouldBeSheet ? 'sheet' : 'floating');
    return host.locator(`.sb-dialog.${className}`);
}

for (const layout of layouts) {
    test.describe(`${layout.name} property overlays (${layout.width}×${layout.height})`, () => {
        test.use({
            viewport: { width: layout.width, height: layout.height },
            isMobile: layout.mobile,
            hasTouch: layout.mobile,
            contextOptions: { reducedMotion: 'reduce' },
        });

        test('persona properties use the shared Dialog when the editor switches to its summary', async ({ page }) => {
            await protectMaintainerServer(page);
            await page.goto('/');
            await waitForApp(page);
            const entry = await openPersonaEntry(page);
            const summary = entry.locator('.sb-persona-property-summary');
            if (!(await summary.isVisible())) {
                await expect(entry.locator(':scope > .sb-persona-properties')).toBeVisible();
                await expect(page.locator('.sb-dialog-host:has(.sb-persona-properties-dialog)')).toHaveCount(0);
                return;
            }

            await summary.click();
            const surface = await expectDialogPresentation(page, 'sb-persona-properties-dialog', layout.width, layout.height);
            const position = surface.locator('.sb-persona-property').filter({ hasText: 'Position' });
            await expect(position.getByRole('button', { name: 'Position', exact: true })).toBeVisible();
            await position.scrollIntoViewIfNeeded();
            const geometry = await position.evaluate(row => {
                const label = row.querySelector(':scope > span').getBoundingClientRect();
                const control = row.querySelector('button, input').getBoundingClientRect();
                return { labelRight: label.right, controlLeft: control.left };
            });
            expect(geometry.controlLeft).toBeGreaterThan(geometry.labelRight);
            await page.keyboard.press('Escape');
            await expect(page.locator('.sb-dialog-host:has(.sb-persona-properties-dialog)')).toHaveCount(0);
            await expect(summary).toBeFocused();
        });

        test('Prompt properties use the shared Dialog when the editor switches to its summary', async ({ page }) => {
            await protectMaintainerServer(page);
            await page.goto('/');
            await waitForApp(page);
            const editor = await openPromptEntry(page);
            const summary = editor.getByRole('button', { name: 'Prompt properties', exact: true });
            if (!(await summary.isVisible())) {
                await expect(editor.locator(':scope > .sb-prompt-properties')).toBeVisible();
                await expect(page.locator('.sb-dialog-host:has(.sb-prompt-properties-dialog)')).toHaveCount(0);
                return;
            }

            await summary.click();
            const surface = await expectDialogPresentation(page, 'sb-prompt-properties-dialog', layout.width, layout.height);
            await expect(surface.locator('.sb-prompt-properties')).toBeVisible();
            const lastProperty = surface.locator('.sb-prompt-property:visible').last();
            await lastProperty.scrollIntoViewIfNeeded();
            await expect(lastProperty).toBeInViewport();
            await page.keyboard.press('Escape');
            await expect(page.locator('.sb-dialog-host:has(.sb-prompt-properties-dialog)')).toHaveCount(0);
            await expect(summary).toBeFocused();
        });

        test('World Info properties use the shared Dialog when the editor switches to its summary', async ({ page }) => {
            await protectMaintainerServer(page);
            await installWorldInfoFixture(page);
            await page.goto('/');
            await waitForApp(page);
            const entry = await openWorldInfoEntry(page);
            const summary = entry.locator('.sb-wi-property-summary');
            if (!(await summary.isVisible())) {
                await expect(entry.locator(':scope > .sb-wi-properties')).toBeVisible();
                await expect(page.locator('.sb-dialog-host:has(.sb-world-info-properties-dialog)')).toHaveCount(0);
                return;
            }

            await summary.click();
            const surface = await expectDialogPresentation(page, 'sb-world-info-properties-dialog', layout.width, layout.height);
            const position = surface.locator('.sb-wi-property').filter({ hasText: 'Position' });
            await expect(position.getByRole('button', { name: 'Position', exact: true })).toBeVisible();
            await position.scrollIntoViewIfNeeded();
            const geometry = await position.evaluate(row => {
                const label = row.querySelector(':scope > span').getBoundingClientRect();
                const control = row.querySelector('button, input').getBoundingClientRect();
                return { labelRight: label.right, controlLeft: control.left };
            });
            expect(geometry.controlLeft).toBeGreaterThan(geometry.labelRight);
            await page.keyboard.press('Escape');
            await expect(page.locator('.sb-dialog-host:has(.sb-world-info-properties-dialog)')).toHaveCount(0);
            await expect(summary).toBeFocused();
        });
    });
}

async function mountColorPicker(page) {
    await page.route('http://colors.test/**', async route => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname === '/') {
            return route.fulfill({
                contentType: 'text/html',
                body: `<!doctype html><html><head>
                    <meta name="viewport" content="width=device-width, initial-scale=1">
                    <link rel="stylesheet" href="/style.css">
                    <link rel="stylesheet" href="/css/sillybunny-theme.css">
                    <link rel="stylesheet" href="/css/sillybunny-tabs.css">
                    <link rel="stylesheet" href="/css/sillybunny-color-picker.css">
                    <style>body { margin: 0; padding: 16px; }</style>
                    </head><body><div class="ds-pref-group"><div class="ds-row">
                    <div class="ds-row-text"><span class="ds-row-label">Main Text</span></div>
                    <div class="ds-row-suffix"><toolcool-color-picker id="main-text-color-picker" color="rgba(53, 132, 228, 0.5)" aria-label="Main Text"></toolcool-color-picker>
                    </div></div></div><script src="/lib/toolcool-color-picker.js"></script></body></html>`,
            });
        }
        if (pathname === '/lib.js') {
            const response = await route.fetch({ url: new URL('/lib.js', process.env.SILLYBUNNY_TEST_BASE_URL || 'http://127.0.0.1:4455').href });
            return route.fulfill({ response });
        }
        if (pathname === '/scripts/i18n.js') {
            return route.fulfill({
                contentType: 'text/javascript',
                body: 'export const t = value => value; export const translate = value => value;',
            });
        }
        const filePath = path.resolve(publicRoot, `.${pathname}`);
        if (!filePath.startsWith(`${publicRoot}${path.sep}`)) return route.abort();
        return route.fulfill({
            body: readFileSync(filePath),
            contentType: pathname.endsWith('.css') ? 'text/css' : 'text/javascript',
        });
    });
    await page.goto('http://colors.test/');
    await page.evaluate(() => customElements.whenDefined('toolcool-color-picker'));
    await page.evaluate(async () => {
        const { initializeColorPickers } = await import('/scripts/sillybunny-color-picker.js');
        await initializeColorPickers();
    });
}

for (const layout of layouts) {
    test.describe(`colour picker parity: ${layout.name}`, () => {
        test.use({ viewport: { width: layout.width, height: layout.height }, contextOptions: { reducedMotion: 'reduce' } });

        test('uses the Dialog tier only at the overlay sheet breakpoint', async ({ page }) => {
            await mountColorPicker(page);
            await page.locator('toolcool-color-picker .button').click();
            const shouldBeSheet = layout.width <= 450 || layout.height <= 360;
            if (shouldBeSheet) {
                const surface = await expectDialogPresentation(page, 'sb-color-picker-dialog', layout.width, layout.height);
                await expect(surface.locator('input[data-color-field="hex"]')).toBeVisible();
                await surface.locator('input[data-color-field="hex"]').fill('#123456');
                await expect(page.locator('toolcool-color-picker')).toHaveJSProperty('rgb', 'rgba(18, 52, 86, 0.5)');
                await page.keyboard.press('Escape');
                await expect(page.locator('.sb-dialog-host:has(.sb-color-picker-dialog)')).toHaveCount(0);
            } else {
                await expect(page.locator('.sb-color-picker-menu')).toBeVisible();
                await expect(page.locator('.sb-dialog-host:has(.sb-color-picker-dialog)')).toHaveCount(0);
                await page.getByRole('button', { name: 'Close', exact: true }).click();
            }
        });
    });
}

for (const layout of layouts.filter(({ width }) => width <= 768)) {
    test.describe(`mobile chat overlays: ${layout.name}`, () => {
        test.use({
            viewport: { width: layout.width, height: layout.height },
            isMobile: true,
            hasTouch: true,
            contextOptions: { reducedMotion: 'reduce' },
        });

        test('bottom chat actions, chat tools and Quick Actions keep their input paths', async ({ page }) => {
            await protectMaintainerServer(page);
            await page.addInitScript(() => {
                localStorage.setItem('sb-mobile-quick-actions-v2', JSON.stringify([{
                    type: 'custom', shellKey: 'right', tabId: 'data-security',
                    label: 'Delayed server', displayText: 'Thumbnail Quality', dedupeKey: 'thumbnail-quality',
                }]));
            });
            await openQuietChatForSmoke(page);

            const chip = page.locator('#sb-bottom-chat-bar .sb-bottom-chat-chip');
            await expect(chip).toBeVisible();
            await chip.click();
            const bottomSurface = await expectDialogPresentation(page, 'sb-bottom-chat-sheet', layout.width, layout.height);
            await expect(bottomSurface.locator('#sb-bottom-chat-select')).toBeAttached();
            await expect(bottomSurface.locator('.sb-bottom-chat-sheet-actions .sb-bottom-chat-btn').first()).toBeVisible();
            await page.keyboard.press('Escape');
            await expect(page.locator('.sb-dialog-host:has(.sb-bottom-chat-sheet)')).toHaveCount(0);
            await expect(chip).toBeFocused();

            await page.evaluate(() => window.SillyBunnyShell.openChatTools());
            const toolsSurface = await expectDialogPresentation(page, 'sb-mobile-chat-tools-dialog', layout.width, layout.height);
            await expect(toolsSurface.locator('#sb-mobile-chat-search')).toBeVisible();
            await expect(toolsSurface.locator('#sb-mobile-chat-select')).toBeVisible();
            await page.keyboard.press('Escape');
            await expect(page.locator('.sb-dialog-host:has(.sb-mobile-chat-tools-dialog)')).toHaveCount(0);

            await page.evaluate(() => {
                const nav = document.getElementById('sb-mobile-nav');
                nav.hidden = false;
                nav.inert = false;
                nav.classList.add('sb-nav-open');
                nav.setAttribute('aria-hidden', 'false');
            });
            const quickActions = page.locator('#sb-mobile-nav .sb-mobile-quick-actions-trigger');
            await expect(quickActions).toBeVisible();
            await quickActions.evaluate(button => button.click());
            await expect(quickActions).toHaveAttribute('aria-expanded', 'true');
            await expect(page.getByRole('menuitem').first()).toBeVisible();
            if (layout.width <= 450 || layout.height <= 360) {
                await expect(page.locator('.sb-action-sheet')).toBeVisible();
            } else {
                await expect(page.locator('.sb-action-popover')).toBeVisible();
            }
            await page.keyboard.press('Escape');
            await expect(page.locator('.sb-action-menu')).toBeHidden();
            await expect(quickActions).toHaveAttribute('aria-expanded', 'false');
            await expect(page.locator('#sb-mobile-nav')).toBeVisible();
        });
    });
}
