import {
    captureVisibleMessageAnchor,
    restoreVisibleMessageAnchor,
    settleVisibleMessageAnchor,
} from './anchor.js';
import {
    resolveChatBottomScrollAction,
    shouldApplyChatBottomScrollAction,
} from './bottom-scroll.js';
import {
    createFrameWriteScheduler,
    runSettledFrames,
} from './scheduler.js';
import {
    CHAT_SCROLL_ACTION,
    CHAT_SCROLL_INTENT,
    resolveChatScrollAction,
} from './scroll-intent.js';
import {
    CHAT_RENDER_LIFECYCLE_ROLLOUT_KEY,
    CHAT_RENDER_LIFECYCLE_ROUTE,
    CHAT_RENDER_LIFECYCLE_ROUTE_DEFAULTS,
    resolveChatRenderLifecycleRollout,
} from './rollout-guard.js';
import {
    renderMessagesInBatches,
} from './render-batch.js';
import {
    CHAT_RENDER_WINDOW_DEFAULT,
    CHAT_RENDER_WINDOW_MAX,
    CHAT_RENDER_WINDOW_AGGRESSIVE_DEFAULT,
    getChatHistoryPageSize,
    getChatRenderWindowStartIndex,
    normalizeChatRenderWindowSize,
} from './render-window.js';
import {
    createStreamWriteBuffer,
} from './stream-buffer.js';
import {
    createMessageUpdateQueue,
} from './update-queue.js';
import {
    createDelegatedResizeObserver,
} from './resize-observer.js';
import {
    createMobileViewportObserver,
    MOBILE_VIEWPORT_SETTLE_DELAY_MS,
} from './mobile-viewport.js';

export {
    CHAT_RENDER_LIFECYCLE_ROLLOUT_KEY,
    CHAT_RENDER_LIFECYCLE_ROUTE,
    CHAT_RENDER_LIFECYCLE_ROUTE_DEFAULTS,
    CHAT_RENDER_WINDOW_DEFAULT,
    CHAT_RENDER_WINDOW_MAX,
    CHAT_RENDER_WINDOW_AGGRESSIVE_DEFAULT,
    CHAT_SCROLL_ACTION,
    CHAT_SCROLL_INTENT,
    captureVisibleMessageAnchor,
    createMessageUpdateQueue,
    createDelegatedResizeObserver,
    createFrameWriteScheduler,
    createMobileViewportObserver,
    createStreamWriteBuffer,
    getChatHistoryPageSize,
    getChatRenderWindowStartIndex,
    MOBILE_VIEWPORT_SETTLE_DELAY_MS,
    normalizeChatRenderWindowSize,
    resolveChatBottomScrollAction,
    resolveChatScrollAction,
    restoreVisibleMessageAnchor,
    renderMessagesInBatches,
    resolveChatRenderLifecycleRollout,
    runSettledFrames,
    settleVisibleMessageAnchor,
    shouldApplyChatBottomScrollAction,
};

/**
 * Creates the compatibility-facing chat render lifecycle seam.
 * Runtime call sites should depend on this shape instead of individual modules.
 */
export function createChatRenderLifecycle() {
    return {
        anchor: {
            capture: captureVisibleMessageAnchor,
            restore: restoreVisibleMessageAnchor,
            settle: settleVisibleMessageAnchor,
        },
        scheduler: {
            createFrameWriteScheduler,
            runSettledFrames,
        },
        bottomScroll: {
            resolve: resolveChatBottomScrollAction,
            shouldApply: shouldApplyChatBottomScrollAction,
        },
        scrollIntent: {
            action: CHAT_SCROLL_ACTION,
            intent: CHAT_SCROLL_INTENT,
            resolve: resolveChatScrollAction,
        },
        rollout: {
            key: CHAT_RENDER_LIFECYCLE_ROLLOUT_KEY,
            route: CHAT_RENDER_LIFECYCLE_ROUTE,
            routeDefaults: CHAT_RENDER_LIFECYCLE_ROUTE_DEFAULTS,
            resolve: resolveChatRenderLifecycleRollout,
        },
        renderBatch: {
            render: renderMessagesInBatches,
        },
        renderWindow: {
            defaultSize: CHAT_RENDER_WINDOW_DEFAULT,
            maxSize: CHAT_RENDER_WINDOW_MAX,
            getPageSize: getChatHistoryPageSize,
            getStartIndex: getChatRenderWindowStartIndex,
            normalizeSize: normalizeChatRenderWindowSize,
        },
        streamBuffer: {
            create: createStreamWriteBuffer,
        },
        updateQueue: {
            create: createMessageUpdateQueue,
        },
        resizeObserver: {
            create: createDelegatedResizeObserver,
        },
        mobileViewport: {
            create: createMobileViewportObserver,
            settleDelayMs: MOBILE_VIEWPORT_SETTLE_DELAY_MS,
        },
    };
}
