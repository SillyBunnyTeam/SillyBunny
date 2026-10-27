/* eslint-disable playwright/no-conditional-in-test, playwright/no-conditional-expect -- viewport mode selects docked or sheet-specific geometry assertions. */
import { expect, test } from '@playwright/test';
import { protectMaintainerServer } from './helpers/maintainer-server.js';

const VIEWPORTS = [
    { width: 1920, height: 1080, expectedMode: 'docked' },
    { width: 1440, height: 900, expectedMode: 'docked' },
    { width: 1280, height: 900, expectedMode: 'docked' },
    { width: 1024, height: 768, expectedMode: 'docked' },
    { width: 900, height: 768, expectedMode: 'docked' },
    { width: 768, height: 1024, expectedMode: 'docked' },
    { width: 390, height: 844, expectedMode: 'sheet' },
    { width: 844, height: 390, expectedMode: 'docked' },
];

async function boot(page, viewport) {
    await protectMaintainerServer(page);
    await page.setViewportSize(viewport);
    await page.goto('/');
    await page.waitForFunction(() => window.SillyTavern?.getContext?.()?.eventSource?.autoFireLastArgs?.has('app_ready'), null, { timeout: 60000 });
    await page.waitForFunction(() => !document.getElementById('preloader'));
}

for (const viewport of VIEWPORTS) {
    test(`side-panel engine layout and focus at ${viewport.width}×${viewport.height}`, async ({ page }) => {
        await boot(page, viewport);
        await page.evaluate(async () => {
            document.documentElement.style.setProperty('--sheldWidth', '55vw');
            let visualNovelWrapper = document.getElementById('visual-novel-wrapper');
            const visualNovelWrapperCreated = !visualNovelWrapper;
            if (!visualNovelWrapper) {
                visualNovelWrapper = document.createElement('div');
                visualNovelWrapper.id = 'visual-novel-wrapper';
                document.body.append(visualNovelWrapper);
            }
            window.qaVisualNovelWrapperState = {
                created: visualNovelWrapperCreated,
                display: visualNovelWrapper.style.getPropertyValue('display'),
                displayPriority: visualNovelWrapper.style.getPropertyPriority('display'),
            };
            visualNovelWrapper.style.display = 'flex';

            const opener = document.createElement('button');
            opener.id = 'qa-side-panel-opener';
            opener.textContent = 'Open test panel';
            document.body.append(opener);
            const source = document.createElement('section');
            source.id = 'qa-side-panel';
            const control = document.createElement('button');
            control.id = 'qa-side-panel-control';
            control.textContent = 'Panel control';
            source.append(control);
            document.getElementById('movingDivs').append(source);

            const zoomedAvatar = document.createElement('div');
            zoomedAvatar.id = 'qa-zoomed-avatar';
            zoomedAvatar.className = 'zoomed_avatar';
            zoomedAvatar.style.cssText = `position: fixed; left: 0; top: ${document.getElementById('top-bar').getBoundingClientRect().bottom}px; width: 40px; height: 40px; background: red;`;
            document.body.append(zoomedAvatar);
            opener.focus();

            const powerUserModule = await import('/scripts/power-user.js');
            powerUserModule.power_user.movingUIState = {};
            const sidePanels = await import('/scripts/sillybunny-editor/side-panel.js');
            window.qaSidePanel = sidePanels.registerSidePanel({
                id: 'qa-side-panel',
                element: source,
                title: 'Test Panel',
                defaultSide: 'left',
                onClose: () => { window.qaSidePanelClosed = true; },
            });
            window.qaInitialChatRect = document.getElementById('sheld').getBoundingClientRect().toJSON();
            await window.qaSidePanel.open({ opener });
        });

        const panel = page.locator('.sb-side-panel[data-sb-side-panel-id="qa-side-panel"]');
        await expect(panel).toBeVisible();
        await expect(page.locator('#qa-side-panel-control')).toBeFocused();
        if (viewport.expectedMode === 'sheet') {
            await expect.poll(() => panel.evaluate(element => element.getBoundingClientRect().bottom - document.getElementById('form_sheld').getBoundingClientRect().top))
                .toBeLessThanOrEqual(1);
        }

        const geometry = await page.evaluate(() => {
            const panel = document.querySelector('.sb-side-panel[data-sb-side-panel-id="qa-side-panel"]');
            const panelRect = panel.getBoundingClientRect();
            const chatRect = document.getElementById('sheld').getBoundingClientRect();
            const chatContentRect = document.getElementById('chat').getBoundingClientRect();
            const topBarRect = document.getElementById('top-bar').getBoundingClientRect();
            const composerRect = document.getElementById('form_sheld').getBoundingClientRect();
            const sendForm = document.getElementById('send_form');
            const sendTextarea = document.getElementById('send_textarea');
            const initial = window.qaInitialChatRect;
            const intersects = (left, right) => left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top;
            const result = {
                mode: panel.classList.contains('sb-side-panel--sheet') ? 'sheet' : 'docked',
                panel: { left: panelRect.left, right: panelRect.right, top: panelRect.top, bottom: panelRect.bottom },
                chat: { left: chatRect.left, right: chatRect.right, top: chatRect.top, bottom: chatRect.bottom, width: chatRect.width },
                chatContent: { left: chatContentRect.left, right: chatContentRect.right, top: chatContentRect.top, bottom: chatContentRect.bottom },
                initialChat: initial,
                topBar: { bottom: topBarRect.bottom },
                composer: { top: composerRect.top, bottom: composerRect.bottom },
                sendFormVisible: !!sendForm && sendForm.getClientRects().length > 0,
                sendTextareaVisible: !!sendTextarea && sendTextarea.getClientRects().length > 0,
                panelIntersectsChat: intersects(panelRect, panel.classList.contains('sb-side-panel--sheet') ? chatContentRect : chatRect),
                panelIntersectsShell: intersects(panelRect, document.getElementById('sheld').getBoundingClientRect()),
                panelIntersectsComposer: intersects(panelRect, composerRect),
                panelShadow: getComputedStyle(panel).boxShadow,
                panelUsesDialogFrame: panel.classList.contains('sb-dialog')
                    && panel.querySelector('.sb-dialog__header')
                    && panel.querySelector('.sb-dialog__body'),
                visualNovel: panel.classList.contains('sb-side-panel--sheet') ? null : {
                    left: document.getElementById('visual-novel-wrapper').getBoundingClientRect().left,
                    top: document.getElementById('visual-novel-wrapper').getBoundingClientRect().top,
                    width: document.getElementById('visual-novel-wrapper').getBoundingClientRect().width,
                    bottom: document.getElementById('visual-novel-wrapper').getBoundingClientRect().bottom,
                },
                panelIsAboveZoomedAvatar: panel.classList.contains('sb-side-panel--sheet')
                    ? null
                    : document.elementFromPoint(10, panelRect.top + 10)?.closest('.sb-side-panel') === panel,
                panelZIndex: getComputedStyle(panel).zIndex,
                avatarZIndex: getComputedStyle(document.getElementById('qa-zoomed-avatar')).zIndex,
            };
            const wrapperState = window.qaVisualNovelWrapperState;
            const wrapper = document.getElementById('visual-novel-wrapper');
            if (wrapperState.created) wrapper.remove();
            else if (wrapperState.display) wrapper.style.setProperty('display', wrapperState.display, wrapperState.displayPriority);
            else wrapper.style.removeProperty('display');
            document.getElementById('qa-zoomed-avatar').remove();
            return result;
        });

        expect(geometry.mode).toBe(viewport.expectedMode);
        expect(geometry.panelUsesDialogFrame).toBeTruthy();
        expect(geometry.panel.top).toBeGreaterThanOrEqual(geometry.topBar.bottom - 1);
        expect(geometry.sendFormVisible).toBe(true);
        expect(geometry.sendTextareaVisible).toBe(true);
        if (geometry.mode === 'sheet') {
            await expect(panel.locator('.sb-side-panel__grab-handle')).toBeVisible();
            expect(geometry.panelIntersectsChat, JSON.stringify(geometry)).toBe(false);
            expect(geometry.panelIntersectsComposer, JSON.stringify(geometry)).toBe(false);
            expect(geometry.panel.bottom).toBeLessThanOrEqual(geometry.composer.top + 1);
            expect(geometry.panel.bottom - geometry.panel.top).toBeLessThanOrEqual(viewport.height * 0.5 + 1);
            expect(Math.abs(geometry.chat.left - geometry.initialChat.left)).toBeLessThan(1);
            expect(Math.abs(geometry.chat.width - geometry.initialChat.width)).toBeLessThan(1);
            await page.locator('#send_textarea').fill('Composer remains usable above the sheet');
            await expect(page.locator('#send_textarea')).toHaveValue('Composer remains usable above the sheet');
            await panel.locator('.sb-side-panel__close').click();
            await expect(panel).toBeHidden();
            await expect(page.locator('#send_textarea')).toHaveValue('Composer remains usable above the sheet');
            await page.evaluate(async () => {
                await window.qaSidePanel.open({ opener: document.getElementById('qa-side-panel-opener') });
            });
            await expect(panel).toBeVisible();
        } else {
            expect(geometry.panelIntersectsChat, JSON.stringify(geometry)).toBe(false);
            expect(geometry.panelIntersectsComposer).toBe(false);
            if (viewport.width === 1440 && viewport.height === 900) expect(geometry.panelIntersectsShell).toBe(false);
            expect(geometry.panelShadow).toBe('none');
            expect(geometry.panelIsAboveZoomedAvatar).toBe(true);
            expect(Number(geometry.panelZIndex)).toBeGreaterThan(Number(geometry.avatarZIndex));
            if (viewport.width >= 1200) {
                expect(Math.abs(geometry.chat.left - geometry.initialChat.left)).toBeLessThan(1);
                expect(Math.abs(geometry.chat.width - geometry.initialChat.width)).toBeLessThan(1);
            }
            expect(Math.abs(geometry.visualNovel.left - geometry.chat.left)).toBeLessThan(1);
            expect(Math.abs(geometry.visualNovel.width - geometry.chat.width)).toBeLessThan(1);
            expect(Math.abs(geometry.visualNovel.top - geometry.topBar.bottom)).toBeLessThan(1);
            expect(Math.abs(geometry.visualNovel.bottom - viewport.height)).toBeLessThan(1);
        }

        await panel.locator('.sb-side-panel__menu-trigger').click();
        await expect(panel.locator('.sb-side-panel__menu-item')).toBeVisible();
        await panel.locator('.sb-side-panel__menu-item').click();
        const sideState = await page.evaluate(async () => {
            const module = await import('/scripts/power-user.js');
            return module.power_user.movingUIState['qa-side-panel'];
        });
        expect(sideState).toEqual({ left: 'unset', right: '0px' });

        await page.evaluate(async () => {
            const powerUserModule = await import('/scripts/power-user.js');
            const sidePanels = await import('/scripts/sillybunny-editor/side-panel.js');
            const movingUiToggle = document.getElementById('movingUImode');
            powerUserModule.power_user.movingUIState = {
                'qa-side-panel': { left: 'unset', right: '0px', top: '12px', width: 900 },
            };
            movingUiToggle.checked = true;
            movingUiToggle.dispatchEvent(new Event('change', { bubbles: true }));
            const { dragElement, isMobile } = await import('/scripts/RossAscends-mods.js');
            if (isMobile()) sidePanels.applyMovingUIState('qa-side-panel', powerUserModule.power_user.movingUIState['qa-side-panel']);
            powerUserModule.loadMovingUIState();
            await new Promise(resolve => setTimeout(resolve, 80));
            const panel = document.querySelector('.sb-side-panel[data-sb-side-panel-id="qa-side-panel"]');
            window.qaPresetSide = panel.dataset.sbSidePanelSide;
            window.qaPresetGeometryIgnored = !document.getElementById('qa-side-panel').style.width && !document.getElementById('qa-side-panel').style.top;

            dragElement(window.jQuery('#qa-side-panel'));
            const rect = document.getElementById('qa-side-panel').getBoundingClientRect();
            document.getElementById('qa-side-panel').dispatchEvent(new MouseEvent('mousedown', {
                bubbles: true,
                clientX: rect.right - 1,
                clientY: rect.bottom - 1,
            }));
            window.qaDragIgnored = !document.getElementById('qa-side-panel').hasAttribute('data-dragged');
            window.qaResizeDisabled = getComputedStyle(document.getElementById('qa-side-panel')).resize === 'none';

            document.getElementById('movingUIreset').click();
            await new Promise(resolve => setTimeout(resolve, 80));
            window.qaResetSide = panel.dataset.sbSidePanelSide;
            window.qaResetStateCleared = Object.keys(powerUserModule.power_user.movingUIState).length === 0;

            movingUiToggle.checked = false;
            movingUiToggle.dispatchEvent(new Event('change', { bubbles: true }));
            await new Promise(resolve => setTimeout(resolve, 80));
            window.qaMovingUIOff = !document.body.classList.contains('movingUI');
        });

        expect(await page.evaluate(() => window.qaPresetSide)).toBe('right');
        expect(await page.evaluate(() => window.qaPresetGeometryIgnored)).toBe(true);
        expect(await page.evaluate(() => window.qaDragIgnored)).toBe(true);
        expect(await page.evaluate(() => window.qaResizeDisabled)).toBe(true);
        expect(await page.evaluate(() => window.qaResetSide)).toBe('left');
        expect(await page.evaluate(() => window.qaResetStateCleared)).toBe(true);
        expect(await page.evaluate(() => window.qaMovingUIOff)).toBe(true);

        await page.keyboard.press('Escape');
        await expect(panel).toBeHidden();
        await expect(page.locator('#qa-side-panel-opener')).toBeFocused();
        expect(await page.evaluate(() => window.qaSidePanelClosed)).toBe(true);
    });
}

test('Escape follows dialog, menu, text-input and panel priority with multiple panels open', async ({ page }) => {
    await boot(page, { width: 1440, height: 900 });
    await page.evaluate(async () => {
        document.documentElement.style.setProperty('--sheldWidth', '55vw');
        const powerUserModule = await import('/scripts/power-user.js');
        powerUserModule.power_user.movingUIState = {};
        const sidePanels = await import('/scripts/sillybunny-editor/side-panel.js');
        const register = (id, side) => {
            const source = document.createElement('section');
            source.id = id;
            const input = document.createElement('input');
            input.id = `${id}-input`;
            input.addEventListener('keydown', event => {
                if (event.key !== 'Escape' || !input.value) return;
                event.preventDefault();
                input.value = '';
            });
            const control = document.createElement('button');
            control.textContent = `${id} control`;
            source.append(input, control);
            document.getElementById('movingDivs').append(source);
            return sidePanels.registerSidePanel({ id, element: source, title: id, defaultSide: side });
        };

        window.qaLeftSidePanel = register('qa-left-panel', 'left');
        window.qaRightSidePanel = register('qa-right-panel', 'right');
        await window.qaLeftSidePanel.open();
        await window.qaRightSidePanel.open();
    });

    const leftPanel = page.locator('.sb-side-panel[data-sb-side-panel-id="qa-left-panel"]');
    const rightPanel = page.locator('.sb-side-panel[data-sb-side-panel-id="qa-right-panel"]');
    await expect(leftPanel).toBeVisible();
    await expect(rightPanel).toBeVisible();

    await page.locator('#qa-right-panel-input').fill('clear on Escape');
    await page.keyboard.press('Escape');
    await expect(page.locator('#qa-right-panel-input')).toHaveValue('');
    await expect(rightPanel).toBeVisible();

    await rightPanel.locator('.sb-side-panel__menu-trigger').click();
    await expect(rightPanel.locator('.sb-side-panel__menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(rightPanel.locator('.sb-side-panel__menu')).toBeHidden();
    await expect(rightPanel).toBeVisible();

    await page.evaluate(() => {
        const dialog = document.createElement('dialog');
        dialog.id = 'qa-side-panel-priority-dialog';
        dialog.textContent = 'Dialog over panel';
        document.body.append(dialog);
        dialog.showModal();
    });
    const dialog = page.locator('#qa-side-panel-priority-dialog');
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveJSProperty('open', false);
    await expect(rightPanel).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(rightPanel).toBeHidden();
    await expect(leftPanel).toBeVisible();
    await leftPanel.locator('.sb-side-panel__close').focus();
    await page.keyboard.press('Escape');
    await expect(leftPanel).toBeHidden();
});
