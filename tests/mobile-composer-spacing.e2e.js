/* global document, getComputedStyle */
import { expect, test } from '@playwright/test';
import { openQuietChatForSmoke, waitForAnimationFrames } from './chat-scroll-regression-helpers.js';

const IPHONE_USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

function getComposerSpacing(page) {
    return page.evaluate(() => {
        const composer = document.getElementById('nonQRFormItems');
        const textarea = document.getElementById('send_textarea');
        const form = document.getElementById('send_form');
        const textareaRect = textarea?.getBoundingClientRect();
        const getVisibleControlRects = id => Array.from(document.getElementById(id)?.children ?? [])
            .map(element => element.getBoundingClientRect())
            .filter(rect => rect.width > 0 && rect.height > 0);
        const leftControlRects = getVisibleControlRects('leftSendForm');
        const rightControlRects = getVisibleControlRects('rightSendForm');

        if (!composer || !form || !textareaRect || leftControlRects.length === 0 || rightControlRects.length === 0) {
            return null;
        }

        return {
            columnGap: Number.parseFloat(getComputedStyle(composer).columnGap),
            leftClearance: textareaRect.left - Math.max(...leftControlRects.map(rect => rect.right)),
            rightClearance: Math.min(...rightControlRects.map(rect => rect.left)) - textareaRect.right,
            textareaWidth: textareaRect.width,
            textareaBorderRadius: getComputedStyle(textarea).borderRadius,
            formOutlineStyle: getComputedStyle(form).outlineStyle,
        };
    });
}

test.describe('mobile composer spacing at 320x568', () => {
    test.use({
        viewport: { width: 320, height: 568 },
        isMobile: true,
        hasTouch: true,
        userAgent: IPHONE_USER_AGENT,
    });

    test('normal and compact modes keep the action rails clear of the textarea', async ({ page }) => {
        await openQuietChatForSmoke(page, { selectCharacter: false });

        await page.evaluate(() => {
            document.documentElement.style.setProperty('--sb-bottom-bar-scale', '1.5');
            document.getElementById('send_but')?.classList.remove('displayNone');
        });

        for (const compactMode of ['false', 'true']) {
            await page.evaluate(mode => document.documentElement.setAttribute('data-sb-compact-mode', mode), compactMode);
            await page.locator('#send_textarea').focus();
            await waitForAnimationFrames(page, 2);

            const spacing = await getComposerSpacing(page);

            expect(spacing).not.toBeNull();
            expect(spacing.columnGap).toBeGreaterThanOrEqual(8);
            expect(spacing.leftClearance).toBeGreaterThanOrEqual(6);
            expect(spacing.rightClearance).toBeGreaterThanOrEqual(6);
            expect(spacing.textareaWidth).toBeGreaterThanOrEqual(100);
            expect(spacing.textareaBorderRadius).toBe('0px');
            expect(spacing.formOutlineStyle).toBe('none');
        }
    });
});
