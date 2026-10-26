import { createDefaultOrganization, normalizeOrganization } from '../core.js';
import { fetchOrganization } from '../api.js';
import { refreshOpenOrganizer } from './chat-organizer.js';
import { UNFILED_VALUE } from './constants.js';
import { runDeepSearch } from './deep-search.js';
import { appendOption, setStatus, tr } from './dom.js';
import { preserveArchiveFocus } from './focus.js';
import { renderList, updateBrowseStatus } from './list.js';
import { mentionSearchState } from './mentions.js';
import { renderNamedManager } from './organization-manager.js';
import { markOrganizationDirty, setOrganizationControlsEnabled, updateOrganizationStatus } from './organization-save.js';
import { applySavedView, currentSavedView } from './saved-views.js';
import { updateSelectionControls } from './selection.js';

export async function loadOrganization(ctx, state, ui) {
    state.organizationLoadAbort?.abort();
    const controller = new AbortController();
    state.organizationLoadAbort = controller;
    state.organizationLoadState = 'loading';
    state.organizationLoadError = null;
    state.organizationWritable = false;
    ui.backup.status.textContent = '';
    delete ui.backup.status.dataset.sbcaOrganizationError;
    updateOrganizationStatus(ctx, state, ui);
    try {
        const value = await fetchOrganization(ctx, controller.signal);
        const organization = value === null ? createDefaultOrganization() : normalizeOrganization(value);
        if (state.organizationLoadAbort !== controller || state.closed) {
            return;
        }
        preserveArchiveFocus(ui, () => {
            state.organization = organization;
            state.organizationLoadState = 'ready';
            state.organizationWritable = true;
            state.organizationLoadError = null;
            state.organizationSaveError = null;
            refreshOrganizationUI(ctx, state, ui);
            if (state.viewTouched) {
                state.organization = { ...state.organization, lastView: currentSavedView(state, ui) };
                markOrganizationDirty(ctx, state, ui, true);
                renderList(ctx, state, ui);
                if (!state.searchAbort) {
                    if (state.deepRows === null) {
                        updateBrowseStatus(ctx, state, ui);
                    } else {
                        setStatus(ui, tr(ctx, '{matching} of {total} matching chats', {
                            matching: state.matchingRows.length,
                            total: state.deepRows.length,
                        }));
                    }
                }
                updateSelectionControls(ctx, state, ui);
            } else {
                applySavedView(ctx, state, ui, state.organization.lastView, null, false);
            }
            if (mentionSearchState(ui.search.value, ui.characterMentions).text
                && state.listState === 'ready'
                && !state.scanAbort) {
                void runDeepSearch(ctx, state, ui);
            }
            refreshOpenOrganizer(ctx, state, ui);
            updateOrganizationStatus(ctx, state, ui);
        });
    } catch (error) {
        if (error?.name === 'AbortError' || state.organizationLoadAbort !== controller || state.closed) {
            return;
        }
        console.error('[Chat Archive] failed to load organization:', error);
        preserveArchiveFocus(ui, () => {
            state.organizationLoadState = 'error';
            state.organizationLoadError = error;
            state.organizationWritable = false;
            ui.backup.status.textContent = tr(ctx, 'Organization could not be loaded. Retry or import a backup.');
            ui.backup.status.dataset.sbcaOrganizationError = 'load';
            updateOrganizationStatus(ctx, state, ui);
            refreshOpenOrganizer(ctx, state, ui);
        });
    } finally {
        if (state.organizationLoadAbort === controller) {
            state.organizationLoadAbort = null;
        }
    }
}

function replaceSelectOptions(select, options, selected = select.value) {
    select.replaceChildren();
    for (const [value, label] of options) {
        appendOption(select, value, label);
    }
    select.value = options.some(([value]) => value === selected) ? selected : '';
}

export function refreshOrganizationUI(ctx, state, ui) {
    const organization = state.organization;
    if (!organization) {
        return;
    }
    const folders = organization.folders.map(item => [item.id, item.name]);
    const collections = organization.collections.map(item => [item.id, item.name]);
    ui.savedViewWrap.hidden = organization.views.length === 0;
    replaceSelectOptions(ui.savedView, [
        ['', tr(ctx, 'Current view')],
        ...organization.views.map(view => [view.id, view.name]),
    ], state.selectedViewId ?? '');
    if (state.selectedViewId && !organization.views.some(view => view.id === state.selectedViewId)) {
        state.selectedViewId = null;
    }
    replaceSelectOptions(ui.folder, [
        ['', tr(ctx, 'Any folder')],
        [UNFILED_VALUE, tr(ctx, 'Unfiled')],
        ...folders,
    ]);
    replaceSelectOptions(ui.collection, [['', tr(ctx, 'Any collection')], ...collections]);
    replaceSelectOptions(ui.batch.folder, [
        ['', tr(ctx, 'Choose folder')],
        [UNFILED_VALUE, tr(ctx, 'Clear folder')],
        ...folders,
    ]);
    replaceSelectOptions(ui.batch.collection, [['', tr(ctx, 'Choose collection')], ...collections]);
    refreshTagOptions(state, ui);
    for (const [type, manager] of Object.entries(ui.managers)) {
        renderNamedManager(ctx, state, ui, type, manager);
    }
    setOrganizationControlsEnabled(ui, state.organizationWritable);
    updateSelectionControls(ctx, state, ui);
}

function refreshTagOptions(state, ui) {
    const tags = new Set();
    for (const metadata of Object.values(state.organization?.chats ?? {})) {
        for (const tag of metadata.tags ?? []) {
            tags.add(tag);
        }
    }
    ui.tagOptions.replaceChildren(...[...tags].sort().map(tag => {
        const option = document.createElement('option');
        option.value = tag;
        return option;
    }));
}

export function commitOrganizationChange(ctx, state, ui) {
    preserveArchiveFocus(ui, () => {
        refreshOrganizationUI(ctx, state, ui);
        renderList(ctx, state, ui);
        updateBrowseStatus(ctx, state, ui);
        refreshOpenOrganizer(ctx, state, ui);
        markOrganizationDirty(ctx, state, ui);
    });
}

export function commitChatMetadataChange(ctx, state, ui) {
    preserveArchiveFocus(ui, () => {
        refreshTagOptions(state, ui);
        renderList(ctx, state, ui);
        updateBrowseStatus(ctx, state, ui);
        refreshOpenOrganizer(ctx, state, ui);
        markOrganizationDirty(ctx, state, ui);
    });
}
