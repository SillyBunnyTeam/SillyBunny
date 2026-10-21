import { expect, test } from '@playwright/test';
import { protectMaintainerServer } from './helpers/maintainer-server.js';
/* eslint-disable playwright/no-conditional-in-test, playwright/no-conditional-expect -- The viewport matrix switches between floating and sheet assertions. */

// The shared frame in sillybunny-editor/dialog.js: tiers, the AdwDialog sheet condition
// (max-width 450px or max-height 360px), geometry, scrolling, focus and Escape.

const VIEWPORTS = [
    { width: 1440, height: 900, sheet: false },
    { width: 1024, height: 600, sheet: false },
    { width: 768, height: 1024, sheet: false },
    { width: 450, height: 800, sheet: true },
    { width: 390, height: 844, sheet: true },
    { width: 844, height: 390, sheet: false },
    { width: 800, height: 340, sheet: true },
];

async function prepare(page, viewport) {
    await protectMaintainerServer(page);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto('/');
    await page.waitForFunction(() => window.SillyTavern?.getContext?.()?.eventSource?.autoFireLastArgs?.has('app_ready'), null, { timeout: 60000 });
    await page.waitForFunction(() => !document.getElementById('preloader'));
    await page.emulateMedia({ reducedMotion: 'reduce' });
}

function within(inner, outer) {
    return inner.x >= outer.x - 1 && inner.y >= outer.y - 1
        && inner.x + inner.width <= outer.x + outer.width + 1 && inner.y + inner.height <= outer.y + outer.height + 1;
}

for (const viewport of VIEWPORTS) {
    test.describe(`${viewport.width}×${viewport.height}`, () => {
        test('Dialog and Window tiers fit the viewport, scroll their body and return focus', async ({ page }) => {
            await prepare(page, viewport);
            for (const tier of ['dialog', 'window']) {
                await page.evaluate(async tier => {
                    const { openDialog } = await import('/scripts/sillybunny-editor/dialog.js');
                    const opener = document.createElement('button');
                    opener.id = 'qa-dialog-opener';
                    document.body.append(opener);
                    opener.focus();
                    const content = document.createElement('div');
                    for (let index = 0; index < 60; index++) {
                        const row = document.createElement('p');
                        row.className = 'qa-row';
                        row.textContent = `Row ${index}`;
                        content.append(row);
                    }
                    window.qaDialog = openDialog({ tier, title: 'QA Dialog', content, responses: { affirmative: { id: 'save', label: 'Save' } } });
                }, tier);
                const host = page.locator('.sb-dialog-host[open]');
                const surface = host.locator('.sb-dialog');
                await expect(host).toHaveAttribute('data-presentation', viewport.sheet ? 'sheet' : 'floating');
                await expect(surface).toHaveClass(new RegExp(`sb-dialog--${tier}`));
                const box = await surface.boundingBox();
                expect(within(box, { x: 0, y: 0, ...viewport })).toBe(true);
                if (viewport.sheet) {
                    expect(Math.round(box.y + box.height)).toBe(viewport.height);
                    expect(Math.round(box.width)).toBe(viewport.width);
                    await expect(surface.locator('.sb-dialog__handle')).toBeVisible();
                } else {
                    expect(Math.abs(box.x + box.width / 2 - viewport.width / 2)).toBeLessThanOrEqual(1);
                    if (tier === 'dialog') expect(box.width).toBeLessThanOrEqual(640);
                    await expect(surface.locator('.sb-dialog__handle')).toBeHidden();
                }
                const save = surface.getByRole('button', { name: 'Save', exact: true });
                const cancel = surface.getByRole('button', { name: 'Cancel', exact: true });
                expect((await cancel.boundingBox()).x).toBeLessThan((await save.boundingBox()).x);
                const last = surface.locator('.qa-row').last();
                const body = surface.locator('.sb-dialog__body');
                await body.hover();
                for (let step = 0; step < 12; step++) await page.mouse.wheel(0, 600);
                await expect.poll(async () => within(await last.boundingBox(), await body.boundingBox())).toBe(true);
                await expect(save).toBeInViewport();
                await page.keyboard.press('Escape');
                await expect(host).toHaveCount(0);
                expect(await page.evaluate(async () => (await window.qaDialog.closed).response)).toBe('cancel');
                await expect(page.locator('#qa-dialog-opener')).toBeFocused();
                await page.evaluate(() => document.getElementById('qa-dialog-opener').remove());
            }
        });

        test('Alert tier is 300–372px floating, a stacked sheet when narrow, and resolves its response', async ({ page }) => {
            await prepare(page, viewport);
            await page.evaluate(async () => {
                const { openAlert } = await import('/scripts/sillybunny-editor/dialog.js');
                window.qaAlert = openAlert({
                    heading: 'Delete Folder?',
                    body: 'The characters in this folder stay in your library.',
                    responses: [{ id: 'cancel', label: 'Cancel' }, { id: 'delete', label: 'Delete', appearance: 'destructive' }],
                });
            });
            const host = page.locator('.sb-dialog-host[role="alertdialog"][open]');
            const surface = host.locator('.sb-dialog--alert');
            await expect(host).toHaveAttribute('data-presentation', viewport.sheet ? 'sheet' : 'floating');
            const box = await surface.boundingBox();
            expect(within(box, { x: 0, y: 0, ...viewport })).toBe(true);
            const cancel = surface.getByRole('button', { name: 'Cancel', exact: true });
            const remove = surface.getByRole('button', { name: 'Delete', exact: true });
            await expect(cancel).toBeFocused();
            if (viewport.sheet) {
                await expect(surface.locator('.sb-dialog__responses')).toHaveClass(/is-stacked/);
                expect((await remove.boundingBox()).y).toBeLessThan((await cancel.boundingBox()).y);
            } else {
                expect(box.width).toBeGreaterThanOrEqual(299);
                expect(box.width).toBeLessThanOrEqual(373);
                expect((await cancel.boundingBox()).x).toBeLessThan((await remove.boundingBox()).x);
            }
            await remove.click();
            expect(await page.evaluate(() => window.qaAlert)).toBe('delete');
            await expect(host).toHaveCount(0);
        });
    });
}

test('menus opened from inside a dialog are hosted in its top layer and usable', async ({ page }) => {
    await prepare(page, { width: 1440, height: 900 });
    await page.evaluate(async () => {
        const { openDialog } = await import('/scripts/sillybunny-editor/dialog.js');
        window.qaPicked = '';
        window.qaDialog = openDialog({
            tier: 'window', title: 'QA Menu',
            menu: () => [{ items: [{ label: 'Pick Me', icon: 'fa-solid fa-check', onSelect: () => window.qaPicked = 'yes' }] }],
        });
    });
    const host = page.locator('.sb-dialog-host[open]');
    await host.locator('.sb-dialog__menu').click();
    const item = page.getByRole('menuitem', { name: 'Pick Me', exact: true });
    await expect(item).toBeVisible();
    expect(await item.evaluate(node => Boolean(node.closest('.sb-dialog-host')))).toBe(true);
    await item.click();
    await expect.poll(() => page.evaluate(() => window.qaPicked)).toBe('yes');
    await host.locator('.sb-dialog__close').click();
    await expect(host).toHaveCount(0);
});

test('a dialog opened from a dialog is pushed as a page with Back', async ({ page }) => {
    await prepare(page, { width: 1440, height: 900 });
    await page.evaluate(async () => {
        const { openDialog } = await import('/scripts/sillybunny-editor/dialog.js');
        openDialog({ tier: 'window', title: 'Parent' });
        window.qaChild = openDialog({ title: 'Child' });
    });
    await expect(page.locator('.sb-dialog-host[open]')).toHaveCount(1);
    const visibleTitle = page.locator('.sb-dialog__page:not([hidden]) .sb-dialog__title');
    await expect(visibleTitle).toHaveText('Child');
    await page.locator('.sb-dialog__back').click();
    await expect(visibleTitle).toHaveText('Parent');
    await page.keyboard.press('Escape');
    await expect(page.locator('.sb-dialog-host[open]')).toHaveCount(0);
});
