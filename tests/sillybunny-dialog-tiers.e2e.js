import { expect, test } from '@playwright/test';
import { protectMaintainerServer } from './helpers/maintainer-server.js';

const VIEWPORTS = [
    { width: 1440, height: 900, presentation: 'floating' },
    { width: 390, height: 844, presentation: 'sheet' },
    { width: 844, height: 390, presentation: 'floating' },
];

async function boot(page, viewport) {
    await protectMaintainerServer(page);
    await page.setViewportSize(viewport);
    await page.goto('/');
    await page.waitForFunction(() => window.SillyTavern?.getContext?.()?.eventSource?.autoFireLastArgs?.has('app_ready'), null, { timeout: 60000 });
    await page.waitForFunction(() => !document.getElementById('preloader'));
    await page.emulateMedia({ reducedMotion: 'reduce' });
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
            void window.qaAlert.show();
        });
        let popup = page.locator('dialog.popup[open]').last();
        await expect(popup).toHaveClass(/sb-dialog--alert/);
        await expect(popup).toHaveAttribute('data-presentation', viewport.presentation);
        await expect(popup.locator('#delete-chat-files')).toHaveAttribute('role', 'switch');
        await expect(popup.locator('.popup-button-cancel')).toBeFocused();
        await popup.locator('.popup-button-cancel').click();
        await expect(popup).toBeHidden();

        await page.evaluate(async () => {
            const { Popup, POPUP_TYPE } = await import('/scripts/popup.js');
            window.qaInput = new Popup('<h3>Rename</h3><p>Enter a long name.</p>', POPUP_TYPE.INPUT, 'Old', { rows: 4 });
            void window.qaInput.show();
        });
        popup = page.locator('dialog.popup[open]').last();
        await expect(popup).toHaveClass(/sb-dialog--dialog/);
        await expect(popup.locator('.sb-dialog__title')).toHaveText('Rename');
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
    await page.keyboard.press('Escape');
    await expect(child).toHaveCount(0);
    await expect(parent).not.toHaveAttribute('data-sb-covered');
    await expect(parent).toHaveJSProperty('inert', false);
    await page.keyboard.press('Escape');
    await expect(parent).toHaveCount(0);
});
