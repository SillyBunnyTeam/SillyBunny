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

test('an openAlert surface paints the same Alert layer as a Popup alert, not the Window layer', async ({ page }) => {
    await prepare(page, { width: 1440, height: 900 });
    const backgroundOf = selector => page.locator(selector).last().evaluate(node => getComputedStyle(node).backgroundColor);

    await page.evaluate(async () => {
        const { openAlert } = await import('/scripts/sillybunny-editor/dialog.js');
        window.qaAlert = openAlert({ heading: 'Delete Folder?', body: 'Body.', responses: [{ id: 'cancel', label: 'Cancel' }] });
    });
    await expect(page.locator('.sb-dialog-host[role="alertdialog"][open]')).toBeVisible();
    const framedAlert = await backgroundOf('.sb-dialog-host[open] .sb-dialog--alert');
    const framedAlertBody = await backgroundOf('.sb-dialog-host[open] .sb-dialog--alert .sb-dialog__body');
    await page.keyboard.press('Escape');
    await expect(page.locator('.sb-dialog-host')).toHaveCount(0);

    await page.evaluate(async () => {
        const { Popup, POPUP_TYPE } = await import('/scripts/popup.js');
        void new Popup('<h3>Delete Folder?</h3><p>Body.</p>', POPUP_TYPE.CONFIRM, '', { okButton: 'Delete', cancelButton: 'Cancel' }).show();
    });
    const popup = page.locator('dialog.popup[open]').last();
    await expect(popup).toHaveClass(/sb-dialog--alert/);
    const popupAlert = await backgroundOf('dialog.popup[open]');
    const popupAlertBody = await backgroundOf('dialog.popup[open] > .popup-body');
    await page.keyboard.press('Escape');
    await expect(popup).toBeHidden();

    const layers = await page.evaluate(() => {
        const paint = token => {
            const probe = document.createElement('div');
            probe.style.background = `var(${token})`;
            document.body.append(probe);
            const color = getComputedStyle(probe).backgroundColor;
            probe.remove();
            return color;
        };
        return { alert: paint('--sb-layer-alert'), window: paint('--sb-layer-window') };
    });
    expect(layers.alert).not.toBe(layers.window);
    expect(popupAlert).toBe(layers.alert);
    expect(framedAlert).toBe(popupAlert);
    expect(popupAlertBody).toBe(layers.alert);
    expect(framedAlertBody).toBe(popupAlertBody);
});

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

test.describe('while pages slide', () => {
    async function openWithStackedDivider(page) {
        await prepare(page, { width: 1440, height: 900 });
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await page.evaluate(async () => {
            // The slide only runs when motion is allowed, and the host may start with its own reduced-motion setting on.
            document.body.classList.remove('reduced-motion');
            const { openDialog } = await import('/scripts/sillybunny-editor/dialog.js');
            const content = document.createElement('div');
            content.style.cssText = 'display:flex;block-size:320px';
            const divider = document.createElement('div');
            divider.className = 'qa-divider';
            divider.style.cssText = 'position:relative;z-index:4;inline-size:6px;margin-inline-start:85%;background:#c00';
            content.append(divider);
            window.qaDialog = openDialog({ tier: 'window', size: 'fill', title: 'Parent', content });
        });
        await expect(page.locator('.sb-dialog-host[open]')).not.toHaveAttribute('opening');
        await page.waitForFunction(() => !document.getAnimations().some(animation => animation.effect?.target?.closest?.('.sb-dialog-host')));
    }

    /**
     * Starts a push or a pop, freezes the page slide with the moving page across half of the surface and reports what paints at the parent's divider.
     * Both steps run in one page task so the slide cannot finish in between.
     */
    const slideHalfway = (page, direction) => page.evaluate(async direction => {
        const { openDialog } = await import('/scripts/sillybunny-editor/dialog.js');
        const child = openDialog({ title: 'Child', content: document.createElement('p') });
        if (direction === 'pop') {
            await new Promise(resolve => setTimeout(resolve, 1000));
            child.close();
        }
        const slides = document.getAnimations().filter(animation => animation.effect?.target?.classList.contains('sb-dialog__page'));
        const surface = document.querySelector('.sb-dialog-host[open] .sb-dialog').getBoundingClientRect();
        // The spring is front-loaded, so find the moment the moving page has covered half of the surface.
        let best = Infinity;
        let halfway = 0;
        for (let step = 0; step <= 40; step++) {
            for (const animation of slides) {
                animation.pause();
                animation.currentTime = (animation.effect.getTiming().duration * step) / 40;
            }
            const gap = Math.abs(slides[0].effect.target.getBoundingClientRect().left - (surface.left + surface.width / 2));
            if (gap < best) {
                best = gap;
                halfway = step;
            }
        }
        for (const animation of slides) {
            animation.currentTime = (animation.effect.getTiming().duration * halfway) / 40;
        }
        // The covered and the leaving page are inert, and hit testing skips inert content, so make them testable without changing how they paint.
        for (const covered of document.querySelectorAll('.sb-dialog__page')) covered.inert = false;
        const divider = document.querySelector('.qa-divider').getBoundingClientRect();
        const moving = slides[0]?.effect.target.getBoundingClientRect();
        const x = divider.left + divider.width / 2;
        const topNode = document.elementFromPoint(x, divider.top + divider.height / 2);
        return {
            animations: slides.length,
            dividerInsideMovingPage: Boolean(moving) && x > moving.left && x < moving.right,
            paintedByMovingPage: Boolean(slides[0]) && slides[0].effect.target.contains(topNode),
            painted: topNode?.className ?? null,
        };
    }, direction);

    test('a page pushed over a z-indexed element paints above it until the slide ends', async ({ page }) => {
        await openWithStackedDivider(page);
        const probe = await slideHalfway(page, 'push');
        expect(probe.animations).toBe(1);
        expect(probe.dividerInsideMovingPage).toBe(true);
        expect(probe.paintedByMovingPage, `painted: ${probe.painted}`).toBe(true);
    });

    test('the covered page is hidden and inert once the push settles, even when the slide is cancelled', async ({ page }) => {
        await openWithStackedDivider(page);
        const cancelled = await page.evaluate(() => {
            window.qaDialog.push({ title: 'Child', content: document.createElement('p') });
            // Code outside the motion helper can cancel the slide directly, which skips the helper's own cancel path.
            const slides = document.getAnimations()
                .filter(animation => animation.effect?.target?.classList?.contains('sb-dialog__page'));
            slides.forEach(animation => animation.cancel());
            return slides.length;
        });
        expect(cancelled).toBeGreaterThan(0);
        const covered = page.locator('.sb-dialog-host[open] .sb-dialog__page').first();
        await expect(covered).toHaveAttribute('hidden', '');
        await expect(covered).not.toHaveClass(/is-underlay/);
        await expect(page.locator('.sb-dialog-host[open] .sb-dialog__page:not([hidden])')).toHaveCount(1);
        await page.evaluate(() => window.qaDialog.forceClose());
    });

    test('a page popped back paints above the revealed page until the slide ends', async ({ page }) => {
        await openWithStackedDivider(page);
        const probe = await slideHalfway(page, 'pop');
        expect(probe.animations).toBe(1);
        expect(probe.dividerInsideMovingPage).toBe(true);
        expect(probe.paintedByMovingPage, `painted: ${probe.painted}`).toBe(true);
    });
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
            const actionBar = document.createElement('div');
            content.append(list, actionBar);
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
            window.qaSelection = createSelectionMode({ root: content, list, actionBar, actions: [], headerSlots: slots });
            opener.focus();
            window.qaSelection.enter(null, opener);
        });
        const header = page.locator('.sb-dialog-host[open] .sb-dialog__header');
        const cancel = header.getByRole('button', { name: 'Cancel', exact: true });
        const selectAll = header.getByRole('button', { name: 'Select All', exact: true });
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

test.describe('page chains', () => {
    const openPopups = (page, levels) => page.evaluate(async levels => {
        const { Popup, POPUP_TYPE } = await import('/scripts/popup.js');
        window.qaLog = [];
        window.qaResults = {};
        window.qaGates = {};
        window.qaPopups = {};
        for (const level of levels) {
            const popup = new Popup(`<p>${level.name}</p>`, POPUP_TYPE[level.type ?? 'DISPLAY'], '', {
                tier: level.tier ?? 'dialog',
                title: level.name,
                allowEscapeClose: level.allowEscapeClose ?? true,
                onClosing: async () => {
                    window.qaLog.push(`closing:${level.name}`);
                    return window.qaGates[level.name] ?? true;
                },
            });
            window.qaPopups[level.name] = popup;
            void popup.show().then(value => {
                window.qaResults[level.name] = value;
                window.qaLog.push(`closed:${level.name}`);
            });
        }
    }, levels);
    const popupNamed = (page, name) => page.locator('dialog.popup[open]').filter({ has: page.locator('.sb-dialog__title', { hasText: new RegExp(`^${name}$`) }) });
    const chainClose = (page, name) => popupNamed(page, name).locator('.sb-dialog__chain-close');
    const gate = (page, name, value) => page.evaluate(([name, value]) => {
        window.qaGates[name] = value === 'pending' ? new Promise(resolve => { window.qaRelease = resolve; }) : value;
    }, [name, value]);

    test('a Popup page shows Back and Close, and Back keeps the child result', async ({ page }) => {
        await prepare(page, { width: 1440, height: 900 });
        await openPopups(page, [{ name: 'root', tier: 'window' }, { name: 'child' }]);
        const child = popupNamed(page, 'child');
        await expect(child).toHaveClass(/sb-dialog--page/);
        await expect(child.getByRole('button', { name: 'Back', exact: true })).toBeVisible();
        await expect(chainClose(page, 'child')).toBeVisible();
        await expect(chainClose(page, 'child')).toHaveAttribute('aria-label', 'Close');
        const [back, close] = await Promise.all([
            child.getByRole('button', { name: 'Back', exact: true }).boundingBox(),
            chainClose(page, 'child').boundingBox(),
        ]);
        expect(back.x).toBeLessThan(close.x);
        expect(Math.abs(back.y - close.y)).toBeLessThanOrEqual(1);
        await child.getByRole('button', { name: 'Back', exact: true }).click();
        await expect(page.locator('dialog.popup[open]')).toHaveCount(1);
        expect(await page.evaluate(() => window.qaResults)).toEqual({ child: 0 });
        await page.evaluate(() => window.qaPopups.root.completeCancelled());
    });

    test('Close on a Popup grandchild closes all three levels, top first, with cancel results', async ({ page }) => {
        await prepare(page, { width: 1440, height: 900 });
        await openPopups(page, [{ name: 'root', type: 'CONFIRM', tier: 'window' }, { name: 'middle' }, { name: 'top' }]);
        await expect(page.locator('dialog.popup[open]')).toHaveCount(3);
        await chainClose(page, 'top').click();
        await expect(page.locator('dialog.popup')).toHaveCount(0);
        expect(await page.evaluate(() => window.qaResults)).toEqual({ root: null, middle: null, top: null });
        expect(await page.evaluate(() => window.qaLog)).toEqual([
            'closing:top', 'closed:top', 'closing:middle', 'closed:middle', 'closing:root', 'closed:root',
        ]);
    });

    test('a root without a Close button and one with allowEscapeClose false still close with their own cancel result', async ({ page }) => {
        await prepare(page, { width: 1440, height: 900 });
        await openPopups(page, [{ name: 'root', type: 'CONFIRM', tier: 'window', allowEscapeClose: false }, { name: 'top' }]);
        await expect(popupNamed(page, 'root').locator('.popup-button-close')).toBeHidden();
        await chainClose(page, 'top').click();
        await expect(page.locator('dialog.popup')).toHaveCount(0);
        expect(await page.evaluate(() => window.qaResults)).toEqual({ root: null, top: null });
        expect(await page.evaluate(() => window.qaLog.filter(entry => entry.startsWith('closing')))).toEqual(['closing:top', 'closing:root']);
    });

    test('a pending child onClosing keeps the parent open, and a refusal closes nothing', async ({ page }) => {
        await prepare(page, { width: 1440, height: 900 });
        await openPopups(page, [{ name: 'root', tier: 'window' }, { name: 'top' }]);
        await gate(page, 'top', 'pending');
        await chainClose(page, 'top').click();
        await expect.poll(() => page.evaluate(() => window.qaLog)).toEqual(['closing:top']);
        // A parent close would start within a few frames, so a short quiet period proves it waits.
        await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 300)));
        expect(await page.evaluate(() => window.qaLog)).toEqual(['closing:top']);
        await expect(page.locator('dialog.popup[open]')).toHaveCount(2);
        await page.evaluate(() => window.qaRelease(false));
        await expect(popupNamed(page, 'top')).toBeVisible();
        expect(await page.evaluate(() => ({ results: window.qaResults, log: window.qaLog, result: window.qaPopups.top.result }))).toEqual({
            results: {}, log: ['closing:top'], result: undefined,
        });
        await gate(page, 'top', true);
        await popupNamed(page, 'top').getByRole('button', { name: 'Back', exact: true }).click();
        await expect(page.locator('dialog.popup[open]')).toHaveCount(1);
        await page.evaluate(() => window.qaPopups.root.completeCancelled());
    });

    test('a refusing middle level stays open with its levels below, and later closes with its handler intact', async ({ page }) => {
        await prepare(page, { width: 1440, height: 900 });
        await openPopups(page, [{ name: 'root', tier: 'window' }, { name: 'middle' }, { name: 'top' }]);
        await gate(page, 'middle', false);
        const opener = popupNamed(page, 'middle').getByRole('button', { name: 'Back', exact: true });
        await chainClose(page, 'top').click();
        await expect(popupNamed(page, 'top')).toHaveCount(0);
        await expect(page.locator('dialog.popup[open]')).toHaveCount(2);
        expect(await page.evaluate(() => ({
            results: window.qaResults,
            middle: window.qaPopups.middle.result,
            value: window.qaPopups.middle.value,
            hasHandler: typeof window.qaPopups.middle.onClosing === 'function',
            lastResult: window.qaPopups.middle.constructor.util.lastResult?.result,
        }))).toEqual({ results: { top: null }, middle: undefined, value: undefined, hasHandler: true, lastResult: null });
        await expect(popupNamed(page, 'middle')).toHaveJSProperty('inert', false);
        await expect(popupNamed(page, 'root')).toHaveJSProperty('inert', true);
        await expect(opener).toBeEnabled();
        expect(await page.evaluate(() => document.activeElement?.closest('dialog.popup') === window.qaPopups.middle.dlg)).toBe(true);
        await gate(page, 'middle', true);
        await chainClose(page, 'middle').click();
        await expect(page.locator('dialog.popup')).toHaveCount(0);
        expect(await page.evaluate(() => window.qaLog.filter(entry => entry.startsWith('closing')))).toEqual(['closing:top', 'closing:middle', 'closing:middle', 'closing:root']);
    });

    test('focus returns to the opener of the chain root after Close', async ({ page }) => {
        await prepare(page, { width: 1440, height: 900 });
        await page.evaluate(() => {
            const opener = document.createElement('button');
            opener.id = 'qa-chain-opener';
            opener.textContent = 'Open';
            document.body.append(opener);
            opener.focus();
        });
        await openPopups(page, [{ name: 'root', tier: 'window' }, { name: 'middle' }, { name: 'top' }]);
        await chainClose(page, 'top').click();
        await expect(page.locator('dialog.popup')).toHaveCount(0);
        await expect(page.locator('#qa-chain-opener')).toBeFocused();
    });

    test('openDialog over a Popup Window is a page with Back and Close, and Back returns focus into the Popup', async ({ page }) => {
        await prepare(page, { width: 1440, height: 900 });
        await openPopups(page, [{ name: 'root', type: 'CONFIRM', tier: 'window' }]);
        const root = popupNamed(page, 'root');
        await root.locator('.popup-button-ok').focus();
        await page.evaluate(async () => {
            const { openDialog } = await import('/scripts/sillybunny-editor/dialog.js');
            window.qaPage = openDialog({ title: 'Page', content: document.createElement('p') });
        });
        const host = page.locator('.sb-dialog-host[open]');
        const surface = host.locator('.sb-dialog');
        await expect(page.locator('.sb-dialog-host')).toHaveCount(1);
        await expect(surface).toHaveClass(/sb-dialog--page/);
        await expect(page.locator('.sb-dialog:visible')).toHaveCount(1);
        await expect(root).toHaveAttribute('data-sb-covered', '');
        await expect(root).toHaveJSProperty('inert', true);
        await expect(host.locator('.sb-dialog__back')).toBeVisible();
        await expect(host.locator('.sb-dialog__close')).toBeVisible();
        const [parentBox, pageBox] = await Promise.all([root.boundingBox(), surface.boundingBox()]);
        for (const key of ['x', 'y', 'width', 'height']) expect(Math.abs(parentBox[key] - pageBox[key])).toBeLessThanOrEqual(1);
        await host.locator('.sb-dialog__back').click();
        await expect(host).toHaveCount(0);
        expect(await page.evaluate(() => window.qaPage.closed.then(result => result.response))).toBe('back');
        await expect(root.locator('.popup-button-ok')).toBeFocused();
        await expect(root).toHaveJSProperty('inert', false);
        await root.locator('.popup-button-cancel').click();
    });

    test('openDialog, Popup and openDialog close from the top, each through its own path', async ({ page }) => {
        await prepare(page, { width: 1440, height: 900 });
        await page.evaluate(async () => {
            const { openDialog } = await import('/scripts/sillybunny-editor/dialog.js');
            window.qaCanClose = [];
            window.qaRoot = openDialog({ tier: 'window', title: 'Root', canClose: reason => (window.qaCanClose.push(reason), true) });
        });
        await openPopups(page, [{ name: 'middle', tier: 'window' }]);
        await page.evaluate(async () => {
            const { openDialog } = await import('/scripts/sillybunny-editor/dialog.js');
            window.qaTop = openDialog({ title: 'Top', canClose: reason => (window.qaCanClose.push(`top:${reason}`), true) });
        });
        await expect(page.locator('.sb-dialog:visible')).toHaveCount(1);
        await page.locator('.sb-dialog-host[open]').last().locator('.sb-dialog__close').click();
        await expect(page.locator('.sb-dialog-host, dialog.popup')).toHaveCount(0);
        expect(await page.evaluate(async () => ({
            top: (await window.qaTop.closed).response,
            root: (await window.qaRoot.closed).response,
            popup: window.qaResults.middle,
            canClose: window.qaCanClose,
        }))).toEqual({ top: 'close', root: 'close', popup: null, canClose: ['top:close', 'close'] });
    });

    test('a refusing openDialog root stops the walk after the Popup above it closed', async ({ page }) => {
        await prepare(page, { width: 1440, height: 900 });
        await page.evaluate(async () => {
            const { openDialog } = await import('/scripts/sillybunny-editor/dialog.js');
            window.qaRoot = openDialog({ tier: 'window', title: 'Root', canClose: () => false });
        });
        await openPopups(page, [{ name: 'top' }]);
        await chainClose(page, 'top').click();
        await expect(page.locator('dialog.popup')).toHaveCount(0);
        const root = page.locator('.sb-dialog-host[open]');
        await expect(root).toHaveCount(1);
        await expect(root.locator('.sb-dialog')).toHaveJSProperty('inert', false);
        await expect(root.locator('.sb-dialog')).toBeVisible();
        await expect(root.locator('.sb-dialog__close')).toBeVisible();
        await page.evaluate(() => window.qaRoot.forceClose());
    });

    test('with motion allowed each level finishes closing before the next one starts', async ({ page }) => {
        await prepare(page, { width: 1440, height: 900 });
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await page.evaluate(() => document.body.classList.remove('reduced-motion'));
        await openPopups(page, [{ name: 'root', type: 'CONFIRM', tier: 'window' }, { name: 'middle' }, { name: 'top' }]);
        await expect(popupNamed(page, 'top')).not.toHaveAttribute('opening');
        await chainClose(page, 'top').click();
        await expect(page.locator('dialog.popup')).toHaveCount(0);
        expect(await page.evaluate(() => window.qaLog)).toEqual([
            'closing:top', 'closed:top', 'closing:middle', 'closed:middle', 'closing:root', 'closed:root',
        ]);
    });

    test('with reduced motion the chain closes without any animation running', async ({ page }) => {
        await prepare(page, { width: 1440, height: 900 });
        await openPopups(page, [{ name: 'root', type: 'CONFIRM', tier: 'window' }, { name: 'middle' }, { name: 'top' }]);
        // Unrelated looping animations outside the dialogs, such as the hidden #connection_profile_spinner, must not count, so only animations inside a dialog are checked.
        const mostAnimations = await page.evaluate(async () => {
            const dialogAnimations = () => document.getAnimations().filter(animation => animation.effect?.target?.closest?.('dialog')).length;
            let most = dialogAnimations();
            document.querySelector('dialog.popup[open]:last-of-type .sb-dialog__chain-close').click();
            while (document.querySelector('dialog.popup')) {
                most = Math.max(most, dialogAnimations());
                await new Promise(resolve => requestAnimationFrame(resolve));
            }
            return most;
        });
        expect(mostAnimations).toBe(0);
        expect(await page.evaluate(() => window.qaLog)).toEqual([
            'closing:top', 'closed:top', 'closing:middle', 'closed:middle', 'closing:root', 'closed:root',
        ]);
    });

    test('a page opened in the same tick as its Popup parent takes the settled Popup rectangle', async ({ page }) => {
        await prepare(page, { width: 1440, height: 900 });
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await page.evaluate(async () => {
            document.body.classList.remove('reduced-motion');
            const { Popup, POPUP_TYPE } = await import('/scripts/popup.js');
            const { openDialog } = await import('/scripts/sillybunny-editor/dialog.js');
            window.qaPopup = new Popup('<p>Parent</p>', POPUP_TYPE.CONFIRM, '', { tier: 'window', title: 'Parent' });
            void window.qaPopup.show();
            window.qaPage = openDialog({ title: 'Page', content: document.createElement('p') });
        });
        // Page-wide animations never stop in this app, so only the dialogs' own motion is awaited.
        await page.waitForFunction(() => !document.getAnimations().some(animation => animation.effect?.target?.closest?.('dialog')));
        const parent = page.locator('dialog.popup[open]');
        await expect(parent).not.toHaveAttribute('opening');
        const [parentBox, pageBox] = await Promise.all([parent.boundingBox(), page.locator('.sb-dialog-host .sb-dialog').boundingBox()]);
        for (const key of ['x', 'y', 'width', 'height']) expect(Math.abs(parentBox[key] - pageBox[key])).toBeLessThanOrEqual(1);
        await page.evaluate(() => window.qaPage.forceClose());
        await page.evaluate(() => window.qaPopup.completeCancelled());
    });

    const sheetShape = node => {
        const style = getComputedStyle(node);
        return {
            topRadius: parseFloat(style.borderTopLeftRadius) > 0 && parseFloat(style.borderTopRightRadius) > 0,
            bottomRadius: style.borderBottomLeftRadius === '0px' && style.borderBottomRightRadius === '0px',
            borders: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth],
        };
    };
    const backdropAlpha = node => {
        const color = getComputedStyle(node, '::backdrop').backgroundColor;
        return color.startsWith('rgba(') ? Number(color.slice(5, -1).split(',')[3] ?? 1) : Number(color.match(/\/\s*([\d.]+)\)/)?.[1] ?? 1);
    };

    /** Counts the dims that are painted: visible backdrops and scrims with some opacity. */
    const countDims = page => page.evaluate(() => {
        const alphaOf = color => {
            const slash = color.match(/\/\s*([\d.]+)\)/);
            if (slash) return Number(slash[1]);
            return color.startsWith('rgba(') ? Number(color.slice(5, -1).split(',')[3]) : 1;
        };
        let count = 0;
        for (const dialog of document.querySelectorAll('dialog[open]')) {
            const style = getComputedStyle(dialog, '::backdrop');
            if (style.visibility === 'visible' && alphaOf(style.backgroundColor) > 0) count++;
        }
        for (const scrim of document.querySelectorAll('.sb-dialog-scrim')) {
            const style = getComputedStyle(scrim);
            if (style.display !== 'none' && style.visibility === 'visible' && alphaOf(style.backgroundColor) > 0) count++;
        }
        return count;
    });
    const openLevel = (page, kind) => page.evaluate(async kind => {
        const { Popup, POPUP_TYPE } = await import('/scripts/popup.js');
        const { openDialog } = await import('/scripts/sillybunny-editor/dialog.js');
        window.qaLevels ??= [];
        if (kind === 'host') {
            window.qaLevels.push(openDialog({ tier: 'window', title: 'Host', content: document.createElement('p') }));
        } else {
            const popup = new Popup('<p>Popup</p>', POPUP_TYPE.DISPLAY, '', { tier: window.qaLevels.length ? 'dialog' : 'window', title: 'Popup' });
            window.qaLevels.push(popup);
            void popup.show();
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }, kind);

    for (const chain of [
        ['popup'], ['popup', 'popup'], ['popup', 'host'], ['popup', 'popup', 'host'], ['popup', 'popup', 'popup'], ['popup', 'host', 'popup'],
        ['host'], ['host', 'popup'], ['host', 'popup', 'host'], ['host', 'popup', 'popup'],
    ]) {
        test(`one dim is painted over the chain ${chain.join(' > ')}`, async ({ page }) => {
            await prepare(page, { width: 1440, height: 900 });
            for (const kind of chain) await openLevel(page, kind);
            expect(await countDims(page)).toBe(1);
        });
    }

    /** The page keeps the sheet's grab handle, and its title stays where the parent's title was. */
    async function expectSheetChrome(parent, pageSurface, handle) {
        await expect(handle).toBeVisible();
        const [parentTitle, pageTitle] = await Promise.all([
            parent.locator('.sb-dialog__title').boundingBox(),
            pageSurface.locator('.sb-dialog__title').first().boundingBox(),
        ]);
        expect(Math.abs((parentTitle.y + parentTitle.height / 2) - (pageTitle.y + pageTitle.height / 2))).toBeLessThanOrEqual(1);
    }

    test('at 390 an openDialog page over a Popup sheet is one visible frame in the sheet shape, with the dim kept', async ({ page }) => {
        await prepare(page, { width: 390, height: 844 });
        await openPopups(page, [{ name: 'parent', type: 'CONFIRM', tier: 'window' }]);
        const parent = popupNamed(page, 'parent');
        await expect(parent).toHaveAttribute('data-presentation', 'sheet');
        await page.evaluate(async () => {
            const { openDialog } = await import('/scripts/sillybunny-editor/dialog.js');
            const content = document.createElement('div');
            for (let index = 0; index < 60; index++) {
                const row = document.createElement('p');
                row.className = 'qa-row';
                row.textContent = `Row ${index}`;
                content.append(row);
            }
            window.qaPage = openDialog({ title: 'Page', content });
        });
        const host = page.locator('.sb-dialog-host[open]');
        const surface = host.locator('.sb-dialog');
        await expect(surface).toHaveAttribute('data-covers-sheet', '');
        await expect(page.locator('.sb-dialog:visible')).toHaveCount(1);
        await expect(host.locator('.sb-dialog-scrim')).toBeHidden();
        await expect(host.locator('.sb-dialog__back')).toBeVisible();
        await expect(host.locator('.sb-dialog__close')).toBeVisible();
        expect(await surface.evaluate(sheetShape)).toEqual({ topRadius: true, bottomRadius: true, borders: ['1px', '0px', '0px', '0px'] });
        const [parentBox, pageBox] = await Promise.all([parent.boundingBox(), surface.boundingBox()]);
        for (const key of ['x', 'y', 'width', 'height']) expect(Math.abs(parentBox[key] - pageBox[key])).toBeLessThanOrEqual(1);
        expect(Math.round(pageBox.y + pageBox.height)).toBe(844);
        expect(await host.evaluate(backdropAlpha)).toBeGreaterThan(0);
        expect(await parent.evaluate(backdropAlpha)).toBe(0);
        expect(await countDims(page)).toBe(1);
        await expectSheetChrome(parent, surface, host.locator('.sb-dialog__handle'));
        const body = surface.locator('.sb-dialog__body');
        await body.hover();
        for (let step = 0; step < 12; step++) await page.mouse.wheel(0, 800);
        await expect.poll(async () => {
            const [last, box] = await Promise.all([surface.locator('.qa-row').last().boundingBox(), body.boundingBox()]);
            return last.y + last.height <= box.y + box.height + 1 && last.y >= box.y - 1;
        }).toBe(true);
        await host.locator('.sb-dialog__close').click();
        await expect(page.locator('dialog.popup, .sb-dialog-host')).toHaveCount(0);
    });

    test('at 390 a Popup page over a Popup sheet has the sheet shape and keeps the dim', async ({ page }) => {
        await prepare(page, { width: 390, height: 844 });
        await openPopups(page, [{ name: 'parent', type: 'CONFIRM', tier: 'window' }, { name: 'child' }]);
        const parent = popupNamed(page, 'parent');
        const child = popupNamed(page, 'child');
        await expect(child).toHaveAttribute('data-covers-sheet', '');
        await expect(page.locator('.sb-dialog:visible')).toHaveCount(1);
        await expect(child.getByRole('button', { name: 'Back', exact: true })).toBeVisible();
        await expect(chainClose(page, 'child')).toBeVisible();
        expect(await child.evaluate(sheetShape)).toEqual({ topRadius: true, bottomRadius: true, borders: ['1px', '0px', '0px', '0px'] });
        const [parentBox, childBox] = await Promise.all([parent.boundingBox(), child.boundingBox()]);
        for (const key of ['x', 'y', 'width', 'height']) expect(Math.abs(parentBox[key] - childBox[key])).toBeLessThanOrEqual(1);
        expect(await child.evaluate(backdropAlpha)).toBeGreaterThan(0);
        expect(await parent.evaluate(backdropAlpha)).toBe(0);
        expect(await countDims(page)).toBe(1);
        await expectSheetChrome(parent, child, child.locator('> .sb-dialog__handle'));
        await chainClose(page, 'child').click();
        await expect(page.locator('dialog.popup')).toHaveCount(0);
    });

    const swipeDown = handle => handle.evaluate(node => {
        const y = node.getBoundingClientRect().top + 5;
        node.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 9, pointerType: 'touch', clientY: y, button: 0 }));
        node.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 9, pointerType: 'touch', clientY: y + 400, button: 0 }));
    });

    test('at 390 a swipe down on the handle of a Popup page goes back one level only', async ({ page }) => {
        await prepare(page, { width: 390, height: 844 });
        await openPopups(page, [{ name: 'root', type: 'CONFIRM', tier: 'window' }, { name: 'middle' }, { name: 'top' }]);
        const top = popupNamed(page, 'top');
        await expect(top).toHaveAttribute('data-covers-sheet', '');
        await swipeDown(top.locator('> .sb-dialog__handle'));
        await expect(page.locator('dialog.popup')).toHaveCount(2);
        await expect(popupNamed(page, 'middle')).toBeVisible();
        await expect(popupNamed(page, 'middle')).not.toHaveAttribute('inert');
        expect(await page.evaluate(() => window.qaLog)).toEqual(['closing:top', 'closed:top']);
        await chainClose(page, 'middle').click();
        await expect(page.locator('dialog.popup')).toHaveCount(0);
    });

    test('at 390 a swipe down on the handle of an openDialog page goes back one level only', async ({ page }) => {
        await prepare(page, { width: 390, height: 844 });
        await openPopups(page, [{ name: 'root', type: 'CONFIRM', tier: 'window' }, { name: 'middle' }]);
        await page.evaluate(async () => {
            const { openDialog } = await import('/scripts/sillybunny-editor/dialog.js');
            window.qaPage = openDialog({ title: 'Page', content: document.createElement('p') });
            window.qaPageResult = undefined;
            void window.qaPage.closed.then(result => { window.qaPageResult = result; });
        });
        const host = page.locator('.sb-dialog-host[open]');
        await expect(host.locator('.sb-dialog')).toHaveAttribute('data-covers-sheet', '');
        await swipeDown(host.locator('.sb-dialog__handle'));
        await expect(page.locator('.sb-dialog-host')).toHaveCount(0);
        expect(await page.evaluate(() => window.qaPageResult)).toEqual({ response: 'back' });
        await expect(page.locator('dialog.popup')).toHaveCount(2);
        await expect(popupNamed(page, 'middle')).toBeVisible();
        await expect(popupNamed(page, 'middle')).not.toHaveAttribute('inert');
        await chainClose(page, 'middle').click();
        await expect(page.locator('dialog.popup')).toHaveCount(0);
    });
});
