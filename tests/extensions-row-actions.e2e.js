import { expect, test } from '@playwright/test';
import { protectMaintainerServer } from './helpers/maintainer-server.js';

const fullActionExtension = {
    name: 'third-party/fixture-full-actions',
    type: 'local',
    manifest: {
        display_name: 'Fixture Full Actions', version: '1.0.0', homepage: 'https://example.test/full-actions',
        requires: [], optional: [], hooks: { clean: 'cleanFixture' },
    },
};
const singleActionExtension = {
    name: 'system-single-action-fixture',
    type: 'system',
    manifest: {
        display_name: 'Fixture Single Action', version: '1.0.0', auto_update: true,
        requires: [], optional: [],
    },
};
const extensionFixtures = [fullActionExtension, singleActionExtension];

async function waitForAnimations(page) {
    await expect.poll(() => page.evaluate(() => document.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running').length), { timeout: 30000 }).toBe(0);
}

async function openExtensionsManager(page, viewport) {
    await page.setViewportSize(viewport);
    await protectMaintainerServer(page);
    await page.route('**/api/extensions/discover', route => route.fulfill({ json: extensionFixtures.map(({ name, type }) => ({ name, type })) }));
    await page.route('**/manifest.json*', route => {
        const pathname = new URL(route.request().url()).pathname;
        const fixture = extensionFixtures.find(({ name }) => pathname.endsWith(`/${name}/manifest.json`));
        return fixture ? route.fulfill({ json: fixture.manifest }) : route.continue();
    });
    await page.route('**/api/extensions/version', route => route.fulfill({ json: {
        isUpToDate: false, currentBranchName: 'main', currentCommitHash: '1234567890', remoteUrl: 'https://example.test/full-actions',
    } }));
    await page.goto('/');
    await page.waitForFunction(() => !document.getElementById('preloader'), null, { timeout: 60000 });
    await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'extensions'));
    await page.locator('#extensions_details').waitFor({ state: 'visible' });
    await page.locator('#extensions_details').click();
    const popup = page.locator('dialog.popup[open]').last();
    const fullRow = popup.locator('.extension_block[data-name="/fixture-full-actions"]');
    const singleRow = popup.locator('.extension_block[data-name="system-single-action-fixture"]');
    await expect(fullRow).toBeVisible({ timeout: 30000 });
    await expect(singleRow).toBeVisible({ timeout: 30000 });
    await expect(fullRow.locator('.btn_update')).not.toHaveClass(/displayNone/, { timeout: 30000 });
    await waitForAnimations(page);
    return { popup, fullRow, singleRow };
}

for (const viewport of [
    { name: 'desktop', width: 1440, height: 900 },
    { name: 'mobile', width: 390, height: 844 },
]) {
    test(`extension row actions at ${viewport.width}×${viewport.height}`, async ({ page }) => {
        const { fullRow, singleRow } = await openExtensionsManager(page, viewport);
        const fullLayout = await fullRow.evaluate(row => {
            const title = row.querySelector('.extension_name').getBoundingClientRect();
            const menu = row.querySelector('.sb-extension-actions-menu');
            const originals = [...row.querySelectorAll('.extension_actions > button:not(.sb-extension-actions-menu)')];
            const toggle = row.querySelector('.extension_toggle').getBoundingClientRect();
            const rowBox = row.getBoundingClientRect();
            const menuBox = menu.getBoundingClientRect();
            return {
                row: rowBox.toJSON(), title: title.toJSON(), toggle: toggle.toJSON(), menu: menuBox.toJSON(),
                originalCount: originals.length,
                visibleOriginals: originals.filter(button => getComputedStyle(button).display !== 'none').length,
                actionsBox: row.querySelector('.extension_actions').getBoundingClientRect().toJSON(),
                scrollWidth: document.documentElement.scrollWidth,
                className: row.className,
                displays: originals.map(button => getComputedStyle(button).display),
            };
        });
        expect(fullLayout.originalCount).toBe(6);
        expect(fullLayout.scrollWidth).toBeLessThanOrEqual(viewport.width);
        if (viewport.width > 450) {
            await expect(fullRow).not.toHaveClass(/sb-extension-actions-collapsed/);
            expect(fullLayout.visibleOriginals).toBe(6);
            expect(fullLayout.actionsBox.right).toBeLessThanOrEqual(fullLayout.toggle.left);
            expect(fullLayout.menu.width).toBe(0);
        } else {
            await expect(fullRow).toHaveClass(/sb-extension-actions-collapsed/);
            expect(fullLayout.visibleOriginals).toBe(0);
            expect(fullLayout.title.width).toBeGreaterThanOrEqual(fullLayout.row.width * 0.4);
            expect(fullLayout.menu.right).toBeLessThanOrEqual(fullLayout.toggle.left);

            const updateRequest = page.waitForRequest(request => request.url().endsWith('/api/extensions/update'));
            await fullRow.locator('.sb-extension-actions-menu').click();
            const menu = page.getByRole('menu', { name: 'Extension Actions' });
            await expect(menu).toBeVisible();
            const labels = await menu.getByRole('menuitem').allTextContents();
            expect(labels.map(label => label.trim())).toEqual(['Update available', 'Switch branch', 'Move', 'Clean extension data', 'Reinstall', 'Delete']);
            await menu.getByRole('menuitem', { name: 'Update available' }).click();
            const request = await updateRequest;
            expect(JSON.parse(request.postData()).extensionName).toBe('/fixture-full-actions');
        }

        const singleActionButtons = await singleRow.locator('.extension_actions > button:not(.sb-extension-actions-menu)').count();
        expect(singleActionButtons).toBe(1);
        if (viewport.width > 450) {
            await expect(singleRow).not.toHaveClass(/sb-extension-actions-collapsed/);
        } else {
            await expect(singleRow).toHaveClass(/sb-extension-actions-collapsed/);
            await singleRow.locator('.sb-extension-actions-menu').click();
            await expect(page.getByRole('menu', { name: 'Extension Actions' }).getByRole('menuitem', { name: 'Sync from upstream' })).toBeVisible();
        }
    });
}
