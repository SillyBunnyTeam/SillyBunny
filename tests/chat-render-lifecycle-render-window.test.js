import { describe, expect, test } from '@jest/globals';

import {
    CHAT_RENDER_WINDOW_DEFAULT,
    CHAT_RENDER_WINDOW_MAX,
    getChatHistoryPageSize,
    getChatRenderWindowStartIndex,
    normalizeChatRenderWindowSize,
} from '../public/scripts/chat-render-lifecycle/render-window.js';

describe('chat render lifecycle render window helper', () => {
    test('uses a bounded default when truncation is disabled or invalid', () => {
        expect(CHAT_RENDER_WINDOW_DEFAULT).toBe(100);
        expect(CHAT_RENDER_WINDOW_MAX).toBe(200);
        expect(normalizeChatRenderWindowSize(0)).toBe(CHAT_RENDER_WINDOW_DEFAULT);
        expect(normalizeChatRenderWindowSize(null)).toBe(CHAT_RENDER_WINDOW_DEFAULT);
        expect(normalizeChatRenderWindowSize(Number.NaN)).toBe(CHAT_RENDER_WINDOW_DEFAULT);
        expect(normalizeChatRenderWindowSize(-1)).toBe(CHAT_RENDER_WINDOW_DEFAULT);
    });

    test('floors requested values and clamps large windows to the hard cap', () => {
        expect(normalizeChatRenderWindowSize(24.9)).toBe(24);
        expect(normalizeChatRenderWindowSize(500)).toBe(CHAT_RENDER_WINDOW_MAX);
        expect(normalizeChatRenderWindowSize(Number.MAX_SAFE_INTEGER)).toBe(CHAT_RENDER_WINDOW_MAX);
    });

    test('resolves the initial tail-window start index without rendering everything', () => {
        expect(getChatRenderWindowStartIndex(12, 100)).toBe(0);
        expect(getChatRenderWindowStartIndex(250, 100)).toBe(150);
        expect(getChatRenderWindowStartIndex(250, 0)).toBe(150);
        expect(getChatRenderWindowStartIndex(250, 500)).toBe(50);
    });

    test('keeps one rendered message as a paging anchor when pruning will follow', () => {
        expect(getChatHistoryPageSize(100, { renderedMessageCount: 0, windowSize: 100 })).toBe(100);
        expect(getChatHistoryPageSize(100, { renderedMessageCount: 100, windowSize: 100 })).toBe(99);
        expect(getChatHistoryPageSize(500, { renderedMessageCount: 200, windowSize: 200 })).toBe(199);
    });

    test('can load an exact page for target-reveal callers', () => {
        expect(getChatHistoryPageSize(50, {
            renderedMessageCount: 100,
            windowSize: 100,
            preserveAnchor: false,
        })).toBe(50);
        expect(getChatHistoryPageSize(500, {
            renderedMessageCount: 200,
            windowSize: 200,
            preserveAnchor: false,
        })).toBe(200);
    });
});
