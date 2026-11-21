import { expect, test } from '@playwright/test';
import { openQuietChatForSmoke } from './chat-scroll-regression-helpers.js';
import { protectMaintainerServer } from './helpers/maintainer-server.js';

test.beforeEach(async ({ page }) => { await protectMaintainerServer(page); });

test.use({ serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });
test.describe.configure({ timeout: 60_000 });

const SOURCE = Array.from({ length: 14 }, (_, index) => `Suggestion number ${index + 1} with a long name that is wider than the field`);

/** Opens a jQuery UI autocomplete list on a field that sits at the given place, and returns the list's and the field's boxes. */
async function openListAt(page, place) {
    await page.evaluate(({ place: where, source }) => {
        document.getElementById('clamp-field')?.remove();
        const input = document.createElement('input');
        input.id = 'clamp-field';
        input.style.cssText = `position: fixed; width: 120px; z-index: 20000; ${where}`;
        document.body.append(input);
        window.$(input).autocomplete({ source, minLength: 0 });
        input.focus();
        window.$(input).autocomplete('search', '');
    }, { place, source: SOURCE });
    const list = page.locator('.ui-autocomplete:not([style*="display: none"])').last();
    await expect(list.locator('.ui-menu-item').first()).toBeVisible();
    return list;
}

async function boxes(page, list) {
    return list.evaluate(node => {
        const rect = node.getBoundingClientRect();
        const field = document.getElementById('clamp-field').getBoundingClientRect();
        return {
            left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
            fieldBottom: field.bottom, width: window.innerWidth, height: window.innerHeight,
        };
    });
}

for (const [name, place] of [
    ['the right edge', 'right: 4px; top: 200px'],
    ['the foot of the window', 'left: 40px; bottom: 100px'],
    ['the bottom right corner', 'right: 4px; bottom: 100px'],
]) {
    test(`an autocomplete list that opens at ${name} stays inside the window, below its field`, async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 700 });
        await openQuietChatForSmoke(page);
        // The first list loads the clamp, which then clamps that list too.
        const list = await openListAt(page, place);
        await expect.poll(async () => {
            const box = await boxes(page, list);
            return box.left >= -0.5 && box.right <= box.width + 0.5 && box.bottom <= box.height + 0.5;
        }).toBe(true);
        const box = await boxes(page, list);
        expect(box.top).toBeGreaterThanOrEqual(box.fieldBottom - 1);
        // A list that was cut short still scrolls to its last item.
        expect(await list.evaluate(node => node.scrollHeight >= node.clientHeight)).toBe(true);
    });
}

test('a list that fits is left where the widget put it, and a later open is clamped again', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 800 });
    await openQuietChatForSmoke(page);
    const roomy = await openListAt(page, 'left: 100px; top: 100px');
    await expect(roomy).toBeVisible();
    await expect.poll(async () => (await boxes(page, roomy)).bottom).toBeLessThanOrEqual(800);
    expect(await roomy.evaluate(node => node.style.maxHeight)).toBe('');
    const tight = await openListAt(page, 'right: 2px; bottom: 80px');
    await expect.poll(async () => {
        const box = await boxes(page, tight);
        return box.right <= box.width + 0.5 && box.bottom <= box.height + 0.5;
    }).toBe(true);
});
