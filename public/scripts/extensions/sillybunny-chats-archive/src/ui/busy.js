import { setStatus, syncBanner, tr } from './dom.js';

/**
 * Shows the banner above the chat list while a load, an orphan scan or a message search runs. Loads and scans
 * get Cancel or Stop scan; a search stops when the query changes.
 */
export function syncBusyControls(ctx, state, ui) {
    const task = state.listAbort ? 'load' : state.scanAbort ? 'scan' : state.searchAbort ? 'search' : '';
    const { banner, bannerAction } = ui;
    if ((bannerAction.dataset.task ?? '') !== task) {
        bannerAction.dataset.task = task;
        bannerAction.disabled = false;
        bannerAction.textContent = tr(ctx, task === 'scan' ? 'Stop Scan' : 'Cancel');
    }
    bannerAction.hidden = task !== 'load' && task !== 'scan';
    if (task) {
        banner.dataset.busy = 'true';
    } else {
        delete banner.dataset.busy;
    }
    syncBanner(ui);
}

/** Aborts the running load or scan; it finishes through its own abort handling. */
export function stopBusyTask(ctx, state, ui) {
    if (state.listAbort) {
        state.listAbort.abort();
    } else if (state.scanAbort) {
        state.scanAbort.abort();
        setStatus(ui, tr(ctx, 'Stopping after the current server scan...'));
    } else {
        return;
    }
    ui.bannerAction.disabled = true;
    ui.bannerAction.textContent = tr(ctx, 'Stopping...');
}
