import { expect, test } from '@playwright/test';
import { openQuietChatForSmoke } from './chat-scroll-regression-helpers.js';
import { protectMaintainerServer } from './helpers/maintainer-server.js';

// The wide layouts start at 1280px, the step the stylesheets write as `max-width: 1279px`. Below it the chat takes the
// width that a docked panel leaves; from it the chat keeps its configured width and the panels take the gutters.
const CASES = [
    { width: 1279, fillsRemainder: true },
    { width: 1280, fillsRemainder: false },
];

for (const { width, fillsRemainder } of CASES) {
    test(`a docked side panel ${fillsRemainder ? 'leaves the chat the rest of the width' : 'keeps the chat at its configured width'} at ${width}px`, async ({ page }) => {
        await protectMaintainerServer(page);
        await page.setViewportSize({ width, height: 900 });
        await openQuietChatForSmoke(page);
        const before = await page.evaluate(async () => {
            const source = document.createElement('section');
            source.id = 'qa-side-panel';
            source.textContent = 'Panel';
            document.getElementById('movingDivs').append(source);
            const sidePanels = await import('/scripts/sillybunny-editor/side-panel.js');
            window.qaSidePanel = sidePanels.registerSidePanel({ id: 'qa-side-panel', element: source, title: 'Test Panel', defaultSide: 'left' });
            const before = document.getElementById('sheld').getBoundingClientRect().width;
            await window.qaSidePanel.open({});
            return before;
        });
        const panel = page.locator('.sb-side-panel[data-sb-side-panel-id="qa-side-panel"]');
        await expect(panel).toBeVisible();
        await expect.poll(() => panel.evaluate(element => element.getAnimations().length)).toBe(0);
        const geometry = await page.evaluate(() => ({
            panel: document.querySelector('.sb-side-panel[data-sb-side-panel-id="qa-side-panel"]').getBoundingClientRect().toJSON(),
            shell: document.getElementById('sheld').getBoundingClientRect().toJSON(),
        }));
        expect(geometry.shell.left).toBeGreaterThanOrEqual(geometry.panel.right - 1);
        // The shell ends at the window edge when it fills the remainder, and keeps its width otherwise.
        const expectedWidth = fillsRemainder ? width - geometry.shell.left : before;
        expect(Math.abs(geometry.shell.width - expectedWidth)).toBeLessThan(1);
    });
}
