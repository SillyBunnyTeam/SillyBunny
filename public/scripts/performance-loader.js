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

/**
 * The marks that start the idle activation. `sb-app-ready` ends a normal start. A first run holds startup on the
 * Welcome dialog until the persona has a name, and a start that fails never reaches `sb-app-ready`, so the Welcome
 * dialog (`sb-welcome-shown`, made where it opens) and the timer below start the activation as well.
 */
const ACTIVATION_MARKS = Object.freeze(['sb-app-ready', 'sb-welcome-shown']);
/** How long after `load` the sheets activate when none of the marks has come. */
const ACTIVATION_FALLBACK_AFTER_LOAD_MS = 3000;

function hasActivationMark() {
    return ACTIVATION_MARKS.some(name => globalThis.performance?.getEntriesByName?.(name)?.length);
}

function activateAfterLoadTimeout() {
    const arm = () => {
        if (typeof window.setTimeout === 'function') {
            window.setTimeout(schedulePostAppReadyActivation, ACTIVATION_FALLBACK_AFTER_LOAD_MS);
        }
    };

    if (document.readyState === 'complete') {
        arm();
    } else if (typeof window.addEventListener === 'function') {
        window.addEventListener('load', arm, { once: true, passive: true });
    }
}

// An activated sheet delays the window `load` event until it has loaded, and script.js waits for `load` at its top
// level before the app starts. Wait for the earliest of `sb-app-ready`, the Welcome dialog and a timer that starts at
// `load` (or `window` `load` / `readyState === 'complete'` when mark observation is unavailable) before scheduling idle
// activation, so slow sheets never stall boot and are never left unloaded when the app does not become ready. A caller
// that needs a sheet earlier activates it through the two functions below.
function waitForAppReadyThenActivate() {
    if (hasActivationMark()) {
        schedulePostAppReadyActivation();
        return;
    }

    if (typeof globalThis.PerformanceObserver === 'function'
        && Array.isArray(globalThis.PerformanceObserver.supportedEntryTypes)
        && globalThis.PerformanceObserver.supportedEntryTypes.includes('mark')) {
        try {
            const observer = new globalThis.PerformanceObserver((list) => {
                if (list.getEntries().some(entry => ACTIVATION_MARKS.includes(entry.name))) {
                    observer.disconnect();
                    schedulePostAppReadyActivation();
                }
            });
            observer.observe({ type: 'mark', buffered: true });
            if (hasActivationMark()) {
                observer.disconnect();
                schedulePostAppReadyActivation();
                return;
            }
            activateAfterLoadTimeout();
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
