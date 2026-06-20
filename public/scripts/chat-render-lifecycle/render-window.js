export const CHAT_RENDER_WINDOW_DEFAULT = 100;
export const CHAT_RENDER_WINDOW_MAX = 200;
// SillyBunny: aggressive DOM unloading for low-memory devices (e.g., iPhones crashing on long streams)
export const CHAT_RENDER_WINDOW_AGGRESSIVE_DEFAULT = 5;

/**
 * Keeps chat DOM windows bounded even when older settings used 0 as "render everything".
 * @param {number} requestedSize User-configured or caller-requested window size.
 * @param {object} [options] Options
 * @param {number} [options.defaultSize=CHAT_RENDER_WINDOW_DEFAULT] Fallback for invalid or disabled values.
 * @param {number} [options.maxSize=CHAT_RENDER_WINDOW_MAX] Hard cap for rendered chat messages.
 * @returns {number}
 */
export function normalizeChatRenderWindowSize(requestedSize, {
    defaultSize = CHAT_RENDER_WINDOW_DEFAULT,
    maxSize = CHAT_RENDER_WINDOW_MAX,
} = {}) {
    const normalizedDefault = normalizePositiveInteger(defaultSize, CHAT_RENDER_WINDOW_DEFAULT);
    const normalizedMax = Math.max(1, normalizePositiveInteger(maxSize, CHAT_RENDER_WINDOW_MAX));
    const numericSize = Number(requestedSize);

    if (!Number.isFinite(numericSize) || numericSize <= 0) {
        return Math.min(normalizedDefault, normalizedMax);
    }

    return Math.min(Math.floor(numericSize), normalizedMax);
}

/**
 * Resolves the tail-window start index for initial chat rendering.
 * @param {number} totalMessages Total messages in the chat array.
 * @param {number} requestedSize User-configured or caller-requested window size.
 * @param {object} [options] Normalization options.
 * @returns {number}
 */
export function getChatRenderWindowStartIndex(totalMessages, requestedSize, options = {}) {
    const messageCount = Math.max(0, Math.floor(Number(totalMessages) || 0));
    const windowSize = normalizeChatRenderWindowSize(requestedSize, options);

    return Math.max(0, messageCount - windowSize);
}

/**
 * Leaves one already-rendered message in place while paging so scroll anchors survive pruning.
 * @param {number} requestedSize User-configured or caller-requested page size.
 * @param {object} [options] Options
 * @param {number} [options.renderedMessageCount=0] Number of message elements currently rendered.
 * @param {number} [options.windowSize=CHAT_RENDER_WINDOW_DEFAULT] Current DOM window size.
 * @param {boolean} [options.preserveAnchor=true] Leave one rendered message in place for scroll anchoring.
 * @param {number} [options.anchorRetentionCount=1] Rendered message count through the current scroll anchor.
 * @returns {number}
 */
export function getChatHistoryPageSize(requestedSize, {
    renderedMessageCount = 0,
    windowSize = CHAT_RENDER_WINDOW_DEFAULT,
    preserveAnchor = true,
    anchorRetentionCount = 1,
} = {}) {
    const normalizedWindowSize = normalizeChatRenderWindowSize(windowSize);
    const normalizedRequestedSize = normalizeChatRenderWindowSize(requestedSize, { maxSize: normalizedWindowSize });

    if (preserveAnchor && renderedMessageCount > 0) {
        const normalizedAnchorRetentionCount = Math.max(1, normalizePositiveInteger(anchorRetentionCount, 1));
        return Math.min(normalizedRequestedSize, Math.max(1, normalizedWindowSize - normalizedAnchorRetentionCount));
    }

    return normalizedRequestedSize;
}

function normalizePositiveInteger(value, fallback) {
    const numericValue = Number(value);

    if (!Number.isFinite(numericValue) || numericValue <= 0) {
        return fallback;
    }

    return Math.floor(numericValue);
}
