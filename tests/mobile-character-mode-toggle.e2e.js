import { expect, test } from '@playwright/test';
import { openQuietChatForSmoke, waitForAnimationFrames } from './chat-scroll-regression-helpers.js';

const IPHONE_USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const PHONE_VIEWPORTS = [
    { width: 390, height: 844 },
    { width: 360, height: 780 },
];
const TOUCH_TARGET_PX = 44;
const SUBPIXEL_PX = 0.5;

async function waitForPanelAnimations(page) {
    // The reveal animation moves the header 8px down while it runs, so measure after the finite panel animations finish.
    await page.evaluate(async () => {
        const animations = document.getElementById('right-nav-panel').getAnimations({ subtree: true })
            .filter(animation => animation.effect?.getComputedTiming().endTime !== Infinity);
        await Promise.all(animations.map(animation => animation.finished.catch(() => undefined)));
    });
    await waitForAnimationFrames(page, 2);
}

function getHeaderLayout(page) {
    return page.evaluate(() => {
        const box = (element) => {
            const { left, top, right, bottom, width, height } = element.getBoundingClientRect();
            return { left, top, right, bottom, width, height };
        };
        const toggle = document.getElementById('sb_character_mode_toggle');

        return {
            header: box(toggle.closest('.sb-character-shell-header')),
            toggle: box(toggle),
            close: box(document.getElementById('sb_character_shell_close')),
            buttons: [...toggle.querySelectorAll('.sb-character-shell-mode-button')]
                .map(button => ({ mode: button.dataset.sbCharacterMode, ...box(button) })),
        };
    });
}

function overlaps(first, second) {
    return first.left < second.right - SUBPIXEL_PX
        && second.left < first.right - SUBPIXEL_PX
        && first.top < second.bottom - SUBPIXEL_PX
        && second.top < first.bottom - SUBPIXEL_PX;
}

function expectInside(inner, outer, message) {
    expect(inner.left, message).toBeGreaterThanOrEqual(outer.left - SUBPIXEL_PX);
    expect(inner.top, message).toBeGreaterThanOrEqual(outer.top - SUBPIXEL_PX);
    expect(inner.right, message).toBeLessThanOrEqual(outer.right + SUBPIXEL_PX);
    expect(inner.bottom, message).toBeLessThanOrEqual(outer.bottom + SUBPIXEL_PX);
}

function expectTouchTarget(rect, message) {
    expect(rect.width, message).toBeGreaterThanOrEqual(TOUCH_TARGET_PX - SUBPIXEL_PX);
    expect(rect.height, message).toBeGreaterThanOrEqual(TOUCH_TARGET_PX - SUBPIXEL_PX);
}

async function expectToggleRowLayout(page) {
    await waitForPanelAnimations(page);
    const layout = await getHeaderLayout(page);
    const { width, height } = page.viewportSize();
    const viewport = { left: 0, top: 0, right: width, bottom: height };
    const diagnostic = JSON.stringify(layout);

    expect(layout.toggle.width, diagnostic).toBeGreaterThan(0);
    expectInside(layout.toggle, layout.header, `toggle inside the header: ${diagnostic}`);
    expect(overlaps(layout.toggle, layout.close), `toggle clear of the close button: ${diagnostic}`).toBe(false);
    expectTouchTarget(layout.close, `close button touch target: ${diagnostic}`);
    expect(layout.buttons.map(button => button.mode)).toEqual(['roleplay', 'conversation', 'creator']);

    for (const button of layout.buttons) {
        expectInside(button, viewport, `${button.mode} button inside the viewport: ${diagnostic}`);
        expectTouchTarget(button, `${button.mode} button touch target: ${diagnostic}`);
    }
}

for (const phoneViewport of PHONE_VIEWPORTS) {
    test.describe(`character workspace toggle at ${phoneViewport.width}x${phoneViewport.height}`, () => {
        test.use({
            viewport: phoneViewport,
            isMobile: true,
            hasTouch: true,
            userAgent: IPHONE_USER_AGENT,
        });

        test.beforeEach(async ({ page }) => {
            await openQuietChatForSmoke(page);
            await waitForAnimationFrames(page, 3);
        });

        test('the toggle row stays in the header beside the close button on the character list', async ({ page }) => {
            await page.evaluate(() => window.SillyBunnyShell.openTab('characters', 'characters'));
            await expect(page.locator('#right-nav-panel.openDrawer')).toHaveAttribute('data-menu-type', 'characters');
            await expectToggleRowLayout(page);
        });

        test('the toggle row stays in the header beside the close button in the character editor', async ({ page }) => {
            await page.evaluate(() => window.SillyBunnyShell.openTab('characters', 'editor'));
            await expect(page.locator('#right-nav-panel.openDrawer')).toHaveAttribute('data-menu-type', 'character_edit');
            await expectToggleRowLayout(page);
        });
    });
}
