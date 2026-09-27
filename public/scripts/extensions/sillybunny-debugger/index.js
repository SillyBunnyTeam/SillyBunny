import { disableCapture, installCapture } from './src/capture.js';
import { destroyEruda, maybeAutoStart, mountUi, removeUi, setActive } from './src/ui.js';

let initialized = false;
let appReadySubscription = null;

function onAppReady() {
    mountUi();
    void maybeAutoStart();
}

export function init() {
    if (initialized) {
        mountUi();
        return;
    }

    // Capture first: everything else (including eruda) stacks on top of it.
    installCapture();
    setActive(true);
    try {
        mountUi();
        const { eventSource, eventTypes } = SillyTavern.getContext();
        if (eventTypes.APP_READY) {
            eventSource.on(eventTypes.APP_READY, onAppReady);
            appReadySubscription = { eventSource, eventType: eventTypes.APP_READY };
        }
        initialized = true;
        if (document.readyState === 'complete') void maybeAutoStart();
    } catch (error) {
        deactivate();
        throw error;
    }
}

export function deactivate() {
    initialized = false;
    setActive(false);
    disableCapture();
    try {
        removeUi();
    } catch {
        // Teardown continues so a broken host node cannot leave capture active.
    }
    try {
        destroyEruda();
    } catch {
        // Eruda may be only partially initialized.
    }
    if (appReadySubscription) {
        const { eventSource, eventType } = appReadySubscription;
        appReadySubscription = null;
        try {
            eventSource.removeListener(eventType, onAppReady);
        } catch {
            // The host may already have disposed its event source.
        }
    }
}
