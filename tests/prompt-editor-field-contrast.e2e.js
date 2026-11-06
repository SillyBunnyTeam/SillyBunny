import { expect, test } from '@playwright/test';
import { gunzipSync } from 'node:zlib';
import { testSetup } from './frontend/frontent-test-utils.js';

test.use({ reducedMotion: 'reduce' });

test.beforeEach(async ({ page }) => {
    // Theme and navigation checks must not change saved account preferences.
    await page.route('**/api/settings/save', route => {
        const request = route.request();
        const body = request.headers()['content-encoding'] === 'gzip'
            ? gunzipSync(request.postDataBuffer()) : request.postDataBuffer();
        const payload = JSON.parse(body.toString());
        return route.fulfill({ json: { result: 'ok', version: payload._version + 1 } });
    });
});

function fieldAppearance(node) {
    const style = getComputedStyle(node);
    return {
        background: style.backgroundColor,
        color: style.color,
        radius: style.borderRadius,
        border: style.borderTopColor,
        shadow: style.boxShadow,
    };
}

function fieldContrast(node) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, 1, 1);
    const surfaces = [];
    for (let parent = node; parent; parent = parent.parentElement) {
        surfaces.unshift(getComputedStyle(parent).backgroundColor);
    }
    for (const color of surfaces) {
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
    }
    const background = context.getImageData(0, 0, 1, 1);
    const luminance = pixel => [...pixel].slice(0, 3).map(channel => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
    const backgroundLuminance = luminance(background.data);
    return [getComputedStyle(node).color, getComputedStyle(node, '::placeholder').color].map(color => {
        context.putImageData(background, 0, 0);
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        const foregroundLuminance = luminance(context.getImageData(0, 0, 1, 1).data);
        return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
            / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
    });
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 375, height: 812 }]) {
    for (const theme of ['Libadwaita', 'Libadwaita Light']) {
        test(`prompt field matches character fields in ${theme} at ${viewport.width}px`, async ({ page }) => {
            await page.setViewportSize(viewport);
            await testSetup.awaitST({ page });
            await page.evaluate(theme => $('#themes').val(theme).trigger('change'), theme);
            const reference = await page.locator('#description_textarea').evaluate(fieldAppearance);
            await page.evaluate(() => window.SillyBunnyShell.openTab('left', 'editor'));
            await page.locator('button[data-sb-settings-tab="editor"]').click();
            const row = page.locator('.sb-prompt-row[data-prompt-id="main"]');
            await expect(row).toBeVisible();
            await row.locator('.sb-prompt-row-name').click();
            const field = page.locator('#sb-prompt-form_prompt');
            await expect(field).toBeVisible();
            await expect(page.locator('.sb-prompt-detail')).not.toHaveClass(/sb-list-editor__detail--travelling/);
            await field.evaluate(node => node.blur());
            await expect.poll(() => field.evaluate(fieldAppearance)).toEqual(reference);
            const contrast = await field.evaluate(fieldContrast);
            expect(contrast[0]).toBeGreaterThanOrEqual(4.5);
            expect(contrast[1]).toBeGreaterThanOrEqual(4.5);
            const bounds = await field.boundingBox();
            expect(bounds.width).toBeGreaterThan(200);
            expect(bounds.height).toBeGreaterThan(44);
            expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
            await field.focus();
            await expect(field).toBeFocused();
            await expect.poll(async () => (await field.evaluate(fieldAppearance)).shadow).not.toBe('none');
            expect((await field.evaluate(fieldAppearance)).background).toBe(reference.background);
        });
    }
}
