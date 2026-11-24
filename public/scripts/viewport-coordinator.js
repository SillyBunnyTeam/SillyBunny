/**
 * Unified single-read / single-write requestAnimationFrame viewport coordinator.
 *
 * Coalesces `window.visualViewport` (`resize`, `scroll`) and `window` (`resize`,
 * `orientationchange`) notifications into at most one frame callback, updates
 * `--sb-vv-height` and `--sb-keyboard-inset` only when values move by at least
 * 1px, and fans out the measured snapshot to registered subscribers.
 */

export const VIEWPORT_CSS_DELTA_THRESHOLD_PX = 1;

const PASSIVE_EVENT_OPTIONS = Object.freeze({ passive: true });

function isEventTargetLike(target) {
    return Boolean(
        target
        && typeof target.addEventListener === 'function'
        && typeof target.removeEventListener === 'function',
    );
}

function toFiniteNumber(value, fallback = 0) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
}

/**
 * Performs the single read phase for viewport geometry.
 *
 * @param {object} [options]
 * @param {Window|object|null} [options.win]
 * @param {Document|object|null} [options.doc]
 * @param {VisualViewport|object|null} [options.visualViewport]
 * @returns {{
 *   layoutWidth: number,
 *   layoutHeight: number,
 *   width: number,
 *   height: number,
 *   offsetTop: number,
 *   offsetLeft: number,
 *   scale: number,
 *   keyboardInset: number,
 * }}
 */
export function readViewportSnapshot({
    win = globalThis.window ?? globalThis,
    doc = globalThis.document ?? null,
    visualViewport = undefined,
} = {}) {
    const vv = visualViewport !== undefined ? visualViewport : (win?.visualViewport ?? null);
    const docEl = doc?.documentElement ?? null;

    const layoutWidth = Math.max(0, toFiniteNumber(win?.innerWidth, 0) || toFiniteNumber(docEl?.clientWidth, 0));
    const layoutHeight = Math.max(0, toFiniteNumber(win?.innerHeight, 0) || toFiniteNumber(docEl?.clientHeight, 0));

    const rawVisualWidth = toFiniteNumber(vv?.width, 0);
    const rawVisualHeight = toFiniteNumber(vv?.height, 0);
    const width = rawVisualWidth > 0 ? rawVisualWidth : layoutWidth;
    const height = rawVisualHeight > 0 ? rawVisualHeight : layoutHeight;
    const offsetTop = toFiniteNumber(vv?.offsetTop, 0);
    const offsetLeft = toFiniteNumber(vv?.offsetLeft, 0);
    const rawScale = toFiniteNumber(vv?.scale, 1);
    const scale = rawScale > 0 ? rawScale : 1;
    const keyboardInset = Math.max(0, layoutHeight - height - offsetTop);

    return {
        layoutWidth,
        layoutHeight,
        width,
        height,
        offsetTop,
        offsetLeft,
        scale,
        keyboardInset,
    };
}

/**
 * Creates a standalone ViewportCoordinator instance.
 *
 * @param {object} [options]
 * @param {Window|object|null} [options.win=globalThis.window ?? globalThis]
 * @param {Document|object|null} [options.doc=globalThis.document ?? null]
 * @param {VisualViewport|object|null} [options.visualViewport]
 * @param {(cb: FrameRequestCallback) => number} [options.requestAnimationFrameRef]
 * @param {(id: number) => void} [options.cancelAnimationFrameRef]
 * @param {number} [options.deltaThresholdPx=VIEWPORT_CSS_DELTA_THRESHOLD_PX]
 */
export function createViewportCoordinator({
    win = globalThis.window ?? globalThis,
    doc = globalThis.document ?? null,
    visualViewport = undefined,
    requestAnimationFrameRef = undefined,
    cancelAnimationFrameRef = undefined,
    deltaThresholdPx = VIEWPORT_CSS_DELTA_THRESHOLD_PX,
} = {}) {
    const resolveVisualViewport = () => (visualViewport !== undefined ? visualViewport : (win?.visualViewport ?? null));
    const scheduleFrame = (callback) => {
        if (typeof requestAnimationFrameRef === 'function') {
            return requestAnimationFrameRef(callback);
        }
        if (typeof win?.requestAnimationFrame === 'function') {
            return win.requestAnimationFrame(callback);
        }
        if (typeof globalThis.requestAnimationFrame === 'function') {
            return globalThis.requestAnimationFrame(callback);
        }
        return globalThis.setTimeout(() => callback(Date.now()), 0);
    };
    const cancelFrame = (handle) => {
        if (handle === null || handle === undefined) {
            return;
        }
        if (typeof cancelAnimationFrameRef === 'function') {
            cancelAnimationFrameRef(handle);
            return;
        }
        if (typeof win?.cancelAnimationFrame === 'function') {
            win.cancelAnimationFrame(handle);
            return;
        }
        if (typeof globalThis.cancelAnimationFrame === 'function') {
            globalThis.cancelAnimationFrame(handle);
            return;
        }
        globalThis.clearTimeout(handle);
    };

    const threshold = Math.max(0, toFiniteNumber(deltaThresholdPx, VIEWPORT_CSS_DELTA_THRESHOLD_PX));
    /** @type {Set<{ callback: Function, sources: Set<string>|null }>} */
    const subscribers = new Set();

    let attached = false;
    let attachedVisualViewport = null;
    let rafHandle = null;
    let lastEvent = null;
    let pendingEvents = [];
    let pendingSources = new Set();
    let pendingTypes = new Set();
    let lastSnapshot = null;
    let lastWrittenHeight = null;
    let lastWrittenKeyboardInset = null;

    const writeCssProperties = (snapshot) => {
        const rootStyle = doc?.documentElement?.style;
        let heightWritten = false;
        let keyboardInsetWritten = false;

        if (rootStyle && typeof rootStyle.setProperty === 'function') {
            if (lastWrittenHeight === null || Math.abs(snapshot.height - lastWrittenHeight) >= threshold) {
                rootStyle.setProperty('--sb-vv-height', `${Math.round(snapshot.height)}px`);
                lastWrittenHeight = snapshot.height;
                heightWritten = true;
            }

            if (lastWrittenKeyboardInset === null || Math.abs(snapshot.keyboardInset - lastWrittenKeyboardInset) >= threshold) {
                rootStyle.setProperty('--sb-keyboard-inset', `${Math.round(snapshot.keyboardInset)}px`);
                lastWrittenKeyboardInset = snapshot.keyboardInset;
                keyboardInsetWritten = true;
            }
        }

        return { heightWritten, keyboardInsetWritten };
    };

    const notifySubscribers = (snapshot, meta) => {
        if (subscribers.size === 0) {
            return;
        }

        for (const entry of Array.from(subscribers)) {
            if (entry.sources && meta.sources.size > 0) {
                let matched = false;
                for (const source of meta.sources) {
                    if (entry.sources.has(source)) {
                        matched = true;
                        break;
                    }
                }
                if (!matched) {
                    continue;
                }
            }

            try {
                entry.callback(snapshot, meta);
            } catch (error) {
                console.error('[ViewportCoordinator] Subscriber error:', error);
            }
        }
    };

    const runFrame = ({ forceEvent = null, forceSource = null, forceType = null } = {}) => {
        rafHandle = null;

        const events = pendingEvents;
        const sources = pendingSources;
        const types = pendingTypes;
        const event = forceEvent ?? lastEvent;

        if (forceSource) {
            sources.add(forceSource);
        }
        if (forceType) {
            types.add(forceType);
        }

        pendingEvents = [];
        pendingSources = new Set();
        pendingTypes = new Set();
        lastEvent = null;

        // Single read phase before any DOM write.
        const snapshot = readViewportSnapshot({
            win,
            doc,
            visualViewport: attachedVisualViewport ?? resolveVisualViewport(),
        });
        lastSnapshot = snapshot;

        // Single write phase gated by >= 1px delta threshold.
        const cssChanges = writeCssProperties(snapshot);

        const meta = {
            event,
            events,
            sources,
            types,
            cssChanges,
        };

        notifySubscribers(snapshot, meta);
        return snapshot;
    };

    const enqueueEvent = (source, type, event) => {
        const normalizedEvent = event ?? { type };
        lastEvent = normalizedEvent;
        pendingEvents.push(normalizedEvent);
        pendingSources.add(source);
        pendingTypes.add(type);
        pendingTypes.add(`${source}:${type}`);

        if (rafHandle !== null) {
            return;
        }

        rafHandle = scheduleFrame(() => {
            runFrame();
        });
    };

    const handleVisualViewportResize = (event) => enqueueEvent('visualViewport', 'resize', event);
    const handleVisualViewportScroll = (event) => enqueueEvent('visualViewport', 'scroll', event);
    const handleWindowResize = (event) => enqueueEvent('window', 'resize', event);
    const handleOrientationChange = (event) => enqueueEvent('window', 'orientationchange', event);

    const start = () => {
        if (attached) {
            return false;
        }

        const vv = resolveVisualViewport();
        let attachedAny = false;

        if (isEventTargetLike(vv)) {
            vv.addEventListener('resize', handleVisualViewportResize, PASSIVE_EVENT_OPTIONS);
            vv.addEventListener('scroll', handleVisualViewportScroll, PASSIVE_EVENT_OPTIONS);
            attachedVisualViewport = vv;
            attachedAny = true;
        }

        if (isEventTargetLike(win)) {
            win.addEventListener('resize', handleWindowResize, PASSIVE_EVENT_OPTIONS);
            win.addEventListener('orientationchange', handleOrientationChange, PASSIVE_EVENT_OPTIONS);
            attachedAny = true;
        }

        attached = attachedAny;
        return attached;
    };

    const stopListeners = () => {
        if (rafHandle !== null) {
            cancelFrame(rafHandle);
            rafHandle = null;
        }

        pendingEvents = [];
        pendingSources = new Set();
        pendingTypes = new Set();
        lastEvent = null;

        if (!attached) {
            return;
        }

        if (isEventTargetLike(attachedVisualViewport)) {
            attachedVisualViewport.removeEventListener('resize', handleVisualViewportResize, PASSIVE_EVENT_OPTIONS);
            attachedVisualViewport.removeEventListener('scroll', handleVisualViewportScroll, PASSIVE_EVENT_OPTIONS);
        }

        if (isEventTargetLike(win)) {
            win.removeEventListener('resize', handleWindowResize, PASSIVE_EVENT_OPTIONS);
            win.removeEventListener('orientationchange', handleOrientationChange, PASSIVE_EVENT_OPTIONS);
        }

        attachedVisualViewport = null;
        attached = false;
    };

    const subscribe = (callback, options = {}) => {
        if (typeof callback !== 'function') {
            throw new TypeError('subscribeViewport requires a callback function.');
        }

        const sources = Array.isArray(options?.sources) && options.sources.length > 0
            ? new Set(options.sources)
            : null;
        const entry = { callback, sources };
        subscribers.add(entry);

        if (!attached) {
            start();
        }

        if (options?.immediate) {
            const snapshot = readViewportSnapshot({
                win,
                doc,
                visualViewport: attachedVisualViewport ?? resolveVisualViewport(),
            });
            lastSnapshot = snapshot;
            const cssChanges = writeCssProperties(snapshot);
            try {
                callback(snapshot, {
                    event: { type: 'immediate' },
                    events: [],
                    sources: new Set(['immediate']),
                    types: new Set(['immediate']),
                    cssChanges,
                });
            } catch (error) {
                console.error('[ViewportCoordinator] Subscriber error:', error);
            }
        }

        let disposed = false;
        return () => {
            if (disposed) {
                return;
            }
            disposed = true;
            subscribers.delete(entry);
            if (subscribers.size === 0) {
                stopListeners();
            }
        };
    };

    const syncNow = () => {
        if (rafHandle !== null) {
            cancelFrame(rafHandle);
            rafHandle = null;
        }
        return runFrame({ forceSource: 'sync', forceType: 'sync' });
    };

    const dispose = () => {
        subscribers.clear();
        stopListeners();
        lastSnapshot = null;
        lastWrittenHeight = null;
        lastWrittenKeyboardInset = null;
    };

    const getSnapshot = () => lastSnapshot ?? readViewportSnapshot({
        win,
        doc,
        visualViewport: attachedVisualViewport ?? resolveVisualViewport(),
    });

    return {
        start,
        dispose,
        subscribe,
        syncNow,
        getSnapshot,
        isAttached: () => attached,
        hasPendingFrame: () => rafHandle !== null,
        getSubscriberCount: () => subscribers.size,
    };
}

let defaultCoordinator = null;

/**
 * Returns the shared application ViewportCoordinator singleton.
 */
export function getViewportCoordinator() {
    if (!defaultCoordinator) {
        defaultCoordinator = createViewportCoordinator();
    }
    return defaultCoordinator;
}

/**
 * Registers a subscriber with the shared ViewportCoordinator.
 *
 * @param {(snapshot: ReturnType<typeof readViewportSnapshot>, meta: object) => void} callback
 * @param {object} [options]
 * @returns {() => void} Unsubscribe / teardown function.
 */
export function subscribeViewport(callback, options = {}) {
    return getViewportCoordinator().subscribe(callback, options);
}

/**
 * Returns the latest viewport snapshot from the shared ViewportCoordinator.
 */
export function getViewportSnapshot() {
    return getViewportCoordinator().getSnapshot();
}

/**
 * Disposes and clears the shared default ViewportCoordinator (useful for tests).
 */
export function resetDefaultViewportCoordinator() {
    defaultCoordinator?.dispose();
    defaultCoordinator = null;
}
