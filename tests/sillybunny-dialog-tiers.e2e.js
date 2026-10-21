import { expect, test } from '@playwright/test';
import { protectMaintainerServer } from './helpers/maintainer-server.js';

const VIEWPORTS = [
    { width: 1440, height: 900, presentation: 'floating' },
    { width: 1024, height: 600, presentation: 'floating' },
    { width: 768, height: 1024, presentation: 'floating' },
    { width: 450, height: 800, presentation: 'sheet' },
    { width: 390, height: 844, presentation: 'sheet' },
    { width: 844, height: 390, presentation: 'floating' },
];

async function boot(page, viewport, { reduceMotion = true } = {}) {
    await protectMaintainerServer(page);
    await page.setViewportSize(viewport);
    await page.goto('/');
    await page.waitForFunction(() => window.SillyTavern?.getContext?.()?.eventSource?.autoFireLastArgs?.has('app_ready'), null, { timeout: 60000 });
    await page.waitForFunction(() => !document.getElementById('preloader'));
    if (reduceMotion) await page.emulateMedia({ reducedMotion: 'reduce' });
}

for (const viewport of VIEWPORTS) {
    test(`Popup tiers and fallback controls at ${viewport.width}×${viewport.height}`, async ({ page }) => {
        await boot(page, viewport);

        await page.evaluate(async () => {
            const { Popup, POPUP_TYPE } = await import('/scripts/popup.js');
            const content = document.createElement('div');
            content.innerHTML = '<h3 data-i18n="Delete Character">Delete Character</h3><p>Permanent action.</p>';
            window.qaAlert = new Popup(content, POPUP_TYPE.CONFIRM, '', {
                okButton: 'Delete', cancelButton: 'Cancel', defaultResult: 0,
                customInputs: [{ id: 'delete-chat-files', label: 'Also delete chat files' }],
            });
            void window.qaAlert.show().then(result => { window.qaAlertResult = result; });
        });
        let popup = page.locator('dialog.popup[open]').last();
        await expect(popup).toHaveClass(/sb-dialog--alert/);
        await expect(popup).toHaveAttribute('data-presentation', viewport.presentation);
        await expect(popup.locator('#delete-chat-files')).toHaveAttribute('role', 'switch');
        await expect(popup.locator('.popup-button-cancel')).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(popup).toBeHidden();
        expect(await page.evaluate(() => window.qaAlertResult)).toBeNull();

        await page.evaluate(async () => {
            const { Popup, POPUP_TYPE } = await import('/scripts/popup.js');
            window.qaInput = new Popup('<h3>Rename a connection profile with a long descriptive title</h3><p>Enter a long name.</p>', POPUP_TYPE.INPUT, 'Old', { rows: 4 });
            void window.qaInput.show();
        });
        popup = page.locator('dialog.popup[open]').last();
        await expect(popup).toHaveClass(/sb-dialog--dialog/);
        await expect(popup.locator('.sb-dialog__title')).toHaveText('Rename a connection profile with a long descriptive title');
        const headerFit = await popup.evaluate(node => {
            const title = node.querySelector('.sb-dialog__title').getBoundingClientRect();
            const surface = node.getBoundingClientRect();
            const responses = [...node.querySelectorAll('.popup-button-ok, .popup-button-cancel')].map(button => button.getBoundingClientRect());
            return {
                overlaps: responses.some(button => title.left < button.right && title.right > button.left),
                centred: Math.abs((title.left + title.right - surface.left - surface.right) / 2) < 1,
            };
        });
        expect(headerFit).toEqual({ overlaps: false, centred: true });
        await popup.locator('.popup-button-cancel').click();
        await expect(popup).toBeHidden();

        await page.evaluate(async () => {
            const { Popup, POPUP_TYPE } = await import('/scripts/popup.js');
            window.qaWindow = new Popup('<h3>Data Bank</h3><p>Viewer content.</p>', POPUP_TYPE.TEXT, '', { large: true, okButton: 'Close' });
            void window.qaWindow.show();
        });
        popup = page.locator('dialog.popup[open]').last();
        await expect(popup).toHaveClass(/sb-dialog--window/);
        await expect(popup).toHaveAttribute('data-presentation', viewport.presentation);
        await expect(popup.locator('.popup-button-ok')).toBeHidden();
        await expect(popup.locator('.sb-dialog__close')).toBeVisible();
        await popup.locator('.sb-dialog__close').click();
        await expect(popup).toBeHidden();
    });

    test(`Popup veto, inputs, scrim and focus contract at ${viewport.width}×${viewport.height}`, async ({ page }) => {
        await boot(page, viewport);
        await page.evaluate(async () => {
            const { Popup, POPUP_TYPE } = await import('/scripts/popup.js');
            const opener = document.createElement('button');
            opener.id = 'qa-popup-opener';
            opener.textContent = 'Open';
            document.body.append(opener);
            opener.focus();
            window.qaCloseAllowed = false;
            window.qaPopup = new Popup('<h3>Options</h3><p>Details</p>', POPUP_TYPE.CONFIRM, '', {
                tier: 'dialog',
                customInputs: [{ id: 'qa-retain', label: 'Retain data', defaultState: false }],
                onClosing: () => window.qaCloseAllowed,
            });
            void window.qaPopup.show().then(result => {
                window.qaCompletion = { result, inputs: Object.fromEntries(window.qaPopup.inputResults) };
            });
            window.qaHeader = window.qaPopup.dlg.querySelector('.sb-dialog__header');
        });
        const popup = page.locator('dialog.popup[open]').last();
        await expect(popup).toHaveAttribute('data-presentation', viewport.presentation);
        await popup.locator('#qa-retain').check();
        await popup.locator('.popup-button-ok').click();
        await expect(popup).toBeVisible();
        await expect(popup).not.toHaveAttribute('closing');
        expect(await popup.evaluate(node => node.querySelector('.sb-dialog__header') === window.qaHeader)).toBe(true);
        await page.mouse.click(2, 2);
        await expect(popup).toBeVisible();
        await page.evaluate(() => { window.qaCloseAllowed = true; });
        await page.mouse.click(2, 2);
        if (viewport.presentation === 'sheet') {
            await expect(popup).toBeVisible();
            await page.keyboard.press('Escape');
        }
        await expect(popup).toHaveCount(0);
        expect(await page.evaluate(() => window.qaCompletion)).toEqual({ result: null, inputs: { 'qa-retain': true } });
        await expect(page.locator('#qa-popup-opener')).toBeFocused();

        await page.evaluate(async () => {
            const { Popup, POPUP_TYPE } = await import('/scripts/popup.js');
            window.qaPopup = new Popup('<h3>Responses</h3>', POPUP_TYPE.CONFIRM, '', {
                tier: 'dialog', defaultResult: 7, customButtons: [{ text: 'Custom', result: 7 }],
            });
            void window.qaPopup.show().then(result => { window.qaCustomResult = result; });
        });
        await expect(popup.locator('.popup-button-custom')).toBeFocused();
        await expect(popup.locator('.popup-button-custom')).toHaveCSS('flex-grow', '0');
        const endGap = await popup.locator('.popup-button-custom').evaluate(button => {
            const bar = button.closest('.sb-dialog__bottom-bar');
            return bar.getBoundingClientRect().right - button.getBoundingClientRect().right - Number.parseFloat(getComputedStyle(bar).paddingRight);
        });
        expect(endGap).toBeCloseTo(0, 0);
        expect(await page.evaluate(() => window.qaPopup.buttonControls.querySelectorAll('[data-result]').length)).toBe(3);
        expect(await popup.evaluate(node => node.querySelector('.sb-dialog__bottom-bar').getBoundingClientRect().top >= node.querySelector('.popup-body').getBoundingClientRect().bottom - 1)).toBe(true);
        await popup.locator('.popup-button-custom').click();
        await expect(popup).toHaveCount(0);
        expect(await page.evaluate(() => window.qaCustomResult)).toBe(7);
        await expect(page.locator('#qa-popup-opener')).toBeFocused();
    });
}

test('dragging from Popup content onto the backdrop does not dismiss it', async ({ page }) => {
    await boot(page, { width: 1440, height: 900 });
    await page.evaluate(async () => {
        const { Popup, POPUP_TYPE } = await import('/scripts/popup.js');
        window.qaPopup = new Popup('<h3>Draft</h3><p>Keep these unsaved edits.</p>', POPUP_TYPE.CONFIRM, '', { tier: 'dialog' });
        void window.qaPopup.show();
    });
    const popup = page.locator('dialog.popup[open]');
    const content = popup.locator('.popup-content p');
    await content.hover();
    await page.mouse.down();
    await page.mouse.move(2, 2);
    await page.mouse.up();
    await expect(popup).toBeVisible();
    await expect(popup).not.toHaveAttribute('closing');
    await page.mouse.click(2, 2);
    await expect(popup).toHaveCount(0);
});

for (const width of [1440, 390]) {
    test(`opening motion preserves unscaled header tracks and footer reservation at ${width}px`, async ({ page }) => {
        await boot(page, { width, height: 844 }, { reduceMotion: false });
        await page.evaluate(() => document.body.classList.remove('reduced-motion'));
        expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(false);
        await page.evaluate(async () => {
            const { Popup, POPUP_TYPE } = await import('/scripts/popup.js');
            window.qaPopup = new Popup('<h3>A long descriptive dialog title</h3><p>Details</p>', POPUP_TYPE.CONFIRM, '', {
                tier: 'dialog', okButton: 'Save changes', customButtons: [{ text: 'Custom response', result: 7 }],
            });
            void window.qaPopup.show();
        });
        const popup = page.locator('dialog.popup[open]');
        await expect(popup).not.toHaveAttribute('opening');
        const layout = await popup.evaluate(node => {
            const header = node.querySelector(':scope > .sb-dialog__header');
            const tracks = getComputedStyle(header).gridTemplateColumns.split(' ').map(Number.parseFloat);
            const buttons = [...header.querySelectorAll(':scope > .popup-controls > .menu_button')];
            const bar = header.querySelector('.sb-dialog__bottom-bar');
            return {
                start: tracks[0], end: tracks[2],
                reservedSide: Number.parseFloat(header.style.getPropertyValue('--sb-dialog-header-side')),
                buttonWidth: Math.max(...buttons.map(button => button.offsetWidth)),
                reservedFooter: Number.parseFloat(node.style.getPropertyValue('--sb-popup-response-height')),
                footerHeight: bar.offsetHeight,
            };
        });
        expect(layout.start).toBeCloseTo(layout.end, 0);
        expect(layout.reservedSide).toBe(layout.buttonWidth);
        expect(layout.reservedFooter).toBe(layout.footerHeight);
        await popup.locator('.popup-button-cancel').click();
        await expect(popup).toHaveCount(0);
    });
}

test('a Popup opened from a Dialog is presented as a page and restores the parent on close', async ({ page }) => {
    await boot(page, { width: 1440, height: 900 });
    await page.evaluate(async () => {
        const { Popup, POPUP_TYPE } = await import('/scripts/popup.js');
        window.qaParent = new Popup('<h3>Parent</h3><p>Parent content</p>', POPUP_TYPE.TEXT, '', { large: true });
        void window.qaParent.show();
        window.qaChild = new Popup('<h3>Child</h3><p>Child content</p>', POPUP_TYPE.CONFIRM, '', { wide: true });
        void window.qaChild.show();
    });
    const dialogs = page.locator('dialog.popup[open]');
    await expect(dialogs).toHaveCount(2);
    const parent = dialogs.nth(0);
    const child = dialogs.nth(1);
    await expect(parent).toHaveAttribute('data-sb-covered', '');
    await expect(parent).toHaveJSProperty('inert', true);
    await expect(child).toHaveClass(/sb-dialog--page/);
    await expect(child.locator('.sb-dialog__title')).toHaveText('Child');
    await page.mouse.click(2, 2);
    await expect(child).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(child).toHaveCount(0);
    await expect(parent).not.toHaveAttribute('data-sb-covered');
    await expect(parent).toHaveJSProperty('inert', false);
    await page.keyboard.press('Escape');
    await expect(parent).toHaveCount(0);
});

for (const width of [1440, 390]) {
    test(`closing a Popup also closes its hosted colour picker at ${width}px`, async ({ page }) => {
        await boot(page, { width, height: 844 });
        await page.evaluate(async () => {
            const { Popup, POPUP_TYPE } = await import('/scripts/popup.js');
            const { initializeColorPickers } = await import('/scripts/sillybunny-color-picker.js');
            window.qaPopup = new Popup('<h3>Colour</h3><toolcool-color-picker color="#3584e4" aria-label="Colour"></toolcool-color-picker>', POPUP_TYPE.TEXT, '', { large: true });
            void window.qaPopup.show();
            await initializeColorPickers();
        });
        await page.locator('dialog.popup[open] toolcool-color-picker .button').click();
        await expect(page.locator('.sb-color-picker-menu')).toBeVisible();
        await page.evaluate(() => window.qaPopup.completeCancelled());
        await expect(page.locator('.sb-color-picker-menu, .sb-color-picker-sheet')).toHaveCount(0);
        await expect(page.locator('dialog[open]')).toHaveCount(0);
    });
}
