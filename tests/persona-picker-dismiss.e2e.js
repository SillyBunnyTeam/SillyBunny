import { expect, test } from '@playwright/test';
import { openQuietChatForSmoke } from './chat-scroll-regression-helpers.js';
import { protectMaintainerServer } from './helpers/maintainer-server.js';

test.beforeEach(async ({ page }) => { await protectMaintainerServer(page); });

test.use({ serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });
// The case boots the whole app, which can use most of the default 30 s when several workers share one server.
test.describe.configure({ timeout: 60_000 });

test('the persona menu ignores a click that the app dispatches and closes on a click outside', async ({ page }) => {
    await openQuietChatForSmoke(page);
    const picker = page.locator('#sb-persona-picker');

    await page.locator('#sb-persona-bubble').click();
    await expect(picker).toBeVisible();

    // The app clicks and focuses the message box a moment after a chat loads. That click is the app's, not the user's.
    await page.evaluate(() => document.getElementById('send_textarea').click());
    await expect(picker).toBeVisible();

    await page.locator('#chat').click({ position: { x: 12, y: 12 } });
    await expect(picker).toHaveCount(0);
});

test('Escape closes the persona menu whether the focus is in it or has been moved to the message box', async ({ page }) => {
    await openQuietChatForSmoke(page);
    const picker = page.locator('#sb-persona-picker');

    await page.locator('#sb-persona-bubble').click();
    await expect(picker).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(picker).toHaveCount(0);

    // The app moves the focus to the message box a moment after a chat loads; the menu was opened before that.
    await page.locator('#sb-persona-bubble').click();
    await expect(picker).toBeVisible();
    await page.evaluate(() => document.getElementById('send_textarea').focus());
    await expect(page.locator('#send_textarea')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(picker).toHaveCount(0);
});

test('the persona menu stays shown, in place, while a persona event renders it again', async ({ page }) => {
    await openQuietChatForSmoke(page);
    const picker = page.locator('#sb-persona-picker');
    await page.locator('#sb-persona-bubble').click();
    await expect(picker).toBeVisible();
    await expect.poll(() => picker.evaluate(element => element.style.visibility)).toBe('');
    const placed = await picker.evaluate(element => ({ left: element.style.left, top: element.style.top }));

    // The event renders an open menu again on the next frame, and the frame after that is the one where a menu that is built
    // hidden would show itself. The menu is read on each of the next frames; a capture that finds it hidden opens its surface again.
    const frames = await page.evaluate(async () => {
        const context = window.SillyTavern.getContext();
        const original = document.getElementById('sb-persona-picker');
        await context.eventSource.emit((context.eventTypes ?? context.event_types).PERSONA_UPDATED);
        const read = [];
        for (let frame = 0; frame < 6; frame++) {
            await new Promise(resolve => requestAnimationFrame(resolve));
            const current = document.getElementById('sb-persona-picker');
            read.push({ present: Boolean(current), replaced: current !== original, visibility: current && getComputedStyle(current).visibility, left: current?.style.left, top: current?.style.top });
        }
        return read;
    });
    expect(frames.some(frame => frame.replaced), 'the event rendered the menu again').toBe(true);
    for (const frame of frames) {
        expect(frame).toMatchObject({ present: true, visibility: 'visible', ...placed });
    }
});
