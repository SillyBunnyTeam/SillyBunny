function activateDeferredStyles() {
    const styles = document.querySelectorAll('link[data-sb-deferred-style]');

    for (const style of styles) {
        if (style.dataset.sbStyleActivated === 'true') {
            continue;
        }

        // SillyBunny: retain settled state for consumers that subscribe after idle activation — see docs/ui-migration.md
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

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => scheduleIdleWork(activateDeferredStyles), { once: true });
} else {
    scheduleIdleWork(activateDeferredStyles);
}

scheduleIdleWork(loadWideFontFallbacks);
