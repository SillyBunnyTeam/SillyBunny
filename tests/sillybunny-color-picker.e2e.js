import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const publicRoot = path.resolve(fileURLToPath(new URL('../public/', import.meta.url)));
test.use({ reducedMotion: 'reduce' });

async function mountPicker(page, { accent = false, fallback = false } = {}) {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    if (fallback) {
        await page.addInitScript(() => { HTMLElement.prototype.showPopover = undefined; });
    }
    await page.route('http://colors.test/**', route => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname === '/') {
            return route.fulfill({
                contentType: 'text/html',
                body: `<!doctype html><html><head>
                    <meta name="viewport" content="width=device-width, initial-scale=1">
                    <link rel="stylesheet" href="/style.css">
                    <link rel="stylesheet" href="/css/sillybunny-theme.css">
                    <link rel="stylesheet" href="/css/sillybunny-tabs.css">
                    <link rel="stylesheet" href="/css/sillybunny-color-picker.css">
                    <style>body { margin: 0; padding: 16px; }
                        #sb-settings-page { display: block; position: static; width: 100%; padding: 0; }
                        .sb-settings-mounted-shell { width: 100%; }</style>
                    </head><body><main id="sb-settings-page">
                    <div class="sb-settings-mounted-shell">
                    <div id="${accent ? 'sb-accent-custom-controls' : 'color-picker-block'}">
                    <div class="ds-pref-group"><div class="ds-row">
                    <div class="ds-row-text"><span class="ds-row-label">${accent ? 'Primary Accent' : 'Main Text'}</span></div>
                    <div class="ds-row-suffix"><toolcool-color-picker
                        id="${accent ? 'sb-accent-primary-picker' : 'main-text-color-picker'}"
                        color="rgba(53, 132, 228, 0.5)"
                        aria-label="${accent ? 'Primary Accent' : 'Main Text'}"></toolcool-color-picker>
                    </div></div></div></div></div></main>
                    <script src="/lib/toolcool-color-picker.js"></script>
                    </body></html>`,
            });
        }
        const filePath = path.resolve(publicRoot, `.${pathname}`);
        if (!filePath.startsWith(`${publicRoot}${path.sep}`)) {
            return route.abort();
        }
        return route.fulfill({
            body: readFileSync(filePath),
            contentType: pathname.endsWith('.css') ? 'text/css' : 'text/javascript',
        });
    });
    await page.goto('http://colors.test/');
    await page.evaluate(() => customElements.whenDefined('toolcool-color-picker'));
    await page.evaluate(async () => {
        const { initializeColorPickers } = await import('/scripts/sillybunny-color-picker.js');
        await initializeColorPickers();
    });
}

async function expectUnclippedPicker(page) {
    const surface = page.locator('.sb-color-picker-menu, toolcool-color-picker-popup .popup');
    await expect(surface).toBeVisible();
    const geometry = await surface.evaluate(element => {
        const rect = element.getBoundingClientRect();
        const points = [
            [rect.left + rect.width / 2, rect.top + 4],
            [rect.left + 4, rect.top + rect.height / 2],
            [rect.right - 4, rect.top + rect.height / 2],
            [rect.left + rect.width / 2, rect.bottom - 4],
        ];
        const visible = points.every(([x, y]) => {
            let hit = document.elementFromPoint(x, y);
            while (hit?.shadowRoot) {
                const child = hit.shadowRoot.elementFromPoint(x, y);
                if (!child || child === hit) break;
                hit = child;
            }
            while (hit) {
                if (hit === element) return true;
                hit = hit.parentElement ?? hit.getRootNode().host;
            }
            return false;
        });
        return {
            left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
            width: window.innerWidth, height: window.innerHeight, visible,
        };
    });
    expect(geometry.left).toBeGreaterThanOrEqual(0);
    expect(geometry.top).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(geometry.width);
    expect(geometry.bottom).toBeLessThanOrEqual(geometry.height);
    expect(geometry.visible).toBe(true);
}

for (const width of [1440, 768, 390, 320]) {
    test.describe(`Colour picker at ${width}px`, () => {
        test.use({ viewport: { width, height: 800 } });

        for (const accent of [false, true]) {
            test(`${accent ? 'accent' : 'theme'} menu is visible outside its settings card`, async ({ page }, testInfo) => {
                await mountPicker(page, { accent });
                await page.locator('toolcool-color-picker .button').click();
                await expect(page.locator('.sb-color-picker-menu')).toBeVisible();
                await expectUnclippedPicker(page);
                expect(await page.locator('.ds-pref-group').evaluate(card => getComputedStyle(card).overflow)).toBe('hidden');
                await page.screenshot({ path: testInfo.outputPath('colour-menu.png') });
            });
        }
    });
}

test('keeps the complete RGB/RGBA event contract and rejects incomplete edits', async ({ page }) => {
    await mountPicker(page);
    await page.locator('toolcool-color-picker').evaluate(picker => {
        window.pickerEvents = [];
        picker.addEventListener('change', event => window.pickerEvents.push(event.detail));
    });
    await page.locator('toolcool-color-picker .button').click();
    expect(await page.evaluate(() => window.pickerEvents.length)).toBe(0);
    const hex = page.locator('input[data-color-field="hex"]');
    await hex.fill('12x');
    await expect(hex).toHaveAttribute('aria-invalid', 'true');
    expect(await page.evaluate(() => window.pickerEvents.length)).toBe(0);
    await hex.fill('#ff0000');
    expect(await page.evaluate(() => {
        const event = window.pickerEvents.at(-1);
        return { rgb: event.rgb, rgba: event.rgba, formats: Object.keys(event) };
    })).toEqual({
        rgb: 'rgba(255, 0, 0, 0.5)', rgba: 'rgba(255, 0, 0, 0.5)',
        formats: ['hex', 'hex8', 'rgb', 'rgba', 'hsl', 'hsla', 'hsv', 'hsva', 'color'],
    });
    await page.locator('input[data-color-field="r"]').fill('256');
    await expect(page.locator('input[data-color-field="r"]')).toHaveAttribute('aria-invalid', 'true');
    expect(await page.locator('toolcool-color-picker').evaluate(picker => picker.rgba)).toBe('rgba(255, 0, 0, 0.5)');
    await page.locator('input[data-color-field="a"]').fill('0');
    expect(await page.locator('toolcool-color-picker').evaluate(picker => picker.rgba)).toBe('rgba(255, 0, 0, 0)');
});

test('supports keyboard opening, plane controls, Escape and focus return', async ({ page }) => {
    await mountPicker(page);
    const button = page.locator('toolcool-color-picker .button');
    await button.focus();
    await button.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Main Text' })).toBeVisible();
    await expect(page.locator('input[data-color-field="hex"]')).toBeFocused();
    const saturation = page.getByRole('slider', { name: 'Saturation' });
    await saturation.focus();
    const initial = Number(await saturation.inputValue());
    await saturation.press('ArrowLeft');
    expect(Number(await saturation.inputValue())).toBeLessThan(initial);
    await saturation.press('Escape');
    await expect(page.locator('.sb-color-picker-menu')).toHaveCount(0);
    await expect(button).toBeFocused();
    await expect(button).toHaveAttribute('aria-expanded', 'false');
});

test('retains a chosen hue when moving from white back into the colour field', async ({ page }) => {
    await mountPicker(page);
    await page.locator('toolcool-color-picker').evaluate(picker => { picker.color = '#ffffff'; });
    await page.locator('toolcool-color-picker .button').click();
    await page.getByRole('slider', { name: 'Hue', exact: true }).fill('120');
    await page.getByRole('slider', { name: 'Saturation', exact: true }).fill('100');
    expect(await page.locator('toolcool-color-picker').evaluate(picker => picker.rgb)).toBe('rgb(0, 255, 0)');
});

test('supports dragging the colour field and reopening after a programmatic theme change', async ({ page }) => {
    await mountPicker(page);
    await page.locator('toolcool-color-picker .button').click();
    const rect = await page.locator('.sb-color-picker-plane').boundingBox();
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await page.mouse.down();
    await page.mouse.move(rect.x + rect.width, rect.y);
    await page.mouse.up();
    const hsv = await page.locator('toolcool-color-picker').evaluate(picker => picker.color.toHsv());
    expect(hsv.s).toBe(1);
    expect(hsv.v).toBe(1);
    expect(hsv.a).toBe(0.5);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.locator('toolcool-color-picker').evaluate(picker => { picker.color = 'rgba(10, 20, 30, 0.25)'; });
    await page.locator('toolcool-color-picker .button').click();
    await expect(page.locator('input[data-color-field="hex"]')).toHaveValue('#0A141E');
    await expect(page.locator('input[data-color-field="a"]')).toHaveValue('0.25');
});

for (const fallback of [false, true]) {
    test(`keeps the ${fallback ? 'fallback' : 'native'} popover interactive above an upstream modal`, async ({ page }) => {
        await mountPicker(page, { fallback });
        await page.locator('.ds-pref-group').evaluate(card => {
            const dialog = document.createElement('dialog');
            dialog.style.cssText = 'width:80vw;height:70vh;';
            document.body.append(dialog);
            dialog.append(card);
            dialog.showModal();
        });
        await page.locator('toolcool-color-picker .button').click();
        await expectUnclippedPicker(page);
        await expect(page.locator('dialog > .sb-color-picker-menu')).toBeVisible();
        const hex = page.locator('input[data-color-field="hex"]');
        await hex.fill('#123456');
        await expect(hex).toBeFocused();
        expect(await page.locator('toolcool-color-picker').evaluate(picker => picker.rgba)).toBe('rgba(18, 52, 86, 0.5)');
        await page.getByRole('button', { name: 'Close', exact: true }).click();
        await expect(page.locator('dialog')).toHaveAttribute('open', '');
    });
}

test('retains opacity across sequential hex typing and commits intentional shorthand alpha', async ({ page }) => {
    await mountPicker(page);
    await page.locator('toolcool-color-picker .button').click();
    const hex = page.locator('input[data-color-field="hex"]');
    await hex.fill('');
    await hex.pressSequentially('#123456');
    expect(await page.locator('toolcool-color-picker').evaluate(picker => picker.rgba)).toBe('rgba(18, 52, 86, 0.5)');
    await hex.fill('#1230');
    await hex.press('Enter');
    expect(await page.locator('toolcool-color-picker').evaluate(picker => picker.rgba)).toBe('rgba(17, 34, 51, 0)');
    await hex.fill('#abcdef');
    expect(await page.locator('toolcool-color-picker').evaluate(picker => picker.rgba)).toBe('rgba(171, 205, 239, 0)');
});

test('enhances dynamic extension pickers after insertion and reparenting', async ({ page }) => {
    await mountPicker(page);
    await page.evaluate(() => {
        const picker = document.createElement('toolcool-color-picker');
        picker.id = 'extension-picker';
        picker.setAttribute('color', 'rgba(20, 40, 60, 0.75)');
        document.querySelector('.ds-pref-group').append(picker);
    });
    const button = page.locator('#extension-picker .button');
    await expect(button).toHaveAttribute('aria-haspopup', 'dialog');
    await page.locator('#extension-picker').evaluate(picker => document.body.append(picker));
    await expect(button).toHaveAttribute('aria-haspopup', 'dialog');
    await button.click();
    await expect(page.locator('input[data-color-field="a"]')).toHaveValue('0.75');
    await page.locator('#extension-picker').evaluate(picker => picker.remove());
    await expect(page.locator('.sb-color-picker-menu')).toHaveCount(0);
});

test('keeps mobile controls reachable on short screens and traps focus in its sheet', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 400 });
    await mountPicker(page);
    await page.locator('toolcool-color-picker .button').click();
    await expectUnclippedPicker(page);
    await expect(page.locator(':focus')).toBeInViewport();
    const alpha = page.locator('input[data-color-field="a"]');
    await alpha.fill('0.4');
    await expect(alpha).toBeInViewport();
    await alpha.press('Tab');
    await expect(page.getByRole('button', { name: 'Close', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('.sb-color-picker-sheet')).toHaveCount(0);
});

test('clamps the fallback desktop menu near the bottom-right corner', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 500 });
    await mountPicker(page, { fallback: true });
    await page.locator('.ds-pref-group').evaluate(card => {
        card.style.cssText = 'position:fixed;right:0;bottom:0;width:300px;';
    });
    await page.locator('toolcool-color-picker .button').click();
    await expectUnclippedPicker(page);
    await page.mouse.click(20, 20);
    await expect(page.locator('.sb-color-picker-menu')).toHaveCount(0);
});

test('keeps the focused field visible when the mobile viewport contracts', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mountPicker(page);
    await page.locator('toolcool-color-picker .button').click();
    const alpha = page.locator('input[data-color-field="a"]');
    await alpha.focus();
    await page.setViewportSize({ width: 390, height: 400 });
    await expect(alpha).toBeInViewport();
    await expectUnclippedPicker(page);
    expect(await alpha.evaluate(input => {
        const field = input.getBoundingClientRect();
        const body = input.closest('.sb-color-picker-body').getBoundingClientRect();
        return field.top >= body.top && field.bottom <= body.bottom;
    })).toBe(true);
});

test('finishes sheet motion without clipping and respects reduced motion', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mountPicker(page);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.locator('toolcool-color-picker .button').click();
    await page.locator('.sb-color-picker-sheet').evaluate(async sheet => {
        await Promise.all(sheet.getAnimations().map(animation => animation.finished));
    });
    await expectUnclippedPicker(page);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.locator('toolcool-color-picker .button').click();
    expect(await page.locator('.sb-color-picker-sheet').evaluate(sheet => sheet.getAnimations().length)).toBe(0);
});

test.describe('Touch colour controls', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    test('selects a colour with touch and provides a 44px close target', async ({ page }) => {
        await mountPicker(page);
        await page.locator('toolcool-color-picker .button').tap();
        const plane = await page.locator('.sb-color-picker-plane').boundingBox();
        await page.touchscreen.tap(plane.x + plane.width / 2, plane.y + plane.height / 2);
        const hsv = await page.locator('toolcool-color-picker').evaluate(picker => picker.color.toHsv());
        expect(hsv.s).toBeCloseTo(0.5, 1);
        expect(hsv.v).toBeCloseTo(0.5, 1);
        expect(hsv.a).toBe(0.5);
        const close = page.getByRole('button', { name: 'Close', exact: true });
        const target = await close.boundingBox();
        expect(target.width).toBeGreaterThanOrEqual(44);
        expect(target.height).toBeGreaterThanOrEqual(44);
        await close.tap();
        await expect(page.locator('.sb-color-picker-sheet')).toHaveCount(0);
    });
});

test('does not overwrite an external source change when an untouched Hex field loses focus', async ({ page }) => {
    await mountPicker(page);
    await page.locator('toolcool-color-picker .button').click();
    await page.locator('toolcool-color-picker').evaluate(picker => { picker.color = 'rgba(10, 20, 30, 0.25)'; });
    await expect(page.locator('input[data-color-field="hex"]')).toHaveValue('#0A141E');
    await page.getByRole('slider', { name: 'Hue', exact: true }).focus();
    expect(await page.locator('toolcool-color-picker').evaluate(picker => picker.rgba)).toBe('rgba(10, 20, 30, 0.25)');
});

test('updates the active trigger when its picker is reparented', async ({ page }) => {
    await mountPicker(page);
    await page.locator('toolcool-color-picker .button').click();
    await page.locator('toolcool-color-picker').evaluate(picker => document.body.append(picker));
    const button = page.locator('toolcool-color-picker .button');
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await expect(button).toBeFocused();
});

test('commits valid shorthand on outside dismissal and discards pending shorthand on Escape', async ({ page }) => {
    await mountPicker(page);
    await page.locator('toolcool-color-picker .button').click();
    const hex = page.locator('input[data-color-field="hex"]');
    await hex.fill('#abc');
    await page.mouse.click(20, 20);
    expect(await page.locator('toolcool-color-picker').evaluate(picker => picker.rgba)).toBe('rgba(170, 187, 204, 0.5)');
    await page.locator('toolcool-color-picker .button').click();
    await hex.fill('#1230');
    await hex.press('Escape');
    expect(await page.locator('toolcool-color-picker').evaluate(picker => picker.rgba)).toBe('rgba(170, 187, 204, 0.5)');
});

test('toggles the menu closed when clicking its swatch again', async ({ page }) => {
    await mountPicker(page);
    const button = page.locator('toolcool-color-picker .button');
    for (let index = 0; index < 3; index++) {
        await button.click();
        await expect(page.locator('.sb-color-picker-menu')).toBeVisible();
        await button.click();
        await expect(page.locator('.sb-color-picker-menu')).toHaveCount(0);
        await expect(button).toHaveAttribute('aria-expanded', 'false');
    }
});
