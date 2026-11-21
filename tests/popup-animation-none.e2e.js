import { expect, test } from '@playwright/test';
import { MOTION } from './helpers/dialog-opening.js';
import { bootMiscDialogs, MISC_VIEWPORTS } from './helpers/misc-dialogs.js';

test.use({ serviceWorkers: 'block' });

// The theme's exit animation lasts 200ms. WebKit does not report the end of the 0ms backdrop animation of a popup with no animation, so
// there the dialog waited for the 200ms one. Chromium and Firefox hide that wait. Time is measured instead of frames, because
// headless WebKit counts frames at its own pace.
const EXIT_MS = 200;

/**
 * Opens a Popup, waits for its opening to end, closes it, and measures how long the dialog stays in the document.
 */
async function msInDocumentAfterClose(page, animation) {
    return await page.evaluate(async animation => {
        const { Popup, POPUP_TYPE } = await import('/scripts/popup.js');
        const popup = new Popup('<p>Animation check</p>', POPUP_TYPE.TEXT, '', { animation });
        const shown = popup.show();
        while (popup.dlg.hasAttribute('opening')) await new Promise(resolve => requestAnimationFrame(resolve));
        const started = performance.now();
        popup.completeCancelled();
        while (popup.dlg.isConnected && performance.now() - started < 1000) {
            await new Promise(resolve => requestAnimationFrame(resolve));
        }
        const ms = performance.now() - started;
        await shown;
        return { ms, connected: popup.dlg.isConnected };
    }, animation);
}

for (const viewport of MISC_VIEWPORTS) {
    const size = `${viewport.width}x${viewport.height}`;

    test(`a popup opened with no animation leaves the document at once at ${size}`, async ({ page }) => {
        await bootMiscDialogs(page, viewport, MOTION);
        expect(await page.evaluate(() => document.body.classList.contains('reduced-motion')), 'this check needs motion on').toBe(false);

        const none = await msInDocumentAfterClose(page, 'none');
        expect(none.connected).toBe(false);
        expect(none.ms, `a popup with no animation stayed ${Math.round(none.ms)}ms in the document`).toBeLessThan(EXIT_MS * 0.75);
    });

    test(`a popup opened with an animation still plays its exit at ${size}`, async ({ page }) => {
        await bootMiscDialogs(page, viewport, MOTION);

        const fast = await msInDocumentAfterClose(page, 'fast');
        expect(fast.connected).toBe(false);
        expect(fast.ms, 'the exit animation of a popup with an animation did not run').toBeGreaterThanOrEqual(EXIT_MS * 0.75);
    });
}
