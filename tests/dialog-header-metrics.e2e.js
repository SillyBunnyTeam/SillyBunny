import { expect, test } from '@playwright/test';
import { waitForAppReady } from './helpers/app-ready.js';
import { protectMaintainerServer } from './helpers/maintainer-server.js';

// One header bar for the Dialog and Window tiers, whether the frame comes from openDialog or from a Popup, so that the
// headers of sibling dialogs agree in height, padding, gap and alignment (floating and as a bottom sheet).

test.beforeEach(async ({ page }) => {
    await protectMaintainerServer(page);
});

const OPEN = {
    async dialog(page) {
        await page.evaluate(async () => {
            const { openDialog } = await import('/scripts/sillybunny-editor/dialog.js');
            window.__headerDialog = openDialog({ tier: 'dialog', title: 'A Title', content: document.createElement('div'), responses: { affirmative: { id: 'ok', label: 'Save' } } });
        });
    },
    async window(page) {
        await page.evaluate(async () => {
            const { openDialog } = await import('/scripts/sillybunny-editor/dialog.js');
            window.__headerDialog = openDialog({ tier: 'window', title: 'A Title', content: document.createElement('div'), responses: { affirmative: { id: 'ok', label: 'Save' } } });
        });
    },
    async naming(page) {
        await page.evaluate(async () => {
            const { openFontNamingDialog } = await import('/scripts/sillybunny-fonts.js');
            void openFontNamingDialog({ fileName: 'Example-BoldItalic.woff2' });
        });
    },
    async popup(page) {
        await page.evaluate(async () => {
            const { Popup, POPUP_TYPE } = await import('/scripts/popup.js');
            window.__headerPopup = new Popup('<h3>A Title</h3><textarea></textarea>', POPUP_TYPE.CONFIRM, '', { wide: true, okButton: 'Save', cancelButton: 'Cancel' });
            void window.__headerPopup.show();
        });
    },
};

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    test(`Dialog and Window headers share one height, padding, gap and alignment at ${viewport.width}px`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.goto('/');
        await waitForAppReady(page);
        const metrics = {};
        for (const [kind, open] of Object.entries(OPEN)) {
            await open(page);
            const header = page.locator('dialog[open]:not([closing]) .sb-dialog__header').last();
            await expect(header).toBeVisible();
            await page.waitForTimeout(700);
            metrics[kind] = await header.evaluate(node => {
                const style = getComputedStyle(node);
                return { height: Math.round(node.getBoundingClientRect().height), padding: style.padding, gap: style.columnGap, align: style.alignItems };
            });
            await page.evaluate(() => {
                window.__headerDialog?.forceClose();
                window.__headerDialog = null;
            });
            await page.keyboard.press('Escape');
            await page.waitForTimeout(500);
        }
        expect(metrics.window).toEqual(metrics.dialog);
        expect(metrics.popup).toEqual(metrics.dialog);
        expect(metrics.naming).toEqual(metrics.dialog);
        expect(metrics.dialog.align).toBe('center');
        expect(metrics.dialog.gap).toBe('6px');
    });
}
