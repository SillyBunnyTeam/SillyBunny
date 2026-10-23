export const OFFSCREEN_MESSAGE_SIZED_CLASS = 'sb-mes-sized';
export const OFFSCREEN_MESSAGE_WIDTH_SETTLE_MS = 250;

function assertOffscreenMessageTrackerOptions({
    container,
    ResizeObserverImpl,
    setTimeoutRef,
    clearTimeoutRef,
}) {
    if (!container || typeof container.querySelectorAll !== 'function') {
        throw new TypeError('createOffscreenMessageTracker requires a container element.');
    }

    if (typeof ResizeObserverImpl !== 'function') {
        throw new TypeError('createOffscreenMessageTracker requires ResizeObserverImpl to be a constructor.');
    }

    if (typeof setTimeoutRef !== 'function') {
        throw new TypeError('createOffscreenMessageTracker requires setTimeoutRef to be a function.');
    }

    if (typeof clearTimeoutRef !== 'function') {
        throw new TypeError('createOffscreenMessageTracker requires clearTimeoutRef to be a function.');
    }
}

/**
 * Marks chat messages once the browser has laid them out, so CSS can let off-screen history skip
 * rendering while `contain-intrinsic-size: auto` holds each skipped message at its real height.
 * A container width change clears every mark until the width settles, so messages lay out again
 * at the new width instead of keeping heights remembered at the old one.
 * @param {object} options Options.
 * @param {Element} options.container Scroll container that owns the message elements.
 * @param {ResizeObserver} [options.ResizeObserverImpl=globalThis.ResizeObserver] ResizeObserver constructor.
 * @param {string} [options.sizedClass=OFFSCREEN_MESSAGE_SIZED_CLASS] Class added to laid-out messages.
 * @param {string} [options.messageSelector=':scope > .mes'] Selector for tracked messages inside the container.
 * @param {number} [options.widthSettleMs=OFFSCREEN_MESSAGE_WIDTH_SETTLE_MS] Quiet time after a width change before marking again.
 * @param {(callback: () => void, delay: number) => number|object} [options.setTimeoutRef=globalThis.setTimeout] Timer function.
 * @param {(handle: number|object) => void} [options.clearTimeoutRef=globalThis.clearTimeout] Timer clear function.
 * @returns {{track: (message: Element) => boolean, untrack: (message: Element) => void, dispose: () => void}}
 */
export function createOffscreenMessageTracker({
    container,
    ResizeObserverImpl = globalThis.ResizeObserver,
    sizedClass = OFFSCREEN_MESSAGE_SIZED_CLASS,
    messageSelector = ':scope > .mes',
    widthSettleMs = OFFSCREEN_MESSAGE_WIDTH_SETTLE_MS,
    setTimeoutRef = globalThis.setTimeout,
    clearTimeoutRef = globalThis.clearTimeout,
} = {}) {
    assertOffscreenMessageTrackerOptions({
        container,
        ResizeObserverImpl,
        setTimeoutRef,
        clearTimeoutRef,
    });

    let containerWidth = null;
    let settleTimer = null;
    let isDisposed = false;

    const messageObserver = new ResizeObserverImpl(entries => {
        // Marks wait for the width to settle; rearm() observes the messages again afterwards.
        if (settleTimer !== null) {
            return;
        }

        for (const entry of entries) {
            const message = entry.target;

            // Zero height means no layout yet (for example a hidden chat), so there is no real height to remember.
            if (!message?.isConnected || !(Number(entry.contentRect?.height) > 0)) {
                continue;
            }

            message.classList.add(sizedClass);
            messageObserver.unobserve(message);
        }
    });

    const rearm = () => {
        settleTimer = null;

        if (isDisposed) {
            return;
        }

        for (const message of container.querySelectorAll(messageSelector)) {
            if (message.classList.contains(sizedClass)) {
                continue;
            }

            // A fresh observation reports the message again once it has its new-width layout.
            messageObserver.unobserve(message);
            messageObserver.observe(message);
        }
    };

    const clearMarksUntilWidthSettles = () => {
        for (const message of container.querySelectorAll(messageSelector)) {
            if (message.classList.contains(sizedClass)) {
                message.classList.remove(sizedClass);
            }
        }

        if (settleTimer !== null) {
            clearTimeoutRef(settleTimer);
        }

        settleTimer = setTimeoutRef(rearm, widthSettleMs);
    };

    const containerObserver = new ResizeObserverImpl(entries => {
        const width = Number(entries.at(-1)?.contentRect?.width);

        // A hidden chat keeps its marks: remembered heights still fit if it shows again at the same width.
        if (isDisposed || !(width > 0)) {
            return;
        }

        if (containerWidth !== null && Math.abs(width - containerWidth) >= 1) {
            clearMarksUntilWidthSettles();
        }

        containerWidth = width;
    });

    containerObserver.observe(container);

    const track = (message) => {
        if (isDisposed || !message?.classList || message.classList.contains(sizedClass)) {
            return false;
        }

        messageObserver.observe(message);
        return true;
    };

    const untrack = (message) => {
        if (message) {
            messageObserver.unobserve(message);
        }
    };

    const dispose = () => {
        isDisposed = true;

        if (settleTimer !== null) {
            clearTimeoutRef(settleTimer);
            settleTimer = null;
        }

        messageObserver.disconnect();
        containerObserver.disconnect();
    };

    return {
        track,
        untrack,
        dispose,
    };
}
