function activateDeferredStyles() {
    const styles = document.querySelectorAll('link[data-sb-deferred-style]');

    for (const style of styles) {
        if (style.dataset.sbStyleActivated === 'true') {
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
        style.media = style.getAttribute('data-sb-media') || style.getAttribute('media') || 'all';
    }
}

function loadWideFontFallbacks() {
    activateDeferredStyles();
}

function scheduleIdleWork(callback) {
    if ('requestIdleCallback' in window) {
        window.requestIdleCallback(callback, { timeout: 2500 });
        return;
    }

    window.setTimeout(callback, 1200);
}

window.SillyBunnyLoadStylesheet = activateDeferredStyles;
window.SillyBunnyLoadWideFontFallbacks = loadWideFontFallbacks;

// An activated sheet delays the window `load` event until it has loaded, and script.js waits for `load` at its top
// level before the app starts. An idle callback can run before `load` (the main thread is idle while the rest of the module
// graph loads), so the idle work waits for `load`, and a slow sheet delays no start. A caller that needs a sheet earlier
// activates it through the two functions above.
function whenWindowLoaded(callback) {
    if (document.readyState === 'complete') {
        callback();
        return;
    }

    window.addEventListener('load', callback, { once: true });
}

whenWindowLoaded(() => {
    scheduleIdleWork(activateDeferredStyles);
    scheduleIdleWork(loadWideFontFallbacks);
});
