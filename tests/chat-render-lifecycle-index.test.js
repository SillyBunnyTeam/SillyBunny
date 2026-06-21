import { describe, expect, test } from '@jest/globals';

import {
    CHAT_SCROLL_ACTION,
    CHAT_SCROLL_INTENT,
    CHAT_RENDER_LIFECYCLE_ROLLOUT_KEY,
    CHAT_RENDER_LIFECYCLE_ROUTE,
    CHAT_RENDER_LIFECYCLE_ROUTE_DEFAULTS,
    CHAT_RENDER_WINDOW_DEFAULT,
    CHAT_RENDER_WINDOW_MAX,
    captureVisibleMessageAnchor,
    createChatRenderLifecycle,
    createDelegatedResizeObserver,
    createMessageUpdateQueue,
    createFrameWriteScheduler,
    createMobileViewportObserver,
    createStreamWriteBuffer,
    getChatHistoryPageSize,
    getChatRenderWindowStartIndex,
    MOBILE_VIEWPORT_SETTLE_DELAY_MS,
    normalizeChatRenderWindowSize,
    resolveChatBottomScrollAction,
    resolveChatRenderLifecycleRollout,
    resolveChatScrollAction,
    renderMessagesInBatches,
    restoreVisibleMessageAnchor,
    runSettledFrames,
    settleVisibleMessageAnchor,
    shouldApplyChatBottomScrollAction,
} from '../public/scripts/chat-render-lifecycle/index.js';

describe('chat render lifecycle index seam', () => {
    test('re-exports lifecycle helper modules through one stable seam', () => {
        expect(typeof captureVisibleMessageAnchor).toBe('function');
        expect(typeof restoreVisibleMessageAnchor).toBe('function');
        expect(typeof settleVisibleMessageAnchor).toBe('function');
        expect(typeof createFrameWriteScheduler).toBe('function');
        expect(typeof runSettledFrames).toBe('function');
        expect(typeof resolveChatBottomScrollAction).toBe('function');
        expect(typeof shouldApplyChatBottomScrollAction).toBe('function');
        expect(typeof resolveChatScrollAction).toBe('function');
        expect(typeof resolveChatRenderLifecycleRollout).toBe('function');
        expect(typeof renderMessagesInBatches).toBe('function');
        expect(typeof normalizeChatRenderWindowSize).toBe('function');
        expect(typeof getChatRenderWindowStartIndex).toBe('function');
        expect(typeof getChatHistoryPageSize).toBe('function');
        expect(typeof createMessageUpdateQueue).toBe('function');
        expect(typeof createStreamWriteBuffer).toBe('function');
        expect(typeof createDelegatedResizeObserver).toBe('function');
        expect(typeof createMobileViewportObserver).toBe('function');
        expect(CHAT_SCROLL_INTENT.TAIL_APPEND).toBe('tail-append');
        expect(CHAT_SCROLL_ACTION.PIN_BOTTOM).toBe('pin-bottom');
        expect(CHAT_RENDER_LIFECYCLE_ROLLOUT_KEY).toBe('sillybunny.chatRenderLifecycle.enabled');
        expect(CHAT_RENDER_WINDOW_DEFAULT).toBe(100);
        expect(CHAT_RENDER_WINDOW_MAX).toBe(200);
        expect(CHAT_RENDER_LIFECYCLE_ROUTE.INITIAL_LOAD).toBe('initial-load');
        expect(CHAT_RENDER_LIFECYCLE_ROUTE_DEFAULTS[CHAT_RENDER_LIFECYCLE_ROUTE.BOTTOM_SCROLL]).toBe(true);
        expect(CHAT_RENDER_LIFECYCLE_ROUTE_DEFAULTS[CHAT_RENDER_LIFECYCLE_ROUTE.INITIAL_LOAD]).toBe(true);
        expect(CHAT_RENDER_LIFECYCLE_ROUTE_DEFAULTS[CHAT_RENDER_LIFECYCLE_ROUTE.MEDIA_RESIZE]).toBe(true);
        expect(CHAT_RENDER_LIFECYCLE_ROUTE_DEFAULTS[CHAT_RENDER_LIFECYCLE_ROUTE.MESSAGE_UPDATE]).toBe(true);
        expect(CHAT_RENDER_LIFECYCLE_ROUTE_DEFAULTS[CHAT_RENDER_LIFECYCLE_ROUTE.MOBILE_VIEWPORT]).toBe(true);
        expect(CHAT_RENDER_LIFECYCLE_ROUTE_DEFAULTS[CHAT_RENDER_LIFECYCLE_ROUTE.REDISPLAY_BATCH]).toBe(true);
        expect(CHAT_RENDER_LIFECYCLE_ROUTE_DEFAULTS[CHAT_RENDER_LIFECYCLE_ROUTE.REPLACE_MESSAGE]).toBe(true);
        expect(CHAT_RENDER_LIFECYCLE_ROUTE_DEFAULTS[CHAT_RENDER_LIFECYCLE_ROUTE.SHOW_MORE_BATCH]).toBe(true);
        expect(CHAT_RENDER_LIFECYCLE_ROUTE_DEFAULTS[CHAT_RENDER_LIFECYCLE_ROUTE.STREAM_PROGRESS]).toBe(true);
        expect(CHAT_RENDER_LIFECYCLE_ROUTE_DEFAULTS[CHAT_RENDER_LIFECYCLE_ROUTE.STREAM_START]).toBe(true);
        expect(MOBILE_VIEWPORT_SETTLE_DELAY_MS).toBe(180);
    });

    test('creates a pass-through lifecycle adapter without mutating runtime behavior', () => {
        const lifecycle = createChatRenderLifecycle();

        expect(lifecycle.anchor.capture).toBe(captureVisibleMessageAnchor);
        expect(lifecycle.anchor.restore).toBe(restoreVisibleMessageAnchor);
        expect(lifecycle.anchor.settle).toBe(settleVisibleMessageAnchor);
        expect(lifecycle.scheduler.createFrameWriteScheduler).toBe(createFrameWriteScheduler);
        expect(lifecycle.scheduler.runSettledFrames).toBe(runSettledFrames);
        expect(lifecycle.bottomScroll.resolve).toBe(resolveChatBottomScrollAction);
        expect(lifecycle.bottomScroll.shouldApply).toBe(shouldApplyChatBottomScrollAction);
        expect(lifecycle.scrollIntent.resolve).toBe(resolveChatScrollAction);
        expect(lifecycle.scrollIntent.intent).toBe(CHAT_SCROLL_INTENT);
        expect(lifecycle.scrollIntent.action).toBe(CHAT_SCROLL_ACTION);
        expect(lifecycle.rollout.key).toBe(CHAT_RENDER_LIFECYCLE_ROLLOUT_KEY);
        expect(lifecycle.rollout.route).toBe(CHAT_RENDER_LIFECYCLE_ROUTE);
        expect(lifecycle.rollout.routeDefaults).toBe(CHAT_RENDER_LIFECYCLE_ROUTE_DEFAULTS);
        expect(lifecycle.rollout.resolve).toBe(resolveChatRenderLifecycleRollout);
        expect(lifecycle.renderBatch.render).toBe(renderMessagesInBatches);
        expect(lifecycle.renderWindow.defaultSize).toBe(CHAT_RENDER_WINDOW_DEFAULT);
        expect(lifecycle.renderWindow.maxSize).toBe(CHAT_RENDER_WINDOW_MAX);
        expect(lifecycle.renderWindow.normalizeSize).toBe(normalizeChatRenderWindowSize);
        expect(lifecycle.renderWindow.getStartIndex).toBe(getChatRenderWindowStartIndex);
        expect(lifecycle.renderWindow.getPageSize).toBe(getChatHistoryPageSize);
        expect(lifecycle.streamBuffer.create).toBe(createStreamWriteBuffer);
        expect(lifecycle.updateQueue.create).toBe(createMessageUpdateQueue);
        expect(lifecycle.resizeObserver.create).toBe(createDelegatedResizeObserver);
        expect(lifecycle.mobileViewport.create).toBe(createMobileViewportObserver);
        expect(lifecycle.mobileViewport.settleDelayMs).toBe(MOBILE_VIEWPORT_SETTLE_DELAY_MS);
    });
});
