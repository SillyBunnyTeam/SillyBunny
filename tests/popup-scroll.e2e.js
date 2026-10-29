import { expect, test } from '@playwright/test';
import { protectMaintainerServer } from './helpers/maintainer-server.js';

// A default-size Popup with long content must scroll on desktop. Before the SillyBunny dialog frame,
// popup.css clipped .popup-content (overflow: hidden above 1000px), so the last rows were unreachable.

async function openCreateProfile(page, viewport) {
    await protectMaintainerServer(page);
    await page.setViewportSize(viewport);
    await page.goto('/');
    await page.waitForFunction(() => window.SillyTavern?.getContext?.()?.eventSource?.autoFireLastArgs?.has('app_ready'), null, { timeout: 60000 });
    await page.waitForFunction(() => !document.getElementById('preloader'));
    await page.evaluate(async () => {
        const { Popup, POPUP_TYPE } = await import('/scripts/popup.js');
        const content = document.createElement('div');
        for (let index = 0; index < 12; index++) {
            const label = document.createElement('label');
            label.className = 'checkbox_label';
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.name = 'exclude';
            input.value = `fixture-command-${index}`;
            input.checked = true;
            const text = document.createElement('span');
            text.textContent = `Fixture command ${index + 1}: a long value that makes the profile dialog scroll`;
            label.append(input, text);
            content.append(label);
        }
        content.insertAdjacentHTML('afterbegin', '<h3>Creating a Connection Profile</h3>');
        window.qaPopupScroll = new Popup(content, POPUP_TYPE.INPUT, 'QA profile', { rows: 4 });
        void window.qaPopupScroll.show();
    });
    const dialog = page.locator('dialog.popup[open]').filter({ has: page.locator('input[name="exclude"]') });
    await expect(dialog.locator('input[name="exclude"]').first()).toBeAttached();
    return dialog;
}

/** Whether `inner` lies inside both `outer` and the viewport. */
function inside(inner, outer, viewport) {
    return inner.y >= outer.y - 1 && inner.y + inner.height <= outer.y + outer.height + 1
        && inner.y >= -1 && inner.y + inner.height <= viewport.height + 1;
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 720 }]) {
    test(`Create Connection Profile scrolls to its last row and keeps Save visible at ${viewport.width}×${viewport.height}`, async ({ page }) => {
        const dialog = await openCreateProfile(page, viewport);
        const rows = dialog.locator('input[name="exclude"]');
        expect(await rows.count()).toBeGreaterThan(10);

        const dialogBox = await dialog.boundingBox();
        expect(dialogBox.y).toBeGreaterThanOrEqual(0);
        expect(dialogBox.y + dialogBox.height).toBeLessThanOrEqual(viewport.height);

        const first = await rows.first().locator('xpath=ancestor::label[1]').boundingBox();
        await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
        for (let step = 0; step < 20; step++) await page.mouse.wheel(0, 400);

        const lastRow = rows.last().locator('xpath=ancestor::label[1]');
        await expect.poll(async () => inside(await lastRow.boundingBox(), await dialog.boundingBox(), viewport)).toBe(true);

        const save = dialog.locator('.popup-button-ok');
        await expect(save).toBeVisible();
        expect(inside(await save.boundingBox(), await dialog.boundingBox(), viewport)).toBe(true);

        await dialog.locator('.popup-button-cancel').click();
        await expect(dialog).toBeHidden();
    });
}
