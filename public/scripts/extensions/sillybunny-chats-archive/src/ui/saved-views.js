import { normalizeSavedView } from '../core.js';
import { exitDeepSearch } from './cancellation.js';
import { LIST_PAGE_SIZE } from './constants.js';
import { runDeepSearch } from './deep-search.js';
import { renderList, updateBrowseStatus, updateResultStatus } from './list.js';
import { mentionSearchState } from './mentions.js';
import { markOrganizationDirty } from './organization-save.js';
import { updateSelectionControls } from './selection.js';
import { createViewModel, modelToView } from './view-model.js';

export function currentSavedView(state, ui) {
    return modelToView(state.model, ui.search.value, state.organization);
}

export function rememberCurrentView(ctx, state, ui) {
    if (!state.organizationWritable || !state.organization) {
        return;
    }
    state.organization = { ...state.organization, lastView: currentSavedView(state, ui) };
    markOrganizationDirty(ctx, state, ui, true);
}

export function noteViewEdit(ctx, state, ui) {
    state.viewTouched = true;
    state.selectedViewId = null;
    rememberCurrentView(ctx, state, ui);
}

function restartDeepSearch(ctx, state, ui) {
    if (mentionSearchState(ui.search.value, ui.characterMentions).text && state.listState === 'ready' && !state.scanAbort) {
        void runDeepSearch(ctx, state, ui);
    }
}

export function commitModel(ctx, state, ui, next) {
    const ownerChanged = next.owner !== state.model.owner;
    if (ownerChanged) {
        exitDeepSearch(ctx, state, ui);
    }
    state.model = next;
    state.visibleLimit = LIST_PAGE_SIZE;
    renderList(ctx, state, ui);
    updateResultStatus(ctx, state, ui);
    updateSelectionControls(ctx, state, ui);
    noteViewEdit(ctx, state, ui);
    if (ownerChanged) {
        restartDeepSearch(ctx, state, ui);
    }
}

/** Shows a restored query without taking focus from whatever the user is doing. */
function restoreSearchText(ui, text) {
    ui.search.value = text;
    ui.searchControl.setQuery(text, { notify: false });
    if (text && !ui.searchControl.isOpen) {
        const active = document.activeElement;
        ui.searchControl.open();
        if (active instanceof HTMLElement && active.isConnected) {
            active.focus({ preventScroll: true });
        }
    }
}

export function applySavedView(ctx, state, ui, value, selectedViewId = null, persist = true) {
    const view = normalizeSavedView(value, state.organization);
    exitDeepSearch(ctx, state, ui);
    state.model = createViewModel(view);
    restoreSearchText(ui, view.query ?? '');
    state.selectedViewId = selectedViewId;
    state.visibleLimit = LIST_PAGE_SIZE;
    renderList(ctx, state, ui);
    updateBrowseStatus(ctx, state, ui);
    updateSelectionControls(ctx, state, ui);
    restartDeepSearch(ctx, state, ui);
    if (persist) {
        state.viewTouched = true;
        if (state.organizationWritable) {
            state.organization = { ...state.organization, lastView: view };
            markOrganizationDirty(ctx, state, ui, true);
        }
    }
}
