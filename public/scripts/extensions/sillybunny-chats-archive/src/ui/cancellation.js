import { syncBusyControls } from './busy.js';
import { setStatus } from './dom.js';

export function clearViewerMatch(ui) {
    for (const match of ui.viewerContent.querySelectorAll('.sbca-msg-match')) {
        match.classList.remove('sbca-msg-match');
    }
    for (const label of ui.viewerContent.querySelectorAll('.sbca-match-label')) {
        label.remove();
    }
}

export function exitDeepSearch(ctx, state, ui) {
    cancelSearch(ctx, state, ui);
    state.deepRows = null;
    state.deepQuery = '';
    clearViewerMatch(ui);
}

export function cancelSearch(ctx, state, ui) {
    const controller = state.searchAbort;
    state.searchAbort = null;
    controller?.abort();
    if (controller) {
        setStatus(ui, '');
        syncBusyControls(ctx, state, ui);
    }
    ui.status.removeAttribute('aria-busy');
}

export function cancelViewer(state) {
    state.viewerAbort?.abort();
}

export function cancelNavigation(state) {
    state.navigationAbort?.abort();
}
