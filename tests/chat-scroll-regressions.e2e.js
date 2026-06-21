/* global document, WheelEvent, window */
import { expect, test } from '@playwright/test';
import {
    getChatScrollSnapshot,
    getRedisplayCompatibilitySnapshot,
    getRenderedMessageIds,
    growMessageBlockAboveViewport,
    installSwipeCandidate,
    installSyntheticLongChat,
    markFirstRenderedMessageEditing,
    markManualMobileScroll,
    openReadyChat,
    scrollMessageNearTop,
    waitForAnimationFrames,
} from './chat-scroll-regression-helpers.js';

test.describe.configure({ mode: 'serial' });

test.describe('issue 167 chat scroll regressions', () => {
    test.beforeEach(async ({ page }) => {
        await openReadyChat(page);
    });

    test('long chat initial render lands near the latest message', async ({ page }) => {
        await installSyntheticLongChat(page, { messageCount: 96, visibleCount: 24 });

        const snapshot = await getChatScrollSnapshot(page);

        expect(snapshot.lastMesId).toBe('95');
        expect(snapshot.lastVisibleMesId).toBe('95');
        expect(snapshot.bottomDelta).toBeLessThanOrEqual(16);
    });

    test('redisplay keeps render follow-up hooks applied after batched render', async ({ page }) => {
        await installSyntheticLongChat(page, { messageCount: 36, visibleCount: 12 });
        await markFirstRenderedMessageEditing(page);
        await page.evaluate(async () => window.SillyTavern.getContext().redisplayChat({ startIndex: 24, fade: false }));

        const snapshot = await getRedisplayCompatibilitySnapshot(page);

        expect(snapshot.renderedMessageIds).toEqual(Array.from({ length: 12 }, (_, index) => String(24 + index)));
        expect(snapshot.lastMessageId).toBe('35');
        expect(snapshot.lastMessageClassCount).toBe(1);
        expect(snapshot.fadeClassCount).toBe(0);
        expect(snapshot.stylePinsCount).toBe(0);
        expect(snapshot.firstEditUpDisabled).toBe(true);
        expect(snapshot.firstEditDownDisabled).toBe(false);
    });

    test('show more preserves the first visible message anchor', async ({ page }) => {
        await installSyntheticLongChat(page, { messageCount: 96, visibleCount: 24 });
        const renderedIds = await getRenderedMessageIds(page);
        const anchorId = renderedIds.at(Math.min(6, renderedIds.length - 1));

        await scrollMessageNearTop(page, anchorId, 32);

        const before = await getChatScrollSnapshot(page);
        await page.evaluate(async () => window.SillyTavern.getContext().showMoreMessages());
        await waitForAnimationFrames(page, 10);
        const after = await getChatScrollSnapshot(page);

        expect(after.firstVisibleMesId).toBe(before.firstVisibleMesId);
        expect(Math.abs(after.firstVisibleOffsetTop - before.firstVisibleOffsetTop)).toBeLessThanOrEqual(3);
    });

    test('swipe replacement keeps the current viewport anchored', async ({ page }) => {
        await installSyntheticLongChat(page, { messageCount: 48, visibleCount: 48 });
        const renderedIds = await getRenderedMessageIds(page);
        const swipeMessageId = Number(renderedIds.at(-1));

        await installSwipeCandidate(page, swipeMessageId);
        await scrollMessageNearTop(page, 32, 20);

        const before = await getChatScrollSnapshot(page);
        await page.evaluate(async (messageId) => {
            const context = window.SillyTavern.getContext();
            await context.swipe.to(null, 'right', {
                source: 'slash_command',
                message: context.chat[messageId],
                forceMesId: messageId,
                forceSwipeId: 1,
                forceDuration: 0,
            });
        }, swipeMessageId);
        await waitForAnimationFrames(page, 6);
        const after = await getChatScrollSnapshot(page);

        expect(after.firstVisibleMesId).toBe(before.firstVisibleMesId);
        expect(Math.abs(after.firstVisibleOffsetTop - before.firstVisibleOffsetTop)).toBeLessThanOrEqual(8);
        await expect(page.locator(`.mes[mesid="${swipeMessageId}"] .mes_text`)).toContainText(`issue 167 replacement swipe ${swipeMessageId}`);
    });

    test('late media resize above the viewport keeps the current message anchored', async ({ page }) => {
        await installSyntheticLongChat(page, { messageCount: 72, visibleCount: 72 });

        await scrollMessageNearTop(page, 48, 24);

        const before = await getChatScrollSnapshot(page);
        await growMessageBlockAboveViewport(page, 12, { height: 460 });
        const after = await getChatScrollSnapshot(page);

        expect(after.firstVisibleMesId).toBe(before.firstVisibleMesId);
        expect(Math.abs(after.firstVisibleOffsetTop - before.firstVisibleOffsetTop)).toBeLessThanOrEqual(8);
        expect(after.scrollTop).toBeGreaterThan(before.scrollTop + 300);
    });

    test('desktop wheel over chat shell scrolls the chat viewport', async ({ page }) => {
        await installSyntheticLongChat(page, { messageCount: 96, visibleCount: 96 });
        await expect.poll(async () => {
            await page.evaluate(() => {
                const chat = document.querySelector('#chat');
                const maxScrollTop = Math.max(0, chat.scrollHeight - chat.clientHeight);

                chat.scrollTop = Math.min(640, Math.max(0, maxScrollTop - 720));
                chat.dispatchEvent(new Event('scroll', { bubbles: true }));
            });
            await waitForAnimationFrames(page, 2);

            return (await getChatScrollSnapshot(page)).bottomDelta;
        }, { timeout: 5000 }).toBeGreaterThan(360);

        const before = await getChatScrollSnapshot(page);
        await page.evaluate(() => {
            const shellTarget = document.querySelector('#form_sheld');
            shellTarget.dispatchEvent(new WheelEvent('wheel', {
                bubbles: true,
                cancelable: true,
                deltaY: 360,
            }));
        });
        await waitForAnimationFrames(page, 2);
        const after = await getChatScrollSnapshot(page);

        expect(after.scrollTop).toBeGreaterThan(before.scrollTop + 100);
    });
});

test.describe('issue 167 mobile chat scroll regressions', () => {
    test.use({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    });

    test.beforeEach(async ({ page }) => {
        await openReadyChat(page);
    });

    test('streaming update does not yank a manually scrolled-up mobile chat', async ({ page }) => {
        await installSyntheticLongChat(page, { messageCount: 80, visibleCount: 80 });
        await scrollMessageNearTop(page, 48, 24);

        const before = await getChatScrollSnapshot(page);
        await markManualMobileScroll(page, before.scrollTop);
        await page.evaluate(() => {
            const context = window.SillyTavern.getContext();
            const lastIndex = context.chat.length - 1;
            const lastMessage = context.chat[lastIndex];

            lastMessage.mes += `\nissue 167 streamed token ${'stream '.repeat(40)}`;
            context.addOneMessage(lastMessage, { type: 'swipe', forceId: lastIndex, scroll: true });
        });
        await waitForAnimationFrames(page, 6);
        const after = await getChatScrollSnapshot(page);

        expect(after.firstVisibleMesId).toBe(before.firstVisibleMesId);
        expect(Math.abs(after.scrollTop - before.scrollTop)).toBeLessThanOrEqual(12);
        expect(after.bottomDelta).toBeGreaterThan(200);
    });
});
