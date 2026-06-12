import { expect, test } from '@playwright/test';
import { openQuietChatForSmoke } from './chat-scroll-regression-helpers.js';

test.describe('chat scroll state machine', () => {
    test.beforeEach(async ({ page }) => {
        await openQuietChatForSmoke(page, { selectCharacter: false });
    });

    test('browser runtime module resolves manual and streaming-follow transitions', async ({ page }) => {
        const transitions = await page.evaluate(async () => {
            const {
                CHAT_SCROLL_INTENT,
                CHAT_SCROLL_STATE,
                resolveChatScrollStateTransition,
            } = await import('/scripts/chat-render-lifecycle/index.js');

            const userReading = resolveChatScrollStateTransition({
                state: CHAT_SCROLL_STATE.STREAMING_FOLLOW,
                intent: CHAT_SCROLL_INTENT.MANUAL_SCROLL,
            });
            const streamingFollow = resolveChatScrollStateTransition({
                state: userReading.state,
                intent: CHAT_SCROLL_INTENT.STREAM_PROGRESS,
                autoScrollEnabled: true,
                isNearBottom: true,
                isManualScrollSuppressed: false,
            });

            return {
                manualState: userReading.state,
                manualAction: userReading.action.action,
                streamingState: streamingFollow.state,
                streamingAction: streamingFollow.action.action,
            };
        });

        expect(transitions).toEqual({
            manualState: 'user-reading',
            manualAction: 'suppress-auto-scroll',
            streamingState: 'streaming-follow',
            streamingAction: 'pin-bottom',
        });
    });
});
