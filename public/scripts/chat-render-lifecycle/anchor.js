import { runSettledFrames } from './scheduler.js';

const DEFAULT_MESSAGE_SELECTOR = '.mes[mesid]';

function canReadElementRect(element) {
    return Boolean(element && typeof element.getBoundingClientRect === 'function');
}

function getMessageElements(scrollElement, messageSelector = DEFAULT_MESSAGE_SELECTOR) {
    if (!scrollElement || typeof scrollElement.querySelectorAll !== 'function') {
        return [];
    }

    return Array.from(scrollElement.querySelectorAll(messageSelector));
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
    const anchorElement = getMessageElements(scrollElement, messageSelector).find(message => {
        if (!canReadElementRect(message)) {
            return false;
        }

        const messageRect = message.getBoundingClientRect();
        return messageRect.bottom > scrollRect.top && messageRect.top < scrollRect.bottom;
    });

    if (!anchorElement || typeof anchorElement.getAttribute !== 'function') {
        return null;
    }

    const messageId = anchorElement.getAttribute(keyAttribute);

    if (!messageId) {
        return null;
    }

    return {
        messageId,
        offsetTop: anchorElement.getBoundingClientRect().top - scrollRect.top,
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

    const anchorElement = getMessageElements(scrollElement, messageSelector)
        .find(message => typeof message.getAttribute === 'function' && message.getAttribute(keyAttribute) === String(anchor.messageId));

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
