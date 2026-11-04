import { expect, test } from '@playwright/test';
import { motionOn, startPaintProbe, stopPaintProbe, warmUpPopups } from './helpers/first-paint-probe.js';
import { bootWindowDialogs, openApiKeyManager, WINDOW_VIEWPORTS } from './helpers/window-dialogs.js';

test.setTimeout(90000);
// Playwright's `page.route` does not see requests that the app's service worker handles.
test.use({ serviceWorkers: 'block' });

// A destructive confirmation must show its OK button in the destructive colour from the first frame.
// It is marked in `onBeforePaint`: `onOpen` waits for the opening animation, and a Delete button that is the
// accent colour for that long looks harmless.
for (const viewport of WINDOW_VIEWPORTS) {
    test(`Delete Secret shows a destructive OK button in every frame, from the first, at ${viewport.width}×${viewport.height}`, async ({ page }) => {
        await bootWindowDialogs(page, viewport);
        const manager = await openApiKeyManager(page);
        await motionOn(page);
        await warmUpPopups(page);
        await startPaintProbe(page);
        await manager.locator('[data-action="delete-secret"][data-id="window-secret-23"]').click();
        const frames = await stopPaintProbe(page);

        const [first] = frames;
        const settled = frames.at(-1);
        expect(first.opening, 'the first sampled frame is inside the opening animation').toBe(true);
        expect(frames.length, 'frames sampled during and after the opening animation').toBeGreaterThan(2);
        expect(settled.okClasses).toContain('is-destructive');
        expect(first.okClasses, 'OK is marked destructive in the first frame').toContain('is-destructive');
        const fills = [...new Set(frames.map(frame => frame.okBackground))];
        expect(fills, 'the OK fill in every frame').toEqual([settled.okBackground]);
    });
}
