import { runSettledFrames } from './scheduler.js';

const DEFAULT_MESSAGE_SELECTOR = '.mes[mesid]';
const SAFE_ATTRIBUTE_VALUE_PATTERN = /^[A-Za-z0-9_-]+$/;

function canReadElementRect(element) {
    return Boolean(element && typeof element.getBoundingClientRect === 'function');
}

function isCollapsedBoxRect(rect) {
    return rect.top === 0 && rect.bottom === 0 && rect.width === 0 && rect.height === 0;
}

function getMessageElements(scrollElement, messageSelector = DEFAULT_MESSAGE_SELECTOR) {
    if (!scrollElement || typeof scrollElement.querySelectorAll !== 'function') {
        return [];
    }

    return Array.from(scrollElement.querySelectorAll(messageSelector));
}

function findFirstVisibleMessage(messages, scrollRect) {
    let low = 0;
    let high = messages.length - 1;
    let candidate = null;
    let sawCollapsedBox = false;

    while (low <= high) {
        const mid = (low + high) >>> 1;
        const message = messages[mid];
        if (!canReadElementRect(message)) {
            sawCollapsedBox = true;
            break;
        }
        const rect = message.getBoundingClientRect();
        if (isCollapsedBoxRect(rect)) {
            sawCollapsedBox = true;
            break;
        }
        if (rect.bottom > scrollRect.top) {
            candidate = { message, rect };
            high = mid - 1;
        } else {
            low = mid + 1;
        }
    }

    if (!sawCollapsedBox) {
        if (candidate && candidate.rect.top < scrollRect.bottom) {
            return candidate;
        }
        return null;
    }

    // Fall back to a linear scan only when a hidden zero-box node breaks top-to-bottom ordering.
    for (const message of messages) {
        if (!canReadElementRect(message)) {
            continue;
        }
        const rect = message.getBoundingClientRect();
        if (rect.bottom > scrollRect.top && rect.top < scrollRect.bottom) {
            return { message, rect };
        }
    }

    return null;
}

/**
 * Captures the first visible message's viewport-relative offset before DOM mutation.
 * @param {Element} scrollElement Scroll container that owns message elements.
 * @param {object} [options] Options.
 * @param {string} [options.messageSelector] Message selector to anchor against.
 * @param {string} [options.keyAttribute] Attribute that identifies the anchor element.
 * @returns {{messageId: string, offsetTop: number}|null}
 */
export function captureVisibleMessageAnchor(scrollElement, { messageSelector = DEFAULT_MESSAGE_SELECTOR, keyAttribute = 'mesid' } = {}) {
    if (!canReadElementRect(scrollElement)) {
        return null;
    }

    const scrollRect = scrollElement.getBoundingClientRect();
    const messages = getMessageElements(scrollElement, messageSelector);
    if (messages.length === 0) {
        return null;
    }

    const visible = findFirstVisibleMessage(messages, scrollRect);
    const anchorElement = visible?.message ?? null;

    if (!anchorElement || typeof anchorElement.getAttribute !== 'function') {
        return null;
    }

    const messageId = anchorElement.getAttribute(keyAttribute);

    if (!messageId) {
        return null;
    }

    return {
        messageId,
        offsetTop: visible.rect.top - scrollRect.top,
    };
}

/**
 * Restores a previously captured message anchor after DOM mutation.
 * @param {Element & {scrollTop: number}} scrollElement Scroll container that owns message elements.
 * @param {{messageId: string, offsetTop: number}|null} anchor Anchor captured before mutation.
 * @param {object} [options] Options.
 * @param {string} [options.messageSelector] Message selector to anchor against.
 * @param {string} [options.keyAttribute] Attribute that identifies the anchor element.
 */
export function restoreVisibleMessageAnchor(scrollElement, anchor, { messageSelector = DEFAULT_MESSAGE_SELECTOR, keyAttribute = 'mesid' } = {}) {
    if (!canReadElementRect(scrollElement) || !anchor?.messageId || typeof scrollElement.scrollTop !== 'number') {
        return;
    }

    const keyString = String(anchor.messageId);
    let anchorElement = null;
    if (typeof scrollElement.querySelector === 'function' && SAFE_ATTRIBUTE_VALUE_PATTERN.test(keyString) && SAFE_ATTRIBUTE_VALUE_PATTERN.test(keyAttribute)) {
        anchorElement = scrollElement.querySelector(`${messageSelector}[${keyAttribute}="${keyString}"]`);
    }
    if (!anchorElement) {
        anchorElement = getMessageElements(scrollElement, messageSelector)
            .find(message => typeof message.getAttribute === 'function' && message.getAttribute(keyAttribute) === keyString);
    }

    if (!canReadElementRect(anchorElement)) {
        return;
    }

    const scrollRect = scrollElement.getBoundingClientRect();
    const nextOffsetTop = anchorElement.getBoundingClientRect().top - scrollRect.top;
    scrollElement.scrollTop += nextOffsetTop - anchor.offsetTop;
}

/**
 * Re-applies anchor restoration over multiple frames while late layout settles.
 * @param {Element & {scrollTop: number}} scrollElement Scroll container that owns message elements.
 * @param {{messageId: string, offsetTop: number}|null} anchor Anchor captured before mutation.
 * @param {object} [options] Options.
 * @param {number} [options.frames=8] Number of animation frames to settle over.
 * @param {(callback: FrameRequestCallback) => number|void} [options.requestAnimationFrameRef] Frame scheduler.
 * @param {string} [options.messageSelector] Message selector to anchor against.
 * @param {string} [options.keyAttribute] Attribute that identifies the anchor element.
 */
export async function settleVisibleMessageAnchor(scrollElement, anchor, {
    frames = 8,
    requestAnimationFrameRef = globalThis.requestAnimationFrame,
    messageSelector = DEFAULT_MESSAGE_SELECTOR,
    keyAttribute = 'mesid',
} = {}) {
    if (!anchor || typeof requestAnimationFrameRef !== 'function') {
        return;
    }

    await runSettledFrames(() => restoreVisibleMessageAnchor(scrollElement, anchor, { messageSelector, keyAttribute }), {
        frames,
        requestAnimationFrameRef,
    });
}
