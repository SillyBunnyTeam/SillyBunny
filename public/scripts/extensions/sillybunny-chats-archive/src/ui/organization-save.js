import { saveOrganization } from '../api.js';
import { LAST_VIEW_SAVE_DELAY_MS } from './constants.js';
import { tr } from './dom.js';
import { updateSelectionControls } from './selection.js';

export function setOrganizationControlsEnabled(ui, enabled) {
    for (const control of ui.root.querySelectorAll('[data-sbca-organization-control]')) {
        control.disabled = !enabled;
    }
}

export function updateOrganizationStatus(ctx, state, ui) {
    ui.backup.retryButton.hidden = !state.organizationLoadError && !state.organizationSaveError;
    if (state.organizationSaveError) {
        ui.backup.status.textContent = tr(ctx, 'Organization changes could not be saved. Retry to keep these changes.');
        ui.backup.status.dataset.sbcaOrganizationError = 'save';
    } else if (ui.backup.status.dataset.sbcaOrganizationError === 'save') {
        ui.backup.status.textContent = '';
        delete ui.backup.status.dataset.sbcaOrganizationError;
    }
    setOrganizationControlsEnabled(ui, state.organizationWritable);
    updateSelectionControls(ctx, state, ui);
}

export function markOrganizationDirty(ctx, state, ui, debounce = false) {
    if (!state.organizationWritable || !state.organization) {
        return;
    }
    state.organizationRevision++;
    state.organizationSaveError = null;
    clearTimeout(state.lastViewSaveTimer);
    state.lastViewSaveTimer = null;
    updateOrganizationStatus(ctx, state, ui);
    if (debounce) {
        state.lastViewSaveTimer = setTimeout(() => {
            state.lastViewSaveTimer = null;
            requestOrganizationSave(ctx, state, ui);
        }, LAST_VIEW_SAVE_DELAY_MS);
    } else {
        requestOrganizationSave(ctx, state, ui);
    }
}

export function requestOrganizationSave(ctx, state, ui) {
    if (!state.organizationWritable || !state.organization || state.organizationRevision === 0) {
        return;
    }
    state.organizationRequestedRevision = state.organizationRevision;
    if (!state.organizationSaveRunning) {
        runOrganizationSave(ctx, state, ui);
    }
}

function runOrganizationSave(ctx, state, ui) {
    const revision = state.organizationRequestedRevision;
    if (!state.organizationWritable || !state.organization || revision <= state.organizationSavedRevision) {
        return state.organizationSavePromise;
    }
    state.organizationSaveRunning = true;
    state.organizationSaveError = null;
    const snapshot = state.organization;
    updateOrganizationStatus(ctx, state, ui);
    // ponytail: host upload has no compare-and-swap/etag; simultaneous tabs are last-writer-wins.
    const operation = saveOrganization(ctx, snapshot)
        .then(() => {
            state.organizationSavedRevision = Math.max(state.organizationSavedRevision, revision);
        })
        .catch(error => {
            state.organizationSaveError = error;
            console.error('[Chat Archive] failed to save organization:', error);
        })
        .finally(() => {
            state.organizationSaveRunning = false;
            updateOrganizationStatus(ctx, state, ui);
            if (state.organizationRequestedRevision > revision) {
                runOrganizationSave(ctx, state, ui);
            }
        });
    state.organizationSavePromise = operation;
    return operation;
}

export async function flushOrganization(ctx, state, ui) {
    if (state.lastViewSaveTimer) {
        clearTimeout(state.lastViewSaveTimer);
        state.lastViewSaveTimer = null;
    }
    if (state.organizationWritable && state.organizationRevision > state.organizationSavedRevision) {
        requestOrganizationSave(ctx, state, ui);
    }
    while (state.organizationSaveRunning) {
        await state.organizationSavePromise;
    }
    if (state.organizationWritable && state.organizationRevision > state.organizationSavedRevision) {
        requestOrganizationSave(ctx, state, ui);
        await state.organizationSavePromise;
    }
    if (state.organizationSaveError && state.organizationRevision > state.organizationSavedRevision) {
        globalThis.toastr?.error?.(tr(ctx, 'Organization changes could not be saved.'));
    }
}
