import { getViewportCoordinator } from '../viewport-coordinator.js';

export const MOBILE_VIEWPORT_SETTLE_DELAY_MS = 180;

function isViewportLike(viewport) {
    return Boolean(viewport
        && typeof viewport.addEventListener === 'function'
        && typeof viewport.removeEventListener === 'function');
}

function assertMobileViewportOptions({
    onViewportChange,
    onViewportSettle,
    setTimeoutRef,
    clearTimeoutRef,
}) {
    if (typeof onViewportChange !== 'function') {
        throw new TypeError('createMobileViewportObserver requires onViewportChange to be a function.');
    }

    if (onViewportSettle !== null && typeof onViewportSettle !== 'function') {
        throw new TypeError('createMobileViewportObserver requires onViewportSettle to be a function when provided.');
    }

    if (typeof setTimeoutRef !== 'function') {
        throw new TypeError('createMobileViewportObserver requires setTimeoutRef to be a function.');
    }

    if (typeof clearTimeoutRef !== 'function') {
        throw new TypeError('createMobileViewportObserver requires clearTimeoutRef to be a function.');
    }
}

/**
 * Creates lifecycle-owned visual viewport listener setup with cancellable settle detection.
 * Runtime calls share the unified ViewportCoordinator so competing visualViewport listeners
 * collapse into one frame; injected custom viewport targets remain directly attached for unit tests.
 * @param {object} options Options.
 * @param {VisualViewport|null} [options.viewport=globalThis.visualViewport] Viewport-like event target.
 * @param {object|null} [options.coordinator=null] Optional ViewportCoordinator instance.
 * @param {(event: Event) => void} options.onViewportChange Immediate viewport movement handler.
 * @param {(event: Event) => void|null} [options.onViewportSettle=null] Settled viewport handler.
 * @param {number} [options.settleDelayMs=MOBILE_VIEWPORT_SETTLE_DELAY_MS] Settle debounce delay.
 * @param {(callback: () => void, delay: number) => number|object} [options.setTimeoutRef=globalThis.setTimeout] Timer function.
 * @param {(handle: number|object) => void} [options.clearTimeoutRef=globalThis.clearTimeout] Timer clear function.
 * @returns {{start: () => boolean, dispose: () => void, isStarted: () => boolean}}
 */
export function createMobileViewportObserver({
    viewport = globalThis.visualViewport ?? null,
    coordinator = null,
    onViewportChange,
    onViewportSettle = null,
    settleDelayMs = MOBILE_VIEWPORT_SETTLE_DELAY_MS,
    setTimeoutRef = globalThis.setTimeout,
    clearTimeoutRef = globalThis.clearTimeout,
} = {}) {
    assertMobileViewportOptions({
        onViewportChange,
        onViewportSettle,
        setTimeoutRef,
        clearTimeoutRef,
    });

    let isStarted = false;
    let settleTimer = null;
    let lastEvent = null;
    let unsubscribeCoordinator = null;

    const usesGlobalViewport = viewport !== null && viewport === globalThis.visualViewport;
    const useCoordinator = Boolean(coordinator && typeof coordinator.subscribe === 'function') || usesGlobalViewport;

    const cancelSettleTimer = () => {
        if (settleTimer === null) {
            return;
        }

        clearTimeoutRef(settleTimer);
        settleTimer = null;
    };

    const scheduleSettle = () => {
        cancelSettleTimer();

        if (typeof onViewportSettle !== 'function') {
            return;
        }

        let timerHandle = null;
        timerHandle = setTimeoutRef(() => {
            if (settleTimer !== timerHandle) {
                return;
            }

            settleTimer = null;
            onViewportSettle(lastEvent);
        }, settleDelayMs);
        settleTimer = timerHandle;
    };

    const handleViewportChange = (event) => {
        lastEvent = event;
        onViewportChange(event);
        scheduleSettle();
    };

    const start = () => {
        if (isStarted) {
            return false;
        }

        if (useCoordinator) {
            if (!coordinator && !isViewportLike(viewport)) {
                return false;
            }

            const activeCoordinator = coordinator ?? getViewportCoordinator();
            unsubscribeCoordinator = activeCoordinator.subscribe((_snapshot, meta) => {
                handleViewportChange(meta?.event ?? { type: 'resize' });
            }, { sources: ['visualViewport'] });
            isStarted = true;
            return true;
        }

        if (!isViewportLike(viewport)) {
            return false;
        }

        viewport.addEventListener('scroll', handleViewportChange, { passive: true });
        viewport.addEventListener('resize', handleViewportChange, { passive: true });
        isStarted = true;
        return true;
    };

    const dispose = () => {
        cancelSettleTimer();

        if (!isStarted) {
            return;
        }

        if (typeof unsubscribeCoordinator === 'function') {
            unsubscribeCoordinator();
            unsubscribeCoordinator = null;
            isStarted = false;
            return;
        }

        if (!isViewportLike(viewport)) {
            isStarted = false;
            return;
        }

        viewport.removeEventListener('scroll', handleViewportChange, { passive: true });
        viewport.removeEventListener('resize', handleViewportChange, { passive: true });
        isStarted = false;
    };

    return {
        start,
        dispose,
        isStarted: () => isStarted,
    };
}
