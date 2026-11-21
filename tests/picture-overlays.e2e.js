import { expect, test } from '@playwright/test';
import { openQuietChatForSmoke } from './chat-scroll-regression-helpers.js';
import { protectMaintainerServer } from './helpers/maintainer-server.js';
import { AVATAR_IMAGE } from './helpers/surfaces/need-kit.js';

/* eslint-disable playwright/no-conditional-in-test, playwright/no-conditional-expect -- The pointer type and the width decide which layout a check expects. */

test.describe.configure({ timeout: 180_000 });

const SIZES = [
    { width: 360, height: 294 },
    { width: 844, height: 390 },
    { width: 390, height: 844 },
    { width: 360, height: 640 },
    { width: 1440, height: 900 },
];
const EDGE = 0.75;

async function boot(page, viewport) {
    await protectMaintainerServer(page);
    await page.setViewportSize(viewport);
    await openQuietChatForSmoke(page);
}

async function openZoomedAvatar(page) {
    await page.locator('#chat .mes[is_user="false"] .avatar').first().click();
    await page.locator('.zoomed_avatar[forChar]').first().waitFor({ state: 'visible' });
    await page.waitForFunction(() => {
        const zoomed = document.querySelector('.zoomed_avatar[forChar]');
        const image = zoomed?.querySelector('img');
        return Boolean(image?.complete && image.naturalWidth > 0) && getComputedStyle(zoomed).opacity === '1';
    });
    // The pointer rests on the top-left corner, over the top bar and away from the picture, so that nothing hovers.
    await page.mouse.move(1, 1);
    // The click that opened the picture left the pointer over it, and the magnifier eases the picture back for 300ms once the pointer is gone.
    await expect.poll(() => page.evaluate(() => {
        const zoomed = document.querySelector('.zoomed_avatar[forChar]');
        const box = zoomed.querySelector('.zoomed_avatar_container').getBoundingClientRect();
        const image = zoomed.querySelector('img').getBoundingClientRect();
        return image.left >= box.left - 0.5 && image.right <= box.right + 0.5;
    })).toBe(true);
}

/** The boxes of the zoomed avatar, its Close control and the top bar, and what a pointer at the middle of Close would press. */
function measureZoomedAvatar(page) {
    return page.evaluate(() => {
        const box = (element) => {
            const { left, top, right, bottom } = element.getBoundingClientRect();
            return { left, top, right, bottom };
        };
        const zoomed = document.querySelector('.zoomed_avatar[forChar]');
        const close = zoomed.querySelector('.dragClose');
        const container = zoomed.querySelector('.zoomed_avatar_container');
        const image = zoomed.querySelector('img');
        const closeBox = box(close);
        const middle = [(closeBox.left + closeBox.right) / 2, (closeBox.top + closeBox.bottom) / 2];
        const hit = document.elementFromPoint(...middle);
        return {
            viewport: { width: innerWidth, height: innerHeight },
            topBar: box(document.getElementById('top-bar')),
            zoomed: box(zoomed),
            container: box(container),
            image: box(image),
            close: closeBox,
            closeOpacity: getComputedStyle(zoomed.querySelector('.panelControlBar')).opacity,
            hitIsClose: Boolean(hit?.closest('.dragClose')),
        };
    });
}

function expectInside(inner, outer, label) {
    expect(inner.left, `${label}: left edge`).toBeGreaterThanOrEqual(outer.left - EDGE);
    expect(inner.top, `${label}: top edge`).toBeGreaterThanOrEqual(outer.top - EDGE);
    expect(inner.right, `${label}: right edge`).toBeLessThanOrEqual(outer.right + EDGE);
    expect(inner.bottom, `${label}: bottom edge`).toBeLessThanOrEqual(outer.bottom + EDGE);
}

for (const pointer of ['fine', 'coarse']) {
    test.describe(`zoomed avatar, ${pointer} pointer`, () => {
        test.use(pointer === 'coarse' ? { hasTouch: true, isMobile: true } : {});

        for (const size of SIZES.filter(({ width }) => pointer === 'fine' || width <= 1024)) {
            test(`fits the window below the top bar, with its Close control on show and reachable at ${size.width}x${size.height}`, async ({ page }) => {
                await boot(page, size);
                await openZoomedAvatar(page);
                const m = await measureZoomedAvatar(page);
                const area = { left: 0, top: m.topBar.bottom, right: m.viewport.width, bottom: m.viewport.height };

                expectInside(m.zoomed, area, 'the avatar lies in the free area under the top bar');
                expectInside(m.close, m.zoomed, 'Close lies inside the avatar');
                expectInside(m.container, m.zoomed, 'the picture box lies inside the avatar');
                expectInside(m.image, m.container, 'the picture fits its box');
                expect(m.hitIsClose, 'a press at the middle of Close reaches it, and not the top bar or the composer').toBe(true);
                // Up to 1024px the picture is the page, so its Close control is never left to a hover; a wide window with a mouse reveals it on hover.
                if (size.width <= 1024 || pointer === 'coarse') {
                    expect(m.closeOpacity).toBe('1');
                } else {
                    await page.locator('.zoomed_avatar[forChar]').hover();
                    await expect.poll(() => page.locator('.zoomed_avatar[forChar] .panelControlBar').evaluate(bar => getComputedStyle(bar).opacity)).toBe('1');
                }
                const closeSize = m.close.bottom - m.close.top;
                expect(closeSize, 'Close meets the target floor of its pointer').toBeGreaterThanOrEqual(pointer === 'coarse' ? 32 : 24);
            });
        }
    });
}

test.describe('Close controls of the moving windows', () => {
    test('the zoomed avatar Close is a named button that Enter, Space and Escape operate', async ({ page }) => {
        await boot(page, { width: 390, height: 844 });
        const zoomed = page.locator('.zoomed_avatar[forChar]');
        const close = zoomed.locator('.dragClose');

        await openZoomedAvatar(page);
        await expect(close).toHaveAttribute('role', 'button');
        await expect(close).toHaveAttribute('tabindex', '0');
        await expect(close).toHaveAccessibleName('Close');
        await expect(close).toHaveAttribute('title', 'Close');

        await close.focus();
        await expect(close).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(zoomed).toHaveCount(0);

        await openZoomedAvatar(page);
        await close.focus();
        await page.keyboard.press('Space');
        await expect(zoomed).toHaveCount(0);

        await openZoomedAvatar(page);
        await page.evaluate(() => document.activeElement?.blur());
        await page.keyboard.press('Escape');
        await expect(zoomed).toHaveCount(0);
    });

    test('the zoomed avatar shows Close while it has focus, on a pointer that hovers', async ({ page }) => {
        await boot(page, { width: 1440, height: 900 });
        await openZoomedAvatar(page);
        const bar = page.locator('.zoomed_avatar[forChar] .panelControlBar');
        await expect(bar).toHaveCSS('opacity', '0');
        await page.locator('.zoomed_avatar[forChar] .dragClose').focus();
        await expect(bar).toHaveCSS('opacity', '1');
    });

    test('the gallery Close is a named button that Enter, Space and Escape operate', async ({ page }) => {
        await page.route('**/api/images/list', route => route.fulfill({ json: ['picture-overlays-1.png', 'picture-overlays-2.png'] }));
        await page.route('**/user/images/**', route => route.fulfill({ contentType: 'image/png', body: AVATAR_IMAGE }));
        await boot(page, { width: 390, height: 844 });
        const gallery = page.locator('#gallery');
        const close = gallery.locator('.dragClose');
        const openGallery = async () => {
            await page.evaluate(() => document.getElementById('show_gallery_wand_button').click());
            await gallery.locator('.nGY2GThumbnail').first().waitFor({ state: 'visible' });
            await page.mouse.move(1, 1);
        };

        await openGallery();
        await expect(close).toHaveAttribute('role', 'button');
        await expect(close).toHaveAttribute('tabindex', '0');
        await expect(close).toHaveAccessibleName('Close');

        await close.focus();
        await page.keyboard.press('Enter');
        await expect(gallery).toHaveCount(0);

        await openGallery();
        await close.focus();
        await page.keyboard.press('Space');
        await expect(gallery).toHaveCount(0);

        await openGallery();
        await page.evaluate(() => document.activeElement?.blur());
        await page.keyboard.press('Escape');
        await expect(gallery).toHaveCount(0);
    });

    test('the gallery Close keeps the target floor', async ({ page }) => {
        await page.route('**/api/images/list', route => route.fulfill({ json: ['picture-overlays-1.png'] }));
        await page.route('**/user/images/**', route => route.fulfill({ contentType: 'image/png', body: AVATAR_IMAGE }));
        await boot(page, { width: 1440, height: 900 });
        await page.evaluate(() => document.getElementById('show_gallery_wand_button').click());
        await page.locator('#gallery .nGY2GThumbnail').first().waitFor({ state: 'visible' });
        const box = await page.locator('#gallery .dragClose').boundingBox();
        expect(box.height).toBeGreaterThanOrEqual(32);
        expect(box.width).toBeGreaterThanOrEqual(32);
    });

    test('the summary popout Close is a named button that Enter and Space operate, at the target floor', async ({ page }) => {
        await boot(page, { width: 1440, height: 900 });
        const root = page.locator('#summaryExtensionPopout');
        const close = page.locator('#summaryExtensionPopoutClose');
        const openPopout = async () => {
            await page.evaluate(() => document.getElementById('summaryExtensionPopoutButton').click());
            await expect(root).toBeVisible();
            await expect(root).toHaveCSS('opacity', '1');
        };

        await openPopout();
        await expect(close).toHaveAttribute('role', 'button');
        await expect(close).toHaveAttribute('tabindex', '0');
        await expect(close).toHaveAccessibleName('Close');
        const box = await close.boundingBox();
        expect(box.height).toBeGreaterThanOrEqual(32);

        await close.focus();
        await page.keyboard.press('Enter');
        await expect(root).toHaveCount(0);

        await openPopout();
        await close.focus();
        await page.keyboard.press('Space');
        await expect(root).toHaveCount(0);
    });
});

const CROP_TEXT = 'Set the crop position of the avatar image';

async function openCrop(page) {
    await page.evaluate(async ([text]) => {
        const { callGenericPopup, POPUP_TYPE } = await import('/scripts/popup.js');
        window.cropResult = 'pending';
        void callGenericPopup(text, POPUP_TYPE.CROP, '', { cropAspect: 1, cropImage: '/img/ai4.png' }).then((value) => { window.cropResult = value; });
    }, [CROP_TEXT]);
    const dialog = page.locator('dialog.popup[open]:not([closing])');
    await dialog.locator('.cropper-crop-box').waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector('dialog[open][opening]'));
    return dialog;
}

/** Opens an enlarged message picture the way a click on it does: the chat's own handler builds the popup. */
async function openImageZoom(page) {
    await page.evaluate(() => {
        const { chat } = window.SillyTavern.getContext();
        chat[0].extra = { ...chat[0].extra, media: [{ type: 'image', url: '/img/ai4.png' }] };
        const holder = document.createElement('div');
        holder.className = 'mes_media_container';
        holder.dataset.index = '0';
        holder.innerHTML = '<img class="mes_img" src="/img/ai4.png" alt="">';
        document.querySelector('#chat .mes[mesid="0"] .mes_text').append(holder);
    });
    await page.locator('#chat .mes[mesid="0"] .mes_img').evaluate(image => image.click());
    const dialog = page.locator('dialog.popup[open]:not([closing])');
    await dialog.locator('.img_enlarged').waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector('dialog[open][opening]') && document.querySelector('.img_enlarged')?.complete);
    return dialog;
}

async function swipeDown(page, handle, distance) {
    const box = await handle.boundingBox();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let step = 1; step <= 8; step++) {
        await page.mouse.move(x, y + (distance * step) / 8);
    }
    await page.mouse.up();
}

test.describe('Crop and image zoom under the overlay breakpoint', () => {
    test.describe('on a phone', () => {
        test.use({ hasTouch: true, isMobile: true });

        test('the crop is a bottom sheet with Cancel and Crop in its header, and keeps its results', async ({ page }) => {
            await boot(page, { width: 390, height: 844 });
            const dialog = await openCrop(page);
            await expect(dialog).toHaveClass(/\bsb-dialog\b/);
            await expect(dialog).toHaveAttribute('data-presentation', 'sheet');
            await expect(dialog.locator('.sb-dialog__handle')).toBeVisible();

            const rect = await dialog.evaluate((element) => {
                const { left, right, bottom, top } = element.getBoundingClientRect();
                return { left, right, bottom, top, width: innerWidth, height: innerHeight };
            });
            expect(rect.left).toBeCloseTo(0, 0);
            expect(rect.right).toBeCloseTo(rect.width, 0);
            expect(rect.bottom).toBeCloseTo(rect.height, 0);

            const cancel = dialog.locator('.sb-dialog__header .popup-button-cancel');
            const crop = dialog.locator('.sb-dialog__header .popup-button-ok');
            await expect(cancel).toHaveText('Cancel');
            await expect(crop).toHaveText('Crop');
            const [cancelBox, cropBox] = await Promise.all([cancel.boundingBox(), crop.boundingBox()]);
            expect(cancelBox.x, 'Cancel at the header start, the affirmative response at its end').toBeLessThan(cropBox.x);
            expect(cropBox.height).toBeGreaterThanOrEqual(44);
            await expect(dialog.locator('.cropper-container')).toBeVisible();
            const wrap = await dialog.locator('.popup-crop-wrap').evaluate(element => element.getBoundingClientRect().bottom <= innerHeight);
            expect(wrap, 'the cropper lies inside the window').toBe(true);

            await crop.tap();
            await expect.poll(() => page.evaluate(() => window.cropResult)).toMatch(/^data:image\/png;base64,/);
            await expect(page.locator('dialog.popup[open]')).toHaveCount(0);

            const again = await openCrop(page);
            await again.locator('.sb-dialog__header .popup-button-cancel').tap();
            await expect.poll(() => page.evaluate(() => window.cropResult)).toBeNull();
        });

        test('a swipe down from the handle, and Escape, close the crop with the cancelled result; a short swipe springs back', async ({ page }) => {
            await boot(page, { width: 390, height: 844 });
            let dialog = await openCrop(page);
            await swipeDown(page, dialog.locator('.sb-dialog__handle'), 30);
            await expect(dialog).toBeVisible();
            await expect.poll(() => page.evaluate(() => window.cropResult)).toBe('pending');

            await swipeDown(page, dialog.locator('.sb-dialog__handle'), 500);
            await expect(page.locator('dialog.popup[open]')).toHaveCount(0);
            await expect.poll(() => page.evaluate(() => window.cropResult)).toBeNull();

            dialog = await openCrop(page);
            await page.keyboard.press('Escape');
            await expect(page.locator('dialog.popup[open]')).toHaveCount(0);
            await expect.poll(() => page.evaluate(() => window.cropResult)).toBeNull();
        });

        test('the enlarged picture is a sheet with a handle and Close, and a swipe down closes it', async ({ page }) => {
            await boot(page, { width: 390, height: 844 });
            const dialog = await openImageZoom(page);
            await expect(dialog).toHaveClass(/\bsb-dialog\b/);
            await expect(dialog).toHaveAttribute('data-presentation', 'sheet');
            await expect(dialog.locator('.sb-dialog__handle')).toBeVisible();
            await expect(dialog.locator('.sb-dialog__close')).toBeVisible();

            const geometry = await dialog.evaluate((element) => {
                const { left, right, bottom } = element.getBoundingClientRect();
                const image = element.querySelector('.img_enlarged').getBoundingClientRect();
                return { left, right, bottom, width: innerWidth, height: innerHeight, image: { left: image.left, right: image.right, bottom: image.bottom, top: image.top } };
            });
            expect(geometry.left).toBeCloseTo(0, 0);
            expect(geometry.right).toBeCloseTo(geometry.width, 0);
            expect(geometry.bottom).toBeCloseTo(geometry.height, 0);
            expect(geometry.image.left).toBeGreaterThanOrEqual(0);
            expect(geometry.image.right).toBeLessThanOrEqual(geometry.width + 0.5);
            expect(geometry.image.bottom).toBeLessThanOrEqual(geometry.height + 0.5);

            await swipeDown(page, dialog.locator('.sb-dialog__handle'), 30);
            await expect(dialog).toBeVisible();
            await swipeDown(page, dialog.locator('.sb-dialog__handle'), 600);
            await expect(page.locator('dialog.popup[open]')).toHaveCount(0);
        });

        test('Close closes the enlarged picture, and a press on the picture still zooms it', async ({ page }) => {
            await boot(page, { width: 390, height: 844 });
            const dialog = await openImageZoom(page);
            await dialog.locator('.img_enlarged').tap();
            await expect(dialog.locator('.img_enlarged')).toHaveClass(/\bzoomed\b/);
            await expect(dialog).toBeVisible();
            await dialog.locator('.sb-dialog__close').tap();
            await expect(page.locator('dialog.popup[open]')).toHaveCount(0);
        });
    });

    test.describe('on a wide window', () => {
        test('both keep their own floating frame', async ({ page }) => {
            await boot(page, { width: 1440, height: 900 });
            const crop = await openCrop(page);
            await expect(crop).not.toHaveClass(/\bsb-dialog\b/);
            await expect(crop.locator('.popup-controls .popup-button-ok')).toHaveText('Crop');
            await crop.locator('.popup-button-ok').click();
            await expect.poll(() => page.evaluate(() => window.cropResult)).toMatch(/^data:image\/png;base64,/);

            const zoom = await openImageZoom(page);
            await expect(zoom).not.toHaveClass(/\bsb-dialog\b/);
            await zoom.click({ position: { x: 4, y: 4 } });
            await expect(page.locator('dialog.popup[open]')).toHaveCount(0);
        });
    });
});
