import { normalizeSavedView } from '../core.js';
import { exitDeepSearch } from './cancellation.js';
import { KINDS, LIST_PAGE_SIZE, UNFILED_VALUE } from './constants.js';
import { runDeepSearch } from './deep-search.js';
import { tr } from './dom.js';
import { inputDate, inputNumber } from './filter-values.js';
import { renderList, updateBrowseStatus } from './list.js';
import { mentionSearchState } from './mentions.js';
import { markOrganizationDirty } from './organization-save.js';
import { refreshOwnerOptions, setOwnerValue } from './owner-picker.js';
import { updateSelectionControls } from './selection.js';

export function currentSavedView(state, ui) {
    const view = {
        query: ui.search.value,
        kinds: [...ui.kinds.querySelectorAll('input[data-sbca-kind]:checked')].map(box => box.dataset.sbcaKind),
        sort: ui.sort.value,
        group: ui.group.value,
        density: ui.density.value,
        owner: ui.owner.value,
        orphan: ui.orphan.value,
        tag: ui.tag.value,
        minDate: inputDate(ui.minDate),
        maxDate: inputDate(ui.maxDate, true),
        minSize: inputNumber(ui.minSize, 1024 ** 2),
        maxSize: inputNumber(ui.maxSize, 1024 ** 2),
        minMessages: inputNumber(ui.minMessages, 1, true),
        maxMessages: inputNumber(ui.maxMessages, 1, true),
    };
    if (!ui.favorite.checked) {
        view.favorite = false;
    }
    if (ui.folder.value) {
        view.folder = ui.folder.value === UNFILED_VALUE ? null : ui.folder.value;
    }
    if (ui.collection.value) {
        view.collection = ui.collection.value;
    }
    return normalizeSavedView(view, state.organization);
}

export function rememberCurrentView(ctx, state, ui) {
    if (!state.organizationWritable || !state.organization) {
        return;
    }
    state.organization = { ...state.organization, lastView: currentSavedView(state, ui) };
    markOrganizationDirty(ctx, state, ui, true);
}

function dateInputValue(value) {
    if (value === undefined) {
        return '';
    }
    const date = new Date(value);
    if (Number.isNaN(date.valueOf())) {
        return '';
    }
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
}

export function applySavedView(ctx, state, ui, value, selectedViewId = null, persist = true) {
    const view = normalizeSavedView(value, state.organization);
    exitDeepSearch(ctx, state, ui);
    ui.search.value = view.query ?? '';
    const kinds = new Set(view.kinds ?? KINDS.map(([kind]) => kind));
    for (const box of ui.kinds.querySelectorAll('input')) {
        box.checked = kinds.has(box.dataset.sbcaKind);
    }
    ui.sort.value = view.sort ?? 'recent';
    ui.group.value = view.group ?? 'flat';
    ui.density.value = view.density ?? 'comfortable';
    const owner = view.owner ?? '';
    setOwnerValue(ctx, ui, owner);
    if (owner && !ui.ownerField.choices.has(owner)) {
        refreshOwnerOptions(ctx, state, ui);
    }
    ui.orphan.value = view.orphan ?? '';
    ui.favorite.checked = view.favorite !== false;
    ui.favorite.indeterminate = false;
    ui.favoriteLabel.textContent = tr(ctx, 'Favorites');
    ui.folder.value = view.folder === null ? UNFILED_VALUE : view.folder ?? '';
    ui.collection.value = view.collection ?? '';
    ui.tag.value = view.tag ?? '';
    ui.minDate.value = dateInputValue(view.minDate);
    ui.maxDate.value = dateInputValue(view.maxDate);
    ui.minSize.value = view.minSize === undefined ? '' : String(view.minSize / 1024 ** 2);
    ui.maxSize.value = view.maxSize === undefined ? '' : String(view.maxSize / 1024 ** 2);
    ui.minMessages.value = view.minMessages ?? '';
    ui.maxMessages.value = view.maxMessages ?? '';
    ui.root.dataset.sbcaDensity = ui.density.value;
    state.selectedViewId = selectedViewId;
    ui.savedView.value = selectedViewId ?? '';
    state.visibleLimit = LIST_PAGE_SIZE;
    renderList(ctx, state, ui);
    updateBrowseStatus(ctx, state, ui);
    updateSelectionControls(ctx, state, ui);
    if (mentionSearchState(ui.search.value, ui.characterMentions).text && state.listState === 'ready' && !state.scanAbort) {
        void runDeepSearch(ctx, state, ui);
    }
    if (persist) {
        state.viewTouched = true;
        if (state.organizationWritable) {
            state.organization = { ...state.organization, lastView: view };
            markOrganizationDirty(ctx, state, ui, true);
        }
    }
}
