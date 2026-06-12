import { describe, expect, test } from '@jest/globals';

import {
    CHAT_SCROLL_ACTION,
    CHAT_SCROLL_INTENT,
    CHAT_SCROLL_STATE,
    resolveChatScrollStateTransition,
} from '../public/scripts/chat-render-lifecycle/scroll-state.js';

describe('chat render lifecycle scroll state machine', () => {
    test('initial load enters pinned-bottom with a forced bottom action', () => {
        expect(resolveChatScrollStateTransition({
            state: CHAT_SCROLL_STATE.USER_READING,
            intent: CHAT_SCROLL_INTENT.INITIAL_LOAD,
            autoScrollEnabled: false,
        })).toEqual({
            state: CHAT_SCROLL_STATE.PINNED_BOTTOM,
            action: {
                action: CHAT_SCROLL_ACTION.PIN_BOTTOM,
                force: true,
                reason: CHAT_SCROLL_INTENT.INITIAL_LOAD,
            },
        });
    });

    test('tail append stays pinned only when the viewport was already near bottom', () => {
        expect(resolveChatScrollStateTransition({
            state: CHAT_SCROLL_STATE.USER_READING,
            intent: CHAT_SCROLL_INTENT.TAIL_APPEND,
            autoScrollEnabled: true,
            isNearBottom: true,
        })).toEqual({
            state: CHAT_SCROLL_STATE.PINNED_BOTTOM,
            action: {
                action: CHAT_SCROLL_ACTION.PIN_BOTTOM,
                reason: CHAT_SCROLL_INTENT.TAIL_APPEND,
            },
        });

        expect(resolveChatScrollStateTransition({
            state: CHAT_SCROLL_STATE.PINNED_BOTTOM,
            intent: CHAT_SCROLL_INTENT.TAIL_APPEND,
            autoScrollEnabled: true,
            isNearBottom: false,
        })).toEqual({
            state: CHAT_SCROLL_STATE.USER_READING,
            action: {
                action: CHAT_SCROLL_ACTION.NONE,
                reason: 'tail-append-not-pinned',
            },
        });
    });

    test('stream progress follows generation only while auto-scroll is allowed', () => {
        expect(resolveChatScrollStateTransition({
            state: CHAT_SCROLL_STATE.PINNED_BOTTOM,
            intent: CHAT_SCROLL_INTENT.STREAM_PROGRESS,
            autoScrollEnabled: true,
            isNearBottom: true,
            isManualScrollSuppressed: false,
        })).toEqual({
            state: CHAT_SCROLL_STATE.STREAMING_FOLLOW,
            action: {
                action: CHAT_SCROLL_ACTION.PIN_BOTTOM,
                reason: CHAT_SCROLL_INTENT.STREAM_PROGRESS,
            },
        });

        expect(resolveChatScrollStateTransition({
            state: CHAT_SCROLL_STATE.STREAMING_FOLLOW,
            intent: CHAT_SCROLL_INTENT.STREAM_PROGRESS,
            autoScrollEnabled: true,
            isNearBottom: true,
            isManualScrollSuppressed: true,
        })).toEqual({
            state: CHAT_SCROLL_STATE.USER_READING,
            action: {
                action: CHAT_SCROLL_ACTION.NONE,
                reason: 'stream-progress-not-pinned',
            },
        });
    });

    test('history prepend and scrolled-up replacements preserve anchors when available', () => {
        expect(resolveChatScrollStateTransition({
            state: CHAT_SCROLL_STATE.USER_READING,
            intent: CHAT_SCROLL_INTENT.HISTORY_PREPEND,
            hasAnchor: true,
        })).toEqual({
            state: CHAT_SCROLL_STATE.ANCHORED_HISTORY,
            action: {
                action: CHAT_SCROLL_ACTION.PRESERVE_ANCHOR,
                reason: CHAT_SCROLL_INTENT.HISTORY_PREPEND,
            },
        });

        expect(resolveChatScrollStateTransition({
            state: CHAT_SCROLL_STATE.STREAMING_FOLLOW,
            intent: CHAT_SCROLL_INTENT.REPLACE_MESSAGE,
            autoScrollEnabled: true,
            isNearBottom: false,
            hasAnchor: true,
        })).toEqual({
            state: CHAT_SCROLL_STATE.ANCHORED_HISTORY,
            action: {
                action: CHAT_SCROLL_ACTION.PRESERVE_ANCHOR,
                reason: CHAT_SCROLL_INTENT.REPLACE_MESSAGE,
            },
        });
    });

    test('replace-message transitions keep regenerated streams in the right lane', () => {
        expect(resolveChatScrollStateTransition({
            state: CHAT_SCROLL_STATE.STREAMING_FOLLOW,
            intent: CHAT_SCROLL_INTENT.REPLACE_MESSAGE,
            autoScrollEnabled: true,
            isNearBottom: false,
            hasAnchor: true,
            isManualScrollSuppressed: true,
        })).toEqual({
            state: CHAT_SCROLL_STATE.ANCHORED_HISTORY,
            action: {
                action: CHAT_SCROLL_ACTION.PRESERVE_ANCHOR,
                reason: CHAT_SCROLL_INTENT.REPLACE_MESSAGE,
            },
        });

        expect(resolveChatScrollStateTransition({
            state: CHAT_SCROLL_STATE.USER_READING,
            intent: CHAT_SCROLL_INTENT.REPLACE_MESSAGE,
            autoScrollEnabled: true,
            isNearBottom: true,
            hasAnchor: false,
            isManualScrollSuppressed: false,
        })).toEqual({
            state: CHAT_SCROLL_STATE.PINNED_BOTTOM,
            action: {
                action: CHAT_SCROLL_ACTION.PIN_BOTTOM,
                reason: CHAT_SCROLL_INTENT.REPLACE_MESSAGE,
            },
        });
    });

    test('media-resize transitions preserve scrolled-up anchors and restore bottom pins', () => {
        expect(resolveChatScrollStateTransition({
            state: CHAT_SCROLL_STATE.USER_READING,
            intent: CHAT_SCROLL_INTENT.MEDIA_RESIZE,
            autoScrollEnabled: true,
            isNearBottom: false,
            hasAnchor: true,
        })).toEqual({
            state: CHAT_SCROLL_STATE.ANCHORED_HISTORY,
            action: {
                action: CHAT_SCROLL_ACTION.PRESERVE_ANCHOR,
                reason: CHAT_SCROLL_INTENT.MEDIA_RESIZE,
            },
        });

        expect(resolveChatScrollStateTransition({
            state: CHAT_SCROLL_STATE.ANCHORED_HISTORY,
            intent: CHAT_SCROLL_INTENT.MEDIA_RESIZE,
            autoScrollEnabled: true,
            isNearBottom: true,
            hasAnchor: false,
            isManualScrollSuppressed: false,
        })).toEqual({
            state: CHAT_SCROLL_STATE.PINNED_BOTTOM,
            action: {
                action: CHAT_SCROLL_ACTION.PIN_BOTTOM,
                reason: CHAT_SCROLL_INTENT.MEDIA_RESIZE,
            },
        });
    });

    test('unknown intents keep the normalized current state and fail closed', () => {
        expect(resolveChatScrollStateTransition({
            state: 'unexpected-state',
            intent: 'unknown-intent',
            autoScrollEnabled: true,
            isNearBottom: true,
        })).toEqual({
            state: CHAT_SCROLL_STATE.PINNED_BOTTOM,
            action: {
                action: CHAT_SCROLL_ACTION.NONE,
                reason: 'unknown-intent',
            },
        });
    });
});
