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

test('a dialog opened from a dialog is pushed as a page with Back and Close', async ({ page }) => {
    await prepare(page, { width: 1440, height: 900 });
    await page.evaluate(async () => {
        const { openDialog } = await import('/scripts/sillybunny-editor/dialog.js');
        openDialog({ tier: 'window', title: 'Parent' });
        window.qaChild = openDialog({ title: 'Child' });
    });
    await expect(page.locator('.sb-dialog-host[open]')).toHaveCount(1);
    const visibleTitle = page.locator('.sb-dialog__page:not([hidden]) .sb-dialog__title');
    await expect(visibleTitle).toHaveText('Child');
    const childPage = page.locator('.sb-dialog__page:not([hidden])');
    await expect(childPage.locator('.sb-dialog__back')).toBeVisible();
    await expect(childPage.locator('.sb-dialog__close')).toBeVisible();
    await childPage.locator('.sb-dialog__back').click();
    await expect(visibleTitle).toHaveText('Parent');
    await page.evaluate(async () => {
        const { openDialog } = await import('/scripts/sillybunny-editor/dialog.js');
        window.qaChild = openDialog({ title: 'Child' });
    });
    const secondChild = page.locator('.sb-dialog__page:not([hidden])');
    await expect(secondChild.locator('.sb-dialog__close')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(visibleTitle).toHaveText('Parent');
    await page.evaluate(async () => {
        const { openDialog } = await import('/scripts/sillybunny-editor/dialog.js');
        window.qaChild = openDialog({ title: 'Child' });
    });
    const thirdChild = page.locator('.sb-dialog__page:not([hidden])');
    await expect(thirdChild.locator('.sb-dialog__close')).toBeVisible();
    await thirdChild.locator('.sb-dialog__close').click();
    await expect(page.locator('.sb-dialog-host[open]')).toHaveCount(0);
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    test(`header-slot selection mode has no overlap at ${viewport.width}×${viewport.height}`, async ({ page }) => {
        await prepare(page, viewport);
        await page.evaluate(async () => {
            const { openDialog } = await import('/scripts/sillybunny-editor/dialog.js');
            const { createSelectionMode } = await import('/scripts/sillybunny-editor/selection-mode.js');
            const content = document.createElement('div');
            const opener = document.createElement('button');
            opener.id = 'qa-selection-opener';
            opener.textContent = 'Open';
            content.append(opener);
            const list = document.createElement('div');
            const row = document.createElement('div');
            row.dataset.sbListKey = 'one';
            row.textContent = 'One';
            list.append(row);
            const inertHeader = document.createElement('div');
            const actionBar = document.createElement('div');
            content.append(inertHeader, list, actionBar);
            window.qaDialog = openDialog({ title: 'Archive', content, menu: () => [], search: { collapsed: true, onChange() {} } });
            const slots = {
                header: window.qaDialog.header,
                headerStart: window.qaDialog.headerStart,
                headerEnd: window.qaDialog.headerEnd,
                titleNode: window.qaDialog.titleNode,
                search: window.qaDialog.search,
                menuButton: window.qaDialog.menuButton,
                closeButton: window.qaDialog.closeButton,
            };
            window.qaSelection = createSelectionMode({ root: content, list, header: inertHeader, actionBar, actions: [], headerSlots: slots });
            opener.focus();
            window.qaSelection.enter(null, opener);
        });
        const header = page.locator('.sb-dialog-host[open] .sb-dialog__header');
        const cancel = header.getByRole('button', { name: 'Cancel', exact: true });
        const selectAll = header.getByRole('button', { name: 'Select all', exact: true });
        const close = header.getByRole('button', { name: 'Close', exact: true });
        const title = header.locator('.sb-dialog__selection-title');
        await expect(cancel).toBeVisible();
        await expect(title).toHaveText('0 selected');
        await expect(selectAll).toBeVisible();
        await expect(close).toBeVisible();
        await expect(header.locator('.sb-dialog__search-toggle')).toBeHidden();
        await expect(header.locator('.sb-dialog__menu')).toBeHidden();
        await expect.poll(() => title.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
        const boxes = await Promise.all([cancel, title, selectAll, close].map(locator => locator.boundingBox()));
        for (let left = 0; left < boxes.length; left++) {
            for (let right = left + 1; right < boxes.length; right++) {
                const a = boxes[left];
                const b = boxes[right];
                expect(a.x + a.width <= b.x + 1 || b.x + b.width <= a.x + 1 || a.y + a.height <= b.y + 1 || b.y + b.height <= a.y + 1).toBe(true);
            }
        }
        await page.screenshot({ path: `/tmp/opencode/4b7a-shots-2/selection-${viewport.width}.png` });
        await cancel.click();
        await expect(header.locator('.sb-dialog__search-toggle')).toBeVisible();
        await expect(header.locator('.sb-dialog__menu')).toBeVisible();
        await expect(close).toBeVisible();
        await expect(page.locator('#qa-selection-opener')).toBeFocused();
        await page.evaluate(() => { window.qaSelection.destroy(); window.qaDialog.forceClose(); });
    });
}

test('narrow selection actions stay on one row with accessible names', async ({ page }) => {
    await prepare(page, { width: 390, height: 844 });
    await page.evaluate(async () => {
        const { openDialog } = await import('/scripts/sillybunny-editor/dialog.js');
        const { createSelectionMode } = await import('/scripts/sillybunny-editor/selection-mode.js');
        const content = document.createElement('div');
        const list = document.createElement('div');
        const row = document.createElement('div');
        row.dataset.sbListKey = 'one';
        row.textContent = 'One';
        list.append(row);
        const header = document.createElement('div');
        const actionBar = document.createElement('div');
        content.append(header, list, actionBar);
        window.qaDialog = openDialog({ title: 'Archive', content });
        window.qaSelection = createSelectionMode({ root: content, list, header, actionBar, iconOnlyAtNarrow: true, actions: [
            { id: 'one', label: 'Restore', icon: 'fa-solid fa-rotate-left', onActivate() {} },
            { id: 'two', label: 'Export', icon: 'fa-solid fa-download', onActivate() {} },
            { id: 'three', label: 'Delete', icon: 'fa-solid fa-trash', onActivate() {} },
        ] });
        window.qaSelection.enter();
    });
    const actionBar = page.getByRole('toolbar', { name: 'Selection actions' });
    await expect(actionBar).toBeVisible();
    const buttons = actionBar.getByRole('button');
    await expect(buttons).toHaveCount(3);
    const positions = await buttons.evaluateAll(nodes => nodes.map(node => ({ top: node.getBoundingClientRect().top, name: node.getAttribute('aria-label') })));
    expect(positions.every(position => position.name && Math.abs(position.top - positions[0].top) <= 1)).toBe(true);
    const distribution = await actionBar.evaluate(node => getComputedStyle(node).justifyContent);
    expect(distribution).toBe('space-evenly');
    const sizes = await buttons.evaluateAll(nodes => nodes.map(node => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })));
    expect(sizes.every(size => size.width >= 44 && size.height >= 44)).toBe(true);
    await page.screenshot({ path: '/tmp/opencode/4b7a-shots-2/icon-action-bar-390.png' });
    await page.evaluate(() => { window.qaSelection.destroy(); window.qaDialog.forceClose(); });
});

test('popover sheet swipe closes and content scrolling does not', async ({ page }) => {
    await prepare(page, { width: 390, height: 844 });
    await page.evaluate(async () => {
        const { openPopover } = await import('/scripts/sillybunny-action-menu.js');
        const trigger = document.createElement('button');
        trigger.id = 'qa-popover-trigger';
        trigger.textContent = 'Open menu';
        document.body.append(trigger);
        const content = document.createElement('div');
        content.style.cssText = 'height: 1000px; overflow: auto';
        content.innerHTML = '<div style="height: 1800px">Scrollable content</div>';
        window.qaPopover = openPopover({ trigger, content, title: 'Actions' });
    });
    const sheet = page.locator('.sb-action-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet.locator('.sb-action-sheet-title')).not.toBeFocused();
    expect(await sheet.evaluate(node => getComputedStyle(node.querySelector('.sb-action-sheet-title')).boxShadow)).toBe('none');
    await page.screenshot({ path: '/tmp/opencode/4b7a-shots-2/popover-sheet-390.png' });
    await sheet.locator('.sb-action-sheet-body').evaluate(node => { node.scrollTop = 0; });
    await sheet.locator('.sb-action-sheet-body').hover();
    await page.mouse.wheel(0, 150);
    await expect(sheet).toBeVisible();
    await sheet.locator('.sb-dialog__handle').evaluate(node => {
        const y = node.getBoundingClientRect().top + 5;
        node.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 7, pointerType: 'touch', clientY: y, button: 0 }));
        node.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 7, pointerType: 'touch', clientY: y + 120, button: 0 }));
    });
    await expect(sheet).toBeHidden();
    await expect(page.locator('#qa-popover-trigger')).toBeFocused();
    await page.evaluate(() => document.getElementById('qa-popover-trigger').remove());
});

test('adopted search entry shares styling with a built-in entry', async ({ page }) => {
    await prepare(page, { width: 1440, height: 900 });
    await page.evaluate(async () => {
        const { openDialog } = await import('/scripts/sillybunny-editor/dialog.js');
        const adopted = document.createElement('input');
        adopted.type = 'text';
        adopted.setAttribute('aria-label', 'Adopted search');
        const content = document.createElement('div');
        content.style.cssText = 'display:grid;grid-template-columns:minmax(0,1fr);gap:8px;padding:16px';
        const builtInLabel = document.createElement('label');
        builtInLabel.textContent = 'Built-in entry';
        builtInLabel.style.cssText = 'display:grid;gap:6px;max-width:480px';
        const builtIn = document.createElement('input');
        builtIn.type = 'search';
        builtIn.className = 'text_pole sb-dialog__entry sb-dialog__search-input';
        builtIn.setAttribute('aria-label', 'Built-in search');
        builtInLabel.append(builtIn);
        content.append(builtInLabel);
        window.qaDialog = openDialog({ title: 'Search comparison', content, search: { input: adopted, label: 'Adopted search', onChange() {} } });
        const adoptedLabel = document.createElement('span');
        adoptedLabel.textContent = 'Adopted entry';
        adoptedLabel.style.cssText = 'padding:6px 10px;font-weight:700';
        window.qaDialog.searchInput.closest('.sb-dialog__search').prepend(adoptedLabel);
        document.activeElement.blur();
    });
    const adopted = page.getByRole('searchbox', { name: 'Adopted search' });
    const builtin = page.getByRole('searchbox', { name: 'Built-in search' });
    await expect(adopted).toBeVisible();
    await expect(builtin).toBeVisible();
    const metrics = async locator => locator.evaluate(node => {
        const style = getComputedStyle(node);
        return { height: style.height, padding: style.padding, borderRadius: style.borderRadius, fontSize: style.fontSize, background: style.backgroundColor, border: style.borderColor };
    });
    const adoptedRest = await metrics(adopted);
    const builtinRest = await metrics(builtin);
    expect(adoptedRest).toEqual(builtinRest);
    await page.screenshot({ path: '/tmp/opencode/4b7a-shots-2/adopted-search-1440.png' });
    await adopted.focus();
    const adoptedFocused = await metrics(adopted);
    await builtin.focus();
    const builtinFocused = await metrics(builtin);
    expect(adoptedFocused).toEqual(builtinFocused);
    await page.screenshot({ path: '/tmp/opencode/4b7a-shots-2/adopted-search-focused-1440.png' });
    await page.evaluate(() => window.qaDialog.forceClose());
});
