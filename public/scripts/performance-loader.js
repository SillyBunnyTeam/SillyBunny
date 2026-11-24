function isPanelStyle(style) {
    return style.dataset?.sbPanelStyle !== undefined
        || Boolean(style.hasAttribute?.('data-sb-panel-style'))
        || (typeof style.getAttribute === 'function' && style.getAttribute('data-sb-panel-style') !== null);
}

function activateDeferredStyles() {
    const styles = document.querySelectorAll('link[data-sb-deferred-style]');

    for (const style of styles) {
        if (isPanelStyle(style) || style.dataset.sbStyleActivated === 'true') {
            continue;
        }

        const deferredHref = style.getAttribute?.('data-sb-href') ?? style.dataset?.sbHref;
        const currentHref = style.getAttribute?.('href') || style.href;
        if (!currentHref && deferredHref) {
            if (style.setAttribute) {
                style.setAttribute('href', deferredHref);
            } else {
                style.href = deferredHref;
            }
        }
        if (!(style.getAttribute?.('href') || style.href)) {
            continue;
        }

        // SillyBunny: retain settled state for consumers that subscribe after idle activation
        style.dataset.sbStyleState = 'loading';
        style.addEventListener('load', () => {
            style.dataset.sbStyleState = 'loaded';
            style.dataset.loaded = 'true';
        }, { once: true });
        style.addEventListener('error', () => {
            style.dataset.sbStyleState = 'error';
            style.dataset.loaded = 'false';
        }, { once: true });
        style.dataset.sbStyleActivated = 'true';
        style.rel = 'stylesheet';
        style.media = style.getAttribute?.('data-sb-media') || style.dataset?.sbMedia || style.getAttribute?.('media') || style.media || 'all';
    }
}

function loadWideFontFallbacks() {
    activateDeferredStyles();
}

function scheduleIdleWork(callback) {
    if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(callback, { timeout: 2500 });
        return;
    }

    if (typeof window.setTimeout === 'function') {
        window.setTimeout(callback, 1200);
    }
}

let postReadyActivationScheduled = false;

function schedulePostAppReadyActivation() {
    if (postReadyActivationScheduled) {
        return;
    }

    postReadyActivationScheduled = true;
    scheduleIdleWork(activateDeferredStyles);
}

function hasAppReadyMark() {
    return Boolean(globalThis.performance?.getEntriesByName?.('sb-app-ready')?.length);
}

// An activated sheet delays the window `load` event until it has loaded, and script.js waits for `load` at its top
// level before the app starts. Wait for `sb-app-ready` (or `window` `load` / `readyState === 'complete'` when mark
// observation is unavailable) before scheduling idle activation so slow sheets never stall boot. A caller that needs a
// sheet earlier activates it through the two functions below.
function waitForAppReadyThenActivate() {
    if (hasAppReadyMark()) {
        schedulePostAppReadyActivation();
        return;
    }

    if (typeof globalThis.PerformanceObserver === 'function'
        && Array.isArray(globalThis.PerformanceObserver.supportedEntryTypes)
        && globalThis.PerformanceObserver.supportedEntryTypes.includes('mark')) {
        try {
            const observer = new globalThis.PerformanceObserver((list) => {
                if (list.getEntries().some(entry => entry.name === 'sb-app-ready')) {
                    observer.disconnect();
                    schedulePostAppReadyActivation();
                }
            });
            observer.observe({ type: 'mark', buffered: true });
            if (hasAppReadyMark()) {
                observer.disconnect();
                schedulePostAppReadyActivation();
            }
            return;
        } catch {
            // Fall through to context readiness check when mark observation is unavailable.
        }
    }

    const bindContextReady = () => {
        const eventSource = window.SillyTavern?.getContext?.()?.eventSource;
        if (eventSource && typeof eventSource.on === 'function') {
            eventSource.on('app_ready', schedulePostAppReadyActivation);
            return true;
        }
        return false;
    };

    const onWindowLoaded = () => {
        if (!bindContextReady()) {
            schedulePostAppReadyActivation();
        }
    };

    if (!bindContextReady()) {
        if (document.readyState === 'complete') {
            onWindowLoaded();
        } else if (typeof window.addEventListener === 'function') {
            window.addEventListener('load', onWindowLoaded, { once: true, passive: true });
        }
    }
}

window.SillyBunnyLoadStylesheet = activateDeferredStyles;
window.SillyBunnyLoadWideFontFallbacks = loadWideFontFallbacks;

waitForAppReadyThenActivate();
