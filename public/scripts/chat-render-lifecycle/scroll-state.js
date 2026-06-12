import {
    CHAT_SCROLL_ACTION,
    CHAT_SCROLL_INTENT,
    resolveChatScrollAction,
} from './scroll-intent.js';

export {
    CHAT_SCROLL_ACTION,
    CHAT_SCROLL_INTENT,
} from './scroll-intent.js';

export const CHAT_SCROLL_STATE = Object.freeze({
    PINNED_BOTTOM: 'pinned-bottom',
    USER_READING: 'user-reading',
    STREAMING_FOLLOW: 'streaming-follow',
    ANCHORED_HISTORY: 'anchored-history',
});

const CHAT_SCROLL_STATES = new Set(Object.values(CHAT_SCROLL_STATE));

function normalizeScrollState(state) {
    return CHAT_SCROLL_STATES.has(state) ? state : CHAT_SCROLL_STATE.PINNED_BOTTOM;
}

function resolveNextScrollState({
    currentState,
    intent,
    action,
    autoScrollEnabled,
    isNearBottom,
    isManualScrollSuppressed,
}) {
    if (action.action === CHAT_SCROLL_ACTION.PIN_BOTTOM) {
        return intent === CHAT_SCROLL_INTENT.STREAM_PROGRESS
            ? CHAT_SCROLL_STATE.STREAMING_FOLLOW
            : CHAT_SCROLL_STATE.PINNED_BOTTOM;
    }

    if (action.action === CHAT_SCROLL_ACTION.FORCE_EDGE) {
        return action.edge === 'bottom'
            ? CHAT_SCROLL_STATE.PINNED_BOTTOM
            : CHAT_SCROLL_STATE.USER_READING;
    }

    if (action.action === CHAT_SCROLL_ACTION.PRESERVE_ANCHOR) {
        return CHAT_SCROLL_STATE.ANCHORED_HISTORY;
    }

    if (intent === CHAT_SCROLL_INTENT.MANUAL_SCROLL) {
        return CHAT_SCROLL_STATE.USER_READING;
    }

    if (!autoScrollEnabled || isManualScrollSuppressed || !isNearBottom) {
        switch (intent) {
            case CHAT_SCROLL_INTENT.TAIL_APPEND:
            case CHAT_SCROLL_INTENT.STREAM_PROGRESS:
            case CHAT_SCROLL_INTENT.REPLACE_MESSAGE:
            case CHAT_SCROLL_INTENT.MEDIA_RESIZE:
                return CHAT_SCROLL_STATE.USER_READING;
        }
    }

    return currentState;
}

/**
 * Resolves the chat viewport state transition and its existing scroll action.
 * @param {object} [options] Options.
 * @param {string} [options.state] Current chat scroll state.
 * @param {string} options.intent Render lifecycle intent.
 * @param {boolean} [options.autoScrollEnabled=true] User auto-scroll preference.
 * @param {boolean} [options.isNearBottom=false] Whether the viewport is already near bottom.
 * @param {boolean} [options.hasAnchor=false] Whether an anchor is available for restoration.
 * @param {boolean} [options.isManualScrollSuppressed=false] Whether user scroll/touch suppression is active.
 * @param {string} [options.edge='bottom'] Forced scroll edge for explicit jumps.
 * @returns {{state: string, action: {action: string, reason: string, edge?: string, force?: boolean}}}
 */
export function resolveChatScrollStateTransition({
    state,
    intent,
    autoScrollEnabled = true,
    isNearBottom = false,
    hasAnchor = false,
    isManualScrollSuppressed = false,
    edge = 'bottom',
} = {}) {
    const currentState = normalizeScrollState(state);
    const action = resolveChatScrollAction({
        intent,
        autoScrollEnabled,
        isNearBottom,
        hasAnchor,
        isManualScrollSuppressed,
        edge,
    });

    return {
        state: resolveNextScrollState({
            currentState,
            intent,
            action,
            autoScrollEnabled,
            isNearBottom,
            isManualScrollSuppressed,
        }),
        action,
    };
}
