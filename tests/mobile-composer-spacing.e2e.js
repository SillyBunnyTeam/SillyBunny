/* global document, getComputedStyle, HTMLElement */
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
            composerBorderRadius: getComputedStyle(composer).borderRadius,
            composerBorderTopWidth: getComputedStyle(composer).borderTopWidth,
            composerBorderColor: getComputedStyle(composer).borderColor,
            composerBackgroundImage: getComputedStyle(composer).backgroundImage,
            textareaBorderRadius: getComputedStyle(textarea).borderRadius,
            textareaBackgroundColor: getComputedStyle(textarea).backgroundColor,
            textareaBoxShadow: getComputedStyle(textarea).boxShadow,
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
            await page.evaluate(mode => {
                document.documentElement.setAttribute('data-sb-compact-mode', mode);
                document.getElementById('send_form')?.classList.remove('sb-generating-controls');
                if (document.activeElement instanceof HTMLElement) {
                    document.activeElement.blur();
                }
            }, compactMode);
            await waitForAnimationFrames(page, 2);

            const defaultState = await getComposerSpacing(page);

            expect(defaultState).not.toBeNull();
            expect(Number.parseFloat(defaultState.composerBorderRadius)).toBeGreaterThan(0);
            expect(Number.parseFloat(defaultState.composerBorderTopWidth)).toBeGreaterThan(0);
            expect(defaultState.composerBackgroundImage).not.toBe('none');
            expect(Number.parseFloat(defaultState.textareaBorderRadius)).toBeGreaterThan(0);
            expect(defaultState.textareaBackgroundColor).not.toBe('rgba(0, 0, 0, 0)');

            await page.locator('#send_textarea').focus();
            await waitForAnimationFrames(page, 2);

            const focusState = await getComposerSpacing(page);

            expect(focusState).not.toBeNull();
            expect(focusState.columnGap).toBeGreaterThanOrEqual(8);
            expect(focusState.leftClearance).toBeGreaterThanOrEqual(6);
            expect(focusState.rightClearance).toBeGreaterThanOrEqual(6);
            expect(focusState.textareaWidth).toBeGreaterThanOrEqual(100);
            expect(focusState.formOutlineStyle).toBe('none');
            expect(focusState.composerBorderColor).not.toBe(defaultState.composerBorderColor);
            expect(focusState.composerBackgroundImage).not.toBe(defaultState.composerBackgroundImage);
            expect(focusState.textareaBackgroundColor).not.toBe(defaultState.textareaBackgroundColor);
            expect(focusState.textareaBoxShadow).not.toBe(defaultState.textareaBoxShadow);

            await page.evaluate(() => {
                if (document.activeElement instanceof HTMLElement) {
                    document.activeElement.blur();
                }
                document.getElementById('send_form')?.classList.add('sb-generating-controls');
            });
            await waitForAnimationFrames(page, 2);

            const generatingState = await getComposerSpacing(page);

            expect(generatingState).not.toBeNull();
            expect(generatingState.composerBorderColor).not.toBe(defaultState.composerBorderColor);
            expect(generatingState.composerBackgroundImage).not.toBe(defaultState.composerBackgroundImage);
        }
    });
});
